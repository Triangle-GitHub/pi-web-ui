import { describe, expect, it } from "vitest";
import {
	estimateBaseContext,
	estimateContextWeights,
	reconcileContextCategories,
	type ContextWeights,
} from "../../server/context-usage.js";
import { estimatePromptTokens, renderPromptTemplate } from "../../server/prompt-composer.js";

const empty: ContextWeights = {
	systemPrompt: 0,
	memoryFiles: 0,
	tools: 0,
	skills: 0,
	toolResults: 0,
	messages: 0,
	other: 0,
};

function base(
	options: { promptTemplate?: string; promptOverrides?: Record<string, string>; promptDisabled?: string[] } = {},
) {
	const texts = {
		soul: "System instructions.",
		context: "Project memory.",
		skills: "Skills catalog.",
		tools: "Tools catalog.",
	};
	const full = renderPromptTemplate(
		options.promptTemplate ?? "",
		texts,
		options.promptOverrides,
		options.promptDisabled,
	);
	return { result: estimateBaseContext({ full, texts, toolsSchema: "Tool schemas." }, options), full };
}

describe("context usage categories", () => {
	it("keeps the existing prompt + schema baseline and separates sources", () => {
		const { result, full } = base();
		expect(result.tokens).toBe(estimatePromptTokens(full) + estimatePromptTokens("Tool schemas."));
		expect(result.weights.memoryFiles).toBe(estimatePromptTokens("Project memory."));
		expect(result.weights.skills).toBe(estimatePromptTokens("Skills catalog."));
		expect(result.weights.tools).toBe(estimatePromptTokens("Tools catalog.") + estimatePromptTokens("Tool schemas."));
		expect(Object.values(result.weights).reduce((n, value) => n + value, 0)).toBeCloseTo(result.tokens);
	});

	it("respects overridden, omitted, disabled and repeated prompt sections", () => {
		const { result } = base({
			promptTemplate: "Custom instructions {{context}} {{context}} {{skills}}",
			promptOverrides: { context: "Replacement memory" },
			promptDisabled: ["skills"],
		});
		expect(result.weights.memoryFiles).toBe(2 * estimatePromptTokens("Replacement memory"));
		expect(result.weights.skills).toBe(0);
		expect(result.weights.tools).toBe(estimatePromptTokens("Tool schemas."));
		expect(result.weights.systemPrompt).toBeGreaterThan(0);
	});

	it("separates tool arguments/results, skill bodies, messages and compaction summaries", () => {
		const messages = [
			{ role: "system", content: "Already counted in the baseline" },
			{ role: "user", content: "Hello world" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Inspecting the file" },
					{ type: "toolCall", id: "1", name: "read", arguments: { path: "README.md" } },
				],
			},
			{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "File contents" }] },
			{ role: "toolResult", toolName: "skill", content: [{ type: "text", text: "Skill instructions" }] },
			{ role: "compactionSummary", summary: "Previous context" },
		];
		const weights = estimateContextWeights(empty, messages);
		expect(weights.systemPrompt).toBe(0);
		expect(weights.messages).toBeGreaterThan(0);
		expect(weights.toolResults).toBeGreaterThan(0);
		expect(weights.skills).toBeGreaterThan(0);
		expect(weights.other).toBeGreaterThan(0);
		// Compaction changes the live context; removed tool output must disappear.
		const compacted = estimateContextWeights(empty, [messages[5]]);
		expect(compacted.toolResults).toBe(0);
		expect(compacted.skills).toBe(0);
	});

	it("counts streaming content once and never changes its source messages", () => {
		const streaming = { role: "assistant", content: [{ type: "text", text: "Streaming answer" }] };
		const original = JSON.stringify(streaming);
		expect(estimateContextWeights(empty, [], streaming)).toEqual(estimateContextWeights(empty, [streaming], streaming));
		expect(JSON.stringify(streaming)).toBe(original);
	});

	it("reuses settled-message estimates and re-estimates growing streaming content", () => {
		const cache = new WeakMap<object, ContextWeights>();
		const settled = { role: "user", content: "Settled message" };
		const streaming = { role: "assistant", content: [{ type: "text", text: "Now" }] };
		const before = estimateContextWeights(empty, [settled], streaming, cache);
		expect(cache.has(settled)).toBe(true);
		expect(cache.has(streaming)).toBe(false);
		streaming.content[0].text = "A much longer streaming answer that is still being generated";
		const after = estimateContextWeights(empty, [settled], streaming, cache);
		expect(after.messages).toBeGreaterThan(before.messages);
		expect(estimateContextWeights(empty, [], undefined, cache).messages).toBe(0);
	});

	it.each([0, 1, 17, 99, 100, 251, 1000])(
		"reconciles categories to the authoritative total %i without negative values",
		(total) => {
			const weights = { ...empty, systemPrompt: 71.25, memoryFiles: 13.5, tools: 12.75, messages: 99.5 };
			const rows = reconcileContextCategories(weights, total);
			expect(rows.reduce((n, row) => n + row.tokens, 0)).toBe(total);
			expect(rows.every((row) => Number.isInteger(row.tokens) && row.tokens > 0)).toBe(true);
		},
	);

	it("puts unexplained usage in Other without inflating the known categories", () => {
		const rows = reconcileContextCategories({ ...empty, systemPrompt: 40, tools: 10 }, 100);
		expect(rows).toEqual([
			{ category: "systemPrompt", tokens: 40 },
			{ category: "tools", tokens: 10 },
			{ category: "other", tokens: 50 },
		]);
	});
});
