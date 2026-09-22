import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { SAMPLE_AUDIT } from '../fixtures/audits/sample-audit.js';
import { CORE_RULES, validateCoreRuleComposition } from '../src/core/audit.js';
import { NBR17225_ITEMS } from '../src/core/normative/nbr17225.js';
import { renderTechnicalJson } from '../src/core/report/earl-json.js';
import { renderHtmlReport } from '../src/core/report/html.js';
import { renderPdf } from '../src/browser/render-pdf.js';
import { AXE_MV3_CSP_GATE, AXE_PROVENANCE, AXE_RUN_CONFIG } from '../src/browser/axe-adapter.js';
import { ANNOTATION_MAP_MV3_GATE } from '../src/browser/annotation-map.js';
import { scanNeutralIdentity } from './verify-neutral-identity.mjs';
import { verifyStaticReportSecurity } from './verify-report-security.mjs';

const root = new URL('../', import.meta.url);
const text = path => readFile(new URL(path, root), 'utf8');

const manifest = JSON.parse(await text('manifest.json'));
assert.equal(manifest.manifest_version, 3, 'manifest precisa ser MV3');
assert.match(manifest.content_security_policy.extension_pages, /script-src 'self'/u);
assert.doesNotMatch(manifest.content_security_policy.extension_pages, /https?:/u, 'CSP não pode autorizar origem remota');
assert.doesNotMatch(manifest.content_security_policy.extension_pages, /unsafe-eval/iu, 'CSP não pode autorizar eval');

const packageJson = JSON.parse(await text('package.json'));
const lock = JSON.parse(await text('package-lock.json'));
assert.equal(packageJson.devDependencies?.['axe-core'], '4.13.0', 'axe-core precisa de versão exata');
assert.equal(lock.packages?.['']?.devDependencies?.['axe-core'], '4.13.0', 'lock raiz precisa fixar axe-core');
assert.equal(lock.packages?.['node_modules/axe-core']?.version, '4.13.0', 'lock precisa resolver axe-core 4.13.0');
const axeVendorHashes = Object.freeze({
  'axe.js': '138a93a4ce7b7c6c08ed84144e45dcd8cc36d2d4ff8ed673619faf0406906d88',
  'LICENSE': 'af175b9d96ee93c21a036152e1b905b0b95304d4ae8c2c921c7609100ba8df7e',
  'LICENSE-3RD-PARTY.txt': '4f8563870d0fca38bbc3e00b6f670cb7fa9f380ba9f26a7f7d1184a6b18b1653',
});
assert.deepEqual((await readdir(new URL('../vendor/axe/', import.meta.url))).sort(), Object.keys(axeVendorHashes).sort(), 'vendor axe precisa conter somente runtime e licenças');
for (const [name, expected] of Object.entries(axeVendorHashes)) {
  const digest = createHash('sha256').update(await readFile(new URL(`../vendor/axe/${name}`, import.meta.url))).digest('hex');
  assert.equal(digest, expected, `hash oficial divergente: vendor/axe/${name}`);
}
assert.equal(AXE_PROVENANCE.version, '4.13.0');
assert.equal(AXE_PROVENANCE.runtimeSha256, axeVendorHashes['axe.js']);
assert.equal(AXE_PROVENANCE.packageTarballSha256, '096912f6e77b4b695fc9304b7be65091db42d98de054da674ae222a11cb33f70');
assert.deepEqual(AXE_MV3_CSP_GATE, {
  enabled: true,
  targetSizeEnabled: true,
  code: 'AXE_MV3_CSP_E2E_PASSED',
  testedBrowser: 'Google Chrome for Testing 152.0.7977.64',
}, 'axe e target-size exigem a prova black-box pública desta versão');
assert.deepEqual(AXE_RUN_CONFIG.rules['target-size'], { enabled: true }, 'target-size deve acompanhar o gate axe aprovado');
assert.deepEqual(ANNOTATION_MAP_MV3_GATE, {
  enabled: true,
  code: 'ANNOTATION_MAP_MV3_E2E_PASSED',
  reason: 'Composição local e relatório com mapa validados no percurso público MV3 com confirmação e quatro exportações.',
  testedBrowser: 'Google Chrome for Testing 152.0.7977.64',
}, 'mapa anotado exige a prova pública de composição e exportação aprovada');
assert.doesNotMatch(JSON.stringify(AXE_RUN_CONFIG), /experimental|section508/iu);

assert.equal(CORE_RULES.length, 130);
assert.equal(NBR17225_ITEMS.length, 146);
assert.equal(NBR17225_ITEMS.filter(item => item.classification === 'requirement').length, 96);
assert.equal(NBR17225_ITEMS.filter(item => item.classification === 'recommendation').length, 50);
assert.deepEqual(validateCoreRuleComposition(), [], 'zero erros normativos esperados');

assert.deepEqual(await scanNeutralIdentity(root), [], 'pacote precisa manter identidade neutra');

const html = renderHtmlReport(SAMPLE_AUDIT);
const json = renderTechnicalJson(SAMPLE_AUDIT);
const technical = JSON.parse(json);
assert.match(html, /^<!doctype html>/u, 'assinatura HTML');
assert.equal(technical.assertions.length, 146, 'assinatura JSON e assertions');
verifyStaticReportSecurity(html);
const pdf = await renderPdf({ async command() { return { data: Buffer.from('%PDF-1.7\nfixture adapter').toString('base64') }; } });
assert.equal(new TextDecoder().decode(pdf.bytes.subarray(0, 5)), '%PDF-', 'assinatura %PDF- via adapter');

const failures = await text('fixtures/pages/failures.html');
for (const id of ['content-image-alternative', 'accessible-component-name', 'heading-order', 'form-field-label', 'text-contrast-minimum', 'target-size-minimum', 'frame-title', 'audio-control']) {
  assert.match(failures, new RegExp(`data-expected-rule="${id}"`, 'u'));
}
assert.match(await text('fixtures/pages/manual-review.html'), /data-review-outcome="cantTell"/u);

for (const path of await sourceFiles(new URL('src/', root))) {
  const value = await readFile(path, 'utf8');
  assert.doesNotMatch(value, /TOPSECRET|Bearer\s+[A-Za-z0-9._-]+|api[-_]?key\s*[:=]/iu, `secret scan: ${path}`);
  assert.doesNotMatch(value, /(?:src|href)\s*=\s*["']https?:\/\//iu, `remote executable scan: ${path}`);
}

if (process.env.AUDITA_VERIFY_SKIP_TESTS !== '1') {
  const suite = spawnSync('npm', ['test'], { cwd: new URL('.', root), stdio: 'inherit' });
  assert.equal(suite.status, 0, 'npm test precisa passar');
}

console.log('verify-project: manifest/CSP e axe 4.13.0 aprovados no Chrome for Testing 152.0.7977.64; mapa numerado aprovado; 130/146 (96/50), identidade neutra, HTML/JSON/PDF, fixtures e privacidade GREEN');

async function sourceFiles(directoryUrl) {
  const directory = directoryUrl.pathname;
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(new URL(`${entry.name}/`, directoryUrl)));
    else if (['.js', '.html', '.css'].includes(extname(entry.name))) files.push(path);
  }
  return files;
}
