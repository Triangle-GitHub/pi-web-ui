import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { DeviceCollabContext, DeviceCollabService } from "./collab-tool.js";
import type { createDeviceFileSync } from "./file-sync.js";
import { transferSummary } from "./transfers.js";
import { checkedUrl } from "./relay.js";

type Config = { hubUrl: string; deviceId: string; credential: string; allowExecution: boolean };
export function createDeviceCollabService(options: {
	getConfig: () => Config | undefined;
	root?: string;
	files?: ReturnType<typeof createDeviceFileSync>;
	workspaceResolver?: (input: {
		roomId: string;
		sourceBotId: string;
		context: DeviceCollabContext;
		signal?: AbortSignal;
	}) => Promise<{ root: string; files: ReturnType<typeof createDeviceFileSync>; release(): void }>;
	fetch?: typeof fetch;
	getParentTask?: (context?: DeviceCollabContext) => string | undefined;
	getSourceBot?: (context?: DeviceCollabContext) => string | undefined;
}): DeviceCollabService {
	const root = options.root === undefined ? undefined : resolve(options.root);
	return {
		async execute(action, args, signal, context) {
			let workspace: { root: string; files: ReturnType<typeof createDeviceFileSync>; release(): void } | undefined;
			try {
				signal?.throwIfAborted();
				if (!context) throw new Error("Invalid workspace");
				const readOnly = action === "list_bots" || action === "list_rooms";
				if (!readOnly && !args.sourceBotId) throw new Error("Source bot required");
				if (options.workspaceResolver && !["list_bots", "list_rooms", "create_room"].includes(action)) {
					if (!args.roomId) throw new Error("Room required");
					if (!args.sourceBotId) throw new Error("Source bot required");
					workspace = await options.workspaceResolver({
						roomId: args.roomId,
						sourceBotId: args.sourceBotId,
						context,
						signal,
					});
					if (resolve(context.cwd) !== resolve(workspace.root)) throw new Error("Invalid workspace");
				} else if (!options.workspaceResolver && resolve(context.cwd) !== root) throw new Error("Invalid workspace");
				const config = options.getConfig();
				if (!config || !config.deviceId || !config.credential) throw new Error("Device unavailable");
				if (!["list_bots", "list_rooms"].includes(action) && !config.allowExecution)
					throw new Error("Device execution disabled");
				const base = checkedUrl(config.hubUrl);
				if (!["http:", "https:"].includes(base.protocol) || base.search) throw new Error("Invalid hub URL");
				const parentTaskId = options.getParentTask?.(context);
				if (args.parentTaskId !== undefined && args.parentTaskId !== parentTaskId)
					throw new Error("Parent task spoofing denied");
				const boundBot = options.getSourceBot?.(context);
				if (args.sourceBotId && boundBot && args.sourceBotId !== boundBot) throw new Error("Invalid source bot");
				if (action === "create_room" && options.workspaceResolver) {
					workspace = await options.workspaceResolver({ roomId: "", sourceBotId: args.sourceBotId!, context, signal });
					if (resolve(context.cwd) !== resolve(workspace.root)) throw new Error("Invalid workspace");
				}
				const request = async (path: string, body?: unknown, query?: URLSearchParams) => {
					signal?.throwIfAborted();
					const url = new URL(base.href);
					url.pathname = `${url.pathname.replace(/\/$/, "")}/api/agent/${path}`;
					if (query) url.search = query.toString();
					const response = await (options.fetch ?? fetch)(url, {
						method: body === undefined ? "GET" : "POST",
						headers: {
							authorization: `Bearer ${config.credential}`,
							"X-Device-Id": config.deviceId,
							...(body === undefined ? {} : { "Content-Type": "application/json" }),
						},
						body: body === undefined ? undefined : JSON.stringify(body),
						signal,
						redirect: "error",
					});
					if (!response.ok) throw new Error("Hub request failed");
					const result: unknown = await response.json();
					signal?.throwIfAborted();
					return result;
				};
				const room = () => {
					if (!args.roomId) throw new Error("Room required");
					return `rooms/${encodeURIComponent(args.roomId)}`;
				};
				switch (action) {
					case "list_bots": {
						const result = (await request("bots")) as { bots?: { deviceId: string }[] };
						return { bots: result.bots?.map((bot) => ({ ...bot, local: bot.deviceId === config.deviceId })) ?? [] };
					}
					case "list_rooms":
						return await request("rooms");
					case "read_history": {
						if (
							args.before !== undefined &&
							(typeof args.before !== "string" || !args.before.trim() || args.before.length > 256)
						)
							throw new Error("Invalid history cursor");
						const query = new URLSearchParams({ sourceBotId: args.sourceBotId! });
						if (args.before !== undefined) query.set("before", args.before);
						return await request(`${room()}/history`, undefined, query);
					}
					case "create_room":
						if (!args.targetBotId) throw new Error("Target required");
						return await request("rooms", {
							name: args.name,
							sourceBotId: args.sourceBotId,
							botIds: [...new Set([args.sourceBotId, args.targetBotId])],
						});
					case "send_message":
						return await request(`${room()}/messages`, { text: args.message, sourceBotId: args.sourceBotId });
					case "send_task":
						if (!args.targetBotId) throw new Error("Target required");
						return await request(`${room()}/messages`, {
							text: args.prompt,
							sourceBotId: args.sourceBotId,
							targetBotIds: [args.targetBotId],
							idempotencyKey: randomUUID(),
							...(parentTaskId ? { parentTaskId } : {}),
						});
					case "conversation_list":
					case "conversation_read": {
						if (action === "conversation_read" && !args.conversationId) throw new Error("Conversation required");
						const suffix = action === "conversation_read" ? `/${encodeURIComponent(args.conversationId!)}` : "";
						const query = new URLSearchParams({ sourceBotId: args.sourceBotId! });
						if (action === "conversation_read" && args.before !== undefined) {
							if (typeof args.before !== "string" || !args.before.trim() || args.before.length > 256)
								throw new Error("Invalid conversation cursor");
							query.set("before", args.before);
						}
						return await request(`${room()}/conversations${suffix}`, undefined, query);
					}
					case "conversation_stop":
						if (!args.conversationId) throw new Error("Conversation required");
						return await request(`${room()}/conversations/${encodeURIComponent(args.conversationId)}/stop`, {
							sourceBotId: args.sourceBotId,
						});
					case "conversation_create":
						if (!args.targetBotId || !args.prompt) throw new Error("Conversation fields required");
						return await request(`${room()}/conversations`, {
							targetBotId: args.targetBotId,
							text: args.prompt,
							sourceBotId: args.sourceBotId,
							parentTaskId,
							idempotencyKey: args.idempotencyKey ?? randomUUID(),
						});
					case "conversation_send":
						if (
							!args.conversationId ||
							!args.message ||
							(args.kind !== undefined && !["message", "request", "reply"].includes(args.kind)) ||
							(args.kind === "reply" && !args.requestId)
						)
							throw new Error("Conversation fields required");
						return await request(`${room()}/conversations/${encodeURIComponent(args.conversationId)}/messages`, {
							text: args.message,
							sourceBotId: args.sourceBotId,
							parentTaskId,
							kind: args.kind ?? "message",
							requestId: args.requestId,
							idempotencyKey: args.idempotencyKey ?? randomUUID(),
						});
					case "sync_files": {
						if (!args.targetBotId || !args.roomId || !args.paths?.length) throw new Error("Transfer fields required");
						const files = workspace?.files ?? options.files;
						if (!files) throw new Error("File workspace unavailable");
						const bundle = await files.prepare({ paths: args.paths, signal, recursive: args.recursive });
						const response = await request("transfers", {
							action: "stage",
							roomId: args.roomId,
							sourceBotId: args.sourceBotId,
							targetBotId: args.targetBotId,
							bundle,
						});
						return {
							...summarizeTransfer(response),
							...(bundle.manifest.exclusions
								? { exclusions: bundle.manifest.exclusions, totalExcluded: bundle.manifest.totalExcluded }
								: {}),
						};
					}
					case "transfer_preview":
					case "transfer_apply": {
						if (!args.roomId || !args.targetBotId || !args.transferId) throw new Error("Transfer fields required");
						if (action === "transfer_apply" && (!args.revision || !Array.isArray(args.overwritePaths)))
							throw new Error("Explicit apply required");
						return summarizeTransfer(
							await request("transfers", {
								action: action === "transfer_apply" ? "apply" : "preview",
								roomId: args.roomId,
								sourceBotId: args.sourceBotId,
								targetBotId: args.targetBotId,
								transferId: args.transferId,
								...(action === "transfer_apply"
									? { revision: args.revision, overwritePaths: args.overwritePaths }
									: {}),
							}),
						);
					}
					default:
						throw new Error("Unsupported collaboration action");
				}
			} catch {
				// Remote errors, URLs, fetch errors and local file errors may contain secrets.
				throw new Error(signal?.aborted ? "Device collaboration cancelled." : "Device collaboration request failed.");
			} finally {
				workspace?.release();
			}
		},
	};
}
function summarizeTransfer(value: unknown) {
	const id = value && typeof value === "object" ? (value as { transferId?: unknown }).transferId : undefined;
	return { ...transferSummary(value), ...(typeof id === "string" ? { transferId: id } : {}) };
}
