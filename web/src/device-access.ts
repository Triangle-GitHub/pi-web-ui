import { appUrl } from "./base-url";
import { withToken } from "./auth-token";

export type DesktopAccess = { id: string; hubUrl: string; url: string; zh: boolean };
let desktopAccess: DesktopAccess | null = null;
const listeners = new Set<() => void>();
export const subscribeDesktopAccess = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};
export const getDesktopAccess = () => desktopAccess;
export function closeDesktopAccess(expected: DesktopAccess) {
	if (desktopAccess !== expected) return;
	desktopAccess = null;
	listeners.forEach((listener) => listener());
}

/** Obtain a fresh ticket; desktop entry points share the persistent App window. */
export async function openDeviceAccess(id: string, hubUrl: string, desktop: boolean, zh: boolean, detached = false) {
	const floating = desktop && !detached;
	const shell = (window as unknown as { piDesktop?: { openHub?: (url: string) => Promise<boolean> } }).piDesktop;
	const tab = floating || shell?.openHub ? null : window.open("about:blank", "_blank");
	if (!floating && !shell?.openHub && !tab)
		throw new Error(zh ? "请允许弹出窗口后重试。" : "Allow popups and try again.");
	if (tab) tab.opener = null;
	try {
		const response = await fetch(withToken(appUrl(`/api/device-center/devices/${encodeURIComponent(id)}/open`)), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
			credentials: "same-origin",
			signal: AbortSignal.timeout(15000),
		});
		if (!response.ok)
			throw new Error(
				zh
					? "无法打开设备，请确认设备在线且本机绑定有效。"
					: "Could not open the device. Check connectivity and local pairing.",
			);
		const data = await response.json();
		const url = new URL(data.url);
		const hub = new URL(hubUrl);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.hostname !== hub.hostname ||
			url.username ||
			url.password ||
			!(
				url.pathname === "/__device/open" ||
				(url.origin === hub.origin && url.pathname === `/device/${encodeURIComponent(id)}/__open`)
			)
		)
			throw new Error("Invalid device access URL");
		url.searchParams.delete("next");
		if (desktop) url.searchParams.set("next", "/desktop");
		if (floating) {
			desktopAccess = { id, hubUrl, url: url.href, zh };
			listeners.forEach((listener) => listener());
		} else if (shell?.openHub) {
			if (!(await shell.openHub(url.href)))
				throw new Error(zh ? "无法打开设备窗口。" : "Could not open device window.");
		} else if (tab) tab.location.replace(url.href);
	} catch (error) {
		tab?.close();
		throw error;
	}
}
