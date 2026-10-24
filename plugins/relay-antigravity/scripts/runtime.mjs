import { readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export function loadRuntime() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('Relay requires Node 22.13 or newer');
  const path = process.env.RELAY_CONFIG ?? join(homedir(), '.config/agent-relay/config.json');
  let config;
  try { config = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`Relay is not configured: ${path}. Run scripts/install-plugins.mjs --target antigravity from the Relay checkout.`); }
  if (config.version !== 1 || !isAbsolute(config.runtime ?? '') || !isAbsolute(config.home ?? '') ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(config.defaultChannel ?? '')) throw new Error('Invalid Relay installation configuration');
  return { config, configPath: path, module: name => import(pathToFileURL(join(config.runtime, 'src', name)).href) };
}
