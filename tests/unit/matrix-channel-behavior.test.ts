import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import activate, { MatrixBotBridge } from "../../plugins/matrix/index.mjs";

const cfg = { homeserverUrl: "https://matrix.test", accessToken: "token" };
afterEach(() => vi.unstubAllGlobals());
function setup(chat?: any) {
	const sent: any[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: any = {}) => {
			if (url.includes("/media/download/")) return new Response(new Uint8Array([1, 2, 3]));
			if (url.includes("/upload")) return Response.json({ content_uri: "mxc://matrix.test/upload" });
			if (init.body) sent.push(JSON.parse(init.body));
			return Response.json(url.endsWith("/state") ? [] : { event_id: "$sent" });
		}),
	);
	const host = {
		cwd: process.cwd(),
		chat: chat || vi.fn(async () => ({ conversationId: "actual", runId: "stable" })),
		abortRun: vi.fn(async () => ({ ok: true })),
		models: { list: vi.fn(async () => [{ provider: "test", id: "model" }]) },
		fs: {
			mkdirPath: vi.fn(),
			writePath: vi.fn(),
			statPath: vi.fn(async () => ({ type: "dir", size: 3 })),
			readPath: vi.fn(async () => Buffer.from([1, 2, 3])),
		},
	};
	const bridge = new MatrixBotBridge({ host, getConfig: () => cfg, log: vi.fn() });
	const inbound = (body: string, content: any = {}, room = "!room", thread = "$thread") =>
		bridge.onInboundMessage(room, {
			event_id: Math.random().toString(),
			sender: "@user:test",
			content: { msgtype: "m.text", body, "m.relates_to": { rel_type: "m.thread", event_id: thread }, ...content },
		});
	return { bridge, host, sent, inbound };
}
describe("Matrix channel behavior", () => {
	it("handles all commands locally and applies scoped settings", async () => {
		const { inbound, host, sent } = setup();
		for (const cmd of [
			"/help",
			"/status",
			"/new",
			"/clear",
			"/stop",
			"/abort",
			"/model",
			"/thinking",
			"/cwd",
			"/unknown",
			"/model bad",
			"/thinking bad",
			"/cwd relative",
		])
			await inbound(cmd);
		expect(host.chat).not.toHaveBeenCalled();
		await inbound("/model test/model");
		await inbound("/thinking high");
		await inbound(`/cwd ${process.cwd()}`);
		await inbound("hello");
		expect(host.chat).toHaveBeenCalledWith(
			expect.objectContaining({ model: "test/model", thinkingLevel: "high", cwd: process.cwd() }),
		);
		await inbound("/stop");
		expect(host.abortRun).toHaveBeenCalledWith("stable");
		expect(sent.some((s) => s.body.includes("未知命令"))).toBe(true);
	});
	it("rotates daemon account identity for new, clear, cwd and model", async () => {
		const { inbound, host, bridge } = setup(
			vi.fn(async (request: any) => ({ conversationId: "c1", runId: `run:${request.accountId}` })),
		);
		const accounts = [];
		await inbound("first");
		accounts.push(host.chat.mock.calls.at(-1)[0].accountId);
		await bridge.handleRunEvent({ type: "run_end", runId: (await host.chat.mock.results.at(-1).value).runId });
		for (const command of ["/new", "/clear", `/cwd ${process.cwd()}`, "/model test/model"]) {
			await inbound(command);
			await inbound("next");
			accounts.push(host.chat.mock.calls.at(-1)[0].accountId);
			await bridge.handleRunEvent({ type: "run_end", runId: (await host.chat.mock.results.at(-1).value).runId });
		}
		expect(new Set(accounts).size).toBe(5);
	});
	it("stops a pending media download immediately and never dispatches it", async () => {
		const { inbound, host, sent } = setup();
		const normalFetch = globalThis.fetch;
		let release: any;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: any, init: any) => {
				if (String(url).includes("/media/download/"))
					return await new Promise<Response>((done) => {
						release = () => done(new Response(new Uint8Array([1])));
					});
				return normalFetch(url, init);
			}),
		);
		const pending = inbound("image", {
			msgtype: "m.image",
			url: "mxc://matrix.test/image",
			info: { mimetype: "image/png" },
		});
		await inbound("/stop");
		expect(sent.some((s) => s.body.includes("下载已取消"))).toBe(true);
		release();
		await pending;
		expect(host.chat).not.toHaveBeenCalled();
		expect(host.fs.writePath).not.toHaveBeenCalled();
	});
	it("claims early message and run_end by stable runId despite renamed conversation IDs", async () => {
		let bridge: any;
		const chat = vi.fn(async () => {
			await bridge.handleRunEvent({
				type: "message",
				conversationId: "early-a",
				runId: "stable",
				message: { role: "assistant", content: "early answer" },
			});
			await bridge.handleRunEvent({ type: "run_end", conversationId: "early-b", runId: "stable" });
			return { conversationId: "real", runId: "stable" };
		});
		const result = setup(chat);
		bridge = result.bridge;
		await result.inbound("hello");
		expect([...bridge.userConversations.values()]).toEqual(["real"]);
		expect(bridge.pendingRuns.size).toBe(0);
		expect(result.sent.filter((s) => s.body === "early answer")).toHaveLength(1);
		expect(result.sent.at(-1)["m.relates_to"]).toEqual({ rel_type: "m.thread", event_id: "$thread" });
	});
	it("preserves early terminal state after many assistant events and marks partial aborts", async () => {
		let bridge: any;
		const result = setup(
			vi.fn(async () => {
				for (let i = 0; i < 300; i++)
					await bridge.handleRunEvent({
						type: "message",
						runId: "flood",
						conversationId: "early",
						message: { role: "assistant", content: "partial" },
					});
				await bridge.handleRunEvent({
					type: "run_end",
					runId: "flood",
					conversationId: "changed",
					stopReason: "aborted",
				});
				return { conversationId: "actual", runId: "flood" };
			}),
		);
		bridge = result.bridge;
		await result.inbound("hello");
		expect(bridge.pendingRuns.size).toBe(0);
		expect(result.sent.some((s) => s.body.includes("partial") && s.body.includes("任务已停止"))).toBe(true);
	});
	it("isolates same user across rooms and threads and ignores unrelated runs", async () => {
		let n = 0;
		const { inbound, bridge, host, sent } = setup(
			vi.fn(async () => ({ conversationId: `real${++n}`, runId: `run${n}` })),
		);
		await inbound("a");
		await inbound("b", {}, "!other");
		await inbound("c", {}, "!room", "$other");
		expect(new Set(host.chat.mock.calls.map((c: any) => c[0].accountId)).size).toBe(3);
		await bridge.handleRunEvent({ type: "run_end", runId: "unrelated", conversationId: "real1" });
		expect(sent).toHaveLength(0);
		await bridge.handleRunEvent({
			type: "message",
			runId: "run2",
			conversationId: "renamed",
			message: { role: "assistant", content: "answer" },
		});
		await bridge.handleRunEvent({ type: "run_end", runId: "run2", conversationId: "renamed-again" });
		expect(sent.at(-1).body).toBe("answer");
	});
	it.each(["image", "audio", "file", "video"])("downloads %s and passes real attachments to chat", async (type) => {
		const { inbound, host } = setup();
		await inbound("example", {
			msgtype: `m.${type}`,
			url: "mxc://matrix.test/media",
			info: { mimetype: type === "image" ? "image/png" : "application/octet-stream" },
		});
		expect(host.fs.writePath).toHaveBeenCalledWith(expect.stringContaining(".matrix-media"), Buffer.from([1, 2, 3]));
		const attachment = host.chat.mock.calls[0][0].attachments[0];
		if (type === "image")
			expect(attachment).toEqual({ path: "", imageData: "AQID", mimeType: "image/png", name: "example" });
		else
			expect(attachment).toEqual({
				path: expect.stringContaining(".matrix-media"),
				mode: "reference",
				name: "example",
			});
	});
	it("reports download, encrypted attachment and unknown type failures without dispatch", async () => {
		const { inbound, host, sent } = setup();
		await inbound("bad", { msgtype: "m.image", file: { url: "mxc://encrypted" } });
		await inbound("bad", { msgtype: "m.video" });
		await inbound("bad", { msgtype: "m.unknown" });
		expect(host.chat).not.toHaveBeenCalled();
		expect(sent.every((s) => s.body.startsWith("❌"))).toBe(true);
	});
	it("reports oversize images and file write failures without dispatch", async () => {
		const { inbound, host, sent } = setup();
		const normalFetch = globalThis.fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: any, init: any) =>
				String(url).includes("/media/download/")
					? new Response("", { headers: { "content-length": String(11 * 1024 * 1024) } })
					: normalFetch(url, init),
			),
		);
		await inbound("large", { msgtype: "m.image", url: "mxc://matrix.test/image", info: { mimetype: "image/png" } });
		expect(host.fs.writePath).not.toHaveBeenCalled();
		expect(sent.at(-1).body).toContain("10 MiB");
		vi.stubGlobal("fetch", normalFetch);
		host.fs.writePath.mockRejectedValueOnce(new Error("disk full"));
		await inbound("file", { msgtype: "m.file", url: "mxc://matrix.test/file" });
		expect(host.chat).not.toHaveBeenCalled();
		expect(sent.at(-1).body).toContain("disk full");
	});
	it("rejects E2EE outbound and exposes reply delivery failures", async () => {
		const { bridge } = setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json([{ type: "m.room.encryption" }])),
		);
		await expect(bridge.sendRoomMessage("!encrypted", "secret")).rejects.toThrow("E2EE");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);
		await bridge.feedback("!other", "reply");
		expect(bridge.status.lastError).toBe("network down");
	});
	it("uploads and sends every media type through the registered tool", async () => {
		const { host, sent } = setup();
		let tool: any;
		const deactivate = await activate({
			...host,
			storage: { get: () => cfg },
			registerTool: (t: any) => {
				tool = t;
			},
		});
		for (const type of ["image", "audio", "file", "video"])
			await tool.execute({
				action: "send",
				room_id: "!room",
				path: resolve(process.cwd(), "example.bin"),
				media_type: type,
			});
		expect(sent.map((s) => s.msgtype)).toEqual(["m.image", "m.audio", "m.file", "m.video"]);
		expect(sent.every((s) => s.url === "mxc://matrix.test/upload")).toBe(true);
		await expect(tool.execute({ action: "send", room_id: "!room", path: "../outside" })).rejects.toThrow(
			"inside workspace",
		);
		await deactivate();
	});
});
