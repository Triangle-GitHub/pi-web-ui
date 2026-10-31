import { afterEach, expect, it, vi } from "vitest";
import { WhatsappBotBridge } from "../../plugins/whatsapp/index.mjs";

afterEach(() => vi.unstubAllGlobals());
function setup(saved = new Map(), config = { accessToken: "secret", phoneNumberId: "business" }) {
	const sent: any[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url, opts) => {
			if (opts?.body) sent.push(JSON.parse(opts.body));
			return { ok: true, json: async () => ({ messages: [{ id: "out" }] }) };
		}),
	);
	let emit: any;
	let n = 0;
	const host = {
		storage: {
			get: async (key: string) => saved.get(key),
			set: async (key: string, value: any) => {
				saved.set(key, structuredClone(value));
			},
		},
		onRunEvent: (fn: any) => {
			emit = fn;
			return () => {};
		},
		chat: vi.fn(async () => ({
			conversationId: "c1",
			clientId: `owner${++n}`,
			sessionId: `stable${n}`,
			runId: `rid${n}`,
		})),
		abortRun: vi.fn(async () => ({ ok: true })),
	};
	const bridge = new WhatsappBotBridge({ host, getConfig: () => config });
	const inbound = (from: string, text = "hello") => bridge.onInboundMessage({ from, text: { body: text } });
	return { bridge, host, sent, inbound, event: (ev: any) => emit(ev), saved, config };
}
it("isolates concurrent c1 scopes and routes web continuation once by stable session", async () => {
	const s = setup();
	await s.bridge.start();
	await Promise.all([s.inbound("111"), s.inbound("222")]);
	await s.event({ type: "run_end", runId: "rid2" });
	await s.event({ type: "run_end", runId: "rid1" });
	s.sent.length = 0;
	for (const sessionId of ["stable1", "stable2"]) {
		await s.event({ type: "run_start", sessionId, conversationId: "c1", clientId: "browser" });
		await s.event({ type: "run_start", sessionId, conversationId: "c1", clientId: "browser" });
		await s.event({
			type: "message",
			sessionId,
			message: { role: "assistant", content: "tool preamble", stopReason: "toolUse" },
		});
		await s.event({ type: "message", sessionId, runId: "unknown", message: { role: "assistant", content: "wrong" } });
		await s.event({ type: "message", sessionId, message: { role: "assistant", content: sessionId } });
		await s.event({ type: "run_end", sessionId });
		await s.event({ type: "run_end", sessionId });
	}
	expect(s.sent.map((p) => [p.to, p.text.body])).toEqual([
		["111", "stable1"],
		["222", "stable2"],
	]);
	await s.bridge.stop();
});
it("restores persistent scopes and revokes reset epochs across reload", async () => {
	const s = setup();
	await s.bridge.start();
	await s.inbound("111");
	await s.event({ type: "run_end", runId: "rid1" });
	await s.bridge.stop();
	const next = setup(s.saved);
	await next.bridge.start();
	await next.event({ type: "run_start", sessionId: "stable1" });
	await next.event({ type: "message", sessionId: "stable1", message: { role: "assistant", content: "restored" } });
	await next.event({ type: "run_end", sessionId: "stable1" });
	expect(next.sent.at(-1).text.body).toBe("restored");
	await next.inbound("111", "/new");
	await next.bridge.stop();
	const third = setup(s.saved);
	await third.bridge.start();
	await third.event({ type: "run_start", sessionId: "stable1" });
	await third.event({ type: "run_end", sessionId: "stable1" });
	expect(third.sent).toEqual([]);
	await third.bridge.stop();
});
it("does not resurrect routes after an offline account change and revert", async () => {
	const first = setup();
	await first.bridge.start();
	await first.inbound("111");
	await first.event({ type: "run_end", runId: "rid1" });
	await first.bridge.stop();
	const changed = setup(first.saved, { accessToken: "other", phoneNumberId: "other" });
	await changed.bridge.start();
	await changed.bridge.stop();
	const reverted = setup(first.saved);
	await reverted.bridge.start();
	await reverted.event({ type: "run_start", sessionId: "stable1" });
	await reverted.event({ type: "run_end", sessionId: "stable1" });
	expect(reverted.sent).toEqual([]);
	await reverted.bridge.stop();
});
it("supports only complete legacy owner identity and never guesses web abort", async () => {
	const s = setup();
	s.host.chat.mockResolvedValue({ conversationId: "c1", clientId: "legacy", runId: "r" } as any);
	await s.bridge.start();
	await s.inbound("111");
	await s.event({ type: "run_end", runId: "r" });
	s.sent.length = 0;
	await s.event({ type: "run_start", conversationId: "c1" });
	await s.event({ type: "run_end", conversationId: "c1" });
	expect(s.sent).toEqual([]);
	await s.event({ type: "run_start", conversationId: "c1", clientId: "legacy" });
	await s.inbound("111", "/stop");
	expect(s.host.abortRun).not.toHaveBeenCalled();
	expect(s.sent.at(-1).text.body).toContain("cannot precisely abort");
	await s.event({ type: "run_start", conversationId: "c1", clientId: "legacy" });
	await s.event({
		type: "message",
		conversationId: "c1",
		clientId: "legacy",
		message: { role: "assistant", content: "after stop" },
	});
	await s.event({ type: "run_end", conversationId: "c1", clientId: "legacy" });
	expect(s.sent.at(-1).text.body).toBe("after stop");
	await s.bridge.stop();
});
it("revokes routes after account changes and exposes Cloud API delivery errors", async () => {
	const s = setup();
	await s.bridge.start();
	await s.inbound("111");
	await s.event({ type: "run_end", runId: "rid1" });
	s.sent.length = 0;
	s.config.phoneNumberId = "other";
	await s.event({ type: "run_start", sessionId: "stable1" });
	await s.event({ type: "run_end", sessionId: "stable1" });
	expect(s.sent).toEqual([]);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: false,
			status: 400,
			json: async () => ({ error: { message: "24 hour window expired" } }),
		})),
	);
	await s.bridge.reply("111", "late");
	expect(s.bridge.status.lastError).toContain("24 hour window expired");
	await s.bridge.stop();
});
