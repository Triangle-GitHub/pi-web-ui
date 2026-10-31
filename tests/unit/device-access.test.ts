// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RemoteDesktopWindow } from "../../web/src/components/RemoteDesktopWindow.js";
import { closeDesktopAccess, getDesktopAccess, openDeviceAccess } from "../../web/src/device-access.js";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const hub = "https://hub.example.com";
function ticket(url = `${hub}/device/mac/__open?ticket=fresh&next=/ignored`) {
	return vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: true, json: async () => ({ url }) })),
	);
}
async function mount() {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(createElement(RemoteDesktopWindow));
		await openDeviceAccess("mac", hub, true, false);
	});
}
async function click(label: string) {
	await act(async () => {
		document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
	});
}
afterEach(() => {
	act(() => {
		root?.unmount();
		const access = getDesktopAccess();
		if (access) closeDesktopAccess(access);
	});
	root = undefined;
	host?.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
it("keeps a sandboxed desktop alive through outside clicks, minimize, and fullscreen", async () => {
	ticket();
	const popup = vi.spyOn(window, "open");
	await mount();
	const frame = document.querySelector("iframe")!;
	expect(frame.src).toBe(`${hub}/device/mac/__open?ticket=fresh&next=%2Fdesktop`);
	expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-pointer-lock");
	expect(popup).not.toHaveBeenCalled();
	await act(async () => document.body.click());
	expect(document.querySelector("iframe")).toBe(frame);
	await click("Minimize");
	expect(frame.hidden).toBe(true);
	await click("Restore");
	expect(frame.hidden).toBe(false);
	await click("Fullscreen");
	expect(document.querySelector(".is-fullscreen")).not.toBeNull();
	await click("Exit fullscreen");
	expect(document.querySelector(".is-fullscreen")).toBeNull();
	expect(document.querySelector("iframe")).toBe(frame);
	await click("Close");
	expect(document.querySelector("iframe")).toBeNull();
});
it("retains the floating window on blocked popups and bridge failures, closes only after success", async () => {
	ticket();
	await mount();
	const access = getDesktopAccess();
	const popup = vi.spyOn(window, "open").mockReturnValue(null);
	const detach = () =>
		[...document.querySelectorAll("button")].find(
			(b) => b.textContent === "Separate tab" || b.textContent === "Separate window",
		)!;
	await act(async () => detach().click());
	expect(getDesktopAccess()).toBe(access);
	expect(document.querySelector('[role="alert"]')?.textContent).toContain("Allow popups");
	const openHub = vi.fn(async () => false);
	vi.stubGlobal("piDesktop", { openHub });
	await act(async () => detach().click());
	expect(getDesktopAccess()).toBe(access);
	openHub.mockResolvedValue(true);
	await act(async () => detach().click());
	expect(getDesktopAccess()).toBeNull();
	expect(openHub).toHaveBeenCalledWith(`${hub}/device/mac/__open?ticket=fresh&next=%2Fdesktop`);
	expect(popup).toHaveBeenCalledTimes(1);
});
it("obtains a fresh ticket for a separate tab and isolates its opener", async () => {
	ticket();
	await mount();
	const replace = vi.fn();
	const close = vi.fn();
	const tab = { opener: window, location: { replace }, close };
	vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
	ticket(`${hub}/device/mac/__open?ticket=second`);
	await act(async () =>
		[...document.querySelectorAll("button")].find((b) => b.textContent === "Separate tab")!.click(),
	);
	expect(tab.opener).toBeNull();
	expect(replace).toHaveBeenCalledWith(`${hub}/device/mac/__open?ticket=second&next=%2Fdesktop`);
	expect(close).not.toHaveBeenCalled();
	expect(getDesktopAccess()).toBeNull();
});
it.each([
	"https://evil.example/device/mac/__open",
	`${hub}/device/other/__open`,
	"javascript:alert(1)",
	"https://user:secret@hub.example.com/__device/open",
])("rejects an invalid ticket URL %s without replacing the current window", async (url) => {
	ticket();
	await mount();
	const access = getDesktopAccess();
	ticket(url);
	await expect(openDeviceAccess("mac", hub, true, false)).rejects.toThrow("Invalid device access URL");
	expect(getDesktopAccess()).toBe(access);
});
it("does not let an old detach completion close a newer desktop", async () => {
	ticket();
	await mount();
	const previous = getDesktopAccess()!;
	await act(async () => {
		await openDeviceAccess("mac", hub, true, false);
		closeDesktopAccess(previous);
	});
	expect(getDesktopAccess()).not.toBe(previous);
	expect(getDesktopAccess()).not.toBeNull();
});
