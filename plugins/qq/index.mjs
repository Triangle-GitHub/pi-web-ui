/**
 * plugins/qq/index.mjs
 * QQ Bot (腾讯开放平台 QQBot) integration for pi-web-ui.
 * Zero external dependencies (built-in fetch + node:crypto + native WebSocket).
 * Inspired by dsh-im & wechat-ilink: outbound WebSocket duplex chat (zero public IP),
 * structure-aware Markdown chunks, isolated multi-turn sessions,
 * access control whitelist, slash commands, model & thinkingLevel switches,
 * and workspace cwd binding.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { chunkMarkdownText } from "./markdown-chunks.mjs";
import {
	QQ_INBOUND_MAX,
	formatInboundMediaLines,
	inboundFileName,
	mediaKindOfContentType,
	mediaKindOfPath,
	mimeOfPath,
	sendQqMediaMessage,
	uploadQqMedia,
} from "./media.mjs";

export const SECRET_CLIENT_SECRET = "qq.clientSecret";
const QQ_AUTH_URL = "https://bots.qq.com/app/getAppAccessToken";
const QQ_API_BASE = "https://api.sgroup.qq.com";

/** Strips internal system markers from assistant response text before delivery. */
export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** 校验工作目录合法性（防路径不存在或越界，Windows 下防 SystemRoot）。 */
export function checkCwdValid(cwd) {
	const trimmed = String(cwd ?? "").trim();
	if (!trimmed) return { ok: false, error: "工作目录不能为空" };
	let abs;
	try {
		abs =
			process.platform === "win32" && /^[A-Za-z]:$/.test(trimmed) ? `${trimmed.toUpperCase()}${sep}` : resolve(trimmed);
	} catch {
		return { ok: false, error: `工作目录路径非法：${trimmed}` };
	}
	try {
		if (!existsSync(abs) || !statSync(abs).isDirectory()) {
			return { ok: false, error: `目标项目不存在或不是目录：${trimmed}` };
		}
	} catch {
		return { ok: false, error: `无法访问目标项目：${trimmed}` };
	}
	if (process.platform === "win32") {
		const sysRoot = (process.env.SystemRoot || process.env.windir || "C:\\Windows")
			.replace(/\//g, "\\")
			.replace(/\\+$/, "");
		const norm = abs.replace(/\//g, "\\").replace(/\\+$/, "");
		const low = norm.toLowerCase();
		const rootLow = sysRoot.toLowerCase();
		if (low === rootLow || low.startsWith(`${rootLow}\\`)) {
			return { ok: false, error: `拒绝在系统目录执行：${abs}` };
		}
	}
	return { ok: true, abs };
}

/** Generates a stable, privacy-preserving accountId from QQ user OpenID or user ID and session seq. */
export function peerAccountId(userId, seq = 0, prefix = "qq") {
	const base = String(userId ?? "").trim();
	const raw = seq ? `${base}:${seq}` : base;
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

/** Extract text content and strip bot mention tags (<@!botId> or <@botId>) from QQ message. */
export function extractQqText(content = "", botId = "") {
	let text = String(content || "").trim();
	if (!text) return "";
	if (botId) {
		const regex = new RegExp(`<@!?${botId}>`, "g");
		text = text.replace(regex, "").trim();
	}
	return text.replace(/<@!\d+>/g, "").trim();
}

/**
 * Obtain QQBot Access Token from Tencent Open Platform.
 */
export async function getQqAccessToken(appId, clientSecret, { timeoutMs = 15000 } = {}) {
	if (!appId || !clientSecret) throw new Error("QQ AppID and ClientSecret are required.");
	const res = await fetch(QQ_AUTH_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json; charset=utf-8" },
		body: JSON.stringify({
			appId: String(appId).trim(),
			clientSecret: String(clientSecret).trim(),
		}),
		signal: AbortSignal.timeout(timeoutMs),
	});

	if (!res.ok) {
		throw new Error(`QQ Auth HTTP ${res.status}`);
	}

	const json = await res.json();
	if (!json.access_token) {
		throw new Error(json.msg || "Failed to obtain QQBot access token");
	}
	return {
		accessToken: json.access_token,
		expiresInSec: Number(json.expires_in) > 0 ? Number(json.expires_in) : 2 * 60 * 60,
	};
}

/**
 * QQ OpenAPI request helper.
 */
export async function qqApi(
	accessToken,
	method,
	path,
	payload = null,
	{ apiBase = QQ_API_BASE, timeoutMs = 15000 } = {},
) {
	const url = `${apiBase.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
	const headers = {
		Authorization: `QQBot ${accessToken}`,
		"Content-Type": "application/json; charset=utf-8",
		"User-Agent": "pi-web-ui-qqbot/0.1.0",
	};

	const res = await fetch(url, {
		method,
		headers,
		body: payload !== null ? JSON.stringify(payload) : undefined,
		signal: AbortSignal.timeout(timeoutMs),
	});

	if (!res.ok) {
		const errJson = await res.json().catch(() => ({}));
		throw new Error(errJson.message || `QQ HTTP ${res.status}`);
	}

	return await res.json().catch(() => ({}));
}

/**
 * 下载 QQ 附件（腾讯 CDN，url 有时效）。超过上限直接放弃，不把服务内存拖坏。
 * @param {string} url
 * @param {number} [declaredSize] 事件里带的 size 字节数（可选，先做一次快判）
 * @param {number} [maxBytes]
 */
export async function downloadInbound(url, declaredSize, maxBytes = QQ_INBOUND_MAX) {
	if (Number(declaredSize) > maxBytes) {
		throw new Error(
			`附件 ${Math.round(Number(declaredSize) / 1024 / 1024)}MB 超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB`,
		);
	}
	const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length === 0) throw new Error("附件为空");
	if (buf.length > maxBytes) {
		throw new Error(`附件 ${Math.round(buf.length / 1024 / 1024)}MB 超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB`);
	}
	return buf;
}

/**
 * 发媒体时的来源解析：http(s) URL 交给平台自己转存（最省事）；本地文件读成字节，
 * 由 uploadQqMedia 走 base64（≤50MB）或分片上传。相对路径按工作区解析。
 */
export function resolveMediaSpec(spec, workspace) {
	const raw = String(spec ?? "").trim();
	if (!raw) return null;
	const kind = mediaKindOfPath(raw);
	if (/^https?:\/\//i.test(raw)) return { url: raw, kind, fileName: basename(raw.split("?")[0]) || "media" };
	const base = String(workspace ?? "").trim() || process.cwd();
	const abs = resolve(base, raw);
	if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`本地文件不存在：${raw}`);
	const size = statSync(abs).size;
	if (size === 0) throw new Error(`文件为空：${raw}`);
	return { buffer: readFileSync(abs), fileName: basename(abs), size, kind: mediaKindOfContentType(mimeOfPath(abs)) };
}

/**
 * 向频道/群聊/单聊发一条媒体（图片/视频/语音/文件）。
 * - 频道（channel_id）：官方只收公网 URL 的 image 字段，本地文件无上传通道；
 * - 单聊 / 群聊：先传 files 拿 file_info，再 msg_type=7 发（本地文件自动 base64/分片上传）。
 */
export async function sendMediaToTarget({ cfg, target, media, content = "" }) {
	if (!cfg?.appId || !cfg?.clientSecret) throw new Error("QQBot AppID 或 ClientSecret 未配置");
	const caption = String(content ?? "");
	const channelId = String(target?.channelId ?? "").trim();
	const isGuild = Boolean(channelId) && !target?.groupOpenid && !target?.userOpenid;
	// 先校验再取 token：能本地报错就别发请求（频道只收公网 URL，本地文件没有上传通道）。
	if (isGuild && !media?.url) throw new Error("QQ 频道只支持公网 http(s) 媒体 URL（本地文件请走单聊/群聊）");
	if (!isGuild && !target?.groupOpenid && !target?.userOpenid) {
		throw new Error("缺少目标：channel_id / group_openid / user_openid 至少填一个");
	}

	const apiBase = cfg.useSandbox ? "https://sandbox.api.sgroup.qq.com" : QQ_API_BASE;
	const token = await getQqAccessToken(cfg.appId, cfg.clientSecret).then((r) => r.accessToken);

	if (isGuild) {
		const payload = { content: caption || " ", image: media.url };
		return qqApi(token, "POST", `/channels/${channelId}/messages`, payload, { apiBase });
	}

	const scope = target?.groupOpenid
		? { type: "group", openid: String(target.groupOpenid).trim() }
		: target?.userOpenid
			? { type: "user", openid: String(target.userOpenid).trim() }
			: null;
	if (!scope) throw new Error("缺少目标：channel_id / group_openid / user_openid 至少填一个");
	const api = (method, path, body) => qqApi(token, method, path, body ?? null, { apiBase });
	const fileInfo = await uploadQqMedia({
		api,
		scope,
		source: media?.url ? { url: media.url } : { buffer: media?.buffer },
		fileName: media?.fileName ?? "media",
		kind: media?.kind ?? "file",
	});
	return sendQqMediaMessage({
		api,
		scope,
		fileInfo,
		msgId: target?.msgId ?? "",
		msgSeq: target?.msgSeq,
		content: caption,
	});
}

/**
 * QqBotBridge manages outbound WebSocket duplex exchange with Tencent QQ Open Platform.
 */
export class QqBotBridge {
	/**
	 * @param {object} options
	 * @param {any} options.host
	 * @param {() => any} options.getConfig
	 * @param {(level: string, msg: string) => void} [options.log]
	 */
	constructor({ host, getConfig, log } = {}) {
		this.host = host;
		this.getConfig = getConfig;
		this.log = log || ((level, msg) => console.log(`[qq-bot:${level}] ${msg}`));

		this.running = false;
		this.stopGeneration = 0;
		this.ws = null;
		this.heartbeatTimer = null;
		this.lastSequence = null;
		this.accessToken = "";
		this.tokenExpiresAt = 0;
		this.tokenRefreshInFlight = null;
		this.botUser = null;
		this.offRunEvent = null;

		this.seenMessageIds = new Set();
		this.pendingRuns = new Map();
		this.earlyRuns = new Map();
		/** host.chat 回执的稳定 runId → pendingRuns 的 key（对话被过户 / 撞 id 改名后
		 *  conversationId 会变，只有 runId 不变；QQ 靠它认领自己那一轮的回包）。 */
		this.runIdIndex = new Map();
		this.inFlightConvs = new Set();
		this.lastInFlightStartedAt = 0;
		this.earlyRunEvents = new Map();

		this.userWorkspaces = new Map();
		this.userModels = new Map();
		this.userThinkingLevels = new Map();
		this.userPlanMode = new Map();
		this.userActiveConvs = new Map(); // authorId -> conversationId (真实会话ID)
		this.peerSessionSeq = new Map();
		this.userActiveSeq = new Map();

		this.conversationBindings = new Map(); // convId -> { authorId, replyTarget, updatedAt }
		this.recentChats = []; // Array<{ conversationId, authorId, lastUserText, lastAssistantText, updatedAt }>
		this.webRunTexts = new Map(); // convId -> accumulatedText (电脑网页发起的双向同步累积)

		this.notifiedToolCalls = new Set(); // 防止同一 toolCallId 重复触发广播通知
		this.runStartTimes = new Map(); // convId -> timestamp (耗时统计)
		this.runTasks = new Map(); // convId -> task (触发词/任务说明)
		this.recentAssistantTexts = new Map(); // convId -> 最新文本输出 (用于完成广播摘要)

		this.currentIntents = (1 << 30) | (1 << 25); // PUBLIC_GUILD_MESSAGES | GROUP_AND_C2C
		this.status = {
			enabled: false,
			connected: false,
			state: "idle", // 'idle' | 'connecting' | 'connected' | 'error'
			botUsername: "",
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

	getRecentChats() {
		return [...this.recentChats];
	}

	recordRecentChat(conversationId, authorId, { userText, assistantText } = {}) {
		if (!conversationId) return;
		// 严防非 QQ 会话写入：必须属于 QQ 绑定或当前排队任务
		if (!this.conversationBindings.has(conversationId) && !this.pendingRuns.has(conversationId)) {
			return;
		}
		const seq = this.peerSessionSeq.get(authorId) || 0;
		const pseudoOwner = `plugin:qq:${peerAccountId(authorId, seq)}`;
		let item = this.recentChats.find((c) => c.conversationId === conversationId);
		if (!item) {
			item = {
				conversationId,
				authorId: String(authorId || "qq_user"),
				ownerId: pseudoOwner,
				lastUserText: "",
				lastAssistantText: "",
				updatedAt: Date.now(),
			};
			this.recentChats.unshift(item);
		} else {
			this.recentChats = this.recentChats.filter((c) => c.conversationId !== conversationId);
			this.recentChats.unshift(item);
		}
		if (pseudoOwner) item.ownerId = pseudoOwner;
		if (userText !== undefined) item.lastUserText = String(userText).slice(0, 300);
		if (assistantText !== undefined) item.lastAssistantText = String(assistantText).slice(0, 300);
		item.updatedAt = Date.now();
		if (this.recentChats.length > 20) {
			this.recentChats = this.recentChats.slice(0, 20);
		}
		this.host?.broadcast?.({ type: "recent_chats", recentChats: this.getRecentChats() });
	}

	resolveWorkspace(authorId, cfg) {
		return String(this.userWorkspaces.get(authorId) || cfg?.workspace || this.host?.cwd || "").trim();
	}

	resolveModel(authorId, cfg) {
		return String(this.userModels.get(authorId) || cfg?.model || "").trim();
	}

	resolveThinkingLevel(authorId, cfg) {
		return String(this.userThinkingLevels.get(authorId) || cfg?.thinkingLevel || "").trim();
	}

	resolvePlanMode(authorId, cfg) {
		if (this.userPlanMode.has(authorId)) {
			return Boolean(this.userPlanMode.get(authorId));
		}
		return false;
	}

	async start() {
		if (this.running) return;
		this.running = true;
		this.status.enabled = true;
		this.status.state = "connecting";
		this.currentIntents = (1 << 30) | (1 << 25);

		const cfg = this.getConfig();
		if (!cfg.appId || !cfg.clientSecret) {
			this.status.state = "idle";
			this.status.lastError = "Missing QQ AppID or ClientSecret";
			return;
		}

		if (this.host.onRunEvent) {
			this.offRunEvent = this.host.onRunEvent((ev) => this.handleRunEvent(ev));
		}

		try {
			const auth = await getQqAccessToken(cfg.appId, cfg.clientSecret);
			this.accessToken = auth.accessToken;
			this.tokenExpiresAt = Date.now() + auth.expiresInSec * 1000;
			this.status.lastError = null;
			this.log("info", "QQBot access token obtained successfully");
		} catch (err) {
			this.status.state = "error";
			this.status.lastError = err.message;
			this.log("warn", `QQBot auth failed: ${err.message}`);
			return;
		}

		try {
			await this.connectGateway();
		} catch (err) {
			this.status.state = "error";
			this.status.lastError = err.message;
			this.log("warn", `QQ Gateway start failed: ${err.message}`);
		}
	}

	async stop() {
		this.stopGeneration++;
		this.running = false;
		this.status.enabled = false;
		this.status.connected = false;
		this.status.state = "idle";

		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}

		if (this.ws) {
			try {
				this.ws.close();
			} catch {}
			this.ws = null;
		}

		if (this.offRunEvent) {
			try {
				this.offRunEvent();
			} catch {}
			this.offRunEvent = null;
		}

		for (const run of this.pendingRuns.values()) {
			if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
		}
		this.pendingRuns.clear();
		this.conversationBindings.clear();
		this.webRunTexts.clear();
		this.runIdIndex.clear();
		this.earlyRuns.clear();
		this.earlyRunEvents.clear();
		this.inFlightConvs.clear();
		this.notifiedToolCalls.clear();
		this.runStartTimes.clear();
		this.runTasks.clear();
		this.recentAssistantTexts.clear();

		this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });
	}

	async ensureAccessToken() {
		const cfg = this.getConfig();
		const REFRESH_MARGIN_MS = 5 * 60 * 1000;
		if (this.accessToken && Date.now() < this.tokenExpiresAt - REFRESH_MARGIN_MS) {
			return this.accessToken;
		}
		if (!this.tokenRefreshInFlight) {
			this.tokenRefreshInFlight = (async () => {
				try {
					const auth = await getQqAccessToken(cfg.appId, cfg.clientSecret);
					this.accessToken = auth.accessToken;
					this.tokenExpiresAt = Date.now() + auth.expiresInSec * 1000;
				} catch (err) {
					this.log("warn", `QQBot token refresh failed: ${err.message}`);
				}
				return this.accessToken;
			})().finally(() => {
				this.tokenRefreshInFlight = null;
			});
		}
		return this.tokenRefreshInFlight;
	}

	async connectGateway() {
		const cfg = this.getConfig();
		const apiBase = cfg.useSandbox ? "https://sandbox.api.sgroup.qq.com" : QQ_API_BASE;

		let wssUrl;
		try {
			const token = await this.ensureAccessToken();
			const gw = await qqApi(token, "GET", "/gateway", null, { apiBase });
			wssUrl = gw?.url;
		} catch (err) {
			throw new Error(`Failed to obtain QQ Gateway URL: ${err.message}`);
		}

		if (!wssUrl) throw new Error("QQ /gateway returned empty URL");

		if (typeof globalThis.WebSocket === "undefined") {
			throw new Error("Node environment missing globalThis.WebSocket");
		}

		const ws = new globalThis.WebSocket(wssUrl);
		this.ws = ws;

		ws.onopen = () => {
			this.log("info", "QQBot WebSocket connection established");
		};

		ws.onmessage = (event) => {
			this.handleGatewayPayload(event.data);
		};

		ws.onerror = (err) => {
			this.status.lastError = err?.message || "WebSocket error";
			this.log("warn", `QQ Gateway error: ${this.status.lastError}`);
		};

		ws.onclose = (event) => {
			this.status.connected = false;
			if (this.heartbeatTimer) {
				clearInterval(this.heartbeatTimer);
				this.heartbeatTimer = null;
			}
			const code = event?.code;
			const reason = event?.reason || "";
			if (code === 4014 || code === 4903) {
				if (this.currentIntents !== 1 << 30) {
					this.currentIntents = 1 << 30;
					this.log?.("warn", `QQ Gateway reported ${code} (${reason}), falling back to base PUBLIC_GUILD_MESSAGES`);
				}
			}
			if (this.running) {
				this.status.state = "connecting";
				if (reason) this.status.lastError = `Gateway close ${code || ""}: ${reason}`;
				this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });
				setTimeout(() => {
					if (this.running) this.connectGateway().catch(() => {});
				}, 5000);
			} else {
				this.status.state = "idle";
				this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });
			}
		};
	}

	handleGatewayPayload(dataRaw) {
		let packet;
		try {
			const text = typeof dataRaw === "string" ? dataRaw : new TextDecoder().decode(dataRaw);
			packet = JSON.parse(text);
		} catch {
			return;
		}

		const { op, d, s, t } = packet;
		if (typeof s === "number") this.lastSequence = s;

		// Opcode 10: Hello -> start heartbeat and send Identify
		if (op === 10) {
			const interval = d?.heartbeat_interval || 30000;
			if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = setInterval(() => {
				if (this.ws && this.ws.readyState === 1) {
					this.ws.send(JSON.stringify({ op: 1, d: this.lastSequence }));
				}
			}, interval);

			const identifyPayload = {
				op: 2,
				d: {
					token: `QQBot ${this.accessToken}`,
					intents: this.currentIntents,
					properties: {
						$os: "linux",
						$browser: "pi-web-ui",
						$device: "pi-web-ui",
					},
				},
			};
			if (this.ws && this.ws.readyState === 1) {
				this.ws.send(JSON.stringify(identifyPayload));
			}
			return;
		}

		// Opcode 11: Heartbeat ACK
		if (op === 11) return;

		// Opcode 0: Dispatch
		if (op === 0) {
			if (t === "READY") {
				this.botUser = d?.user || {};
				this.status.botUsername = this.botUser.username || "QQBot";
				this.status.connected = true;
				this.status.state = "connected";
				this.status.lastError = null;
				this.log("info", `QQBot connected as ${this.status.botUsername} (ID: ${this.botUser.id})`);
				this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });
			} else if (
				t === "AT_MESSAGE_CREATE" ||
				t === "MESSAGE_CREATE" ||
				t === "DIRECT_MESSAGE_CREATE" ||
				t === "GROUP_AT_MESSAGE_CREATE" ||
				t === "C2C_MESSAGE_CREATE"
			) {
				this.onInboundMessage(d, t).catch((err) => {
					this.log("warn", `Inbound message handling error: ${err.message}`);
				});
			}
		}
	}

	async onInboundMessage(data, eventType) {
		if (!data) return;
		const messageId = data.id;
		if (messageId) {
			if (this.seenMessageIds.has(messageId)) return;
			this.seenMessageIds.add(messageId);
			if (this.seenMessageIds.size > 500) {
				const first = this.seenMessageIds.values().next().value;
				this.seenMessageIds.delete(first);
			}
		}

		// Extract author ID
		const authorId = data.author?.id || data.author?.user_openid || "";
		if (data.author?.bot) return;

		const cfg = this.getConfig();

		// Access control whitelist check
		const allowedUsers = Array.isArray(cfg.allowedUsers)
			? cfg.allowedUsers.map((u) => String(u).trim()).filter(Boolean)
			: [];
		if (allowedUsers.length > 0 && authorId && !allowedUsers.includes(String(authorId))) {
			this.log("info", `QQ user ${authorId} blocked by whitelist`);
			return;
		}

		this.status.messagesReceived++;
		this.status.lastMessageAt = Date.now();
		this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });

		const replyTarget = {
			eventType,
			channelId: data.channel_id,
			guildId: data.guild_id,
			threadId: data.thread_id,
			groupOpenid: data.group_openid,
			userOpenid: data.author?.user_openid,
			msgId: messageId,
		};

		const botId = this.botUser?.id || "";
		const cleanText = extractQqText(data.content, botId);
		// Keep direct messages compatible; scope group/channel sessions to their actual destination.
		const sessionPeer = this.sessionPeer(authorId, replyTarget);
		// Commands must run before media downloads, especially cancellation.
		const commandText = cleanText.replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
		if (commandText.startsWith("/") || /^\d+\/.+/.test(commandText) || /^\d+(?:\s|$)/.test(commandText)) {
			if (await this.handleSlashCommand(cleanText, { authorId: sessionPeer, replyTarget, cfg })) return;
		}
		// 图片/语音/视频/文件（QQ 走 attachments，带腾讯 CDN url，有时效）
		const attachments = Array.isArray(data.attachments) ? data.attachments : [];
		const media =
			attachments.length > 0
				? await this.collectInboundMedia(attachments, { authorId: sessionPeer, cfg })
				: { text: "", attachments: [] };
		const promptText = [cleanText, media.text].filter(Boolean).join("\n\n");
		if (!promptText) {
			const promptHint = "👋 您好！我在听，请在 @ 我后面附带具体问题或发送 /help 查看快捷指令。";
			const tempCid = `qq_${String(authorId).slice(-8)}_0`;
			this.recordRecentChat(tempCid, authorId, {
				userText: `@${this.botUser?.username || "机器人"}`,
				assistantText: promptHint,
			});
			await this.replyMessage(replyTarget, promptHint).catch(() => {});
			return;
		}

		await this.driveAuthor(sessionPeer, promptText, replyTarget, media.attachments);
	}

	/**
	 * 收图/收文件落地：QQ 附件的 `url` 是腾讯 CDN（有时效），收到必须立刻下载。
	 * 落盘到 `<工作区>/.pi-qq-media/`，正文里给绝对路径让 agent 用 read 直接看；
	 * 关掉 `inboundMedia`（或下载失败/超限）就只给占位文字，绝不吞消息。
	 */
	async collectInboundMedia(attachments, { authorId, cfg }) {
		const items = [];
		const hostAttachments = [];
		let imageBytes = 0;
		let imageCount = 0;
		const wantLand = cfg?.inboundMedia !== false;
		let dir = "";
		if (wantLand) {
			const workspace = this.resolveWorkspace(authorId, cfg);
			const chk = checkCwdValid(workspace);
			if (chk.ok) {
				dir = join(chk.abs, ".pi-qq-media");
				try {
					mkdirSync(dir, { recursive: true });
				} catch (err) {
					this.log("warn", `QQ 媒体目录创建失败：${err.message}`);
					dir = "";
				}
			}
		}
		for (let i = 0; i < attachments.length; i++) {
			const att = attachments[i] || {};
			const url = String(att.voice_wav_url || att.url || "").trim();
			const contentType = att.voice_wav_url ? "audio/wav" : att.content_type;
			const declaredKind = mediaKindOfContentType(contentType);
			const kind = declaredKind !== "file" ? declaredKind : mediaKindOfPath(att.filename || url);
			const filename = String(att.filename || "").trim();
			const asrText = String(att.asr_refer_text || "").trim();
			if (!wantLand || !dir) {
				items.push({ kind, filename, asrText, reason: wantLand ? "未找到可用工作区" : "已关闭接收媒体" });
				continue;
			}
			if (!url) {
				items.push({ kind, filename, asrText, reason: "缺少下载地址" });
				continue;
			}
			try {
				const buf = await downloadInbound(url, att.size);
				const name = inboundFileName({
					contentType,
					filename,
					url,
					index: i,
					peer: authorId,
				});
				const path = join(dir, name);
				writeFileSync(path, buf);
				items.push({ kind, filename, path, asrText });
				if (kind === "image") {
					const mimeType = mimeOfPath(path);
					if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType)) {
						items.push({ kind, filename, reason: "当前模型附件接口不支持此图片格式，请转换为 PNG/JPEG/GIF/WebP" });
					} else if (imageCount >= 8 || buf.length > 10 * 1024 * 1024 || imageBytes + buf.length > 20 * 1024 * 1024) {
						items.push({ kind, filename, reason: "图片未注入模型：最多 8 张、单张 10MiB、合计 20MiB" });
					} else {
						hostAttachments.push({ path: "", imageData: buf.toString("base64"), mimeType, name: filename || name });
						imageCount++;
						imageBytes += buf.length;
					}
				} else hostAttachments.push({ path, mode: "reference", name: filename || name });
			} catch (err) {
				this.log("warn", `QQ 附件下载失败（${filename || url}）：${err.message}`);
				items.push({ kind, filename, asrText, reason: `下载失败：${err.message}` });
			}
		}
		return {
			text: formatInboundMediaLines(items),
			attachments: hostAttachments,
		};
	}

	sessionPeer(authorId, target) {
		const scope = target.groupOpenid
			? `group:${target.groupOpenid}`
			: target.channelId
				? `channel:${target.guildId || ""}:${target.channelId}`
				: "";
		return scope ? peerAccountId(`${authorId}:${scope}:thread:${target.threadId || ""}`) : authorId;
	}

	async driveAuthor(authorId, cleanText, replyTarget, attachments = []) {
		const cfg = this.getConfig();
		const seq = this.peerSessionSeq.get(authorId) || 0;
		const accountId = peerAccountId(authorId, seq);

		let conversationId =
			(this.userActiveSeq.get(authorId) === seq && this.userActiveConvs.get(authorId)) ||
			`qq_${String(authorId).slice(-8)}_${seq}`;
		let bindCid = null;

		// An explicit reset owns its new context; never bind it back to the web context.
		if (cfg.bindActive === true && seq === 0) {
			try {
				const active = this.host.getActiveConversation?.()?.conversationId;
				if (typeof active === "string" && active.trim()) {
					bindCid = active.trim();
					conversationId = bindCid;
				}
			} catch {}
		}

		if (
			[...this.pendingRuns.values()].some((run) => run.authorId === authorId || run.canonicalId === conversationId) ||
			this.pendingRuns.has(conversationId)
		) {
			await this.replyMessage(replyTarget, "⏳ 当前会话仍在执行，请等待完成或发送 /abort。").catch(() => {});
			return;
		}
		const timeoutSec = Math.max(15, Number(cfg.replyTimeoutSec) || 90);
		const timeoutTimer = setTimeout(() => {
			const run = this.pendingRuns.get(conversationId);
			if (run && !run.noticed) {
				run.noticed = true;
				this.replyMessage(replyTarget, "⏳ 任务还在深度执行中，稍后把结果推给您…").catch(() => {});
			}
		}, timeoutSec * 1000);

		const dispatchedRun = {
			authorId,
			replyTarget,
			accumulatedText: "",
			startedAt: Date.now(),
			timeoutTimer,
			noticed: false,
		};
		this.pendingRuns.set(conversationId, dispatchedRun);
		// Both the epoch and object identity must survive reset, abort and bridge stop.
		const ownsDispatch = () =>
			(this.peerSessionSeq.get(authorId) || 0) === seq && this.pendingRuns.get(conversationId) === dispatchedRun;

		this.conversationBindings.set(conversationId, {
			authorId,
			replyTarget,
			updatedAt: Date.now(),
		});
		this.recordRecentChat(conversationId, authorId, { userText: cleanText });

		try {
			const workspace = this.resolveWorkspace(authorId, cfg);
			const model = this.resolveModel(authorId, cfg);
			const thinkingLevel = this.resolveThinkingLevel(authorId, cfg);
			const planMode = this.resolvePlanMode(authorId, cfg);

			const chatReq = {
				text: cleanText,
				accountId,
				conversationId,
			};
			if (attachments.length) chatReq.attachments = attachments;
			if (workspace) chatReq.cwd = workspace;
			if (model) chatReq.model = model;
			if (thinkingLevel) chatReq.thinkingLevel = thinkingLevel;
			if (planMode) chatReq.planMode = true;

			const startedAt = Date.now();
			if (conversationId) this.inFlightConvs.add(conversationId);
			this.lastInFlightStartedAt = startedAt;

			const r = await this.host.chat(chatReq);
			if (!ownsDispatch()) return;
			this.inFlightConvs.delete(conversationId);
			if (r?.conversationId) {
				this.inFlightConvs.delete(r.conversationId);
				this.inFlightConvs.delete(conversationId);
				this.userActiveConvs.set(authorId, r.conversationId);
				this.userActiveSeq.set(authorId, seq);
				if (r.conversationId !== conversationId) {
					const curRun = this.pendingRuns.get(conversationId);
					if (curRun) {
						curRun.canonicalId = r.conversationId;
						curRun.aliasId = conversationId;
						this.pendingRuns.set(r.conversationId, curRun);
					}
					const curBinding = this.conversationBindings.get(conversationId);
					if (curBinding) {
						this.conversationBindings.set(r.conversationId, curBinding);
					}
					// 关键修复：从 recentChats 中迁移旧的临时 conversationId，防止列表中同时出现两条相同的提问
					const oldIndex = this.recentChats.findIndex((c) => c.conversationId === conversationId);
					if (oldIndex >= 0) {
						this.recentChats[oldIndex].conversationId = r.conversationId;
						// 去重保障：避免重复
						this.recentChats = this.recentChats.filter(
							(c, i) => i === this.recentChats.findIndex((x) => x.conversationId === c.conversationId),
						);
						this.host?.broadcast?.({ type: "recent_chats", recentChats: this.getRecentChats() });
					} else {
						this.recordRecentChat(r.conversationId, authorId, { userText: cleanText });
					}
				}
			}
			const runKey = r?.conversationId || conversationId;
			const pending = this.pendingRuns.get(runKey);
			if (pending) pending.runId = r?.runId;
			this.rememberRunId(runKey, r?.runId);
			const early = r?.runId ? this.earlyRunEvents.get(r.runId) || [] : [];
			if (r?.runId) this.earlyRunEvents.delete(r.runId);
			for (const event of early) await this.handleRunEvent(event);
			if (!this.inFlightConvs.size) this.earlyRunEvents.clear();
		} catch (err) {
			if (!ownsDispatch()) return;
			this.log("warn", `QQBot host.chat dispatch failed: ${err.message}`);
			const run = this.pendingRuns.get(conversationId);
			if (run?.timeoutTimer) clearTimeout(run.timeoutTimer);
			this.forgetRun(conversationId, run?.canonicalId);
			this.inFlightConvs.delete(conversationId);
			if (!this.inFlightConvs.size) this.earlyRunEvents.clear();
			this.conversationBindings.delete(conversationId);
			this.recentChats = this.recentChats.filter((c) => c.conversationId !== conversationId);
			this.host?.broadcast?.({ type: "recent_chats", recentChats: this.getRecentChats() });
			await this.replyMessage(replyTarget, `⚠️ 任务启动失败：${err.message}`).catch(() => {});
		}
	}

	async replyMessage(target, text, explicitSeq = null) {
		const cfg = this.getConfig();
		const apiBase = cfg.useSandbox ? "https://sandbox.api.sgroup.qq.com" : QQ_API_BASE;
		const token = await this.ensureAccessToken();

		// 同一 target 维护单调自增序号，绝不重复发送相同的 msg_seq 避免腾讯 304026 冲突
		if (!target.__nextSeq || typeof target.__nextSeq !== "number") {
			target.__nextSeq = 1;
		}
		const msgSeq = explicitSeq !== null ? explicitSeq : target.__nextSeq++;

		const payload = {
			content: text,
			msg_seq: msgSeq,
		};
		if (target.msgId) {
			payload.msg_id = target.msgId;
		}

		try {
			if (target.channelId) {
				await qqApi(token, "POST", `/channels/${target.channelId}/messages`, payload, { apiBase });
			} else if (target.groupOpenid) {
				await qqApi(token, "POST", `/v2/groups/${target.groupOpenid}/messages`, payload, { apiBase });
			} else if (target.userOpenid) {
				await qqApi(token, "POST", `/v2/users/${target.userOpenid}/messages`, payload, { apiBase });
			}
		} catch (err) {
			const errMsg = String(err?.message || "").toLowerCase();
			const isExpiredOrSeq =
				errMsg.includes("expire") ||
				errMsg.includes("timeout") ||
				errMsg.includes("304023") ||
				errMsg.includes("304024") ||
				errMsg.includes("304026") ||
				errMsg.includes("40040003") ||
				errMsg.includes("50006");

			// 遇到被动回复过期或 seq 冲突时降级重试：
			if (isExpiredOrSeq) {
				if (target.channelId) {
					// QQ 频道：去掉 msg_id/msg_seq 作为普通频道消息发送，100% 成功送达
					try {
						await qqApi(token, "POST", `/channels/${target.channelId}/messages`, { content: text }, { apiBase });
						this.log("info", "QQ channel passive reply expired, fallback to active channel message succeeded");
						return;
					} catch (fallbackErr) {
						this.log("warn", `QQ channel active fallback failed: ${fallbackErr.message}`);
					}
				} else if (target.groupOpenid || target.userOpenid) {
					// QQ 群/单聊：尝试作为主动消息重发
					try {
						const activePayload = { content: text };
						const path = target.groupOpenid
							? `/v2/groups/${target.groupOpenid}/messages`
							: `/v2/users/${target.userOpenid}/messages`;
						await qqApi(token, "POST", path, activePayload, { apiBase });
						this.log("info", "QQ group/c2c passive reply expired, fallback to active message succeeded");
						return;
					} catch (fallbackErr) {
						this.log("warn", `QQ group/c2c active fallback failed: ${fallbackErr.message}`);
					}
				}
			}
			throw err;
		}
	}

	async resetAuthorSession(authorId, replyTarget, cfg) {
		if ([...this.pendingRuns.values()].some((run) => run.authorId === authorId)) {
			await this.handleSlashCommand("/abort", { authorId, replyTarget, cfg });
			if ([...this.pendingRuns.values()].some((run) => run.authorId === authorId)) return false;
		}
		this.peerSessionSeq.set(authorId, (this.peerSessionSeq.get(authorId) || 0) + 1);
		this.userActiveConvs.delete(authorId);
		this.userActiveSeq.delete(authorId);
		for (const [key, binding] of this.conversationBindings) {
			if (binding.authorId !== authorId) continue;
			this.conversationBindings.delete(key);
			this.webRunTexts.delete(key);
		}
		return true;
	}

	async handleSlashCommand(cmdText, { authorId, replyTarget, cfg }) {
		// Normalize only the command token: paths and prompts must retain their exact text.
		const normalized = cmdText
			.trim()
			.replace(/^\S+/, (token) =>
				token.replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0)),
			);
		const match = /^\/?([^\s]*)(?:\s+([\s\S]*))?$/.exec(normalized);
		if (!match) return false;

		let rawCmd = match[1].toLowerCase();
		const args = (match[2] ?? "").trim();

		const NUMBERED_COMMANDS = {
			1: "cwd",
			2: "new",
			3: "status",
			4: "model",
			5: "thinking",
			6: "plan",
			7: "compact",
			8: "stop",
			9: "reload",
			10: "help",
		};
		if (/^\d+\/.+/.test(rawCmd)) {
			rawCmd = rawCmd.split("/")[1] || rawCmd.split("/")[0];
		}
		const cmd = NUMBERED_COMMANDS[rawCmd] ?? rawCmd;

		switch (cmd) {
			case "":
			case "?":
			case "h":
			case "help":
			case "帮助": {
				const lines = [
					"🤖 **QQ 机器人帮助与快捷指令菜单**",
					"可直接发送 /序号（如 /1 或 /2 <提示词>）快捷操作：",
					"1/cwd : 查看或切换当前项目根目录",
					"2/new : 清空上下文开启全新会话 [提示词]",
					"3/status : 查看机器人运行状态与指标",
					"4/model : 查看或切换当前模型 [模型ID]",
					"5/thinking : 设置思考强度 <off|low|medium|high|max>",
					"6/plan : 开启或关闭计划模式 [on|off]",
					"7/compact : 压缩当前会话上下文 [说明]",
					"8/abort : 中止当前正在执行的任务（/stop 同义）",
					"9/reload : 重新加载扩展与配置",
					"10/help : 显示全部命令 (或发 /)",
				];
				await this.replyMessage(replyTarget, lines.join("\n")).catch(() => {});
				return true;
			}
			case "cwd":
			case "workspace": {
				if (!args) {
					const cur = this.resolveWorkspace(authorId, cfg) || "(跟随宿主当前项目)";
					const text = [
						`📂 当前项目根目录：${cur}`,
						"",
						"提示：",
						"• 发送 /cwd <目录绝对路径> 可切换根目录",
						"• 发送 /cwd default 可恢复跟随全局配置",
					].join("\n");
					await this.replyMessage(replyTarget, text).catch(() => {});
					return true;
				}
				if (["default", "默认", "clear", "reset"].includes(args.toLowerCase())) {
					if (!(await this.resetAuthorSession(authorId, replyTarget, cfg))) return true;
					this.userWorkspaces.delete(authorId);
					const cur = this.resolveWorkspace(authorId, cfg) || "(跟随宿主当前项目)";
					await this.replyMessage(replyTarget, `📂 已恢复跟随全局根目录：${cur}\n✨ 已自动为您开启全新会话！`).catch(
						() => {},
					);
					return true;
				}
				const chk = checkCwdValid(args);
				if (!chk.ok) {
					await this.replyMessage(replyTarget, `⚠️ 切换失败：${chk.error}`).catch(() => {});
					return true;
				}
				if (!(await this.resetAuthorSession(authorId, replyTarget, cfg))) return true;
				this.userWorkspaces.set(authorId, chk.abs);
				await this.replyMessage(
					replyTarget,
					`📂 已将项目根目录切换为：${chk.abs}\n✨ 已自动为您开启该目录下的全新会话！`,
				).catch(() => {});
				return true;
			}
			case "reset":
			case "clear":
			case "new": {
				if (!(await this.resetAuthorSession(authorId, replyTarget, cfg))) return true;
				if (args) {
					await this.replyMessage(replyTarget, "✨ 已为您开启全新会话，正在执行指令…").catch(() => {});
					await this.driveAuthor(authorId, args, replyTarget);
					return true;
				}
				await this.replyMessage(replyTarget, "✨ 对话上下文已清空，已为您开启全新会话！").catch(() => {});
				return true;
			}
			case "status": {
				const s = this.status;
				const currentWs = this.resolveWorkspace(authorId, cfg) || "(跟随宿主当前项目)";
				const currentModel = this.resolveModel(authorId, cfg) || "(跟随全局默认)";
				const currentThinking = this.resolveThinkingLevel(authorId, cfg) || "(跟随全局设置)";
				const bindActive =
					cfg.bindActive === true && !(this.peerSessionSeq.get(authorId) || 0) ? "投递到网页活跃会话" : "独立无头会话";
				const planMode = this.resolvePlanMode(authorId, cfg) ? "已开启" : "未开启";
				let pendingCount = 0;
				for (const run of this.pendingRuns.values()) {
					if (run.authorId === authorId) pendingCount++;
				}
				const statusText = [
					"🟢 **QQ 机器人状态与运行指标**",
					"",
					`- 账号名称：${s.botUsername || "QQBot"} (ID: ${this.botUser?.id || "--"})`,
					`- 运行状态：${s.state === "connected" ? "在线 (WebSocket)" : s.state}`,
					`- 项目根目录：${currentWs}`,
					`- 当前模型：${currentModel}`,
					`- 思考强度：${currentThinking}`,
					`- 计划模式：${planMode}`,
					`- 投递模式：${bindActive}`,
					`- 已接收消息：${s.messagesReceived} 条`,
					`- 已回复消息：${s.messagesReplied} 条`,
					`- 进行中任务：${pendingCount} 个`,
				].join("\n");
				await this.replyMessage(replyTarget, statusText).catch(() => {});
				return true;
			}
			case "model": {
				if (!args) {
					const cur = this.resolveModel(authorId, cfg) || "(跟随全局默认)";
					const text = [
						`🤖 当前模型：${cur}`,
						"",
						"提示：",
						"• 发送 /model <模型ID> 可切换模型（如 /model deepseek/deepseek-chat）",
						"• 发送 /model default 可恢复跟随全局默认模型",
					].join("\n");
					await this.replyMessage(replyTarget, text).catch(() => {});
					return true;
				}
				if (["default", "默认", "clear", "reset"].includes(args.toLowerCase())) {
					if (!(await this.resetAuthorSession(authorId, replyTarget, cfg))) return true;
					this.userModels.delete(authorId);
					await this.replyMessage(replyTarget, "🤖 已恢复跟随全局默认模型。\n✨ 已自动为您开启全新会话！").catch(
						() => {},
					);
					return true;
				}
				if (!(await this.resetAuthorSession(authorId, replyTarget, cfg))) return true;
				this.userModels.set(authorId, args);
				await this.replyMessage(replyTarget, `🤖 已将模型切换为：${args}\n✨ 已自动为您开启该模型下的全新会话！`).catch(
					() => {},
				);
				return true;
			}
			case "thinking": {
				const ALIAS = {
					off: "off",
					minimal: "minimal",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: "max",
					关闭: "off",
					极简: "minimal",
					低: "low",
					中: "medium",
					高: "high",
					极高: "xhigh",
					最大: "max",
				};
				if (!args) {
					const cur = this.resolveThinkingLevel(authorId, cfg) || "(跟随全局设置)";
					const text = [
						`🧠 当前思考强度：${cur}`,
						"",
						"提示：",
						"• 发送 /thinking <档位> 可切换（off/minimal/low/medium/high/xhigh/max）",
						"• 发送 /thinking default 可恢复跟随全局设置",
					].join("\n");
					await this.replyMessage(replyTarget, text).catch(() => {});
					return true;
				}
				if (["default", "默认", "clear", "reset"].includes(args.toLowerCase())) {
					if (!(await this.resetAuthorSession(authorId, replyTarget, cfg))) return true;
					this.userThinkingLevels.delete(authorId);
					await this.replyMessage(replyTarget, "🧠 已恢复跟随全局思考强度设置。\n✨ 已自动为您开启全新会话！").catch(
						() => {},
					);
					return true;
				}
				const mapped = ALIAS[args.toLowerCase()];
				if (!mapped) {
					await this.replyMessage(
						replyTarget,
						`⚠️ 无效的思考强度：${args}。可用档位：off / minimal / low / medium / high / xhigh / max`,
					).catch(() => {});
					return true;
				}
				if (!(await this.resetAuthorSession(authorId, replyTarget, cfg))) return true;
				this.userThinkingLevels.set(authorId, mapped);
				await this.replyMessage(
					replyTarget,
					`🧠 已将思考强度设置为：${mapped}\n✨ 已自动为您开启该档位下的全新会话！`,
				).catch(() => {});
				return true;
			}
			case "plan": {
				const trimmed = args.toLowerCase();
				const cur = this.resolvePlanMode(authorId, cfg);
				const next = trimmed === "on" ? true : trimmed === "off" ? false : !cur;
				this.userPlanMode.set(authorId, next);
				await this.replyMessage(replyTarget, `📋 计划模式已${next ? "开启" : "关闭"}`).catch(() => {});
				return true;
			}
			case "compact": {
				const seq = this.peerSessionSeq.get(authorId) || 0;
				const convId = this.userActiveConvs.get(authorId) || `qq_${String(authorId).slice(-8)}_${seq}`;
				try {
					if (this.host.compactConversation) {
						await this.host.compactConversation(convId, args || undefined);
						await this.replyMessage(replyTarget, "🗜️ 已向 agent 触发会话压缩").catch(() => {});
					} else {
						await this.replyMessage(replyTarget, "⚠️ 当前宿主不支持手动触发会话压缩").catch(() => {});
					}
				} catch (err) {
					await this.replyMessage(replyTarget, `⚠️ 压缩失败：${err.message}`).catch(() => {});
				}
				return true;
			}
			case "abort":
			case "stop": {
				let stopped = 0;
				for (const run of new Set(this.pendingRuns.values())) {
					if (run.authorId !== authorId) continue;
					const key = [...this.pendingRuns].find(([, value]) => value === run)?.[0];
					try {
						const result = await this.host.abortRun?.(run.runId || run.canonicalId || key);
						if (!result?.ok) throw new Error(result?.error || "宿主未确认中止");
						if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
						this.forgetRun(key, run.aliasId, run.canonicalId);
						for (const id of [key, run.aliasId, run.canonicalId]) this.inFlightConvs.delete(id);
						if (!this.inFlightConvs.size) this.earlyRunEvents.clear();
						stopped++;
					} catch (err) {
						await this.replyMessage(replyTarget, `⚠️ 中止失败：${err.message}`).catch(() => {});
						return true;
					}
				}
				if (stopped > 0) {
					await this.replyMessage(replyTarget, `⏹️ 已中止 ${stopped} 个正在执行的任务`).catch(() => {});
				} else {
					await this.replyMessage(replyTarget, "⏹️ 当前没有正在执行的任务").catch(() => {});
				}
				return true;
			}
			case "reload": {
				await this.replyMessage(replyTarget, "🔄 正在重新加载…").catch(() => {});
				return true;
			}
			default:
				return false;
		}
	}

	/** 记住某个对话「本轮」的稳定 runId（host.chat 回执给出；旧宿主没有就跳过）。 */
	rememberRunId(conversationId, runId) {
		const rid = typeof runId === "string" ? runId.trim() : "";
		if (!rid || !conversationId || !this.pendingRuns.has(conversationId)) return;
		this.pendingRuns.get(conversationId).runId = rid;
		this.runIdIndex.set(rid, conversationId);
	}

	/** 事件归属的 pendingRuns key：优先稳定 runId（过户改名后 conversationId 已对不上）。 */
	resolveRunKey(ev) {
		const rid = typeof ev?.runId === "string" ? ev.runId.trim() : "";
		const mapped = rid ? this.runIdIndex.get(rid) : undefined;
		// 映射已失效（该轮已收尾/被清理）时回落当前 conversationId，别拿旧 key 误吞事件。
		return mapped && this.pendingRuns.has(mapped) ? mapped : ev.conversationId;
	}

	/** 某轮收尾/作废：连同 runId 索引一起清，防陈旧映射把后续运行认错。 */
	forgetRun(key, ...aliasKeys) {
		const keys = [key, ...aliasKeys].filter(Boolean);
		for (const k of keys) this.pendingRuns.delete(k);
		const keySet = new Set(keys);
		for (const [rid, k] of this.runIdIndex) {
			if (keySet.has(k)) this.runIdIndex.delete(rid);
		}
	}

	createDeliveryGuard(authorId, conversationId, binding) {
		const peerSeq = this.peerSessionSeq.get(authorId) || 0;
		const generation = this.stopGeneration;
		return () =>
			this.stopGeneration === generation &&
			(this.peerSessionSeq.get(authorId) || 0) === peerSeq &&
			(!binding || this.conversationBindings.get(conversationId) === binding);
	}

	async handleRunEvent(ev) {
		const convId = this.resolveRunKey(ev);
		if (!convId) return;
		const pending = this.pendingRuns.get(convId);
		if (pending?.runId && ev.runId && pending.runId !== ev.runId) return;
		// A receipt is the only authority for a run whose canonical ID is not known yet.
		if (ev.runId && !this.runIdIndex.has(ev.runId) && this.inFlightConvs.size && (!pending || !pending.runId)) {
			if (!this.earlyRunEvents.has(ev.runId) && this.earlyRunEvents.size >= 64)
				this.earlyRunEvents.delete(this.earlyRunEvents.keys().next().value);
			const events = this.earlyRunEvents.get(ev.runId) || [];
			if (events.length < 256) events.push(ev);
			this.earlyRunEvents.set(ev.runId, events);
			return;
		}

		// 1. 全局运行轨迹监听：用于频道广播通知与统计
		if (ev.type === "run_start") {
			this.runStartTimes.set(convId, ev.at || Date.now());
			if (ev.task) {
				this.runTasks.set(convId, String(ev.task).slice(0, 150));
			}
			this.recentAssistantTexts.delete(convId);
		} else if (ev.type === "tool_start" && ev.toolName === "ask_user_question") {
			const cfg = this.getConfig?.() || {};
			if (cfg.notifyOnQuestion !== false) {
				const toolCallId = ev.toolCallId || `${convId}_${Date.now()}`;
				if (!this.notifiedToolCalls.has(toolCallId)) {
					this.notifiedToolCalls.add(toolCallId);
					if (this.notifiedToolCalls.size > 200) {
						const first = this.notifiedToolCalls.values().next().value;
						this.notifiedToolCalls.delete(first);
					}
					const msg = this.formatQuestionNotification(convId, ev.argsText);
					this.broadcastToChannel(msg).catch(() => {});
				}
			}
		}

		// 2. 收集助手消息文本，供广播摘要与同步使用
		if (ev.type === "message" && ev.message) {
			const m = ev.message;
			let content = "";
			if (typeof m.content === "string") content = m.content;
			else if (Array.isArray(m.content)) {
				content = m.content
					.map((c) => (typeof c === "string" ? c : c.text || ""))
					.join("\n")
					.trim();
			}

			if (content && (m.role === "assistant" || m.author === "assistant")) {
				this.recentAssistantTexts.set(convId, content);
				if (this.recentAssistantTexts.size > 50) {
					const first = this.recentAssistantTexts.keys().next().value;
					this.recentAssistantTexts.delete(first);
				}

				if (this.pendingRuns.has(convId)) {
					const r = this.pendingRuns.get(convId);
					r.accumulatedText += (r.accumulatedText ? "\n" : "") + content;
				} else if (this.conversationBindings.has(convId)) {
					const prev = this.webRunTexts.get(convId) || "";
					this.webRunTexts.set(convId, (prev ? "\n" : "") + content);
				} else if (this.inFlightConvs.has(convId)) {
					let early = this.earlyRuns.get(convId);
					if (!early) {
						early = { accumulatedText: "" };
						this.earlyRuns.set(convId, early);
					}
					early.accumulatedText += (early.accumulatedText ? "\n" : "") + content;
				}
			}
			return;
		}

		// 3. 关键安全守卫（与微信通道同级）：区分 QQ 自身会话 与 宿主普通网页会话
		const isPending = this.pendingRuns.has(convId);
		const isBound = this.conversationBindings.has(convId);
		const isInFlight = this.inFlightConvs.has(convId);

		if (!isPending && !isBound && !isInFlight) {
			// 普通网页端会话结束：检查是否开启了任务完成广播通知
			if (ev.type === "run_end") {
				const cfg = this.getConfig?.() || {};
				if (cfg.notifyOnRunEnd === true) {
					const durationSec = this.runStartTimes.has(convId)
						? Math.max(1, Math.round((Date.now() - this.runStartTimes.get(convId)) / 1000))
						: null;
					const task = this.runTasks.get(convId) || "";
					const lastText = this.recentAssistantTexts.get(convId) || "";
					const msg = this.formatRunEndNotification(convId, {
						task,
						assistantText: lastText,
						stopReason: ev.stopReason,
						durationSec,
					});
					this.broadcastToChannel(msg).catch(() => {});
				}
				this.runStartTimes.delete(convId);
				this.runTasks.delete(convId);
				this.recentAssistantTexts.delete(convId);
			}
			return; // 绝不让网页端普通对话进入 earlyRuns 或 recentChats！
		}

		if (ev.type === "run_end") {
			const run = this.pendingRuns.get(convId) || this.earlyRuns.get(convId);
			if (run) {
				if (run.timeoutTimer) {
					clearTimeout(run.timeoutTimer);
				}
				this.forgetRun(convId, run.aliasId, run.canonicalId);
				if (run.aliasId) {
					this.conversationBindings.delete(run.aliasId);
				}
				this.earlyRuns.delete(convId);

				const rawText = run.accumulatedText || "";
				const cleanText = stripInternalMarkers(rawText);
				const finalText = cleanText || "✅ 任务已完成（无文本输出）。";

				const targetConvId = run.canonicalId || convId;
				this.recordRecentChat(targetConvId, run.authorId, { assistantText: finalText });

				const chunks = chunkMarkdownText(finalText, 3000);
				const canDeliver = this.createDeliveryGuard(run.authorId);

				try {
					for (let i = 0; i < chunks.length; i++) {
						if (!canDeliver()) return;
						const seq = (run.replyTarget.__nextSeq = (run.replyTarget.__nextSeq || 0) + 1);
						await this.replyMessage(run.replyTarget, chunks[i], seq);
					}
					if (!canDeliver()) return;
					this.status.messagesReplied++;
					this.status.lastReplyAt = Date.now();
					this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });
				} catch (err) {
					this.log("warn", `QQ reply delivery failed: ${err.message}`);
				}
				return;
			}

			// 电脑网页端发起的运行 -> 双向同步给 QQ
			const binding = this.conversationBindings.get(convId);
			if (binding && this.webRunTexts.has(convId)) {
				const webRaw = this.webRunTexts.get(convId) || "";
				this.webRunTexts.delete(convId);
				const cleanText = stripInternalMarkers(webRaw);
				if (!cleanText) return;

				this.recordRecentChat(convId, binding.authorId, { assistantText: cleanText });

				const cfg = this.getConfig();
				if (cfg.bindActive !== false && binding.replyTarget) {
					const syncText = `💻 [来自电脑网页端同步]\n${cleanText}`;
					const chunks = chunkMarkdownText(syncText, 3000);
					const canDeliver = this.createDeliveryGuard(binding.authorId, convId, binding);
					try {
						for (let i = 0; i < chunks.length; i++) {
							if (!canDeliver()) return;
							const seq = (binding.replyTarget.__nextSeq = (binding.replyTarget.__nextSeq || 0) + 1);
							await this.replyMessage(binding.replyTarget, chunks[i], seq);
						}
						if (!canDeliver()) return;
						this.status.messagesReplied++;
						this.status.lastReplyAt = Date.now();
						this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });
					} catch (err) {
						this.log("warn", `QQ web-to-bot sync delivery failed: ${err.message}`);
					}
				}
			}
		}
	}
	/**
	 * Send proactive notification message to a QQ guild channel.
	 * Used for broadcast notifications (e.g. AI ask_user_question or run_end).
	 */
	async broadcastToChannel(text) {
		const clean = stripInternalMarkers(text);
		if (!clean) return false;
		const cfg = this.getConfig?.() || {};
		const channelId = String(cfg.broadcastChannelId || cfg.defaultChannelId || "").trim();
		if (!channelId) return false;
		if (!cfg.appId || !cfg.clientSecret) return false;

		const apiBase = cfg.useSandbox ? "https://sandbox.api.sgroup.qq.com" : QQ_API_BASE;
		try {
			const token = await this.ensureAccessToken();
			if (!token) return false;
			const safeText = clean.length > 2000 ? `${clean.slice(0, 1990)}…` : clean;
			await qqApi(token, "POST", `/channels/${channelId}/messages`, { content: safeText }, { apiBase });
			this.log("info", `Broadcast notification sent to QQ channel ${channelId}`);
			return true;
		} catch (err) {
			this.log("warn", `Failed to send broadcast notification to channel ${channelId}: ${err?.message || err}`);
			return false;
		}
	}

	formatQuestionNotification(conversationId, argsText) {
		let qLines = [];
		try {
			const parsed = typeof argsText === "string" ? JSON.parse(argsText) : argsText;
			const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
			if (questions.length > 0) {
				for (let i = 0; i < questions.length; i++) {
					const q = questions[i];
					const prefix = questions.length > 1 ? `${i + 1}. ` : "";
					const title = q.header ? `【${q.header}】` : "";
					qLines.push(`${prefix}${title}${q.question || ""}`);
					if (Array.isArray(q.options) && q.options.length > 0) {
						const optStrs = q.options
							.map((o) => {
								if (typeof o === "string") return o;
								const rec = o.recommended ? " (推荐)" : "";
								return `${o.label || ""}${rec}`;
							})
							.filter(Boolean);
						if (optStrs.length > 0) {
							qLines.push(`   👉 选项：${optStrs.join(" / ")}`);
						}
					}
				}
			}
		} catch {}

		const contentPart = qLines.length > 0 ? qLines.join("\n") : "AI 正在等待您的确认回复";
		return [
			"🔔 【AI 提问待确认】",
			conversationId ? `💬 对话：${conversationId}` : "",
			`❓ 内容：\n${contentPart}`,
			"💡 请前往网页端查看并确认",
		]
			.filter(Boolean)
			.join("\n");
	}

	formatRunEndNotification(conversationId, { task, assistantText, stopReason, durationSec } = {}) {
		const isAborted = stopReason === "aborted" || stopReason === "user_interrupt";
		const statusLine = isAborted ? "⚠️ 【AI 任务已中止】" : "✅ 【AI 任务已完成】";
		const durLine = durationSec ? `⏱️ 耗时：${durationSec} 秒` : "";

		const cleanText = stripInternalMarkers(assistantText);
		let summaryLine = "";
		if (cleanText) {
			const snippet = cleanText.length > 200 ? `${cleanText.slice(0, 197)}…` : cleanText;
			summaryLine = `📝 结果摘要：\n${snippet}`;
		} else if (!isAborted) {
			summaryLine = "📝 任务已顺利执行完毕。";
		}

		return [
			statusLine,
			conversationId ? `💬 对话：${conversationId}` : "",
			task ? `🎯 任务：${task}` : "",
			durLine,
			summaryLine,
		]
			.filter(Boolean)
			.join("\n");
	}
}

/** Strip secrets from config before plaintext storage. */
export function stripSecretsFromConfig(cfg) {
	const c = { ...(cfg || {}) };
	delete c.clientSecret;
	delete c.hasClientSecret;
	return c;
}

/** Merge saved secrets into incoming config. */
export function mergeSavedSecrets(incoming, prev = {}, savedSecrets = {}) {
	const out = { ...(prev || {}), ...(incoming || {}) };
	const existingSecret = savedSecrets[SECRET_CLIENT_SECRET] || prev.clientSecret || "";

	if (incoming.clearClientSecret || !out.appId?.trim()) {
		out.clientSecret = "";
	} else if (typeof incoming.clientSecret === "string" && incoming.clientSecret.trim()) {
		out.clientSecret = incoming.clientSecret.trim();
	} else {
		out.clientSecret = existingSecret;
	}

	delete out.clearClientSecret;
	return out;
}

export default async function activate(host) {
	let localConfig = (await host.storage.get("config")) || {};
	const savedSecrets = (await host.secrets?.getAll?.()) || {};
	localConfig = mergeSavedSecrets(localConfig, {}, savedSecrets);

	const botBridge = new QqBotBridge({
		host,
		getConfig: () => localConfig,
		log: (lvl, msg) => host.log?.(lvl, msg),
	});

	if (localConfig.botEnabled && localConfig.appId && localConfig.clientSecret) {
		botBridge.start().catch((err) => {
			host.log?.("warn", `QQBot start note: ${err.message}`);
		});
	}

	// Register project right-click context menu action
	host.onUiAction?.("qq:set-workspace", (_itemId, _val, target) => {
		const path = target?.id !== undefined && target?.id !== null ? String(target.id).trim() : "";
		if (!path) return;
		const chk = checkCwdValid(path);
		if (chk.ok) {
			localConfig.workspace = chk.abs;
			void host.storage.set("config", stripSecretsFromConfig(localConfig));
			host.notify?.("info", `已将 QQ 机器人根目录设为：${chk.abs}`, `Set QQ bot workspace root to: ${chk.abs}`);
		}
	});

	// Register AI tool "qq" adhering strictly to tool-prompt-hygiene
	host.registerTool?.({
		name: "qq",
		description:
			"Send text or media (image/video/audio/file) to QQ: guild channel via channel_id, or C2C/group via user_openid/group_openid. Local file paths are uploaded automatically.",
		promptSnippet: "send QQ messages or media",
		promptGuidelines: [
			"Confirm the target and content with the user once before sending",
			"Guild channels accept only public http(s) URLs for media; local files need user_openid or group_openid",
			"Use action=status to query bot connection status",
		],
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["send", "status"],
					description: "action to perform (send: send message; status: query connection status).",
				},
				channel_id: {
					type: "string",
					description: "send: target QQ guild sub-channel ID (text or public-URL media).",
				},
				user_openid: {
					type: "string",
					description: "send: target C2C user openid (required for local-file media).",
				},
				group_openid: {
					type: "string",
					description: "send: target group openid (required for local-file media).",
				},
				text: {
					type: "string",
					description: "send: text content to send (also used as media caption).",
				},
				image: {
					type: "string",
					description: "send: image path or http(s) URL.",
				},
				file: {
					type: "string",
					description: "send: any other attachment path or http(s) URL (video/audio/document).",
				},
			},
			required: ["action"],
		},
		async execute(args) {
			const action = String(args.action || "");
			switch (action) {
				case "send": {
					const channelId = args.channel_id?.trim() || localConfig.defaultChannelId?.trim();
					const userOpenid = args.user_openid?.trim() || "";
					const groupOpenid = args.group_openid?.trim() || "";
					if (!channelId && !userOpenid && !groupOpenid)
						throw new Error("channel_id / user_openid / group_openid 至少填一个。");
					if (!localConfig.appId || !localConfig.clientSecret) {
						throw new Error("QQBot AppID or ClientSecret is not configured.");
					}
					// 带媒体就先走富媒体链路（本地文件自动上传）；否则保持原来的纯文本行为。
					const mediaSpec = String(args.image || args.file || "").trim();
					if (mediaSpec) {
						const workspace = String(localConfig.workspace || host.cwd || "").trim();
						const media = resolveMediaSpec(mediaSpec, workspace);
						const res = await sendMediaToTarget({
							cfg: localConfig,
							target: { channelId: userOpenid || groupOpenid ? "" : channelId, userOpenid, groupOpenid },
							media,
							content: args.text || "",
						});
						return JSON.stringify(
							{ ok: true, sent: media.kind, target: userOpenid || groupOpenid || channelId, res },
							null,
							2,
						);
					}
					const token = await getQqAccessToken(localConfig.appId, localConfig.clientSecret).then((r) => r.accessToken);
					const apiBase = localConfig.useSandbox ? "https://sandbox.api.sgroup.qq.com" : QQ_API_BASE;
					const res = await qqApi(
						token,
						"POST",
						`/channels/${channelId}/messages`,
						{
							content: args.text || "",
						},
						{ apiBase },
					);
					return JSON.stringify(res, null, 2);
				}
				case "status": {
					return JSON.stringify(botBridge.getStatus(), null, 2);
				}
				default:
					throw new Error(`Unknown action: ${action}`);
			}
		},
	});

	// Handle UI client messages
	// 回包回显请求里的 __rid：宿主为「上行 send / 下行 onData」，
	// 客户端按 __rid 将回包精确配对到发起请求，保证 Promise 正常 resolve。
	host.onClientMessage?.(async (msg, replyRaw) => {
		const __rid = msg && msg.__rid;
		const reply = (payload) =>
			__rid === undefined
				? replyRaw(payload)
				: replyRaw(payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload, __rid } : payload);
		try {
			switch (msg.type) {
				case "get_state": {
					const secrets = (await host.secrets?.getAll?.()) || {};
					reply({
						type: "state",
						config: {
							appId: localConfig.appId || "",
							defaultChannelId: localConfig.defaultChannelId || "",
							broadcastChannelId: localConfig.broadcastChannelId || "",
							notifyOnQuestion: localConfig.notifyOnQuestion !== false,
							notifyOnRunEnd: Boolean(localConfig.notifyOnRunEnd),
							workspace: localConfig.workspace || "",
							model: localConfig.model || "",
							thinkingLevel: localConfig.thinkingLevel || "",
							bindActive: Boolean(localConfig.bindActive),
							replyTimeoutSec: Number(localConfig.replyTimeoutSec) || 90,
							useSandbox: Boolean(localConfig.useSandbox),
							botEnabled: Boolean(localConfig.botEnabled),
							allowedUsers: localConfig.allowedUsers || [],
							inboundMedia: localConfig.inboundMedia !== false,
							hasClientSecret: Boolean(secrets[SECRET_CLIENT_SECRET] || localConfig.clientSecret),
						},
						botStatus: botBridge.getStatus(),
						recentChats: botBridge.getRecentChats(),
						hostCwd: String(host.cwd ?? "").trim(),
					});
					break;
				}

				case "set_workspace": {
					const ws = String(msg.workspace ?? "").trim();
					if (!ws) {
						localConfig.workspace = "";
					} else {
						const chk = checkCwdValid(ws);
						if (!chk.ok) {
							reply({ type: "set_workspace_done", success: false, message: chk.error });
							break;
						}
						localConfig.workspace = chk.abs;
					}
					await host.storage.set("config", stripSecretsFromConfig(localConfig));
					reply({ type: "set_workspace_done", success: true, workspace: localConfig.workspace });
					break;
				}

				case "save_config": {
					const incoming = msg.config || {};
					const secrets = (await host.secrets?.getAll?.()) || {};
					localConfig = mergeSavedSecrets(incoming, localConfig, secrets);

					if (host.secrets) {
						if (localConfig.clientSecret) {
							await host.secrets.set(SECRET_CLIENT_SECRET, localConfig.clientSecret);
						} else if (incoming.clearClientSecret) {
							await host.secrets.delete?.(SECRET_CLIENT_SECRET);
						}
					}

					await host.storage.set("config", stripSecretsFromConfig(localConfig));

					if (localConfig.botEnabled && localConfig.appId && localConfig.clientSecret) {
						await botBridge.stop().catch(() => {});
						await botBridge.start().catch(() => {});
					} else {
						await botBridge.stop().catch(() => {});
					}

					reply({ type: "save_config_done", success: true, botStatus: botBridge.getStatus() });
					break;
				}

				case "test_config": {
					const incoming = msg.config || {};
					const secrets = (await host.secrets?.getAll?.()) || {};
					const testCfg = mergeSavedSecrets(incoming, localConfig, secrets);

					if (!testCfg.appId || !testCfg.clientSecret) {
						reply({ type: "test_config_done", success: false, message: "未填入 AppID 或 ClientSecret" });
						break;
					}

					try {
						const token = await getQqAccessToken(testCfg.appId, testCfg.clientSecret).then((r) => r.accessToken);
						const apiBase = testCfg.useSandbox ? "https://sandbox.api.sgroup.qq.com" : QQ_API_BASE;
						const me = await qqApi(token, "GET", "/users/@me", null, { apiBase });
						reply({
							type: "test_config_done",
							success: true,
							message: `连接成功！已验证 QQ 机器人账号：${me.username || "QQBot"} (ID: ${me.id})`,
						});
					} catch (err) {
						reply({ type: "test_config_done", success: false, message: `连接失败: ${err.message}` });
					}
					break;
				}

				case "list_channels": {
					if (!localConfig.appId || !localConfig.clientSecret) {
						reply({ type: "list_channels_done", success: false, message: "未配置 AppID 或 ClientSecret" });
						break;
					}
					try {
						const token = await getQqAccessToken(localConfig.appId, localConfig.clientSecret).then(
							(r) => r.accessToken,
						);
						const apiBase = localConfig.useSandbox ? "https://sandbox.api.sgroup.qq.com" : QQ_API_BASE;
						const guilds = await qqApi(token, "GET", "/users/@me/guilds", null, { apiBase });
						const result = [];
						if (Array.isArray(guilds)) {
							for (const g of guilds) {
								const channels = await qqApi(token, "GET", `/guilds/${g.id}/channels`, null, { apiBase }).catch(
									() => [],
								);
								result.push({
									guildId: g.id,
									guildName: g.name,
									channels: Array.isArray(channels)
										? channels.map((c) => ({
												id: c.id,
												name: c.name,
												type: c.type,
											}))
										: [],
								});
							}
						}
						reply({ type: "list_channels_done", success: true, guilds: result });
					} catch (err) {
						reply({ type: "list_channels_done", success: false, message: err?.message || String(err) });
					}
					break;
				}

				case "send_message": {
					const channelId = msg.channelId?.trim() || localConfig.defaultChannelId?.trim();
					const openid = String(msg.openid ?? "").trim();
					const openidType = msg.openidType === "group" ? "group" : "user";
					const mediaSpec = String(msg.media ?? "").trim();
					if (!channelId && !openid) throw new Error("channelId is required.");
					if (!localConfig.appId || !localConfig.clientSecret) {
						throw new Error("QQBot AppID or ClientSecret is not configured.");
					}
					if (mediaSpec) {
						// 富媒体：频道只收公网 URL；单聊/群聊支持本地文件（自动 base64/分片上传）。
						const workspace = String(localConfig.workspace || host.cwd || "").trim();
						const media = resolveMediaSpec(mediaSpec, workspace);
						const res = await sendMediaToTarget({
							cfg: localConfig,
							target: {
								channelId: openid ? "" : channelId,
								userOpenid: openid && openidType === "user" ? openid : "",
								groupOpenid: openid && openidType === "group" ? openid : "",
							},
							media,
							content: msg.text || "",
						});
						reply({ type: "send_done", success: true, res });
						break;
					}
					if (!channelId) throw new Error("发纯文本需要子频道 Channel ID（单聊/群聊目前只支持富媒体）");
					const token = await getQqAccessToken(localConfig.appId, localConfig.clientSecret).then((r) => r.accessToken);
					const apiBase = localConfig.useSandbox ? "https://sandbox.api.sgroup.qq.com" : QQ_API_BASE;
					const res = await qqApi(
						token,
						"POST",
						`/channels/${channelId}/messages`,
						{
							content: msg.text || "",
						},
						{ apiBase },
					);
					reply({ type: "send_done", success: true, res });
					break;
				}

				case "start_bot": {
					localConfig.botEnabled = true;
					await host.storage.set("config", stripSecretsFromConfig(localConfig));
					await botBridge.start();
					reply({ type: "bot_status", success: true, status: botBridge.getStatus() });
					break;
				}

				case "stop_bot": {
					localConfig.botEnabled = false;
					await host.storage.set("config", stripSecretsFromConfig(localConfig));
					await botBridge.stop();
					reply({ type: "bot_status", success: true, status: botBridge.getStatus() });
					break;
				}

				default:
					reply({ type: "error", success: false, message: `Unknown message type: ${msg.type}` });
					break;
			}
		} catch (err) {
			reply({ type: "error", success: false, message: err?.message || String(err) });
		}
	});

	return async () => {
		await botBridge.stop().catch(() => {});
	};
}
