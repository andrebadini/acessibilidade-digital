import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('review page is local, keyboard-friendly and has one live status and one h1', async () => {
  const html = await read('src/review/index.html');
  assert.equal((html.match(/<h1\b/gi) ?? []).length, 1);
  assert.match(html, /lang="pt-BR"/i);
  assert.match(html, /aria-live="polite"/i);
  assert.match(html, /id="review-list"/i);
  assert.match(html, /id="review-evaluator"/i);
  assert.match(html, /id="regenerate-report"/i);
  assert.doesNotMatch(html, /<script(?![^>]+src=)|<style\b|\sstyle=/i);
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//i);
});

test('review script renders snippets inertly, offers exactly three answers and never auto-selects', async () => {
  const source = await read('src/review/review.js');
  assert.match(source, /createElement/);
  assert.match(source, /isSafeEvidenceImageUrl/);
  assert.match(source, /textContent/);
  assert.doesNotMatch(source, /innerHTML/);
  for (const answer of ['conforme', 'não conforme', 'não foi possível determinar']) assert.match(source, new RegExp(answer, 'u'));
  assert.match(source, /Pular revisão/);
  assert.match(source, /REQUEST_EXPORT/);
  assert.match(source, /REVIEW_COMMITTED/u);
  assert.match(source, /exportRevision:\s*committed\.exportRevision/u);
  assert.match(source, /restoreExportEventState\(latest\)/u);
  assert.match(source, /latest\?\.exportCleanupPending\s*===\s*true/u);
  assert.match(source, /arquivo obsoleto.*removido/iu);
  assert.match(source, /Solicitando a geração do relatório/u);
  assert.doesNotMatch(source, /\.checked\s*=\s*true|\.click\(\)/);
});

test('review uses the canonical ABNT item id and isolates a divergent printed id in an editorial note', async () => {
  const source = await read('src/review/review.js');
  assert.match(source, /ABNT NBR 17225[^`]*\$\{item\.id\}/u);
  assert.doesNotMatch(source, /item\.printedId\s*\|\|\s*item\.id/u);
  assert.match(source, /item\.printedId\s*!==\s*item\.id[\s\S]*Nota editorial:[^`]*\$\{item\.printedId\}/u);
});

test('review offers a correlated accessible delete-one dialog without exposing the audited URL', async () => {
  const [html, script, css] = await Promise.all([
    read('src/review/index.html'), read('src/review/review.js'), read('src/review/review.css'),
  ]);
  assert.match(html, /id="delete-audit"/u);
  assert.match(html, /<dialog[^>]+id="delete-audit-dialog"[^>]+aria-labelledby="delete-audit-title"[^>]+aria-describedby="delete-audit-description"/iu);
  assert.match(html, /<dialog[^>]+id="delete-audit-dialog"[^>]+aria-hidden="true"/iu);
  assert.match(html, /id="delete-audit-dialog-status"[^>]+role="status"[^>]+aria-live="polite"/iu);
  assert.match(html, /evidências[\s\S]*pixels[\s\S]*revisões[\s\S]*downloads/iu);
  assert.match(script, /createDestructiveDialog/u);
  assert.match(script, /REQUEST_DELETE_AUDIT/u);
  assert.match(script, /auditId:\s*auditModel\.auditId/u);
  assert.match(script, /parseAuditDeletedEvent/u);
  assert.doesNotMatch(script, /src\/export\/index\.html/u);
  assert.doesNotMatch(script, /window\.confirm|innerHTML/u);
  assert.match(css, /#delete-audit[^{]*\{[^}]*min-height:\s*2\.75rem/isu);
  assert.match(css, /\*\s*\{[^}]*box-sizing:\s*border-box/isu);
  assert.match(css, /dialog:not\(\[open\]\)[^{]*\{[^}]*display:\s*none/isu);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/iu);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/iu);
});
