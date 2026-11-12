import http from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, RelayError } from './store.mjs';
import { codexAdapter } from './adapters/codex.mjs';
import { claudeDesktopAdapter, findDesktopSession } from './adapters/claude-desktop.mjs';
import { createTitleResolver } from './session-titles.mjs';
import { observeDesktops } from './desktop-continuity.mjs';
import { codexBinary } from './provider-paths.mjs';

export function acquireLock(home) {
  const path = join(home, 'daemon.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 }); return () => unlinkSync(path); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(path, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid lock: ${path}; inspect it before removing`);
      try { process.kill(pid, 0); throw new Error(`Relay already running (PID ${pid})`); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      unlinkSync(path);
    }
  }
  throw new Error('Could not acquire daemon lock');
}

async function jsonBody(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new RelayError('Expected application/json', 415);
  let size = 0; const parts = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 160000) throw new RelayError('Request too large', 413);
    parts.push(chunk);
  }
  try { const result = JSON.parse(Buffer.concat(parts).toString());
    if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error();
    return result;
  } catch { throw new RelayError('Expected a JSON object'); }
}

export async function startDaemon({ home, port = 9231, adapters, interval = 500, desktopObserver = observeDesktops, desktopScanInterval = 3000, resolveTitles = createTitleResolver() } = {}) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const unlock = acquireLock(home);
  let store;
  try { store = new Store(join(home, 'relay.sqlite')); store.recover(); }
  catch (error) { unlock(); throw error; }
  chmodSync(join(home, 'relay.sqlite'), 0o600);
  const tokenPath = join(home, 'owner-token');
  if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomUUID(), { mode: 0o600 });
  const ownerToken = readFileSync(tokenPath, 'utf8').trim();
  const drivers = adapters ?? { codex: codexAdapter({ binary: codexBinary() }), 'claude-desktop': claudeDesktopAdapter({ home }) };
  // Enrollment always uses fresh broker-side evidence. On the receiving side,
  // discovery runs even if the resumed chat has not issued any Relay commands.
  let scan, checkedAt = 0, desktopReady = new Map(), errors = new Map();
  function observations() {
    return scan ??= Promise.resolve().then(desktopObserver).finally(() => { scan = null; });
  }
  async function enrollDesktop(body) {
    const rows = await observations();
    return store.reconcileDesktop(rows.find(r => r.native === body.native_id), body);
  }
  async function refreshDesktops() {
    if (checkedAt && Date.now() - checkedAt < desktopScanInterval) return;
    const next = new Map(), problems = new Map();
    try {
      for (const row of await observations()) {
        try {
          const e = store.reconcileDesktop(row)?.endpoint;
          if (e) next.set(e.id, e.native_id);
        } catch (error) { problems.set(row.native, error.message); }
      }
    } catch (error) { problems.set('registry', error.message); }
    for (const [key, error] of problems) if (errors.get(key) !== error) console.error('Claude desktop continuity:', key, error);
    errors = problems; desktopReady = next; checkedAt = Date.now();
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    try {
      if (request.headers.origin) throw new RelayError('Browser-origin requests are not supported', 403);
      const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const admin = token === ownerToken;
      const endpoint = admin ? null : store.authenticate(token);
      if (!admin && !endpoint) throw new RelayError('Invalid Relay credential', 401);
      const url = new URL(request.url, 'http://127.0.0.1');
      const body = request.method === 'POST' ? await jsonBody(request) : {};
      const requireAdmin = () => { if (!admin) throw new RelayError('Owner credential required', 403); };
      const requireMember = () => { if (!endpoint) throw new RelayError('Session credential required', 403); return endpoint.id; };
      let result;
      const match = url.pathname.match(/^\/v1\/messages\/([0-9a-f-]+)\/(ack|reply|requeue)$/);
      if (request.method === 'GET' && url.pathname === '/v1/status') {
        result = { version: '0.3.1', sessions: store.sessions(endpoint?.channel),
          ...(admin ? { desktop_identity_conflicts: Object.fromEntries(errors) } : {}) };
      } else if (request.method === 'GET' && url.pathname === '/v1/directory') {
        requireMember();
        if (drivers['claude-desktop']?.usesDesktopIdentity) await refreshDesktops();
        const sessions = store.sessions(endpoint.channel);
        // Resolve only this member's channel and disclose only title metadata.
        const identities = sessions.map(session => {
          const { id, kind, native_id } = store.endpoint(session.id);
          return { id, kind, native_id };
        });
        let titles;
        try { titles = await resolveTitles(identities); } catch { titles = new Map(); }
        result = { sessions: sessions.map(session => ({ ...session,
          title: titles.get(session.id)?.title ?? null, title_source: titles.get(session.id)?.title_source ?? null })) };
      } else if (request.method === 'POST' && url.pathname === '/v1/register') {
        requireAdmin();
        if (body.kind === 'claude-desktop') {
          if (!body.alias) throw new RelayError('Operator registration requires an alias');
          result = (await enrollDesktop({ ...body, default_channel: 'general' })).endpoint;
        } else result = store.register(body);
      } else if (request.method === 'POST' && url.pathname === '/v1/enroll') {
        requireAdmin(); result = body.kind === 'claude-desktop' ? await enrollDesktop(body) : store.enroll(body);
      } else if (request.method === 'POST' && url.pathname === '/v1/pause') {
        requireAdmin(); if (typeof body.paused !== 'boolean') throw new RelayError('paused must be boolean');
        result = store.pause(body.endpoint_id, body.paused);
      } else if (request.method === 'POST' && url.pathname === '/v1/bind-claude-desktop') {
        requireAdmin();
        const target = await findDesktopSession(body.native_id);
        if (!target) throw new RelayError('No live Claude desktop process for that exact native session', 409);
        result = { endpoint: store.bindClaudeDesktop(body.endpoint_id, body.native_id), target };
      } else if (request.method === 'GET' && url.pathname === '/v1/history') {
        const channel = endpoint?.channel ?? url.searchParams.get('channel') ?? 'general';
        result = store.history(channel, { after: Number(url.searchParams.get('after') ?? 0),
          limit: Number(url.searchParams.get('limit') ?? 100), thread_id: url.searchParams.get('thread_id') ?? undefined });
      } else if (request.method === 'GET' && url.pathname === '/v1/inbox') {
        result = store.inbox(requireMember());
      } else if (request.method === 'POST' && url.pathname === '/v1/send') {
        result = store.send(requireMember(), body);
      } else if (request.method === 'POST' && match) {
        const [, id, action] = match;
        if (action === 'ack') result = store.ack(requireMember(), id);
        if (action === 'reply') result = store.reply(requireMember(), id, body);
        if (action === 'requeue') { requireAdmin(); result = store.requeue(id); }
      } else if (request.method === 'POST' && url.pathname === '/v1/bridge/pull') {
        result = store.bridge(requireMember(), body.instance);
      } else if (request.method === 'POST' && url.pathname === '/v1/bridge/finish') {
        result = store.finish(requireMember(), body.message_id, body.claim, body.status, body.error);
      } else if (request.method === 'POST' && url.pathname === '/v1/bridge/disconnect') {
        store.disconnect(requireMember(), body.instance); result = { ok: true };
      } else if (request.method === 'POST' && ['/v1/antigravity/pull', '/v1/antigravity/finish', '/v1/antigravity/disconnect'].includes(url.pathname)) {
        // The App sidecar serves all opted-in Antigravity sessions. Keep this
        // machine-local service separate from a member's session credential.
        requireAdmin();
        const target = store.endpoint(body.endpoint_id);
        if (target.kind !== 'agy') throw new RelayError('Not an Antigravity App endpoint', 403);
        if (url.pathname.endsWith('/pull')) {
          result = { native_id: target.native_id, delivery: store.bridge(target.id, body.instance, 'agy') };
        } else if (url.pathname.endsWith('/finish')) {
          result = store.finish(target.id, body.message_id, body.claim, body.status, body.error);
        } else {
          store.disconnect(target.id, body.instance); result = { ok: true };
        }
      } else throw new RelayError('Route not found', 404);
      response.end(JSON.stringify({ result }));
    } catch (error) {
      response.statusCode = error.status ?? 500;
      response.end(JSON.stringify({ error: error.status ? error.message : 'Internal Relay error' }));
      if (!error.status) console.error(error);
    }
  });
  if (drivers['claude-desktop']?.usesDesktopIdentity) await refreshDesktops();
  try { await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(port, '127.0.0.1', resolve);
  }); } catch (error) { store.close(); unlock(); throw error; }
  const url = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(home, 'server.json'), JSON.stringify({ url }, null, 2) + '\n', { mode: 0o600 });
  let stopped = false, pending = null;
  async function tick() {
    if (pending || stopped) return;
    pending = (async () => {
      store.expireClaims();
      const nativeDesktop = drivers['claude-desktop']?.usesDesktopIdentity;
      if (nativeDesktop && (!checkedAt || store.db.prepare(`SELECT 1 FROM deliveries d JOIN messages m ON m.id=d.message_id
          JOIN active_endpoints e ON e.id=m.recipient WHERE e.kind='claude-desktop' AND e.paused=0 AND d.status='queued' LIMIT 1`).get())) {
        await refreshDesktops();
      }
      // Independent endpoints progress together; each endpoint has one delivery lane.
      await Promise.all(store.sessions().filter(ep => !ep.paused && drivers[ep.kind]).map(async endpoint => {
        const driver = drivers[endpoint.kind], privateEndpoint = store.endpoint(endpoint.id);
        if (endpoint.kind === 'claude-desktop' && nativeDesktop && desktopReady.get(endpoint.id) !== privateEndpoint.native_id) return;
        if (!store.hasQueued(endpoint.id)) return;
        if (driver.available && !await driver.available(privateEndpoint)) return;
        if (nativeDesktop && endpoint.kind === 'claude-desktop') {
          // The short cache throttles checks for offline mailboxes. Before an actual
          // claim, validate uniqueness again rather than delivering on a stale scan.
          const live = (await observations()).find(r => r.native === privateEndpoint.native_id);
          if (!live || live.error || live.host !== privateEndpoint.desktop_host) return;
        }
        if (store.routeId(endpoint.id) !== endpoint.id || store.endpoint(endpoint.id).native_id !== privateEndpoint.native_id) return;
        const delivery = store.claim(endpoint.id);
        if (!delivery) return;
        let outcome;
        try { outcome = await driver(privateEndpoint, delivery.message); }
        catch (error) { outcome = { status: 'delivery_unknown', error: error.message }; }
        store.finish(endpoint.id, delivery.message.id, delivery.claim, outcome.status, outcome.error);
      }));
    })();
    try { await pending; } catch (error) { console.error('Delivery worker:', error); }
    finally { pending = null; }
  }
  const timer = setInterval(tick, interval);
  return { url, ownerToken, store, tick, async close() {
    if (stopped) return;
    stopped = true; clearInterval(timer);
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    if (pending) await pending;
    store.close(); unlock();
  } };
}
