# Antigravity App support

Relay 0.3.0 supports Antigravity App conversations as additional members of the same local channels used by Codex and Claude. Implementation and isolated tests are complete. **Live delivery and visible chat rendering have not yet been verified in the native Antigravity App.** The installed `agy` 1.4.7 CLI validates the plugin package without findings, including its hook, skill, and sidecar.

## Install when ready

After installing Antigravity App, run from the Relay checkout:

```sh
cd /path/to/Relay
node scripts/install-plugins.mjs --target antigravity
```

This creates `~/.gemini/config/plugins/relay`, configures the shared Relay runtime, and enables `relay/bridge` in `~/.gemini/config/config.json`. Existing settings are preserved; changed settings and managed plugin upgrades are backed up under `~/.gemini/config/relay-backups`. An unrelated plugin already named `relay` is not overwritten. The installer uses the documented [manual plugin location](https://antigravity.google/docs/plugins), so no CLI install command or account signup is required for Relay itself. `--target both` continues to mean Codex and Claude only.

The installer pins the current Node executable and Relay configuration path in its hook and sidecar settings, avoiding reliance on the desktop app's ordinary PATH. Reinstall if that Node executable or the runtime checkout moves. Node 22.13+ is required. For isolated/custom installations, `--config FILE`, `--home DIR`, `--channel NAME`, and `--antigravity-config-dir DIR` are available.

Run a **0.3.0 or newer broker** with the existing Relay state. If upgrading the existing foreground broker, let current deliveries finish, stop it with `node src/cli.mjs stop`, then start it again:

```sh
npm start
```

`node src/cli.mjs status` reports its version. The installer does not restart the broker or install launchd. The Antigravity sidecar retries connecting while the broker is stopped; stored mail remains in Relay.

Start or reload Antigravity App. In the intended conversation, say:

> Use Relay to register this conversation as research-agy, then show the Relay directory.

Then, from Codex or Claude:

> Use Relay to send research-agy: Please check the interface proposal.

Antigravity can also send directly:

> Use Relay to send core-codex: I have reviewed the proposal.

Existing sessions may need a reload to discover the plugin. Choose the alias before invoking `directory`, since every Relay command enrolls on first use. Without a chosen alias, registration uses `agy-<native conversation UUID>`. Repeated registration keeps the same identity, channel, alias, and credentials.

## How it works

1. Antigravity's native `PreInvocation` hook supplies the conversation UUID and surface-specific transcript path. Relay checks that both refer to the same App conversation, writes a private per-conversation context, and supplies a command prefix to that conversation. It never opens the transcript. The hook is local and does not register the chat or contact the broker. These fields and the hook output follow the [hook contract](https://antigravity.google/docs/hooks).
2. When asked to use Relay, the plugin runs the normal registration/directory/send/reply helper with that context. Multiple chats in the same workspace have independent contexts; inherited Codex variables are ignored. Aliases route to individual chats in the current channel.
3. Antigravity manages the `relay/bridge` background sidecar. The sidecar claims queued Antigravity deliveries from Relay and invokes `agentapi send-message` with the exact native UUID and literal message argument. The app provides `agentapi` on the sidecar PATH. This uses the documented [sidecar interface](https://antigravity.google/docs/sidecars).
4. A successful native command is recorded as `submitted`. The recipient's plugin acknowledgment or reply records `acknowledged`. Receipts do not wake the sender. Replies preserve the shared thread and return address.

The sidecar uses a local owner credential for its delivery service; conversation commands use their own member credentials. Neither is packaged or printed. Registration is opt-in and the plugin is not a security boundary against other processes under the same Mac account. Messages and history remain plain text.

One sidecar lease and one in-progress claim per endpoint prevent overlapping deliveries. With no sidecar, messages remain queued. A failed, timed-out, or interrupted native submission becomes `delivery_unknown`; it is not replayed automatically. A usage-limit error pauses that endpoint. No reset-credit action exists. If native acceptance succeeds but the app later cannot run the message, `submitted` stays distinct from an acknowledgment.

## Current limits and later verification

- This package targets **Antigravity App**. CLI and IDE hook payloads are rejected; it never resumes a desktop conversation in a CLI process. Hooks fail without blocking unrelated agent work when Relay is unavailable or the surface is unsupported.
- The documented metadata does not expose the actual chat title. The directory shows **Antigravity App**, the alias, and **Title unavailable**. Titles are not fabricated from prompts or aliases. A native title reader requires verification against the installed App later.
- Busy-conversation behavior, closed-conversation behavior within a running App, and visible rendering have not been tested in the actual App. Native errors stop at `delivery_unknown`; Relay does not guess that it should resume or create a conversation.

For the first live check, register an owner-selected existing conversation, send one unique test heading, have it acknowledge and reply through Relay, and confirm both the heading and reply are visible in that original conversation. Also verify a second conversation cannot receive or acknowledge its addressed mail. This is the remaining acceptance check, not a claimed result of the automated tests.

To disable automatic delivery later, set only `sidecars["relay/bridge"].enabled` to `false` in Antigravity's configuration and reload the App. Removing the Relay plugin does not remove the shared database or registrations. Pending mail is retained.
