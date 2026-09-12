import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot } from '../../src/core/normalize-snapshot.js';
import { runRules } from '../../src/core/rules/run-rules.js';
import { VISUAL_RULES } from '../../src/core/rules/visual.js';

function capture(extra) {
  const records = [
    { tag: '#document', parent: -1 }, { tag: 'HTML', parent: 0 }, { tag: 'BODY', parent: 1 }, ...extra
  ];
  const strings = [];
  const s = value => { if (!strings.includes(value)) strings.push(value); return strings.indexOf(value); };
  const styles = { display: 'block', visibility: 'visible', opacity: '1', color: 'rgb(255, 255, 255)',
    'background-color': 'rgb(255, 255, 255)', 'background-image': 'none', 'font-size': '16px', 'font-weight': '400' };
  const nodes = {
    parentIndex: records.map(r => r.parent), nodeType: records.map(r => r.tag === '#document' ? 9 : r.tag === '#text' ? 3 : 1),
    nodeName: records.map(r => s(r.tag)), nodeValue: records.map(r => s(r.text ?? '')),
    backendNodeId: records.map((_, i) => i + 1), attributes: records.map(r => Object.entries(r.attrs ?? {}).flatMap(([k, v]) => [s(k), s(v)]))
  };
  const document = { documentURL: s('https://example.test/'), title: s('Contraste'), frameId: s('main'), nodes,
    layout: { nodeIndex: records.map((_, i) => i), bounds: records.map(() => [0, 0, 80, 20]),
      styles: records.map(() => Object.values(styles).map(s)) } };
  return { domSnapshot: { strings, computedStyles: Object.keys(styles), documents: [document] },
    pageData: [{ frameId: 'main', result: { nodes: records.map((r, i) => ({ backendNodeId: i + 1, contrastReliable: true, styles: { ...styles, ...r.styles },
      ...(r.disabled === undefined ? {} : { disabled: r.disabled }) })) } }] };
}

async function evaluate(records) {
  const snapshot = normalizeSnapshot(capture(records));
  const results = await runRules(snapshot, {}, VISUAL_RULES.filter(r => ['text-contrast-minimum', 'text-contrast-enhanced'].includes(r.id)));
  return { snapshot, results };
}

test('inactive text and its aggregate ancestors do not become contrast failures', async () => {
  const { results } = await evaluate([
    { tag: 'BUTTON', parent: 2, attrs: { disabled: '' } },
    { tag: 'SPAN', parent: 3 }, { tag: '#text', parent: 4, text: 'Enviar' }
  ]);
  for (const result of results) {
    assert.equal(result.outcome, 'inapplicable');
    assert.deepEqual(result.targets, []);
  }
});

test('observed inherited inactivity does not exempt first legend instructions', async () => {
  const { snapshot, results } = await evaluate([
    { tag: 'FIELDSET', parent: 2, attrs: { disabled: '' } },
    { tag: 'LEGEND', parent: 3 }, { tag: '#text', parent: 4, text: 'Informações' },
    { tag: 'BUTTON', parent: 3, disabled: true }, { tag: '#text', parent: 6, text: 'Enviar' }
  ]);
  for (const result of results) {
    assert.equal(result.outcome, 'failed');
    assert.deepEqual(result.targets.map(t => snapshot.nodes.find(n => n.nodeId === t.nodeId).tagName), ['legend']);
  }
});

test('disabled on a generic element does not create a native contrast exception', async () => {
  const { results } = await evaluate([
    { tag: 'DIV', parent: 2, attrs: { disabled: '' } }, { tag: '#text', parent: 3, text: 'Texto' }
  ]);
  for (const result of results) assert.equal(result.outcome, 'failed');
});

test('only the direct text owner supplies colors, not aggregate ancestor styles', async () => {
  const { results } = await evaluate([
    { tag: 'SPAN', parent: 2, styles: { color: 'rgb(0, 0, 0)' } },
    { tag: '#text', parent: 3, text: 'Texto legível' }
  ]);
  for (const result of results) assert.equal(result.outcome, 'passed');
});

test('text provenance is derived after privacy redaction', async () => {
  const { snapshot, results } = await evaluate([
    { tag: 'DIV', parent: 2, attrs: { contenteditable: 'true' } },
    { tag: 'SPAN', parent: 3 }, { tag: '#text', parent: 4, text: 'PRIVATE-TEXT-SENTINEL' }
  ]);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE-TEXT-SENTINEL'), false);
  assert.ok(snapshot.nodes.every(n => n.textContrastScope === 'aggregate'));
  for (const result of results) assert.equal(result.outcome, 'inapplicable');
});

test('own instructions next to an inactive control remain applicable without aggregate duplicates', async () => {
  const { snapshot, results } = await evaluate([
    { tag: '#text', parent: 2, text: 'Leia as instruções' },
    { tag: 'BUTTON', parent: 2, attrs: { disabled: '' } },
    { tag: '#text', parent: 4, text: 'Enviar' }
  ]);
  for (const result of results) {
    assert.equal(result.outcome, 'failed');
    assert.equal(result.targets.length, 1);
    assert.equal(snapshot.nodes.find(n => n.nodeId === result.targets[0].nodeId).tagName, 'body');
  }
});

test('active nested links and external labels are not exempted by an inactive button', async () => {
  const { snapshot, results } = await evaluate([
    { tag: 'BUTTON', parent: 2, attrs: { disabled: '' } },
    { tag: 'A', parent: 3, attrs: { href: '/help' } },
    { tag: '#text', parent: 4, text: 'Ajuda' },
    { tag: 'LABEL', parent: 2 }, { tag: '#text', parent: 6, text: 'Nome' }
  ]);
  for (const result of results) {
    assert.equal(result.outcome, 'failed');
    assert.deepEqual(result.targets.map(t => snapshot.nodes.find(n => n.nodeId === t.nodeId).tagName), ['a', 'label']);
  }
});
