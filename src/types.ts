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
