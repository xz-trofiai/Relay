import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { publicFiles } from './public-files.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
try {
  const files = publicFiles(root), allowed = new Set(files), errors = [];
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  if (pkg.license !== 'Apache-2.0' || pkg.version !== lock.version || pkg.version !== lock.packages[''].version) errors.push('Package/lock metadata is inconsistent');
  for (const folder of ['.codex-plugin', '.claude-plugin']) {
    const manifest = JSON.parse(readFileSync(join(root, 'plugins/relay', folder, 'plugin.json'), 'utf8'));
    if (manifest.version !== pkg.version) errors.push(`Plugin version mismatch: ${folder}`);
  }
  if (existsSync(join(root, '.git'))) {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const name of tracked) if (!allowed.has(name)) errors.push(`Tracked file outside public source set: ${name}`);
  }
  for (const name of files) {
    if (/(^|\/)(\.relay|\.local-notes|node_modules|identities|owner-token)(\/|$)|\.(sqlite|log)$/.test(name)) errors.push(`Private/runtime file in distribution: ${name}`);
    const body = readFileSync(join(root, name), 'utf8');
    const sensitive = [/\/Users\/[A-Za-z0-9_.-]+\//, /gh[pousr]_[A-Za-z0-9]{30,}/, /github_pat_[A-Za-z0-9_]{30,}/,
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
    if (sensitive.some(pattern => pattern.test(body))) errors.push(`Possible private path or credential in ${name} (content withheld)`);
    if (name.endsWith('.md')) for (const match of body.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^[a-z]+:|^#/.test(target)) continue;
      const path = resolve(dirname(join(root, name)), decodeURIComponent(target.split('#')[0]));
      const targetName = relative(root, path);
      if (!existsSync(path) || (statSync(path).isFile() && !allowed.has(targetName))) errors.push(`Unpublished/broken local link in ${name}: ${target}`);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`Distribution check passed: ${files.length} public files; version ${pkg.version}; Apache-2.0.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
