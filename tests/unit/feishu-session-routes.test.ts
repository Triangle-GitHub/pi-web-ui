import { describe, expect, it, vi } from "vitest";
import { FeishuBotBridge } from "../../plugins/feishu/bot-bridge.mjs";
import { scopeKey } from "../../plugins/feishu/runtime.mjs";

function setup(saved = new Map(), config = { appId: "app", appSecret: "secret" }) {
	const host = {
		chat: vi.fn(),
		abortRun: vi.fn().mockResolvedValue({ ok: true }),
		storage: { get: vi.fn(async (key) => saved.get(key)), set: vi.fn(async (key, value) => saved.set(key, value)) },
	};
	const reply = vi.fn().mockResolvedValue({ success: true });
	const bridge: any = new FeishuBotBridge({
		host,
		getConfig: () => config,
		replyMessage: reply,
		sendMessage: reply,
		reactMessage: vi.fn(),
		log: vi.fn(),
	} as any);
	const dispatch = async (room: string, receipt: any) => {
		host.chat.mockResolvedValueOnce(receipt);
		const scope = scopeKey("peer", room, "thread");
		await bridge.dispatch("hello", [], {
			scope,
			openId: "peer",
			chatId: room,
			threadId: "thread",
			messageId: `msg-${room}`,
			replyInThread: true,
			cfg: config,
		});
		return scope;
	};
	const event = (type: string, identity: any, text?: string) =>
		bridge.handleRunEvent({ type, ...identity, ...(text ? { message: { role: "assistant", content: text } } : {}) });
	return { bridge, host, reply, dispatch, event, saved, config };
}

describe("Feishu persistent session routing", () => {
	it("isolates concurrent c1 scopes and sends only the final candidate once after web continuation", async () => {
		const { bridge, dispatch, event, reply } = setup();
		await dispatch("a", { conversationId: "c1", clientId: "owner-a", sessionId: "sa", runId: "ra" });
		await dispatch("b", { conversationId: "c1", clientId: "owner-b", sessionId: "sb", runId: "rb" });
		expect(bridge.pendingRuns.size).toBe(2);
		for (const runId of ["ra", "rb"]) {
			await event("message", { runId }, runId);
			await event("run_end", { runId });
		}
		expect(reply.mock.calls.map(([, m]) => [m.messageId, m.text])).toEqual([
			["msg-a", "ra"],
			["msg-b", "rb"],
		]);
		reply.mockClear();
		const web = { sessionId: "sa", clientId: "browser", conversationId: "c1" };
		await event("run_start", web);
		await event("message", web, "tool preface");
		await event("run_start", web);
		await event("message", { ...web, runId: "unknown" }, "wrong");
		await event("run_end", { ...web, runId: "unknown" });
		await event("message", web, "final");
		await event("run_end", web);
		await event("run_end", web);
		expect(reply).toHaveBeenCalledTimes(1);
		expect(reply.mock.calls[0][1]).toMatchObject({ messageId: "msg-a", text: "final", replyInThread: true });
	});

	it("restores only stable routes, revokes reset epochs and account changes", async () => {
		const original = setup();
		const scope = await original.dispatch("a", { conversationId: "c1", sessionId: "sa", runId: "r" });
		await original.bridge.routeSave;
		const restored = setup(original.saved);
		await restored.bridge.restoreSessionRoutes();
		await restored.event("run_start", { sessionId: "sa", conversationId: "renamed" });
		await restored.event("message", { sessionId: "sa" }, "restored");
		await restored.event("run_end", { sessionId: "sa" });
		expect(restored.reply.mock.calls[0][1].text).toBe("restored");
		await restored.bridge.handleSlashCommand("/new", { scope, cfg: restored.config });
		await restored.bridge.routeSave;
		const reset = setup(original.saved);
		await reset.bridge.restoreSessionRoutes();
		await reset.event("run_start", { sessionId: "sa" });
		expect(reset.bridge.pendingRuns.size).toBe(0);
		await reset.dispatch("a", { conversationId: "c1", sessionId: "new", runId: "new-r" });
		reset.config.appId = "changed";
		await reset.event("run_end", { runId: "new-r" });
		expect(reset.bridge.sessionRoutes.size).toBe(0);
		expect(reset.reply).not.toHaveBeenCalled();
	});

	it("clears tool prefaces and permanently discards routes on startup account mismatch", async () => {
		const original = setup();
		await original.dispatch("a", { conversationId: "c1", sessionId: "sa", runId: "r" });
		await original.event("message", { runId: "r" }, "preface");
		await original.bridge.handleRunEvent({
			type: "message",
			runId: "r",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", name: "read" }],
				stopReason: "toolUse",
			},
		});
		await original.event("run_end", { runId: "r" });
		expect(original.reply.mock.calls[0][1].text).not.toContain("preface");
		await original.bridge.routeSave;
		const changed = setup(original.saved, { appId: "other", appSecret: "secret" });
		await changed.bridge.restoreSessionRoutes();
		const returned = setup(original.saved);
		await returned.bridge.restoreSessionRoutes();
		await returned.event("run_start", { sessionId: "sa" });
		expect(returned.bridge.pendingRuns.size).toBe(0);
	});

	it("requires complete legacy identity and refuses to guess a web abort target", async () => {
		const { bridge, host, dispatch, event, reply, config } = setup();
		const scope = await dispatch("a", { conversationId: "c1", clientId: "owner", runId: "r" });
		await event("run_end", { runId: "r" });
		reply.mockClear();
		await event("run_start", { conversationId: "c1" });
		expect(bridge.pendingRuns.size).toBe(0);
		await event("run_start", { conversationId: "c1", clientId: "owner" });
		expect(bridge.pendingRuns.size).toBe(1);
		await bridge.handleSlashCommand("/stop", { scope, cfg: config });
		expect(host.abortRun).not.toHaveBeenCalled();
		expect(reply.mock.calls[0][1].text).toContain("网页任务无法精准停止");
		await bridge.handleSlashCommand("/new", { scope, cfg: config });
		expect(bridge.pendingRuns.size).toBe(0);
	});
});
