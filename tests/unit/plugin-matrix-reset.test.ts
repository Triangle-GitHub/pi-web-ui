import { afterEach, describe, expect, it, vi } from "vitest";
import { MatrixBotBridge } from "../../plugins/matrix/index.mjs";

afterEach(() => vi.unstubAllGlobals());

function setup() {
	const host = {
		cwd: process.cwd(),
		chat: vi.fn<(request: any) => Promise<any>>(async (request) => ({
			conversationId: "actual",
			runId: `run:${request.accountId}`,
		})),
		models: { list: vi.fn<any>(async () => [{ provider: "p", id: "m" }]) },
		fs: { statPath: vi.fn<any>(async () => ({ type: "dir" })) },
	};
	const bridge: any = new MatrixBotBridge({ host, getConfig: () => ({}) });
	bridge.sendRoomMessage = vi.fn(async () => {});
	bridge.feedback = vi.fn(async () => {});
	const send = (body: string) =>
		bridge.onInboundMessage("room", { sender: "user", content: { msgtype: "m.text", body } });
	const key = () => [...bridge.epochs.keys()][0] || [...bridge.userConversations.keys()][0];
	return { host, bridge, send, key };
}
const commands = [
	"/new",
	"/clear",
	"／ReSeT",
	"/model DEFAULT",
	"/thinking HIGH",
	`/cwd ${process.cwd()}`,
	`/workspace ${process.cwd()}`,
];
describe("Matrix reset command lifecycle", () => {
	it("stops old chunks after reset during the first send", async () => {
		const { host, bridge, send } = setup();
		await send("hello");
		await bridge.handleRunEvent({
			type: "message",
			runId: (await host.chat.mock.results[0].value).runId,
			message: { role: "assistant", content: "old output ".repeat(1000) },
		});
		bridge.feedback = vi.fn(async () => {
			await send("/reset");
		});
		await bridge.handleRunEvent({ type: "run_end", runId: (await host.chat.mock.results.at(-1)!.value).runId });
		expect(bridge.feedback).toHaveBeenCalledTimes(1);
		expect(host.chat).toHaveBeenCalledTimes(1);
	});
	it("does not send after reset during the room state check", async () => {
		const { bridge, send } = setup();
		bridge.getConfig = () => ({ homeserverUrl: "https://matrix.test", accessToken: "token" });
		await send("/reset");
		const epoch = [...bridge.epochs.values()][0];
		const sent: any[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: any, init: any) => {
				if (String(url).endsWith("/state")) {
					await send("/reset");
					return Response.json([]);
				}
				sent.push(init);
				return Response.json({});
			}),
		);
		await bridge.sendContent("room", { body: "obsolete" }, "", () => [...bridge.epochs.values()][0] === epoch);
		expect(sent).toHaveLength(0);
	});
	it.each(["/new", "/clear", "／ReSeT"])("%s dispatches its literal prompt after reset", async (command) => {
		const { host, send, bridge } = setup();
		await send("/reset");
		for (const prompt of ["/model DEFAULT", "DeFaUlT", "／UNKNOWN keep CASE"]) {
			await send(command + " " + prompt);
			expect(host.chat).toHaveBeenLastCalledWith(expect.objectContaining({ text: prompt }));
			await bridge.handleRunEvent({ type: "run_end", runId: (await host.chat.mock.results.at(-1)!.value).runId });
		}
	});
	it("does not dispatch reset prompts while busy", async () => {
		const { host, send } = setup();
		await send("running");
		for (const command of ["/new", "/clear", "／RESET"]) await send(command + " do not run");
		expect(host.chat).toHaveBeenCalledTimes(1);
	});
	it.each(commands)("%s cannot be undone by duplicate events from a completed dispatch", async (command) => {
		const { host, bridge, send, key } = setup();
		let finish!: (value: any) => void;
		host.chat.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
		const dispatch = send("hello");
		await vi.waitFor(() => expect(host.chat).toHaveBeenCalledTimes(1));
		await bridge.handleRunEvent({ type: "run_end", runId: "old-run" });
		finish({ conversationId: "actual", runId: "old-run", sessionId: "old-session" });
		await dispatch;
		await send(command);
		expect(bridge.epochs.get(key())).toBe(1);
		await bridge.handleRunEvent({ type: "run_end", runId: "old-run" });
		expect(bridge.userConversations.get(key())).not.toBe("obsolete");
		expect(bridge.pendingRuns.size).toBe(0);
		await send("next");
		expect(host.chat.mock.calls[1][0].conversationId).not.toBe("obsolete");
	});
	it("does not resurrect an ended run when its receipt arrives without reset", async () => {
		const { host, bridge, send } = setup();
		let finish!: (value: any) => void;
		host.chat.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
		const dispatch = send("hello");
		await vi.waitFor(() => expect(host.chat).toHaveBeenCalledTimes(1));
		await bridge.handleRunEvent({ type: "run_end", runId: "run" });
		finish({ conversationId: "actual", runId: "run" });
		await dispatch;
		expect(bridge.pendingRuns.size).toBe(0);
	});
	it.each(["/model p/m", `/workspace ${process.cwd()}`])("%s rechecks identity after validation", async (command) => {
		const { host, bridge, send, key } = setup();
		let finish!: (value: any) => void;
		const mock = command.startsWith("/model") ? host.models.list : host.fs.statPath;
		mock.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
		const changing = send(command);
		await send("/reset");
		const id = bridge.userConversations.get(key());
		finish(command.startsWith("/model") ? [{ provider: "p", id: "m" }] : { type: "dir" });
		await changing;
		expect(bridge.epochs.get(key())).toBe(1);
		expect(bridge.userConversations.get(key())).toBe(id);
		expect(bridge.preferences.size).toBe(0);
		expect(bridge.userWorkspaces.size).toBe(0);
	});
	it("consumes fullwidth commands, rejects unknown commands and keeps queries read only", async () => {
		const { bridge, host, send, key } = setup();
		await send("/reset");
		for (const cmd of [
			"／UNKNOWN",
			"／MoDeL",
			"／THINKING",
			"／CWD",
			"／WORKSPACE",
			"／HELP",
			"／STATUS",
			"／STOP",
			"／ABORT",
		])
			await send(cmd);
		expect(bridge.epochs.get(key())).toBe(1);
		expect(host.chat).not.toHaveBeenCalled();
		expect(bridge.sendRoomMessage.mock.calls.some(([, text]: any[]) => text.includes("未知命令"))).toBe(true);
	});
	it.each(commands)("%s cannot change a running context", async (command) => {
		const { bridge, send, key } = setup();
		await send("hello");
		await send(command);
		expect(bridge.epochs.get(key()) || 0).toBe(0);
		expect(bridge.pendingRuns.size).toBe(1);
	});
});
