import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";

export const PATH_HTML_LIMIT = 2 * 1024 * 1024;
export function parseDevicePath(value: string | undefined) {
	// Match the raw path: URL normalization must never turn an escape into a portal request.
	const match = /^\/device\/([a-z0-9][a-z0-9-]{0,62})(\/[^?#]*)?(\?[^#]*)?$/.exec(value || "");
	if (!match) return null;
	const tail = match[2] || "/";
	const capability = /^\/__relay\/([a-f0-9]{64})(\/.*)$/.exec(tail);
	return {
		id: match[1],
		tail,
		query: match[3] || "",
		token: capability?.[1],
		path: capability ? capability[2] + (match[3] || "") : undefined,
	};
}
export function capabilityBase(id: string, token: string) {
	return `/device/${id}/__relay/${token}/`;
}
export function portalHeaders(hub: URL, base: string): Record<string, string> {
	const http = hub.origin + base;
	const ws = http.replace(/^http/, "ws");
	return {
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
		"access-control-allow-origin": "null",
		"access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
		"access-control-allow-headers":
			"content-type, authorization, x-requested-with, range, if-none-match, if-modified-since",
		"access-control-expose-headers": "content-type, content-length, content-range, accept-ranges, etag",
		"content-security-policy": `sandbox allow-scripts allow-forms allow-downloads; default-src 'none'; script-src ${http} 'unsafe-inline'; style-src ${http} 'unsafe-inline'; img-src ${http} data: blob:; font-src ${http} data:; media-src ${http} blob:; connect-src ${http} ${ws}; frame-src ${http}; form-action ${http}; base-uri ${http}; worker-src 'none'; object-src 'none'`,
		"x-content-type-options": "nosniff",
	};
}
export function wrapperHtml(base: string, initialPath = "", desktopHub?: URL, deviceLabel = "Device") {
	const title = `${deviceLabel} · pi-web-ui`.replace(/[&<>"']/g, (char) => {
		return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[char];
	});
	const nonce = randomBytes(16).toString("hex");
	// Desktop tickets may be embedded by a paired device UI on another origin.
	// The device content remains in the opaque sandbox, even when this wrapper is embedded.
	const frameBase = desktopHub ? new URL(base, desktopHub).href : base;
	const frameSource = desktopHub ? `${desktopHub.origin}${base}` : "'self'";
	const ancestors = desktopHub ? "http: https:" : "'self'";
	const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style nonce="${nonce}">html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block}body{background:#17181c;color:#eee;font:14px system-ui}#loading{position:fixed;inset:0;display:grid;place-content:center;text-align:center;gap:14px;background:#17181c}#loading[hidden]{display:none}button,a{padding:10px 16px;color:inherit;background:#303137;border:1px solid #555;border-radius:8px;text-decoration:none;cursor:pointer}p{color:#aaa;max-width:420px;line-height:1.7}</style></head><body><iframe sandbox="allow-scripts allow-forms allow-downloads" allowfullscreen referrerpolicy="no-referrer"></iframe><div id="loading"><strong id="title">正在连接设备… / Connecting…</strong><p id="hint">正在加载远程页面，请稍候。 / Loading the remote page.</p><div><button id="retry" type="button">重新连接 / Retry</button> <a href="/">返回设备中心 / Hub</a></div></div><script nonce="${nonce}">const frame=document.querySelector('iframe'),loading=document.getElementById('loading');let timer;const connect=()=>{loading.hidden=false;document.getElementById('title').textContent='正在连接设备… / Connecting…';frame.src=${JSON.stringify(frameBase + initialPath)}+location.hash;clearTimeout(timer);timer=setTimeout(()=>{document.getElementById('title').textContent='设备页面加载超时 / Connection timed out';document.getElementById('hint').textContent='请重试；若设备离线或入口已过期，请返回设备中心重新打开。 / Retry, or reopen the device from the Hub.';},20000)};document.getElementById('retry').onclick=connect;connect();addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.origin!=='null')return;const data=event.data;if(data?.type==='device-portal-ready'){clearTimeout(timer);loading.hidden=true;return}if(!data||data.type!=='device-session-hash'||typeof data.hash!=='string'||!/^#s=[a-zA-Z0-9_-]{1,256}$/.test(data.hash))return;history.replaceState(null,'',location.pathname+data.hash)});</script></body></html>`;
	return {
		html,
		csp: `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; frame-src ${frameSource}; base-uri 'none'; form-action 'none'; frame-ancestors ${ancestors}`,
	};
}
export function transformPortalHtml(html: string, base: string) {
	// Remove upstream base tags so the first base always belongs to this capability.
	const content = html
		.replace(/<base\b[^>]*>/gi, "")
		.replace(
			/\b(src|href|action|poster)\s*=\s*(["'])\/(?!\/)([^"']*)\2/gi,
			(_all, name, quote, path) => `${name}=${quote}${base}${path}${quote}`,
		);
	const ready = `<script>(()=>{let ready=false,banner;const update=()=>{const root=document.getElementById('root'),status=document.querySelector('.status-conn');if(!ready&&((root&&root.childElementCount)||(!root&&document.readyState==='complete'))){ready=true;parent.postMessage({type:'device-portal-ready'},'*')}if(!ready||!status)return;if(!banner){banner=document.createElement('div');banner.setAttribute('role','status');banner.style.cssText='position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:90vw;padding:8px 12px;border-radius:8px;background:#303137;color:#eee;font:13px system-ui;box-shadow:0 2px 12px #0006';banner.textContent='连接已断开，正在自动重试，请稍候… / Disconnected. Retrying automatically, please wait…';document.body.append(banner)}banner.hidden=status.classList.contains('ok')};setInterval(update,200);update()})();</script>`;
	return `<!doctype html><base href="${base}">` + content.replace(/<!doctype[^>]*>/i, "") + ready;
}
/** Only the entry HTML is collected; every other body retains relay streaming. */
export function createPortalResponse(res: ServerResponse, hub: URL, base: string, root: boolean) {
	let buffered = false;
	let status = 200;
	let headers: Record<string, string> = {};
	let chunks: Buffer[] = [];
	let bytes = 0;
	let started = false;
	return {
		start(code: number, upstream: Record<string, string>) {
			if (started) throw new Error("Duplicate portal response");
			started = true;
			status = code;
			headers = Object.fromEntries(
				Object.entries(upstream).filter(
					([key]) =>
						!/^(access-control-|content-security-policy|clear-site-data|service-worker-allowed|x-frame-options|refresh|content-location|link|reporting-endpoints|report-to|nel)/i.test(
							key,
						),
				),
			);
			if (headers.location) {
				const location = headers.location;
				if (!location.startsWith("/") || location.startsWith("//") || /[\\\r\n]/.test(location))
					throw new Error("Unsafe portal redirect");
				let decoded = location.split(/[?#]/)[0];
				for (let i = 0; i < 8; i++) {
					const next = decodeURIComponent(decoded);
					if (next === decoded) break;
					decoded = next;
				}
				if (/%|[\\\x00-\x20]/.test(decoded) || decoded.split("/").some((part) => part === "." || part === ".."))
					throw new Error("Unsafe portal redirect");
				headers.location = base + location.slice(1);
			}
			Object.assign(headers, portalHeaders(hub, base));
			buffered = root && /^(text\/html|application\/xhtml\+xml)\b/i.test(headers["content-type"] || "");
			if (buffered) {
				if (headers["content-encoding"] && headers["content-encoding"] !== "identity")
					throw new Error("Encoded portal HTML");
				delete headers["content-length"];
				delete headers["content-encoding"];
				delete headers.etag;
				headers["content-type"] = "text/html; charset=utf-8";
			} else {
				res.writeHead(status, headers);
				res.flushHeaders();
			}
		},
		write(data: Buffer) {
			if (!started) throw new Error("Missing portal headers");
			if (!buffered) {
				res.write(data);
				return;
			}
			bytes += data.length;
			if (bytes > PATH_HTML_LIMIT) throw new Error("Portal HTML exceeds 2 MiB");
			chunks.push(data);
		},
		end() {
			if (!started) throw new Error("Missing portal headers");
			if (buffered) {
				res.writeHead(status, headers);
				res.end(transformPortalHtml(Buffer.concat(chunks, bytes).toString("utf8"), base));
				chunks = [];
			} else res.end();
		},
	};
}
