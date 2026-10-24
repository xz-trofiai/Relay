import { execFile } from 'node:child_process';
import { formatMessage } from './codex.mjs';
import { nativeUuid } from '../antigravity/context.mjs';

// Called only by an App-managed sidecar, where agentapi is on the native PATH.
// Never start agy --conversation: that would create a separate CLI execution.
export function antigravityAdapter({ binary = 'agentapi', execute = execFile, timeout = 20000 } = {}) {
  return async (endpoint, message) => {
    if (endpoint.kind !== 'agy' || !nativeUuid.test(endpoint.native_id ?? '')) throw new Error('Expected exact Antigravity App conversation UUID');
    return new Promise(resolve => {
      execute(binary, ['send-message', endpoint.native_id, formatMessage(message)],
        { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
          if (!error) return resolve({ status: 'submitted' });
          const detail = `${error.message}\n${stdout ?? ''}\n${stderr ?? ''}`.slice(0, 2000);
          const usage = /usage.limit|rate.limit|quota.exceed|allowance.exhaust|insufficient.quota/i.test(detail);
          resolve({ status: usage ? 'blocked_usage' : 'delivery_unknown', error: detail });
        });
    });
  };
}
