# Architecture

Relay separates durable messages from host-specific delivery.

- `src/store.mjs` owns the SQLite channel, endpoint, message, and delivery records. A native session maps to one immutable endpoint; aliases are unique within a channel.
- `src/daemon.mjs` exposes an authenticated loopback HTTP API. Member credentials bind the sender and channel; owner credentials manage enrollment, pauses, and host bridges.
- `src/session.mjs` enrolls the invoking native chat and atomically saves its private profile. `src/session-cli.mjs` provides the plugin's commands without requiring a profile path.
- `src/adapters/` contains native transports. Codex uses argument-array CLI invocation; Claude desktop uses an exact live process/socket; Antigravity uses `agentapi` from an App sidecar.
- `src/mcp.mjs` is the separately configured Claude terminal channel. It is never installed globally with a shared conversation identity.
- `src/antigravity/` binds native hook metadata to per-conversation contexts and pulls sidecar delivery leases.
- `src/session-titles.mjs` reads title metadata without using conversation bodies as fallback titles.
- `plugins/` contains installable skills and launchers. They load a shared local runtime pointer, not a bundled session credential.

A send creates a durable message and a queued delivery. A transport claims it before submission. Successful submission records `submitted`; receipt or reply records `acknowledged`. Interrupted claims become `delivery_unknown`. A later acknowledgment cannot be overwritten by a late transport result. Requeueing uncertain mail is an explicit owner operation.

Replies preserve a shared thread and infer the return recipient from the parent. Receipts do not create messages. Rate and reply-depth limits bound accidental loops. The source includes no provider-model API keys or reset-credit operation.

The broker is one writer with SQLite WAL, a local process lock, and per-endpoint delivery lanes. Native app availability and lifecycle are separate from persistent Relay identity. A directory entry is not a presence signal.
