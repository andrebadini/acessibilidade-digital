import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot } from '../../src/core/normalize-snapshot.js';
import { STRUCTURE_RULES } from '../../src/core/rules/structure.js';

function observedHeading(tag, attributes, level, role = 'heading') {
  const strings = [];
  const s = value => { let index = strings.indexOf(value); if (index < 0) { index = strings.length; strings.push(value); } return index; };
  return normalizeSnapshot({
    domSnapshot: { strings, computedStyles: ['display', 'visibility'], documents: [{
      frameId: s('main'), documentURL: s('https://example.test/'), title: s('Exemplo'),
      nodes: { parentIndex: [-1, 0, 1, 2], nodeType: [9, 1, 1, 1],
        nodeName: ['#document', 'HTML', 'BODY', tag].map(s), nodeValue: [s(''), s(''), s(''), s('')],
        backendNodeId: [1, 2, 3, 4], attributes: [[], [], [], Object.entries(attributes).flat().map(s)] },
      layout: { nodeIndex: [1, 2, 3], bounds: [[0, 0, 200, 60], [0, 0, 200, 60], [0, 0, 100, 30]],
        styles: Array.from({ length: 3 }, () => [s('block'), s('visible')]) }
    }] },
    axTree: { nodes: [{ backendDOMNodeId: 4, role: { value: role }, name: { value: 'Serviços' },
      properties: level === undefined ? [] : [{ name: 'level', value: { value: level } }] }] }, warnings: []
  });
}
const semantics = snapshot => STRUCTURE_RULES.find(rule => rule.id === 'heading-semantics').evaluate(snapshot);

for (const [label, tag, attrs, level] of [
  ['native H1', 'H1', {}, 1],
  ['ARIA heading', 'DIV', { role: 'heading', 'aria-level': '1' }, 1],
  ['ARIA level above six', 'DIV', { role: 'heading', 'aria-level': '7' }, 7],
]) test(`real normalizer preserves valid ${label} for semantic evaluation`, () => {
  assert.equal(semantics(observedHeading(tag, attrs, level)).outcome, 'passed');
});

test('missing observed level is uncertainty, not proof of invalid author semantics', () => {
  assert.equal(semantics(observedHeading('DIV', { role: 'heading', 'aria-level': '1' }, undefined)).outcome, 'cantTell');
});

test('invalid observed level remains a failure', () => {
  assert.equal(semantics(observedHeading('DIV', { role: 'heading', 'aria-level': '0' }, 0)).outcome, 'failed');
});

test('native heading whose effective role was changed is not approved', () => {
  assert.equal(semantics(observedHeading('H1', { role: 'button' }, undefined, 'button')).outcome, 'failed');
});

test('browser fallback level cannot approve ARIA heading missing required aria-level', () => {
  assert.equal(semantics(observedHeading('DIV', { role: 'heading' }, 2)).outcome, 'failed');
});

for (const declared of ['', 'abc', '0', '1.5']) test(`browser fallback cannot conceal invalid aria-level ${JSON.stringify(declared)}`, () => {
  assert.equal(semantics(observedHeading('DIV', { role: 'heading', 'aria-level': declared }, 2)).outcome, 'failed');
});
