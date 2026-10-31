/**
 * 洛雪音乐 (LX Music) 客户端入口 —— 全功能专业音乐播放器
 * 特性：一键播放全部、静默添加队列(无阻断弹窗)、多源搜索、热歌榜单、收藏夹持久化、播放队列抽屉、画中画桌面浮动歌词、音质切换、歌曲下载、快捷键
 */

let globalAudio = null;
let globalState = {
	currentSong: null,
	isPlaying: false,
	currentTime: 0,
	duration: 0,
	playMode: "loop", // loop | random | single
	queue: [],
	favorites: [],
	searchResults: [],
	source: "wy",
	lyrics: [],
	currentLrcIndex: -1,
	volume: 0.8,
	quality: "128k", // 128k | 320k | flac
	activeUserApi: null,
	activeViewTab: "search", // search | top | favorites | queue
	topChartType: "hot", // hot | soar | new
};

// ==============================
// 轻量无阻断 Toast 提示系统 (不弹 alert)
// ==============================
let toastTimer = null;
function showToast(message, duration = 1800) {
	if (!activeRootEl) return;
	let toast = activeRootEl.querySelector("#lx-toast");
	if (!toast) {
		toast = document.createElement("div");
		toast.id = "lx-toast";
		toast.className = "lx-toast";
		activeRootEl.appendChild(toast);
	}
	toast.textContent = message;
	toast.classList.add("show");

	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		toast.classList.remove("show");
	}, duration);
}

// ==============================
// 画中画桌面歌词 (Picture-in-Picture)
// ==============================
let pipVideo = null;
let pipCanvas = null;
let pipCtx = null;
let isPipActive = false;

function initPipEngine() {
	if (!pipCanvas) {
		pipCanvas = document.createElement("canvas");
		pipCanvas.width = 640;
		pipCanvas.height = 140;
		pipCtx = pipCanvas.getContext("2d");
	}
	if (!pipVideo) {
		pipVideo = document.createElement("video");
		pipVideo.muted = true;
		pipVideo.playsInline = true;
		const stream = pipCanvas.captureStream(15);
		pipVideo.srcObject = stream;
		pipVideo.play().catch(() => {});

		pipVideo.addEventListener("enterpictureinpicture", () => {
			isPipActive = true;
			updatePipBtnState();
		});
		pipVideo.addEventListener("leavepictureinpicture", () => {
			isPipActive = false;
			updatePipBtnState();
		});
	}
}

function updatePipLyric(mainText, subText = "") {
	if (!pipCtx) return;
	pipCtx.fillStyle = "#14161d";
	pipCtx.fillRect(0, 0, 640, 140);

	pipCtx.strokeStyle = "rgba(255,255,255,0.08)";
	pipCtx.lineWidth = 2;
	pipCtx.strokeRect(1, 1, 638, 138);

	pipCtx.fillStyle = "#88c0d0";
	pipCtx.font = "bold 24px -apple-system, BlinkMacSystemFont, sans-serif";
	pipCtx.textAlign = "center";
	pipCtx.textBaseline = "middle";
	pipCtx.fillText(mainText || "洛雪音乐", 320, 52);

	pipCtx.fillStyle = "#7e8798";
	pipCtx.font = "15px sans-serif";
	pipCtx.fillText(
		subText || (globalState.currentSong ? `${globalState.currentSong.name} - ${globalState.currentSong.singer}` : ""),
		320,
		96,
	);
}

async function togglePictureInPicture() {
	initPipEngine();
	try {
		if (document.pictureInPictureElement) {
			await document.exitPictureInPicture();
		} else {
			updatePipLyric(
				globalState.lyrics[globalState.currentLrcIndex]?.text || "正在播放",
				globalState.currentSong ? `${globalState.currentSong.name} - ${globalState.currentSong.singer}` : "",
			);
			await pipVideo.requestPictureInPicture();
		}
	} catch (err) {
		showToast(`画中画启动失败: ${err.message}`);
	}
}

function updatePipBtnState() {
	if (!activeRootEl) return;
	const btn = activeRootEl.querySelector("#lx-pip-btn");
	if (btn) {
		if (isPipActive) btn.classList.add("active");
		else btn.classList.remove("active");
	}
}

// ==============================
// 播放核心与事件总线
// ==============================
function ensureGlobalAudio(apiBase) {
	if (!globalAudio) {
		globalAudio = new Audio();
		globalAudio.volume = globalState.volume;

		globalAudio.addEventListener("timeupdate", () => {
			globalState.currentTime = globalAudio.currentTime;
			globalState.duration = globalAudio.duration || globalState.currentSong?.durationSec || 0;
			updateProgressBar();
			updateCurrentLyric(globalAudio.currentTime);
		});

		globalAudio.addEventListener("play", () => {
			globalState.isPlaying = true;
			updatePlayButtonState();
			updateMediaSession();
		});

		globalAudio.addEventListener("pause", () => {
			globalState.isPlaying = false;
			updatePlayButtonState();
			updateMediaSession();
		});

		globalAudio.addEventListener("ended", () => {
			playNextSong();
		});

		globalAudio.addEventListener("error", (e) => {
			console.warn("[LX-Music] Audio error, trying fallback...", e);
		});
	}
	return globalAudio;
}

function parseLrc(lrcText) {
	if (!lrcText) return [{ time: 0, text: "暂无歌词" }];
	const lines = lrcText.split("\n");
	const result = [];
	const timeReg = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]/g;

	for (const line of lines) {
		const matches = [...line.matchAll(timeReg)];
		const text = line.replace(timeReg, "").trim();
		if (!text) continue;

		for (const m of matches) {
			const min = parseInt(m[1], 10);
			const sec = parseInt(m[2], 10);
			const ms = m[3] ? parseInt(m[3].padEnd(3, "0"), 10) : 0;
			const totalSec = min * 60 + sec + ms / 1000;
			result.push({ time: totalSec, text });
		}
	}

	result.sort((a, b) => a.time - b.time);
	return result.length ? result : [{ time: 0, text: "暂无有效歌词" }];
}

function formatTime(sec) {
	if (isNaN(sec) || sec < 0) return "00:00";
	const s = Math.floor(sec);
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return `${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

let activeRootEl = null;
let apiBaseUrl = "";

function updatePlayButtonState() {
	if (!activeRootEl) return;
	const btn = activeRootEl.querySelector("#lx-play-btn");
	const coverDisc = activeRootEl.querySelector("#lx-cover-disc");
	if (btn) {
		btn.innerHTML = globalState.isPlaying
			? `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
			: `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
		btn.title = globalState.isPlaying ? "暂停 (Space)" : "播放 (Space)";
	}
	if (coverDisc) {
		if (globalState.isPlaying) coverDisc.classList.add("playing");
		else coverDisc.classList.remove("playing");
	}
}

function updateProgressBar() {
	if (!activeRootEl) return;
	const curText = activeRootEl.querySelector("#lx-cur-time");
	const durText = activeRootEl.querySelector("#lx-dur-time");
	const progressInner = activeRootEl.querySelector("#lx-progress-bar-inner");

	if (curText) curText.textContent = formatTime(globalState.currentTime);
	if (durText) durText.textContent = formatTime(globalState.duration);
	if (progressInner && globalState.duration > 0) {
		const pct = Math.min(100, Math.max(0, (globalState.currentTime / globalState.duration) * 100));
		progressInner.style.width = `${pct}%`;
	}
}

function updateCurrentLyric(currentTime) {
	if (!activeRootEl || !globalState.lyrics.length) return;
	let idx = -1;
	for (let i = 0; i < globalState.lyrics.length; i++) {
		if (currentTime >= globalState.lyrics[i].time) {
			idx = i;
		} else {
			break;
		}
	}
	if (idx !== globalState.currentLrcIndex && idx !== -1) {
		globalState.currentLrcIndex = idx;
		const curLine = globalState.lyrics[idx];
		const nextLine = globalState.lyrics[idx + 1];

		updatePipLyric(curLine.text, nextLine ? nextLine.text : "");

		const lrcContainer = activeRootEl.querySelector("#lx-lyrics-scroll");
		if (lrcContainer) {
			const items = lrcContainer.querySelectorAll(".lx-lrc-line");
			items.forEach((item, i) => {
				if (i === idx) {
					item.classList.add("active");
					const containerHeight = lrcContainer.clientHeight;
					const itemTop = item.offsetTop;
					lrcContainer.scrollTo({
						top: itemTop - containerHeight / 2 + item.clientHeight / 2,
						behavior: "smooth",
					});
				} else {
					item.classList.remove("active");
				}
			});
		}
	}
}

function updateMediaSession() {
	if ("mediaSession" in navigator && globalState.currentSong) {
		const s = globalState.currentSong;
		navigator.mediaSession.metadata = new MediaMetadata({
			title: s.name,
			artist: s.singer,
			album: s.album || "洛雪音乐",
			artwork: s.pic ? [{ src: s.pic, sizes: "300x300", type: "image/jpeg" }] : [],
		});
		navigator.mediaSession.setActionHandler("play", () => {
			if (globalAudio) globalAudio.play();
		});
		navigator.mediaSession.setActionHandler("pause", () => {
			if (globalAudio) globalAudio.pause();
		});
		navigator.mediaSession.setActionHandler("previoustrack", () => {
			playPrevSong();
		});
		navigator.mediaSession.setActionHandler("nexttrack", () => {
			playNextSong();
		});
	}
}

async function playSong(song, addToQueue = true) {
	const audio = ensureGlobalAudio(apiBaseUrl);
	globalState.currentSong = song;

	if (addToQueue) {
		const exists = globalState.queue.find((item) => item.id === song.id && item.source === song.source);
		if (!exists) {
			globalState.queue.push(song);
			updateQueueBadge();
		}
	}

	renderPlayerBarInfo();
	updatePlayButtonState();
	renderCurrentTable();

	// 1. 获取歌词
	try {
		const lrcRes = await fetch(`${apiBaseUrl}/lyric?source=${song.source}&songId=${encodeURIComponent(song.id)}`).then(
			(r) => r.json(),
		);
		if (lrcRes.ok && lrcRes.lyric) {
			globalState.lyrics = parseLrc(lrcRes.lyric);
		} else {
			globalState.lyrics = [{ time: 0, text: `${song.name} - ${song.singer} (暂无歌词)` }];
		}
	} catch {
		globalState.lyrics = [{ time: 0, text: "歌词加载失败" }];
	}
	renderLyrics();

	// 2. 获取真实音频链接
	try {
		const urlRes = await fetch(
			`${apiBaseUrl}/song-url?source=${song.source}&songId=${encodeURIComponent(song.id)}&name=${encodeURIComponent(song.name)}&singer=${encodeURIComponent(song.singer)}&album=${encodeURIComponent(song.album || "")}&quality=${globalState.quality}`,
		).then((r) => r.json());

		if (urlRes.ok && urlRes.url) {
			song._realPlayUrl = urlRes.url;
			const streamUrl = `${apiBaseUrl}/stream?url=${encodeURIComponent(urlRes.url)}&source=${song.source}`;
			audio.src = streamUrl;
			await audio.play();
		} else {
			showToast(`无法获取播放链接: ${song.name}`);
		}
	} catch (err) {
		console.error("Play error:", err);
	}
}

function playNextSong() {
	if (!globalState.queue.length) return;
	let idx = globalState.queue.findIndex(
		(s) => s.id === globalState.currentSong?.id && s.source === globalState.currentSong?.source,
	);
	if (globalState.playMode === "random") {
		idx = Math.floor(Math.random() * globalState.queue.length);
	} else if (globalState.playMode === "single") {
		if (globalAudio) {
			globalAudio.currentTime = 0;
			globalAudio.play();
			return;
		}
	} else {
		idx = (idx + 1) % globalState.queue.length;
	}
	playSong(globalState.queue[idx], false);
}

function playPrevSong() {
	if (!globalState.queue.length) return;
	let idx = globalState.queue.findIndex(
		(s) => s.id === globalState.currentSong?.id && s.source === globalState.currentSong?.source,
	);
	idx = (idx - 1 + globalState.queue.length) % globalState.queue.length;
	playSong(globalState.queue[idx], false);
}

function isFavorited(song) {
	if (!song) return false;
	return globalState.favorites.some((f) => f.id === song.id && f.source === song.source);
}

async function toggleFavorite(song) {
	const idx = globalState.favorites.findIndex((f) => f.id === song.id && f.source === song.source);
	if (idx >= 0) {
		globalState.favorites.splice(idx, 1);
		showToast(`已从收藏夹移除: ${song.name}`);
	} else {
		globalState.favorites.push(song);
		showToast(`已收藏: ${song.name}`);
	}
	renderCurrentTable();

	try {
		await fetch(`${apiBaseUrl}/favorites`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ favorites: globalState.favorites }),
		});
	} catch {}
}

async function downloadCurrentSong(song) {
	try {
		let url = song._realPlayUrl;
		if (!url) {
			const urlRes = await fetch(
				`${apiBaseUrl}/song-url?source=${song.source}&songId=${encodeURIComponent(song.id)}&name=${encodeURIComponent(song.name)}&singer=${encodeURIComponent(song.singer)}`,
			).then((r) => r.json());
			if (urlRes.ok && urlRes.url) url = urlRes.url;
		}
		if (!url) return showToast("获取下载链接失败");

		showToast(`正在开始下载: ${song.name}`);
		const downloadUrl = `${apiBaseUrl}/download?url=${encodeURIComponent(url)}&name=${encodeURIComponent(song.name)}&singer=${encodeURIComponent(song.singer)}`;
		const a = document.createElement("a");
		a.href = downloadUrl;
		a.download = `${song.name} - ${song.singer}.mp3`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	} catch (err) {
		showToast(`下载出错: ${err.message}`);
	}
}

// ==============================
// 列表与队列批量操作核心
// ==============================
function getCurrentViewSongs() {
	if (globalState.activeViewTab === "search") {
		return globalState.searchResults || [];
	} else if (globalState.activeViewTab === "top") {
		return globalState.topChartSongs || [];
	} else if (globalState.activeViewTab === "favorites") {
		return globalState.favorites || [];
	} else if (globalState.activeViewTab === "queue") {
		return globalState.queue || [];
	}
	return [];
}

/** 一键播放整个列表 */
function playAllCurrentList() {
	const songs = getCurrentViewSongs();
	if (!songs || songs.length === 0) {
		return showToast("当前列表没有可播放的歌曲");
	}

	// 将当前整个列表载入播放队列并立即从第 1 首播放
	globalState.queue = [...songs];
	updateQueueBadge();
	playSong(songs[0], false);
	showToast(`开始播放全部 (共 ${songs.length} 首)`);
}

/** 全部直接加入队列（静默添加，无阻断确认框） */
function addAllCurrentToQueue() {
	const songs = getCurrentViewSongs();
	if (!songs || songs.length === 0) {
		return showToast("当前列表没有歌曲");
	}

	let addedCount = 0;
	songs.forEach((s) => {
		const exists = globalState.queue.find((item) => item.id === s.id && item.source === s.source);
		if (!exists) {
			globalState.queue.push(s);
			addedCount++;
		}
	});

	updateQueueBadge();
	showToast(`已追加 ${addedCount} 首歌曲至播放队列`);
}

/** 直接添加单曲到队列（无任何 confirm/alert 阻断弹窗） */
function addSingleToQueueDirectly(song) {
	const exists = globalState.queue.find((item) => item.id === song.id && item.source === song.source);
	if (exists) {
		showToast(`该歌曲已在队列中: ${song.name}`);
	} else {
		globalState.queue.push(song);
		updateQueueBadge();
		showToast(`已加入播放队列: ${song.name}`);
	}
}

/** 清空当前播放队列 */
function clearQueue() {
	globalState.queue = [];
	updateQueueBadge();
	renderCurrentTable();
	showToast("播放队列已清空");
}

function renderPlayerBarInfo() {
	if (!activeRootEl) return;
	const s = globalState.currentSong;
	const nameEl = activeRootEl.querySelector("#lx-bar-song-name");
	const singerEl = activeRootEl.querySelector("#lx-bar-singer");
	const coverEl = activeRootEl.querySelector("#lx-bar-cover");
	const discImg = activeRootEl.querySelector("#lx-disc-img");

	if (!s) {
		if (nameEl) nameEl.textContent = "洛雪音乐";
		if (singerEl) singerEl.textContent = "选择一首歌曲开始播放";
		if (coverEl)
			coverEl.src =
				"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'><path d='M9 18V5l12-2v13'/><circle cx='6' cy='18' r='3'/><circle cx='18' cy='16' r='3'/></svg>";
		return;
	}

	if (nameEl) nameEl.textContent = s.name;
	if (singerEl) singerEl.textContent = `${s.singer} · ${s.album || "精选"}`;
	const defaultCover =
		"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='1.5'><path d='M9 18V5l12-2v13'/><circle cx='6' cy='18' r='3'/><circle cx='18' cy='16' r='3'/></svg>";
	if (coverEl) coverEl.src = s.pic || defaultCover;
	if (discImg) discImg.src = s.pic || defaultCover;
}

function renderLyrics() {
	if (!activeRootEl) return;
	const container = activeRootEl.querySelector("#lx-lyrics-scroll");
	if (!container) return;
	container.innerHTML = "";
	globalState.currentLrcIndex = -1;

	globalState.lyrics.forEach((line) => {
		const div = document.createElement("div");
		div.className = "lx-lrc-line";
		div.textContent = line.text;
		div.title = `点击跳转到 ${formatTime(line.time)}`;
		div.addEventListener("click", () => {
			if (globalAudio) {
				globalAudio.currentTime = line.time;
				if (!globalState.isPlaying) globalAudio.play();
			}
		});
		container.appendChild(div);
	});
}

function updateUserApiBadge() {
	if (!activeRootEl) return;
	const badge = activeRootEl.querySelector("#lx-active-api-badge");
	if (!badge) return;
	if (globalState.activeUserApi) {
		badge.textContent = `⚡ 音源: ${globalState.activeUserApi.name} (${globalState.activeUserApi.version})`;
		badge.style.display = "inline-flex";
	} else {
		badge.style.display = "none";
	}
}

function updateQueueBadge() {
	if (!activeRootEl) return;
	const queueNavTab = activeRootEl.querySelector(".lx-nav-tab[data-tab='queue']");
	if (queueNavTab) {
		queueNavTab.innerHTML = `<span>📋 播放队列</span><span class="lx-badge-count">${globalState.queue.length}</span>`;
	}
}

function renderCurrentTable() {
	if (!activeRootEl) return;
	const tbody = activeRootEl.querySelector("#lx-song-table-body");
	const listCountEl = activeRootEl.querySelector("#lx-list-count");
	const clearQueueBtn = activeRootEl.querySelector("#lx-clear-queue-btn");
	const songs = getCurrentViewSongs();

	if (listCountEl) {
		listCountEl.textContent = `共 ${songs.length} 首歌曲`;
	}
	if (clearQueueBtn) {
		clearQueueBtn.style.display = globalState.activeViewTab === "queue" && songs.length > 0 ? "inline-flex" : "none";
	}

	if (!songs || songs.length === 0) {
		const tips = {
			search: "输入关键词开始搜索音乐",
			top: "正在加载排行榜...",
			favorites: "暂无收藏歌曲，点击歌曲行 ❤️ 即可收藏",
			queue: "播放队列为空，点击歌曲直接入队",
		};
		tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-faint, #7e8798); padding: 40px;">${tips[globalState.activeViewTab] || "无数据"}</td></tr>`;
		return;
	}

	tbody.innerHTML = "";
	songs.forEach((song, idx) => {
		const isCur =
			globalState.currentSong &&
			globalState.currentSong.id === song.id &&
			globalState.currentSong.source === song.source;
		const isFav = isFavorited(song);

		const tr = document.createElement("tr");
		if (isCur) tr.classList.add("playing-row");

		tr.innerHTML = `
			<td style="width: 50px;">
				${isCur ? `<span class="lx-wave-icon">🔊</span>` : idx + 1}
			</td>
			<td>
				<div class="lx-song-name">
					<button class="lx-fav-btn ${isFav ? "active" : ""}" title="${isFav ? "取消收藏" : "收藏"}">
						${isFav ? "❤️" : "🤍"}
					</button>
					<span style="${isCur ? "color: var(--accent); font-weight: 700;" : ""}">${song.name}</span>
				</div>
			</td>
			<td class="lx-singer">${song.singer}</td>
			<td class="lx-singer">${song.album || "-"}</td>
			<td class="lx-singer">${song.duration}</td>
			<td style="text-align: right;">
				<div class="lx-table-actions" style="justify-content: flex-end;">
					<button class="lx-icon-btn btn-play" title="立即播放">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
					</button>
					<button class="lx-icon-btn btn-add" title="直接加入播放队列(不弹窗)">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
					</button>
					<button class="lx-icon-btn btn-down" title="下载音频">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
					</button>
				</div>
			</td>
		`;

		tr.querySelector(".btn-play").addEventListener("click", () => playSong(song));
		// 直接静默加入队列，不弹任何 alert 确认窗！
		tr.querySelector(".btn-add").addEventListener("click", () => addSingleToQueueDirectly(song));
		tr.querySelector(".btn-down").addEventListener("click", () => downloadCurrentSong(song));
		tr.querySelector(".lx-fav-btn").addEventListener("click", () => toggleFavorite(song));
		tbody.appendChild(tr);
	});
}

function buildStyles() {
	return `
		.lx-wrap {
			display: flex;
			flex-direction: column;
			height: 100%;
			min-height: 100%;
			background: var(--bg, #111216);
			color: var(--text, #eceff4);
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
			user-select: none;
			overflow: hidden;
			box-sizing: border-box;
			position: relative;
		}

		/* 顶部操作条 */
		.lx-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 10px 20px;
			background: var(--card, #1a1c23);
			border-bottom: 1px solid var(--border, #2e3440);
			flex-shrink: 0;
			gap: 16px;
			flex-wrap: wrap;
		}
		.lx-brand {
			display: flex;
			align-items: center;
			gap: 8px;
			font-weight: 700;
			font-size: 16px;
			color: var(--accent, #5e81ac);
		}
		.lx-nav-tabs {
			display: flex;
			background: var(--bg, #111216);
			border-radius: 8px;
			padding: 3px;
			gap: 2px;
		}
		.lx-nav-tab {
			border: none;
			background: transparent;
			color: var(--text-faint, #7e8798);
			padding: 6px 14px;
			font-size: 13px;
			border-radius: 6px;
			cursor: pointer;
			transition: all 0.2s;
			display: flex;
			align-items: center;
			gap: 6px;
		}
		.lx-nav-tab.active {
			background: var(--accent, #5e81ac);
			color: var(--accent-contrast, #ffffff);
			font-weight: 600;
		}
		.lx-badge-count {
			background: rgba(255,255,255,0.2);
			color: inherit;
			font-size: 11px;
			padding: 1px 6px;
			border-radius: 10px;
		}
		.lx-search-box {
			display: flex;
			align-items: center;
			background: var(--bg, #111216);
			border: 1px solid var(--border, #2e3440);
			border-radius: 8px;
			padding: 0 10px;
			flex: 1;
			max-width: 380px;
			min-width: 200px;
		}
		.lx-search-input {
			flex: 1;
			background: transparent;
			border: none;
			color: var(--text, #eceff4);
			font-size: 13px;
			padding: 8px 6px;
			outline: none;
		}
		.lx-search-btn {
			background: transparent;
			border: none;
			color: var(--text-faint, #7e8798);
			cursor: pointer;
			display: flex;
			align-items: center;
			padding: 4px;
		}
		.lx-search-btn:hover {
			color: var(--accent, #5e81ac);
		}
		.lx-action-btns {
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.lx-api-badge {
			font-size: 11px;
			padding: 4px 8px;
			border-radius: 4px;
			background: rgba(94, 129, 172, 0.15);
			color: var(--accent, #5e81ac);
			border: 1px solid rgba(94, 129, 172, 0.3);
			display: none;
			white-space: nowrap;
		}
		.lx-btn {
			border: 1px solid var(--border, #2e3440);
			background: var(--bg, #111216);
			color: var(--text, #eceff4);
			border-radius: 6px;
			padding: 6px 12px;
			font-size: 12px;
			cursor: pointer;
			display: flex;
			align-items: center;
			gap: 6px;
			transition: all 0.2s;
		}
		.lx-btn:hover {
			background: var(--border, #2e3440);
		}
		.lx-btn-primary {
			border: none;
			background: var(--accent, #5e81ac);
			color: var(--accent-contrast, #ffffff);
			border-radius: 6px;
			padding: 6px 14px;
			font-size: 12.5px;
			font-weight: 600;
			cursor: pointer;
			display: flex;
			align-items: center;
			gap: 6px;
			transition: transform 0.15s, opacity 0.15s;
		}
		.lx-btn-primary:hover {
			transform: scale(1.02);
			opacity: 0.95;
		}

		/* 次级工具栏 (音源切换/榜单切换) */
		.lx-sub-bar {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 8px 20px;
			background: rgba(255,255,255,0.02);
			border-bottom: 1px solid var(--border, #2e3440);
			font-size: 12px;
			flex-shrink: 0;
		}
		.lx-pill-group {
			display: flex;
			gap: 6px;
		}
		.lx-pill-btn {
			border: 1px solid var(--border, #2e3440);
			background: transparent;
			color: var(--text-faint, #7e8798);
			border-radius: 12px;
			padding: 3px 10px;
			font-size: 12px;
			cursor: pointer;
			transition: all 0.2s;
		}
		.lx-pill-btn.active {
			background: var(--accent, #5e81ac);
			color: var(--accent-contrast, #ffffff);
			border-color: var(--accent, #5e81ac);
		}

		/* 列表操作顶栏 (一键播放全部) */
		.lx-list-action-bar {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 10px 0 12px 0;
			border-bottom: 1px solid rgba(255,255,255,0.05);
			margin-bottom: 6px;
		}
		.lx-list-left-actions {
			display: flex;
			align-items: center;
			gap: 10px;
		}
		.lx-list-count {
			font-size: 12px;
			color: var(--text-faint, #7e8798);
		}

		/* 主体内容布局 */
		.lx-main {
			display: flex;
			flex: 1;
			min-height: 0;
			overflow: hidden;
			position: relative;
		}
		.lx-song-list-wrap {
			flex: 1;
			overflow-y: auto;
			padding: 12px 20px;
			min-width: 0;
		}
		.lx-lyrics-panel {
			width: 380px;
			max-width: 38%;
			background: var(--card, #1a1c23);
			border-left: 1px solid var(--border, #2e3440);
			display: flex;
			flex-direction: column;
			align-items: center;
			padding: 24px 16px;
			overflow: hidden;
			flex-shrink: 0;
		}
		@media (max-width: 860px) {
			.lx-lyrics-panel {
				display: none;
			}
		}

		/* 歌曲表格 */
		.lx-table {
			width: 100%;
			border-collapse: collapse;
			font-size: 13px;
		}
		.lx-table th {
			text-align: left;
			padding: 10px 12px;
			color: var(--text-faint, #7e8798);
			font-weight: 500;
			border-bottom: 1px solid var(--border, #2e3440);
		}
		.lx-table td {
			padding: 10px 12px;
			border-bottom: 1px solid rgba(255,255,255,0.03);
			color: var(--text, #eceff4);
		}
		.lx-table tr:hover {
			background: rgba(255,255,255,0.04);
		}
		.lx-table tr.playing-row {
			background: rgba(94, 129, 172, 0.08);
		}
		.lx-song-name {
			font-weight: 600;
			color: var(--text, #eceff4);
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.lx-fav-btn {
			background: transparent;
			border: none;
			cursor: pointer;
			padding: 2px;
			font-size: 14px;
			transition: transform 0.15s;
		}
		.lx-fav-btn:hover {
			transform: scale(1.2);
		}
		.lx-singer {
			color: var(--text-faint, #94a3b8);
		}
		.lx-table-actions {
			display: flex;
			gap: 6px;
		}
		.lx-icon-btn {
			background: transparent;
			border: none;
			color: var(--text-faint, #7e8798);
			cursor: pointer;
			padding: 5px;
			border-radius: 4px;
			display: flex;
			align-items: center;
			transition: all 0.2s;
		}
		.lx-icon-btn:hover {
			color: var(--accent, #5e81ac);
			background: rgba(255,255,255,0.08);
		}

		/* 歌词与唱片 */
		.lx-cover-disc {
			width: 150px;
			height: 150px;
			border-radius: 50%;
			background: #000;
			border: 6px solid #222;
			box-shadow: 0 10px 25px rgba(0,0,0,0.5);
			overflow: hidden;
			display: flex;
			align-items: center;
			justify-content: center;
			margin-bottom: 16px;
			animation: rotateDisc 20s linear infinite;
			animation-play-state: paused;
		}
		.lx-cover-disc.playing {
			animation-play-state: running;
		}
		.lx-cover-disc img {
			width: 100%;
			height: 100%;
			object-fit: cover;
		}
		@keyframes rotateDisc {
			from { transform: rotate(0deg); }
			to { transform: rotate(360deg); }
		}
		.lx-lyrics-scroll {
			flex: 1;
			width: 100%;
			overflow-y: auto;
			text-align: center;
			padding: 20px 0;
			mask-image: linear-gradient(to bottom, transparent, black 15%, black 85%, transparent);
			-webkit-mask-image: linear-gradient(to bottom, transparent, black 15%, black 85%, transparent);
		}
		.lx-lrc-line {
			padding: 8px 16px;
			color: var(--text-faint, #64748b);
			font-size: 13.5px;
			cursor: pointer;
			transition: all 0.3s;
			line-height: 1.5;
		}
		.lx-lrc-line.active {
			color: var(--accent, #5e81ac);
			font-weight: 700;
			font-size: 15.5px;
			transform: scale(1.05);
		}
		.lx-lrc-line:hover {
			color: var(--text, #ffffff);
		}

		/* 底部播放条 */
		.lx-footer {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 10px 24px;
			background: var(--card, #1a1c23);
			border-top: 1px solid var(--border, #2e3440);
			flex-shrink: 0;
			gap: 16px;
			z-index: 10;
		}
		.lx-footer-left {
			display: flex;
			align-items: center;
			gap: 12px;
			width: 240px;
			min-width: 180px;
		}
		.lx-bar-cover {
			width: 44px;
			height: 44px;
			border-radius: 6px;
			object-fit: cover;
			background: #2e3440;
		}
		.lx-bar-info {
			display: flex;
			flex-direction: column;
			gap: 2px;
			min-width: 0;
		}
		.lx-bar-song-name {
			font-size: 13px;
			font-weight: 600;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.lx-bar-singer {
			font-size: 11px;
			color: var(--text-faint, #7e8798);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.lx-footer-center {
			flex: 1;
			max-width: 600px;
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 6px;
		}
		.lx-ctrl-btns {
			display: flex;
			align-items: center;
			gap: 14px;
		}
		.lx-play-main-btn {
			width: 36px;
			height: 36px;
			border-radius: 50%;
			background: var(--accent, #5e81ac);
			color: var(--accent-contrast, #ffffff);
			border: none;
			display: flex;
			align-items: center;
			justify-content: center;
			cursor: pointer;
			transition: transform 0.15s;
		}
		.lx-play-main-btn:hover {
			transform: scale(1.08);
		}
		.lx-progress-bar-wrap {
			width: 100%;
			display: flex;
			align-items: center;
			gap: 10px;
			font-size: 11px;
			color: var(--text-faint, #7e8798);
		}
		.lx-progress-track {
			flex: 1;
			height: 4px;
			background: rgba(255,255,255,0.1);
			border-radius: 2px;
			position: relative;
			cursor: pointer;
		}
		.lx-progress-inner {
			position: absolute;
			left: 0;
			top: 0;
			height: 100%;
			width: 0%;
			background: var(--accent, #5e81ac);
			border-radius: 2px;
		}
		.lx-footer-right {
			display: flex;
			align-items: center;
			gap: 12px;
			justify-content: flex-end;
		}
		.lx-vol-slider {
			width: 70px;
			accent-color: var(--accent, #5e81ac);
			cursor: pointer;
		}
		.lx-quality-select {
			background: var(--bg, #111216);
			border: 1px solid var(--border, #2e3440);
			color: var(--text, #eceff4);
			border-radius: 4px;
			padding: 2px 6px;
			font-size: 11px;
			outline: none;
		}

		/* 轻量非阻断 Toast 提示框 */
		.lx-toast {
			position: absolute;
			bottom: 80px;
			left: 50%;
			transform: translateX(-50%) translateY(20px);
			background: rgba(20, 22, 29, 0.94);
			border: 1px solid var(--border, #2e3440);
			color: var(--text, #eceff4);
			padding: 8px 18px;
			border-radius: 20px;
			font-size: 12.5px;
			box-shadow: 0 8px 24px rgba(0,0,0,0.4);
			pointer-events: none;
			opacity: 0;
			transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
			z-index: 99999;
			backdrop-filter: blur(8px);
		}
		.lx-toast.show {
			opacity: 1;
			transform: translateX(-50%) translateY(0);
		}

		/* 模态框 */
		.lx-modal-mask {
			position: fixed;
			top: 0;
			left: 0;
			width: 100%;
			height: 100%;
			background: rgba(0,0,0,0.6);
			display: none;
			align-items: center;
			justify-content: center;
			z-index: 9999;
		}
		.lx-modal {
			background: var(--card, #1a1c23);
			border: 1px solid var(--border, #2e3440);
			border-radius: 10px;
			width: 480px;
			max-width: 90%;
			padding: 20px;
			display: flex;
			flex-direction: column;
			gap: 14px;
		}
		.lx-modal-title {
			font-size: 16px;
			font-weight: 700;
		}
		.lx-textarea {
			width: 100%;
			height: 140px;
			background: var(--bg, #111216);
			border: 1px solid var(--border, #2e3440);
			color: var(--text, #eceff4);
			border-radius: 6px;
			padding: 8px;
			font-family: monospace;
			font-size: 12px;
			resize: vertical;
		}
	`;
}

function renderApp(el) {
	el.innerHTML = `
		<style>${buildStyles()}</style>
		<div class="lx-wrap">
			<!-- 头部主导航 -->
			<div class="lx-header">
				<div class="lx-brand">
					<span>🎵</span>
					<span>洛雪音乐</span>
				</div>

				<div class="lx-nav-tabs" id="lx-nav-tabs">
					<button class="lx-nav-tab active" data-tab="search">🔍 搜索</button>
					<button class="lx-nav-tab" data-tab="top">🔥 排行榜</button>
					<button class="lx-nav-tab" data-tab="favorites">❤️ 我的收藏</button>
					<button class="lx-nav-tab" data-tab="queue">📋 播放队列</button>
				</div>

				<div class="lx-search-box" id="lx-search-box-wrap">
					<input type="text" id="lx-search-input" class="lx-search-input" placeholder="搜索歌曲、歌手、专辑..." />
					<button id="lx-search-btn" class="lx-search-btn" title="搜索">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
					</button>
				</div>

				<div class="lx-action-btns">
					<span class="lx-api-badge" id="lx-active-api-badge">⚡ 自定义源</span>
					<button class="lx-btn" id="lx-open-userapi-btn">
						<span>🧩</span>
						<span>音源管理</span>
					</button>
				</div>
			</div>

			<!-- 次级栏 (音源与榜单分类) -->
			<div class="lx-sub-bar" id="lx-sub-bar">
				<div class="lx-pill-group" id="lx-source-pills">
					<span style="color: var(--text-faint); margin-right: 4px;">音源平台:</span>
					<button class="lx-pill-btn active" data-src="wy">网易云</button>
					<button class="lx-pill-btn" data-src="kw">酷我</button>
					<button class="lx-pill-btn" data-src="kg">酷狗</button>
					<button class="lx-pill-btn" data-src="mg">咪咕</button>
				</div>

				<div class="lx-pill-group" id="lx-top-pills" style="display: none;">
					<span style="color: var(--text-faint); margin-right: 4px;">榜单分类:</span>
					<button class="lx-pill-btn active" data-chart="hot">🔥 热歌榜</button>
					<button class="lx-pill-btn" data-chart="soar">🚀 飙升榜</button>
					<button class="lx-pill-btn" data-chart="new">🌟 新歌榜</button>
				</div>

				<div style="color: var(--text-faint); font-size: 11px;">
					快捷键: 空格(播放/暂停) · 方向键(快进/音量)
				</div>
			</div>

			<!-- 中间主视图 -->
			<div class="lx-main">
				<div class="lx-song-list-wrap">
					<!-- 列表操作顶栏 (一键播放全部) -->
					<div class="lx-list-action-bar">
						<div class="lx-list-left-actions">
							<button class="lx-btn-primary" id="lx-play-all-btn">
								<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
								<span>播放全部</span>
							</button>
							<button class="lx-btn" id="lx-add-all-btn" title="将当前列表整张加入播放队列(无确认框)">
								<span>➕ 全部入队</span>
							</button>
							<button class="lx-btn" id="lx-clear-queue-btn" style="display: none;" title="清空播放队列">
								<span>🗑️ 清空队列</span>
							</button>
						</div>
						<div class="lx-list-count" id="lx-list-count">共 0 首歌曲</div>
					</div>

					<table class="lx-table">
						<thead>
							<tr>
								<th style="width: 50px;">#</th>
								<th>歌曲标题</th>
								<th>歌手</th>
								<th>专辑</th>
								<th style="width: 80px;">时长</th>
								<th style="width: 120px; text-align: right;">操作</th>
							</tr>
						</thead>
						<tbody id="lx-song-table-body">
							<tr>
								<td colspan="6" style="text-align: center; color: var(--text-faint, #7e8798); padding: 40px;">
									输入关键词开始搜索音乐
								</td>
							</tr>
						</tbody>
					</table>
				</div>

				<!-- 歌词与唱片右面板 -->
				<div class="lx-lyrics-panel">
					<div class="lx-cover-disc" id="lx-cover-disc">
						<img id="lx-disc-img" src="" alt="Album Cover" />
					</div>
					<div class="lx-lyrics-scroll" id="lx-lyrics-scroll">
						<div class="lx-lrc-line">暂无歌词</div>
					</div>
				</div>
			</div>

			<!-- 底部播放栏 -->
			<div class="lx-footer">
				<div class="lx-footer-left">
					<img class="lx-bar-cover" id="lx-bar-cover" src="" alt="Cover" />
					<div class="lx-bar-info">
						<div class="lx-bar-song-name" id="lx-bar-song-name">洛雪音乐</div>
						<div class="lx-bar-singer" id="lx-bar-singer">选择一首歌曲开始播放</div>
					</div>
				</div>

				<div class="lx-footer-center">
					<div class="lx-ctrl-btns">
						<button class="lx-icon-btn" id="lx-mode-btn" title="列表循环">
							<span id="lx-mode-icon">🔁</span>
						</button>
						<button class="lx-icon-btn" id="lx-prev-btn" title="上一首 (Ctrl+Left)">
							<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" stroke-width="2"/></svg>
						</button>
						<button class="lx-play-main-btn" id="lx-play-btn" title="播放/暂停 (Space)">
							<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
						</button>
						<button class="lx-icon-btn" id="lx-next-btn" title="下一首 (Ctrl+Right)">
							<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2"/></svg>
						</button>
						<button class="lx-icon-btn" id="lx-pip-btn" title="开启桌面画中画悬浮歌词">
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><rect x="12" y="9" width="8" height="6" rx="1"/></svg>
						</button>
					</div>

					<div class="lx-progress-bar-wrap">
						<span id="lx-cur-time">00:00</span>
						<div class="lx-progress-track" id="lx-progress-track">
							<div class="lx-progress-inner" id="lx-progress-bar-inner"></div>
						</div>
						<span id="lx-dur-time">00:00</span>
					</div>
				</div>

				<div class="lx-footer-right">
					<select class="lx-quality-select" id="lx-quality-select" title="音质选择">
						<option value="128k">标准 128k</option>
						<option value="320k">高品 320k</option>
						<option value="flac">无损 FLAC</option>
					</select>

					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
					<input type="range" class="lx-vol-slider" id="lx-vol-slider" min="0" max="1" step="0.05" value="0.8" />
				</div>
			</div>

			<!-- 自定义音源弹窗 -->
			<div class="lx-modal-mask" id="lx-userapi-modal">
				<div class="lx-modal">
					<div class="lx-modal-title">导入六音 / 自定义音源脚本</div>
					<div style="font-size: 12px; color: var(--text-faint, #7e8798);">
						支持直接粘贴音源 JS 代码，或输入 GitHub / 在线脚本 URL。
					</div>
					<textarea class="lx-textarea" id="lx-userapi-script" placeholder="可粘贴 JS 源码，或输入 https://raw.githubusercontent.com/..."></textarea>
					<div style="display: flex; justify-content: flex-end; gap: 10px;">
						<button class="lx-btn" id="lx-modal-close-btn">取消</button>
						<button class="lx-btn" id="lx-modal-save-btn" style="background: var(--accent); color: var(--accent-contrast);">导入并激活</button>
					</div>
				</div>
			</div>
		</div>
	`;
}

function bindEvents(rootEl) {
	// 1. 页签导航切换 (搜索 / 排行榜 / 我的收藏 / 播放队列)
	const tabs = rootEl.querySelectorAll(".lx-nav-tab");
	const sourcePills = rootEl.querySelector("#lx-source-pills");
	const topPills = rootEl.querySelector("#lx-top-pills");
	const searchBoxWrap = rootEl.querySelector("#lx-search-box-wrap");

	tabs.forEach((tab) => {
		tab.addEventListener("click", () => {
			tabs.forEach((t) => t.classList.remove("active"));
			tab.classList.add("active");
			globalState.activeViewTab = tab.dataset.tab;

			if (globalState.activeViewTab === "search") {
				sourcePills.style.display = "flex";
				topPills.style.display = "none";
				searchBoxWrap.style.display = "flex";
			} else if (globalState.activeViewTab === "top") {
				sourcePills.style.display = "none";
				topPills.style.display = "flex";
				searchBoxWrap.style.display = "none";
				loadTopChart();
			} else {
				sourcePills.style.display = "none";
				topPills.style.display = "none";
				searchBoxWrap.style.display = "none";
			}
			renderCurrentTable();
		});
	});

	// 2. 音源平台切换
	const srcBtns = rootEl.querySelectorAll(".lx-pill-btn[data-src]");
	srcBtns.forEach((btn) => {
		btn.addEventListener("click", () => {
			srcBtns.forEach((b) => b.classList.remove("active"));
			btn.classList.add("active");
			globalState.source = btn.dataset.src;
			triggerSearch();
		});
	});

	// 3. 榜单分类切换
	const chartBtns = rootEl.querySelectorAll(".lx-pill-btn[data-chart]");
	chartBtns.forEach((btn) => {
		btn.addEventListener("click", () => {
			chartBtns.forEach((b) => b.classList.remove("active"));
			btn.classList.add("active");
			globalState.topChartType = btn.dataset.chart;
			loadTopChart();
		});
	});

	const loadTopChart = async () => {
		const tbody = rootEl.querySelector("#lx-song-table-body");
		tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 40px;">正在获取排行榜歌曲...</td></tr>`;
		try {
			const res = await fetch(`${apiBaseUrl}/top-list?type=${globalState.topChartType}&limit=50`).then((r) => r.json());
			if (res.ok && res.songs) {
				globalState.topChartSongs = res.songs;
				renderCurrentTable();
			}
		} catch (err) {
			tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--err-text); padding: 40px;">加载排行榜失败: ${err.message}</td></tr>`;
		}
	};

	// 4. 搜索
	const searchInput = rootEl.querySelector("#lx-search-input");
	const searchBtn = rootEl.querySelector("#lx-search-btn");

	const triggerSearch = async () => {
		const kw = searchInput.value.trim();
		if (!kw) return;
		const tbody = rootEl.querySelector("#lx-song-table-body");
		tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 40px;">正在检索 ${kw}...</td></tr>`;

		try {
			const res = await fetch(
				`${apiBaseUrl}/search?source=${globalState.source}&keyword=${encodeURIComponent(kw)}`,
			).then((r) => r.json());

			if (!res.ok || !res.songs || res.songs.length === 0) {
				tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 40px; color: var(--text-faint);">未找到相关歌曲</td></tr>`;
				return;
			}

			globalState.searchResults = res.songs;
			renderCurrentTable();
		} catch (err) {
			tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--err-text, #bf616a); padding: 40px;">搜索失败: ${err.message}</td></tr>`;
		}
	};

	searchBtn.addEventListener("click", triggerSearch);
	searchInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter") triggerSearch();
	});

	// 5. 播控
	const playBtn = rootEl.querySelector("#lx-play-btn");
	playBtn.addEventListener("click", () => {
		if (!globalAudio) return;
		if (globalState.isPlaying) globalAudio.pause();
		else globalAudio.play();
	});

	rootEl.querySelector("#lx-prev-btn").addEventListener("click", playPrevSong);
	rootEl.querySelector("#lx-next-btn").addEventListener("click", playNextSong);

	// 6. 一键播放全部 与 一键全部入队
	rootEl.querySelector("#lx-play-all-btn").addEventListener("click", playAllCurrentList);
	rootEl.querySelector("#lx-add-all-btn").addEventListener("click", addAllCurrentToQueue);
	rootEl.querySelector("#lx-clear-queue-btn").addEventListener("click", clearQueue);

	// 7. 播放模式切换 (列表循环 -> 随机播放 -> 单曲循环)
	const modeBtn = rootEl.querySelector("#lx-mode-btn");
	const modeIcon = rootEl.querySelector("#lx-mode-icon");
	const modes = [
		{ type: "loop", icon: "🔁", title: "列表循环" },
		{ type: "random", icon: "🔀", title: "随机播放" },
		{ type: "single", icon: "🔂", title: "单曲循环" },
	];

	modeBtn.addEventListener("click", () => {
		const curIdx = modes.findIndex((m) => m.type === globalState.playMode);
		const next = modes[(curIdx + 1) % modes.length];
		globalState.playMode = next.type;
		modeIcon.textContent = next.icon;
		modeBtn.title = next.title;
		showToast(`播放模式: ${next.title}`);
	});

	// 8. 画中画歌词
	rootEl.querySelector("#lx-pip-btn").addEventListener("click", togglePictureInPicture);

	// 9. 音质切换
	const qualitySelect = rootEl.querySelector("#lx-quality-select");
	qualitySelect.value = globalState.quality;
	qualitySelect.addEventListener("change", (e) => {
		globalState.quality = e.target.value;
		showToast(`已切换音质: ${e.target.options[e.target.selectedIndex].text}`);
	});

	// 10. 进度条拖拽与跳转
	const track = rootEl.querySelector("#lx-progress-track");
	track.addEventListener("click", (e) => {
		if (!globalAudio || !globalState.duration) return;
		const rect = track.getBoundingClientRect();
		const clickPct = (e.clientX - rect.left) / rect.width;
		globalAudio.currentTime = clickPct * globalState.duration;
	});

	// 11. 音量
	const volSlider = rootEl.querySelector("#lx-vol-slider");
	volSlider.addEventListener("input", (e) => {
		const val = parseFloat(e.target.value);
		globalState.volume = val;
		if (globalAudio) globalAudio.volume = val;
	});

	// 12. 自定义音源弹窗
	const modal = rootEl.querySelector("#lx-userapi-modal");
	const saveBtn = rootEl.querySelector("#lx-modal-save-btn");
	const scriptArea = rootEl.querySelector("#lx-userapi-script");

	rootEl.querySelector("#lx-open-userapi-btn").addEventListener("click", () => {
		modal.style.display = "flex";
		scriptArea.focus();
	});
	rootEl.querySelector("#lx-modal-close-btn").addEventListener("click", () => {
		modal.style.display = "none";
	});

	saveBtn.addEventListener("click", async () => {
		const script = scriptArea.value.trim();
		if (!script) return showToast("脚本内容或 URL 不能为空");

		const oldText = saveBtn.textContent;
		saveBtn.disabled = true;
		saveBtn.textContent = "正在下载与解析...";

		try {
			const res = await fetch(`${apiBaseUrl}/user-api/import`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ script }),
			}).then((r) => r.json());

			if (res.ok) {
				globalState.activeUserApi = res.meta;
				updateUserApiBadge();
				showToast(`自定义音源激活成功: ${res.meta.name}`);
				scriptArea.value = "";
				modal.style.display = "none";
			} else {
				showToast(`导入失败: ${res.error}`);
			}
		} catch (err) {
			showToast(`请求异常: ${err.message}`);
		} finally {
			saveBtn.disabled = false;
			saveBtn.textContent = oldText;
		}
	});

	// 13. 键盘快捷键监听
	const onKeyDown = (e) => {
		if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

		if (e.code === "Space") {
			e.preventDefault();
			if (globalAudio) {
				if (globalState.isPlaying) globalAudio.pause();
				else globalAudio.play();
			}
		} else if (e.code === "ArrowLeft") {
			if (e.ctrlKey) {
				playPrevSong();
			} else if (globalAudio) {
				globalAudio.currentTime = Math.max(0, globalAudio.currentTime - 5);
			}
		} else if (e.code === "ArrowRight") {
			if (e.ctrlKey) {
				playNextSong();
			} else if (globalAudio) {
				globalAudio.currentTime = Math.min(globalState.duration, globalAudio.currentTime + 5);
			}
		} else if (e.code === "ArrowUp") {
			e.preventDefault();
			globalState.volume = Math.min(1, globalState.volume + 0.05);
			if (globalAudio) globalAudio.volume = globalState.volume;
			volSlider.value = globalState.volume;
		} else if (e.code === "ArrowDown") {
			e.preventDefault();
			globalState.volume = Math.max(0, globalState.volume - 0.05);
			if (globalAudio) globalAudio.volume = globalState.volume;
			volSlider.value = globalState.volume;
		}
	};
	window.addEventListener("keydown", onKeyDown);

	// 14. 初始化恢复收藏夹与音源
	fetch(`${apiBaseUrl}/favorites`)
		.then((r) => r.json())
		.then((d) => {
			if (d?.favorites) globalState.favorites = d.favorites;
		})
		.catch(() => {});

	fetch(`${apiBaseUrl}/user-apis`)
		.then((r) => r.json())
		.then((data) => {
			const active = data?.apis?.find((a) => a.active);
			if (active) {
				globalState.activeUserApi = active;
				updateUserApiBadge();
			}
		})
		.catch(() => {});
}

export default {
	async mount(el, ctx) {
		activeRootEl = el;
		apiBaseUrl = `${ctx.appBaseUrl || ""}/plugins-api/lx-music`;

		// 监听宿主 WebSocket 消息 (来自 AI Agent Tool 的点歌控制)
		if (typeof ctx.onData === "function") {
			ctx.onData((payload) => {
				if (payload?.type === "lx:play_song" && payload?.song) {
					playSong(payload.song);
				} else if (payload?.type === "lx:play_all" && payload?.songs?.length) {
					globalState.queue = [...payload.songs];
					updateQueueBadge();
					playSong(payload.songs[0], false);
					showToast(`AI 已为你开始播放整份歌单 (${payload.songs.length} 首)`);
				} else if (payload?.type === "lx:pause" && globalAudio) {
					globalAudio.pause();
				} else if (payload?.type === "lx:resume" && globalAudio) {
					globalAudio.play();
				} else if (payload?.type === "lx:playlist_add" && payload?.song) {
					globalState.queue.push(payload.song);
					updateQueueBadge();
					showToast(`已追加至播放队列: ${payload.song.name}`);
				}
			});
		}

		renderApp(el);
		bindEvents(el);
		renderPlayerBarInfo();
		updatePlayButtonState();
		renderLyrics();
		updateQueueBadge();
	},

	unmount() {
		activeRootEl = null;
	},
};
