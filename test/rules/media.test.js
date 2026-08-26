import test from 'node:test';
import assert from 'node:assert/strict';

import { MEDIA_RULES } from '../../src/core/rules/media.js';
import { runRules } from '../../src/core/rules/run-rules.js';

function record(nodeId, tagName, overrides = {}) {
  return { nodeId, tagName, attributes: {}, text: '', children: [], parentId: null, hidden: false, selectorHint: `#${nodeId}`, role: '', ...overrides };
}

function snapshot(nodes = [], documentOverrides = {}) {
  const document = { nodeId: 'document', ...documentOverrides };
  return { document, nodes, byId: Object.fromEntries([['document', document], ...nodes.map(node => [String(node.nodeId), node])]) };
}

async function evaluate(ruleId, value) {
  const rule = MEDIA_RULES.find(candidate => candidate.id === ruleId);
  assert.ok(rule, `Regra ausente: ${ruleId}`);
  return (await runRules(value, {}, [rule]))[0];
}

test('image alternatives fail objective absence but quality and unknown purpose remain review', async () => {
  const missing = await evaluate('content-image-alternative', snapshot([
    record('image', 'img', { mediaPurpose: 'content' })
  ]));
  assert.equal(missing.outcome, 'failed');
  assert.equal(missing.targets[0].data.reason, 'missing-alternative');

  const empty = await evaluate('functional-image-alternative', snapshot([
    record('image', 'input', { attributes: { type: 'image', alt: '' }, mediaPurpose: 'functional', accessibleName: '' })
  ]));
  assert.equal(empty.outcome, 'failed');

  const quality = await evaluate('content-image-alternative', snapshot([
    record('image', 'img', { attributes: { alt: 'Gráfico de vendas' }, mediaPurpose: 'content' })
  ]));
  assert.equal(quality.outcome, 'cantTell');
  assert.equal(quality.targets[0].nodeId, 'image');

  assert.equal((await evaluate('decorative-image-alternative', snapshot([
    record('image', 'img', { attributes: { alt: '' }, mediaPurpose: 'unknown' })
  ]))).outcome, 'cantTell');
  assert.equal((await evaluate('decorative-image-alternative', snapshot([
    record('image', 'img', { attributes: { alt: 'ornamento' }, mediaPurpose: 'decorative' })
  ]))).outcome, 'failed');
});

test('audio autoplay over three seconds requires a stop, pause or independent volume control', async () => {
  assert.equal((await evaluate('audio-control', snapshot([
    record('audio', 'audio', { autoplay: true, hasAudio: true, durationSeconds: 3.01, audioControl: { canPause: false, canStop: false, independentVolume: false } })
  ]))).outcome, 'failed');
  assert.equal((await evaluate('audio-control', snapshot([
    record('audio', 'audio', { autoplay: true, hasAudio: true, durationSeconds: 3, audioControl: { canPause: false, canStop: false, independentVolume: false } })
  ]))).outcome, 'passed');
  assert.equal((await evaluate('audio-control', snapshot([
    record('audio', 'audio', { autoplay: true, hasAudio: true })
  ]))).outcome, 'cantTell');
  assert.equal((await evaluate('audio-control', snapshot())).outcome, 'inapplicable');
});

test('prerecorded video with audio fails without captions and reviews track equivalence when present', async () => {
  const video = overrides => record('video', 'video', { mediaTiming: 'prerecorded', hasAudio: true, essentiality: 'non-essential', ...overrides });
  assert.equal((await evaluate('video-captions', snapshot([video({ captionTracks: [] })]))).outcome, 'failed');
  const present = await evaluate('video-captions', snapshot([video({ captionTracks: [{ kind: 'captions', srclang: 'pt-BR' }] })]));
  assert.equal(present.outcome, 'cantTell');
  assert.equal(present.targets[0].data.reason, 'verify-caption-equivalence');
  assert.equal((await evaluate('video-captions', snapshot([video({ captionTracks: [], essentiality: 'unknown' })]))).outcome, 'cantTell');
});

test('transcript, audio description, sign language and live equivalents expose review candidates', async () => {
  const prerecorded = snapshot([record('video', 'video', { mediaTiming: 'prerecorded', hasAudio: true, essentiality: 'non-essential' })]);
  for (const ruleId of ['video-transcript', 'video-audio-description', 'extended-audio-description', 'sign-language-interpretation']) {
    const value = await evaluate(ruleId, prerecorded);
    assert.equal(value.outcome, 'cantTell');
    assert.equal(value.targets.length, 1);
  }
  const live = snapshot([record('stream', 'video', { mediaTiming: 'live', hasAudio: true, essentiality: 'non-essential' })]);
  for (const ruleId of ['live-captions', 'live-audio-transcript']) {
    assert.equal((await evaluate(ruleId, live)).outcome, 'cantTell');
  }
});

test('CSS animation duration and control are objective only with explicit essentiality', async () => {
  const animated = animation => snapshot([record('box', 'div', { animations: [animation] })]);
  assert.equal((await evaluate('animation-control', animated({ durationSeconds: 5.01, iterationCount: Infinity, hasPauseControl: false, essentiality: 'non-essential' }))).outcome, 'failed');
  assert.equal((await evaluate('animation-control', animated({ durationSeconds: 5, iterationCount: Infinity, hasPauseControl: false, essentiality: 'non-essential' }))).outcome, 'passed');
  assert.equal((await evaluate('animation-control', animated({ durationSeconds: 10, iterationCount: Infinity, hasPauseControl: false, essentiality: 'unknown' }))).outcome, 'cantTell');
});

test('flashing conclusions require reliable measurement', async () => {
  assert.equal((await evaluate('flashing-content-enhanced', snapshot([], {
    flashObservation: { reliable: true, flashesPerSecond: 3.01 }
  }))).outcome, 'failed');
  assert.equal((await evaluate('flashing-content-enhanced', snapshot([], {
    flashObservation: { reliable: true, flashesPerSecond: 3 }
  }))).outcome, 'passed');
  assert.equal((await evaluate('flashing-content-limit', snapshot([], {
    flashObservation: { reliable: true, withinGeneralThreshold: false }
  }))).outcome, 'failed');
  assert.equal((await evaluate('flashing-content-limit', snapshot([], {
    flashObservation: { reliable: false }
  }))).outcome, 'cantTell');
});

test('updating content over five seconds needs explicit control and essentiality', async () => {
  const updating = updatingContent => snapshot([
    record('ticker', 'div', { updatingContent: { startsAutomatically: true, ...updatingContent } })
  ]);
  assert.equal((await evaluate('updating-content-control', updating({
    durationSeconds: 5.01, essentiality: 'non-essential', hasPauseControl: false
  }))).outcome, 'failed');
  assert.equal((await evaluate('updating-content-control', updating({
    durationSeconds: 5, essentiality: 'non-essential', hasPauseControl: false
  }))).outcome, 'passed');
  assert.equal((await evaluate('updating-content-control', updating({
    durationSeconds: 10, essentiality: 'unknown', hasPauseControl: false
  }))).outcome, 'cantTell');
});
