import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const tokens = (css: string) =>
	new Map([...css.matchAll(/(--switch-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const ratio = (a: string, b: string) => {
	const lum = (hex: string) =>
		hex
			.slice(1)
			.match(/../g)!
			.map((v) => parseInt(v, 16) / 255)
			.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
			.reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
	const [x, y] = [lum(a), lum(b)];
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe("theme-owned switch colors", () => {
	for (const file of readdirSync(join(root, "themes")).filter((f) => f.endsWith(".css"))) {
		it(`${file} explicitly defines visible knobs in both states`, () => {
			const palette = tokens(readFileSync(join(root, "themes", file), "utf8"));
			for (const token of ["bg-off", "border-off", "knob", "bg-on", "border-on", "knob-on"]) {
				expect(palette.get(`--switch-${token}`), token).toMatch(/^#[a-f0-9]{6}$/i);
			}
			for (const [bg, fg] of [
				["bg-off", "knob"],
				["bg-on", "knob-on"],
			]) {
				expect(ratio(palette.get(`--switch-${bg}`)!, palette.get(`--switch-${fg}`)!), bg).toBeGreaterThanOrEqual(3);
			}
			expect(
				ratio(palette.get("--switch-bg-on")!, palette.get("--switch-bg-off")!),
				"state distinction",
			).toBeGreaterThanOrEqual(1.3);
		});
	}
});
