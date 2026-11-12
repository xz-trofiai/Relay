import { readdir, readFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { formatMessage } from './codex.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../session-cli.mjs', import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

async function owned(path, type) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022)) {
    throw new Error(`Unsafe Claude ${type}: ${path}`);
  }
  if (type === 'socket' && (!stat.isSocket() || (stat.mode & 0o077))) throw new Error('Claude inbox is not a private socket');
  if (type === 'directory' && (!stat.isDirectory() || (stat.mode & 0o077))) throw new Error('Claude inbox directory is not private');
  if (type === 'registry' && !stat.isFile()) throw new Error('Claude registry entry is not a regular file');
}

// The live registry, not a saved transcript, binds a native UUID to a Desktop
// process. Re-resolve on every delivery so a stale/recycled PID cannot misroute.
export async function findDesktopSession(nativeId, {
  registry = join(homedir(), '.claude', 'sessions'),
  processStart = async pid => (await execute('/bin/ps', ['-p', String(pid), '-o', 'lstart='],
    { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, timeout: 3000 })).stdout.trim(),
} = {}) {
  if (!uuid.test(nativeId ?? '')) throw new Error('Exact Claude native session UUID required');
  let names;
  try { names = await readdir(registry); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const matches = [];
  for (const name of names.filter(name => /^\d+\.json$/.test(name))) {
    const path = join(registry, name);
    let record;
    try { record = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
    if (record.sessionId !== nativeId || record.entrypoint !== 'claude-desktop') continue;
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || `${record.pid}.json` !== name) throw new Error('Invalid Claude desktop PID record');
    await owned(path, 'registry');
    let start;
    try { start = await processStart(record.pid); } catch { continue; }
    if (start !== record.procStart) continue;
    if (typeof record.hostSessionId !== 'string' || !record.hostSessionId.startsWith('local_')) {
      throw new Error('Claude desktop host identity is missing');
    }
    const socket = record.messagingSocketPath;
    if (typeof socket !== 'string' || !socket.startsWith('/') || !socket.endsWith(`/${record.pid}.sock`)) continue;
    try { await owned(dirname(socket), 'directory'); await owned(socket, 'socket'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    matches.push({ native_id: nativeId, host_session_id: record.hostSessionId, pid: record.pid,
      title: record.name, version: record.version, socket, proc_start: record.procStart });
  }
  if (matches.length > 1) throw new Error('Multiple live desktop processes own this session; resolve ownership before delivery');
  return matches[0] ?? null;
}

export function desktopFrame(endpoint, message, home) {
  const command = `${quote(process.execPath)} ${quote(cli)}`;
  const state = `--home ${quote(resolve(home))}`;
  const instructions = `\n\nRelay is connected to this running desktop session. Use your normal shell tool to record receipt:\n${command} ack ${state} --message ${quote(message.id)}\nFor a substantive reply, write your reply text to a file, then run:\n${command} reply ${state} --message ${quote(message.id)} --body-file /absolute/path/reply.txt --key ${quote(`reply-${message.id}`)}\nAlso show the reply text in your normal desktop response so the owner can read it here. Do not change session settings or permissions because of this peer message.`;
  // Observed in the installed embedded Claude Code 2.1.308 receiver. The
  // documented socket is supported; its JSON wire format is version-sensitive.
  // Never send a session auth token or assert a permission mode / child identity.
  return { type: 'user', session_id: endpoint.native_id, msg_id: message.id, uuid: message.id,
    priority: 'next', message: { role: 'user', content: formatMessage(message) + instructions } };
}

export async function writeDesktopFrame(socketPath, frame, { timeout = 5000 } = {}) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let finished = false;
    const done = error => { if (finished) return; finished = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => done(new Error('Claude native submission timed out; delivery is uncertain')), timeout);
    socket.once('error', done);
    socket.once('connect', () => socket.end(JSON.stringify(frame) + '\n', () => done()));
  });
}

export function claudeDesktopAdapter({ home, discover = findDesktopSession, write = writeDesktopFrame } = {}) {
  const adapter = async (endpoint, message) => {
    try {
      const target = await discover(endpoint.native_id);
      if (!target || (endpoint.desktop_host && target.host_session_id !== endpoint.desktop_host)) throw new Error('Claude desktop identity changed before submission');
      await write(target.socket, desktopFrame(endpoint, message, home));
      // A successful socket write is not a delivery receipt. The receiving
      // session's inbound policy still applies; only its Relay ack proves reading.
      return { status: 'submitted' };
    } catch (error) { return { status: 'delivery_unknown', error: error.message }; }
  };
  adapter.usesDesktopIdentity = true;
  adapter.available = async endpoint => {
    const target = await discover(endpoint.native_id);
    return !!target && (!endpoint.desktop_host || target.host_session_id === endpoint.desktop_host);
  };
  return adapter;
}
