import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('internal export page authenticates first, rebuilds one stored revision and completes from a durable receipt', async () => {
  const [html, script, css] = await Promise.all([
    read('src/export/index.html'), read('src/export/index.js'), read('src/export/export.css'),
  ]);
  assert.match(html, /lang="pt-BR"/u);
  assert.equal((html.match(/<h1\b/giu) ?? []).length, 1);
  assert.match(html, /aria-live="polite"/u);
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//u);
  assert.doesNotMatch(script, /data:text|URL\.createObjectURL/u);
  assert.match(script, /runReportExport|createAuditStore/u);
  assert.match(script, /type:\s*'EXPORT_CONNECT'/u);
  assert.match(script, /deriveExportLeaseOwner/u);
  assert.match(script, /getReportRevision/u);
  assert.match(script, /verifyAuditIntegritySnapshot/u);
  assert.match(script, /buildReportView/u);
  assert.ok(script.indexOf('await store.claimExportLease') < script.indexOf('const result = await runReportExport'));
  assert.ok(script.indexOf('reconcileStaleDownloads') < script.indexOf('const result = await runReportExport'));
  assert.match(script, /recordExportDelivery/u);
  assert.match(script, /resolveExportDelivery/u);
  assert.ok(script.indexOf('await store.claimExportLease') < script.indexOf('await store.beginExportDelivery'));
  assert.ok(script.indexOf('await store.beginExportDelivery') < script.indexOf('const result = await runReportExport'));
  assert.doesNotMatch(script, /commitAuditIfRevisionWithExportLease/u,
    'a exportação autorizada não pode criar uma revisão diferente da revisão reconstruída');
  assert.doesNotMatch(script, /navigator\.locks|request\(['"]audita-export/u);
  assert.match(script, /if \(!busy\) await closeOwnTab\(\)/u);
  assert.match(script, /type:\s*'EXPORT_COMPLETE'[\s\S]*sessionCapabilityId[\s\S]*attemptId/u);
  assert.match(script, /mimeType,\s*byteSize,\s*sha256/u);
  assert.doesNotMatch(script, /searchParams\.get\(['"](?:leaseOwnerId|exportAttempt|revision|capability)/u);
  assert.doesNotMatch(script, /notify\(\{\s*type:\s*'AUDIT_DELETED'/u,
    'somente o worker validado pode publicar o evento visual de exclusão');
  assert.match(html, /HTML[\s\S]*PDF[\s\S]*CSV[\s\S]*JSON/iu);
  assert.match(html, /exclusão[^.]*escolhida antes[^.]*quatro downloads[^.]*sucesso/iu);
  assert.match(html, /arquivos já baixados[^.]*não são apagados/iu);
  assert.doesNotMatch(html, /<button|<input/iu);
  assert.match(css, /@media\s*\(max-width:\s*24rem\)/u);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/u);
});
