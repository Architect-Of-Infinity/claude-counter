(async () => {
	'use strict';

	const CC = globalThis.ClaudeCounter;
	const store = CC?.store;

	const buttons = Array.from(document.querySelectorAll('#position-toggle .cc-segmented__option'));
	const usageSummaryEl = document.getElementById('usage-summary');
	const diagEl = document.getElementById('usage-diag');
	const liveEl = document.getElementById('live-diag');
	const copyBtn = document.getElementById('copy-diag');
	let lastDiagText = '';

	function renderActivePosition(position) {
		for (const btn of buttons) {
			btn.classList.toggle('is-active', btn.dataset.value === position);
		}
	}

	function formatPct(n) {
		return `${Math.round(n * 10) / 10}%`;
	}

	function formatAge(updatedAt) {
		if (!updatedAt) return '';
		const minutes = Math.floor((Date.now() - updatedAt) / 60000);
		if (minutes < 1) return 'Updated just now';
		if (minutes === 1) return 'Updated 1 minute ago';
		if (minutes < 60) return `Updated ${minutes} minutes ago`;
		const hours = Math.floor(minutes / 60);
		return `Updated ${hours}h ago`;
	}

	const STAGE_LABELS = {
		bridge: "couldn't start on the page - reload the claude.ai tab",
		'no-org': "couldn't read your account id from the page",
		request: 'request to claude.ai failed',
		parse: 'claude.ai replied in a format this version does not understand'
	};

	function renderDiag(state) {
		const result = state?.lastResult;
		if (!result) {
			diagEl.textContent = '';
			return;
		}
		const age = formatAge(result.at).replace('Updated ', '');
		if (result.ok && result.stage === 'no-windows') {
			diagEl.textContent = `Last check: ${age} - Claude reported no usage windows for this account yet.`;
			return;
		}
		if (result.ok) {
			diagEl.textContent = `Last check: ${age} - OK.`;
			return;
		}
		const why = STAGE_LABELS[result.stage] || result.stage;
		diagEl.textContent = `Last check: ${age} - ${why}${result.detail ? ` (${result.detail})` : ''}.`;
	}

	function ago(ts) {
		return formatAge(ts).replace('Updated ', '');
	}

	// Plain-language summary of what the page actually did: was a message sent,
	// did a reply stream arrive, did it carry usage numbers. Names only.
	function describeLive(state) {
		const lines = [];
		lines.push([
			'Message sent',
			state?.lastGeneration
				? `last seen ${ago(state.lastGeneration)}`
				: (state?.recentPosts || []).some((p) => /\/PerformAction$/.test(p))
					? 'newer chat route (PerformAction seen)'
					: 'none seen yet'
		]);

		const st = state?.lastStream;
		if (!st) {
			lines.push(['Reply stream', 'none seen yet']);
		} else {
			const kinds = st.types.length ? st.types.join(', ') : `no readable events (${st.lines} lines)`;
			lines.push(['Reply stream', `${ago(st.at)}: ${kinds}`]);
		}

		const live = state?.lastLive;
		if (!live) {
			lines.push(['Usage event', 'none seen yet']);
		} else if (live.parsed) {
			lines.push(['Usage event', `${ago(live.at)}: included ${live.windowKeys.join(' + ') || 'windows'}`]);
		} else {
			lines.push([
				'Usage event',
				`${ago(live.at)}: arrived WITHOUT usage windows (fields: ${live.fields.join(', ') || 'none'})`
			]);
		}

		if (state?.recentResponses?.length) {
			lines.push(['Other replies', state.recentResponses.join('  |  ')]);
		}
		if (state?.recentPosts?.length) {
			lines.push(['Recent requests', state.recentPosts.join('  |  ')]);
		}
		return lines;
	}

	function renderLive(state) {
		const lines = describeLive(state);
		liveEl.textContent = '';
		for (const [label, value] of lines) {
			const row = document.createElement('div');
			const b = document.createElement('b');
			b.textContent = `${label}: `;
			row.appendChild(b);
			row.appendChild(document.createTextNode(value));
			liveEl.appendChild(row);
		}
		const result = state?.lastResult;
		const fetchLine = result
			? `Usage check: ${ago(result.at)} - ${result.ok ? result.stage : `${result.stage} ${result.detail || ''}`}`
			: 'Usage check: none yet';
		lastDiagText = [`Claude Counter ${chrome.runtime?.getManifest?.().version || ''}`, fetchLine]
			.concat(lines.map(([l, v]) => `${l}: ${v}`))
			.join('\n');
	}

	function renderUsage(cache) {
		const usage = cache?.usage;
		if (!usage || (!usage.five_hour && !usage.seven_day)) {
			usageSummaryEl.innerHTML = '<p class="cc-popup-hint">Open a claude.ai tab to fetch usage.</p>';
			return;
		}

		const rows = [];
		if (usage.five_hour) {
			rows.push(
				`<div class="cc-usage-row"><span>Session</span><strong>${formatPct(usage.five_hour.utilization)}</strong></div>`
			);
		}
		if (usage.seven_day) {
			rows.push(
				`<div class="cc-usage-row"><span>Weekly</span><strong>${formatPct(usage.seven_day.utilization)}</strong></div>`
			);
		}
		const ageLine = formatAge(cache.updatedAt);
		usageSummaryEl.innerHTML =
			rows.join('') + (ageLine ? `<p class="cc-popup-hint">${ageLine}</p>` : '');
	}

	if (!store) {
		// Storage APIs unavailable (shouldn't happen with the "storage" permission
		// granted, but fail quietly rather than leaving a broken-looking popup).
		usageSummaryEl.innerHTML = '<p class="cc-popup-hint">Unavailable.</p>';
		return;
	}

	for (const btn of buttons) {
		btn.addEventListener('click', async () => {
			const position = btn.dataset.value;
			renderActivePosition(position); // instant feedback, don't wait on the write
			await store.setSettings({ barPosition: position });
		});
	}

	const settings = await store.getSettings();
	renderActivePosition(settings.barPosition);

	const cache = await store.getUsageCache();
	renderUsage(cache);
	const fetchState = await store.getFetchState();
	renderDiag(fetchState);
	renderLive(fetchState);
	store.onFetchStateChanged((state) => {
		renderDiag(state);
		renderLive(state);
	});

	copyBtn.addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(lastDiagText);
			copyBtn.textContent = 'Copied';
		} catch {
			copyBtn.textContent = 'Copy failed - select the text instead';
		}
		setTimeout(() => (copyBtn.textContent = 'Copy details'), 1500);
	});

	store.onUsageCacheChanged((newCache) => renderUsage(newCache));
	store.onSettingsChanged((newSettings) => renderActivePosition(newSettings.barPosition));
})();
