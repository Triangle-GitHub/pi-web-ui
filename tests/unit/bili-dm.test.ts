import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore Plugin modules are JavaScript runtime imports.
import { listSessionPage, fetchMessagePage, fetchMsgs, sendDm } from "../../plugins/bili-scroll/lib/dm.mjs";
// @ts-ignore Plugin modules are JavaScript runtime imports.
import { DmService } from "../../plugins/bili-scroll/lib/dm-service.mjs";
const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllGlobals();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const cred = { sessdata: "session", bili_jct: "csrf", dedeuserid: "123" };
const msg = (key: string, sender = 456, type = 1, text = "hello") => ({
	msg_key: key,
	msg_seqno: key,
	timestamp: Number(key),
	sender_uid: sender,
	msg_type: type,
	content: JSON.stringify({ content: text }),
});
function fixture() {
	const storageDir = mkdtempSync(join(tmpdir(), "bili-dm-"));
	dirs.push(storageDir);
	let messages = [msg("1")];
	let failSend = false;
	const sends: string[] = [];
	const fetchMock = vi.fn(async (url: any, opts: any = {}) => {
		if (opts.signal?.aborted) throw opts.signal.reason;
		const u = String(url);
		let data: any;
		if (u.includes("get_sessions")) data = { session_list: [{ talker_id: 456, session_ts: "99" }], has_more: 0 };
		else if (u.includes("fetch_session_msgs")) {
			const size = Number(new URL(u).searchParams.get("size"));
			data = { messages: [...messages].reverse().slice(0, size), has_more: 0 };
		} else {
			sends.push(String(opts.body));
			if (failSend) throw new Error("connection reset after write");
			data = { msg_key: "99" };
		}
		return { ok: true, status: 200, json: async () => ({ code: 0, data }) };
	});
	vi.stubGlobal("fetch", fetchMock);
	const cfg: any = { dmWatch: true, dmAutoReply: true, dmDailyLimit: 2 };
	const complete = vi.fn(async (_request: any) => ({ ok: true, text: "A real model reply" }));
	const options = {
		api: { cred: { load: () => cred } },
		host: { llm: { complete } },
		storageDir,
		loadConfig: () => cfg,
	};
	return {
		storageDir,
		cfg,
		complete,
		options,
		sends,
		fetchMock,
		service: new DmService(options),
		setMessages: (m: any[]) => {
			messages = m;
		},
		fail: () => {
			failSend = true;
		},
	};
}
describe("Bilibili DM API", () => {
	it("requires self identity and validates identifiers before fetching", async () => {
		const f = fixture();
		await expect(fetchMessagePage({ sessdata: "s" }, 456)).rejects.toThrow("UID");
		await expect(fetchMessagePage(cred, "456&x=1")).rejects.toThrow("UID");
		await expect(fetchMessagePage(cred, 456, { cursor: "-1" })).rejects.toThrow("cursor");
		expect(f.fetchMock).not.toHaveBeenCalled();
	});
	it("preserves raw message types, safe self identity and array compatibility", async () => {
		const f = fixture();
		f.setMessages([msg("1", 123, 2), msg("2", 456, 1, "BV1xx411c7mD")]);
		const page = await fetchMessagePage(cred, 456);
		expect(page.messages[0]).toMatchObject({ fromMe: true, kind: 2, rawType: 2 });
		expect(page.messages[1].bvid).toBe("BV1xx411c7mD");
		expect(await fetchMsgs(cred, 456, 10)).toHaveLength(2);
	});
	it("bounds serialized Unicode message pages and reports truncation", async () => {
		const f = fixture();
		f.setMessages(Array.from({ length: 50 }, (_, i) => msg(String(i + 1), 456, 1, '中文字\\\"\n'.repeat(2000))));
		const page = await fetchMessagePage(cred, 456);
		expect(page.messages).toHaveLength(50);
		expect(page.truncated).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThan(60000);
	});
	it("passes pagination cursors and a bounded signal", async () => {
		const f = fixture();
		await listSessionPage(cred, { cursor: "1234" });
		await fetchMessagePage(cred, 456, { cursor: "42", selfUid: 123 });
		expect(String(f.fetchMock.mock.calls[0][0])).toContain("end_ts=1234");
		expect(String(f.fetchMock.mock.calls[1][0])).toContain("begin_seqno=42");
		expect(f.fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
		await expect(sendDm(cred, 456, " ")).rejects.toThrow();
	});
});
describe("account-wide DM service", () => {
	it("requires explicit watcher and auto-reply opt-ins", async () => {
		const f = fixture();
		delete f.cfg.dmWatch;
		expect(await f.service.tick()).toEqual({ skipped: true });
		expect(f.fetchMock).not.toHaveBeenCalled();
		f.cfg.dmWatch = true;
		f.cfg.dmAutoReply = false;
		await f.service.tick();
		f.setMessages([msg("1"), msg("2")]);
		await f.service.tick();
		expect(f.complete).not.toHaveBeenCalled();
		f.cfg.dmAutoReply = true;
		expect((await f.service.tick()).baseline).toBe(true);
		expect(f.sends).toHaveLength(0);
	});
	it("baselines once, replies to backlog with context and evidence, persists quotas", async () => {
		const f = fixture();
		f.cfg.model = "provider/analysis-model";
		const readVideoContent = vi.fn(async () => ({ transcript: "verified evidence" }));
		const service = new DmService({ ...f.options, readVideoContent });
		expect((await service.tick()).baseline).toBe(true);
		f.setMessages([msg("1"), msg("2", 456, 1, "Please review BV1xx411c7mD"), msg("3", 456, 1, "and compare")]);
		expect((await service.tick()).sent).toBe(1);
		expect(readVideoContent).toHaveBeenCalledOnce();
		const request: any = f.complete.mock.calls[0]?.[0];
		expect(request.model).toBe("provider/analysis-model");
		expect(request.prompt).toContain("verified evidence");
		expect(request.prompt).toContain("and compare");
		expect(request.system).toContain("untrusted data");
		expect(request.tools).toBeUndefined();
		const restarted = new DmService(f.options);
		await restarted.tick();
		expect(f.sends).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(f.storageDir, "dm-service-state.json"), "utf8")).accounts[123].used).toBe(1);
	});
	it("bounds long model prompts while keeping newest incoming and shared evidence", async () => {
		const f = fixture();
		const service = new DmService({
			...f.options,
			readVideoContent: async () => ({ transcript: 'verified evidence\\\"\n'.repeat(3000) }),
		});
		await service.tick();
		f.setMessages([
			msg("1"),
			...Array.from({ length: 39 }, (_, i) =>
				msg(
					String(i + 2),
					456,
					1,
					`NEWEST${i} ${["BV1xx411c7mD", "BV1xx411c7mE", "BV1xx411c7mF"][i % 3]} ` + '中文字\\\"\n'.repeat(1500),
				),
			),
		]);
		await service.tick();
		const request: any = f.complete.mock.calls[0][0];
		expect(request.prompt.length).toBeLessThanOrEqual(7800);
		const parsed = JSON.parse(request.prompt);
		expect(parsed.conversation.at(-1).text).toContain("NEWEST38");
		expect(parsed.evidence).toHaveLength(3);
		for (const item of parsed.evidence) expect(item.content).toContain("verified evidence");
		expect(f.sends).toHaveLength(1);
	});
	it("never automatically retries an ambiguous send, including after restart", async () => {
		const f = fixture();
		await f.service.tick();
		f.setMessages([msg("1"), msg("2")]);
		f.fail();
		await expect(f.service.tick()).rejects.toThrow("connection reset");
		await new DmService(f.options).tick();
		expect(f.sends).toHaveLength(1);
		const state = JSON.parse(readFileSync(join(f.storageDir, "dm-service-state.json"), "utf8")).accounts[123];
		expect(state.peers[456].mark).toBe("1");
		expect(state.peers[456].pending.key).toBe("2");
	});
	it("does not reply after our own outbound or over the daily quota", async () => {
		const f = fixture();
		await f.service.tick();
		f.setMessages([msg("1"), msg("2"), msg("3", 123)]);
		await f.service.tick();
		expect(f.sends).toHaveLength(0);
		f.cfg.dmReplyPerDay = 1;
		f.setMessages([msg("1"), msg("2"), msg("3", 123), msg("4")]);
		await f.service.tick();
		f.setMessages([msg("1"), msg("2"), msg("3", 123), msg("4"), msg("5")]);
		await f.service.tick();
		expect(f.complete).toHaveBeenCalledOnce();
		expect(f.sends).toHaveLength(1);
	});
	it("cancels and disposes without sending", async () => {
		const f = fixture();
		await f.service.tick();
		f.setMessages([msg("1"), msg("2")]);
		const controller = new AbortController();
		controller.abort();
		await expect(f.service.tick({ signal: controller.signal })).rejects.toThrow();
		f.service.dispose();
		expect(await f.service.tick()).toEqual({ skipped: true });
		expect(f.sends).toHaveLength(0);
	});
	it("walks message pages instead of replying only to the latest page", async () => {
		const f = fixture();
		await f.service.tick();
		f.fetchMock.mockImplementation(async (url: any) => {
			const u = String(url);
			let data: any;
			if (u.includes("get_sessions")) data = { session_list: [{ talker_id: 456 }], has_more: 0 };
			else if (u.includes("size=1&")) data = { messages: [msg("4")], has_more: 1 };
			else if (u.includes("begin_seqno=3")) data = { messages: [msg("2"), msg("1")], has_more: 0 };
			else if (u.includes("fetch_session_msgs")) data = { messages: [msg("4"), msg("3")], min_seqno: 3, has_more: 1 };
			else {
				f.sends.push("sent");
				data = {};
			}
			return { ok: true, status: 200, json: async () => ({ code: 0, data }) };
		});
		await f.service.tick();
		const request: any = f.complete.mock.calls[0]?.[0];
		expect(JSON.parse(request.prompt).conversation).toHaveLength(4);
		expect(f.sends).toHaveLength(1);
	});
});
