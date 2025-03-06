# client

[![npm](https://img.shields.io/npm/v/@ws-asyncapi/client?logo=npm&style=flat&labelColor=000&color=3b82f6)](https://www.npmjs.org/package/@ws-asyncapi/client)
[![npm downloads](https://img.shields.io/npm/dw/@ws-asyncapi/client?logo=npm&style=flat&labelColor=000&color=3b82f6)](https://www.npmjs.org/package/@ws-asyncapi/client)

## Installation

```bash
npm install @ws-asyncapi/client
```

## Usage

Designed to work with [@ws-asyncapi/cli](https://github.com/ws-asyncapi/cli)

```bash
npx @ws-asyncapi/cli http://localhost:3005/asyncapi.json
```

```ts
import { websocketAsyncAPI } from "@ws-asyncapi/client";

const client = websocketAsyncAPI("ws://localhost:3005/test");

client.onEvent("response", (data) => {
    console.log(data.name);
});

client.onClose((data) => {
    console.log(data);
});

client.onOpen(() => {
    console.log("connected");
});

await client.opened;

client.call("test", {
    name: "test",
});
```

## TODO:

[ ] Redesign types for different channels
