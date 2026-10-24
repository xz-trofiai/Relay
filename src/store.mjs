import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export class RelayError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function required(value, name, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new RelayError(`${name} must be a nonempty string of at most ${max} characters`);
  }
  return value;
}
const now = () => new Date().toISOString();
const publicEndpoint = ({ token, native_id, bridge_id, bridge_until, ...rest }) => rest;

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS channels (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS endpoints (
        id TEXT PRIMARY KEY, channel TEXT NOT NULL REFERENCES channels(name),
        alias TEXT NOT NULL, kind TEXT NOT NULL, native_id TEXT, token TEXT NOT NULL UNIQUE,
        paused INTEGER NOT NULL DEFAULT 0, last_seen TEXT,
        bridge_id TEXT, bridge_until INTEGER, UNIQUE(channel, alias)
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        channel TEXT NOT NULL REFERENCES channels(name), thread_id TEXT NOT NULL,
        sender TEXT NOT NULL REFERENCES endpoints(id), recipient TEXT NOT NULL REFERENCES endpoints(id),
        body TEXT NOT NULL, reply_to TEXT REFERENCES messages(id), depth INTEGER NOT NULL,
        created_at TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        UNIQUE(sender, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        message_id TEXT PRIMARY KEY REFERENCES messages(id), status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, claim TEXT, updated_at TEXT NOT NULL, error TEXT
      );
      CREATE INDEX IF NOT EXISTS channel_sequence ON messages(channel, seq);
      CREATE INDEX IF NOT EXISTS delivery_status ON deliveries(status);
      INSERT OR IGNORE INTO channels(name) VALUES ('general');`);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  register({ alias, kind, channel = 'general', native_id = null }) {
    for (const [key, value] of Object.entries({ alias, channel, kind })) {
      if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) throw new RelayError(`Invalid ${key}`);
    }
    if (native_id !== null) required(native_id, 'native_id', 256);
    if (['codex', 'claude-desktop', 'agy'].includes(kind) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(native_id ?? '')) {
      throw new RelayError('Registration requires the exact native session UUID');
    }
    return this.transaction(() => {
      if (this.db.prepare('SELECT id FROM endpoints WHERE channel=? AND alias=?').get(channel, alias)) {
        throw new RelayError('Alias already registered in this channel; choose another alias', 409);
      }
      if (native_id && this.db.prepare('SELECT id FROM endpoints WHERE kind=? AND native_id=?').get(kind, native_id)) {
        throw new RelayError('Native session already registered; use its existing identity', 409);
      }
      this.db.prepare('INSERT OR IGNORE INTO channels(name) VALUES (?)').run(channel);
      const id = randomUUID(), token = randomUUID();
      this.db.prepare('INSERT INTO endpoints(id,channel,alias,kind,native_id,token) VALUES (?,?,?,?,?,?)')
        .run(id, channel, alias, kind, native_id, token);
      return this.endpoint(id);
    });
  }
  // Owner-only, serialized by the daemon. Recover the same credential after a
  // lost response/profile write; never retarget an alias or a native session.
  enroll({ kind, native_id, alias, channel, default_channel = 'main' }) {
    if (!['codex', 'claude-desktop', 'agy'].includes(kind) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(native_id ?? '')) {
      throw new RelayError('Enrollment requires a supported native session UUID');
    }
    const existing = this.db.prepare('SELECT * FROM endpoints WHERE kind=? AND native_id=?').get(kind, native_id);
    if (existing) {
      if (alias !== undefined && alias !== existing.alias) throw new RelayError(`This session is already registered as ${existing.alias}; enrollment does not rename it`, 409);
      if (channel !== undefined && channel !== existing.channel) throw new RelayError(`This session already belongs to channel ${existing.channel}`, 409);
      return { endpoint: existing, reused: true };
    }
    return { endpoint: this.register({ kind, native_id, alias: alias ?? `${kind === 'claude-desktop' ? 'claude' : kind}-${native_id}`,
      channel: channel ?? default_channel }), reused: false };
  }
  endpoint(id) {
    const endpoint = this.db.prepare('SELECT * FROM endpoints WHERE id=?').get(id);
    if (!endpoint) throw new RelayError('Endpoint not found', 404);
    return endpoint;
  }
  authenticate(token) {
    return this.db.prepare('SELECT * FROM endpoints WHERE token=?').get(token);
  }
  sessions(channel) {
    const rows = channel
      ? this.db.prepare('SELECT * FROM endpoints WHERE channel=? ORDER BY alias').all(channel)
      : this.db.prepare('SELECT * FROM endpoints ORDER BY channel,alias').all();
    return rows.map(publicEndpoint);
  }
  pause(id, paused) {
    this.endpoint(id);
    this.db.prepare('UPDATE endpoints SET paused=? WHERE id=?').run(paused ? 1 : 0, id);
    return publicEndpoint(this.endpoint(id));
  }
  bindClaudeDesktop(id, nativeId) {
    return this.transaction(() => {
      const endpoint = this.endpoint(id);
      if (!['claude', 'claude-desktop'].includes(endpoint.kind) || endpoint.native_id !== nativeId) {
        throw new RelayError('Desktop binding must preserve an existing Claude native session identity', 409);
      }
      if (endpoint.bridge_until > Date.now()) throw new RelayError('Disconnect the CLI channel before binding Desktop', 409);
      if (this.db.prepare("SELECT 1 FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE m.recipient=? AND d.status='submitting'").get(id)) {
        throw new RelayError('Wait for the current delivery before rebinding', 409);
      }
      if (this.db.prepare("SELECT 1 FROM endpoints WHERE kind='claude-desktop' AND native_id=? AND id!=?").get(nativeId, id)) {
        throw new RelayError('Desktop native session already registered', 409);
      }
      this.db.prepare("UPDATE endpoints SET kind='claude-desktop',bridge_id=NULL,bridge_until=NULL WHERE id=?").run(id);
      return publicEndpoint(this.endpoint(id));
    });
  }
  message(id) {
    const result = this.db.prepare(`SELECT m.*, d.status, d.attempts, d.error,
      a.alias AS sender_alias, b.alias AS recipient_alias
      FROM messages m JOIN deliveries d ON d.message_id=m.id
      JOIN endpoints a ON a.id=m.sender JOIN endpoints b ON b.id=m.recipient WHERE m.id=?`).get(id);
    if (!result) throw new RelayError('Message not found', 404);
    return result;
  }
  send(senderId, input) {
    return this.transaction(() => this._send(senderId, input));
  }
  _send(senderId, { recipient, body, idempotency_key, reply_to = null }) {
    const sender = this.endpoint(senderId);
    required(body, 'body', 32000); required(idempotency_key, 'idempotency_key', 200);
    required(recipient, 'recipient', 100);
    const matches = this.db.prepare('SELECT * FROM endpoints WHERE channel=? AND (id=? OR alias=?)')
      .all(sender.channel, recipient, recipient);
    if (matches.length > 1) throw new RelayError('Ambiguous recipient; use a unique endpoint ID or alias', 409);
    const target = matches[0];
    if (!target) throw new RelayError('Recipient is not registered in this channel', 404);
    if (target.id === sender.id) throw new RelayError('Self-addressed messages are not supported');
    const existing = this.db.prepare('SELECT id FROM messages WHERE sender=? AND idempotency_key=?')
      .get(senderId, idempotency_key);
    if (existing) {
      const previous = this.message(existing.id);
      if (previous.body !== body || previous.recipient !== target.id || previous.reply_to !== reply_to) {
        throw new RelayError('Idempotency key was already used with different content', 409);
      }
      return previous;
    }
    if (sender.paused) throw new RelayError('Sender is paused', 409);
    let thread = randomUUID(), depth = 0;
    if (reply_to) {
      const parent = this.message(reply_to);
      if (parent.recipient !== senderId || parent.sender !== target.id) {
        throw new RelayError('Only the addressed recipient may reply to the sender', 403);
      }
      thread = parent.thread_id; depth = parent.depth + 1;
      if (depth > 12) throw new RelayError('Reply limit reached; owner review required', 409);
    }
    const recent = this.db.prepare('SELECT count(*) AS n FROM messages WHERE sender=? AND created_at>?')
      .get(senderId, new Date(Date.now() - 60000).toISOString()).n;
    if (recent >= 30) throw new RelayError('Message rate limit reached', 429);
    const id = randomUUID(), time = now();
    this.db.prepare(`INSERT INTO messages(id,channel,thread_id,sender,recipient,body,reply_to,depth,created_at,idempotency_key)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, sender.channel, thread, senderId, target.id, body, reply_to, depth, time, idempotency_key);
    this.db.prepare('INSERT INTO deliveries(message_id,status,updated_at) VALUES (?,?,?)').run(id, 'queued', time);
    if (reply_to) this.ack(senderId, reply_to);
    return this.message(id);
  }
  reply(senderId, id, { body, idempotency_key }) {
    const parent = this.message(id);
    return this.send(senderId, { recipient: parent.sender, body, idempotency_key, reply_to: id });
  }
  history(channel, { thread_id, after = 0, limit = 100 } = {}) {
    if (!Number.isSafeInteger(after) || after < 0) throw new RelayError('Invalid sequence cursor');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RelayError('Invalid page size');
    const rows = this.db.prepare(`SELECT id FROM messages WHERE channel=? AND seq>?
      AND (? IS NULL OR thread_id=?) ORDER BY seq LIMIT ?`).all(channel, after, thread_id ?? null, thread_id ?? null, limit);
    return rows.map(row => this.message(row.id));
  }
  inbox(id) {
    return this.db.prepare(`SELECT m.id FROM messages m JOIN deliveries d ON d.message_id=m.id
      WHERE m.recipient=? AND d.status!='acknowledged' ORDER BY m.seq LIMIT 100`).all(id).map(row => this.message(row.id));
  }
  ack(id, messageId) {
    if (this.message(messageId).recipient !== id) throw new RelayError('Only the recipient can acknowledge', 403);
    this.db.prepare("UPDATE deliveries SET status='acknowledged',error=NULL,updated_at=? WHERE message_id=?")
      .run(now(), messageId);
    return this.message(messageId);
  }
  claim(endpointId) {
    return this.transaction(() => {
      if (this.endpoint(endpointId).paused) return null;
      // A slow/disconnected sidecar must not overlap another delivery lane.
      if (this.db.prepare("SELECT 1 FROM messages m JOIN deliveries d ON m.id=d.message_id WHERE m.recipient=? AND d.status='submitting'").get(endpointId)) return null;
      const row = this.db.prepare(`SELECT m.id FROM messages m JOIN deliveries d ON m.id=d.message_id
        WHERE m.recipient=? AND d.status='queued' ORDER BY m.seq LIMIT 1`).get(endpointId);
      if (!row) return null;
      const claim = randomUUID();
      this.db.prepare("UPDATE deliveries SET status='submitting',claim=?,attempts=attempts+1,updated_at=? WHERE message_id=?")
        .run(claim, now(), row.id);
      return { message: this.message(row.id), claim };
    });
  }
  finish(endpointId, messageId, claim, status, error = null) {
    if (!['submitted', 'delivery_unknown', 'blocked_usage'].includes(status)) throw new RelayError('Invalid delivery status');
    if (this.message(messageId).recipient !== endpointId) throw new RelayError('Wrong delivery recipient', 403);
    const row = this.db.prepare('SELECT * FROM deliveries WHERE message_id=?').get(messageId);
    if (row.claim !== claim) throw new RelayError('Stale delivery claim', 409);
    // Acknowledgment may arrive before the transport command returns. Never regress it.
    this.db.prepare("UPDATE deliveries SET status=?,error=?,updated_at=? WHERE message_id=? AND status='submitting'")
      .run(status, error?.slice(0, 2000) ?? null, now(), messageId);
    if (status === 'blocked_usage') this.pause(endpointId, true);
    return this.message(messageId);
  }
  recover() {
    this.db.prepare("UPDATE deliveries SET status='delivery_unknown',error='Broker restarted during submission',updated_at=? WHERE status='submitting'").run(now());
    this.db.exec('UPDATE endpoints SET bridge_id=NULL,bridge_until=NULL');
  }
  expireClaims() {
    this.db.prepare("UPDATE deliveries SET status='delivery_unknown',error='Submission receipt timed out',updated_at=? WHERE status='submitting' AND updated_at<?")
      .run(now(), new Date(Date.now() - 60000).toISOString());
  }
  bridge(endpointId, instance, kind = 'claude') {
    required(instance, 'bridge instance', 100);
    const endpoint = this.endpoint(endpointId);
    if (!['claude', 'agy'].includes(kind) || endpoint.kind !== kind) {
      throw new RelayError(kind === 'claude' ? 'This endpoint is not a Claude channel' : 'Wrong bridge endpoint kind', 403);
    }
    if (endpoint.bridge_id && endpoint.bridge_id !== instance && endpoint.bridge_until > Date.now()) {
      throw new RelayError('Another live bridge owns this endpoint', 409);
    }
    this.db.prepare('UPDATE endpoints SET bridge_id=?,bridge_until=?,last_seen=? WHERE id=?')
      .run(instance, Date.now() + (kind === 'agy' ? 60000 : 15000), now(), endpointId);
    return this.claim(endpointId);
  }
  disconnect(endpointId, instance) {
    this.db.prepare('UPDATE endpoints SET bridge_id=NULL,bridge_until=NULL WHERE id=? AND bridge_id=?').run(endpointId, instance);
  }
  requeue(id) {
    const message = this.message(id);
    if (!['delivery_unknown', 'blocked_usage', 'submitted'].includes(message.status)) {
      throw new RelayError('Only unacknowledged attempted messages can be explicitly requeued', 409);
    }
    this.db.prepare("UPDATE deliveries SET status='queued',claim=NULL,error=NULL,updated_at=? WHERE message_id=?").run(now(), id);
    return this.message(id);
  }
}
