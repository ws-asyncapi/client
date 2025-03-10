import type {
    CloseEvent,
    FindMatchingAddressKey,
    OpenEvent,
    WebsocketAsyncAPIMap,
    WebsocketAsyncAPIOptions,
} from "./types.ts";
import { joinUrlPath } from "./utils.ts";

export * from "./types.ts";

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
    const fullUrl = joinUrlPath(url, path);
    const ws = new WebSocket(fullUrl);
    const promise = new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
            resolve();
        };
        ws.onerror = (event) => {
            reject(event);
        };
    });

    return {
        "~original": ws as WebSocket,
        opened: promise,
        onOpen: (callback: (data: OpenEvent) => void) => {
            ws.onopen = callback;
        },
        onClose: (callback: (data: CloseEvent) => void) => {
            ws.onclose = callback;
        },
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
        >(
            command: Command,
            // @ts-ignore hack to generate declare module statements
            ...data: T["commandMap"][Command] extends never
                ? []
                : // @ts-ignore hack to generate declare module statements
                  [T["commandMap"][Command]]
        ) => {
            ws.send(JSON.stringify([command, ...data]));
        },
    };
}
