import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('review page leaves its one polite live announcement to the rendered report and has one h1', async () => {
  const html = await read('src/review/index.html');
  assert.equal((html.match(/<h1\b/gi) ?? []).length, 1);
  assert.match(html, /<h1 class="review-page-title">Relatório de auditoria de acessibilidade<\/h1>/iu);
  assert.match(html, /lang="pt-BR"/i);
  assert.doesNotMatch(html, /aria-live="polite"/i);
  assert.match(html, /id="review-list"/i);
  assert.match(html, /id="review-evaluator"/i);
  assert.match(html, /id="regenerate-report"/i);
  assert.match(html, /id="return-to-page"[^>]*disabled/iu);
  assert.match(html, />Voltar à página auditada e ao painel</iu);
  assert.match(html, /id="report-source-explanation"[^>]*hidden[^>]*>Retorno e destaque na aba original indisponíveis: a auditoria usou uma cópia temporária e não alterou a aba original\.<\/p>/iu);
  assert.match(html, /href="#report-root"[^>]*>Voltar ao (?:início|sumário) do relatório/iu);
  assert.doesNotMatch(html, /href="\.\.\/panel\/index\.html"/iu);
  assert.doesNotMatch(html, /<script(?![^>]+src=)|<style\b|\sstyle=/i);
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//i);
});

test('review script renders snippets inertly, offers the four lay answers and never auto-selects', async () => {
  const source = await read('src/review/review.js');
  assert.match(source, /createElement/);
  assert.match(source, /isSafeEvidenceImageUrl/);
  assert.match(source, /textContent/);
  assert.doesNotMatch(source, /innerHTML/);
  for (const answer of ['conforme', 'não conforme', 'não foi possível determinar', 'não se aplica']) assert.match(source, new RegExp(answer, 'u'));
  assert.match(source, /LAY_ANSWERS/u);
  assert.match(source, /REPORT_PAGE_AID/u);
  assert.match(source, /revise: true/u);
  assert.match(source, /Pular revisão/);
  assert.match(source, /REPORT_CONNECT/u);
  assert.match(source, /\['result',\s*'view-only'\]\.includes\(connection\.state\)/u);
  assert.match(source, /GET_HIGHLIGHT_AVAILABILITY/u);
  assert.match(source, /HIGHLIGHT_OCCURRENCE/u);
  assert.match(source, /CLEAR_HIGHLIGHT/u);
  assert.match(source, /REPORT_PORT_NAME/u);
  assert.match(source, /createReportHighlightPolicy/u);
  assert.match(source, /maximumKnown:\s*40/u);
  assert.match(source, /maximumQueued:\s*8/u);
  assert.doesNotMatch(source, /for\s*\(const control of report\.querySelectorAll\('\[data-report-highlight-control\]'\)\)/u);
  assert.match(source, /O destaque foi negado ou perdeu validade/iu);
  assert.match(source, /REPORT_RECONNECT_DELAYS\s*=\s*Object\.freeze\(\[250,\s*1_000,\s*3_000\]\)/u);
  assert.match(source, /event\.state\s*===\s*'clear'[\s\S]*reportHighlightPolicy\.recheckKnown\(\)/u);
  assert.match(source, /REPORT_REQUEST_EXPORT/u);
  assert.match(source, /REPORT_RETURN_TO_SOURCE/u);
  assert.match(source, /REPORT_COMMIT_REVIEW_DECISION/u);
  assert.match(source, /sessionCapabilityId:\s*reportSessionCapabilityId/u);
  assert.match(source, /createAuthorizedReviewDecisionCommitter/u);
  assert.match(source, /loadReportRevision:\s*auditId\s*=>\s*store\.getReportRevision\(auditId\)/u);
  assert.doesNotMatch(source, /REPORT_REVIEW_COMMITTED/u);
  assert.doesNotMatch(source, /createReviewDecisionCommitter/u);
  assert.doesNotMatch(source, /\bstore\s*,\s*controls:/u);
  assert.match(source, /getReportRevision\(id\)/u);
  assert.match(source, /buildCompleteReportSummary/u);
  assert.doesNotMatch(source, /createPanelResultBundleV1/u);
  assert.match(source, /buildReportView/u);
  assert.match(source, /renderReportView/u);
  assert.match(source, /applyReportSourceControls/u);
  assert.match(source, /reportSessionState[\s\S]*view\.executive\.limitations[\s\S]*returnControl:[\s]*returnToPage[\s\S]*explanation:[\s]*reportSourceExplanation/u);
  assert.match(source, /latest\?\.exportCleanupPending\s*===\s*true/u);
  assert.match(source, /arquivo obsoleto.*removido/iu);
  assert.match(source, /Solicitando a geração do relatório/u);
  assert.doesNotMatch(source, /\.checked\s*=\s*true|\.click\(\)/);
  assert.doesNotMatch(source, /\bREQUEST_EXPORT\b|EXPORT_PROGRESS|searchParams\.get\(['"]leaseOwnerId/u);
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
  assert.match(html, /id="delete-audit-dialog-status"/iu);
  assert.doesNotMatch(html, /aria-live="polite"/iu);
  assert.match(html, /id="review-status"[^>]+tabindex="-1"/iu);
  assert.match(html, /evidências[\s\S]*pixels[\s\S]*revisões[\s\S]*downloads/iu);
  assert.match(script, /createDestructiveDialog/u);
  assert.match(script, /REPORT_DELETE_AUDIT/u);
  assert.match(script, /sessionCapabilityId:\s*reportSessionCapabilityId/u);
  assert.doesNotMatch(script, /type:\s*['"](?:REVIEW_COMMITTED|REQUEST_DELETE_AUDIT|REQUEST_DELETE_ALL_AUDITS)['"]/u);
  assert.match(script, /auditId:\s*auditModel\.auditId/u);
  assert.match(script, /parseAuditDeletedEvent/u);
  assert.match(script, /stableFocus:\s*status/u);
  assert.match(script, /deleteAuditController\.completeSuccess\(\)/u);
  assert.doesNotMatch(script, /src\/export\/index\.html/u);
  assert.doesNotMatch(script, /window\.confirm|innerHTML/u);
  assert.match(css, /#delete-audit[^{]*\{[^}]*min-height:\s*2\.75rem/isu);
  assert.match(css, /\*\s*\{[^}]*box-sizing:\s*border-box/isu);
  assert.match(css, /dialog:not\(\[open\]\)[^{]*\{[^}]*display:\s*none/isu);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/iu);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/iu);
});
