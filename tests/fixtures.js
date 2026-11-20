// Test fixtures for the newer chat route (Connect-framed protobuf).
// No real chat data: USAGE_FRAME is the usage event as claude.ai sends it
// (usage fields and a stream timestamp only); every other frame is synthetic.
const zlib = require('node:zlib');

// Usage event: 5h = 0.17 (resets 1791494400), 7d = 0.0 (resets 1792033200).
const USAGE_FRAME = Buffer.from(
	'0a7552110a0f313739313437373337373335312d305801225e0801280032176f7665726167655f6e6f745f70726f766973696f6e65644a09666976655f686f75726a190a02376412130801120608b083c1d6061900000000000000006a190a023568121308011206088092a0d60619c3f5285c8fc2c53f',
	'hex'
);
const USAGE = { '5h': { utilization: 0.17, resets_at: 1791494400 }, '7d': { utilization: 0, resets_at: 1792033200 } };
const KEEPALIVE = Buffer.from('0a023200', 'hex');
const TRAILER = Buffer.from('{"metadata":{"Stream-Close-Reason":["cadence"]}}');

// --- tiny protobuf writer for synthetic frames ---
function varint(n) {
	const out = [];
	while (n > 127) {
		out.push((n % 128) | 128);
		n = Math.floor(n / 128);
	}
	out.push(n);
	return Buffer.from(out);
}
const len = (field, buf) => Buffer.concat([varint((field << 3) | 2), varint(buf.length), buf]);
const str = (field, s) => len(field, Buffer.from(s));
const dbl = (field, x) => {
	const b = Buffer.alloc(9);
	b[0] = (field << 3) | 1;
	b.writeDoubleLE(x, 1);
	return b;
};

// A streamed text block, shaped like a reply delta (synthetic text).
const TEXT_FRAME = len(1, Buffer.concat([str(10, '1700000000000-0'), len(2, Buffer.concat([str(1, 'cblk_test'), str(2, 'Hello from a test fixture.')]))]));

// Usage-shaped message built from scratch: window(key, fields...)
function usageMessage(windows) {
	const entries = windows.map(({ key, value }) => len(13, Buffer.concat([str(1, key), len(2, value)])));
	return len(1, len(4, Buffer.concat(entries)));
}
const windowValue = ({ utilization, resetsAt }) =>
	Buffer.concat([
		Buffer.from([0x08, 0x01]),
		resetsAt != null ? len(2, Buffer.concat([Buffer.from([0x08]), varint(resetsAt)])) : Buffer.alloc(0),
		utilization != null ? dbl(3, utilization) : Buffer.alloc(0)
	]);

// Connect framing: flag byte, 4-byte big-endian length, payload.
function frame(payload, { gzip = false, end = false } = {}) {
	const body = gzip ? zlib.gzipSync(payload) : payload;
	const h = Buffer.alloc(5);
	h[0] = (gzip ? 1 : 0) | (end ? 2 : 0);
	h.writeUInt32BE(body.length, 1);
	return Buffer.concat([h, body]);
}

// A whole reply stream: keep-alive, text, usage, keep-alive, end trailer.
const REPLY_STREAM = Buffer.concat([
	frame(KEEPALIVE),
	frame(TEXT_FRAME),
	frame(TEXT_FRAME),
	frame(USAGE_FRAME),
	frame(KEEPALIVE),
	frame(TRAILER, { end: true })
]);
// A conversation snapshot with no usage in it (gzip, like the page-load stream).
const SNAPSHOT_STREAM = Buffer.concat([frame(Buffer.concat([TEXT_FRAME, TEXT_FRAME, TEXT_FRAME]), { gzip: true }), frame(KEEPALIVE), frame(TRAILER, { end: true })]);

// Older chat route: text SSE from /completion.
const SSE_STREAM = Buffer.from(
	'event: message_start\ndata: {"type":"message_start"}\n\n' +
		'event: message_limit\ndata: ' +
		JSON.stringify({ type: 'message_limit', message_limit: { type: 'within_limit', windows: { '5h': { utilization: 0.22, resets_at: 1790000000 }, '7d': { utilization: 0.03, resets_at: 1790500000 } } } }) +
		'\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
);

module.exports = { USAGE_FRAME, USAGE, KEEPALIVE, TRAILER, TEXT_FRAME, REPLY_STREAM, SNAPSHOT_STREAM, SSE_STREAM, frame, usageMessage, windowValue };
