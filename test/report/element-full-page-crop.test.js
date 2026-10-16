import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { hashEvidenceArtifact } from '../../src/core/evidence/artifact-hash.js';
import { decodePngDataUrl } from '../../src/core/evidence/png.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { elementCropSource, integralCropSource } from '../../src/core/report/evidence-crop.js';
import { cropSourceEvidence, evidenceFileHashPresentation } from '../../src/core/report/evidence-hash-presentation.js';
import { sha256Hex } from '../../src/core/report/hash.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { verifyAuditIntegritySnapshot } from '../../src/core/report/integrity.js';
import { buildPanelSummary } from '../../src/panel/panel-summary.js';
import { buildReportView } from '../../src/review/report-view.js';
import { pngDataUrl } from '../support/png-fixture.js';

// O caminho novo da 1.1.62: o elemento guarda ONDE ele estava na captura integral (`fullPageRect`, em px
// CSS da imagem) e o recorte do relatório sai dessa imagem, que já está na auditoria. Nada de uma captura
// de tela por elemento; e o artefato continua sendo um só, com a posição comprometida pelo seu próprio
// hash. Auditorias sem o campo — todas as anteriores — seguem abrindo pelo caminho antigo.

const ENRICH_OPTIONS = Object.freeze({
  now: () => '2026-08-29T12:00:00.000Z', timezone: 'America/Cuiaba',
  manifestVersion: '1.0.1', rulesVersion: '1.0.0', browserVersion: 'Chrome/151.0.0.0',
});

// A captura integral de verdade do teste: um PNG com as dimensões declaradas, para o registro de imagens
// do relatório usar a mesma caixa que a posição gravada.
const INTEGRAL_WIDTH = 1280;
const INTEGRAL_HEIGHT = 1600;
const INTEGRAL_PNG = pngDataUrl(INTEGRAL_WIDTH / 16, INTEGRAL_HEIGHT / 16);
const INTEGRAL_HASH = await sha256Hex(decodePngDataUrl(INTEGRAL_PNG).bytes);
const RECT = Object.freeze({ x: 100, y: 200, width: 320, height: 80 });

/** Auditoria de exemplo com o elemento sem miniatura própria e com a posição na integral. */
function draftWithRect(rect = RECT, extra = {}) {
  const draft = structuredClone(SAMPLE_AUDIT);
  const fullPage = draft.evidence.find(artifact => artifact.kind === 'full-page');
  fullPage.dataUrl = INTEGRAL_PNG;
  fullPage.metadata = { width: INTEGRAL_WIDTH, height: INTEGRAL_HEIGHT };
  fullPage.hash = INTEGRAL_HASH;
  const element = draft.evidence.find(artifact => artifact.kind === 'element');
  delete element.dataUrl;
  delete element.metadata;
  element.fullPageRect = { ...rect };
  Object.assign(element, extra);
  draft.integrity.canonicalModelHash = 'pending';
  draft.integrity.evidenceManifestHash = 'pending';
  return draft;
}

async function modelWithRect(rect = RECT, extra = {}) {
  const inventory = await createInstalledCoreRuleInventory();
  return enrichAuditForReport(draftWithRect(rect, extra), { ...ENRICH_OPTIONS, rulesVersion: inventory.rulesVersion });
}

/** A mesma auditoria no formato que a página de revisão projeta (relatório completo). */
async function viewWithRect(rect = RECT, extra = {}) {
  const inventory = await createInstalledCoreRuleInventory();
  const model = await enrichAuditForReport(draftWithRect(rect, extra),
    { ...ENRICH_OPTIONS, rulesVersion: inventory.rulesVersion });
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
  return { model, view: buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash }) };
}

// --- o recorte ---------------------------------------------------------------------------------------

const pristineIntegral = (dataUrl = INTEGRAL_PNG) => ({
  evidenceId: 'ev-full', pageId: 'page-1', kind: 'full-page', state: 'pristine',
  dataUrl, metadata: { width: INTEGRAL_WIDTH, height: INTEGRAL_HEIGHT }, hash: INTEGRAL_HASH,
});

test('o recorte do elemento sai da captura integral, na posição gravada e sem captura nova', () => {
  const crop = integralCropSource({
    evidence: [pristineIntegral()], pageId: 'page-1',
    elementEvidence: { evidenceId: 'ev-el', pageId: 'page-1', kind: 'element', fullPageEvidenceId: 'ev-full', fullPageRect: RECT },
  });
  assert.equal(crop.sourceEvidenceId, 'ev-full');
  assert.equal(crop.artifact.dataUrl, INTEGRAL_PNG, 'os pixels são os da captura que já estava guardada');
  assert.deepEqual(crop.artifact.metadata.highlightBox, RECT);
  // Folga de contexto: o maior valor entre 24 px e 12% do lado maior (320 × 0,12 = 38,4 → 38).
  assert.deepEqual(crop.view, { x: 62, y: 162, width: 396, height: 156 });
  assert.equal(crop.artifact.metadata.width, INTEGRAL_WIDTH);
  assert.equal(crop.artifact.metadata.height, INTEGRAL_HEIGHT);
});

test('a janela acompanha a caixa em que o consumidor desenha a captura, e proporção diferente é recusada', () => {
  const scaled = integralCropSource({
    evidence: [pristineIntegral()], elementEvidence: { kind: 'element', fullPageEvidenceId: 'ev-full', fullPageRect: RECT },
    targetImageSize: { width: INTEGRAL_WIDTH / 2, height: INTEGRAL_HEIGHT / 2 },
  });
  assert.deepEqual(scaled.artifact.metadata.highlightBox, { x: 50, y: 100, width: 160, height: 40 });
  assert.deepEqual(scaled.view, { x: 26, y: 76, width: 208, height: 88 });
  // Um alvo com outra proporção esticaria o recorte para fora do elemento: melhor não ter imagem.
  assert.equal(integralCropSource({
    evidence: [pristineIntegral()], elementEvidence: { kind: 'element', fullPageEvidenceId: 'ev-full', fullPageRect: RECT },
    targetImageSize: { width: 640, height: 100 },
  }), null);
});

test('fragmentos de linha delimitam a janela quando a captura os registra', () => {
  const parts = [{ x: 100, y: 200, width: 320, height: 24 }, { x: 100, y: 232, width: 180, height: 24 }];
  const crop = integralCropSource({
    evidence: [pristineIntegral()], elementEvidence: { kind: 'element', fullPageEvidenceId: 'ev-full', fullPageRect: RECT, fullPageParts: parts },
  });
  assert.deepEqual(crop.artifact.metadata.highlightParts, parts);
  // A janela cobre os dois fragmentos (o mais alto deles), não a caixa declarada.
  assert.deepEqual(crop.view, { x: 62, y: 162, width: 396, height: 132 });
});

test('sem posição utilizável não existe recorte — a caixa nunca é adivinhada', () => {
  const element = (extra = {}) => ({ kind: 'element', pageId: 'page-1', fullPageEvidenceId: 'ev-full', ...extra });
  const cases = {
    'sem retângulo': { evidence: [pristineIntegral()], elementEvidence: element() },
    'retângulo malformado': { evidence: [pristineIntegral()], elementEvidence: element({ fullPageRect: { x: 0, y: 0, width: 0, height: 10 } }) },
    'fora da imagem (truncada pelo teto)': { evidence: [pristineIntegral()], elementEvidence: element({ fullPageRect: { x: 10, y: INTEGRAL_HEIGHT - 20, width: 100, height: 80 } }) },
    'sem a captura de origem na auditoria': { evidence: [], elementEvidence: element({ fullPageRect: RECT }) },
    'origem de outra página': { evidence: [pristineIntegral()], pageId: 'page-2', elementEvidence: element({ fullPageRect: RECT }) },
    'origem sem pixels guardados': { evidence: [pristineIntegral(null)], elementEvidence: element({ fullPageRect: RECT }) },
  };
  for (const [name, input] of Object.entries(cases)) {
    assert.equal(integralCropSource({ pageId: 'page-1', ...input }), null, name);
  }
});

test('a posição gravada é a primeira escolha: ela ganha da geometria dos mapas', () => {
  const segment = {
    segmentId: 'seg-1', index: 1, count: 1, role: 'image', sourceCssClip: { x: 0, y: 0, width: INTEGRAL_WIDTH, height: INTEGRAL_HEIGHT },
    width: INTEGRAL_WIDTH, height: INTEGRAL_HEIGHT, dataUrl: INTEGRAL_PNG, contentHash: INTEGRAL_HASH,
  };
  const map = {
    evidenceId: 'ev-map', pageId: 'page-1', kind: 'announcement-map', state: 'derived', fullPageEvidenceId: 'ev-full',
    derivation: {
      type: 'annotated-announcement-map',
      geometry: {
        coordinateSpace: 'document-css-px', sourceCssSize: { width: INTEGRAL_WIDTH, height: INTEGRAL_HEIGHT },
        sourcePixelSize: { width: INTEGRAL_WIDTH, height: INTEGRAL_HEIGHT }, scaleX: 1, scaleY: 1, deviceScaleFactor: 1,
        annotations: [{ number: 1, nodeId: 'n-1', sourceRect: { x: 5, y: 5, width: 40, height: 40 }, marker: { x: 0.5, y: 0.5, size: 28, leaderX: 0.5, leaderY: 0.5 }, segmentIndex: 1 }],
      },
    },
    segments: [segment], legend: [], hash: 'b'.repeat(64),
  };
  const element = { kind: 'element', pageId: 'page-1', nodeId: 'n-1', fullPageEvidenceId: 'ev-full', fullPageRect: RECT };
  const withRect = elementCropSource({ evidence: [pristineIntegral(), map], pageId: 'page-1', nodeId: 'n-1', elementEvidence: element });
  assert.equal(withRect.sourceEvidenceId, 'ev-full');
  assert.deepEqual(withRect.view, { x: 62, y: 162, width: 396, height: 156 });
  // Sem a posição gravada (auditorias anteriores), o mesmo elemento continua saindo pelo mapa.
  const legacy = elementCropSource({ evidence: [map], pageId: 'page-1', nodeId: 'n-1' });
  assert.equal(legacy.sourceEvidenceId, 'seg-1');
  assert.equal(legacy.mapEvidenceId, 'ev-map');
});

// --- esquema, hash e integridade ---------------------------------------------------------------------

test('a posição é aceita no esquema fechado e entra no hash do artefato', async () => {
  const withRect = await modelWithRect();
  const element = withRect.evidence.find(artifact => artifact.kind === 'element');
  assert.deepEqual(element.fullPageRect, RECT);
  assert.equal(element.dataUrl, undefined, 'o elemento recortado não guarda pixels próprios');
  // O hash do artefato cobre a posição: mudar onde o elemento estava muda o hash do registro.
  const moved = await hashEvidenceArtifact({ ...element, fullPageRect: { ...RECT, y: RECT.y + 10 } });
  assert.notEqual(moved, element.hash);
  assert.equal(await hashEvidenceArtifact(element), element.hash);
  // A oscilação de leiaute declarada continua valendo para a posição gravada.
  const verified = await verifyAuditIntegritySnapshot(structuredClone(withRect));
  assert.deepEqual(verified.evidence.find(artifact => artifact.kind === 'element').fullPageRect, RECT);
  await assert.rejects(() => verifyAuditIntegritySnapshot(structuredClone({
    ...withRect,
    evidence: withRect.evidence.map(artifact => artifact.kind === 'element' ? { ...artifact, fullPageRect: { ...RECT, x: 1 } } : artifact),
  })), 'posição trocada no armazenamento local é recusada pela integridade');
});

test('a auditoria anterior, sem a posição, mantém o hash e o caminho antigo', async () => {
  const inventory = await createInstalledCoreRuleInventory();
  const legacy = structuredClone(SAMPLE_AUDIT);
  legacy.integrity.canonicalModelHash = 'pending';
  legacy.integrity.evidenceManifestHash = 'pending';
  const model = await enrichAuditForReport(legacy, { ...ENRICH_OPTIONS, rulesVersion: inventory.rulesVersion });
  const element = model.evidence.find(artifact => artifact.kind === 'element');
  assert.equal(element.fullPageRect, undefined);
  assert.equal(element.fullPageParts, undefined);
  const stored = SAMPLE_AUDIT.evidence.find(artifact => artifact.kind === 'element');
  assert.equal(element.hash, await hashEvidenceArtifact(stored),
    'o hash recalculado do artefato antigo continua sendo o mesmo, sem o campo novo');
  assert.notEqual(await hashEvidenceArtifact({ ...stored, fullPageRect: RECT }), element.hash,
    'e o campo novo, quando existe, muda o hash — a posição é dado guardado, não enfeite');
  assert.equal(elementCropSource({ evidence: model.evidence, pageId: element.pageId, nodeId: element.nodeId, elementEvidence: element }), null,
    'sem posição e sem mapa, o cartão mostra o texto do elemento');
});

test('o esquema recusa posição sem a captura de origem ou fora do contrato do retângulo', async () => {
  const model = await modelWithRect();
  const element = model.evidence.find(artifact => artifact.kind === 'element');
  const replace = change => createAuditModel({
    ...model,
    evidence: model.evidence.map(artifact => artifact === element ? change(structuredClone(element)) : artifact),
  });
  const rejected = {
    'sem a captura de origem': artifact => { delete artifact.fullPageEvidenceId; return artifact; },
    'retângulo sem todos os números': artifact => { artifact.fullPageRect = { x: 1, y: 2, width: 3 }; return artifact; },
    'retângulo com campo a mais': artifact => { artifact.fullPageRect = { ...RECT, scale: 1 }; return artifact; },
    'retângulo de largura zero': artifact => { artifact.fullPageRect = { ...RECT, width: 0 }; return artifact; },
    'retângulo com texto': artifact => { artifact.fullPageRect = { ...RECT, x: '10' }; return artifact; },
    'fragmentos sem lista': artifact => { artifact.fullPageParts = 'linha'; return artifact; },
    'lista de fragmentos vazia': artifact => { artifact.fullPageParts = []; return artifact; },
    'fragmentos demais': artifact => { artifact.fullPageParts = Array.from({ length: 9 }, () => ({ ...RECT })); return artifact; },
    'fragmento malformado': artifact => { artifact.fullPageParts = [{ ...RECT, height: -1 }]; return artifact; },
    'fragmentos sem a captura de origem': artifact => { artifact.fullPageParts = [{ ...RECT }]; delete artifact.fullPageEvidenceId; return artifact; },
  };
  for (const [name, change] of Object.entries(rejected)) {
    assert.throws(() => replace(change), name);
  }
  // O mesmo artefato com a posição e os fragmentos completos continua aceito.
  assert.doesNotThrow(() => replace(artifact => { artifact.fullPageParts = [{ ...RECT }]; return artifact; }));
});

// --- relatório ---------------------------------------------------------------------------------------

test('a ocorrência mostra o recorte da captura integral em vez do aviso de alvo não localizado', async () => {
  const model = await modelWithRect();
  const html = renderHtmlReport(model);
  const cards = html.split('id="ocorrencia-').slice(1);
  const withCrop = cards.find(card => card.includes('data-evidence-crop-source="ev-full"'));
  assert.ok(withCrop, 'a ocorrência do elemento listado aparece com o recorte da captura integral');
  assert.match(withCrop, /<use href="#evidence-image-\d+"/u, 'o recorte referencia a imagem já embutida, sem copiar bytes');
  assert.match(withCrop, /Recorte tirado da captura da página inteira desta auditoria/u);
  assert.doesNotMatch(withCrop, /Alvo elementar não localizado|Captura sem imagens locais nesta auditoria/u);
  // A captura integral entra uma única vez no documento; os recortes só a referenciam.
  assert.equal((html.match(/href="data:image\/png;base64,/gu) ?? []).length, 1);
});

test('a ficha do anexo recorta a integral e diz de qual captura saiu o recorte', async () => {
  const model = await modelWithRect();
  const html = renderHtmlReport(model);
  const card = html.slice(html.indexOf('id="evidencia-2"')).split('</article>')[0];
  assert.match(card, /data-evidence-crop-source="ev-full"|data-evidence-crop-source/u);
  assert.match(card, /A imagem original é a captura integral/u);
  assert.match(card, /ev-full/u);
  // O código do arquivo é o da captura que a pessoa pode baixar — não "não registrado".
  const element = model.evidence.find(artifact => artifact.kind === 'element');
  const source = model.evidence.find(artifact => artifact.kind === 'full-page');
  assert.equal(evidenceFileHashPresentation(element, source).value, INTEGRAL_HASH);
  assert.match(card, new RegExp(INTEGRAL_HASH, 'u'));
  assert.match(card, /recorte da captura integral ev-full/u);
});

test('o relatório completo da revisão recorta a integral sem duplicar os pixels dela', async () => {
  const { model, view } = await viewWithRect();
  for (const forPrint of [false, true]) {
    const html = renderHtmlReport(model, { reportView: view, forPrint });
    const count = (html.match(/data-evidence-crop-source="ev-full"/gu) ?? []).length;
    assert.ok(count > 0, `forPrint=${forPrint}: o recorte aparece no documento entregue`);
    assert.equal((html.match(/href="data:image\/png;base64,/gu) ?? []).length, 1,
      `forPrint=${forPrint}: a captura integral aparece uma vez, no registro de imagens; figuras e recortes a referenciam`);
    assert.match(html, /<use href="#evidence-image-0"/u);
    assert.match(html, /Recorte tirado da captura da página inteira desta auditoria/u);
  }
  const card = view.technicalEvidence.find(evidence => evidence.evidenceId === 'ev-control');
  assert.equal(card.dataUrl, undefined);
});

test('a posição na captura integral não sobrevive à falta dos pixels dela', () => {
  // A captura da auditoria pode ficar sem o arquivo (limite de tamanho ou omissão registrada). O recorte
  // reaproveita os pixels que já estão guardados e não inventa nenhum: sem eles não há imagem a mostrar, e
  // a ficha diz de qual captura o recorte viria, em vez de mostrar um código que não confere nada.
  const element = {
    evidenceId: 'ev-el', pageId: 'page-1', kind: 'element',
    fullPageEvidenceId: 'ev-full', fullPageRect: RECT, hash: 'c'.repeat(64),
  };
  const omitted = {
    evidenceId: 'ev-full', pageId: 'page-1', kind: 'full-page', state: 'pristine',
    pixelState: 'omitted-budget', pixelContentHash: INTEGRAL_HASH, hash: INTEGRAL_HASH,
  };
  assert.equal(integralCropSource({ evidence: [omitted], pageId: 'page-1', elementEvidence: element }), null,
    'sem os pixels guardados não existe recorte — e nenhuma captura nova é tirada para cobrir isso');
  assert.equal(cropSourceEvidence(element, [omitted]), null);
  const file = evidenceFileHashPresentation(element, cropSourceEvidence(element, [omitted]));
  assert.equal(file.value, 'não disponível');
  assert.match(file.note, /recorte vem da captura integral ev-full/u);
  assert.doesNotMatch(file.value, /[a-f0-9]{64}/u, 'nenhum código de arquivo é afirmado sem o arquivo');
});

test('a miniatura própria do elemento continua ganhando do recorte da integral', async () => {
  // A ordem de preferência do produto: primeiro os pixels que a própria auditoria capturou para este
  // elemento; o recorte da captura integral é o que entra no lugar quando eles não existem.
  const THUMBNAIL = pngDataUrl(24, 24);
  const thumbnailHash = await sha256Hex(decodePngDataUrl(THUMBNAIL).bytes);
  const model = await modelWithRect(RECT, {
    dataUrl: THUMBNAIL, metadata: { width: 24, height: 24 }, binarySha256: thumbnailHash,
  });
  const html = renderHtmlReport(model);
  const element = model.evidence.find(artifact => artifact.kind === 'element');
  assert.ok(element.dataUrl, 'a miniatura do elemento continua no artefato');
  assert.match(html, /href="data:image\/png;base64,/u);
  assert.doesNotMatch(html, /data-evidence-crop-source/u, 'o recorte da integral não é montado por cima da miniatura');
  const file = evidenceFileHashPresentation(element, cropSourceEvidence(element, model.evidence));
  assert.equal(file.value, thumbnailHash, 'com miniatura própria, o código do arquivo é o dela');
});

test('o item do mapa no anexo manda ver as imagens na seção do mapa', () => {
  const map = { evidenceId: 'ev-map', kind: 'announcement-map', hash: 'a'.repeat(64) };
  const file = evidenceFileHashPresentation(map);
  assert.equal(file.value, 'no mapa');
  assert.match(file.note, /seção do mapa/u);
  assert.doesNotMatch(file.value, /não se aplica|não disponível/u);
});
