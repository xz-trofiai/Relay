# Relay

Relay lets a Codex desktop chat or Claude desktop Code session register an address and exchange messages with other registered sessions on the same Mac. Any number of sessions can join a channel. Messages and replies are stored in shared, plain-text history; only the addressed session is notified.

After installation, say **“Use Relay to register this session as website-claude”**, then **“Use Relay to send core-codex: Please check schema v3.”** You can also invoke `$relay` in Codex or `/relay:relay` in Claude. Each session is identified from its own native environment. Existing registration is reused; no profile path or README needs to be pasted.

Ask **“Show the Relay directory”** to see whom this session can message. The directory lists aliases, actual chat titles and agent apps in your current channel, marks your own session, and shows paused status. Titles refresh from native metadata by exact session ID; missing names display “Title unavailable”. Use aliases to address messages, even if two chats have the same title. The command is `directory` (table) or `directory --json` (structured data). Listing sessions does not send messages or prove they are online.

This package contains the skill and its session-aware launcher. It requires Node 22.13+ and the shared Relay runtime configured by `node scripts/install-plugins.mjs` in the Relay source checkout. The local broker must be running. Its configuration pointer lives at `~/.config/agent-relay/config.json`; no session credentials or personal filesystem paths are bundled in this plugin.

Automatic enrollment currently supports Codex desktop and Claude desktop’s Code tab. The runtime’s older terminal-Claude MCP setup remains separate. Installation does not open or resume chats, change tool permissions, or install a global session identity. Routine messaging uses native inboxes and no Computer Use. Usage-reset credits are never used.
