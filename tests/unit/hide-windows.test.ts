import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { hiddenWindowArgs } from "../lib/hide-windows.mjs";

const helper = new URL("../lib/hide-windows.mjs", import.meta.url).href;

describe("Windows test subprocess consoles", () => {
	it("handles subprocess overloads without moving callbacks or mutating options", () => {
		const callback = () => {};
		for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"]) {
			expect(hiddenWindowArgs(name, ["node"])).toEqual(["node", { windowsHide: true }]);
			expect(hiddenWindowArgs(name, ["node", ["--version"], callback])).toEqual([
				"node",
				["--version"],
				{ windowsHide: true },
				callback,
			]);
			expect(hiddenWindowArgs(name, ["node", callback])).toEqual(["node", { windowsHide: true }, callback]);
			const options = { windowsHide: false, cwd: "test" };
			expect(hiddenWindowArgs(name, ["node", [], options, callback])).toEqual(["node", [], options, callback]);
			expect(hiddenWindowArgs(name, ["node", [], options])[2]).not.toBe(options);
		}
		for (const name of ["exec", "execSync"]) {
			expect(hiddenWindowArgs(name, ["node --version", callback])).toEqual([
				"node --version",
				{ windowsHide: true },
				callback,
			]);
		}
	});

	it("preserves promisified execFile stdout and stderr", async () => {
		const result = await promisify(execFile)(process.execPath, ["-e", "console.log('stdout');console.error('stderr')"]);
		expect(result.stdout.trim()).toBe("stdout");
		expect(result.stderr.trim()).toBe("stderr");
	});

	it.skipIf(process.platform !== "win32")("preloads the helper in grandchildren and updates named ESM imports", () => {
		const probe = `
			import cp, { spawn } from 'node:child_process';
			console.log(JSON.stringify({ patched: !!cp[Symbol.for('pi-web-ui.tests.hide-windows')], named: spawn === cp.spawn }));
		`;
		const script = `
			import { execFileSync } from 'node:child_process';
			process.stdout.write(execFileSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(probe)}]));
		`;
		const output = execFileSync(process.execPath, ["--import", helper, "--input-type=module", "-e", script], {
			encoding: "utf8",
		});
		expect(JSON.parse(output)).toEqual({ patched: true, named: true });
	});
});
