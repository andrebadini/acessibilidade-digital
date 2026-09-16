import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, launchUnpackedExtension, resolveRealChromeTestBinary, evaluate, waitForValue } from './support/real-chrome.mjs';

// The report names the version that performed the audit, and that version comes from the running
// manifest through chrome.runtime.getManifest, not from a constant. The frozen production
// candidate 1.1.14 was reviewed at a fixed SHA while the source kept moving, so a package carrying
// new code under an old number would make every report misstate its own provenance. This pins the
// chain end to end: manifest, runtime, audit model, rendered report.
const DOCUMENT = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Versão</title></head>
<body><main><h1>Versão</h1><input id="sem-rotulo" type="text"></main></body></html>`;

test('the report records the version that performed the audit', { timeout: 300_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([
    ['/v', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: DOCUMENT }],
  ]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/v`, chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
    viewport: { width: 1280, height: 900 },
  });
  const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(
    fileURLToPath(new URL('../../manifest.json', import.meta.url)), 'utf8'));
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/u, 'o manifesto precisa de uma versão válida');
  assert.equal(manifest.version_name, manifest.version, 'version e version_name precisam concordar');

  const panel = await extension.openSidePanelFromAction();
  await panel.command('Page.bringToFront');
  await waitForValue(panel, 'document.visibilityState', value => value === 'visible', { timeoutMs: 10_000 });
  await waitForValue(panel, `(() => {
    const input = document.querySelector('input[data-capture-mode="no-pixels"]');
    const button = document.querySelector('button[data-intent="START_ATTACHED"]');
    return Boolean(input && !input.disabled && button && !button.disabled);
  })()`, value => value === true, { timeoutMs: 30_000, intervalMs: 50 });
  await extension.click(panel, 'input[data-capture-mode="no-pixels"]');
  await extension.click(panel, 'button[data-intent="START_ATTACHED"]');
  const auditId = await waitForValue(panel, `document.querySelector('[data-screen="result"]')?.dataset.auditId ?? null`,
    value => typeof value === 'string' && value.length > 0, { timeoutMs: 120_000, intervalMs: 100 });
  await extension.click(panel, 'button[data-intent="OPEN_REPORT"]');
  const report = await extension.waitForReport({ auditId });
  await waitForValue(report, `Boolean(document.querySelector('button[data-report-export]'))`, value => value === true, { timeoutMs: 30_000 });

  const line = await evaluate(report,
    `[...document.querySelectorAll('p')].map(node => node.textContent).find(text => /Versão da extensão/u.test(text ?? '')) ?? null`);
  assert.ok(line, 'o relatório precisa declarar a versão que realizou a auditoria');
  assert.ok(line.includes(manifest.version),
    `o relatório registra a versão do manifesto em execução: esperado ${manifest.version}, obtido "${line}"`);
  t.diagnostic(`versão declarada pela auditoria: ${line}`);
});
