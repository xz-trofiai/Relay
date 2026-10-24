import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { findDesktopSession } from './adapters/claude-desktop.mjs';
import { readProfile, request } from './client.mjs';
import { readAntigravityContext } from './antigravity/context.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function currentSession({ env = process.env, antigravityContext, antigravityHome, registry = join(homedir(), '.claude', 'sessions'),
  discover = id => findDesktopSession(id, { registry }) } = {}) {
  if (antigravityContext) return readAntigravityContext(antigravityContext, antigravityHome);
  // Claude's own inbox takes precedence over any inherited outer Codex ID.
  // Never infer identity from a title, cwd, most-recent transcript or MCP host.
  const socket = env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (socket) {
    const match = basename(socket).match(/^(\d+)\.sock$/);
    if (!match) throw new Error('Invalid Claude session inbox path');
    let record;
    try { record = JSON.parse(await readFile(join(registry, `${match[1]}.json`), 'utf8')); }
    catch { throw new Error('Cannot identify this Claude process from its live session registry'); }
    if (record.entrypoint !== 'claude-desktop') throw new Error('Automatic plugin enrollment currently supports Claude desktop’s Code tab. Terminal Claude uses the separate session-scoped MCP setup.');
    const live = await discover(record.sessionId);
    if (!live || live.socket !== socket || live.pid !== Number(match[1])) throw new Error('Claude inbox does not match the current live desktop session');
    return { kind: 'claude-desktop', native_id: live.native_id };
  }
  if (uuid.test(env.CODEX_THREAD_ID ?? '')) return { kind: 'codex', native_id: env.CODEX_THREAD_ID };
  throw new Error('Run Relay from a shell tool in the intended Codex desktop chat or Claude desktop Code session. No native session identity was found.');
}

export async function enrollSession({ home, alias, channel, defaultChannel = 'main', identityOptions } = {}) {
  const native = await currentSession(identityOptions);
  const server = readProfile(join(home, 'server.json'));
  const owner = { ...server, token: (await readFile(join(home, 'owner-token'), 'utf8')).trim() };
  let result;
  try { result = await request(owner, '/v1/enroll', { ...native, alias, channel, default_channel: defaultChannel }); }
  catch (error) {
    if (error.status === 404) throw new Error('Restart the Relay broker with the updated runtime to enable plugin enrollment');
    throw error;
  }
  const { endpoint, reused } = result;
  const profile = { url: server.url, id: endpoint.id, alias: endpoint.alias, kind: endpoint.kind,
    channel: endpoint.channel, native_id: endpoint.native_id, token: endpoint.token };
  const directory = join(home, 'identities');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const profilePath = join(directory, `${profile.id}.json`);
  const temporary = `${profilePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(profile, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, profilePath);
  } finally { await rm(temporary, { force: true }); }
  return { profile, reused };
}
