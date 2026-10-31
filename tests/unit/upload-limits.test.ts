import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilesService } from "../../server/files-service.js";
import * as remoteSsh from "../../server/remote-ssh-service.js";
import { SettingsService, type SettingsHost } from "../../server/settings-service.js";
import type { ServerMessage } from "../../server/protocol.js";
import { ClientStateStore } from "../../server/client-state.js";
import { normalizeUploadMaxMb, uploadLimitBytes } from "../../server/payload-limits.js";

const dirs: string[] = [];
function stateFile() {
	const dir = mkdtempSync(join(tmpdir(), "pi-upload-limits-"));
	dirs.push(dir);
	return join(dir, "client-state.json");
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const defaults = { chatUploadMaxMb: 20, workspaceUploadMaxMb: 100, folderUploadMaxMb: 32 };

describe("upload limit normalization", () => {
	it.each([
		[1, 1],
		[100, 100],
		[42, 42],
		[19.99, 19],
		[100.9, 100],
		[0, 1],
		[-10, 1],
		[0.9, 1],
		[101, 100],
		[Number.MAX_VALUE, 100],
	])("normalizes %s to integer %s MB", (input, expected) => {
		expect(normalizeUploadMaxMb(input, 32)).toBe(expected);
	});
	it.each([undefined, null, NaN, Infinity, -Infinity, "50", "", true, {}, []])(
		"uses the supplied fallback for invalid input %j",
		(input) => {
			for (const fallback of [20, 100, 32]) expect(normalizeUploadMaxMb(input, fallback)).toBe(fallback);
		},
	);
	it.each(["chat", "workspace", "folder"] as const)("uses the %s default and converts MB to bytes", (kind) => {
		expect(uploadLimitBytes({}, kind)).toBe(defaults[`${kind}UploadMaxMb`] * 1024 * 1024);
	});
	it.each([
		[{ chatUploadMaxMb: 7.9, workspaceUploadMaxMb: 48, folderUploadMaxMb: 99 }, [7, 48, 99]],
		[{ chatUploadMaxMb: -1, workspaceUploadMaxMb: 101, folderUploadMaxMb: NaN }, [1, 100, 32]],
	])("applies each category's own normalized cap", (settings, expected) => {
		for (const [index, kind] of (["chat", "workspace", "folder"] as const).entries()) {
			expect(uploadLimitBytes(settings, kind)).toBe(expected[index] * 1024 * 1024);
		}
	});
});

describe("upload settings exposed to clients", () => {
	it.each([{}, { chatUploadMaxMb: 3, workspaceUploadMaxMb: 17, folderUploadMaxMb: 81 }])(
		"includes all three limits in settings_state",
		(settings) => {
			const store = new ClientStateStore(stateFile());
			store.saveSettings("client", settings);
			const seen: ServerMessage[] = [];
			const svc = new SettingsService(
				{
					clientId: "client",
					isDisposed: () => false,
					stateStore: store,
					emit: (m: ServerMessage) => {
						seen.push(m);
					},
					getSession: () => {
						throw new Error("Session not initialized");
					},
					cwd: () => dirs.at(-1)!,
					agentDir: () => dirs.at(-1)!,
					flushSnapshot: () => {},
					promptSnapshot: () => ({ full: "", texts: {}, toolsSchema: "" }),
				} as unknown as SettingsHost,
				{ list: () => [] } as any,
			);
			svc.push();
			const states = seen.filter((m) => m.type === "settings_state");
			expect(states).toHaveLength(1);
			expect(states[0].settings).toMatchObject({ ...defaults, ...settings });
		},
	);
});

describe("workspace upload results", () => {
	it.each([false, true])("correlates local/remote upload outcomes (remote: %s)", async (remote) => {
		const path = stateFile();
		const root = join(path, "..");
		const cwd = remote ? "ssh://tester@example.test/work" : root;
		const ssh = {
			sftpStat: vi.fn().mockResolvedValue(null),
			sftpWriteFile: vi.fn().mockResolvedValue(undefined),
			execInWorkspace: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
		};
		vi.spyOn(remoteSsh, "getGlobalRemoteSshService").mockReturnValue(ssh as any);
		const seen: ServerMessage[] = [];
		const svc = new FilesService({
			emit: (m) => {
				seen.push(m);
			},
			isDisposed: () => false,
			getCwd: () => cwd,
			getActiveCwd: () => cwd,
			getUploadMaxBytes: () => 4,
		});
		const results = () => seen.filter((m) => m.type === "file_upload_result");
		const encode = (value: string) => Buffer.from(value).toString("base64");
		await svc.uploadFile("", "ok.txt", encode("four"), "success");
		expect(results()).toEqual([{ type: "file_upload_result", uploadId: "success", ok: true }]);
		if (remote) expect(ssh.sftpWriteFile.mock.calls[0][2]).toEqual(Buffer.from("four"));
		else expect(readFileSync(join(root, "ok.txt"), "utf8")).toBe("four");
		for (const [name, data] of [
			["too-large.txt", encode("12345")],
			["empty.txt", ""],
		]) {
			seen.length = 0;
			await svc.uploadFile("", name, data, name);
			expect(results()).toEqual([{ type: "file_upload_result", uploadId: name, ok: false, error: expect.any(String) }]);
			if (!remote) expect(() => readFileSync(join(root, name))).toThrow();
		}
		seen.length = 0;
		if (remote) ssh.sftpWriteFile.mockRejectedValueOnce(new Error("disk full"));
		else writeFileSync(join(root, "blocked"), "not a directory");
		await svc.uploadFile(remote ? "" : "blocked", "write.txt", encode("four"), "write-failure");
		expect(results()).toEqual([
			{ type: "file_upload_result", uploadId: "write-failure", ok: false, error: expect.any(String) },
		]);
		seen.length = 0;
		await svc.uploadFile("", "legacy.txt", encode("four"));
		await svc.uploadFile("", "legacy-invalid.txt", encode("12345"));
		expect(results()).toEqual([]);
	});
});

describe("durable upload settings", () => {
	it("defaults missing settings, including older persisted state", () => {
		const path = stateFile();
		expect(new ClientStateStore(path).getSettingsSnapshot("first")).toMatchObject(defaults);
		writeFileSync(path, JSON.stringify({ __settings__: { projects: [], settings: { thinkingWrap: true } } }));
		expect(new ClientStateStore(path).getSettingsSnapshot("second")).toMatchObject({ ...defaults, thinkingWrap: true });
	});
	it.each([
		[
			{ chatUploadMaxMb: 7.9, workspaceUploadMaxMb: 0, folderUploadMaxMb: 200 },
			{ chatUploadMaxMb: 7, workspaceUploadMaxMb: 1, folderUploadMaxMb: 100 },
		],
		[{ chatUploadMaxMb: NaN, workspaceUploadMaxMb: Infinity, folderUploadMaxMb: -Infinity }, defaults],
	])("normalizes before writing and retains values across clients and restarts", (input, expected) => {
		const path = stateFile();
		const store = new ClientStateStore(path);
		expect(store.saveSettings("first", input)).toMatchObject(expected);
		expect(JSON.parse(readFileSync(path, "utf8")).__settings__.settings).toMatchObject(expected);
		expect(store.getSettingsSnapshot("another-tab")).toMatchObject(expected);
		expect(new ClientStateStore(path).getSettingsSnapshot("after-restart")).toMatchObject(expected);
	});
	it("normalizes malformed values read from disk", () => {
		const path = stateFile();
		writeFileSync(
			path,
			JSON.stringify({
				__settings__: {
					projects: [],
					settings: {
						chatUploadMaxMb: "80",
						workspaceUploadMaxMb: 0.5,
						folderUploadMaxMb: 101.9,
					},
				},
			}),
		);
		expect(new ClientStateStore(path).getSettingsSnapshot("client")).toMatchObject({
			chatUploadMaxMb: 20,
			workspaceUploadMaxMb: 1,
			folderUploadMaxMb: 100,
		});
	});
	it("merges partial updates without resetting other caps or unrelated settings", () => {
		const path = stateFile();
		const store = new ClientStateStore(path);
		store.saveSettings("first", {
			chatUploadMaxMb: 12,
			workspaceUploadMaxMb: 34,
			folderUploadMaxMb: 56,
			thinkingWrap: true,
		});
		store.saveSettings("second", { folderUploadMaxMb: 9.8 });
		store.saveSettings("first", { toolsWrap: false });
		const expected = {
			chatUploadMaxMb: 12,
			workspaceUploadMaxMb: 34,
			folderUploadMaxMb: 9,
			thinkingWrap: true,
			toolsWrap: false,
		};
		expect(store.getSettingsSnapshot("first")).toMatchObject(expected);
		expect(JSON.parse(readFileSync(path, "utf8")).__settings__.settings).toMatchObject(expected);
		expect(new ClientStateStore(path).getSettingsSnapshot("third")).toMatchObject(expected);
	});
});
