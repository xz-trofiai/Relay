#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { loadRuntime } from './runtime.mjs';

try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 128000) throw new Error('Hook payload too large');
  }
  const payload = JSON.parse(input);
  const runtime = loadRuntime(), { hookOutput } = await runtime.module('antigravity/context.mjs');
  const result = await hookOutput(payload, { home: runtime.config.home, configPath: runtime.configPath,
    launcher: fileURLToPath(new URL('./relay.mjs', import.meta.url)) });
  console.log(JSON.stringify(result));
} catch (error) {
  // Do not block unrelated agent work if Relay is absent or on an unsupported surface.
  console.error(`Relay context unavailable: ${error.message}`);
  console.log('{}');
}
