import { createHash } from "node:crypto";

export function identityKey(value) {
	if (value.sessionId) return `session:${value.sessionId}`;
	return value.clientId && value.conversationId
		? `owner:${JSON.stringify([value.clientId, value.conversationId])}`
		: "";
}

export function scopeKey(route) {
	return JSON.stringify([route.userId, route.channelId, route.sessionThread ?? route.threadTs ?? ""]);
}

export function accountKey(cfg) {
	return createHash("sha256")
		.update(JSON.stringify([cfg.botToken || "", cfg.appToken || ""]))
		.digest("hex");
}

export function installSessionRoutes(Bridge) {
	Object.assign(Bridge.prototype, {
		async restoreSessionRoutes() {
			const saved = await this.host.storage?.get("sessionRoutes");
			if (!saved) return;
			if (saved.account !== accountKey(this.getConfig())) {
				await this.clearSessionRoutes();
				return;
			}
			this.channelStates = new Map(saved.states || []);
			this.sessionRoutes = new Map(saved.routes || []);
		},
		async saveSessionRoutes() {
			const saved = JSON.parse(
				JSON.stringify({
					account: accountKey(this.getConfig()),
					states: [...(this.channelStates || [])].map(([key, state]) => [
						key,
						{
							conversationId: state.conversationId,
							epoch: state.epoch,
							cwd: state.cwd,
							model: state.model,
							thinkingLevel: state.thinkingLevel,
						},
					]),
					routes: [...(this.sessionRoutes || [])],
				}),
			);
			this.routeSave = (this.routeSave || Promise.resolve())
				.catch(() => {})
				.then(() => this.host.storage?.set("sessionRoutes", saved));
			try {
				await this.routeSave;
			} catch (error) {
				this.status.lastError = `Session route save failed: ${error.message}`;
				this.host.notify?.("error", this.status.lastError);
				throw error;
			}
		},
		validSessionRoute(binding) {
			return (
				binding &&
				!binding.ambiguous &&
				binding.account === accountKey(this.getConfig()) &&
				this.channelStates?.get(binding.scope)?.epoch === binding.epoch
			);
		},
		async bindSessionRoute(identity, run) {
			const key = identityKey(identity);
			if (!key) return;
			this.sessionRoutes ??= new Map();
			const previous = this.sessionRoutes.get(key);
			const scope = scopeKey(run.route);
			const binding =
				previous?.ambiguous || (this.validSessionRoute(previous) && previous.scope !== scope)
					? { ambiguous: true }
					: { scope, route: run.route, epoch: run.epoch, account: run.account };
			this.sessionRoutes.set(key, binding);
			await this.saveSessionRoutes();
		},
		async revokeSessionRoutes(state) {
			for (const [key, binding] of this.sessionRoutes || []) {
				if (this.channelStates?.get(binding.scope) === state) this.sessionRoutes.delete(key);
			}
			await this.saveSessionRoutes();
		},
		async clearSessionRoutes() {
			for (const state of this.channelStates?.values() || []) state.downloadController?.abort();
			this.channelStates = new Map();
			this.sessionRoutes = new Map();
			this.ownedRuns?.clear();
			this.webRuns?.clear();
			this.dispatches?.clear();
			await this.saveSessionRoutes();
		},
		async findSessionRun(ev) {
			if (ev.runId) return this.ownedRuns?.get(ev.runId);
			const key = identityKey(ev);
			if (!key) return;
			this.webRuns ??= new Map();
			let run = this.webRuns.get(key);
			if (!run && ev.type === "run_start") {
				const binding = this.sessionRoutes?.get(key);
				if (!this.validSessionRoute(binding)) return;
				const state = this.channelStates.get(binding.scope);
				if (state.busy) return;
				run = { ...binding, state, text: "", truncated: false, identity: key, sessionId: ev.sessionId };
				state.busy = true;
				this.webRuns.set(key, run);
			}
			return run;
		},
	});
}
