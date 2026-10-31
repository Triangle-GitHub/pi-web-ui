import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

export function scopeKey(openId, chatId = "", threadId = "") {
	return createHash("sha256")
		.update(JSON.stringify([openId, chatId, threadId]))
		.digest("hex");
}

export function parseCommand(text) {
	const match = String(text)
		.trim()
		.match(/^(\S+)(?:\s+([\s\S]*))?$/);
	return {
		command: (match?.[1] || "").normalize("NFKC").toLowerCase(),
		arg: match?.[2] || "",
	};
}

async function resetContext(bridge, scope) {
	bridge.epochs ??= new Map();
	bridge.cancellations ??= new Map();
	bridge.epochs.set(scope, (bridge.epochs.get(scope) || 0) + 1);
	bridge.cancellations.set(scope, (bridge.cancellations.get(scope) || 0) + 1);
	const epoch = bridge.epochs.get(scope);
	const cancellation = bridge.cancellations.get(scope);
	bridge.userConversations.delete(scope);
	bridge.dispatchingScopes?.delete(scope);
	const runs = [...bridge.pendingRuns.values()].filter((run) => run.scope === scope);
	for (const run of runs) bridge.pendingRuns.delete(run.runId);
	const results = await Promise.allSettled(runs.map((run) => bridge.host.abortRun(run.runId)));
	return { epoch, cancellation, failed: results.some((result) => result.status === "rejected" || !result.value?.ok) };
}

export const runtime = {
	async dispatch(text, attachments, ctx) {
		const { scope, cfg } = ctx;
		if (ctx.epoch !== undefined && ctx.epoch !== (this.epochs?.get(scope) || 0)) return;
		if (ctx.cancellation !== undefined && ctx.cancellation !== (this.cancellations?.get(scope) || 0)) return;
		if ([...this.pendingRuns.values()].some((r) => r.scope === scope) || this.dispatchingScopes?.has(scope)) {
			return this.replyMessage(cfg, { ...ctx, msgType: "text", text: "当前会话正在运行，请等待完成或使用 /stop。" });
		}
		this.dispatchingScopes ??= new Map();
		const dispatchToken = Symbol();
		this.dispatchingScopes.set(scope, dispatchToken);
		this.inFlight = (this.inFlight || 0) + 1;
		const generation = this.generation || 0;
		const cancellation = this.cancellations?.get(scope) || 0;
		const epoch = this.epochs?.get(scope) || 0;
		try {
			const preferences = this.preferences?.get(scope) || {};
			const receipt = await this.host.chat({
				text: text || "请检查收到的附件。音视频如无解码工具，请明确告知无法解码，不要猜测内容。",
				accountId: `fs_${scope.slice(0, 32)}_${this.epochs?.get(scope) || 0}`,
				...(this.userConversations.get(scope) ? { conversationId: this.userConversations.get(scope) } : {}),
				cwd: this.resolveWorkspace(scope, cfg),
				...(cfg.model ? { model: cfg.model } : {}),
				...(cfg.thinkingLevel ? { thinkingLevel: cfg.thinkingLevel } : {}),
				...preferences,
				...(attachments.length ? { attachments } : {}),
			});
			if (!receipt?.conversationId || !receipt?.runId)
				throw new Error("宿主未返回有效 conversationId/runId，请升级宿主。");
			if (generation !== (this.generation || 0) || cancellation !== (this.cancellations?.get(scope) || 0)) {
				const aborted = await this.host.abortRun?.(receipt.runId || receipt.conversationId);
				if (!aborted?.ok) throw new Error(aborted?.error || "宿主未能停止已取消的任务");
				return;
			}
			this.userConversations.set(scope, receipt.conversationId);
			const run = {
				...ctx,
				epoch,
				cancellation,
				generation,
				runId: receipt.runId,
				conversationId: receipt.conversationId,
				accumulatedText: "",
				startedAt: Date.now(),
			};
			this.pendingRuns.set(receipt.runId, run);
			const events = this.earlyRuns.get(receipt.runId) || [];
			this.earlyRuns.delete(receipt.runId);
			for (const event of events) await this.handleRunEvent(event);
		} catch (err) {
			this.status.lastError = err.message;
			await this.replyMessage(cfg, { ...ctx, msgType: "text", text: `任务启动失败：${err.message}` });
		} finally {
			if (this.dispatchingScopes.get(scope) === dispatchToken) this.dispatchingScopes.delete(scope);
			if (!--this.inFlight) this.earlyRuns.clear();
		}
	},

	async handleSlashCommand(text, ctx) {
		const { cfg, scope = ctx.openId } = ctx;
		const { command, arg } = parseCommand(text);
		const isDefault = arg.toLowerCase() === "default";
		const initialEpoch = this.epochs?.get(scope) || 0;
		let answer;
		try {
			this.preferences ??= new Map();
			this.epochs ??= new Map();
			const prefs = this.preferences.get(scope) || {};
			const runs = [...this.pendingRuns.values()].filter((r) => r.scope === scope);
			switch (command.toLowerCase()) {
				case "/help":
					return await this.replyMessage(cfg, {
						...ctx,
						msgType: "interactive",
						title: "飞书机器人帮助",
						text: "/help 帮助\n/new /clear /reset [prompt] 新会话\n/status 状态\n/stop /abort 停止\n/model [provider/id] 模型\n/thinking [off|minimal|low|medium|high|xhigh] 思考强度\n/cwd [绝对路径] 工作区\n支持图片、文件、语音与视频附件；音视频理解依赖模型工具，无法解码会明确告知。",
					}).then(() => true);
				case "/stop":
				case "/abort": {
					this.cancellations ??= new Map();
					this.cancellations.set(scope, (this.cancellations.get(scope) || 0) + 1);
					for (const run of runs) {
						const result = await this.host.abortRun(run.runId || run.conversationId);
						if (!result?.ok) throw new Error(result?.error || "宿主未能停止任务");
					}
					answer =
						runs.length || this.dispatchingScopes?.has(scope)
							? "已请求停止当前任务；等待中的投递将在回执到达后中止。"
							: "已取消等待中的媒体处理；当前没有运行中的任务。";
					break;
				}
				case "/clear":
				case "/reset":
				case "/new": {
					const { epoch, cancellation, failed } = await resetContext(this, scope);
					if (epoch !== this.epochs.get(scope)) return true;
					if (arg) await this.dispatch(arg, [], { ...ctx, scope, epoch, cancellation });
					answer = "✨ 已开启全新会话（旧会话历史保留）。" + (failed ? "旧任务停止失败，请在宿主检查。" : "");
					break;
				}
				case "/cwd":
				case "/workspace":
					if (arg) {
						if (!isDefault && !isAbsolute(arg)) throw new Error("请提供工作区绝对路径");
						if (isDefault) this.userWorkspaces.delete(scope);
						else this.userWorkspaces.set(scope, arg);
						await resetContext(this, scope);
					}
					answer = `📂 当前项目根目录：${this.resolveWorkspace(scope, cfg)}${arg ? "（将在下次投递时由宿主验证）" : ""}`;
					break;
				case "/model":
					if (arg) {
						if (!isDefault) {
							const models = await this.host.models.list();
							if (initialEpoch !== (this.epochs.get(scope) || 0)) return true;
							if (!models.some((m) => `${m.provider}/${m.id}` === arg))
								throw new Error("模型不可用，请使用 /model 查看列表");
						}
						if (isDefault) delete prefs.model;
						else prefs.model = arg;
						this.preferences.set(scope, prefs);
						await resetContext(this, scope);
						answer = `模型设为 ${isDefault ? "跟随宿主" : arg}（已开启新会话）`;
					} else {
						const models = (await this.host.models?.list?.()) || [];
						answer = `当前模型：${prefs.model || cfg.model || "跟随宿主"}\n${models.map((m) => `${m.provider}/${m.id}`).join("\n")}`;
					}
					break;
				case "/thinking":
					if (arg && !isDefault && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(arg.toLowerCase()))
						throw new Error("不支持的思考强度");
					if (arg) {
						if (isDefault) delete prefs.thinkingLevel;
						else prefs.thinkingLevel = arg.toLowerCase();
						this.preferences.set(scope, prefs);
						await resetContext(this, scope);
					}
					answer = `思考强度：${prefs.thinkingLevel || cfg.thinkingLevel || "跟随宿主"}（由宿主在投递时验证模型支持）`;
					break;
				case "/status":
					answer = `连接：${this.status.state}\n会话：${this.userConversations.get(scope) || "未创建"}\n运行：${runs.length || (this.dispatchingScopes?.has(scope) ? 1 : 0)}\n工作区：${this.resolveWorkspace(scope, cfg)}\n最近错误：${this.status.lastError || "无"}`;
					break;
				default:
					answer = "未知命令，请使用 /help 查看支持的命令。";
			}
		} catch (err) {
			answer = `命令执行失败：${err.message}`;
		}
		await this.replyMessage(cfg, { ...ctx, msgType: "text", text: answer });
		return true;
	},

	async handleRunEvent(ev) {
		if (!ev?.runId) return;
		const run = this.pendingRuns.get(ev.runId);
		if (!run) {
			if (this.inFlight && ["message", "run_end"].includes(ev.type)) {
				if (!this.earlyRuns.has(ev.runId) && this.earlyRuns.size >= 64) return;
				const events = this.earlyRuns.get(ev.runId) || [];
				if (events.length < 128) events.push(ev);
				this.earlyRuns.set(ev.runId, events);
			}
			return;
		}
		if (ev.conversationId) {
			run.conversationId = ev.conversationId;
			this.userConversations.set(run.scope, ev.conversationId);
		}
		if (ev.type === "message" && ev.message?.role === "assistant") {
			const content = ev.message.content;
			const text =
				typeof content === "string"
					? content
					: (content || [])
							.filter((b) => b.type === "text")
							.map((b) => b.text || "")
							.join("\n");
			run.accumulatedText += (run.accumulatedText ? "\n" : "") + text;
			if (ev.message.errorMessage) run.error = ev.message.errorMessage;
		}
		if (ev.type === "run_end") {
			this.pendingRuns.delete(ev.runId);
			if (!run.accumulatedText)
				run.accumulatedText =
					ev.stopReason === "aborted"
						? "任务已停止。"
						: `任务未返回可显示内容${run.error ? `：${run.error}` : "，可能运行失败或无法解码附件。"}`;
			await this.deliverReply(run);
		}
	},
};

export function inboundResources(content, type) {
	const body = typeof content === "string" ? JSON.parse(content) : content || {};
	if (type === "image") return [{ key: body.image_key, type: "image", name: "image.png" }];
	if (["file", "audio", "media", "video"].includes(type))
		return [
			{
				key: body.file_key,
				type: "file",
				name: body.file_name || (type === "audio" ? "audio.opus" : type === "file" ? "file.bin" : "video.mp4"),
				kind: type,
			},
		];
	if (type === "post") {
		const post = body.content ? body : body.zh_cn || body.en_us || Object.values(body)[0] || {};
		return (post.content || [])
			.flat()
			.filter((b) => b.tag === "img")
			.map((b) => ({ key: b.image_key, type: "image", name: "image.png" }));
	}
	if (type !== "text") throw new Error(`不支持的消息类型：${type}`);
	return [];
}

export async function receiveAttachments(resources, download, cfg, messageId) {
	if (resources.filter((r) => r.type === "image").length > 8) throw new Error("图片数量超过 8 张");
	let total = 0;
	const attachments = [];
	for (const resource of resources) {
		if (!resource.key) throw new Error("附件缺少资源标识，无法解码");
		const result = await download(cfg, { ...resource, messageId });
		const data = Buffer.from(result.data);
		if (!data.length || data.length > 10 * 1024 * 1024) throw new Error("附件为空或超过单个 10MiB 限制");
		total += data.length;
		if (total > 20 * 1024 * 1024) throw new Error("附件合计超过 20MiB 限制");
		if (resource.type === "image" && !/^image\/(png|jpeg|gif|webp)$/.test(result.mimeType))
			throw new Error("图片格式不支持或无法解码");
		attachments.push({
			path: "",
			name: resource.name || randomUUID(),
			mimeType: result.mimeType || "application/octet-stream",
			[resource.type === "image" ? "imageData" : "fileData"]: data.toString("base64"),
		});
	}
	return attachments;
}
