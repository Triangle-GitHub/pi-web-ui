import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { chunkMarkdownText } from "./markdown-chunks.mjs";
import { MEDIA_TYPES, receiveMedia } from "./media.mjs";

export function sessionKey(event) {
	return JSON.stringify([event.from || event.sender || "", event.groupId || event.chatId || "", event.threadId || ""]);
}

function commandName(text) {
	return text.trim().split(/\s+/, 1)[0].normalize("NFKC").toLowerCase();
}

export class WhatsappBotBridge {
	constructor({ host, getConfig, log, api, payload, extractText, stripMarkers, accountId } = {}) {
		Object.assign(this, { host, getConfig, api, payload, extractText, stripMarkers, accountId });
		this.log = log || (() => {});
		this.running = false;
		this.generation = 0;
		this.seenMessageIds = new Set();
		this.pendingRuns = new Map();
		this.earlyRuns = new Map();
		this.dispatching = 0;
		this.sessions = new Map();
		this.queues = new Map();
		this.inboundEpochs = new Map();
		this.status = {
			enabled: false,
			connected: false,
			state: "idle",
			displayPhone: "",
			messagesReceived: 0,
			messagesReplied: 0,
			lastMessageAt: null,
			lastReplyAt: null,
			lastError: null,
		};
	}
	getStatus() {
		return { ...this.status };
	}
	async reply(to, text) {
		const cfg = this.getConfig();
		try {
			await this.api(cfg.accessToken, cfg.phoneNumberId, "/messages", this.payload(to, text));
			this.status.messagesReplied++;
			this.status.lastReplyAt = Date.now();
		} catch (err) {
			this.status.lastError = err.message;
			this.log("error", `WhatsApp reply delivery failed: ${err.message}`);
			this.host.notify?.("error", `WhatsApp reply delivery failed: ${err.message}`);
		}
	}
	async start() {
		if (this.running) return;
		const generation = ++this.generation;
		this.running = true;
		this.status.enabled = true;
		this.status.state = "connecting";
		const cfg = this.getConfig();
		try {
			if (!cfg.accessToken || !cfg.phoneNumberId) throw new Error("Missing WhatsApp credentials");
			const info = await this.api(cfg.accessToken, cfg.phoneNumberId, "", null, { method: "GET", timeoutMs: 10000 });
			if (generation !== this.generation) return;
			this.status.displayPhone = info.display_phone_number || info.verified_name || cfg.phoneNumberId;
			this.offRunEvent = this.host.onRunEvent?.((ev) => this.handleRunEvent(ev));
			Object.assign(this.status, { connected: true, state: "connected", lastError: null });
		} catch (err) {
			if (generation !== this.generation) return;
			this.running = false;
			Object.assign(this.status, { connected: false, state: "error", lastError: err.message });
		}
	}
	async stop() {
		this.generation++;
		this.running = false;
		this.offRunEvent?.();
		this.offRunEvent = null;
		for (const run of this.pendingRuns.values()) clearTimeout(run.timer);
		this.pendingRuns.clear();
		this.earlyRuns.clear();
		Object.assign(this.status, { enabled: false, connected: false, state: "idle" });
	}
	async onInboundMessage(event) {
		if (!event) return;
		const key = sessionKey(event);
		// Serialize a peer's configuration and dispatch; control commands must interrupt a pending dispatch.
		const text = this.extractText(event).trim();
		const control = [
			"/new",
			"/clear",
			"/reset",
			"/stop",
			"/abort",
			"/model",
			"/thinking",
			"/cwd",
			"/workspace",
		].includes(commandName(text));
		const epoch = this.inboundEpochs.get(key) || 0;
		const previous = this.queues.get(key) || Promise.resolve();
		const task = control
			? this.processInbound(event, key)
			: previous
					.catch(() => {})
					.then(() => {
						if (epoch === (this.inboundEpochs.get(key) || 0)) return this.processInbound(event, key);
					});
		if (control) this.queues.delete(key);
		else this.queues.set(key, task);
		try {
			await task;
		} finally {
			if (this.queues.get(key) === task) this.queues.delete(key);
		}
	}
	async processInbound(event, key, literal = false) {
		const sender = String(event.from || event.sender || "");
		if (!sender) return;
		const id = event.id || event.messageId;
		if (id) {
			if (this.seenMessageIds.has(id)) return;
			this.seenMessageIds.add(id);
			if (this.seenMessageIds.size > 500) this.seenMessageIds.delete(this.seenMessageIds.values().next().value);
		}
		const cfg = this.getConfig();
		if (cfg.allowedUsers?.length && !cfg.allowedUsers.map(String).includes(sender))
			return this.reply(sender, "Access Restricted: contact the administrator.");
		// Cloud API supports business-to-person delivery only; never leak a claimed group/thread reply into a DM.
		if (event.groupId || (event.chatId && event.chatId !== sender) || event.threadId) {
			this.status.lastError = "WhatsApp Cloud API does not support group/thread routing";
			this.log("warn", this.status.lastError);
			return;
		}
		this.status.messagesReceived++;
		this.status.lastMessageAt = Date.now();
		let session = this.sessions.get(key);
		if (!session) {
			session = {
				accountId: this.accountId(key + randomUUID()),
				model: cfg.model || "",
				thinkingLevel: cfg.thinkingLevel || "",
				cwd: cfg.workspace || this.host.cwd || "",
			};
			this.sessions.set(key, session);
		}
		const rawText = String(event.text?.body ?? event.body ?? this.extractText(event));
		const text = literal ? rawText : rawText.trim();
		const inboundRevision = session.revision || 0;
		const inboundGeneration = this.generation;
		try {
			if (!literal && commandName(text).startsWith("/"))
				return await this.command(rawText.trimStart(), session, sender, key);
			const attachments = [];
			if (MEDIA_TYPES.includes(event.type)) {
				const saved = await receiveMedia(this.host, cfg, event);
				if (inboundRevision !== (session.revision || 0) || inboundGeneration !== this.generation) return;
				if (saved.kind === "image") {
					if (saved.size > 10 * 1024 * 1024) throw new Error("Image exceeds 10 MiB limit");
					if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(saved.mimeType))
						throw new Error(`Cannot decode image type ${saved.mimeType}`);
					attachments.push({
						path: "",
						imageData: saved.bytes.toString("base64"),
						mimeType: saved.mimeType,
						name: saved.name,
					});
				} else {
					attachments.push({
						path: "",
						fileData: saved.bytes.toString("base64"),
						mimeType: saved.mimeType,
						name: saved.name,
					});
					if (["audio", "video"].includes(saved.kind))
						await this.reply(
							sender,
							`Received ${saved.kind} file. Automatic transcription/video decoding is not available in this plugin; the file is attached as a reference. The model must report if it cannot decode it.`,
						);
				}
			}
			if (!text && !attachments.length)
				return await this.reply(sender, "Unsupported message. Send text, image, audio, document or video.");
			if (inboundRevision !== (session.revision || 0) || inboundGeneration !== this.generation) return;
			if (!this.host.onRunEvent) throw new Error("Host run events are unavailable");
			if ([...this.pendingRuns.values()].some((r) => r.session === session))
				throw new Error("A task is already running. Use /stop or wait for its reply.");
			this.dispatching++;
			const generation = this.generation;
			const revision = session.revision || 0;
			try {
				const request = {
					text: text || `Inspect the attached ${event.type}. If decoding is unavailable, say so explicitly.`,
					accountId: session.accountId,
				};
				if (attachments.length) request.attachments = attachments;
				for (const field of ["conversationId", "model", "thinkingLevel", "cwd"])
					if (session[field]) request[field] = session[field];
				const result = await this.host.chat(request);
				if (!result?.conversationId || !result?.runId)
					throw new Error("Host did not return conversationId/runId; cannot safely associate replies");
				if (generation !== this.generation || revision !== (session.revision || 0)) {
					const aborted = await this.host.abortRun?.(result.runId || result.conversationId);
					if (!aborted?.ok) {
						this.status.lastError = aborted?.error || "Host abort unavailable";
						await this.reply(sender, `Could not stop the previous task: ${this.status.lastError}`);
					}
					return;
				}
				session.conversationId = result.conversationId;
				session.runId = result.runId;
				const run = { session, revision, sender, accumulatedText: "", timer: null };
				this.pendingRuns.set(result.runId, run);
				run.timer = setTimeout(() => {
					if (this.pendingRuns.delete(result.runId))
						void this.reply(sender, "Task timed out waiting for the host. Use /stop to abort it.");
				}, 600000);
				run.timer.unref?.();
				const early = this.earlyRuns.get(result.runId) || [];
				this.earlyRuns.delete(result.runId);
				for (const ev of early) await this.handleRunEvent(ev);
			} finally {
				this.dispatching--;
				if (!this.dispatching) this.earlyRuns.clear();
			}
		} catch (err) {
			if (
				(literal || !commandName(text).startsWith("/")) &&
				(inboundRevision !== (session.revision || 0) || inboundGeneration !== this.generation)
			)
				return;
			this.status.lastError = err.message;
			await this.reply(sender, `Request failed: ${err.message}`);
		}
	}
	async command(text, session, sender, key) {
		const [raw] = text.split(/\s+/);
		const cmd = commandName(raw);
		const prompt = text.slice(raw.length).trimStart();
		const arg = prompt.trim();
		const revision = session.revision || 0;
		const value = arg.normalize("NFKC").toLowerCase();
		let reply;
		switch (cmd) {
			case "/help":
				reply =
					"WhatsApp Bot Help\n/help /new [prompt] /clear [prompt] /reset [prompt] /status /stop (/abort) /model [provider/id|default] /thinking [off|minimal|low|medium|high|xhigh|default] /cwd [absolute path]\nSettings apply on the next text message. Images are supplied as real image attachments. Audio/documents/video are file attachments; automatic transcription/video decoding depends on host tools.";
				break;
			case "/status":
				reply = `WhatsApp Bot Status: ${this.status.state}\nConversation: ${session.conversationId || "none"}\nModel: ${session.model || "host default"}\nThinking: ${session.thinkingLevel || "host default"}\nWorkspace: ${session.cwd || "host default"}\nLast error: ${this.status.lastError || "none"}`;
				break;
			case "/new":
			case "/clear":
			case "/reset": {
				const reset = this.resetSession(session, key);
				const nextRevision = session.revision;
				await reset;
				if (nextRevision !== session.revision) return;
				if (arg) return this.processInbound({ from: sender, type: "text", text: { body: prompt } }, key, true);
				reply = "Context cleared. The next message starts a fresh conversation.";
				break;
			}
			case "/stop":
			case "/abort": {
				this.inboundEpochs.set(key, (this.inboundEpochs.get(key) || 0) + 1);
				session.revision = (session.revision || 0) + 1;
				if (!session.conversationId) {
					reply = "Stop requested. Any pending download or dispatch will be cancelled before model delivery.";
					break;
				}
				const target = session.runId || session.conversationId;
				this.forgetRuns(session);
				delete session.runId;
				const result = await this.host.abortRun?.(target);
				if (!result?.ok) throw new Error(result?.error || "Host abort unavailable");
				reply = "Stop requested.";
				break;
			}
			case "/model":
				if (arg && value !== "default" && !/^[^\s/]+\/\S+$/.test(arg))
					throw new Error("Use /model provider/id or /model default");
				if (arg) {
					session.model = value === "default" ? this.getConfig().model || "" : arg;
					await this.resetSession(session, key);
				}
				reply = `Model: ${session.model || "host default"}${arg ? " (requested for next message; host validates on dispatch)" : ""}`;
				break;
			case "/thinking":
				if (arg && !["off", "minimal", "low", "medium", "high", "xhigh", "default"].includes(value))
					throw new Error("Unsupported thinking level");
				if (arg) {
					session.thinkingLevel = value === "default" ? this.getConfig().thinkingLevel || "" : value;
					await this.resetSession(session, key);
				}
				reply = `Thinking: ${session.thinkingLevel || "host default"}${arg ? " (requested for next message)" : ""}`;
				break;
			case "/cwd":
			case "/workspace":
				if (arg) {
					const cwd = value === "default" ? this.getConfig().workspace || this.host.cwd || "" : arg;
					if (!isAbsolute(cwd)) throw new Error("Workspace must be an absolute path");
					const stat = await this.host.fs?.statPath(cwd);
					if (revision !== (session.revision || 0)) return;
					if (stat?.type !== "dir") throw new Error("Workspace must be an existing authorized directory");
					session.cwd = cwd;
					await this.resetSession(session, key);
				}
				reply = `Workspace: ${session.cwd || "host default"}`;
				break;
			default:
				reply = `Unknown command: ${raw}. Use /help.`;
		}
		await this.reply(sender, reply);
	}
	async resetSession(session, key) {
		this.inboundEpochs.set(key, (this.inboundEpochs.get(key) || 0) + 1);
		session.revision = (session.revision || 0) + 1;
		const target = session.runId || session.conversationId;
		const active = [...this.pendingRuns.values()].some((r) => r.session === session);
		this.forgetRuns(session);
		delete session.conversationId;
		delete session.runId;
		session.accountId = this.accountId(randomUUID());
		if (target && active) {
			const result = await this.host.abortRun?.(target);
			if (!result?.ok) throw new Error(result?.error || "Host abort unavailable");
		}
	}
	forgetRuns(session) {
		for (const [id, run] of this.pendingRuns)
			if (run.session === session) {
				clearTimeout(run.timer);
				this.pendingRuns.delete(id);
			}
	}
	async handleRunEvent(ev) {
		if (!ev?.runId) return;
		const run = this.pendingRuns.get(ev.runId);
		if (!run) {
			if (this.dispatching && this.earlyRuns.size < 64) {
				const early = this.earlyRuns.get(ev.runId) || [];
				if (early.length < 64) early.push(ev);
				this.earlyRuns.set(ev.runId, early);
			}
			return;
		}
		if (run.revision !== (run.session.revision || 0)) return;
		if (ev.conversationId) run.session.conversationId = ev.conversationId;
		if (ev.type === "message" && ev.message?.role === "assistant") {
			const content = ev.message.content;
			const text =
				typeof content === "string"
					? content
					: (content || [])
							.filter((b) => b.type === "text")
							.map((b) => b.text || "")
							.join("\n");
			run.accumulatedText = (run.accumulatedText + "\n" + text).slice(-100000);
		}
		if (ev.type === "run_end") {
			clearTimeout(run.timer);
			this.pendingRuns.delete(ev.runId);
			if (run.session.runId === ev.runId) delete run.session.runId;
			const failure = ev.isError || ["error", "aborted"].includes(ev.stopReason);
			const text = failure
				? `Task ${ev.stopReason || "failed"}. ${this.stripMarkers(run.accumulatedText)}`
				: this.stripMarkers(run.accumulatedText) || "Task completed (no text output).";
			for (const chunk of chunkMarkdownText(text, 3800)) {
				if (run.revision !== (run.session.revision || 0)) break;
				await this.reply(run.sender, chunk);
			}
		}
	}
}
