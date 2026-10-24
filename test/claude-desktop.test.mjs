import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { findDesktopSession, desktopFrame, writeDesktopFrame, claudeDesktopAdapter } from '../src/adapters/claude-desktop.mjs';
import { Store } from '../src/store.mjs';
import { startDaemon } from '../src/daemon.mjs';

async function fixture() {
  // Keep Unix socket paths below macOS's length limit.
  const root = mkdtempSync('/tmp/relay-desktop-');
  const registry = join(root, 'registry'); mkdirSync(registry, { mode: 0o700 });
  const session = randomUUID(), servers = [];
  async function add(pid, options = {}) {
    const socket = join(root, `${pid}.sock`);
    const server = net.createServer(client => client.resume()); servers.push(server);
    server.listen(socket); await once(server, 'listening'); chmodSync(socket, 0o600);
    const record = { pid, sessionId: session, entrypoint: 'claude-desktop', hostSessionId: 'local_test',
      procStart: 'test-start', messagingSocketPath: socket, version: '2.1.308', name: 'Test', ...options };
    writeFileSync(join(registry, `${pid}.json`), JSON.stringify(record), { mode: 0o600 });
    return { record, server, socket };
  }
  return { root, registry, session, add, discover: id => findDesktopSession(id, { registry, processStart: async () => 'test-start' }),
    async close() { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); rmSync(root, { recursive: true, force: true }); } };
}

test('desktop discovery selects the exact live desktop process, excluding CLI and recycled PIDs', async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.add(1001, { entrypoint: 'cli' });
  await f.add(1002, { procStart: 'stale' });
  assert.equal(await f.discover(f.session), null);
  const correct = await f.add(1003);
  assert.equal((await f.discover(f.session)).socket, correct.socket);
  assert.equal(await f.discover(randomUUID()), null);
  await f.add(1004);
  await assert.rejects(f.discover(f.session), /Multiple live desktop/);
});

test('desktop discovery rejects symlinked and non-private socket targets', async t => {
  const f = await fixture(); t.after(() => f.close());
  const target = await f.add(1005);
  chmodSync(target.socket, 0o666);
  await assert.rejects(f.discover(f.session), /Unsafe Claude socket/);
  chmodSync(target.socket, 0o600);
  const recordPath = join(f.registry, '1005.json');
  const other = join(f.root, 'other.json'); writeFileSync(other, JSON.stringify(target.record));
  unlinkSync(recordPath); symlinkSync(other, recordPath);
  await assert.rejects(f.discover(f.session), /Unsafe Claude registry/);
});

test('native frame preserves exact session/message identity and sends no authority or auth claims', async t => {
  const f = await fixture(); t.after(() => f.close());
  const target = await f.add(1006);
  const message = { id: randomUUID(), channel: 'main', sender_alias: 'codex', recipient_alias: 'claude', thread_id: randomUUID(), body: '`false` $(touch /tmp/no)\nHello' };
  const frame = desktopFrame({ native_id: f.session }, message, join(f.root, "profile's.json"));
  assert.equal(frame.session_id, f.session); assert.equal(frame.uuid, message.id);
  assert.equal(frame.priority, 'next'); assert.equal(frame.from, undefined);
  assert.equal(frame.token, undefined); assert.equal(frame.from_mode, undefined);
  assert.ok(frame.message.content.includes(message.body));
  assert.ok(frame.message.content.includes("profile'\\''s.json"));
  const received = new Promise(resolve => target.server.once('connection', socket => {
    let data = ''; socket.on('data', chunk => { data += chunk; }); socket.on('end', () => resolve(data));
  }));
  await writeDesktopFrame(target.socket, frame);
  const wire = await received;
  assert.equal(wire.split('\n').length, 2);
  assert.deepEqual(JSON.parse(wire), frame);
});

test('binding preserves identity/history and prevents a CLI channel from claiming desktop mail', t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-bind-')), store = new Store(join(root, 'db'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const native = randomUUID();
  const from = store.register({ alias: 'a', kind: 'manual' });
  const to = store.register({ alias: 'b', kind: 'claude', native_id: native });
  const message = store.send(from.id, { recipient: to.id, body: 'hello', idempotency_key: 'a' });
  store.bridge(to.id, 'cli');
  assert.throws(() => store.bindClaudeDesktop(to.id, native), /Disconnect/);
  store.disconnect(to.id, 'cli');
  assert.throws(() => store.bindClaudeDesktop(to.id, native), /current delivery/);
  store.ack(to.id, message.id);
  assert.throws(() => store.bindClaudeDesktop(to.id, randomUUID()), /preserve/);
  store.bindClaudeDesktop(to.id, native);
  assert.equal(store.endpoint(to.id).token, to.token);
  assert.equal(store.endpoint(to.id).kind, 'claude-desktop');
  assert.equal(store.message(message.id).status, 'acknowledged');
  assert.throws(() => store.bridge(to.id, 'cli'), /not a Claude channel/);
});

test('offline desktop keeps mail queued; socket submission remains distinct from recipient acknowledgment', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-delivery-'));
  let online = false, frame;
  const driver = claudeDesktopAdapter({ home: root, discover: async () => online ? { socket: '/test.sock' } : null,
    write: async (socket, value) => { frame = value; } });
  const daemon = await startDaemon({ home: root, port: 0, adapters: { 'claude-desktop': driver }, interval: 60000 });
  t.after(async () => { await daemon.close(); rmSync(root, { recursive: true, force: true }); });
  const from = daemon.store.register({ alias: 'a', kind: 'manual' });
  const to = daemon.store.register({ alias: 'b', kind: 'claude-desktop', native_id: randomUUID() });
  const message = daemon.store.send(from.id, { recipient: to.id, body: 'hello', idempotency_key: 'a' });
  await daemon.tick();
  assert.equal(daemon.store.message(message.id).status, 'queued');
  assert.equal(daemon.store.message(message.id).attempts, 0);
  online = true; await daemon.tick();
  assert.equal(daemon.store.message(message.id).status, 'submitted');
  assert.equal(frame.session_id, to.native_id);
  daemon.store.ack(to.id, message.id);
  assert.equal(daemon.store.message(message.id).status, 'acknowledged');
  const uncertain = claudeDesktopAdapter({ home: root, discover: async () => ({ socket: '/test.sock' }), write: async () => { throw new Error('timeout'); } });
  assert.equal((await uncertain(to, message)).status, 'delivery_unknown');
});
