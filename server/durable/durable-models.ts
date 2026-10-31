/**
 * durable-models.ts — Pi Durable 引擎的全局模型继承与提供商装配器。
 *
 * 职责：
 * 1. 继承全局模型事实源：从 SDK ModelRuntime 与 models.json 聚合全量可用模型；
 * 2. 装配 @earendil-works/pi-ai 的 models 容器，注入内置与自定义 Providers（带 API Key 与 BaseURL）；
 * 3. 解析用户选择的 activeModel，传递给 Durable Conversation 运行时。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
	listCustomModelsFromConfig,
	readModelsJson,
	resolveProviderCredential,
	isProtocolSupportedByEngine,
	resolveModelProtocol,
} from "../model-resolver.js";
import { loadDurablePeerModule } from "./durable-loader.js";

function mergeProviderHeaders(...sources: Array<Record<string, string> | undefined>): Record<string, string> {
	const headers = new Map<string, [string, string]>();
	for (const source of sources) {
		for (const [name, value] of Object.entries(source ?? {})) headers.set(name.toLowerCase(), [name, value]);
	}
	return Object.fromEntries(headers.values());
}

export interface DurableModelInfo {
	id: string;
	name: string;
	provider: string;
	vision?: boolean;
	reasoning?: boolean;
}

/**
 * 聚合全局所有已鉴权、可用的模型名录（包括官方内置模型与用户自定义模型）。
 * 优先收录并前置展示 models.json 中的用户自定义服务商与模型。
 */
export async function listGlobalAvailableModels(cwd: string, agentDir?: string): Promise<DurableModelInfo[]> {
	const modelMap = new Map<string, DurableModelInfo>();

	// 1. 优先收录 models.json 中的用户自定义模型（本地代理/自定义端点通常为首选活动端点）
	try {
		const customModels = listCustomModelsFromConfig(agentDir, (entry) =>
			isProtocolSupportedByEngine("durable", entry.api, entry.providerId, entry.modelId),
		);
		for (const cm of customModels) {
			const fullId = `${cm.providerId}/${cm.modelId}`;
			if (!modelMap.has(fullId)) {
				modelMap.set(fullId, {
					id: fullId,
					name: cm.name || cm.modelId,
					provider: cm.providerId,
					vision: cm.vision ?? false,
					reasoning: cm.reasoning ?? false,
				});
			}
		}
	} catch {
		/* ignore */
	}

	// 2. 补充 SDK ModelRuntime 动态获取的官方与外部模型
	try {
		const piSdk = await import(/* webpackIgnore: true */ "@earendil-works/pi-coding-agent" as string).catch(() => null);

		if (piSdk && typeof piSdk.createAgentSessionServices === "function") {
			const services = await piSdk.createAgentSessionServices({ cwd, agentDir });
			const available = await services.modelRuntime.getAvailable();
			for (const m of available) {
				// 严格按照实际协议类型进行过滤（绝不按模型名字猜测）
				if (!isProtocolSupportedByEngine("durable", m.api, m.provider, m.id)) {
					continue;
				}
				const fullId = `${m.provider}/${m.id}`;
				if (!modelMap.has(fullId)) {
					modelMap.set(fullId, {
						id: fullId,
						name: (m.name || m.id).replace(/\s*\(new\)$/i, "").trim(),
						provider: m.provider,
						vision: m.input?.includes("image") ?? false,
						reasoning: m.reasoning,
					});
				}
			}
		}
	} catch {
		/* SDK model runtime load failed, fall back to models.json */
	}

	return Array.from(modelMap.values());
}

/**
 * 为 Pi Durable Harness 装配并初始化全局模型服务（@earendil-works/pi-ai Models 实例）。
 */
export async function setupDurableModels(agentDir?: string): Promise<any> {
	const aiModule = await loadDurablePeerModule("@earendil-works/pi-ai", "models").catch(() => null);

	if (!aiModule || typeof aiModule.createModels !== "function") {
		return {};
	}

	const models = aiModule.createModels();

	// 1. 尝试全量装载内置提供商（providers/all 包含 opencode-go、openrouter 等 42+ 个提供商）
	try {
		const allProvidersModule = await loadDurablePeerModule("@earendil-works/pi-ai", "providers/all").catch(() => null);
		if (allProvidersModule && typeof allProvidersModule.builtinProviders === "function") {
			const builtins = allProvidersModule.builtinProviders();
			for (const p of builtins) {
				if (typeof models.setProvider === "function") {
					models.setProvider(p);
				}
			}
		}
	} catch {
		/* ignore fallback to minimal builtins */
	}

	// 2. 兜底保障基础内置提供商
	const fallbackBuiltinIds = ["openai", "anthropic", "google", "google-vertex", "mistral", "groq", "deepseek"];
	for (const pid of fallbackBuiltinIds) {
		if (models.providers && models.providers.has(pid)) continue;
		try {
			const providerModule = await loadDurablePeerModule("@earendil-works/pi-ai", `providers/${pid}`).catch(() => null);
			const providerFactory =
				providerModule?.[`${pid.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())}Provider`] ||
				providerModule?.default;
			if (typeof providerFactory === "function") {
				const instance = providerFactory();
				if (typeof models.setProvider === "function") {
					models.setProvider(instance);
				}
			}
		} catch {
			/* provider loading skipped */
		}
	}

	// 3. 继承持久化动态模型缓存 (~/.pi/agent/models-store.json)
	let cachedProviders: Record<string, any> = {};
	try {
		const userAgentDir = agentDir || join(homedir(), ".pi", "agent");
		const storePath = join(userAgentDir, "models-store.json");
		if (existsSync(storePath)) {
			cachedProviders = JSON.parse(readFileSync(storePath, "utf8"));
			for (const [providerId, pData] of Object.entries(cachedProviders)) {
				const p = typeof models.getProvider === "function" ? models.getProvider(providerId) : undefined;
				if (p && Array.isArray((pData as any)?.models)) {
					const extraModels: any[] = (pData as any).models;
					const origGetModels = typeof p.getModels === "function" ? p.getModels.bind(p) : null;
					const origGetAllModels = typeof p.getAllModels === "function" ? p.getAllModels.bind(p) : null;

					if (origGetModels) {
						p.getModels = () => {
							const list = origGetModels();
							const ids = new Set(list.map((m: any) => m.id));
							const added = extraModels
								.filter((m: any) => !ids.has(m.id))
								.map((m: any) => ({
									...m,
									cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								}));
							return [...list, ...added];
						};
					}
					if (origGetAllModels) {
						p.getAllModels = () => {
							const list = origGetAllModels();
							const ids = new Set(list.map((m: any) => m.id));
							const added = extraModels
								.filter((m: any) => !ids.has(m.id))
								.map((m: any) => ({
									...m,
									cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								}));
							return [...list, ...added];
						};
					}
				}
			}
		}
	} catch {
		/* dynamic models store read skipped */
	}

	// 4. 动态加载 models.json 中的自定义服务商与模型
	try {
		const { providers: customProviders } = readModelsJson(agentDir);
		const implementations: Record<string, any> = {};
		for (const [protocol, factory] of [
			["openai-completions", "openAICompletionsApi"],
			["openai-responses", "openAIResponsesApi"],
			["anthropic-messages", "anthropicMessagesApi"],
			["google-generative-ai", "googleGenerativeAIApi"],
			["google-vertex", "googleVertexApi"],
		]) {
			try {
				const module = await loadDurablePeerModule("@earendil-works/pi-ai", `api/${protocol}.lazy`);
				if (typeof module?.[factory] === "function") implementations[protocol] = module[factory]();
			} catch {
				/* An unavailable API must not suppress unrelated providers. */
			}
		}

		for (const [providerId, pConfig] of Object.entries(customProviders)) {
			if (!pConfig || typeof pConfig !== "object") continue;
			const cred = resolveProviderCredential(agentDir, providerId);
			const builtin = models.getProvider(providerId);
			const rawModels: any[] = Array.isArray(pConfig.models) ? pConfig.models : [];
			const apiOverride = typeof pConfig.api === "string" && pConfig.api.trim() ? pConfig.api : undefined;
			const mergeModels = (baseline: any[]) => {
				const key = (model: any) => `${model.type ?? "chat"}:${model.id}`;
				const cached: any[] = Array.isArray(cachedProviders[providerId]?.models)
					? cachedProviders[providerId].models
					: [];
				const merged = new Map([...cached, ...baseline].map((model: any) => [key(model), { ...model }]));
				for (const override of rawModels) {
					const original = merged.get(key(override));
					merged.set(key(override), {
						...original,
						...override,
						...(original?.cost && override.cost ? { cost: { ...original.cost, ...override.cost } } : {}),
						api:
							override.type && override.type !== "chat"
								? (override.api ?? original?.api)
								: resolveModelProtocol(
										override.api ?? apiOverride ?? original?.api ?? builtin?.getModels()[0]?.api,
										providerId,
										override.id,
									),
					});
				}
				return [...merged.values()].map((model: any) => ({
					...model,
					provider: providerId,
					api:
						model.type && model.type !== "chat"
							? model.api
							: resolveModelProtocol(
									rawModels.find((m) => key(m) === key(model))?.api ?? apiOverride ?? model.api,
									providerId,
									model.id,
								),
					cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					type: model.type ?? "chat",
				}));
			};

			if (Object.keys(implementations).length && typeof aiModule.createProvider === "function") {
				const customProvider = aiModule.createProvider({
					id: providerId,
					name: (pConfig as any).name || providerId,
					baseUrl: cred.baseUrl,
					headers: cred.headers,
					auth: builtin?.auth ?? {
						apiKey: {
							name: `${providerId} API key`,
							login: async () => ({ type: "api_key", key: cred.apiKey || "" }),
							resolve: async () => (cred.apiKey ? { auth: { apiKey: cred.apiKey }, source: "config" } : undefined),
						},
					},
					models: mergeModels([]),
					api: implementations,
				});

				if (builtin) {
					// Keep native authentication and operations (ADC/OAuth, images, discovery).
					// Only explicit API overrides opt into a different SDK implementation.
					const overridden = (model: any) =>
						apiOverride ||
						rawModels.some((m) => m.id === model.id && (m.type ?? "chat") === (model.type ?? "chat") && m.api);
					models.setProvider({
						...builtin,
						name: pConfig.name || builtin.name,
						getModels: () => mergeModels(builtin.getModels()).filter((model: any) => model.type === "chat"),
						getAllModels: () => mergeModels(builtin.getAllModels?.() ?? builtin.getModels()),
						stream: (model: any, context: any, options: any) =>
							(overridden(model) ? customProvider : builtin).stream(model, context, options),
						streamSimple: (model: any, context: any, options: any) =>
							(overridden(model) ? customProvider : builtin).streamSimple(model, context, options),
					});
				} else {
					models.setProvider(customProvider);
				}
			}
		}
	} catch {
		/* custom provider setup skipped */
	}

	// 5. 为所有已注册 Provider 注入凭证与 BaseURL
	try {
		const { providers } = readModelsJson(agentDir);
		if (models.providers && typeof models.providers.keys === "function") {
			for (const providerId of models.providers.keys()) {
				const cred = resolveProviderCredential(agentDir, providerId);
				if (cred.apiKey && models.credentials && typeof models.credentials.modify === "function") {
					await models.credentials
						.modify(providerId, async () => ({
							type: "api_key",
							key: cred.apiKey,
						}))
						.catch(() => {});
				}
				const p = models.getProvider(providerId);
				const pConfig = providers[providerId];
				if (p && (cred.baseUrl || cred.headers || pConfig?.api || pConfig?.models)) {
					if (cred.baseUrl) p.baseUrl = cred.baseUrl;
					if (cred.headers) p.headers = { ...p.headers, ...cred.headers };
					// pi-ai streams consume model.baseUrl/headers, not provider metadata.
					// Apply provider defaults before explicit per-model configuration.
					const overrides: any[] = Array.isArray(pConfig?.models) ? pConfig.models : [];
					for (const method of ["getModels", "getAllModels"]) {
						if (typeof p[method] !== "function") continue;
						const getModels = p[method].bind(p);
						p[method] = () =>
							getModels().map((model: any) => {
								const override = overrides.find(
									(m) => m.id === model.id && (m.type ?? "chat") === (model.type ?? "chat"),
								);
								return {
									...model,
									api:
										model.type && model.type !== "chat"
											? model.api
											: resolveModelProtocol(
													override?.api ?? (typeof pConfig?.api === "string" ? pConfig.api : model.api),
													providerId,
													model.id,
												),
									baseUrl: override?.baseUrl ?? cred.baseUrl ?? model.baseUrl,
									headers: mergeProviderHeaders(model.headers, cred.headers, override?.headers),
								};
							});
					}
				}
			}
		}
	} catch {
		/* credential hydration skipped */
	}

	return models;
}

/**
 * 将形如 "openai/gpt-4o" 或 "gpt-4o" 的模型标识解析为 Durable 引擎可识别的 provider 与 modelId。
 */
export function resolveDurableModelChoice(
	modelId?: string,
	fallbackList?: DurableModelInfo[],
	agentDir?: string,
): { provider: string; modelId: string } | undefined {
	if (!modelId || !modelId.trim() || modelId === "default") {
		if (fallbackList && fallbackList.length > 0) {
			// 1. 优先在 fallbackList 中寻找用户在 models.json 里明确配置的自定义端点模型
			const { providers: customConfig } = readModelsJson(agentDir);
			const customFirst = fallbackList.find((m) => Object.prototype.hasOwnProperty.call(customConfig, m.provider));
			if (customFirst) {
				return { provider: customFirst.provider, modelId: customFirst.id.replace(`${customFirst.provider}/`, "") };
			}

			// 2. 其次寻找具备有效 baseUrl 或独立 apiKey 的可用模型
			const configured = fallbackList.find((m) => {
				const cred = resolveProviderCredential(agentDir, m.provider);
				return Boolean(cred.baseUrl || cred.apiKey);
			});
			const chosen = configured ?? fallbackList[0];
			return { provider: chosen.provider, modelId: chosen.id.replace(`${chosen.provider}/`, "") };
		}
		return undefined;
	}

	const trimmed = modelId.trim();
	if (trimmed.includes("/")) {
		const slashIdx = trimmed.indexOf("/");
		return {
			provider: trimmed.slice(0, slashIdx),
			modelId: trimmed.slice(slashIdx + 1),
		};
	}

	// 若未带 provider 前缀，尝试在已知列表中寻找匹配项
	if (fallbackList) {
		const found = fallbackList.find((m) => m.id === trimmed || m.id.endsWith(`/${trimmed}`));
		if (found) {
			return {
				provider: found.provider,
				modelId: found.id.replace(`${found.provider}/`, ""),
			};
		}
	}

	return {
		provider: "openai",
		modelId: trimmed,
	};
}

/**
 * 根据模型配置（reasoning 与 thinkingLevelMap）解析支持的思考强度档位。
 */
export function calculateSupportedThinkingLevels(modelDef?: {
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
}): string[] {
	if (!modelDef) {
		return ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	}
	if (modelDef.reasoning === false) {
		return ["off"];
	}
	const allLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	if (modelDef.thinkingLevelMap && typeof modelDef.thinkingLevelMap === "object") {
		return allLevels.filter((lvl) => {
			const mapped = modelDef.thinkingLevelMap?.[lvl];
			if (mapped === null) return false;
			if (lvl === "xhigh" || lvl === "max") return mapped !== undefined;
			return true;
		});
	}
	// 默认具备 reasoning 能力时支持 off, minimal, low, medium, high
	return ["off", "minimal", "low", "medium", "high"];
}

/**
 * 快速同步解析指定模型的思考能力（优先 models 容器，次之 models.json / models-store.json / cachedModels）。
 */
export function resolveDurableThinkingLevels(
	modelId?: string,
	options?: {
		modelsContainer?: any;
		cachedModels?: DurableModelInfo[];
		agentDir?: string;
	},
): string[] {
	if (!modelId || !modelId.trim() || modelId === "default") {
		return ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	}
	const choice = resolveDurableModelChoice(modelId, options?.cachedModels, options?.agentDir);
	const provider = choice?.provider;
	const bareModelId = choice?.modelId;

	// 1. 尝试从已装配的 models 容器中取
	if (options?.modelsContainer && typeof options.modelsContainer.getModel === "function" && provider && bareModelId) {
		try {
			const m = options.modelsContainer.getModel(provider, bareModelId);
			if (m) {
				return calculateSupportedThinkingLevels(m);
			}
		} catch {
			/* ignore */
		}
	}

	// 2. 尝试从 models.json 中取
	try {
		const { providers } = readModelsJson(options?.agentDir);
		if (provider && providers[provider]?.models && Array.isArray(providers[provider].models)) {
			const list = providers[provider].models;
			const found = list.find((m: any) => m.id === bareModelId);
			if (found) {
				return calculateSupportedThinkingLevels(found);
			}
		}
		// 若按 provider 未匹配，遍历所有 provider 寻找裸模型 ID 匹配
		for (const pConfig of Object.values(providers)) {
			if (Array.isArray((pConfig as any)?.models)) {
				const found = (pConfig as any).models.find((m: any) => m.id === bareModelId);
				if (found) {
					return calculateSupportedThinkingLevels(found);
				}
			}
		}
	} catch {
		/* ignore */
	}

	// 3. 尝试从 models-store.json 中取
	try {
		const userAgentDir = options?.agentDir || join(homedir(), ".pi", "agent");
		const storePath = join(userAgentDir, "models-store.json");
		if (existsSync(storePath)) {
			const store = JSON.parse(readFileSync(storePath, "utf8"));
			if (provider && Array.isArray(store[provider]?.models)) {
				const found = store[provider].models.find((m: any) => m.id === bareModelId);
				if (found) {
					return calculateSupportedThinkingLevels(found);
				}
			}
			// 若按 provider 未匹配，遍历 store 所有 provider 寻找裸模型 ID 匹配
			for (const pData of Object.values(store)) {
				if (Array.isArray((pData as any)?.models)) {
					const found = (pData as any).models.find((m: any) => m.id === bareModelId);
					if (found) {
						return calculateSupportedThinkingLevels(found);
					}
				}
			}
		}
	} catch {
		/* ignore */
	}

	// 4. 尝试从 cachedModels 中取
	if (options?.cachedModels && options.cachedModels.length > 0) {
		const found = options.cachedModels.find(
			(m) =>
				m.id === modelId ||
				m.id.endsWith(`/${bareModelId}`) ||
				(provider && m.provider === provider && m.id.endsWith(bareModelId!)),
		);
		if (found && found.reasoning === false) {
			return ["off"];
		}
	}

	// 未明确识别或通用兜底
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
}
