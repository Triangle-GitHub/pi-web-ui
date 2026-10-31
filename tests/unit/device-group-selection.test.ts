// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "../../web/src/i18n.js";
import { getContextMenu, closeContextMenu } from "../../web/src/context-menu-state.js";
import { DeviceGroupSection } from "../../web/src/components/DeviceGroupSection.js";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	closeContextMenu();
});
it("confirms clearing group messages and refreshes after success", async () => {
	const fetchMock = vi.fn(async (_url: unknown, _options?: unknown) => ({
		ok: true,
		json: async () => ({
			hubUrl: "https://hub.example.com",
			deviceId: "local",
			rooms: [{ id: "one", name: "Team", botIds: [] }],
		}),
	}));
	vi.stubGlobal("fetch", fetchMock);
	const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
	const changed = vi.fn();
	window.addEventListener("pi-web-ui:device-groups-changed", changed);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => {
			root.render(createElement(LanguageProvider, null, createElement(DeviceGroupSection)));
		});
		host.querySelector(".dg-side-row")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		const menu = getContextMenu()!;
		const clear = menu.entries!.find((entry) => entry.action === "clear")!;
		expect(clear).toBeDefined();
		await act(async () => {
			menu.onHostAction!(clear, menu.target);
		});
		expect(confirm.mock.calls[0][0]).toContain("Team");
		expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/clear"))).toHaveLength(0);
		confirm.mockReturnValue(true);
		await act(async () => {
			menu.onHostAction!(clear, menu.target);
		});
		expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/rooms/one/clear"))).toHaveLength(1);
		expect(changed).toHaveBeenCalledOnce();
		expect(host.querySelector(".dg-side-row")?.textContent).toContain("Team");
	} finally {
		act(() => root.unmount());
		host.remove();
		window.removeEventListener("pi-web-ui:device-groups-changed", changed);
	}
});
it("tracks the selected group from navigation and clears its highlight for ordinary chats", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: true,
			json: async () => ({
				hubUrl: "https://hub.example.com",
				deviceId: "local",
				rooms: [
					{ id: "one", name: "家", botIds: [] },
					{ id: "two", name: "工作", botIds: [] },
				],
			}),
		})),
	);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const render = async (selectedRoomId: string | null) =>
		act(async () => {
			root.render(createElement(LanguageProvider, null, createElement(DeviceGroupSection, { selectedRoomId })));
		});
	try {
		await render("one");
		expect(host.querySelectorAll(".dg-side-row")).toHaveLength(2);
		expect(host.querySelector(".dg-side-row")?.tagName).toBe("DIV");
		const open = vi.fn();
		window.addEventListener("pi-web-ui:device-group-open", open, { once: true });
		host.querySelector(".dg-side-row")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(open).toHaveBeenCalledOnce();
		expect(host.querySelector('[aria-current="page"]')?.textContent).toBe("家");
		await render("two");
		expect(host.querySelectorAll(".dg-side-row.is-selected")).toHaveLength(1);
		expect(host.querySelector('[aria-current="page"]')?.textContent).toBe("工作");
		await render(null);
		expect(host.querySelector(".dg-side-row.is-selected")).toBeNull();
	} finally {
		act(() => root.unmount());
		host.remove();
	}
});
