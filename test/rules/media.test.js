import test from 'node:test';
import assert from 'node:assert/strict';

import { MEDIA_RULES } from '../../src/core/rules/media.js';
import { runRules } from '../../src/core/rules/run-rules.js';
import { validateCoreRuleTargetInventory } from '../../src/core/report/remediation-policy.js';

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

test('unknown media timing preserves a review task instead of declaring inapplicability', async () => {
  for (const id of ['video-captions', 'video-transcript', 'video-audio-description', 'live-captions', 'live-audio-transcript']) {
    const value = await evaluate(id, snapshot([record('video', 'video')]));
    assert.equal(value.outcome, 'cantTell', id);
    assert.equal(value.targets[0].nodeId, 'video');
    assert.equal(value.targets[0].data.reason, 'unknown-media-timing');
    assert.equal(validateCoreRuleTargetInventory(id, value.outcome, value.targets.map(({selectorHint, ...target}) => target)), true);
  }
});

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
  assert.equal((await evaluate('audio-control', snapshot([
    record('audio', 'audio', { autoplay: true, hasAudio: true, durationSeconds: 4, audioControl: { canPause: false } })
  ]))).outcome, 'cantTell');
  assert.equal((await evaluate('audio-control', snapshot([
    record('audio', 'audio', { autoplay: true, hasAudio: true, durationSeconds: 4, audioControl: { canPause: true } })
  ]))).outcome, 'passed');
  assert.equal((await evaluate('audio-control', snapshot([
    record('audio', 'audio', { autoplay: true, hasAudio: true, durationSeconds: -1, audioControl: { canPause: false, canStop: false, independentVolume: false } })
  ]))).outcome, 'cantTell');
  assert.equal((await evaluate('audio-control', snapshot())).outcome, 'inapplicable');
});

test('audio control preserves video hasAudio tri-state while native audio is inherently audible', async () => {
  const noControl = { canPause: false, canStop: false, independentVolume: false };
  const autoplay = (tagName, overrides = {}) => record(tagName, tagName, {
    autoplay: true, durationSeconds: 4, audioControl: noControl, ...overrides
  });

  assert.equal((await evaluate('audio-control', snapshot([autoplay('video')]))).outcome, 'cantTell');
  assert.equal((await evaluate('audio-control', snapshot([autoplay('video', { hasAudio: 'yes' })]))).outcome, 'cantTell');
  assert.equal((await evaluate('audio-control', snapshot([autoplay('video', { hasAudio: false })]))).outcome, 'inapplicable');
  assert.equal((await evaluate('audio-control', snapshot([autoplay('video', { hasAudio: true })]))).outcome, 'failed');
  assert.equal((await evaluate('audio-control', snapshot([autoplay('audio')]))).outcome, 'failed');
});

test('prerecorded video reviews absent tracks and equivalence instead of assuming absent captions', async () => {
  const video = overrides => record('video', 'video', { mediaTiming: 'prerecorded', hasAudio: true, essentiality: 'non-essential', ...overrides });
  assert.equal((await evaluate('video-captions', snapshot([video({ captionTracks: [] })]))).outcome, 'cantTell');
  const present = await evaluate('video-captions', snapshot([video({ captionTracks: [{ kind: 'captions', srclang: 'pt-BR' }] })]));
  assert.equal(present.outcome, 'cantTell');
  assert.equal(present.targets[0].data.reason, 'verify-caption-equivalence');
  assert.equal((await evaluate('video-captions', snapshot([video({ captionTracks: [], essentiality: 'unknown' })]))).outcome, 'cantTell');
  assert.equal((await evaluate('video-captions', snapshot([
    record('video', 'video', { mediaTiming: 'prerecorded', essentiality: 'non-essential', captionTracks: [] })
  ]))).outcome, 'cantTell');
  assert.equal((await evaluate('video-captions', snapshot([
    record('video', 'video', { mediaTiming: 'prerecorded', hasAudio: 'yes', essentiality: 'non-essential', captionTracks: [] })
  ]))).outcome, 'cantTell');
  const missingTrackCollection = await evaluate('video-captions', snapshot([video({})]));
  assert.equal(missingTrackCollection.outcome, 'cantTell');
  assert.deepEqual(missingTrackCollection.targets.map(target => target.nodeId), ['video']);
  assert.equal((await evaluate('video-captions', snapshot([video({ captionTracks: [{}] })]))).outcome, 'cantTell');
  assert.equal((await evaluate('video-captions', snapshot([video({ captionTracks: [{ kind: 'captions' }] })]))).outcome, 'cantTell');
  assert.equal((await evaluate('video-captions', snapshot([video({ hasAudio: false, captionTracks: [] })]))).outcome, 'inapplicable');
});

test('no caption track cannot disprove burned-in captions or an equivalent-text exception', async () => {
  for (const tracks of [[], [{ kind: 'subtitles', srclang: 'pt-BR' }]]) {
    const value = await evaluate('video-captions', snapshot([record('video', 'video', {
      mediaTiming: 'prerecorded', hasAudio: true, essentiality: 'non-essential', captionTracks: tracks
    })]));
    assert.equal(value.outcome, 'cantTell');
    assert.equal(value.targets[0].data.reason, 'captions-not-determined');
    assert.equal(validateCoreRuleTargetInventory(value.ruleId, value.outcome, value.targets.map(({selectorHint, ...target}) => target)), true);
  }
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
  const noControl = { hasPauseControl: false, hasStopControl: false, hasHideControl: false };
  assert.equal((await evaluate('animation-control', animated({ durationSeconds: 5.01, iterationCount: 1, ...noControl, essentiality: 'non-essential' }))).outcome, 'failed');
  assert.equal((await evaluate('animation-control', animated({ durationSeconds: 5, iterationCount: 1, ...noControl, essentiality: 'non-essential' }))).outcome, 'passed');
  assert.equal((await evaluate('animation-control', animated({ durationSeconds: 6, iterationCount: 1, ...noControl, essentiality: 'non-essential' }))).outcome, 'failed');
  assert.equal((await evaluate('animation-control', animated({ durationSeconds: 5, iterationCount: Infinity, ...noControl, essentiality: 'non-essential' }))).outcome, 'failed');
  assert.equal((await evaluate('animation-control', animated({ durationSeconds: 6, iterationCount: 2, hasPauseControl: false, hasStopControl: true, hasHideControl: false, essentiality: 'non-essential' }))).outcome, 'passed');
  assert.equal((await evaluate('animation-control', animated({ durationSeconds: 6, iterationCount: 2, hasPauseControl: false, hasStopControl: true, hasHideControl: false }))).outcome, 'passed');
  assert.equal((await evaluate('animation-control', animated({ durationSeconds: 6, iterationCount: 2, hasPauseControl: false, hasStopControl: false, hasHideControl: true, essentiality: 'non-essential' }))).outcome, 'passed');
  assert.equal((await evaluate('animation-control', animated({ durationSeconds: 10, iterationCount: 1, ...noControl, essentiality: 'unknown' }))).outcome, 'cantTell');
  assert.equal((await evaluate('animation-control', animated({ durationSeconds: 10, iterationCount: 1, hasPauseControl: false, essentiality: 'non-essential' }))).outcome, 'cantTell');
  for (const animation of [
    { durationSeconds: -1, iterationCount: 1 },
    { durationSeconds: 0, iterationCount: 1 },
    { durationSeconds: 1, iterationCount: 0 },
    { durationSeconds: '6', iterationCount: 1 },
    { durationSeconds: 6, iterationCount: '2' }
  ]) {
    assert.equal((await evaluate('animation-control', animated({ ...animation, ...noControl, essentiality: 'non-essential' }))).outcome, 'cantTell');
  }
});

test('interaction animation consumes normalized reduced-motion observation conservatively', async () => {
  const animated = animation => snapshot([record('box', 'div', { animations: [{ triggeredByInteraction: true, ...animation }] })]);
  assert.equal((await evaluate('interaction-animation', animated({ respectsReducedMotion: false, essentiality: 'non-essential' }))).outcome, 'failed');
  assert.equal((await evaluate('interaction-animation', animated({ respectsReducedMotion: true, essentiality: 'non-essential' }))).outcome, 'cantTell');
  assert.equal((await evaluate('interaction-animation', animated({ essentiality: 'non-essential' }))).outcome, 'cantTell');
  assert.equal((await evaluate('interaction-animation', animated({ respectsReducedMotion: false, essentiality: 'unknown' }))).outcome, 'cantTell');
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
  assert.equal((await evaluate('flashing-content-enhanced', snapshot([], {
    flashObservation: { reliable: true, flashesPerSecond: -1 }
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
  assert.equal((await evaluate('updating-content-control', updating({
    durationSeconds: -1, essentiality: 'non-essential', hasPauseControl: false
  }))).outcome, 'cantTell');
});
