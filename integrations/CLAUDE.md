# Claude desktop — Code tab

Install with `node scripts/install-plugins.mjs --target claude` from the Relay checkout. This requires a plugin-capable Claude CLI even though the recipient is a desktop Code conversation. Start the broker and reload the plugin or desktop app if needed.

In the intended **Code tab** conversation, say:

> Use Relay to register this session as website-claude.

The plugin uses `CLAUDE_CODE_MESSAGING_SOCKET` and Claude's live registry to identify the exact current process. It does not choose a conversation by title or saved transcript.

Before each delivery, Relay checks the native UUID, desktop entrypoint, process start time, and private Unix inbox socket. If the exact conversation is offline, mail remains queued. Multiple live owners are rejected instead of guessed. This adapter does not support Claude's ordinary consumer chat.

Anthropic documents the [session inbox socket](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket), but not its full wire format. The current frame was verified with embedded Claude Code 2.1.308. Compatibility may need updates after provider upgrades.

Relay does not send a session auth token, override inbound permissions, or impersonate an authorized human. Socket completion is `submitted`; the recipient must acknowledge/reply through Relay. A held or refused message is not force-enabled or retried automatically.

## Existing operator-managed profiles

A live desktop session can be inspected by exact UUID:

```sh
node src/cli.mjs desktop-session --native-id NATIVE_SESSION_UUID
```

For a new manual registration:

```sh
node src/cli.mjs register --alias website-claude --kind claude-desktop --channel main --native-id NATIVE_SESSION_UUID
```

To convert an existing Relay Claude CLI endpoint to desktop, first disconnect its MCP bridge, then run `node src/cli.mjs bind-claude-desktop --profile /path/to/profile.json`. Binding must preserve the existing native UUID and requires its live desktop process. It keeps the alias and history. Relay never launches or resumes the conversation to make binding succeed.
