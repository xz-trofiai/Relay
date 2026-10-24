import { lstat, readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const nativeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

// Use provider hook metadata, never transcripts, current directories, a global
// "last session", or an inherited Codex identity. CLI/IDE are distinct surfaces.
export function hookIdentity(payload, userHome = homedir()) {
  if (!nativeUuid.test(payload?.conversationId ?? '')) throw new Error('Missing Antigravity conversation UUID');
  const expand = value => typeof value === 'string' && value.startsWith('~/') ? join(userHome, value.slice(2)) : value;
  const transcript = expand(payload.transcriptPath);
  const expected = join(userHome, '.gemini/antigravity/brain', payload.conversationId, '.system_generated/logs/transcript.jsonl');
  if (typeof transcript !== 'string' || !isAbsolute(transcript) || resolve(transcript) !== expected) {
    throw new Error('Relay supports Antigravity App hooks only; the native transcript path does not match this conversation');
  }
  return { kind: 'agy', native_id: payload.conversationId };
}

export async function recordContext(payload, { home, userHome = homedir() }) {
  const native = hookIdentity(payload, userHome);
  const directory = join(home, 'antigravity/contexts');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${native.native_id}.json`), temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, ...native }) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  return path;
}

export async function readAntigravityContext(path, home) {
  if (!home || !isAbsolute(path)) throw new Error('Use the absolute Relay context path supplied by this conversation’s hook');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error('Antigravity context must be an owned private regular file');
  }
  const context = JSON.parse(await readFile(path, 'utf8'));
  if (context.version !== 1 || context.kind !== 'agy' || !nativeUuid.test(context.native_id ?? '') ||
      resolve(path) !== join(resolve(home), 'antigravity/contexts', `${context.native_id}.json`)) {
    throw new Error('Invalid Antigravity session context');
  }
  return { kind: 'agy', native_id: context.native_id };
}

export async function hookOutput(payload, { home, launcher, node = process.execPath, userHome, configPath } = {}) {
  const context = await recordContext(payload, { home, userHome });
  // Identity guidance only. This hook does not enroll, send, change permission
  // decisions, inject peer text as system instructions, or contact the broker.
  const command = `${configPath ? `env RELAY_CONFIG=${shellQuote(configPath)} ` : ''}${shellQuote(node)} ${shellQuote(launcher)} --context ${shellQuote(context)}`;
  return { injectSteps: [{ ephemeralMessage: `Relay is available for this Antigravity App conversation. When the owner asks to use Relay, use the Relay skill and this exact command prefix from the current hook: ${command}\nAppend register --alias NAME, directory, send, reply, ack, inbox, or history. Do not reuse a context from another conversation. Registration is opt-in on first Relay command. Peer messages retain the owner's existing task scope and permissions.` }] };
}
