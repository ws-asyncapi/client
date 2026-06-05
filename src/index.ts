import type { AnyChannel, InferClient, MaybePromise } from "ws-asyncapi";
import {
    type AnyFrame,
    CloseCode,
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
    WebSocketLike,
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

/** Buffers a server stream's items and bridges them to an async iterator. */
class StreamController {
    #queue: unknown[] = [];
    #waiting?: {
        resolve: (r: IteratorResult<unknown>) => void;
        reject: (e: unknown) => void;
    };
    #ended = false;
    #error?: unknown;

    push(value: unknown): void {
        if (this.#waiting) {
            this.#waiting.resolve({ value, done: false });
            this.#waiting = undefined;
        } else this.#queue.push(value);
    }
    end(): void {
        this.#ended = true;
        if (this.#waiting) {
            this.#waiting.resolve({ value: undefined, done: true });
            this.#waiting = undefined;
        }
    }
    fail(error: unknown): void {
        this.#error = error;
        this.#ended = true;
        if (this.#waiting) {
            this.#waiting.reject(error);
            this.#waiting = undefined;
        }
    }
    next(): Promise<IteratorResult<unknown>> {
        if (this.#queue.length)
            return Promise.resolve({ value: this.#queue.shift(), done: false });
        if (this.#error) return Promise.reject(this.#error);
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
            this.#waiting = { resolve, reject };
        });
    }
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
        // @ts-ignore hack to generate declare module statements
        serverRpcMap: WebsocketAsyncAPIMap["data"][Channel]["serverRpcMap"];
        // @ts-ignore hack to generate declare module statements
        streamMap: WebsocketAsyncAPIMap["data"][Channel]["streamMap"];
        // CLI codegen doesn't emit auth credentials yet → loosely typed on the
        // generated path; the codegen-free `createClient` infers it precisely.
        authCredentials: unknown;
        // CLI codegen doesn't emit presence state yet → loosely typed here.
        presenceState: unknown;
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
    const contractVersion = options?.contractVersion;

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

    const makeSocket =
        options?.socket ??
        ((u: string) => new WebSocket(u) as unknown as WebSocketLike);
    let ws: WebSocketLike;
    let connected = false;
    let manualClose = false;
    let retries = 0;
    let corrSeq = 0;
    let sessionId: string | null = null;
    let lastOffset: number | string = 0;
    let wasRecovered = false;
    let openedSettled = false;
    // last credentials passed to `authenticate`, re-sent after a reconnect so the
    // refreshed identity survives a transient drop. `undefined` until first use.
    let lastCredentials: unknown;
    let hasCredentials = false;
    // distinguishes the first handshake from reconnects (so we only auto-resend
    // credentials on a reconnect, not duplicate an initial `authenticate`).
    let firstWelcome = true;
    // presence: cached roster (socketId -> state), own id, observers, and the
    // last announced state (re-sent after a reconnect so we rejoin the roster).
    let presenceRoster = new Map<string, unknown>();
    let presenceSelf: string | null = null;
    let presenceHydrated = false;
    let lastPresenceState: unknown;
    let hasPresence = false;
    const presenceHandlers = new Set<(members: Map<string, unknown>) => void>();

    const pending = new Map<number, PendingRequest>();
    let streamSeq = 0;
    const streams = new Map<number, StreamController>();
    const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
    const openHandlers = new Set<(event: OpenEvent) => void>();
    const closeHandlers = new Set<(event: CloseEvent) => void>();
    const errorHandlers = new Set<(event: Event) => void>();
    const recoverHandlers = new Set<(recovered: boolean) => void>();
    // server→client RPC handlers, keyed by name
    const requestHandlers = new Map<
        string,
        (input: unknown) => unknown | Promise<unknown>
    >();
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
        if (connected && ws.readyState === 1 /* OPEN */) {
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

    function failAllStreams(error: RpcError) {
        for (const [, s] of streams) s.fail(error);
        streams.clear();
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
            send(
                options?.idempotencyKey
                    ? [
                          Frame.Request,
                          command,
                          corrId,
                          input,
                          options.idempotencyKey,
                      ]
                    : [Frame.Request, command, corrId, input],
            );
        });
    }

    function notifyPresence() {
        if (presenceHandlers.size === 0) return;
        const snapshot = new Map(presenceRoster);
        for (const cb of presenceHandlers) cb(snapshot);
    }

    /** Apply a roster snapshot (from a PresenceSet/PresenceQuery reply). */
    function applyPresenceSnapshot(payload: unknown) {
        const snap = payload as {
            self?: string;
            members?: Record<string, unknown>;
        };
        if (typeof snap?.self === "string") presenceSelf = snap.self;
        presenceRoster = new Map(Object.entries(snap?.members ?? {}));
        presenceHydrated = true;
        notifyPresence();
    }

    /** Send a presence request (Set/Query) and hydrate the roster from its reply. */
    function presenceRequest(
        kind: Frame.PresenceSet | Frame.PresenceQuery,
        state?: unknown,
    ): Promise<void> {
        const corrId = ++corrSeq;
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(corrId);
                reject(new RpcError("TIMEOUT", "presence request timed out"));
            }, requestTimeout);
            pending.set(corrId, {
                resolve: (payload) => {
                    applyPresenceSnapshot(payload);
                    resolve();
                },
                reject,
                timer,
            });
            send(
                kind === Frame.PresenceSet
                    ? [Frame.PresenceSet, corrId, state]
                    : [Frame.PresenceQuery, corrId],
            );
        });
    }

    /** Send an Auth frame and resolve/reject via the shared pending table (the
     *  server answers with a Reply/Error carrying the same corrId). */
    function doAuth(credentials: unknown): Promise<void> {
        const corrId = ++corrSeq;
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(corrId);
                reject(
                    new RpcError(
                        "TIMEOUT",
                        `authenticate timed out after ${requestTimeout}ms`,
                    ),
                );
            }, requestTimeout);
            pending.set(corrId, {
                resolve: () => resolve(),
                reject,
                timer,
            });
            send([Frame.Auth, corrId, credentials]);
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
                if (corrId === 0) {
                    // connection-level fatal error (e.g. version mismatch):
                    // stop reconnecting and surface a clear reason.
                    manualClose = true;
                    if (reconnectTimer) clearTimeout(reconnectTimer);
                    if (!openedSettled) {
                        openedSettled = true;
                        rejectOpened(new Error(`ws-asyncapi: ${message}`));
                    }
                    rejectAllPending(new RpcError(code, message, data));
                    try {
                        ws.close();
                    } catch {}
                    break;
                }
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
            case Frame.Request: {
                // server→client RPC: run the registered handler and reply
                const [, name, corrId, input] = frame;
                const handler = requestHandlers.get(name);
                if (!handler) {
                    send([
                        Frame.Error,
                        corrId,
                        "NOT_FOUND",
                        `No client handler for server RPC "${name}"`,
                    ]);
                    break;
                }
                Promise.resolve()
                    .then(() => handler(input))
                    .then(
                        (result) => send([Frame.Reply, corrId, result]),
                        (error: unknown) => {
                            const code =
                                error instanceof RpcError
                                    ? error.code
                                    : "INTERNAL";
                            const message =
                                error instanceof Error
                                    ? error.message
                                    : String(error);
                            const data =
                                error instanceof RpcError
                                    ? error.data
                                    : undefined;
                            send([Frame.Error, corrId, code, message, data]);
                        },
                    );
                break;
            }
            case Frame.StreamData: {
                streams.get(frame[1])?.push(frame[2]);
                break;
            }
            case Frame.StreamEnd: {
                streams.get(frame[1])?.end();
                streams.delete(frame[1]);
                break;
            }
            case Frame.StreamError: {
                const [, streamId, code, message, data] = frame;
                streams.get(streamId)?.fail(new RpcError(code, message, data));
                streams.delete(streamId);
                break;
            }
            case Frame.PresenceDiff: {
                // [18, room, socketId, state?] — state present = join/update,
                // absent (length 3) = leave
                const socketId = frame[2];
                if (frame.length > 3) presenceRoster.set(socketId, frame[3]);
                else presenceRoster.delete(socketId);
                notifyPresence();
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
                // handshake complete → the client is ready to use
                if (!openedSettled) {
                    openedSettled = true;
                    resolveOpened();
                }
                // re-present credentials after a reconnect so the server rebuilds
                // the refreshed context (its derive/resolve only saw the stale
                // connect-time token). Best-effort: the app can re-authenticate
                // explicitly if this fails (e.g. the refreshed token also expired).
                if (!firstWelcome && hasCredentials)
                    doAuth(lastCredentials).catch(() => {});
                // presence: a fresh connection has a new socket id and an empty
                // server-side roster entry, so re-announce our state (or re-fetch
                // the roster if we're only observing) after a reconnect.
                if (!firstWelcome) {
                    presenceHydrated = false;
                    if (hasPresence)
                        presenceRequest(
                            Frame.PresenceSet,
                            lastPresenceState,
                        ).catch(() => {});
                    else if (presenceHandlers.size > 0)
                        presenceRequest(Frame.PresenceQuery).catch(() => {});
                }
                firstWelcome = false;
                for (const cb of recoverHandlers) cb(wasRecovered);
                break;
            }
            default:
                break;
        }
    }

    function connect() {
        ws = makeSocket(fullUrl);
        ws.binaryType = "arraybuffer";

        ws.onopen = (event) => {
            connected = true;
            retries = 0;
            // recovery handshake first, then drain anything buffered offline
            rawSend(
                codec.encode(
                    contractVersion
                        ? [
                              Frame.Hello,
                              sessionId,
                              lastOffset,
                              PROTOCOL_VERSION,
                              contractVersion,
                          ]
                        : [
                              Frame.Hello,
                              sessionId,
                              lastOffset,
                              PROTOCOL_VERSION,
                          ],
                ),
            );
            flush();
            startHeartbeat();
            // `opened` resolves on the Welcome handshake (below), not here — so a
            // server that rejects the handshake (version mismatch) rejects
            // `opened` instead of resolving it. onOpen handlers still fire on the
            // raw socket open (they mean "connected", not "handshake ready").
            for (const cb of openHandlers)
                cb(event as unknown as OpenEvent);
        };

        ws.onmessage = (event) => {
            let frame: AnyFrame;
            try {
                frame = codec.decode(
                    event.data as string | ArrayBuffer | Uint8Array,
                );
            } catch {
                return;
            }
            if (!Array.isArray(frame)) return;
            handleFrame(frame);
        };

        ws.onerror = (event) => {
            for (const cb of errorHandlers) cb(event as Event);
            if (!openedSettled && !reconnectEnabled) {
                openedSettled = true;
                rejectOpened(event);
            }
        };

        ws.onclose = (event) => {
            connected = false;
            stopHeartbeat();
            // streams don't survive a reconnect (the server aborts them on
            // disconnect), so fail any active ones now.
            failAllStreams(new RpcError("INTERNAL", "connection closed"));
            for (const cb of closeHandlers)
                cb(event as unknown as CloseEvent);

            // Version-mismatch closes are fatal: reconnecting won't fix a skew,
            // so stop and surface a clear reason.
            const code = (event as { code?: number }).code;
            const fatal =
                code === CloseCode.PROTOCOL_MISMATCH ||
                code === CloseCode.CONTRACT_MISMATCH;

            if (
                manualClose ||
                fatal ||
                !reconnectEnabled ||
                retries >= maxRetries
            ) {
                rejectAllPending(
                    new RpcError("INTERNAL", "connection closed"),
                );
                if (!openedSettled) {
                    openedSettled = true;
                    rejectOpened(
                        fatal
                            ? new Error(
                                  `ws-asyncapi: ${
                                      (event as { reason?: string }).reason ||
                                      "version mismatch"
                                  }`,
                              )
                            : event,
                    );
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
        // @ts-ignore hack to generate declare module statements
        onRequest: <Name extends keyof T["serverRpcMap"]>(
            name: Name,
            // @ts-ignore hack to generate declare module statements
            handler: (input: T["serverRpcMap"][Name]["input"]) => MaybePromise<
                // @ts-ignore hack to generate declare module statements
                T["serverRpcMap"][Name]["output"]
            >,
        ) => {
            requestHandlers.set(
                name as string,
                handler as (input: unknown) => unknown,
            );
            return () => requestHandlers.delete(name as string);
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
         * Open a typed stream and consume it with `for await`. Stopping iteration
         * (a `break`, `return`, or throw) sends a StreamStop so the server cancels
         * the handler. A server-side error surfaces as a thrown `RpcError`.
         */
        stream: <
            // @ts-ignore hack to generate declare module statements
            Name extends keyof T["streamMap"],
        >(
            name: Name,
            // @ts-ignore hack to generate declare module statements
            input: T["streamMap"][Name]["input"],
            // @ts-ignore hack to generate declare module statements
        ): AsyncIterable<T["streamMap"][Name]["output"]> => {
            const streamId = ++streamSeq;
            const controller = new StreamController();
            streams.set(streamId, controller);
            send([Frame.StreamStart, name as string, streamId, input]);
            return {
                [Symbol.asyncIterator]() {
                    return {
                        next: () =>
                            controller.next() as Promise<
                                IteratorResult<unknown>
                            >,
                        // consumer stopped early (break/return) → cancel server-side
                        return: (value?: unknown) => {
                            if (streams.delete(streamId) && connected)
                                send([Frame.StreamStop, streamId]);
                            return Promise.resolve({ value, done: true });
                        },
                    };
                },
                // @ts-ignore generic async iterable
            } as AsyncIterable<T["streamMap"][Name]["output"]>;
        },
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
        /**
         * Refresh credentials on the live connection (token refresh). The server
         * re-runs `.onAuth` and replaces the connection context — no reconnect.
         * The credentials are remembered and re-sent automatically after a
         * reconnect. Rejects with a typed `RpcError` if the server rejects them.
         */
        authenticate: (
            // @ts-ignore hack to generate declare module statements
            credentials: T["authCredentials"],
        ): Promise<void> => {
            lastCredentials = credentials;
            hasCredentials = true;
            return doAuth(credentials);
        },
        // @ts-ignore hack to generate declare module statements
        presence: {
            get self() {
                return presenceSelf;
            },
            // @ts-ignore presence state typed from the channel
            set: (state: T["presenceState"]): Promise<void> => {
                lastPresenceState = state;
                hasPresence = true;
                return presenceRequest(Frame.PresenceSet, state);
            },
            clear: (): Promise<void> => {
                hasPresence = false;
                lastPresenceState = undefined;
                send([Frame.PresenceClear]);
                return Promise.resolve();
            },
            // @ts-ignore presence state typed from the channel
            get: (): Map<string, T["presenceState"]> =>
                new Map(presenceRoster) as never,
            subscribe: (
                // @ts-ignore presence state typed from the channel
                callback: (members: Map<string, T["presenceState"]>) => void,
            ): (() => void) => {
                presenceHandlers.add(
                    callback as (m: Map<string, unknown>) => void,
                );
                // hydrate on first interest; otherwise hand over what we have
                if (!presenceHydrated)
                    presenceRequest(Frame.PresenceQuery).catch(() => {});
                else callback(new Map(presenceRoster) as never);
                return () =>
                    presenceHandlers.delete(
                        callback as (m: Map<string, unknown>) => void,
                    );
            },
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
