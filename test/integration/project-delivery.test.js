import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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

test('project verifier is an executable ESM checklist with suite, signatures, privacy and brand gates', async () => {
  const source = await read('scripts/verify-project.mjs');
  for (const gate of ['npm', 'validateCoreRuleComposition', 'gov-mt-logo.png', '%PDF-', 'TOPSECRET', 'manifest']) {
    assert.match(source, new RegExp(gate.replaceAll('.', '\\.'), 'u'));
  }
});
