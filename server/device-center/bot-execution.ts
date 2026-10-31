import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { LocalBot } from "./bots.js";

/** Process-local authority. Never accept a Bot configuration or capability over WS. */
export interface BotExecutionCapability {
	readonly bot: Readonly<LocalBot>;
	readonly authorizedResumePath?: string;
	assertActive(): void;
	allowsTool(name: string): boolean;
	filterSkills<T extends { name: string }>(skills: T[]): T[];
	captureModel(fallback: string | undefined): { provider: string; modelId: string };
	revoke(): void;
}
const bindings = new Map<string, BotExecutionCapability>();
// These tools can create unconstrained execution contexts or mutate host policy.
const barred = new Set([
	"conversation",
	"subagent",
	"worktree",
	"canvas",
	"mcp",
	"tool_manage",
	"codemode",
	"load_tools",
	"browser_page",
	"delegate_task",
	"schedule",
	"mcp_manage",
	"sandbox",
	"team",
	"tool_search",
]);

/** Shared by execution authorization and the selectable capability catalog. */
export function isBotToolAllowed(name: string): boolean {
	return !barred.has(name) && !name.startsWith("subagent_") && !name.startsWith("team_");
}

export function registerBotExecution(
	bot: LocalBot,
	authorizedResumePath?: string,
): {
	clientId: string;
	capability: BotExecutionCapability;
	release(): void;
} {
	if (!bot?.enabled || !bot.id || !isAbsolute(bot.cwd) || !Number.isSafeInteger(bot.revision)) {
		throw new Error("An enabled, versioned local Bot with an absolute cwd is required");
	}
	if (authorizedResumePath !== undefined && !isAbsolute(authorizedResumePath))
		throw new Error("Resume path must be absolute");
	const snapshot = structuredClone(bot);
	snapshot.cwd = resolve(snapshot.cwd);
	Object.freeze(snapshot.tools);
	Object.freeze(snapshot.skills);
	Object.freeze(snapshot.mcpServers);
	if (snapshot.model) Object.freeze(snapshot.model);
	Object.freeze(snapshot);
	let active = true;
	let model = snapshot.model;
	const tools = new Set(snapshot.tools);
	const skills = new Set(snapshot.skills);
	const capability: BotExecutionCapability = {
		bot: snapshot,
		authorizedResumePath,
		assertActive() {
			if (!active) throw new Error("Bot execution capability has been revoked");
		},
		allowsTool(name) {
			return active && tools.has(name) && isBotToolAllowed(name);
		},
		filterSkills(items) {
			this.assertActive();
			return items.filter((item) => skills.has(item.name));
		},
		captureModel(fallback) {
			this.assertActive();
			if (!model) {
				const slash = fallback?.indexOf("/") ?? -1;
				if (!fallback || slash <= 0 || slash === fallback.length - 1) {
					throw new Error("Bot requires an explicit local default model");
				}
				model = Object.freeze({ provider: fallback.slice(0, slash), modelId: fallback.slice(slash + 1) });
			}
			return model;
		},
		revoke() {
			active = false;
		},
	};
	const clientId = `device-task-${randomUUID()}`;
	bindings.set(clientId, capability);
	return {
		clientId,
		capability,
		release() {
			capability.revoke();
			bindings.delete(clientId);
		},
	};
}

/** A binding is removed only after the executor confirms its task has stopped. */
export function isBotExecutionRegistered(clientId: string): boolean {
	return bindings.has(clientId);
}

/** Unregistered private IDs fail closed, including after a server restart. */
export function getBotExecution(clientId: string): BotExecutionCapability | undefined {
	const binding = bindings.get(clientId);
	if (!binding && clientId.startsWith("device-task-")) throw new Error("Unregistered Bot execution client");
	return binding;
}

/** Executor uses only this control surface; all other public WS commands are denied. */
export function botExecutionMessageAllowed(clientId: string, type: string, message?: unknown): boolean {
	const capability = getBotExecution(clientId);
	if (!capability) return true;
	if (["abort", "get_state", "pong"].includes(type)) return true;
	try {
		capability.assertActive();
	} catch {
		return false;
	}
	if (type === "switch_session")
		return (
			!!capability.authorizedResumePath &&
			!!message &&
			typeof message === "object" &&
			"path" in message &&
			message.path === capability.authorizedResumePath
		);
	return ["hello", "new_chat", "prompt"].includes(type);
}
