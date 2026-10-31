// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContextUsage } from "../../web/src/components/ContextUsage.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { UiState } from "../../server/protocol.js";

type Usage = UiState["stats"]["contextUsage"];
let root: Root;
let container: HTMLDivElement;
const usage: Usage = {
	tokens: 80000,
	contextWindow: 1000000,
	percent: 8,
	categories: [
		{ category: "systemPrompt", tokens: 7000 },
		{ category: "memoryFiles", tokens: 500 },
		{ category: "tools", tokens: 19000 },
		{ category: "skills", tokens: 2500 },
		{ category: "toolResults", tokens: 18000 },
		{ category: "messages", tokens: 31000 },
		{ category: "other", tokens: 2000 },
	],
};

function render(
	context: Usage | undefined = usage,
	bar: "top" | "bottom" | "left" | "right" = "top",
	key = "conversation-1",
) {
	act(() =>
		root.render(
			createElement(
				LanguageProvider,
				null,
				createElement(ContextUsage, {
					key,
					context,
					bar,
					title: "上下文用量",
					onContextMenu: () => {},
					children: "80K / 1M",
				}),
			),
		),
	);
	return container.querySelector<HTMLButtonElement>("button")!;
}
function panel() {
	return document.querySelector<HTMLDivElement>(".context-usage-panel");
}
function click(button: HTMLButtonElement) {
	act(() => button.click());
}

beforeEach(() => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	localStorage.setItem("pi-web-ui:lang", "zh");
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

describe("context usage popover", () => {
	it.each(["top", "bottom", "left", "right"] as const)(
		"opens from the %s bar with categorized usage and free space",
		(bar) => {
			const button = render(usage, bar);
			expect(panel()).toBeNull();
			click(button);
			expect(button.getAttribute("aria-expanded")).toBe("true");
			expect(panel()?.parentElement).toBe(document.body);
			expect(panel()?.getAttribute("role")).toBe("dialog");
			expect(panel()?.textContent).toContain("已用 8%");
			expect(panel()?.textContent).toContain("估算：80K / 1M token");
			expect(panel()?.querySelectorAll("li")).toHaveLength(8);
			expect(panel()?.querySelector('li[data-category="free"]')?.textContent).toContain("920K");
		},
	);

	it("closes on a repeated click, Escape or an outside click", () => {
		const button = render();
		click(button);
		click(button);
		expect(panel()).toBeNull();
		click(button);
		act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(panel()).toBeNull();
		click(button);
		act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
		expect(panel()).toBeNull();
		expect(button.getAttribute("aria-expanded")).toBe("false");
	});

	it("keeps the panel open on scroll or a click inside", () => {
		const button = render();
		click(button);
		act(() => panel()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
		act(() => window.dispatchEvent(new Event("scroll")));
		expect(panel()).not.toBeNull();
	});

	it("updates live totals and closes when the conversation changes", () => {
		click(render());
		render({ ...usage, tokens: 100000, percent: 10 });
		expect(panel()?.textContent).toContain("已用 10%");
		expect(panel()?.querySelector('li[data-category="free"]')?.textContent).toContain("900K");
		render(usage, "top", "conversation-2");
		expect(panel()).toBeNull();
	});

	it("explains soft caps using the same denominator as the existing badge", () => {
		click(render({ ...usage, softCap: 200000 }));
		expect(panel()?.textContent).toContain("已用 40%");
		expect(panel()?.textContent).toContain("80K / 200K");
		expect(panel()?.textContent).toContain("压缩软上限：200K · 模型容量：1M");
	});

	it("explains that request transformations can change estimated category proportions", () => {
		click(render());
		expect(panel()?.textContent).toContain("分类按会话内容估算并校准到总用量");
		expect(panel()?.textContent).toContain("去重、工具结果外置或扩展转换");
		render({ ...usage, categories: undefined });
		expect(panel()?.textContent).not.toContain("分类按会话内容估算");
		expect(panel()?.textContent).toContain("当前引擎仅提供总用量");
	});

	it("handles engines that provide only a total without inventing a breakdown", () => {
		click(render({ ...usage, categories: undefined }));
		expect(panel()?.textContent).toContain("当前引擎仅提供总用量");
		expect(panel()?.textContent).toContain("已用空间");
		expect(panel()?.textContent).not.toContain("系统提示词");
		expect(panel()?.querySelectorAll("li")).toHaveLength(2);
	});

	it("distinguishes zero usage from unknown usage and clamps over-capacity values", () => {
		const button = render({ ...usage, tokens: null, categories: undefined });
		click(button);
		expect(panel()?.textContent).toContain("暂无上下文用量数据");
		expect(panel()?.querySelector('[role="meter"]')).toBeNull();
		render({ ...usage, tokens: 0, categories: [] });
		expect(panel()?.textContent).toContain("已用 0%");
		expect(panel()?.querySelector('li[data-category="free"]')?.textContent).toContain("1M");
		render({ ...usage, tokens: 1100000, categories: undefined });
		expect(panel()?.textContent).toContain("已用 100%");
		expect(panel()?.querySelector('li[data-category="free"] .context-usage-value')?.textContent).toBe("0");
	});
});
