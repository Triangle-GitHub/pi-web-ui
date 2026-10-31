import { createHash } from "node:crypto";

export function sessionKey(value) {
	return value.sessionId
		? `session:${value.sessionId}`
		: value.clientId && value.conversationId
			? `owner:${JSON.stringify([value.clientId, value.conversationId])}`
			: "";
}

export function accountKey(cfg = {}) {
	return createHash("sha256")
		.update(
			JSON.stringify([cfg.appId || "", cfg.appSecret || "", cfg.domain || "", cfg.baseUrl || "", cfg.preset || ""]),
		)
		.digest("hex");
}

export const routes = {
	async restoreSessionRoutes() {
		const saved = await this.host.storage?.get("sessionRoutes");
		this.routeAccount = accountKey(this.getConfig());
		if (saved?.account !== this.routeAccount) {
			if (saved) {
				this.saveSessionRoutes();
				await this.routeSave;
			}
			return;
		}
		this.epochs = new Map(saved.epochs || []);
		for (const [key, route] of saved.routes || []) {
			if (!key.startsWith("session:") || !this.validSessionRoute(route)) continue;
			this.sessionRoutes.set(key, route);
			this.userConversations.set(route.scope, route.conversationId);
		}
	},

	syncRouteAccount() {
		const account = accountKey(this.getConfig());
		if (this.routeAccount === undefined) this.routeAccount = account;
		if (this.routeAccount === account) return;
		this.routeAccount = account;
		this.generation = (this.generation || 0) + 1;
		this.sessionRoutes.clear();
		this.pendingRuns.clear();
		this.earlyRuns.clear();
		this.userConversations.clear();
		this.saveSessionRoutes();
	},

	validSessionRoute(route) {
		return (
			route &&
			!route.ambiguous &&
			route.account === accountKey(this.getConfig()) &&
			route.epoch === (this.epochs?.get(route.scope) || 0)
		);
	},

	saveSessionRoutes() {
		while (this.sessionRoutes.size > 200) this.sessionRoutes.delete(this.sessionRoutes.keys().next().value);
		const saved = JSON.parse(
			JSON.stringify({
				account: this.routeAccount,
				epochs: [...(this.epochs || [])],
				routes: [...this.sessionRoutes].filter(([key]) => key.startsWith("session:")),
			}),
		);
		this.routeSave = (this.routeSave || Promise.resolve())
			.catch(() => {})
			.then(() => this.host.storage?.set("sessionRoutes", saved))
			.catch((err) => {
				this.status.lastError = `会话路由保存失败：${err.message}`;
				this.log("warn", this.status.lastError);
			});
	},

	bindSessionRoute(identity, ctx) {
		const key = sessionKey(identity);
		if (!key) return;
		const previous = this.sessionRoutes.get(key);
		if (previous?.ambiguous || (this.validSessionRoute(previous) && previous.scope !== ctx.scope)) {
			this.sessionRoutes.set(key, { ambiguous: true });
		} else {
			const { scope, openId, chatId, threadId, messageId, replyInThread, epoch } = ctx;
			this.sessionRoutes.set(key, {
				scope,
				openId,
				chatId,
				threadId,
				messageId,
				replyInThread,
				epoch,
				account: this.routeAccount,
				conversationId: identity.conversationId,
			});
		}
		this.saveSessionRoutes();
	},

	revokeSessionRoutes(scope) {
		for (const [key, route] of this.sessionRoutes) if (route.scope === scope) this.sessionRoutes.delete(key);
		this.saveSessionRoutes();
	},
};
