import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  cancelDownload, launchUnpackedExtension, readDownloadState, readExportDeliveryJournal,
  readLatestExportState, resolveRealChromeTestBinary, startFixtureServer, waitForValue,
} from './support/real-chrome.mjs';

// O dono do produto pode ter "Perguntar onde salvar cada arquivo" ligado. Com a janela nativa
// aberta, o prazo do download não pode vencer: o app espera a decisão da pessoa. Cancelar um
// formato precisa produzir DOWNLOAD_CANCELLED (não "interrompido" nem tempo esgotado) e a tela
// precisa dizer, em português simples, que o salvamento foi cancelado.
const DOCUMENT = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Diálogo de salvamento</title></head>
<body><main><h1>Página avaliada</h1>
<img id="missing-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
<button id="missing-name">Botão sem nome</button><input id="missing-label" type="text">
</main></body></html>`;

const summaryState = `(() => {
  const root = document.querySelector('[data-screen="result"]');
  return { screen: document.querySelector('[data-screen]')?.dataset.screen ?? null,
    auditId: root?.dataset.auditId ?? null };
})()`;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('an open save dialog outlives the deadline and cancelling one format is reported honestly', { timeout: 600_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([
    ['/pagina', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: DOCUMENT }],
  ]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/pagina`, chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
    // 2560×1300 é uma das duas janelas grandes exigidas nesta rodada.
    viewport: { width: 2560, height: 1300 }, downloadMode: 'profile-prompt',
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
  await extension.click(panel, 'button[data-intent="OPEN_REPORT"]');
  const report = await extension.waitForReport({ auditId: summary.auditId });
  await waitForValue(report, `(() => {
    const button = document.querySelector('button[data-report-export-format="pdf"]');
    return Boolean(button && !button.disabled);
  })()`, value => value === true, { timeoutMs: 60_000, intervalMs: 100 });

  await extension.click(report, 'button[data-report-export-format="pdf"]');
  // O journal grava o id físico assim que o Chrome aceita o download; com o diálogo aberto o
  // item fica `in_progress` e sem nome de arquivo escolhido.
  let entry = null;
  await waitForValue(extension.harnessPage, `(async () => {
    const store = (await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
    return store.getExportDeliveryJournal(${JSON.stringify(summary.auditId)});
  })()`, value => {
    const pdf = Array.isArray(value) ? value.find(row => row?.format === 'pdf' && row.state === 'in-flight') : null;
    if (pdf && Number.isSafeInteger(pdf.downloadId) && pdf.downloadId >= 0) { entry = pdf; return true; }
    return false;
  }, { timeoutMs: 120_000, intervalMs: 100, awaitPromise: true });
  assert.ok(entry, 'the PDF download must be physically registered before the dialog opens');
  const downloadId = entry.downloadId;

  const opened = await waitForValue(extension.harnessPage, `(async () => {
    const [item] = await chrome.downloads.search({ id: ${downloadId} });
    return item ? { state: item.state, filename: item.filename } : null;
  })()`, value => value?.state === 'in_progress', { timeoutMs: 30_000, intervalMs: 100, awaitPromise: true });
  assert.equal(opened.filename, '', 'the save dialog must be open with no destination chosen yet');

  // O prazo padrão do download é 30 s. Com o diálogo aberto por mais tempo, o app precisa
  // renovar a espera em vez de encerrar o arquivo por tempo esgotado.
  await sleep(36_000);
  const stillOpen = await readDownloadState(extension, downloadId);
  assert.equal(stillOpen?.state, 'in_progress', 'the dialog must still be waiting after the original deadline');
  const duringDialog = await readLatestExportState(extension, summary.auditId);
  assert.notEqual(duringDialog?.exportStatus, 'failed',
    'an open dialog must not be turned into a download timeout failure');

  await cancelDownload(extension, downloadId);
  const terminal = await waitForValue(extension.harnessPage, `(async () => {
    const store = (await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
    return store.getLatest();
  })()`, value => value?.auditId === summary.auditId &&
    ['partial', 'complete', 'failed'].includes(value?.exportStatus), { timeoutMs: 120_000, intervalMs: 200, awaitPromise: true });
  assert.equal(terminal.exportStatus, 'partial');
  const pdf = terminal.deliveryReceipt?.formats?.find(row => row.format === 'pdf');
  assert.equal(pdf?.status, 'interrupted');
  assert.equal(pdf?.failureCode, 'DOWNLOAD_CANCELLED');
  assert.ok(terminal.deliveryReceipt.limitations.includes('O download do artefato PDF foi cancelado por você.'));
  assert.equal(terminal.deliveryReceipt.formats.some(row => row.failureCode === 'DOWNLOAD_WAIT_TIMEOUT'), false);
  assert.equal(terminal.deliveryReceipt.formats.some(row => row.failureCode === 'DOWNLOAD_INTERRUPTED'), false);

  const result = await waitForValue(report,
    `document.querySelector('[data-report-export-result="pdf"]')?.textContent??''`,
    value => /você cancelou o salvamento/u.test(value), { timeoutMs: 90_000, intervalMs: 100 });
  assert.equal(result, 'PDF não foi baixado: você cancelou o salvamento.');
  const status = await waitForValue(report, `document.querySelector('#review-status')?.textContent??''`,
    value => /você cancelou o salvamento/u.test(value), { timeoutMs: 90_000, intervalMs: 100 });
  assert.match(status, /exporte novamente e confirme o salvamento na janela do navegador/u);
  const files = await readdir(extension.downloadDirectory);
  assert.deepEqual(files.filter(name => /\.pdf$/iu.test(name)), [],
    'a cancelled save must not leave a PDF file behind');
  t.diagnostic(`prompt ok; audit=${summary.auditId}; cancelled download=${downloadId}`);
});
