import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeProbesIntoSnapshot, normalizeProbes, normalizeSnapshot, runCoreAudit } from '../../src/core/index.js';
import { collectRuntimePageData } from '../../src/collector/page-collector.js';

const STYLE_NAMES = [
  'display', 'visibility', 'opacity', 'color', 'background-color',
  'background-image', 'font-family', 'font-size', 'font-weight', 'line-height',
  'letter-spacing', 'word-spacing', 'text-align'
];

function collectorFixture() {
  const strings = [
    '#document', 'HTML', 'BODY', 'P', '#text', 'BUTTON', 'AUDIO',
    'Texto justificado', 'id', 'copy', 'target', 'podcast',
    'https://example.test/', 'Contrato do coletor', 'main',
  ];
  const s = value => strings.indexOf(value);
  const attrs = (...pairs) => pairs.flatMap(([name, value]) => [s(name), s(value)]);
  return {
    domSnapshot: {
      strings,
      computedStyles: STYLE_NAMES,
      documents: [{
        frameId: s('main'),
        documentURL: s('https://example.test/'),
        title: s('Contrato do coletor'),
        nodes: {
          parentIndex: [-1, 0, 1, 2, 3, 2, 2],
          nodeType: [9, 1, 1, 1, 3, 1, 1],
          nodeName: [s('#document'), s('HTML'), s('BODY'), s('P'), s('#text'), s('BUTTON'), s('AUDIO')],
          nodeValue: [s(''), s(''), s(''), s(''), s('Texto justificado'), s(''), s('')],
          backendNodeId: [1, 2, 3, 4, 5, 6, 7],
          attributes: [[], [], [], attrs(['id', 'copy']), [], attrs(['id', 'target']), attrs(['id', 'podcast'])],
        },
        layout: { nodeIndex: [], bounds: [], styles: [] },
      }],
    },
    axTree: { nodes: [
      { backendDOMNodeId: 6, role: { value: 'button' }, name: { value: '' } },
    ] },
    // This is the browser-world collector wire format: per-frame pageData
    // with runtime values nested in each node record.
    pageData: [{ frameId: 'main', result: {
      url: 'https://example.test/', framePath: [], nodes: [
        {
          backendNodeId: 4, order: 2, tagName: 'p', selectorHint: '#copy',
          visibleText: 'Texto justificado',
          contrastReliable: true,
          viewportRect: { x: 10, y: 10, width: 320, height: 48 },
          documentRect: { x: 10, y: 10, width: 320, height: 48 },
          styles: {
            display: 'block', visibility: 'visible', opacity: '1',
            color: 'rgb(119, 119, 119)', 'background-color': 'rgb(255, 255, 255)',
            'background-image': 'none', 'font-family': 'Arial, sans-serif',
            'font-size': '16px', 'font-weight': '400', 'line-height': 'normal',
            'letter-spacing': 'normal', 'word-spacing': 'normal', 'text-align': 'justify',
          },
        },
        { backendNodeId: 6, order: 4, tagName: 'button', selectorHint: '#target', focusable: true },
        {
          backendNodeId: 7, order: 5, tagName: 'audio', selectorHint: '#podcast',
          media: {
            kind: 'audio', currentSrc: 'https://example.test/podcast.mp3', durationSeconds: 8,
            muted: false, autoplay: true, controls: false, captionTracks: [], hasAudio: true,
          },
        },
      ],
    }}],
    warnings: [],
  };
}

test('collector runtime records normalize into the observations consumed by the existing rules', async () => {
  const snapshot = normalizeSnapshot(collectorFixture());
  const paragraph = snapshot.nodes.find(node => node.backendNodeId === 4);
  const button = snapshot.nodes.find(node => node.backendNodeId === 6);
  const audio = snapshot.nodes.find(node => node.backendNodeId === 7);

  assert.equal(button.accessibleName, '');
  assert.equal(Object.hasOwn(button, 'accessibleName'), true);
  assert.deepEqual({ textBlock: paragraph.textBlock, textAlign: paragraph.textAlign }, {
    textBlock: true, textAlign: 'justify'
  });
  assert.deepEqual(paragraph.contrast, {
    foreground: 'rgb(119, 119, 119)', background: 'rgb(255, 255, 255)',
    backgroundImage: 'none', fontFamily: 'Arial, sans-serif', fontSizePx: 16,
    fontWeight: '400', reliable: true,
  });
  assert.equal(audio.audioControl, undefined);
  assert.deepEqual(audio.captionTracks, []);
  assert.equal(audio.autoplay, true);
  assert.equal(audio.durationSeconds, 8);
  assert.equal(audio.hasAudio, true);
  assert.equal(Object.hasOwn(audio, 'mediaTiming'), false);

  const merged = mergeProbesIntoSnapshot(snapshot, normalizeProbes({
    targetSizes: [{ backendNodeId: 6, selector: '#target', frameId: 'main', width: 20, height: 20, exception: 'none' }],
  }));
  assert.deepEqual(merged.nodes.find(node => node.backendNodeId === 6).targetSize, {
    width: 20, height: 20, exception: 'none'
  });

  const audit = await runCoreAudit(merged);
  const outcome = ruleId => audit.ruleResults.find(item => item.ruleId === ruleId).outcome;
  assert.equal(outcome('accessible-component-name'), 'failed');
  assert.equal(outcome('text-block-alignment'), 'failed');
  assert.equal(outcome('text-contrast-minimum'), 'failed');
  assert.equal(outcome('target-size-minimum'), 'failed');
  assert.equal(outcome('audio-control'), 'cantTell');
});

test('a translucent text block remains an unreliable contrast observation', async () => {
  const raw = collectorFixture();
  raw.pageData[0].result.nodes[0].styles.opacity = '0.5';
  const snapshot = normalizeSnapshot(raw);
  const paragraph = snapshot.nodes.find(node => node.backendNodeId === 4);
  assert.equal(paragraph.contrast.reliable, false);
  const audit = await runCoreAudit(snapshot);
  assert.equal(audit.ruleResults.find(item => item.ruleId === 'text-contrast-minimum').outcome, 'cantTell');
});

test('the browser-world collector emits complete observed media without inferring timing from duration', () => {
  const names = ['Node', 'Element', 'ShadowRoot', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLMediaElement', 'HTMLAudioElement', 'HTMLImageElement', 'HTMLCanvasElement', 'CSS', 'document', 'getComputedStyle', 'location', 'innerWidth', 'innerHeight', 'scrollX', 'scrollY', 'matchMedia'];
  const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  class FakeElement {}
  class FakeMedia extends FakeElement {}
  class FakeAudio extends FakeMedia {}
  const audio = new FakeAudio();
  Object.assign(audio, {
    localName: 'audio', id: '', children: [], parentElement: null, shadowRoot: null,
    currentSrc: 'https://example.test/podcast.mp3', duration: 8, muted: false, autoplay: true, controls: false,
    textTracks: [], disabled: false, innerText: '',
    getAttribute: () => '', getRootNode: () => globalThis.document, matches: () => false, getAnimations: () => [],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 120, height: 30 }),
  });
  try {
    Object.assign(globalThis, {
      Node: { ELEMENT_NODE: 1 }, Element: FakeElement, ShadowRoot: class {},
      HTMLInputElement: class {}, HTMLSelectElement: class {}, HTMLTextAreaElement: class {},
      HTMLMediaElement: FakeMedia, HTMLAudioElement: FakeAudio, HTMLImageElement: class {}, HTMLCanvasElement: class {},
      CSS: { escape: value => value }, document: { baseURI: 'https://example.test/', children: [audio], activeElement: null },
      getComputedStyle: () => ({ getPropertyValue: name => ({ display: 'block', visibility: 'visible', opacity: '1', 'background-image': 'none' }[name] || '') }),
      location: { href: 'https://example.test/' }, innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0,
      matchMedia: () => ({ matches: false }),
    });
    const media = collectRuntimePageData().nodes[0].media;
    assert.deepEqual(media, {
      kind: 'audio', currentSrc: 'https://example.test/podcast.mp3', durationSeconds: 8,
      muted: false, autoplay: true, controls: false, captionTracks: [], hasAudio: true,
    });
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test('probe selector and frame fallback shares the normalized node identity when no backend node is available', () => {
  const snapshot = normalizeSnapshot(collectorFixture());
  const raw = { targetSizes: [{ selector: '#target', frameId: 'main', width: 44, height: 44, exception: 'none' }] };
  const probes = normalizeProbes(raw);
  const merged = mergeProbesIntoSnapshot(snapshot, probes);
  assert.deepEqual(merged.nodes.find(node => node.backendNodeId === 6).targetSize, {
    width: 44, height: 44, exception: 'none'
  });
});

test('an ambiguous selector and frame fallback never assigns one target measurement to multiple nodes', () => {
  const snapshot = normalizeSnapshot(collectorFixture());
  for (const backendNodeId of [6, 7]) snapshot.nodes.find(node => node.backendNodeId === backendNodeId).selectorHint = 'button';
  const merged = mergeProbesIntoSnapshot(snapshot, normalizeProbes({
    targetSizes: [{ selector: 'button', frameId: 'main', width: 20, height: 20, exception: 'none' }],
  }));
  for (const backendNodeId of [6, 7]) {
    assert.equal(merged.nodes.find(node => node.backendNodeId === backendNodeId).targetSize, undefined);
  }
});
