import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTitleResolver } from '../src/session-titles.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'relay-titles-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const codexHome = join(root, 'codex'), claudeRegistry = join(root, 'claude');
  mkdirSync(codexHome); mkdirSync(claudeRegistry);
  return { codexHome, claudeRegistry, resolve: createTitleResolver({ codexHome, claudeRegistry,
    processStart: async () => 'current-start' }) };
}
const endpoint = kind => ({ id: randomUUID(), kind, native_id: randomUUID() });

test('Codex titles use exact native names, refresh renames, and never expose the first-prompt title field', async t => {
  const f = fixture(t), first = endpoint('codex'), second = endpoint('codex');
  const db = new DatabaseSync(join(f.codexHome, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT)');
  db.prepare('INSERT INTO threads VALUES (?,?,?)').run(first.native_id, 'Actual chat title', 'PRIVATE FIRST PROMPT');
  db.prepare('INSERT INTO threads VALUES (?,?,?)').run(second.native_id, null, 'ANOTHER PRIVATE PROMPT');
  writeFileSync(join(f.codexHome, 'session_index.jsonl'), JSON.stringify({ id: second.native_id, thread_name: 'Old cleared name' }) + '\n');
  let result = await f.resolve([first, second]);
  assert.equal(result.get(first.id).title, 'Actual chat title');
  assert.equal(result.get(first.id).title_source, 'codex-state');
  assert.equal(result.get(second.id).title, null);
  db.prepare('UPDATE threads SET name=? WHERE id=?').run('Renamed ✓', first.native_id);
  result = await f.resolve([first]);
  assert.equal(result.get(first.id).title, 'Renamed ✓');
  assert.equal(db.prepare('SELECT title FROM threads WHERE id=?').get(first.native_id).title, 'PRIVATE FIRST PROMPT');
  db.close();
});

test('Codex index fallback uses the latest exact-ID rename; unavailable metadata stays explicit', async t => {
  const f = fixture(t), first = endpoint('codex'), missing = endpoint('codex');
  const db = new DatabaseSync(join(f.codexHome, 'state_9.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO threads VALUES (?,?)').run(first.native_id, 'DO NOT USE AS CHAT NAME');
  db.close();
  writeFileSync(join(f.codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: first.native_id, thread_name: 'Old' }), 'malformed',
    JSON.stringify({ id: missing.native_id + '-suffix', thread_name: 'Wrong session' }),
    JSON.stringify({ id: first.native_id, thread_name: 'Latest name' }),
  ].join('\n'));
  const result = await f.resolve([first, missing, endpoint('manual')]);
  assert.equal(result.get(first.id).title, 'Latest name');
  assert.equal(result.get(first.id).title_source, 'codex-name-index');
  assert.equal(result.get(missing.id).title, null);
  rmSync(f.codexHome, { recursive: true });
  assert.equal((await f.resolve([first])).get(first.id).title, null);
});

test('Claude titles select the exact live surface, refresh names, and reject stale or ambiguous ownership', async t => {
  const f = fixture(t), desktop = endpoint('claude-desktop');
  const cli = { ...endpoint('claude'), native_id: desktop.native_id };
  const add = (pid, entrypoint, name, extra = {}) => writeFileSync(join(f.claudeRegistry, `${pid}.json`), JSON.stringify({
    pid, entrypoint, name, sessionId: desktop.native_id, procStart: 'current-start', ...extra,
  }), { mode: 0o600 });
  add(1001, 'claude-desktop', 'Website review');
  add(1002, 'cli', 'A different CLI copy');
  add(1003, 'claude-desktop', 'Stale desktop', { procStart: 'recycled-pid' });
  let result = await f.resolve([desktop, cli]);
  assert.equal(result.get(desktop.id).title, 'Website review');
  assert.equal(result.get(cli.id).title, 'A different CLI copy');
  add(1001, 'claude-desktop', 'Renamed desktop');
  assert.equal((await f.resolve([desktop])).get(desktop.id).title, 'Renamed desktop');
  add(1004, 'claude-desktop', 'Second live owner');
  assert.equal((await f.resolve([desktop])).get(desktop.id).title, null);
  rmSync(join(f.claudeRegistry, '1001.json')); rmSync(join(f.claudeRegistry, '1004.json'));
  assert.equal((await f.resolve([desktop])).get(desktop.id).title, null);
});
