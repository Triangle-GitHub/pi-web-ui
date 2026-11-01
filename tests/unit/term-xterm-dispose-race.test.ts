import { describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { readFileSync } from "node:fs";

// Regression guard for the conversation-switch console error
// "Cannot read properties of undefined (reading 'fg')": xterm's write
// queue keeps processing for a while after dispose() (WriteBuffer timers +
// rAF renderer callbacks), so a synchronous dispose() in the React cleanup
// can race with queued output and throw inside xterm internals.
//
// The fix keeps the display alive long enough to drain: dispose() is
// deferred to after the write queue settles (empty-write callback), with a
// hard timeout backstop for endless PTY output.

describe("TermXterm dispose-vs-write-queue race protection", () => {
	it("defers term.dispose() in cleanup until queued output drains (source guard)", () => {
		const src = readFileSync(new URL("../../web/src/components/TermXterm.tsx", import.meta.url), "utf8");

		// The cleanup must not dispose the terminal synchronously anymore.
		expect(src).not.toMatch(/term\.dispose\(\);\s*\n\s*termRef\.current = null;/);

		// It must schedule disposal through the write queue via disposeDisplay callback.
		expect(src).toMatch(/term\.write\(\s*""\s*,\s*disposeDisplay\s*\);/);

		// It must include a 5s fallback timeout backstop for stuck queues.
		expect(src).toMatch(/disposeTimer\s*=\s*setTimeout\(\s*disposeDisplay\s*,\s*5000\s*\);/);

		// disposeDisplay must clear the timer and protect active termRef ownership.
		expect(src).toMatch(/clearTimeout\(\s*disposeTimer\s*\);/);
		expect(src).toMatch(/if\s*\(\s*termRef\.current\?\.term\s*===\s*term\s*\)\s*termRef\.current\s*=\s*null;/);

		// Registry dispose must also delegate to disposeDisplay.
		expect(src).toMatch(/dispose:\s*\(\)\s*=>\s*disposeDisplay\(\)/);
	});

	it("drains queued output before calling dispose, preserving active reference on remount", async () => {
		vi.useFakeTimers();
		try {
			const term = new Terminal({ cols: 40, rows: 5 });
			const disposeSpy = vi.spyOn(term, "dispose");

			let displayDisposed = false;
			let disposeTimer: ReturnType<typeof setTimeout> | undefined;

			type TermRef = { current: { term: Terminal; fit: unknown } | null };
			const termRef: TermRef = { current: { term, fit: {} } };

			const disposeDisplay = () => {
				if (displayDisposed) return;
				displayDisposed = true;
				clearTimeout(disposeTimer);
				term.dispose();
				if (termRef.current?.term === term) termRef.current = null;
			};

			// Simulate in-flight output arriving before unmount
			term.write("line 1\r\nline 2\r\nline 3\r\n");

			// Simulate unmount cleanup scheduling
			term.write("", disposeDisplay);
			disposeTimer = setTimeout(disposeDisplay, 5000);

			// Dispose must NOT have happened synchronously
			expect(disposeSpy).not.toHaveBeenCalled();
			expect(termRef.current).not.toBeNull();

			// Simulate quick remount before queue drains (new terminal mounted in another component instance)
			const nextTerm = new Terminal({ cols: 40, rows: 5 });
			termRef.current = { term: nextTerm, fit: {} };

			// Now advance timers / flush microtasks so the empty-write callback runs
			await vi.runAllTimersAsync();

			// Old term disposed after drain
			expect(disposeSpy).toHaveBeenCalledTimes(1);

			// New terminal reference must NOT be clobbered by the old terminal's deferred cleanup
			expect(termRef.current).toEqual({ term: nextTerm, fit: {} });
			expect(termRef.current?.term).toBe(nextTerm);

			nextTerm.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("handles stuck write queue via 5s timeout backstop and remains idempotent", () => {
		vi.useFakeTimers();
		try {
			const term = new Terminal({ cols: 40, rows: 5 });
			const disposeSpy = vi.spyOn(term, "dispose");

			let displayDisposed = false;
			let disposeTimer: ReturnType<typeof setTimeout> | undefined;

			type TermRef = { current: { term: Terminal; fit: unknown } | null };
			const termRef: TermRef = { current: { term, fit: {} } };

			const disposeDisplay = () => {
				if (displayDisposed) return;
				displayDisposed = true;
				clearTimeout(disposeTimer);
				term.dispose();
				if (termRef.current?.term === term) termRef.current = null;
			};

			// Schedule without running queue callback
			disposeTimer = setTimeout(disposeDisplay, 5000);

			expect(disposeSpy).not.toHaveBeenCalled();
			expect(termRef.current?.term).toBe(term);

			// Fast-forward past the 5s backstop
			vi.advanceTimersByTime(5000);

			expect(disposeSpy).toHaveBeenCalledTimes(1);
			expect(termRef.current).toBeNull();

			// Subsequent calls (e.g. queue later finishing) must be no-ops
			disposeDisplay();
			expect(disposeSpy).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
