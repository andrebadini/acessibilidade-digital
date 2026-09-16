import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const releaseDirectory = fileURLToPath(new URL('../release/', import.meta.url));
const packageName = 'audita-acessibilidade-1.1.15.zip';

function runBuild(args) {
  return spawnSync(process.execPath, ['scripts/build-release.mjs', ...args], {
    cwd: root, encoding: 'utf8',
  });
}

function build(temporaryReleaseDirectory) {
  const result = runBuild(['--temporary-release-directory', temporaryReleaseDirectory]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function createIsolatedBuilder(t, version) {
  const project = await mkdtemp(join(tmpdir(), 'audita-builder-project-'));
  const isolatedRelease = await mkdtemp(join(tmpdir(), 'audita-release-test-'));
  t.after(async () => {
    await rm(project, { recursive: true, force: true });
    await rm(isolatedRelease, { recursive: true, force: true });
  });
  await mkdir(join(project, 'scripts'));
  await mkdir(join(project, 'src'));
  await mkdir(join(project, 'vendor'));
  await mkdir(join(project, 'assets', 'icons'), { recursive: true });
  await cp(join(root, 'scripts', 'build-release.mjs'), join(project, 'scripts', 'build-release.mjs'));
  await writeFile(join(project, 'src', 'runtime.js'), 'globalThis.__fixture = true;\n');
  await writeFile(join(project, 'vendor', 'LICENSE'), 'fixture license\n');
  for (const size of [16, 32, 48, 128]) {
    await writeFile(join(project, 'assets', 'icons', `icon-${size}.png`), `fixture icon ${size}\n`);
  }
  await writeIsolatedManifest(project, version);
  return { project, isolatedRelease };
}

function runIsolatedBuild(project, isolatedRelease) {
  return spawnSync(process.execPath, [
    join(project, 'scripts', 'build-release.mjs'),
    '--temporary-release-directory', isolatedRelease,
  ], { cwd: project, encoding: 'utf8' });
}

function runIsolatedDefaultBuild(project) {
  return spawnSync(process.execPath, [join(project, 'scripts', 'build-release.mjs')], {
    cwd: project, encoding: 'utf8',
  });
}

function writeIsolatedManifest(project, version) {
  return writeFile(join(project, 'manifest.json'), `${JSON.stringify({ version })}\n`);
}

async function digest(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function snapshotRelease() {
  const snapshot = [];
  for (const entry of (await readdir(releaseDirectory, { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = join(releaseDirectory, entry.name);
    const metadata = await lstat(path, { bigint: true });
    snapshot.push({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      inode: metadata.ino.toString(),
      size: metadata.size.toString(),
      modified: metadata.mtimeNs.toString(),
      changed: metadata.ctimeNs.toString(),
      sha256: entry.isFile() ? await digest(path) : null,
    });
  }
  return snapshot;
}

test('builds the public ZIP reproducibly in an isolated temporary directory', async t => {
  const isolatedRelease = await mkdtemp(join(tmpdir(), 'audita-release-test-'));
  t.after(() => rm(isolatedRelease, { recursive: true, force: true }));

  const output = join(isolatedRelease, packageName);
  const legacyOutput = join(isolatedRelease, 'audita-mt-0.0.0.zip');
  const unrelatedReleaseFile = join(isolatedRelease, 'keep.txt');
  await writeFile(legacyOutput, 'legacy package');
  await writeFile(unrelatedReleaseFile, 'preserve me');
  const releaseBefore = await snapshotRelease();

  build(isolatedRelease);

  assert.equal(await readFile(legacyOutput, 'utf8'), 'legacy package');
  assert.equal(await readFile(unrelatedReleaseFile, 'utf8'), 'preserve me');
  assert.deepEqual(
    (await readdir(isolatedRelease)).filter(name => name.endsWith('.zip')).sort(),
    [packageName, 'audita-mt-0.0.0.zip'],
  );
  const first = await digest(output);
  await new Promise(resolve => setTimeout(resolve, 2_100));
  build(isolatedRelease);
  const second = await digest(output);
  assert.equal(second, first);
  assert.deepEqual(await snapshotRelease(), releaseBefore, 'o teste não pode tocar em release/');

  const listing = spawnSync('unzip', ['-Z1', output], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  const entries = listing.stdout.trim().split('\n');
  assert.equal(entries[0], 'manifest.json');
  assert.deepEqual(entries.filter(path => /assets\/icons\/icon-\d+\.png$/u.test(path)).sort(), [
    'assets/icons/icon-128.png', 'assets/icons/icon-16.png', 'assets/icons/icon-32.png', 'assets/icons/icon-48.png',
  ]);
  assert.deepEqual(entries.filter(path => path.startsWith('vendor/axe/')).sort(), [
    'vendor/axe/LICENSE', 'vendor/axe/LICENSE-3RD-PARTY.txt', 'vendor/axe/axe.min.js',
  ]);
  assert.equal(entries.some(path => /(?:^|\/)(?:test|docs|store-assets|fixtures|node_modules)(?:\/|$)/u.test(path)), false);
});

test('rejects temporary release targets that could broaden package cleanup', async t => {
  const validationFixture = await mkdtemp(join(tmpdir(), 'audita-release-validation-'));
  const nested = await mkdtemp(join(validationFixture, 'audita-release-test-'));
  const symlinkTarget = join(validationFixture, 'target');
  await mkdir(symlinkTarget);

  const symlinkPath = await mkdtemp(join(tmpdir(), 'audita-release-test-'));
  await rm(symlinkPath, { recursive: true });
  await symlink(symlinkTarget, symlinkPath, 'dir');
  const missing = await mkdtemp(join(tmpdir(), 'audita-release-test-'));
  await rm(missing, { recursive: true });
  const validButExtra = await mkdtemp(join(tmpdir(), 'audita-release-test-'));
  t.after(async () => {
    await rm(symlinkPath, { force: true });
    await rm(validationFixture, { recursive: true, force: true });
    await rm(missing, { recursive: true, force: true });
    await rm(validButExtra, { recursive: true, force: true });
  });

  const releaseBefore = await snapshotRelease();
  const invalidInvocations = [
    ...[nested, validationFixture, symlinkPath, missing, releaseDirectory, root, '/', '.']
      .map(candidate => ['--temporary-release-directory', candidate]),
    ['--temporary-release-directory'],
    ['--temporary-release-directory', ''],
    ['--temporary-release-directory', validButExtra, '--unexpected'],
    ['--unknown-option', validButExtra],
  ];
  for (const args of invalidInvocations) {
    const result = runBuild(args);
    assert.equal(result.signal, null, `validação não terminou: ${JSON.stringify(args)}`);
    assert.notEqual(result.status, 0, `destino inseguro aceito: ${JSON.stringify(args)}`);
  }
  assert.deepEqual(await snapshotRelease(), releaseBefore, 'rejeições não podem tocar em release/');
});

test('default build replaces only its exact four-component package output', async t => {
  const fixture = await createIsolatedBuilder(t, '1.2.3.4');
  const fixtureRelease = join(fixture.project, 'release');
  const output = join(fixtureRelease, 'audita-acessibilidade-1.2.3.4.zip');
  const preserved = [
    ['audita-acessibilidade-1.zip', 'one component'],
    ['audita-acessibilidade-1.2.zip', 'two components'],
    ['audita-acessibilidade-1.2.3.zip', 'three components'],
    ['audita-acessibilidade-2.0.0.0.zip', 'other four components'],
    ['audita-acessibilidade-01.zip', 'invalid lookalike'],
    ['audita-mt-0.0.0.zip', 'legacy package'],
    ['keep.txt', 'unrelated file'],
  ];
  await mkdir(fixtureRelease);
  await writeFile(output, 'stale invalid archive');
  for (const [name, contents] of preserved) await writeFile(join(fixtureRelease, name), contents);
  const releaseBefore = await snapshotRelease();

  const firstBuild = runIsolatedDefaultBuild(fixture.project);

  assert.equal(firstBuild.status, 0, firstBuild.stderr || firstBuild.stdout);
  for (const [name, contents] of preserved) {
    assert.equal(await readFile(join(fixtureRelease, name), 'utf8'), contents, `${name} precisa ser preservado`);
  }
  const first = await digest(output);
  await new Promise(resolve => setTimeout(resolve, 2_100));
  await writeFile(output, 'different stale archive');
  const secondBuild = runIsolatedDefaultBuild(fixture.project);
  assert.equal(secondBuild.status, 0, secondBuild.stderr || secondBuild.stdout);
  assert.equal(await digest(output), first);
  for (const [name, contents] of preserved) {
    assert.equal(await readFile(join(fixtureRelease, name), 'utf8'), contents, `${name} precisa continuar preservado`);
  }
  assert.deepEqual(await snapshotRelease(), releaseBefore, 'o build isolado não pode tocar em release/ real');
});

test('default build rejects a symlinked release directory before exact output cleanup', async t => {
  const fixture = await createIsolatedBuilder(t, '1.2.3.4');
  const outside = await mkdtemp(join(tmpdir(), 'audita-release-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const sentinel = join(outside, 'audita-acessibilidade-1.2.3.4.zip');
  await writeFile(sentinel, 'preserve outside sentinel');
  await symlink(outside, join(fixture.project, 'release'), 'dir');
  const releaseBefore = await snapshotRelease();

  const result = runIsolatedDefaultBuild(fixture.project);

  assert.equal(result.signal, null, 'validação do diretório padrão precisa terminar');
  assert.notEqual(result.status, 0, 'release/ simbólico não pode ser aceito');
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve outside sentinel');
  assert.deepEqual(await snapshotRelease(), releaseBefore, 'symlink rejeitado não pode tocar em release/ real');
});

test('enforces the exact Chrome numeric version grammar before cleanup', async t => {
  const fixture = await createIsolatedBuilder(t, '65536');
  const releaseBefore = await snapshotRelease();
  for (const version of [
    '65536',
    '01',
    '1.02',
    '1.2.3.4.5',
    '0',
    '0.0.0.0',
    '',
    '1-beta',
    1,
    null,
  ]) {
    await writeIsolatedManifest(fixture.project, version);
    const result = runIsolatedBuild(fixture.project, fixture.isolatedRelease);
    assert.equal(result.signal, null, `validação não terminou para ${JSON.stringify(version)}`);
    assert.notEqual(result.status, 0, `versão inválida aceita: ${JSON.stringify(version)}`);
  }
  for (const version of ['1', '1.0', '0.1.0.0', '65535.65535.65535.65535']) {
    await writeIsolatedManifest(fixture.project, version);
    const result = runIsolatedBuild(fixture.project, fixture.isolatedRelease);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  assert.deepEqual(await snapshotRelease(), releaseBefore, 'versões inválidas não podem tocar em release/');
});

test('rejects a traversal version before removing an escaped output path', async t => {
  const escapeDirectory = await mkdtemp(join(tmpdir(), 'audita-release-escape-'));
  t.after(() => rm(escapeDirectory, { recursive: true, force: true }));
  const sentinel = join(escapeDirectory, 'sentinel.zip');
  await writeFile(sentinel, 'preserve escaped sentinel');
  const traversal = `1/../../${basename(escapeDirectory)}/sentinel`;
  const fixture = await createIsolatedBuilder(t, traversal);
  const releaseBefore = await snapshotRelease();

  const result = runIsolatedBuild(fixture.project, fixture.isolatedRelease);

  assert.equal(result.signal, null, 'validação de traversal precisa terminar');
  assert.notEqual(result.status, 0, 'versão com traversal não pode alcançar o output');
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve escaped sentinel');
  assert.deepEqual(await snapshotRelease(), releaseBefore, 'traversal rejeitado não pode tocar em release/');
});
