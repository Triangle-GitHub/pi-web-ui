/**
 * Fork-free executable lookup for Android/Termux.
 *
 * Background: on POSIX the SDK resolves host executables with `spawnSync("which", …)`
 * (`dist/utils/shell.js`) and probes availability with `spawnSync(cmd, ["--version"])`
 * (`dist/utils/tools-manager.js`). On Android/Termux forking a child process can stall
 * before it ever execs, so those probes never return and the first tool call hangs the
 * server instead of failing fast. Both are pure lookups, so this patch answers them from
 * PATH using the SDK's own imports — no child process involved.
 *
 * The SDK sources are transformed in memory before compilation, never on disk (same seam
 * as `server/patch-bash-process.ts`). The patch therefore survives every
 * `npm i -g @earendil-works/pi-coding-agent` and applies to whichever copy
 * `resolve-global-sdk.ts` picks. Drop this module once the SDK resolves executables from
 * PATH itself.
 */
import { registerHooks } from "node:module";

export const SENTINEL = "// pi-web-ui: fork-free executable lookup v1";

export type ExecutableLookupTarget = "shell" | "tools-manager";
export type PatchStatus = "patched" | "already" | "unsupported";

const TARGETS: Record<ExecutableLookupTarget, string> = {
	shell: "/@earendil-works/pi-coding-agent/dist/utils/shell.js",
	"tools-manager": "/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js",
};

/** SDK 1.4.0 shape: `which` child process in the POSIX branch of findExecutableOnPath. */
const SHELL_LOOKUP_OLD = `    // Unix: Use 'which' and trust its output (handles Termux and special filesystems)
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
    }`;

/** SDK 1.4.0 shape: `--version` child process probe in commandExists. */
const TOOLS_LOOKUP_OLD = `function commandExists(cmd) {
    try {
        const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
        // Check for ENOENT error (command not found)
        return result.error === undefined || result.error === null;
    }
    catch {
        return false;
    }
}`;

/* delimiter, join and shellPathExists are already imported/defined in shell.js. */
const SHELL_LOOKUP_NEW = `    // Unix: resolve from PATH directly — a forked \`which\` can stall before exec on
    // Android/Termux, which hung the first tool call instead of failing fast.
    try {
        for (const directory of (process.env.PATH ?? "").split(delimiter)) {
            if (!directory) continue;
            const candidate = join(directory, executable);
            if (shellPathExists(candidate)) {
                return candidate;
            }
        }
    }
    catch {
        // Ignore errors
    }`;

/* existsSync, join and platform are already imported/defined in tools-manager.js. */
const TOOLS_LOOKUP_NEW = `function commandExists(cmd) {
    // Android/Termux: resolve from PATH instead of forking \`cmd --version\` — the fork can
    // stall before exec, so the probe hung instead of answering.
    try {
        const win = platform() === "win32";
        const extensions = win ? [".exe", ".cmd", ".bat", ""] : [""];
        return (process.env.PATH ?? "")
            .split(win ? ";" : ":")
            .some((directory) => !!directory && extensions.some((ext) => existsSync(join(directory, cmd + ext))));
    }
    catch {
        return false;
    }
}`;

/** Which target a loaded module URL belongs to, or null when it is not ours to touch. */
export function executableLookupTarget(url: string): ExecutableLookupTarget | null {
	const normalized = url.replaceAll("\\\\", "/");
	for (const [target, suffix] of Object.entries(TARGETS) as [ExecutableLookupTarget, string][]) {
		if (normalized.endsWith(suffix)) return target;
	}
	return null;
}

export function patchExecutableLookupSource(
	source: string,
	target: ExecutableLookupTarget,
): { code: string; status: PatchStatus } {
	if (source.includes(SENTINEL)) return { code: source, status: "already" };
	const old = target === "shell" ? SHELL_LOOKUP_OLD : TOOLS_LOOKUP_OLD;
	const replacement = target === "shell" ? SHELL_LOOKUP_NEW : TOOLS_LOOKUP_NEW;
	// Exact, single occurrence: a moved or rewritten lookup must fail loudly, never
	// half-apply, because the alternative is a silently hanging server.
	if (source.split(old).length !== 2) return { code: source, status: "unsupported" };
	return { code: `${source.replace(old, replacement)}\n${SENTINEL}\n`, status: "patched" };
}

const OPT_OUT = new Set(["off", "0", "false", "no"]);
const OPT_IN = new Set(["on", "1", "true", "yes"]);

/** Android/Termux only by default; `PI_WEB_EXEC_LOOKUP=off` opts out, `=on` forces. */
export function shouldPatchExecutableLookup(
	platform: string = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const flag = (env.PI_WEB_EXEC_LOOKUP ?? "").trim().toLowerCase();
	if (OPT_OUT.has(flag)) return false;
	if (OPT_IN.has(flag)) return true;
	return platform === "android" || Boolean(env.TERMUX_VERSION);
}

/* SDK sources are transformed in memory before compilation, never on disk. */
export function registerExecutableLookupPatch(): void {
	if (!shouldPatchExecutableLookup()) return;
	registerHooks({
		load(url, context, nextLoad) {
			const target = executableLookupTarget(url);
			if (!target) return nextLoad(url, context);
			const loaded = nextLoad(url, context);
			if (loaded.source == null) return loaded;
			const source = typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
			const result = patchExecutableLookupSource(source, target);
			if (result.status === "unsupported")
				console.warn(`[executable-lookup] SDK lookup patch not applied (unrecognized source): ${url}`);
			return result.status === "patched" ? { ...loaded, source: result.code } : loaded;
		},
	});
}
