import assert from 'node:assert/strict';
import test from 'node:test';

const modelModule = await import('../../src/reader/report-model.js').catch(() => ({}));
const controllerModule = await import('../../src/reader/controller.js').catch(() => ({}));
const row = (fields = {}) => ({ id: 'element-1', selector: 'button:nth-of-type(1)', tag: 'button', role: 'button', name: 'Enviar', description: '', states: [], preview: 'Enviar, botão', tabIndex: 0, tabOrder: 1, category: 'tab', reasons: [], bounds: { x: 10, y: 20, width: 80, height: 24 }, ...fields });
const inventory = (entries = [row()]) => ({ version: 1, sessionId: 'test-session', entries, limitations: [], counts: { total: entries.length, tab: 1, outsideTab: 0, reading: 0, hidden: 0, scanned: 3, truncated: false } });

test('report preserves every category and Tab order, redacts secrets and excludes arbitrary fields', () => {
  assert.equal(typeof modelModule.createReadingReport, 'function');
  const report = modelModule.createReadingReport(inventory([
    row({ name: 'Token: segredo123', preview: 'Token: segredo123' }),
    row({ id: 'element-2', category: 'outside-tab', tabOrder: null, tabIndex: -1, reasons: ['tabindex negativo'] }),
    row({ id: 'element-3', category: 'reading', tabOrder: null, tabIndex: null, role: 'heading' }),
  ]), { origin: 'https://example.com', generatedAt: '2026-09-19T12:00:00.000Z' });
  assert.equal(report.entries.length, 3);
  assert.equal(report.counts.outsideTab, 1);
  assert.equal(report.counts.reading, 1);
  assert.doesNotMatch(JSON.stringify(report), /segredo123/u);
  assert.throws(() => modelModule.createReadingReport(inventory([row({ value: 'secret' })])));
  assert.throws(() => modelModule.createReadingReport(inventory([row(), row()])));
  assert.throws(() => modelModule.createReadingReport(inventory([row({ tabOrder: 2 })])));
});

test('HTML export escapes site markup, includes all records and works without executable content', () => {
  assert.equal(typeof modelModule.renderReadingHtml, 'function');
  const report = modelModule.createReadingReport(inventory([row({ name: '<img src=x onerror=alert(1)>', preview: '<script>alert(1)</script>' })]), { origin: 'https://example.com', generatedAt: '2026-09-19T12:00:00.000Z' });
  const html = modelModule.renderReadingHtml(report);
  assert.match(html, /&lt;script&gt;/u);
  assert.doesNotMatch(html, /<script/iu);
  assert.doesNotMatch(html, /<img[^>]+onerror/iu);
  assert.match(html, /Content-Security-Policy/u);
  assert.match(html, /img-src data:/u);
  assert.match(html, /Imagem do elemento/u);
  assert.match(html, /estimativa/iu);
  assert.match(html, /Conteúdo estrutural/u);
  assert.match(html, /Fora da sequência de Tab/u);
});

test('CSV uses quoted cells and neutralizes spreadsheet formula injection', () => {
  assert.equal(typeof modelModule.renderReadingCsv, 'function');
  const report = modelModule.createReadingReport(inventory([row({ name: '=HYPERLINK("bad")', preview: '+cmd', selector: '@selector' })]));
  const csv = modelModule.renderReadingCsv(report);
  assert.match(csv, /"'=HYPERLINK\(""bad""\)"/u);
  assert.match(csv, /"'\+cmd"/u);
  assert.match(csv, /"'@selector"/u);
});

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('attaches element screenshots before the code column and a numbered full-page map at the end', () => {
  const inventoryRaw = inventory([
    row({ id: 'first', tabOrder: 1, preview: 'Ir para o conteúdo' }),
    row({ id: 'heading', tabOrder: null, tabIndex: null, category: 'reading', role: 'heading', preview: 'Título principal', bounds: { x: 0, y: 40, width: 200, height: 30 } }),
  ]);
  const base = modelModule.createReadingReport(inventoryRaw, { origin: 'https://example.com', generatedAt: '2026-09-19T12:00:00.000Z' });
  const report = modelModule.attachReadingVisuals(base, {
    elementImages: { first: TINY_PNG },
    fullPage: TINY_PNG,
    limitations: ['visual-capture-unavailable'],
  });
  assert.equal(report.entries[0].image, TINY_PNG);
  assert.equal(report.entries[1].image, null);
  assert.equal(report.pageMap, TINY_PNG);
  assert.ok(report.limitations.includes('A captura de tela não ficou disponível nesta inspeção.') || report.limitations.some(value => /captura/iu.test(value)));
  const html = modelModule.renderReadingHtml(report);
  assert.match(html, /Imagem do elemento/u);
  assert.match(html, /map-base/u);
  assert.match(html, /map-label-num/u);
  assert.match(html, /1\./u);
  assert.match(html, /Ir para o conteúdo/u);
  assert.match(html, /L\d+|T[uí]tulo principal/u);
  assert.ok(html.indexOf('Imagem do elemento') < html.indexOf('Ordem / elemento'));
  assert.ok(html.indexOf('Mapa de leitura') > html.indexOf('Conferir'));
});

test('rejects non-PNG visual payloads and keeps a text-only report when capture is absent', () => {
  const base = modelModule.createReadingReport(inventory([row()]), { origin: 'https://example.com', generatedAt: '2026-09-19T12:00:00.000Z' });
  assert.throws(() => modelModule.attachReadingVisuals(base, { elementImages: { 'element-1': 'data:text/html,oi' }, fullPage: null }));
  const plain = modelModule.attachReadingVisuals(base, { elementImages: {}, fullPage: null });
  const html = modelModule.renderReadingHtml(plain);
  assert.match(html, /Captura não disponível/u);
  assert.doesNotMatch(html, /class="map-base"/u);
  assert.doesNotMatch(html, /Mapa de leitura/u);
});

test('interleaved structural content cannot disturb Tab order or disclose session tokens in exports', () => {
  const report = modelModule.createReadingReport(inventory([
    row({ id: 'second', tabOrder: 2 }),
    row({ id: 'heading', category: 'reading', tabOrder: null, tabIndex: null }),
    row({ id: 'first', tabOrder: 1 }),
  ]));
  assert.deepEqual(report.entries.filter(entry => entry.category === 'tab').map(entry => entry.id), ['first', 'second']);
  assert.doesNotMatch(JSON.stringify(report), /test-session|sessionId/u);
});

function fakeChrome() {
  const records = {};
  const calls = [];
  let tab = { id: 7, windowId: 2, url: 'https://example.com/private?secret=hidden', status: 'complete' };
  return { calls, records, setTab(value) { tab = value; },
    runtime: { getURL: path => `chrome-extension://${'a'.repeat(32)}/${path}` },
    tabs: { query: async () => [tab], get: async () => tab, create: async value => { calls.push(['create', value]); return { id: 9 }; }, update: async (id, value) => { calls.push(['update', id, value]); } },
    windows: { update: async () => {} },
    storage: { session: { set: async value => Object.assign(records, value), get: async key => key === null ? { ...records } : Object.fromEntries((Array.isArray(key) ? key : [key]).map(item => [item, records[item]])), remove: async key => { delete records[key]; } } },
    scripting: { executeScript: async value => { calls.push(['script', value]); return [{ frameId: 0, documentId: 'document-one', result: value.files ? undefined : inventory() }]; } },
  };
}

test('launch is a one-time short-lived local capability and never retains a page URL', async () => {
  assert.equal(typeof controllerModule.openReadingReport, 'function');
  const api = fakeChrome();
  await controllerModule.openReadingReport(api, { token: 'a'.repeat(43), now: 1000 });
  assert.doesNotMatch(JSON.stringify(api.records), /private|secret|example/u);
  const href = api.calls.find(([type]) => type === 'create')[1].url;
  const source = await controllerModule.consumeReadingLaunch(api, href, 1500);
  assert.equal(source.tabId, 7);
  assert.equal(source.documentId, 'document-one', 'freeze the selected document at the launch gesture');
  await assert.rejects(controllerModule.consumeReadingLaunch(api, href, 1600));
  api.setTab({ id: 7, url: 'chrome://extensions' });
  await assert.rejects(controllerModule.openReadingReport(api));
});

test('concurrent launch consumers cannot both claim the same one-time capability', async () => {
  const api = fakeChrome();
  await controllerModule.openReadingReport(api, { token: 'c'.repeat(43), now: 1000 });
  const href = api.calls.find(([type]) => type === 'create')[1].url;
  let tail = Promise.resolve(); const names = [];
  const lockManager = {
    request(name, options, callback) {
      names.push(name); assert.deepEqual(options, { mode: 'exclusive' });
      const pending = tail.then(() => callback({ name }));
      tail = pending.catch(() => {});
      return pending;
    },
  };
  const results = await Promise.allSettled([
    controllerModule.consumeReadingLaunch(api, href, 1500, { lockManager }),
    controllerModule.consumeReadingLaunch(api, href, 1500, { lockManager }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(names.length, 2); assert.equal(names[0], names[1]);
  assert.equal(Object.keys(api.records).length, 0);
});

test('launch consumption fails closed without a Web Lock and leaves its capability unclaimed', async () => {
  const api = fakeChrome();
  await controllerModule.openReadingReport(api, { token: 'd'.repeat(43), now: 1000 });
  const href = api.calls.find(([type]) => type === 'create')[1].url;
  for (const lockManager of [null, {}, { request: async (_name, _options, callback) => callback(null) }]) {
    await assert.rejects(controllerModule.consumeReadingLaunch(api, href, 1500, { lockManager }));
    assert.equal(Object.keys(api.records).length, 1);
  }
});

test('the first collection cannot bind a different document after the launch click', async () => {
  const api = fakeChrome();
  await controllerModule.openReadingReport(api, { token: 'a'.repeat(43), now: 1000 });
  const href = api.calls.find(([type]) => type === 'create')[1].url;
  const source = await controllerModule.consumeReadingLaunch(api, href, 1500);
  api.setTab({ id: 7, url: 'https://different.example', status: 'complete' });
  const calls = [];
  api.scripting.executeScript = async options => {
    calls.push(options);
    if (options.target.documentIds?.[0] === 'document-one') throw new Error('No document with that id');
    return [{ frameId: 0, documentId: 'document-two', result: inventory() }];
  };
  const controller = controllerModule.createReadingController(api, source, { lockManager: { request: async (_name, _options, callback) => callback({}) } });
  await assert.rejects(controller.collect());
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].target.documentIds, ['document-one']);
});

test('a busy target lock or paused audit prevents all reading injection', async () => {
  for (const kind of ['lock', 'paused']) {
    const api = fakeChrome();
    if (kind === 'paused') api.records['audita:active-audit-job:v1'] = { state: 'privacy-paused' };
    const controller = controllerModule.createReadingController(api, { tabId: 7, documentId: 'document-one', sessionId: 'test-session' },
      { lockManager: { request: async (_name, _options, callback) => callback(kind === 'lock' ? null : {}) } });
    await assert.rejects(controller.collect());
    assert.equal(api.calls.length, 0);
  }
});

test('audit revocation prevents the old report from recreating its overlay', async () => {
  const api = fakeChrome();
  const controller = controllerModule.createReadingController(api, { tabId: 7, documentId: 'document-one', sessionId: 'test-session' },
    { lockManager: { request: async (_name, _options, callback) => callback({}) } });
  await controller.collect();
  delete api.records['audita.reading-active.7'];
  const previous = api.calls.length;
  await assert.rejects(controller.observe());
  assert.equal(api.calls.length, previous);
});

test('collection binds scripts to the document and refuses navigation before a live action', async () => {
  assert.equal(typeof controllerModule.createReadingController, 'function');
  const api = fakeChrome();
  const controller = controllerModule.createReadingController(api, { tabId: 7, documentId: 'document-one', sessionId: 'test-session' }, { lockManager: { request: async (_name, _options, callback) => callback({}) } });
  const report = await controller.collect();
  assert.equal(report.origin, 'https://example.com');
  assert.doesNotMatch(JSON.stringify(report), /secret=|private\?/u);
  const collection = api.calls.filter(([type]) => type === 'script').at(-1)[1];
  assert.deepEqual(collection.target.documentIds, ['document-one']);
  api.setTab({ id: 7, url: 'https://different.example', status: 'complete' });
  await assert.rejects(controller.highlight('element-1'));
  assert.equal(api.calls.filter(([type]) => type === 'update').length, 0);
});
