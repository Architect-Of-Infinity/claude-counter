# Privacy

Claude Counter runs entirely in your browser.

- **No servers, no analytics, no tracking.** The extension never sends data anywhere except to `claude.ai`, using your existing login.
- **What it reads from claude.ai:**
  - your usage (`/api/organizations/{org}/usage`), using the org id from your `lastActiveOrg` cookie;
  - the conversation you have open, to count tokens;
  - the reply streams of messages you send, only to pick out the usage windows (`5h`, `7d`).
- **What it changes on claude.ai:** nothing. It never sends, edits or deletes anything.
- **What it stores, and where:** the last usage snapshot, the bar-position setting, and popup diagnostics, in `chrome.storage.local` on **this computer only**, shared between your own tabs. Uninstalling the extension deletes it.
- **Diagnostics contain no content:** request paths with ids replaced by `:id`, event and field names, sizes and timestamps. Never message text, tokens or cookies.
- **Permissions:** `storage`, and access to `https://claude.ai/*` only.
