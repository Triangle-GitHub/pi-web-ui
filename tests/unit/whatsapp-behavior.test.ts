import { afterEach, describe, expect, it, vi } from "vitest";
import activate, { WhatsappBotBridge } from "../../plugins/whatsapp/index.mjs";
import { sendMedia } from "../../plugins/whatsapp/media.mjs";
import { sessionKey } from "../../plugins/whatsapp/bridge.mjs";

const cfg = { accessToken: "secret", phoneNumberId: "business" };
const inbound = (text: string, from = "123") => ({ from, type: "text", text: { body: text } });
function setup(chat?: any) {
	const sent: any[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url, opts) => {
			if (opts?.body && typeof opts.body === "string") sent.push(JSON.parse(opts.body));
			return { ok: true, json: async () => ({ messages: [{ id: "out" }] }) };
		}),
	);
	let handler: any;
	const host = {
		cwd: "/workspace",
		chat: chat || vi.fn(async () => ({ conversationId: "actual", runId: "run" })),
		onRunEvent: (fn: any) => {
			handler = fn;
			return () => {};
		},
		abortRun: vi.fn(async () => ({ ok: true })),
		fs: { statPath: vi.fn(async () => ({ type: "dir" })) },
		notify: vi.fn(),
	};
	const bridge = new WhatsappBotBridge({ host, getConfig: () => cfg });
	return { bridge, host, sent, event: (ev: any) => handler(ev) };
}
afterEach(() => vi.unstubAllGlobals());

describe("WhatsApp behavior contract", () => {
	it.each(["/new", "/clear", "/reset", "/RESET", "／ＮＥＷ", "／ＣＬＥＡＲ", "／ＲＥＳＥＴ"])(
		"%s executes its prompt literally on a new account",
		async (command) => {
			let n = 0;
			const { bridge, host, event } = setup(vi.fn(async () => ({ conversationId: `conv${++n}`, runId: `run${n}` })));
			await bridge.start();
			await bridge.onInboundMessage(inbound("old"));
			await bridge.onInboundMessage(inbound(`${command} /stop keep ＡＢＣ\n  /reset literal  `));
			expect(host.chat).toHaveBeenCalledTimes(2);
			expect(host.chat.mock.calls[1][0].text).toBe("/stop keep ＡＢＣ\n  /reset literal  ");
			expect(host.chat.mock.calls[1][0]).not.toHaveProperty("conversationId");
			expect(host.chat.mock.calls[1][0].accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
			await event({ type: "run_end", runId: "run2" });
			await bridge.onInboundMessage(inbound("continue"));
			expect(host.chat.mock.calls[2][0]).toMatchObject({
				accountId: host.chat.mock.calls[1][0].accountId,
				conversationId: "conv2",
			});
			await bridge.stop();
		},
	);
	it.each([
		"／ＭＯＤＥＬ p/model",
		"/MODEL DEFAULT",
		"／ＴＨＩＮＫＩＮＧ HIGH",
		"/THINKING DEFAULT",
		"／ＷＯＲＫＳＰＡＣＥ /next",
		"/WORKSPACE DEFAULT",
	])("%s rotates the active context and preserves preferences", async (command) => {
		const { bridge, host } = setup();
		await bridge.start();
		await bridge.onInboundMessage(inbound("old"));
		await bridge.onInboundMessage(inbound(command));
		expect(host.abortRun).toHaveBeenCalledWith("run");
		await bridge.onInboundMessage(inbound("fresh"));
		const next = host.chat.mock.calls[1][0];
		expect(next.accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
		expect(next).not.toHaveProperty("conversationId");
		if (command.includes("p/model")) expect(next.model).toBe("p/model");
		if (command.includes("HIGH")) expect(next.thinkingLevel).toBe("high");
		if (command.includes("/next")) expect(next.cwd).toBe("/next");
		await bridge.stop();
	});
	it.each(["/stop", "/abort", "／ＳＴＯＰ", "／ＡＢＯＲＴ"])(
		"%s releases stale run records after abort failure",
		async (command) => {
			for (const throws of [false, true]) {
				let count = 0;
				const { bridge, host, event, sent } = setup(
					vi.fn(async () => ({ conversationId: "actual", runId: `run${++count}` })),
				);
				await bridge.start();
				await bridge.onInboundMessage(inbound("old"));
				if (throws) host.abortRun.mockRejectedValueOnce(new Error("abort threw"));
				else host.abortRun.mockResolvedValueOnce({ ok: false, error: "abort denied" } as any);
				await bridge.onInboundMessage(inbound(command));
				expect(host.abortRun).toHaveBeenCalledWith("run1");
				expect(sent.at(-1).text.body).toContain(throws ? "abort threw" : "abort denied");
				expect(bridge.pendingRuns.size).toBe(0);
				await event({ type: "run_end", runId: "run1", conversationId: "stale" });
				await bridge.onInboundMessage(inbound("continue"));
				expect(host.chat).toHaveBeenCalledTimes(2);
				expect(host.chat.mock.calls[1][0].conversationId).toBe("actual");
				expect([...bridge.pendingRuns.keys()]).toEqual(["run2"]);
				await bridge.stop();
			}
		},
	);
	it("allows fresh delivery while the previous task abort is pending", async () => {
		let finishAbort: any;
		const { bridge, host } = setup();
		await bridge.start();
		await bridge.onInboundMessage(inbound("old"));
		host.abortRun.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishAbort = resolve;
				}),
		);
		const reset = bridge.onInboundMessage(inbound("/reset"));
		await vi.waitFor(() => expect(finishAbort).toBeTypeOf("function"));
		await bridge.onInboundMessage(inbound("fresh"));
		expect(host.chat).toHaveBeenCalledTimes(2);
		finishAbort({ ok: true });
		await reset;
		await bridge.stop();
	});
	it("ignores workspace validation completed after reset", async () => {
		let resolveStat: any;
		const { bridge, host } = setup();
		host.fs.statPath.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveStat = resolve;
				}),
		);
		await bridge.start();
		const workspace = bridge.onInboundMessage(inbound("／ＷＯＲＫＳＰＡＣＥ /late"));
		await vi.waitFor(() => expect(resolveStat).toBeTypeOf("function"));
		await bridge.onInboundMessage(inbound("/reset"));
		resolveStat({ type: "dir" });
		await workspace;
		await bridge.onInboundMessage(inbound("fresh"));
		expect(host.chat.mock.calls[0][0].cwd).toBe("/workspace");
		await bridge.stop();
	});
	it("handles every command without model dispatch and passes settings on the next request", async () => {
		const { bridge, host, sent } = setup();
		await bridge.start();
		for (const cmd of [
			"/help",
			"/status",
			"/model p/model",
			"/thinking high",
			"/cwd /next",
			"/unknown",
			"/new",
			"/clear",
			"/stop",
			"/abort",
		])
			await bridge.onInboundMessage(inbound(cmd));
		expect(host.chat).not.toHaveBeenCalled();
		expect(sent.some((p) => p.text?.body.includes("Unknown command"))).toBe(true);
		await bridge.onInboundMessage(inbound("hello"));
		expect(host.chat).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/next", model: "p/model", thinkingLevel: "high" }),
		);
		await bridge.onInboundMessage(inbound("/abort"));
		expect(host.abortRun).toHaveBeenCalledWith("run");
		await bridge.stop();
	});
	it.each(["/cwd", "/workspace", "/CWD", "/WORKSPACE"])(
		"%s rotates the account and clears the completed conversation binding",
		async (command) => {
			const { bridge, host, event } = setup();
			await bridge.start();
			await bridge.onInboundMessage(inbound("old"));
			await event({ type: "run_end", runId: "run" });
			const oldAccount = host.chat.mock.calls[0][0].accountId;
			await bridge.onInboundMessage(inbound(`${command} /next`));
			await bridge.onInboundMessage(inbound("fresh"));
			expect(host.chat.mock.calls[1][0]).toMatchObject({ cwd: "/next" });
			expect(host.chat.mock.calls[1][0].accountId).not.toBe(oldAccount);
			expect(host.chat.mock.calls[1][0]).not.toHaveProperty("conversationId");
			await bridge.stop();
		},
	);
	it.each(["/new", "/clear", "/NEW", "/CLEAR"])(
		"%s rotates identity and drops old bindings and replies",
		async (command) => {
			let sequence = 0;
			const { bridge, host, sent, event } = setup(
				vi.fn(async () => ({ conversationId: `conv${++sequence}`, runId: `run${sequence}` })),
			);
			await bridge.start();
			await bridge.onInboundMessage(inbound("old"));
			const oldAccount = host.chat.mock.calls[0][0].accountId;
			await bridge.onInboundMessage(inbound(command));
			expect(host.abortRun).toHaveBeenCalledWith("run1");
			const replies = sent.length;
			await event({ type: "run_end", runId: "run1", conversationId: "old-binding" });
			expect(sent).toHaveLength(replies);
			await bridge.onInboundMessage(inbound("fresh"));
			expect(host.chat.mock.calls[1][0].accountId).not.toBe(oldAccount);
			expect(host.chat.mock.calls[1][0]).not.toHaveProperty("conversationId");
			await bridge.stop();
		},
	);
	it.each(["/new", "/clear"])(
		"%s bypasses pending dispatch and invalidates queued work and late receipts",
		async (command) => {
			let resolveOld: any;
			const oldReceipt = new Promise((resolve) => {
				resolveOld = resolve;
			});
			const chat = vi
				.fn()
				.mockImplementationOnce(() => oldReceipt)
				.mockResolvedValue({ conversationId: "fresh", runId: "fresh-run" });
			const { bridge, host } = setup(chat);
			await bridge.start();
			const old = bridge.onInboundMessage(inbound("old"));
			await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
			const queued = bridge.onInboundMessage(inbound("queued before reset"));
			await bridge.onInboundMessage(inbound(command));
			await bridge.onInboundMessage(inbound("fresh"));
			expect(chat).toHaveBeenCalledTimes(2);
			expect(chat.mock.calls[1][0].accountId).not.toBe(chat.mock.calls[0][0].accountId);
			expect(chat.mock.calls[1][0]).not.toHaveProperty("conversationId");
			resolveOld({ conversationId: "old", runId: "old-run" });
			await Promise.all([old, queued]);
			expect(host.abortRun).toHaveBeenCalledWith("old-run");
			expect(chat).toHaveBeenCalledTimes(2);
			expect(bridge.sessions.get(sessionKey(inbound("fresh"))).conversationId).toBe("fresh");
			await bridge.stop();
		},
	);
	it.each(["/new", "/clear"])("%s detaches an old run even when abort fails", async (command) => {
		const { bridge, host, sent, event } = setup();
		await bridge.start();
		await bridge.onInboundMessage(inbound("old"));
		const oldAccount = host.chat.mock.calls[0][0].accountId;
		host.abortRun.mockResolvedValueOnce({ ok: false, error: "abort denied" } as any);
		await bridge.onInboundMessage(inbound(command));
		expect(sent.at(-1).text.body).toContain("abort denied");
		await event({ type: "run_end", runId: "run", conversationId: "old" });
		await bridge.onInboundMessage(inbound("fresh"));
		expect(host.chat.mock.calls[1][0].accountId).not.toBe(oldAccount);
		expect(host.chat.mock.calls[1][0]).not.toHaveProperty("conversationId");
		await bridge.stop();
	});
	it.each(["/new", "/clear"])("%s cancels old media preparation before host delivery", async (command) => {
		let resolveMedia: any;
		const { bridge, host } = setup();
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockImplementation(async (url: any, options: any) => {
			if (String(url).includes("/media-id"))
				return new Promise((resolve) => {
					resolveMedia = resolve;
				});
			if (String(url) === "https://media.test/image")
				return {
					ok: true,
					headers: new Headers({ "content-type": "image/png" }),
					arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
				} as any;
			return { ok: true, json: async () => ({ messages: [{ id: "out" }] }) } as any;
		});
		await bridge.start();
		const media = bridge.onInboundMessage({ from: "123", type: "image", image: { id: "media-id" } });
		await vi.waitFor(() => expect(resolveMedia).toBeTypeOf("function"));
		await bridge.onInboundMessage(inbound(command));
		await bridge.onInboundMessage(inbound("fresh"));
		resolveMedia({ ok: true, json: async () => ({ url: "https://media.test/image", mime_type: "image/png" }) });
		await media;
		expect(host.chat).toHaveBeenCalledTimes(1);
		expect(host.chat.mock.calls[0][0].text).toBe("fresh");
		await bridge.stop();
	});
	it("buffers early events and uses actual runId through takeover and id changes", async () => {
		let emit: any;
		const chat = vi.fn(async (_request: any) => {
			await emit({
				type: "message",
				conversationId: "moved",
				runId: "real",
				message: { role: "assistant", content: "early answer" },
			});
			await emit({ type: "run_end", conversationId: "moved", runId: "real" });
			return { conversationId: "actual", runId: "real" };
		});
		const { bridge, sent, event } = setup(chat);
		emit = event;
		await bridge.start();
		await bridge.onInboundMessage(inbound("hello"));
		expect(sent.at(-1)).toMatchObject({ to: "123", text: { body: "early answer" } });
		expect(bridge.pendingRuns.size).toBe(0);
		await bridge.onInboundMessage(inbound("again"));
		expect(chat.mock.calls[1][0].conversationId).toBe("moved");
		await bridge.stop();
	});
	it("never matches unrelated runIds on the same conversation and replies to the correct sender", async () => {
		let counter = 0;
		const { bridge, event, sent, host } = setup(
			vi.fn(async () => ({ conversationId: "same", runId: `run${++counter}` })),
		);
		await bridge.start();
		await bridge.onInboundMessage(inbound("one", "123"));
		await bridge.onInboundMessage(inbound("two", "456"));
		expect(host.chat.mock.calls[0][0].accountId).not.toBe(host.chat.mock.calls[1][0].accountId);
		await event({ runId: "stranger", conversationId: "same", type: "run_end" });
		expect(sent).toHaveLength(0);
		await event({
			runId: "run2",
			conversationId: "renamed",
			type: "message",
			message: { role: "assistant", content: "second" },
		});
		await event({ runId: "run2", type: "run_end" });
		expect(sent.at(-1)).toMatchObject({ to: "456", text: { body: "second" } });
		await bridge.stop();
	});
	it("isolates group/thread identities and rejects unsupported Cloud API routing without leaking replies", async () => {
		const { bridge, host, sent } = setup();
		expect(sessionKey({ from: "123", groupId: "a" })).not.toBe(sessionKey({ from: "123", groupId: "b" }));
		expect(sessionKey({ from: "123", threadId: "a" })).not.toBe(sessionKey({ from: "123", threadId: "b" }));
		await bridge.onInboundMessage({ ...inbound("group"), groupId: "a" });
		await bridge.onInboundMessage({ ...inbound("thread"), threadId: "b" });
		expect(host.chat).not.toHaveBeenCalled();
		expect(sent).toHaveLength(0);
		expect(bridge.getStatus().lastError).toContain("group/thread");
	});
	it("new resets the host account instead of inventing a conversation id", async () => {
		const { bridge, host } = setup();
		await bridge.start();
		await bridge.onInboundMessage(inbound("first"));
		await bridge.onInboundMessage(inbound("/new"));
		await bridge.onInboundMessage(inbound("second"));
		expect(host.chat.mock.calls[1][0].accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
		expect(host.chat.mock.calls[1][0].conversationId).toBeUndefined();
		await bridge.stop();
	});
	it("cwd changes the peer epoch and stop bypasses a pending chat dispatch", async () => {
		let resolveChat: any;
		const chat = vi.fn(
			(_request: any) =>
				new Promise((resolve) => {
					resolveChat = resolve;
				}),
		);
		const { bridge, host, sent } = setup(chat);
		await bridge.start();
		const pending = bridge.onInboundMessage(inbound("first"));
		await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
		await bridge.onInboundMessage(inbound("/stop"));
		expect(sent.at(-1).text.body).toContain("Stop requested");
		resolveChat({ conversationId: "late", runId: "late-run" });
		await pending;
		expect(host.abortRun).toHaveBeenCalledWith("late-run");
		expect(bridge.pendingRuns.size).toBe(0);
		await bridge.onInboundMessage(inbound("/cwd /different"));
		const next = bridge.onInboundMessage(inbound("next"));
		await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
		expect(chat.mock.calls[1][0].accountId).not.toBe(chat.mock.calls[0][0].accountId);
		resolveChat({ conversationId: "next", runId: "next-run" });
		await next;
		await bridge.stop();
	});

	it("stop bypasses media download and prevents later model delivery", async () => {
		const { bridge, host, sent } = setup();
		await bridge.start();
		let resolveLookup: any;
		vi.mocked(fetch).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveLookup = resolve;
				}),
		);
		const pending = bridge.onInboundMessage({ from: "123", type: "image", image: { id: "media" } });
		await vi.waitFor(() => expect(resolveLookup).toBeTypeOf("function"));
		await bridge.onInboundMessage(inbound("/stop"));
		expect(sent.at(-1).text.body).toContain("Stop requested");
		vi.mocked(fetch).mockImplementationOnce(
			async () =>
				({
					ok: true,
					headers: new Headers(),
					body: (async function* () {
						yield Buffer.from("bytes");
					})(),
				}) as any,
		);
		resolveLookup({
			ok: true,
			json: async () => ({ url: "https://lookaside.fbsbx.com/media", mime_type: "image/png" }),
		});
		await pending;
		expect(host.chat).not.toHaveBeenCalled();
		await bridge.stop();
	});

	it.each(["/stop", "/abort", "/new", "/clear"])("%s aborts using the stable runId after takeover", async (command) => {
		const { bridge, host, event } = setup();
		await bridge.start();
		await bridge.onInboundMessage(inbound("hello"));
		await event({
			runId: "run",
			conversationId: "renamed-after-takeover",
			type: "message",
			message: { role: "assistant", content: "working" },
		});
		await bridge.onInboundMessage(inbound(command));
		expect(host.abortRun).toHaveBeenCalledExactlyOnceWith("run");
		expect(bridge.pendingRuns.size).toBe(0);
		await bridge.stop();
	});

	it("stop falls back to conversationId when no current runId remains", async () => {
		const { bridge, host, event } = setup();
		await bridge.start();
		await bridge.onInboundMessage(inbound("hello"));
		await event({ runId: "run", conversationId: "last-conversation", type: "run_end" });
		await bridge.onInboundMessage(inbound("/stop"));
		expect(host.abortRun).toHaveBeenCalledExactlyOnceWith("last-conversation");
		await bridge.stop();
	});

	it("reports dispatch, run and command failures", async () => {
		const { bridge, host, event, sent } = setup();
		await bridge.start();
		host.chat.mockRejectedValueOnce(new Error("offline"));
		await bridge.onInboundMessage(inbound("first"));
		expect(sent.at(-1).text.body).toContain("offline");
		await bridge.onInboundMessage(inbound("second"));
		await event({ runId: "run", type: "run_end", stopReason: "error" });
		expect(sent.at(-1).text.body).toContain("error");
		await bridge.onInboundMessage(inbound("/thinking invalid"));
		expect(sent.at(-1).text.body).toContain("Unsupported thinking");
		await bridge.stop();
	});
	it("rejects missing stable receipt ids", async () => {
		const { bridge, sent } = setup(vi.fn(async () => ({ conversationId: "id" })));
		await bridge.start();
		await bridge.onInboundMessage(inbound("hello"));
		expect(sent.at(-1).text.body).toContain("conversationId/runId");
		await bridge.stop();
	});
	it.each(["image", "audio", "document", "video"])(
		"downloads %s as bytes and supplies real attachments",
		async (kind) => {
			const { bridge, host } = setup();
			await bridge.start();
			vi.mocked(fetch).mockImplementation(async (url: any, opts: any) => {
				if (String(url).endsWith("/media-id"))
					return {
						ok: true,
						json: async () => ({
							url: "https://lookaside.fbsbx.com/media",
							mime_type: kind === "image" ? "image/png" : "application/octet-stream",
						}),
					} as any;
				if (String(url).includes("lookaside"))
					return {
						ok: true,
						headers: new Headers(),
						body: (async function* () {
							yield Buffer.from("real bytes");
						})(),
					} as any;
				return { ok: true, json: async () => ({ messages: [{ id: "out" }] }) } as any;
			});
			await bridge.onInboundMessage({ from: "123", type: kind, [kind]: { id: "media-id", filename: "test.bin" } });
			const req = host.chat.mock.calls[0][0];
			expect(req.images).toBeUndefined();
			expect(req.attachments).toEqual([
				expect.objectContaining({
					path: "",
					[kind === "image" ? "imageData" : "fileData"]: Buffer.from("real bytes").toString("base64"),
				}),
			]);
			await bridge.stop();
		},
	);
	it.each(["metadata", "header", "stream"])(
		"rejects a 15 MiB inbound document at %s without model delivery",
		async (boundary) => {
			const { bridge, host, sent } = setup();
			const size = 15 * 1024 * 1024;
			vi.mocked(fetch).mockImplementationOnce(
				async () =>
					({
						ok: true,
						json: async () => ({
							url: "https://lookaside.fbsbx.com/media",
							mime_type: "application/pdf",
							...(boundary === "metadata" ? { file_size: size } : {}),
						}),
					}) as any,
			);
			if (boundary !== "metadata")
				vi.mocked(fetch).mockImplementationOnce(
					async () =>
						({
							ok: true,
							headers: new Headers(boundary === "header" ? { "content-length": String(size) } : {}),
							body: (async function* () {
								yield Buffer.alloc(size);
							})(),
						}) as any,
				);
			await bridge.onInboundMessage({
				from: "123",
				type: "document",
				document: { id: "large", filename: "large.pdf" },
			});
			expect(host.chat).not.toHaveBeenCalled();
			expect(sent.at(-1).text.body).toContain("10 MiB");
		},
	);

	it("reports media download failure without model dispatch", async () => {
		const { bridge, host, sent } = setup();
		vi.mocked(fetch).mockImplementationOnce(async () => ({ ok: false, status: 404 }) as any);
		await bridge.onInboundMessage({ from: "123", type: "image", image: { id: "missing" } });
		expect(host.chat).not.toHaveBeenCalled();
		expect(sent.at(-1).text.body).toContain("404");
	});
	it.each(["image", "audio", "document", "video"])("uploads and sends %s", async (type) => {
		const calls: any[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url, opts) => {
				calls.push(opts);
				return {
					ok: true,
					json: async () => (calls.length === 1 ? { id: "uploaded" } : { messages: [{ id: "out" }] }),
				};
			}),
		);
		await sendMedia(
			{ fs: { stat: async () => ({ type: "file", size: 3 }), read: async () => Buffer.from("abc") } },
			cfg,
			"123",
			{ type, path: "x.bin", mimeType: "application/octet-stream" },
		);
		expect(calls[0].body).toBeInstanceOf(FormData);
		expect(JSON.parse(calls[1].body)).toMatchObject({ type, to: "123", [type]: { id: "uploaded" } });
	});
	it("registers the inbox route and a usable media tool", async () => {
		let tool: any;
		let route: any;
		const dispose = await activate({
			storage: { get: async () => cfg },
			secrets: { getAll: async () => ({}) },
			registerTool: (t: any) => {
				tool = t;
			},
			route: (_m: any, _p: any, h: any) => {
				route = h;
			},
		});
		expect(tool.parameters.properties.action.enum).toContain("send_media");
		expect(route).toBeTypeOf("function");
		await dispose();
	});
});
