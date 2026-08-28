import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('reopened panel hydrates the persisted export attempt correlation', async () => {
  const source = await readFile(new URL('../../src/panel/panel.js', import.meta.url), 'utf8');
  assert.match(source, /restoreExportEventState\(saved\)/u);
  assert.match(source, /GET_LAST_AUDIT/u);
});

test('panel exposes an explicit accessible single-page or URL-list audit form', async () => {
  const [html, script, css] = await Promise.all([
    readFile(new URL('../../src/panel/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../../src/panel/panel.js', import.meta.url), 'utf8'),
    readFile(new URL('../../src/panel/panel.css', import.meta.url), 'utf8'),
  ]);
  const auditSection = html.match(/<form[^>]+id="audit-form"[\s\S]*?<\/form>/u)?.[0] ?? '';
  assert.match(auditSection, /<fieldset[\s\S]*type="radio"[\s\S]*value="single"[\s\S]*value="batch"/iu);
  assert.match(auditSection, /<textarea[^>]+id="audit-urls"[^>]+aria-describedby="batch-help batch-errors batch-warnings"/iu);
  assert.match(auditSection, /uma por linha[^<]*até 20/iu);
  assert.match(auditSection, /id="batch-errors"/u);
  assert.match(auditSection, /id="batch-warnings"/u);
  assert.match(html, /id="batch-progress"/u);
  assert.match(html, /id="batch-summary"/u);
  assert.match(html, /id="cancel-audit"/u);
  assert.match(html, /sessão atual[\s\S]*URLs[\s\S]*pixels/iu);
  assert.equal((html.match(/id="audit-status"[^>]*aria-live="polite"/gu) ?? []).length, 1);
  assert.match(script, /START_BATCH/u);
  assert.match(script, /CANCEL_AUDIT/u);
  assert.match(script, /normalizeUrlList/u);
  assert.match(script, /renderBatchWarnings/u);
  assert.match(css, /#cancel-audit[^{]*\{[^}]*min-height:\s*2\.75rem/isu);
  assert.match(css, /\.audit-mode label[^{]*\{[^}]*min-height:\s*2\.75rem/isu);
  assert.match(css, /\.product-header[^{]*\{[^}]*flex-wrap:\s*wrap/isu);
});

test('panel exposes explicit 30-day retention controls and a confirmed delete-all dialog', async () => {
  const [html, script, css] = await Promise.all([
    readFile(new URL('../../src/panel/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../../src/panel/panel.js', import.meta.url), 'utf8'),
    readFile(new URL('../../src/panel/panel.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /URLs sanitizadas[\s\S]*pixels[\s\S]*nada é enviado[\s\S]*até 30 dias[\s\S]*downloads/iu);
  assert.match(html, /id="delete-after-export"[^>]*type="checkbox"/iu);
  assert.match(html, /Excluir esta auditoria local depois que HTML, JSON-LD, CSV e PDF forem baixados com sucesso/iu);
  assert.match(html, /id="delete-all-audits"/u);
  assert.match(html, /<dialog[^>]+id="delete-all-dialog"[^>]+aria-labelledby="delete-all-title"[^>]+aria-describedby="delete-all-description"/iu);
  assert.match(html, /<dialog[^>]+id="delete-all-dialog"[^>]+aria-hidden="true"/iu);
  assert.match(html, /id="delete-all-dialog-status"[^>]+role="status"[^>]+aria-live="polite"/iu);
  assert.match(html, /todas as auditorias locais[\s\S]*downloads/iu);
  assert.match(script, /createDestructiveDialog/u);
  assert.match(script, /deleteAfterCompleteExport:\s*deleteAfterExport\.checked/u);
  assert.match(script, /REQUEST_DELETE_ALL_AUDITS/u);
  assert.doesNotMatch(script, /window\.confirm|innerHTML/u);
  assert.match(css, /#delete-all-audits[^{]*\{[^}]*min-height:\s*2\.75rem/isu);
  assert.match(css, /dialog:not\(\[open\]\)[^{]*\{[^}]*display:\s*none/isu);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/iu);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/iu);
});

test('panel exposes three reversible persona modes and complete simulated-reader controls', async () => {
  const [html, script, css] = await Promise.all([
    readFile(new URL('../../src/panel/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../../src/panel/panel.js', import.meta.url), 'utf8'),
    readFile(new URL('../../src/panel/panel.css', import.meta.url), 'utf8'),
  ]);
  const personaSection = html.match(/<section[^>]+id="persona-section"[\s\S]*?<\/section>/u)?.[0] ?? '';
  assert.notEqual(personaSection, '');
  assert.equal((personaSection.match(/aria-pressed="false"/gu) ?? []).length, 3);
  for (const id of [
    'persona-mode-reader', 'persona-mode-achromatopsia', 'persona-mode-motor',
    'persona-reader-toggle', 'persona-reader-stop', 'persona-reader-repeat',
    'persona-reader-previous', 'persona-reader-next', 'persona-voice', 'persona-rate',
    'persona-caption', 'persona-go-target', 'persona-live-status', 'persona-disabled-reason',
  ]) assert.match(personaSection, new RegExp(`id="${id}"`, 'u'));
  assert.match(personaSection, /fallback DOM/iu);
  assert.match(personaSection, /VoiceOver[\s\S]*NVDA[\s\S]*JAWS/iu);
  assert.match(personaSection, /não substitui/iu);
  assert.match(personaSection, /Escape[^<]*três|três[^<]*Escape/iu);
  assert.match(personaSection, /campos editáveis e áreas marcadas como privadas são omitidos/iu);
  assert.match(personaSection, /ao parar ou substituir a fala própria[^.]*falas enfileiradas depois podem ser afetadas/iu);
  assert.equal((personaSection.match(/aria-live="polite"/gu) ?? []).length, 1);
  assert.doesNotMatch(personaSection.match(/id="persona-caption"[^>]*>/u)?.[0] ?? '', /aria-live/iu);
  assert.match(personaSection.match(/id="persona-caption"[^>]*>/u)?.[0] ?? '', /dir="auto"/iu);

  assert.match(script, /chrome\.runtime\.connect\(\{\s*name:\s*'audita-persona-v1'/u);
  assert.match(script, /queuePersonaCommand/u);
  assert.match(script, /reducePersonaState/u);
  assert.match(script, /playback\s*===\s*'idle'[\s\S]{0,180}Iniciar novamente/u);
  assert.match(css, /min-height:\s*2\.75rem/iu);
  assert.match(css, /\.persona-card\s+\.secondary-action:disabled\s*\{[^}]*background:\s*#e6edf2[^}]*color:\s*#2f3b45[^}]*opacity:\s*1/isu);
  assert.match(css, /body\s*\{[^}]*min-width:\s*min\(20rem,\s*100%\)/isu,
    'a largura mínima deve ceder ao espaço útil quando a barra vertical reduz o viewport');
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/iu);
});

test('injected persona stylesheet is local, reversible and pointer-transparent', async () => {
  const source = await readFile(new URL('../../src/personas/personas.css', import.meta.url), 'utf8');
  for (const className of [
    'audita-persona-reader', 'audita-persona-reader-overlay', 'audita-persona-reader-marker',
    'audita-persona-achromatopsia', 'audita-persona-motor',
  ]) assert.match(source, new RegExp(`\\.${className}`, 'u'));
  assert.match(source, /filter:\s*grayscale\(1\)/iu);
  assert.match(source, /html\[data-audita-persona-root="audita-accessible-preview-v1"\]\.audita-persona-achromatopsia/iu);
  assert.match(source, /html\[data-audita-persona-root="audita-accessible-preview-v1"\]\.audita-persona-motor/iu);
  assert.match(source, /html\[data-audita-persona-root="audita-accessible-preview-v1"\][\s\S]*\[data-audita-persona-owned="audita-accessible-preview-v1"\]/iu);
  assert.match(source, /pointer-events:\s*none/iu);
  assert.doesNotMatch(source, /https?:|@import|url\s*\(/iu);
});
