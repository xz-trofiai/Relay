#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { startDaemon } from './daemon.mjs';
import { readProfile, request } from './client.mjs';
import { codexAdapter } from './adapters/codex.mjs';
import { claudeDesktopAdapter, findDesktopSession } from './adapters/claude-desktop.mjs';
import { directory, formatDirectory } from './directory.mjs';
import { codexBinary } from './provider-paths.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const options = Object.fromEntries(['home', 'port', 'channel', 'alias', 'kind', 'native-id', 'profile',
  'to', 'body', 'body-file', 'key', 'message', 'thread', 'after', 'endpoint', 'codex-binary', 'codex-remote']
  .map(name => [name, { type: 'string' }]));
options.help = { type: 'boolean', short: 'h' };
options.json = { type: 'boolean' };
options['confirm-redelivery'] = { type: 'boolean' };
const { values, positionals } = parseArgs({ options, allowPositionals: true });
const path = value => resolve(value.startsWith('~/') ? join(homedir(), value.slice(2)) : value);
const home = path(values.home ?? process.env.RELAY_HOME ?? join(root, '.relay'));
const print = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
const need = (key, fallback) => {
  const value = values[key] ?? fallback;
  if (!value) throw new Error(`--${key} is required`);
  return value;
};
const owner = () => ({ ...readProfile(join(home, 'server.json')), token: readFileSync(join(home, 'owner-token'), 'utf8').trim() });
const identity = async () => {
  const profile = readProfile(path(need('profile', process.env.RELAY_PROFILE)));
  if (profile.kind === 'codex' && process.env.CODEX_THREAD_ID && profile.native_id !== process.env.CODEX_THREAD_ID) {
    throw new Error('This profile belongs to a different Codex thread; use the current session identity');
  }
  if (profile.kind === 'claude-desktop') {
    const current = await findDesktopSession(profile.native_id);
    if (!current || process.env.CLAUDE_CODE_MESSAGING_SOCKET !== current.socket) {
      throw new Error('Use this Claude desktop profile only from a shell tool in its enrolled desktop session');
    }
  }
  return profile;
};
const body = () => {
  if (values.body && values['body-file']) throw new Error('Choose --body or --body-file');
  return values['body-file'] ? readFileSync(path(values['body-file']), 'utf8') : need('body');
};

async function main() {
  const command = positionals[0];
  if (!command || values.help) {
    console.log(`Local Agent Relay — plain-text channels for registered sessions

serve       [--home DIR] [--port 9231] [--codex-binary PATH] [--codex-remote URL]
stop        [--home DIR]         Stop this Relay daemon; preserve messages
register    --alias NAME --kind codex|claude|claude-desktop|agy|manual [--native-id UUID] [--channel NAME]
bind-claude-desktop --profile FILE  Bind an existing Claude identity to its live desktop process
desktop-session --native-id UUID   Inspect the exact live desktop recipient
status      [--home DIR]
directory   --profile FILE [--json]  Show this session's channel directory
send        --profile FILE --to ALIAS --body TEXT [--key KEY]
reply       --profile FILE --message ID --body TEXT [--key KEY]
ack         --profile FILE --message ID
inbox       --profile FILE
history     [--profile FILE | --channel NAME] [--thread ID] [--after SEQUENCE]
export      [--profile FILE | --channel NAME] [--thread ID]
config      --profile FILE       Print session-scoped MCP configuration
pause       --endpoint ID
unpause     --endpoint ID        Only after the underlying blocker is resolved
requeue     --message ID --confirm-redelivery

Use --body-file FILE for long content. RELAY_HOME and RELAY_PROFILE are supported.
All members can read their channel. Only the explicit recipient is notified.
No encryption or TLS. State and credentials are local plain text.
No usage-reset-credit operation is implemented.`);
    return;
  }
  if (command === 'serve') {
    const port = Number(values.port ?? 9231);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
    const daemon = await startDaemon({ home, port, adapters: { codex: codexAdapter({
      binary: codexBinary(values['codex-binary']), remote: values['codex-remote'],
    }), 'claude-desktop': claudeDesktopAdapter({ home }) } });
    console.error(`Relay listening at ${daemon.url}; plain-text state: ${home}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      void daemon.close().then(() => process.exit(0));
    });
    return;
  }
  if (command === 'desktop-session') { print(await findDesktopSession(need('native-id'))); return; }
  if (command === 'bind-claude-desktop') {
    const profilePath = path(need('profile'));
    const profile = readProfile(profilePath);
    const result = await request(owner(), '/v1/bind-claude-desktop', { endpoint_id: profile.id, native_id: profile.native_id });
    writeFileSync(profilePath, JSON.stringify({ ...profile, kind: 'claude-desktop' }, null, 2) + '\n', { mode: 0o600 });
    print(result); return;
  }
  if (command === 'register') {
    const kind = need('kind');
    const native_id = values['native-id'] ?? (kind === 'codex' ? process.env.CODEX_THREAD_ID : null);
    const endpoint = await request(owner(), '/v1/register', { alias: need('alias'), kind, native_id,
      channel: values.channel ?? 'general' });
    const directory = join(home, 'identities'); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const profilePath = join(directory, `${endpoint.id}.json`);
    writeFileSync(profilePath, JSON.stringify({ url: owner().url, id: endpoint.id, alias: endpoint.alias,
      kind: endpoint.kind, channel: endpoint.channel, native_id: endpoint.native_id, token: endpoint.token }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    print({ endpoint: endpoint.id, alias: endpoint.alias, channel: endpoint.channel, profile: profilePath }); return;
  }
  if (command === 'config') {
    const profilePath = path(need('profile', process.env.RELAY_PROFILE));
    readProfile(profilePath);
    print({ mcpServers: { relay: { command: process.execPath, args: [join(root, 'src/mcp.mjs'), profilePath] } } }); return;
  }
  if (command === 'stop') {
    await request(owner(), '/v1/status');
    const pid = Number(readFileSync(join(home, 'daemon.lock'), 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid daemon PID');
    process.kill(pid, 'SIGTERM'); print({ stopping: pid }); return;
  }
  if (command === 'status') { print(await request(owner(), '/v1/status')); return; }
  if (command === 'directory') {
    const result = await directory(await identity());
    if (values.json) print(result); else console.log(formatDirectory(result));
    return;
  }
  if (command === 'pause' || command === 'unpause') {
    print(await request(owner(), '/v1/pause', { endpoint_id: need('endpoint'), paused: command === 'pause' })); return;
  }
  if (command === 'requeue') {
    if (!values['confirm-redelivery']) throw new Error('Requeue can repeat already delivered content. Inspect history, then use --confirm-redelivery.');
    print(await request(owner(), `/v1/messages/${need('message')}/requeue`, {})); return;
  }
  if (command === 'send' || command === 'reply') {
    const url = command === 'send' ? '/v1/send' : `/v1/messages/${need('message')}/reply`;
    print(await request(await identity(), url, { recipient: command === 'send' ? need('to') : undefined,
      body: body(), idempotency_key: values.key ?? randomUUID() })); return;
  }
  if (command === 'ack') { print(await request(await identity(), `/v1/messages/${need('message')}/ack`, {})); return; }
  if (command === 'inbox') { print(await request(await identity(), '/v1/inbox')); return; }
  if (command === 'history' || command === 'export') {
    const profile = values.profile || process.env.RELAY_PROFILE ? await identity() : owner();
    let after = Number(values.after ?? 0);
    const collected = [];
    do {
      const query = new URLSearchParams({ channel: values.channel ?? 'general', after: String(after) });
      if (values.thread) query.set('thread_id', values.thread);
      const rows = await request(profile, `/v1/history?${query}`);
      collected.push(...rows);
      if (command !== 'export' || rows.length < 100) break;
      after = rows.at(-1).seq;
    } while (true);
    if (command === 'history') print(collected);
    else {
      console.log('# Relay channel transcript\n');
      for (const message of collected) console.log(`## ${message.created_at} — ${message.sender_alias} → ${message.recipient_alias}\n\nMessage: ${message.id}  \nThread: ${message.thread_id}  \nStatus: ${message.status}\n\n${message.body}\n`);
    }
    return;
  }
  throw new Error(`Unknown command: ${command}; use --help`);
}
main().catch(error => { console.error(`Relay: ${error.message}`); process.exitCode = 1; });
