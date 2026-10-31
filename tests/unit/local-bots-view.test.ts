// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LocalBots } from "../../web/src/components/LocalBots";
import { en } from "../../web/src/i18n";
vi.mock("../../web/src/i18n", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../web/src/i18n")>()),
	useT: () => (key: keyof typeof en) => en[key],
}));
let root: Root;
let host: HTMLDivElement;
afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
const bot = {
	id: "bot-stable",
	revision: 7,
	name: "Helper",
	description: "",
	systemPrompt: "",
	cwd: "D:/project",
	tools: [],
	skills: [],
	mcpServers: [],
	enabled: true,
};
const options = {
	cwd: "D:/project",
	defaultCwd: "D:/project",
	defaultModel: "openrouter/anthropic/claude",
	models: [
		{ id: "openrouter/anthropic/claude", provider: "openrouter", name: "Claude", reasoning: true, vision: true },
	],
	tools: [
		{ id: "read", name: "Read files", description: "Inspect files" },
		{ id: "edit", name: "Edit files" },
	],
	skills: [{ id: "docx", name: "Word documents", path: "D:/skills/docx/SKILL.md" }],
	mcpServers: [{ id: "github", name: "GitHub", tools: [], status: "not_loaded", scope: "global" }],
	projects: [{ path: "D:/other" }],
};
const response = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response;
async function mount(bots: unknown, synced = true, catalog?: (url: string, init?: RequestInit) => Promise<Response>) {
	const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
		if (url.includes("local-bot-options")) return catalog ? catalog(url, init) : response(options);
		return response(init?.method === "POST" ? { bot, removed: true, synced } : { bots });
	});
	vi.stubGlobal("fetch", fetcher);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root.render(createElement(LocalBots)));
	return fetcher;
}
async function click(text: string, scope: ParentNode = host) {
	const el = [...scope.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
	expect(el).toBeTruthy();
	await act(async () => el!.click());
}
async function input(label: string, value: string) {
	const el = [...host.querySelectorAll("label")]
		.find((l) => l.textContent?.includes(label))
		?.querySelector("input,textarea") as HTMLInputElement;
	expect(el).toBeTruthy();
	await setInput(el, value);
}
async function setInput(el: HTMLInputElement, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
			"value",
		)!.set!.call(el, value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function check(text: string) {
	const el = [...host.querySelectorAll(".dc-bot-option")]
		.find((l) => l.textContent?.includes(text))
		?.querySelector("input");
	expect(el).toBeTruthy();
	await act(async () => el!.click());
}
async function save() {
	await act(async () =>
		host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
	);
}
const posted = (fetcher: Awaited<ReturnType<typeof mount>>) =>
	JSON.parse(fetcher.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body as string);
it("opens a modal drawer and restores the page when dismissed with Escape", async () => {
	const previousOverflow = document.body.style.overflow;
	await mount([bot]);
	await click("Helper");
	const drawer = host.querySelector<HTMLDialogElement>("dialog.dc-bot-drawer")!;
	expect(drawer.getAttribute("aria-label")).toBe(en.localBotTitle);
	expect(drawer.contains(host.querySelector("form"))).toBe(true);
	expect(drawer.querySelector(".dc-bot-drawer-close")).toBeTruthy();
	expect(document.body.style.overflow).toBe("hidden");
	await act(async () => {
		drawer.dispatchEvent(new Event("cancel", { cancelable: true }));
	});
	expect(host.querySelector("dialog.dc-bot-drawer")).toBeNull();
	expect(document.body.style.overflow).toBe(previousOverflow);
	expect(host.querySelector(".dc-bot-item")?.textContent).toContain("Helper");
});
it("keeps the directory browser inside the Bot modal and closes only the browser with Escape", async () => {
	await mount([bot]);
	await click("Helper");
	const drawer = host.querySelector<HTMLDialogElement>("dialog")!;
	await act(async () => drawer.querySelector<HTMLButtonElement>(".universal-path-browse-btn")!.click());
	expect(drawer.querySelector(".project-picker")).toBeTruthy();
	await act(async () =>
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })),
	);
	expect(drawer.querySelector(".project-picker")).toBeNull();
	expect(host.contains(drawer)).toBe(true);
});
it("switches configuration tabs without losing unsaved fields", async () => {
	await mount([bot]);
	await click("Helper");
	await input("Description", "Unsaved identity");
	await click(en.localBotRuntime, host.querySelector('[role="tablist"]')!);
	expect(host.querySelector<HTMLElement>("#bot-panel-identity")!.hidden).toBe(true);
	expect(host.querySelector<HTMLElement>("#bot-panel-runtime")!.hidden).toBe(false);
	await click(en.localBotPermissions, host.querySelector('[role="tablist"]')!);
	expect(host.querySelector<HTMLElement>("#bot-panel-permissions")!.hidden).toBe(false);
	await click(en.localBotIdentity, host.querySelector('[role="tablist"]')!);
	expect(host.querySelector<HTMLTextAreaElement>("#bot-panel-identity textarea")!.value).toBe("Unsaved identity");
});
it("saves catalog selections and inherited model while reporting local success on failed Hub sync", async () => {
	const fetcher = await mount([], false);
	await click("New Bot");
	await input("Name", "Helper");
	expect((host.querySelector("#local-bot-cwd") as HTMLInputElement).value).toBe("D:/project");
	await check("Read files");
	await check("Word documents");
	await check("GitHub");
	await save();
	expect(posted(fetcher)).toMatchObject({
		tools: ["read"],
		skills: ["docx"],
		mcpServers: ["github"],
		cwd: "D:/project",
	});
	expect(posted(fetcher).model).toBeUndefined();
	expect(host.querySelector('[role="status"]')?.textContent).toContain("Saved locally, but Hub sync failed");
});
it("preserves unknown IDs, supports searchable catalogs and select all/clear", async () => {
	const fetcher = await mount([{ ...bot, tools: ["legacy"], skills: ["old-skill"] }]);
	await click("Helper");
	expect(host.textContent).toContain("Unavailable in this project");
	const tools = host.querySelector(".dc-bot-catalog")!;
	await setInput(tools.querySelector('input[type="search"]')!, "Inspect");
	expect(tools.textContent).toContain("Read files");
	expect(tools.textContent).not.toContain("Edit files");
	await click("Select results", tools);
	expect((tools.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
	await setInput(tools.querySelector('input[type="search"]')!, "");
	await click("Select all", tools);
	expect([...tools.querySelectorAll('input[type="checkbox"]')].every((el) => (el as HTMLInputElement).checked)).toBe(
		true,
	);
	await check("legacy");
	await click("Clear", host.querySelectorAll(".dc-bot-catalog")[2]);
	await save();
	expect(posted(fetcher)).toMatchObject({ tools: ["read", "edit"], skills: ["old-skill"], mcpServers: [] });
});
it("uses the real model picker and strips the provider once while preserving model slashes", async () => {
	const fetcher = await mount([bot]);
	await click("Helper");
	await click("Inherit default model");
	const dialog = document.querySelector('[role="dialog"]')!;
	expect(dialog.querySelector(".dd-search")).toBeTruthy();
	const row = dialog.querySelector<HTMLElement>(".dd-item");
	expect(row).toBeTruthy();
	await act(async () => row!.click());
	await save();
	expect(posted(fetcher).model).toEqual({ provider: "openrouter", modelId: "anthropic/claude" });
});
it("retains unavailable models and lets users explicitly inherit", async () => {
	const fetcher = await mount([{ ...bot, model: { provider: "gone", modelId: "a/b" } }]);
	await click("Helper");
	expect(host.textContent).toContain("gone/a/b");
	await click("Inherit default model");
	await save();
	expect(posted(fetcher).model).toBeUndefined();
});
it("ignores stale catalog responses after cwd changes without resetting permissions", async () => {
	let resolveOld!: (data: Response) => void;
	let oldSignal: AbortSignal | undefined;
	const fetcher = await mount([{ ...bot, tools: ["legacy"] }], true, async (url, init) => {
		if (url.includes(encodeURIComponent("D:/project"))) {
			oldSignal = init?.signal as AbortSignal;
			return new Promise((resolve) => {
				resolveOld = resolve;
			});
		}
		return response({ ...options, cwd: "D:/other", tools: [{ id: "new", name: "New catalog" }] });
	});
	await click("Helper");
	const cwd = host.querySelector<HTMLInputElement>("#local-bot-cwd")!;
	const beforeTyping = fetcher.mock.calls.length;
	await setInput(cwd, "D:/other");
	expect(fetcher.mock.calls.length).toBe(beforeTyping);
	await act(async () => cwd.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
	expect(oldSignal?.aborted).toBe(true);
	expect(host.textContent).toContain("New catalog");
	await act(async () => resolveOld(response(options)));
	expect(host.textContent).not.toContain("Read files");
	await save();
	expect(posted(fetcher)).toMatchObject({ cwd: "D:/other", tools: ["legacy"] });
});
it("reports catalog failure and retries without losing selections", async () => {
	let fail = true;
	const fetcher = await mount([{ ...bot, skills: ["old"] }], true, async () =>
		fail ? response({ error: "Catalog offline" }, false) : response(options),
	);
	await click("Helper");
	expect(host.textContent).toContain("Catalog offline");
	expect(host.textContent).toContain("old");
	fail = false;
	await click("Retry");
	expect(host.textContent).toContain("Word documents");
	await save();
	expect(posted(fetcher).skills).toEqual(["old"]);
});
it("explains MCP connection state and prevents granting disabled servers while allowing removal", async () => {
	const fetcher = await mount([{ ...bot, mcpServers: ["disabled-old"] }], true, async () =>
		response({
			...options,
			mcpServers: [
				{ id: "github", name: "GitHub", status: "not_loaded" },
				{ id: "disabled-new", name: "Disabled new", status: "disabled" },
				{ id: "disabled-old", name: "Disabled old", status: "disabled" },
			],
		}),
	);
	await click("Helper");
	expect(host.textContent).toContain("Connect this server in MCP settings");
	const field = host.querySelectorAll(".dc-bot-catalog")[2];
	const boxes = [...field.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
	expect(boxes[1].disabled).toBe(true);
	expect(boxes[2].disabled).toBe(false);
	await check("Disabled old");
	await click("Select all", field);
	await save();
	expect(posted(fetcher).mcpServers).toEqual(["github"]);
});
it("updates and deletes using the stable ID and loaded revision", async () => {
	const fetcher = await mount([bot]);
	await click("Helper");
	await input("Description", "Updated");
	await save();
	expect(posted(fetcher)).toMatchObject({ id: "bot-stable", revision: 7, description: "Updated" });
	await click("Helper");
	vi.spyOn(window, "confirm").mockReturnValue(true);
	await click("Delete");
	const deleted = fetcher.mock.calls.find(([url]) => url.includes("/bot-stable/delete"));
	expect(deleted).toBeTruthy();
	expect(JSON.parse(deleted![1]!.body as string)).toEqual({ revision: 7 });
});
it("reports malformed lists without crashing the device view", async () => {
	await mount(undefined);
	expect(host.querySelector('[role="alert"]')?.textContent).toContain("Invalid Bot list");
});
