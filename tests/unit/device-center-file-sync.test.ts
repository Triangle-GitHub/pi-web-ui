import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, lstat, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
	createDeviceFileSync,
	DEVICE_FILE_SYNC_LIMITS,
	type DeviceFileBundle,
} from "../../server/device-center/file-sync.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "device-sync-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const root = join(dir, "project");
	const dataDir = join(dir, "data");
	await mkdir(root);
	const sync = createDeviceFileSync({ root, dataDir, allowReceive: true });
	cleanup.push(() => sync.close());
	return { dir, root, dataDir, sync };
}
function bundle(path = "new.txt", content: string | Buffer = "hello"): DeviceFileBundle {
	const bytes = Buffer.from(content);
	return {
		manifest: {
			version: 1,
			totalBytes: bytes.length,
			files: [{ path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }],
		},
		files: [{ path, base64: bytes.toString("base64") }],
	};
}
function combine(...bundles: DeviceFileBundle[]): DeviceFileBundle {
	return {
		manifest: {
			version: 1,
			totalBytes: bundles.reduce((n, b) => n + b.manifest.totalBytes, 0),
			files: bundles.flatMap((b) => b.manifest.files),
		},
		files: bundles.flatMap((b) => b.files),
	};
}

describe("device file sync", () => {
	it("requires explicit recursion, sorts files, reports pruned sensitive and ignored entries", async () => {
		const { root, sync, dataDir } = await fixture();
		await mkdir(join(root, "project", "nested"), { recursive: true });
		await mkdir(join(root, "project", ".git"));
		await mkdir(join(root, "project", "node_modules"));
		for (const path of ["z.txt", "a.txt", "nested/文件.bin", ".envlocal", "credentials.json", "private.pem"])
			await writeFile(join(root, "project", path), path);
		await expect(sync.prepare({ paths: ["project"] })).rejects.toThrow(/recursive/);
		const result = await sync.prepare({ paths: ["project"], recursive: true });
		expect(result.manifest.files.map((f) => f.path)).toEqual([
			"project/a.txt",
			"project/nested/文件.bin",
			"project/z.txt",
		]);
		expect(result.manifest.totalExcluded).toBe(5);
		expect(result.manifest.exclusions).toEqual([
			{ path: "project/.envlocal", reason: "sensitive" },
			{ path: "project/.git", reason: "ignored" },
			{ path: "project/credentials.json", reason: "sensitive" },
			{ path: "project/node_modules", reason: "ignored" },
			{ path: "project/private.pem", reason: "sensitive" },
		]);
		await expect(sync.prepare({ paths: ["project/.envlocal"], recursive: true })).rejects.toThrow(/Sensitive/);
		await expect(sync.prepare({ paths: ["project", "project/a.txt"], recursive: true })).rejects.toThrow(/overlapping/);
		const preview = await sync.stage(result);
		const stagedDir = (await readdir(join(dataDir, "device-transfers")))[0];
		expect(
			JSON.parse(await readFile(join(dataDir, "device-transfers", stagedDir, "bundle.json"), "utf8")).manifest,
		).toEqual(result.manifest);
		await sync.cancel(preview.id);
	});
	it("bounds exclusion summaries by count and UTF-8 bytes while counting all pruned entries", async () => {
		const { root, sync } = await fixture();
		await mkdir(join(root, "tree"));
		await writeFile(join(root, "tree", "ok"), "ok");
		for (let i = 0; i < 140; i++)
			await writeFile(join(root, "tree", `.env${String(i).padStart(3, "0")}${"密".repeat(50)}`), "secret");
		const { manifest } = await sync.prepare({ paths: ["tree"], recursive: true });
		expect(manifest.totalExcluded).toBe(140);
		expect(manifest.exclusions!.length).toBeLessThanOrEqual(128);
		expect(Buffer.byteLength(JSON.stringify(manifest.exclusions))).toBeLessThanOrEqual(8192);
		expect(manifest.exclusions!.length).toBeLessThan(140);
		const malformed = structuredClone(bundle());
		malformed.manifest.exclusions = [{ path: "../secret", reason: "sensitive" }];
		malformed.manifest.totalExcluded = 1;
		await expect(sync.stage(malformed)).rejects.toThrow(/Unsafe/);
	});
	it("rejects recursive directory symlinks or Windows junctions, including ignored names", async () => {
		const { root, dir, sync } = await fixture();
		await mkdir(join(root, "tree"));
		await mkdir(join(dir, "outside"));
		await symlink(join(dir, "outside"), join(root, "tree", ".git"), process.platform === "win32" ? "junction" : "dir");
		await expect(sync.prepare({ paths: ["tree"], recursive: true })).rejects.toThrow(/Symlink/);
	});
	it("enforces incremental file and visited-entry limits and permits no partial bundle", async () => {
		const { root, sync } = await fixture();
		await mkdir(join(root, "tree"));
		for (let i = 0; i <= DEVICE_FILE_SYNC_LIMITS.files; i++) await writeFile(join(root, "tree", `f${i}`), "");
		await expect(sync.prepare({ paths: ["tree"], recursive: true })).rejects.toThrow(/file count budget/);
		await rm(join(root, "tree"), { recursive: true });
		await mkdir(join(root, "tree"));
		for (let i = 0; i < DEVICE_FILE_SYNC_LIMITS.visitedEntries; i++) await mkdir(join(root, "tree", `d${i}`));
		await expect(sync.prepare({ paths: ["tree"], recursive: true })).rejects.toThrow(/entry budget/);
	}, 30000);
	it("checks cumulative recursive bytes before reading the next file", async () => {
		const { root, sync } = await fixture();
		await mkdir(join(root, "tree"));
		await writeFile(join(root, "tree", "a"), Buffer.alloc(DEVICE_FILE_SYNC_LIMITS.bytes));
		await writeFile(join(root, "tree", "b"), "x");
		await expect(sync.prepare({ paths: ["tree"], recursive: true })).rejects.toThrow(/budget/);
	});
	it("rejects case-folded selections and discovered duplicate file names", async () => {
		const { root, sync } = await fixture();
		await mkdir(join(root, "tree"));
		await writeFile(join(root, "tree", "a"), "a");
		await expect(sync.prepare({ paths: ["tree/a", "TREE/A"], recursive: true })).rejects.toThrow(/Duplicate/);
		await writeFile(join(root, "tree", "A"), "A");
		if ((await readdir(join(root, "tree"))).length === 2)
			await expect(sync.prepare({ paths: ["tree"], recursive: true })).rejects.toThrow(/Duplicate/);
	});
	it("cancels during asynchronous recursive scanning and rejects empty directories", async () => {
		const { root, sync } = await fixture();
		await mkdir(join(root, "tree"));
		await expect(sync.prepare({ paths: ["tree"], recursive: true })).rejects.toThrow(/no transferable/);
		await writeFile(join(root, "tree", "file"), "hello");
		const controller = new AbortController();
		const pending = sync.prepare({ paths: ["tree"], recursive: true, signal: controller.signal });
		setImmediate(() => controller.abort());
		await expect(pending).rejects.toThrow(/cancelled|aborted/);
		await expect(sync.prepare({ paths: ["tree"], recursive: true })).resolves.toMatchObject({
			manifest: { totalBytes: 5 },
		});
	});
	it("prepares explicit UTF-8 paths and binary content, stages privately, then exclusively creates", async () => {
		const { root, dataDir, sync } = await fixture();
		const bytes = Buffer.from([0, 255, 128, 10]);
		await writeFile(join(root, "源.bin"), bytes);
		const prepared = await sync.prepare({ paths: ["源.bin"] });
		expect(prepared).toEqual(bundle("源.bin", bytes));
		const p = await sync.stage(bundle("nested/文件.bin", bytes));
		expect(p.files[0]).toMatchObject({ baseline: null, status: "create" });
		await expect(lstat(join(root, "nested"))).rejects.toThrow();
		const dirs = await readdir(join(dataDir, "device-transfers"));
		expect(dirs).toHaveLength(1);
		const saved = join(dataDir, "device-transfers", dirs[0], "bundle.json");
		expect(JSON.parse(await readFile(saved, "utf8"))).toEqual(bundle("nested/文件.bin", bytes));
		if (process.platform !== "win32") expect((await stat(saved)).mode & 0o777).toBe(0o600);
		const report = await sync.apply(p);
		expect(report).toEqual({ id: p.id, applied: ["nested/文件.bin"], unchanged: [], rejected: [] });
		expect(await readFile(join(root, "nested", "文件.bin"))).toEqual(bytes);
		expect(await readdir(join(dataDir, "device-transfers"))).toEqual([]);
	});

	it.each([
		"../escape",
		"/absolute",
		"C:/escape",
		"C:escape",
		"//server/share",
		"a\\..\\escape",
		"a/../b",
		"a//b",
		"a/./b",
		"a\0b",
		"bad\ud800",
		"x/CON.txt",
		"a.",
		"a ",
		"x:ads",
		"e\u0301.txt",
		".git/config",
		"NODE_MODULES/a",
		".env",
		"config/.env.local",
		".ssh/id_ed25519",
		".aws/config",
		"credentials.json",
		"secret.key",
		".npmrc",
	])("rejects unsafe/sensitive path %j on send and receive", async (path) => {
		const { sync } = await fixture();
		await expect(sync.prepare({ paths: [path] })).rejects.toThrow();
		await expect(sync.stage(bundle(path))).rejects.toThrow();
	});

	it("rejects malformed manifest, hashes, duplicates, noncanonical base64 and sizes", async () => {
		const { sync } = await fixture();
		const bad: unknown[] = [
			null,
			{},
			{ manifest: { version: 2 }, files: [] },
			combine(bundle(), bundle()),
			combine(bundle("Case"), bundle("case")),
			combine(bundle("a"), bundle("a/b")),
		];
		const hash = bundle();
		hash.manifest.files[0].sha256 = "0".repeat(64);
		bad.push(hash);
		const size = bundle();
		size.manifest.files[0].size++;
		bad.push(size);
		const total = bundle();
		total.manifest.totalBytes++;
		bad.push(total);
		const path = bundle();
		path.files[0].path = "other";
		bad.push(path);
		const base64 = bundle("a", "f");
		base64.files[0].base64 = "Zh==";
		bad.push(base64);
		for (const input of bad) await expect(sync.stage(input)).rejects.toThrow();
	});

	it("does not recurse directories, accepts no special files, and rejects duplicate sends", async () => {
		const { root, sync } = await fixture();
		await mkdir(join(root, "folder"));
		await writeFile(join(root, "file"), "x");
		await expect(sync.prepare({ paths: ["folder"] })).rejects.toThrow(/recursive/);
		await expect(sync.prepare({ paths: ["file", "file"] })).rejects.toThrow(/Duplicate/);
		await expect(sync.stage(bundle("folder"))).rejects.toThrow(/regular/);
	});

	it("rejects file links, ancestor links, linked roots and storage links", async () => {
		const { dir, root, sync } = await fixture();
		const outside = join(dir, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "x"), "secret");
		await symlink(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
		await expect(sync.prepare({ paths: ["link/x"] })).rejects.toThrow(/Symlink/);
		await expect(sync.stage(bundle("link/new"))).rejects.toThrow(/Symlink/);
		const rooted = createDeviceFileSync({
			root: join(root, "link"),
			dataDir: join(dir, "more-data"),
			allowReceive: true,
		});
		cleanup.push(() => rooted.close());
		await expect(rooted.stage(bundle())).rejects.toThrow(/Symlink/);
		if (process.platform !== "win32") {
			await symlink(join(outside, "x"), join(root, "file-link"));
			await expect(sync.prepare({ paths: ["file-link"] })).rejects.toThrow(/Symlink/);
			await expect(sync.stage(bundle("file-link"))).rejects.toThrow(/Symlink/);
		}
		const dataLink = join(dir, "data-link");
		await symlink(outside, dataLink, process.platform === "win32" ? "junction" : "dir");
		const storage = createDeviceFileSync({ root, dataDir: dataLink, allowReceive: true });
		cleanup.push(() => storage.close());
		await expect(storage.stage(bundle())).rejects.toThrow(/Symlink/);
	});

	it("detects changes after preview and requires refreshed revision plus explicit overwrite", async () => {
		const { root, sync } = await fixture();
		await writeFile(join(root, "existing"), "old");
		const p = await sync.stage(bundle("existing", Buffer.from([255, 0, 1])));
		expect(p.files[0].status).toBe("conflict");
		const denied = await sync.apply(p);
		expect(denied.rejected[0].reason).toMatch(/explicit overwrite/);
		expect(await readFile(join(root, "existing"), "utf8")).toBe("old");
		await writeFile(join(root, "existing"), "changed");
		const changed = await sync.apply({ ...p, decisions: { existing: "overwrite" } });
		expect(changed.rejected[0].reason).toMatch(/Baseline changed/);
		const fresh = await sync.preview(p.id);
		expect(fresh.revision).not.toBe(p.revision);
		await expect(sync.apply(p)).rejects.toThrow(/revision/);
		const applied = await sync.apply({ ...fresh, decisions: { existing: "overwrite" } });
		expect(applied.applied).toEqual(["existing"]);
		expect(await readFile(join(root, "existing"))).toEqual(Buffer.from([255, 0, 1]));
	}, 15000);

	it("preserves existing permissions on replacement", async () => {
		const { root, sync } = await fixture();
		await writeFile(join(root, "existing"), "old");
		if (process.platform !== "win32") await chmod(join(root, "existing"), 0o640);
		const p = await sync.stage(bundle("existing", "new"));
		const result = await sync.apply({ ...p, decisions: { existing: "overwrite" } });
		expect(result.rejected).toEqual([]);
		if (process.platform !== "win32") expect((await stat(join(root, "existing"))).mode & 0o777).toBe(0o640);
	}, 15000);

	it("rejects a newly occupied target and reports partial batches without false success", async () => {
		const { root, sync } = await fixture();
		const p = await sync.stage(combine(bundle("occupied"), bundle("created"), bundle("skipped")));
		await writeFile(join(root, "occupied"), "local");
		const r = await sync.apply({ ...p, decisions: { skipped: "skip", occupied: "overwrite" } });
		expect(r.applied).toEqual(["created"]);
		expect(r.rejected.map((f) => f.path)).toEqual(["occupied", "skipped"]);
		expect(await readFile(join(root, "occupied"), "utf8")).toBe("local");
	});

	it("rechecks ancestor links inserted after stage before writing", async () => {
		const { dir, root, sync } = await fixture();
		const p = await sync.stage(bundle("parent/new"));
		const outside = join(dir, "outside");
		await mkdir(outside);
		await symlink(outside, join(root, "parent"), process.platform === "win32" ? "junction" : "dir");
		const report = await sync.apply(p);
		expect(report.applied).toEqual([]);
		expect(report.rejected[0].reason).toMatch(/Symlink/);
		expect(await readdir(outside)).toEqual([]);
	});

	it("returns unchanged for identical targets and validates decision paths", async () => {
		const { root, sync } = await fixture();
		await writeFile(join(root, "new.txt"), "hello");
		const p = await sync.stage(bundle());
		expect(p.files[0].status).toBe("identical");
		await expect(sync.apply({ ...p, decisions: { missing: "overwrite" } })).rejects.toThrow(/decision/);
		expect((await sync.apply(p)).unchanged).toEqual(["new.txt"]);
	});

	it("enforces file, byte and cumulative staging budgets and releases them on cancel", async () => {
		const { root, dataDir, sync } = await fixture();
		await expect(sync.prepare({ paths: Array(129).fill("x") })).rejects.toThrow(/count/);
		await expect(sync.stage(combine(...Array.from({ length: 129 }, (_, i) => bundle(`f${i}`))))).rejects.toThrow(
			/manifest/,
		);
		const oversized = bundle();
		oversized.manifest.files[0].size = DEVICE_FILE_SYNC_LIMITS.bytes + 1;
		await expect(sync.stage(oversized)).rejects.toThrow(/size/);
		await writeFile(join(root, "huge"), Buffer.alloc(DEVICE_FILE_SYNC_LIMITS.bytes + 1));
		await expect(sync.prepare({ paths: ["huge"] })).rejects.toThrow(/budget/);
		const ids: string[] = [];
		for (let i = 0; i < DEVICE_FILE_SYNC_LIMITS.staged; i++) ids.push((await sync.stage(bundle(`f${i}`, ""))).id);
		await expect(sync.stage(bundle())).rejects.toThrow(/budget/);
		await sync.cancel(ids.pop()!);
		await sync.stage(bundle());
		await sync.close();
		expect(await readdir(join(dataDir, "device-transfers"))).toEqual([]);
		await expect(sync.stage(bundle())).rejects.toThrow(/closed/);
	});

	it("limits cumulative staged bytes and reclaims budget after cancellation", async () => {
		const { sync } = await fixture();
		const large = bundle("large", Buffer.alloc(DEVICE_FILE_SYNC_LIMITS.bytes));
		const ids: string[] = [];
		for (let i = 0; i < 4; i++) ids.push((await sync.stage(large)).id);
		await expect(sync.stage(bundle("extra", "x"))).rejects.toThrow(/budget/);
		await sync.cancel(ids[0]);
		expect((await sync.stage(large)).files[0].size).toBe(DEVICE_FILE_SYNC_LIMITS.bytes);
	}, 15000);

	it("does not treat equal bytes in a replaced inode as an unchanged baseline", async () => {
		const { sync, root } = await fixture();
		await writeFile(join(root, "local"), "old");
		const p = await sync.stage(bundle("local", "new"));
		await rm(join(root, "local"));
		await writeFile(join(root, "local"), "old");
		const report = await sync.apply({ ...p, decisions: { local: "overwrite" } });
		expect(report.applied).toEqual([]);
		expect(report.rejected[0].reason).toMatch(/Baseline changed/);
	});

	it("bounds path depth and bytes", async () => {
		const { sync } = await fixture();
		for (const path of ["a".repeat(256), Array(34).fill("a").join("/"), Array(8).fill("字".repeat(70)).join("/")]) {
			await expect(sync.stage(bundle(path))).rejects.toThrow(/path/i);
		}
	});

	it("supports abort without publishing a transfer, cancel and close cleanup", async () => {
		const { dataDir, root, sync } = await fixture();
		const controller = new AbortController();
		controller.abort();
		await expect(sync.stage(bundle(), { signal: controller.signal })).rejects.toThrow();
		await expect(sync.prepare({ paths: ["new.txt"], signal: controller.signal })).rejects.toThrow();
		const p = await sync.stage(bundle());
		await expect(sync.apply({ ...p, signal: controller.signal })).rejects.toThrow();
		expect(await readdir(root)).toEqual([]);
		await sync.cancel(p.id);
		await expect(sync.preview(p.id)).rejects.toThrow(/Unknown/);
		expect(await readdir(join(dataDir, "device-transfers"))).toEqual([]);
	});

	it("does not allow receive by default policy or data directories in the root", async () => {
		const { root, dir } = await fixture();
		expect(() => createDeviceFileSync({ root, dataDir: join(root, "data"), allowReceive: true })).toThrow(/outside/);
		const sender = createDeviceFileSync({ root, dataDir: join(dir, "send-data"), allowReceive: false });
		cleanup.push(() => sender.close());
		await expect(sender.stage(bundle())).rejects.toThrow(/disabled/);
	});
});
