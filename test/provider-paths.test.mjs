import test from 'node:test';
import assert from 'node:assert/strict';
import { codexBinary } from '../src/provider-paths.mjs';

test('Codex executable discovery respects overrides and falls back without installed desktop apps', () => {
  assert.equal(codexBinary('/custom/codex', () => { throw new Error('Must not inspect applications'); }), '/custom/codex');
  assert.equal(codexBinary(undefined, () => false), 'codex');
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  assert.equal(codexBinary(undefined, path => path === bundled), bundled);
});
