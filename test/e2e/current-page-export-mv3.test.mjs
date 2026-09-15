import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, launchUnpackedExtension, resolveRealChromeTestBinary, evaluate, waitForValue, waitForFourDownloads } from './support/real-chrome.mjs';

// The current-page audit stores a review-ready model whose artifact is still pending, so its
// export takes the immutable revision path. That path must accept an honest partial receipt
// and deliver the four artifacts for real: this is the exact journey that used to fail with
// "Recibo completo da revisão imutável inválido." while closing the export tab silently.
const DOCUMENT = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Exportação da página atual</title></head>
<body><main><h1>Página avaliada</h1>
<img id="missing-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
<button id="missing-name"></button><input id="missing-label" type="text">
<a href="/current">clique aqui</a></main></body></html>`;

test('current-page audit exports four verified artifacts', { timeout: 420_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([
    ['/current', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: DOCUMENT }],
  ]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/current`, chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
    viewport: { width: 1280, height: 900 }, downloadMode: 'profile',
  });
  const panel = await extension.openSidePanelFromAction();
  await panel.command('Page.bringToFront');
  await waitForValue(panel, 'document.visibilityState', value => value === 'visible', { timeoutMs: 10_000 });
  await waitForValue(panel, `(() => {
    const input=document.querySelector('input[data-capture-mode="no-pixels"]');
    const button=document.querySelector('button[data-intent="START_ATTACHED"]');
    return Boolean(input&&!input.disabled&&button&&!button.disabled);
  })()`, value => value === true, { timeoutMs: 30_000, intervalMs: 50 });
  const sourceUrl = await evaluate(extension.startPage.page, 'location.href');
  await extension.click(panel, 'input[data-capture-mode="no-pixels"]');
  await extension.click(panel, 'button[data-intent="START_ATTACHED"]');
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const screen = await evaluate(panel, `document.querySelector('[data-screen]')?.dataset.screen ?? null`).catch(() => null);
    if (screen === 'result') break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const auditId = await extension.readAttribute(panel, '[data-screen="result"]', 'data-audit-id');
  assert.match(auditId ?? '', /^[A-Za-z0-9._:-]{1,160}$/u);

  await extension.click(panel, 'button[data-intent="OPEN_REPORT"]');
  const report = await extension.waitForReport({ auditId });
  await waitForValue(report, `Boolean(document.querySelector('button[data-report-export]'))`, value => value === true, { timeoutMs: 30_000 });
  await extension.click(report, 'button[data-report-export]');

  // The durable four-format receipt is the proof: it hashes the bytes that landed on disk.
  const downloads = await waitForFourDownloads(extension, { auditId, timeoutMs: 120_000, intervalMs: 250 });
  assert.deepEqual(downloads.map(record => record.format), ['html', 'pdf', 'csv', 'json']);
  for (const record of downloads) {
    assert.equal(record.state, 'complete', record.format);
    assert.ok(record.byteLength > 0, record.format);
    assert.match(record.sha256, /^[a-f0-9]{64}$/u, record.format);
  }
  // The source page must not have been navigated by the export.
  assert.equal(await evaluate(extension.startPage.page, 'location.href'), sourceUrl);
  await extension.close();
});
