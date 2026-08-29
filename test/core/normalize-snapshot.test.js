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
  'letter-spacing', 'word-spacing', 'text-align', 'outline-color', 'outline-style',
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

function columnarContentEditable(secret) {
  const strings = ['#document', 'HTML', 'BODY', 'DIV', '#text', 'contenteditable', 'true', secret, 'https://example.test/', 'Fixture'];
  const s = value => strings.indexOf(value);
  return {
    domSnapshot: {
      strings,
      computedStyles: [],
      documents: [{
        frameId: 0,
        documentURL: s('https://example.test/'),
        title: s('Fixture'),
        nodes: {
          parentIndex: [-1, 0, 1, 2, 3, 4],
          nodeType: [9, 1, 1, 1, 1, 3],
          nodeName: [s('#document'), s('HTML'), s('BODY'), s('DIV'), s('DIV'), s('#text')],
          nodeValue: [0, 0, 0, 0, 0, s(secret)],
          backendNodeId: [1, 2, 3, 4, 5, 6],
          attributes: [[], [], [], [s('contenteditable'), s('true')], [s('contenteditable'), s('true')], []],
        },
        layout: { nodeIndex: [], bounds: [], styles: [] },
      }],
    },
    axTree: { nodes: [4, 5].map(backendDOMNodeId => ({
      backendDOMNodeId,
      role: { value: 'textbox' },
      name: { value: secret },
      description: { value: secret },
      value: { value: secret },
    })) },
    pageData: [],
    warnings: [],
  };
}

function columnarPrivateTextAncestorLeak(secret) {
  const strings = [
    '#document', 'HTML', 'BODY', 'SECTION', 'P', '#text', 'DIV', 'ASIDE',
    'contenteditable', 'true', secret, 'Conteúdo público', 'Rodapé público',
    'https://example.test/', 'Fixture',
  ];
  const s = value => strings.indexOf(value);
  return {
    domSnapshot: {
      strings,
      computedStyles: [],
      documents: [{
        frameId: 0,
        documentURL: s('https://example.test/'),
        title: s('Fixture'),
        nodes: {
          parentIndex: [-1, 0, 1, 2, 3, 4, 3, 6, 2, 8],
          nodeType: [9, 1, 1, 1, 1, 3, 1, 3, 1, 3],
          nodeName: [s('#document'), s('HTML'), s('BODY'), s('SECTION'), s('P'), s('#text'), s('DIV'), s('#text'), s('ASIDE'), s('#text')],
          nodeValue: [0, 0, 0, 0, 0, s('Conteúdo público'), 0, s(secret), 0, s('Rodapé público')],
          backendNodeId: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          attributes: [[], [], [], [], [], [], [s('contenteditable'), s('true')], [], [], []],
        },
        layout: { nodeIndex: [], bounds: [], styles: [] },
      }],
    },
    axTree: { nodes: [] },
    pageData: [{ frameId: '0', result: { nodes: [
      { backendNodeId: 2, visibleText: `Conteúdo público ${secret} Rodapé público` },
      { backendNodeId: 3, visibleText: `Conteúdo público ${secret} Rodapé público` },
      { backendNodeId: 4, visibleText: `Conteúdo público ${secret}` },
      { backendNodeId: 5, visibleText: 'Conteúdo público' },
      { backendNodeId: 7, visibleText: secret },
      { backendNodeId: 9, visibleText: 'Rodapé público' },
    ] } }],
    warnings: [],
  };
}

function privateEditorRaw(secret) {
  return {
    format: 'simplified-v1',
    document: { url: 'https://example.test/', title: 'Privacy' },
    nodes: [
      {
        backendNodeId: 1, tagName: 'div', parentBackendNodeId: null,
        attributes: {
          id: secret, name: secret, contenteditable: 'true', role: 'textbox', tabindex: '0',
          title: secret, 'aria-label': secret, 'aria-description': secret,
          'aria-labelledby': 'editor-label', 'aria-describedby': 'editor-description',
          'data-private': secret, href: `https://example.test/editor?view=${secret}`,
        },
        selectorHint: `#${secret}`, text: secret, visibleText: secret,
        media: { kind: 'video', currentSrc: `https://example.test/media?view=${secret}` },
      },
      {
        backendNodeId: 2, tagName: 'div', parentBackendNodeId: 1,
        attributes: {
          id: secret, name: secret, title: secret, 'aria-label': secret,
          'data-private': secret, src: `https://example.test/private?view=${secret}`,
        },
        selectorHint: `#${secret}`, text: secret, visibleText: secret,
        media: { kind: 'video', currentSrc: `https://example.test/private-media?view=${secret}` },
      },
      {
        backendNodeId: 3, tagName: 'input', parentBackendNodeId: 1,
        attributes: { id: secret, name: secret, type: 'text', title: secret, 'data-private': secret, value: secret },
        selectorHint: `#${secret}`, text: secret, visibleText: secret,
        form: { type: 'text', value: secret, currentValue: secret },
      },
      { backendNodeId: 4, tagName: 'span', parentBackendNodeId: null, attributes: { id: 'editor-label' }, text: 'Editor externo seguro' },
      { backendNodeId: 5, tagName: 'span', parentBackendNodeId: null, attributes: { id: 'editor-description' }, text: 'Descrição externa segura' },
    ],
    axTree: { nodes: [
      { backendDOMNodeId: 1, role: { value: 'textbox' }, name: { value: secret }, description: { value: secret }, value: { value: secret } },
      { backendDOMNodeId: 2, role: { value: 'generic' }, name: { value: secret }, description: { value: secret }, value: { value: secret } },
      { backendDOMNodeId: 3, role: { value: 'textbox' }, name: { value: 'Campo interno seguro' }, description: { value: 'Descrição do campo segura' }, value: { value: secret } },
    ] },
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
  assert.equal(shadowRoot.shadowRootId, shadowRoot.nodeId);
  assert.equal(shadowRoot.shadowHostId, snapshot.nodes.find(node => node.backendNodeId === 16).nodeId);
  assert.equal(snapshot.nodes.find(node => node.backendNodeId === 18).shadowRootId, shadowRoot.nodeId);
  assert.equal(snapshot.nodes.find(node => node.backendNodeId === 18).shadowHostId, snapshot.nodes.find(node => node.backendNodeId === 16).nodeId);
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
  assert.equal(snippet, '&lt;button id=&quot;send&quot;&gt;Enviar&lt;/button&gt;');
  assert.equal(screenshot.status, 'captured');
});

function rawMetrics(snapshot) {
  return snapshot.document.layoutMetrics;
}

const UNAVAILABLE_WARNINGS = [{
  code: 'WARNINGS_UNAVAILABLE',
  message: 'Os avisos de coleta não puderam ser normalizados com segurança.',
}];

test('normalizes simplified and columnar warning properties before touching hostile collections', () => {
  const marker = 'PRIVATE_SNAPSHOT_WARNINGS_MESSAGE';
  let getterReads = 0;
  const simplified = {
    format: 'simplified-v1',
    document: { url: 'https://example.test/', title: 'Fixture' },
    nodes: [],
  };
  const columnar = columnarRaw();
  for (const raw of [simplified, columnar]) {
    Object.defineProperty(raw, 'warnings', {
      configurable: true,
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error(marker);
      },
    });
    let snapshot;
    assert.doesNotThrow(() => { snapshot = normalizeSnapshot(raw); });
    assert.deepEqual(snapshot.document.warnings, UNAVAILABLE_WARNINGS);
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(marker));
  }
  assert.equal(getterReads, 0);
});

test('contains hostile external warning slots before simplified or columnar normalization', () => {
  const marker = 'PRIVATE_SNAPSHOT_WARNING_SLOT_MESSAGE';
  let getterReads = 0;
  for (const raw of [
    { format: 'simplified-v1', document: { url: 'https://example.test/' }, nodes: [] },
    columnarRaw(),
  ]) {
    const warnings = new Array(1);
    Object.defineProperty(warnings, '0', {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error(marker);
      },
    });
    raw.warnings = warnings;
    let snapshot;
    assert.doesNotThrow(() => { snapshot = normalizeSnapshot(raw); });
    assert.deepEqual(snapshot.document.warnings, UNAVAILABLE_WARNINGS);
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(marker));
  }
  assert.equal(getterReads, 0);
});

test('normalizes frame identifiers from own primitive data without invoking object coercion', () => {
  const marker = 'PRIVATE_SNAPSHOT_FRAME_COERCION_MESSAGE';
  let coercions = 0;
  const hostileFrameId = {
    [Symbol.toPrimitive]() {
      coercions += 1;
      throw new Error(marker);
    },
  };
  const columnar = columnarRaw();
  columnar.domSnapshot.documents[0].frameId = hostileFrameId;
  columnar.pageData[0].frameId = hostileFrameId;

  let snapshot;
  assert.doesNotThrow(() => { snapshot = normalizeSnapshot(columnar); });
  assert.equal(coercions, 0);
  assert.equal(snapshot.nodes.some(node => typeof node.frameId !== 'string'), false);
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(marker));
});

test('normalizes frame paths from dense own primitive leaves without invoking hostile slots or coercion', () => {
  const marker = 'PRIVATE_SNAPSHOT_FRAME_PATH_MESSAGE';
  let getterReads = 0;
  let coercions = 0;
  const framePath = new Array(2);
  Object.defineProperty(framePath, '0', {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error(marker);
    },
  });
  framePath[1] = {
    [Symbol.toPrimitive]() {
      coercions += 1;
      throw new Error(marker);
    },
  };
  const raw = {
    format: 'simplified-v1',
    document: { url: 'https://example.test/', title: 'Fixture' },
    nodes: [{
      backendNodeId: 1,
      parentBackendNodeId: null,
      tagName: 'div',
      attributes: {},
      framePath,
    }],
  };

  let snapshot;
  assert.doesNotThrow(() => { snapshot = normalizeSnapshot(raw); });
  assert.equal(getterReads, 0);
  assert.equal(coercions, 0);
  assert.deepEqual(snapshot.nodes[0].framePath, []);
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(marker));
});

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

test('applies privacy redaction after runtime and AX merges and zeros executable subtrees', () => {
  const marker = 'POST_MERGE_PRIVACY_MARKER';
  const raw = {
    format: 'simplified-v1',
    document: { url: `https://user:${marker}@example.test/?token=${marker}&ok=1`, title: 'Privacy' },
    nodes: [
      {
        backendNodeId: 1, tagName: 'input', parentBackendNodeId: null,
        attributes: { type: 'password', value: marker, style: `background:url(data:image/png,${marker})` },
        visibleText: marker, form: { type: 'password', value: marker, currentValue: marker },
        styles: { display: 'block', 'background-image': `url("data:image/svg+xml,${marker}")` },
        media: { kind: 'image', currentSrc: `data:image/png;base64,${marker}` }
      },
      { backendNodeId: 2, tagName: 'script', parentBackendNodeId: null, text: `window.token='${marker}'` },
      { backendNodeId: 3, tagName: '#text', parentBackendNodeId: 2, text: marker, visibleText: marker },
      { backendNodeId: 4, tagName: 'style', parentBackendNodeId: null, text: `body{background:url(blob:${marker})}` },
      { backendNodeId: 5, tagName: '#text', parentBackendNodeId: 4, text: marker },
      { backendNodeId: 6, tagName: 'template', parentBackendNodeId: null, text: marker },
      { backendNodeId: 7, tagName: '#text', parentBackendNodeId: 6, text: marker }
    ],
    axTree: { nodes: [{
      backendDOMNodeId: 1, role: { value: 'textbox' }, name: { value: 'Senha da conta' }, value: { value: marker }
    }] }
  };
  const snapshot = normalizeSnapshot(raw);
  const password = snapshot.nodes[0];
  assert.equal(password.accessibleName, 'Senha da conta');
  assert.equal(password.backgroundImageKind, 'url');
  assert.equal(Object.hasOwn(password.attributes, 'style'), false);
  assert.equal(Object.hasOwn(password.attributes, 'value'), false);
  assert.equal(Object.hasOwn(password, 'axValue'), false);
  assert.equal(Object.hasOwn(password.form, 'value'), false);
  assert.equal(Object.hasOwn(password.form, 'currentValue'), false);
  assert.equal(password.visibleText, '');
  assert.equal(password.media.currentSrc, 'data:[redacted]');
  for (const node of snapshot.nodes.slice(1)) {
    assert.equal(node.text, '');
    assert.equal(node.visibleText, '');
  }
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(marker));
});

test('never persists current values from ordinary editable controls or runtime aliases', () => {
  const firstSecret = 'TOPSECRET-api-key-one';
  const raw = {
    format: 'simplified-v1',
    document: { url: 'https://example.test/', title: 'Privacy' },
    nodes: [
      {
        backendNodeId: 1, tagName: 'input', parentBackendNodeId: null,
        attributes: { type: 'text', name: 'api_key', value: firstSecret, 'aria-valuenow': firstSecret, 'aria-valuetext': firstSecret },
        text: firstSecret, visibleText: firstSecret,
        form: { type: 'text', value: firstSecret, currentValue: firstSecret, rawValue: firstSecret, inputValue: firstSecret },
      },
      {
        backendNodeId: 2, tagName: 'textarea', parentBackendNodeId: null,
        attributes: {}, text: firstSecret, visibleText: firstSecret,
        form: { type: 'textarea', value: firstSecret, currentValue: firstSecret },
      },
      {
        backendNodeId: 3, tagName: 'div', parentBackendNodeId: null,
        attributes: { contenteditable: 'true' }, text: firstSecret, visibleText: firstSecret,
        currentValue: firstSecret,
      },
      {
        backendNodeId: 4, tagName: 'select', parentBackendNodeId: null,
        attributes: { value: firstSecret }, form: { type: 'select', value: firstSecret, selectedIndex: 0 },
      },
      {
        backendNodeId: 5, tagName: 'option', parentBackendNodeId: 4,
        attributes: { value: firstSecret, selected: '' }, text: 'Rótulo público', visibleText: 'Rótulo público',
      },
    ],
    axTree: { nodes: [
      { backendDOMNodeId: 1, role: { value: 'textbox' }, name: { value: 'Chave da API' }, value: { value: firstSecret } },
      { backendDOMNodeId: 2, role: { value: 'textbox' }, name: { value: 'Observação' }, value: { value: firstSecret } },
      { backendDOMNodeId: 3, role: { value: 'textbox' }, name: { value: 'Editor' }, value: { value: firstSecret } },
      { backendDOMNodeId: 4, role: { value: 'combobox' }, name: { value: 'Escolha' }, value: { value: firstSecret } },
    ] },
  };

  const snapshot = normalizeSnapshot(raw);
  for (const node of snapshot.nodes.filter(item => ['input', 'textarea', 'div', 'select'].includes(item.tagName))) {
    assert.equal(node.valueStatus, 'omitted-privacy');
    assert.equal(Object.hasOwn(node.attributes, 'value'), false);
    assert.equal(Object.hasOwn(node.attributes, 'aria-valuenow'), false);
    assert.equal(Object.hasOwn(node.attributes, 'aria-valuetext'), false);
    assert.equal(Object.hasOwn(node, 'axValue'), false);
    assert.equal(node.text, '');
    assert.equal(node.visibleText, '');
    assert.equal(Object.hasOwn(node.form || {}, 'value'), false);
    assert.equal(Object.hasOwn(node.form || {}, 'currentValue'), false);
    assert.equal(Object.hasOwn(node.form || {}, 'rawValue'), false);
    assert.equal(Object.hasOwn(node.form || {}, 'inputValue'), false);
  }
  assert.equal(snapshot.nodes.find(node => node.backendNodeId === 1).accessibleName, 'Chave da API');
  assert.equal(snapshot.nodes.find(node => node.backendNodeId === 2).accessibleName, 'Observação');
  assert.equal(Object.hasOwn(snapshot.nodes.find(node => node.backendNodeId === 3), 'accessibleName'), false);
  assert.equal(snapshot.nodes.find(node => node.backendNodeId === 4).accessibleName, 'Escolha');
  const option = snapshot.nodes.find(node => node.tagName === 'option');
  assert.equal(Object.hasOwn(option.attributes, 'value'), false);
  assert.equal(Object.hasOwn(option.attributes, 'selected'), false);
  assert.equal(option.text, 'Rótulo público');
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(firstSecret));
});

test('removes AX-derived content from a contenteditable root and every private descendant', () => {
  const simplifiedSecret = 'TOPSECRET-contenteditable-simplified';
  const simplified = normalizeSnapshot({
    format: 'simplified-v1',
    document: { url: 'https://example.test/', title: 'Privacy' },
    nodes: [
      { backendNodeId: 1, tagName: 'div', parentBackendNodeId: null, attributes: { contenteditable: 'true' }, text: simplifiedSecret },
      { backendNodeId: 2, tagName: 'div', parentBackendNodeId: 1, attributes: { contenteditable: 'true' }, text: simplifiedSecret },
      { backendNodeId: 3, tagName: 'span', parentBackendNodeId: 2, attributes: {}, text: simplifiedSecret },
      { backendNodeId: 4, tagName: 'input', parentBackendNodeId: 2, attributes: { type: 'text', value: simplifiedSecret }, text: simplifiedSecret },
    ],
    axTree: { nodes: [1, 2, 3].map(backendDOMNodeId => ({
      backendDOMNodeId, role: { value: 'textbox' }, name: { value: simplifiedSecret },
      description: { value: simplifiedSecret }, value: { value: simplifiedSecret },
    })).concat({
      backendDOMNodeId: 4, role: { value: 'textbox' }, name: { value: 'Rótulo estático seguro' },
      description: { value: 'Descrição estática segura' }, value: { value: simplifiedSecret },
    }) },
  });
  const columnarSecret = 'TOPSECRET-contenteditable-columnar';
  const columnar = normalizeSnapshot(columnarContentEditable(columnarSecret));

  for (const [snapshot, secret] of [[simplified, simplifiedSecret], [columnar, columnarSecret]]) {
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret));
    for (const node of snapshot.nodes.filter(item => ['div', 'span'].includes(item.tagName))) {
      assert.equal(Object.hasOwn(node, 'axValue'), false);
      assert.equal(Object.hasOwn(node, 'accessibleName'), false);
      assert.equal(Object.hasOwn(node, 'accessibleDescription'), false);
      assert.equal(node.text, '');
      assert.equal(node.visibleText, '');
    }
  }
  const nestedInput = simplified.nodes.find(node => node.backendNodeId === 4);
  assert.equal(nestedInput.accessibleName, 'Rótulo estático seguro');
  assert.equal(nestedInput.accessibleDescription, 'Descrição estática segura');
});

test('redacts aggregated visibleText only on ancestors of private text roots in simplified and columnar snapshots', () => {
  const simplifiedSecret = 'TOPSECRET-private-ancestor-simplified';
  const simplified = normalizeSnapshot({
    format: 'simplified-v1',
    document: { url: 'https://example.test/', title: 'Privacy' },
    nodes: [
      { backendNodeId: 1, tagName: 'body', parentBackendNodeId: null, attributes: { 'data-public': 'shell' }, text: 'Estrutura pública', visibleText: `Conteúdo público ${simplifiedSecret} Rodapé público` },
      { backendNodeId: 2, tagName: 'section', parentBackendNodeId: 1, attributes: { 'aria-label': 'Seção pública' }, text: 'Estrutura da seção', visibleText: `Conteúdo público ${simplifiedSecret}` },
      { backendNodeId: 3, tagName: 'p', parentBackendNodeId: 2, attributes: {}, text: 'Conteúdo público', visibleText: 'Conteúdo público' },
      { backendNodeId: 4, tagName: 'div', parentBackendNodeId: 2, attributes: { contenteditable: 'true' }, text: simplifiedSecret, visibleText: simplifiedSecret },
      { backendNodeId: 5, tagName: 'span', parentBackendNodeId: 4, attributes: {}, text: simplifiedSecret, visibleText: simplifiedSecret },
      { backendNodeId: 6, tagName: 'aside', parentBackendNodeId: 1, attributes: {}, text: 'Rodapé público', visibleText: 'Rodapé público' },
    ],
    axTree: { nodes: [] },
  });
  const columnarSecret = 'TOPSECRET-private-ancestor-columnar';
  const columnar = normalizeSnapshot(columnarPrivateTextAncestorLeak(columnarSecret));

  for (const [snapshot, ancestorBackends, publicBackends, secret] of [
    [simplified, [1, 2], [[3, 'Conteúdo público'], [6, 'Rodapé público']], simplifiedSecret],
    [columnar, [2, 3, 4], [[5, 'Conteúdo público'], [9, 'Rodapé público']], columnarSecret],
  ]) {
    for (const backendNodeId of ancestorBackends) {
      const ancestor = snapshot.nodes.find(node => node.backendNodeId === backendNodeId);
      assert.equal(ancestor.visibleText, '');
      assert.notEqual(ancestor.text, '');
    }
    for (const [backendNodeId, visibleText] of publicBackends) {
      assert.equal(snapshot.nodes.find(node => node.backendNodeId === backendNodeId).visibleText, visibleText);
    }
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret));
  }
  assert.equal(simplified.nodes.find(node => node.backendNodeId === 1).attributes['data-public'], 'shell');
  assert.equal(simplified.nodes.find(node => node.backendNodeId === 2).attributes['aria-label'], 'Seção pública');
});

test('strictly redacts contenteditable root and descendant attributes while preserving external references and control labels', () => {
  const first = normalizeSnapshot(privateEditorRaw('TOPSECRET-A'));
  const second = normalizeSnapshot(privateEditorRaw('TOPSECRET-B'));
  const root = first.nodes.find(node => node.backendNodeId === 1);
  const descendant = first.nodes.find(node => node.backendNodeId === 2);
  const nestedInput = first.nodes.find(node => node.backendNodeId === 3);

  assert.deepEqual(root.attributes, {
    contenteditable: 'true', role: 'textbox', tabindex: '0',
    'aria-labelledby': 'editor-label', 'aria-describedby': 'editor-description',
  });
  assert.equal(root.selectorHint, '');
  assert.equal(Object.hasOwn(root, 'media'), false);
  for (const property of ['accessibleName', 'accessibleDescription', 'axValue']) {
    assert.equal(Object.hasOwn(root, property), false);
  }
  assert.deepEqual(descendant.attributes, {});
  assert.equal(descendant.selectorHint, '');
  assert.equal(Object.hasOwn(descendant, 'media'), false);
  assert.equal(Object.hasOwn(descendant, 'accessibleName'), false);
  assert.equal(Object.hasOwn(descendant, 'accessibleDescription'), false);
  assert.deepEqual(nestedInput.attributes, {});
  assert.equal(nestedInput.selectorHint, '');
  assert.equal(Object.hasOwn(nestedInput, 'media'), false);
  assert.equal(Object.hasOwn(nestedInput, 'form'), false);
  assert.equal(nestedInput.accessibleName, 'Campo interno seguro');
  assert.equal(nestedInput.accessibleDescription, 'Descrição do campo segura');
  assert.equal(Object.hasOwn(nestedInput, 'axValue'), false);
  assert.doesNotMatch(JSON.stringify(first), /TOPSECRET/iu);
  assert.deepEqual(first, second);
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

test('keeps DOMSnapshot document bounds and only retains runtime viewport/document rects as distinct coordinates', () => {
  const raw = columnarRaw();
  raw.pageData[0].result.nodes[0].viewportRect = { x: 8, y: 500, width: 90, height: 32 };
  raw.pageData[0].result.nodes[0].documentRect = { x: 8, y: 1500, width: 90, height: 32 };
  const button = normalizeSnapshot(raw).nodes.find(node => node.backendNodeId === 8);
  assert.deepEqual(button.rect, { x: 8, y: 120, width: 90, height: 32 });
  assert.deepEqual(button.viewportRect, { x: 8, y: 500, width: 90, height: 32 });
  assert.deepEqual(button.documentRect, { x: 8, y: 1500, width: 90, height: 32 });
});

test('does not associate ambiguous runtime fallbacks across same-URL frames', () => {
  const raw = columnarRaw();
  const mainUrlIndex = raw.domSnapshot.documents[0].documentURL;
  const h1Index = raw.domSnapshot.strings.indexOf('H1');
  raw.domSnapshot.documents[1].documentURL = mainUrlIndex;
  raw.domSnapshot.documents[1].nodes.nodeName[3] = h1Index;
  raw.pageData = [
    { frameId: 0, result: { url: 'https://example.test/page?view=public', nodes: [{ order: 2, tagName: 'h1', visibleText: 'WRONG_A', focusable: true }] } },
    { frameId: 1, result: { url: 'https://example.test/page?view=public', nodes: [{ order: 2, tagName: 'h1', visibleText: 'WRONG_B', focusable: true }] } }
  ];
  raw.coverage = {
    runtime: { outcome: 'partial', expectedFrameCount: 2, observedFrameCount: 2 },
    accessibility: { outcome: 'complete', expectedFrameCount: 2, observedFrameCount: 2 }
  };
  const snapshot = normalizeSnapshot(raw);
  const headings = snapshot.nodes.filter(node => node.tagName === 'h1');
  assert.equal(headings.length, 2);
  assert.equal(headings.some(node => /WRONG_/u.test(node.visibleText)), false);
  assert.equal(headings.some(node => node.focusable === true), false);
  assert.equal(snapshot.document.warnings.some(item => item.code === 'RUNTIME_MATCH_AMBIGUOUS'), true);
  assert.equal(snapshot.document.coverage.runtime.outcome, 'partial');
});

test('collectPage issues the minimal structural CDP commands and injects runtime collection', async () => {
  const calls = [];
  const cdp = { command: async (method, params = {}) => {
    calls.push([method, params]);
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root', url: 'https://example.test/' }, childFrames: [{ frame: { id: 'child', url: 'https://example.test/frame' } }] } };
    if (method === 'DOMSnapshot.captureSnapshot') return Object.freeze({ strings: [], documents: [] });
    if (method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: `ax-${params.frameId}` }] };
    if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: 1, height: 1 } };
    return {};
  } };
  const injections = [];
  const executeScript = async options => {
    injections.push(options);
    return [
      { frameId: 'root', result: { url: 'https://example.test/', nodes: [] } },
      { frameId: 'child', result: { url: 'https://example.test/frame', nodes: [] } }
    ];
  };

  const raw = await collectPage(cdp, 42, { executeScript });
  assert.deepEqual(calls.slice(0, 4).map(([method]) => method), ['Page.enable', 'DOM.enable', 'Accessibility.enable', 'Network.enable']);
  assert.deepEqual(calls.slice(4).map(([method]) => method), ['Page.getFrameTree', 'DOMSnapshot.captureSnapshot', 'Accessibility.getFullAXTree', 'Accessibility.getFullAXTree', 'Page.getLayoutMetrics']);
  assert.deepEqual(calls[5][1], { computedStyles: COMPUTED_STYLES, includeDOMRects: true, includePaintOrder: true });
  assert.deepEqual(calls.filter(([method]) => method === 'Accessibility.getFullAXTree').map(([, params]) => params), [{ frameId: 'root' }, { frameId: 'child' }]);
  assert.equal(injections[0].target.tabId, 42);
  assert.equal(injections[0].target.allFrames, true);
  assert.equal(typeof injections[0].func, 'function');
  assert.equal(raw.axTree.nodes.length, 2);
  assert.equal(raw.pageData.length, 2);
  assert.equal(raw.coverage.runtime.outcome, 'complete');
  assert.equal(raw.coverage.accessibility.outcome, 'complete');
  assert.deepEqual(raw.warnings, []);
});

test('collectPage degrades blocked frame injection to a warning but propagates structural failure', async () => {
  const healthy = { command: async (method, params) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root', url: 'https://example.test/' }, childFrames: [{ frame: { id: 'child', url: 'https://example.test/frame' } }] } };
    if (method === 'DOMSnapshot.captureSnapshot') return { strings: [], documents: [] };
    if (method === 'Accessibility.getFullAXTree') {
      if (params.frameId === 'child') throw new Error('AX token=AX_FRAME_WARNING_FAKE');
      return { nodes: [] };
    }
    if (method === 'Page.getLayoutMetrics') return {};
    return {};
  } };
  const partial = await collectPage(healthy, 9, { executeScript: async () => { throw new Error('frame blocked token=FRAME_WARNING_FAKE'); } });
  assert.equal(partial.pageData.length, 0);
  assert.equal(partial.coverage.runtime.outcome, 'partial');
  assert.equal(partial.coverage.accessibility.outcome, 'partial');
  assert.equal(partial.warnings.some(item => item.code === 'FRAME_RUNTIME_BLOCKED'), true);
  assert.equal(partial.warnings.some(item => item.code === 'RUNTIME_FRAME_MISSING'), true);
  assert.equal(partial.warnings.some(item => item.code === 'AX_FRAME_UNAVAILABLE'), true);
  assert.doesNotMatch(JSON.stringify(partial), /FRAME_WARNING_FAKE|AX_FRAME_WARNING_FAKE/);

  const broken = { command: async method => {
    if (method === 'DOMSnapshot.captureSnapshot') throw new Error('main snapshot failed');
    return {};
  } };
  await assert.rejects(collectPage(broken, 9, { executeScript: async () => [] }), /main snapshot failed/);
});
