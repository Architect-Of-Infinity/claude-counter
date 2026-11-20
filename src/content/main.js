(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	if (CC.__started) return;
	CC.__started = true;

	function getConversationId() {
		const match = window.location.pathname.match(/\/chat\/([^/?]+)/);
		return match ? match[1] : null;
	}

	function getOrgIdFromCookie() {
		try {
			return document.cookie
				.split('; ')
				.find((row) => row.startsWith('lastActiveOrg='))
				?.split('=')[1] || null;
		} catch {
			return null;
		}
	}

	/**
	 * Wait for an element to appear in the DOM using MutationObserver.
	 * More efficient than polling - reacts immediately when element appears.
	 * @param {string} selector - CSS selector
	 * @param {number} [timeoutMs] - Optional timeout in ms. Returns null if timeout expires.
	 */
	function waitForElement(selector, timeoutMs) {
		return new Promise((resolve) => {
			const existing = document.querySelector(selector);
			if (existing) {
				resolve(existing);
				return;
			}

			let timeoutId;
			const observer = new MutationObserver(() => {
				const el = document.querySelector(selector);
				if (el) {
					if (timeoutId) clearTimeout(timeoutId);
					observer.disconnect();
					resolve(el);
				}
			});

			observer.observe(document.body, { childList: true, subtree: true });

			if (timeoutMs) {
				timeoutId = setTimeout(() => {
					observer.disconnect();
					resolve(null);
				}, timeoutMs);
			}
		});
	}

	CC.waitForElement = waitForElement;

	function observeUrlChanges(callback) {
		let lastPath = window.location.pathname;

		const fireIfChanged = () => {
			const current = window.location.pathname;
			if (current !== lastPath) {
				lastPath = current;
				callback();
			}
		};

		// Listen for custom event from bridge (history methods wrapped early)
		window.addEventListener('cc:urlchange', fireIfChanged);
		// Also popstate for back/forward buttons
		window.addEventListener('popstate', fireIfChanged);

		return () => {
			window.removeEventListener('cc:urlchange', fireIfChanged);
			window.removeEventListener('popstate', fireIfChanged);
		};
	}

	function parseUsageFromUsageEndpoint(raw) {
		if (!raw || typeof raw !== 'object') return null;

		const normalizeWindow = (w, hours) => {
			if (!w || typeof w !== 'object') return null;
			if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
			const utilization = Math.max(0, Math.min(100, w.utilization));
			const resets_at = typeof w.resets_at === 'string' ? w.resets_at : null;
			return { utilization, resets_at, window_hours: hours };
		};

		const fiveHour = normalizeWindow(raw.five_hour, 5);
		const sevenDay = normalizeWindow(raw.seven_day, 24 * 7);

		if (!fiveHour && !sevenDay) return null;
		return { five_hour: fiveHour, seven_day: sevenDay };
	}

	function parseUsageFromMessageLimit(raw) {
		if (!raw?.windows || typeof raw.windows !== 'object') return null;

		const normalizeWindow = (w, hours) => {
			if (!w || typeof w !== 'object') return null;
			if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
			const utilization = Math.max(0, Math.min(100, w.utilization * 100));
			const resets_at = typeof w.resets_at === 'number' && Number.isFinite(w.resets_at)
				? new Date(w.resets_at * 1000).toISOString()
				: null;
			return { utilization, resets_at, window_hours: hours };
		};

		const fiveHour = normalizeWindow(raw.windows['5h'], 5);
		const sevenDay = normalizeWindow(raw.windows['7d'], 24 * 7);

		if (!fiveHour && !sevenDay) return null;
		return { five_hour: fiveHour, seven_day: sevenDay };
	}

	let currentConversationId = null;
	let currentOrgId = null;

	let usageState = null; // last snapshot applied to the UI (ours or another tab's)
	let usageResetMs = { five_hour: null, seven_day: null }; // cached parsed timestamps
	let lastUsageSseMs = 0;
	let usageFetchInFlight = false;
	let lastUsageUpdateMs = 0; // Date.now() of whatever snapshot we're currently showing

	// Once a window's resets_at passes locally, keep retrying the real fetch on
	// a short throttle (CC.CONST.ROLLOVER_RETRY_MS) until the server confirms
	// the rollover (a resets_at that has actually moved into the future) - see
	// maybeHandleRollover(). This replaces a fire-once flag that used to mark a
	// rollover "handled" the instant it was *attempted*, even if that attempt
	// failed or the tab was backgrounded and throttled - which is exactly how
	// the bar could get stuck showing a stale percentage and "0s" past reset.
	const lastRolloverAttemptMs = { five_hour: 0, seven_day: 0 };

	const ui = new CC.ui.CounterUI({
		onUsageRefresh: async () => {
			await refreshUsage({ passive: false });
		}
	});
	ui.initialize();

	// Bridge must be ready before we can make requests
	const bridgeReady = CC.injectBridgeOnce();

	function applyUsageUpdate(normalized, source, { persist = true, at = null } = {}) {
		if (!normalized) return;
		const now = Date.now();
		usageState = normalized;
		// `at` is when this snapshot was actually fetched. For one restored from
		// shared storage that is the cache's own timestamp, NOT "now" - otherwise a
		// 10-minute-old cached value would look brand new and never get refreshed.
		lastUsageUpdateMs = at ?? now;
		if (source === 'sse') lastUsageSseMs = now;
		// Cache parsed timestamps to avoid Date.parse() every tick
		usageResetMs.five_hour = normalized.five_hour?.resets_at ? Date.parse(normalized.five_hour.resets_at) : null;
		usageResetMs.seven_day = normalized.seven_day?.resets_at ? Date.parse(normalized.seven_day.resets_at) : null;
		ui.setUsage(normalized);

		// Share it with every other open claude.ai tab, and with this tab's next
		// reload. `persist: false` is for snapshots we're applying *from* that
		// same shared cache (our own echo, or another tab's update) - re-writing
		// on every echo would just bounce updatedAt between tabs for no reason.
		if (persist) {
			CC.store.patchUsageCache({ usage: normalized, updatedAt: now, source });
		}
	}

	// A snapshot arriving from storage - either the one-time read on load, or
	// another tab's write coming in live via onUsageCacheChanged.
	function applyCachedSnapshot(cache) {
		if (!cache || !cache.usage) return;
		if (cache.updatedAt && cache.updatedAt <= lastUsageUpdateMs) return; // not newer than what we're already showing
		applyUsageUpdate(cache.usage, cache.source || 'cache', { persist: false, at: cache.updatedAt || 0 });
	}

	function updateOrgIdIfNeeded(newOrgId) {
		if (newOrgId && typeof newOrgId === 'string' && newOrgId !== currentOrgId) {
			currentOrgId = newOrgId;
		}
	}

	let usageRetryCount = 0;
	let usageRetryTimer = null;

	// Remember WHY the last fetch did or didn't work, in shared storage, so the
	// toolbar popup can show it. Silent failures were the hardest part to debug.
	function recordFetchResult(ok, stage, detail) {
		const result = { at: Date.now(), ok, stage, detail: detail ? String(detail).slice(0, 160) : '' };
		if (!ok) console.debug('[Claude Counter] usage fetch failed:', stage, detail || '');
		CC.store.patchFetchState({ lastResult: result });
	}

	function scheduleUsageRetry() {
		if (usageRetryTimer) return;
		const delays = CC.CONST.USAGE_RETRY_DELAYS_MS;
		if (usageRetryCount >= delays.length) return; // give up until next navigation/rollover/hourly check
		const delay = delays[usageRetryCount++];
		usageRetryTimer = setTimeout(() => {
			usageRetryTimer = null;
			refreshUsage({ passive: true });
		}, delay);
	}

	// Claude's usage endpoint answered normally but both windows are null: this
	// account currently has no usage window to report. Not an error. Requires the
	// two keys to be present so a genuine format change still shows up as 'parse'.
	function isEmptyUsageResponse(raw) {
		return (
			!!raw &&
			typeof raw === 'object' &&
			'five_hour' in raw &&
			'seven_day' in raw &&
			raw.five_hour == null &&
			raw.seven_day == null
		);
	}

	function handleEmptyUsage() {
		// Keep any snapshot that is still live (e.g. exact numbers from the live
		// message event). Only drop one whose window has already ended, otherwise
		// the rollover logic would poll forever waiting for a window that the
		// server says does not exist.
		const now = Date.now();
		const expired =
			(usageResetMs.five_hour && now >= usageResetMs.five_hour) ||
			(usageResetMs.seven_day && now >= usageResetMs.seven_day);
		if (usageState && !expired) return;

		usageState = null;
		usageResetMs = { five_hour: null, seven_day: null };
		ui.setUsageEmpty();
		if (expired) CC.store.patchUsageCache({ usage: null, updatedAt: now, source: 'usage' });
	}

	function describeShape(raw) {
		if (raw === null || raw === undefined) return String(raw);
		if (typeof raw !== 'object') return typeof raw;
		const keys = Object.keys(raw).slice(0, 6).join(',');
		return `keys: ${keys || '(none)'}`;
	}

	async function refreshUsage({ passive = false } = {}) {
		// Claimed synchronously, before any await, so two triggers firing back to
		// back in the same tick (e.g. two rollover checks in a row) can't both
		// slide past this check while the first is still mid-flight - whichever
		// runs first claims it immediately, the second sees it claimed right away.
		if (usageFetchInFlight) return;
		usageFetchInFlight = true;

		let failure = null; // { stage, detail } when this attempt didn't produce data
		let succeeded = false;
		let emptyReport = false; // server answered, but reported no usage windows
		try {
			if ((await bridgeReady) === false) {
				failure = { stage: 'bridge', detail: 'page bridge script was not injected' };
				return;
			}
			const orgId = currentOrgId || getOrgIdFromCookie();
			if (!orgId) {
				failure = { stage: 'no-org', detail: 'lastActiveOrg cookie not readable' };
				return;
			}
			updateOrgIdIfNeeded(orgId);

			if (passive) {
				// If another claude.ai tab attempted a fetch very recently, sit this
				// one out and let their result reach us through the shared cache
				// instead (see the onUsageCacheChanged listener below).
				const state = await CC.store.getFetchState();
				if (state?.lastAttemptAt && Date.now() - state.lastAttemptAt < CC.CONST.PASSIVE_FETCH_DEBOUNCE_MS) {
					return;
				}
				await CC.store.patchFetchState({ lastAttemptAt: Date.now() });
			}

			let raw;
			try {
				raw = await CC.bridge.requestUsage(orgId);
			} catch (e) {
				failure = { stage: 'request', detail: e?.message || String(e) };
				return;
			}

			const parsed = parseUsageFromUsageEndpoint(raw);
			if (!parsed) {
				if (isEmptyUsageResponse(raw)) {
					handleEmptyUsage();
					emptyReport = true;
					return;
				}
				failure = { stage: 'parse', detail: `unexpected response (${describeShape(raw)})` };
				return;
			}
			applyUsageUpdate(parsed, 'usage');
			succeeded = true;
		} finally {
			usageFetchInFlight = false;
			if (succeeded) {
				usageRetryCount = 0;
				recordFetchResult(true, 'ok', '');
			} else if (emptyReport) {
				usageRetryCount = 0; // a valid answer, so no retry ladder
				recordFetchResult(true, 'no-windows', '');
			} else if (failure) {
				recordFetchResult(false, failure.stage, failure.detail);
				scheduleUsageRetry();
			}
		}
	}

	async function refreshConversation() {
		await bridgeReady;
		if (!currentConversationId) {
			ui.setConversationMetrics();
			return;
		}

		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

		try {
			await CC.bridge.requestConversation(orgId, currentConversationId);
		} catch {
			// ignore
		}
	}

	function handleGenerationStart() {
		CC.store.patchFetchState({ lastGeneration: Date.now() });
		if (!currentConversationId) return;
		ui.setPendingCache(true);
	}

	// --- Diagnostics shown in the popup (names/ids only, never message content) ---
	const recentPostPaths = [];
	function handlePostSeen(payload) {
		const path = payload?.path;
		if (!path || recentPostPaths.includes(path)) return;
		recentPostPaths.push(path);
		if (recentPostPaths.length > 8) recentPostPaths.shift();
		CC.store.patchFetchState({ recentPosts: recentPostPaths.slice() });
	}

	const recentResponses = [];
	function handleResponseSeen(payload) {
		const path = String(payload?.path || '').slice(0, 120);
		if (!path) return;
		const kb = Math.max(0.1, Math.round((Number(payload?.bytes) || 0) / 100) / 10);
		const frames = Number(payload?.frames) > 0 ? `, ${Number(payload.frames)} frames` : '';
		const entry = `${path} (${payload?.contentType || '?'}, ${kb} kB${frames}, usage keys: ${payload?.found ? 'yes, read' : payload?.hasKeys ? 'present, not readable' : 'no'})`;
		const at = recentResponses.findIndex((e) => e.startsWith(path + ' ('));
		if (at >= 0) recentResponses.splice(at, 1);
		recentResponses.push(entry);
		if (recentResponses.length > 4) recentResponses.shift();
		CC.store.patchFetchState({ recentResponses: recentResponses.slice() });
	}

	// Transport-independent: a finished reply always makes the page re-read the
	// conversation, so use that as the cue to re-check /usage shortly after.
	let afterReplyTimer = null;
	function scheduleUsageAfterReply() {
		clearTimeout(afterReplyTimer);
		afterReplyTimer = setTimeout(() => refreshUsage({ passive: true }), 2500);
	}

	function handleStreamSummary(payload) {
		const types = Array.isArray(payload?.types) ? payload.types.slice(0, 16).map(String) : [];
		CC.store.patchFetchState({ lastStream: { at: Date.now(), types, lines: Number(payload?.lines) || 0 } });
	}

	async function handleConversationPayload({ orgId, conversationId, data }) {
		if (!conversationId || conversationId !== currentConversationId) return;
		updateOrgIdIfNeeded(orgId);
		scheduleUsageAfterReply();
		if (!data) return;

		const metrics = await CC.tokens.computeConversationMetrics(data);
		ui.setConversationMetrics({ totalTokens: metrics.totalTokens, cachedUntil: metrics.cachedUntil });
	}

	function handleMessageLimit(messageLimit) {
		const parsed = parseUsageFromMessageLimit(messageLimit);
		CC.store.patchFetchState({
			lastLive: {
				at: Date.now(),
				parsed: !!parsed,
				fields: Object.keys(messageLimit || {}).slice(0, 12),
				windowKeys: Object.keys(messageLimit?.windows || {}).slice(0, 8)
			}
		});
		applyUsageUpdate(parsed, 'sse');
	}

	CC.bridge.on('cc:post_seen', handlePostSeen);
	CC.bridge.on('cc:stream_summary', handleStreamSummary);
	CC.bridge.on('cc:response_seen', handleResponseSeen);
	CC.bridge.on('cc:generation_start', handleGenerationStart);
	CC.bridge.on('cc:conversation', handleConversationPayload);
	CC.bridge.on('cc:message_limit', handleMessageLimit);

	// Cross-tab sync: whenever any tab (including this one) writes a fresh
	// usage snapshot, every tab's listener fires and picks it up immediately -
	// no polling, no message-passing to coordinate, just shared storage.
	CC.store.onUsageCacheChanged((cache) => applyCachedSnapshot(cache));

	// Bar position, live-updated the moment the popup changes it.
	CC.store.onSettingsChanged((settings) => ui.setBarPosition(settings.barPosition));

	async function handleUrlChange() {
		currentConversationId = getConversationId();

		// Attach usage line and header independently - they have different anchor
		// elements and CHAT_MENU_TRIGGER doesn't exist on home/new pages. Usage
		// line attachment is cheap and self-guarding (see attachUsageLine/_observeDom),
		// so a direct call here is enough; no need to wait for a specific element.
		ui.attachUsageLine();
		waitForElement(CC.DOM.CHAT_MENU_TRIGGER, 60000).then((el) => {
			if (el) ui.attachHeader();
		});

		// Usage is org-level, not conversation-level, so fetch it on EVERY page
		// (home / new chat included) and don't make it wait behind the conversation
		// request. Skipped only if what we're already showing is recent; a cached
		// snapshot older than CC.CONST.USAGE_STALE_MS is displayed right away but
		// still refreshed. Passive, so a pile of tabs opened at once don't all hit
		// the endpoint simultaneously.
		const usageIsStale = !usageState || Date.now() - lastUsageUpdateMs > CC.CONST.USAGE_STALE_MS;
		const usagePromise = usageIsStale ? refreshUsage({ passive: true }) : Promise.resolve();

		if (!currentConversationId) {
			ui.setConversationMetrics();
			await usagePromise;
			return;
		}

		// Best-effort orgId from cookie.
		updateOrgIdIfNeeded(getOrgIdFromCookie());

		await refreshConversation();
		await usagePromise;
	}

	const unobserveUrl = observeUrlChanges(handleUrlChange);
	window.addEventListener('beforeunload', unobserveUrl);

	// Refresh on branch navigation - watch for the branch indicator to change
	let branchObserver = null;
	document.addEventListener('click', (e) => {
		if (!currentConversationId) return;
		const btn = e.target.closest('button[aria-label="Previous"], button[aria-label="Next"]');
		if (!btn) return;

		// Find the branch indicator span (matches "X / Y" pattern) near the clicked button
		const container = btn.closest('.inline-flex');
		const spans = container?.querySelectorAll('span') || [];
		const indicator = Array.from(spans).find((s) => /^\d+\s*\/\s*\d+$/.test(s.textContent.trim()));
		if (!indicator) return;

		const originalText = indicator.textContent;

		// Clean up any existing observer
		if (branchObserver) branchObserver.disconnect();

		// Watch for the indicator text to change (with cleanup timeout)
		branchObserver = new MutationObserver(() => {
			if (indicator.textContent !== originalText) {
				branchObserver.disconnect();
				branchObserver = null;
				refreshConversation();
			}
		});

		branchObserver.observe(indicator, { childList: true, characterData: true, subtree: true });

		// Clean up if nothing changes after 60 seconds
		setTimeout(() => {
			if (branchObserver) {
				branchObserver.disconnect();
				branchObserver = null;
			}
		}, 60000);
	});

	// Seed from storage before the first handleUrlChange() runs, so its "only
	// fetch if we don't have usageState yet" check sees whatever's already
	// cached (this tab's last session, or another open tab) instead of always
	// treating a fresh page load as having nothing.
	async function boot() {
		applyCachedSnapshot(await CC.store.getUsageCache());
		ui.setBarPosition((await CC.store.getSettings()).barPosition);
		await handleUrlChange();
	}
	boot();

	function maybeHandleRollover(windowKey, now) {
		const resetMs = usageResetMs[windowKey];
		if (!resetMs || now < resetMs) return;

		// The window ended on our local clock. Zero it out right away instead of
		// leaving the old percentage (and a frozen "0s") sitting there while we
		// wait on the network - then keep retrying, throttled, until the server
		// confirms with a resets_at that has actually moved forward.
		if (windowKey === 'five_hour') ui.resetSessionOptimistically();
		else ui.resetWeeklyOptimistically();

		if (now - lastRolloverAttemptMs[windowKey] < CC.CONST.ROLLOVER_RETRY_MS) return;
		lastRolloverAttemptMs[windowKey] = now;
		refreshUsage({ passive: true });
	}

	function tick() {
		ui.tick();

		// Refresh usage when a window ends (5h / 7d). SSE won't fire at rollover unless a message is sent.
		const now = Date.now();
		maybeHandleRollover('five_hour', now);
		maybeHandleRollover('seven_day', now);

		// Optional hourly safety refresh.
		const ONE_HOUR_MS = 60 * 60 * 1000;
		const sseAge = now - lastUsageSseMs;
		const anyAge = now - lastUsageUpdateMs;
		if (!document.hidden && sseAge > ONE_HOUR_MS && anyAge > ONE_HOUR_MS) {
			refreshUsage({ passive: true });
		}
	}

	// Background tabs get setInterval throttled by the browser, so a countdown
	// that hit zero while you were on another tab (or another app entirely)
	// won't refresh right away. Catch up immediately the moment this tab
	// becomes visible again instead of waiting on the next 1s tick.
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) return;
		tick();
		const now = Date.now();
		const missedRollover =
			(usageResetMs.five_hour && now >= usageResetMs.five_hour) ||
			(usageResetMs.seven_day && now >= usageResetMs.seven_day);
		const stale = now - lastUsageUpdateMs > 60 * 1000;
		if (missedRollover || stale) refreshUsage({ passive: true });
	});

	// Keep countdowns + markers updated.
	setInterval(tick, 1000);
})();
