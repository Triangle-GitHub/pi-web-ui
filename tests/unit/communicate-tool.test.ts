import { describe, expect, it, vi } from "vitest";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { makeCommunicateTool } from "../../server/communicate-tool.js";

describe("communicate tool", () => {
	it("forwards structured requests and cancellation without binding a conversation holder", async () => {
		const communicate = vi.fn(async () => ({ requestId: "q", result: null }));
		const tool = makeCommunicateTool({ communicate });
		const signal = new AbortController().signal;
		const args = { to: "root", questions: [{ id: "q", question: "Choose?" }], timeoutSeconds: 0 };
		const result = await tool.execute("call", { action: "request", ...args }, signal, undefined, {} as any);
		expect(communicate).toHaveBeenCalledWith("request", args, signal);
		expect(result.details).toEqual({ requestId: "q", result: null });
	});
	it("keeps tool prose concise and exposes all five actions in a root object", () => {
		const tool = makeCommunicateTool({ communicate: vi.fn() });
		expect(tool.description.length).toBeLessThanOrEqual(600);
		expect(tool.promptSnippet!.length).toBeLessThanOrEqual(80);
		const schema = tool.parameters as any;
		expect(schema.type).toBe("object");
		expect(schema.anyOf).toBeUndefined();
		expect(schema.properties.action.anyOf.map((v: any) => v.const)).toEqual([
			"read",
			"send",
			"request",
			"reply",
			"escalate",
		]);
		expect(schema.required).toEqual(["action"]);
		expect(schema.properties.timeoutSeconds.minimum).toBe(0);
	});
	it.each([
		["undefined", undefined],
		["null", null],
		["primitive", "read"],
		["array", []],
		["missing action", {}],
		["unknown action", { action: "unknown" }],
		["send missing target", { action: "send", message: "hello" }],
		["send missing message", { action: "send", to: "root" }],
		["send empty target", { action: "send", to: "", message: "hello" }],
		["send empty message", { action: "send", to: "root", message: "" }],
		["request missing target", { action: "request", questions: [{ id: "q", question: "Choose?" }] }],
		["request missing questions", { action: "request", to: "root" }],
		["request empty questions", { action: "request", to: "root", questions: [] }],
		[
			"request too many questions",
			{ action: "request", to: "root", questions: Array.from({ length: 4 }, () => ({ id: "q", question: "Choose?" })) },
		],
		["request missing question text", { action: "request", to: "root", questions: [{ id: "q" }] }],
		["request empty question id", { action: "request", to: "root", questions: [{ id: "", question: "Choose?" }] }],
		["request empty question text", { action: "request", to: "root", questions: [{ id: "q", question: "" }] }],
		[
			"request invalid dependency",
			{
				action: "request",
				to: "root",
				questions: [{ id: "q", question: "Choose?", dependsOn: { questionId: "first", value: 1 } }],
			},
		],
		[
			"request bad options",
			{ action: "request", to: "root", questions: [{ id: "q", question: "Choose?", options: [{ label: "A" }] }] },
		],
		[
			"request empty option label",
			{
				action: "request",
				to: "root",
				questions: [{ id: "q", question: "Choose?", options: [{ label: "" }, { label: "B" }] }],
			},
		],
		[
			"request too many options",
			{
				action: "request",
				to: "root",
				questions: [{ id: "q", question: "Choose?", options: Array.from({ length: 5 }, () => ({ label: "A" })) }],
			},
		],
		[
			"request bad mapped options",
			{
				action: "request",
				to: "root",
				questions: [{ id: "q", question: "Choose?", optionsMap: { A: [{ label: "A" }] } }],
			},
		],
		[
			"request negative timeout",
			{ action: "request", to: "root", questions: [{ id: "q", question: "Choose?" }], timeoutSeconds: -1 },
		],
		[
			"request excessive timeout",
			{ action: "request", to: "root", questions: [{ id: "q", question: "Choose?" }], timeoutSeconds: 86401 },
		],
		[
			"request wrong timeout type",
			{ action: "request", to: "root", questions: [{ id: "q", question: "Choose?" }], timeoutSeconds: "1" },
		],
		["reply missing request", { action: "reply", answers: [{ id: "q", selected: [] }] }],
		["reply missing answers", { action: "reply", requestId: "q" }],
		["reply empty answers", { action: "reply", requestId: "q", answers: [] }],
		[
			"reply too many answers",
			{ action: "reply", requestId: "q", answers: Array.from({ length: 4 }, () => ({ id: "q", selected: [] })) },
		],
		[
			"reply invalid custom answer",
			{ action: "reply", requestId: "q", answers: [{ id: "q", selected: [], custom: 1 }] },
		],
		["reply missing selection", { action: "reply", requestId: "q", answers: [{ id: "q" }] }],
		["reply wrong selection type", { action: "reply", requestId: "q", answers: [{ id: "q", selected: [1] }] }],
		["escalate missing request", { action: "escalate" }],
		["escalate empty request", { action: "escalate", requestId: "" }],
		["invalid supplied field on read", { action: "read", timeoutSeconds: -1 }],
	])("rejects %s before dispatch, including direct execute calls", async (_label, params) => {
		const communicate = vi.fn(async () => ({ messages: [], remaining: 0 }));
		const tool = makeCommunicateTool({ communicate });
		await expect(tool.execute("call", params, undefined, undefined, {} as any)).rejects.toThrow(
			/^Invalid communicate arguments:/,
		);
		expect(communicate).not.toHaveBeenCalled();
	});

	it.each([
		{ action: "read" },
		{ action: "send", to: "parent", message: "hello" },
		{
			action: "request",
			to: "root",
			message: "",
			questions: [{ id: "q", question: "Choose?" }],
			timeoutSeconds: 86400,
		},
		{
			action: "request",
			to: "root",
			questions: [
				{
					id: "q",
					question: "Choose?",
					options: [{ label: "A" }, { label: "B" }],
					dependsOn: { questionId: "first", value: ["A"] },
					optionsMap: { A: [{ label: "A" }, { label: "B" }] },
				},
			],
		},
		{ action: "reply", requestId: "q", answers: [{ id: "q", selected: [], custom: "Other" }] },
		{ action: "escalate", requestId: "q" },
	])("dispatches valid $action arguments unchanged", async (params) => {
		const communicate = vi.fn(async () => ({ messages: [], remaining: 0 }));
		const tool = makeCommunicateTool({ communicate });
		await tool.execute("call", params, undefined, undefined, {} as any);
		const { action, ...args } = params;
		expect(communicate).toHaveBeenCalledWith(action, args, undefined);
	});

	it("validates serialized SDK arguments before enforcing action requirements at execution", async () => {
		const communicate = vi.fn(async () => ({ messages: [], remaining: 0 }));
		const tool = makeCommunicateTool({ communicate });
		const declaration = JSON.parse(JSON.stringify(tool));
		expect(() =>
			validateToolArguments(declaration, {
				type: "toolCall",
				id: "call",
				name: "communicate",
				arguments: { action: "request", to: "root", timeoutSeconds: -1 },
			}),
		).toThrow();
		const incomplete = validateToolArguments(declaration, {
			type: "toolCall",
			id: "call",
			name: "communicate",
			arguments: { action: "send", to: "root" },
		});
		await expect(tool.execute("call", incomplete, undefined, undefined, {} as any)).rejects.toThrow(
			"Invalid communicate arguments",
		);
		expect(communicate).not.toHaveBeenCalled();
		const valid = validateToolArguments(declaration, {
			type: "toolCall",
			id: "call",
			name: "communicate",
			arguments: { action: "send", to: "root", message: "hello" },
		});
		await tool.execute("call", valid, undefined, undefined, {} as any);
		expect(communicate).toHaveBeenCalledWith("send", { to: "root", message: "hello" }, undefined);
	});

	it("bounds adapter results before adding wire details", async () => {
		const tool = makeCommunicateTool({
			communicate: vi.fn(async () => ({
				requestId: "q",
				result: [{ id: "x", selected: [], custom: "x".repeat(50000) }],
			})),
		});
		await expect(
			tool.execute("call", { action: "escalate", requestId: "q" }, undefined, undefined, {} as any),
		).rejects.toThrow("byte limit");
	});
});
