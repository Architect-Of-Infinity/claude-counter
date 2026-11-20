# Changelog

## 0.5.8
- **Newer chat route works again.** claude.ai started labelling the `StreamTimeline` reply as `text/event-stream` while still sending binary protobuf frames, so the reply went to the text reader and the usage was never read. Streams are now routed by their first bytes instead of their label.

## 0.5.7
- **Reads usage on accounts using claude.ai's newer chat route** (`/claudeai-rpc/…/StreamTimeline`, Connect-framed protobuf). The `5h` and `7d` windows are found by their shape rather than by fixed field numbers, including in gzip frames.
- Values outside 0–1 are rejected instead of being shown as a wrong percentage; a window that carries only a reset time is read as 0%.
- Popup: *Message sent* recognises the newer route; *Other replies* shows frame counts.

## 0.5.6
- `/usage` is re-checked about 2.5 s after every reply, whichever route sent the message.
- Usage windows are looked for in any reply format, not only the `/completion` text stream.
- Popup: new *Other replies* line (path, type, size, whether usage was found); *Recent requests* lists every non-GET call to claude.ai.

## 0.5.5
- The network watcher now loads in the page's own context at `document_start`, before claude.ai's scripts, so sends can't bypass it through an early saved copy of `fetch`. The old injection stays as a fallback; the watcher installs only once.
- `XMLHttpRequest` POSTs appear in *Recent requests*.

## 0.5.4
- Popup **Live updates** section: whether the last send was seen, which events the reply carried, and whether it contained usage windows. **Copy details** button for bug reports.
- Only request paths (ids replaced with `:id`), event names and field names are recorded; never message text, tokens or cookies.
- Concurrent writes to the shared diagnostic state are queued so none are lost.

## 0.5.3
- Accounts whose `/usage` returns empty windows now show *Usage: not reported by Claude yet* instead of nothing, and this is not treated as an error.
- A live snapshot is kept when `/usage` reports no windows, until its window actually ends.

## 0.5.2
- Snapshots restored from storage keep their real age, so a reloaded tab refreshes anything older than 60 s.
- Usage is fetched on every page, including the new-chat page, without waiting for the conversation request.
- Failed fetches retry after 10 s, 30 s and 90 s; the popup shows why a fetch failed (no account id, HTTP status, unexpected response).
- Top pill: larger bars and text, anchored to the right so it stays clear of the chat title when vertical tabs are open.

## 0.5.0
- **Stuck at "resets in 0s" fixed:** when a window's reset time passes the bar zeroes immediately, and the real fetch retries every 10 s until the server confirms the new window. Switching back to a background tab catches up at once.
- **Synced across tabs and reloads:** usage is cached in `chrome.storage.local`, shared by every claude.ai tab; passive fetches back off if another tab just fetched.
- **Bar position setting** (top of page / in chat box) in a new toolbar popup, applied live to every tab.
- Keeps the upstream composer-anchor fix (`[data-cds="ChatComposer"]`), with the model-selector anchor as a fallback.

## 0.4.2 and earlier
- Upstream releases by she-llac: see [she-llac/claude-counter](https://github.com/she-llac/claude-counter).
