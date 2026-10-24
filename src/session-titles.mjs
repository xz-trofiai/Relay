import { DatabaseSync } from 'node:sqlite';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const titleValue = value => typeof value === 'string' && value.trim() ? value : null;

async function codexTitles(ids, home) {
  const result = new Map(), pending = new Set(ids);
  // The desktop installation has no default app-server control socket. Read
  // only the native `name` field; `title` can contain the whole first prompt.
  // Inspect the schema instead of assuming every installed DB version has it.
  for (const folder of [home, join(home, 'sqlite')]) {
    if (!pending.size) break;
    let files;
    try { files = (await readdir(folder)).filter(name => /^state_\d+\.sqlite$/.test(name)); }
    catch { continue; }
    files.sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    for (const file of files) {
      let db;
      try {
        db = new DatabaseSync(join(folder, file), { readOnly: true });
        db.exec('PRAGMA busy_timeout=100');
        const columns = db.prepare('PRAGMA table_info(threads)').all().map(row => row.name);
        if (!columns.includes('id') || !columns.includes('name')) continue;
        const query = db.prepare('SELECT name FROM threads WHERE id=?');
        for (const id of pending) {
          const row = query.get(id);
          if (!row) continue;
          result.set(id, { title: titleValue(row.name), title_source: 'codex-state' });
          pending.delete(id); // An explicitly empty name must not revive an old rename.
        }
      } catch { /* Missing/locked/incompatible metadata must not break the directory. */ }
      finally { db?.close(); }
    }
  }
  if (pending.size) {
    // Compatibility fallback: this is the provider's append-only name index,
    // not conversation content. Process every matching rename, including clears.
    const stream = createReadStream(join(home, 'session_index.jsonl'), { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (pending.has(row.id) && Object.hasOwn(row, 'thread_name')) {
          result.set(row.id, { title: titleValue(row.thread_name), title_source: 'codex-name-index' });
        }
      }
    } catch { /* No saved name available. */ }
    finally { lines.close(); stream.destroy(); }
  }
  return result;
}

async function claudeTitles(endpoints, registry, processStart) {
  const result = new Map();
  let files;
  try { files = (await readdir(registry)).filter(name => /^\d+\.json$/.test(name)); }
  catch { return result; }
  const matches = new Map();
  for (const file of files) {
    try {
      const path = join(registry, file);
      const row = JSON.parse(await readFile(path, 'utf8'));
      const targets = endpoints.filter(endpoint => endpoint.native_id === row.sessionId &&
        row.entrypoint === (endpoint.kind === 'claude-desktop' ? 'claude-desktop' : 'cli'));
      if (!targets.length) continue;
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022) ||
          !Number.isSafeInteger(row.pid) || row.pid <= 0 || `${row.pid}.json` !== file) continue;
      if (await processStart(row.pid) !== row.procStart) continue;
      for (const endpoint of targets) {
        const values = matches.get(endpoint.id) ?? [];
        values.push(titleValue(row.name)); matches.set(endpoint.id, values);
      }
    } catch { /* Stale processes, malformed registry rows and metadata errors are unavailable. */ }
  }
  for (const [id, values] of matches) {
    // More than one live owner is ambiguous even if one has a convenient name.
    if (values.length === 1) result.set(id, { title: values[0], title_source: 'claude-live-registry' });
  }
  return result;
}

export function createTitleResolver({ codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  claudeRegistry = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'sessions'),
  processStart = async pid => (await execute('/bin/ps', ['-p', String(pid), '-o', 'lstart='],
    { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, timeout: 1000 })).stdout.trim(),
} = {}) {
  return async endpoints => {
    const valid = endpoints.filter(endpoint => uuid.test(endpoint.native_id ?? ''));
    const codex = valid.filter(endpoint => endpoint.kind === 'codex');
    const claude = valid.filter(endpoint => ['claude', 'claude-desktop'].includes(endpoint.kind));
    const [codexResult, claudeResult] = await Promise.all([
      codex.length ? codexTitles(codex.map(endpoint => endpoint.native_id), codexHome) : new Map(),
      claude.length ? claudeTitles(claude, claudeRegistry, processStart) : new Map(),
    ]);
    return new Map(endpoints.map(endpoint => {
      const found = endpoint.kind === 'codex' ? codexResult.get(endpoint.native_id) : claudeResult.get(endpoint.id);
      return [endpoint.id, found?.title ? found : { title: null, title_source: null }];
    }));
  };
}
