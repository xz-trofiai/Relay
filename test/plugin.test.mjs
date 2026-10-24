import { tmpdir } from 'node:os';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../src/store.mjs';
import { startDaemon } from '../src/daemon.mjs';
import { currentSession, enrollSession } from '../src/session.mjs';
import { request } from '../src/client.mjs';

const execute = promisify(execFile);
const directories = [];
after(() => { for (const root of directories) rmSync(root, { recursive: true, force: true }); });
const temporary = t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-plugin-'));
  directories.push(root);
  return root;
};

test('enrollment reuses the exact endpoint and rejects alias theft, rename and channel changes', t => {
  const root = temporary(t), store = new Store(join(root, 'db'));
  t.after(() => store.close());
  const input = { kind: 'codex', native_id: randomUUID(), alias: 'core' };
  const first = store.enroll(input);
  assert.equal(first.reused, false);
  assert.equal(store.enroll(input).endpoint.token, first.endpoint.token);
  assert.equal(store.enroll({ kind: input.kind, native_id: input.native_id }).endpoint.alias, 'core');
  assert.throws(() => store.enroll({ ...input, alias: 'different' }), /does not rename/);
  assert.throws(() => store.enroll({ ...input, channel: 'other' }), /already belongs/);
  assert.throws(() => store.enroll({ ...input, native_id: randomUUID() }), /Alias already registered/);
  assert.throws(() => store.enroll({ kind: 'codex', native_id: 'a title' }), /UUID/);
  const third = store.enroll({ kind: 'claude-desktop', native_id: randomUUID(), default_channel: 'project' });
  assert.equal(third.endpoint.channel, 'project');
  assert.match(third.endpoint.alias, /^claude-/);
  store.pause(first.endpoint.id, true);
  assert.equal(store.enroll(input).endpoint.paused, 1, 'enrollment must not unpause usage-blocked sessions');
});

test('identity detection binds to the current shell and verified desktop process, never a saved name', async t => {
  const registry = temporary(t), native = randomUUID(), outer = randomUUID();
  const socket = '/tmp/cc-socks/1234.sock';
  const recordPath = join(registry, '1234.json');
  writeFileSync(recordPath, JSON.stringify({ sessionId: native, entrypoint: 'claude-desktop' }));
  const options = { env: { CODEX_THREAD_ID: outer, CLAUDE_CODE_MESSAGING_SOCKET: socket }, registry,
    discover: async id => ({ native_id: id, pid: 1234, socket }) };
  assert.deepEqual(await currentSession(options), { kind: 'claude-desktop', native_id: native });
  assert.deepEqual(await currentSession({ env: { CODEX_THREAD_ID: outer } }), { kind: 'codex', native_id: outer });
  await assert.rejects(currentSession({ env: {} }), /No native session/);
  await assert.rejects(currentSession({ ...options, discover: async () => null }), /does not match/);
  await assert.rejects(currentSession({ ...options, discover: async () => ({ native_id: native, pid: 1234, socket: '/wrong' }) }), /does not match/);
  writeFileSync(recordPath, JSON.stringify({ sessionId: native, entrypoint: 'cli' }));
  await assert.rejects(currentSession(options), /Terminal Claude/);
});

test('concurrent enrollment and lost local profile recover one identity; member cannot enroll peers', async t => {
  const home = temporary(t);
  const daemon = await startDaemon({ home, port: 0, adapters: {}, interval: 60000, resolveTitles: async () => new Map() });
  t.after(() => daemon.close());
  const native = randomUUID();
  const options = { home, alias: 'my-chat', identityOptions: { env: { CODEX_THREAD_ID: native } } };
  const all = await Promise.all(Array.from({ length: 6 }, () => enrollSession(options)));
  assert.equal(new Set(all.map(x => x.profile.id)).size, 1);
  assert.equal(all.filter(x => !x.reused).length, 1);
  const { profile } = all[0], profilePath = join(home, 'identities', `${profile.id}.json`);
  assert.equal(statSync(profilePath).mode & 0o777, 0o600);
  rmSync(profilePath);
  assert.equal((await enrollSession(options)).profile.token, profile.token);
  assert.equal(JSON.parse(readFileSync(profilePath)).id, profile.id);
  await assert.rejects(request(profile, '/v1/enroll', { kind: 'codex', native_id: randomUUID() }), /Owner credential/);
});

test('cached plugin works outside its repo: fresh enrollment, discovery, literal send, retry and reply', async t => {
  const root = temporary(t), home = join(root, 'state');
  const daemon = await startDaemon({ home, port: 0, adapters: {}, interval: 60000,
    resolveTitles: async identities => new Map(identities.map(identity => [identity.id,
      { title: `Native title for ${identity.id}`, title_source: 'test-metadata' }])) });
  t.after(() => daemon.close());
  const cached = join(root, "cache with ' spaces", 'relay');
  cpSync(resolve('plugins/relay'), cached, { recursive: true });
  const config = join(root, 'config.json');
  await execute(process.execPath, [resolve('scripts/install-plugins.mjs'), '--configure-only', '--config', config, '--home', home]);
  const first = randomUUID(), second = randomUUID();
  const env = { ...process.env, RELAY_CONFIG: config, CLAUDE_CODE_MESSAGING_SOCKET: '' };
  const run = async (id, ...args) => {
    const result = await execute(process.execPath, [join(cached, 'scripts/relay.mjs'), ...args],
      { cwd: root, env: { ...env, CODEX_THREAD_ID: id } });
    assert.ok(!result.stdout.includes('"token"'));
    return JSON.parse(result.stdout);
  };
  const a = await run(first, 'register', '--alias', 'core');
  const b = await run(second, 'register', '--alias', 'website');
  assert.equal(a.reused, false); assert.equal((await run(first, 'whoami')).reused, true);
  assert.equal((await run(first, 'sessions')).length, 2);
  const listing = await run(first, 'directory', '--json');
  assert.equal(listing.current_session.id, a.id);
  assert.equal(listing.sessions.find(row => row.id === b.id).title, `Native title for ${b.id}`);
  assert.equal(listing.sessions.find(row => row.id === b.id).can_send, true);
  const table = await execute(process.execPath, [join(cached, 'scripts/relay.mjs'), 'directory'],
    { cwd: root, env: { ...env, CODEX_THREAD_ID: first } });
  assert.match(table.stdout, /core \(you\)/);
  assert.match(table.stdout, /website/);
  const bodyPath = join(root, 'body.txt'), literal = 'Question\n`false` $(touch /tmp/should-not-exist)';
  writeFileSync(bodyPath, literal);
  const message = await run(first, 'send', '--to', 'website', '--body-file', bodyPath, '--key', 'question-1');
  assert.equal(message.body, literal); assert.equal(message.sender, a.id); assert.equal(message.recipient, b.id);
  assert.equal((await run(first, 'send', '--to', 'website', '--body-file', bodyPath, '--key', 'question-1')).id, message.id);
  assert.equal((await run(second, 'inbox'))[0].id, message.id);
  await run(second, 'ack', '--message', message.id);
  const reply = await run(second, 'reply', '--message', message.id, '--body', 'Answer', '--key', 'answer-1');
  assert.equal(reply.recipient, a.id); assert.equal(reply.thread_id, message.thread_id);
  const history = await run(first, 'history', '--thread', message.thread_id);
  assert.equal(history.length, 2); assert.equal(history[0].status, 'acknowledged');
  await assert.rejects(run(first, 'send', '--profile', '/someone/else', '--to', 'website', '--body', 'x', '--key', 'x'), /Unknown option/);
  await assert.rejects(run(first, 'register', '--alias', 'website'), /already registered as core/);
});

test('plugin fails clearly without installation config or a native session', async t => {
  const root = temporary(t), script = resolve('plugins/relay/scripts/relay.mjs');
  const env = { ...process.env, RELAY_CONFIG: join(root, 'missing.json'), CODEX_THREAD_ID: '', CLAUDE_CODE_MESSAGING_SOCKET: '' };
  await assert.rejects(execute(process.execPath, [script, 'whoami'], { env }), /Relay is not configured/);
  writeFileSync(env.RELAY_CONFIG, JSON.stringify({ version: 1, runtime: resolve('.'), home: root, defaultChannel: 'main' }));
  await assert.rejects(execute(process.execPath, [script, 'whoami'], { env }), /No native session/);
});

test('both marketplace packages are self-contained, discoverable and carry no session config', () => {
  const plugin = resolve('plugins/relay');
  for (const folder of ['.codex-plugin', '.claude-plugin']) {
    const manifest = JSON.parse(readFileSync(join(plugin, folder, 'plugin.json')));
    assert.equal(manifest.name, 'relay'); assert.equal(manifest.version, JSON.parse(readFileSync('package.json')).version);
    assert.equal(manifest.skills, './skills/');
    assert.equal(manifest.mcpServers, undefined);
  }
  const codex = JSON.parse(readFileSync('.agents/plugins/marketplace.json'));
  const claude = JSON.parse(readFileSync('.claude-plugin/marketplace.json'));
  assert.equal(resolve(codex.plugins[0].source.path), plugin);
  assert.equal(resolve(claude.plugins[0].source), plugin);
  const skill = readFileSync(join(plugin, 'skills/relay/SKILL.md'), 'utf8');
  assert.ok(!/\/Users\/[^/]+\//.test(skill));
  assert.match(skill, /Never redeem or trigger usage-reset credits/);
});
