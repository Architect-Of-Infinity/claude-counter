(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	CC.DOM = Object.freeze({
		CHAT_MENU_TRIGGER: '[data-testid="chat-menu-trigger"]',
		MODEL_SELECTOR_DROPDOWN: '[data-testid="model-selector-dropdown"]',
		CHAT_PROJECT_WRAPPER: '.chat-project-wrapper',
		CHAT_COMPOSER: '[data-cds="ChatComposer"]',
		BRIDGE_SCRIPT_ID: 'cc-bridge-script'
	});

	CC.SETTINGS_DEFAULTS = Object.freeze({
		barPosition: 'inline' // 'inline' (under the composer) | 'top' (fixed pill at top of page)
	});

	CC.CONST = Object.freeze({
		CACHE_WINDOW_MS: 5 * 60 * 1000,
		CONTEXT_LIMIT_TOKENS: 200000,
		// Once a usage window's resets_at passes locally, how often to retry the
		// real fetch until the server confirms the rollover.
		ROLLOVER_RETRY_MS: 10 * 1000,
		// For fetches we start ourselves (not a direct user click): if another
		// open claude.ai tab attempted one this recently, sit this one out.
		PASSIVE_FETCH_DEBOUNCE_MS: 8 * 1000,
		// A cached snapshot older than this is shown immediately but also
		// re-fetched in the background when a tab loads or navigates, so a
		// reloaded tab never sits on hours-old numbers.
		USAGE_STALE_MS: 60 * 1000,
		// Back-off between retries after a failed usage fetch (then give up
		// until the next navigation / rollover / hourly check).
		USAGE_RETRY_DELAYS_MS: [10 * 1000, 30 * 1000, 90 * 1000]
	});

	CC.COLORS = Object.freeze({
		PROGRESS_FILL_DARK: '#2c84db',
		PROGRESS_FILL_LIGHT: '#5aa6ff',
		PROGRESS_OUTLINE_DARK: '#787877',
		PROGRESS_OUTLINE_LIGHT: '#bfbfbf',
		PROGRESS_MARKER_DARK: '#ffffff',
		PROGRESS_MARKER_LIGHT: '#111111',
		RED_WARNING: '#ce2029',
		BOLD_LIGHT: '#141413',
		BOLD_DARK: '#faf9f5'
	});
})();
