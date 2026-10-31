// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorktreeView, useWorktreeRefresh } from "../../web/src/components/WorktreeBanner";
import type { WorktreeInfo } from "../../server/protocol";
vi.mock("../../web/src/i18n", () => ({ useT: () => (key: string) => key }));
let root: Root;
let container: HTMLDivElement;
const refresh = vi.fn();
const switchTree = vi.fn();
const remove = vi.fn();
const back = vi.fn();
const info: WorktreeInfo = {
	isLinkedWorktree: false,
	currentPath: "/repo",
	mainPath: "/repo",
	mainBranch: "main",
	linkedWorktrees: [
		{
			path: "/repo/wt",
			branch: "feature/" + "long-name-".repeat(20),
			isMain: false,
			isCurrent: false,
			isDirty: true,
			uncommittedCount: 1,
		},
		{ path: "/repo/detached", isMain: false, isCurrent: false, isDirty: false, uncommittedCount: 0 },
	],
};
function render(value: WorktreeInfo | undefined = info) {
	act(() =>
		root.render(
			React.createElement(WorktreeView, {
				worktree: value,
				onRefresh: refresh,
				onSwitch: switchTree,
				onRemove: remove,
				onBack: back,
			}),
		),
	);
}
function click(selector: string) {
	act(() => (container.querySelector(selector) as HTMLButtonElement).click());
}
beforeEach(() => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers();
	vi.clearAllMocks();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.useRealTimers();
	vi.restoreAllMocks();
});
it("shows full branch names, detached HEAD, dirty state and a main repository in a page", () => {
	render();
	expect(container.querySelector(".worktree-banner")).toBeNull();
	expect(container.querySelectorAll(".worktree-card")).toHaveLength(3);
	expect(container.textContent).toContain(info.linkedWorktrees[0].branch);
	expect(container.textContent).toContain("worktreeDetached");
	expect(container.querySelector(".worktree-dirty")?.textContent).toBe("worktreeHasChanges");
	expect(container.querySelector(".current .worktree-card-path")?.textContent).toBe("/repo");
	click(".worktree-card:nth-child(2) .worktree-card-actions button");
	expect(switchTree).toHaveBeenCalledWith("/repo/wt");
	expect(back).not.toHaveBeenCalled();
});
it("keeps removal in collapsed details and respects cancellation without force", () => {
	render();
	const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
	expect(container.querySelector(".worktree-card-details")?.hasAttribute("open")).toBe(false);
	click(".worktree-card-details button");
	expect(remove).not.toHaveBeenCalled();
	confirm.mockReturnValue(true);
	click(".worktree-card-details button");
	expect(remove).toHaveBeenCalledExactlyOnceWith("/repo/wt");
});
it("supports current worktrees missing from sibling lists and returning to main", () => {
	render({ ...info, isLinkedWorktree: true, currentPath: "/repo/other", branch: "other" });
	expect(container.querySelectorAll(".worktree-card")).toHaveLength(4);
	expect(container.querySelector(".current strong")?.textContent).toBe("other");
	click(".worktree-card:first-child .worktree-card-actions button");
	expect(switchTree).toHaveBeenCalledWith("/repo");
	click(".worktree-view-header button");
	expect(back).toHaveBeenCalledOnce();
});
it("refreshes outside the page, on focus and interval, and cleans up on unmount", () => {
	function Refresh() {
		useWorktreeRefresh("/repo", refresh);
		return null;
	}
	act(() => root.render(React.createElement(Refresh)));
	expect(refresh).toHaveBeenCalledTimes(1);
	act(() => window.dispatchEvent(new Event("focus")));
	act(() => vi.advanceTimersByTime(30_000));
	expect(refresh).toHaveBeenCalledTimes(3);
	act(() => root.render(null));
	window.dispatchEvent(new Event("focus"));
	vi.advanceTimersByTime(30_000);
	expect(refresh).toHaveBeenCalledTimes(3);
});
