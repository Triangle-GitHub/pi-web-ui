import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLocalDeviceCenter } from "../../server/device-center/local.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function listen(server: Server) {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
describe("local persistent conversation proxy", () => {
	it("forwards all conversation routes with UI authority and strict body allowlists", async () => {
		const received: {
			method: string;
			path: string;
			body: unknown;
			authorization: string | undefined;
			device: unknown;
		}[] = [];
		const upstream = express();
		upstream.use(express.json());
		upstream.use((req, res) => {
			received.push({
				method: req.method,
				path: req.path,
				body: req.body,
				authorization: req.headers.authorization,
				device: req.headers["x-device-id"],
			});
			res
				.status(req.method === "POST" ? 409 : 200)
				.json(req.method === "POST" ? { code: "CONVERSATION_BUSY", error: "busy" } : { conversations: [] });
		});
		const hubUrl = await listen(createServer(upstream));
		const dataDir = await mkdtemp(join(tmpdir(), "local-conversations-"));
		cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
		await writeFile(
			join(dataDir, "device-center.json"),
			JSON.stringify({
				hubUrl,
				deviceId: "source",
				name: "Source",
				credential: "agent-secret",
				uiCredential: "ui-secret",
				allowExecution: false,
			}),
		);
		const app = express();
		app.use(express.json());
		const local = await installLocalDeviceCenter({ app, dataDir, connect: () => ({ close() {} }) });
		cleanup.push(() => local.close());
		const base = await listen(createServer(app));
		const route = `${base}/api/device-center/rooms/team/conversations`;
		for (const suffix of ["", "/thread"]) {
			expect((await fetch(route + suffix)).status).toBe(200);
		}
		const create = { name: "Review", targetBotId: "original-bot", text: "Start", idempotencyKey: "new-key" };
		const continuation = { text: "Follow up", kind: "message", requestId: "request", idempotencyKey: "continue-key" };
		for (const [suffix, body] of [
			["", create],
			["/thread/messages", continuation],
		] as const) {
			const result = await fetch(route + suffix, {
				method: "POST",
				headers: { Origin: base, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(result.status).toBe(409);
			expect(await result.json()).toEqual({ code: "HUB_REJECTED", error: "Hub rejected group request" });
		}
		expect(received.map((entry) => entry.path)).toEqual([
			"/api/device-user/rooms/team/conversations",
			"/api/device-user/rooms/team/conversations/thread",
			"/api/device-user/rooms/team/conversations",
			"/api/device-user/rooms/team/conversations/thread/messages",
		]);
		expect(received[2].body).toEqual(create);
		expect(received[3].body).toEqual(continuation);
		for (const entry of received) {
			expect(entry.authorization).toBe("Bearer ui-secret");
			expect(entry.device).toBe("source");
		}
		for (const [suffix, body] of [
			["", { ...create, credential: "injected" }],
			["/thread/messages", { ...continuation, targetBotId: "other-bot" }],
		] as const) {
			expect(
				(
					await fetch(route + suffix, {
						method: "POST",
						headers: { Origin: base, "Content-Type": "application/json" },
						body: JSON.stringify(body),
					})
				).status,
			).toBe(400);
		}
		expect(
			(
				await fetch(route + "/thread/messages", {
					method: "POST",
					headers: { Origin: "https://other.test", "Content-Type": "application/json" },
					body: JSON.stringify(continuation),
				})
			).status,
		).toBe(403);
		expect(received).toHaveLength(4);
	});
});
