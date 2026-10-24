import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function codexBinary(explicit, exists = existsSync) {
  if (explicit) return explicit;
  for (const app of ['Codex.app', 'ChatGPT.app']) {
    for (const base of ['/Applications', join(homedir(), 'Applications')]) {
      for (const suffix of ['Contents/Resources/codex', 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex']) {
        const binary = join(base, app, suffix);
        if (exists(binary)) return binary;
      }
    }
  }
  return 'codex';
}
