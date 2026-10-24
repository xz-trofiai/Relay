import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { Store } from '../src/store.mjs';
import { startDaemon } from '../src/daemon.mjs';
import { request } from '../src/client.mjs';
import { codexAdapter } from '../src/adapters/codex.mjs';

const temporaryDirectories = [];
after(() => { for (const path of temporaryDirectories) rmSync(path, { recursive: true, force: true }); });
const temporary = t => {
  const path = mkdtempSync(join(tmpdir(), 'relay-test-'));
  temporaryDirectories.push(path);
  return path;
};
const register = (store, alias, channel = 'shared', kind = 'manual') =>
  store.register({ alias, channel, kind, native_id: kind === 'codex' ? randomUUID() : null });
const send = (store, from, to, body = 'Question', key = randomUUID()) =>
  store.send(from.id, { recipient: to.alias, body, idempotency_key: key });

test('channel is N-party and public, while inboxes and acknowledgments remain addressed', t => {
  const store = new Store(join(temporary(t), 'db')); t.after(() => store.close());
  const codex = register(store, 'core'), claude = register(store, 'website'), agy = register(store, 'research');
  const other = register(store, 'website', 'unrelated');
  const question = send(store, codex, claude);
  send(store, claude, agy, 'Please check the evidence');
  assert.equal(store.history(agy.channel).length, 2);
  assert.equal(store.inbox(claude.id)[0].id, question.id);
  assert.equal(store.inbox(agy.id).length, 1);
  assert.equal(store.inbox(other.id).length, 0);
  assert.throws(() => store.ack(agy.id, question.id), /Only the recipient/);
  assert.throws(() => store.send(codex.id, { recipient: other.id, body: 'No', idempotency_key: 'x' }), /not registered/);
  const reply = store.reply(claude.id, question.id, { body: 'Supported', idempotency_key: 'reply' });
  assert.equal(reply.recipient, codex.id);
  assert.equal(reply.thread_id, question.thread_id);
  assert.equal(store.message(question.id).status, 'acknowledged');
  assert.equal(store.inbox(codex.id)[0].id, reply.id);
  assert.equal(store.sessions()[0].token, undefined);
  assert.equal(store.sessions()[0].native_id, undefined);
});

test('idempotency preserves one message and rejects accidental key reuse', t => {
  const store = new Store(join(temporary(t), 'db')); t.after(() => store.close());
  const a = register(store, 'a'), b = register(store, 'b');
  const first = send(store, a, b, 'Hello', 'stable-key');
  assert.equal(send(store, a, b, 'Hello', 'stable-key').id, first.id);
  assert.throws(() => send(store, a, b, 'Different', 'stable-key'), /different content/);
  assert.equal(store.history('shared').length, 1);
  assert.throws(() => register(store, 'a'), /already registered/);
  store.pause(a.id, true);
  assert.equal(send(store, a, b, 'Hello', 'stable-key').id, first.id);
});

test('missing identities and alias/UUID collisions fail rather than misroute', t => {
  const store = new Store(join(temporary(t), 'db')); t.after(() => store.close());
  assert.throws(() => store.register({ kind: 'manual' }), /Invalid alias/);
  const a = register(store, 'a'), b = register(store, 'b');
  register(store, b.id);
  assert.throws(() => store.send(a.id, { recipient: b.id, body: 'Hi', idempotency_key: 'x' }), /Ambiguous recipient/);
  assert.equal(store.history('shared').length, 0);
});

test('restart preserves queued work and does not replay ambiguous submissions', t => {
  const path = join(temporary(t), 'db');
  let store = new Store(path);
  const a = register(store, 'a'), b = register(store, 'b');
  const first = send(store, a, b), second = send(store, a, b);
  store.claim(b.id); store.close();
  store = new Store(path); t.after(() => store.close()); store.recover();
  assert.equal(store.message(first.id).status, 'delivery_unknown');
  assert.equal(store.message(second.id).status, 'queued');
  assert.equal(store.claim(b.id).message.id, second.id);
});

test('late transport completion cannot regress acknowledgement; usage block pauses delivery', t => {
  const store = new Store(join(temporary(t), 'db')); t.after(() => store.close());
  const a = register(store, 'a'), b = register(store, 'b');
  const first = send(store, a, b), delivery = store.claim(b.id);
  store.ack(b.id, first.id);
  store.finish(b.id, first.id, delivery.claim, 'submitted');
  assert.equal(store.message(first.id).status, 'acknowledged');
  const next = send(store, a, b), attempt = store.claim(b.id);
  store.finish(b.id, next.id, attempt.claim, 'blocked_usage', 'Allowance exhausted');
  send(store, a, b, 'Wait for later');
  assert.equal(store.endpoint(b.id).paused, 1);
  assert.equal(store.claim(b.id), null);
});

test('one Claude bridge per endpoint and finite reply chains', t => {
  const store = new Store(join(temporary(t), 'db')); t.after(() => store.close());
  const a = register(store, 'a'), b = register(store, 'b', 'shared', 'claude');
  store.bridge(b.id, 'bridge-1');
  assert.throws(() => store.bridge(b.id, 'bridge-2'), /Another live bridge/);
  store.disconnect(b.id, 'bridge-1');
  assert.equal(store.bridge(b.id, 'bridge-2'), null);
  let message = send(store, a, b);
  for (let i = 0; i < 12; i++) {
    message = store.reply(message.recipient, message.id, { body: 'Follow-up', idempotency_key: randomUUID() });
  }
  assert.throws(() => store.reply(message.recipient, message.id, { body: 'Stop', idempotency_key: randomUUID() }), /Reply limit/);
});

test('Codex adapter passes content literally, reports uncertainty, and blocks on quota', async () => {
  const endpoint = { native_id: randomUUID() };
  const message = { channel: 'shared', sender_alias: 'a', recipient_alias: 'b', id: 'id', thread_id: 'thread', body: '$(touch /tmp/no) `false` "quoted"\ntext' };
  let captured;
  const adapter = codexAdapter({ execute: (binary, args, options, callback) => {
    captured = { binary, args, options }; callback(null, 'queued', '');
  } });
  assert.equal((await adapter(endpoint, message)).status, 'submitted');
  assert.equal(captured.args[2], endpoint.native_id);
  assert.ok(captured.args[4].includes(message.body));
  assert.equal(captured.options.shell, undefined);
  const limited = codexAdapter({ execute: (b, a, o, callback) => callback(new Error('Usage limit reached'), '', '') });
  assert.equal((await limited(endpoint, message)).status, 'blocked_usage');
  const uncertain = codexAdapter({ execute: (b, a, o, callback) => callback(new Error('timed out'), '', '') });
  assert.equal((await uncertain(endpoint, message)).status, 'delivery_unknown');
});

async function daemonFor(t, adapters = {}) {
  const home = temporary(t);
  const daemon = await startDaemon({ home, port: 0, adapters, interval: 60000, resolveTitles: async identities =>
    new Map(identities.map(identity => [identity.id, { title: `Chat ${identity.id}`, title_source: 'test-metadata' }])) });
  t.after(() => daemon.close());
  return { ...daemon, home, owner: { url: daemon.url, token: daemon.ownerToken } };
}

test('HTTP binds identities, protects owner actions, and scopes public history to membership', async t => {
  const daemon = await daemonFor(t);
  const a = await request(daemon.owner, '/v1/register', { alias: 'a', kind: 'manual', channel: 'one' });
  const b = await request(daemon.owner, '/v1/register', { alias: 'b', kind: 'manual', channel: 'one' });
  const c = await request(daemon.owner, '/v1/register', { alias: 'c', kind: 'manual', channel: 'two' });
  const pa = { url: daemon.url, token: a.token }, pc = { url: daemon.url, token: c.token };
  const message = await request(pa, '/v1/send', { recipient: b.id, sender: c.id, body: 'Hi', idempotency_key: 'one' });
  assert.equal(message.sender, a.id);
  assert.equal((await request(pc, '/v1/history?channel=one')).length, 0);
  await assert.rejects(request(pa, '/v1/register', { alias: 'x', kind: 'manual' }), /Owner credential/);
  await assert.rejects(request({ url: daemon.url, token: 'bad' }, '/v1/status'), /Invalid Relay/);
  const origin = await fetch(`${daemon.url}/v1/status`, { headers: { Origin: 'https://example.com', Authorization: `Bearer ${a.token}` } });
  assert.equal(origin.status, 403);
  await assert.rejects(startDaemon({ home: daemon.home, port: 0 }), /already running/);
});

class MCPPeer {
  constructor(profilePath) {
    this.child = spawn(process.execPath, [resolve('src/mcp.mjs'), profilePath], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map(); this.events = []; this.seq = 0; this.stderr = '';
    this.child.stderr.on('data', text => { this.stderr += text; });
    createInterface({ input: this.child.stdout }).on('line', line => {
      const message = JSON.parse(line);
      if (message.id !== undefined) this.pending.get(message.id)?.(message);
      else this.events.push(message);
    });
  }
  write(message) { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); }
  async call(method, params = {}) {
    const id = ++this.seq;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP timeout: ${method}; ${this.stderr}`)); }, 5000);
      this.pending.set(id, value => { clearTimeout(timer); this.pending.delete(id); resolve(value); });
    });
    this.write({ id, method, params }); return result;
  }
  async start() {
    const response = await this.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'relay-test', version: '1' } });
    this.write({ method: 'notifications/initialized' }); return response;
  }
  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exit = once(this.child, 'exit'); this.child.stdin.end();
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    await exit; clearTimeout(kill);
  }
}
async function eventually(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Condition did not become true');
}

test('real MCP stdio round trip: addressed Claude channel notification, reply, and Codex adapter', async t => {
  const submitted = [];
  const daemon = await daemonFor(t, { codex: async (endpoint, message) => { submitted.push({ endpoint, message }); return { status: 'submitted' }; } });
  const core = register(daemon.store, 'core', 'product', 'codex');
  const website = register(daemon.store, 'website', 'product', 'claude');
  const observer = register(daemon.store, 'third-member', 'product');
  const profilePath = join(daemon.home, 'claude.json');
  writeFileSync(profilePath, JSON.stringify({ ...website, url: daemon.url }));
  const mcp = new MCPPeer(profilePath); t.after(() => mcp.close());
  const initialized = await mcp.start();
  assert.deepEqual(initialized.result.capabilities.experimental['claude/channel'], {});
  const discovered = await mcp.call('tools/list');
  assert.ok(discovered.result.tools.some(tool => tool.name === 'relay_reply'));
  assert.ok(discovered.result.tools.some(tool => tool.name === 'relay_directory'));
  const directoryResult = await mcp.call('tools/call', { name: 'relay_directory', arguments: {} });
  assert.ok(!directoryResult.result.isError);
  const listed = JSON.parse(directoryResult.result.content[0].text);
  assert.equal(listed.current_session.id, website.id);
  assert.equal(listed.current_session.title, `Chat ${website.id}`);
  assert.equal(listed.sessions.find(row => row.id === core.id).can_send, true);
  const question = send(daemon.store, core, website, 'Does schema v3 work?');
  await eventually(() => mcp.events.some(event => event.method === 'notifications/claude/channel'));
  const event = mcp.events.find(event => event.method === 'notifications/claude/channel');
  assert.equal(event.params.meta.message_id, question.id);
  assert.match(event.params.content, /Does schema v3 work/);
  assert.equal(daemon.store.inbox(observer.id).length, 0);
  const reply = await mcp.call('tools/call', { name: 'relay_reply', arguments: {
    message_id: question.id, body: 'Yes, v3 works.', idempotency_key: 'reply-1',
  } });
  assert.ok(!reply.result.isError, JSON.stringify(reply));
  const result = JSON.parse(reply.result.content[0].text);
  assert.equal(result.recipient, core.id);
  await daemon.tick();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].endpoint.native_id, core.native_id);
  assert.equal(submitted[0].message.id, result.id);
  assert.equal(daemon.store.message(question.id).status, 'acknowledged');
  assert.equal(daemon.store.message(result.id).status, 'submitted');
  const history = await mcp.call('tools/call', { name: 'relay_history', arguments: {} });
  assert.equal(JSON.parse(history.result.content[0].text).length, 2);
  // No receipt is sent as a third message, so there is no acknowledgment loop.
  assert.equal(daemon.store.history('product').length, 2);
  await mcp.close();
  assert.equal(mcp.child.signalCode, null, 'Bridge should exit cleanly on stdin EOF');
});
