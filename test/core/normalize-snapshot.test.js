import test from 'node:test';
import assert from 'node:assert/strict';

import { collectPage } from '../../src/browser/collect-page.js';
import { captureFullPage } from '../../src/browser/capture-evidence.js';
import {
  buildSnapshotIndexes,
  buildStableSelector,
  normalizeSnapshot,
  runCoreAudit,
  sanitizeHtmlSnippet,
  validateSnapshotV1
} from '../../src/core/index.js';

const COMPUTED_STYLES = [
  'display', 'visibility', 'opacity', 'color', 'background-color',
  'background-image', 'font-size', 'font-weight', 'line-height',
  'letter-spacing', 'word-spacing', 'outline-color', 'outline-style',
  'outline-width', 'box-shadow', 'text-decoration-color', 'overflow-x',
  'overflow-y', 'animation-duration', 'animation-iteration-count',
  'transition-duration'
];

function columnarRaw() {
  const strings = [
    '#document', 'HTML', 'BODY', 'H1', '#text', 'Bem-vindo', 'id', 'title',
    'INPUT', 'passwd', 'type', 'password', 'value', 'PW_FAKE_DO_NOT_KEEP',
    'autocomplete', 'current-password', 'csrf_token', 'hidden', 'name',
    'TOKEN_FAKE_DO_NOT_KEEP', 'BUTTON', 'send', 'onclick', 'location.href=\'https://example.test/?token=bad\'',
    'Enviar', 'IFRAME', 'Subdocumento', 'DIV', 'host', '#document-fragment',
    'open', 'data-testid', 'shadow-action', 'Ação sombra', 'P', 'inner', 'Dentro',
    'block', 'visible', 'rgb(10, 20, 30)', 'VIDEO', 'clip',
    'https://user:pass@example.test/movie.mp4?token=bad&lang=pt#secret=bad',
    'https://example.test/page?token=bad&view=public#authorization=bad',
    'https://example.test/frame?auth=bad&ok=1', ''
  ];
  const s = value => strings.indexOf(value);
  const attrs = (...pairs) => pairs.flatMap(([name, value]) => [s(name), s(value)]);
  return {
    domSnapshot: {
      strings,
      computedStyles: COMPUTED_STYLES,
      documents: [
        {
          frameId: s('host'),
          documentURL: s('https://example.test/page?token=bad&view=public#authorization=bad'),
          title: s('title'),
          nodes: {
            parentIndex: [-1, 0, 1, 2, 3, 2, 2, 2, 7, 2, 2, 10, 11, 2],
            nodeType: [9, 1, 1, 1, 3, 1, 1, 1, 3, 1, 1, 11, 1, 1],
            nodeName: [s('#document'), s('HTML'), s('BODY'), s('H1'), s('#text'), s('INPUT'), s('INPUT'), s('BUTTON'), s('#text'), s('IFRAME'), s('DIV'), s('#document-fragment'), s('BUTTON'), s('VIDEO')],
            nodeValue: [s(''), s(''), s(''), s(''), s('Bem-vindo'), s(''), s(''), s(''), s('Enviar'), s(''), s(''), s(''), s(''), s('')],
            backendNodeId: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 16, 17, 18, 20],
            attributes: [[], [], [], attrs(['id', 'title']), [], attrs(['id', 'passwd'], ['type', 'password'], ['value', 'PW_FAKE_DO_NOT_KEEP'], ['autocomplete', 'current-password']), attrs(['id', 'csrf_token'], ['type', 'hidden'], ['name', 'csrf_token'], ['value', 'TOKEN_FAKE_DO_NOT_KEEP']), attrs(['id', 'send'], ['onclick', "location.href='https://example.test/?token=bad'"]), [], attrs(['title', 'Subdocumento']), attrs(['id', 'host']), [], attrs(['data-testid', 'shadow-action']), attrs(['id', 'clip'])],
            contentDocumentIndex: { index: [9], value: [1] },
            shadowRootType: { index: [11], value: [s('open')] }
          },
          layout: {
            nodeIndex: [3, 4, 5, 6, 7, 8, 9, 10, 12, 13],
            bounds: [[8, 8, 200, 40], [8, 8, 100, 20], [8, 60, 180, 30], [8, 100, 1, 1], [8, 120, 90, 32], [12, 126, 60, 18], [8, 170, 280, 100], [8, 280, 200, 50], [12, 290, 120, 30], [8, 340, 160, 90]],
            styles: Array.from({ length: 10 }, () => [s('block'), s('visible'), s(''), s('rgb(10, 20, 30)'), ...Array(17).fill(s(''))])
          }
        },
        {
          frameId: s('inner'),
          documentURL: s('https://example.test/frame?auth=bad&ok=1'),
          title: s('Subdocumento'),
          nodes: {
            parentIndex: [-1, 0, 1, 2, 3],
            nodeType: [9, 1, 1, 1, 3],
            nodeName: [s('#document'), s('HTML'), s('BODY'), s('P'), s('#text')],
            nodeValue: [s(''), s(''), s(''), s(''), s('Dentro')],
            backendNodeId: [11, 12, 13, 14, 15],
            attributes: [[], [], [], attrs(['id', 'inner']), []]
          },
          layout: { nodeIndex: [3, 4], bounds: [[2, 2, 100, 20], [2, 2, 50, 18]], styles: [[s('block'), s('visible'), s(''), s('rgb(10, 20, 30)'), ...Array(17).fill(s(''))], [s('block'), s('visible'), s(''), s('rgb(10, 20, 30)'), ...Array(17).fill(s(''))]] }
        }
      ]
    },
    axTree: {
      nodes: [
        { backendDOMNodeId: 8, role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Enviar' }, description: { type: 'computedString', value: 'Confirma o envio' } },
        { backendDOMNodeId: 6, role: { type: 'role', value: 'textbox' }, name: { type: 'computedString', value: 'Senha' }, value: { type: 'string', value: 'PW_AX_FAKE_DO_NOT_KEEP' } }
      ]
    },
    layoutMetrics: { cssContentSize: { width: 320, height: 900 }, cssLayoutViewport: { clientWidth: 320, clientHeight: 640 } },
    pageData: [
      { frameId: 'host', result: { framePath: [], nodes: [
        { backendNodeId: 8, selectorHint: '#send', visibleText: 'Enviar', focusable: true, interaction: 'button', rect: { x: 8, y: 120, width: 90, height: 32 } },
        { backendNodeId: 20, selectorHint: '#clip', media: { kind: 'video', currentSrc: 'https://user:pass@example.test/movie.mp4?token=bad&lang=pt#secret=bad', durationSeconds: 12, muted: true, autoplay: false } }
      ] } }
    ],
    warnings: []
  };
}

test('normalizes a real columnar DOMSnapshot in deterministic iframe and shadow order', () => {
  const snapshot = normalizeSnapshot(columnarRaw());
  assert.deepEqual(validateSnapshotV1(snapshot), []);
  assert.deepEqual(snapshot.nodes.map(node => node.backendNodeId), [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 20]);

  const iframe = snapshot.nodes.find(node => node.backendNodeId === 10);
  const innerHtml = snapshot.nodes.find(node => node.backendNodeId === 12);
  const shadowRoot = snapshot.nodes.find(node => node.backendNodeId === 17);
  assert.equal(innerHtml.parentId, iframe.nodeId);
  assert.deepEqual(innerHtml.framePath, [iframe.nodeId]);
  assert.equal(shadowRoot.shadowRootType, 'open');
  assert.equal(shadowRoot.parentId, snapshot.nodes.find(node => node.backendNodeId === 16).nodeId);
  assert.equal(snapshot.nodes.find(node => node.backendNodeId === 4).text, 'Bem-vindo');
  assert.deepEqual(snapshot.nodes.find(node => node.backendNodeId === 4).styles, {
    display: 'block', visibility: 'visible', color: 'rgb(10, 20, 30)'
  });
});

test('merges AX and runtime data while redacting sensitive values and resource URL secrets', async () => {
  const raw = columnarRaw();
  raw.warnings = [{ code: 'FRAME_RUNTIME_BLOCKED', message: 'blocked token=WARNING_FAKE' }];
  const snapshot = normalizeSnapshot(raw);
  const button = snapshot.nodes.find(node => node.backendNodeId === 8);
  const password = snapshot.nodes.find(node => node.backendNodeId === 6);
  const token = snapshot.nodes.find(node => node.backendNodeId === 7);
  const video = snapshot.nodes.find(node => node.backendNodeId === 20);

  assert.deepEqual({ role: button.axRole, name: button.accessibleName, description: button.accessibleDescription }, {
    role: 'button', name: 'Enviar', description: 'Confirma o envio'
  });
  assert.equal(button.selectorHint, '#send');
  assert.equal(button.focusable, true);
  assert.equal(Object.hasOwn(password.attributes, 'value'), false);
  assert.equal(Object.hasOwn(password, 'axValue'), false);
  assert.equal(password.accessibleName, 'Senha');
  assert.equal(Object.hasOwn(token.attributes, 'value'), false);
  assert.equal(token.hidden, true);
  assert.equal(video.media.currentSrc, 'https://example.test/movie.mp4?lang=pt');
  assert.equal(snapshot.document.url, 'https://example.test/page?view=public');
  assert.doesNotMatch(JSON.stringify(snapshot), /PW_FAKE|TOKEN_FAKE|PW_AX_FAKE|WARNING_FAKE|authorization=bad|token=bad|user:pass/i);
  assert.doesNotThrow(() => JSON.stringify(snapshot));

  const audit = await runCoreAudit(snapshot);
  assert.equal(audit.composition.valid, true);
  assert.equal(audit.ruleResults.length, 130);

  const selector = buildStableSelector(button, buildSnapshotIndexes(snapshot));
  const snippet = sanitizeHtmlSnippet('<button id="send" onclick="bad()" data-token="fixture">Enviar</button>');
  const screenshot = await captureFullPage({ command: async () => ({ data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }) }, rawMetrics(snapshot));
  assert.deepEqual(selector, { css: '#send', framePath: [], confidence: 'high' });
  assert.equal(snippet, '<button id="send">Enviar</button>');
  assert.equal(screenshot.status, 'captured');
});

function rawMetrics(snapshot) {
  return snapshot.document.layoutMetrics;
}

test('accepts only explicitly marked simplified fixtures', () => {
  const simplified = {
    format: 'simplified-v1',
    document: { url: 'https://example.test/', title: 'Fixture', language: 'pt-BR' },
    nodes: [{
      backendNodeId: 1, tagName: 'button', attributes: { id: 'ok' }, text: 'OK', parentBackendNodeId: null,
      rect: { x: 1, y: 2, width: 24, height: 24 }, styles: { display: 'block' },
      media: { kind: 'image', currentSrc: 'https://example.test/a.png?token=bad&ok=1' }
    }, {
      backendNodeId: 2, tagName: 'INPUT', attributes: { TYPE: 'PASSWORD', VALUE: 'PW_UPPER_FAKE' }, text: '', parentBackendNodeId: null
    }],
    axTree: { nodes: [{ backendDOMNodeId: 1, role: { value: 'button' }, name: { value: 'OK' } }] }
  };
  const node = normalizeSnapshot(simplified).nodes[0];
  assert.equal(node.tagName, 'button');
  assert.deepEqual(node.rect, { x: 1, y: 2, width: 24, height: 24 });
  assert.deepEqual(node.styles, { display: 'block' });
  assert.equal(node.media.currentSrc, 'https://example.test/a.png?ok=1');
  assert.equal(node.axRole, 'button');
  assert.equal(node.accessibleName, 'OK');
  assert.doesNotMatch(JSON.stringify(normalizeSnapshot(simplified)), /PW_UPPER_FAKE/);
  assert.throws(() => normalizeSnapshot({ ...simplified, format: undefined }), /DOMSnapshot|formato/i);
});

test('associates runtime data by sanitized document URL when Chrome and CDP frame IDs differ', () => {
  const raw = columnarRaw();
  raw.pageData = [{
    frameId: 0,
    result: {
      url: 'https://example.test/page?view=public',
      nodes: [{ order: 5, tagName: 'button', visibleText: 'Enviar por runtime', focusable: true, hidden: true }]
    }
  }];
  const button = normalizeSnapshot(raw).nodes.find(node => node.backendNodeId === 8);
  assert.equal(button.visibleText, 'Enviar por runtime');
  assert.equal(button.focusable, true);
  assert.equal(button.hidden, true);
});

test('collectPage issues the minimal structural CDP commands and injects runtime collection', async () => {
  const calls = [];
  const cdp = { command: async (method, params = {}) => {
    calls.push([method, params]);
    if (method === 'DOMSnapshot.captureSnapshot') return Object.freeze({ strings: [], documents: [] });
    if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
    if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: 1, height: 1 } };
    return {};
  } };
  const injections = [];
  const executeScript = async options => {
    injections.push(options);
    return [{ frameId: 0, result: { nodes: [] } }];
  };

  const raw = await collectPage(cdp, 42, { executeScript });
  assert.deepEqual(calls.slice(0, 4).map(([method]) => method), ['Page.enable', 'DOM.enable', 'Accessibility.enable', 'Network.enable']);
  assert.deepEqual(calls.slice(4).map(([method]) => method), ['DOMSnapshot.captureSnapshot', 'Accessibility.getFullAXTree', 'Page.getLayoutMetrics']);
  assert.deepEqual(calls[4][1], { computedStyles: COMPUTED_STYLES, includeDOMRects: true, includePaintOrder: true });
  assert.equal(injections[0].target.tabId, 42);
  assert.equal(injections[0].target.allFrames, true);
  assert.equal(typeof injections[0].func, 'function');
  assert.deepEqual(raw.pageData, [{ frameId: 0, result: { nodes: [] } }]);
  assert.deepEqual(raw.warnings, []);
});

test('collectPage degrades blocked frame injection to a warning but propagates structural failure', async () => {
  const healthy = { command: async method => {
    if (method === 'DOMSnapshot.captureSnapshot') return { strings: [], documents: [] };
    if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
    if (method === 'Page.getLayoutMetrics') return {};
    return {};
  } };
  const partial = await collectPage(healthy, 9, { executeScript: async () => { throw new Error('frame blocked token=FRAME_WARNING_FAKE'); } });
  assert.equal(partial.pageData.length, 0);
  assert.match(partial.warnings[0].message, /frame blocked/);
  assert.doesNotMatch(JSON.stringify(partial), /FRAME_WARNING_FAKE/);

  const broken = { command: async method => {
    if (method === 'DOMSnapshot.captureSnapshot') throw new Error('main snapshot failed');
    return {};
  } };
  await assert.rejects(collectPage(broken, 9, { executeScript: async () => [] }), /main snapshot failed/);
});
