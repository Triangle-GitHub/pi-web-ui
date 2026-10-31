import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupDurableModels, listGlobalAvailableModels } from "../../server/durable/durable-models.js";
import * as loader from "../../server/durable/durable-loader.js";
const { loadDurablePeerModule } = loader;

const dirs: string[] = [];
function config(providers: Record<string, unknown>, store?: Record<string, unknown>) {
	const dir = mkdtempSync(join(tmpdir(), "durable-models-802-"));
	dirs.push(dir);
	writeFileSync(join(dir, "models.json"), JSON.stringify({ providers }));
	if (store) writeFileSync(join(dir, "models-store.json"), JSON.stringify(store));
	return dir;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Durable provider configuration with the installed pi-ai SDK", () => {
	it.each(["openai", "anthropic", "google", "google-vertex"])(
		"keeps %s built-in models and authentication for endpoint-only overrides",
		async (id) => {
			const sdk = await loadDurablePeerModule("@earendil-works/pi-ai", "providers/all");
			expect(sdk?.builtinProviders).toBeTypeOf("function");
			const builtin = sdk!.builtinProviders().find((p: any) => p.id === id);
			expect(builtin).toBeDefined();
			for (const models of [undefined, []]) {
				const dir = config({ [id]: { baseUrl: "http://127.0.0.1:8999", models } });
				const registry = await setupDurableModels(dir);
				const provider = registry.getProvider(id);
				expect(provider.getModels().map((m: any) => m.id)).toEqual(builtin.getModels().map((m: any) => m.id));
				expect(provider.getAllModels().map((m: any) => m.id)).toEqual(builtin.getAllModels().map((m: any) => m.id));
				expect(Object.keys(provider.auth)).toEqual(Object.keys(builtin.auth));
				expect(provider.auth.apiKey.name).toBe(builtin.auth.apiKey.name);
				if (builtin.auth.oauth) expect(provider.auth.oauth.name).toBe(builtin.auth.oauth.name);
			}
		},
	);

	it("retains live SDK discovery and merges overrides onto existing models", async () => {
		const all = await loadDurablePeerModule("@earendil-works/pi-ai", "providers/all");
		const builtin = all!.builtinProviders().find((p: any) => p.id === "google-vertex");
		const baseline = builtin.getModels();
		let current = baseline;
		builtin.getModels = () => current;
		builtin.getAllModels = () => current;
		builtin.refreshModels = async () => {
			current = [...baseline, { ...baseline[0], id: "discovered-gemini" }];
		};
		const load = loader.loadDurablePeerModule;
		vi.spyOn(loader, "loadDurablePeerModule").mockImplementation((pkg, path) =>
			path === "providers/all" ? Promise.resolve({ builtinProviders: () => [builtin] }) : load(pkg, path),
		);
		const registry = await setupDurableModels(
			config({
				"google-vertex": {
					models: [{ id: baseline[0].id, name: "Override name", contextWindow: 12345, cost: { input: 7 } }],
				},
			}),
		);
		const provider = registry.getProvider("google-vertex");
		expect(registry.getModel("google-vertex", baseline[0].id)).toMatchObject({
			name: "Override name",
			contextWindow: 12345,
			api: baseline[0].api,
			cost: { ...baseline[0].cost, input: 7 },
		});
		expect(provider.refreshModels).toBe(builtin.refreshModels);
		await provider.refreshModels();
		expect(registry.getModel("google-vertex", "discovered-gemini")).toBeDefined();
	});

	it("extends a built-in provider without losing its catalog or ADC authentication", async () => {
		const dir = config({
			"google-vertex": {
				baseUrl: "http://127.0.0.1:8999",
				models: [{ id: "local-gemini", name: "Local Gemini", contextWindow: 8192, maxTokens: 1024 }],
			},
		});
		const registry = await setupDurableModels(dir);
		expect(registry.getModels("google-vertex").length).toBeGreaterThan(1);
		expect(registry.getModel("google-vertex", "local-gemini")).toMatchObject({
			api: "google-vertex",
			provider: "google-vertex",
		});
		registry.authContext = {
			env: async (name: string) =>
				({ GOOGLE_CLOUD_PROJECT: "offline-project", GOOGLE_CLOUD_LOCATION: "us-central1" })[name],
			fileExists: async () => true,
		};
		expect(await registry.getAuth("google-vertex")).toMatchObject({ source: "gcloud application default credentials" });
	});

	it("lists configured Vertex models through the Durable protocol filter", async () => {
		const dir = config(
			{
				"google-vertex": {
					baseUrl: "http://127.0.0.1:8999",
					models: [{ id: "cached-gemini", name: "Cached Gemini", api: "google-vertex" }],
				},
			},
			{
				"google-vertex": {
					models: [{ id: "cached-gemini", name: "Cached Gemini", api: "google-vertex", provider: "google-vertex" }],
				},
			},
		);
		const list = await listGlobalAvailableModels(dir, dir);
		expect(list).toContainEqual(
			expect.objectContaining({ id: "google-vertex/cached-gemini", provider: "google-vertex" }),
		);
	});

	it("retains cached model defaults when models.json only overrides its name", async () => {
		const dir = config(
			{ "google-vertex": { models: [{ id: "cached", name: "renamed" }] } },
			{
				"google-vertex": {
					models: [
						{
							id: "cached",
							provider: "google-vertex",
							api: "google-vertex",
							contextWindow: 8192,
							maxTokens: 1024,
							input: ["text"],
						},
					],
				},
			},
		);
		const registry = await setupDurableModels(dir);
		expect(registry.getModel("google-vertex", "cached")).toMatchObject({
			name: "renamed",
			api: "google-vertex",
			contextWindow: 8192,
			maxTokens: 1024,
			input: ["text"],
		});
	});

	it("keeps non-chat APIs and same-id model overrides separate", async () => {
		const all = await loadDurablePeerModule("@earendil-works/pi-ai", "providers/all");
		const builtin = all!.builtinProviders().find((p: any) => p.id === "openai");
		const registry = await setupDurableModels(
			config({
				openai: {
					api: "openai-completions",
					headers: { "X-Provider": "yes" },
					models: [
						{ id: "gpt-6-luna", headers: { "X-Chat-Only": "yes" }, baseUrl: "http://127.0.0.1:8999/chat" },
						{ id: "gpt-6-luna", type: "classifier", name: "Renamed classifier" },
					],
				},
			}),
		);
		const classifiers = registry.getAllModels("openai").filter((m: any) => m.type === "classifier");
		expect(classifiers.length).toBeGreaterThan(0);
		for (const model of classifiers) {
			expect(model.api).toBe(builtin.getAllModels().find((m: any) => m.type === "classifier" && m.id === model.id).api);
			expect(model.headers).not.toHaveProperty("X-Chat-Only");
			expect(model.baseUrl).not.toBe("http://127.0.0.1:8999/chat");
		}
	});

	it("loads the native Vertex fallback when the all-provider module is unavailable", async () => {
		const load = loader.loadDurablePeerModule;
		vi.spyOn(loader, "loadDurablePeerModule").mockImplementation((pkg, path) =>
			path === "providers/all" ? Promise.resolve(null) : load(pkg, path),
		);
		const registry = await setupDurableModels(config({ "google-vertex": { baseUrl: "http://127.0.0.1:8999" } }));
		expect(registry.getModels("google-vertex").length).toBeGreaterThan(0);
		expect(registry.getProvider("google-vertex").auth.apiKey.name).toBe("Google Cloud credentials");
	});

	it("isolates unavailable API modules while retaining other custom providers", async () => {
		const load = loader.loadDurablePeerModule;
		vi.spyOn(loader, "loadDurablePeerModule").mockImplementation((pkg, path) => {
			if (path === "api/google-vertex.lazy") return Promise.reject(new Error("module unavailable"));
			return load(pkg, path);
		});
		const registry = await setupDurableModels(
			config({ gateway: { api: "openai-completions", models: [{ id: "test" }] } }),
		);
		expect(registry.getModel("gateway", "test")).toMatchObject({ api: "openai-completions" });
	});

	it.each([
		{ id: "google-vertex", protocol: "google-vertex", override: "none" },
		{ id: "vertex-gateway", protocol: "google-vertex", override: "provider" },
		{ id: "google", protocol: "google-vertex", override: "model" },
		{ id: "google-vertex", protocol: "openai-completions", override: "provider" },
		{ id: "google-vertex", protocol: "openai-completions", override: "model" },
		{ id: "google-vertex", protocol: "openai-completions", override: "cached" },
	])(
		"streams $id via $protocol with $override overrides using the actual SDK",
		async ({ id, protocol, override }) => {
			const requests: Array<{ url: string; headers: any; body: any }> = [];
			const server = createServer(async (req, res) => {
				let body = "";
				for await (const chunk of req) body += chunk;
				requests.push({ url: req.url!, headers: req.headers, body: JSON.parse(body) });
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				if (protocol === "openai-completions") {
					res.end(
						`data: ${JSON.stringify({ id: "offline", choices: [{ index: 0, delta: { content: "vertex-ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
					);
					return;
				}
				res.end(
					`data: ${JSON.stringify({
						candidates: [{ content: { role: "model", parts: [{ text: "vertex-ok" }] }, finishReason: "STOP" }],
						usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
					})}\n\n`,
				);
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			try {
				const address = server.address() as import("node:net").AddressInfo;
				const dir = config(
					{
						[id]: {
							baseUrl: `http://127.0.0.1:${address.port}/provider`,
							apiKey: "offline-vertex-test-key",
							headers: { "X-Regression-802": "configured", "X-Priority": "provider" },
							...(["provider", "cached"].includes(override) ? { api: protocol } : {}),
							...(!["none", "cached"].includes(override)
								? {
										models: [
											{
												id: "cached-gemini",
												name: "Local Gemini",
												baseUrl: `http://127.0.0.1:${address.port}/model`,
												headers: { "x-priority": "model" },
												...(override === "model" ? { api: protocol } : {}),
												contextWindow: 8192,
												maxTokens: 1024,
												input: ["text"],
												reasoning: false,
											},
										],
									}
								: {}),
						},
					},
					{
						[id]: {
							models: [
								{
									id: "cached-gemini",
									name: "Cached Gemini",
									provider: id,
									api: "google-vertex",
									contextWindow: 8192,
									maxTokens: 1024,
									input: ["text"],
									reasoning: false,
								},
							],
						},
					},
				);
				const registry = await setupDurableModels(dir);
				const model = registry.getModel(id, "cached-gemini");
				expect(model).toBeDefined();
				const result = await registry
					.streamSimple(
						model,
						{
							messages: [{ role: "user", content: "say ok", timestamp: Date.now() }],
						},
						{ signal: AbortSignal.timeout(5000), maxTokens: 16 },
					)
					.result();
				expect(result.errorMessage).toBeUndefined();
				expect(result.content).toContainEqual({ type: "text", text: "vertex-ok" });
				expect(requests).toHaveLength(1);
				expect(requests[0].url).toContain(["none", "cached"].includes(override) ? "/provider/" : "/model/");
				expect(requests[0].headers["x-priority"]).toBe(["none", "cached"].includes(override) ? "provider" : "model");
				if (protocol === "google-vertex") {
					expect(requests[0].url).toContain("models/cached-gemini:streamGenerateContent");
					expect(requests[0].headers["x-goog-api-key"]).toBe("offline-vertex-test-key");
					expect(requests[0].body.contents[0].parts).toContainEqual({ text: "say ok" });
					expect(requests[0].body).not.toHaveProperty("messages");
				} else {
					expect(requests[0].url).toContain("chat/completions");
					expect(requests[0].headers.authorization).toBe("Bearer offline-vertex-test-key");
					expect(requests[0].body.messages[0].content).toBe("say ok");
				}
				expect(requests[0].headers["x-regression-802"]).toBe("configured");
			} finally {
				server.closeAllConnections();
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		},
		15000,
	);
});
