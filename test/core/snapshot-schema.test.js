import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SNAPSHOT_SCHEMA_VERSION,
  assertSnapshotV1,
  buildSnapshotIndexes,
  validateSnapshotV1
} from '../../src/core/snapshot-schema.js';
import { computeAccessibleText } from '../../src/core/accessibility/accessible-name.js';

function validSnapshot() {
  return {
    schemaVersion: 1,
    document: { nodeId: 'document', title: 'Página' },
    nodes: [
      { nodeId: 'text-node', tagName: '#text', attributes: { id: 'not-the-node-id' }, text: 'Enviar', children: [], parentId: 'button-node' },
      { nodeId: 'button-node', tagName: 'button', attributes: {}, text: '', children: ['text-node'], parentId: null },
      { nodeId: 'label-node', tagName: 'span', attributes: { id: 'dom-label' }, text: 'Conta', children: [], parentId: null }
    ]
  };
}

test('SnapshotV1 has separate runtime nodeId and DOM id indexes', () => {
  const snapshot = validSnapshot();
  const indexes = buildSnapshotIndexes(snapshot);

  assert.equal(SNAPSHOT_SCHEMA_VERSION, 1);
  assert.equal(indexes.byNodeId.get('label-node').attributes.id, 'dom-label');
  assert.deepEqual(indexes.byDomId.get('dom-label'), [snapshot.nodes[2]]);
  assert.equal(indexes.byNodeId.has('dom-label'), false);
  assert.equal(Object.hasOwn(snapshot, 'byNodeId'), false);
  assert.equal(Object.hasOwn(snapshot, 'byDomId'), false);
  assert.doesNotMatch(JSON.stringify(snapshot), /byNodeId|byDomId/);
});

test('accessible name resolves children by nodeId and labelledby by unique DOM id', () => {
  const snapshot = validSnapshot();
  const indexes = buildSnapshotIndexes(snapshot);
  const button = snapshot.nodes[1];

  assert.equal(computeAccessibleText(button, indexes).name, 'Enviar');
  button.attributes['aria-labelledby'] = 'dom-label';
  assert.deepEqual(computeAccessibleText(button, indexes), {
    name: 'Conta', nameSource: 'aria-labelledby',
    description: '', descriptionSource: 'none'
  });
});

test('duplicate DOM ids are conservatively ignored for accessible references', () => {
  const snapshot = validSnapshot();
  snapshot.nodes.push({
    nodeId: 'second-label', tagName: 'span', attributes: { id: 'dom-label' },
    text: 'SEGREDO', children: [], parentId: null
  });
  const button = snapshot.nodes[1];
  button.attributes['aria-labelledby'] = 'dom-label';
  button.attributes['aria-label'] = 'Alternativa segura';

  assert.equal(computeAccessibleText(button, buildSnapshotIndexes(snapshot)).name, 'Alternativa segura');
});

test('native labels use label nodeIds while for continues to use a unique DOM id', () => {
  const snapshot = validSnapshot();
  const explicit = {
    nodeId: 'explicit-label', tagName: 'label', attributes: { for: 'email-dom' },
    text: 'E-mail', children: [], parentId: null
  };
  const collected = {
    nodeId: 'collected-label', tagName: 'label', attributes: {},
    text: 'Contato', children: [], parentId: null
  };
  const input = {
    nodeId: 'email-node', tagName: 'input', attributes: { id: 'email-dom' },
    text: '', children: [], parentId: null, labels: ['collected-label']
  };
  snapshot.nodes.push(explicit, collected, input);

  assert.equal(computeAccessibleText(input, buildSnapshotIndexes(snapshot)).name, 'Contato E-mail');
});

test('SnapshotV1 validator rejects namespace, reference and serialization violations', () => {
  assert.deepEqual(validateSnapshotV1(validSnapshot()), []);
  assert.equal(assertSnapshotV1(validSnapshot()).schemaVersion, 1);

  const malformed = validSnapshot();
  malformed.nodes[1].children = ['missing'];
  malformed.byNodeId = new Map();
  assert.match(validateSnapshotV1(malformed).join('\n'), /missing|índice|index/i);
  assert.throws(() => assertSnapshotV1(malformed), /snapshotv1/i);
});
