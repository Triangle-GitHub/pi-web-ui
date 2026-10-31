import { describe, expect, it } from "vitest";
import {
	describeLookupResult,
	executableLookupTarget,
	patchExecutableLookupSource,
	shouldPatchExecutableLookup,
	SENTINEL,
} from "../../server/patch-executable-lookup.js";

/* Trimmed to the shape the patch anchors on, copied from @earendil-works/pi-coding-agent 1.4.0. */
const SHELL_SOURCE = `function shellPathExists(path) {
    try {
        accessSync(path, constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
function findExecutableOnPath(executable) {
    if (process.platform === "win32") {
        return null;
    }
    // Unix: Use 'which' and trust its output (handles Termux and special filesystems)
    try {
        const result = spawnSync("which", [executable], { encoding: "utf-8", timeout: 5000 });
        if (result.status === 0 && result.stdout) {
            const firstMatch = result.stdout.trim().split(/\\r?\\n/)[0];
            if (firstMatch) {
                return firstMatch;
            }
        }
    }
    catch {
        // Ignore errors
    }
    return null;
}`;

const TOOLS_SOURCE = `import { join } from "path";
import { platform } from "os";
function commandExists(cmd) {
    try {
        const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
        // Check for ENOENT error (command not found)
        return result.error === undefined || result.error === null;
    }
    catch {
        return false;
    }
}`;

describe("fork-free executable lookup patch", () => {
	it("replaces the POSIX `which` child process with a PATH scan", () => {
		const result = patchExecutableLookupSource(SHELL_SOURCE, "shell");
		expect(result.status).toBe("patched");
		expect(result.code).not.toContain('spawnSync("which"');
		expect(result.code).toContain('for (const directory of (process.env.PATH ?? "").split(delimiter))');
		expect(result.code).toContain(SENTINEL);
		// untouched: the Windows branch and the helper the replacement relies on
		expect(result.code).toContain('if (process.platform === "win32")');
		expect(result.code).toContain("function shellPathExists(path)");
	});

	it("replaces the `--version` probe and keeps working for win32 and POSIX PATH separators", () => {
		const result = patchExecutableLookupSource(TOOLS_SOURCE, "tools-manager");
		expect(result.status).toBe("patched");
		expect(result.code).not.toContain('spawnSync(cmd, ["--version"]');

		// Imports are module-scope only; the injected parameters stand in for them.
		const body = result.code.replace(/^import .*$/gm, "");
		const commandExists = new Function(
			"existsSync",
			"platform",
			"join",
			"process",
			`${body}; return commandExists;`,
		) as (
			existsSync: (path: string) => boolean,
			platform: () => string,
			join: (...parts: string[]) => string,
			process: { env: Record<string, string | undefined> },
		) => (cmd: string) => boolean;

		const posix = commandExists(
			() => true,
			() => "android",
			(...parts) => parts.join("/"),
			{
				env: { PATH: "/usr/bin:/data/bin" },
			},
		);
		expect(posix("rg")).toBe(true);

		const missing = commandExists(
			() => false,
			() => "linux",
			(...parts) => parts.join("/"),
			{
				env: { PATH: "/usr/bin" },
			},
		);
		expect(missing("rg")).toBe(false);

		const win = commandExists(
			(path) => path.endsWith("rg.exe"),
			() => "win32",
			(...parts) => parts.join("\\"),
			{
				env: { PATH: "C:\\bin" },
			},
		);
		expect(win("rg")).toBe(true);
	});

	it("never applies twice, and refuses to touch an unrecognized source", () => {
		const once = patchExecutableLookupSource(SHELL_SOURCE, "shell");
		const twice = patchExecutableLookupSource(once.code, "shell");
		expect(twice.status).toBe("already");
		expect(twice.code).toBe(once.code);

		const unknown = patchExecutableLookupSource("function findExecutableOnPath() { return null; }", "shell");
		expect(unknown).toMatchObject({ status: "unsupported" });
		expect(unknown.code).toBe("function findExecutableOnPath() { return null; }");

		const moved = patchExecutableLookupSource(SHELL_SOURCE.replace("which", "whichx"), "shell");
		expect(moved.status).toBe("unsupported");
	});

	it("matches the loaded URL of either SDK copy but nothing else", () => {
		expect(
			executableLookupTarget(
				"file:///data/data/com.termux/files/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/utils/shell.js",
			),
		).toBe("shell");
		expect(
			executableLookupTarget("file:///app/node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js"),
		).toBe("tools-manager");
		expect(executableLookupTarget("file:///app/dist/utils/tools-manager.js")).toBeNull();
		expect(
			executableLookupTarget("file:///app/node_modules/@earendil-works/pi-coding-agent/dist/utils/child-process.js"),
		).toBeNull();
	});

	it("states its verdict on every load, so a restart shows whether the patch is in place", () => {
		const url = "file:///x/@earendil-works/pi-coding-agent/dist/utils/shell.js";
		expect(describeLookupResult("shell", "patched", url)).toEqual({
			level: "log",
			message: "[executable-lookup] shell: patched",
		});
		expect(describeLookupResult("tools-manager", "already", url)).toEqual({
			level: "log",
			message: "[executable-lookup] tools-manager: already patched",
		});
		const unsupported = describeLookupResult("shell", "unsupported", url);
		expect(unsupported.level).toBe("warn");
		expect(unsupported.message).toContain("[executable-lookup] shell: NOT patched");
		expect(unsupported.message).toContain("can hang on Android/Termux");
	});

	it("is enabled on Android/Termux only, unless explicitly forced", () => {
		expect(shouldPatchExecutableLookup("android", {})).toBe(true);
		expect(shouldPatchExecutableLookup("linux", { TERMUX_VERSION: "0.118" })).toBe(true);
		expect(shouldPatchExecutableLookup("linux", {})).toBe(false);
		expect(shouldPatchExecutableLookup("darwin", {})).toBe(false);
		expect(shouldPatchExecutableLookup("android", { PI_WEB_EXEC_LOOKUP: "off" })).toBe(false);
		expect(shouldPatchExecutableLookup("android", { PI_WEB_EXEC_LOOKUP: "0" })).toBe(false);
		expect(shouldPatchExecutableLookup("linux", { PI_WEB_EXEC_LOOKUP: "on" })).toBe(true);
		expect(shouldPatchExecutableLookup("win32", { PI_WEB_EXEC_LOOKUP: "true" })).toBe(true);
	});
});
