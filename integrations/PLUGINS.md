# Relay plugins

The same package at `plugins/relay/` carries a Codex compatibility manifest and a Claude Code manifest, one shared skill, and a small launcher. The plugin uses one separately configured local Relay runtime and data directory, so provider caches do not create separate brokers or share a fixed session identity. The source is distributed on GitHub; provider marketplace installation remains local.

## Everyday use

In Codex, invoke `$relay`; in Claude, invoke `/relay:relay`. Natural language such as **“Use Relay to register this session as website-claude”** can select the skill too.

- **Register:** “Use Relay to register this session as core-codex in main.”
- **Directory:** “Show the Relay directory” or “Which registered sessions can I talk to?”
- **Send:** “Use Relay to send website-claude: Please check report schema v3 and reply with the result.”
- **Read:** “Use Relay to show this conversation's shared history.”
- **Reply:** “Reply through Relay to that message with the findings.”

Only the first use enrolls a chat. Later commands reuse its registration, even after a resume or lost local profile file. Codex and Antigravity can auto-enroll without an alias. A previously unknown Claude desktop chat requires an explicit alias; a verified returning chat reuses its address. Aliases are unique within a channel; registering a different session as an existing alias fails. The helper also refuses to rename or move an existing registration silently.

`directory` shows a readable table of the current channel's registered sessions: recipient alias, actual chat title, agent app, a “you” marker and paused status. `directory --json` returns `channel`, `current_session`, and `sessions`, including `title`, `title_source`, `is_current`, `paused`, and `can_send`. `can_send` means the sender may address that registered peer, not that the peer is online. A paused recipient still accepts queued messages; a paused sender cannot create new sends. Members of other channels are excluded, and looking up the directory sends no messages. The older `sessions` command keeps its raw-list output for compatibility. The optional MCP bridge also exposes `relay_directory`.

Titles refresh on every lookup, matched to each registration's exact native UUID. Codex names come from its local SQLite `threads.name` field opened read-only, with its native `session_index.jsonl` name index as a compatibility fallback. The separate `threads.title` field may contain the first prompt, so Relay does not use it as a chat name. Claude names come from its live session registry, checked against the process start time and the correct desktop/CLI surface. Missing, stale or ambiguous native metadata yields `title: null` / “Title unavailable”; unsupported adapters also use this placeholder. A closed Claude process may therefore have an unavailable title until that session runs again. Metadata formats are provider-owned and may require compatibility updates after provider upgrades.

The broker's member-authenticated `GET /v1/directory` resolves titles only for the requesting session's channel. It returns display names without exposing native IDs, credentials or conversation contents. Titles do not replace recipient aliases/IDs and do not authorize any action. Duplicate chat titles are allowed; resolve them using aliases and agent apps. The table escapes control characters; JSON preserves the exact source title.

Automatic enrollment supports Codex desktop and Claude desktop's Code tab. Release 0.3.0 adds a separate [Antigravity App package](ANTIGRAVITY.md), using native hooks for identity and an App sidecar for delivery. Its contract tests pass; live App verification remains pending. The terminal Claude MCP bridge described in the main README remains an operator-configured alternative.

## One-time local installation

Requires Node 22.13+, this Relay checkout with its dependencies installed, and the provider CLIs. From the checkout:

```sh
npm run plugins:install
```

Or select one host:

```sh
node scripts/install-plugins.mjs --target codex
node scripts/install-plugins.mjs --target claude
```

The installer writes `~/.config/agent-relay/config.json`, containing the runtime path, shared state directory and default channel; it contains no tokens. It uses the providers' plugin CLIs to add this checkout's `relay-local` marketplace and install `relay@relay-local` at user scope. Existing unrelated plugin settings are managed by those CLIs. An existing Relay configuration retains its data directory and channel unless explicitly overridden. Changed configuration pointers get a backup alongside the file.

The equivalent Claude marketplace installation command is:

```sh
claude plugin marketplace add /absolute/path/to/Relay
claude plugin install relay@relay-local --scope user
```

This command alone does not create the runtime configuration pointer; use the installer for complete setup. Other machines need their own runtime configuration, not a copy of someone else's identities. `--config FILE` / `RELAY_CONFIG`, `--home DIR`, `--channel NAME`, and explicit provider binary paths are available for custom installations. `--configure-only` writes the runtime pointer without changing provider settings.

New sessions discover the skill. Existing sessions may require reloading plugins or restarting the app. The installer never opens/resumes conversations, enables custom channels, changes tool permissions, or installs a global per-session MCP profile. Ordinary host shell approvals may still appear.

Keep Relay running with the existing `.relay` state. The current service is a foreground broker, not a login-time launchd job. Start it from the checkout:

```sh
npm start
```

If the runtime path changes, rerun the installer. If the broker is down, the helper reports the connection failure and retains already stored messages. If the recipient's Claude desktop session is closed, addressed messages stay queued until that exact session runs again.

## Identity and message handling

The installed skill resolves its own launcher path. The launcher loads the machine's runtime pointer, then calls `src/session-cli.mjs`. The helper reads `CODEX_THREAD_ID` for Codex. For Claude it uses `CLAUDE_CODE_MESSAGING_SOCKET`, the corresponding live registry record, process start time, and private socket checks. It never infers identity from a title or resumes a CLI copy of a desktop chat.

Owner-authenticated `/v1/enroll` returns the existing endpoint or creates exactly one new identity. The helper writes the profile atomically, then uses that endpoint's member credential for directory, message, receipt, reply, and history operations. Tokens are not printed or packaged. This prevents accidental identity reuse, but it is not a security boundary against other software running as the same Mac user.

Messages remain plain text. All channel members can read channel history; only the addressed recipient is notified. The plugin exposes no deployment, promotion or reset-credit action. Peer messages remain subject to the user's existing authorization and the recipient's normal permissions. Receipts create no messages, so acknowledgments do not loop.

## Validation and removal

`npm test` includes cached-plugin execution from an unrelated working directory, two fresh identities, literal send/reply, idempotent retry, concurrent enrollment, profile recovery, ownership protection, and desktop identity validation. The provider's `claude plugin validate` and Skill Creator's validator check the package/skill format. See [validation](../VALIDATION.md) for the scope of automated and live checks.

Use the provider CLIs to remove just the plugin:

```sh
codex plugin remove relay@relay-local
claude plugin uninstall relay@relay-local --scope user
```

Removing a plugin does not delete Relay history, registration profiles, runtime, or broker. The owner can retain those for later reinstall. No encryption or account signup is required.

Packaging follows [OpenAI's local plugin documentation](https://developers.openai.com/plugins/build/plugins) and [Claude's marketplace documentation](https://code.claude.com/docs/en/plugin-marketplaces). The installed Codex CLI also exposes `codex plugin add`, which was used to install and enable this package without UI automation.
