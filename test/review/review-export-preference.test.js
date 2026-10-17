import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../../src/review/review.js', import.meta.url), 'utf8');
const requestSource = source.slice(source.indexOf('const EXPORT_CONFIRMATION_TIMEOUT_MS'),
  source.indexOf('\nasync function returnToAuditedPage'));
const EXPORT_CONFIRMATION_TIMEOUT_MS = Number(
  source.slice(source.indexOf('const EXPORT_CONFIRMATION_TIMEOUT_MS')).match(/=\s*([\d_]+)/u)[1].replaceAll('_', ''),
);

test('review forwards explicit export choice; a default request never inherits deletion', async () => {
  const sent = [];
  const request = runInNewContext(`${requestSource}; requestExport`, {
    auditModel: { auditId: 'audit-a' }, reportSessionCapabilityId: 'S'.repeat(22),
    regenerate: {}, status: {}, exportConfirmationTimer: null,
    async sendAuthorizedRequest(build) { sent.push(build('S'.repeat(22))); return { ok: true }; },
    setTimeout: () => 0, clearTimeout: () => {},
  });
  await request({ deleteAfterCompleteExport: true });
  await request();
  assert.deepEqual(sent.map(value => value.deleteAfterCompleteExport), [true, false]);
  assert.match(source, /onExport:\s*options\s*=>\s*\{\s*void requestExport\(options\)/u);
});

test('an unconfirmed export stops waiting and says so instead of staying queued', async () => {
  let scheduled = null;
  let cleared = 0;
  const auditModel = { auditId: 'audit-a' };
  const status = { textContent: '' };
  const regenerate = {};
  const request = runInNewContext(`${requestSource}; requestExport`, {
    auditModel, status, regenerate, reportSessionCapabilityId: 'S'.repeat(22), exportConfirmationTimer: null,
    async sendAuthorizedRequest() { return { ok: true }; },
    setTimeout(callback, delayMs) { scheduled = { callback, delayMs }; return 7; },
    clearTimeout() { cleared += 1; },
  });
  await request();
  assert.equal(status.textContent, 'Relatório atualizado na fila de geração.');
  assert.equal(scheduled.delayMs, EXPORT_CONFIRMATION_TIMEOUT_MS);
  assert.equal(cleared, 2, 'a confirmed acknowledgement must cancel the bounded notice');
  // The deadline fires while the same audit is still open: the screen must stop claiming
  // the report is queued and must offer a way forward.
  status.textContent = 'Relatório atualizado na fila de geração.';
  scheduled.callback();
  assert.match(status.textContent, /não foi confirmada/u);
  assert.match(status.textContent, /Tente novamente/u);
  assert.doesNotMatch(status.textContent, /na fila de geração/u);
  assert.equal(regenerate.disabled, false);
  // A deadline that arrives after the auditor has moved on must not overwrite the screen.
  auditModel.auditId = 'audit-b';
  status.textContent = 'estado da auditoria nova';
  scheduled.callback();
  assert.equal(status.textContent, 'estado da auditoria nova');
});

test('the report follows the durable receipt and names a partial delivery instead of staying queued', async () => {
  const { describeExportDelivery, exportDeliveryText } = await import('../../src/export/export-outcome-message.js');
  const watchSource = `${requestSource}; watchExportOutcome`;
  const runWatch = ({ attempts, cleanupPending = false }) => {
    const timers = [];
    const status = { textContent: '' };
    const regenerate = {};
    const watch = runInNewContext(watchSource, {
      auditModel: { auditId: 'audit-a' }, status, regenerate,
      EXPORT_CLEANUP_MESSAGE: 'Um arquivo obsoleto da exportação não pôde ser removido com confirmação; tente gerar o relatório novamente.',
      describeExportDelivery, exportDeliveryText,
      store: {
        async getLatest() {
          if (cleanupPending) return { auditId: 'audit-a', exportAttempt: 2, exportCleanupPending: true };
          const state = attempts.shift();
          return state ? { auditId: 'audit-a', exportAttempt: 2, ...state } : { auditId: 'audit-a', exportAttempt: 2 };
        },
      },
      setTimeout(callback) { timers.push(callback); return timers.length; },
      clearTimeout() {},
      Date,
    });
    return { watch, timers, status, regenerate };
  };
  const flush = () => new Promise(resolve => setImmediate(resolve));

  const partial = runWatch({
    attempts: [{ exportStatus: 'partial', deliveryReceipt: {
      status: 'partial',
      limitations: ['O artefato PDF não concluiu o download (interrompido).'],
      formats: [
        { format: 'html', status: 'complete' },
        { format: 'pdf', status: 'interrupted', failureCode: 'DOWNLOAD_INTERRUPTED' },
      ],
    } }],
  });
  const pending = partial.watch('audit-a', 1);
  await flush();
  assert.equal(partial.timers.length, 1, 'the report polls instead of waiting for a worker event');
  partial.timers.shift()();
  await flush();
  await pending;
  assert.match(partial.status.textContent, /Alguns arquivos do relatório não puderam ser baixados/u);
  assert.match(partial.status.textContent, /PDF: o navegador interrompeu o download/u);
  assert.match(partial.status.textContent, /exporte novamente/u);
  assert.doesNotMatch(partial.status.textContent, /na fila de geração/u);
  assert.equal(partial.regenerate.disabled, false);

  const cleanup = runWatch({ attempts: [], cleanupPending: true });
  const cleanupPending = cleanup.watch('audit-a', 1);
  await flush();
  cleanup.timers.shift()();
  await flush();
  await cleanupPending;
  assert.match(cleanup.status.textContent, /arquivo obsoleto da exportação/u);
  assert.doesNotMatch(cleanup.status.textContent, /na fila de geração/u);
});

test('regenerate uses the same current checkbox choice as the main export button', () => {
  const start = source.indexOf("regenerate.addEventListener('click'");
  const handler = source.slice(start, source.indexOf('\nreturnToPage.addEventListener', start));
  assert.ok(handler);
  const values = [];
  runInNewContext(handler, {
    regenerate: { addEventListener(_type, callback) { callback(); } },
    document: { querySelector() { return { checked: true }; } },
    requestExport(options) { values.push(options?.deleteAfterCompleteExport); },
  });
  assert.deepEqual(values, [true]);
});

test('the report summary line names checks and occurrences instead of calling occurrences failures', () => {
  const lineSource = source.slice(source.indexOf('function reportStatusLine('), source.indexOf('\nvoid start()'));
  const line = runInNewContext(`${lineSource}; reportStatusLine`, {})(
    { counts: { errors: { checkKeys: 4, occurrences: 5 }, humanReview: { checkKeys: 7, occurrences: 7 } }, checklist: [1, 2, 3] },
  );
  assert.equal(line, '4 verificações com falha confirmada (5 ocorrências); 7 verificações sob revisão humana (7 ocorrências). Checklist separado: 3 verificações ainda sem conclusão.');
  const single = runInNewContext(`${lineSource}; reportStatusLine`, {})(
    { counts: { errors: { checkKeys: 1, occurrences: 1 }, humanReview: { checkKeys: 0, occurrences: 0 } }, checklist: [1] },
  );
  assert.equal(single, '1 verificação com falha confirmada (1 ocorrência); 0 verificações sob revisão humana (0 ocorrências). Checklist separado: 1 verificação ainda sem conclusão.');
  // A missing or hostile summary must still produce a readable line, never "undefined".
  const hostile = runInNewContext(`${lineSource}; reportStatusLine`, {})({});
  assert.doesNotMatch(hostile, /undefined|NaN/u);
  assert.match(hostile, /^0 verificações com falha confirmada/u);
});
