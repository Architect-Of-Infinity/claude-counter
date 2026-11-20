(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	// Everything in this file talks to chrome.storage.local. That storage area is
	// shared by every tab of the extension on this browser profile (unlike plain
	// JS variables, which only live inside one tab's content-script instance) and
	// is disk-backed, so it survives a reload. That's what makes two things work:
	//   1. Twelve claude.ai tabs open at once all show the same numbers, because
	//      whichever tab actually fetches fresh data writes it here and every
	//      other tab is listening for the change.
	//   2. Reloading a tab doesn't show a blank bar while waiting on the network -
	//      we paint the last known snapshot immediately, then refresh underneath it.
	//
	// Two keys are stored:
	//   cc_usageCache - last known usage snapshot + bookkeeping, written by
	//                   whichever tab last fetched or received an SSE update.
	//   cc_settings   - user preferences (currently just bar position), written
	//                   by the popup.

	const KEY_USAGE_CACHE = 'cc_usageCache';
	const KEY_SETTINGS = 'cc_settings';
	const KEY_FETCH_STATE = 'cc_fetchState';

	function getStorageArea() {
		const storage = globalThis.browser?.storage || globalThis.chrome?.storage;
		return storage?.local || null;
	}

	function getOnChanged() {
		const storage = globalThis.browser?.storage || globalThis.chrome?.storage;
		return storage?.onChanged || null;
	}

	async function get(key, fallback) {
		const area = getStorageArea();
		if (!area) return fallback;
		try {
			const result = await area.get(key);
			return result && Object.prototype.hasOwnProperty.call(result, key) ? result[key] : fallback;
		} catch {
			return fallback;
		}
	}

	async function set(key, value) {
		const area = getStorageArea();
		if (!area) return false;
		try {
			await area.set({ [key]: value });
			return true;
		} catch {
			return false;
		}
	}

	function onKeyChanged(key, callback) {
		const onChanged = getOnChanged();
		if (!onChanged) return () => {};
		const listener = (changes, areaName) => {
			if (areaName !== 'local') return;
			if (!Object.prototype.hasOwnProperty.call(changes, key)) return;
			callback(changes[key].newValue ?? null, changes[key].oldValue ?? null);
		};
		onChanged.addListener(listener);
		return () => onChanged.removeListener(listener);
	}

	// --- Settings (bar position, etc.) -----------------------------------------

	async function getSettings() {
		const stored = await get(KEY_SETTINGS, null);
		return { ...CC.SETTINGS_DEFAULTS, ...(stored || {}) };
	}

	async function setSettings(partial) {
		const current = await getSettings();
		const next = { ...current, ...partial };
		await set(KEY_SETTINGS, next);
		return next;
	}

	function onSettingsChanged(callback) {
		return onKeyChanged(KEY_SETTINGS, (newValue) => {
			callback({ ...CC.SETTINGS_DEFAULTS, ...(newValue || {}) });
		});
	}

	// --- Usage cache (cross-tab sync) -------------------------------------------

	async function getUsageCache() {
		return get(KEY_USAGE_CACHE, null);
	}

	// Read-modify-write merge, since storage.set() replaces the whole value at a
	// key rather than merging nested fields.
	async function patchUsageCache(partial) {
		const current = (await getUsageCache()) || {};
		const next = { ...current, ...partial };
		await set(KEY_USAGE_CACHE, next);
		return next;
	}

	function onUsageCacheChanged(callback) {
		return onKeyChanged(KEY_USAGE_CACHE, (newValue) => callback(newValue));
	}

	// --- Fetch state (debounce + diagnostics) ----------------------------------
	// Kept under its own key, NOT inside the usage cache: it's written far more
	// often, and a read-modify-write on the usage cache from a tab holding a
	// stale copy could otherwise overwrite a fresh snapshot another tab just saved.
	//   { lastAttemptAt, lastResult: { at, ok, stage, detail } }

	async function getFetchState() {
		return get(KEY_FETCH_STATE, null);
	}

	// Patches are queued one after another inside a tab: several diagnostics can
	// fire within milliseconds, and two overlapping read-modify-writes would
	// otherwise each start from the same old value and lose the other's field.
	let fetchStateQueue = Promise.resolve();
	function patchFetchState(partial) {
		const run = async () => {
			const current = (await getFetchState()) || {};
			const next = { ...current, ...partial };
			await set(KEY_FETCH_STATE, next);
			return next;
		};
		const result = fetchStateQueue.then(run, run);
		fetchStateQueue = result.catch(() => {});
		return result;
	}

	function onFetchStateChanged(callback) {
		return onKeyChanged(KEY_FETCH_STATE, (newValue) => callback(newValue));
	}

	CC.store = {
		getFetchState,
		patchFetchState,
		onFetchStateChanged,
		getSettings,
		setSettings,
		onSettingsChanged,
		getUsageCache,
		patchUsageCache,
		onUsageCacheChanged
	};
})();
