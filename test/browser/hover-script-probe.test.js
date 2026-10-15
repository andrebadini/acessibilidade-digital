import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOVER_SCRIPT_EVENTS,
  HOVER_SCRIPT_LIMITS,
  KEYBOARD_PATH_EVENTS,
  categorizeListeners,
  inspectHoverScriptPaths,
  scriptHoverWithoutKeyboardPath,
} from '../../src/browser/hover-script-probe.js';

/**
 * Sessão CDP falsa só com o que esta leitura usa: um arranjo de cadeias por bloco, ouvintes por nó e
 * a possibilidade de falhar em pontos escolhidos. `chains` recebe, por bloco, a lista de níveis —
 * `null` é o nível que não existe, como no Chrome.
 */
class FakeCdp {
  constructor(chains, { failOn = null, propertiesWithoutObjectId = false } = {}) {
    this.chains = new Map(Object.entries(chains));
    this.failOn = failOn;
    this.propertiesWithoutObjectId = propertiesWithoutObjectId;
    this.calls = [];
    this.listenerNodes = new Map();
  }

  async command(method, params = {}) {
    this.calls.push(method);
    if (method === this.failOn) throw new Error(`falha simulada em ${method}`);
    if (method === 'Runtime.evaluate') {
      const payload = JSON.parse(String(params.expression).slice(String(params.expression).lastIndexOf('})({') + 3, -1));
      const objectIds = [];
      for (const path of payload.paths) {
        const chain = this.chains.get(path.join('.')) ?? [];
        for (let depth = 0; depth <= payload.levels; depth += 1) {
          const types = depth < chain.length ? chain[depth] : undefined;
          if (!Array.isArray(types)) { objectIds.push(null); continue; }
          const objectId = `${path.join('.')}#${depth}`;
          this.listenerNodes.set(objectId, types);
          objectIds.push(objectId);
        }
      }
      const arrayObjectId = `array-${this.calls.length}`;
      this.arrayObjectId = arrayObjectId;
      this.arrayValue = objectIds;
      return { result: { objectId: arrayObjectId } };
    }
    if (method === 'Runtime.getProperties') {
      if (params.objectId !== this.arrayObjectId) throw new Error('arranjo desconhecido');
      return { result: this.arrayValue.map((objectId, index) => ({
        name: String(index),
        value: objectId === null
          ? { type: 'object', subtype: 'null', value: null }
          : { type: 'object', objectId: this.propertiesWithoutObjectId ? undefined : objectId },
      })) };
    }
    if (method === 'DOMDebugger.getEventListeners') {
      const types = this.listenerNodes.get(params.objectId);
      if (types === undefined) throw new Error('nó sem ouvintes registrados');
      if (types === 'fail') throw new Error('falha simulada de ouvintes');
      return { listeners: types.map(type => ({ type, useCapture: false, passive: false })) };
    }
    throw new Error(`comando não esperado: ${method}`);
  }
}

test('the listener catalog stays explicit: what opens with the mouse and what opens with the keyboard', () => {
  assert.deepEqual([...HOVER_SCRIPT_EVENTS], ['mouseenter', 'mouseover', 'pointerenter', 'pointerover']);
  assert.deepEqual([...KEYBOARD_PATH_EVENTS], ['focus', 'focusin', 'keydown', 'click']);
  assert.deepEqual(HOVER_SCRIPT_LIMITS, {
    ancestorLevels: 3, maxGroups: 60, maxListeners: 200, deadlineMs: 6_000, timeoutMs: 15_000,
  });
});

test('listener types are classified without ever trusting the shape of the list', () => {
  assert.deepEqual(categorizeListeners([{ type: 'mouseenter' }, { type: 'click' }]),
    { hoverScript: true, keyboardPath: true });
  assert.deepEqual(categorizeListeners([{ type: 'pointerover' }]), { hoverScript: true, keyboardPath: false });
  assert.deepEqual(categorizeListeners([{ type: 'keydown' }]), { hoverScript: false, keyboardPath: true });
  assert.deepEqual(categorizeListeners([{ type: 'scroll' }, { type: 'mousemove' }]),
    { hoverScript: false, keyboardPath: false });
  // Uma página hostil pode devolver qualquer coisa: nada aqui pode lançar.
  for (const hostile of [null, undefined, 'x', [{ type: 7 }], [{}, null], [null]]) {
    assert.deepEqual(categorizeListeners(hostile), { hoverScript: false, keyboardPath: false });
  }
});

test('the doubt only exists when the mouse side is present and the keyboard side is not', () => {
  assert.equal(scriptHoverWithoutKeyboardPath({ hoverScript: true, keyboardPath: false }), true);
  assert.equal(scriptHoverWithoutKeyboardPath({ hoverScript: true, keyboardPath: true }), false);
  assert.equal(scriptHoverWithoutKeyboardPath({ hoverScript: false, keyboardPath: false }), false);
  assert.equal(scriptHoverWithoutKeyboardPath(null), false);
  // Registro antigo, sem os campos: nada muda para quem não foi lido.
  assert.equal(scriptHoverWithoutKeyboardPath({}), false);
});

test('the chain of a block is read level by level, including a listener on an ancestor', async () => {
  const cdp = new FakeCdp({ '1.0': [['mouseenter'], [], ['keydown']] });
  const inspection = await inspectHoverScriptPaths(cdp, [{ key: '1.0', anchorPath: [1, 0] }]);

  assert.equal(inspection.inspected, true);
  assert.deepEqual(inspection.uninspected, []);
  assert.deepEqual(inspection.entries.get('1.0'), { hoverScript: true, keyboardPath: true });
  // Quatro níveis por bloco (o bloco e três ancestrais), um deles sem nó: posições fixas no arranjo.
  assert.equal(cdp.calls.filter(method => method === 'DOMDebugger.getEventListeners').length, 3);
});

test('a block whose chain only has mouse listeners is the case the doubt describes', async () => {
  const cdp = new FakeCdp({ '1.0': [['mouseenter', 'mouseleave'], [], [], null] });
  const inspection = await inspectHoverScriptPaths(cdp, [{ key: '1.0', anchorPath: [1, 0] }]);

  assert.equal(inspection.inspected, true);
  assert.deepEqual(inspection.entries.get('1.0'), { hoverScript: true, keyboardPath: false });
});

test('a block without listeners is read and passes as nothing to report', async () => {
  const cdp = new FakeCdp({ '1.0': [[], [], [], []] });
  const inspection = await inspectHoverScriptPaths(cdp, [{ key: '1.0', anchorPath: [1, 0] }]);

  assert.equal(inspection.inspected, true);
  assert.deepEqual(inspection.entries.get('1.0'), { hoverScript: false, keyboardPath: false });
});

test('a block that disappeared before the reading is left without a verdict', async () => {
  const cdp = new FakeCdp({ '1.0': [null, ['mouseenter']] });
  const inspection = await inspectHoverScriptPaths(cdp, [{ key: '1.0', anchorPath: [1, 0] }]);

  assert.equal(inspection.inspected, false);
  assert.deepEqual(inspection.uninspected, ['1.0']);
  assert.equal(inspection.entries.size, 0);
});

test('a chain whose listeners cannot be read stays uninspected instead of "no listeners"', async () => {
  const cdp = new FakeCdp({ '1.0': ['fail', [], [], []] });
  const inspection = await inspectHoverScriptPaths(cdp, [{ key: '1.0', anchorPath: [1, 0] }]);

  assert.equal(inspection.inspected, false);
  assert.deepEqual(inspection.uninspected, ['1.0']);
});

test('a broken batch is never mistaken for a page without listeners', async () => {
  const noObjectId = new FakeCdp({ '1.0': [['mouseenter'], [], [], []] }, { propertiesWithoutObjectId: true });
  const first = await inspectHoverScriptPaths(noObjectId, [{ key: '1.0', anchorPath: [1, 0] }]);
  assert.equal(first.inspected, false);
  assert.deepEqual(first.uninspected, ['1.0']);

  for (const failOn of ['Runtime.evaluate', 'Runtime.getProperties']) {
    const cdp = new FakeCdp({ '1.0': [['mouseenter'], [], [], []] }, { failOn });
    const inspection = await inspectHoverScriptPaths(cdp, [{ key: '1.0', anchorPath: [1, 0] }]);
    assert.equal(inspection.inspected, false, failOn);
    assert.deepEqual(inspection.uninspected, ['1.0'], failOn);
  }
});

test('the levels and the number of blocks stay bounded by the declared limits', async () => {
  const cdp = new FakeCdp({
    '1.0': [['mouseenter'], [], ['mouseenter'], ['mouseenter'], ['keydown']],
    '2.0': [['mouseenter']],
  });
  const inspection = await inspectHoverScriptPaths(cdp, [
    { key: '1.0', anchorPath: [1, 0] }, { key: '2.0', anchorPath: [2, 0] },
  ], { limits: { ancestorLevels: 1, maxGroups: 1 } });

  // Só o bloco e um ancestral de cada bloco são lidos: o `keydown` dois níveis acima fica fora.
  assert.deepEqual(inspection.entries.get('1.0'), { hoverScript: true, keyboardPath: false });
  assert.equal(inspection.attempted, 1);
  assert.deepEqual(inspection.uninspected, ['2.0']);
  assert.equal(inspection.inspected, false);

  const perBlock = cdp.listenerNodes.size;
  assert.equal(perBlock, 2, 'um bloco lido com dois níveis');
});

test('an invalid CDP client is rejected instead of silently reporting a clean page', async () => {
  await assert.rejects(() => inspectHoverScriptPaths(null, []), /CDP/iu);
  const inspection = await inspectHoverScriptPaths(new FakeCdp({}), []);
  assert.equal(inspection.inspected, true);
  assert.equal(inspection.entries.size, 0);
});
