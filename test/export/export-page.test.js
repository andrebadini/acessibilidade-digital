import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('internal export page authenticates first, rebuilds one stored revision and completes from a durable receipt', async () => {
  const [html, script, css, completion] = await Promise.all([
    read('src/export/index.html'), read('src/export/index.js'), read('src/export/export.css'),
    read('src/export/export-completion.js'),
  ]);
  assert.match(html, /lang="pt-BR"/u);
  assert.equal((html.match(/<h1\b/giu) ?? []).length, 1);
  assert.match(html, /aria-live="polite"/u);
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//u);
  assert.doesNotMatch(script, /data:text|URL\.createObjectURL/u);
  assert.match(script, /runReportExport|createAuditStore/u);
  assert.match(script, /createExportSuccessRequest/u);
  assert.match(script, /persistExportSuccess/u);
  assert.match(script, /type:\s*'EXPORT_CONNECT'/u);
  assert.match(script, /deriveExportLeaseOwner/u);
  assert.match(script, /getReportRevision/u);
  assert.match(script, /verifyAuditIntegritySnapshot/u);
  assert.match(script, /buildCompleteReportSummary/u);
  assert.doesNotMatch(script, /createPanelResultBundleV1/u);
  assert.match(script, /buildReportView/u);
  assert.ok(script.indexOf('await store.claimExportLease') < script.indexOf('const result = await runReportExport'));
  assert.doesNotMatch(script, /runReportExport\(\{[^}]*deliveryAt\s*:/u,
    'a caller must not be able to select the public artifact timestamp');
  assert.match(script, /assertDelivery\([\s\S]*store\.assertExportLease/u,
    'the export must obtain its delivery identity from the persisted lease assertion');
  assert.ok(script.indexOf('reconcileStaleDownloads') < script.indexOf('const result = await runReportExport'));
  assert.match(script, /recordExportDelivery/u);
  assert.match(script, /resolveExportDelivery/u);
  assert.ok(script.indexOf('await store.claimExportLease') < script.indexOf('await store.beginExportDelivery'));
  assert.ok(script.indexOf('await store.beginExportDelivery') < script.indexOf('const result = await runReportExport'));
  assert.ok(script.indexOf('const result = await runReportExport') < script.indexOf('await persistExportSuccess'));
  assert.ok(script.indexOf('await persistExportSuccess') < script.indexOf('await confirmExportCompletion'));
  assert.match(script, /completionPending\s*=\s*true[\s\S]*confirmExportCompletion/u);
  assert.match(script, /awaitExportCompletionAcknowledgement/u);
  assert.match(script, /send:\s*sendWorkerRequest[\s\S]*wait:\s*delay/u,
    'completion acknowledgement must retry while the export tab remains alive');
  assert.match(script, /setTimeout\(\(\) => finish\(\{ ok: false \}\), 5_000\)/u,
    'a missing worker callback must not block the export tab forever');
  assert.match(script, /if \(completionPending\)[\s\S]*return;/u,
    'a transient acknowledgement failure must preserve the durable receipt and active export tab for retry');
  assert.match(script, /shouldPreserveExportTabAndLease[\s\S]*await recoverPendingDownloadCleanup\(error\)/u,
    'download cleanup ownership must remain in the live export tab until durable recovery finishes');
  assert.ok(script.indexOf('await recoverPendingDownloadCleanup(error)') < script.indexOf('await persistAndCloseFailure(error)'),
    'cleanup recovery must finish before failure persistence can release the lease');
  assert.match(script, /isPendingReportReservationError\(error\)[\s\S]*await recoverPendingReportReservation\(error\)/u,
    'a late persistent reservation must be adopted by its live export tab');
  assert.ok(script.indexOf('await recoverPendingReportReservation(error)') < script.indexOf('await persistAndCloseFailure(error)'),
    'reservation ownership must settle before failure persistence can release the lease');
  assert.match(script, /advancePendingDownloadOwnership\(error[\s\S]*advancePendingExportCleanup/u,
    'an adopted asynchronous download source must settle before an empty journal can release the tab');
  assert.doesNotMatch(script, /navigator\.locks|request\(['"]audita-export/u);
  assert.match(script, /if \(!busy\) await closeOwnTab\(\)/u);
  assert.match(completion, /type:\s*'EXPORT_COMPLETE'[\s\S]*sessionCapabilityId[\s\S]*attemptId/u);
  assert.match(script, /mimeType,\s*byteSize,\s*sha256/u);
  assert.doesNotMatch(script, /searchParams\.get\(['"](?:leaseOwnerId|exportAttempt|revision|capability)/u);
  assert.doesNotMatch(script, /notify\(\{\s*type:\s*'AUDIT_DELETED'/u,
    'somente o worker validado pode publicar o evento visual de exclusão');
  assert.match(html, /HTML[\s\S]*PDF[\s\S]*CSV[\s\S]*JSON/iu);
  assert.match(html, /beta[^.]*permanece no armazenamento local[^.]*exportação/iu);
  assert.match(html, /Excluir auditoria local[^.]*página do relatório/iu);
  assert.doesNotMatch(html, /exclusão[^.]*escolhida antes/iu);
  assert.match(html, /arquivos já baixados[^.]*não são apagados/iu);
  assert.doesNotMatch(html, /<button|<input/iu);
  assert.match(css, /@media\s*\(max-width:\s*24rem\)/u);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/u);
});
