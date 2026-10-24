#!/usr/bin/env node
import { loadRuntime } from './runtime.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help') {
    console.log('Use the exact Relay command prefix supplied by this Antigravity conversation’s hook:\nnode /installed/plugin/scripts/relay.mjs --context /hook/context.json COMMAND [OPTIONS]\nCommands: register, whoami, directory, send, reply, ack, inbox, history.');
  } else {
    if (args[0] !== '--context' || !args[1]) throw new Error('Use --context with the path supplied by this conversation’s Relay hook; never borrow another session’s context');
    const runtime = loadRuntime(), { config } = runtime;
    const { sessionMain } = await runtime.module('session-cli.mjs');
    await sessionMain(args.slice(2), { defaultHome: config.home, defaultChannel: config.defaultChannel,
      identityOptions: { antigravityContext: args[1], antigravityHome: config.home } });
  }
} catch (error) { console.error(`Relay: ${error.message}`); process.exitCode = 1; }
