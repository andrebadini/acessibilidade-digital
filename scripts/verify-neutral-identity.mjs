import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ENTRIES = Object.freeze([
  'assets', 'docs', 'fixtures', 'scripts', 'src', 'test',
  'README.md', 'manifest.json', 'package.json',
]);
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.txt']);
const FORBIDDEN = Object.freeze([
  new RegExp(`${'go' + 'verno'}[\\s_-]+(?:de[\\s_-]+)?mato[\\s_-]+grosso`, 'iu'),
  new RegExp(`${'go' + 'verno'}[\\s_-]+mt\\b`, 'iu'),
  new RegExp(`\\b${'pro' + 'con'}(?:-mt)?\\b`, 'iu'),
  new RegExp(`\\b${'se' + 'com'}(?:-mt)?\\b`, 'iu'),
  new RegExp(`${'gov' + 'mt'}|${'gov' + '-mt-logo'}|${'brand' + '-source'}`, 'iu'),
  new RegExp(`${'marca'}[\\s_-]+${'oficial'}|${'manual'}[\\s_-]+${'oficial'}`, 'iu'),
  new RegExp(`\\b(?:[a-z0-9-]+\\.)*${'go' + 'v'}\\.${'b' + 'r'}\\b`, 'iu'),
]);

export async function scanNeutralIdentity(root, entries = DEFAULT_ENTRIES) {
  const rootPath = root instanceof URL ? fileURLToPath(root) : resolve(root);
  const violations = [];
  for (const entry of entries) {
    const path = join(rootPath, entry);
    let metadata;
    try { metadata = await stat(path); } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    await scanPath(path, rootPath, metadata, violations);
  }
  return violations.sort();
}

async function scanPath(path, rootPath, metadata, violations) {
  const name = relative(rootPath, path);
  if (matchesForbidden(name)) violations.push(`Identidade vedada em nome de arquivo: ${name}`);
  if (metadata.isDirectory()) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const child = join(path, entry.name);
      await scanPath(child, rootPath, await stat(child), violations);
    }
    return;
  }
  if (!metadata.isFile() || !TEXT_EXTENSIONS.has(extname(path).toLowerCase())) return;
  const contents = await readFile(path, 'utf8');
  if (matchesForbidden(contents)) violations.push(`Identidade vedada em conteúdo: ${name}`);
}

function matchesForbidden(value) {
  return FORBIDDEN.some(pattern => pattern.test(value));
}
