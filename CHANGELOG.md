# Changelog

## 0.3.1

- Preserve Claude desktop addresses across verified native session ID changes. Existing eligible duplicate addresses redirect new traffic without moving the old backlog. Unknown chats need an explicit alias, and ambiguous identities are held for owner review.

## 0.3.0 — 2026-10-24

First public source release.

- Local multi-party channels, per-session aliases, a directory, shared history, addressed delivery, receipts, and replies.
- Codex desktop and Claude desktop Code plugins with automatic native-session registration.
- Optional session-scoped Claude Code CLI MCP bridge.
- Antigravity App plugin with hook-based identity and native sidecar delivery; live App verification remains pending.
- Durable SQLite storage, idempotency, restart recovery, pause controls, and explicit handling of uncertain submissions.
- Native Codex/Claude chat titles when metadata is available; Antigravity titles remain unavailable.
- Portable setup documentation, automatic Codex executable discovery, CI, distribution checks, and Apache 2.0 licensing.
