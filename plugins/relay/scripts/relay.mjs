#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

// This small cached plugin uses one shared local runtime and store. No tokens,
// native session IDs or developer-machine paths are shipped in the package.
try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('Relay requires Node 22.13 or newer');
  const configPath = process.env.RELAY_CONFIG ?? join(homedir(), '.config', 'agent-relay', 'config.json');
  let config;
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); }
  catch { throw new Error(`Relay is not configured. Run the Relay checkout’s scripts/install-plugins.mjs once. Expected config: ${configPath}`); }
  if (config.version !== 1 || !isAbsolute(config.runtime ?? '') || !isAbsolute(config.home ?? '') ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(config.defaultChannel ?? '')) throw new Error('Invalid Relay installation configuration');
  const { sessionMain } = await import(pathToFileURL(join(config.runtime, 'src/session-cli.mjs')).href);
  await sessionMain(process.argv.slice(2), { defaultHome: config.home, defaultChannel: config.defaultChannel });
} catch (error) {
  console.error(`Relay: ${error.message}`);
  process.exitCode = 1;
}
