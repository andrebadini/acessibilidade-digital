import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeProbesIntoSnapshot, normalizeProbes, normalizeSnapshot, runCoreAudit } from '../../src/core/index.js';
import { collectRuntimePageData } from '../../src/collector/page-collector.js';
import { COMPUTED_STYLE_PROPERTIES } from '../../src/browser/collect-page.js';

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

function addViewport(raw, content, documentIndex = 0) {
  const strings = raw.domSnapshot.strings;
  const token = value => { let id = strings.indexOf(value); if (id < 0) id = strings.push(value) - 1; return id; };
  const nodes = raw.domSnapshot.documents[documentIndex].nodes;
  nodes.parentIndex.push(1);
  nodes.nodeType.push(1);
  nodes.nodeName.push(token('META'));
  nodes.nodeValue.push(token(''));
  nodes.backendNodeId.push(100 + documentIndex * 100 + nodes.nodeType.length);
  nodes.attributes.push([token('name'), token('viewport'), token('content'), token(content)]);
  return raw;
}

test('columnar runtime target area survives the existing identity join without trusting layout bounds', () => {
  const raw = collectorFixture();
  const runtimeButton = raw.pageData[0].result.nodes.find(node => node.backendNodeId === 6);
  runtimeButton.targetSizeRect = { x: 10, y: 20, width: 30, height: 30 };
  raw.domSnapshot.documents[0].layout = { nodeIndex: [5], bounds: [[0, 0, 200, 200]], styles: [[]] };
  const snapshot = normalizeSnapshot(raw);
  const button = snapshot.nodes.find(node => node.backendNodeId === 6);
  assert.deepEqual(button.targetSizeRect, { x: 10, y: 20, width: 30, height: 30 });
  delete runtimeButton.targetSizeRect;
  assert.equal(normalizeSnapshot(raw).nodes.find(node => node.backendNodeId === 6).targetSizeRect, undefined);
});

test('normalization preserves a top-document zoom restriction for the ABNT zoom rule', async () => {
  const raw = addViewport(collectorFixture(), 'width=device-width, user-scalable=no');
  const snapshot = normalizeSnapshot(raw);
  assert.equal(snapshot.document.metaViewport?.userScalable, false,
    'the observed restriction must not be lost between DOM collection and rule input');
  const audit = await runCoreAudit(snapshot);
  const rule = audit.ruleResults.find(value => value.ruleId === 'zoom-not-blocked');
  assert.equal(rule.outcome, 'cantTell');
  assert.equal(rule.targets.length, 1, 'the declaration must produce a concrete review target');
});

test('zoom metadata normalizes numbers and retains ambiguity without exporting raw content', () => {
  for (const [content, expected] of [
    ['user-scalable=YES; maximum-scale=2.5', { userScalable: true, maximumScale: 2.5 }],
    ['user-scalable=0', { userScalable: false }],
    ['width=device-width', {}],
    ['maximum-scale=bad-secret-value', {}],
    ['maximum-scale=1, maximum-scale=5', {}],
    ['maximum-scale=-1', {}],
  ]) {
    const normalized = normalizeSnapshot(addViewport(collectorFixture(), content));
    assert.deepEqual(normalized.document.metaViewport, expected);
    assert.ok(normalized.nodes.filter(node=>node.tagName==='meta').every(node=>!Object.hasOwn(node.attributes,'content')));
  }
  const duplicate = addViewport(addViewport(collectorFixture(), 'user-scalable=no'), 'user-scalable=yes');
  assert.deepEqual(normalizeSnapshot(duplicate).document.metaViewport, {});
});

test('viewport declarations in inert template content do not describe the page', () => {
  const raw = addViewport(collectorFixture(), 'user-scalable=no');
  const nodes = raw.domSnapshot.documents[0].nodes;
  nodes.nodeName[3] = raw.domSnapshot.strings.push('TEMPLATE') - 1;
  nodes.parentIndex[nodes.parentIndex.length - 1] = 3;
  assert.equal(normalizeSnapshot(raw).document.metaViewport, null);
});

test('zoom metadata distinguishes observed absence and ignores another document', () => {
  const raw = collectorFixture();
  raw.domSnapshot.documents.push(structuredClone(raw.domSnapshot.documents[0]));
  raw.domSnapshot.documents[1].nodes.backendNodeId = raw.domSnapshot.documents[1].nodes.backendNodeId.map(id=>id+50);
  raw.domSnapshot.documents[1].frameId = raw.domSnapshot.strings.push('child-frame') - 1;
  addViewport(raw, 'user-scalable=no', 1);
  assert.equal(normalizeSnapshot(raw).document.metaViewport, null);
});

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
  assert.deepEqual(merged.nodes.find(node => node.backendNodeId === 6).targetSize,
    { width: 20, height: 20, exception: 'unknown' });

  const audit = await runCoreAudit(merged);
  const outcome = ruleId => audit.ruleResults.find(item => item.ruleId === ruleId).outcome;
  assert.equal(outcome('accessible-component-name'), 'failed');
  assert.equal(outcome('text-block-alignment'), 'failed');
  assert.equal(outcome('text-contrast-minimum'), 'failed');
  assert.equal(outcome('target-size-minimum'), 'cantTell');
  assert.equal(outcome('target-size-enhanced'), 'cantTell');
  assert.equal(outcome('audio-control'), 'cantTell');
});

test('the actual structural collector requests text-align for the existing justified-text evaluator', () => {
  assert.ok(COMPUTED_STYLE_PROPERTIES.includes('text-align'));
});

test('normalizer retains only bounded contextual and widget observations', () => {
  const raw = {
    format: 'simplified-v1',
    document: { url: 'https://example.test/', title: 'Contexto', language: 'pt-BR' },
    coverage: { runtime: { outcome: 'complete' }, accessibility: { outcome: 'complete' } },
    widgetObservations: {
      coverage: 'complete', widgets: {
        vlibras: { dom: true, script: false, global: false },
        'hand-talk': { dom: false, script: false, global: false },
      },
      privateText: 'PRIVATE-WIDGET-SENTINEL',
    },
    nodes: [{
      backendNodeId: 1, tagName: 'a', attributes: { href: '/ajuda', target: '_blank' },
      text: 'Ajuda', visibleText: 'Ajuda', parentBackendNodeId: null,
      linkPurposeContext: 'potential-context', adjacentNewWindowWarning: true,
      newWindowBehavior: 'new-window', neighboringText: 'PRIVATE-ADJACENT-SENTINEL',
    }],
    axTree: { nodes: [{ backendDOMNodeId: 1, role: { value: 'link' }, name: { value: 'Ajuda' } }] },
  };
  const normalized = normalizeSnapshot(raw);
  const link = normalized.nodes[0];
  assert.equal(link.linkPurposeContext, 'potential-context');
  assert.equal(link.adjacentNewWindowWarning, true);
  assert.equal(link.newWindowBehavior, 'new-window');
  assert.deepEqual(normalized.document.accessibilityWidgetSignals, {
    coverage: 'complete', widgets: {
      vlibras: { dom: true, script: false, global: false },
      'hand-talk': { dom: false, script: false, global: false },
    },
  });
  assert.doesNotMatch(JSON.stringify(normalized), /PRIVATE-|neighboringText|privateText/u);
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

test('the isolated browser-world collector emits media and only observable DOM/script widget booleans', () => {
  const names = ['Node', 'Element', 'ShadowRoot', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLMediaElement', 'HTMLAudioElement', 'HTMLImageElement', 'HTMLCanvasElement', 'CSS', 'document', 'getComputedStyle', 'location', 'innerWidth', 'innerHeight', 'scrollX', 'scrollY', 'matchMedia', 'VLibras'];
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
  const handTalkScript = new FakeElement();
  Object.assign(handTalkScript, {
    localName: 'script', id: '', children: [], parentElement: null, shadowRoot: null,
    className: '', disabled: false, innerText: 'PRIVATE-SCRIPT-CONTENT',
    getAttribute: name => name === 'src' ? 'https://cdn.example.test/handtalk/widget.js?private=PRIVATE-SRC' : '',
    getRootNode: () => globalThis.document, matches: () => false, getAnimations: () => [],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 1, height: 1 }),
  });
  const vlibrasWidget = new FakeElement();
  Object.assign(vlibrasWidget, {
    localName: 'div', id: '', children: [], parentElement: null, shadowRoot: null,
    className: 'vw', disabled: false, innerText: '',
    getAttribute: name => name === 'vw' ? '' : '',
    hasAttribute: name => name === 'vw',
    getRootNode: () => globalThis.document, matches: () => false, getAnimations: () => [],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 1, height: 1 }),
  });
  const privateSibling = new FakeElement();
  const inheritedButton = Object.assign(new FakeElement(), {
    localName: 'button', id: 'inherited-disabled', children: [], parentElement: null, shadowRoot: null,
    disabled: false, innerText: 'Salvar', getAttribute: () => '', hasAttribute: () => false,
    getRootNode: () => globalThis.document, matches: () => true, getAnimations: () => [],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 80, height: 30 }),
  });
  const contextualLink = new FakeElement();
  const linkParent = new FakeElement();
  Object.assign(linkParent, {
    localName: 'div', id: '', className: '', children: [contextualLink, privateSibling], parentElement: null,
    shadowRoot: null, disabled: false, innerText: '', getAttribute: () => '', hasAttribute: () => false,
    getRootNode: () => globalThis.document, matches: () => false, getAnimations: () => [],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 1, height: 1 }),
  });
  Object.assign(contextualLink, {
    localName: 'a', id: '', className: '', children: [], parentElement: linkParent,
    previousSibling: null, nextSibling: privateSibling,
    previousElementSibling: null, nextElementSibling: privateSibling, shadowRoot: null,
    disabled: false, innerText: 'Saiba mais',
    getAttribute: name => name === 'role' ? 'link' : name === 'href' ? '/ajuda' : '', hasAttribute: () => false,
    getRootNode: () => globalThis.document, matches: () => true, getAnimations: () => [],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 80, height: 20 }),
  });
  Object.assign(privateSibling, {
    localName: 'div', id: '', className: '', children: [], parentElement: linkParent,
    previousSibling: contextualLink, nextSibling: null,
    previousElementSibling: contextualLink, nextElementSibling: null, shadowRoot: null,
    disabled: false, innerText: 'PRIVATE-ADJACENT-SENTINEL nova aba',
    getAttribute: name => name === 'contenteditable' ? 'true' : '',
    hasAttribute: name => name === 'contenteditable',
    getRootNode: () => globalThis.document, matches: () => false, getAnimations: () => [],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 80, height: 20 }),
  });
  try {
    Object.assign(globalThis, {
      Node: { ELEMENT_NODE: 1 }, Element: FakeElement, ShadowRoot: class {},
      HTMLInputElement: class {}, HTMLSelectElement: class {}, HTMLTextAreaElement: class {},
      HTMLMediaElement: FakeMedia, HTMLAudioElement: FakeAudio, HTMLImageElement: class {}, HTMLCanvasElement: class {},
      CSS: { escape: value => value }, document: { baseURI: 'https://example.test/', children: [audio, handTalkScript, vlibrasWidget, linkParent, inheritedButton], activeElement: null },
      getComputedStyle: () => ({ getPropertyValue: name => ({ display: 'block', visibility: 'visible', opacity: '1', 'background-image': 'none' }[name] || '') }),
      location: { href: 'https://example.test/' }, innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0,
      matchMedia: () => ({ matches: false }),
      VLibras: { privateValue: 'PRIVATE-GLOBAL-VALUE' },
    });
    const collected = collectRuntimePageData();
    const media = collected.nodes[0].media;
    const inactive = collected.nodes.find(item => item.tagName === 'button');
    assert.equal(inactive.disabled, true);
    assert.equal(inactive.focusable, false);
    assert.deepEqual(media, {
      kind: 'audio', currentSrc: 'https://example.test/podcast.mp3', durationSeconds: 8,
      muted: false, autoplay: true, controls: false, captionTracks: [], hasAudio: true,
    });
    assert.deepEqual(collected.widgetSignals, {
      vlibras: { dom: true, script: false },
      'hand-talk': { dom: false, script: true },
    });
    assert.equal(Object.hasOwn(collected.widgetSignals.vlibras, 'global'), false);
    assert.doesNotMatch(JSON.stringify(collected.widgetSignals), /PRIVATE-|src|selector|value/iu);
    const collectedLink = collected.nodes.find(item => item.tagName === 'a');
    assert.equal(collectedLink.linkPurposeContext, 'unknown-context');
    assert.equal(Object.hasOwn(collectedLink, 'adjacentNewWindowWarning'), false);
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
    width: 44, height: 44, exception: 'unknown'
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
