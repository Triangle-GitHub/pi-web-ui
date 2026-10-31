import http, { type ClientRequest } from "node:http";
import https from "node:https";
import { WebSocket } from "ws";
import { deviceTaskFailure } from "./task-error.js";
import {
	checkedUrl,
	createCommandChannel,
	createWsMessageChannel,
	WS_MESSAGE_BYTES,
	type DeviceCommand,
	cleanHeaders,
	decodeChunk,
	loopback,
	parseFrame,
	RELAY_LIMITS,
	safePath,
	sendChunks,
	sendFrame,
} from "./relay.js";

export interface DeviceConnectorOptions {
	hubUrl: string;
	deviceId: string;
	credential: string;
	localOrigin: string;
	localAuthToken?: string;
	onTask?: (task: any, signal?: AbortSignal) => unknown | Promise<unknown>;
	/** Parent disposes its executor; the next task after reconnect must create a fresh executor. */
	onDisconnect?: () => void;
	onConnect?: () => void | Promise<void>;
	onCommand?: (action: DeviceCommand, payload: unknown, signal: AbortSignal) => Promise<unknown>;
}
export function createDeviceConnector(options: DeviceConnectorOptions) {
	const hub = checkedUrl(options.hubUrl);
	const local = new URL(options.localOrigin);
	if (
		!["localhost", "127.0.0.1", "[::1]"].includes(local.hostname) ||
		!["http:", "https:"].includes(local.protocol) ||
		local.username ||
		local[("pass" + "word") as keyof URL] ||
		local.pathname !== "/" ||
		local.search ||
		local.hash
	)
		throw new Error("localOrigin must be a fixed loopback origin");
	if (
		!/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.deviceId) ||
		!options.credential ||
		/[\r\n]/.test(options.credential) ||
		(options.localAuthToken && /[\r\n]/.test(options.localAuthToken))
	)
		throw new Error("Invalid device credentials");
	const endpoint = new URL("/device-connect", hub);
	endpoint.protocol = hub.protocol === "https:" || hub.protocol === "wss:" ? "wss:" : "ws:";
	endpoint.searchParams.set("deviceId", options.deviceId);
	let closed = false;
	let tasksDisabled = false;
	const runningTasks = new Map<
		string,
		{ attemptId: string; ws: WebSocket; controller: AbortController; settled: Promise<void>; stopUnconfirmed: boolean }
	>();
	function stopTasks() {
		if (tasksDisabled) return;
		tasksDisabled = true;
		for (const task of runningTasks.values()) task.controller.abort();
		try {
			options.onDisconnect?.();
		} catch {}
	}
	let socket: WebSocket | undefined;
	let retry: NodeJS.Timeout | undefined;
	let attempts = 0;
	let lastPong = Date.now();
	const streams = new Map<string, { req?: ClientRequest; ws?: WebSocket; bytes: number; timer: NodeJS.Timeout }>();
	function dispose(id: string) {
		const stream = streams.get(id);
		if (stream) {
			streams.delete(id);
			clearTimeout(stream.timer);
			stream.req?.destroy();
			stream.ws?.terminate();
		}
	}
	function headers(value: unknown) {
		const result = cleanHeaders((value && typeof value === "object" ? value : {}) as Record<string, unknown>);
		result.host = local.host;
		result.origin = local.origin;
		if (options.localAuthToken) {
			result.authorization = `Bearer ${options.localAuthToken}`;
			result.cookie = `pi_web_token=${encodeURIComponent(options.localAuthToken)}`;
		}
		return result;
	}
	function location(value: string) {
		try {
			const url = new URL(value, local);
			if (
				options.localAuthToken &&
				(value.includes(options.localAuthToken) || value.includes(encodeURIComponent(options.localAuthToken)))
			)
				return undefined;
			if (url.origin === local.origin) return url.pathname + url.search + url.hash;
			const decoded = decodeURIComponent(url.href);
			if (/localhost|127\.0\.0\.1|\[::1\]/i.test(decoded)) return undefined;
			if (
				url.protocol === "https:" &&
				!loopback(url.hostname) &&
				!url.username &&
				!url[("pass" + "word") as keyof URL] &&
				(!options.localAuthToken || !value.includes(options.localAuthToken))
			)
				return url.href;
		} catch {}
		return undefined;
	}
	function connect() {
		if (closed) return;
		const ws = new WebSocket(endpoint, {
			headers: { authorization: `Bearer ${options.credential}` },
			maxPayload: RELAY_LIMITS.frame,
			perMessageDeflate: false,
			handshakeTimeout: 10_000,
		});
		socket = ws;
		const rpc = createCommandChannel(ws, options.onCommand);
		const messages = createWsMessageChannel(ws);
		const cancellations = new Set<string>();
		ws.on("open", () => {
			if (socket !== ws || closed) {
				ws.terminate();
				return;
			}
			attempts = 0;
			tasksDisabled = false;
			lastPong = Date.now();
			void Promise.resolve()
				.then(() => options.onConnect?.())
				.catch(() => ws.close(1011, "Bot sync failed"));
		});
		ws.on("pong", () => {
			lastPong = Date.now();
		});
		ws.on("message", (raw) => {
			if (socket !== ws || closed) return;
			try {
				const frame = parseFrame(Buffer.from(raw as Buffer));
				if (rpc.handle(frame)) return;
				if (frame.type === "task_cancel") {
					if (
						typeof frame.id !== "string" ||
						!frame.id ||
						frame.id.length > 128 ||
						typeof frame.taskId !== "string" ||
						typeof frame.attemptId !== "string" ||
						cancellations.size >= RELAY_LIMITS.cancellations ||
						cancellations.has(frame.id)
					)
						throw new Error("Invalid task cancellation");
					const id = frame.id;
					const task = runningTasks.get(frame.taskId);
					const matched = task?.ws === ws && task.attemptId === frame.attemptId;
					cancellations.add(frame.id);
					if (matched) task.controller.abort();
					void (matched ? task.settled : Promise.resolve()).then(() => {
						cancellations.delete(id);
						if (socket === ws && !closed)
							sendFrame(ws, {
								type: "task_cancelled",
								id: frame.id,
								taskId: frame.taskId,
								attemptId: frame.attemptId,
								stopped: matched && !task.stopUnconfirmed,
							});
					});
					return;
				}
				if (frame.type === "task") {
					if (tasksDisabled) throw new Error("Task executor disconnected");
					const task = frame.task as any;
					if (
						!task ||
						typeof task.id !== "string" ||
						typeof task.attemptId !== "string" ||
						typeof task.botId !== "string" ||
						!task.botId ||
						!Number.isSafeInteger(task.botRevision) ||
						task.botRevision < 1 ||
						task.deviceId !== options.deviceId ||
						runningTasks.has(task.id) ||
						runningTasks.size >= RELAY_LIMITS.streams
					)
						throw new Error("Invalid task");
					const controller = new AbortController();
					const emit = (status: string, report?: string) => {
						if (socket === ws && !closed && !controller.signal.aborted)
							sendFrame(ws, {
								type: "task_event",
								taskId: task.id,
								botId: task.botId,
								attemptId: task.attemptId,
								status,
								...(report ? { report: report.slice(0, 16_000) } : {}),
							});
					};
					emit("running");
					const execution = {
						attemptId: task.attemptId,
						ws,
						controller,
						settled: Promise.resolve(),
						stopUnconfirmed: false,
					};
					runningTasks.set(task.id, execution);
					execution.settled = Promise.resolve()
						.then(() => {
							if (!options.onTask) throw new Error("Task handler unavailable");
							if (controller.signal.aborted) throw new Error("Task cancelled");
							return options.onTask(task, controller.signal);
						})
						.then(
							(result) => emit("completed", typeof result === "string" ? result : undefined),
							(error) => {
								execution.stopUnconfirmed = !!error && typeof error === "object" && error.stopUnconfirmed === true;
								emit("failed", deviceTaskFailure(error));
							},
						)
						.finally(() => {
							if (runningTasks.get(task.id) === execution) runningTasks.delete(task.id);
						});
					return;
				}
				if (typeof frame.id !== "string" || frame.id.length > 128) throw new Error("Invalid stream");
				const id = frame.id;
				if (frame.type === "cancel" || frame.type === "ws_close") {
					messages.discard(id);
					dispose(id);
					return;
				}
				if (frame.type === "request" || frame.type === "ws_open") {
					if (
						streams.has(id) ||
						streams.size >= RELAY_LIMITS.streams ||
						!safePath(frame.path, frame.type === "ws_open" ? "WS" : String(frame.method))
					)
						throw new Error("Invalid request");
					const timer = setTimeout(() => {
						dispose(id);
						sendFrame(ws, { type: "error", id });
					}, 30 * 60_000);
					timer.unref();
					const stream: { req?: ClientRequest; ws?: WebSocket; bytes: number; timer: NodeJS.Timeout } = {
						bytes: 0,
						timer,
					};
					streams.set(id, stream);
					if (frame.type === "request") {
						if (typeof frame.method !== "string" || !/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(frame.method))
							throw new Error("Invalid method");
						const req = (local.protocol === "https:" ? https : http).request(
							{
								hostname: local.hostname.replace(/^\[|\]$/g, ""),
								port: local.port || undefined,
								protocol: local.protocol,
								path: frame.path,
								method: frame.method,
								headers: headers(frame.headers),
							},
							(res) => {
								const responseHeaders = cleanHeaders(res.headers);
								if (res.headers.location) {
									const target = location(res.headers.location);
									if (target) responseHeaders.location = target;
									else delete responseHeaders.location;
								}
								sendFrame(ws, { type: "response", id, status: res.statusCode, headers: responseHeaders });
								void (async () => {
									let bytes = 0;
									try {
										// Pull only as fast as the relay socket drains, instead of aborting bursts.
										for await (const data of res) {
											const chunk = Buffer.from(data);
											bytes += chunk.length;
											if (bytes > RELAY_LIMITS.body) throw new Error("Response too large");
											for (let offset = 0; offset < chunk.length; offset += RELAY_LIMITS.chunk) {
												while (ws.bufferedAmount > RELAY_LIMITS.queue / 2) {
													if (!streams.has(id) || ws.readyState !== WebSocket.OPEN) throw new Error("Cancelled");
													await new Promise((resolve) => setTimeout(resolve, 5));
												}
												if (!streams.has(id) || ws.readyState !== WebSocket.OPEN) throw new Error("Cancelled");
												await new Promise<void>((resolve, reject) => {
													ws.send(
														JSON.stringify({
															type: "response_body",
															id,
															data: chunk.subarray(offset, offset + RELAY_LIMITS.chunk).toString("base64"),
														}),
														(error) => (error ? reject(error) : resolve()),
													);
												});
											}
										}
										sendFrame(ws, { type: "response_end", id });
									} catch {
										res.destroy();
										sendFrame(ws, { type: "error", id });
									} finally {
										dispose(id);
									}
								})();
							},
						);
						stream.req = req;
						req.on("error", () => {
							if (streams.has(id)) {
								sendFrame(ws, { type: "error", id });
								dispose(id);
							}
						});
					} else {
						const target = new URL(local);
						target.protocol = local.protocol === "https:" ? "wss:" : "ws:";
						const protocols =
							typeof frame.protocols === "string" ? frame.protocols.split(",").map((x) => x.trim()) : [];
						const remote = new WebSocket(`${target.origin}${frame.path}`, protocols, {
							headers: headers(frame.headers),
							maxPayload: WS_MESSAGE_BYTES,
							perMessageDeflate: false,
							handshakeTimeout: 10_000,
						});
						stream.ws = remote;
						remote.on("open", () => {
							sendFrame(ws, { type: "ws_ready", id });
						});
						remote.on("message", (data, binary) => {
							if (!messages.send(id, Buffer.from(data as Buffer), binary)) remote.terminate();
						});
						remote.on("close", () => {
							messages.discard(id);
							sendFrame(ws, { type: "ws_close", id });
							dispose(id);
						});
						remote.on("error", () => {
							sendFrame(ws, { type: "error", id });
							dispose(id);
						});
					}
					return;
				}
				const stream = streams.get(id);
				if (!stream) return;
				if (frame.type === "request_body") {
					const data = decodeChunk(frame.data);
					stream.bytes += data.length;
					if (stream.req && stream.bytes <= RELAY_LIMITS.body) stream.req.write(data);
					if (stream.bytes > RELAY_LIMITS.body || !stream.req || stream.req.writableLength > RELAY_LIMITS.queue) {
						sendFrame(ws, { type: "error", id });
						dispose(id);
					}
				} else if (frame.type === "request_end") stream.req?.end();
				else if (frame.type === "ws_chunk" || frame.type === "ws_end") {
					if (!stream.ws) throw new Error("Missing WS stream");
					messages.receive(frame, stream.ws);
				} else throw new Error("Unknown frame");
			} catch {
				ws.terminate();
			}
		});
		ws.on("error", () => ws.terminate());
		ws.on("close", () => {
			rpc.close();
			messages.close();
			if (socket !== ws) return;
			socket = undefined;
			stopTasks();
			for (const id of streams.keys()) dispose(id);
			if (!closed) {
				const delay = Math.min(30_000, 500 * 2 ** Math.min(attempts++, 6)) + Math.floor(Math.random() * 250);
				retry = setTimeout(connect, delay);
				retry.unref();
			}
		});
	}
	const heartbeat = setInterval(() => {
		if (socket?.readyState === WebSocket.OPEN) {
			if (Date.now() - lastPong > 45_000) socket.terminate();
			else socket.ping();
		}
	}, 15_000);
	heartbeat.unref();
	connect();
	return {
		isOnline: () => socket?.readyState === WebSocket.OPEN,
		close() {
			closed = true;
			stopTasks();
			clearInterval(heartbeat);
			clearTimeout(retry);
			socket?.terminate();
			for (const id of streams.keys()) dispose(id);
		},
	};
}
export type DeviceConnector = ReturnType<typeof createDeviceConnector>;
