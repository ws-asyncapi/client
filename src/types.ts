// biome-ignore lint/suspicious/noEmptyInterface: <explanation>
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

// Useless because we precompute the paths but interesting
// type ExpandPathPattern<Path extends string> =
//     Path extends `${infer Prefix}/{${string}}${infer Suffix}`
//         ? `${Prefix}/${string}${ExpandPathPattern<Suffix>}`
//         : Path;

export interface WebsocketAsyncAPIOptions<
    Query extends Record<string, string> = Record<string, string>,
    Headers extends Record<string, string> = Record<string, string>,
> {
    query?: Query;
    headers?: Headers;
}
