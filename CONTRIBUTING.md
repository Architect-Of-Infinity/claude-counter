# Contributing

Thanks for helping. Most changes fall into one of three kinds.

## 1. claude.ai changed how usage arrives (the common one)
- Ask for, or capture, the popup's **Copy details** output and a sanitized HAR of one short message (steps in the README).
- All network reading is in **`src/injected/bridge.js`**:
  - `routeStream` decides between the text reader (`handleEventStream`) and the protobuf reader (`scanProtoStream`) by the first bytes of the stream;
  - `pbFindWindows` finds the usage windows by shape (a `5h` / `7d` key with a 0–1 double and a reset timestamp).
- Add the new format to `tests/fixtures.js` and a test in `tests/bridge.test.js`.

## 2. Usage logic
- `src/content/main.js`: refresh timing, rollover, the empty state, and how every reader feeds `applyUsageUpdate`.
- `src/content/store.js`: the shared `chrome.storage.local` cache and settings.

## 3. UI
- Bar and header: `src/content/ui.js`, `src/styles.css`.
- Popup: `popup/`.

## Running it
```bash
# load: chrome://extensions → Developer mode → Load unpacked → this folder
cd tests && npm install && npm test
```

## Rules
- **Read-only towards claude.ai.** Never send, edit or delete anything on the user's behalf.
- **No external servers**, no analytics, no remote code.
- **No real chat data** in tests, fixtures or screenshots.
