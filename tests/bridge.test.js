// Tests for src/injected/bridge.js: how usage is read from claude.ai's replies.
// Run: node --test bridge.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const F = require('./fixtures');

const SRC = fs.readFileSync(path.resolve(__dirname, '../src/injected/bridge.js'), 'utf8');
const RPC = 'https://claude.ai/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline';
const COMPLETION = 'https://claude.ai/api/organizations/o/chat_conversations/c/completion';
const settle = () => new Promise((r) => setTimeout(r, 150));

// Deliver a body in chunks of `size` bytes, like a network stream.
function chunked(buf, size) {
	let off = 0;
	return new ReadableStream({
		pull(c) {
			if (off >= buf.length) return c.close();
			c.enqueue(new Uint8Array(buf.subarray(off, off + size)));
			off += size;
		}
	});
}

// A claude.ai page with bridge.js installed; `body` is the server's reply.
function page(body, contentType, size = 64) {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://claude.ai/chat/abc', runScripts: 'dangerously' });
	const w = dom.window;
	Object.assign(w, { Response, Request, URL, TextDecoder, DecompressionStream });
	w.fetch = async () => new Response(chunked(body, size), { status: 200, headers: { 'content-type': contentType } });
	const events = [];
	w.addEventListener('message', (e) => {
		if (e.data?.cc === 'ClaudeCounter') events.push(e.data);
	});
	w.eval(SRC);
	return { w, events, usage: () => JSON.parse(JSON.stringify(events.filter((e) => e.type === 'cc:message_limit').map((e) => e.payload.windows))) };
}

test('newer route: usage read from the protobuf stream, any chunk size', async () => {
	for (const size of [1, 7, 97, 1e6]) {
		const p = page(F.REPLY_STREAM, 'application/connect+proto', size);
		await p.w.fetch(RPC, { method: 'POST' });
		await settle();
		assert.equal(p.usage().length, 1, `one usage event (chunks of ${size})`);
		assert.deepEqual(p.usage()[0], F.USAGE);
	}
});

test('newer route labelled text/event-stream is still read as protobuf (Nov 2026 change)', async () => {
	const p = page(F.REPLY_STREAM, 'text/event-stream', 13);
	await p.w.fetch(RPC, { method: 'POST' });
	await settle();
	assert.deepEqual(p.usage(), [F.USAGE]);
});

test('routing is by content, not by path', async () => {
	const p = page(F.REPLY_STREAM, 'text/event-stream');
	await p.w.fetch('https://claude.ai/some/future/path', { method: 'POST' });
	await settle();
	assert.deepEqual(p.usage(), [F.USAGE]);
});

test('gzip-compressed usage frame', async () => {
	const p = page(Buffer.concat([F.frame(F.USAGE_FRAME, { gzip: true }), F.frame(F.TRAILER, { end: true })]), 'text/event-stream', 20);
	await p.w.fetch(RPC, { method: 'POST' });
	await settle();
	assert.deepEqual(p.usage(), [F.USAGE]);
});

test('conversation snapshot without usage: nothing invented, reported as "no"', async () => {
	const p = page(F.SNAPSHOT_STREAM, 'application/connect+proto');
	await p.w.fetch(RPC, { method: 'POST' });
	await settle();
	assert.deepEqual(p.usage(), []);
	const seen = p.events.find((e) => e.type === 'cc:response_seen');
	assert.equal(seen.payload.found, false);
	assert.equal(seen.payload.frames, 3);
});

test('a window with only a reset time is 0% (proto3 omits zero doubles)', async () => {
	const msg = F.usageMessage([{ key: '5h', value: F.windowValue({ resetsAt: 1791494400 }) }]);
	const p = page(F.frame(msg), 'application/connect+proto');
	await p.w.fetch(RPC, { method: 'POST' });
	await settle();
	assert.deepEqual(p.usage(), [{ '5h': { utilization: 0, resets_at: 1791494400 } }]);
});

test('values outside 0-1 are rejected, never shown as a wrong percentage', async () => {
	const msg = F.usageMessage([{ key: '5h', value: F.windowValue({ utilization: 17 }) }]);
	const p = page(F.frame(msg), 'application/connect+proto');
	await p.w.fetch(RPC, { method: 'POST' });
	await settle();
	assert.deepEqual(p.usage(), []);
});

test('garbage and empty streams: no crash, no usage', async () => {
	for (const body of [Buffer.from([0, 0, 0, 0, 40, 1, 2, 3]), Buffer.alloc(0)]) {
		const p = page(body, 'text/event-stream', 3);
		await p.w.fetch(RPC, { method: 'POST' });
		await settle();
		assert.deepEqual(p.usage(), []);
	}
});

test('older route: message_limit read from the /completion text stream', async () => {
	const p = page(F.SSE_STREAM, 'text/event-stream', 11);
	await p.w.fetch(COMPLETION, { method: 'POST' });
	await settle();
	assert.equal(p.usage().length, 1);
	assert.equal(p.usage()[0]['5h'].utilization, 0.22);
	assert.ok(p.events.some((e) => e.type === 'cc:generation_start'), 'send detected');
	const summary = p.events.find((e) => e.type === 'cc:stream_summary');
	assert.ok(summary.payload.types.includes('message_limit'));
});

test('claude.ai still receives the complete, unmodified stream', async () => {
	const p = page(F.REPLY_STREAM, 'text/event-stream', 33);
	const res = await p.w.fetch(RPC, { method: 'POST' });
	assert.ok(Buffer.from(await res.arrayBuffer()).equals(F.REPLY_STREAM));
});

test('other sites are ignored', async () => {
	const p = page(F.REPLY_STREAM, 'application/connect+proto');
	await p.w.fetch('https://example.com/x', { method: 'POST' });
	await settle();
	assert.equal(p.events.length, 0);
});

test('loaded twice, installs once', async () => {
	const p = page(F.SSE_STREAM, 'text/event-stream');
	const first = p.w.fetch;
	p.w.eval(SRC);
	assert.equal(p.w.fetch, first);
});
