import { describe, expect, it } from "bun:test";
import { Frame, jsonCodec, RpcError } from "ws-asyncapi";
import { createClient } from "../src/index.ts";

// Deterministic unit tests for the client's resilience machinery (handshake,
// pending table, offline buffering, reconnect/backoff, heartbeat watchdog,
// connection-state recovery, credential re-send) driven by a scripted fake
// socket — no real network, no real server.

type WireFrame = [number, ...unknown[]];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeSocket {
	binaryType = "arraybuffer";
	readyState = 0;
	onopen: ((e: unknown) => void) | null = null;
	onmessage: ((e: { data: unknown }) => void) | null = null;
	onerror: ((e: unknown) => void) | null = null;
	onclose: ((e: unknown) => void) | null = null;
	sent: WireFrame[] = [];

	send(data: string | Uint8Array): void {
		this.sent.push(jsonCodec.decode(data) as WireFrame);
	}
	close(code?: number, reason?: string): void {
		if (this.readyState === 3) return;
		this.readyState = 3;
		queueMicrotask(() =>
			this.onclose?.({ code: code ?? 1000, reason: reason ?? "" }),
		);
	}

	// --- test controls ---
	fireOpen(): void {
		this.readyState = 1;
		this.onopen?.({});
	}
	recv(frame: WireFrame): void {
		this.onmessage?.({ data: jsonCodec.encode(frame) });
	}
	/** simulate an unclean server-side drop (triggers reconnect) */
	drop(code = 1006): void {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.onclose?.({ code });
	}
	find(kind: number): WireFrame | undefined {
		return this.sent.find((f) => f[0] === kind);
	}
	all(kind: number): WireFrame[] {
		return this.sent.filter((f) => f[0] === kind);
	}
}

function transport() {
	const sockets: FakeSocket[] = [];
	return {
		sockets,
		factory: () => {
			const s = new FakeSocket();
			sockets.push(s);
			return s as never;
		},
		last: () => sockets[sockets.length - 1],
	};
}

/** Stand up a client and complete the Welcome handshake. */
async function connected(opts: Record<string, unknown> = {}) {
	const t = transport();
	// biome-ignore lint/suspicious/noExplicitAny: erased channel
	const c = createClient<any>("ws://test", "/room/1", {
		socket: t.factory,
		heartbeat: false,
		...opts,
	});
	const s = t.last();
	s.fireOpen();
	s.recv([Frame.Welcome, "sess-1", 0, 0]);
	await c.opened;
	return { c, t, s };
}

describe("handshake", () => {
	it("opened resolves on Welcome and assigns the session id", async () => {
		const { c } = await connected();
		expect(c.connected).toBe(true);
		expect(c.sessionId).toBe("sess-1");
		c.close();
	});

	it("sends a Hello on connect", async () => {
		const { s, c } = await connected();
		const hello = s.find(Frame.Hello);
		expect(hello).toBeDefined();
		c.close();
	});
});

describe("pending table", () => {
	it("resolves a request from its Reply by corrId", async () => {
		const { c, s } = await connected();
		const p = c.request("add", { a: 1 });
		const req = s.find(Frame.Request) as WireFrame;
		const corrId = req[2] as number;
		s.recv([Frame.Reply, corrId, { sum: 1 }]);
		expect(await p).toEqual({ sum: 1 });
		c.close();
	});

	it("rejects a request from a typed Error frame", async () => {
		const { c, s } = await connected();
		const p = c.request("boom", {});
		const corrId = (s.find(Frame.Request) as WireFrame)[2] as number;
		s.recv([Frame.Error, corrId, "FORBIDDEN", "no", { why: "x" }]);
		await expect(p).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: { why: "x" },
		});
		c.close();
	});

	it("times out when no reply arrives", async () => {
		const { c } = await connected();
		await expect(
			c.request("slow", {}, { timeout: 30 }),
		).rejects.toMatchObject({ code: "TIMEOUT" });
		c.close();
	});
});

describe("offline buffering", () => {
	it("buffers commands while disconnected and flushes on open", async () => {
		const t = transport();
		// biome-ignore lint/suspicious/noExplicitAny: erased
		const c = createClient<any>("ws://test", "/room/1", {
			socket: t.factory,
			heartbeat: false,
		});
		const s = t.last();
		// not opened yet → buffered
		c.call("hello", { n: 1 });
		expect(s.all(Frame.Command)).toHaveLength(0);
		s.fireOpen();
		s.recv([Frame.Welcome, "sess-1", 0, 0]);
		await c.opened;
		const cmds = s.all(Frame.Command);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]).toEqual([Frame.Command, "hello", { n: 1 }]);
		c.close();
	});

	it("drops the oldest past the buffer cap", async () => {
		const t = transport();
		// biome-ignore lint/suspicious/noExplicitAny: erased
		const c = createClient<any>("ws://test", "/room/1", {
			socket: t.factory,
			heartbeat: false,
			maxBufferSize: 2,
		});
		const s = t.last();
		c.call("a", { n: 1 });
		c.call("a", { n: 2 });
		c.call("a", { n: 3 }); // evicts n:1
		s.fireOpen();
		s.recv([Frame.Welcome, "sess-1", 0, 0]);
		await c.opened;
		const ns = s
			.all(Frame.Command)
			.map((f) => (f[2] as { n: number }).n);
		expect(ns).toEqual([2, 3]);
		c.close();
	});
});

describe("reconnect", () => {
	it("opens a new socket after an unclean drop", async () => {
		const { c, t, s } = await connected({
			reconnect: { baseDelay: 5 },
		});
		expect(t.sockets).toHaveLength(1);
		s.drop(1006);
		await wait(40);
		expect(t.sockets.length).toBeGreaterThanOrEqual(2);
		// the new socket completes a fresh handshake
		const s2 = t.last();
		s2.fireOpen();
		s2.recv([Frame.Welcome, "sess-1", 1, 0]);
		expect(c.connected).toBe(true);
		c.close();
	});

	it("does not reconnect after a fatal contract-mismatch close", async () => {
		const t = transport();
		// biome-ignore lint/suspicious/noExplicitAny: erased
		const c = createClient<any>("ws://test", "/room/1", {
			socket: t.factory,
			heartbeat: false,
			reconnect: { baseDelay: 5 },
		});
		const s = t.last();
		s.fireOpen();
		s.drop(4409); // CONTRACT_MISMATCH → fatal
		await expect(c.opened).rejects.toBeDefined();
		await wait(40);
		expect(t.sockets).toHaveLength(1); // never reconnected
		c.close();
	});
});

describe("heartbeat", () => {
	it("pings on the interval and reconnects when no pong arrives", async () => {
		const { t, s, c } = await connected({
			heartbeat: { interval: 10, timeout: 10 },
			reconnect: { baseDelay: 5 },
		});
		await wait(15);
		expect(s.find(Frame.Ping)).toBeDefined();
		// no Pong → watchdog closes the socket → reconnect
		await wait(40);
		expect(t.sockets.length).toBeGreaterThanOrEqual(2);
		c.close();
	});

	it("a Pong keeps the connection alive (no reconnect)", async () => {
		const { t, s, c } = await connected({
			heartbeat: { interval: 10, timeout: 30 },
		});
		// answer pings promptly for a while
		for (let i = 0; i < 4; i++) {
			await wait(12);
			const ping = s.find(Frame.Ping);
			if (ping) s.recv([Frame.Pong, ping[1] as number]);
		}
		expect(t.sockets).toHaveLength(1);
		c.close();
	});
});

describe("connection-state recovery", () => {
	it("reconnect Hello carries the session id and last seen offset", async () => {
		const { c, t, s } = await connected({ reconnect: { baseDelay: 5 } });
		// an event with an offset advances the recovery cursor
		s.recv([Frame.Event, "message", { text: "x" }, 42]);
		s.drop(1006);
		await wait(40);
		const s2 = t.last();
		s2.fireOpen();
		const hello = s2.find(Frame.Hello) as WireFrame;
		expect(hello[1]).toBe("sess-1"); // session id
		expect(hello[2]).toBe(42); // last seen offset
		c.close();
	});

	it("recovered=1 flips client.recovered and fires onRecover", async () => {
		const { c, t, s } = await connected({ reconnect: { baseDelay: 5 } });
		let recovered: boolean | null = null;
		c.onRecover((r) => {
			recovered = r;
		});
		s.drop(1006);
		await wait(40);
		const s2 = t.last();
		s2.fireOpen();
		s2.recv([Frame.Welcome, "sess-1", 1, 99]);
		expect(c.recovered).toBe(true);
		expect(recovered).toBe(true);
		c.close();
	});
});

describe("credentials", () => {
	it("re-sends credentials automatically after a reconnect", async () => {
		const { c, t, s } = await connected({ reconnect: { baseDelay: 5 } });
		const authP = c.authenticate({ token: "t1" });
		const auth = s.find(Frame.Auth) as WireFrame;
		s.recv([Frame.Reply, auth[1] as number, {}]);
		await authP;

		s.drop(1006);
		await wait(40);
		const s2 = t.last();
		s2.fireOpen();
		s2.recv([Frame.Welcome, "sess-1", 1, 0]);
		// credentials re-presented on the new socket without a manual call
		expect(s2.find(Frame.Auth)).toBeDefined();
		c.close();
	});
});
