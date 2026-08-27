import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { SAMPLE_AUDIT } from '../fixtures/audits/sample-audit.js';
import { CORE_RULES, validateCoreRuleComposition } from '../src/core/audit.js';
import { NBR17225_ITEMS } from '../src/core/normative/nbr17225.js';
import { renderTechnicalJson } from '../src/core/report/earl-json.js';
import { renderHtmlReport } from '../src/core/report/html.js';
import { renderPdf } from '../src/browser/render-pdf.js';
import { scanNeutralIdentity } from './verify-neutral-identity.mjs';

const root = new URL('../', import.meta.url);
const text = path => readFile(new URL(path, root), 'utf8');

const manifest = JSON.parse(await text('manifest.json'));
assert.equal(manifest.manifest_version, 3, 'manifest precisa ser MV3');
assert.match(manifest.content_security_policy.extension_pages, /script-src 'self'/u);
assert.doesNotMatch(manifest.content_security_policy.extension_pages, /https?:/u, 'CSP não pode autorizar origem remota');

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
assert.doesNotMatch(html, /<script\b|(?:src|href)="https?:/iu, 'relatório autocontido e sem execução remota');
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

console.log('verify-project: manifest, 130/146 (96/50), identidade neutra, HTML/JSON/PDF, fixtures, privacidade e suíte GREEN');

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
