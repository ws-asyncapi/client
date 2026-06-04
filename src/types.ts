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
}

export interface RequestOptions {
    /** override the default RPC timeout for this call (ms) */
    timeout?: number;
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
    close(code?: number, reason?: string): void;
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
