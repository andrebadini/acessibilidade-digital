import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('internal export page claims a persistent lease before generation and keeps a BUSY duplicate visible', async () => {
  const [html, script, css] = await Promise.all([
    read('src/export/index.html'), read('src/export/index.js'), read('src/export/export.css'),
  ]);
  assert.match(html, /lang="pt-BR"/u);
  assert.equal((html.match(/<h1\b/giu) ?? []).length, 1);
  assert.match(html, /aria-live="polite"/u);
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//u);
  assert.doesNotMatch(script, /data:text|URL\.createObjectURL/u);
  assert.match(script, /runReportExport|createAuditStore/u);
  assert.match(script, /leaseOwnerId/u);
  assert.match(script, /exportAttempt/u);
  assert.ok(script.indexOf('await store.claimExportLease') < script.indexOf('const result = await runReportExport'));
  assert.ok(script.indexOf('reconcileStaleDownloads') < script.indexOf('const result = await runReportExport'));
  assert.match(script, /recordExportDelivery/u);
  assert.match(script, /resolveExportDelivery/u);
  assert.ok(script.indexOf('await store.claimExportLease') < script.indexOf('await store.commitAuditIfRevisionWithExportLease'));
  assert.doesNotMatch(script, /navigator\.locks|request\(['"]audita-export/u);
  assert.match(script, /if \(!busy\) await closeOwnTab\(\)/u);
  assert.match(script, /if \(leaseClaimed && \(persistedFailure \|\| busy\)\)/u);
  assert.match(script, /EXPORT_INVALIDATED/u);
  assert.match(script, /refreshed\.exportAttempt\s*===\s*exportAttempt/u);
  assert.match(script, /exportCleanupPending\s*===\s*true/u);
  assert.match(script, /arquivo obsoleto.*removido/iu);
  assert.match(script, /exportRevision:[\s\S]*exportAttempt[\s\S]*leaseOwnerId/u);
  assert.doesNotMatch(script, /notify\(\{\s*type:\s*'AUDIT_DELETED'/u,
    'somente o worker validado pode publicar o evento visual de exclusão');
  assert.match(html, /HTML[\s\S]*JSON-LD[\s\S]*CSV[\s\S]*PDF/iu);
  assert.match(html, /exclusão[^.]*escolhida antes[^.]*quatro downloads[^.]*sucesso/iu);
  assert.match(html, /arquivos já baixados[^.]*não são apagados/iu);
  assert.doesNotMatch(html, /<button|<input/iu);
  assert.match(css, /@media\s*\(max-width:\s*24rem\)/u);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/u);
});
