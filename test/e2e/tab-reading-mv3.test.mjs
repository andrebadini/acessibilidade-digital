import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  evaluate, launchUnpackedExtension, pressKey, resolveRealChromeTestBinary, startFixtureServer, waitForValue,
} from './support/real-chrome.mjs';

const documentSource = await readFile(new URL('../../fixtures/pages/tab-reading.html', import.meta.url), 'utf8');
// The private values live in the fixture only. This sweep proves their presence before testing omission.
const privateValues = [...new Set(documentSource.match(/TAB_PRIVATE_[A-Z_]+_7319|tab-private-[^\s"'<>]+/gu))];
const overlayText = `document.querySelector('[data-audita-tab-reading]')?.shadowRoot?.textContent ?? ''`;

async function pageCommand(extension, command) {
  return evaluate(extension.harnessPage, `(async () => {
    const { tabReadingPageCommand } = await import(chrome.runtime.getURL('/src/reader/page-inspector.js'));
    const results = await chrome.scripting.executeScript({
      target: { tabId: ${extension.startPage.tabId}, frameIds: [0] },
      func: tabReadingPageCommand,
      args: [${JSON.stringify(command)}],
    });
    return results[0].result;
  })()`, { awaitPromise: true });
}

function assertPrivateValuesAbsent(text, surface) {
  for (const value of privateValues) assert.equal(text.includes(value), false, `editable value leaked to ${surface}`);
}

async function createExtension(t) {
  assert.ok(privateValues.length >= 8, 'the fixture must carry real, distinct private form values');
  const fixture = await startFixtureServer(t, new Map([
    ['/tab-reading', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: documentSource }],
  ]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
    startUrl: `${fixture.origin}/tab-reading`, viewport: { width: 1280, height: 800 }, downloadMode: 'profile',
  });
  await waitForValue(extension.startPage.page, `Boolean(document.querySelector('#shadow-host')?.shadowRoot)`, Boolean);
  return extension;
}

test('Tab reading uses real browser semantics, protects editable values and observes focus without activating controls', { timeout: 90_000 }, async t => {
  const extension = await createExtension(t);
  const page = extension.startPage.page;
  const initial = await evaluate(page, `({ url: location.href, x: scrollX, y: scrollY, focus: document.activeElement.tagName })`);
  await evaluate(extension.harnessPage, `chrome.scripting.executeScript({
    target: { tabId: ${extension.startPage.tabId}, frameIds: [0] },
    files: ['src/core/accessibility/accessible-preview-runtime.classic.js'],
  }).then(() => true)`, { awaitPromise: true });
  const inventory = await pageCommand(extension, { type: 'collect', sessionId: 'real-browser-reading' });
  assert.equal(inventory.version, 1);
  assert.equal(inventory.counts.truncated, false);
  assert.deepEqual(await evaluate(page, `({ url: location.href, x: scrollX, y: scrollY, focus: document.activeElement.tagName })`), initial,
    'collecting must preserve focus, scroll and navigation');
  assertPrivateValuesAbsent(JSON.stringify(inventory), 'collector inventory');
  const named = name => {
    const entry = inventory.entries.find(row => row.name === name);
    assert.ok(entry, `expected an entry named ${name}`);
    return entry;
  };
  assert.equal(named('Primeiro na ordem positiva').tabOrder, 1);
  assert.equal(named('Segundo na ordem positiva').tabOrder, 2);
  assert.equal(named('Ordem natural').tabOrder, 3);
  assert.equal(named('Página inicial').role, 'link');
  assert.equal(named('Pesquisar documentos').role, 'button');
  assert.equal(named('Abrir opções').category, 'tab');
  assert.equal(named('Nome visível').role, 'button', 'hidden descendants are not part of the accessible name');
  assert.equal(named('E-mail de contato').description, 'Use o endereço de contato.');
  assert.equal(named('Nome da pessoa').category, 'tab');
  assert.ok(named('Receber novidades').states.includes('marcado'));
  assert.equal(named('Por telefone').category, 'tab');
  assert.equal(named('Por e-mail').category, 'outside-tab');
  assert.ok(named('Por e-mail').reasons.includes('radio-group-arrow-navigation'));
  for (const name of ['Região', 'Observações', 'Anotações editáveis', 'Código somente leitura']) {
    assert.equal(named(name).category, 'tab', name);
  }
  for (const name of ['Link fora do Tab', 'Ação sem acesso por Tab', 'Controle desabilitado',
    'Campo desabilitado pelo grupo', 'Ação desabilitada pelo grupo', 'Ação na segunda legenda']) {
    assert.equal(named(name).category, 'outside-tab', name);
  }
  assert.equal(named('Ajuda do grupo').category, 'tab', 'the first legend is exempt from disabled fieldset semantics');
  assert.equal(named('Ação ARIA indisponível').category, 'tab', 'aria-disabled does not remove the tab stop');
  assert.ok(inventory.entries.some(row => row.category === 'tab' && row.reasons.includes('aria-hidden')),
    'aria-hidden can still receive focus and must be disclosed');
  assert.equal(named('Conferência da leitura por Tab').category, 'reading');
  assert.equal(named('Mapa das regiões de Mato Grosso').category, 'reading');
  assert.equal(named('Detalhes fechados').category, 'tab');
  assert.equal(named('Ação em detalhes abertos').category, 'tab');
  assert.ok(!inventory.entries.some(row => row.name === 'Ação em detalhes fechados' && row.category === 'tab'));
  assert.equal(named('Ação no Shadow DOM aberto').category, 'tab');
  assert.equal(named('Ação distribuída no slot').category, 'tab');
  assert.equal(inventory.entries.filter(row => row.name === 'Ação distribuída no slot').length, 1,
    'a slotted element is one focus stop, not two');
  assert.ok(!inventory.entries.some(row => row.name === 'Ação dentro do quadro'), 'nested document contents are outside this scope');
  assert.ok(inventory.limitations.some(value => /frame/iu.test(value)), 'the iframe boundary must be explicit');
  assert.ok(inventory.limitations.includes('estimated-order-not-literal-screen-reader'));

  assert.equal((await pageCommand(extension, { type: 'observe', sessionId: 'real-browser-reading' })).ok, true);
  await page.command('Page.bringToFront');
  const expectedPrefix = ['tab-positive-one', 'tab-positive-two', 'tab-zero', 'image-link', 'image-button', 'labelled-button'];
  const focused = [];
  for (const id of expectedPrefix) {
    await pressKey(page, { key: 'Tab', code: 'Tab', virtualKeyCode: 9, modifiers: 0, raw: true });
    focused.push(await evaluate(page, 'document.activeElement.id'));
  }
  assert.deepEqual(focused, expectedPrefix, 'estimated positive and natural order must match actual Tab focus');
  await waitForValue(page, overlayText, value => value.includes('Abrir opções'));
  const expectedRemainder = ['nameless-button', 'custom-disabled', 'hidden-from-at', 'email', 'password', 'person-name', 'newsletter',
    'contact-phone', 'region', 'notes', 'editable', 'readonly', 'first-legend-button', 'closed-summary',
    'open-summary', 'open-details-button', 'shadow-button', 'slotted-button', 'example-frame', 'last-button', 'hidden-descendant-button'];
  const remainder = [];
  for (const id of expectedRemainder) {
    await pressKey(page, { key: 'Tab', code: 'Tab', virtualKeyCode: 9, modifiers: 0, raw: true });
    remainder.push(await evaluate(page, `(() => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      return active?.id ?? '';
    })()`));
    if (id === 'shadow-button') await waitForValue(page, overlayText, value => value.includes('Ação no Shadow DOM aberto'));
  }
  assert.deepEqual(remainder, expectedRemainder,
    'real Tab must skip negative/native disabled/inert controls, keep ARIA states, and enter the composed tree');
  await evaluate(page, `(() => { document.querySelector('#image-button').focus(); return true; })()`);
  await waitForValue(page, overlayText, value => value.includes('Pesquisar documentos'),
    { timeoutMs: 3000 });
  const focusBeforeHighlight = await evaluate(page, 'document.activeElement.id');
  assert.equal((await pageCommand(extension, {
    type: 'highlight', sessionId: 'real-browser-reading', elementId: named('Ordem natural').id,
  })).ok, true);
  assert.equal(await evaluate(page, 'document.activeElement.id'), focusBeforeHighlight, 'highlight must not focus or activate the target');
  assert.equal(await evaluate(page, 'location.href'), initial.url, 'no link or control was activated');
  assertPrivateValuesAbsent(await evaluate(page, overlayText), 'visual focus annotation');
  await pressKey(page, { key: 'Escape', code: 'Escape', virtualKeyCode: 27, modifiers: 0, raw: true });
  assert.equal(await evaluate(page, `document.querySelector('[data-audita-tab-reading]') === null`), true);

  await pageCommand(extension, { type: 'collect', sessionId: 'stale-reading' });
  const replacementInventory = await pageCommand(extension, { type: 'collect', sessionId: 'replacement-reading' });
  assert.equal((await pageCommand(extension, { type: 'observe', sessionId: 'stale-reading' })).ok, false);
  const replacementEntry = replacementInventory.entries.find(row => row.name === 'Ordem natural');
  await evaluate(page, `(() => { const old = document.querySelector('#tab-zero'); old.replaceWith(old.cloneNode(true)); return true; })()`);
  const rejected = await pageCommand(extension, { type: 'highlight', sessionId: 'replacement-reading', elementId: replacementEntry.id });
  assert.equal(rejected.ok, false, 'a replacement DOM node must not inherit a previously captured target');
  await pageCommand(extension, { type: 'clear', sessionId: 'replacement-reading' });
});

async function waitForReaderPage(extension) {
  const deadline = Date.now() + 15_000;
  do {
    const { targetInfos = [] } = await extension.browser.command('Target.getTargets');
    const targets = targetInfos.filter(target => {
      try {
        const url = new URL(target.url);
        return url.protocol === 'chrome-extension:' && url.hostname === extension.extensionId &&
          url.pathname === '/src/reader/index.html' && target.type === 'page';
      } catch { return false; }
    });
    assert.ok(targets.length < 2, 'the launcher must open exactly one reader report');
    if (targets.length === 1) return extension.attachPage(targets[0].targetId);
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail('the panel did not open the reader report');
}

async function readDownloadedReports(extension) {
  const deadline = Date.now() + 30_000;
  do {
    const names = await readdir(extension.downloadDirectory);
    const delivered = names.filter(name => /^audita-leitura-tab-.*\.(?:html|csv|json)$/u.test(name));
    if (delivered.length === 3 && !names.some(name => name.endsWith('.crdownload'))) {
      const records = await Promise.all(delivered.map(async name => ({
        format: name.split('.').at(-1), bytes: await readFile(join(extension.downloadDirectory, name)),
      })));
      if (records.every(record => record.bytes.length > 0)) return Object.fromEntries(records.map(record => [record.format, record.bytes.toString('utf8')]));
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail('HTML, CSV and JSON report files must reach the real download directory');
}

async function captureTabQa(t, target, name, prepare) {
  const directory = process.env.AUDITA_TAB_QA_DIR;
  if (!directory) return;
  assert.ok(isAbsolute(directory), 'AUDITA_TAB_QA_DIR must be an absolute output directory');
  await mkdir(directory, { recursive: true });
  // Set the actual CSS rendering viewport, never resize or alter the PNG afterwards.
  await target.command('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  await target.command('Page.bringToFront');
  if (prepare) await evaluate(target, prepare);
  await evaluate(target, 'document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))', { awaitPromise: true });
  assert.deepEqual(await evaluate(target, '({ width: innerWidth, height: innerHeight, scale: devicePixelRatio })'),
    { width: 1280, height: 800, scale: 1 });
  const capture = await target.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const bytes = Buffer.from(capture.data, 'base64');
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(bytes.readUInt32BE(16), 1280, `${name}: PNG width`);
  assert.equal(bytes.readUInt32BE(20), 800, `${name}: PNG height`);
  assert.equal(bytes[25], 2, `${name}: truecolor PNG without an alpha channel`);
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    assert.notEqual(type, 'tRNS', `${name}: PNG must not contain transparency`);
    offset += length + 12;
  }
  await writeFile(join(directory, name), bytes);
  t.diagnostic(`${name}: native rendering 1280×800, RGB PNG, no alpha or pixel editing`);
}

async function readingRuntimeState(extension) {
  return evaluate(extension.harnessPage, `(async () => {
    const results = await chrome.scripting.executeScript({
      target: { tabId: ${extension.startPage.tabId}, frameIds: [0] }, world: 'ISOLATED',
      func: () => ({ namespace: Boolean(globalThis[Symbol.for('audita.tab-reading.inspector.v1')]),
        overlay: Boolean(document.querySelector('[data-audita-tab-reading]')) }),
    });
    const active = await chrome.storage.session.get('audita.reading-active.${extension.startPage.tabId}');
    return { ...results[0].result, documentId: results[0].documentId,
      active: Boolean(active['audita.reading-active.${extension.startPage.tabId}']) };
  })()`, { awaitPromise: true });
}

test('panel launches and exports the visual reading report; a subsequent audit revokes its live annotations', { timeout: 180_000 }, async t => {
  const extension = await createExtension(t);
  const page = extension.startPage.page;
  const panel = await extension.openSidePanelFromAction();
  await waitForValue(panel, `Boolean(document.querySelector('button[data-intent="OPEN_TAB_READING"]:not(:disabled)'))`, Boolean,
    { timeoutMs: 15_000 });
  await extension.click(panel, 'button[data-intent="OPEN_TAB_READING"]');
  const reader = await waitForReaderPage(extension);
  await waitForValue(reader, `document.querySelector('#status')?.textContent ?? ''`, value => value.includes('Inspeção concluída'),
    { timeoutMs: 20_000 });
  await captureTabQa(t, reader, 'screenshot-tab-report.png', '(() => { scrollTo(0, 0); return true; })()');
  assert.equal(await evaluate(reader, 'location.search'), '', 'the one-time launch capability is removed from the URL');
  const pageText = await evaluate(reader, 'document.body.innerText');
  assert.match(pageText, /estimativa/iu);
  assert.match(pageText, /Conteúdo estrutural/u);
  assert.match(pageText, /Fora da sequência de Tab/u);
  assertPrivateValuesAbsent(pageText, 'reader page');
  const totalRows = await evaluate(reader, `document.querySelectorAll('[data-entry-id]').length`);
  assert.ok(totalRows > 20, 'the report must contain a substantive inventory of the fixture');
  const firstRows = await evaluate(reader, `Array.from(document.querySelectorAll('[data-category="tab"] [data-entry-id]')).slice(0, 3).map(row => row.innerText)`);
  assert.match(firstRows[0], /Primeiro na ordem positiva/u);
  assert.match(firstRows[1], /Segundo na ordem positiva/u);
  assert.match(firstRows[2], /Ordem natural/u);
  await captureTabQa(t, reader, 'screenshot-tab-elements.png', `(() => {
    document.querySelector('[data-category="tab"]').scrollIntoView({ block: 'start' }); scrollBy(0, -16); return true;
  })()`);

  await evaluate(reader, `(() => { const select = document.querySelector('#category'); select.value = 'outside-tab'; select.dispatchEvent(new Event('change')); return true; })()`);
  assert.deepEqual(await evaluate(reader, `Array.from(document.querySelectorAll('[data-category]')).filter(section => !section.hidden).map(section => section.dataset.category)`), ['outside-tab']);
  assert.match(await evaluate(reader, `document.querySelector('[data-category="outside-tab"]').innerText`), /Ação sem acesso por Tab/u);

  await extension.click(reader, '#observe');
  await waitForValue(reader, `document.querySelector('#status')?.textContent ?? ''`, value => value.includes('Acompanhamento ativado'));
  await page.command('Page.bringToFront');
  await pressKey(page, { key: 'Tab', code: 'Tab', virtualKeyCode: 9, modifiers: 0, raw: true });
  await waitForValue(page, overlayText, value => value.includes('Primeiro na ordem positiva'));
  await captureTabQa(t, page, 'screenshot-tab-highlight.png', `(() => {
    const input = document.querySelector('#email'); input.focus(); input.scrollIntoView({ block: 'center' }); return true;
  })()`);
  await extension.click(reader, '#clear');
  await waitForValue(page, `document.querySelector('[data-audita-tab-reading]') === null`, Boolean);
  await waitForValue(reader, `document.querySelector('#status')?.textContent ?? ''`, value => value.includes('Destaques encerrados'));
  assert.equal(await evaluate(reader, `document.querySelectorAll('[data-entry-id]').length`), totalRows,
    'ending live markers must preserve the report');

  for (const format of ['html', 'csv', 'json']) await extension.click(reader, `#export-${format}`);
  const files = await readDownloadedReports(extension);
  assert.deepEqual(Object.keys(files).sort(), ['csv', 'html', 'json']);
  for (const [format, content] of Object.entries(files)) assertPrivateValuesAbsent(content, `downloaded ${format}`);
  const exported = JSON.parse(files.json);
  assert.equal(exported.entries.length, totalRows, 'export must include all rows even while the UI is filtered');
  assert.deepEqual([...new Set(exported.entries.map(entry => entry.category))].sort(), ['hidden', 'outside-tab', 'reading', 'tab']);
  assert.equal(Object.hasOwn(exported, 'sessionId'), false, 'session capability is not report content');
  assert.match(files.html, /Content-Security-Policy/u);
  assert.doesNotMatch(files.html, /<script\b/iu);
  assert.match(files.html, /Mapa das regiões de Mato Grosso/u);
  assert.match(files.csv, /Ação sem acesso por Tab/u);
  assert.match(files.csv, /Nome visível/u);
  assert.match(files.html, /Conteúdo estrutural/u);
  const session = await evaluate(extension.harnessPage, 'chrome.storage.session.get(null)', { awaitPromise: true });
  assert.equal(Object.keys(session).some(key => key.startsWith('audita.reading-launch.')), false,
    'the launch capability must be consumed once');
  const local = await evaluate(extension.harnessPage, 'chrome.storage.local.get(null)', { awaitPromise: true });
  assertPrivateValuesAbsent(JSON.stringify(local), 'durable extension storage');
  assert.equal(await evaluate(page, 'location.pathname'), '/tab-reading', 'the source page was preserved throughout the journey');

  // The live overlay must not contaminate a later audit of this same document.
  await extension.click(reader, '#observe');
  await waitForValue(reader, `document.querySelector('#status')?.textContent ?? ''`, value => value.includes('Acompanhamento ativado'));
  const beforeAudit = await readingRuntimeState(extension);
  assert.equal(beforeAudit.namespace && beforeAudit.overlay && beforeAudit.active, true,
    'revocation coverage requires a real registered inspector and visible overlay');
  const sourceIdentity = await extension.identityOf(extension.startPage);
  const sourceUrl = await evaluate(page, 'location.href');
  const auditPanel = await extension.waitForSidePanel();
  await auditPanel.command('Page.bringToFront');
  await waitForValue(auditPanel, `(() => {
    const input = document.querySelector('input[data-capture-mode="no-pixels"]');
    const button = document.querySelector('button[data-intent="START_ATTACHED"]');
    return Boolean(input && !input.disabled && button && !button.disabled);
  })()`, Boolean, { timeoutMs: 30_000 });
  await extension.click(auditPanel, 'input[data-capture-mode="no-pixels"]');
  await extension.click(auditPanel, 'button[data-intent="START_ATTACHED"]');
  const auditView = await waitForValue(auditPanel, `(() => ({
    screen: document.querySelector('[data-screen]')?.dataset.screen ?? null,
    auditId: document.querySelector('[data-screen="result"]')?.dataset.auditId ?? null,
    text: document.body.innerText.slice(0, 2400),
  }))()`, value => ['result', 'unavailable'].includes(value?.screen), { timeoutMs: 90_000, intervalMs: 100 });
  if (auditView.screen !== 'result') {
    const { namespace, overlay, active } = await readingRuntimeState(extension);
    t.diagnostic(JSON.stringify({ readingAfterFailedStart: { namespace, overlay, active } }));
  }
  assert.equal(auditView.screen, 'result', `audit must complete: ${JSON.stringify(auditView)}`);
  const auditId = auditView.auditId;
  const afterAudit = await readingRuntimeState(extension);
  assert.deepEqual(afterAudit, { namespace: false, overlay: false, documentId: beforeAudit.documentId, active: false },
    'starting the audit must dispose the inspector and revoke its registered capability');
  assert.deepEqual(await extension.identityOf(extension.startPage), sourceIdentity, 'the original document was audited without navigation');
  const audit = await evaluate(extension.harnessPage, `import(chrome.runtime.getURL('/src/storage/audit-store.js')).then(async module => {
    const snapshot = await module.createAuditStore().getAuditSnapshot(${JSON.stringify(auditId)});
    const model = snapshot.model ?? snapshot.snapshot ?? snapshot;
    return { status: model.session?.status, pages: model.pages.map(item => item.finalUrl),
      rasterCount: model.evidence.filter(item => Boolean(item.dataUrl)).length,
      rules: model.ruleResults.length };
  })`, { awaitPromise: true });
  assert.ok(['complete', 'partial'].includes(audit.status), 'the audit must finish with a document result');
  assert.deepEqual(audit.pages, [sourceUrl]);
  assert.ok(audit.rules > 0, 'the document must actually have been evaluated');
  assert.equal(audit.rasterCount, 0, 'the no-images audit must not enable pixel capture');
  await extension.click(reader, '#observe');
  await waitForValue(reader, `document.querySelector('#status')?.classList.contains('error') ?? false`, Boolean);
  assert.deepEqual(await readingRuntimeState(extension), afterAudit,
    'the old report cannot resurrect an inspector revoked by the audit');
});
