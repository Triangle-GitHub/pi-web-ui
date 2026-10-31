import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
	spawn: vi.fn(),
	rm: vi.fn(),
	exists: vi.fn(),
	payload: null as any,
	media: {} as any,
	child: null as any,
}));
vi.mock("node:child_process", () => ({ spawn: mock.spawn }));
vi.mock("node:fs", () => ({ existsSync: mock.exists }));
vi.mock("node:fs/promises", () => ({ mkdtemp: vi.fn(async () => "/tmp/unique-evidence"), rm: mock.rm }));
import { readVideoContent } from "../../plugins/bili-scroll/lib/video-content.mjs";

const bvid = "BV1234567890";
function options(extra: Record<string, any> = {}) {
	return {
		api: {
			getVideoSubtitle: vi.fn(async () => ({ ok: true, source: "description", fullText: "fake description" })),
			cred: { getCookieString: () => "SESSDATA=secret" },
		},
		host: {},
		storageDir: "/storage",
		bvid,
		...extra,
	};
}
beforeEach(() => {
	vi.clearAllMocks();
	mock.exists.mockReturnValue(true);
	mock.media = { durationSeconds: 60, frames: [{ seconds: 15, text: "screen text" }], transcript: "actual speech" };
	mock.spawn.mockImplementation(() => {
		const child = new EventEmitter() as any;
		child.stdout = new EventEmitter() as any;
		child.stdout.setEncoding = vi.fn();
		child.stderr = { resume: vi.fn() };
		child.stdin = new EventEmitter() as any;
		child.stdin.end = (payload: string) => {
			mock.payload = JSON.parse(payload);
			queueMicrotask(() => {
				child.stdout.emit("data", JSON.stringify(mock.media));
				child.emit("close", 0);
			});
		};
		child.kill = vi.fn(() => {
			queueMicrotask(() => child.emit("close", null));
		});
		mock.child = child;
		return child;
	});
});

describe("bili actual video content evidence", () => {
	it("excludes descriptions, enables ASR by default and labels OCR honestly", async () => {
		const result = await readVideoContent(options({ settings: { asrModel: "tiny" } }));
		expect(result.ok).toBe(true);
		expect(result.fullText).toContain("actual speech");
		expect(result.fullText).not.toContain("fake description");
		expect(result.coverage).toMatchObject({ speech: "local_whisper_asr", visual: "sampled_frame_ocr", vision: false });
		expect(mock.payload).toMatchObject({ transcribe: true, model: "tiny", cookie: "SESSDATA=secret" });
		expect(JSON.stringify(mock.spawn.mock.calls)).not.toContain("secret");
		expect(mock.rm).toHaveBeenCalledWith("/tmp/unique-evidence", expect.objectContaining({ recursive: true }));
	});
	it("bounds unicode evidence bytes and retains distributed excerpts without duplication", async () => {
		mock.media.transcript = "开".repeat(15000) + "中".repeat(15000) + "终".repeat(15000);
		const result = await readVideoContent(options());
		expect(result.fullText.length).toBeLessThanOrEqual(10000);
		expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64000);
		expect(result.fullText).toContain("middle sample");
		expect(result.evidence.every((item: any) => !("text" in item))).toBe(true);
	});
	it("uses actual subtitle tracks and skips unnecessary transcription", async () => {
		const result = await readVideoContent(
			options({
				api: {
					getVideoSubtitle: async () => ({
						ok: true,
						source: "subtitle_track",
						hasSubtitle: true,
						fullText: "real subtitle",
					}),
				},
			}),
		);
		expect(result.coverage.speech).toBe("subtitle_track");
		expect(mock.payload.transcribe).toBe(false);
		expect(result.fullText).not.toContain("actual speech");
	});
	it("does not turn summaries or disabled ASR into speech evidence", async () => {
		mock.media = { frames: [], transcript: "should be ignored" };
		const result = await readVideoContent(
			options({
				settings: { transcribe: false },
				api: {
					getVideoSubtitle: async () => ({
						ok: true,
						source: "ai_conclusion",
						hasSubtitle: false,
						fullText: "summary",
					}),
				},
			}),
		);
		expect(result.ok).toBe(false);
		expect(result.source).toBe("none");
		expect(mock.payload.transcribe).toBe(false);
	});
	it("requires explicit image support and successful vision response", async () => {
		mock.media.frames[0].image = "anBlZw==";
		const complete = vi.fn(async () => ({ ok: true, text: "A person points at a chart." }));
		const result = await readVideoContent(
			options({ host: { llm: { supportsImages: true, complete } }, settings: { visionModel: "p/vision" } }),
		);
		expect(complete).toHaveBeenCalledWith(
			expect.objectContaining({ model: "p/vision", images: [{ data: "anBlZw==", mimeType: "image/jpeg" }] }),
		);
		expect(result.coverage).toMatchObject({ vision: true, visual: "sampled_frame_vision" });
		expect(result.evidence.some((e: any) => e.kind === "frame_vision")).toBe(true);
	});
	it("keeps OCR coverage when the vision model rejects images", async () => {
		mock.media.frames[0].image = "anBlZw==";
		const result = await readVideoContent(
			options({ host: { llm: { supportsImages: true, complete: async () => ({ ok: false, error: "unsupported" }) } } }),
		);
		expect(result.coverage.vision).toBe(false);
		expect(result.coverage.visual).toBe("sampled_frame_ocr");
	});
	it("keeps subtitle evidence when Python is unavailable", async () => {
		mock.exists.mockReturnValue(false);
		const result = await readVideoContent(
			options({
				api: {
					getVideoSubtitle: async () => ({
						ok: true,
						source: "subtitle_track",
						hasSubtitle: true,
						fullText: "real subtitle",
					}),
				},
			}),
		);
		expect(result.ok).toBe(true);
		expect(result.limitations).toContain("media_python_unavailable");
	});
	it("rejects invalid ids and pre-cancelled requests before spawning", async () => {
		expect((await readVideoContent(options({ bvid: "bad" }))).ok).toBe(false);
		const controller = new AbortController();
		controller.abort();
		expect((await readVideoContent(options({ signal: controller.signal }))).limitations).toContain("cancelled");
		expect(mock.spawn).not.toHaveBeenCalled();
	});
	it("kills the media process on cancellation and cleans its directory", async () => {
		const controller = new AbortController();
		mock.spawn.mockImplementationOnce(() => {
			const child = new EventEmitter() as any;
			child.stdout = new EventEmitter() as any;
			child.stdout.setEncoding = vi.fn();
			child.stderr = { resume: vi.fn() };
			child.stdin = new EventEmitter() as any;
			child.stdin.end = () => queueMicrotask(() => controller.abort());
			child.kill = vi.fn(() => queueMicrotask(() => child.emit("close", null)));
			mock.child = child;
			return child;
		});
		const result = await readVideoContent(options({ signal: controller.signal }));
		expect(mock.child.kill).toHaveBeenCalledWith("SIGKILL");
		expect(result.limitations).toContain("cancelled");
		expect(mock.rm).toHaveBeenCalled();
	});
});
