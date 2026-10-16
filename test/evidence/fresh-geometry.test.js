import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SOURCE_LAYOUT_HEIGHT_TOLERANCE_PX,
  SOURCE_LAYOUT_WIDTH_TOLERANCE_PX,
  contentSizeOf,
  domSnapshotRects,
  layoutAgreement,
  snapshotFrameId,
  withFreshRects,
} from '../../src/core/evidence/fresh-geometry.js';

const metrics = (width, height) => ({ cssContentSize: { width, height } });

/**
 * Instantâneo estrutural mínimo, no formato que a coleta produz: `nodeId` no padrão `n-<backendNodeId>`,
 * `rect` em px CSS de documento e `framePath` vazio para o documento principal.
 */
function structuralSnapshot(entries) {
  return {
    nodes: entries.map(([backendNodeId, rect, framePath = []]) => ({
      nodeId: `n-${backendNodeId}`,
      backendNodeId,
      label: 'Botão',
      ...(rect ? { rect } : {}),
      framePath,
    })),
  };
}

/**
 * Resposta de `DOMSnapshot.captureSnapshot` no formato colunar de verdade: `strings` para os textos,
 * `documents[].frameId` como índice nessa tabela e `layout.nodeIndex`/`layout.bounds` alinhados por índice
 * de nó. Uma entrada com `rect: null` é nó sem caixa — o navegador simplesmente não o lista em `layout`.
 */
function columnarCapture(entries, { frameId = 'https://exemplo.test/', strings = [frameId] } = {}) {
  const nodes = { nodeType: [9], nodeName: ['#document'], backendNodeId: [undefined] };
  const nodeIndex = [];
  const bounds = [];
  entries.forEach(([backendNodeId, rect], offset) => {
    const index = offset + 1;
    nodes.nodeType.push(1);
    nodes.nodeName.push('BUTTON');
    nodes.backendNodeId.push(backendNodeId);
    if (rect) {
      nodeIndex.push(index);
      bounds.push([rect.x, rect.y, rect.width, rect.height]);
    }
  });
  return {
    strings,
    documents: [{ frameId: strings.indexOf(frameId), nodes, layout: { nodeIndex, bounds } }],
  };
}

test('lê os retângulos do instantâneo colunar indexados por backendNodeId', () => {
  const rects = domSnapshotRects(columnarCapture([
    [11, { x: 0, y: 0, width: 1280, height: 40 }],
    [12, { x: 8, y: 100, width: 120, height: 32 }],
    [13, null],
  ]));

  assert.equal(rects.size, 2);
  assert.deepEqual(rects.get(12), { x: 8, y: 100, width: 120, height: 32 });
  assert.equal(rects.has(13), false, 'nó sem caixa não entra no índice');
});

test('descarta caixa sem tamanho e captura sem nada utilizável vira ausência de geometria', () => {
  const rects = domSnapshotRects(columnarCapture([
    [11, { x: 0, y: 0, width: 0, height: 40 }],
    [12, { x: 0, y: 0, width: 100, height: 0 }],
  ]));
  assert.equal(rects, null);

  assert.equal(domSnapshotRects(null), null);
  assert.equal(domSnapshotRects({}), null);
  assert.equal(domSnapshotRects({ strings: [], documents: [] }), null);
  assert.equal(domSnapshotRects({ strings: ['a'], documents: [{ nodes: {}, layout: null }] }), null);
});

test('escolhe o documento principal pelo frameId da leitura estrutural', () => {
  const strings = ['https://principal.test/', 'https://quadro.test/'];
  const main = columnarCapture([[11, { x: 1, y: 1, width: 10, height: 10 }]], { frameId: strings[0], strings });
  const child = columnarCapture([[99, { x: 0, y: 0, width: 5, height: 5 }]], { frameId: strings[1], strings });
  const capture = { strings, documents: [main.documents[0], child.documents[0]] };

  const rects = domSnapshotRects(capture, { frameId: strings[1] });
  assert.equal(rects.size, 1);
  assert.deepEqual(rects.get(99), { x: 0, y: 0, width: 5, height: 5 });
  // Sem frame conhecido vale o primeiro documento, a convenção da normalização do instantâneo.
  assert.deepEqual([...domSnapshotRects(capture).keys()], [11]);

  assert.equal(snapshotFrameId({ nodes: [{ framePath: [] }, { frameId: strings[0] }] }), strings[0]);
  assert.equal(snapshotFrameId({ nodes: [] }), null);
});

test('página que cresceu entre a leitura e a captura recebe as caixas do estado da imagem', () => {
  // A leitura estrutural viu o item em y=200 (antes de o aviso entrar no topo); a imagem mostra o aviso
  // ocupando 120 px, e o item desceu para y=320. É o retângulo fresco que vale.
  const snapshot = structuralSnapshot([
    [11, { x: 40, y: 200, width: 160, height: 32 }],
    [12, { x: 40, y: 260, width: 160, height: 32 }],
  ]);
  const rects = domSnapshotRects(columnarCapture([
    [11, { x: 40, y: 320, width: 160, height: 32 }],
    [12, { x: 40, y: 380, width: 160, height: 32 }],
  ]));

  const result = withFreshRects(snapshot, rects);

  assert.equal(result.applied, true);
  assert.equal(result.replaced, 2);
  assert.deepEqual(result.dropped, new Set());
  assert.deepEqual(result.snapshot.nodes.map(node => node.rect.y), [320, 380]);
  assert.deepEqual(snapshot.nodes.map(node => node.rect.y), [200, 260], 'o instantâneo da auditoria não é alterado');
});

test('nó que sumiu perde só a própria caixa; os outros continuam desenhando', () => {
  const snapshot = structuralSnapshot([
    [11, { x: 0, y: 0, width: 100, height: 20 }],
    [12, { x: 0, y: 40, width: 100, height: 20 }],
    [13, { x: 0, y: 80, width: 100, height: 20 }],
  ]);
  const rects = domSnapshotRects(columnarCapture([
    [11, { x: 0, y: 0, width: 100, height: 20 }],
    // 12 virou `display:none` depois do aviso entrar: não aparece na medição fresca.
    [13, { x: 0, y: 80, width: 100, height: 20 }],
  ]));

  const result = withFreshRects(snapshot, rects);

  assert.equal(result.replaced, 2);
  assert.deepEqual(result.dropped, new Set(['n-12']));
  assert.equal(result.snapshot.nodes[0].rect.y, 0);
  assert.equal(result.snapshot.nodes[1].rect, undefined, 'sem caixa fresca, sem caixa');
  assert.equal(result.snapshot.nodes[2].rect.y, 80);
  assert.equal(snapshot.nodes[1].rect.y, 40, 'a evidência estrutural guarda o retângulo lido');
});

test('nó de frame interno e nó sem backendNodeId ficam como estavam', () => {
  const snapshot = structuralSnapshot([
    [11, { x: 0, y: 0, width: 10, height: 10 }],
    [12, { x: 0, y: 0, width: 10, height: 10 }],
  ]);
  snapshot.nodes[1].framePath = ['#quadro'];
  const rects = domSnapshotRects(columnarCapture([[11, { x: 5, y: 5, width: 10, height: 10 }]]));

  const result = withFreshRects(snapshot, rects);

  assert.equal(result.snapshot.nodes[0].rect.x, 5);
  assert.deepEqual(result.snapshot.nodes[1].rect, { x: 0, y: 0, width: 10, height: 10 });
  assert.deepEqual(result.snapshot.nodes[1].framePath, ['#quadro']);

  const synthetic = { nodes: [{ nodeId: 'n-a', rect: { x: 1, y: 2, width: 3, height: 4 } }] };
  const untouched = withFreshRects(synthetic, rects);
  assert.equal(untouched.applied, false);
  assert.equal(untouched.snapshot, synthetic);
  assert.deepEqual(untouched.dropped, new Set());
});

test('sem geometria fresca o instantâneo volta intacto', () => {
  const snapshot = structuralSnapshot([[11, { x: 0, y: 0, width: 10, height: 10 }]]);

  for (const rects of [null, undefined, new Map()]) {
    const result = withFreshRects(snapshot, rects);
    assert.equal(result.applied, false);
    assert.equal(result.snapshot, snapshot);
    assert.equal(result.replaced, 0);
  }
});

test('o leiaute está parado dentro das tolerâncias e mexeu fora delas', () => {
  assert.deepEqual(layoutAgreement(metrics(1280, 3121), metrics(1280, 3121)), {
    stable: true, widthDrift: 0, heightDrift: 0, reason: 'measured',
  });
  assert.equal(layoutAgreement(
    metrics(1280, 3121),
    metrics(1280 + SOURCE_LAYOUT_WIDTH_TOLERANCE_PX, 3121 - SOURCE_LAYOUT_HEIGHT_TOLERANCE_PX),
  ).stable, true);
  assert.equal(layoutAgreement(
    metrics(1280, 3121),
    metrics(1280 + SOURCE_LAYOUT_WIDTH_TOLERANCE_PX + 1, 3121),
  ).stable, false, 'uma barra de rolagem que apareceu muda a largura em mais que a tolerância');
  assert.equal(layoutAgreement(
    metrics(1280, 3121),
    metrics(1280, 3121 + SOURCE_LAYOUT_HEIGHT_TOLERANCE_PX + 1),
  ).stable, false);
  assert.equal(layoutAgreement(null, metrics(1280, 3121)).reason, 'size-unavailable');
  assert.equal(layoutAgreement(metrics(1280, 3121), {}).reason, 'size-unavailable');
});

test('fator de escala 2 não muda a geometria: os retângulos já vêm em px CSS', () => {
  // O instantâneo devolve px CSS de documento; quem multiplica pelo fator de escala é o compositor, a partir
  // das métricas. Aqui a única coisa que importa é que a medição fresca com tela 2x aponta o mesmo elemento.
  const snapshot = structuralSnapshot([[11, { x: 10, y: 10, width: 200, height: 40 }]]);
  const rects = domSnapshotRects(columnarCapture([[11, { x: 10, y: 10, width: 200, height: 40 }]]));
  const result = withFreshRects(snapshot, rects);

  assert.deepEqual(result.snapshot.nodes[0].rect, { x: 10, y: 10, width: 200, height: 40 });
  assert.equal(contentSizeOf(metrics(1280, 800)).width, 1280);
});
