import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  launchUnpackedExtension, readLatestExportState, resolveRealChromeTestBinary,
  startFixtureServer, waitForValue,
} from './support/real-chrome.mjs';

// Cada botão do grupo "Baixar relatório" pede só o seu formato. O recibo durável e o arquivo
// apontado pelo `downloadId` são a prova: uma exportação por vez, sem acumular formatos de
// pedidos anteriores e sem abrir a aba de impressão para CSV, JSON ou HTML.
const DOCUMENT = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Botões de formato</title></head>
<body><main><h1>Página avaliada</h1>
<img id="missing-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
<button id="missing-name">Botão sem nome</button><input id="missing-label" type="text">
</main></body></html>`;

const LABELS = Object.freeze({ pdf: 'PDF', html: 'HTML', csv: 'CSV', json: 'JSON' });
const summaryState = `(() => {
  const root = document.querySelector('[data-screen="result"]');
  return { screen: document.querySelector('[data-screen]')?.dataset.screen ?? null,
    auditId: root?.dataset.auditId ?? null };
})()`;

async function directoryFiles(extension) {
  return new Set((await readdir(extension.downloadDirectory)).filter(name => !name.startsWith('.')));
}

function onlyNew(before, after) {
  return [...after].filter(name => !before.has(name));
}

async function startAudit(t, viewport) {
  const fixture = await startFixtureServer(t, new Map([
    ['/pagina', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: DOCUMENT }],
  ]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/pagina`, chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
    viewport, downloadMode: 'profile',
  });
  const panel = await extension.openSidePanelFromAction();
  await panel.command('Page.bringToFront');
  await waitForValue(panel, `(() => {
    const input = document.querySelector('input[data-capture-mode="no-pixels"]');
    const button = document.querySelector('button[data-intent="START_ATTACHED"]');
    return Boolean(input && !input.disabled && button && !button.disabled);
  })()`, value => value === true, { timeoutMs: 30_000, intervalMs: 50 });
  await extension.click(panel, 'input[data-capture-mode="no-pixels"]');
  await extension.click(panel, 'button[data-intent="START_ATTACHED"]');
  const summary = await waitForValue(panel, summaryState, value => value?.screen === 'result',
    { timeoutMs: 120_000, intervalMs: 100 });
  assert.match(summary.auditId ?? '', /^[A-Za-z0-9._:-]{1,160}$/u);
  await extension.click(panel, 'button[data-intent="OPEN_REPORT"]');
  const report = await extension.waitForReport({ auditId: summary.auditId });
  await waitForValue(report, `(() => {
    const buttons = [...document.querySelectorAll('button[data-report-export-format]')];
    return buttons.length === 4 && buttons.every(button => !button.disabled);
  })()`, value => value === true, { timeoutMs: 60_000, intervalMs: 100 });
  return { extension, report, auditId: summary.auditId };
}

async function clickOneFormat({ extension, report, auditId }, format) {
  const before = await directoryFiles(extension);
  await extension.click(report, `button[data-report-export-format="${format}"]`);
  const downloads = await extension.waitForDownloads({ auditId, formats: [format], timeoutMs: 300_000, intervalMs: 250 });
  assert.deepEqual(downloads.map(row => row.format), [format]);
  assert.equal(downloads[0].state, 'complete');
  assert.ok(downloads[0].byteLength > 0);
  assert.match(downloads[0].sha256, /^[a-f0-9]{64}$/u);
  const result = await waitForValue(report,
    `document.querySelector('[data-report-export-result="${format}"]')?.textContent??''`,
    value => value === `${LABELS[format]} baixado.`, { timeoutMs: 90_000, intervalMs: 100 });
  assert.equal(result, `${LABELS[format]} baixado.`);
  const added = onlyNew(before, await directoryFiles(extension));
  assert.equal(added.length, 1, `one click must add exactly one file: ${added.join(', ')}`);
  assert.ok(added[0].toLowerCase().endsWith(`.${format}`), added[0]);
  const latest = await readLatestExportState(extension, auditId);
  const receiptFormats = latest?.deliveryReceipt?.formats?.map(row => row.format) ?? [];
  assert.deepEqual(receiptFormats, [format], 'the durable receipt describes only this request');
  return downloads[0];
}

test('each report format button downloads only its file, sequential requests stay separate and "all" brings four', { timeout: 900_000 }, async t => {
  // A viewport larga está entre as duas exigidas para esta rodada (1920×1080 e 2560×1300).
  const viewport = process.env.AUDITA_E2E_VIEWPORT === '2560x1300'
    ? { width: 2560, height: 1300 } : { width: 1920, height: 1080 };
  const { extension, report, auditId } = await startAudit(t, viewport);
  const seen = [];
  for (const format of ['pdf', 'html', 'csv', 'json']) {
    const record = await clickOneFormat({ extension, report, auditId }, format);
    seen.push(record);
    // O que já foi baixado permanece na pasta: o pedido seguinte não apaga nem substitui.
    const files = await directoryFiles(extension);
    for (const previous of seen) assert.ok(files.has(previous.filename), previous.filename);
  }

  const beforeAll = await directoryFiles(extension);
  await extension.click(report, 'button[data-report-export]');
  const all = await extension.waitForDownloads({
    auditId, formats: ['html', 'pdf', 'csv', 'json'], timeoutMs: 300_000, intervalMs: 250,
  });
  assert.deepEqual(all.map(row => row.format), ['html', 'pdf', 'csv', 'json']);
  const added = onlyNew(beforeAll, await directoryFiles(extension));
  assert.deepEqual(added.map(name => name.slice(name.lastIndexOf('.') + 1)).sort(), ['csv', 'html', 'json', 'pdf']);
  const latest = await readLatestExportState(extension, auditId);
  assert.equal(latest.exportStatus, 'complete', JSON.stringify(latest?.deliveryReceipt?.limitations ?? []));
  assert.deepEqual(latest.deliveryReceipt.formats.map(row => row.format), ['html', 'pdf', 'csv', 'json']);
  // Os formatos que não usam a aba de impressão não deixaram aba residual para trás.
  const exportTabs = (await extension.runtimeContexts({ contextTypes: ['TAB'] }))
    .filter(context => context.documentUrl?.includes('/src/export/index.html'));
  assert.deepEqual(exportTabs, [], 'the export tab must close after a confirmed delivery');
  t.diagnostic(`buttons ok; audit=${auditId}; viewport=${viewport.width}x${viewport.height}; ` +
    `files=${[...(await directoryFiles(extension))].length}`);
});
