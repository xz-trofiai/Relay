import { readFileSync } from 'node:fs';

export function readProfile(path) { return JSON.parse(readFileSync(path, 'utf8')); }
export async function request(profile, path, body) {
  const url = new URL(profile.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Relay v0 only connects to plain HTTP on 127.0.0.1');
  const response = await fetch(new URL(path, url), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${profile.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000), redirect: 'error',
  });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error ?? `Relay HTTP ${response.status}`); error.status = response.status; throw error; }
  return data.result;
}
