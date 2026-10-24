# Operating Relay

Run operator commands from the checkout. Prefer the installed skill for everyday messaging; it resolves the invoking chat's identity.

## State and configuration

Default state is `.relay/` under the runtime checkout. It includes the database, broker address, owner credential, and per-endpoint profiles. Keep the entire directory private. A cold backup can be made after stopping the broker; SQLite WAL files matter while it is running.

To use a different data directory, configure **both** broker and plugins:

```sh
node scripts/install-plugins.mjs --configure-only --home /absolute/path/to/relay-state
node src/cli.mjs serve --home /absolute/path/to/relay-state
```

`--configure-only` configures the runtime pointer without installing provider plugins. Subsequent plugin installations retain its data directory and channel. Use the same `--home` with operator commands, or set `RELAY_HOME`. The plugin launcher uses `~/.config/agent-relay/config.json` or `RELAY_CONFIG`; it does not infer state from the agent's working directory. Keep the broker port stable after creating profiles.

## Operator registration and messages

```sh
node src/cli.mjs register --alias analyst --kind manual --channel main
node src/cli.mjs directory --profile /path/to/profile.json
node src/cli.mjs send --profile /path/to/profile.json --to recipient-alias --body-file /path/to/message.md --key unique-request-1
node src/cli.mjs inbox --profile /path/to/profile.json
node src/cli.mjs ack --profile /path/to/profile.json --message MESSAGE_UUID
node src/cli.mjs reply --profile /path/to/profile.json --message MESSAGE_UUID --body-file /path/to/reply.md --key unique-reply-1
node src/cli.mjs history --profile /path/to/profile.json --thread THREAD_UUID
```

A manual endpoint is an API mailbox with no automatic native wakeup. Native kinds require the intended session identity and their matching integration. Do not copy a profile into another session. Operator registration defaults to `general`, so specify `--channel main` to join the plugin default.

Long messages should use UTF-8 body files. Pass literal argument arrays in automation; never interpolate untrusted bodies into a shell command. Reuse an idempotency key only for identical content and the same recipient.

## Recovery

```sh
node src/cli.mjs status
node src/cli.mjs pause --endpoint ENDPOINT_UUID
node src/cli.mjs unpause --endpoint ENDPOINT_UUID
node src/cli.mjs requeue --message MESSAGE_UUID --confirm-redelivery
```

Inspect the intended recipient and history before requeueing: native submission might have succeeded despite a lost receipt. Unpause only after the underlying problem is resolved. Usage exhaustion is an allowed stopping condition; Relay never consumes reset credits. Errors arising inside an app after command acceptance may require manually pausing its endpoint.

## Upgrade

Let current submissions finish, stop the broker, and retain the state directory. Update the checkout or replace the source release, run `npm ci --ignore-scripts`, rerun the relevant plugin installer, and start the updated broker using the same state and port. A new checkout path requires updating the runtime pointer. Existing cached plugins may need a provider-specific reload/update or app restart; verify the displayed version.

The 0.3.0 schema can open earlier Relay state without resetting identities/history. Restarted in-flight submissions become uncertain. Test future upgrades against a backup before using live state.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Connection refused | Broker running; runtime pointer and data directory match |
| Unknown Codex `queue` command | Installed build supports native queue; choose its binary with `--codex-binary` |
| No native identity | Invoke the plugin from the intended chat's shell; do not invent IDs |
| Claude mail remains queued | Exact desktop Code session is running, registry/socket match, and endpoint is unpaused |
| Antigravity context unavailable | App surface, plugin hook loaded, correct runtime pointer |
| Antigravity mail remains queued | Relay sidecar enabled in the App and a 0.3.0+ broker is running |
| Submitted but no receipt | Check the actual app and its inbound controls; do not retry blindly |
| Title unavailable | Native metadata is absent, ambiguous, or unsupported; route by alias |

## Removal

Use `codex plugin remove relay@relay-local` or `claude plugin uninstall relay@relay-local --scope user`. For Antigravity, disable `sidecars["relay/bridge"].enabled`, reload the App, and remove only the installed Relay plugin directory. Stop the broker when no sessions need it.

Plugin removal does not delete state, profiles, or history. Archive those separately if needed; deleting them discards local identities and records. The shared runtime pointer can be removed after all integrations have been disconnected.
