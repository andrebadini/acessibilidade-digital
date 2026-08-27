import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const output = new URL('../release/audita-acessibilidade-1.0.1.zip', import.meta.url);
const releaseDirectory = new URL('../release/', import.meta.url);
const legacyOutput = new URL('../release/audita-mt-0.0.0.zip', import.meta.url);
const unrelatedReleaseFile = new URL('../release/keep.txt', import.meta.url);

function build() {
  const result = spawnSync(process.execPath, ['scripts/build-release.mjs'], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function digest() {
  return createHash('sha256').update(await readFile(output)).digest('hex');
}

test('builds the public ZIP reproducibly with only runtime files and manifest at root', async () => {
  await writeFile(legacyOutput, 'legacy package');
  await writeFile(unrelatedReleaseFile, 'preserve me');
  try {
    build();
    await assert.rejects(readFile(legacyOutput), { code: 'ENOENT' });
    assert.equal(await readFile(unrelatedReleaseFile, 'utf8'), 'preserve me');
    assert.deepEqual(
      (await readdir(releaseDirectory)).filter(name => name.endsWith('.zip')).sort(),
      ['audita-acessibilidade-1.0.1.zip'],
    );
    const first = await digest();
    await new Promise(resolve => setTimeout(resolve, 2_100));
    build();
    const second = await digest();
    assert.equal(second, first);

    const listing = spawnSync('unzip', ['-Z1', output.pathname], { encoding: 'utf8' });
    assert.equal(listing.status, 0, listing.stderr);
    const entries = listing.stdout.trim().split('\n');
    assert.equal(entries[0], 'manifest.json');
    assert.deepEqual(entries.filter(path => /assets\/icons\/icon-\d+\.png$/u.test(path)).sort(), [
      'assets/icons/icon-128.png', 'assets/icons/icon-16.png', 'assets/icons/icon-32.png', 'assets/icons/icon-48.png',
    ]);
    assert.equal(entries.some(path => /(?:^|\/)(?:test|docs|store-assets|fixtures|node_modules)(?:\/|$)/u.test(path)), false);
  } finally {
    await rm(legacyOutput, { force: true });
    await rm(unrelatedReleaseFile, { force: true });
  }
});
