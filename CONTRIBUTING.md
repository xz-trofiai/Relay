# Contributing

Use Node 22.13+ on macOS. Clone the repository and run:

```sh
npm ci --ignore-scripts
npm test
npm run check:distribution
```

Tests use local HTTP servers, Unix sockets, temporary databases, and simulated native transports. They must not require accounts, invoke models, message real conversations, or touch a developer's Relay state. Keep tests isolated and avoid assumptions about a username, checkout location, or installed app.

Preserve exact native session identity, addressed receipts, channel isolation, idempotency, and the distinction between submission and acknowledgment. Uncertain sends must not replay automatically. A new provider should come with focused contract tests and a clear statement of which native behavior has been live-verified.

Changes to plugin metadata must preserve the matching package versions. The portable source distribution includes both local marketplace manifests, both plugin packages, the runtime, and the locked dependency graph. Do not commit `.relay`, identity profiles, credentials, transcript exports, personal validation notes, or provider caches.

Open a pull request describing the problem, resulting behavior, and tests performed. Obtain the owner's explicit authorization before live inter-agent tests. Report compatibility issues with provider/Node versions and redacted errors; omit session credentials and private transcripts.
