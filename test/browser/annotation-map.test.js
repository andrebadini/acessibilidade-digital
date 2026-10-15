import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import {
  ANNOTATION_MAP_MV3_GATE,
  ANNOTATION_MAP_LIMITS,
  AnnotationMapError,
  buildAnnotationMapPlan,
  composeAnnouncementMap,
  composeAnnouncementMapForProduction,
  selectAnnouncementMapEntries,
} from '../../src/browser/annotation-map.js';
import { validateAnnotationMapArtifact } from '../../src/core/evidence/annotation-map-artifact.js';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { normalizeSnapshot } from '../../src/core/normalize-snapshot.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { sha256Hex } from '../../src/core/report/hash.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { readerMapPresentation } from '../../src/core/report/reader-map-presentation.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngBytes(width, height, raster) {
  const chunk = (type, data) => {
    const typeBytes = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
    return Buffer.concat([length, typeBytes, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const scanlines = raster ?? Buffer.alloc(height * (1 + width * 4), 255);
  if (!raster) for (let row = 0; row < height; row += 1) scanlines[row * (1 + width * 4)] = 0;
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

async function pristineSource(width, height, overrides = {}) {
  const bytes = pngBytes(width, height);
  return {
    evidenceId: 'full', pageId: 'page-1', kind: 'full-page', state: 'pristine',
    dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
    hash: await sha256Hex(bytes), metadata: {}, ...overrides,
  };
}

function snapshot(nodes) {
  const normalized = nodes.map((node, index) => ({
    nodeId: node.nodeId ?? `n-${index + 1}`,
    parentId: node.parentId ?? null,
    children: node.children ?? [],
    tagName: node.tagName ?? 'button',
    attributes: node.attributes ?? {},
    framePath: node.framePath ?? [],
    hidden: false,
    ...node,
  }));
  const byId = new Map(normalized.map(node => [node.nodeId, node]));
  for (const node of normalized) {
    if (node.parentId && byId.has(node.parentId) && !byId.get(node.parentId).children.includes(node.nodeId)) {
      byId.get(node.parentId).children.push(node.nodeId);
    }
  }
  return { schemaVersion: 1, document: { nodeId: 'document', title: 'Fixture', url: 'https://example.test/' }, nodes: normalized };
}

test('selects a stable safe DOM/AX projection with structural selectors only', () => {
  const input = snapshot([
    { nodeId: 'root', tagName: 'main', children: ['disabled', 'hidden', 'inert', 'editable', 'private', 'open-host', 'frame', 'frame-child'] },
    { nodeId: 'disabled', parentId: 'root', tagName: 'button', attributes: { id: 'SECRET-author-id', disabled: '' }, accessibleName: 'Salvar', axRole: 'button', disabled: true, rect: { x: 10, y: 10, width: 80, height: 30 } },
    { nodeId: 'hidden', parentId: 'root', accessibleName: 'Oculto', axRole: 'button', hidden: true, rect: { x: 10, y: 50, width: 80, height: 30 } },
    { nodeId: 'inert', parentId: 'root', tagName: 'section', attributes: { inert: 'false' }, children: ['inert-child'], rect: { x: 0, y: 0, width: 1, height: 1 } },
    { nodeId: 'inert-child', parentId: 'inert', accessibleName: 'Inerte', axRole: 'button', rect: { x: 10, y: 90, width: 80, height: 30 } },
    { nodeId: 'editable', parentId: 'root', tagName: 'input', attributes: { type: 'text', value: 'TOPSECRET' }, accessibleName: 'Chave', axRole: 'textbox', rect: { x: 10, y: 130, width: 80, height: 30 } },
    { nodeId: 'private', parentId: 'root', tagName: 'div', attributes: { 'data-private': '' }, children: ['private-child'], rect: { x: 0, y: 0, width: 1, height: 1 } },
    { nodeId: 'private-child', parentId: 'private', accessibleName: 'TOPSECRET', axRole: 'button', rect: { x: 10, y: 170, width: 80, height: 30 } },
    { nodeId: 'open-host', parentId: 'root', tagName: 'x-actions', children: ['open-root'] },
    { nodeId: 'open-root', parentId: 'open-host', tagName: '#document-fragment', shadowRootType: 'open', children: ['shadow-button'] },
    { nodeId: 'shadow-button', parentId: 'open-root', tagName: 'button', shadowRootId: 'open-root', shadowHostId: 'open-host', accessibleName: 'Ajuda', axRole: 'button', rect: { x: 10, y: 210, width: 80, height: 30 } },
    { nodeId: 'frame', parentId: 'root', tagName: 'iframe', accessibleName: 'Frame externo', axRole: 'iframe', framePath: ['frame-host'], rect: { x: 10, y: 250, width: 80, height: 30 } },
    { nodeId: 'frame-child', parentId: 'root', tagName: 'button', accessibleName: 'Mesmo frame', axRole: 'button', framePath: ['frame-host'], rect: { x: 10, y: 280, width: 80, height: 30 } },
    { nodeId: 'no-rect', parentId: 'root', tagName: 'a', attributes: { href: 'https://example.test/' }, accessibleName: 'Sem geometria', axRole: 'link' },
  ]);

  const result = selectAnnouncementMapEntries(input);

  assert.deepEqual(result.entries.map(entry => [entry.number, entry.nodeId, entry.announcementPreview]), [
    [1, 'disabled', 'Salvar, botão, indisponível'],
    [2, 'shadow-button', 'Ajuda, botão'],
  ]);
  assert.deepEqual(result.counts, {
    eligible: 3, annotated: 2, omittedNoRect: 1, omittedFrame: 1, omittedLimit: 0, unresolvedOverlap: 0, omittedClipped: 0,
  });
  assert.match(result.entries[0].selectorSummary, /^main > button:nth-of-type\(1\)$/u);
  assert.match(result.entries[1].selectorSummary, /x-actions >>> button/u);
  assert.doesNotMatch(JSON.stringify(result), /SECRET-author-id|TOPSECRET|data-private/u);
  assert.ok(result.limitations.includes('frame-content-omitted'));
});

test('excludes an otherwise eligible ancestor when a private editable descendant can contaminate its AX name', () => {
  const secret = 'TOPSECRET-descendant-name';
  const normalized = normalizeSnapshot({
    format: 'simplified-v1',
    document: { url: 'https://example.test/', title: 'Privacy' },
    nodes: [
      { backendNodeId: 1, tagName: 'button', parentBackendNodeId: null, attributes: {}, rect: { x: 5, y: 5, width: 100, height: 30 } },
      { backendNodeId: 2, tagName: 'div', parentBackendNodeId: 1, attributes: { contenteditable: 'true' }, text: secret, visibleText: secret },
      { backendNodeId: 3, tagName: 'button', parentBackendNodeId: null, attributes: {}, rect: { x: 5, y: 45, width: 100, height: 30 } },
    ],
    axTree: { nodes: [
      { backendDOMNodeId: 1, role: { value: 'button' }, name: { value: secret } },
      { backendDOMNodeId: 2, role: { value: 'textbox' }, name: { value: secret }, value: { value: secret } },
      { backendDOMNodeId: 3, role: { value: 'button' }, name: { value: 'Ação segura' } },
    ] },
  });

  const selected = selectAnnouncementMapEntries(normalized);

  assert.deepEqual(selected.entries.map(entry => entry.announcementPreview), ['Ação segura, botão']);
  assert.doesNotMatch(JSON.stringify(selected), /TOPSECRET/iu);
});

test('keeps an editable descendant AX secret out of the composed artifact, hashes, canonical model and HTML report', async () => {
  const secret = 'TOPSECRET-full-path-privacy';
  const normalized = normalizeSnapshot({
    format: 'simplified-v1',
    document: { url: 'https://example.test/', title: 'Privacy' },
    nodes: [
      { backendNodeId: 1, tagName: 'button', parentBackendNodeId: null, attributes: {}, rect: { x: 5, y: 5, width: 80, height: 24 } },
      { backendNodeId: 2, tagName: 'div', parentBackendNodeId: 1, attributes: { id: 'shared-private-reference', contenteditable: 'true' }, text: secret, visibleText: secret },
      { backendNodeId: 3, tagName: 'button', parentBackendNodeId: null, attributes: {}, rect: { x: 5, y: 40, width: 80, height: 24 } },
      { backendNodeId: 4, tagName: 'button', parentBackendNodeId: null, attributes: { 'aria-labelledby': 'shared-private-reference' }, rect: { x: 5, y: 70, width: 80, height: 24 } },
      { backendNodeId: 5, tagName: 'button', parentBackendNodeId: null, attributes: { 'aria-describedby': 'shared-private-reference' }, rect: { x: 5, y: 70, width: 80, height: 24 } },
      { backendNodeId: 6, tagName: 'span', parentBackendNodeId: null, attributes: { id: 'shared-private-reference' }, text: 'Texto público com ID duplicado' },
      { backendNodeId: 7, tagName: 'label', parentBackendNodeId: null, attributes: { for: 'shared-native-target' }, text: secret },
      { backendNodeId: 8, tagName: 'div', parentBackendNodeId: 7, attributes: { contenteditable: 'true' }, text: secret, visibleText: secret },
      { backendNodeId: 9, tagName: 'button', parentBackendNodeId: null, attributes: { id: 'shared-native-target' }, rect: { x: 5, y: 70, width: 80, height: 24 } },
      { backendNodeId: 10, tagName: 'button', parentBackendNodeId: null, attributes: { id: 'shared-native-target' }, rect: { x: 5, y: 70, width: 80, height: 24 } },
    ],
    axTree: { nodes: [
      { backendDOMNodeId: 1, role: { value: 'button' }, name: { value: secret } },
      { backendDOMNodeId: 2, role: { value: 'textbox' }, name: { value: secret }, value: { value: secret } },
      { backendDOMNodeId: 3, role: { value: 'button' }, name: { value: 'Ação segura' } },
      { backendDOMNodeId: 4, role: { value: 'button' }, name: { value: secret } },
      { backendDOMNodeId: 5, role: { value: 'button' }, name: { value: 'Ação contaminada' }, description: { value: secret } },
      { backendDOMNodeId: 9, role: { value: 'button' }, name: { value: secret } },
      { backendDOMNodeId: 10, role: { value: 'button' }, name: { value: 'Rótulo público ambíguo' } },
    ] },
  });
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
      return {
        fillRect() {}, drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {}, fillText() {},
        measureText(value) { return { width: [...String(value)].length * 7 }; },
      };
    }
    async convertToBlob() { return new Blob([pngBytes(this.width, this.height)], { type: 'image/png' }); }
  }
  const source = await pristineSource(100, 100, { evidenceId: 'ev-full' });
  const artifact = await composeAnnouncementMap({
    pageId: 'page-1', snapshot: normalized, fullPageEvidence: source,
    layoutMetrics: { cssContentSize: { width: 100, height: 100 } },
    runtime: { OffscreenCanvas: Canvas, createImageBitmap: async () => ({ close() {} }) },
  });
  const input = structuredClone(SAMPLE_AUDIT);
  input.evidence[0] = source;
  input.evidence.push(artifact);
  const model = createAuditModel(input);
  const html = renderHtmlReport(model);

  assert.deepEqual(artifact.legend.map(entry => entry.announcementPreview), ['Ação segura, botão']);
  for (const serialized of [JSON.stringify(artifact), JSON.stringify(model), html]) assert.doesNotMatch(serialized, /TOPSECRET/iu);
});

test('propagates privacy taint through explicit and implicit native label associations', () => {
  const input = snapshot([
    { nodeId: 'label-explicit', tagName: 'label', attributes: { for: 'target-explicit' }, children: ['editor-explicit'] },
    { nodeId: 'editor-explicit', parentId: 'label-explicit', tagName: 'div', attributes: { contenteditable: 'true' } },
    { nodeId: 'target-explicit', tagName: 'button', attributes: { id: 'target-explicit' }, labels: ['label-explicit'], accessibleName: 'TOPSECRET-explicit', axRole: 'button', rect: { x: 5, y: 5, width: 80, height: 24 } },
    { nodeId: 'label-implicit', tagName: 'label', children: ['editor-implicit', 'target-implicit'] },
    { nodeId: 'editor-implicit', parentId: 'label-implicit', tagName: 'div', attributes: { contenteditable: 'true' } },
    { nodeId: 'target-implicit', parentId: 'label-implicit', tagName: 'button', accessibleName: 'TOPSECRET-implicit', axRole: 'button', rect: { x: 5, y: 35, width: 80, height: 24 } },
    { nodeId: 'safe', tagName: 'button', accessibleName: 'Ação segura', axRole: 'button', rect: { x: 5, y: 65, width: 80, height: 24 } },
  ]);

  const selected = selectAnnouncementMapEntries(input);

  assert.deepEqual(selected.entries.map(entry => entry.nodeId), ['safe']);
  assert.doesNotMatch(JSON.stringify(selected), /TOPSECRET/iu);
});

test('keeps missing and duplicate-public ARIA references while tainting a duplicate with any private source', () => {
  const input = snapshot([
    { nodeId: 'missing', tagName: 'button', attributes: { 'aria-labelledby': 'absent' }, accessibleName: 'Salvar', axRole: 'button', rect: { x: 5, y: 5, width: 80, height: 24 } },
    { nodeId: 'public-one', tagName: 'span', attributes: { id: 'duplicate-public' }, text: 'Primeiro' },
    { nodeId: 'public-two', tagName: 'span', attributes: { id: 'duplicate-public' }, text: 'Segundo' },
    { nodeId: 'duplicate-public-consumer', tagName: 'button', attributes: { 'aria-labelledby': 'duplicate-public' }, accessibleName: 'Nome público observado', axRole: 'button', rect: { x: 5, y: 35, width: 80, height: 24 } },
    { nodeId: 'private-source', tagName: 'div', attributes: { id: 'duplicate-private', contenteditable: 'true' } },
    { nodeId: 'public-collision', tagName: 'span', attributes: { id: 'duplicate-private' }, text: 'Colisão pública' },
    { nodeId: 'private-consumer', tagName: 'button', attributes: { 'aria-labelledby': 'duplicate-private' }, accessibleName: 'TOPSECRET-duplicate-private', axRole: 'button', rect: { x: 5, y: 65, width: 80, height: 24 } },
  ]);

  const selected = selectAnnouncementMapEntries(input);

  assert.deepEqual(selected.entries.map(entry => entry.nodeId), ['missing', 'duplicate-public-consumer']);
  assert.doesNotMatch(JSON.stringify(selected), /TOPSECRET/iu);
});

test('counts every omitted frame context from normalized coverage even when no child node was captured', () => {
  const input = snapshot([
    { nodeId: 'frame-host', tagName: 'iframe', accessibleName: 'Conteúdo incorporado', axRole: 'iframe', rect: { x: 0, y: 0, width: 100, height: 80 } },
    { nodeId: 'action', tagName: 'button', accessibleName: 'Continuar', axRole: 'button', rect: { x: 0, y: 90, width: 100, height: 30 } },
  ]);
  input.document.coverage = {
    runtime: { outcome: 'partial', expectedFrameCount: 2, observedFrameCount: 1 },
    accessibility: { outcome: 'partial', expectedFrameCount: 2, observedFrameCount: 1 },
  };
  input.document.warnings = [{ code: 'RUNTIME_FRAME_MISSING', frameId: 'child' }];

  const selected = selectAnnouncementMapEntries(input);

  assert.equal(selected.counts.omittedFrame, 1);
  assert.ok(selected.limitations.includes('frame-content-omitted'));
});

test('plans document-CSS geometry, clipping, non-uniform scale and deterministic overlap', () => {
  const input = snapshot([
    { nodeId: 'one', tagName: 'button', accessibleName: 'Um', axRole: 'button', rect: { x: -10, y: 90, width: 40, height: 30 } },
    { nodeId: 'two', tagName: 'button', accessibleName: 'Dois', axRole: 'button', rect: { x: -10, y: 90, width: 40, height: 30 } },
  ]);

  const plan = buildAnnotationMapPlan({
    snapshot: input,
    sourceMetadata: { width: 200, height: 300 },
    layoutMetrics: { cssContentSize: { width: 100, height: 100 }, scrollX: 500, scrollY: 900 },
  });

  assert.deepEqual(plan.geometry, { cssWidth: 100, cssHeight: 100, scaleX: 2, scaleY: 3, deviceScaleFactor: null });
  assert.deepEqual(plan.entries[0].bounds, { x: 0, y: 90, width: 30, height: 10 });
  assert.equal(plan.entries[0].number, 1);
  assert.equal(plan.entries[1].number, 2);
  assert.ok(plan.counts.unresolvedOverlap >= 0);
  assert.ok(plan.limitations.includes('non-atomic-source-geometry'));
  assert.ok(plan.limitations.includes('non-uniform-pixel-scale'));
  assert.equal(JSON.stringify(plan).includes('scrollX'), false, 'scroll não pode ser somado novamente aos bounds documentais');
});

test('uses a bounded deterministic spiral trail before declaring identical marker anchors unresolved', () => {
  const nodes = Array.from({ length: 9 }, (_, index) => ({
    nodeId: `overlap-${index + 1}`,
    tagName: 'button',
    accessibleName: `Ação ${index + 1}`,
    axRole: 'button',
    rect: { x: 135, y: 135, width: 30, height: 30 },
  }));

  const plan = buildAnnotationMapPlan({
    snapshot: snapshot(nodes),
    sourceMetadata: { width: 300, height: 300 },
    layoutMetrics: { cssContentSize: { width: 300, height: 300 } },
  });
  const placements = plan.segments[0].placements;

  assert.equal(plan.counts.unresolvedOverlap, 0);
  assert.equal(new Set(placements.map(marker => `${marker.x}:${marker.y}`)).size, nodes.length);
  // A ponta da linha-guia é a borda do contorno mais próxima do marcador — nunca o centro do elemento,
  // que riscaria o conteúdo — e é o próprio marcador quando ele já encosta no contorno.
  const rect = { x: 135, y: 135, width: 30, height: 30 };
  let outside = 0;
  for (const marker of placements) {
    const borderX = Math.min(Math.max(marker.x, rect.x), rect.x + rect.width);
    const borderY = Math.min(Math.max(marker.y, rect.y), rect.y + rect.height);
    if (Math.hypot(borderX - marker.x, borderY - marker.y) < 6) {
      assert.deepEqual([marker.leaderX, marker.leaderY], [marker.x, marker.y], 'marcador encostando no contorno');
      continue;
    }
    outside += 1;
    assert.deepEqual([marker.leaderX, marker.leaderY], [borderX, borderY]);
    assert.notEqual(`${marker.leaderX}:${marker.leaderY}`, '150:150');
  }
  assert.ok(outside > 0, 'nenhum marcador ficou fora do contorno para a linha-guia');
});

test('places each number next to its own element, preferring the outer top-left corner', () => {
  const plan = buildAnnotationMapPlan({
    snapshot: snapshot([
      { nodeId: 'narrow', tagName: 'button', accessibleName: 'Estreito', axRole: 'button', rect: { x: 100, y: 100, width: 40, height: 40 } },
      { nodeId: 'wide', tagName: 'button', accessibleName: 'Largo', axRole: 'button', rect: { x: 100, y: 100, width: 400, height: 40 } },
    ]),
    sourceMetadata: { width: 600, height: 300 },
    layoutMetrics: { cssContentSize: { width: 600, height: 300 } },
  });
  const placements = plan.segments[0].placements;

  // O primeiro marcador fica no canto superior-esquerdo exterior do próprio elemento.
  assert.deepEqual([placements[0].x, placements[0].y], [100, 100]);
  // O segundo tem o mesmo canto ocupado: cai no candidato livre mais perto (logo abaixo do canto), e
  // não no primeiro livre da trilha, que ficaria no canto superior-direito a 300 px de distância.
  assert.deepEqual([placements[1].x, placements[1].y], [100, 140]);
  assert.equal(placements[1].overlapped, false);
  assert.equal(plan.counts.unresolvedOverlap, 0);
});

test('omits what an ancestor with its own scrolling hides, without moving what stays visible', () => {
  const selected = selectAnnouncementMapEntries(snapshot([
    { nodeId: 'drawer', tagName: 'div', styles: { 'overflow-x': 'auto', 'overflow-y': 'auto' }, rect: { x: 100, y: 400, width: 460, height: 132 } },
    { nodeId: 'visible', parentId: 'drawer', tagName: 'button', accessibleName: 'Primeiro item', axRole: 'button', rect: { x: 110, y: 446, width: 442, height: 56 } },
    { nodeId: 'sliver', parentId: 'drawer', tagName: 'button', accessibleName: 'Item na borda', axRole: 'button', rect: { x: 110, y: 520, width: 442, height: 56 } },
    { nodeId: 'gone', parentId: 'drawer', tagName: 'button', accessibleName: 'Item rolado para fora', axRole: 'button', rect: { x: 110, y: 614, width: 442, height: 56 } },
    { nodeId: 'far', parentId: 'drawer', tagName: 'button', accessibleName: 'Item muito abaixo', axRole: 'button', rect: { x: 110, y: 782, width: 442, height: 56 } },
  ]));

  // O que está fora aparece na captura integral em outro lugar da página: marcar a posição de layout
  // poria o número sobre um conteúdo que não é o elemento.
  assert.deepEqual(selected.entries.map(entry => entry.nodeId), ['visible', 'sliver']);
  assert.deepEqual(selected.entries.map(entry => entry.bounds.y), [446, 520], 'a caixa anotada continua sendo a do layout, não a recortada');
  assert.deepEqual(selected.counts, {
    eligible: 4, annotated: 2, omittedNoRect: 0, omittedFrame: 0, omittedLimit: 0, unresolvedOverlap: 0, omittedClipped: 2,
  });
  assert.ok(selected.limitations.includes('ancestor-clipped-elements-omitted'));
});

test('only an ancestor that really clips removes elements', () => {
  const styles = [
    // Rolagem da página não esconde nada da captura integral.
    { nodeId: 'root', tagName: 'html', styles: { 'overflow-y': 'hidden' }, rect: { x: 0, y: 0, width: 800, height: 600 } },
    { nodeId: 'page', parentId: 'root', tagName: 'body', styles: { 'overflow-x': 'hidden' }, rect: { x: 0, y: 0, width: 800, height: 600 } },
    { nodeId: 'plain', parentId: 'page', tagName: 'div', styles: { 'overflow-y': 'visible' }, rect: { x: 0, y: 0, width: 800, height: 100 } },
    { nodeId: 'hidden-box', parentId: 'plain', tagName: 'div', styles: { 'overflow-y': 'hidden' }, rect: { x: 0, y: 0, width: 800, height: 100 } },
    { nodeId: 'inner', parentId: 'hidden-box', tagName: 'button', accessibleName: 'Dentro', axRole: 'button', rect: { x: 10, y: 20, width: 80, height: 30 } },
    { nodeId: 'outer', parentId: 'page', tagName: 'button', accessibleName: 'Abaixo de tudo', axRole: 'button', rect: { x: 10, y: 4000, width: 80, height: 30 } },
  ];
  const selected = selectAnnouncementMapEntries(snapshot(styles));
  assert.deepEqual(selected.entries.map(entry => entry.nodeId), ['inner', 'outer']);
  assert.equal(selected.counts.omittedClipped, 0);
  assert.equal(selected.limitations.includes('ancestor-clipped-elements-omitted'), false);

  // `visible` não recorta: um irmão fora da caixa do pai continua anotado.
  const overflowing = selectAnnouncementMapEntries(snapshot([
    { nodeId: 'plain', tagName: 'div', styles: { 'overflow-y': 'visible' }, rect: { x: 0, y: 0, width: 100, height: 100 } },
    { nodeId: 'child', parentId: 'plain', tagName: 'button', accessibleName: 'Sai da caixa', axRole: 'button', rect: { x: 10, y: 400, width: 80, height: 30 } },
  ]));
  assert.deepEqual(overflowing.entries.map(entry => entry.nodeId), ['child']);
});

test('compounds nested scrollports and needs a whole visible pixel to keep an annotation', () => {
  const selected = selectAnnouncementMapEntries(snapshot([
    { nodeId: 'outer', tagName: 'div', styles: { 'overflow-y': 'hidden' }, rect: { x: 0, y: 0, width: 200, height: 200 } },
    { nodeId: 'inner', parentId: 'outer', tagName: 'div', styles: { 'overflow-x': 'scroll' }, rect: { x: 50, y: 50, width: 100, height: 100 } },
    { nodeId: 'both', parentId: 'inner', tagName: 'button', accessibleName: 'Nos dois', axRole: 'button', rect: { x: 100, y: 100, width: 200, height: 200 } },
    { nodeId: 'left-out', parentId: 'inner', tagName: 'button', accessibleName: 'Sai pela esquerda', axRole: 'button', rect: { x: 0, y: 60, width: 40, height: 20 } },
    { nodeId: 'half-pixel', parentId: 'inner', tagName: 'button', accessibleName: 'Vinco', axRole: 'button', rect: { x: 60, y: 150, width: 60, height: 0.4 } },
  ]));
  // O que sobra é o cruzamento dos dois recortes: o do pai morde o filho, e nenhum deles volta atrás.
  assert.deepEqual(selected.entries.map(entry => [entry.nodeId, entry.bounds]), [
    ['both', { x: 100, y: 100, width: 200, height: 200 }],
  ]);
  assert.equal(selected.counts.omittedClipped, 2);
});

test('replaces containers by their annotated descendants instead of numbering the whole container', () => {
  const selected = selectAnnouncementMapEntries(snapshot([
    { nodeId: 'list', tagName: 'ul', axRole: 'list', accessibleName: 'Ações da conta', children: ['item'], rect: { x: 10, y: 10, width: 200, height: 60 } },
    { nodeId: 'item', parentId: 'list', tagName: 'li', axRole: 'listitem', accessibleName: 'Primeiro item', children: ['link'], rect: { x: 10, y: 10, width: 200, height: 30 } },
    { nodeId: 'link', parentId: 'item', tagName: 'a', attributes: { href: 'https://example.test/' }, accessibleName: 'Detalhes', axRole: 'link', rect: { x: 16, y: 14, width: 80, height: 20 } },
    { nodeId: 'lone-region', tagName: 'section', axRole: 'region', accessibleName: 'Sem itens anotados', rect: { x: 10, y: 100, width: 200, height: 30 } },
  ]));

  // O contêiner com descendente anotado sai; o contêiner sem descendente anotado continua entrando.
  assert.deepEqual(selected.entries.map(entry => entry.nodeId), ['link', 'lone-region']);
  assert.deepEqual(selected.counts, {
    eligible: 2, annotated: 2, omittedNoRect: 0, omittedFrame: 0, omittedLimit: 0, unresolvedOverlap: 0, omittedClipped: 0,
  });
  assert.ok(selected.limitations.includes('container-replaced-by-annotated-descendant'));
});

test('draws a thin haloed outline around each annotated element', async () => {
  const strokes = [];
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
      const context = {
        fillRect() {}, drawImage() {}, fill() {}, fillText() {},
        measureText(value) { return { width: [...String(value)].length * 7 }; },
        strokeStyle: '', lineWidth: 0,
        points: [],
        beginPath() { context.points = []; },
        moveTo(x, y) { context.points.push([x, y]); },
        lineTo(x, y) { context.points.push([x, y]); },
        arc() {},
        stroke() { strokes.push({ strokeStyle: context.strokeStyle, lineWidth: context.lineWidth, points: context.points }); },
      };
      return context;
    }
    async convertToBlob() { return new Blob([pngBytes(this.width, this.height)], { type: 'image/png' }); }
  }
  const artifact = await composeAnnouncementMap({
    pageId: 'page-1', fullPageEvidence: await pristineSource(100, 100),
    snapshot: snapshot([{
      nodeId: 'action', tagName: 'button', accessibleName: 'Ação segura', axRole: 'button',
      rect: { x: 10, y: 20, width: 30, height: 40 },
    }]),
    layoutMetrics: { cssContentSize: { width: 100, height: 100 } },
    runtime: { OffscreenCanvas: Canvas, createImageBitmap: async () => ({ close() {} }) },
  });
  const outlines = strokes.filter(stroke => stroke.points.length === 5);
  const rectangle = [[10, 20], [40, 20], [40, 60], [10, 60], [10, 20]];

  assert.equal(artifact.status, 'complete');
  assert.deepEqual(outlines.map(stroke => stroke.points), [rectangle, rectangle]);
  assert.deepEqual(outlines.map(stroke => stroke.strokeStyle), ['#fff', '#8b1e1e']);
  assert.equal(outlines[0].lineWidth > outlines[1].lineWidth, true, 'o halo branco é mais largo que o traço colorido');
  // O marcador preferido é o canto superior-esquerdo do próprio elemento: encostado no contorno, ele
  // dispensa a linha-guia.
  assert.deepEqual(strokes.filter(stroke => stroke.points.length === 2), []);
});

test('sem geometria confiável o mapa de anúncios não desenha número nenhum e diz por quê', async () => {
  const strokes = [];
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
      const context = {
        fillRect() {}, drawImage() {}, fill() {}, fillText() {},
        measureText(value) { return { width: [...String(value)].length * 7 }; },
        strokeStyle: '', lineWidth: 0,
        points: [],
        beginPath() { context.points = []; },
        moveTo(x, y) { context.points.push([x, y]); },
        lineTo(x, y) { context.points.push([x, y]); },
        arc() {},
        stroke() { strokes.push({ strokeStyle: context.strokeStyle, lineWidth: context.lineWidth, points: context.points }); },
      };
      return context;
    }
    async convertToBlob() { return new Blob([pngBytes(this.width, this.height)], { type: 'image/png' }); }
  }
  const fullPageEvidence = await pristineSource(100, 100);
  const artifact = await composeAnnouncementMap({
    pageId: 'page-1', fullPageEvidence,
    snapshot: snapshot([{
      nodeId: 'action', tagName: 'button', accessibleName: 'Ação segura', axRole: 'button',
      rect: { x: 10, y: 20, width: 30, height: 40 },
    }]),
    layoutMetrics: { cssContentSize: { width: 100, height: 100 } },
    sourceAligned: false,
    runtime: { OffscreenCanvas: Canvas, createImageBitmap: async () => ({ close() {} }) },
  });

  // Sem contorno, sem marcador e sem legenda: a imagem sozinha não sugere lugar nenhum.
  assert.deepEqual(strokes, []);
  assert.deepEqual(artifact.segments, []);
  assert.deepEqual(artifact.legend, []);
  assert.deepEqual(artifact.derivation.geometry.annotations, []);
  assert.equal(artifact.status, 'partial');
  assert.ok(artifact.limitations.includes('source-layout-changed'));
  assert.deepEqual(artifact.counts, {
    eligible: 1, annotated: 0, omittedNoRect: 1, omittedFrame: 0, omittedLimit: 0, unresolvedOverlap: 0, omittedClipped: 0,
  });
  assert.deepEqual(validateAnnotationMapArtifact(artifact, { sourceArtifact: fullPageEvidence }), artifact);

  // O relatório diz, em português claro, que nenhum anúncio foi marcado e por quê.
  const [presented] = readerMapPresentation([{ pageId: 'page-1' }], [artifact]);
  assert.match(presented.summary, /nenhum anúncio foi marcado/iu);
  assert.match(presented.coverage, /nenhum foi marcado/iu);
  assert.ok(presented.limitations.some(text => /mudou de tamanho/iu.test(text)));
});

test('ends the leader line on the outline and drops it when the badge already touches the outline', async () => {
  const compose = async rect => {
    const strokes = [];
    class Canvas {
      constructor(width, height) { this.width = width; this.height = height; }
      getContext() {
        const context = {
          fillRect() {}, drawImage() {}, fill() {}, fillText() {},
          measureText(value) { return { width: [...String(value)].length * 7 }; },
          strokeStyle: '', lineWidth: 0,
          points: [],
          beginPath() { context.points = []; },
          moveTo(x, y) { context.points.push([x, y]); },
          lineTo(x, y) { context.points.push([x, y]); },
          arc() {},
          stroke() { strokes.push({ strokeStyle: context.strokeStyle, lineWidth: context.lineWidth, points: context.points }); },
        };
        return context;
      }
      async convertToBlob() { return new Blob([pngBytes(this.width, this.height)], { type: 'image/png' }); }
    }
    const artifact = await composeAnnouncementMap({
      pageId: 'page-1', fullPageEvidence: await pristineSource(100, 100),
      snapshot: snapshot([{ nodeId: 'edge', tagName: 'button', accessibleName: 'Ação na borda', axRole: 'button', rect }]),
      layoutMetrics: { cssContentSize: { width: 100, height: 100 } },
      runtime: { OffscreenCanvas: Canvas, createImageBitmap: async () => ({ close() {} }) },
    });
    // Linha-guia = traço de dois pontos; o contorno tem cinco e o círculo do marcador, nenhum.
    return { artifact, leaders: strokes.filter(stroke => stroke.points.length === 2) };
  };

  // O elemento não cabe até a margem do marcador: a ponta é a borda do contorno, não o centro.
  const outside = await compose({ x: 90, y: 20, width: 6, height: 20 });
  assert.equal(outside.artifact.status, 'complete');
  assert.deepEqual(outside.leaders.map(stroke => stroke.points), [[[84, 20], [90, 20]]]);
  assert.equal(outside.artifact.derivation.geometry.annotations[0].marker.leaderX, 90);
  assert.equal(outside.artifact.derivation.geometry.annotations[0].marker.leaderY, 20);

  // A quatro px do contorno, o marcador já encosta: a linha não é traçada e a ponta guardada é o
  // próprio marcador.
  const touching = await compose({ x: 88, y: 20, width: 8, height: 20 });
  assert.deepEqual(touching.leaders, []);
  assert.equal(touching.artifact.derivation.geometry.annotations[0].marker.leaderX, 84);
});

test('wraps raster legend by measured width and exposes bidi controls as visible tokens', () => {
  let measurements = 0;
  const measureLegendText = value => {
    measurements += 1;
    return [...value].reduce((width, character) => width + (character === 'W' ? 20 : 7), 0);
  };
  const plan = buildAnnotationMapPlan({
    snapshot: snapshot([{
      nodeId: 'wide', tagName: 'button', accessibleName: `WWWWWWWWWW \u202Etexto`, axRole: 'button',
      rect: { x: 5, y: 5, width: 80, height: 24 },
    }]),
    sourceMetadata: { width: 100, height: 100 },
    layoutMetrics: { cssContentSize: { width: 100, height: 100 } },
    measureLegendText,
  });
  const lines = plan.segments.flatMap(segment => segment.legendLines.map(line => line.text));

  assert.ok(measurements > 0);
  assert.equal(lines.every(line => measureLegendText(line) <= 68), true);
  assert.doesNotMatch(lines.join('\n'), /\u202E/u);
  assert.match(lines.join('\n'), /U\+202E/u);
});

test('freezes all declared limits and keeps global numbering across long segments without ellipsis', () => {
  assert.deepEqual(ANNOTATION_MAP_LIMITS, {
    maxNodes: 200,
    maxSourcePixels: 32_000_000,
    maxDimension: 8192,
    maxCanvasPixels: 32_000_000,
    maxSegments: 64,
    maxDerivedBytes: 64 * 1024 * 1024,
    maxLegendCodePoints: 256 * 1024,
  });
  assert.equal(Object.isFrozen(ANNOTATION_MAP_LIMITS), true);

  const nodes = Array.from({ length: 12 }, (_, index) => ({
    nodeId: `n-${index + 1}`, tagName: 'button', accessibleName: `Ação ${index + 1} ${'descrição '.repeat(12)}`,
    axRole: 'button', rect: { x: 4, y: index * 80 + 4, width: 120, height: 30 },
  }));
  const plan = buildAnnotationMapPlan({
    snapshot: snapshot(nodes),
    sourceMetadata: { width: 400, height: 2000 },
    layoutMetrics: { cssContentSize: { width: 200, height: 1000 } },
    segmentCssHeight: 240,
  });

  assert.deepEqual(plan.legend.map(entry => entry.number), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.ok(plan.segments.length > 1);
  assert.equal(plan.segments.every(segment => segment.entryNumbers.every(number => number >= 1 && number <= 12)), true);
  assert.doesNotMatch(JSON.stringify(plan.legend), /…|\.\.\./u);
});

test('moves bounded legend overflow into white continuations and reports entries omitted by the segment cap', () => {
  const nodes = Array.from({ length: 20 }, (_, index) => ({
    nodeId: `long-${index + 1}`,
    tagName: 'button',
    accessibleName: `Ação ${index + 1} ${'conteúdo-sem-segredo '.repeat(50)}`,
    axRole: 'button',
    rect: { x: 5, y: 5 + index * 3, width: 80, height: 24 },
  }));
  const plan = buildAnnotationMapPlan({
    snapshot: snapshot(nodes),
    sourceMetadata: { width: 100, height: 200 },
    layoutMetrics: { cssContentSize: { width: 100, height: 200 } },
  });

  assert.ok(plan.legend.length > 0 && plan.legend.length < 20);
  assert.equal(plan.counts.omittedLimit, 20 - plan.legend.length);
  assert.ok(plan.limitations.includes('legend-limit-reached'));
  assert.ok(plan.segments.some(segment => segment.role === 'legend-continuation'));
  assert.ok(plan.segments.length <= ANNOTATION_MAP_LIMITS.maxSegments);
  assert.equal(plan.segments.filter(segment => segment.role === 'legend-continuation')
    .every(segment => segment.sourceCssClip === null && segment.placements.length === 0), true);
  const renderedLegend = plan.segments.flatMap(segment => segment.legendLines.map(line => line.text)).join('\n');
  for (const entry of plan.legend) assert.match(renderedLegend, new RegExp(`^${entry.number} —|\\n${entry.number} —`, 'u'));
  assert.doesNotMatch(renderedLegend, /…|\.\.\./u);
});

test('plans adjacent fractional CSS clips as contiguous non-overlapping source raster rows', () => {
  const plan = buildAnnotationMapPlan({
    snapshot: snapshot([{
      nodeId: 'fractional', tagName: 'button', accessibleName: 'Ação', axRole: 'button',
      rect: { x: 5, y: 5, width: 80, height: 24 },
    }]),
    sourceMetadata: { width: 100, height: 200 },
    layoutMetrics: { cssContentSize: { width: 100, height: 200 } },
    segmentCssHeight: 200 / 3,
  });
  const clips = plan.segments.filter(segment => segment.role === 'image-and-legend')
    .map(segment => segment.sourcePixelClip);

  assert.deepEqual(clips, [
    { x: 0, y: 0, width: 100, height: 67 },
    { x: 0, y: 67, width: 100, height: 66 },
    { x: 0, y: 133, width: 100, height: 67 },
  ]);
  assert.equal(clips.at(-1).y + clips.at(-1).height, 200);
});

test('bounds every raster segment to a printable page ratio and splits legend continuations', () => {
  const sourceWidth = 100;
  const plan = buildAnnotationMapPlan({
    snapshot: snapshot([{
      nodeId: 'printable', tagName: 'button',
      accessibleName: `Ação ${'conteúdo-sem-segredo '.repeat(25)}`, axRole: 'button',
      rect: { x: 5, y: 5, width: 80, height: 24 },
    }]),
    sourceMetadata: { width: sourceWidth, height: 200 },
    layoutMetrics: { cssContentSize: { width: sourceWidth, height: 200 } },
  });
  const plannedHeight = segment => (segment.sourcePixelClip?.height ?? 0) +
    (segment.legendLines.length ? 34 + 16 * 2 + segment.legendLines.length * 22 : 0);

  assert.ok(plan.segments.filter(segment => segment.role === 'legend-continuation').length > 1);
  assert.equal(plan.segments.every(segment => plannedHeight(segment) <= Math.floor(sourceWidth * 1.3)), true);
  assert.ok(plan.segments.length <= ANNOTATION_MAP_LIMITS.maxSegments);
});

test('fails explicitly when the source aspect cannot fit printable segments within the frozen segment cap', () => {
  assert.throws(() => buildAnnotationMapPlan({
    snapshot: snapshot([{
      nodeId: 'too-tall', tagName: 'button', accessibleName: 'Ação', axRole: 'button',
      rect: { x: 1, y: 1, width: 20, height: 20 },
    }]),
    sourceMetadata: { width: 33, height: 3295 },
    layoutMetrics: { cssContentSize: { width: 33, height: 3295 } },
  }), error => error instanceof AnnotationMapError && error.code === 'ANNOTATION_MAP_PRINT_SEGMENT_LIMIT');
});

test('fails explicitly without worker canvas APIs and never mutates the pristine source', async () => {
  const source = Object.freeze({
    evidenceId: 'full-page-source', pageId: 'page-1', kind: 'full-page', state: 'pristine', dataUrl: PNG,
    hash: '8d9e23c8ce28148f4d51f47e9d933f82f84d3c6560c337266eb7a9bfbc8e441d',
    metadata: { width: 1, height: 1 },
  });
  const before = JSON.stringify(source);

  await assert.rejects(
    composeAnnouncementMap({
      pageId: 'page-1', snapshot: snapshot([]), fullPageEvidence: source,
      runtime: { OffscreenCanvas: undefined, createImageBitmap: undefined },
    }),
    error => error instanceof AnnotationMapError && error.code === 'ANNOTATION_MAP_COMPOSITOR_UNAVAILABLE',
  );
  assert.equal(JSON.stringify(source), before);
});

test('the production compositor rejects a missing pristine source before creating any canvas', async () => {
  let canvasCount = 0;
  assert.equal(Object.isFrozen(ANNOTATION_MAP_MV3_GATE), true);
  await assert.rejects(composeAnnouncementMapForProduction({
    pageId: 'page-1', snapshot: snapshot([]),
    runtime: { OffscreenCanvas: class { constructor() { canvasCount += 1; } }, createImageBitmap: async () => ({ close() {} }) },
  }), error => error instanceof AnnotationMapError && error.code === 'ANNOTATION_MAP_SOURCE_INVALID');
  assert.equal(canvasCount, 0);
});

test('production wrapper composes and revalidates a strict PNG segment with geometry and bitmap cleanup', async () => {
  let closes = 0;
  const canvasSizes = [];
  const canvases = [];
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; canvasSizes.push([width, height]); canvases.push(this); }
    getContext() {
      return {
        fillRect() {}, drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {}, fillText() {},
        measureText(value) { return { width: [...String(value)].length * 7 }; },
      };
    }
    async convertToBlob() { return new Blob([pngBytes(this.width, this.height)], { type: 'image/png' }); }
  }
  const source = await pristineSource(100, 100);
  const before = structuredClone(source);
  const artifact = await composeAnnouncementMapForProduction({
    pageId: 'page-1',
    snapshot: snapshot([{ nodeId: 'action', accessibleName: 'Ação', axRole: 'button', rect: { x: 0, y: 0, width: 1, height: 1 } }]),
    fullPageEvidence: source,
    layoutMetrics: { cssContentSize: { width: 100, height: 100 }, deviceScaleFactor: 2 },
    runtime: { OffscreenCanvas: Canvas, createImageBitmap: async () => ({ close() { closes += 1; } }) },
  });

  assert.equal(artifact.status, 'complete');
  assert.ok(artifact.segments.length >= 1);
  assert.deepEqual(artifact.derivation.geometry.sourceCssSize, { width: 100, height: 100 });
  assert.deepEqual(artifact.derivation.geometry.sourcePixelSize, { width: 100, height: 100 });
  assert.equal(artifact.derivation.geometry.annotations[0].nodeId, 'action');
  assert.equal(artifact.derivation.geometry.annotations[0].marker.size, 28);
  assert.equal(artifact.legend[0].segmentIndex, 1);
  assert.equal(canvasSizes.length, artifact.segments.length + 1);
  artifact.segments.forEach((segment, index) => {
    assert.deepEqual([segment.width, segment.height], canvasSizes[index + 1]);
  });
  assert.equal(canvases.every(canvas => canvas.width === 0 && canvas.height === 0), true);
  assert.equal(closes, 1);
  assert.deepEqual(source, before);
});

test('uses real canvas text metrics and rasterizes visible bidi tokens without clipping legend lines', async () => {
  let measurements = 0;
  const rasterText = [];
  const measuredWidth = value => [...value].reduce((width, character) => width + (character === 'W' ? 20 : 7), 0);
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
      return {
        fillRect() {}, drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {},
        measureText(value) { measurements += 1; return { width: measuredWidth(value) }; },
        fillText(value) { rasterText.push(value); },
      };
    }
    async convertToBlob() { return new Blob([pngBytes(this.width, this.height)], { type: 'image/png' }); }
  }
  const artifact = await composeAnnouncementMap({
    pageId: 'page-1', fullPageEvidence: await pristineSource(100, 100),
    snapshot: snapshot([{
      nodeId: 'wide', tagName: 'button', accessibleName: `WWWWWWWWWW \u202Etexto`, axRole: 'button',
      rect: { x: 5, y: 5, width: 80, height: 24 },
    }]),
    layoutMetrics: { cssContentSize: { width: 100, height: 100 } },
    runtime: { OffscreenCanvas: Canvas, createImageBitmap: async () => ({ close() {} }) },
  });

  assert.equal(artifact.status, 'complete');
  assert.ok(measurements > 0);
  assert.doesNotMatch(rasterText.join('\n'), /\u202E/u);
  assert.match(rasterText.join('\n'), /U\+202E/u);
  const legendLines = rasterText.filter(value => !/^\d+$/u.test(value));
  assert.equal(legendLines.every(line => measuredWidth(line) <= 68), true);
});

test('marks an otherwise rendered map partial when a closed shadow root was omitted', async () => {
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
      return {
        fillRect() {}, drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {}, fillText() {},
        measureText(value) { return { width: [...String(value)].length * 7 }; },
      };
    }
    async convertToBlob() { return new Blob([pngBytes(this.width, this.height)], { type: 'image/png' }); }
  }
  const source = await pristineSource(100, 100);
  const artifact = await composeAnnouncementMap({
    pageId: 'page-1', fullPageEvidence: source,
    snapshot: snapshot([
      { nodeId: 'action', accessibleName: 'Ação segura', axRole: 'button', rect: { x: 0, y: 0, width: 1, height: 1 } },
      { nodeId: 'closed-root', tagName: '#document-fragment', shadowRootType: 'closed' },
    ]),
    layoutMetrics: { cssContentSize: { width: 100, height: 100 } },
    runtime: { OffscreenCanvas: Canvas, createImageBitmap: async () => ({ close() {} }) },
  });

  assert.equal(artifact.status, 'partial');
  assert.ok(artifact.limitations.includes('closed-shadow-root-omitted'));
});

test('classifies invalid pristine input and hash mismatch before allocating a bitmap', async () => {
  let bitmapCalls = 0;
  const runtime = {
    OffscreenCanvas: class {},
    createImageBitmap: async () => { bitmapCalls += 1; return { close() {} }; },
  };
  const common = { pageId: 'page-1', snapshot: snapshot([]), runtime };

  await assert.rejects(composeAnnouncementMap({
    ...common,
    fullPageEvidence: { evidenceId: 'full', pageId: 'page-1', kind: 'full-page', state: 'pristine', dataUrl: 'data:image/png;base64,AAAA', hash: '0'.repeat(64) },
  }), error => error instanceof AnnotationMapError && error.code === 'ANNOTATION_MAP_SOURCE_INVALID');
  await assert.rejects(composeAnnouncementMap({
    ...common,
    fullPageEvidence: { evidenceId: 'full', pageId: 'page-1', kind: 'full-page', state: 'pristine', dataUrl: PNG, hash: '0'.repeat(64) },
  }), error => error instanceof AnnotationMapError && error.code === 'ANNOTATION_MAP_SOURCE_HASH_MISMATCH');
  assert.equal(bitmapCalls, 0);
});

test('rejects a structurally valid source PNG inflate bomb before bitmap allocation', async () => {
  const bytes = pngBytes(1, 1, new Uint8Array(10 * 1024 * 1024));
  let bitmapCalls = 0;
  await assert.rejects(composeAnnouncementMap({
    pageId: 'page-1', snapshot: snapshot([]),
    fullPageEvidence: {
      evidenceId: 'full', pageId: 'page-1', kind: 'full-page', state: 'pristine',
      dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
      hash: await sha256Hex(bytes), metadata: {},
    },
    runtime: { OffscreenCanvas: class {}, createImageBitmap: async () => { bitmapCalls += 1; return { close() {} }; } },
  }), error => error instanceof AnnotationMapError && error.code === 'ANNOTATION_MAP_SOURCE_INVALID');
  assert.equal(bitmapCalls, 0);
});

test('rejects invalid compositor output with a fixed code and still releases the bitmap', async () => {
  let closes = 0;
  class InvalidCanvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
      return {
        fillRect() {}, drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {}, fillText() {},
        measureText(value) { return { width: [...String(value)].length * 7 }; },
      };
    }
    async convertToBlob() { return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }); }
  }
  await assert.rejects(composeAnnouncementMap({
    pageId: 'page-1',
    snapshot: snapshot([{ nodeId: 'action', accessibleName: 'Ação', axRole: 'button', rect: { x: 0, y: 0, width: 1, height: 1 } }]),
    fullPageEvidence: await pristineSource(100, 100),
    layoutMetrics: { cssContentSize: { width: 100, height: 100 } },
    runtime: { OffscreenCanvas: InvalidCanvas, createImageBitmap: async () => ({ close() { closes += 1; } }) },
  }), error => error instanceof AnnotationMapError && error.code === 'ANNOTATION_MAP_OUTPUT_INVALID');
  assert.equal(closes, 1);
});

test('rejects a dimension-matching compositor PNG inflate bomb before accepting derived bytes', async () => {
  let closes = 0;
  class BombCanvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
      return {
        fillRect() {}, drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {}, fillText() {},
        measureText(value) { return { width: [...String(value)].length * 7 }; },
      };
    }
    async convertToBlob() {
      return new Blob([pngBytes(this.width, this.height, new Uint8Array(10 * 1024 * 1024))], { type: 'image/png' });
    }
  }
  await assert.rejects(composeAnnouncementMap({
    pageId: 'page-1',
    snapshot: snapshot([{ nodeId: 'action', accessibleName: 'Ação', axRole: 'button', rect: { x: 0, y: 0, width: 1, height: 1 } }]),
    fullPageEvidence: await pristineSource(100, 100),
    layoutMetrics: { cssContentSize: { width: 100, height: 100 } },
    runtime: { OffscreenCanvas: BombCanvas, createImageBitmap: async () => ({ close() { closes += 1; } }) },
  }), error => error instanceof AnnotationMapError && error.code === 'ANNOTATION_MAP_OUTPUT_INVALID');
  assert.equal(closes, 1);
});

test('honors an already-aborted signal before decoding or allocating a canvas', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('cancelado', 'AbortError'));
  let allocations = 0;

  await assert.rejects(composeAnnouncementMap({
    pageId: 'page-1', snapshot: snapshot([]),
    fullPageEvidence: { evidenceId: 'full', pageId: 'page-1', kind: 'full-page', state: 'pristine', dataUrl: PNG, hash: 'x', metadata: {} },
    signal: controller.signal,
    runtime: { OffscreenCanvas: class { constructor() { allocations += 1; } }, createImageBitmap: async () => ({ close() {} }) },
  }), error => error?.name === 'AbortError');

  assert.equal(allocations, 0);
});

test('times out a stalled bitmap allocation, closes the late bitmap and avoids a render canvas', async () => {
  let resolveBitmap;
  let closes = 0;
  let allocations = 0;
  const stalled = new Promise(resolve => { resolveBitmap = resolve; });
  const source = await pristineSource(100, 100);

  await assert.rejects(composeAnnouncementMap({
    pageId: 'page-1',
    snapshot: snapshot([{ nodeId: 'action', accessibleName: 'Ação', axRole: 'button', rect: { x: 0, y: 0, width: 1, height: 1 } }]),
    fullPageEvidence: source,
    layoutMetrics: { cssContentSize: { width: 100, height: 100 } },
    timeoutMs: 5,
    runtime: {
      OffscreenCanvas: class {
        constructor() { this.width = 1; this.height = 1; allocations += 1; }
        getContext() { return { measureText(value) { return { width: [...String(value)].length * 7 }; } }; }
      },
      createImageBitmap: () => stalled,
    },
  }), error => error instanceof AnnotationMapError && error.code === 'ANNOTATION_MAP_TIMEOUT');

  resolveBitmap({ close() { closes += 1; } });
  // O fechamento do bitmap tardio acontece numa microtask seguinte; sob carga (CI) um único
  // `await Promise.resolve()` não basta e o contador ainda está em 0.
  for (let tick = 0; tick < 20 && closes === 0; tick += 1) await Promise.resolve();
  assert.equal(closes, 1);
  assert.equal(allocations, 1, 'somente o canvas transitório de métricas pode ter sido alocado');
});

test('cancels the active PNG inflate reader when the compositor deadline expires', async () => {
  const OriginalDecompressionStream = globalThis.DecompressionStream;
  let cancellations = 0;
  globalThis.DecompressionStream = class {
    constructor() {
      this.readable = new ReadableStream({ cancel() { cancellations += 1; } });
      this.writable = new WritableStream({ write() {}, close() {} });
    }
  };
  try {
    await assert.rejects(composeAnnouncementMap({
      pageId: 'page-1', snapshot: snapshot([]),
      fullPageEvidence: {
        evidenceId: 'full', pageId: 'page-1', kind: 'full-page', state: 'pristine', dataUrl: PNG,
        hash: '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460', metadata: {},
      },
      timeoutMs: 5,
      runtime: { OffscreenCanvas: class {}, createImageBitmap: async () => ({ close() {} }) },
    }), error => error instanceof AnnotationMapError && error.code === 'ANNOTATION_MAP_TIMEOUT');
    await Promise.resolve();
    assert.equal(cancellations, 1);
  } finally {
    globalThis.DecompressionStream = OriginalDecompressionStream;
  }
});
