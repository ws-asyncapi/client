import type { Codec } from "ws-asyncapi/wire";

/**
 * Augmented by the generated file from `@ws-asyncapi/cli`. Each channel exposes
 * its `addresses`, and per-channel `query`/`headers`/`commandMap`/`eventMap`/
 * `rpcMap`.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by codegen
export interface WebsocketAsyncAPIMap {}

export interface CloseEvent {
    wasClean: boolean;
    code: number;
    reason: string;
    type: string;
    target: WebSocket;
}

export interface OpenEvent {
    type: string;
    target: WebSocket;
}

export type FindMatchingAddressKey<
    T extends Record<string, string>,
    Input extends string,
> = {
    [K in keyof T]: Input extends T[K] ? K : never;
}[keyof T];

export interface ReconnectOptions {
    /** max reconnection attempts before giving up (default: Infinity) */
    maxRetries?: number;
    /** base backoff delay in ms (default: 500) */
    baseDelay?: number;
    /** max backoff delay in ms (default: 10_000) */
    maxDelay?: number;
}

export interface HeartbeatOptions {
    /** how often to send a ping in ms (default: 25_000) */
    interval?: number;
    /** how long to wait for a pong before reconnecting in ms (default: 10_000) */
    timeout?: number;
}

export interface WebsocketAsyncAPIOptions<
    Query extends Record<string, string> = Record<string, string>,
    Headers extends Record<string, string> = Record<string, string>,
> {
    query?: Query;
    /**
     * Kept for API parity / SSR; browser `WebSocket` cannot set request
     * headers, so this is ignored in the browser.
     */
    headers?: Headers;
    /** wire codec (default: JSON) */
    codec?: Codec;
    /** auto-reconnect with exponential backoff (default: true) */
    reconnect?: boolean | ReconnectOptions;
    /** heartbeat ping/pong liveness detection (default: true) */
    heartbeat?: boolean | HeartbeatOptions;
    /** default RPC timeout in ms (default: 30_000) */
    requestTimeout?: number;
    /** max outbound frames buffered while disconnected (default: 1024) */
    maxBufferSize?: number;
    /**
     * Coalesce volatile `presence.update` calls (cursors) to the latest, flushed
     * at most every N ms (default: 0 = send each immediately). ~50ms (~20Hz) is a
     * good cursor default; the receiver smooths between samples.
     */
    presenceThrottle?: number;
    /**
     * Custom transport factory (default: `new WebSocket(url)`). Supply one for a
     * non-browser environment or an in-memory pipe (see `@ws-asyncapi/testing`).
     */
    socket?: (url: string) => WebSocketLike;
    /**
     * Contract version sent in the handshake. If the server's contract hash
     * differs, the server rejects the connection (close 4409) and the client
     * stops reconnecting and rejects `opened`. The CLI-generated client supplies
     * this automatically; for the codegen-free client pass `contractHash(channel)`
     * if you want runtime contract checking.
     */
    contractVersion?: string;
}

/**
 * Minimal WebSocket surface the client drives — enough to plug in a custom
 * transport (SSR/Node, React Native, or an in-memory pipe for tests) via the
 * `socket` option. The browser `WebSocket` satisfies it.
 */
export interface WebSocketLike {
    binaryType?: string;
    /** 0 CONNECTING · 1 OPEN · 2 CLOSING · 3 CLOSED */
    readonly readyState: number;
    send(data: string | Uint8Array): void;
    close(code?: number, reason?: string): void;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    onclose: ((event: unknown) => void) | null;
}

export interface RequestOptions {
    /** override the default RPC timeout for this call (ms) */
    timeout?: number;
    /**
     * Stable idempotency key. When set, the server runs the handler once per key
     * and replays the cached result to duplicates — so retrying the same call
     * (e.g. after a reconnect) won't execute side effects twice. Generate one key
     * per logical action and reuse it across retries.
     */
    idempotencyKey?: string;
}

/**
 * The fully-typed client surface, parameterized by a channel's maps. Returned by
 * `createClient<typeof channel>()` (codegen-free) and structurally identical to
 * what `websocketAsyncAPI` returns for a CLI-generated channel.
 */
export interface WsClient<
    T extends {
        // biome-ignore lint/suspicious/noExplicitAny: map value types are per-channel
        commandMap: Record<string, any>;
        // biome-ignore lint/suspicious/noExplicitAny: map value types are per-channel
        eventMap: Record<string, any>;
        rpcMap: Record<
            string,
            // biome-ignore lint/suspicious/noExplicitAny: per-channel io/errors
            { input: any; output: any; errors: Record<string, any> }
        >;
        // biome-ignore lint/suspicious/noExplicitAny: per-channel io
        serverRpcMap: Record<string, { input: any; output: any }>;
        // biome-ignore lint/suspicious/noExplicitAny: per-channel io
        streamMap: Record<string, { input: any; output: any }>;
        // biome-ignore lint/suspicious/noExplicitAny: per-channel credentials shape
        authCredentials?: any;
        // biome-ignore lint/suspicious/noExplicitAny: per-channel presence state shape
        presenceState?: any;
    },
> {
    /** the underlying browser WebSocket (current connection) */
    readonly "~original": WebSocket;
    readonly connected: boolean;
    /** server-assigned session id (stable across reconnects) */
    readonly sessionId: string | null;
    /** whether the most recent (re)connect recovered missed events */
    readonly recovered: boolean;
    /** resolves once the first connection opens */
    readonly opened: Promise<void>;
    onOpen(callback: (event: OpenEvent) => void): () => void;
    onClose(callback: (event: CloseEvent) => void): () => void;
    onError(callback: (event: Event) => void): () => void;
    onRecover(callback: (recovered: boolean) => void): () => void;
    onEvent<E extends keyof T["eventMap"]>(
        event: E,
        callback: (data: T["eventMap"][E]) => void,
    ): () => void;
    /** Answer a server→client RPC: receive the server's input, return output. */
    onRequest<N extends keyof T["serverRpcMap"]>(
        name: N,
        handler: (
            input: T["serverRpcMap"][N]["input"],
        ) =>
            | T["serverRpcMap"][N]["output"]
            | Promise<T["serverRpcMap"][N]["output"]>,
    ): () => void;
    call<C extends keyof T["commandMap"]>(
        command: C,
        ...data: T["commandMap"][C] extends never ? [] : [T["commandMap"][C]]
    ): void;
    request<C extends keyof T["rpcMap"]>(
        command: C,
        input: T["rpcMap"][C]["input"],
        options?: RequestOptions,
    ): Promise<T["rpcMap"][C]["output"]>;
    safeRequest<C extends keyof T["rpcMap"]>(
        command: C,
        input: T["rpcMap"][C]["input"],
        options?: RequestOptions,
    ): Promise<SafeResult<T["rpcMap"][C]["output"], T["rpcMap"][C]["errors"]>>;
    /** Open a typed stream; consume with `for await`. Stopping iteration cancels
     *  it server-side; a server error throws an `RpcError` into the loop. */
    stream<N extends keyof T["streamMap"]>(
        name: N,
        input: T["streamMap"][N]["input"],
    ): AsyncIterable<T["streamMap"][N]["output"]>;
    /**
     * Refresh credentials on the live connection (token refresh) — the server
     * re-runs its `.onAuth` handler and replaces the connection context without a
     * reconnect. Resolves once accepted; rejects with a typed `RpcError` if the
     * server rejects the credentials. The last credentials passed are re-sent
     * automatically after a reconnect, so the refreshed identity survives drops.
     */
    authenticate(credentials: T["authCredentials"]): Promise<void>;
    /**
     * Typed presence: announce this connection's state, observe the room roster,
     * or leave. Available when the channel declares `.presence(...)`. Join/leave/
     * update changes are delivered as diffs and reconciled into a live roster; the
     * last announced state is re-sent automatically after a reconnect.
     */
    presence: PresenceApi<T["presenceState"]>;
    /**
     * Fetch a room's retained recent events (history / rewind) — e.g. the chat
     * backlog when opening a room. Returns a typed, discriminated list (narrow on
     * `entry.event`). Only rooms this connection is subscribed to are readable.
     * Requires `.history(event)` on the server; otherwise resolves to `[]`.
     */
    history(
        room: string,
        options?: { limit?: number },
    ): Promise<HistoryEntry<T["eventMap"]>[]>;
    close(code?: number, reason?: string): void;
}

/**
 * One entry from {@link WsClient.history}: a discriminated union over the
 * channel's events, so `if (entry.event === "message")` narrows `entry.data`.
 */
export type HistoryEntry<EventMap> = {
    [E in keyof EventMap]: { event: E; data: EventMap[E] };
}[keyof EventMap];

/** The `client.presence` surface, typed by the channel's `.presence` schema. */
export interface PresenceApi<State> {
    /** this connection's own socket id (known once the roster is hydrated) */
    readonly self: string | null;
    /**
     * Announce or update this connection's presence state. Resolves once the
     * server has accepted it and returned the current roster (which hydrates
     * {@link get}/{@link subscribe}); rejects with an `RpcError` if rejected.
     */
    set(state: State): Promise<void>;
    /**
     * **Volatile** presence update — the cursor hot path. Fire-and-forget
     * (no ack, no roster snapshot), last-write-wins, dropped while offline, and
     * coalesced to the latest per `presenceThrottle` window. Merges the patch
     * into the last-known state, so `update({ cursor })` keeps other fields. Call
     * {@link set} once first to join the roster.
     */
    update(patch: Partial<State>): void;
    /** Leave presence (stay connected). Other members receive a leave diff. */
    clear(): Promise<void>;
    /** The current cached roster: socket id → state. */
    get(): Map<string, State>;
    /**
     * Observe the roster live. The callback fires with the full roster on every
     * change (join/leave/update). Returns an unsubscribe function. The first
     * subscriber triggers a snapshot fetch if the roster isn't hydrated yet.
     */
    subscribe(callback: (members: Map<string, State>) => void): () => void;
}

/** Built-in error codes the runtime can produce in addition to declared ones. */
export type BuiltinErrorCode =
    | "VALIDATION"
    | "NOT_FOUND"
    | "INTERNAL"
    | "TIMEOUT"
    | "OVERLOADED";

/**
 * A typed RPC error: either one of the codes declared in the contract (with its
 * `data` payload typed), or a built-in runtime code (`data` is `unknown`). The
 * codes are kept as distinct literals so `if (error.code === "X")` narrows to
 * the typed `data` for that code. (Undeclared custom codes still arrive at
 * runtime — reach them via `request()` + `catch` on the open-coded `RpcError`.)
 */
export type TypedRpcError<Errors> =
    | {
          [C in keyof Errors]: { code: C; message: string; data: Errors[C] };
      }[keyof Errors]
    | { code: BuiltinErrorCode; message: string; data: unknown };

/**
 * Result of `safeRequest`: a discriminated union you narrow on `error`. On
 * success `error` is `null`; on failure `data` is `null` and `error` carries a
 * typed, discriminated code.
 */
export type SafeResult<Output, Errors> =
    | { data: Output; error: null }
    | { data: null; error: TypedRpcError<Errors> };
