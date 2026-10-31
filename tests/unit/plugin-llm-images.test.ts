import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ runtime: vi.fn(), services: vi.fn(), create: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	ModelRuntime: { create: sdk.runtime },
	createAgentSessionServices: sdk.services,
	createAgentSessionFromServices: sdk.create,
	SessionManager: { inMemory: vi.fn() },
}));
import { completeWithIsolatedSession, llmInflight } from "../../server/plugin-llm.js";

const env = { cwd: ".", agentDir: "." };
function image(mimeType = "image/png", size = 8) {
	const bytes = Buffer.alloc(size);
	const signature =
		mimeType === "image/png"
			? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
			: mimeType === "image/jpeg"
				? Buffer.from([255, 216, 255])
				: Buffer.from("RIFF0000WEBP");
	signature.copy(bytes);
	return { mimeType, data: bytes.toString("base64") };
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
let session: {
	model: { input: string[] };
	prompt: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	getLastAssistantText: () => string;
	getSessionStats: () => unknown;
};
beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	session = {
		model: { input: ["text", "image"] },
		prompt: vi.fn().mockResolvedValue(undefined),
		abort: vi.fn().mockResolvedValue(undefined),
		dispose: vi.fn(),
		getLastAssistantText: () => "seen",
		getSessionStats: () => ({ tokens: { input: 12, output: 4 } }),
	};
	sdk.runtime.mockResolvedValue({});
	sdk.services.mockResolvedValue({ modelRuntime: { getModel: () => session.model } });
	sdk.create.mockImplementation(async () => ({ session }));
});
afterEach(() => {
	vi.useRealTimers();
});

describe("bounded image inputs", () => {
	it.each(["image/png", "image/jpeg", "image/webp"])("forwards %s as SDK ImageContent", async (mime) => {
		const input = image(mime, 16);
		expect(await completeWithIsolatedSession(env, { prompt: "describe", images: [input] })).toMatchObject({
			ok: true,
			text: "seen",
		});
		expect(session.prompt).toHaveBeenCalledWith("describe", {
			expandPromptTemplates: false,
			images: [{ type: "image", ...input }],
		});
		expect(session.dispose).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
	it.each([
		null,
		{},
		new Array(1),
		[
			{
				mimeType: "image/webp",
				data: Buffer.from([210, 201, 198, 198, 0, 0, 0, 0, 215, 197, 194, 208]).toString("base64"),
			},
		],
		Array(9).fill(image()),
		[{ data: "%%%", mimeType: "image/png" }],
		[{ data: "data:image/png;base64,AAAA", mimeType: "image/png" }],
		[{ data: "AB==", mimeType: "image/png" }],
		[{ data: "", mimeType: "image/png" }],
		[{ ...image(), mimeType: "image/jpeg" }],
		[{ ...image(), mimeType: "image/gif" }],
		[image("image/png", 1048577)],
		Array(7).fill(image("image/png", 1048576)),
	])("rejects malformed or over-budget images before creating SDK resources (%#)", async (images) => {
		expect(await completeWithIsolatedSession(env, { prompt: "describe", images: images as any })).toMatchObject({
			ok: false,
		});
		expect(sdk.runtime).not.toHaveBeenCalled();
		expect(llmInflight()).toBe(0);
	});
	it("accepts the exact decoded total and count limits", async () => {
		const images = [...Array(4).fill(image("image/png", 1048576)), ...Array(4).fill(image("image/png", 524288))];
		expect(await completeWithIsolatedSession(env, { prompt: "describe", images })).toMatchObject({ ok: true });
		expect(session.prompt.mock.calls[0][1].images).toHaveLength(8);
	});
	it("rejects a nonvision default model explicitly without prompting", async () => {
		session.model.input = ["text"];
		expect(await completeWithIsolatedSession(env, { prompt: "describe", images: [image()] })).toMatchObject({
			ok: false,
			error: expect.stringContaining("does not support image"),
		});
		expect(session.prompt).not.toHaveBeenCalled();
		expect(session.dispose).toHaveBeenCalledOnce();
	});
	it("keeps text-only calls compatible and cleans up SDK errors", async () => {
		session.model.input = ["text"];
		session.prompt.mockRejectedValue(new Error("provider failed"));
		expect(await completeWithIsolatedSession(env, { prompt: "hi" })).toMatchObject({
			ok: false,
			error: expect.stringContaining("provider failed"),
		});
		expect(session.prompt).toHaveBeenCalledWith("hi", { expandPromptTemplates: false });
		expect(session.dispose).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("cancellation lifecycle", () => {
	it("does not start SDK work for a pre-aborted request", async () => {
		expect(await completeWithIsolatedSession(env, { prompt: "hi", signal: AbortSignal.abort() })).toMatchObject({
			ok: false,
			error: expect.stringContaining("cancelled"),
		});
		expect(sdk.runtime).not.toHaveBeenCalled();
	});
	it.each(["signal", "timeout"])(
		"aborts/disposes a running prompt on %s and holds its concurrency slot until settled",
		async (kind) => {
			const pending = deferred<void>();
			const started = deferred<void>();
			session.prompt.mockImplementation(() => {
				started.resolve();
				return pending.promise;
			});
			const controller = new AbortController();
			const result = completeWithIsolatedSession(env, { prompt: "hi", signal: controller.signal, timeoutMs: 5000 });
			await started.promise;
			if (kind === "signal") controller.abort();
			else await vi.advanceTimersByTimeAsync(5000);
			expect(await result).toMatchObject({ ok: false });
			expect(session.abort).toHaveBeenCalledOnce();
			expect(session.dispose).toHaveBeenCalledOnce();
			expect(llmInflight()).toBe(1);
			expect(vi.getTimerCount()).toBe(0);
			pending.resolve();
			await vi.waitFor(() => expect(llmInflight()).toBe(0));
			expect(session.dispose).toHaveBeenCalledOnce();
		},
	);
	it("disposes a session that arrives after cancellation without prompting", async () => {
		const pending = deferred<{ session: typeof session }>();
		const started = deferred<void>();
		sdk.create.mockImplementation(() => {
			started.resolve();
			return pending.promise;
		});
		const controller = new AbortController();
		const result = completeWithIsolatedSession(env, { prompt: "hi", signal: controller.signal });
		await started.promise;
		controller.abort();
		expect(await result).toMatchObject({ ok: false });
		pending.resolve({ session });
		await vi.waitFor(() => expect(llmInflight()).toBe(0));
		expect(session.prompt).not.toHaveBeenCalled();
		expect(session.dispose).toHaveBeenCalledOnce();
	});
});
