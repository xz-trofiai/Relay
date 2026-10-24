import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { shellQuote } from '../src/antigravity/context.mjs';

export function installAntigravity({ root, configPath, configDirectory, node = process.execPath }) {
  const directory = resolve(configDirectory), destination = join(directory, 'plugins/relay');
  const markerName = '.relay-installation.json';
  if (existsSync(destination)) {
    let marker;
    try { marker = JSON.parse(readFileSync(join(destination, markerName), 'utf8')); } catch { /* Unmanaged plugin. */ }
    if (marker?.managedBy !== 'agent-relay') throw new Error(`Refusing to replace an unmanaged plugin at ${destination}`);
  }
  const settingsPath = join(directory, 'config.json');
  const previous = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : null;
  const settings = previous === null ? {} : JSON.parse(previous);
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(settings) || (settings.sidecars !== undefined && !object(settings.sidecars)) ||
      (settings.sidecars?.['relay/bridge'] !== undefined && !object(settings.sidecars['relay/bridge']))) throw new Error('Invalid Antigravity sidecar settings');
  settings.sidecars = { ...settings.sidecars, 'relay/bridge': { ...settings.sidecars?.['relay/bridge'], enabled: true } };
  const stage = join(directory, `.relay-stage-${randomUUID()}`);
  let backup, installed = false;
  try {
    cpSync(join(root, 'plugins/relay-antigravity'), stage, { recursive: true });
    const hook = { 'relay-session-context': { PreInvocation: [{ type: 'command', timeout: 10,
      command: `env RELAY_CONFIG=${shellQuote(configPath)} ${shellQuote(node)} ${shellQuote(join(destination, 'scripts/hook.mjs'))}` }] } };
    writeFileSync(join(stage, 'hooks.json'), JSON.stringify(hook, null, 2) + '\n');
    const sidecarPath = join(stage, 'sidecars/bridge/sidecar.json');
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    writeFileSync(sidecarPath, JSON.stringify({ ...sidecar, command: node,
      args: [join(destination, 'scripts/sidecar.mjs')], env: { RELAY_CONFIG: configPath } }, null, 2) + '\n');
    writeFileSync(join(stage, markerName), JSON.stringify({ managedBy: 'agent-relay',
      version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version }) + '\n');
    mkdirSync(join(directory, 'plugins'), { recursive: true });
    if (existsSync(destination) || previous !== null) mkdirSync(join(directory, 'relay-backups'), { recursive: true, mode: 0o700 });
    if (existsSync(destination)) {
      backup = join(directory, 'relay-backups', `plugin-${randomUUID()}`);
      renameSync(destination, backup);
    }
    renameSync(stage, destination);
    installed = true;
    if (previous !== null && previous !== JSON.stringify(settings, null, 2) + '\n') {
      writeFileSync(join(directory, 'relay-backups', `config-${randomUUID()}.json`), previous, { mode: 0o600, flag: 'wx' });
    }
    const temporary = `${settingsPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temporary, settingsPath);
    } finally { rmSync(temporary, { force: true }); }
  } catch (error) {
    if (installed) rmSync(destination, { recursive: true, force: true });
    if (backup) renameSync(backup, destination);
    throw error;
  } finally { rmSync(stage, { recursive: true, force: true }); }
  return destination;
}
