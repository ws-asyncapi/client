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
    WebsocketAsyncAPIMap,
    WebsocketAsyncAPIOptions,
} from "./types.ts";
import { joinUrlPath } from "./utils.ts";

export * from "./types.ts";
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
    let openedSettled = false;

    const pending = new Map<number, PendingRequest>();
    const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
    const openHandlers = new Set<(event: OpenEvent) => void>();
    const closeHandlers = new Set<(event: CloseEvent) => void>();
    const errorHandlers = new Set<(event: Event) => void>();
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

    function handleFrame(frame: AnyFrame) {
        switch (frame[0]) {
            case Frame.Event: {
                const [, name, payload] = frame;
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
                const [, sid, , offset] = frame;
                sessionId = sid;
                lastOffset = offset;
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
        opened,
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
        ): Promise<T["rpcMap"][Command]["output"]> => {
            const corrId = ++corrSeq;
            const timeout = options?.timeout ?? requestTimeout;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(corrId);
                    reject(
                        new RpcError(
                            "TIMEOUT",
                            `RPC "${String(command)}" timed out after ${timeout}ms`,
                        ),
                    );
                }, timeout);
                pending.set(corrId, {
                    resolve: resolve as (value: unknown) => void,
                    reject,
                    timer,
                });
                send([Frame.Request, command as string, corrId, input]);
                // @ts-ignore generic Promise resolution
            });
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
