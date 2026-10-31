import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { loadPlayer, savePlayer } from "../../plugins/lx-music/client/player-storage.mjs";

function memoryStorage() {
	const data = new Map<string, string>();
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => data.set(key, value),
	};
}
const song = { id: "42", source: "wy", name: "Test", singer: "Singer", _realPlayUrl: "https://expired.example/song" };

describe("LX Music player persistence", () => {
	it("restores lists, history, progress and preferences across player instances without signed URLs", () => {
		const storage = memoryStorage();
		const state = {
			queue: [song],
			favorites: [song],
			history: [song],
			searchResults: [song],
			topChartSongs: [song],
			currentSong: song,
			currentTime: 42,
			duration: 180,
			volume: 0,
			quality: "flac",
			playMode: "random",
			source: "kg",
			topChartType: "new",
			activeViewTab: "history",
			searchKeyword: "Test",
			isPlaying: true,
		};
		expect(savePlayer(storage, state)).toBe(true);
		const restored = loadPlayer(storage);
		expect(restored).toMatchObject({
			currentTime: 42,
			duration: 180,
			volume: 0,
			quality: "flac",
			playMode: "random",
			activeViewTab: "history",
			searchKeyword: "Test",
		});
		for (const key of ["queue", "favorites", "history", "searchResults", "topChartSongs"])
			expect(restored[key]).toEqual([{ id: "42", source: "wy", name: "Test", singer: "Singer" }]);
		expect(restored.currentSong._realPlayUrl).toBeUndefined();
		expect(restored.isPlaying).toBeUndefined();
	});
	it("persists empty queues and isolates deployment paths", () => {
		const storage = memoryStorage();
		savePlayer(storage, { queue: [song] }, "a");
		savePlayer(storage, { queue: [] }, "a");
		savePlayer(storage, { queue: [song] }, "b");
		expect(loadPlayer(storage, "a").queue).toEqual([]);
		expect(loadPlayer(storage, "b").queue).toHaveLength(1);
	});
	it("rejects invalid data and handles unavailable storage", () => {
		expect(loadPlayer({ getItem: () => "bad json" })).toEqual({});
		expect(
			loadPlayer({
				getItem: () =>
					JSON.stringify({ version: 1, volume: 5, playMode: "invalid", queue: [null, {}, song], currentTime: -1 }),
			}),
		).toEqual({ version: 1, queue: [{ id: "42", source: "wy", name: "Test", singer: "Singer" }] });
		const storage = {
			getItem() {
				throw new Error("denied");
			},
			setItem() {
				throw new Error("quota");
			},
		};
		expect(loadPlayer(storage)).toEqual({});
		expect(savePlayer(storage, { queue: [song] })).toBe(false);
	});
	it("resolves a fresh URL and seeks to restored progress on user playback, recording successful plays", async () => {
		const source = readFileSync(new URL("../../plugins/lx-music/client/entry.mjs", import.meta.url), "utf8")
			.replace(/^import .*player-storage.mjs";$/m, "")
			.replace("export default {", "const plugin = {");
		const handlers = new Map<string, () => void>();
		const audio = {
			src: "",
			currentTime: 0,
			duration: 180,
			volume: 1,
			addEventListener: (name: string, cb: () => void) => handlers.set(name, cb),
			getAttribute: () => null,
			async play() {
				handlers.get("loadedmetadata")?.();
			},
		};
		const context: any = {
			Audio: function () {
				return audio;
			},
			navigator: {},
			console,
			setTimeout,
			clearTimeout,
			PLAYER_STORAGE_KEY: "test",
			fetch: async (url: string) => ({
				json: async () =>
					url.includes("/lyric?") ? { ok: true, lyric: "" } : { ok: true, url: "https://fresh.example/song" },
			}),
		};
		runInNewContext(
			`${source}\nglobalState.currentSong = ${JSON.stringify(song)}; globalState.currentTime = 42; globalThis.resume = resumePlayback; globalThis.state = globalState;`,
			context,
		);
		await context.resume();
		expect(audio.src).toContain("fresh.example");
		expect(audio.currentTime).toBe(42);
		expect(context.state.history).toHaveLength(1);
		await context.resume();
		expect(context.state.history).toHaveLength(1);
	});
});
