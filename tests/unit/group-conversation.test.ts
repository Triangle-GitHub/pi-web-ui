// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupConversation } from "../../web/src/components/GroupConversation";
import { TemplateProvider } from "../../web/src/components/PromptTemplates";
import { LanguageProvider } from "../../web/src/i18n";
import { resetAppGlobals, setAppSend } from "../../web/src/app-globals";
vi.mock("../../web/src/components/MessageList", () => ({
	MessageList: (props: any) =>
		createElement(
			"div",
			{ "data-readonly": props.readOnly },
			props.state.messages.map((m: any) => createElement("p", { key: m.id }, m.content[0].text)),
		),
}));
let root: Root;
let host: HTMLDivElement;
const localSend = vi.fn(() => true);
const device = { id: "alpha", name: "Twin" };
const detail = {
	room: { id: "one", name: "Room", botIds: ["alpha"] },
	bots: [{ id: "alpha", name: "Twin", deviceId: "host", enabled: true }],
	messages: [{ id: "m", text: "old message", createdAt: 1, sender: { name: "Human" } }],
	tasks: [],
};
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as Response;
async function mount(roomId = "one") {
	await act(async () =>
		root.render(
			createElement(
				LanguageProvider,
				null,
				createElement(TemplateProvider, {
					currentModelId: null,
					children: createElement(GroupConversation, { roomId }),
				}),
			),
		),
	);
}
async function type(text: string) {
	const input = host.querySelector("textarea")!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
		input.selectionStart = text.length;
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function send() {
	await act(async () => host.querySelector<HTMLButtonElement>(".btn.send")!.click());
}
beforeEach(() => {
	Object.defineProperty(Element.prototype, "scrollIntoView", { value: vi.fn(), configurable: true });
	vi.useFakeTimers();
	localStorage.clear();
	setAppSend(localSend);
	localSend.mockClear();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
});
afterEach(() => {
	act(() => root.unmount());
	document.body.innerHTML = "";
	resetAppGlobals();
	setAppSend(null);
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
const conversation = {
	id: "persistent-a",
	botId: "alpha",
	name: "Design review",
	status: "idle",
	latestTaskId: "task-private",
};
async function selectConversation(_value: string) {
	await type("@");
	await act(async () => host.querySelectorAll<HTMLButtonElement>(".slash-item")[1].click());
}
async function append(text: string) {
	await type(host.querySelector("textarea")!.value + text);
}
describe("group stream lifecycle", () => {
	it("routes new and continued Bot mentions without a separate dropdown", async () => {
		const posts: { url: string; body: any }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				if (init.method === "POST") {
					posts.push({ url, body: JSON.parse(init.body as string) });
					return response({});
				}
				return response(url.endsWith("/conversations") ? { conversations: [conversation] } : detail);
			}),
		);
		await mount();
		expect(host.querySelector("select")).toBeNull();
		await type("@");
		expect(host.querySelector(".slash-menu")?.textContent).toContain("Design review");
		expect(host.querySelector(".slash-menu")?.textContent).not.toContain("persistent-a");
		await act(async () => host.querySelector<HTMLButtonElement>(".slash-item")!.click());
		await append("new work");
		await send();
		expect(posts[0].url).toMatch(/rooms\/one\/messages$/);
		expect(posts[0].body.targetBotIds).toEqual(["alpha"]);
		await selectConversation(conversation.id);
		await append("follow up");
		await send();
		expect(posts[1].url).toMatch(/conversations\/persistent-a\/messages$/);
		expect(posts[1].body.text).toBe("@Twin(alpha) follow up");
	});
	it("rejects mixed new and continued mentions before sending", async () => {
		const posts: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				if (init.method === "POST") posts.push(url);
				return response(url.endsWith("/conversations") ? { conversations: [conversation] } : detail);
			}),
		);
		await mount();
		await selectConversation(conversation.id);
		await append("@alpha");
		await act(async () => host.querySelector<HTMLButtonElement>(".slash-item")!.click());
		await append("work");
		await send();
		expect(posts).toEqual([]);
		expect(host.textContent).toMatch(/one conversation|一个对话/);
	});
	it("never falls back after a failed or deleted continued conversation", async () => {
		let conversations = [conversation];
		const posts: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				if (init.method === "POST") {
					posts.push(url);
					return response({ error: "missing" }, 404);
				}
				return response(url.endsWith("/conversations") ? { conversations } : detail);
			}),
		);
		await mount();
		await selectConversation(conversation.id);
		await append("follow up");
		await send();
		await send();
		expect(posts).toHaveLength(2);
		expect(posts.every((url) => url.includes("/conversations/persistent-a/messages"))).toBe(true);
		conversations = [];
		await act(async () => vi.advanceTimersByTimeAsync(2000));
		await send();
		expect(posts).toHaveLength(2);
		expect(host.textContent).toMatch(/unavailable|不可用/);
	});
	it("aborts a pending continuation on room change and ignores its late success", async () => {
		let release!: (value: Response) => void;
		let signal!: AbortSignal;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				if (init.method === "POST") {
					signal = init.signal as AbortSignal;
					return new Promise<Response>((resolve) => {
						release = resolve;
					});
				}
				return response(url.endsWith("/conversations") ? { conversations: [conversation] } : detail);
			}),
		);
		await mount();
		await selectConversation(conversation.id);
		await append("old work");
		await send();
		await mount("two");
		await type("new draft");
		expect(signal.aborted).toBe(true);
		await act(async () => release(response({})));
		expect(host.querySelector("textarea")?.value).toBe("new draft");
		expect(host.querySelector("select")).toBeNull();
	});
	it("bounds conversation polling and ignores an aborted list from the old room", async () => {
		let release!: (value: Response) => void;
		let oldSignal!: AbortSignal;
		let requests = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				if (url.endsWith("one/conversations")) {
					requests++;
					oldSignal = init.signal as AbortSignal;
					return new Promise<Response>((resolve) => {
						release = resolve;
					});
				}
				return response(url.endsWith("/conversations") ? { conversations: [] } : detail);
			}),
		);
		await mount();
		await act(async () => vi.advanceTimersByTimeAsync(6000));
		expect(requests).toBe(1);
		await mount("two");
		expect(oldSignal.aborted).toBe(true);
		await act(async () => release(response({ conversations: [conversation] })));
		await type("@");
		expect(host.querySelector(".slash-menu")?.textContent).not.toContain("Design review");
	});
	it("keeps the device picker open across repeated Hub refreshes", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => response(url.includes("/devices") ? { devices: [{ ...device }] } : { ...detail })),
		);
		await mount();
		await type("@");
		expect(host.querySelector(".slash-menu")).not.toBeNull();
		await act(async () => vi.advanceTimersByTimeAsync(6000));
		expect(host.querySelector("textarea")?.value).toBe("@");
		expect(host.querySelector(".slash-menu")).not.toBeNull();
		expect(host.querySelector(".slash-menu")?.textContent).toContain("Twin");
	});
	it("clears stale messages when the device binding requires repair", async () => {
		let repair = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				response(
					url.includes("/devices")
						? { devices: [device] }
						: repair
							? { error: "stale binding", code: "REPAIR_REQUIRED" }
							: detail,
					!url.includes("/devices") && repair ? 409 : 200,
				),
			),
		);
		await mount();
		repair = true;
		await act(async () => vi.advanceTimersByTimeAsync(2000));
		expect(host.textContent).not.toContain("old message");
		expect(host.querySelector("[role=alert]")?.textContent).toMatch(/bind again|重新绑定/);
		expect(host.querySelector<HTMLButtonElement>(".btn.send")!.disabled).toBe(true);
	});
	it("isolates room drafts and ignores an old room's late response", async () => {
		let release!: (response: Response) => void;
		let oldSignal: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				if (url.includes("/devices")) return response({ devices: [device] });
				if (url.includes("rooms/one")) {
					oldSignal = init.signal as AbortSignal;
					return new Promise<Response>((resolve) => {
						release = resolve;
					});
				}
				return response({ ...detail, room: { ...detail.room, id: "two" }, messages: [] });
			}),
		);
		await mount();
		await type("draft one");
		await mount("two");
		expect(oldSignal?.aborted).toBe(true);
		expect(host.querySelector("textarea")?.value).toBe("");
		await act(async () => release(response(detail)));
		expect(host.textContent).not.toContain("old message");
	});
	it("uses the real composer, keeps failed requests and retries with the same key without local sends", async () => {
		vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes.fill(7) });
		const bodies: any[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				if (init.method === "POST") {
					bodies.push(JSON.parse(init.body as string));
					return response({ error: "Hub offline" }, 503);
				}
				return response(url.includes("/devices") ? { devices: [device] } : detail);
			}),
		);
		await mount();
		expect(host.querySelector("[data-readonly=true]")).not.toBeNull();
		expect(host.querySelector(".attach-img")).toBeNull();
		await type("/help ordinary group chat");
		await send();
		await send();
		expect(bodies).toHaveLength(2);
		expect(bodies[0].targetBotIds).toEqual([]);
		expect(bodies[0].idempotencyKey).toBe(bodies[1].idempotencyKey);
		expect(host.querySelector("textarea")?.value).toBe("/help ordinary group chat");
		expect(bodies[0].idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
		await type("@Twin");
		await send();
		expect(bodies.at(-1).targetBotIds).toEqual([]);
		await type("@alpha");
		await act(async () => host.querySelector<HTMLButtonElement>(".slash-item")!.click());
		await send();
		expect(bodies.at(-1).targetBotIds).toEqual(["alpha"]);
		await type("nothing");
		await type("@Twin(alpha)");
		await send();
		expect(bodies.at(-1).targetBotIds).toEqual([]);
		await act(async () => vi.advanceTimersByTimeAsync(500));
		expect(localSend).not.toHaveBeenCalled();
	});
	it("clears deleted room messages and aborts pending requests on unmount", async () => {
		let removed = false;
		const signals: AbortSignal[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				signals.push(init.signal as AbortSignal);
				return response(
					url.includes("/devices") ? { devices: [device] } : removed ? { error: "missing" } : detail,
					!url.includes("/devices") && removed ? 404 : 200,
				);
			}),
		);
		await mount();
		expect(host.textContent).toContain("old message");
		removed = true;
		await act(async () => vi.advanceTimersByTimeAsync(2000));
		expect(host.textContent).not.toContain("old message");
		expect(host.querySelector("[role=alert]")).not.toBeNull();
		act(() => root.unmount());
		expect(signals.at(-1)?.aborted).toBe(true);
	});
});
