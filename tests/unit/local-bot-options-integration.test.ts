import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getLocalBotOptions, type BotCatalogSources } from "../../server/device-center/bot-catalog.js";
import { installLocalDeviceCenter } from "../../server/device-center/local.js";
import { registerBotExecution, isBotToolHighPrivilege } from "../../server/device-center/bot-execution.js";
import type { LocalBot } from "../../server/device-center/bots.js";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "bot-options-integration-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project with spaces");
	const other = join(root, "other-project");
	const dataDir = join(root, "data");
	await Promise.all([agentDir, cwd, other, dataDir].map((path) => mkdir(path, { recursive: true })));
	const put = async (path: string, content: unknown) => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
	};
	const skill = (name: string) => `---\nname: ${name}\ndescription: Fixture ${name}\n---\n# Instructions\n`;
	await put(join(agentDir, "skills", "global-review", "SKILL.md"), skill("global-review"));
	await put(join(cwd, ".pi", "skills", "nested", "review-folder", "SKILL.md"), skill("project-review"));
	await put(join(other, ".pi", "skills", "other-review", "SKILL.md"), skill("other-review"));
	await put(join(cwd, "configured-skills", "configured-review", "SKILL.md"), skill("configured-review"));
	await put(join(cwd, ".pi", "settings.json"), { skills: ["../configured-skills"] });
	await put(join(agentDir, "mcp.json"), {
		mcpServers: {
			shared: { command: "must-never-start-global", env: { SECRET: "fixture-private-secret" } },
			globalOnly: { command: "must-never-start", enabled: false },
		},
	});
	await put(join(cwd, ".pi", "mcp.json"), {
		mcpServers: {
			shared: { command: "must-never-start-project" },
			projectOnly: { url: "https://invalid.example/mcp", headers: { Authorization: "fixture-private-header" } },
		},
	});
	return {
		root,
		agentDir,
		cwd,
		other,
		dataDir,
		put,
		sources: { defaultCwd: cwd, agentDir, dataDir } satisfies BotCatalogSources,
	};
}
async function snapshot(path: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const entry of await readdir(path, { withFileTypes: true })) {
		const full = join(path, entry.name);
		if (entry.isDirectory()) Object.assign(result, await snapshot(full));
		else result[full] = await readFile(full, "utf8");
	}
	return result;
}
async function endpoint(sources: BotCatalogSources) {
	const app = express();
	const connect = vi.fn(() => ({ close() {}, isConnected: () => false }));
	const local = await installLocalDeviceCenter({ app, dataDir: sources.dataDir, botCatalog: sources, connect });
	cleanup.push(() => local.close());
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return {
		url: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/device-center/local-bot-options`,
		connect,
	};
}

describe("Local Bot catalog real SDK/config integration", () => {
	it("discovers configured and disk skills by execution name, scopes project MCP overrides, and leaves files untouched", async () => {
		const f = await fixture();
		const before = await snapshot(f.root);
		const peek = vi.fn(() => undefined);
		const result = await getLocalBotOptions({ ...f.sources, peekMcpBridge: peek }, f.cwd, new AbortController().signal);
		expect(result.skills).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "global-review", name: "global-review" }),
				expect.objectContaining({
					id: "project-review",
					path: join(f.cwd, ".pi", "skills", "nested", "review-folder", "SKILL.md"),
				}),
				expect.objectContaining({ id: "configured-review" }),
			]),
		);
		expect(result.skills.some((skill) => skill.id === "other-review")).toBe(false);
		expect(result.mcpServers).toEqual(
			expect.arrayContaining([
				{ id: "shared", name: "shared", scope: "project", status: "not_loaded", tools: [] },
				{ id: "globalOnly", name: "globalOnly", scope: "global", status: "disabled", tools: [] },
				{ id: "projectOnly", name: "projectOnly", scope: "project", status: "not_loaded", tools: [] },
			]),
		);
		expect(result.mcpServers.filter((server) => server.id === "shared")).toHaveLength(1);
		expect(JSON.stringify(result)).not.toMatch(/fixture-private|must-never-start|Authorization/);
		expect(peek).toHaveBeenCalledExactlyOnceWith(f.cwd);
		for (const name of ["conversation", "browser_page", "mcp_manage", "codemode"]) {
			expect(isBotToolHighPrivilege(name)).toBe(true);
			expect(result.tools.find((tool) => tool.id === name)).toMatchObject({ warning: "high_privilege" });
		}
		const binding = registerBotExecution({
			id: "fixture-bot",
			name: "Fixture",
			cwd: f.cwd,
			enabled: true,
			revision: 1,
			tools: [],
			skills: ["project-review"],
			mcpServers: [],
		} as unknown as LocalBot);
		cleanup.push(() => binding.release());
		expect(binding.capability.filterSkills(result.skills)).toEqual([
			expect.objectContaining({ name: "project-review" }),
		]);
		expect(await snapshot(f.root)).toEqual(before);
	});

	it("resolves local package manifest skill paths and skips missing packages without creating files", async () => {
		const f = await fixture();
		const pkg = join(f.root, "local-skill-package");
		await f.put(join(pkg, "package.json"), {
			name: "fixture-local-skills",
			version: "1.0.0",
			pi: { skills: ["./custom-resources/reviewer"] },
		});
		await f.put(
			join(pkg, "custom-resources", "reviewer", "SKILL.md"),
			"---\nname: package-review\ndescription: Local package fixture\n---\n# Review\n",
		);
		await f.put(join(f.cwd, ".pi", "settings.json"), {
			skills: ["../configured-skills"],
			packages: [pkg, join(f.root, "missing-local-package")],
		});
		const before = await snapshot(f.root);
		const result = await getLocalBotOptions(f.sources, undefined, new AbortController().signal);
		expect(result.skills).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "package-review", path: join(pkg, "custom-resources", "reviewer", "SKILL.md") }),
				expect.objectContaining({ id: "configured-review" }),
			]),
		);
		expect(await snapshot(f.root)).toEqual(before);
		await f.put(join(f.cwd, ".pi", "settings.json"), {
			skills: ["../configured-skills"],
			packages: [{ source: pkg, skills: [] }],
		});
		const disabledBefore = await snapshot(f.root);
		const filtered = await getLocalBotOptions(f.sources, undefined, new AbortController().signal);
		expect(filtered.skills.some((skill) => skill.id === "package-review")).toBe(false);
		expect(filtered.skills.some((skill) => skill.id === "configured-review")).toBe(true);
		expect(await snapshot(f.root)).toEqual(disabledBefore);
	});

	it("projects a real offline SDK custom model with slash ID without truncating execution identity", async () => {
		const f = await fixture();
		const modelsPath = join(f.agentDir, "models.json");
		await f.put(modelsPath, {
			providers: {
				"fixture-provider": {
					baseUrl: "http://127.0.0.1:1/v1",
					api: "openai-completions",
					apiKey: "fixture-not-a-real-key",
					models: [
						{
							id: "organization/family/model",
							name: "Fixture slash model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 8192,
							maxTokens: 1024,
						},
					],
				},
			},
		});
		const runtime = await ModelRuntime.create({
			modelsPath,
			authPath: join(f.agentDir, "auth.json"),
			modelsStorePath: join(f.agentDir, "models-cache.json"),
			allowModelNetwork: false,
		});
		expect(runtime.getError()).toBeUndefined();
		const models = async () =>
			(await runtime.getAvailable())
				.filter((model) => model.provider === "fixture-provider")
				.map((model) => ({
					id: `${model.provider}/${model.id}`,
					name: model.name,
					provider: model.provider,
					reasoning: model.reasoning,
					vision: model.input.includes("image"),
				}));
		const before = await snapshot(f.root);
		const result = await getLocalBotOptions(
			{ ...f.sources, models, defaultModel: () => "fixture-provider/organization/family/model" },
			undefined,
			new AbortController().signal,
		);
		expect(result.models).toEqual([
			expect.objectContaining({ id: "fixture-provider/organization/family/model", provider: "fixture-provider" }),
		]);
		const binding = registerBotExecution({
			id: "fixture-bot",
			name: "Fixture",
			cwd: f.cwd,
			enabled: true,
			revision: 1,
			tools: [],
			skills: [],
			mcpServers: [],
		} as unknown as LocalBot);
		cleanup.push(() => binding.release());
		expect(binding.capability.captureModel(result.defaultModel)).toEqual({
			provider: "fixture-provider",
			modelId: "organization/family/model",
		});
		expect(JSON.stringify(result)).not.toContain("fixture-not-a-real-key");
		expect(await snapshot(f.root)).toEqual(before);
	});

	it("serves independent requested project catalogs through HTTP and rejects invalid cwd and cross-origin requests", async () => {
		const f = await fixture();
		const { url, connect } = await endpoint(f.sources);
		const before = await snapshot(f.root);
		const [first, second] = await Promise.all([
			fetch(`${url}?cwd=${encodeURIComponent(f.cwd)}`),
			fetch(`${url}?cwd=${encodeURIComponent(f.other)}`),
		]);
		expect(first.status).toBe(200);
		expect(first.headers.get("cache-control")).toBe("no-store");
		const a = await first.json();
		const b = await second.json();
		expect(a.cwd).toBe(f.cwd);
		expect(b.cwd).toBe(f.other);
		expect(a.skills.some((skill: { id: string }) => skill.id === "project-review")).toBe(true);
		expect(b.skills.some((skill: { id: string }) => skill.id === "project-review")).toBe(false);
		expect(b.skills.some((skill: { id: string }) => skill.id === "other-review")).toBe(true);
		for (const cwd of ["relative", join(f.root, "missing"), ""])
			expect((await fetch(`${url}?cwd=${encodeURIComponent(cwd)}`)).status).toBe(400);
		expect((await fetch(url, { headers: { Origin: "https://external.example" } })).status).toBe(403);
		expect((await fetch(url, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
		expect(connect).not.toHaveBeenCalled();
		expect(await snapshot(f.root)).toEqual(before);
	});

	it("returns a sanitized HTTP failure and honors caller cancellation without returning a partial catalog", async () => {
		const f = await fixture();
		const models = vi.fn(async () => {
			throw new Error("private-provider-credentials");
		});
		const { url } = await endpoint({ ...f.sources, models });
		const response = await fetch(url);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ code: "BOT_CATALOG_FAILED", error: "Bot catalog unavailable" });
		const controller = new AbortController();
		controller.abort();
		await expect(getLocalBotOptions({ ...f.sources, models }, undefined, controller.signal)).rejects.toThrow();
		expect(models).toHaveBeenCalledTimes(1);
	});
});
