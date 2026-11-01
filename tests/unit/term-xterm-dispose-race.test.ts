import { describe, expect, it } from "vitest";

// Regression guard for the conversation-switch console error
// "Cannot read properties of undefined (reading 'fg')": xterm's write
// queue keeps processing for a while after dispose() (WriteBuffer timers +
// rAF renderer callbacks), so a synchronous dispose() in the React cleanup
// can race with queued output and throw inside xterm internals.
//
// The fix keeps the display alive long enough to drain: dispose() is
// deferred to after the write queue settles (empty-write callback), with a
// hard timeout backstop for endless PTY output.
it("defers term.dispose() until queued output drains (guarded by source assertions)", async () => {
	const { readFileSync } = await import("node:fs");
	const src = readFileSync(new URL("../../web/src/components/TermXterm.tsx", import.meta.url), "utf8");

	// The cleanup must not dispose the terminal synchronously anymore.
	expect(src).not.toMatch(/term\.dispose\(\);\s*\n\s*termRef\.current = null;/);

	// It must schedule the disposal through the write queue (empty write
	// callback = fires once all earlier queued data has been parsed).
	expect(src).toMatch(/term\.write\(\s*""\s*,\s*\(\)\s*=>/);

	// And it must not drop the reference until disposal is scheduled.
	expect(src).toMatch(/termRef\.current = null/);
});
