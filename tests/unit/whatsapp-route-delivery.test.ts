import { expect, it, vi } from "vitest";
import { WhatsappBotBridge } from "../../plugins/whatsapp/bridge.mjs";

it.each(["account", "stop"])("stops remaining reply chunks after %s changes while sending", async (change) => {
	const cfg = { accessToken: "old-token", phoneNumberId: "old-account" };
	let release!: () => void;
	const first = new Promise<void>((resolve) => {
		release = resolve;
	});
	const api = vi.fn(async (_token, _phone, path) => {
		if (path === "/messages") await first;
		return {};
	});
	const bridge = new WhatsappBotBridge({
		host: { chat: async () => ({ conversationId: "c1", runId: "r", sessionId: "s" }), onRunEvent: () => () => {} },
		getConfig: () => cfg,
		api,
		payload: (to: string, text: string) => ({ to, text }),
		extractText: (event: any) => event.text.body,
		stripMarkers: (text: string) => text,
		accountId: (key: string) => key,
	});
	await bridge.start();
	await bridge.onInboundMessage({ from: "111", text: { body: "hello" } });
	await bridge.handleRunEvent({
		type: "message",
		runId: "r",
		message: { role: "assistant", content: "a".repeat(8000) },
	});
	const delivery = bridge.handleRunEvent({ type: "run_end", runId: "r" });
	await Promise.resolve();
	if (change === "account") {
		cfg.phoneNumberId = "new-account";
		bridge.checkAccount();
	} else await bridge.stop();
	release();
	await delivery;
	expect(api.mock.calls.filter((args) => args[2] === "/messages")).toHaveLength(1);
	await bridge.stop();
});
