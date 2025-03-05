// biome-ignore lint/suspicious/noEmptyInterface: <explanation>
export interface WebsocketAsyncAPIMap {}

export function websocketAsyncAPI<
    // @ts-ignore hack to generate declare module statements
    T = {
        // @ts-ignore hack to generate declare module statements
        commandMap: WebsocketAsyncAPIMap["data"]["commandMap"];
        // @ts-ignore hack to generate declare module statements
        eventMap: WebsocketAsyncAPIMap["data"]["eventMap"];
    },
>(url: string) {
    const ws = new WebSocket(url);
    const promise = new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
            resolve();
        };
        ws.onerror = (event) => {
            reject(event);
        };
    });

    return {
        "~original": ws,
        opened: promise,
        // @ts-ignore hack to generate declare module statements
        onEvent: <Event extends keyof T["eventMap"]>(
            eventName: Event,
            // @ts-ignore hack to generate declare module statements
            callback: (data: T["eventMap"][Event]) => void,
        ) => {
            ws.addEventListener("message", (event) => {
                if (typeof event.data !== "string") return;

                const data = JSON.parse(event.data);
                if (data[0] === eventName) {
                    callback(data[1]);
                }
            });
        },
        call: <
            // @ts-ignore hack to generate declare module statements
            Command extends keyof T["commandMap"],
            // @ts-ignore hack to generate declare module statements
            Data = T["commandMap"][Command],
        >(
            command: Command,
            data: Data,
        ) => {
            ws.send(JSON.stringify([command, data]));
        },
    };
}
