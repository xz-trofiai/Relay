// Provider metadata only. Chat titles, paths to projects and transcript contents
// never establish continuity. Anonymous/disagreeing observations cannot move mail.
import { readdir, readFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findDesktopSession } from './adapters/claude-desktop.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
async function trusted(path, directory) {
  const s = await lstat(path);
  if (!(directory ? s.isDirectory() : s.isFile()) || s.uid !== process.getuid() || (s.mode & 0o022)) {
    throw new Error('Unsafe Claude desktop metadata; owner review required');
  }
}

async function directories(path) {
  await trusted(path, true);
  return (await readdir(path, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => join(path, d.name));
}

// Claude stores the host record at <account>/<workspace>/local_<UUID>.json.
// A missing record is compatible with exact-native use, never a rotation.
export async function desktopLineage(root, host, current) {
  if (!host?.startsWith('local_') || !uuid.test(host.slice(6))) throw new Error('Unknown desktop host ID format');
  let accounts;
  try { accounts = await directories(root); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const matches = [];
  for (const account of accounts) for (const workspace of await directories(account)) {
    const file = join(workspace, host + '.json');
    try { await trusted(workspace, true); await trusted(file, false); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    let record;
    try { record = JSON.parse(await readFile(file, 'utf8')); } catch { throw new Error('Unreadable Claude host record'); }
    const { sessionId, cliSessionId, priorCliSessionIds = [] } = record ?? {};
    if (sessionId !== host || cliSessionId !== current || !Array.isArray(priorCliSessionIds) ||
        !priorCliSessionIds.every(id => typeof id === 'string' && uuid.test(id) && id !== current)) {
      throw new Error('Claude host record disagrees with live registry; owner review required');
    }
    matches.push([...new Set(priorCliSessionIds)]);
  }
  if (matches.length > 1) throw new Error('Ambiguous Claude host record; owner review required');
  return matches[0] ?? null;
}

export async function observeDesktops({
  registry = join(homedir(), '.claude', 'sessions'),
  root = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
  discover = id => findDesktopSession(id, { registry }),
} = {}) {
  let files;
  try { files = await readdir(registry); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const ids = new Set();
  for (const file of files.filter(n => /^\d+\.json$/.test(n))) {
    let row;
    try { row = JSON.parse(await readFile(join(registry, file), 'utf8')); } catch { continue; }
    if (row.entrypoint === 'claude-desktop' && uuid.test(row.sessionId)) ids.add(row.sessionId);
  }
  const rows = [];
  for (const native of ids) {
    let host;
    try {
      const live = await discover(native);
      if (!live) continue;
      host = live.host_session_id;
      rows.push({ native, host, prior: await desktopLineage(root, host, native) });
    } catch (e) { rows.push({ native, host, prior: null, error: e.message }); }
  }
  // Two live processes must never inherit one identity, even when both look valid separately.
  for (const row of rows) {
    const ids = new Set([row.native, ...(row.prior ?? [])]);
    if (rows.some(other => other !== row && (row.host === other.host ||
      [other.native, ...(other.prior ?? [])].some(id => ids.has(id))))) row.error = 'Overlapping live Claude chats; owner review required';
  }
  return rows;
}
