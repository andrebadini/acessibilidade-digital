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
