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
const packageName = 'audita-acessibilidade-1.1.48.zip';
// The digest of the artifact that is actually delivered. It is recorded here so a source change
// that was not followed by a rebuild fails the suite: the test builds from the current tree, so a
// stale release/audita-acessibilidade-1.1.15.zip and a drifted source cannot both stay green.
// It is checked twice on purpose, against the file in release/ and against the fresh build. The
// fresh build alone was not enough: an independent review replaced release/audita-acessibilidade-1.1.19.zip
// with garbage bytes and the suite stayed green, because the digest never touched the delivered
// file. That is the same hole that let the 1.1.15 artifact be overwritten unnoticed.
const deliveredPackageSha256 = 'c519a33be4136eed1d5df8a2e04d1d31407f5be4585722743536648d73482ba4';
// The artifact the independent review approved, kept in release/ so the evidence of what was
// reviewed survives even though the source has moved past it and it is no longer reproducible from
// HEAD. It stays reconstructible from its own commit, 49d70ca, which was verified by rebuilding.
const reviewedPackage = Object.freeze({
  name: 'audita-acessibilidade-1.1.15.zip',
  sha256: '5619e27d4002620fa61d57d24b06279dbc5a7ace1ec50a3e9b9df0b775b6b03b',
});

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
  await cp(join(root, 'scripts', 'report-css-hash.mjs'), join(project, 'scripts', 'report-css-hash.mjs'));
  await mkdir(join(project, 'src', 'core', 'report'), { recursive: true });
  await writeFixtureReportCss(join(project, 'src', 'core', 'report', 'report.css.js'));
  await writeFile(join(project, 'src', 'runtime.js'), 'globalThis.__fixture = true;\n');
  await writeFile(join(project, 'vendor', 'LICENSE'), 'fixture license\n');
  for (const size of [16, 32, 48, 128]) {
    await writeFile(join(project, 'assets', 'icons', `icon-${size}.png`), `fixture icon ${size}\n`);
  }
  await writeIsolatedManifest(project, version);
  return { project, isolatedRelease };
}

// CSS de fixture com par declarado consistente: o build recusa hash divergente, então a fixture
// precisa nascer coerente para exercitar o caminho feliz.
async function writeFixtureReportCss(path, { css = 'body{color:#000}', declared } = {}) {
  const { computeReportCssHash } = await import('../scripts/report-css-hash.mjs');
  const hash = declared ?? computeReportCssHash(css);
  await writeFile(path, `export const REPORT_CSS = ${JSON.stringify(css)};\n`
    + `export const REPORT_CSS_CSP_HASH = ${JSON.stringify(hash)};\n`);
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

  const reviewedPath = join(releaseDirectory, reviewedPackage.name);
  assert.equal(await digest(reviewedPath), reviewedPackage.sha256,
    'o artefato revisado precisa permanecer em release/ exatamente como foi aprovado');
  const deliveredPath = join(releaseDirectory, packageName);
  assert.equal(await digest(deliveredPath), deliveredPackageSha256,
    'o arquivo entregue em release/ precisa ser o artefato de hash fixado; conferir só a reconstrução deixa o arquivo entregue sem verificação');
  assert.equal(await digest(output), deliveredPackageSha256,
    'o pacote construído a partir desta árvore precisa ser o artefato entregue; se o fonte mudou, reconstrua e atualize o hash registrado');

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

test('every packaged byte is the byte in the reviewed working tree', async t => {
  // The distribution deliberately ships only manifest.json, src, vendor and the four runtime icons,
  // and it does not ship test/, which is why the real-Chrome harness cannot drive a packaged
  // extension: the harness opens /test/e2e/fixtures/real-tab-harness.html, a file the package must
  // not contain. Since the artifact cannot be executed through that path, this proves the next best
  // thing and says so: the artifact is exactly the shipped subset of this tree, byte for byte, so
  // the harness results that describe this tree also describe the artifact. It does not replace
  // running the artifact, and it does not cover a build made from a different tree.
  const isolatedRelease = await mkdtemp(join(tmpdir(), 'audita-release-test-'));
  const extracted = await mkdtemp(join(tmpdir(), 'audita-package-content-'));
  t.after(async () => {
    await rm(isolatedRelease, { recursive: true, force: true });
    await rm(extracted, { recursive: true, force: true });
  });
  build(isolatedRelease);

  const unzip = spawnSync('unzip', ['-qq', join(isolatedRelease, packageName), '-d', extracted], { encoding: 'utf8' });
  assert.equal(unzip.status, 0, unzip.stderr);

  const walk = async (directory, prefix = '') => {
    const found = [];
    for (const entry of (await readdir(join(directory, prefix), { withFileTypes: true }))) {
      const relative = prefix ? join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) found.push(...await walk(directory, relative));
      else if (entry.isFile()) found.push(relative);
    }
    return found.sort();
  };
  const packaged = await walk(extracted);
  assert.ok(packaged.includes('manifest.json'), 'o pacote precisa do manifesto');

  const differences = [];
  for (const relative of packaged) {
    const fromPackage = await readFile(join(extracted, relative));
    const fromTree = await readFile(join(root, relative)).catch(() => null);
    if (fromTree === null) { differences.push(`${relative}: ausente na árvore`); continue; }
    if (await digest(join(extracted, relative)) !== await digest(join(root, relative))) {
      differences.push(`${relative}: conteúdo difere`);
    }
    assert.ok(fromPackage.length > 0 || fromTree.length === 0, relative);
  }
  assert.deepEqual(differences, [], 'todo arquivo do pacote precisa ser idêntico ao da árvore');

  // And the reverse direction, so a shipped file cannot be quietly left out of the package.
  const shipped = (await walk(join(root, 'src'))).map(path => path);
  const shippedVendor = (await walk(join(root, 'vendor'))).map(path => join('vendor', path.replace(/^vendor[\\/]/u, '')));
  const missing = [...shipped.filter(path => path.startsWith('src')), ...shippedVendor]
    .filter(path => !packaged.includes(path));
  assert.deepEqual(missing, [], 'nenhum arquivo de src/ ou vendor/ pode ficar fora do pacote');
  t.diagnostic(`pacote conferido byte a byte: ${packaged.length} arquivos idênticos à árvore revisada`);
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

test('o build recusa pacote cujo hash de CSP não corresponde ao CSS empacotado', async t => {
  const { computeReportCssHash, assertReportCssHashConsistent } = await import('../scripts/report-css-hash.mjs');
  const { REPORT_CSS, REPORT_CSS_CSP_HASH } = await import('../src/core/report/report.css.js');
  // O par real passa; um par trocado é recusado com mensagem que diz o que fazer.
  assert.equal(computeReportCssHash(REPORT_CSS), REPORT_CSS_CSP_HASH);
  assert.equal(assertReportCssHashConsistent(REPORT_CSS, REPORT_CSS_CSP_HASH), REPORT_CSS_CSP_HASH);
  assert.throws(() => assertReportCssHashConsistent(REPORT_CSS, 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='),
    /REPORT_CSS_CSP_HASH divergente/u);

  // E o portão vale para o BUILD, não só para a função: com o CSS de fixture e um hash trocado, o
  // pacote não é produzido e o diretório de release fica vazio.
  const { project, isolatedRelease } = await createIsolatedBuilder(t, '1.0.11');
  await writeFixtureReportCss(join(project, 'src', 'core', 'report', 'report.css.js'),
    { css: 'body{color:#111}', declared: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' });
  const result = runIsolatedBuild(project, isolatedRelease);
  assert.notEqual(result.status, 0, 'o build precisa falhar com hash divergente');
  assert.match(`${result.stderr}${result.stdout}`, /REPORT_CSS_CSP_HASH/u);
  assert.deepEqual(await readdir(isolatedRelease), [], 'nenhum pacote pode ser produzido');
});
