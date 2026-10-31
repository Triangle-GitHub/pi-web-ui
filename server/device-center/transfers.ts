import express, { type Express } from "express";
import type { IncomingMessage } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Device, DeviceHubStore } from "./store.js";
import { DEVICE_FILE_SYNC_LIMITS } from "./file-sync.js";

export type TransferRelay = {
	callDevice(
		id: string,
		action: "transfer_stage" | "transfer_preview" | "transfer_apply",
		payload: unknown,
		options?: { signal?: AbortSignal },
	): Promise<unknown>;
};
type Authenticate = (
	req: IncomingMessage,
) => Promise<{ device: Pick<Device, "id" | "accountId">; account: { id: string } } | undefined>;
type Receipt = {
	id: string;
	sourceDeviceId: string;
	sourceBotId: string;
	targetBotId: string;
	sourceBotRevision: number;
	targetBotRevision: number;
	accountId: string;
	roomId: string;
	targetDeviceId: string;
	localTransferId: string;
	roomMembers: string;
	expiresAt: number;
	applyStarted?: boolean;
};
type Options = {
	app: Express;
	dataDir: string;
	relay: TransferRelay;
	hub?: { store: DeviceHubStore; authenticateAgent: Authenticate };
	store?: DeviceHubStore;
	authenticateAgent?: Authenticate;
};
function membership(ids: string[]) {
	return createHash("sha256")
		.update(JSON.stringify([...ids].sort()))
		.digest("hex");
}
const TTL = 24 * 60 * 60 * 1000;
const MAX_RECEIPTS = 1000;
const MAX_PACKET = 12 * 1024 * 1024;
function fail(status: number, message: string): never {
	throw Object.assign(new Error(message), { status });
}
function field(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256;
}
/** Never forward opaque device responses (which could contain file data or credentials). */
export function transferSummary(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const source = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const key of ["revision", "totalBytes", "version"]) {
		if (typeof source[key] === "number" || typeof source[key] === "string") result[key] = source[key];
	}
	for (const key of ["applied", "unchanged"]) {
		if (Array.isArray(source[key]))
			result[key] = source[key].filter((v): v is string => typeof v === "string").slice(0, 200);
	}
	for (const key of ["files", "rejected"]) {
		if (!Array.isArray(source[key])) continue;
		result[key] = source[key].slice(0, 200).map((item: unknown) => {
			const entry: Record<string, unknown> = {};
			if (item && typeof item === "object")
				for (const k of ["path", "size", "sha256", "baseline", "status"]) {
					const v = (item as Record<string, unknown>)[k];
					if (typeof v === "string" || typeof v === "number" || v === null) entry[k] = v;
				}
			return entry;
		});
	}
	if (Number.isSafeInteger(source.totalExcluded) && (source.totalExcluded as number) >= 0)
		result.totalExcluded = source.totalExcluded;
	if (Array.isArray(source.exclusions)) {
		const exclusions: { path: string; reason: "ignored" | "sensitive" }[] = [];
		let bytes = 2; // JSON array brackets, including UTF-8 path bytes and escaping.
		for (const item of source.exclusions.slice(0, DEVICE_FILE_SYNC_LIMITS.exclusions)) {
			if (!item || typeof item !== "object") continue;
			const { path, reason } = item;
			if (
				typeof path !== "string" ||
				!path ||
				Buffer.byteLength(path) > 1024 ||
				Buffer.from(path).toString("utf8") !== path ||
				path.normalize("NFC") !== path ||
				/[\\:\x00-\x1f\x7f<>"|?*]/.test(path) ||
				path.split("/").length > 32 ||
				path
					.split("/")
					.some(
						(part) =>
							!part ||
							part === "." ||
							part === ".." ||
							/[. ]$/.test(part) ||
							Buffer.byteLength(part) > 255 ||
							/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
					) ||
				(reason !== "ignored" && reason !== "sensitive")
			)
				continue;
			const entry = { path, reason };
			const additional = Buffer.byteLength(JSON.stringify(entry)) + (exclusions.length ? 1 : 0);
			if (bytes + additional > DEVICE_FILE_SYNC_LIMITS.exclusionBytes) break;
			bytes += additional;
			exclusions.push(entry);
		}
		result.exclusions = exclusions;
	}
	for (const key of ["manifest", "preview"])
		if (source[key] && typeof source[key] === "object") result[key] = transferSummary(source[key]);
	return result;
}

/** Await installation before serving requests: receipts are loaded before authorization is published. */
export async function installDeviceTransfers(options: Options) {
	const store = options.hub?.store ?? options.store;
	const authenticate = options.hub?.authenticateAgent ?? options.authenticateAgent;
	if (!store || !authenticate) throw new Error("Transfer authorization unavailable");
	const path = join(options.dataDir, "device-transfers.json");
	let receipts: Receipt[] = [];
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!Array.isArray(parsed) || parsed.length > MAX_RECEIPTS) throw new Error("Invalid transfer receipts");
		for (const row of parsed) {
			if (
				!row ||
				![
					row.id,
					row.sourceBotId,
					row.targetBotId,
					row.sourceDeviceId,
					row.accountId,
					row.roomId,
					row.targetDeviceId,
					row.localTransferId,
				].every(field) ||
				!field(row.roomMembers) ||
				!Number.isSafeInteger(row.sourceBotRevision) ||
				!Number.isSafeInteger(row.targetBotRevision) ||
				!Number.isFinite(row.expiresAt) ||
				(row.applyStarted !== undefined && typeof row.applyStarted !== "boolean")
			)
				throw new Error("Invalid transfer receipts");
		}
		receipts = parsed.filter((row: Receipt) => row.expiresAt > Date.now());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Transfer receipt storage unavailable");
	}
	let queue: Promise<unknown> = Promise.resolve();
	function transact<T>(fn: (draft: Receipt[]) => T): Promise<T> {
		const job = queue.then(async () => {
			const draft = structuredClone(receipts.filter((row) => row.expiresAt > Date.now()));
			const result = fn(draft);
			await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
			const temp = `${path}.${randomUUID()}.tmp`;
			try {
				const handle = await open(temp, "wx", 0o600);
				try {
					await handle.writeFile(JSON.stringify(draft));
					await handle.sync();
				} finally {
					await handle.close();
				}
				await rename(temp, path);
			} finally {
				await unlink(temp).catch(() => {});
			}
			receipts = draft;
			return result;
		});
		queue = job.catch(() => {});
		return job;
	}
	let inFlight = 0;
	const devices = new Set<string>();
	options.app.post(
		"/api/agent/transfers",
		express.json({ limit: MAX_PACKET, strict: true, inflate: false }),
		async (req, res) => {
			const controller = new AbortController();
			const abort = () => controller.abort();
			req.once("aborted", abort);
			res.once("close", abort);
			const timer = setTimeout(abort, 60000);
			timer.unref();
			let sourceId: string | undefined;
			try {
				const auth = await authenticate(req);
				controller.signal.throwIfAborted();
				if (!auth) fail(401, "Device authentication required");
				const body = req.body;
				if (
					!body ||
					Buffer.byteLength(JSON.stringify(body)) > MAX_PACKET ||
					!["stage", "preview", "apply"].includes(body.action) ||
					!field(body.roomId) ||
					!field(body.sourceBotId) ||
					!field(body.targetBotId)
				)
					fail(400, "Invalid transfer request");
				const initial = store.snapshot();
				const sourceHash = initial.devices.find((d) => d.id === auth.device.id)?.credentialHash;
				const sourceBot = initial.bots.find((b) => b.id === body.sourceBotId);
				const targetBot = initial.bots.find((b) => b.id === body.targetBotId);
				const targetDeviceId = targetBot?.deviceId;
				const roomMembers = membership(initial.rooms.find((r) => r.id === body.roomId)?.botIds ?? []);
				const authorize = () => {
					const state = store.snapshot();
					const source = state.devices.find((d) => d.id === auth.device.id);
					const target = state.devices.find((d) => d.id === targetDeviceId);
					const currentSource = state.bots.find((b) => b.id === body.sourceBotId);
					const currentTarget = state.bots.find((b) => b.id === body.targetBotId);
					const room = state.rooms.find((r) => r.id === body.roomId && r.accountId === auth.account.id);
					if (
						!source ||
						source.accountId !== auth.account.id ||
						source.credentialHash !== sourceHash ||
						!target ||
						target.accountId !== auth.account.id ||
						!room ||
						!currentSource?.enabled ||
						!currentTarget?.enabled ||
						currentSource.deviceId !== source.id ||
						currentTarget.deviceId !== target.id ||
						currentSource.accountId !== auth.account.id ||
						currentTarget.accountId !== auth.account.id ||
						currentSource.revision !== sourceBot?.revision ||
						currentTarget.revision !== targetBot?.revision ||
						!room.botIds.includes(currentSource.id) ||
						!room.botIds.includes(currentTarget.id) ||
						membership(room.botIds) !== roomMembers
					)
						fail(403, "Transfer access denied");
				};
				authorize();
				if (inFlight >= 4 || devices.has(auth.device.id)) fail(429, "Transfer busy");
				sourceId = auth.device.id;
				devices.add(sourceId);
				inFlight++;
				let receipt: Receipt;
				let result: unknown;
				if (body.action === "stage") {
					if (!body.bundle || typeof body.bundle !== "object") fail(400, "Bundle required");
					await queue;
					if (receipts.filter((r) => r.expiresAt > Date.now()).length >= MAX_RECEIPTS)
						fail(429, "Transfer receipt limit reached");
					result = await options.relay.callDevice(
						targetDeviceId!,
						"transfer_stage",
						{
							roomId: body.roomId,
							sourceBotId: body.sourceBotId,
							targetBotId: body.targetBotId,
							sourceBotRevision: sourceBot!.revision,
							targetBotRevision: targetBot!.revision,
							bundle: body.bundle,
						},
						{ signal: controller.signal },
					);
					controller.signal.throwIfAborted();
					authorize();
					const local = result as { id?: unknown; transferId?: unknown };
					const localId = local?.transferId ?? local?.id;
					if (!field(localId)) fail(502, "Invalid device transfer response");
					receipt = {
						id: randomUUID(),
						sourceDeviceId: auth.device.id,
						accountId: auth.account.id,
						roomId: body.roomId,
						targetDeviceId: targetDeviceId!,
						sourceBotId: sourceBot!.id,
						targetBotId: targetBot!.id,
						sourceBotRevision: sourceBot!.revision,
						targetBotRevision: targetBot!.revision,
						localTransferId: localId,
						roomMembers,
						expiresAt: Date.now() + TTL,
					};
					await transact((draft) => {
						if (draft.length >= MAX_RECEIPTS) fail(429, "Transfer receipt limit reached");
						draft.push(receipt);
					});
				} else {
					if (!field(body.transferId)) fail(400, "Transfer ID required");
					await queue;
					const found = receipts.find(
						(r) =>
							r.id === body.transferId &&
							r.expiresAt > Date.now() &&
							r.sourceDeviceId === auth.device.id &&
							r.accountId === auth.account.id &&
							r.roomId === body.roomId &&
							r.targetDeviceId === targetDeviceId &&
							r.sourceBotId === sourceBot!.id &&
							r.targetBotId === targetBot!.id &&
							r.sourceBotRevision === sourceBot!.revision &&
							r.targetBotRevision === targetBot!.revision &&
							r.roomMembers === roomMembers,
					);
					if (!found) fail(403, "Transfer access denied");
					receipt = { ...found };
					if (body.action === "apply") {
						if (
							!field(body.revision) ||
							!Array.isArray(body.overwritePaths) ||
							body.overwritePaths.length > 200 ||
							!body.overwritePaths.every((p: unknown) => typeof p === "string" && p.length > 0 && p.length <= 4096)
						)
							fail(400, "Explicit revision and overwrite paths required");
						// Persist consumption before the side effect. A lost response must never replay apply.
						await transact((draft) => {
							const row = draft.find((r) => r.id === receipt.id);
							if (!row || row.applyStarted) fail(409, "Apply already attempted; stage a new transfer");
							row.applyStarted = true;
						});
					}
					controller.signal.throwIfAborted();
					authorize();
					result = await options.relay.callDevice(
						receipt.targetDeviceId,
						body.action === "apply" ? "transfer_apply" : "transfer_preview",
						{
							roomId: receipt.roomId,
							sourceBotId: receipt.sourceBotId,
							targetBotId: receipt.targetBotId,
							sourceBotRevision: receipt.sourceBotRevision,
							targetBotRevision: receipt.targetBotRevision,
							transferId: receipt.localTransferId,
							...(body.action === "apply" ? { revision: body.revision, overwritePaths: body.overwritePaths } : {}),
						},
						{ signal: controller.signal },
					);
					controller.signal.throwIfAborted();
					authorize();
				}
				res.json({ ...transferSummary(result), transferId: receipt.id });
			} catch (error) {
				if (!res.destroyed && !res.headersSent) {
					const status = controller.signal.aborted ? 504 : ((error as { status?: number }).status ?? 502);
					res.status(status).json({
						error:
							status === 502
								? "Device transfer failed"
								: status === 504
									? "Transfer cancelled or timed out"
									: status === 403
										? "Transfer access denied"
										: status === 409
											? "Apply already attempted; stage a new transfer"
											: "Transfer request rejected",
					});
				}
			} finally {
				clearTimeout(timer);
				req.off("aborted", abort);
				res.off("close", abort);
				if (sourceId) {
					devices.delete(sourceId);
					inFlight--;
				}
			}
		},
	);
}
