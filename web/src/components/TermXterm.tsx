import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { CommandDef } from "../types";
import { buildTermTheme, THEME_CHANGE_EVENT } from "../theme";
import { shouldStartTouchScroll, touchWheelDeltaY } from "../term-touch";
import { useI18n } from "../i18n";
import { appSend } from "../app-globals";
import type { TerminalOwnerKind } from "../terminal-bridge";

/** Strip exit sentinels/baked banners; the banner itself renders on terminal_exit. */
function stripExitBanner(data: string): { clean: string; exitCode: number | null } {
	let exitCode: number | null = null;
	const clean = data
		.replace(/\r?\n?\[pi-term-exit:(-?\d+)\]\r?\n?/g, (_, c: string) => {
			exitCode = Number(c);
			return "\r\n";
		})
		.replace(/\r?\n?\x1b\[90m\[(?:进程已退出，退出码 |Process exited with code )-?\d+\]\x1b\[0m\r?\n?/g, "\r\n");
	return { clean, exitCode };
}

interface TermXtermProps {
	conversationId: string;
	terminalId: string;
	/** When set, the server runs this command in a new shell instead of a bare shell. */
	command?: CommandDef;
	/** Directory for a bare shell (from the snapshot at tab creation). */
	cwd: string;
	/** Display title (sent to server so the PTY metadata uses the correct locale). */
	title?: string;
	/** true = 终端接管 bash 的 AI 终端：重建时回传给服务端以保留名额豁免（issue #147）。 */
	agentBash?: boolean;
	ownerKind?: TerminalOwnerKind;
	/** Whether this terminal is the visible one. */
	active: boolean;
	/** Live running flag (banner renders when this flips false). */
	running?: boolean;
	/** Exit code (banner text). */
	exitCode?: number | null;
	register: (
		conversationId: string,
		id: string,
		writer: { write(data: string): void; dispose(): void; reset?(): void },
		ownerKind?: TerminalOwnerKind,
	) => () => void;
}

/**
 * One display per terminal tab. Mount only attaches to an existing PTY;
 * creation and explicit restart belong to the terminal actions. Kept mounted
 * while hidden so scrollback survives tab switches.
 */
export function TermXterm({
	conversationId,
	terminalId,
	ownerKind = "client",
	active,
	running,
	exitCode,
	register,
}: TermXtermProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
	// PTY lifecycle: the mount effect must NOT re-run on a language switch
	// (re-running would dispose and re-create the xterm view — scrollback lost
	// — and, for run_command terminals, make the server kill the running
	// process and re-execute the command). The exit banner instead follows the
	// LIVE locale via a small effect keyed on the running→stopped edge.
	// Client terminals survive conversation switches; their display identity does too.
	const routeConversationId = ownerKind === "conversation" ? conversationId : "";

	// Mount/unmount only owns the display and its subscription, never the PTY.
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const term = new Terminal({
			theme: buildTermTheme(),
			fontFamily: '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
			fontSize: 13,
			cursorBlink: true,
			scrollback: 8000,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(container);
		termRef.current = { term, fit };
		if (active) term.focus();

		// Re-theme the canvas when the active theme changes (the injected <link>
		// fires THEME_CHANGE_EVENT after its stylesheet has applied).
		const onThemeChange = () => {
			term.options.theme = buildTermTheme();
		};
		window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);

		// xterm maps Ctrl+V to ^V (0x16, readline quoted-insert) and Ctrl+C to
		// ^C, preventDefault()ing both, so the browser's native copy/paste never
		// fires. Returning false skips xterm's key handling entirely:
		//   · Ctrl+V / Cmd+V → browser-native paste (event lands on xterm's
		//     helper textarea and is forwarded to the shell)
		//   · Ctrl+C with a selection → copy instead of ^C (text staged in the
		//     helper textarea, same trick as xterm's own right-click copy; no
		//     clipboard-API permission needed, works over plain http)
		term.attachCustomKeyEventHandler((event) => {
			if (event.type !== "keydown") return true;
			const key = event.key?.toLowerCase();
			if ((event.ctrlKey || event.metaKey) && key === "v") {
				return false;
			}
			if (event.ctrlKey && !event.shiftKey && !event.altKey && key === "c") {
				if (term.hasSelection()) {
					const ta = term.textarea;
					if (ta) {
						ta.value = term.getSelection();
						ta.select();
					}
					return false;
				}
			}
			return true;
		});

		// Disposal deferral: xterm's write queue keeps parsing (and rendering)
		// for a while after dispose() is called, and a queued pass landing on the
		// torn-down instance surfaces as "Cannot read properties of undefined
		// (reading 'fg')" in the console (xterm 6.0.0 WriteBuffer/rAF dispose
		// race, xtermjs/xterm.js#6063/#5181 family). Drain the queue first via
		// an empty-write callback; the timeout only backstops a stuck backlog.
		let displayDisposed = false;
		let disposeTimer: ReturnType<typeof setTimeout> | undefined;

		const unregister = register(
			conversationId,
			terminalId,
			{
				write: (data) => term.write(stripExitBanner(data).clean),
				// reset() rebuilds both buffers, including scrollback, without clearing
				// xterm's write queue. Its empty-write callback runs after older output
				// and before queued replay/live writes, so none can cross the reset.
				reset: () => term.write("", () => term.reset()),
				// Deferred drain (disposeDisplay, defined below) prevents the same
				// parse/render race on explicit closes as on unmount.
				dispose: () => disposeDisplay(),
			},
			typeof ownerKind === "undefined" ? "client" : ownerKind,
		);

		// Kept below register() so the register→sendDims source range stays
		// self-contained for tests/unit/term-xterm-reset.test.ts.
		const disposeDisplay = () => {
			if (displayDisposed) return;
			displayDisposed = true;
			clearTimeout(disposeTimer);
			term.dispose();
			if (termRef.current?.term === term) termRef.current = null;
		};

		const sendDims = () => {
			try {
				fit.fit();
				appSend({
					type: "terminal_resize",
					terminalId,
					conversationId: routeConversationId,
					ownerKind,
					cols: term.cols,
					rows: term.rows,
				});
			} catch {
				// Container hidden — will re-fit when shown.
			}
		};

		// Attach also replays retained output for exited terminals, without spawning.
		const raf = requestAnimationFrame(() => {
			try {
				fit.fit();
			} catch {
				// ignore
			}
			appSend({
				type: "terminal_attach",
				terminalId,
				conversationId: routeConversationId,
				ownerKind,
				cols: term.cols,
				rows: term.rows,
			});
		});

		const onData = term.onData((data) => {
			appSend({ type: "terminal_input", terminalId, conversationId: routeConversationId, ownerKind, data });
		});

		// 手机端触摸滚动兜底（issue #218）：xterm 6.0.0 自身无任何 touch
		// 处理，手指竖拖看不到历史输出。把单指竖直拖动合成 WheelEvent
		// 派发到 .xterm-viewport，复用 xterm 自己的滚轮链路（含
		// scrollSensitivity、alt 缓冲/鼠标协议分发）。阈值 + 主轴判定保证
		// 轻点/长按选择/横向拖动不受影响；多指（缩放）直接忽略。
		// 上游 #5685 已把触摸滚动做进内核，升级到带该修复的
		// 版本后即可删掉本段。
		// term.open 之后 element 才存在；typing 上是可选的，监听全部可选链。
		const termEl = term.element;
		let touchId: number | null = null;
		let touchStartX = 0;
		let touchStartY = 0;
		let touchLastY = 0;
		let touchScrolling = false;
		const onTouchStart = (e: TouchEvent) => {
			if (e.touches.length !== 1) {
				touchId = null;
				touchScrolling = false;
				return;
			}
			const t = e.touches[0];
			touchId = t.identifier;
			touchStartX = t.clientX;
			touchStartY = t.clientY;
			touchLastY = t.clientY;
			touchScrolling = false;
		};
		const onTouchMove = (e: TouchEvent) => {
			if (touchId === null || e.touches.length !== 1) return;
			const t = e.touches[0];
			if (t.identifier !== touchId) return;
			if (!touchScrolling) {
				if (!shouldStartTouchScroll(t.clientX - touchStartX, t.clientY - touchStartY)) return;
				touchScrolling = true;
			}
			// 劫持后阻止下拉刷新/页面手势，手指跟着内容走。
			e.preventDefault();
			const deltaY = touchWheelDeltaY(touchLastY, t.clientY);
			touchLastY = t.clientY;
			if (deltaY === 0) return;
			if (typeof WheelEvent === "undefined") return;
			const wheelTarget = container.querySelector(".xterm-viewport") ?? termEl;
			wheelTarget?.dispatchEvent(
				new WheelEvent("wheel", {
					bubbles: true,
					cancelable: true,
					deltaY,
					deltaMode: 0,
					clientX: t.clientX,
					clientY: t.clientY,
				}),
			);
		};
		const onTouchEnd = (e: TouchEvent) => {
			if (touchId === null) return;
			// 仍有别的触点在（多指中的一指抬起）→ 整个手势作废。
			if (e.touches.length > 0) {
				touchId = null;
				touchScrolling = false;
				return;
			}
			touchId = null;
			touchScrolling = false;
		};
		// touchmove 必须是非 passive 才能 preventDefault（阻止下拉刷新）。
		termEl?.addEventListener("touchstart", onTouchStart, { passive: true });
		termEl?.addEventListener("touchmove", onTouchMove, { passive: false });
		termEl?.addEventListener("touchend", onTouchEnd);
		termEl?.addEventListener("touchcancel", onTouchEnd);

		let ro: ResizeObserver | null = null;
		if (typeof ResizeObserver !== "undefined") {
			ro = new ResizeObserver(() => {
				if (container.offsetWidth > 0 && container.offsetHeight > 0) {
					sendDims();
				}
			});
			ro.observe(container);
		}

		return () => {
			cancelAnimationFrame(raf);
			onData.dispose();
			termEl?.removeEventListener("touchstart", onTouchStart);
			termEl?.removeEventListener("touchmove", onTouchMove);
			termEl?.removeEventListener("touchend", onTouchEnd);
			termEl?.removeEventListener("touchcancel", onTouchEnd);
			window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
			ro?.disconnect();
			unregister();
			// Unmounting happens when switching conversations/views; the PTY is
			// persistent and is killed only by an explicit close action or agent tool.
			// Dispose only after the write queue has drained (see disposeDisplay)
			// so no in-flight parse/render pass lands on the torn-down instance.
			term.write("", disposeDisplay);
			disposeTimer = setTimeout(disposeDisplay, 5000);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [routeConversationId, ownerKind, terminalId, register]);

	// Becoming visible: re-fit (size may have changed while hidden) and focus.
	useEffect(() => {
		if (!active) return;
		const raf = requestAnimationFrame(() => {
			const inst = termRef.current;
			if (!inst) return;
			try {
				inst.fit.fit();
				appSend({
					type: "terminal_resize",
					terminalId,
					conversationId: routeConversationId,
					ownerKind,
					cols: inst.term.cols,
					rows: inst.term.rows,
				});
			} catch {
				// ignore
			}
			inst.term.focus();
		});
		return () => cancelAnimationFrame(raf);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active]);

	// Exit banner in the LIVE locale (reads t() at effect time, not at
	// PTY-creation time). Guarded by the running-state edge: the banner is
	// written once per running→stopped transition, so reruns in the SAME tab
	// (TerminalPanel reuses the component instance) and remounts of already-
	// stopped terminals each render their banner without duplicates.
	const { t } = useI18n();
	const lastRunning = useRef<boolean | undefined>(undefined);
	useEffect(() => {
		if (running === lastRunning.current) return;
		lastRunning.current = running;
		if (running !== false) return;
		const inst = termRef.current;
		if (!inst) return;
		inst.term.write(`\r\n\x1b[90m${t("exitBanner", { code: exitCode ?? "" })}\x1b[0m\r\n`);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [running, terminalId, exitCode]);

	return <div ref={containerRef} className={`term-xterm ${active ? "" : "hidden"}`} />;
}
