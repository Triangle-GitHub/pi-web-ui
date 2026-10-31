import { isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { writeJsonAtomicSync } from "../atomic-file.js";
import { createDeviceCollabService } from "./collab-service.js";
import { createDeviceTaskExecutor, type DeviceExecutorTask, type DeviceTaskExecutorOptions } from "./executor.js";
import { createDeviceFileSync } from "./file-sync.js";
import { DeviceTaskError } from "./task-error.js";
import type { LocalBotRegistry } from "./bots.js";

type Config = { hubUrl: string; deviceId: string; credential: string; allowExecution: boolean };
type Files = ReturnType<typeof createDeviceFileSync>;
type Executor = { run(task: DeviceExecutorTask): Promise<string>; close(): void | Promise<void> };
type Owner = { roomId: string; taskId: string; root: string; botId: string };
type TaskOwner = { controller: AbortController; executor?: Executor; done?: Promise<unknown> };
type Transcript = { binding: string; path: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_WAITING_TASKS = 32;

/** The task settled, but its executor has not confirmed that execution stopped. */
export class DeviceTaskStopUnconfirmedError extends Error {
	readonly stopUnconfirmed = true;
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : "Task executor stop unconfirmed", { cause });
		this.name = "DeviceTaskStopUnconfirmedError";
	}
}

export function createDeviceRuntime(options: {
	config: Config;
	localOrigin: string;
	localAuthToken?: string;
	dataDir?: string;
	bots: LocalBotRegistry;
	executorFactory?: (options: DeviceTaskExecutorOptions) => Executor;
}) {
	const { config, bots } = options;
	const sessions = new Map<string, Owner>();
	const files = new Map<string, { roomId: string; botId: string; revision: string; files: Files }>();
	const receipts = new Map<string, { roomId: string; botId: string; revision: string; files: Files }>();
	const operations = new Set<Promise<unknown>>();
	let closed = false;
	let blocked: unknown;
	let generation = new AbortController();
	let active: TaskOwner | undefined;
	const queue: { start(): void; cancel(): void }[] = [];
	let draining = false;
	function drain() {
		if (draining) return;
		queue.shift()?.start();
	}
	const transcriptFile = options.dataDir ? join(options.dataDir, "bot-execution-conversations.json") : undefined;
	let transcripts: Record<string, Transcript> = Object.create(null);
	let transcriptLoadError: unknown;
	if (transcriptFile) {
		try {
			const stored: unknown = JSON.parse(readFileSync(transcriptFile, "utf8"));
			if (!stored || typeof stored !== "object" || Array.isArray(stored))
				throw new Error("Invalid transcript registry");
			for (const [id, entry] of Object.entries(stored)) {
				const value = entry as Transcript;
				if (
					!UUID.test(id) ||
					!value ||
					typeof value.binding !== "string" ||
					typeof value.path !== "string" ||
					!isAbsolute(value.path)
				)
					throw new Error("Invalid transcript registry");
			}
			transcripts = Object.assign(Object.create(null), stored);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") transcriptLoadError = error;
		}
	}
	function enabled(signal?: AbortSignal) {
		signal?.throwIfAborted();
		if (closed) throw new Error("Device runtime closed");
		if (blocked)
			throw new DeviceTaskError(
				"群任务停止状态不确定，项目已隔离。请在本机确认后重启服务。 / Task stop unconfirmed; workspace blocked until service restart.",
			);
		if (!config.allowExecution)
			throw new DeviceTaskError("目标设备未开启群任务执行权限。 / Local task execution is disabled.");
	}
	function track<T>(operation: Promise<T>): Promise<T> {
		operations.add(operation);
		void operation.finally(() => operations.delete(operation)).catch(() => {});
		return operation;
	}
	async function sweep() {
		for (const [key, entry] of files) {
			const bot = bots.get(entry.botId);
			if (bot?.enabled && `${bot.id}:${bot.revision}` === entry.revision) continue;
			files.delete(key);
			for (const [id, receipt] of receipts) if (receipt.files === entry.files) receipts.delete(id);
			await entry.files.close();
		}
	}
	async function acquire(botId: string, signal?: AbortSignal) {
		enabled(signal);
		await sweep();
		const lease = await bots.acquire(botId);
		try {
			enabled(signal);
			return lease;
		} catch (error) {
			lease.release();
			throw error;
		}
	}
	function roomFiles(roomId: string, botId: string, lease: { root: string; revision: string }) {
		const key = JSON.stringify([roomId, botId, lease.revision]);
		let entry = files.get(key);
		if (!entry) {
			if (!options.dataDir) throw new Error("File synchronization storage unavailable");
			entry = {
				roomId,
				botId,
				revision: lease.revision,
				files: createDeviceFileSync({
					root: lease.root,
					dataDir: options.dataDir,
					allowReceive: config.allowExecution,
				}),
			};
			files.set(key, entry);
		}
		return entry;
	}
	const service = createDeviceCollabService({
		getConfig: () => (closed ? undefined : config),
		getParentTask: (context) => (context?.sessionId ? sessions.get(context.sessionId)?.taskId : undefined),
		getSourceBot: (context) => (context?.sessionId ? sessions.get(context.sessionId)?.botId : undefined),
		async workspaceResolver({ roomId, sourceBotId, context, signal }) {
			const boundSignal = AbortSignal.any([generation.signal, ...(signal ? [signal] : [])]);
			const lease = await acquire(sourceBotId, boundSignal);
			try {
				const owner = context.sessionId ? sessions.get(context.sessionId) : undefined;
				if (
					!owner ||
					resolve(context.cwd) !== resolve(lease.root) ||
					(roomId && owner.roomId !== roomId) ||
					owner.root !== lease.root ||
					owner.botId !== sourceBotId
				)
					throw new Error("Task workspace ownership mismatch");
				return { ...lease, botId: sourceBotId, files: roomFiles(roomId, sourceBotId, lease).files };
			} catch (error) {
				lease.release();
				throw error;
			}
		},
	});
	const collabService: typeof service = {
		execute(action, args, signal, context) {
			if (action === "send_task" && (!context?.sessionId || sessions.get(context.sessionId)?.roomId !== args.roomId))
				return Promise.reject(new Error("Task session is not bound to this room"));
			const commandSignal = AbortSignal.any([generation.signal, ...(signal ? [signal] : [])]);
			return track(service.execute(action, args, commandSignal, context));
		},
	};
	function onTask(task: DeviceExecutorTask & { roomId: string }, signal?: AbortSignal): Promise<string> {
		try {
			enabled(signal);
			if (queue.length >= MAX_WAITING_TASKS) throw new DeviceTaskError("Local task queue full");
		} catch (error) {
			return Promise.reject(error);
		}
		const taskSignal = AbortSignal.any([generation.signal, ...(signal ? [signal] : [])]);
		return track(
			new Promise<string>((resolve, reject) => {
				const entry = {
					start() {
						taskSignal.removeEventListener("abort", entry.cancel);
						draining = true;
						void runTask(task, taskSignal)
							.then(resolve, reject)
							.finally(() => {
								draining = false;
								drain();
							});
					},
					cancel() {
						const index = queue.indexOf(entry);
						if (index >= 0) queue.splice(index, 1);
						taskSignal.removeEventListener("abort", entry.cancel);
						reject(taskSignal.reason);
					},
				};
				queue.push(entry);
				taskSignal.addEventListener("abort", entry.cancel, { once: true });
				if (taskSignal.aborted) entry.cancel();
				else drain();
			}),
		);
	}
	function runTask(task: DeviceExecutorTask & { roomId: string }, signal?: AbortSignal): Promise<string> {
		try {
			enabled(signal);
		} catch (error) {
			return Promise.reject(error);
		}

		const owner: TaskOwner = { controller: new AbortController() };
		active = owner;
		const taskSignal = AbortSignal.any([owner.controller.signal, generation.signal, ...(signal ? [signal] : [])]);
		const operation = (async () => {
			let lease: Awaited<ReturnType<typeof acquire>> | undefined;
			let stopping: Promise<void> | undefined;
			const stop = () => {
				if (!stopping) stopping = Promise.resolve().then(() => owner.executor?.close());
				void stopping.catch(() => {});
			};
			const confirmStop = async () => {
				stop();
				try {
					await stopping;
				} catch (error) {
					const failure =
						error instanceof DeviceTaskStopUnconfirmedError ? error : new DeviceTaskStopUnconfirmedError(error);
					blocked = failure;
					throw failure;
				}
			};
			try {
				if (!task.roomId) throw new DeviceTaskError("Task room required");
				try {
					if (task.deviceId !== config.deviceId || !task.botId) throw new Error("Task Bot route mismatch");
					lease = await acquire(task.botId, taskSignal);
					if (task.botRevision !== lease.bot.revision) throw new Error("Task Bot revision mismatch");
				} catch (error) {
					if (taskSignal.aborted) throw error;
					throw new DeviceTaskError("目标 Bot 不可用、配置已变更或正在忙碌。 / Target Bot unavailable or busy.");
				}
				let binding: string | undefined;
				let resumePath: string | undefined;
				let transcriptPath: string | undefined;
				let boundSession: string | undefined;
				if (task.resume !== undefined && typeof task.resume !== "boolean")
					throw new DeviceTaskError("Invalid resume flag");
				if (task.resume && !task.conversationId) throw new DeviceTaskError("Resume conversation address required");
				if (task.conversationId !== undefined) {
					if (!UUID.test(task.conversationId) || !transcriptFile || transcriptLoadError)
						throw new DeviceTaskError("Persistent conversation storage unavailable or invalid address");
					binding = createHash("sha256")
						.update(
							JSON.stringify([
								config.hubUrl,
								config.deviceId,
								task.roomId,
								lease.bot.id,
								lease.bot.revision,
								resolve(lease.root),
							]),
						)
						.digest("hex");
					const stored = transcripts[task.conversationId];
					if (task.resume) {
						if (!stored || stored.binding !== binding)
							throw new DeviceTaskError("Conversation unavailable or configuration changed");
						try {
							if (!statSync(stored.path).isFile()) throw new Error();
						} catch {
							throw new DeviceTaskError("Conversation transcript unavailable");
						}
						resumePath = stored.path;
					} else if (stored) throw new DeviceTaskError("Conversation already exists; explicit resume required");
				}
				owner.executor = (options.executorFactory ?? createDeviceTaskExecutor)({
					localOrigin: options.localOrigin,
					localAuthToken: options.localAuthToken,
					cwd: lease.root,
					bot: lease.bot,
					allowExecution: config.allowExecution,
					resumePath,
					onSessionPath(taskId, path) {
						taskSignal.throwIfAborted();
						if (
							taskId !== task.id ||
							!boundSession ||
							sessions.get(boundSession)?.taskId !== task.id ||
							!isAbsolute(path) ||
							(resumePath && path !== resumePath)
						)
							throw new Error("Transcript ownership mismatch");
						if (task.conversationId) {
							const currentBot = bots.get(task.botId);
							if (
								!binding ||
								!currentBot?.enabled ||
								currentBot.revision !== lease!.bot.revision ||
								resolve(currentBot.cwd) !== resolve(lease!.root)
							)
								throw new DeviceTaskError("Conversation transcript ownership changed");
							try {
								if (!statSync(path).isFile()) throw new Error();
								const next = { ...transcripts, [task.conversationId]: { binding, path } };
								writeJsonAtomicSync(transcriptFile!, next);
								transcripts = next;
							} catch {
								throw new DeviceTaskError("Conversation transcript persistence failed");
							}
						}
						transcriptPath = path;
					},
					onSession(taskId, sessionId) {
						if (taskId !== task.id) throw new Error("Task session ownership mismatch");
						boundSession = sessionId;
						for (const [id, bound] of sessions)
							if (bound.taskId === taskId && bound.roomId === task.roomId) sessions.delete(id);
						if (sessionId && !taskSignal.aborted)
							sessions.set(sessionId, { taskId, roomId: task.roomId, root: lease!.root, botId: task.botId });
					},
				});
				taskSignal.addEventListener("abort", stop, { once: true });
				taskSignal.throwIfAborted();
				const result = await owner.executor.run(task);
				await confirmStop();
				taskSignal.throwIfAborted();
				if (task.conversationId) {
					const currentBot = bots.get(task.botId);
					if (
						!transcriptPath ||
						!binding ||
						!currentBot?.enabled ||
						currentBot.revision !== lease.bot.revision ||
						resolve(currentBot.cwd) !== resolve(lease.root)
					)
						throw new DeviceTaskError("Conversation transcript capture failed");
				}
				return result;
			} finally {
				taskSignal.removeEventListener("abort", stop);
				await confirmStop();
				for (const [id, bound] of sessions)
					if (bound.taskId === task.id && bound.roomId === task.roomId) sessions.delete(id);
				lease?.release();
				if (active === owner) active = undefined;
			}
		})();
		owner.done = operation;
		return track(operation);
	}
	function onCommand(action: string, payload: unknown, signal: AbortSignal) {
		const commandSignal = AbortSignal.any([signal, generation.signal]);
		return track(
			(async () => {
				enabled(commandSignal);
				if (!payload || typeof payload !== "object" || Array.isArray(payload))
					throw new Error("Invalid transfer command");
				const command = payload as Record<string, unknown>;
				if (typeof command.roomId !== "string" || !command.roomId) throw new Error("Room required");
				if (typeof command.targetBotId !== "string" || !command.targetBotId) throw new Error("Target Bot required");
				const lease = await acquire(command.targetBotId, commandSignal);
				try {
					if (command.targetBotRevision !== lease.bot.revision) throw new Error("Transfer Bot revision mismatch");
					if (action === "transfer_stage") {
						const entry = roomFiles(command.roomId, command.targetBotId, lease);
						const preview = await entry.files.stage(command.bundle, { signal: commandSignal });
						commandSignal.throwIfAborted();
						receipts.set(preview.id, entry);
						return preview;
					}
					const receipt = typeof command.transferId === "string" ? receipts.get(command.transferId) : undefined;
					if (
						!receipt ||
						receipt.roomId !== command.roomId ||
						receipt.botId !== command.targetBotId ||
						receipt.revision !== lease.revision
					)
						throw new Error("Transfer workspace changed or transfer unavailable");
					if (action === "transfer_preview")
						return await receipt.files.preview(command.transferId as string, { signal: commandSignal });
					if (
						action === "transfer_apply" &&
						typeof command.revision === "string" &&
						Array.isArray(command.overwritePaths) &&
						command.overwritePaths.every((path) => typeof path === "string")
					)
						return await receipt.files.apply({
							id: command.transferId as string,
							revision: command.revision,
							decisions: Object.fromEntries(command.overwritePaths.map((path) => [path, "overwrite" as const])),
							signal: commandSignal,
						});
					throw new Error("Unsupported device command");
				} finally {
					lease.release();
				}
			})(),
		);
	}
	async function onDisconnect() {
		const previous = generation;
		generation = new AbortController();
		previous.abort();
		active?.controller.abort();
		await Promise.allSettled(operations);
		await sweep();
		if (blocked) throw blocked;
	}
	return {
		onTask,
		onCommand,
		collabService,
		onDisconnect,
		async close() {
			closed = true;
			await onDisconnect();
			await Promise.allSettled([...files.values()].map((entry) => entry.files.close()));
			files.clear();
			receipts.clear();
		},
	};
}
