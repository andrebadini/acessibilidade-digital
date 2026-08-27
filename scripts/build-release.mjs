import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const output = join(root, 'release', `audita-mt-${manifest.version}.zip`);
const staging = await mkdtemp(join(tmpdir(), 'audita-mt-release-'));
const releaseTimestamp = new Date('2026-08-27T00:00:00.000Z');

try {
  await cp(join(root, 'manifest.json'), join(staging, 'manifest.json'));
  await cp(join(root, 'src'), join(staging, 'src'), { recursive: true });
  await mkdir(join(staging, 'assets', 'icons'), { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    await cp(join(root, 'assets', 'icons', `icon-${size}.png`), join(staging, 'assets', 'icons', `icon-${size}.png`));
  }
  const discovered = await runtimeFiles(staging);
  const files = ['manifest.json', ...discovered.filter(path => path !== 'manifest.json')];
  for (const path of files) await utimes(join(staging, path), releaseTimestamp, releaseTimestamp);
  await mkdir(dirname(output), { recursive: true });
  await rm(output, { force: true });
  const zip = spawnSync('zip', ['-X', '-q', output, ...files], {
    cwd: staging, encoding: 'utf8', env: { ...process.env, TZ: 'UTC' },
  });
  if (zip.status !== 0) throw new Error(zip.stderr || zip.stdout || 'Falha ao gerar o ZIP.');
  const bytes = await readFile(output);
  const digest = createHash('sha256').update(bytes).digest('hex');
  console.log(`${basename(output)}\nSHA-256 ${digest}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}

async function runtimeFiles(directory, prefix = '') {
  const files = [];
  for (const entry of (await readdir(join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const relative = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await runtimeFiles(directory, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort((a, b) => a.localeCompare(b, 'en'));
}
