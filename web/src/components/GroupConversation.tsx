import { useEffect, useMemo, useRef, useState } from "react";
import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";
import { appUrl } from "../base-url";
import { randomUuid } from "../uuid";
import { withToken } from "../auth-token";
import { isZhLocale, useI18n } from "../i18n";
import { groupConversationState, groupSendAttempt, type GroupDetail, type GroupDevice } from "../device-group-messages";

type PersistentConversation = import("../device-group-messages").GroupBotConversation;

class GroupRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code = "",
	) {
		super(message);
	}
}
async function request<T>(path: string, signal: AbortSignal, body?: object): Promise<T> {
	const response = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
		method: body ? "POST" : "GET",
		credentials: "same-origin",
		signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
		...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok)
		throw new GroupRequestError(response.status, data.error || String(response.status), data.code ?? "");
	return data;
}
const emptyMap = new Map();
const noop = () => {};
export function GroupConversation({
	roomId,
	active = true,
	onBack,
}: {
	roomId: string;
	active?: boolean;
	onBack?: () => void;
}) {
	// Key the entire stream/composer lifecycle by room, including in-flight mutations and drafts.
	return <GroupRoom key={roomId} roomId={roomId} active={active} onBack={onBack} />;
}
function GroupRoom({ roomId, active, onBack }: { roomId: string; active: boolean; onBack?: () => void }) {
	const { locale } = useI18n();
	const zh = isZhLocale(locale);
	const [detail, setDetail] = useState<GroupDetail | null>(null);
	const devices: GroupDevice[] = detail?.bots ?? [];
	const [error, setError] = useState("");
	const [unavailable, setUnavailable] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const [conversations, setConversations] = useState<PersistentConversation[]>([]);
	const [conversationError, setConversationError] = useState("");
	function invalidatesRoom(cause: unknown): boolean {
		return (
			cause instanceof GroupRequestError &&
			(cause.status === 404 || cause.status === 403 || (cause.status === 409 && cause.code === "REPAIR_REQUIRED"))
		);
	}
	function explain(cause: unknown): string {
		if (cause instanceof GroupRequestError && cause.status === 409 && cause.code === "REPAIR_REQUIRED")
			return zh
				? "设备绑定已失效，请返回设备设置重新绑定。"
				: "Device binding expired. Return to device settings and bind again.";
		return cause instanceof Error ? cause.message : String(cause);
	}
	const generation = useRef(0);
	const mutation = useRef<AbortController | null>(null);
	const retry = useRef<{ fingerprint: string; key: string } | null>(null);
	const sending = useRef(false);
	useEffect(() => {
		const token = ++generation.current;
		let controller: AbortController | null = null;
		let inflight = false;
		async function poll() {
			if (!active || inflight || document.visibilityState === "hidden") return;
			inflight = true;
			controller = new AbortController();
			const signal = controller.signal;
			try {
				const base = `rooms/${encodeURIComponent(roomId)}`;
				const [room, list] = await Promise.allSettled([
					request<GroupDetail>(base, signal),
					request<{ conversations: PersistentConversation[] }>(`${base}/conversations`, signal),
				]);
				if (generation.current !== token || signal.aborted) return;
				if (list.status === "fulfilled" && Array.isArray(list.value.conversations)) {
					setConversations(list.value.conversations);
					setConversationError("");
				} else {
					setConversationError(
						zh ? "无法更新对话列表，请稍后重试。" : "Could not refresh conversations. Try again shortly.",
					);
				}
				if (room.status === "rejected") throw room.reason;
				setDetail(room.value);
				setUnavailable(false);
			} catch (cause) {
				if (generation.current !== token || signal.aborted) return;
				if (invalidatesRoom(cause)) {
					setDetail(null);
					setUnavailable(true);
				}
				setError(explain(cause));
			} finally {
				inflight = false;
			}
		}
		void poll();
		const timer = window.setInterval(() => void poll(), 2000);
		const visibility = () => {
			if (document.visibilityState === "hidden") controller?.abort();
			else void poll();
		};
		document.addEventListener("visibilitychange", visibility);
		return () => {
			++generation.current;
			controller?.abort();
			mutation.current?.abort();
			clearInterval(timer);
			document.removeEventListener("visibilitychange", visibility);
		};
	}, [roomId, active, refresh]);
	const { state, labels } = useMemo(
		() => groupConversationState(roomId, detail, devices, zh),
		[roomId, detail, devices, zh],
	);
	const members = devices.filter((d) => d.enabled !== false && detail?.room.botIds.includes(d.id));
	async function send(text: string, targets: string[], conversationId?: string): Promise<boolean> {
		if (!active || unavailable || !detail || sending.current) return false;
		const destination = conversationId;
		const selected = conversations.find((conversation) => conversation.id === destination);
		if (
			destination &&
			(!selected ||
				selected.status === "closed" ||
				conversationError ||
				!members.some((bot) => bot.id === selected.botId))
		) {
			setError(
				zh
					? "所选对话不可用，请重新选择对话或新建任务。"
					: "Selected conversation is unavailable. Choose a conversation or New task.",
			);
			return false;
		}
		if (selected && targets.some((id) => id !== selected.botId)) {
			setError(
				zh
					? "继续对话只能发送给原 Bot，请移除其他目标。"
					: "Continue with the original Bot only. Remove other targets.",
			);
			return false;
		}
		if (targets.some((id) => !detail.room.botIds.includes(id))) return false;
		retry.current = groupSendAttempt(retry.current, JSON.stringify([roomId, destination]), text, targets, randomUuid);
		const controller = new AbortController();
		mutation.current = controller;
		const token = generation.current;
		sending.current = true;
		try {
			const base = `rooms/${encodeURIComponent(roomId)}`;
			await request(
				destination ? `${base}/conversations/${encodeURIComponent(destination)}/messages` : `${base}/messages`,
				controller.signal,
				destination
					? { text, kind: "message", idempotencyKey: retry.current.key }
					: { text, targetBotIds: targets, idempotencyKey: retry.current.key },
			);
			if (controller.signal.aborted || generation.current !== token) return false;
			retry.current = null;
			setError("");
			setRefresh((n) => n + 1);
			return true;
		} catch (cause) {
			if (!controller.signal.aborted && generation.current === token) {
				if (destination) {
					setError(
						zh
							? "继续对话失败，请重试或重新选择目标。"
							: "Could not continue the conversation. Retry or choose a target.",
					);
					return false;
				}
				if (invalidatesRoom(cause)) {
					setDetail(null);
					setUnavailable(true);
				}
				setError(explain(cause));
			}
			return false;
		} finally {
			if (mutation.current === controller) {
				sending.current = false;
				mutation.current = null;
			}
		}
	}
	return (
		<>
			<div className="dg-head">
				<strong>{detail?.room.name ?? (zh ? "群聊" : "Group")}</strong>
				{onBack && (
					<button type="button" className="btn" onClick={onBack}>
						{zh ? "返回对话" : "Back to chat"}
					</button>
				)}
			</div>
			{error && (
				<div role="alert">
					{error}
					{unavailable
						? zh
							? "此群聊已删除或你已不在群中，请返回。"
							: "This group is unavailable or you are no longer a member. Return to chat."
						: null}
				</div>
			)}
			<MessageList state={state} liveOutputs={emptyMap} toolStatuses={emptyMap} messageLabels={labels} readOnly />
			<ChatInput
				groupDevices={members}
				groupConversations={conversations}
				groupConversationError={conversationError}
				onGroupSend={send}
				streaming={false}
				messages={state.messages}
				slashCommands={[]}
				modelState={null}
				models={[]}
				modelsLoading={false}
				attachments={[]}
				onRemoveAttachment={noop}
				onAddImageFiles={noop}
				onAddLocalFiles={noop}
				onNotice={(_level, text) => setError(text)}
				onSent={noop}
				onManageModels={noop}
				providerKeys={{}}
				quickPhrases={[]}
				quickPhrasesEnabled={false}
				groupReady={active && !!detail && !unavailable}
				sessionId={`device-group:${roomId}`}
				conversationId={`device-group:${roomId}`}
			/>
		</>
	);
}
