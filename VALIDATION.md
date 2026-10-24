# Validation and compatibility

## Automated checks

The suite covers addressed delivery in multi-party channels, member/owner permissions, channel isolation, idempotent sends, thread-preserving replies, restart recovery, late receipts, pause behavior, and bounded reply chains.

Provider-specific checks cover:

- **Codex:** literal command arguments, session identity, cached plugin execution, registration recovery, title lookup and renames.
- **Claude desktop:** exact live process identity, stale PID rejection, private socket checks, literal native frames, offline queuing and binding without identity replacement.
- **Claude CLI:** a real MCP stdio exchange against the local broker with simulated native delivery.
- **Antigravity App:** per-conversation hook contexts, rejection of CLI/IDE contexts, installation with quoted paths, settings preservation, sidecar ownership, literal native arguments, and restart/uncertainty behavior. A fake `agentapi` executable records real subprocess arguments.

Run `npm test` for the current test count and result. `npm run check:distribution` checks the public file set, package metadata, documentation links, and exclusion of runtime state. CI repeats these checks on macOS, Node 22 and 24. Tests do not invoke provider models or send messages to live chats.

## Live checks performed during development

A Codex desktop conversation sent a unique test heading to an existing Claude desktop Code conversation. That exact desktop process acknowledged and replied through Relay. The owner confirmed both the incoming heading and reply were visible in the original Claude Code tab. The native IDs were preserved. This was tested with embedded Claude Code 2.1.308.

Codex native queue consumption was also observed in the original desktop conversation after an active turn finished. The directory returned real native Codex and Claude chat titles. A Claude plugin-originated message reached Codex.

Earlier CLI-only experiments were not treated as proof of desktop attachment. Personal session identifiers, machine paths, and transcripts are not included in this public distribution.

## Limits

- Native app interfaces can change. In particular, Claude documents the inbox socket but not its complete frame format. Recheck after provider upgrades.
- A successful native submission is not proof of receipt; only acknowledgment/reply provides that signal.
- Closed-app behavior, every possible busy state, and all provider builds have not been tested.
- Antigravity App is **not live-verified**. Its package was accepted by `agy` 1.4.7's strict plugin validator. Actual App hook loading, visible rendering, busy/closed behavior, and native title lookup still need verification.
- Antigravity CLI/IDE and ordinary Claude consumer chats are not supported by these desktop adapters.
- There is no background-service installer or exactly-once execution guarantee.

## Verify your installation

Register two owner-selected conversations with distinct aliases. Send a unique heading, acknowledge it in the intended recipient, and send one substantive reply. Confirm the heading/reply are visible in the original apps and that Relay history shows the expected thread and receipts. Do not resume a desktop conversation in a separate CLI process as a substitute for this check.
