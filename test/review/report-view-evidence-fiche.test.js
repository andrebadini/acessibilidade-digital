import assert from 'node:assert/strict';
import test from 'node:test';

import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { decodePngDataUrl } from '../../src/core/evidence/png.js';
import { sha256Hex } from '../../src/core/report/hash.js';
import { buildPanelSummary } from '../../src/panel/panel-summary.js';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { buildReportView, evidenceDownloadTarget, renderReportView } from '../../src/review/report-view.js';
import { pngDataUrl } from '../support/png-fixture.js';

// A ficha de evidência é o lugar onde quem lê o relatório aberto no painel confere a imagem de que a
// constatação fala: ID, os dois SHA-256 inteiros, data/hora e o arquivo original para baixar. Estes testes
// fixam o que o produto pediu — nenhum hash cortado, nenhuma instrução para procurar a captura em outro
// lugar, e bytes salvos idênticos aos guardados (é isso que torna o hash conferível por terceiro).

const ELEMENT_FRAME_METADATA = Object.freeze({
  width: 128,
  height: 88,
  highlightBox: { x: 24, y: 12, width: 80, height: 40, coordinateSpace: 'capture-css-px' },
});

async function fixture({ mutateDraft } = {}) {
  const inventory = await createInstalledCoreRuleInventory();
  const draft = structuredClone(SAMPLE_AUDIT);
  mutateDraft?.(draft);
  draft.integrity.canonicalModelHash = 'pending';
  draft.integrity.evidenceManifestHash = 'pending';
  const model = await enrichAuditForReport(draft, {
    now: () => '2026-08-29T12:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '1.0.1', rulesVersion: inventory.rulesVersion, browserVersion: 'Chrome/151.0.0.0',
  });
  const checkpoint = {
    version: 1, auditId: model.auditId,
    pages: model.pages.map(page => ({
      pageId: page.pageId, attempted: page.attempted,
      startedAt: page.attempted ? page.timestamps.startedAt : null,
      rulesVersion: inventory.rulesVersion, inventoryVersion: inventory.inventoryVersion,
      inventoryHash: inventory.sha256, outcomes: [
        { ruleId: 'focus-fully-visible', outcome: 'passed' },
        { ruleId: 'keyboard-focus-trap', outcome: 'untested' },
      ],
    })),
  };
  const summary = await buildPanelSummary({ model, executionCheckpoint: checkpoint, inventory });
  return { model, summary };
}

// O hash do arquivo é o dos pixels da amostra: um valor inventado é recusado pela verificação de
// integridade (e o teste abaixo, que apaga o campo, prova que ele é confiável quando existe).
const ELEMENT_PNG_SHA256 = await sha256Hex(
  decodePngDataUrl(SAMPLE_AUDIT.evidence.find(evidence => evidence.kind === 'element').dataUrl).bytes);

function withElementFrame(draft) {
  const element = draft.evidence.find(evidence => evidence.kind === 'element');
  element.metadata = structuredClone(ELEMENT_FRAME_METADATA);
  element.binarySha256 = ELEMENT_PNG_SHA256;
  return draft;
}

async function panel(model, summary) {
  const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
  return renderReportView({ view, document: new FakeDocument(), onExport() {} });
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase(); this.ownerDocument = ownerDocument; this.children = [];
    this.attributes = new Map(); this.dataset = {}; this.listeners = new Map(); this.hidden = false;
    this._text = ''; this.parentNode = null;
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  // Fragmentos entram no lugar do próprio nó, como no DOM real: é assim que o texto linkificado continua
  // sendo filho direto do parágrafo da citação.
  append(...children) {
    for (const child of children) {
      if (child.tagName === '#FRAGMENT') { this.append(...child.children); continue; }
      child.parentNode = this; this.children.push(child);
    }
  }
  replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/gu, (_all, letter) => letter.toUpperCase())] = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, listener) { const values = this.listeners.get(type) ?? []; values.push(listener); this.listeners.set(type, values); }
  click() { for (const listener of this.listeners.get('click') ?? []) listener({ currentTarget: this }); }
  remove() { this.parentNode = null; }
  querySelectorAll(selector) {
    const output = [];
    const visit = node => { for (const child of node.children) { if (matches(child, selector)) output.push(child); visit(child); } };
    visit(this); return output;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

class FakeDocument {
  constructor() { this.body = new FakeElement('body', this); }
  createElement(tag) { return new FakeElement(tag, this); }
  createElementNS(_namespace, tag) { return new FakeElement(tag, this); }
  createTextNode(text) { const node = new FakeElement('#text', this); node.textContent = text; return node; }
  createDocumentFragment() { return new FakeElement('#fragment', this); }
}

function matches(node, selector) {
  const compounds = selector.trim().split(/\s+(?![^[]*\])/u);
  const target = compounds.pop();
  if (!matchesCompound(node, target)) return false;
  let ancestor = node.parentNode;
  for (let index = compounds.length - 1; index >= 0; index -= 1) {
    let found = false;
    while (ancestor) {
      const current = ancestor;
      ancestor = ancestor.parentNode;
      if (matchesCompound(current, compounds[index])) { found = true; break; }
    }
    if (!found) return false;
  }
  return true;
}

function matchesCompound(node, compound) {
  const tag = compound.match(/^[a-z][a-z0-9-]*/iu)?.[0];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const match of compound.matchAll(/\.([a-z0-9_-]+)/giu)) {
    if (!(node.getAttribute('class') ?? '').split(/\s+/u).includes(match[1])) return false;
  }
  for (const match of compound.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/gu)) {
    const value = node.getAttribute(match[1]);
    if (value === null || (match[2] !== undefined && value !== match[2])) return false;
  }
  return true;
}

test('cada ID de evidência citado vira link para a ficha, sem mudar o texto da citação', async () => {
  const { model, summary } = await fixture({ mutateDraft: withElementFrame });
  const root = await panel(model, summary);
  const board = root.querySelector('[data-findings-board]');
  const citations = board.querySelectorAll('.findings-citation');
  assert.ok(citations.length > 0);
  for (const citation of citations) {
    const links = citation.querySelectorAll('a[data-report-consult-evidence]');
    for (const link of links) {
      const anchor = link.getAttribute('href');
      assert.match(anchor, /^#report-evidence-\d+$/u);
      // O alvo existe: o link leva à ficha, não a um lugar nenhum.
      assert.ok(root.querySelector(`[id="${anchor.slice(1)}"]`));
      // O texto do link é o próprio ID, como ele já aparecia na frase; o nome acessível diz o que o ID
      // sozinho não diz ("ver a ficha da evidência"), porque um ID solto não é uma descrição de destino.
      assert.match(link.textContent, /^ev-[a-z0-9-]+$/u);
      assert.equal(link.getAttribute('aria-label'), `Ver a ficha da evidência ${link.textContent}`);
      assert.equal(citation.textContent.includes(link.textContent), true);
    }
  }
  const withLinks = citations.filter(citation => citation.querySelectorAll('a[data-report-consult-evidence]').length > 0);
  assert.ok(withLinks.length > 0, 'ao menos uma citação aponta para a ficha da evidência citada');
  // Linkificar não reescreve o parágrafo: o texto visível continua sendo a citação pronta, com os mesmos
  // IDs no mesmo lugar do texto (só viraram âncoras).
  const cited = withLinks[0];
  const citedIds = cited.querySelectorAll('a[data-report-consult-evidence]').map(link => link.textContent);
  assert.ok(citedIds.length > 0);
  for (const id of citedIds) assert.match(cited.textContent, new RegExp(`Evidência[^.]*${id}`, 'u'));
});

test('a ficha mostra os dois SHA-256 inteiros, a data/hora e o botão de download do PNG', async () => {
  const { model, summary } = await fixture({ mutateDraft: withElementFrame });
  const root = await panel(model, summary);
  const element = model.evidence.find(evidence => evidence.kind === 'element');
  const fiche = root.querySelector(`[data-report-evidence="${element.evidenceId}"]`);
  assert.ok(fiche);
  assert.equal(fiche.getAttribute('data-evidence-fiche'), '');
  const text = fiche.textContent;
  assert.match(text, /Impressão digital \(SHA-256\) do registro/u);
  assert.match(text, /SHA-256 do arquivo de imagem \(PNG\)/u);
  // Os dois códigos aparecem inteiros (64 caracteres), nunca abreviados.
  assert.equal(text.includes(element.hash), true);
  assert.equal(text.includes(element.binarySha256), true);
  assert.doesNotMatch(text, /SHA-256 [a-f0-9]{16}…/u);
  assert.match(text, /Data e hora da captura/u);
  const download = fiche.querySelector('button[data-evidence-download]');
  assert.equal(download.textContent, 'Baixar imagem (PNG)');
  assert.equal(download.getAttribute('data-evidence-download'), element.evidenceId);
  const help = root.querySelector('[data-report-annex] .evidence-fiche-help');
  assert.match(help.textContent, /impressão digital do arquivo/u);
  assert.match(help.textContent, /calcule o SHA-256/u);
});

test('o botão de download entrega os bytes exatos do PNG guardado, com o SHA-256 anunciado', async () => {
  const { model } = await fixture({ mutateDraft: withElementFrame });
  const element = model.evidence.find(evidence => evidence.kind === 'element');
  const target = evidenceDownloadTarget(element);
  assert.equal(target.fileName, `${element.evidenceId}.png`);
  assert.deepEqual(target.bytes, decodePngDataUrl(element.dataUrl).bytes);
  assert.equal(await sha256Hex(target.bytes), element.binarySha256, 'o arquivo salvo tem o hash que a ficha anuncia');
  assert.equal(evidenceDownloadTarget({ evidenceId: 'ev-x', dataUrl: 'data:image/png;base64,QUJD' }), null,
    'base64 não canônico não vira arquivo: o hash não poderia ser conferido');
});

test('auditoria anterior à 1.1.62 diz que o hash do arquivo não foi registrado, sem inventar valor', async () => {
  const { model, summary } = await fixture({ mutateDraft: withElementFrame });
  const legacy = structuredClone(model);
  delete legacy.evidence.find(evidence => evidence.kind === 'element').binarySha256;
  const root = await panel(legacy, summary);
  const fiche = root.querySelector('[data-report-evidence="ev-control"]');
  assert.match(fiche.textContent, /SHA-256 do arquivo de imagem \(PNG\)/u);
  assert.match(fiche.textContent, /não registrado/u);
  assert.match(fiche.textContent, /versão anterior da extensão/u);
  assert.equal(fiche.textContent.includes(ELEMENT_PNG_SHA256), false, 'nenhum hash é inventado para o campo ausente');
  assert.equal(fiche.textContent.includes(legacy.evidence.find(evidence => evidence.kind === 'element').hash), true);
});

test('a constatação mostra a miniatura do elemento com contorno e o caminho até a ficha', async () => {
  const { model, summary } = await fixture({ mutateDraft: withElementFrame });
  const root = await panel(model, summary);
  const board = root.querySelector('[data-findings-board]');
  const row = board.querySelector('[data-findings-occurrence="occ-focus-failed"]') ??
    board.querySelectorAll('[data-findings-occurrence]').find(candidate =>
      candidate.querySelector('svg[data-evidence-treatment="failed"]'));
  assert.ok(row);
  const svg = row.querySelector('svg[data-evidence-treatment="failed"]');
  assert.ok(svg, 'a miniatura reusa o mesmo contorno do relatório entregue');
  assert.equal(svg.querySelector('image').getAttribute('href'), model.evidence.find(evidence => evidence.kind === 'element').dataUrl);
  assert.ok(svg.querySelector('rect[data-evidence-highlight="failed"]'));
  assert.match(row.querySelector('figcaption').textContent, /Contorno vermelho: elemento com falha\./u);
  // Cada evidência citada na constatação tem o seu caminho até a ficha (o que o quadro oferece além dos
  // IDs linkados dentro do próprio texto para citação).
  const links = row.querySelectorAll('a[data-report-consult-evidence]');
  assert.deepEqual(links.map(link => link.textContent).slice(0, 2),
    ['Ver a ficha da evidência ev-full', 'Ver a ficha da evidência ev-control']);
  for (const link of links) assert.match(link.getAttribute('href'), /^#report-evidence-\d+$/u);
});

test('sem pixels do elemento, a constatação diz o que existe em vez de mandar procurar a captura', async () => {
  const { model, summary } = await fixture({ mutateDraft: withElementFrame });
  const view = structuredClone(buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash }));
  const entry = view.findingsBoard.groups.notMet[0];
  const finding = entry.findings[0];
  finding.elementEvidenceId = null;
  const root = renderReportView({ view, document: new FakeDocument(), onExport() {} });
  const row = root.querySelector(`[data-findings-occurrence="${finding.occurrenceId}"]`);
  assert.equal(row.querySelector('svg[data-evidence-treatment="failed"]'), null);
  assert.equal(row.querySelector('[data-findings-evidence]'), null);
  assert.equal(row.querySelector('.findings-evidence-missing').textContent,
    'A imagem deste elemento não está nesta auditoria.');
  // O caminho para a ficha continua ali: é lá que a pessoa vê o que foi registrado no lugar da imagem.
  assert.ok(row.querySelector('a[data-report-consult-evidence]'));
});

// --- o recorte da captura integral nas telas do relatório vivo (1.1.62) -----------------------------
//
// O elemento que fica dentro da captura integral não tem miniatura própria: o que ele tem é a POSIÇÃO
// dele na imagem de página inteira. A tela do relatório tem de mostrar essa imagem recortada onde hoje
// mostra a miniatura — a constatação do quadro, a prévia da ocorrência e a ficha —, e as três apontam
// para a MESMA captura registrada uma única vez.

const INTEGRAL_WIDTH = 1280;
const INTEGRAL_HEIGHT = 1600;
const INTEGRAL_PNG = pngDataUrl(INTEGRAL_WIDTH / 16, INTEGRAL_HEIGHT / 16);
const INTEGRAL_SHA256 = await sha256Hex(decodePngDataUrl(INTEGRAL_PNG).bytes);
const ELEMENT_CROP_RECT = Object.freeze({ x: 100, y: 200, width: 320, height: 80 });

/** Auditoria em que o elemento não tem pixels próprios: só a posição na captura integral. */
function withoutOwnThumbnail(draft) {
  const fullPage = draft.evidence.find(evidence => evidence.kind === 'full-page');
  fullPage.dataUrl = INTEGRAL_PNG;
  fullPage.metadata = { width: INTEGRAL_WIDTH, height: INTEGRAL_HEIGHT };
  fullPage.hash = INTEGRAL_SHA256;
  const element = draft.evidence.find(evidence => evidence.kind === 'element');
  delete element.dataUrl;
  delete element.metadata;
  element.fullPageRect = { ...ELEMENT_CROP_RECT };
  element.fullPageEvidenceId = fullPage.evidenceId;
  return draft;
}

/** Todos os nós da árvore, para contar atributos que o seletor mínimo do teste não alcança. */
function allNodes(node, output = []) {
  output.push(node);
  for (const child of node.children) allNodes(child, output);
  return output;
}

const dataUrlImages = root => allNodes(root)
  .filter(node => (node.getAttribute('href') ?? '').startsWith('data:image/png'));

test('a constatação mostra o recorte da captura integral quando o elemento não tem miniatura', async () => {
  const { model, summary } = await fixture({ mutateDraft: withoutOwnThumbnail });
  const root = await panel(model, summary);
  const figure = root.querySelector('[data-findings-board]').querySelector('[data-findings-evidence]');
  assert.ok(figure, 'a constatação não pode ficar sem imagem só porque a miniatura própria não existe');
  const svg = figure.querySelector('svg[data-evidence-crop-source="ev-full"]');
  assert.ok(svg, 'a imagem mostrada é o recorte da captura integral, e a tela diz de qual captura ele saiu');
  assert.ok(svg.querySelector('use'), 'os pixels vêm do registro compartilhado, referenciado por <use>');
  assert.equal(svg.querySelector('image'), null, 'nenhum PNG é copiado para dentro da figura do recorte');
  assert.match(figure.querySelector('figcaption').textContent,
    /Recorte tirado da captura da página inteira desta auditoria/u);
  assert.equal(dataUrlImages(root).length, 1, 'a captura integral entra uma vez no documento inteiro');
});

test('a prévia da ocorrência mostra o recorte em vez de dizer que não há captura', async () => {
  const { model, summary } = await fixture({ mutateDraft: withoutOwnThumbnail });
  const root = await panel(model, summary);
  const previews = root.querySelectorAll('section[data-report-evidence-preview]');
  const withCrop = previews.filter(preview => preview.querySelector('svg[data-evidence-crop-source="ev-full"]'));
  assert.ok(withCrop.length > 0, 'a verificação que cita o elemento continua com a captura dele à vista');
  for (const preview of previews) {
    const element = preview.querySelector('figure[data-evidence-kind="element"]');
    if (element) assert.ok(element.querySelector('use'), 'toda figura de elemento desta auditoria usa o recorte');
  }
  assert.equal(dataUrlImages(root).length, 1, 'o mesmo PNG não é repetido por figura');
});
