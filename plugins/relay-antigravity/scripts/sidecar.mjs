#!/usr/bin/env node
import { loadRuntime } from './runtime.mjs';

try {
  const runtime = loadRuntime();
  const { createSidecar } = await runtime.module('antigravity/sidecar.mjs');
  const sidecar = await createSidecar({ home: runtime.config.home });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    void sidecar.close().then(() => process.exit(0));
  });
  sidecar.start();
} catch (error) { console.error(`Relay sidecar: ${error.message}`); process.exitCode = 1; }
