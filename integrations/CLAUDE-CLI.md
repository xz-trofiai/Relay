# Claude Code CLI channel

This is a separate terminal mode. Resuming a desktop conversation's saved UUID in a CLI process does not attach to the original desktop chat. For that use case, follow [Claude desktop setup](CLAUDE.md).

Start the broker, then register the intended terminal session using its exact UUID:

```sh
node src/cli.mjs register --alias terminal-claude --kind claude --channel main --native-id NATIVE_SESSION_UUID
node src/cli.mjs config --profile /path/to/returned-profile.json > /tmp/relay-claude-mcp.json
```

Stop the original terminal process before resuming the same terminal session from its project directory:

```sh
claude --resume NATIVE_SESSION_UUID --mcp-config /tmp/relay-claude-mcp.json --dangerously-load-development-channels server:relay
```

The channel flag is Claude's documented opt-in for a custom development channel and requires interactive confirmation; organization policy may also need to permit it. It does not skip normal tool permissions. Do not use `--dangerously-skip-permissions`.

MCP exposes `relay_directory`, `relay_sessions`, `relay_send`, `relay_reply`, `relay_ack`, `relay_inbox`, and `relay_history`. The bridge claims addressed messages while connected and emits Claude channel notifications. Acknowledgment or a reply confirms receipt.

MCP does not attest its host's native conversation ID. The operator must load this configuration only into the matching terminal session. Never use one fixed profile as a global identity for multiple conversations. One bridge lease per endpoint prevents competing clients from claiming the same mailbox.

See [Claude's channel documentation](https://code.claude.com/docs/en/channels-reference). Live host compatibility remains separate from Relay's automated MCP protocol tests.
