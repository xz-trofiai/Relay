import { readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

// The published source set is explicit. Credentials, live state, personal notes,
// provider caches, and future accidental exports are never release inputs.
export const publicRoots = [
  '.gitignore', '.gitattributes', '.github', '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json',
  'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'NOTICE', 'CHANGELOG.md', 'VALIDATION.md',
  'CONTRIBUTING.md', 'SECURITY.md', 'src', 'scripts', 'plugins', 'integrations', 'docs', 'test',
];

export function publicFiles(root) {
  const result = [];
  function visit(relative) {
    const path = join(root, relative), stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Distribution contains a symbolic link: ${relative}`);
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(`${relative}/${name}`);
    else if (stat.isFile()) result.push(relative);
    else throw new Error(`Unsupported distribution file: ${relative}`);
  }
  for (const relative of publicRoots) visit(relative);
  return result.sort();
}
