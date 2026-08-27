import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { renderHtmlReport } from '../../src/core/report/html.js';

test('renders a complete pt-BR report with one accessible heading hierarchy', () => {
  const html = renderHtmlReport(SAMPLE_AUDIT);
  assert.match(html, /^<!doctype html>/iu);
  assert.match(html, /<html lang="pt-BR">/u);
  assert.match(html, /<title>Relatório de auditoria — Audita MT<\/title>/u);
  assert.match(html, /href="#conteudo"[^>]*>Ir para o conteúdo principal/u);
  assert.equal((html.match(/<h1\b/gu) || []).length, 1);
  const levels = [...html.matchAll(/<h([1-6])\b/gu)].map(match => Number(match[1]));
  for (let index = 1; index < levels.length; index += 1) assert.ok(levels[index] <= levels[index - 1] + 1, `salto h${levels[index - 1]} → h${levels[index]}`);
  assert.match(html, /<main id="conteudo"/u);
});

test('renders all report sections, 146 items, occurrences and evidence records', () => {
  const html = renderHtmlReport(SAMPLE_AUDIT);
  for (const label of [
    'Sumário executivo', 'Escopo', 'Metodologia', 'Resultados por item', 'Ocorrências e evidências',
    'Revisão humana', 'Limitações', 'Notas de integridade normativa', 'Fundamentação normativa', 'Manifesto de integridade',
  ]) assert.match(html, new RegExp(label, 'u'));
  assert.equal((html.match(/data-report-item=/gu) || []).length, 146);
  for (const item of SAMPLE_AUDIT.itemResults) assert.match(html, new RegExp(`>${item.id.replaceAll('.', '\\.')}(?:<| —)`, 'u'));
  for (const occurrence of SAMPLE_AUDIT.occurrences) assert.match(html, new RegExp(occurrence.occurrenceId, 'u'));
  for (const evidence of SAMPLE_AUDIT.evidence.artifacts) assert.match(html, new RegExp(evidence.evidenceId, 'u'));
  assert.match(html, /Prévia de anúncio/u);
  assert.match(html, /não é transcrição literal|pode variar conforme o navegador/iu);
  assert.match(html, /relógio local[^.]*não[^.]*carimbo[^.]*certificado/iu);
  assert.match(html, /SHA-256/u);
});

test('embeds occurrence-specific marked screenshots and raw evidence with useful alt and self-contained A4 CSS', () => {
  const html = renderHtmlReport(SAMPLE_AUDIT);
  const images = [...html.matchAll(/<img\b[^>]*>/gu)].map(match => match[0]);
  assert.equal(images.length, 5);
  for (const image of images) {
    assert.match(image, /src="data:image\/png;base64,[A-Za-z0-9+/=]+"/u);
    assert.match(image, /alt="[^"]+"/u);
    assert.doesNotMatch(image, /alt=""/u);
  }
  assert.match(html, /class="evidence-highlight evidence-highlight--failed"/u);
  assert.match(html, /Moldura vermelha[^<]*não conformidade/iu);
  assert.match(html, /class="evidence-highlight evidence-highlight--review"/u);
  assert.match(html, /Moldura âmbar[^<]*revisão humana/iu);
  assert.match(html, /anotação visual[^.]*PNG original[^.]*hash/iu);
  assert.match(html, /<style>[^]*@page\s*\{[^}]*size:\s*A4/iu);
  assert.match(html, /thead\s*\{[^}]*display:\s*table-header-group/iu);
  assert.doesNotMatch(html, /<script\b|<link\b|@import|url\(\s*["']?https?:|<(?:img|source)[^>]+src=["']https?:/iu);
});

test('positions the automatic highlight from capture metadata without using color alone', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.evidence.artifacts[1].metadata = {
    width: 128, height: 88,
    highlightBox: { x: 24, y: 24, width: 80, height: 40, coordinateSpace: 'capture-css-px' },
  };

  const html = renderHtmlReport(createAuditModel(input));
  assert.match(html, /--highlight-left:18\.75%;--highlight-top:27\.272727%;--highlight-width:62\.5%;--highlight-height:45\.454545%/u);
  assert.match(html, /aria-hidden="true"/u);
  assert.match(html, /Moldura vermelha[^<]*não conformidade/iu);
  assert.match(html, /Moldura âmbar[^<]*revisão humana/iu);
});

test('keeps normative tables semantic and bounded by narrow report viewports', () => {
  const html = renderHtmlReport(SAMPLE_AUDIT);
  assert.match(html, /<table><thead><tr><th>Item<\/th>/u);
  assert.match(html, /table\s*\{[^}]*width:\s*100%/iu);
  assert.match(html, /@media\s*\(max-width:\s*42rem\)\{[^]*table\s*\{[^}]*table-layout:\s*fixed[^}]*\}[^]*th\s*,\s*td\s*\{[^}]*overflow-wrap:\s*anywhere/iu);
});

test('escapes hostile audited strings in text, attributes, code, URLs and media', () => {
  const hostile = '</style><script>alert(1)</script><img src=x onerror=alert(2)>';
  const input = structuredClone(SAMPLE_AUDIT);
  input.scope.description = hostile;
  input.occurrences[0].justification = hostile;
  input.evidence.artifacts[1].snippet = `<button aria-label="${hostile}">x</button>`;
  input.evidence.artifacts[1].selector.css = `#x"]{background:url(https://evil.test/x)}`;
  input.evidence.artifacts[1].backendNodeId = `41</dd><script>alert(5)</script>`;
  input.evidence.artifacts[1].mediaUrl = 'javascript:alert(3)';
  input.evidence.artifacts[1].dataUrl = 'data:image/svg+xml,<svg onload=alert(4)>';
  const html = renderHtmlReport(createAuditModel(input));
  assert.doesNotMatch(html, /<script\b|<img\s+src=x|\s(?:onerror|onload)=["'][^>]*>|(?:src|href)=["']javascript:|>javascript:/iu);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(html, /&lt;button aria-label=&quot;/u);
  assert.equal((html.match(/<img\b[^>]*>/gu) || []).length, 4);
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
  const html = renderHtmlReport(SAMPLE_AUDIT);
  for (const label of ['Aprovado', 'Reprovado', 'Revisar', 'Não aplicável', 'Não testado']) {
    assert.match(html, new RegExp(`<span[^>]*class="status[^>]*><span[^>]*aria-hidden="true"[^>]*>[^<]+</span><span>${label}</span>`, 'u'));
  }
});
