#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { installAntigravity } from './install-antigravity.mjs';
import { codexBinary } from '../src/provider-paths.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
try {
  const { values } = parseArgs({ options: {
    target: { type: 'string', default: 'both' }, config: { type: 'string' }, home: { type: 'string' },
    channel: { type: 'string' }, 'codex-binary': { type: 'string' }, 'claude-binary': { type: 'string' },
    'configure-only': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    'antigravity-config-dir': { type: 'string' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/install-plugins.mjs [--target both|codex|claude|antigravity] [--home DIR] [--channel main]\n'
      + '  [--codex-binary PATH] [--claude-binary PATH] [--config FILE] [--configure-only]\n'
      + '  [--antigravity-config-dir DIR] (default ~/.gemini/config; both means Codex + Claude)\n'
      + 'Installs user-scoped local plugins and configures one shared runtime.\n'
      + 'Antigravity uses its documented plugin directory and enables only the Relay App sidecar.\n'
      + 'Does not start a broker, open/resume chats, enable MCP channels or change tool permissions.');
  } else {
    if (!['both', 'codex', 'claude', 'antigravity'].includes(values.target)) throw new Error('Invalid --target');
    const configPath = resolve(values.config ?? process.env.RELAY_CONFIG ?? join(homedir(), '.config', 'agent-relay', 'config.json'));
    const previous = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
    const config = { ...previous, version: 1, runtime: root,
      home: resolve(values.home ?? previous.home ?? join(root, '.relay')),
      defaultChannel: values.channel ?? previous.defaultChannel ?? 'main' };
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(config.defaultChannel)) throw new Error('Invalid channel');
    mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
    const contents = JSON.stringify(config, null, 2) + '\n';
    if (existsSync(configPath) && readFileSync(configPath, 'utf8') !== contents) {
      writeFileSync(`${configPath}.backup-${Date.now()}`, readFileSync(configPath), { mode: 0o600, flag: 'wx' });
    }
    writeFileSync(configPath, contents, { mode: 0o600 });
    console.log(`Configured shared Relay runtime: ${configPath}`);
    const run = (binary, args) => execFileSync(binary, args, { stdio: 'inherit', timeout: 120000 });
    if (!values['configure-only']) {
      if (values.target === 'antigravity') {
        const installed = installAntigravity({ root, configPath,
          configDirectory: values['antigravity-config-dir'] ?? join(homedir(), '.gemini/config') });
        console.log(`Antigravity App plugin installed: ${installed}; Relay sidecar enabled. Start/reload the App to load it.`);
      }
      if (['both', 'codex'].includes(values.target)) {
        const binary = codexBinary(values['codex-binary']);
        run(binary, ['plugin', 'marketplace', 'add', root]);
        run(binary, ['plugin', 'add', 'relay@relay-local', '--json']);
      }
      if (['both', 'claude'].includes(values.target)) {
        const local = join(homedir(), '.local/bin/claude');
        const binary = values['claude-binary'] ?? (existsSync(local) ? local : 'claude');
        run(binary, ['plugin', 'marketplace', 'add', root]);
        run(binary, ['plugin', 'install', 'relay@relay-local', '--scope', 'user']);
      }
      console.log('Relay installed. New sessions can use the Relay skill. Existing sessions may need a plugin reload or app restart.');
    }
  }
} catch (error) { console.error(`Relay install: ${error.message}`); process.exitCode = 1; }
