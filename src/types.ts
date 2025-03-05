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
