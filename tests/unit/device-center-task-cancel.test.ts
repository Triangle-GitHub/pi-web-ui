import http from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeviceRelay, RELAY_LIMITS, safePath } from "../../server/device-center/relay.js";
import { createDeviceConnector } from "../../server/device-center/connector.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const fn of cleanup.reverse()) fn();
	cleanup.length = 0;
});
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function fixture(onTask?: Parameters<typeof createDeviceConnector>[0]["onTask"]) {
	const server = http.createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	cleanup.push(() => {
		server.closeAllConnections();
		server.close();
	});
	const events = vi.fn();
	const relay = createDeviceRelay({
		server,
		publicUrl: origin,
		authenticateDevice: (id, key) => id === "dev1" && key === "secret",
		getAccount: () => ({ id: "account" }),
		ownsDevice: () => true,
		onTaskEvent: events,
	});
	cleanup.push(() => relay.close());
	let connector: ReturnType<typeof createDeviceConnector> | undefined;
	let peer: WebSocket | undefined;
	if (onTask) {
		connector = createDeviceConnector({
			hubUrl: origin,
			deviceId: "dev1",
			credential: "secret",
			localOrigin: origin,
			onTask,
		});
		cleanup.push(() => connector!.close());
	} else {
		peer = new WebSocket(`${origin.replace("http", "ws")}/device-connect?deviceId=dev1`, {
			headers: { authorization: "Bearer secret" },
		});
		cleanup.push(() => peer!.terminate());
		await once(peer, "open");
	}
	await vi.waitFor(() => expect(relay.isOnline("dev1")).toBe(true));
	const task = (id = "task1", attemptId = "attempt1") => ({
		id,
		attemptId,
		botId: "bot1",
		botRevision: 1,
		deviceId: "dev1",
	});
	return { relay, events, connector, peer: peer!, task, origin };
}

describe("transport-confirmed task cancellation", () => {
	it("waits for aborted task settlement and suppresses terminal events", async () => {
		const exit = deferred();
		let signal!: AbortSignal;
		const f = await fixture(async (_task, current) => {
			signal = current!;
			await exit.promise;
			return "late result";
		});
		expect(f.relay.sendTask("dev1", f.task())).toBe(true);
		await vi.waitFor(() => expect(signal).toBeDefined());
		let settled = false;
		const cancel = f.relay.cancelTask("dev1", "task1", "attempt1").then((result) => {
			settled = true;
			return result;
		});
		await vi.waitFor(() => expect(signal.aborted).toBe(true));
		expect(settled).toBe(false);
		exit.resolve();
		expect(await cancel).toEqual({ stopped: true });
		expect(f.events.mock.calls.map((call) => call[1].status)).toEqual(["running"]);
		expect(await f.relay.cancelTask("dev1", "task1", "attempt1")).toEqual({ stopped: false });
	});

	it("aborts queued work and awaits its promise without starting execution", async () => {
		const queue = deferred();
		const started: string[] = [];
		const entered: string[] = [];
		let queuedSignal: AbortSignal | undefined;
		const f = await fixture(async (task, signal) => {
			entered.push(task.id);
			if (task.id === "queued") queuedSignal = signal;
			await queue.promise;
			signal!.throwIfAborted();
			started.push(task.id);
		});
		f.relay.sendTask("dev1", f.task("active"));
		f.relay.sendTask("dev1", f.task("queued"));
		await vi.waitFor(() => expect(entered).toHaveLength(2));
		const cancel = f.relay.cancelTask("dev1", "queued", "attempt1");
		await vi.waitFor(() => expect(queuedSignal?.aborted).toBe(true));
		queue.resolve();
		expect(await cancel).toEqual({ stopped: true });
		expect(started).toEqual(["active"]);
	});

	it("does not confirm runtime stop uncertainty", async () => {
		let abort!: () => void;
		const f = await fixture(
			(_task, signal) =>
				new Promise((_, reject) => {
					abort = () => reject(Object.assign(new Error("private stop failure"), { stopUnconfirmed: true }));
					signal!.addEventListener("abort", abort, { once: true });
				}),
		);
		f.relay.sendTask("dev1", f.task());
		await vi.waitFor(() => expect(abort).toBeDefined());
		expect(await f.relay.cancelTask("dev1", "task1", "attempt1")).toEqual({ stopped: false });
	});

	it("rejects offline and mismatched attempts without sending cancellation", async () => {
		const f = await fixture();
		const frames: any[] = [];
		f.peer.on("message", (raw) => frames.push(JSON.parse(String(raw))));
		f.relay.sendTask("dev1", f.task());
		expect(await f.relay.cancelTask("missing", "task1", "attempt1")).toEqual({ stopped: false });
		expect(await f.relay.cancelTask("dev1", "task1", "wrong")).toEqual({ stopped: false });
		await vi.waitFor(() => expect(frames).toHaveLength(1));
		expect(frames[0].type).toBe("task");
	});

	it("times out after ten seconds and bounds pending cancellations", async () => {
		const f = await fixture();
		f.relay.sendTask("dev1", f.task());
		vi.useFakeTimers();
		const pending = Array.from({ length: RELAY_LIMITS.cancellations }, () =>
			f.relay.cancelTask("dev1", "task1", "attempt1"),
		);
		expect(await f.relay.cancelTask("dev1", "task1", "attempt1")).toEqual({ stopped: false });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await Promise.all(pending)).toEqual(pending.map(() => ({ stopped: false })));
	});

	it("settles false on connection replacement and ignores old acknowledgements", async () => {
		const f = await fixture();
		f.relay.sendTask("dev1", f.task());
		const cancel = f.relay.cancelTask("dev1", "task1", "attempt1");
		const replacement = new WebSocket(`${f.origin.replace("http", "ws")}/device-connect?deviceId=dev1`, {
			headers: { authorization: "Bearer secret" },
		});
		cleanup.push(() => replacement.terminate());
		await once(replacement, "open");
		expect(await cancel).toEqual({ stopped: false });
		expect(f.relay.sendTask("dev1", f.task())).toBe(true);
	});

	it("requires acknowledgement task and attempt binding", async () => {
		const f = await fixture();
		f.peer.on("message", (raw) => {
			const frame = JSON.parse(String(raw));
			if (frame.type === "task_cancel")
				f.peer.send(JSON.stringify({ ...frame, type: "task_cancelled", attemptId: "wrong", stopped: true }));
		});
		f.relay.sendTask("dev1", f.task());
		expect(await f.relay.cancelTask("dev1", "task1", "attempt1")).toEqual({ stopped: false });
	});
});

describe("portal conversation routes", () => {
	it("allows exact account conversation operations and clear", () => {
		for (const path of ["/rooms/r/conversations", "/rooms/r/conversations/c"])
			expect(safePath(`/api/device-center${path}`, "GET")).toBe(true);
		for (const path of [
			"/rooms/r/clear",
			"/rooms/r/conversations",
			"/rooms/r/conversations/c/messages",
			"/rooms/r/conversations/c/stop",
		])
			expect(safePath(`/api/device-center${path}`, "POST")).toBe(true);
		for (const method of ["GET", "POST", "WS"])
			for (const path of [
				"/settings",
				"/rooms/r/conversations/c/settings",
				"/rooms/r/conversations/c/messages/extra",
				"/rooms/r/conversations/%252e%252e/settings",
			])
				expect(safePath(`/api/device-center${path}`, method)).toBe(false);
	});
});
