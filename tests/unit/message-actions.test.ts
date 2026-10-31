// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Message } from "../../web/src/components/Message";
import { LanguageProvider } from "../../web/src/i18n";
import { setAppSend } from "../../web/src/app-globals";
import type { UiSlotEntry } from "../../web/src/ui-slots";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const send = vi.fn(() => true);
const edit = vi.fn();
const entries = ["reask", "edit-reask", "fork", "rollback", "copy-markdown"].map((name) => ({
	id: `host:msg-${name}`,
	source: "host",
	kind: "button",
	label: name,
})) as unknown as UiSlotEntry[];
function mount(extra: Record<string, unknown> = {}) {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	setAppSend(send);
	act(() =>
		root.render(
			createElement(
				LanguageProvider,
				null,
				createElement(Message, {
					message: { id: "u1", role: "user", timestamp: 1, content: [{ type: "text", text: "Original question" }] },
					toolResults: new Map(),
					liveOutputs: new Map(),
					toolStatuses: new Map(),
					streaming: false,
					isLast: false,
					onEdit: edit,
					uiMessageActions: entries,
					...extra,
				}),
			),
		),
	);
}
function click(selector: string) {
	const button = container.querySelector<HTMLElement>(selector)!;
	expect(button).not.toBeNull();
	act(() => button.click());
}
afterEach(() => {
	if (root) act(() => root.unmount());
	document.body.replaceChildren();
	setAppSend(null);
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});
it("refresh reasks immediately in the current conversation with the original attachments", () => {
	const attachments = [{ path: "notes.txt", mode: "reference" }];
	mount({ questionAttachments: attachments });
	click('.msg-action[aria-label="reask"]');
	expect(edit).toHaveBeenCalledWith("u1", "Original question", attachments);
	expect(send).not.toHaveBeenCalled();
});
it("pencil and user rollback open the inline editor and submit the selected question", () => {
	mount();
	act(() =>
		[...container.querySelectorAll<HTMLButtonElement>(".msg-action")]
			.find((button) => button.textContent?.includes("edit-reask"))!
			.click(),
	);
	expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Original question");
	click(".msg-editor .btn.primary");
	expect(edit).toHaveBeenCalledWith("u1", "Original question", undefined);
	click('.msg-action[aria-label="rollback"]');
	expect(container.querySelector("textarea")).not.toBeNull();
	expect(send).not.toHaveBeenCalled();
});
it.each(["edit", "reask"])("%s restores stored image bytes before submitting", async (action) => {
	const imageUrl = `/api/attachment/${"a".repeat(64)}`;
	const fetchImage = vi.fn(async () => ({
		ok: true,
		blob: async () => new Blob(["image bytes"], { type: "image/png" }),
	}));
	vi.stubGlobal("fetch", fetchImage);
	mount({ questionAttachments: [{ path: "", imageUrl, name: "first.png", mimeType: "image/png" }] });
	if (action === "edit") {
		act(() =>
			[...container.querySelectorAll<HTMLButtonElement>(".msg-action")]
				.find((button) => button.textContent?.includes("edit-reask"))!
				.click(),
		);
		expect(container.querySelector<HTMLImageElement>(".msg-editor-img img")?.getAttribute("src")).toBe(imageUrl);
		click(".msg-editor .btn.primary");
	} else {
		click('.msg-action[aria-label="reask"]');
	}
	expect(edit).not.toHaveBeenCalled();
	await act(async () => {
		await vi.waitFor(() => expect(edit).toHaveBeenCalledOnce());
	});
	expect(fetchImage).toHaveBeenCalledWith(imageUrl);
	expect(edit).toHaveBeenCalledWith("u1", "Original question", [
		{ path: "", name: "first.png", mimeType: "image/png", imageData: btoa("image bytes") },
	]);
});
it("failed image restoration keeps the editor and never submits a question without its image", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: false, status: 404 })),
	);
	mount({ questionAttachments: [{ path: "", imageUrl: `/api/attachment/${"a".repeat(64)}`, name: "first.png" }] });
	click('.msg-action[aria-label="reask"]');
	await act(async () => {
		await Promise.resolve();
	});
	expect(container.querySelector(".msg-editor-notice")).not.toBeNull();
	expect(edit).not.toHaveBeenCalled();
	expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Original question");
	expect(container.querySelector(".msg-editor-img img")).not.toBeNull();
});
it("read-only messages keep copy/export and metadata while hiding local conversation actions", () => {
	mount({ readOnly: true, messageLabel: "Sender · device", canRollbackEdit: true });
	expect(container.textContent).toContain("Sender · device");
	expect(container.querySelector(".msg-copy-main-btn")).not.toBeNull();
	expect(container.querySelectorAll(".msg-actions button")).toHaveLength(2);
	expect(edit).not.toHaveBeenCalled();
	expect(send).not.toHaveBeenCalled();
});
it("fork includes the selected message", () => {
	mount();
	click('.msg-action[aria-label="fork"]');
	expect(send).toHaveBeenCalledWith({ type: "fork_session", messageId: "u1", position: "at" });
});
it("assistant rollback delegates to the list target resolver without workspace rollback", () => {
	const rollback = vi.fn();
	mount({
		message: { id: "a1", role: "assistant", timestamp: 2, content: [{ type: "text", text: "Answer" }] },
		canRollbackEdit: true,
		onRollbackEdit: rollback,
	});
	click('.msg-action[aria-label="rollback"]');
	expect(rollback).toHaveBeenCalledWith("a1");
	expect(send).not.toHaveBeenCalled();
});
it("all action buttons have immediate portal tooltips without native title attributes; copy menu is portalled", () => {
	mount();
	for (const button of container.querySelectorAll<HTMLButtonElement>(".msg-actions button")) {
		expect(button.hasAttribute("title")).toBe(false);
		act(() => button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
		const tooltip = document.body.querySelector('[role="tooltip"]');
		expect(tooltip).not.toBeNull();
		expect(container.contains(tooltip)).toBe(false);
		expect(button.getAttribute("aria-describedby")).toBe(tooltip?.id);
		act(() => button.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
		expect(document.querySelector('[role="tooltip"]')).toBeNull();
	}
	click(".msg-copy-caret-btn");
	expect(document.querySelector('[role="menu"]')).not.toBeNull();
	expect(container.querySelector('[role="menu"]')).toBeNull();
	act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
	expect(document.querySelector('[role="menu"]')).toBeNull();
});
