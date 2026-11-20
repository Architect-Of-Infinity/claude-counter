(() => {
	'use strict';

	// This file can be loaded twice (early, in the page's own context at
	// document_start, and again by the old script-tag fallback). Install once.
	if (window.__ccBridgeInstalled) return;
	window.__ccBridgeInstalled = true;

	const CC_MARKER = 'ClaudeCounter';

	// Capture original fetch before anyone else can wrap it
	const originalFetch = window.fetch;

	// Wrap history methods early to detect SPA navigation (before frameworks cache them)
	const originalPushState = history.pushState.bind(history);
	const originalReplaceState = history.replaceState.bind(history);

	history.pushState = function (...args) {
		const result = originalPushState(...args);
		window.dispatchEvent(new CustomEvent('cc:urlchange'));
		return result;
	};

	history.replaceState = function (...args) {
		const result = originalReplaceState(...args);
		window.dispatchEvent(new CustomEvent('cc:urlchange'));
		return result;
	};

	// The HTTP method can live in the options object OR inside a Request object
	// passed as the first argument; checking only the options misses the latter.
	function getMethod(args) {
		const fromOpts = args[1]?.method;
		const fromRequest = args[0] instanceof Request ? args[0].method : null;
		return String(fromOpts || fromRequest || 'GET').toUpperCase();
	}

	// For diagnostics only: the request path with ids stripped, never the body.
	function describePath(url) {
		try {
			return new URL(url).pathname.replace(
				/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
				':id'
			);
		} catch {
			return '';
		}
	}

	window.fetch = async (...args) => {
		const url = toAbsoluteUrl(args[0]);
		const method = getMethod(args);

		// Detect generation start (completion requests)
		if (url && method === 'POST' && (url.includes('/completion') || url.includes('/retry_completion'))) {
			post('cc:generation_start', {});
		}
		const onSite = !!url && /^https:\/\/([a-z0-9-]+\.)?claude\.ai\//.test(url);
		if (onSite && method !== 'GET' && method !== 'HEAD') {
			post('cc:post_seen', { path: (method === 'POST' ? '' : method + ' ') + describePath(url) });
		}

		const response = await originalFetch.apply(window, args);

		const contentType = response.headers.get('content-type') || '';
		if (contentType.includes('event-stream') || (onSite && !isTelemetry(url) && /connect\+proto/i.test(contentType))) {
			// Don't trust the label: the newer chat route has sent the same binary
			// protobuf frames as both "connect+proto" and "text/event-stream".
			// Peek at the first bytes and pick the reader that fits the content.
			routeStream(response, describePath(url), contentType);
		} else if (onSite && !isTelemetry(url) && (method !== 'GET' || /stream|connect/i.test(contentType))) {
			// Some chat builds answer in another format (not SSE). Look for usage
			// windows inside the body, whatever the framing, and report what it was.
			scanResponse(response, describePath(url), contentType);
		}

		// Catch conversation tree fetches
		if (url && url.includes('/chat_conversations/') && url.includes('tree=')) {
			const meta = getConversationMeta(url);
			if (meta) {
				handleConversationResponse(meta, response);
			}
		}

		return response;
	};

	// Diagnostics only: some page builds may send through XMLHttpRequest instead
	// of fetch. Report the path (ids stripped) so the popup can show it.
	try {
		const xhrOpen = XMLHttpRequest.prototype.open;
		XMLHttpRequest.prototype.open = function (method, url, ...rest) {
			try {
				const abs = toAbsoluteUrl(String(url));
				if (String(method).toUpperCase() === 'POST' && abs.startsWith('https://claude.ai/api/')) {
					post('cc:post_seen', { path: 'XHR ' + describePath(abs) });
				}
			} catch {
				// ignore
			}
			return xhrOpen.call(this, method, url, ...rest);
		};
	} catch {
		// ignore
	}

	// Telemetry/housekeeping calls that can never carry usage; not worth scanning.
	function isTelemetry(url) {
		return /\/(rum|event_logging|batch|time_spent|notification|settings|ReportViewing|composer_notices)(\/|\?|$)/i.test(url);
	}

	// Pull the JSON object that follows a given key out of arbitrary text
	// (balanced braces, string-aware), so it works inside any envelope format.
	function extractObjectAfter(text, key) {
		const at = text.indexOf(key);
		if (at < 0) return null;
		const start = text.indexOf('{', at + key.length);
		if (start < 0 || start - at > key.length + 4) return null;
		let depth = 0;
		let inStr = false;
		for (let i = start; i < text.length; i++) {
			const c = text[i];
			if (inStr) {
				if (c === '\\') i++;
				else if (c === '"') inStr = false;
			} else if (c === '"') inStr = true;
			else if (c === '{') depth++;
			else if (c === '}' && --depth === 0) {
				try {
					return JSON.parse(text.slice(start, i + 1));
				} catch {
					return null;
				}
			}
		}
		return null;
	}

	// ---- Minimal protobuf reading (no schema): just enough to find the usage
	// windows. Field numbers are NOT relied on; a window is recognised by shape:
	// a map entry whose key is "5h" or "7d" and whose value holds a double 0..1.
	function pbVarint(b, i) {
		let r = 0;
		let mul = 1;
		while (i < b.length) {
			const x = b[i++];
			r += (x & 0x7f) * mul;
			if (!(x & 0x80)) return [r, i];
			mul *= 128;
			if (mul > 2 ** 63) break;
		}
		return null;
	}

	function pbParse(b) {
		const out = [];
		let i = 0;
		const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
		while (i < b.length) {
			const k = pbVarint(b, i);
			if (!k) return null;
			i = k[1];
			const f = Math.floor(k[0] / 8);
			const w = k[0] % 8;
			if (f === 0) return null;
			if (w === 0) {
				const v = pbVarint(b, i);
				if (!v) return null;
				i = v[1];
				out.push({ f, w, v: v[0] });
			} else if (w === 1) {
				if (i + 8 > b.length) return null;
				out.push({ f, w, v: dv.getFloat64(i, true) });
				i += 8;
			} else if (w === 5) {
				if (i + 4 > b.length) return null;
				out.push({ f, w, v: dv.getFloat32(i, true) });
				i += 4;
			} else if (w === 2) {
				const l = pbVarint(b, i);
				if (!l || l[1] + l[0] > b.length) return null;
				out.push({ f, w, v: b.subarray(l[1], l[1] + l[0]) });
				i = l[1] + l[0];
			} else {
				return null;
			}
		}
		return out;
	}

	function pbReadWindow(b) {
		const fields = pbParse(b);
		if (!fields) return null;
		let utilization = null;
		let resets = null;
		for (const x of fields) {
			if (x.w === 1 && x.v >= 0 && x.v <= 1.5) utilization = x.v;
			if (x.w === 2) {
				const sub = pbParse(x.v);
				const sec = sub?.find((y) => y.f === 1 && y.w === 0)?.v;
				if (sec > 1.4e9 && sec < 4e9) resets = sec;
			}
		}
		if (utilization === null && resets === null) return null;
		// proto3 omits a zero double, so a window with only a reset time means 0%.
		return { utilization: utilization === null ? 0 : utilization, resets_at: resets };
	}

	function pbFindWindows(b, depth) {
		const fields = pbParse(b);
		if (!fields) return null;
		const found = {};
		for (const x of fields) {
			if (x.w !== 2) continue;
			const entry = pbParse(x.v);
			const key = entry?.find((y) => y.f === 1 && y.w === 2);
			const val = entry?.find((y) => y.f === 2 && y.w === 2);
			if (!key || !val) continue;
			const name = new TextDecoder().decode(key.v);
			if (name === '5h' || name === '7d') {
				const win = pbReadWindow(val.v);
				if (win) found[name] = win;
			}
		}
		if (Object.keys(found).length) return found;
		if (depth < 4) {
			for (const x of fields) {
				if (x.w === 2 && x.v.length > 8) {
					const r = pbFindWindows(x.v, depth + 1);
					if (r) return r;
				}
			}
		}
		return null;
	}

	async function gunzip(u8) {
		const ds = new DecompressionStream('gzip');
		const writer = ds.writable.getWriter();
		writer.write(u8);
		writer.close();
		return new Uint8Array(await new Response(ds.readable).arrayBuffer());
	}

	// Returns a reader that first yields an already-read chunk, then the rest.
	function withFirstChunk(reader, first) {
		let used = false;
		return {
			read: () => (used ? reader.read() : ((used = true), Promise.resolve({ done: false, value: first }))),
			cancel: (r) => reader.cancel(r)
		};
	}

	async function routeStream(response, path, contentType) {
		let reader;
		try {
			reader = response.clone().body?.getReader?.();
		} catch {
			return;
		}
		if (!reader) return;
		let first;
		try {
			do {
				first = await reader.read();
			} while (!first.done && (!first.value || first.value.length === 0));
		} catch {
			return;
		}
		if (first.done) {
			post('cc:stream_summary', { types: [], lines: 0 });
			return;
		}
		// Text SSE starts with a printable character ("data:", "event:", ":"),
		// Connect frames start with a flag byte 0x00-0x03.
		const binary = first.value[0] <= 0x03;
		const r = withFirstChunk(reader, first.value);
		if (binary) scanProtoStream(response, path, contentType, r);
		else handleEventStream(response, r);
	}

	async function scanProtoStream(response, path, contentType, givenReader) {
		let bytes = 0;
		let frames = 0;
		let found = false;
		let lastKey = '';
		try {
			const reader = givenReader || response.clone().body?.getReader?.();
			if (!reader) return;
			let buf = new Uint8Array(0);
			const CAP = 1024 * 1024;
			while (bytes < CAP) {
				const { done, value } = await reader.read();
				if (done) break;
				bytes += value.length;
				const next = new Uint8Array(buf.length + value.length);
				next.set(buf, 0);
				next.set(value, buf.length);
				buf = next;
				// Connect framing: 1 flag byte, 4 byte big-endian length, payload.
				while (buf.length >= 5) {
					const len = ((buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4]) >>> 0;
					if (len > 4 * 1024 * 1024) {
						buf = new Uint8Array(0);
						break;
					}
					if (buf.length < 5 + len) break;
					const flags = buf[0];
					let payload = buf.subarray(5, 5 + len);
					buf = buf.subarray(5 + len);
					frames++;
					if (flags & 2) continue; // end-of-stream trailer (JSON)
					if (len < 12) continue; // keep-alives
					try {
						if (flags & 1) payload = await gunzip(payload);
						const windows = pbFindWindows(payload, 0);
						if (windows) {
							const key = JSON.stringify(windows);
							if (key !== lastKey) {
								lastKey = key;
								found = true;
								post('cc:message_limit', { windows, via: 'proto' });
							}
						}
					} catch {
						// one bad frame must not stop the rest
					}
				}
			}
			try {
				reader.cancel();
			} catch {
				// ignore
			}
		} catch {
			// best-effort; never disturb claude.ai
		} finally {
			post('cc:response_seen', { path, contentType: contentType.split(';')[0], bytes, frames, hasKeys: false, found });
		}
	}

	async function scanResponse(response, path, contentType) {
		let bytes = 0;
		let found = false;
		let hasKeys = false;
		try {
			const reader = response.clone().body?.getReader?.();
			if (!reader) return;
			const decoder = new TextDecoder();
			let text = '';
			const CAP = 512 * 1024;
			while (bytes < CAP) {
				const { done, value } = await reader.read();
				if (done) break;
				bytes += value.length;
				text += decoder.decode(value, { stream: true });
				if (!hasKeys && /message_limit|utilization|"windows"/.test(text)) hasKeys = true;
				if (!found) {
					const windows = extractObjectAfter(text, '"windows"');
					if (windows && (windows['5h'] || windows['7d'])) {
						found = true;
						post('cc:message_limit', { windows, via: 'scan' });
					}
				}
				if (text.length > 64 * 1024) text = text.slice(-32 * 1024); // keep memory small
			}
			try {
				reader.cancel();
			} catch {
				// ignore
			}
		} catch {
			// best-effort; never disturb claude.ai
		} finally {
			post('cc:response_seen', { path, contentType: contentType.split(';')[0], bytes, hasKeys, found });
		}
	}

	function post(type, payload) {
		window.postMessage({ cc: CC_MARKER, type, payload }, '*');
	}

	function postResponse(requestId, ok, payload, error) {
		window.postMessage(
			{
				cc: CC_MARKER,
				type: 'cc:response',
				requestId,
				ok,
				payload,
				error
			},
			'*'
		);
	}

	function toAbsoluteUrl(input) {
		if (typeof input === 'string') {
			if (input.startsWith('/')) return `https://claude.ai${input}`;
			return input;
		}
		if (input instanceof URL) return input.href;
		if (input instanceof Request) return input.url;
		return '';
	}

	function getConversationMeta(url) {
		// /api/organizations/{orgId}/chat_conversations/{conversationId}
		const match = url.match(/^https:\/\/claude\.ai\/api\/organizations\/([^/]+)\/chat_conversations\/([^/?]+)/);
		return match ? { orgId: match[1], conversationId: match[2] } : null;
	}

	async function handleConversationResponse({ orgId, conversationId }, response) {
		try {
			const cloned = response.clone();
			const data = await cloned.json();
			post('cc:conversation', { orgId, conversationId, data });
		} catch {
			// ignore parse failures
		}
	}

	async function handleEventStream(response, givenReader) {
		// What kinds of events this stream carried (names only, never content),
		// reported at the end so the popup can show what was actually seen.
		const typesSeen = new Set();
		let dataLines = 0;
		try {
			const reader = givenReader || response.clone().body?.getReader?.();
			if (!reader) return;
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split(/\r\n|\r|\n/);
				buffer = lines.pop() || '';
				for (const line of lines) {
					if (!line.startsWith('data:')) continue;
					const raw = line.slice(5).trim();
					if (!raw) continue;
					try {
						const json = JSON.parse(raw);
						dataLines++;
						if (typeof json?.type === 'string' && typesSeen.size < 16) typesSeen.add(json.type);
						if (json?.type === 'message_limit' && json.message_limit) {
							post('cc:message_limit', json.message_limit);
						}
					} catch {
						// ignore
					}
				}
			}
		} catch {
			// best-effort; don't break claude.ai
		} finally {
			post('cc:stream_summary', { types: Array.from(typesSeen), lines: dataLines });
		}
	}

	window.addEventListener('message', async (event) => {
		if (event.source !== window) return;
		const data = event.data;
		if (!data || data.cc !== CC_MARKER) return;
		if (data.type !== 'cc:request') return;

		const { requestId, kind, payload } = data;
		try {
			if (kind === 'hash') {
				const text = typeof payload?.text === 'string' ? payload.text : '';
				if (!text || !crypto?.subtle?.digest) {
					postResponse(requestId, false, null, 'Hash unavailable');
					return;
				}
				const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
				const bytes = new Uint8Array(buffer);
				const hash = Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
				postResponse(requestId, true, { hash }, null);
				return;
			}

			if (kind === 'usage') {
				const orgId = payload?.orgId;
				if (!orgId) throw new Error('Missing orgId');
				const res = await originalFetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
					method: 'GET',
					credentials: 'include'
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const json = await res.json();
				postResponse(requestId, true, json, null);
				return;
			}

			if (kind === 'conversation') {
				const orgId = payload?.orgId;
				const conversationId = payload?.conversationId;
				if (!orgId || !conversationId) throw new Error('Missing orgId/conversationId');

				const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=true&rendering_mode=messages&render_all_tools=true`;
				const res = await originalFetch(url, {
					method: 'GET',
					credentials: 'include'
				});
				const json = await res.json();
				post('cc:conversation', { orgId, conversationId, data: json });
				postResponse(requestId, true, json, null);
				return;
			}

			throw new Error(`Unknown request kind: ${kind}`);
		} catch (e) {
			postResponse(requestId, false, null, e?.message || String(e));
		}
	});
})();
