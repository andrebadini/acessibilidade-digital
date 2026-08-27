import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { scanNeutralIdentity } from '../../scripts/verify-neutral-identity.mjs';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('plain-language usage docs cover unpacked install, permissions, local processing and honest limitations', async () => {
  const [readme, guide] = await Promise.all([read('README.md'), read('docs/USO-FISCAL.md')]);
  const combined = `${readme}\n${guide}`;
  for (const phrase of ['Carregar sem compactação', 'debugger', 'downloads', 'processamento local', 'revisão', 'PDF']) {
    assert.match(combined, new RegExp(phrase, 'iu'));
  }
  assert.match(combined, /Chromium.*(?:pendente|não executad)/iu);
  assert.doesNotMatch(combined, /E2E (?:aprovado|concluído)|QA visual (?:aprovado|concluído)/iu);
});

test('neutral identity scanner rejects a forbidden identity in package content or file names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'audita-neutral-'));
  try {
    await writeFile(join(directory, 'README.md'), 'Audita MT — ferramenta independente.');
    assert.deepEqual(await scanNeutralIdentity(directory, ['README.md']), []);
    await writeFile(join(directory, ['gov', '-mt-logo.png'].join('')), 'fixture');
    await writeFile(join(directory, 'legacy.txt'), [['go' + 'verno', 'mt'].join(' '), 'identity'].join(' '));
    const violations = await scanNeutralIdentity(directory, ['README.md', ['gov', '-mt-logo.png'].join(''), 'legacy.txt']);
    assert.equal(violations.length, 2);
    assert.ok(violations.some(violation => /nome de arquivo/iu.test(violation)));
    assert.ok(violations.some(violation => /conteúdo/iu.test(violation)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('neutral identity scanner rejects government domains in URLs and plain text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'audita-neutral-domain-'));
  const governmentSuffix = ['go', 'v.br'].join('');
  try {
    await writeFile(join(directory, 'fixture.json'), JSON.stringify({ url: `https://${governmentSuffix}/servico` }));
    await writeFile(join(directory, 'README.md'), `Consulte api.estado.${governmentSuffix} para detalhes.`);
    await writeFile(join(directory, 'sentence.txt'), `Consulte ${governmentSuffix}.`);
    await writeFile(join(directory, 'fqdn.json'), JSON.stringify({ url: `https://portal.${governmentSuffix}./` }));

    const violations = await scanNeutralIdentity(directory, ['fixture.json', 'README.md', 'sentence.txt', 'fqdn.json']);

    assert.equal(violations.length, 4);
    assert.ok(violations.every(violation => /conteúdo/iu.test(violation)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('neutral identity scanner accepts lookalike hosts with a longer suffix or hyphenated label', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'audita-neutral-lookalike-'));
  const governmentSuffix = ['go', 'v.br'].join('');
  try {
    await writeFile(join(directory, 'longer-suffix.json'), JSON.stringify({ url: `https://portal.${governmentSuffix}.example/path` }));
    await writeFile(join(directory, 'hyphenated-label.json'), JSON.stringify({ url: `https://anti-${governmentSuffix}/path` }));

    assert.deepEqual(
      await scanNeutralIdentity(directory, ['longer-suffix.json', 'hyphenated-label.json']),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the current package passes the neutral identity gate and the executable verifier', async () => {
  assert.deepEqual(await scanNeutralIdentity(new URL('../../', import.meta.url)), []);
  const result = spawnSync(process.execPath, ['scripts/verify-project.mjs'], {
    cwd: new URL('../../', import.meta.url),
    env: { ...process.env, AUDITA_VERIFY_SKIP_TESTS: '1' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /identidade neutra/iu);
});
