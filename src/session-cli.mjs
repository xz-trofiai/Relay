#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enrollSession } from './session.mjs';
import { request } from './client.mjs';
import { directory, formatDirectory } from './directory.mjs';

export async function sessionMain(args = process.argv.slice(2), { defaultHome, defaultChannel = 'main', identityOptions } = {}) {
  const options = Object.fromEntries(['home', 'alias', 'channel', 'to', 'body', 'body-file', 'key', 'message', 'thread', 'after']
    .map(name => [name, { type: 'string' }]));
  options.help = { type: 'boolean', short: 'h' };
  options.json = { type: 'boolean' };
  const { values, positionals } = parseArgs({ args, options, allowPositionals: true });
  const command = positionals[0];
  if (!command || values.help) {
    console.log(`Relay — uses this chat's identity automatically
register [--alias NAME] [--channel NAME]   Join once; repeated calls reuse registration
whoami                                   Show this chat's address
directory [--json]                        Show who this chat can message (table by default)
sessions                                 List registered recipients in this channel
send --to ALIAS --body-file FILE --key KEY
reply --message ID --body-file FILE --key KEY
ack --message ID
inbox
history [--thread ID] [--after SEQUENCE]

Returning sessions reuse their Relay address. Default channel: ${defaultChannel}.
For a new Claude desktop chat, use register --alias NAME. Codex and Antigravity can auto-enroll.
--body TEXT is also supported. Reuse a key only for an exact retry.
No profile paths, session IDs, or copied README instructions are needed.`);
    return;
  }
  if (!['register', 'whoami', 'directory', 'sessions', 'send', 'reply', 'ack', 'inbox', 'history'].includes(command) || positionals.length !== 1) {
    throw new Error('Unknown command; use --help');
  }
  const need = key => { if (!values[key]) throw new Error(`--${key} is required`); return values[key]; };
  let body;
  if (['send', 'reply'].includes(command)) {
    if (values.body !== undefined && values['body-file'] !== undefined) throw new Error('Choose --body or --body-file');
    body = values['body-file'] ? readFileSync(resolve(values['body-file']), 'utf8') : need('body');
    need('key'); need(command === 'send' ? 'to' : 'message');
  }
  if (command === 'ack') need('message');
  const home = values.home ?? defaultHome;
  if (!home) throw new Error('Relay installation has no configured state directory');
  const { profile, reused } = await enrollSession({ home, alias: values.alias, channel: values.channel, defaultChannel, identityOptions });
  let result;
  if (command === 'directory') {
    result = await directory(profile);
    console.log(values.json ? JSON.stringify(result, null, 2) : formatDirectory(result));
    return;
  }
  if (['register', 'whoami'].includes(command)) result = { id: profile.id, alias: profile.alias, channel: profile.channel, kind: profile.kind, reused };
  if (command === 'sessions') result = (await request(profile, '/v1/status')).sessions;
  if (command === 'send') result = await request(profile, '/v1/send', { recipient: values.to, body, idempotency_key: values.key });
  if (command === 'reply') result = await request(profile, `/v1/messages/${values.message}/reply`, { body, idempotency_key: values.key });
  if (command === 'ack') result = await request(profile, `/v1/messages/${values.message}/ack`, {});
  if (command === 'inbox') result = await request(profile, '/v1/inbox');
  if (command === 'history') {
    const query = new URLSearchParams({ after: values.after ?? '0' });
    if (values.thread) query.set('thread_id', values.thread);
    result = await request(profile, `/v1/history?${query}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  sessionMain().catch(error => { console.error(`Relay: ${error.message}`); process.exitCode = 1; });
}
