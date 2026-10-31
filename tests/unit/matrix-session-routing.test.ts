import { describe, expect, it, vi } from "vitest";
import { MatrixBotBridge } from "../../plugins/matrix/index.mjs";

function setup(
	saved = new Map<string, any>(),
	config = { homeserverUrl: "https://matrix.test", accessToken: "token" },
) {
	let listener: any;
	const host = {
		storage: {
			get: vi.fn(async (key: string) => structuredClone(saved.get(key))),
			set: vi.fn(async (key: string, value: any) => {
				saved.set(key, structuredClone(value));
			}),
		},
		chat: vi.fn(async (request: any) => ({
			conversationId: "c1",
			clientId: request.accountId,
			sessionId: request.accountId,
			runId: `run:${request.accountId}`,
		})),
		abortRun: vi.fn(async () => ({ ok: true })),
		onRunEvent: vi.fn((fn: any) => {
			listener = fn;
			return () => {};
		}),
	};
	const bridge: any = new MatrixBotBridge({ host, getConfig: () => config });
	bridge.sendRoomMessage = vi.fn(async () => {});
	bridge.feedback = vi.fn(async () => {});
	bridge.startSyncLoop = vi.fn();
	const send = (room: string, body = "hello", threadId = "thread") =>
		bridge.onInboundMessage(room, {
			sender: "alice",
			content: { body, "m.relates_to": { rel_type: "m.thread", event_id: threadId } },
		});
	const event = (identity: any, type: string, text = "answer") =>
		bridge.handleRunEvent({ ...identity, type, message: { role: "assistant", content: text } });
	return { bridge, host, send, event, saved, config, emit: (...args: any[]) => listener(...args) };
}

async function finishInbound(ctx: ReturnType<typeof setup>, index = 0) {
	const receipt = await ctx.host.chat.mock.results[index].value;
	await ctx.event(receipt, "message", "inbound");
	await ctx.event(receipt, "run_end");
	return receipt;
}

describe("Matrix persistent session routing", () => {
	it("isolates two c1 owners during concurrent receipt races and replaces early preambles", async () => {
		const ctx = setup();
		const resolve: ((value: any) => void)[] = [];
		ctx.host.chat.mockImplementation(() => new Promise<any>((done) => resolve.push(done)));
		const a = ctx.send("room-a"),
			b = ctx.send("room-b");
		await vi.waitFor(() => expect(resolve).toHaveLength(2));
		const receipts = [0, 1].map((i) => ({
			conversationId: "c1",
			clientId: `owner-${i}`,
			sessionId: `session-${i}`,
			runId: `run-${i}`,
		}));
		for (const receipt of receipts) {
			await ctx.event(receipt, "message", "preamble");
			await ctx.event(receipt, "message", receipt.sessionId);
			await ctx.event(receipt, "run_end");
		}
		resolve[1](receipts[1]);
		resolve[0](receipts[0]);
		await Promise.all([a, b]);
		expect(ctx.bridge.feedback.mock.calls.map(([room, text]: any[]) => [room, text])).toEqual([
			["room-b", "session-1"],
			["room-a", "session-0"],
		]);
		expect(ctx.bridge.pendingRuns.size).toBe(0);
	});

	it("restores session routes and epochs, wires web continuation, ends once, and never guesses web abort", async () => {
		const ctx = setup();
		await ctx.send("room", "/reset");
		await ctx.send("room");
		const receipt = await finishInbound(ctx);
		const restored = setup(ctx.saved);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ user_id: "bot" }));
		try {
			await restored.bridge.start();
		} finally {
			fetchSpy.mockRestore();
		}
		const web = { sessionId: receipt.sessionId, clientId: "browser", conversationId: "c1" };
		await restored.emit({ ...web, type: "run_start" });
		await restored.emit({ ...web, type: "message", message: { role: "assistant", content: "preamble" } });
		await restored.emit({ ...web, type: "run_start" });
		await restored.send("room", "/stop");
		expect(restored.host.abortRun).not.toHaveBeenCalled();
		expect(restored.bridge.feedback).toHaveBeenCalledWith("room", expect.stringContaining("运行 ID"), "thread");
		restored.bridge.feedback.mockClear();
		await restored.emit({ ...web, type: "message", message: { role: "assistant", content: "final" } });
		await Promise.all([restored.emit({ ...web, type: "run_end" }), restored.emit({ ...web, type: "run_end" })]);
		expect(restored.bridge.feedback).toHaveBeenCalledTimes(1);
		expect(restored.bridge.feedback).toHaveBeenCalledWith("room", "final", "thread", expect.any(Function));
		expect([...restored.bridge.epochs.values()]).toEqual([1]);
		await restored.emit({ ...web, type: "run_start" });
		await restored.emit({ ...web, type: "run_end" });
		expect(restored.bridge.feedback).toHaveBeenCalledTimes(2);
		await restored.bridge.stop();
	});

	it("does not borrow a session for an unknown rid or bare c1, ignores tool preambles", async () => {
		const ctx = setup();
		await ctx.send("room");
		const receipt = await finishInbound(ctx);
		ctx.bridge.feedback.mockClear();
		const web = { sessionId: receipt.sessionId, conversationId: "c1" };
		await ctx.event(web, "run_start");
		await ctx.event({ ...web, runId: "unknown" }, "message", "leak");
		await ctx.event({ ...web, runId: "unknown" }, "run_end");
		await ctx.event({ conversationId: "c1" }, "message", "bare leak");
		await ctx.event(web, "message", "preamble");
		await ctx.bridge.handleRunEvent({
			...web,
			type: "message",
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [{ type: "text", text: "tool preamble" }, { type: "toolCall" }],
			},
		});
		await ctx.event(web, "run_end");
		expect(ctx.bridge.feedback.mock.calls[0][1]).toBe("任务结束（无文本输出）。");
	});

	it.each(["account", "stop"])("stops remaining chunks after %s changes during delivery", async (change) => {
		const ctx = setup();
		await ctx.send("room");
		const receipt = await ctx.host.chat.mock.results[0].value;
		await ctx.event(receipt, "message", "long answer ".repeat(1200));
		ctx.bridge.feedback.mockImplementationOnce(async () => {
			if (change === "account") ctx.config.accessToken = "changed";
			else await ctx.bridge.stop();
		});
		await ctx.event(receipt, "run_end");
		expect(ctx.bridge.feedback).toHaveBeenCalledTimes(1);
	});

	it("isolates web continuations with the same c1 across rooms and threads", async () => {
		const ctx = setup();
		await ctx.send("room-a", "hello", "thread-a");
		await ctx.send("room-b", "hello", "thread-b");
		const receipts = [await finishInbound(ctx, 0), await finishInbound(ctx, 1)];
		ctx.bridge.feedback.mockClear();
		const web = receipts.map((receipt) => ({
			sessionId: receipt.sessionId,
			clientId: "browser",
			conversationId: "c1",
		}));
		for (let i = 0; i < 2; i++) {
			await ctx.event(web[i], "run_start");
			await ctx.event(web[i], "message", `answer-${i}`);
		}
		await Promise.all(web.map((identity) => ctx.event(identity, "run_end")));
		expect(ctx.bridge.feedback.mock.calls.map(([room, text, thread]: any[]) => [room, text, thread])).toEqual([
			["room-a", "answer-0", "thread-a"],
			["room-b", "answer-1", "thread-b"],
		]);
	});

	it("supports full legacy owner tuples only in memory", async () => {
		const ctx = setup();
		ctx.host.chat.mockResolvedValue({ conversationId: "c1", clientId: "owner" } as any);
		await ctx.send("room");
		await ctx.event({ conversationId: "c1" }, "run_end");
		expect(ctx.bridge.feedback).not.toHaveBeenCalled();
		const owner = { conversationId: "c1", clientId: "owner" };
		await ctx.event(owner, "message", "legacy");
		await ctx.event(owner, "run_end");
		await ctx.event(owner, "run_start");
		await ctx.event(owner, "run_end");
		expect(ctx.bridge.feedback).toHaveBeenCalledTimes(2);
		const restored = setup(ctx.saved);
		await restored.event(owner, "run_start");
		await restored.event(owner, "run_end");
		expect(restored.bridge.feedback).not.toHaveBeenCalled();
	});

	it("persists account mismatch cleanup before returning to the previous offline account", async () => {
		const original = setup();
		await original.send("room");
		const receipt = await finishInbound(original);
		const other = setup(original.saved, { homeserverUrl: "https://matrix.test", accessToken: "other" });
		await other.bridge.loadRouting();
		expect(original.saved.get("sessionRoutes").routes).toEqual([]);
		const returned = setup(original.saved);
		await returned.event({ sessionId: receipt.sessionId }, "run_start");
		await returned.event({ sessionId: receipt.sessionId }, "run_end");
		expect(returned.bridge.pendingRuns.size).toBe(0);
		expect(returned.bridge.feedback).not.toHaveBeenCalled();
	});

	it("invalidates reset and changed account routes across reloads", async () => {
		const ctx = setup();
		await ctx.send("room");
		const receipt = await finishInbound(ctx);
		await ctx.send("room", "/reset");
		const restored = setup(ctx.saved);
		await restored.event(receipt, "run_start");
		await restored.event({ sessionId: receipt.sessionId }, "run_start");
		expect(restored.bridge.pendingRuns.size).toBe(0);
		await ctx.send("room");
		const next = await finishInbound(ctx, 1);
		ctx.config.accessToken = "other";
		await ctx.event({ sessionId: next.sessionId }, "run_start");
		expect(ctx.bridge.pendingRuns.size).toBe(0);
		const changed = setup(ctx.saved, ctx.config);
		await changed.event({ sessionId: next.sessionId }, "run_start");
		expect(changed.bridge.pendingRuns.size).toBe(0);
	});
});
