import type { AnyChannel, InferClient } from "ws-asyncapi";
import {
    type AnyFrame,
    Frame,
    jsonCodec,
    PROTOCOL_VERSION,
    RpcError,
} from "ws-asyncapi/wire";
import type {
    CloseEvent,
    FindMatchingAddressKey,
    OpenEvent,
    ReconnectOptions,
    RequestOptions,
    SafeResult,
    WebsocketAsyncAPIMap,
    WebsocketAsyncAPIOptions,
    WsClient,
} from "./types.ts";
import { joinUrlPath } from "./utils.ts";

export * from "./types.ts";

/** Coerce a channel's Query/Headers (which may be `unknown`/`undefined` when
 *  unset) to the `Record<string,string>` the connect options expect. */
type AsRecord<T> = T extends Record<string, string>
    ? T
    : Record<string, string>;
export { RpcError } from "ws-asyncapi/wire";

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (error: RpcError) => void;
    timer: ReturnType<typeof setTimeout>;
}

export function websocketAsyncAPI<
    Path extends // @ts-ignore hack to generate declare module statements
    WebsocketAsyncAPIMap["addresses"][keyof WebsocketAsyncAPIMap["addresses"]],
    Channel extends FindMatchingAddressKey<
        // @ts-ignore hack to generate declare module statements
        WebsocketAsyncAPIMap["addresses"],
        Path
    >,
    // @ts-ignore hack to generate declare module statements
    T = {
        // @ts-ignore hack to generate declare module statements
        commandMap: WebsocketAsyncAPIMap["data"][Channel]["commandMap"];
        // @ts-ignore hack to generate declare module statements
        eventMap: WebsocketAsyncAPIMap["data"][Channel]["eventMap"];
        // @ts-ignore hack to generate declare module statements
        rpcMap: WebsocketAsyncAPIMap["data"][Channel]["rpcMap"];
    },
>(
    url: string,
    path: Path,
    options?: WebsocketAsyncAPIOptions<
        // @ts-ignore hack to generate declare module statements
        WebsocketAsyncAPIMap["data"][Channel]["query"],
        // @ts-ignore hack to generate declare module statements
        WebsocketAsyncAPIMap["data"][Channel]["headers"]
    >,
) {
    const fullUrl = joinUrlPath(url, path, options?.query);
    const codec = options?.codec ?? jsonCodec;
    const requestTimeout = options?.requestTimeout ?? 30_000;
    const maxBufferSize = options?.maxBufferSize ?? 1024;

    const reconnectOpt = options?.reconnect ?? true;
    const reconnectEnabled = reconnectOpt !== false;
    const rc: ReconnectOptions =
        typeof reconnectOpt === "object" ? reconnectOpt : {};
    const baseDelay = rc.baseDelay ?? 500;
    const maxDelay = rc.maxDelay ?? 10_000;
    const maxRetries = rc.maxRetries ?? Number.POSITIVE_INFINITY;

    const heartbeatOpt = options?.heartbeat ?? true;
    const heartbeatEnabled = heartbeatOpt !== false;
    const hb = typeof heartbeatOpt === "object" ? heartbeatOpt : {};
    const heartbeatInterval = hb.interval ?? 25_000;
    const heartbeatTimeout = hb.timeout ?? 10_000;

    let ws: WebSocket;
    let connected = false;
    let manualClose = false;
    let retries = 0;
    let corrSeq = 0;
    let sessionId: string | null = null;
    let lastOffset: number | string = 0;
    let wasRecovered = false;
    let openedSettled = false;

    const pending = new Map<number, PendingRequest>();
    const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
    const openHandlers = new Set<(event: OpenEvent) => void>();
    const closeHandlers = new Set<(event: CloseEvent) => void>();
    const errorHandlers = new Set<(event: Event) => void>();
    const recoverHandlers = new Set<(recovered: boolean) => void>();
    let outbox: Array<string | Uint8Array> = [];

    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatWatchdog: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    let resolveOpened!: () => void;
    let rejectOpened!: (reason?: unknown) => void;
    const opened = new Promise<void>((resolve, reject) => {
        resolveOpened = resolve;
        rejectOpened = reject;
    });

    function rawSend(data: string | Uint8Array) {
        // biome-ignore lint/suspicious/noExplicitAny: WebSocket.send union
        ws.send(data as any);
    }

    function send(frame: AnyFrame) {
        const data = codec.encode(frame);
        if (connected && ws.readyState === WebSocket.OPEN) {
            rawSend(data);
            return;
        }
        // buffer while disconnected (drop oldest past the cap)
        if (outbox.length >= maxBufferSize) outbox.shift();
        outbox.push(data);
    }

    function flush() {
        const queued = outbox;
        outbox = [];
        for (const data of queued) rawSend(data);
    }

    function stopHeartbeat() {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (heartbeatWatchdog) clearTimeout(heartbeatWatchdog);
        heartbeatTimer = undefined;
        heartbeatWatchdog = undefined;
    }

    function startHeartbeat() {
        if (!heartbeatEnabled) return;
        stopHeartbeat();
        heartbeatTimer = setInterval(() => {
            send([Frame.Ping, Date.now()]);
            if (heartbeatWatchdog) clearTimeout(heartbeatWatchdog);
            heartbeatWatchdog = setTimeout(() => {
                // no pong in time → drop the socket so onclose triggers reconnect
                try {
                    ws.close(4000, "heartbeat timeout");
                } catch {}
            }, heartbeatTimeout);
        }, heartbeatInterval);
    }

    function rejectAllPending(error: RpcError) {
        for (const [, p] of pending) {
            clearTimeout(p.timer);
            p.reject(error);
        }
        pending.clear();
    }

    /** Core RPC: mint a corrId, send a Request, resolve/reject via the pending
     *  table. Shared by `request` (throws) and `safeRequest` (typed result). */
    function doRequest(
        command: string,
        input: unknown,
        options?: RequestOptions,
    ): Promise<unknown> {
        const corrId = ++corrSeq;
        const timeout = options?.timeout ?? requestTimeout;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(corrId);
                reject(
                    new RpcError(
                        "TIMEOUT",
                        `RPC "${command}" timed out after ${timeout}ms`,
                    ),
                );
            }, timeout);
            pending.set(corrId, { resolve, reject, timer });
            send([Frame.Request, command, corrId, input]);
        });
    }

    function handleFrame(frame: AnyFrame) {
        switch (frame[0]) {
            case Frame.Event: {
                const [, name, payload, offset] = frame;
                // advance the recovery cursor (offset present only when the
                // server backplane supports connection-state-recovery)
                if (offset !== undefined) lastOffset = offset;
                const set = eventHandlers.get(name);
                if (set) for (const cb of set) cb(payload);
                break;
            }
            case Frame.Reply: {
                const [, corrId, payload] = frame;
                const p = pending.get(corrId);
                if (p) {
                    clearTimeout(p.timer);
                    pending.delete(corrId);
                    p.resolve(payload);
                }
                break;
            }
            case Frame.Error: {
                const [, corrId, code, message, data] = frame;
                const p = pending.get(corrId);
                if (p) {
                    clearTimeout(p.timer);
                    pending.delete(corrId);
                    p.reject(new RpcError(code, message, data));
                }
                break;
            }
            case Frame.Pong: {
                if (heartbeatWatchdog) clearTimeout(heartbeatWatchdog);
                heartbeatWatchdog = undefined;
                break;
            }
            case Frame.Ping: {
                send([Frame.Pong, frame[1]]);
                break;
            }
            case Frame.Welcome: {
                const [, sid, recovered, offset] = frame;
                sessionId = sid;
                wasRecovered = recovered === 1;
                // On a recovered session the server has already replayed the
                // missed events (which advanced lastOffset); keep our cursor.
                // On a clean connect, adopt the server's current offset as the
                // starting cursor so a later blip replays only from here.
                if (!wasRecovered) lastOffset = offset;
                for (const cb of recoverHandlers) cb(wasRecovered);
                break;
            }
            default:
                break;
        }
    }

    function connect() {
        ws = new WebSocket(fullUrl);
        ws.binaryType = "arraybuffer";

        ws.onopen = (event) => {
            connected = true;
            retries = 0;
            // recovery handshake first, then drain anything buffered offline
            rawSend(codec.encode([Frame.Hello, sessionId, lastOffset, PROTOCOL_VERSION]));
            flush();
            startHeartbeat();
            if (!openedSettled) {
                openedSettled = true;
                resolveOpened();
            }
            for (const cb of openHandlers)
                cb(event as unknown as OpenEvent);
        };

        ws.onmessage = (event) => {
            let frame: AnyFrame;
            try {
                frame = codec.decode(event.data);
            } catch {
                return;
            }
            if (!Array.isArray(frame)) return;
            handleFrame(frame);
        };

        ws.onerror = (event) => {
            for (const cb of errorHandlers) cb(event);
            if (!openedSettled && !reconnectEnabled) {
                openedSettled = true;
                rejectOpened(event);
            }
        };

        ws.onclose = (event) => {
            connected = false;
            stopHeartbeat();
            for (const cb of closeHandlers)
                cb(event as unknown as CloseEvent);

            if (manualClose || !reconnectEnabled || retries >= maxRetries) {
                rejectAllPending(
                    new RpcError("INTERNAL", "connection closed"),
                );
                if (!openedSettled) {
                    openedSettled = true;
                    rejectOpened(event);
                }
                return;
            }

            const backoff = Math.min(maxDelay, baseDelay * 2 ** retries);
            const delay = backoff * (0.5 + Math.random() * 0.5); // jitter
            retries++;
            reconnectTimer = setTimeout(connect, delay);
        };
    }

    connect();

    return {
        get "~original"() {
            return ws;
        },
        get connected() {
            return connected;
        },
        /** Server-assigned session id (stable across reconnects). */
        get sessionId() {
            return sessionId;
        },
        /** Whether the most recent (re)connect recovered missed events. */
        get recovered() {
            return wasRecovered;
        },
        opened,
        /**
         * Fires after each (re)connect handshake with whether the session was
         * recovered (`true` = missed events were replayed, `false` = clean
         * (re)subscribe). Useful to refetch state only when recovery failed.
         */
        onRecover(callback: (recovered: boolean) => void) {
            recoverHandlers.add(callback);
            return () => recoverHandlers.delete(callback);
        },
        onOpen(callback: (data: OpenEvent) => void) {
            openHandlers.add(callback);
            return () => openHandlers.delete(callback);
        },
        onClose(callback: (data: CloseEvent) => void) {
            closeHandlers.add(callback);
            return () => closeHandlers.delete(callback);
        },
        onError(callback: (event: Event) => void) {
            errorHandlers.add(callback);
            return () => errorHandlers.delete(callback);
        },
        // @ts-ignore hack to generate declare module statements
        onEvent: <Event extends keyof T["eventMap"]>(
            eventName: Event,
            // @ts-ignore hack to generate declare module statements
            callback: (data: T["eventMap"][Event]) => void,
        ) => {
            const name = eventName as string;
            let set = eventHandlers.get(name);
            if (!set) {
                set = new Set();
                eventHandlers.set(name, set);
            }
            set.add(callback as (data: unknown) => void);
            return () => set?.delete(callback as (data: unknown) => void);
        },
        call: <
            // @ts-ignore hack to generate declare module statements
            Command extends keyof T["commandMap"],
        >(
            command: Command,
            // @ts-ignore hack to generate declare module statements
            ...data: T["commandMap"][Command] extends never
                ? []
                : // @ts-ignore hack to generate declare module statements
                  [T["commandMap"][Command]]
        ) => {
            send([Frame.Command, command as string, data[0]]);
        },
        request: <
            // @ts-ignore hack to generate declare module statements
            Command extends keyof T["rpcMap"],
        >(
            command: Command,
            // @ts-ignore hack to generate declare module statements
            input: T["rpcMap"][Command]["input"],
            options?: RequestOptions,
            // @ts-ignore hack to generate declare module statements
        ): Promise<T["rpcMap"][Command]["output"]> =>
            // @ts-ignore generic Promise resolution
            doRequest(command as string, input, options),
        /**
         * Like {@link request}, but never throws: returns a typed, discriminated
         * `{ data, error }` result. Narrow on `error` (and `error.code`) to get
         * the declared error's typed `data`.
         */
        safeRequest: async <
            // @ts-ignore hack to generate declare module statements
            Command extends keyof T["rpcMap"],
        >(
            command: Command,
            // @ts-ignore hack to generate declare module statements
            input: T["rpcMap"][Command]["input"],
            options?: RequestOptions,
        ): Promise<
            SafeResult<
                // @ts-ignore hack to generate declare module statements
                T["rpcMap"][Command]["output"],
                // @ts-ignore hack to generate declare module statements
                T["rpcMap"][Command]["errors"]
            >
        > => {
            try {
                const data = await doRequest(
                    command as string,
                    input,
                    options,
                );
                // @ts-ignore generic result narrowing
                return { data, error: null };
            } catch (e) {
                const error =
                    e instanceof RpcError
                        ? { code: e.code, message: e.message, data: e.data }
                        : {
                              code: "INTERNAL",
                              message: String(e),
                              data: undefined,
                          };
                // @ts-ignore generic result narrowing
                return { data: null, error };
            }
        },
        close(code?: number, reason?: string) {
            manualClose = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            stopHeartbeat();
            try {
                ws.close(code, reason);
            } catch {}
        },
    };
}

/**
 * Codegen-free typed client. Infers the full client surface (events, commands,
 * RPCs, typed errors, query/headers) directly from a server `Channel` type — no
 * CLI step, no generated file, no global `declare module`. Same runtime as
 * {@link websocketAsyncAPI}.
 *
 * ```ts
 * import type { chat } from "./server";       // the Channel value's type
 * import { createClient } from "@ws-asyncapi/client";
 *
 * const client = createClient<typeof chat>("ws://localhost:3000", "/chat/1");
 * client.onEvent("message", (m) => m.text);            // typed
 * const { items } = await client.request("history", { limit: 50 }); // typed
 * ```
 */
export function createClient<C extends AnyChannel>(
    url: string,
    path: InferClient<C>["address"],
    options?: WebsocketAsyncAPIOptions<
        AsRecord<InferClient<C>["query"]>,
        AsRecord<InferClient<C>["headers"]>
    >,
): WsClient<InferClient<C>> {
    // The runtime is identical; only the static type differs (inferred from the
    // channel here, vs. the generated WebsocketAsyncAPIMap in websocketAsyncAPI).
    const connect = websocketAsyncAPI as unknown as (
        u: string,
        p: string,
        o?: unknown,
    ) => WsClient<InferClient<C>>;
    return connect(url, path as string, options);
}
