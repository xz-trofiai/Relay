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
const publicEndpoint = ({ token, native_id, bridge_id, bridge_until, desktop_host, ...rest }) => rest;

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
      CREATE TABLE IF NOT EXISTS desktop_hosts (
        host TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE REFERENCES endpoints(id)
      );
      CREATE TABLE IF NOT EXISTS desktop_redirects (
        predecessor TEXT PRIMARY KEY REFERENCES endpoints(id), successor TEXT NOT NULL UNIQUE REFERENCES endpoints(id),
        CHECK (predecessor != successor)
      );
      CREATE VIEW IF NOT EXISTS active_endpoints AS
        SELECT e.id,e.channel,COALESCE(old.alias,e.alias) AS alias,e.kind,e.native_id,e.token,
          e.paused,e.last_seen,e.bridge_id,e.bridge_until,h.host AS desktop_host
        FROM endpoints e LEFT JOIN desktop_redirects r ON r.successor=e.id
        LEFT JOIN endpoints old ON old.id=r.predecessor LEFT JOIN desktop_hosts h ON h.endpoint=e.id
        WHERE NOT EXISTS (SELECT 1 FROM desktop_redirects d WHERE d.predecessor=e.id);
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
  register(input) { return this.transaction(() => this._register(input)); }
  _register({ alias, kind, channel = 'general', native_id = null }) {
    for (const [key, value] of Object.entries({ alias, channel, kind })) {
      if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) throw new RelayError(`Invalid ${key}`);
    }
    if (native_id !== null) required(native_id, 'native_id', 256);
    if (['codex', 'claude-desktop', 'agy'].includes(kind) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(native_id ?? '')) {
      throw new RelayError('Registration requires the exact native session UUID');
    }
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
  }
  // Owner-only, serialized by the daemon. Recover the same credential after a
  // lost response/profile write; never retarget an alias or a native session.
  enroll({ kind, native_id, alias, channel, default_channel = 'main' }) {
    if (kind === 'claude-desktop') throw new RelayError('Desktop enrollment requires verified broker observation', 409);
    if (!['codex', 'agy'].includes(kind) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(native_id ?? '')) {
      throw new RelayError('Enrollment requires a supported native session UUID');
    }
    const existing = this.db.prepare('SELECT * FROM endpoints WHERE kind=? AND native_id=?').get(kind, native_id);
    if (existing) {
      if (alias !== undefined && alias !== existing.alias) throw new RelayError(`This session is already registered as ${existing.alias}; enrollment does not rename it`, 409);
      if (channel !== undefined && channel !== existing.channel) throw new RelayError(`This session already belongs to channel ${existing.channel}`, 409);
      return { endpoint: existing, reused: true };
    }
    return { endpoint: this.register({ kind, native_id, alias: alias ?? `${kind}-${native_id}`,
      channel: channel ?? default_channel }), reused: false };
  }
  // Only consume a fresh observation generated by the broker, never fields
  // supplied by a plugin. Without an enrollment request this cannot create a member.
  reconcileDesktop(observation, request) {
    const conflict = reason => { throw new RelayError(`Claude desktop identity: ${reason}; owner review required`, 409); };
    if (!observation || observation.error) conflict(observation?.error ?? 'no verified live session');
    const { native, host, prior } = observation;
    return this.transaction(() => {
      const desktops = this.db.prepare("SELECT * FROM active_endpoints WHERE kind='claude-desktop'").all();
      const exact = desktops.find(e => e.native_id === native);
      if (this.db.prepare('SELECT 1 FROM desktop_redirects r JOIN endpoints e ON e.id=r.predecessor WHERE e.native_id=?').get(native)) {
        conflict('a retired native session has returned');
      }
      const previous = desktops.filter(e => e !== exact && (e.desktop_host === host || prior?.includes(e.native_id)));
      if (previous.length > 1) conflict('multiple earlier registrations');
      const old = previous[0];
      for (const e of [old, exact].filter(Boolean)) if (e.desktop_host && e.desktop_host !== host) conflict('different recorded host');
      if (old && !prior?.includes(old.native_id)) conflict('host record does not confirm the prior native ID');
      let active = exact ?? old, reused = !!active;
      if (!active) {
        if (!request) return null;
        if (!request.alias) conflict('unknown session; for a new chat explicitly register --alias NAME; for a returning chat report the conflict');
        active = this._register({ kind: 'claude-desktop', native_id: native, alias: request.alias,
          channel: request.channel ?? request.default_channel ?? 'main' });
      }
      if (old) {
        if (this.db.prepare("SELECT 1 FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE m.recipient IN (?,?) AND d.status='submitting'").get(old.id,active.id)) conflict('delivery in flight; retry later');
        if (exact) {
          // Keep the current credential and reply threads. Route only future
          // addresses; the predecessor's original messages and receipts stay put.
          if (old.channel !== exact.channel || old.paused || exact.paused ||
              exact.alias !== `claude-${native}` || this.db.prepare('SELECT 1 FROM desktop_redirects WHERE successor IN (?,?)').get(old.id,exact.id)) {
            conflict('registrations cannot be safely consolidated');
          }
          this.db.prepare('INSERT INTO desktop_redirects(predecessor,successor) VALUES (?,?)').run(old.id,exact.id);
          this.db.prepare('DELETE FROM desktop_hosts WHERE endpoint=?').run(old.id);
        } else {
          this.db.prepare('UPDATE endpoints SET native_id=? WHERE id=?').run(native,old.id);
        }
      }
      if (!active.desktop_host) this.db.prepare('INSERT INTO desktop_hosts(host,endpoint) VALUES (?,?)').run(host,active.id);
      const endpoint = this.endpoint(active.id);
      if (request?.alias !== undefined && request.alias !== endpoint.alias &&
          !this.db.prepare('SELECT 1 FROM endpoints WHERE id=? AND alias=?').get(active.id, request.alias)) conflict('alias mismatch; enrollment does not rename it');
      if (request?.channel !== undefined && request.channel !== endpoint.channel) conflict('registration is in a different channel');
      return { endpoint, reused };
    });
  }
  endpoint(id) {
    const endpoint = this.db.prepare('SELECT * FROM active_endpoints WHERE id=?').get(id);
    if (!endpoint) throw new RelayError('Endpoint not found', 404);
    return endpoint;
  }
  authenticate(token) {
    return this.db.prepare('SELECT * FROM active_endpoints WHERE token=?').get(token);
  }
  sessions(channel) {
    const rows = channel
      ? this.db.prepare('SELECT * FROM active_endpoints WHERE channel=? ORDER BY alias').all(channel)
      : this.db.prepare('SELECT * FROM active_endpoints ORDER BY channel,alias').all();
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
  routeId(id) {
    return this.db.prepare('SELECT successor FROM desktop_redirects WHERE predecessor=?').get(id)?.successor ?? id;
  }
  message(id) {
    const result = this.db.prepare(`SELECT m.*, d.status, d.attempts, d.error,
      COALESCE(aa.alias,a.alias) AS sender_alias, COALESCE(bb.alias,b.alias) AS recipient_alias
      FROM messages m JOIN deliveries d ON d.message_id=m.id
      JOIN endpoints a ON a.id=m.sender JOIN endpoints b ON b.id=m.recipient
      LEFT JOIN active_endpoints aa ON aa.id=m.sender LEFT JOIN active_endpoints bb ON bb.id=m.recipient WHERE m.id=?`).get(id);
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
    const target = matches[0] && this.endpoint(this.routeId(matches[0].id));
    if (!target) throw new RelayError('Recipient is not registered in this channel', 404);
    if (target.id === sender.id) throw new RelayError('Self-addressed messages are not supported');
    const existing = this.db.prepare('SELECT id FROM messages WHERE sender=? AND idempotency_key=?')
      .get(senderId, idempotency_key);
    if (existing) {
      const previous = this.message(existing.id);
      if (previous.body !== body || this.routeId(previous.recipient) !== target.id || previous.reply_to !== reply_to) {
        throw new RelayError('Idempotency key was already used with different content', 409);
      }
      return previous;
    }
    if (sender.paused) throw new RelayError('Sender is paused', 409);
    let thread = randomUUID(), depth = 0;
    if (reply_to) {
      const parent = this.message(reply_to);
      if (parent.recipient !== senderId || this.routeId(parent.sender) !== target.id) {
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
  hasQueued(id) {
    return !!this.db.prepare("SELECT 1 FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE m.recipient=? AND d.status='queued' LIMIT 1").get(id);
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
