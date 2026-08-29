import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { hashAnnotationMapArtifact } from '../../src/core/evidence/annotation-map-artifact.js';
import { createAnnotationMapFixture, createPristineMapSource, TEST_PNG } from './annotation-map-fixture.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { applyReviewDecisions, createReviewDecision } from '../../src/core/review/decisions.js';
import { CONSUMER_ACCESSIBILITY_FIXED_BASIS } from '../../src/core/legal/consumer-basis.js';
import { SECTION508_REVISED_CROSSWALK, section508ReferencesForWcag } from '../../src/core/normative/section508.js';

function occurrenceCard(html, occurrenceId) {
  const marker = `data-occurrence-id="${occurrenceId}"`;
  const markerIndex = html.indexOf(marker);
  assert.notEqual(markerIndex, -1, `ocorrência ${occurrenceId} ausente`);
  const start = html.lastIndexOf('<article', markerIndex);
  const end = html.indexOf('</article>', markerIndex);
  assert.ok(start >= 0 && end > markerIndex, `cartão da ocorrência ${occurrenceId} ausente`);
  return html.slice(start, end + '</article>'.length);
}

function reviewDecision(occurrenceId, itemId, answer, mode) {
  return createReviewDecision({
    auditId: SAMPLE_AUDIT.auditId,
    itemId,
    occurrenceId,
    answer,
    evaluator: 'Fiscal de teste',
    decidedAt: '2026-08-26T15:00:00.000Z',
    mode,
  });
}

function setCoreRuleInapplicable(input, ruleId) {
  const rule = input.ruleResults.find(value => value.ruleId === ruleId);
  assert.ok(rule, `regra ${ruleId} ausente na fixture`);
  rule.outcome = 'inapplicable';
  rule.targets = [];
  for (const itemId of rule.nbrItems) {
    const item = input.itemResults.find(value => value.id === itemId);
    assert.ok(item, `item ${itemId} ausente na fixture`);
    item.outcome = 'inapplicable';
  }
}

function withFailedRecommendation() {
  const input = structuredClone(SAMPLE_AUDIT);
  const item = input.itemResults.find(value => value.id === '5.1.5');
  const rule = input.ruleResults.find(value => value.ruleId === 'focusable-elements-interactive');
  assert.ok(rule, 'regra focusable-elements-interactive ausente na fixture');
  item.outcome = 'failed';
  item.ruleResults = ['focusable-elements-interactive'];
  Object.assign(rule, {
    ruleId: 'focusable-elements-interactive', outcome: 'failed', mode: 'assisted', nbrItems: ['5.1.5'],
    wcag: item.wcag.map(reference => reference.id),
    targets: [], summary: 'O uso do foco observado requer correção.', limitations: [],
    source: { engine: 'audita-core', ruleId: 'focusable-elements-interactive', version: '1.0.0' },
  });
  const wcagRefs = item.wcag.map(reference => reference.id);
  input.occurrences.push({
    occurrenceId: 'occ-recommendation-failed', pageId: 'page-1', outcome: 'failed',
    classification: 'recommendation', impact: 'serious', confidence: 'high',
    source: { engine: 'audita-core', ruleId: 'focusable-elements-interactive', version: '1.0.0' },
    nbrItemRef: item.id, itemWcagRefs: [...wcagRefs], sourceWcagRefs: [...wcagRefs], testedWcagRefs: [...wcagRefs],
    wcagRefs, foreignBenchmarkRefs: [...section508ReferencesForWcag(wcagRefs)],
    target: { nodeId: null, selector: null, framePath: [] }, accessiblePreview: null,
    evidenceRefs: ['ev-full'], legalAnalysis: { basisRef: CONSUMER_ACCESSIBILITY_FIXED_BASIS.id },
    itemId: item.id, ruleId: 'focusable-elements-interactive', mode: 'assisted', nodeId: null,
    evidenceIds: ['ev-full'], justification: 'O uso do foco observado requer correção.',
  });
  return input;
}

function withEditorialFailure() {
  const input = structuredClone(SAMPLE_AUDIT);
  input.methodology.supplementalRuleCount += 1;
  input.methodology.ruleCount += 1;
  input.ruleResults.push({
    ruleId: 'editorial.placeholder-text', outcome: 'failed', mode: 'automated',
    classification: 'editorial', impact: 'minor', confidence: 'high',
    source: { engine: 'audita-editorial', ruleId: 'editorial.placeholder-text', version: '1.0.0' },
    nbrItems: [], wcag: [], targets: [{
      nodeId: 'n-editorial', selectorHint: '',
      message: 'Substitua o conteúdo provisório antes da publicação.',
      data: { reason: 'placeholder-text' },
    }],
    summary: 'Há conteúdo provisório inequívoco na página.', limitations: [],
  });
  input.occurrences.push({
    occurrenceId: 'occ-editorial', pageId: 'page-1', outcome: 'failed',
    classification: 'editorial', impact: 'minor', confidence: 'high',
    source: { engine: 'audita-editorial', ruleId: 'editorial.placeholder-text', version: '1.0.0' },
    nbrItemRef: null, itemWcagRefs: [], sourceWcagRefs: [], testedWcagRefs: [], wcagRefs: [], foreignBenchmarkRefs: [],
    target: { nodeId: 'n-editorial', selector: null, framePath: [] }, accessiblePreview: null,
    evidenceRefs: [], legalAnalysis: null, itemId: null, ruleId: 'editorial.placeholder-text',
    mode: 'automated', nodeId: 'n-editorial', evidenceIds: [],
    justification: 'Há conteúdo provisório inequívoco na página.',
  });
  return input;
}

function withPages(count) {
  const input = structuredClone(SAMPLE_AUDIT);
  const statuses = ['complete', 'partial', 'failed', 'cancelled'];
  input.pages = Array.from({ length: count }, (_, index) => ({
    ...input.pages[0],
    pageId: `page-${index + 1}`,
    requestedUrl: `https://example.test/${index === count - 1 ? 'segmento-muito-longo-'.repeat(30) : ''}${index + 1}`,
    finalUrl: `https://example.test/final-${index + 1}`,
    status: statuses[index % statuses.length],
  }));
  input.requestedScope = count === 1
    ? { mode: 'single', urls: [input.pages[0].requestedUrl] }
    : { mode: 'batch', urls: input.pages.map(page => page.requestedUrl) };
  input.requestedUrl = input.pages[0].requestedUrl;
  input.finalUrl = input.pages[0].finalUrl;
  input.environment.viewport = structuredClone(input.pages[0].viewport);
  if (count === 1) {
    input.pages[0].status = input.session.status;
  } else {
    const pageStatuses = input.pages.map(page => page.status);
    input.session.status = pageStatuses.includes('cancelled')
      ? 'cancelled'
      : pageStatuses.every(status => status === 'complete')
        ? 'complete'
        : pageStatuses.every(status => status === 'failed') ? 'failed' : 'partial';
    input.session.partial = input.session.status === 'partial';
  }
  return input;
}

test('renders a complete pt-BR report with one accessible heading hierarchy', () => {
  const html = renderHtmlReport(SAMPLE_AUDIT);
  assert.match(html, /^<!doctype html>/iu);
  assert.match(html, /<html lang="pt-BR">/u);
  assert.match(html, /<title>Relatório de auditoria — Audita Acessibilidade<\/title>/u);
  assert.match(html, /href="#conteudo"[^>]*>Ir para o conteúdo principal/u);
  assert.equal((html.match(/<h1\b/gu) || []).length, 1);
  const levels = [...html.matchAll(/<h([1-6])\b/gu)].map(match => Number(match[1]));
  for (let index = 1; index < levels.length; index += 1) assert.ok(levels[index] <= levels[index - 1] + 1, `salto h${levels[index - 1]} → h${levels[index]}`);
  assert.match(html, /<main id="conteudo"/u);
});

test('renders all report sections, 146 items, occurrences and evidence records', () => {
  const html = renderHtmlReport(SAMPLE_AUDIT);
  for (const label of [
    'Identidade, escopo e estado da auditoria', 'Sumário executivo', 'Ações e filtros', 'Ocorrências priorizadas',
    'Mapa visual da prévia de anúncios', 'Revisão humana', 'Inventário de recursos de acessibilidade',
    'Matriz completa dos 146 itens', 'Anexos de evidências', 'Metodologia, proveniência e integridade',
  ]) assert.match(html, new RegExp(label, 'u'));
  assert.equal((html.match(/data-report-item=/gu) || []).length, 146);
  for (const item of SAMPLE_AUDIT.itemResults) assert.match(html, new RegExp(`>${item.id.replaceAll('.', '\\.')}(?:<| —)`, 'u'));
  for (const occurrence of SAMPLE_AUDIT.occurrences) assert.match(html, new RegExp(occurrence.occurrenceId, 'u'));
  for (const evidence of SAMPLE_AUDIT.evidence) assert.match(html, new RegExp(evidence.evidenceId, 'u'));
  assert.match(html, /Prévia de anúncio/u);
  assert.match(html, /não é transcrição literal|pode variar conforme o navegador/iu);
  assert.match(html, /relógio local[^.]*não[^.]*carimbo[^.]*certificado/iu);
  assert.match(html, /SHA-256/u);
});

test('renders item context separately from source and tested WCAG plus the frozen source ledger', () => {
  const html = renderHtmlReport(SAMPLE_AUDIT);
  const occurrence = SAMPLE_AUDIT.occurrences.find(value => value.occurrenceId === 'occ-focus-review');
  const card = occurrenceCard(html, occurrence.occurrenceId);
  assert.match(card, /Contexto integral do item ABNT/iu);
  assert.match(card, /Critérios mapeados pela fonte/iu);
  assert.match(card, /Critérios efetivamente testados[\s\S]{0,80}Nenhum/iu);
  assert.doesNotMatch(card, /Section 508[^<]*2\.4\.3/iu);
  assert.match(html, /ABNT-NBR-17225-Acessibilidade-Digital\.pdf/u);
  assert.match(html, /1c3ee66b7fd606367e3de087e6a55fea90f4d368d8a1f769141d5e3b96d32afc/u);
  assert.match(html, /https:\/\/www\.w3\.org\/TR\/WCAG22\//u);
  assert.match(html, /https:\/\/www\.access-board\.gov\/ict\//u);
  assert.match(html, /https:\/\/www\.section508\.gov\/develop\/applicability-conformance\//u);
});

test('embeds occurrence-specific marked screenshots and raw evidence with useful alt and self-contained A4 CSS', () => {
  const html = renderHtmlReport(SAMPLE_AUDIT);
  const images = [...html.matchAll(/<svg\b[^>]*class="evidence-media"[^>]*>[\s\S]*?<\/svg>/gu)].map(match => match[0]);
  assert.equal(images.length, 5);
  for (const image of images) {
    assert.match(image, /role="img"/u);
    assert.match(image, /aria-label="[^"]+"/u);
    assert.doesNotMatch(image, /aria-label=""/u);
    assert.match(image, /<use href="#evidence-image-\d+"[^>]*><\/use>/u);
  }
  assert.equal((html.match(/data:image\/png;base64,/gu) || []).length, 1);
  assert.equal((html.match(/<image\b[^>]*href="data:image\/png;base64,[A-Za-z0-9+/=]+"/gu) || []).length, 1);
  assert.match(html, /class="evidence-highlight evidence-highlight--failed"/u);
  assert.match(html, /Símbolo ✕ e moldura sólida[^<]*não atendimento técnico/iu);
  assert.match(html, /class="evidence-highlight evidence-highlight--review"/u);
  assert.match(html, /Símbolo \? e moldura tracejada[^<]*revisão humana/iu);
  assert.match(html, /marcação é derivada[^.]*PNG original[^.]*hash/iu);
  assert.match(html, /<style>[^]*@page\s*\{[^}]*size:\s*A4/iu);
  assert.match(html, /thead\s*\{[^}]*display:\s*table-header-group/iu);
  assert.equal((html.match(/<script>/gu) || []).length, 1);
  assert.doesNotMatch(html, /<script[^>]+src=|<link\b|@import|url\(\s*["']?https?:|<(?:img|source)[^>]+src=["']https?:/iu);
});

test('positions the automatic highlight from capture metadata without using color alone', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.evidence[1].metadata = {
    width: 128, height: 88,
    highlightBox: { x: 24, y: 24, width: 80, height: 40, coordinateSpace: 'capture-css-px' },
  };

  const html = renderHtmlReport(createAuditModel(input));
  assert.match(html, /<rect class="evidence-highlight evidence-highlight--(?:failed|review)" x="24" y="24" width="80" height="40" aria-hidden="true"><\/rect>/u);
  assert.match(html, /aria-hidden="true"/u);
  assert.match(html, /Símbolo ✕ e moldura sólida[^<]*não atendimento técnico/iu);
  assert.match(html, /Símbolo \? e moldura tracejada[^<]*revisão humana/iu);
});

test('changes occurrence evidence from review to red after a nonconformity decision', () => {
  const reviewed = applyReviewDecisions(SAMPLE_AUDIT, [
    reviewDecision('occ-focus-review', '5.1.4', 'não conforme', 'assisted'),
  ]);
  const html = renderHtmlReport(reviewed);
  const card = occurrenceCard(html, 'occ-focus-review');
  assert.equal(reviewed.occurrences.find(value => value.occurrenceId === 'occ-focus-review').legalAnalysis, null);
  assert.match(card, /data-outcome="cantTell"[^>]*data-display-outcome="failed"/u);
  assert.match(card, /status--failed[\s\S]*Não atendido neste teste/u);
  assert.match(card, /evidence-highlight--failed/u);
  assert.match(card, /Símbolo ✕ e moldura sólida[^<]*não atendimento técnico/iu);
  assert.match(card, /class="legal-analysis"/u);
  for (const fixedText of [
    CONSUMER_ACCESSIBILITY_FIXED_BASIS.label,
    CONSUMER_ACCESSIBILITY_FIXED_BASIS.display,
    CONSUMER_ACCESSIBILITY_FIXED_BASIS.qualification,
    CONSUMER_ACCESSIBILITY_FIXED_BASIS.currentTextCaveatRef,
  ]) assert.match(card, new RegExp(fixedText.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.doesNotMatch(card, /evidence-highlight--review/u);
  assert.ok(html.indexOf('data-occurrence-id="occ-focus-review"') < html.indexOf('data-occurrence-id="occ-cross-page"'));
  assert.match(html, /<h3>Não atendidas<\/h3><strong>2<\/strong>/u);
  assert.match(html, /<h3>Revisão humana<\/h3><strong>1<\/strong>/u);
  assert.match(html, /<h2 id="revisao-titulo">Revisão humana<\/h2>/u);
  assert.match(html, /1 pendente[^<]*1 concluída/iu);
});

test('changes occurrence evidence from review to green after a conformity decision', () => {
  const reviewed = applyReviewDecisions(SAMPLE_AUDIT, [
    reviewDecision('occ-cross-page', '5.7.5', 'conforme', 'manual'),
  ]);
  const card = occurrenceCard(renderHtmlReport(reviewed), 'occ-cross-page');
  assert.match(card, /status--passed[\s\S]*Atendido no escopo observado/u);
  assert.match(card, /page-level-evidence--passed/u);
  assert.match(card, /Símbolo ✓ e moldura dupla[^<]*atendimento confirmado/iu);
  assert.doesNotMatch(card, /page-level-evidence--review/u);
});

test('keeps occurrence evidence amber after an inconclusive review decision', () => {
  const reviewed = applyReviewDecisions(SAMPLE_AUDIT, [
    reviewDecision('occ-focus-review', '5.1.4', 'não foi possível determinar', 'assisted'),
  ]);
  const card = occurrenceCard(renderHtmlReport(reviewed), 'occ-focus-review');
  assert.match(card, /status--cantTell[\s\S]*Requer revisão humana/u);
  assert.match(card, /evidence-highlight--review/u);
  assert.match(card, /Símbolo \? e moldura tracejada[^<]*revisão humana/iu);
});

test('embeds a shared large PNG once when fifty occurrences reuse it', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  const dataUrl = `data:image/png;base64,${readFileSync(new URL('../../store-assets/screenshot-panel.png', import.meta.url)).toString('base64')}`;
  input.evidence = [{
    ...input.evidence[0],
    dataUrl,
  }];
  const sourceOccurrence = input.occurrences.find(value => value.occurrenceId === 'occ-focus-review');
  const sourceReview = input.manualReview.find(value => value.occurrenceId === 'occ-focus-review');
  input.occurrences = Array.from({ length: 50 }, (_, index) => ({
    ...sourceOccurrence,
    occurrenceId: `occ-shared-${index + 1}`,
    nodeId: `n-shared-${index + 1}`,
    target: {
      ...structuredClone(sourceOccurrence.target),
      nodeId: `n-shared-${index + 1}`,
    },
    evidenceIds: ['ev-full'],
    evidenceRefs: ['ev-full'],
  }));
  input.ruleResults.find(value => value.ruleId === 'focus-order').targets =
    input.occurrences.map(occurrence => occurrence.nodeId);
  setCoreRuleInapplicable(input, 'focus-visible');
  input.manualReview = input.occurrences.map(occurrence => ({
    ...sourceReview,
    occurrenceId: occurrence.occurrenceId,
  }));

  const html = renderHtmlReport(createAuditModel(input));
  assert.equal((html.match(/class="occurrence-card"/gu) || []).length, 50);
  assert.equal(html.split(dataUrl).length - 1, 1);
  assert.equal((html.match(/<use href="#evidence-image-0"[^>]*><\/use>/gu) || []).length, 51);
});

test('keeps normative tables semantic and bounded by narrow report viewports', () => {
  const html = renderHtmlReport(SAMPLE_AUDIT);
  assert.match(html, /<div class="matrix-scroll" role="region"[^>]*tabindex="0"><table><thead><tr><th scope="col">Item<\/th>/u);
  assert.match(html, /table\s*\{[^}]*width:\s*100%/iu);
  assert.match(html, /\.matrix-scroll\{[^}]*overflow-x:\s*auto/iu);
  assert.match(html, /p,li,dd,dt,th,td,code\{[^}]*overflow-wrap:\s*anywhere/iu);
  assert.match(html, /\.meta\{[^}]*grid-template-columns:minmax\([^,]+,[^)]+\) minmax\(0,1fr\)/u);
});

test('escapes hostile audited strings in text, attributes, code, URLs and media', () => {
  const hostile = '</style><script>alert(1)</script><img src=x onerror=alert(2)>';
  const input = structuredClone(SAMPLE_AUDIT);
  input.scope.description = hostile;
  input.occurrences[0].justification = hostile;
  input.evidence[1].snippet = `<button aria-label="${hostile}">x</button>`;
  input.evidence[1].selector.css = `#x"]{background:url(https://evil.test/x)}`;
  const html = renderHtmlReport(createAuditModel(input));
  assert.equal((html.match(/<script>/gu) || []).length, 1);
  assert.doesNotMatch(html, /<img\s+src=x|\s(?:onerror|onload)=["'][^>]*>|(?:src|href)=["']javascript:|>javascript:/iu);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(html, /&lt;button aria-label=&quot;/u);
  assert.equal((html.match(/<svg\b[^>]*class="evidence-media"/gu) || []).length, 5);
  for (const mutate of [
    value => { value.evidence[1].mediaUrl = 'javascript:alert(3)'; },
    value => { value.evidence[1].dataUrl = 'data:image/svg+xml,<svg onload=alert(4)>'; },
    value => { value.evidence[1].backendNodeId = `41</dd><script>alert(5)</script>`; },
  ]) {
    const nonCanonical = structuredClone(SAMPLE_AUDIT);
    mutate(nonCanonical);
    assert.throws(() => createAuditModel(nonCanonical), /modelo|evidência|URL/iu);
  }
  const forgedTitle = structuredClone(SAMPLE_AUDIT);
  forgedTitle.itemResults[0].title = `Título ${hostile}`;
  assert.throws(() => renderHtmlReport(forgedTitle), /normativ|title|item/i);
});

test('rejects exact script and style breakout payloads in report counts', () => {
  for (const payload of [
    '</style><script>alert(1)</script>',
    '</style><style>body{display:none}</style>',
  ]) {
    const input = structuredClone(SAMPLE_AUDIT);
    input.methodology.ruleCount = payload;
    assert.throws(() => renderHtmlReport(input), /metodologia|regra|inteiro|count/i);
  }
  const html = renderHtmlReport(SAMPLE_AUDIT);
  assert.doesNotMatch(html, /<\/style><(?:script|style)>/iu);
});

test('communicates every state with visible icon and text rather than color alone', () => {
  const states = {
    passed: 'Atendido no escopo observado', failed: 'Não atendido neste teste',
    cantTell: 'Requer revisão humana', inapplicable: 'Não aplicável', untested: 'Não testado',
  };
  const html = renderHtmlReport(SAMPLE_AUDIT);
  for (const [outcome, label] of Object.entries(states)) {
    assert.match(html, new RegExp(`<span class="status status--${outcome}"><span aria-hidden="true">[^<]+</span><span>${label}</span>`, 'u'));
  }
});

test('renders the approved ten-section information hierarchy before technical methodology', () => {
  const html = renderHtmlReport(SAMPLE_AUDIT);
  const headings = [
    'Identidade, escopo e estado da auditoria',
    'Sumário executivo',
    'Ações e filtros',
    'Ocorrências priorizadas',
    'Mapa visual da prévia de anúncios',
    'Revisão humana',
    'Inventário de recursos de acessibilidade',
    'Matriz completa dos 146 itens',
    'Anexos de evidências',
    'Metodologia, proveniência e integridade',
  ];
  let previous = -1;
  for (const heading of headings) {
    const index = html.indexOf(`>${heading}</h2>`);
    assert.ok(index > previous, `${heading} deve aparecer na ordem aprovada`);
    previous = index;
  }
  assert.ok(html.indexOf('occ-focus-failed') < html.indexOf('data-report-item="5.1.1"'));
  assert.match(html, /não gera indicador numérico/iu);
  assert.doesNotMatch(html, /percentual de conformidade/iu);
});

test('resolves the immutable consumer basis for every failed ABNT occurrence including recommendations', () => {
  const html = renderHtmlReport(withFailedRecommendation());
  const failedRequirement = occurrenceCard(html, 'occ-focus-failed');
  const failedRecommendation = occurrenceCard(html, 'occ-recommendation-failed');
  const humanReview = occurrenceCard(html, 'occ-focus-review');
  for (const card of [failedRequirement, failedRecommendation]) {
    assert.match(card, new RegExp(CONSUMER_ACCESSIBILITY_FIXED_BASIS.label, 'u'));
    assert.match(card, new RegExp(CONSUMER_ACCESSIBILITY_FIXED_BASIS.display.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.match(card, new RegExp(CONSUMER_ACCESSIBILITY_FIXED_BASIS.qualification.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.match(card, /Ressalva ao texto vigente/iu);
  }
  assert.match(failedRecommendation, /Recomendação ABNT/u);
  assert.doesNotMatch(humanReview, /Base consumerista padronizada para análise/u);
  assert.equal((html.match(/class="legal-analysis"/gu) || []).length, 2);
});

test('keeps engine result, human decision and derived display state visibly separate', () => {
  const reviewed = applyReviewDecisions(SAMPLE_AUDIT, [
    reviewDecision('occ-focus-review', '5.1.4', 'não conforme', 'assisted'),
  ]);
  const card = occurrenceCard(renderHtmlReport(reviewed), 'occ-focus-review');
  assert.match(card, /Resultado do motor[^<]*Requer revisão humana/iu);
  assert.match(card, /Decisão humana[^<]*Não conforme/iu);
  assert.match(card, /Estado consolidado[^<]*Não atendido neste teste/iu);
});

test('uses curated supplemental summaries and never attaches legal or normative claims to editorial findings', () => {
  const html = renderHtmlReport(withEditorialFailure());
  const card = occurrenceCard(html, 'occ-editorial');
  assert.match(card, /<h3[^>]*>Há conteúdo provisório inequívoco na página\.<\/h3>/u);
  assert.match(card, /chip--editorial[\s\S]*Alerta editorial/u);
  assert.match(card, /Sem mapeamento normativo atribuído/iu);
  assert.doesNotMatch(card, /legal-analysis|Base consumerista padronizada|ABNT NBR 17225:2025:<\/strong> item/iu);
  assert.match(html, /<option value="best-practice">Boa prática suplementar<\/option>/u);
  assert.match(html, /\.chip--best-practice\{[^}]*border-color:#738596/u);
});

test('keeps ABNT, WCAG and qualified Section 508 mapping distinct from the consumer-analysis block', () => {
  const card = occurrenceCard(renderHtmlReport(SAMPLE_AUDIT), 'occ-focus-failed');
  assert.match(card, /ABNT NBR 17225:2025:<\/strong> item 5\.1\.1/u);
  assert.match(card, /Critérios efetivamente testados<\/dt><dd>2\.4\.7 \(nível AA\)/u);
  assert.match(card, new RegExp(SECTION508_REVISED_CROSSWALK.label, 'u'));
  assert.match(card, new RegExp(SECTION508_REVISED_CROSSWALK.qualification.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(card, /class="legal-analysis"/u);
});

test('renders a complete no-JS source, one live region and independent print safeguards', () => {
  const html = renderHtmlReport(SAMPLE_AUDIT);
  assert.equal((html.match(/<select\b[^>]* disabled>/gu) || []).length, 7);
  assert.equal((html.match(/role="status"/gu) || []).length, 1);
  assert.equal((html.match(/aria-live="polite"/gu) || []).length, 1);
  assert.equal((html.match(/<details open data-collapsible>/gu) || []).length, 4);
  assert.match(html, /Sem JavaScript, todas as ocorrências e todos os detalhes permanecem abertos e legíveis/u);
  assert.match(html, /<button type="button" data-clear-filters disabled>Limpar filtros<\/button>/u);
  assert.match(html, /\.occurrence-card\[hidden\]\{display:block!important\}/u);
  assert.match(html, /details:not\(\[open\]\)>\*:not\(summary\)\{display:block!important\}/u);
  assert.match(html, /@media \(forced-colors:active\)/u);
  assert.match(html, /@media \(prefers-reduced-motion:reduce\)/u);
  assert.match(html, /select,button\{[^}]*min-height:44px/u);
});

test('renders present, absent, unknown, partial and not-recorded widget inventory states without changing findings', () => {
  const complete = structuredClone(SAMPLE_AUDIT);
  complete.accessibilityWidgets = {
    detector: 'audita.accessibility-widgets', version: '1.0.0', coverage: 'complete',
    widgets: [
      { id: 'vlibras', status: 'present', signals: ['dom-signature'] },
      { id: 'hand-talk', status: 'absent', signals: [] },
    ],
  };
  const completeHtml = renderHtmlReport(complete);
  assert.match(completeHtml, /data-widget-state="present"[\s\S]*Assinatura detectada/u);
  assert.match(completeHtml, /data-widget-state="absent"[\s\S]*Assinatura não detectada com cobertura completa/u);
  assert.match(completeHtml, /<dt>Escopo de detecção<\/dt><dd>Agregado da sessão; não localizado por página\.<\/dd>/u);
  assert.match(completeHtml, /<dt>Páginas incluídas<\/dt><dd>page-1<\/dd>/u);

  const partial = structuredClone(SAMPLE_AUDIT);
  partial.accessibilityWidgets = {
    detector: 'audita.accessibility-widgets', version: '1.0.0', coverage: 'partial',
    widgets: [
      { id: 'vlibras', status: 'present', signals: ['script-signature'] },
      { id: 'hand-talk', status: 'unknown', signals: [] },
    ],
  };
  const partialHtml = renderHtmlReport(partial);
  assert.match(partialHtml, /Cobertura local parcial/u);
  assert.match(partialHtml, /data-widget-state="unknown"[\s\S]*Não foi possível determinar/u);

  const unavailable = structuredClone(SAMPLE_AUDIT);
  const missingHtml = renderHtmlReport(unavailable);
  assert.match(missingHtml, /Inventário não registrado/u);
  assert.equal((missingHtml.match(/class="widget-card" data-widget-state="unknown"/gu) || []).length, 2);
  for (const html of [completeHtml, partialHtml, missingHtml]) {
    assert.match(html, /3 de 3 ocorrências exibidas/u);
  }
});

test('keeps page states, long URLs and stable map slots for one, three and twenty pages', async () => {
  for (const count of [1, 3, 20]) {
    const html = renderHtmlReport(withPages(count));
    assert.equal((html.match(/data-page-summary=/gu) || []).length, count);
    assert.equal((html.match(/data-announcement-map-page=/gu) || []).length, count);
    assert.equal((html.match(/Mapa indisponível nesta auditoria/gu) || []).length, count);
    assert.match(html, new RegExp(`segmento-muito-longo-${count > 1 ? 'segmento-muito-longo-'.repeat(29) : 'segmento-muito-longo-'.repeat(29)}`, 'u'));
  }
  const batch = renderHtmlReport(withPages(20));
  for (const label of ['Completa', 'Parcial', 'Falhou', 'Cancelada']) assert.match(batch, new RegExp(label, 'u'));

  const mapped = structuredClone(SAMPLE_AUDIT);
  mapped.evidence[0] = createPristineMapSource();
  mapped.evidence.push(await createAnnotationMapFixture());
  const mappedHtml = renderHtmlReport(mapped);
  assert.match(mappedHtml, /data-map-status="complete"/u);
  assert.match(mappedHtml, /class="announcement-map-segment"/u);
  assert.match(mappedHtml, /<ol class="announcement-map-legend"/u);
  assert.match(mappedHtml, /<bdi>Salvar, botão<\/bdi>/u);
  assert.match(mappedHtml, /Evidências derivadas[\s\S]*ev-map/u);
  assert.doesNotMatch(mappedHtml, /Mapa indisponível nesta auditoria/u);
});

test('renders absent, empty, partial, complete and legend-continuation map states honestly and without filter dependence', async () => {
  const renderState = async status => {
    const input = structuredClone(SAMPLE_AUDIT);
    input.evidence[0] = createPristineMapSource();
    if (status !== 'absent') input.evidence.push(await createAnnotationMapFixture({ status }));
    return renderHtmlReport(input);
  };
  const absent = await renderState('absent');
  const empty = await renderState('empty');
  const partial = await renderState('partial');
  const complete = await renderState('complete');

  assert.match(absent, /data-map-status="absent"[\s\S]*Mapa indisponível nesta auditoria/u);
  assert.match(empty, /data-map-status="empty"[\s\S]*Nenhum elemento elegível/u);
  assert.match(partial, /data-map-status="partial"[\s\S]*cobertura parcial/iu);
  assert.match(complete, /data-map-status="complete"[\s\S]*audita\.annotation-map[\s\S]*1\.0\.0/u);
  assert.match(complete, /200 nós[\s\S]*32.000.000 pixels[\s\S]*64 segmentos/u);
  assert.match(complete, /proporção raster imprimível[^.]*1,3:1/iu);
  assert.match(complete, /non-atomic-source-geometry — captura e geometria foram coletadas/iu);
  assert.match(complete, /com marcador 1/iu);
  assert.doesNotMatch(complete, /marcadores 1 a 1/iu);
  assert.match(complete, /Ordem observada DOM\/AX[\s\S]*não é ordem de foco/iu);
  assert.match(complete, /\.map-card,\.announcement-map-segment,\.announcement-map-legend\{min-width:0\}/u);
  assert.match(complete, /\.map-meta code,\.announcement-map-segment figcaption code,\.legend-selector code\{word-break:break-all\}/u);
  assert.doesNotMatch(complete.match(/<section id="mapas"[^]*?<\/section>/u)?.[0] ?? '', /data-impact=|data-wcag=/u);

  const continued = structuredClone(SAMPLE_AUDIT);
  continued.evidence[0] = createPristineMapSource();
  const map = await createAnnotationMapFixture();
  map.segments[0].count = 2;
  map.segments.push({
    segmentId: 'ev-map-segment-2', index: 2, count: 2, role: 'legend-continuation', sourceCssClip: null,
    width: 1, height: 1, dataUrl: TEST_PNG, contentHash: map.segments[0].contentHash,
  });
  map.hash = await hashAnnotationMapArtifact(map);
  continued.evidence.push(map);
  const continuedHtml = renderHtmlReport(continued);
  assert.equal((continuedHtml.match(/class="announcement-map-segment"/gu) || []).length, 2);
  assert.match(continuedHtml, /continuação da legenda/iu);
  assert.equal((continuedHtml.match(/data:image\/png;base64,/gu) || []).length, 1);
});

test('isolates and escapes hostile audited legend text, including bidi controls', async () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.evidence[0] = createPristineMapSource();
  input.evidence.push(await createAnnotationMapFixture({ preview: '<img src=x onerror=alert(1)>\u202Etexto' }));
  const html = renderHtmlReport(input);
  const mapSection = html.match(/<section id="mapas"[^]*?<\/section>/u)?.[0] ?? '';

  assert.match(mapSection, /<bdi>&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.doesNotMatch(mapSection, /<img src=x|\u202E/u);
  assert.match(mapSection, /U\+202E/u);
});

test('prioritizes 750 occurrences in the real DOM across twenty pages while reusing one PNG payload', () => {
  const input = withPages(20);
  const source = input.occurrences[0];
  input.occurrences = Array.from({ length: 750 }, (_, index) => {
    const onFirstPage = index % 20 === 0;
    return {
      ...source,
      occurrenceId: `occ-stress-${index + 1}`,
      pageId: `page-${(index % 20) + 1}`,
      impact: ['critical', 'serious', 'moderate', 'minor'][index % 4],
      evidenceRefs: onFirstPage ? source.evidenceRefs : [],
      evidenceIds: onFirstPage ? source.evidenceIds : [],
    };
  });
  input.manualReview = [];
  const html = renderHtmlReport(input);
  assert.equal((html.match(/class="occurrence-card"/gu) || []).length, 750);
  assert.equal((html.match(/data:image\/png;base64,/gu) || []).length, 1);
  const first = html.indexOf('data-occurrence-id="occ-stress-1"');
  const secondImpact = html.indexOf('data-occurrence-id="occ-stress-2"');
  assert.ok(first >= 0 && secondImpact > first, 'impacto critical deve preceder serious no DOM');
});

test('uses exact CSP hashes for static CSS and script with no executable audited content', async () => {
  const runtime = await import('../../src/core/report/report.js.js').catch(() => ({}));
  assert.equal(typeof runtime.REPORT_SCRIPT, 'string');
  const html = renderHtmlReport(SAMPLE_AUDIT);
  const style = html.match(/<style>([^]*?)<\/style>/u)?.[1];
  const script = html.match(/<script>([^]*?)<\/script>/u)?.[1];
  assert.ok(style && script, 'CSS e script estáticos devem estar incorporados');
  const styleHash = createHash('sha256').update(style).digest('base64');
  const scriptHash = createHash('sha256').update(script).digest('base64');
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/u)?.[1] ?? '';
  assert.match(csp, new RegExp(`style-src 'sha256-${styleHash.replace(/[+\/]/gu, '\\$&')}'`, 'u'));
  assert.match(csp, new RegExp(`script-src 'sha256-${scriptHash.replace(/[+\/]/gu, '\\$&')}'`, 'u'));
  assert.match(csp, /default-src 'none'/u);
  for (const directive of ['connect-src', 'object-src', 'frame-src', 'font-src', 'media-src', 'worker-src']) {
    assert.match(csp, new RegExp(`${directive} 'none'`, 'u'));
  }
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/iu);
  assert.doesNotMatch(script, /\b(?:eval|Function|fetch|XMLHttpRequest|WebSocket|Worker|innerHTML|insertAdjacentHTML|document\.write)\b/u);
  assert.doesNotMatch(html, /<script[^>]+src=|<link\b|@import|url\(\s*["']?https?:/iu);
});

test('escapes hostile text in filter datasets and never turns audited data into selectors', () => {
  const hostile = `x\" data-engine=\"evil\"><script>alert(1)</script>`;
  const input = structuredClone(SAMPLE_AUDIT);
  input.occurrences[0].justification = hostile;
  const html = renderHtmlReport(input);
  const card = occurrenceCard(html, 'occ-focus-failed');
  assert.match(card, /data-impact="moderate"/u);
  assert.match(card, /data-page="page-1"/u);
  assert.match(card, /data-engine="audita-core"/u);
  assert.match(card, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.doesNotMatch(card, /data-engine="evil"|<script>alert/u);
});

test('fails closed when accessibility evidence contains an untrusted current control value', () => {
  const secret = 'TOPSECRET-current-control';
  const input = structuredClone(SAMPLE_AUDIT);
  input.evidence[1].accessibility.value = secret;

  assert.throws(() => renderHtmlReport(input), error => {
    assert.equal(error.code, 'AUDIT_MODEL_INPUT_INVALID');
    assert.doesNotMatch(error.message, new RegExp(secret, 'u'));
    return true;
  });
});
