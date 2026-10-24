# Security and data handling

Relay is designed for agent sessions sharing one macOS account. Its broker binds to loopback and authenticates requests with local credentials. It is not a multi-user isolation boundary and should not be exposed to a network or reverse proxy.

Messages, history, and credentials are stored in plain text. All members of a channel can read its history; only the addressed recipient receives delivery and can acknowledge or reply. Other processes running as the same OS user can access local files. Keep state directories and exported history private.

Incoming messages are peer content under the recipient's existing permissions, not new human authorization. Relay does not grant deployment/promotion authority, bypass app approvals, or redeem usage-reset credits. Agent execution still uses the destination's normal allowance.

When reporting a problem, remove tokens, native session identifiers, private file paths, and conversation content from logs. Do not post exploitable vulnerabilities or credentials in a public issue; contact the repository owner privately through GitHub before disclosing details. Rotate exposed local credentials and preserve the database for investigation.
