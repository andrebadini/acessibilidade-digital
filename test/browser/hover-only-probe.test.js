import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOVER_ONLY_PROBE_LIMITS,
  applyHoverOnlyProbe,
  mergeHoverOnlyIntoSnapshot,
  normalizeHoverOnlyProbe,
  runHoverOnlyProbe
} from '../../src/browser/hover-only-probe.js';
import { HOVER_ONLY_OBSERVATION_KEY } from '../../src/core/rules/hover-only.js';
import { validateSnapshotV1 } from '../../src/core/snapshot-schema.js';

/**
 * Sessão CDP falsa com uma página minúscula: cada grupo é um bloco com alvos escondidos que aparecem
 * conforme a pseudo-classe forçada. O `CSS.forcePseudoState` só registra o que foi forçado, de modo
 * que os testes podem provar que nada sobra depois da sondagem.
 *
 * `group.transitionMs` modela a página que anima a abertura: a primeira leitura depois de cada
 * mudança de pseudo-classe ainda vê o estado anterior, e diz quanto falta para a animação terminar —
 * exatamente o que o Chrome real publica em `getAnimations()`. `group.stuckAnimating` modela a
 * animação mais longa que o teto de espera.
 */
class FakeCdp {
  constructor(page, { failOn = null, documentRegistered = false, warmupFails = false } = {}) {
    this.page = page;
    this.failOn = failOn;
    // O Chrome real devolve `nodeId` 0 em `DOM.describeNode` enquanto a árvore do documento não foi
    // registrada nesta sessão; `DOM.getDocument` é o que registra.
    this.documentRegistered = documentRegistered;
    this.warmupFails = warmupFails;
    this.forced = new Map();
    this.forcedHistory = [];
    this.calls = [];
    this.lag = new Map();
    this.reads = 0;
  }

  forcedStateOf(nodeId) {
    return this.forced.get(nodeId) ?? [];
  }

  leftoverForcedStates() {
    return [...this.forced.entries()].filter(([, classes]) => classes.length > 0);
  }

  async command(method, params = {}) {
    this.calls.push(method);
    if (method === this.failOn) throw new Error(`falha simulada em ${method}`);
    if (method === 'DOM.enable' || method === 'CSS.enable') return {};
    if (method === 'DOM.getDocument') {
      if (this.warmupFails) throw new Error('falha simulada em DOM.getDocument');
      this.documentRegistered = true;
      return { root: { nodeId: 1 } };
    }
    if (method === 'DOM.pushNodesByBackendIdsToFrontend') {
      const nodeIds = (params.backendNodeIds ?? []).map(backendNodeId =>
        (this.page.find(group => group.backendNodeId === backendNodeId)?.nodeId) ?? 0);
      return { nodeIds };
    }
    if (method === 'Runtime.releaseObject' || method === 'Runtime.releaseObjectGroup') return {};
    if (method === 'Runtime.getProperties') {
      const objectIds = this.chainArrays.get(params.objectId);
      if (!objectIds) throw new Error('arranjo de cadeias desconhecido');
      return { result: objectIds.map((objectId, index) => ({
        name: String(index),
        enumerable: true,
        value: objectId === null
          ? { type: 'object', subtype: 'null', value: null }
          : { type: 'object', subtype: 'node', objectId },
      })) };
    }
    if (method === 'DOMDebugger.getEventListeners') {
      const node = this.listenerNodes.get(params.objectId);
      if (!node) throw new Error('objeto sem ouvintes registrados');
      if (node.group?.listenerFailure === true) throw new Error('falha simulada em DOMDebugger.getEventListeners');
      return { listeners: node.types.map(type => ({ type, useCapture: false })) };
    }
    if (method === 'Input.dispatchMouseEvent') {
      this.pointerMoves.push({ x: params.x, y: params.y, type: params.type });
      this.pointer = { x: params.x, y: params.y };
      for (const group of this.page) {
        if (this.#pointerOver(group)) this.pointerTouched.add(group.anchorPath.join('.'));
      }
      return {};
    }
    if (method === 'CSS.forcePseudoState') {
      const previous = new Map(this.forced);
      this.forced.set(params.nodeId, [...params.forcedPseudoClasses]);
      this.forcedHistory.push({ nodeId: params.nodeId, classes: [...params.forcedPseudoClasses] });
      for (const group of this.page) {
        if (!group.transitionMs) continue;
        const before = this.#revealed(group, previous);
        const after = this.#revealed(group, this.forced);
        if (before === after) continue;
        this.lag.set(group.anchorPath.join('.'), { revealed: before, settleMs: group.transitionMs, remaining: 1 });
      }
      return {};
    }
    if (method === 'Runtime.evaluate') return this.#evaluate(String(params.expression));
    if (method === 'DOM.describeNode') {
      const entry = this.#byObjectId.get(params.objectId);
      if (!entry) throw new Error('objeto desconhecido');
      return { node: {
        nodeId: this.documentRegistered ? entry.nodeId : 0,
        backendNodeId: entry.backendNodeId
      } };
    }
    if (method === 'DOM.requestNode') {
      const entry = this.#byObjectId.get(params.objectId);
      if (!entry) throw new Error('objeto desconhecido');
      return { nodeId: this.documentRegistered ? entry.nodeId : 0 };
    }
    throw new Error(`comando não esperado: ${method}`);
  }

  #byObjectId = new Map();

  // Modelo dos ouvintes e do ponteiro: a cadeia de cada bloco é uma lista por nível — o nível sem
  // nó não existe (posição nula no arranjo, como no Chrome), e o nível com lista vazia existe sem
  // ouvinte. O ponteiro só "pousa" no bloco quando o cliente o move para o ponto declarado.
  listenerNodes = new Map();

  chainArrays = new Map();

  pointerMoves = [];

  pointer = null;

  pointerTouched = new Set();

  #chains = 0;

  #groupFor(path) {
    return this.page.find(group => group.anchorPath.join('.') === path.join('.')) ?? null;
  }

  #pointerOver(group) {
    const point = group.pointerPoint ?? { x: 100, y: 100 };
    return !!this.pointer && this.pointer.x === point.x && this.pointer.y === point.y;
  }

  #entryForPath(path) {
    for (const group of this.page) {
      const anchor = `${group.anchorPath.join('.')}`;
      if (anchor === path.join('.')) {
        return { nodeId: group.nodeId, backendNodeId: group.backendNodeId, group, focus: false };
      }
      if (group.focusPath) {
        const focus = `${[...group.anchorPath, ...group.focusPath].join('.')}`;
        if (focus === path.join('.')) {
          return { nodeId: group.focusNodeId, backendNodeId: group.focusBackendNodeId, group, focus: true };
        }
      }
    }
    return null;
  }

  #revealed(group, forced = this.forced) {
    const stateOf = nodeId => forced.get(nodeId) ?? [];
    if (group.alwaysVisible === true) return group.targetCount;
    // Menu que abre por script: quem revela é o ponteiro de verdade sobre o bloco. `pointerSticky`
    // modela o menu que não fecha quando o ponteiro sai — o caso em que a página não volta ao estado.
    if (group.pointerReveals === true &&
      (this.#pointerOver(group) || (group.pointerSticky === true && this.pointerTouched.has(group.anchorPath.join('.'))))) {
      return group.targetCount;
    }
    if (group.hoverReveals === false) return 0;
    const anchorForced = stateOf(group.nodeId);
    if (anchorForced.includes('hover')) return group.targetCount;
    if (!group.revealsOnFocus) return 0;
    const focusForced = group.focusNodeId === undefined
      ? anchorForced.includes('focus')
      : stateOf(group.focusNodeId).includes('focus');
    return anchorForced.includes('focus-within') && focusForced ? group.targetCount : 0;
  }

  /** Leitura de uma medição, com a defasagem da transição declarada quando ela existe. */
  #read(group) {
    this.reads += 1;
    const lag = this.lag.get(group.anchorPath.join('.'));
    if (lag && lag.remaining > 0) {
      lag.remaining -= 1;
      return { revealed: lag.revealed, settleMs: lag.settleMs };
    }
    this.lag.delete(group.anchorPath.join('.'));
    return { revealed: this.#revealed(group), settleMs: group.stuckAnimating === true ? 300 : 0 };
  }

  #evaluate(expression) {
    if (expression.includes('discoverHoverOnlyCandidates')) {
      return { result: { value: {
        ok: true,
        scanned: this.page.length,
        discovered: this.page.filter(group => group.discovered !== false).length,
        truncated: this.page.some(group => group.truncated === true),
        groups: this.page.filter(group => group.discovered !== false).map(group => ({
          key: group.anchorPath.join('.'),
          anchorPath: group.anchorPath,
          targetCount: group.targetCount,
          targets: group.targets,
          selfFocusable: group.selfFocusable === true,
          focusPath: group.focusPath ?? null
        }))
      } } };
    }
    if (expression.includes('measureHoverOnlyReveal')) {
      const payload = JSON.parse(expression.slice(expression.lastIndexOf('})({') + 3, -1));
      const group = this.page.find(candidate => candidate.anchorPath.join('.') === payload.anchorPath.join('.'));
      if (!group || group.anchorMissing === true) {
        return { result: { value: { anchorMissing: true, revealed: 0, total: 0, settleMs: 0 } } };
      }
      const reading = this.#read(group);
      return { result: { value: {
        anchorMissing: false,
        revealed: reading.revealed,
        total: payload.targetPaths.length,
        settleMs: reading.settleMs
      } } };
    }
    if (expression.includes('collectHoverScriptChains')) {
      const payload = JSON.parse(expression.slice(expression.lastIndexOf('})({') + 3, -1));
      const objectIds = [];
      for (const path of payload.paths) {
        const group = this.#groupFor(path);
        const chain = group?.chain ?? [[], [], [], []];
        for (let depth = 0; depth <= payload.levels; depth += 1) {
          const types = depth < chain.length ? chain[depth] : null;
          if (!Array.isArray(types)) {
            objectIds.push(null);
            continue;
          }
          const objectId = `listeners-${path.join('.')}-${depth}`;
          this.listenerNodes.set(objectId, { group, depth, types });
          objectIds.push(objectId);
        }
      }
      const arrayObjectId = `chains-${this.#chains}`;
      this.#chains += 1;
      this.chainArrays.set(arrayObjectId, objectIds);
      return { result: { objectId: arrayObjectId } };
    }
    if (expression.includes('anchorPointerTarget')) {
      const path = JSON.parse(/\((\[[^\]]*\])\)$/u.exec(expression)[1]);
      const group = this.#groupFor(path);
      if (!group || group.pointerGeometry === false) return { result: { value: null } };
      const point = group.pointerPoint ?? { x: 100, y: 100 };
      return { result: { value: {
        ...point,
        onTarget: group.pointerOnTarget !== false,
        scrolled: group.pointerScrolled === true,
        scrollX: 0,
        scrollY: 0,
      } } };
    }
    if (expression.includes('window.scrollTo')) return { result: { value: null } };
    const match = /const path = (\[[^\]]*\]);/u.exec(expression);
    const path = match ? JSON.parse(match[1]) : [];
    const entry = this.#entryForPath(path);
    if (!entry) return { result: {} };
    const objectId = `obj-${path.join('.')}`;
    this.#byObjectId.set(objectId, entry);
    return { result: { objectId } };
  }
}

function page(overrides = {}) {
  return [{
    anchorPath: [1, 0],
    nodeId: 11,
    backendNodeId: 101,
    targets: [[0, 0], [0, 1], [0, 2], [0, 3]],
    targetCount: 4,
    selfFocusable: false,
    focusPath: null,
    hoverReveals: true,
    revealsOnFocus: false,
    ...overrides
  }];
}

function snapshotDocument() {
  return {
    schemaVersion: 1,
    document: { nodeId: 'document', title: 'Serviços', language: 'pt-BR' },
    nodes: [{
      nodeId: 'n-101',
      tagName: 'div',
      attributes: { class: 'service' },
      text: 'Serviços',
      children: [],
      parentId: 'document',
      hidden: false,
      selectorHint: 'div.service',
      role: ''
    }]
  };
}

test('the probe forces hover, measures and always gives the page back untouched', async () => {
  const cdp = new FakeCdp(page());
  const observation = await runHoverOnlyProbe(cdp);

  assert.equal(observation.status, 'complete');
  assert.equal(observation.truncated, false);
  assert.deepEqual(observation.warnings, []);
  assert.equal(observation.groups.length, 1);
  assert.equal(observation.groups[0].outcome, 'failed');
  assert.equal(observation.groups[0].revealedOnHover, 4);
  assert.equal(observation.groups[0].backendNodeId, 101);
  assert.equal(observation.groups[0].restored, true);
  assert.deepEqual(cdp.leftoverForcedStates(), []);
  assert.deepEqual(cdp.forcedHistory, [{ nodeId: 11, classes: ['hover'] }, { nodeId: 11, classes: [] }]);
});

test('a card that also reveals on focus is keyboard reachable and does not fail', async () => {
  const cdp = new FakeCdp(page({
    selfFocusable: false,
    focusPath: [1],
    focusNodeId: 12,
    focusBackendNodeId: 102,
    revealsOnFocus: true
  }));
  const observation = await runHoverOnlyProbe(cdp);

  assert.equal(observation.groups[0].outcome, 'passed');
  assert.equal(observation.groups[0].revealedByFocus, true);
  assert.equal(observation.status, 'complete');
  assert.deepEqual(cdp.leftoverForcedStates(), []);
  assert.deepEqual(cdp.forcedHistory.at(-2), { nodeId: 12, classes: [] });
  assert.deepEqual(cdp.forcedHistory.at(-1), { nodeId: 11, classes: [] });
  assert.deepEqual(cdp.forcedHistory.slice(0, 2), [
    { nodeId: 11, classes: ['hover'] },
    { nodeId: 11, classes: [] }
  ]);
});

test('a focusable control whose focus does not reveal the hidden links stays unconfirmed', async () => {
  const cdp = new FakeCdp(page({
    focusPath: [0],
    focusNodeId: 12,
    focusBackendNodeId: 102,
    revealsOnFocus: false
  }));
  const observation = await runHoverOnlyProbe(cdp);

  assert.equal(observation.groups[0].outcome, 'cantTell');
  assert.equal(observation.groups[0].focusableInside, true);
  assert.equal(observation.status, 'complete');
  assert.deepEqual(cdp.leftoverForcedStates(), []);
});

test('a card whose hidden content does not appear on hover is not a finding', async () => {
  const cdp = new FakeCdp(page({ hoverReveals: false }));
  const observation = await runHoverOnlyProbe(cdp);

  assert.equal(observation.groups[0].outcome, 'passed');
  assert.equal(observation.groups[0].revealedOnHover, 0);
  assert.equal(observation.status, 'complete');
  // Uma leitura da sondagem e uma da prova de restauração: sem animação em curso não há nova espera.
  assert.equal(cdp.reads, 2, 'sem animação em curso, nenhuma leitura extra de espera');
});

test('a card that opens with an animated transition is still a confirmed failure', async () => {
  // Página real que anima a abertura: no instante em que o hover é forçado o alvo ainda está
  // escondido e só aparece com a transição. Ler só a primeira medição daria "passou" no cartão
  // exatamente defeituoso.
  const cdp = new FakeCdp(page({ transitionMs: 200 }));
  const observation = await runHoverOnlyProbe(cdp);

  assert.equal(observation.groups[0].outcome, 'failed');
  assert.equal(observation.groups[0].revealedOnHover, 4);
  assert.equal(observation.status, 'complete');
  assert.equal(observation.groups[0].restored, true, 'a animação de fechamento também precisa ser respeitada');
  assert.ok(cdp.reads >= 3, `a sondagem precisa remedir depois da transição: ${cdp.reads} leitura(s)`);
  assert.deepEqual(cdp.leftoverForcedStates(), []);
});

test('a card whose animation outlasts the wait becomes a doubt instead of a pass', async () => {
  const cdp = new FakeCdp(page({ hoverReveals: false, stuckAnimating: true }));
  const observation = await runHoverOnlyProbe(cdp);

  const normalized = normalizeHoverOnlyProbe(observation);
  assert.equal(observation.groups[0].outcome, 'cantTell');
  assert.equal(observation.groups[0].unsettled, true);
  assert.equal(normalized.outcome, 'cantTell');
  assert.equal(normalized.groups[0].unsettled, true);
  assert.equal(observation.status, 'complete');
});

test('a group left visible without forced state removes the whole claim from the report', async () => {
  const cdp = new FakeCdp(page({ alwaysVisible: true }));
  const observation = await runHoverOnlyProbe(cdp);

  assert.equal(observation.groups[0].restored, false);
  assert.equal(observation.withheldGroups, 1);
  assert.equal(observation.status, 'incomplete');
  assert.equal(observation.examinedGroups, 0);
  assert.equal(observation.warnings.filter(warning => warning.code === 'PROBE_FAILED').length, 1);
  assert.deepEqual(cdp.leftoverForcedStates(), []);
});

test('a group whose anchor disappeared is dropped and marks the coverage incomplete', async () => {
  const cdp = new FakeCdp(page({ anchorMissing: true }));
  const observation = await runHoverOnlyProbe(cdp);

  assert.equal(observation.status, 'incomplete');
  assert.deepEqual(observation.groups, []);
  assert.equal(cdp.leftoverForcedStates().length, 0);
});

test('a CDP failure becomes an incomplete observation instead of breaking the audit', async () => {
  for (const failOn of ['DOM.enable', 'CSS.enable', 'Runtime.evaluate', 'CSS.forcePseudoState']) {
    const cdp = new FakeCdp(page(), { failOn });
    const observation = await runHoverOnlyProbe(cdp);

    assert.equal(observation.status, 'incomplete', failOn);
    assert.equal(observation.warnings.some(warning => warning.code === 'PROBE_FAILED'), true, failOn);
    assert.equal(observation.warnings.length, 1, failOn);
    assert.deepEqual(cdp.leftoverForcedStates(), [], failOn);
  }
});

test('an invalid CDP client is rejected instead of silently skipped', async () => {
  await assert.rejects(() => runHoverOnlyProbe(null), /CDP/iu);
  assert.throws(() => mergeHoverOnlyIntoSnapshot({}, null), /snapshotv1/iu);
});

test('the probe registers the document before it asks for frontend node ids', async () => {
  const cdp = new FakeCdp(page(), { documentRegistered: false });
  const observation = await runHoverOnlyProbe(cdp);

  assert.equal(observation.groups[0].outcome, 'failed');
  const warmup = cdp.calls.indexOf('DOM.getDocument');
  const described = cdp.calls.indexOf('DOM.describeNode');
  assert.notEqual(warmup, -1, `a árvore precisa ser registrada antes de descrever nós: ${cdp.calls.join(',')}`);
  assert.ok(warmup < described, `sem registro, describeNode devolve nodeId 0: ${cdp.calls.join(',')}`);
});

test('when the document cannot be registered, the backend ids still resolve the anchors', async () => {
  const cdp = new FakeCdp(page(), { documentRegistered: false, warmupFails: true });
  const observation = await runHoverOnlyProbe(cdp);

  assert.equal(observation.groups[0].outcome, 'failed');
  assert.equal(observation.status, 'complete');
  assert.equal(cdp.calls.includes('DOM.pushNodesByBackendIdsToFrontend'), true);
  assert.deepEqual(cdp.leftoverForcedStates(), []);
});

test('the probe limits stay explicit and bounded', () => {
  assert.deepEqual(HOVER_ONLY_PROBE_LIMITS, {
    maxAncestorLevels: 6,
    maxGroups: 60,
    maxTargetsPerGroup: 20,
    maxCandidates: 20_000,
    maxSettleMs: 600,
    deadlineMs: 20_000,
    maxScriptGroups: 60,
    scriptDeadlineMs: 6_000,
    maxPointerGroups: 5,
    maxPointerScrollSettleMs: 250
  });
});

test('a menu that only a script opens, with no keyboard path, becomes a human review', async () => {
  const cdp = new FakeCdp(page({ hoverReveals: false, chain: [['mouseenter', 'mouseleave']] }));
  const observation = await runHoverOnlyProbe(cdp);

  assert.equal(observation.groups[0].outcome, 'cantTell');
  assert.equal(observation.groups[0].hoverScript, true);
  assert.equal(observation.groups[0].keyboardPath, false);
  assert.equal(observation.status, 'complete');
  // A leitura dos ouvintes é consulta, não é interação: nada de evento de ponteiro no modo passivo.
  assert.equal(cdp.calls.includes('Input.dispatchMouseEvent'), false);
  assert.deepEqual(cdp.leftoverForcedStates(), []);

  const normalized = normalizeHoverOnlyProbe(observation);
  assert.equal(normalized.groups[0].hoverScript, true);
  assert.equal(normalized.groups[0].keyboardPath, false);
  assert.equal(normalized.outcome, 'cantTell');
});

test('a keyboard listener on the block or on an ancestor keeps the script menu out of the report', async () => {
  const withKeydown = new FakeCdp(page({
    hoverReveals: false,
    chain: [['mouseenter'], ['keydown'], []],
  }));
  const withFocus = new FakeCdp(page({ hoverReveals: false, chain: [['pointerenter', 'focusin']] }));

  for (const cdp of [withKeydown, withFocus]) {
    const observation = await runHoverOnlyProbe(cdp);
    assert.equal(observation.groups[0].outcome, 'passed');
    assert.equal(observation.groups[0].keyboardPath, true);
    assert.equal(observation.groups[0].hoverScript, true);
    assert.equal(observation.status, 'complete');
  }
});

test('a visible focusable control inside the block skips the listener reading entirely', async () => {
  const cdp = new FakeCdp(page({
    hoverReveals: false,
    selfFocusable: false,
    focusPath: [1],
    focusNodeId: 12,
    focusBackendNodeId: 102,
    chain: [['mouseenter']],
  }));
  const observation = await runHoverOnlyProbe(cdp);

  assert.equal(observation.groups[0].outcome, 'passed');
  assert.equal(cdp.calls.includes('DOMDebugger.getEventListeners'), false,
    `com caminho de teclado conhecido não há o que perguntar: ${cdp.calls.join(',')}`);
});

test('with pointer interaction allowed, the script menu is confirmed as a failure', async () => {
  const cdp = new FakeCdp(page({ hoverReveals: false, pointerReveals: true, chain: [['mouseenter']] }));
  const observation = await runHoverOnlyProbe(cdp, { allowPointerInteraction: true });

  assert.equal(observation.groups[0].outcome, 'failed');
  assert.equal(observation.groups[0].revealedByPointer, 4);
  assert.equal(observation.groups[0].revealedOnHover, 4);
  assert.equal(observation.status, 'complete');
  // Dois movimentos: um para cima do bloco e outro para fora, para a página voltar como estava.
  const moves = cdp.pointerMoves.filter(move => move.type === 'mouseMoved');
  assert.equal(moves.length, 2, `o ponteiro precisa entrar e sair: ${JSON.stringify(cdp.pointerMoves)}`);
  assert.deepEqual(moves[1], { x: 1, y: 1, type: 'mouseMoved' });
  assert.deepEqual(cdp.leftoverForcedStates(), []);
});

test('a real pointer that finds nothing keeps the script block as a pass', async () => {
  const cdp = new FakeCdp(page({ hoverReveals: false, pointerReveals: false, chain: [['mouseenter']] }));
  const observation = await runHoverOnlyProbe(cdp, { allowPointerInteraction: true });

  assert.equal(observation.groups[0].outcome, 'passed');
  assert.equal(observation.groups[0].hoverScript, true);
  assert.equal(observation.status, 'complete');
});

test('a pointer that cannot land on the block leaves the doubt instead of confirming it', async () => {
  const cdp = new FakeCdp(page({
    hoverReveals: false, pointerReveals: true, pointerOnTarget: false, chain: [['mouseenter']],
  }));
  const observation = await runHoverOnlyProbe(cdp, { allowPointerInteraction: true });

  assert.equal(observation.groups[0].outcome, 'cantTell');
  assert.equal(observation.groups[0].revealedByPointer, 0);
  assert.equal(cdp.pointerMoves.length, 0, 'sem ponto confiável, o ponteiro não se move');
});

test('a script menu that stays open after the pointer leaves is withheld from the report', async () => {
  const cdp = new FakeCdp(page({
    hoverReveals: false, pointerReveals: true, pointerSticky: true, chain: [['mouseenter']],
  }));
  const observation = await runHoverOnlyProbe(cdp, { allowPointerInteraction: true });

  assert.equal(observation.groups[0].outcome, 'failed');
  assert.equal(observation.groups[0].restored, false);
  assert.equal(observation.withheldGroups, 1);
  assert.equal(observation.status, 'incomplete');
  assert.equal(observation.warnings.some(warning => warning.code === 'PROBE_FAILED'), true);
});

test('an unreadable listener list is never reported as a pass', async () => {
  const cdp = new FakeCdp(page({ hoverReveals: false, listenerFailure: true, chain: [['mouseenter']] }));
  const observation = await runHoverOnlyProbe(cdp);

  assert.equal(observation.status, 'incomplete');
  assert.equal(observation.warnings.some(warning => warning.code === 'PROBE_FAILED'), true);
  // Sem leitura não há indício: o bloco fica sem conclusão, e a observação incompleta é o que a
  // regra transforma em dúvida em vez de "nada encontrado".
  assert.equal(observation.groups[0].hoverScript, false);
  assert.equal(normalizeHoverOnlyProbe(observation).outcome, 'cantTell');
});

test('normalization drops unusable groups and keeps a confirmed failure even when truncated', () => {
  const truncated = normalizeHoverOnlyProbe({
    status: 'complete',
    truncated: true,
    candidates: 40,
    examinedGroups: 1,
    withheldGroups: 0,
    warnings: [],
    groups: [{ backendNodeId: 101, outcome: 'failed', targetCount: 4, revealedOnHover: 4, focusableInside: false }]
  });

  assert.equal(truncated.outcome, 'failed');
  assert.equal(truncated.truncated, true);
  assert.deepEqual(truncated.groups, [{
    nodeId: 'n-101', targetCount: 4, revealedOnHover: 4, focusableInside: false, unsettled: false,
    hoverScript: false, keyboardPath: false, outcome: 'failed'
  }]);

  const hostile = normalizeHoverOnlyProbe({
    status: 'complete',
    truncated: false,
    groups: [
      { backendNodeId: 101, outcome: 'unexpected' },
      { backendNodeId: -3, outcome: 'failed' },
      { backendNodeId: 'x', outcome: 'failed' },
      { backendNodeId: 102, outcome: 'cantTell' }
    ]
  });

  assert.deepEqual(hostile.groups.map(group => group.nodeId), ['n-102']);
  assert.equal(hostile.outcome, 'cantTell');
  assert.equal(normalizeHoverOnlyProbe({ status: 'omitted' }).status, 'omitted');
  assert.equal(normalizeHoverOnlyProbe(null).outcome, 'cantTell');
  assert.equal(normalizeHoverOnlyProbe({ status: 'complete', groups: [] }).outcome, 'passed');
});

test('the observation is attached to the snapshot without mutating the received object', () => {
  const snapshot = snapshotDocument();
  const frozen = structuredClone(snapshot);
  const merged = mergeHoverOnlyIntoSnapshot(snapshot, normalizeHoverOnlyProbe({
    status: 'complete',
    truncated: false,
    warnings: [],
    groups: [
      { backendNodeId: 101, outcome: 'failed', targetCount: 4, revealedOnHover: 4, focusableInside: false },
      { backendNodeId: 102, outcome: 'passed', targetCount: 1, revealedOnHover: 1, focusableInside: true }
    ]
  }));

  assert.deepEqual(snapshot, frozen, 'o snapshot de entrada precisa permanecer intacto');
  assert.deepEqual(validateSnapshotV1(merged), []);
  assert.equal(merged.document[HOVER_ONLY_OBSERVATION_KEY].outcome, 'failed');
  assert.equal(merged.document[HOVER_ONLY_OBSERVATION_KEY].status, 'complete');
  const [node] = merged.nodes;
  assert.deepEqual(node[HOVER_ONLY_OBSERVATION_KEY], {
    outcome: 'failed', targetCount: 4, revealedOnHover: 4
  });
  assert.notEqual(node, frozen.nodes[0]);
  assert.doesNotMatch(JSON.stringify(merged), /selectorHint.*service.*selectorHint/u);
});

test('a passed group leaves the node untouched and an omitted probe marks the page as uncollected', () => {
  const snapshot = snapshotDocument();
  const passed = mergeHoverOnlyIntoSnapshot(snapshot, normalizeHoverOnlyProbe({
    status: 'complete',
    truncated: false,
    warnings: [],
    groups: [{ backendNodeId: 101, outcome: 'passed', targetCount: 4, revealedOnHover: 4, focusableInside: true }]
  }));
  const omitted = mergeHoverOnlyIntoSnapshot(snapshot, normalizeHoverOnlyProbe({ status: 'omitted' }));

  assert.equal(HOVER_ONLY_OBSERVATION_KEY in passed.nodes[0], false);
  assert.equal(passed.document[HOVER_ONLY_OBSERVATION_KEY].outcome, 'passed');
  assert.equal(omitted.document[HOVER_ONLY_OBSERVATION_KEY].status, 'omitted');
  assert.equal(omitted.document[HOVER_ONLY_OBSERVATION_KEY].groups.length, 0);
});

test('the pipeline hook never throws and records why the observation is missing', async () => {
  const snapshot = snapshotDocument();
  const broken = { command: async () => { throw new Error('sessão perdida'); } };
  const applied = await applyHoverOnlyProbe(snapshot, broken);
  const observation = applied.document[HOVER_ONLY_OBSERVATION_KEY];

  assert.equal(observation.status, 'incomplete');
  assert.equal(observation.outcome, 'cantTell');
  assert.equal(observation.warnings.some(warning => warning.code === 'PROBE_FAILED'), true);
  assert.deepEqual(validateSnapshotV1(applied), []);
  assert.deepEqual(snapshot, snapshotDocument());
});

test('the pipeline hook attaches a confirmed finding on the card that was probed', async () => {
  const applied = await applyHoverOnlyProbe(snapshotDocument(), new FakeCdp(page()));
  const observation = applied.document[HOVER_ONLY_OBSERVATION_KEY];

  assert.equal(observation.outcome, 'failed');
  assert.equal(observation.status, 'complete');
  assert.equal(applied.nodes[0][HOVER_ONLY_OBSERVATION_KEY].outcome, 'failed');
});
