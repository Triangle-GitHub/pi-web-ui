// @vitest-environment jsdom
import { closeDesktopAccess, getDesktopAccess } from "../../web/src/device-access.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { DeviceCenter } from "../../web/src/components/DeviceCenter.js";
import { LanguageProvider } from "../../web/src/i18n.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
	cleanups
		.splice(0)
		.reverse()
		.forEach((fn) => fn());
	vi.unstubAllGlobals();
});
function response(body: unknown, status = 200) {
	return { ok: status < 400, status, json: async () => body } as Response;
}
async function mount() {
	localStorage.setItem("pi-web-ui:lang", "zh");
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	await act(async () => {
		root.render(createElement(LanguageProvider, null, createElement(DeviceCenter)));
	});
	return container;
}
describe("native device workspace", () => {
	it("hides permission and disconnect actions until paired", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response({ name: "Windows", allowExecution: false, connected: false })),
		);
		const page = await mount();
		expect(page.querySelector(".dc-form")).toBeNull();
		expect(page.querySelector(".dc-onboarding")?.textContent).toContain("连接已有中心");
		const settings = page.querySelectorAll<HTMLButtonElement>(".dc-nav-item")[2];
		await act(async () => settings.click());
		expect(page.querySelector(".dc-form")).not.toBeNull();
		await act(async () => page.querySelectorAll<HTMLButtonElement>(".dc-nav-item")[0].click());
		expect(page.querySelector(".dc-form")).toBeNull();
		expect(page.querySelector('[role="switch"]')).toBeNull();
		expect(page.querySelector(".dc-danger-zone")).toBeNull();
		expect(page.querySelector("iframe")).toBeNull();
	});
	it("rolls back execution permission when persistence fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url, init) =>
				init?.method === "POST"
					? response({ error: "save failed" }, 500)
					: response({
							name: "Mac",
							deviceId: "mac",
							hubUrl: "https://hub.example.com",
							allowExecution: false,
							connected: true,
						}),
			),
		);
		const page = await mount();
		expect(page.querySelector('[role="switch"]')).toBeNull();
		await act(async () => page.querySelectorAll<HTMLButtonElement>(".dc-nav-item")[2].click());
		const toggle = page.querySelector<HTMLButtonElement>('[role="switch"]')!;
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		await act(async () => toggle.click());
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		expect(page.querySelector('[role="alert"]')?.textContent).toContain("权限保存失败");
	});
	it("keeps a single device directory when alternating settings and groups", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url) => {
				const path = String(url).split("?")[0];
				if (path.endsWith("/devices")) return response({ devices: [{ id: "mac", name: "Mac", online: true }] });
				if (path.endsWith("/local-bots")) return response({ bots: [] });
				if (path.endsWith("/rooms")) return response({ rooms: [] });
				if (path.endsWith("/bots")) return response({ bots: [] });
				return response({
					name: "Mac",
					deviceId: "mac",
					hubUrl: "https://hub.example.com",
					allowExecution: false,
					connected: true,
				});
			}),
		);
		const page = await mount();
		const sections = () => page.querySelectorAll('section[aria-label="所有设备"]');
		expect(sections()).toHaveLength(1);
		for (let index = 0; index < 8; index++) {
			await act(async () => page.querySelectorAll<HTMLButtonElement>(".dc-nav-item")[2].click());
			expect(sections()).toHaveLength(1);
			expect(page.querySelectorAll(".dc-bots")).toHaveLength(1);
			await act(async () => page.querySelectorAll<HTMLButtonElement>(".dc-nav-item")[1].click());
			expect(sections()).toHaveLength(0);
			expect(page.querySelectorAll(".dc-bots")).toHaveLength(1);
			await act(async () => page.querySelectorAll<HTMLButtonElement>(".dc-nav-item")[0].click());
			expect(sections()).toHaveLength(1);
			expect(page.querySelectorAll(".dc-bots")).toHaveLength(0);
		}
	});
	it("opens the connected Hub from settings and authorizes remote desktop access", async () => {
		const replace = vi.fn();
		const tab = { opener: window, location: { replace }, close: vi.fn() };
		vi.spyOn(window, "open").mockReturnValue(tab as any);
		cleanups.push(() => vi.restoreAllMocks());
		const fetch = vi.fn(async (url) => {
			const path = String(url).split("?")[0];
			if (path.endsWith("/devices/mac/open"))
				return response({ url: "https://hub.example.com/device/mac/__open?ticket=access" });
			if (path.endsWith("/devices")) return response({ devices: [{ id: "mac", name: "Mac", online: true }] });
			if (path.endsWith("/local-bots")) return response({ bots: [] });
			return response({ name: "Mac", deviceId: "mac", hubUrl: "https://hub.example.com", connected: true });
		});
		vi.stubGlobal("fetch", fetch);
		const page = await mount();
		await act(async () => page.querySelectorAll<HTMLButtonElement>(".dc-nav-item")[2].click());
		const hub = page.querySelector<HTMLAnchorElement>(".dc-header a")!;
		expect(hub.href).toBe("https://hub.example.com/");
		expect(hub.target).toBe("_blank");
		const desktop = Array.from(page.querySelectorAll<HTMLAnchorElement>(".dd-device a")).find((a) =>
			a.textContent?.includes("远程桌面"),
		)!;
		expect(desktop.href).toBe("https://hub.example.com/device/mac/desktop");
		await act(async () => desktop.click());
		expect(fetch).toHaveBeenCalledWith(
			expect.stringContaining("/api/device-center/devices/mac/open"),
			expect.objectContaining({ method: "POST" }),
		);
		expect(window.open).not.toHaveBeenCalled();
		expect(replace).not.toHaveBeenCalled();
		expect(getDesktopAccess()?.url).toBe("https://hub.example.com/device/mac/__open?ticket=access&next=%2Fdesktop");
		closeDesktopAccess(getDesktopAccess()!);
		expect(tab.close).not.toHaveBeenCalled();
	});
	it("aborts an in-flight request on unmount", async () => {
		let signal: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn((_url, init) => {
				signal = init.signal;
				return new Promise(() => {});
			}),
		);
		await mount();
		expect(signal?.aborted).toBe(false);
		cleanups.pop()!();
		expect(signal?.aborted).toBe(true);
	});
});
