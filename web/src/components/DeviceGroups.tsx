import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEscapeKey } from "../shortcut-stack";
import { LocalBots } from "./LocalBots";
import { FiUsers, FiPlus, FiMessageSquare, FiMonitor } from "react-icons/fi";
import type { DeviceGroupNavigation } from "../device-group-navigation";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { isZhLocale, useI18n } from "../i18n";

type Device = { id: string; deviceId?: string; name: string; enabled: boolean; online?: boolean };
type Room = { id: string; name: string; botIds: string[] };
type Detail = { room: Room };
const words = {
	zh: {
		groups: "群聊",
		manage: "管理成员",
		save: "保存成员",
		create: "建群",
		name: "群名称",
		devices: "选择 Bot（设备仅承载 Bot）",
		empty: "还没有群聊，创建一个群开始协作。",
		choose: "选择一个群聊",
		open: "打开聊天",
		online: "在线",
		offline: "离线",
		cancel: "取消",
		loading: "加载中…",
		rebind: "设备绑定已失效或已解除，请在设备设置中重新绑定。",
		forbidden: "本机访问被拒绝，请检查本机登录状态与访问权限。",
		failed: "请求失败",
	},
	en: {
		groups: "Groups",
		manage: "Manage members",
		save: "Save members",
		create: "Create group",
		name: "Group name",
		devices: "Select Bots (devices host Bots)",
		empty: "No groups yet. Create a group to collaborate.",
		choose: "Select a group",
		open: "Open chat",
		online: "Online",
		offline: "Offline",
		cancel: "Cancel",
		loading: "Loading…",
		rebind: "The device binding has expired or was removed. Bind again in device settings.",
		forbidden: "Local access denied. Check your local sign-in and access permissions.",
		failed: "Request failed",
	},
};
class RequestError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}
async function request<T>(path: string, signal: AbortSignal, body?: object): Promise<T> {
	const response = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
		method: body ? "POST" : "GET",
		credentials: "same-origin",
		signal,
		...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok)
		throw new RequestError(
			response.status,
			data.code ?? "",
			typeof data.error === "string" ? data.error : String(response.status),
		);
	return data as T;
}
function openChat(roomId: string) {
	window.dispatchEvent(new CustomEvent("pi-web-ui:device-group-open", { detail: { roomId } }));
}

export function DeviceGroupCreateDialog({ onClose }: { onClose: () => void }) {
	const { locale } = useI18n();
	const w = words[isZhLocale(locale) ? "zh" : "en"];
	useEscapeKey(() => {
		if (!document.querySelector("dialog[open]")) onClose();
	});
	return createPortal(
		<div className="modal-backdrop" onClick={onClose}>
			<div
				className="device-group-create-dialog"
				role="dialog"
				aria-modal="true"
				aria-label={w.create}
				onClick={(event) => event.stopPropagation()}
			>
				<DeviceGroups createOnly onClose={onClose} />
			</div>
		</div>,
		document.body,
	);
}

export function DeviceGroups({
	active = true,
	navigation,
	createOnly = false,
	onClose,
}: {
	active?: boolean;
	navigation?: DeviceGroupNavigation;
	createOnly?: boolean;
	onClose?: () => void;
}) {
	const { locale } = useI18n();
	const w = words[isZhLocale(locale) ? "zh" : "en"];
	const [devices, setDevices] = useState<Device[]>([]);
	const [rooms, setRooms] = useState<Room[]>([]);
	const [roomId, setRoomId] = useState("");
	const [detail, setDetail] = useState<Detail | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [creating, setCreating] = useState(createOnly);
	const [managing, setManaging] = useState(false);
	const [creatingBot, setCreatingBot] = useState(false);
	const [name, setName] = useState("");
	const [selected, setSelected] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const pendingManage = useRef<string | null>(null);
	const navigationRevision = useRef<number | undefined>(undefined);
	const generation = useRef(0);
	const mutation = useRef<AbortController | null>(null);
	const translations = useRef(w);
	translations.current = w;
	function explain(cause: unknown) {
		const labels = translations.current;
		if (cause instanceof RequestError) {
			if (
				(cause.status === 409 && /^(REPAIR_REQUIRED|NOT_PAIRED|DEVICE_CHANGED)$/.test(cause.code)) ||
				(cause.status === 403 && /binding|credential|unpaired|revoked|not_bound|hub_forbidden/i.test(cause.code))
			)
				return labels.rebind;
			if (cause.status === 403) return labels.forbidden;
		}
		return `${labels.failed}: ${cause instanceof Error ? cause.message : String(cause)}`;
	}
	function cancelMutation() {
		mutation.current?.abort();
		mutation.current = null;
		setBusy(false);
	}
	function selectRoom(id: string, manage = false) {
		++generation.current;
		cancelMutation();
		setRoomId(id);
		setDetail(null);
		setCreating(false);
		setManaging(manage);
		pendingManage.current = manage ? id : null;
		setSelected([]);
		setLoading(true);
		setError("");
		setRefresh((value) => value + 1);
	}
	function beginCreate() {
		++generation.current;
		cancelMutation();
		setCreating(true);
		setManaging(false);
		pendingManage.current = null;
		setDetail(null);
		setSelected([]);
		setName("");
		setError("");
		setRefresh((value) => value + 1);
	}
	useEffect(() => {
		const token = ++generation.current;
		let controller: AbortController | null = null;
		let inflight = false;
		const valid = () => generation.current === token;
		async function poll() {
			if (!active || document.visibilityState === "hidden" || inflight) return;
			inflight = true;
			const current = new AbortController();
			controller = current;
			try {
				const [deviceData, roomData, next] = await Promise.all([
					request<{ bots: Device[] }>("bots", current.signal),
					request<{ rooms: Room[] }>("rooms", current.signal),
					managing && roomId
						? request<Detail>(`rooms/${encodeURIComponent(roomId)}`, current.signal)
						: Promise.resolve(null),
				]);
				if (!valid() || current.signal.aborted) return;
				setDevices(deviceData.bots);
				setRooms(roomData.rooms);
				setDetail(next);
				if (next && pendingManage.current === next.room.id) {
					pendingManage.current = null;
					setSelected(next.room.botIds);
				}
				setError("");
			} catch (cause) {
				if (valid() && !current.signal.aborted) setError(explain(cause));
			} finally {
				current.abort();
				inflight = false;
				if (valid()) setLoading(false);
			}
		}
		void poll();
		const timer = window.setInterval(() => void poll(), 3000);
		const visibility = () => {
			if (document.visibilityState === "hidden") controller?.abort();
			else void poll();
		};
		document.addEventListener("visibilitychange", visibility);
		return () => {
			++generation.current;
			controller?.abort();
			clearInterval(timer);
			document.removeEventListener("visibilitychange", visibility);
		};
	}, [active, roomId, managing, refresh]);
	useEffect(() => () => mutation.current?.abort(), []);
	useEffect(() => {
		if (!active) cancelMutation();
	}, [active]);
	useEffect(() => {
		if (!active || !navigation || navigation.revision === navigationRevision.current) return;
		navigationRevision.current = navigation.revision;
		if (navigation.create) beginCreate();
		else if (navigation.roomId) {
			// App already routes the open request. Consuming it must not emit it again:
			// a new navigation revision would re-enter this effect indefinitely.
			selectRoom(navigation.roomId, navigation.manage);
		}
	}, [active, navigation?.revision]);
	async function save() {
		if (!active || mutation.current || (creating ? !name.trim() : !detail)) return;
		const controller = new AbortController();
		mutation.current = controller;
		setBusy(true);
		setError("");
		const isCreate = creating;
		const id = detail?.room.id;
		try {
			const { room } = await request<{ room: Room }>(
				isCreate ? "rooms" : `rooms/${encodeURIComponent(id!)}/members`,
				controller.signal,
				isCreate ? { name: name.trim(), botIds: selected } : { botIds: selected },
			);
			if (controller.signal.aborted || mutation.current !== controller) return;
			setRooms((old) => [...old.filter((item) => item.id !== room.id), room]);
			setRoomId(room.id);
			setDetail({ room });
			setCreating(false);
			setManaging(false);
			setName("");
			setSelected([]);
			setRefresh((value) => value + 1);
			window.dispatchEvent(new CustomEvent("pi-web-ui:device-groups-changed"));
			if (isCreate) {
				openChat(room.id);
				if (createOnly) onClose?.();
			}
		} catch (cause) {
			if (!controller.signal.aborted && mutation.current === controller) setError(explain(cause));
		} finally {
			if (mutation.current === controller) {
				mutation.current = null;
				setBusy(false);
			}
		}
	}
	const currentRoom = rooms.find((room) => room.id === roomId);
	return (
		<section className="dg-root" aria-label={w.groups}>
			{!createOnly && (
				<div className="dc-card dg-sidebar">
					<div className="dg-heading">
						<h2>
							<FiUsers /> {w.groups}
						</h2>
						<button className="dc-button" type="button" disabled={!active} onClick={beginCreate}>
							<FiPlus /> {w.create}
						</button>
					</div>
					<div className="dg-rooms">
						{rooms.map((room) => (
							<button
								className="dc-button dg-room"
								type="button"
								key={room.id}
								aria-current={room.id === roomId ? "page" : undefined}
								disabled={!active}
								onClick={() => {
									selectRoom(room.id);
									openChat(room.id);
								}}
							>
								<FiMessageSquare /> {room.name}
							</button>
						))}
					</div>
					{!loading && !rooms.length && <p className="dg-empty">{w.empty}</p>}
				</div>
			)}
			<div className="dc-card dg-chat">
				{error && (
					<p className="dc-error" role="alert">
						{error}
					</p>
				)}
				{loading && <p role="status">{w.loading}</p>}
				{creating || managing ? (
					<form
						className="dg-create"
						onSubmit={(event) => {
							event.preventDefault();
							void save();
						}}
					>
						<h2>{creating ? w.create : w.manage}</h2>
						{creating && (
							<div className="dc-field">
								<label htmlFor="device-group-name">{w.name}</label>
								<input
									id="device-group-name"
									value={name}
									onChange={(event) => setName(event.target.value)}
									disabled={busy || !active}
								/>
							</div>
						)}
						<fieldset disabled={busy || !active || (managing && !detail)}>
							<legend>{w.devices}</legend>
							{devices.map((device) => (
								<label className="dg-device" key={device.id}>
									<input
										type="checkbox"
										disabled={!device.enabled && !selected.includes(device.id)}
										checked={selected.includes(device.id)}
										onChange={(event) =>
											setSelected((old) =>
												event.target.checked ? [...old, device.id] : old.filter((id) => id !== device.id),
											)
										}
									/>
									<FiMonitor />
									<span>
										{device.name} · {device.id} · {device.deviceId} · {device.online ? w.online : w.offline}
									</span>
								</label>
							))}
						</fieldset>
						<div className="dc-actions">
							<button
								className="dc-button"
								type="button"
								disabled={busy || !active || creatingBot}
								onClick={() => setCreatingBot(true)}
							>
								<FiPlus /> {isZhLocale(locale) ? "新建 Bot" : "Create Bot"}
							</button>
							<button
								className="dc-button"
								type="submit"
								disabled={busy || !active || (creating ? !name.trim() : !detail)}
							>
								{creating ? w.create : w.save}
							</button>
							<button
								className="dc-button"
								type="button"
								onClick={() => {
									cancelMutation();
									pendingManage.current = null;
									if (createOnly) onClose?.();
									setCreating(false);
									setManaging(false);
									setError("");
								}}
							>
								{w.cancel}
							</button>
						</div>
					</form>
				) : currentRoom ? (
					<>
						<div className="dg-title">
							<h2>
								<FiUsers /> {currentRoom.name}
							</h2>
						</div>
						<div className="dc-actions">
							<button className="dc-button" type="button" disabled={!active} onClick={() => openChat(currentRoom.id)}>
								<FiMessageSquare />
								{w.open}
							</button>
							<button
								className="dc-button"
								type="button"
								disabled={!active}
								onClick={() => selectRoom(currentRoom.id, true)}
							>
								<FiUsers />
								{w.manage}
							</button>
						</div>
					</>
				) : (
					<p className="dg-empty">{w.choose}</p>
				)}
			</div>
			{creatingBot && (
				<LocalBots
					createOnly
					onCancel={() => setCreatingBot(false)}
					onCreated={(bot, synced) => {
						setCreatingBot(false);
						if (synced && bot.enabled) {
							setDevices((old) => [...old.filter((item) => item.id !== bot.id), bot]);
							setSelected((old) => [...new Set([...old, bot.id])]);
						} else {
							setError(
								isZhLocale(locale)
									? "Bot 已保存；请启用并同步到中心后，再加入群组。"
									: "Bot saved. Enable and sync it to the hub before adding it to the group.",
							);
						}
					}}
				/>
			)}
		</section>
	);
}
