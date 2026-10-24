import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, delimiter, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from '../client.mjs';
import { antigravityAdapter } from '../adapters/antigravity.mjs';

export async function nativeAgentApi(env = process.env) {
  if (!isAbsolute(env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ?? '')) throw new Error('Run Relay delivery as an Antigravity App sidecar');
  for (const directory of (env.PATH ?? '').split(delimiter).filter(isAbsolute)) {
    const binary = join(directory, 'agentapi');
    try { await access(binary, constants.X_OK); return binary; } catch { /* Try next native PATH entry. */ }
  }
  throw new Error('Antigravity did not provide agentapi on the sidecar PATH');
}

export async function createSidecar({ home, env = process.env, adapter, interval = 1000, log = console.error } = {}) {
  const deliver = adapter ?? antigravityAdapter({ binary: await nativeAgentApi(env) });
  const instance = randomUUID(), owned = new Set();
  let pending, timer, stopped = false, lastError;
  const owner = async () => ({ ...JSON.parse(await readFile(join(home, 'server.json'), 'utf8')),
    token: (await readFile(join(home, 'owner-token'), 'utf8')).trim() });
  async function tick() {
    if (stopped) return;
    if (pending) { await pending.catch(() => {}); return; }
    pending = (async () => {
      const credential = await owner();
      const { sessions } = await request(credential, '/v1/status');
      const results = await Promise.allSettled(sessions.filter(endpoint => endpoint.kind === 'agy' && !endpoint.paused).map(async endpoint => {
        let pulled;
        try {
          pulled = await request(credential, '/v1/antigravity/pull', { endpoint_id: endpoint.id, instance });
        } catch (error) {
          if (error.status === 409) return; // Another App sidecar owns this lane.
          throw error;
        }
        owned.add(endpoint.id);
        if (!pulled.delivery) return;
        const { message, claim } = pulled.delivery;
        let outcome;
        try { outcome = await deliver({ ...endpoint, native_id: pulled.native_id }, message); }
        catch (error) { outcome = { status: 'delivery_unknown', error: error.message }; }
        // A lost finish response never reruns agentapi. The broker retains the
        // claim, times it out to unknown, and requires an explicit redelivery.
        await request(credential, '/v1/antigravity/finish', { endpoint_id: endpoint.id,
          message_id: message.id, claim, status: outcome.status, error: outcome.error });
      }));
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    })();
    try { await pending; lastError = undefined; }
    catch (error) { if (lastError !== error.message) log(`Relay sidecar: ${error.message}`); lastError = error.message; }
    finally { pending = undefined; }
  }
  return {
    tick,
    start() { if (!timer && !stopped) { timer = setInterval(() => void tick(), interval); void tick(); } },
    async close() {
      stopped = true; clearInterval(timer); if (pending) await pending.catch(() => {});
      try {
        const credential = await owner();
        await Promise.all([...owned].map(endpoint_id => request(credential, '/v1/antigravity/disconnect', { endpoint_id, instance }).catch(() => {})));
      } catch { /* Broker unavailable; leases expire without replay. */ }
    },
  };
}
