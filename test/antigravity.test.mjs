import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, chmodSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startDaemon } from '../src/daemon.mjs';
import { currentSession } from '../src/session.mjs';
import { hookIdentity, recordContext, readAntigravityContext } from '../src/antigravity/context.mjs';
import { createSidecar, nativeAgentApi } from '../src/antigravity/sidecar.mjs';
import { antigravityAdapter } from '../src/adapters/antigravity.mjs';
import { request } from '../src/client.mjs';
import { installAntigravity } from '../scripts/install-antigravity.mjs';

const execute = promisify(execFile), directories = [];
after(() => { for (const path of directories) rmSync(path, { recursive: true, force: true }); });
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'relay-agy-')); directories.push(path); return path; };
const payload = (id = randomUUID(), surface = 'antigravity') => ({ conversationId: id,
  transcriptPath: join(homedir(), '.gemini', surface, 'brain', id, '.system_generated/logs/transcript.jsonl') });
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const shell = (command, input = '', env = process.env) => new Promise((resolve, reject) => {
  const child = spawn('/bin/sh', ['-c', command], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', code => code ? reject(new Error(stderr)) : resolve({ stdout, stderr }));
  child.stdin.end(input);
});
async function daemonFor(t, home = temporary(), adapters = {}) {
  const daemon = await startDaemon({ home, port: 0, adapters, interval: 60000 });
  t.after(() => daemon.close());
  return { ...daemon, home, owner: { url: daemon.url, token: daemon.ownerToken } };
}
const enroll = (store, alias, kind = 'agy', channel = 'main') => store.enroll({ alias, kind, channel, native_id: randomUUID() }).endpoint;
const send = (store, from, to, body = 'Hello') => store.send(from.id, { recipient: to.alias, body, idempotency_key: randomUUID() });

test('App hook contexts remain isolated and reject other surfaces and unsafe context files', async () => {
  const home = temporary(), a = payload(), b = payload();
  assert.deepEqual(hookIdentity(a), { kind: 'agy', native_id: a.conversationId });
  assert.throws(() => hookIdentity({ ...a, conversationId: 'a title' }), /UUID/);
  for (const surface of ['antigravity-cli', 'antigravity-ide']) assert.throws(() => hookIdentity(payload(a.conversationId, surface)), /App hooks only/);
  assert.throws(() => hookIdentity({ ...a, conversationId: b.conversationId }), /does not match/);
  const paths = await Promise.all([a, b].map(data => recordContext(data, { home })));
  assert.notEqual(paths[0], paths[1]);
  for (let i = 0; i < 2; i++) {
    const native = await currentSession({ antigravityContext: paths[i], antigravityHome: home,
      env: { CODEX_THREAD_ID: randomUUID(), CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/irrelevant.sock' } });
    assert.equal(native.native_id, [a, b][i].conversationId); assert.equal(native.kind, 'agy');
  }
  chmodSync(paths[0], 0o644);
  await assert.rejects(readAntigravityContext(paths[0], home), /private regular/);
  await recordContext(a, { home });
  const link = join(home, 'link.json'); symlinkSync(paths[0], link);
  await assert.rejects(readAntigravityContext(link, home), /private regular/);
  writeFileSync(paths[0], JSON.stringify({ version: 1, kind: 'agy', native_id: b.conversationId }));
  await assert.rejects(readAntigravityContext(paths[0], home), /Invalid Antigravity/);
});

test('installed App hook + plugin + sidecar complete an isolated three-provider exchange', async t => {
  const root = temporary(), home = join(root, 'state'), config = join(root, "config with ' spaces.json");
  const provider = join(root, "provider with ' spaces"); mkdirSync(provider);
  writeFileSync(join(provider, 'config.json'), JSON.stringify({ other: { preserve: true }, sidecars: { unrelated: { enabled: false } } }));
  const received = [];
  const daemon = await daemonFor(t, home, {
    codex: async (ep, message) => { received.push({ ep, message }); return { status: 'submitted' }; },
    'claude-desktop': async (ep, message) => { received.push({ ep, message }); return { status: 'submitted' }; },
  });
  await execute(process.execPath, [resolve('scripts/install-plugins.mjs'), '--target', 'antigravity',
    '--config', config, '--home', home, '--antigravity-config-dir', provider]);
  const plugin = join(provider, 'plugins/relay');
  const settings = json(join(provider, 'config.json'));
  assert.deepEqual(settings.other, { preserve: true }); assert.equal(settings.sidecars.unrelated.enabled, false);
  assert.equal(settings.sidecars['relay/bridge'].enabled, true);
  const sidecarSpec = json(join(plugin, 'sidecars/bridge/sidecar.json'));
  assert.equal(sidecarSpec.command, process.execPath); assert.equal(sidecarSpec.env.RELAY_CONFIG, config);
  const command = json(join(plugin, 'hooks.json'))['relay-session-context'].PreInvocation[0].command;
  const contexts = [payload(), payload()];
  const prefixes = [];
  for (const data of contexts) {
    const output = JSON.parse((await shell(command, JSON.stringify(data))).stdout);
    prefixes.push(output.injectSteps[0].ephemeralMessage.split('current hook: ')[1].split('\n')[0]);
  }
  assert.equal(daemon.store.sessions().length, 0, 'hooks do not opt conversations in');
  const run = async (index, args) => {
    const result = await shell(`${prefixes[index]} ${args}`, '', { ...process.env, CODEX_THREAD_ID: randomUUID(), RELAY_CONFIG: '/nonexistent-inherited-config' });
    assert.ok(!result.stdout.includes('"token"'));
    return JSON.parse(result.stdout);
  };
  const first = await run(0, 'register --alias research-agy'), second = await run(1, 'whoami');
  assert.equal(first.kind, 'agy'); assert.equal(second.alias, `agy-${contexts[1].conversationId}`);
  assert.equal((await run(0, 'whoami')).id, first.id);
  await assert.rejects(run(1, 'register --alias research-agy'), /already registered/);
  const codex = enroll(daemon.store, 'core', 'codex'), claude = enroll(daemon.store, 'website', 'claude-desktop');
  enroll(daemon.store, 'private', 'agy', 'private-channel');
  const listed = await run(0, 'directory --json');
  assert.equal(listed.sessions.length, 4); assert.equal(listed.current_session.id, first.id);
  assert.equal(listed.current_session.title, null);
  const literal = "Question with 'quotes', `false`, $(touch /tmp/relay-no-execute)\nand a newline.";
  const question = send(daemon.store, codex, first, literal);
  await daemon.tick(); assert.equal(daemon.store.message(question.id).status, 'queued');
  const bin = join(root, 'bin'), captured = join(root, 'agentapi.jsonl'); mkdirSync(bin);
  writeFileSync(join(bin, 'agentapi'), `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(captured)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o700 });
  const nativeEnv = { ANTIGRAVITY_EXECUTABLE_DATA_DIR: join(root, 'sidecar-data'), PATH: bin };
  const sidecar = await createSidecar({ home, env: nativeEnv });
  t.after(() => sidecar.close());
  await sidecar.tick();
  assert.equal(daemon.store.message(question.id).status, 'submitted');
  const argv = JSON.parse(readFileSync(captured, 'utf8').trim());
  assert.equal(argv[0], 'send-message'); assert.equal(argv[1], contexts[0].conversationId); assert.ok(argv[2].endsWith(literal));
  assert.equal((await run(1, 'inbox')).length, 0, 'another Antigravity session gets no addressed mail');
  await assert.rejects(run(1, `ack --message ${question.id}`), /Only the recipient/);
  await run(0, `ack --message ${question.id}`);
  const reply = await run(0, `reply --message ${question.id} --body Answer --key reply-1`);
  assert.equal(reply.thread_id, question.thread_id); assert.equal(reply.recipient, codex.id);
  const toClaude = await run(0, 'send --to website --body Follow-up --key next-1');
  await daemon.tick();
  assert.deepEqual(received.map(x => x.ep.kind).sort(), ['claude-desktop', 'codex']);
  assert.equal(daemon.store.message(toClaude.id).status, 'submitted');
  assert.equal(daemon.store.message(question.id).status, 'acknowledged');
  assert.equal(daemon.store.history('main').length, 3, 'receipts do not send messages');
  await sidecar.tick(); assert.equal(readFileSync(captured, 'utf8').trim().split('\n').length, 1);
  const invalidHook = JSON.parse((await shell(command, JSON.stringify(payload(randomUUID(), 'antigravity-cli')))).stdout);
  assert.deepEqual(invalidHook, {});
  await assert.rejects(execute(process.execPath, [join(plugin, 'scripts/relay.mjs'), 'whoami']), /--context/);
});

test('native adapter keeps literal argv, rejects invented IDs, and distinguishes usage blocks and uncertainty', async () => {
  const endpoint = { kind: 'agy', native_id: randomUUID() }, message = { body: 'literal $(no)\n`false`' };
  let captured;
  const ok = antigravityAdapter({ execute: (binary, args, options, callback) => { captured = { binary, args, options }; callback(null, '', ''); } });
  assert.equal((await ok(endpoint, message)).status, 'submitted');
  assert.equal(captured.binary, 'agentapi'); assert.equal(captured.args[0], 'send-message'); assert.equal(captured.args[1], endpoint.native_id);
  assert.ok(captured.args[2].endsWith(message.body)); assert.equal(captured.options.shell, undefined);
  await assert.rejects(ok({ ...endpoint, native_id: 'a title' }, message), /UUID/);
  for (const [error, status] of [['Quota exceeded', 'blocked_usage'], ['Timeout: receipt lost', 'delivery_unknown']]) {
    const failed = antigravityAdapter({ execute: (b, a, o, cb) => cb(new Error(error), '', '') });
    assert.equal((await failed(endpoint, message)).status, status);
  }
  await assert.rejects(nativeAgentApi({ PATH: '/usr/bin' }), /App sidecar/);
  await assert.rejects(nativeAgentApi({ PATH: '', ANTIGRAVITY_EXECUTABLE_DATA_DIR: '/tmp/sidecar' }), /did not provide agentapi/);
});

test('sidecar endpoints are owner-only, exclusive, and cannot claim Codex or Claude deliveries', async t => {
  const daemon = await daemonFor(t), a = enroll(daemon.store, 'a'), b = enroll(daemon.store, 'b', 'codex');
  const member = { url: daemon.url, token: a.token };
  await assert.rejects(request(member, '/v1/antigravity/pull', { endpoint_id: a.id, instance: 'x' }), /Owner credential/);
  await assert.rejects(request(daemon.owner, '/v1/antigravity/pull', { endpoint_id: b.id, instance: 'x' }), /Not an Antigravity/);
  await assert.rejects(request(member, '/v1/bridge/pull', { instance: 'x' }), /not a Claude/);
  const first = send(daemon.store, b, a), second = send(daemon.store, b, a);
  let release, calls = 0, notify;
  const entered = new Promise(resolve => { notify = resolve; });
  const slow = await createSidecar({ home: daemon.home, adapter: async () => { calls++; notify(); await new Promise(resolve => { release = resolve; }); return { status: 'submitted' }; } });
  const other = await createSidecar({ home: daemon.home, adapter: async () => { calls++; return { status: 'submitted' }; } });
  t.after(() => slow.close()); t.after(() => other.close());
  const active = slow.tick(); await entered;
  await other.tick(); assert.equal(calls, 1);
  // Even a lease expiring during a slow command cannot start overlapping delivery.
  daemon.store.db.prepare('UPDATE endpoints SET bridge_until=0 WHERE id=?').run(a.id);
  await other.tick(); assert.equal(calls, 1); assert.equal(daemon.store.message(second.id).status, 'queued');
  release(); await active;
  await other.tick(); assert.equal(calls, 2); assert.equal(daemon.store.message(first.id).status, 'submitted');
});

test('sidecar preserves late acknowledgments, pauses quota failures, and does not retry unknown delivery', async t => {
  const daemon = await daemonFor(t), a = enroll(daemon.store, 'a'), b = enroll(daemon.store, 'b', 'codex');
  let calls = 0;
  const sidecar = await createSidecar({ home: daemon.home, adapter: async (ep, message) => {
    calls++;
    if (calls === 1) { daemon.store.ack(ep.id, message.id); return { status: 'submitted' }; }
    if (calls === 2) return { status: 'delivery_unknown', error: 'Timed out after sending' };
    return { status: 'blocked_usage', error: 'Allowance exhausted' };
  } });
  t.after(() => sidecar.close());
  const first = send(daemon.store, b, a); await sidecar.tick(); assert.equal(daemon.store.message(first.id).status, 'acknowledged');
  const unknown = send(daemon.store, b, a); await sidecar.tick(); await sidecar.tick(); assert.equal(calls, 2);
  assert.equal(daemon.store.message(unknown.id).status, 'delivery_unknown');
  const quota = send(daemon.store, b, a); await sidecar.tick();
  assert.equal(daemon.store.message(quota.id).status, 'blocked_usage'); assert.equal(daemon.store.endpoint(a.id).paused, 1);
  const waiting = send(daemon.store, b, a); await sidecar.tick(); assert.equal(daemon.store.message(waiting.id).status, 'queued');
  assert.equal(calls, 3);
});

test('Antigravity installer preserves settings and backs up managed upgrades but refuses foreign plugins', () => {
  const directory = temporary(), options = { root: resolve('.'), configPath: join(directory, 'relay.json'), configDirectory: directory };
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ sidecars: { 'relay/bridge': { projectId: 'keep' }, another: { enabled: true } }, other: 42 }));
  const installed = installAntigravity(options);
  installAntigravity(options);
  const settings = json(join(directory, 'config.json'));
  assert.equal(settings.other, 42); assert.equal(settings.sidecars['relay/bridge'].projectId, 'keep');
  assert.equal(settings.sidecars.another.enabled, true);
  assert.ok(readdirSync(join(directory, 'relay-backups')).some(name => name.startsWith('plugin-')));
  rmSync(join(installed, '.relay-installation.json'));
  writeFileSync(join(installed, 'custom.txt'), 'keep');
  assert.throws(() => installAntigravity(options), /unmanaged plugin/);
  assert.equal(readFileSync(join(installed, 'custom.txt'), 'utf8'), 'keep');
});

test('broker restart recovers a lost sidecar submission without replay and resumes queued mail', async t => {
  const home = temporary();
  let daemon = await startDaemon({ home, port: 0, adapters: {}, interval: 60000 });
  t.after(() => daemon.close());
  const a = enroll(daemon.store, 'a'), b = enroll(daemon.store, 'b', 'codex');
  const uncertain = send(daemon.store, b, a), waiting = send(daemon.store, b, a);
  const owner = { url: daemon.url, token: daemon.ownerToken };
  const pulled = await request(owner, '/v1/antigravity/pull', { endpoint_id: a.id, instance: 'lost-sidecar' });
  assert.equal(pulled.delivery.message.id, uncertain.id);
  // Simulate process loss after native submission but before a broker receipt.
  await daemon.close();
  daemon = await startDaemon({ home, port: 0, adapters: {}, interval: 60000 });
  assert.equal(daemon.store.message(uncertain.id).status, 'delivery_unknown');
  const received = [];
  const sidecar = await createSidecar({ home, adapter: async (ep, message) => { received.push(message.id); return { status: 'submitted' }; } });
  t.after(() => sidecar.close());
  await sidecar.tick(); await sidecar.tick();
  assert.deepEqual(received, [waiting.id]);
  assert.equal(daemon.store.message(uncertain.id).attempts, 1);
  assert.equal(daemon.store.message(waiting.id).status, 'submitted');
});
