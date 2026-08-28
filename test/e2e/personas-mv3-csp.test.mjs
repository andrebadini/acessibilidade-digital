import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtures = join(root, 'test', 'e2e', 'fixtures');
const chromeBinary = process.env.CHROME_BIN;
const qaDirectory = process.env.AUDITA_PERSONA_QA_DIR || '';
const sentinel = 'SEGREDO-PERSONA-E2E-918273';
const debug = message => { if (process.env.AUDITA_E2E_DEBUG === '1') process.stderr.write(`[personas-e2e] ${message}\n`); };

test('runs reversible personas in the explicit target under real MV3 and strict page CSP', { timeout: 60_000 }, async t => {
  assert.ok(chromeBinary, 'CHROME_BIN é obrigatório para o E2E real de personas.');
  const requests = [];
  const crossServer = createServer(async (request, response) => {
    requests.push(`cross:${request.url}`);
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'",
    });
    response.end(await readFile(join(fixtures, 'personas-frame.html')));
  });
  await listen(crossServer);
  debug('cross server ready');
  t.after(() => closeServer(crossServer));
  const crossUrl = `http://127.0.0.1:${crossServer.address().port}/personas-frame.html`;
  const strictCsp = `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self' ${new URL(crossUrl).origin}; base-uri 'none'; form-action 'none'; connect-src 'none'`;
  const fixtureTemplate = await readFile(join(fixtures, 'personas-csp.html'), 'utf8');
  const fixtureHtml = fixtureTemplate.replace('__CROSS_FRAME_URL__', crossUrl);
  const fixtureScript = await readFile(join(fixtures, 'personas-csp.js'));
  const frameHtml = await readFile(join(fixtures, 'personas-frame.html'));
  const mainServer = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://fixture.invalid').pathname;
    requests.push(`main:${pathname}`);
    const headers = { 'content-security-policy': strictCsp };
    if (pathname === '/personas-csp.js') {
      response.writeHead(200, { ...headers, 'content-type': 'text/javascript; charset=utf-8' });
      response.end(fixtureScript);
      return;
    }
    if (pathname === '/personas-frame.html') {
      response.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
      response.end(frameHtml);
      return;
    }
    if (pathname === '/decoy.html') {
      response.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html lang="pt-BR"><head><title>Decoy personas</title></head><body><button>Decoy</button></body></html>');
      return;
    }
    if (pathname === '/favicon.ico') {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    response.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
    response.end(fixtureHtml);
  });
  await listen(mainServer);
  debug('main server ready');
  t.after(() => closeServer(mainServer));
  const fixtureUrl = `http://127.0.0.1:${mainServer.address().port}/personas-csp.html`;
  const decoyUrl = `http://127.0.0.1:${mainServer.address().port}/decoy.html`;
  const fixtureResponse = await fetch(fixtureUrl);
  assert.equal(fixtureResponse.headers.get('content-security-policy'), strictCsp);
  await fixtureResponse.arrayBuffer();
  debug('fixture CSP verified');

  for (const relativePath of [
    'src/core/accessibility/accessible-preview-runtime.classic.js',
    'src/personas/screen-reader-module.js',
    'src/personas/content.js',
  ]) {
    const source = await readFile(join(root, relativePath), 'utf8');
    assert.doesNotMatch(source, /^\s*(?:import|export)\s/mu, `${relativePath} precisa permanecer script clássico`);
    assert.doesNotMatch(source, /\beval\s*\(|\bnew\s+Function\b/u, `${relativePath} não pode exigir CSP relaxada`);
  }
  debug('classic sources verified');

  const profile = await mkdtemp(join(tmpdir(), 'audita-personas-chrome-'));
  debug(`profile created at ${profile}`);
  const chrome = spawn(chromeBinary, [
    '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--remote-debugging-pipe',
    '--window-position=-10000,-10000', '--window-size=1280,800',
    `--user-data-dir=${profile}`,
    fixtureUrl,
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  debug('Chrome spawned with debugging pipe');
  let chromeStderr = '';
  chrome.stderr.on('data', chunk => { chromeStderr = `${chromeStderr}${chunk}`.slice(-12_000); });
  chrome.on('exit', (code, signal) => debug(`Chrome exited code=${code} signal=${signal}; stderr=${chromeStderr}`));
  t.after(async () => {
    if (chrome.exitCode === null) {
      const exited = new Promise(resolveExit => chrome.once('exit', resolveExit));
      chrome.kill('SIGKILL');
      await exited;
    }
    await rm(profile, { recursive: true, force: true });
  });
  const browser = new PipeCdp(chrome.stdio[3], chrome.stdio[4]);
  t.after(() => browser.close());
  const browserVersion = await browser.command('Browser.getVersion');
  debug(`CDP connected to ${browserVersion.product}`);
  await browser.command('Target.setDiscoverTargets', { discover: true });
  const fixtureTab = await waitForTargetInfo(browser, info => info.type === 'tab' && info.url === fixtureUrl, chromeStderr, true);
  const fixturePage = await waitForTargetInfo(browser, info => info.type === 'page' && info.url === fixtureUrl && info.title === 'Fixture personas MV3 CSP', chromeStderr);
  debug('sole fixture startup tab committed before extension load');
  let loaded;
  try { loaded = await browser.command('Extensions.loadUnpacked', { path: root }, 15_000); }
  catch (error) {
    await delay(50);
    throw new Error(`PERSONA_E2E_EXTENSIONS_LOAD_FAILED: ${error.message}; exit=${chrome.exitCode}; signal=${chrome.signalCode}; stderr=${chromeStderr}`);
  }
  const id = loaded?.id;
  assert.match(id || '', /^[a-p]{32}$/u, JSON.stringify(loaded));
  const installed = await browser.command('Extensions.getExtensions');
  assert.ok(installed.extensions?.some(extension => extension.id === id && extension.name === 'Audita Acessibilidade'));
  debug(`extension loaded as ${id}`);
  const panelUrl = `chrome-extension://${id}/src/panel/index.html`;
  const workerUrl = `chrome-extension://${id}/src/background/service-worker.js`;
  const target = await attach(browser, fixturePage.targetId);
  await target.command('Runtime.enable');
  await target.command('Page.enable');
  const initialWorkerCursor = browser.eventCursor();
  await target.command('ServiceWorker.enable');
  let workerInfo = await waitForTargetInfo(browser, info => info.type === 'service_worker' && info.url === workerUrl, chromeStderr);
  let workerVersion = await waitForServiceWorkerVersion(browser, initialWorkerCursor, workerUrl, 'running', 15_000);
  let worker = await attach(browser, workerInfo.targetId);
  await worker.command('Runtime.enable');
  await waitForValue(worker, `chrome.action.onClicked.hasListeners()`, value => value === true, 15_000);
  debug('production chrome.action listener ready');
  await waitForValue(target, `location.href === ${JSON.stringify(fixtureUrl)} && document.readyState === 'complete' && Boolean(globalThis.__personaFixtureState)`, Boolean, 15_000);
  const sourceTabs = await evaluate(worker, `chrome.tabs.query({}).then(tabs => tabs.map(tab => ({ id: tab.id, url: tab.url })))`, true);
  const fixtureChromeTabId = sourceTabs.find(tab => tab.url === fixtureUrl)?.id;
  assert.ok(Number.isSafeInteger(fixtureChromeTabId), JSON.stringify(sourceTabs));
  await evaluate(worker, `chrome.tabs.update(${fixtureChromeTabId}, { active: true }).then(() => true)`, true);
  await waitForValue(worker, `chrome.tabs.query({ active: true }).then(tabs => tabs.some(tab => tab.id === ${fixtureChromeTabId}))`, Boolean);
  const triggerTarget = await browser.command('Target.getTargetInfo', { targetId: fixtureTab.targetId });
  assert.equal(triggerTarget.targetInfo?.type, 'tab');
  assert.equal(triggerTarget.targetInfo?.url, fixtureUrl);
  try { await browser.command('Extensions.triggerAction', { id, targetId: fixtureTab.targetId }, 15_000); }
  catch (error) { throw new Error(`PERSONA_E2E_TRIGGER_ACTION_FAILED: ${error.message}`); }
  debug('production chrome.action triggered on explicit fixture target');
  let panelPage = await waitForTargetInfo(browser, info => info.type === 'page' && info.url === panelUrl && info.title === 'Audita Acessibilidade', chromeStderr);
  let panelInfo = await waitForTargetInfo(browser, info => info.type === 'tab' && info.url === panelUrl, chromeStderr, true);
  let panel = await attach(browser, panelPage.targetId);
  await panel.command('Runtime.enable');
  await panel.command('Page.enable');
  debug('owned panel connected');

  await waitForValue(panel, `(() => ({
    enabled: !document.querySelector('#persona-mode-reader').disabled,
    target: document.querySelector('#persona-target').textContent
  }))()`, value => value?.enabled === true && /vinculada/iu.test(value.target));
  assert.doesNotMatch(await evaluate(panel, 'document.body.innerText'), new RegExp(sentinel, 'u'));
  let setup = await evaluate(panel, `Promise.all([chrome.tabs.getCurrent(), chrome.tabs.query({})]).then(([panelTab, tabs]) => ({
    panelTabId: panelTab.id,
    targetTabId: tabs.find(tab => tab.url === ${JSON.stringify(fixtureUrl)})?.id
  }))`, true);
  assert.ok(Number.isSafeInteger(setup.panelTabId) && Number.isSafeInteger(setup.targetTabId), JSON.stringify(setup));
  assert.equal(setup.targetTabId, fixtureChromeTabId);
  debug(`tabs resolved target=${setup.targetTabId} panel=${setup.panelTabId}`);
  debug('panel bound');
  const createdDecoy = await evaluate(worker, `chrome.tabs.create({ url: ${JSON.stringify(decoyUrl)}, active: true }).then(tab => ({ id: tab.id }))`, true);
  const decoyChromeTabId = createdDecoy?.id;
  assert.ok(Number.isSafeInteger(decoyChromeTabId), JSON.stringify(createdDecoy));
  const decoyTab = await waitForTargetInfo(browser, info => info.type === 'tab' && info.url === decoyUrl, chromeStderr, true);
  const decoyPage = await waitForTargetInfo(browser, info => info.type === 'page' && info.url === decoyUrl && info.title === 'Decoy personas', chromeStderr);
  const decoy = await attach(browser, decoyPage.targetId);
  await decoy.command('Runtime.enable');
  await decoy.command('Page.enable');
  await waitForValue(decoy, `location.href === ${JSON.stringify(decoyUrl)} && document.readyState === 'complete'`, Boolean, 15_000);
  const decoyTarget = await browser.command('Target.getTargetInfo', { targetId: decoyTab.targetId });
  assert.equal(decoyTarget.targetInfo?.type, 'tab');
  assert.equal(decoyTarget.targetInfo?.url, decoyUrl);
  await waitForValue(worker, `chrome.tabs.query({ active: true }).then(tabs => tabs.some(tab => tab.id === ${decoyChromeTabId}))`, Boolean);
  debug('decoy activated after explicit panel binding');

  await click(panel, '#persona-mode-reader');
  const readerPanel = await waitForValue(panel, `(() => ({
    pressed: document.querySelector('#persona-mode-reader').getAttribute('aria-pressed'),
    caption: document.querySelector('#persona-caption').textContent,
    position: document.querySelector('#persona-reader-position').textContent,
    limitations: document.querySelector('#persona-limitations-list').innerText
  }))()`, value => value?.pressed === 'true' && /Positivo um/iu.test(value.caption));
  assert.match(readerPanel.position, /Item 1 de [1-9]/u);
  assert.match(readerPanel.limitations, /frame não coordenado/iu);
  assert.match(readerPanel.limitations, /sandbox/iu);
  const readerTarget = await evaluate(target, `(() => ({
    classes: [...document.documentElement.classList],
    artifacts: [...document.querySelectorAll('[data-audita-persona-owned]')].map(node => node.outerHTML),
    frameArtifacts: [...document.querySelectorAll('iframe')].map(frame => {
      try { return frame.contentDocument?.querySelectorAll('[data-audita-persona-owned]').length || 0; }
      catch { return 0; }
    })
  }))()`);
  assert.deepEqual(readerTarget.classes.filter(name => name.startsWith('audita-persona-')), ['audita-persona-reader']);
  assert.equal(readerTarget.artifacts.length, 2);
  assert.ok(readerTarget.frameArtifacts.every(count => count === 0));
  assert.doesNotMatch(JSON.stringify(readerTarget.artifacts), new RegExp(sentinel, 'u'));
  assert.deepEqual(await evaluate(decoy, `(() => ({
    classes: [...document.documentElement.classList].filter(name => name.startsWith('audita-persona-')),
    artifacts: document.querySelectorAll('[data-audita-persona-owned]').length
  }))()`), { classes: [], artifacts: 0 }, 'a aba ativa/decoy nunca recebe a persona do alvo explícito');
  debug('reader active and isolated');

  const initialProof = await readBindingProof(worker, fixtureChromeTabId, setup.panelTabId);
  assert.match(initialProof.documentId || '', /^[A-Za-z0-9._:-]{1,200}$/u);
  assert.deepEqual(initialProof.result, {
    proofPresent: true,
    proof: { version: 1, panelTabId: setup.panelTabId, targetTabId: fixtureChromeTabId },
    proofDescriptor: { enumerable: false, configurable: true, writable: false, frozen: true, nullPrototype: true },
    checkerMatches: true,
    runtimePresent: true,
    singletonPresent: true,
    activeMode: 'reader',
  });
  assert.deepEqual(await evaluate(target, `(() => ({
    proof: Boolean(Object.getOwnPropertyDescriptor(globalThis, Symbol.for('audita.persona.binding-proof.v1'))),
    checker: Boolean(Object.getOwnPropertyDescriptor(globalThis, Symbol.for('audita.persona.binding-proof-checker.v1')))
  }))()`), { proof: false, checker: false }, 'a prova ISOLATED nunca é visível no MAIN world');

  const firstWorkerTargetId = workerInfo.targetId;
  const firstWorkerVersionId = workerVersion.versionId;
  await stopServiceWorker(browser, target, worker, workerInfo, workerVersion, workerUrl, chromeStderr);
  await waitForValue(panel, `(() => ({
    reconnectVisible: document.querySelector('#persona-reconnect').hidden === false,
    target: document.querySelector('#persona-target').textContent
  }))()`, value => value?.reconnectVisible === true && /encerrada|conectar/iu.test(value.target), 15_000);
  await waitForValue(target, `(() => ({
    active: [...document.documentElement.classList].some(name => name.startsWith('audita-persona-')),
    artifacts: document.querySelectorAll('[data-audita-persona-owned]').length
  }))()`, value => value?.active === false && value.artifacts === 0, 15_000);
  const workersBeforeReconnect = (await browser.command('Target.getTargets')).targetInfos || [];
  assert.equal(workersBeforeReconnect.some(info => info.type === 'service_worker' && info.url === workerUrl), false,
    JSON.stringify(workersBeforeReconnect));

  const firstRestartCursor = browser.eventCursor();
  await click(panel, '#persona-reconnect');
  workerInfo = await waitForTargetInfo(browser, info => info.type === 'service_worker' &&
    info.url === workerUrl && info.targetId !== firstWorkerTargetId, chromeStderr);
  assert.notEqual(workerInfo.targetId, firstWorkerTargetId, 'o restart precisa criar uma nova execução do worker');
  workerVersion = await waitForServiceWorkerVersion(browser, firstRestartCursor, workerUrl, 'running', 15_000);
  assert.equal(workerVersion.versionId, firstWorkerVersionId, 'o restart executa a mesma versão registrada em um target novo');
  worker = await attach(browser, workerInfo.targetId);
  await worker.command('Runtime.enable');
  await waitForValue(worker, `chrome.action.onClicked.hasListeners()`, value => value === true, 15_000);
  await waitForValue(panel, `(() => ({
    enabled: document.querySelector('#persona-mode-reader').disabled === false,
    pressed: [...document.querySelectorAll('[data-persona-mode]')].some(button => button.getAttribute('aria-pressed') === 'true'),
    target: document.querySelector('#persona-target').textContent
  }))()`, value => value?.enabled === true && value.pressed === false && /vinculada/iu.test(value.target), 15_000);
  const restoredBinding = await evaluate(panel,
    `chrome.storage.session.get('audita:persona:bindings:v1').then(value => value['audita:persona:bindings:v1'])`, true);
  assert.deepEqual(restoredBinding, [{ panelTabId: setup.panelTabId, targetTabId: fixtureChromeTabId }]);
  const restoredProof = await readBindingProof(worker, fixtureChromeTabId, setup.panelTabId);
  assert.equal(restoredProof.documentId, initialProof.documentId);
  assert.deepEqual(restoredProof.result, { ...initialProof.result, activeMode: null });
  debug('service worker restart restored same-document proof fail-closed');

  await click(panel, '#persona-mode-reader');
  await waitForValue(panel, `(() => ({
    pressed: document.querySelector('#persona-mode-reader').getAttribute('aria-pressed'),
    caption: document.querySelector('#persona-caption').textContent
  }))()`, value => value?.pressed === 'true' && /Positivo um/iu.test(value.caption), 15_000);

  await click(panel, '#persona-reader-next');
  await waitForValue(panel, `document.querySelector('#persona-caption').textContent`, value => /Positivo dois/iu.test(value));
  await evaluate(panel, `(() => {
    const input = document.querySelector('#persona-rate');
    input.value = '1.4';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitForValue(panel, `document.querySelector('#persona-rate-output').value`, value => /1,4/u.test(value));
  const storage = await evaluate(panel, `Promise.all([
    chrome.storage.local.get(null), chrome.storage.session.get(null)
  ]).then(([local, session]) => ({ local, session }))`, true);
  assert.deepEqual(Object.keys(storage.local).sort(), ['audita:persona:rate', 'audita:persona:voiceId']);
  assert.equal(storage.local['audita:persona:rate'], 1.4);
  assert.deepEqual(storage.session['audita:persona:bindings:v1'], [{ panelTabId: setup.panelTabId, targetTabId: setup.targetTabId }]);
  assert.doesNotMatch(JSON.stringify(storage), new RegExp(`${sentinel}|Positivo|https?://|token`, 'iu'));
  debug('storage privacy verified');

  await runPanelViewportQa(panel);
  debug('viewport QA complete');

  await click(panel, '#persona-mode-achromatopsia');
  await waitForValue(panel, `document.querySelector('#persona-mode-achromatopsia').getAttribute('aria-pressed')`, value => value === 'true');
  const achromatopsia = await evaluate(target, `(() => ({
    classes: [...document.documentElement.classList].filter(name => name.startsWith('audita-persona-')),
    artifacts: document.querySelectorAll('[data-audita-persona-owned]').length,
    filter: getComputedStyle(document.documentElement).filter
  }))()`);
  assert.deepEqual(achromatopsia.classes, ['audita-persona-achromatopsia']);
  assert.equal(achromatopsia.artifacts, 0);
  assert.match(achromatopsia.filter, /grayscale\(1\)/u);
  debug('achromatopsia reversible');

  await click(panel, '#persona-mode-motor');
  await waitForValue(panel, `document.querySelector('#persona-mode-motor').getAttribute('aria-pressed')`, value => value === 'true');
  assert.deepEqual(await evaluate(target, `[...document.documentElement.classList].filter(name => name.startsWith('audita-persona-'))`), ['audita-persona-motor']);
  const box = await evaluate(target, `(() => {
    const rect = document.querySelector('#input-target').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await target.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await target.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  assert.deepEqual(await evaluate(target, 'globalThis.__personaFixtureState'), { pointerDown: 0, pointerClick: 0, keyboardClick: 0 });
  await evaluate(worker, `chrome.tabs.update(${fixtureChromeTabId}, { active: true }).then(() => true)`, true);
  await waitForValue(worker, `chrome.tabs.query({ active: true }).then(tabs => tabs.some(tab => tab.id === ${fixtureChromeTabId}))`, Boolean);
  await evaluate(target, `document.querySelector('#input-target').focus()`);
  await waitForValue(target, `document.hasFocus() && document.activeElement?.id === 'input-target'`, Boolean);
  await target.command('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await target.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await waitForValue(target, 'globalThis.__personaFixtureState.keyboardClick', value => value === 1);
  await evaluate(worker, `chrome.tabs.update(${decoyChromeTabId}, { active: true }).then(() => true)`, true);
  await waitForValue(worker, `chrome.tabs.query({ active: true }).then(tabs => tabs.some(tab => tab.id === ${decoyChromeTabId}))`, Boolean);
  debug('motor trusted-input behavior verified');

  await evaluate(worker, `chrome.tabs.update(${fixtureChromeTabId}, { active: true }).then(() => true)`, true);
  await waitForValue(worker, `chrome.tabs.query({ active: true }).then(tabs => tabs.some(tab => tab.id === ${fixtureChromeTabId}))`, Boolean);
  await waitForValue(target, `document.hasFocus()`, Boolean);
  for (let press = 0; press < 3; press += 1) {
    await target.command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await target.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  }
  await waitForValue(target, `[...document.documentElement.classList].some(name => name.startsWith('audita-persona-'))`, value => value === false);
  await waitForValue(panel, `[...document.querySelectorAll('[data-persona-mode]')].every(button => button.getAttribute('aria-pressed') === 'false')`, Boolean);
  await evaluate(worker, `chrome.tabs.update(${decoyChromeTabId}, { active: true }).then(() => true)`, true);
  await waitForValue(worker, `chrome.tabs.query({ active: true }).then(tabs => tabs.some(tab => tab.id === ${decoyChromeTabId}))`, Boolean);
  debug('triple Escape cleanup verified');

  await click(panel, '#persona-mode-reader');
  await waitForValue(panel, `document.querySelector('#persona-mode-reader').getAttribute('aria-pressed')`, value => value === 'true');
  await waitForValue(target, `document.documentElement.classList.contains('audita-persona-reader')`, Boolean);
  const proofBeforeWorkerlessSpa = await readBindingProof(worker, fixtureChromeTabId, setup.panelTabId);
  assert.equal(proofBeforeWorkerlessSpa.documentId, initialProof.documentId);
  assert.equal(proofBeforeWorkerlessSpa.result.checkerMatches, true);
  assert.equal(proofBeforeWorkerlessSpa.result.activeMode, 'reader');

  const phaseTwoWorkerTargetId = workerInfo.targetId;
  const phaseTwoWorkerVersionId = workerVersion.versionId;
  await stopServiceWorker(browser, target, worker, workerInfo, workerVersion, workerUrl, chromeStderr);
  await waitForValue(panel, `document.querySelector('#persona-reconnect').hidden === false`, Boolean, 15_000);
  await waitForValue(target, `(() => ({
    active: [...document.documentElement.classList].some(name => name.startsWith('audita-persona-')),
    artifacts: document.querySelectorAll('[data-audita-persona-owned]').length
  }))()`, value => value?.active === false && value.artifacts === 0, 15_000);
  await assertServiceWorkerAbsent(browser, workerUrl);
  const workerlessProofBeforeSpa = await readBindingProof(panel, fixtureChromeTabId, setup.panelTabId);
  assert.equal(workerlessProofBeforeSpa.documentId, initialProof.documentId);
  assert.equal(workerlessProofBeforeSpa.result.proofPresent, true);
  assert.equal(workerlessProofBeforeSpa.result.checkerMatches, true);
  assert.equal(workerlessProofBeforeSpa.result.activeMode, null);
  await assertServiceWorkerAbsent(browser, workerUrl);

  const staleBindingsBeforeSpa = await evaluate(panel,
    `chrome.storage.session.get('audita:persona:bindings:v1').then(value => value['audita:persona:bindings:v1'])`, true);
  assert.deepEqual(staleBindingsBeforeSpa, [{ panelTabId: setup.panelTabId, targetTabId: fixtureChromeTabId }]);
  const spaWakeCursor = browser.eventCursor();
  const spaNavigation = await runAtomicHistoryProofCycle(
    panel, fixtureChromeTabId, setup.panelTabId, `${fixtureUrl}?spa-navigation=1`, fixtureUrl,
  );
  assert.equal(spaNavigation.navigationAvailable, true);
  assert.equal(spaNavigation.originalUrl, fixtureUrl);
  assert.equal(spaNavigation.pushedUrl, `${fixtureUrl}?spa-navigation=1`);
  assert.equal(spaNavigation.finalUrl, spaNavigation.originalUrl);
  assert.notEqual(spaNavigation.pushedEntryKey, spaNavigation.initialEntryKey);
  assert.equal(spaNavigation.finalEntryKey, spaNavigation.pushedEntryKey);
  assert.equal(spaNavigation.proofPresentBefore, true);
  assert.equal(spaNavigation.proofMatchesBefore, true);
  assert.equal(spaNavigation.checkerBefore, true);
  assert.equal(spaNavigation.proofPresentAfter, true);
  assert.equal(spaNavigation.proofMatchesAfter, true);
  assert.equal(spaNavigation.checkerAfter, false,
    'a task ISOLATED prova o estado proof-presente/revogado que nenhum clear do worker pode produzir');
  assert.equal(spaNavigation.documentId, initialProof.documentId);
  workerInfo = await waitForTargetInfo(browser, info => info.type === 'service_worker' &&
    info.url === workerUrl && info.targetId !== phaseTwoWorkerTargetId, chromeStderr);
  workerVersion = await waitForServiceWorkerVersion(browser, spaWakeCursor, workerUrl, 'running', 15_000);
  assert.equal(workerVersion.versionId, phaseTwoWorkerVersionId);
  worker = await attach(browser, workerInfo.targetId);
  await worker.command('Runtime.enable');
  await waitForValue(worker, `chrome.action.onClicked.hasListeners()`, value => value === true, 15_000);
  await waitForValue(panel,
    `chrome.storage.session.get('audita:persona:bindings:v1').then(value => value['audita:persona:bindings:v1'])`,
    value => Array.isArray(value) && value.length === 0, 15_000);
  const clearedSpaProof = await waitForBindingProof(
    panel, fixtureChromeTabId, setup.panelTabId,
    proof => proof.result?.proofPresent === false && proof.result?.checkerMatches === false, 15_000,
  );
  assert.equal(clearedSpaProof.documentId, initialProof.documentId);
  await click(panel, '#persona-reconnect');
  const spaUnboundPanel = await waitForValue(panel, `(() => ({
    disabled: [...document.querySelectorAll('[data-persona-mode]')].every(button => button.disabled),
    released: [...document.querySelectorAll('[data-persona-mode]')].every(button => button.getAttribute('aria-pressed') === 'false'),
    reconnectHidden: document.querySelector('#persona-reconnect').hidden === true,
    target: document.querySelector('#persona-target').textContent,
    busy: document.querySelector('#persona-section').getAttribute('aria-busy')
  }))()`, value => value?.disabled === true && value.released === true && value.reconnectHidden === true &&
    value.busy === 'false' && /Nenhuma aba alvo|restaurar|não está disponível/iu.test(value.target), 15_000);
  assert.match(spaUnboundPanel.target, /Nenhuma aba alvo|restaurar|não está disponível/iu);
  assert.deepEqual(await evaluate(panel,
    `chrome.storage.session.get('audita:persona:bindings:v1').then(value => value['audita:persona:bindings:v1'])`, true), []);
  assert.deepEqual(await evaluate(target, `(() => ({
    active: [...document.documentElement.classList].some(name => name.startsWith('audita-persona-')),
    artifacts: document.querySelectorAll('[data-audita-persona-owned]').length
  }))()`), { active: false, artifacts: 0 });
  debug('workerless History/Navigation A→B→A proof revocation and restore sanitization verified');

  const oldPanelTabTargetId = panelInfo.targetId;
  const oldPanelPageTargetId = panelPage.targetId;
  await browser.command('Target.closeTarget', { targetId: oldPanelTabTargetId });
  await waitForTargetGone(browser, oldPanelTabTargetId, chromeStderr, 15_000);
  await evaluate(worker, `chrome.tabs.update(${fixtureChromeTabId}, { active: true }).then(() => true)`, true);
  await waitForValue(worker,
    `chrome.tabs.query({ active: true }).then(tabs => tabs.some(tab => tab.id === ${fixtureChromeTabId}))`, Boolean);
  try { await browser.command('Extensions.triggerAction', { id, targetId: fixtureTab.targetId }, 15_000); }
  catch (error) { throw new Error(`PERSONA_E2E_REBIND_ACTION_FAILED: ${error.message}`); }
  panelPage = await waitForTargetInfo(browser, info => info.type === 'page' && info.url === panelUrl &&
    info.title === 'Audita Acessibilidade' && info.targetId !== oldPanelPageTargetId, chromeStderr);
  panelInfo = await waitForTargetInfo(browser, info => info.type === 'tab' && info.url === panelUrl &&
    info.targetId !== oldPanelTabTargetId, chromeStderr, true);
  panel = await attach(browser, panelPage.targetId);
  await panel.command('Runtime.enable');
  await panel.command('Page.enable');
  await waitForValue(panel, `(() => ({
    enabled: document.querySelector('#persona-mode-motor').disabled === false,
    target: document.querySelector('#persona-target').textContent
  }))()`, value => value?.enabled === true && /vinculada/iu.test(value.target), 15_000);
  setup = await evaluate(panel, `Promise.all([chrome.tabs.getCurrent(), chrome.tabs.query({})]).then(([panelTab, tabs]) => ({
    panelTabId: panelTab.id,
    targetTabId: tabs.find(tab => tab.url === ${JSON.stringify(fixtureUrl)})?.id
  }))`, true);
  assert.ok(Number.isSafeInteger(setup.panelTabId) && setup.targetTabId === fixtureChromeTabId, JSON.stringify(setup));
  assert.deepEqual(await evaluate(panel,
    `chrome.storage.session.get('audita:persona:bindings:v1').then(value => value['audita:persona:bindings:v1'])`, true),
  [{ panelTabId: setup.panelTabId, targetTabId: fixtureChromeTabId }]);
  const reboundProof = await readBindingProof(worker, fixtureChromeTabId, setup.panelTabId);
  assert.equal(reboundProof.documentId, initialProof.documentId);
  assert.equal(reboundProof.result.proofPresent, true);
  assert.equal(reboundProof.result.checkerMatches, true);
  debug('production action rebound a fresh panel/proof after sanitized restore');

  await click(panel, '#persona-mode-motor');
  await waitForValue(target, `document.documentElement.classList.contains('audita-persona-motor')`, Boolean);
  const proofBeforeNavigation = await readBindingProof(worker, fixtureChromeTabId, setup.panelTabId);
  assert.equal(proofBeforeNavigation.documentId, initialProof.documentId);
  assert.equal(proofBeforeNavigation.result.checkerMatches, true);
  await target.command('Page.navigate', { url: `${fixtureUrl}?navigation=1` });
  await waitForValue(target, `location.search === '?navigation=1' && document.readyState === 'complete'`, Boolean, 15_000);
  await waitForValue(panel, `document.querySelector('#persona-reconnect').hidden === false`, Boolean);
  debug('navigation invalidation verified');
  assert.equal(await evaluate(target, `[...document.documentElement.classList].some(name => name.startsWith('audita-persona-'))`), false);

  const secondWorkerTargetId = workerInfo.targetId;
  const registeredVersionId = workerVersion.versionId;
  const staleBindingsBeforeNavigationRestart = await evaluate(panel,
    `chrome.storage.session.get('audita:persona:bindings:v1').then(value => value['audita:persona:bindings:v1'])`, true);
  assert.deepEqual(staleBindingsBeforeNavigationRestart,
    [{ panelTabId: setup.panelTabId, targetTabId: fixtureChromeTabId }],
    'a navegação revoga a prova, mas o par stale só é saneado durante o restore do novo worker');
  await stopServiceWorker(browser, target, worker, workerInfo, workerVersion, workerUrl, chromeStderr);
  await waitForValue(target, `(() => ({
    active: [...document.documentElement.classList].some(name => name.startsWith('audita-persona-')),
    artifacts: document.querySelectorAll('[data-audita-persona-owned]').length
  }))()`, value => value?.active === false && value.artifacts === 0, 15_000);
  const postNavigationWorkersBeforeReconnect = (await browser.command('Target.getTargets')).targetInfos || [];
  assert.equal(postNavigationWorkersBeforeReconnect.some(info => info.type === 'service_worker' && info.url === workerUrl), false,
    JSON.stringify(postNavigationWorkersBeforeReconnect));

  const navigationRestartCursor = browser.eventCursor();
  await click(panel, '#persona-reconnect');
  workerInfo = await waitForTargetInfo(browser, info => info.type === 'service_worker' &&
    info.url === workerUrl && info.targetId !== secondWorkerTargetId, chromeStderr);
  assert.notEqual(workerInfo.targetId, secondWorkerTargetId);
  workerVersion = await waitForServiceWorkerVersion(browser, navigationRestartCursor, workerUrl, 'running', 15_000);
  assert.equal(workerVersion.versionId, registeredVersionId);
  worker = await attach(browser, workerInfo.targetId);
  await worker.command('Runtime.enable');
  await waitForValue(worker, `chrome.action.onClicked.hasListeners()`, value => value === true, 15_000);
  const unboundPanel = await waitForValue(panel, `(() => ({
    disabled: [...document.querySelectorAll('[data-persona-mode]')].every(button => button.disabled),
    released: [...document.querySelectorAll('[data-persona-mode]')].every(button => button.getAttribute('aria-pressed') === 'false'),
    reconnectHidden: document.querySelector('#persona-reconnect').hidden === true,
    target: document.querySelector('#persona-target').textContent,
    busy: document.querySelector('#persona-section').getAttribute('aria-busy')
  }))()`, value => value?.disabled === true && value.released === true && value.reconnectHidden === true &&
    value.busy === 'false' && /Nenhuma aba alvo|restaurar|não está disponível/iu.test(value.target), 15_000);
  assert.match(unboundPanel.target, /Nenhuma aba alvo|restaurar|não está disponível/iu);
  const sanitizedBindings = await evaluate(panel,
    `chrome.storage.session.get('audita:persona:bindings:v1').then(value => value['audita:persona:bindings:v1'])`, true);
  assert.deepEqual(sanitizedBindings, []);
  const postNavigationProof = await readBindingProof(worker, fixtureChromeTabId, setup.panelTabId);
  assert.notEqual(postNavigationProof.documentId, initialProof.documentId);
  assert.deepEqual(postNavigationProof.result, {
    proofPresent: false,
    proof: null,
    proofDescriptor: null,
    checkerMatches: false,
    runtimePresent: false,
    singletonPresent: false,
    activeMode: null,
  });
  assert.deepEqual(await evaluate(target, `(() => ({
    proof: Boolean(Object.getOwnPropertyDescriptor(globalThis, Symbol.for('audita.persona.binding-proof.v1'))),
    checker: Boolean(Object.getOwnPropertyDescriptor(globalThis, Symbol.for('audita.persona.binding-proof-checker.v1'))),
    active: [...document.documentElement.classList].some(name => name.startsWith('audita-persona-')),
    artifacts: document.querySelectorAll('[data-audita-persona-owned]').length
  }))()`), { proof: false, checker: false, active: false, artifacts: 0 });
  debug('post-navigation worker restore rejected stale proof and sanitized binding fail-closed');

  await browser.command('Target.closeTarget', { targetId: panelInfo.targetId });
  await waitForValue(target, `(() => ({
    active: [...document.documentElement.classList].some(name => name.startsWith('audita-persona-')),
    artifacts: document.querySelectorAll('[data-audita-persona-owned]').length
  }))()`, value => value?.active === false && value.artifacts === 0, 15_000);
  debug('panel-close cleanup verified');
  assert.ok(requests.every(entry => /^(?:main:\/(?:personas-csp(?:\.html|\.js)?|personas-frame\.html|decoy\.html|favicon\.ico)|cross:\/personas-frame\.html)(?:\?.*)?$/u.test(entry)), JSON.stringify(requests));
});

async function runPanelViewportQa(panel) {
  const viewports = [
    ['1440x900', 1440, 900, 1], ['1280x800', 1280, 800, 1], ['1024x768', 1024, 768, 1],
    ['768x1024', 768, 1024, 1], ['390x844', 390, 844, 1], ['320x568', 320, 568, 1],
    ['1280x800-200pct', 640, 400, 2],
  ];
  if (qaDirectory) await mkdir(qaDirectory, { recursive: true });
  for (const [label, width, height, deviceScaleFactor] of viewports) {
    await panel.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false });
    const layout = await evaluate(panel, `(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      minimumControl: Math.min(...[...document.querySelectorAll('#persona-section button, #persona-section select, #persona-section input')]
        .filter(node => !node.hidden && node.getClientRects().length > 0)
        .map(node => node.getBoundingClientRect().height))
    }))()`);
    assert.ok(layout.scrollWidth <= layout.clientWidth, `${label}: overflow horizontal ${layout.scrollWidth}/${layout.clientWidth}`);
    assert.ok(layout.minimumControl >= 44, `${label}: controle menor que 44px (${layout.minimumControl})`);
    if (qaDirectory) {
      const screenshot = await panel.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await writeFile(join(qaDirectory, `personas-panel-${label}.png`), Buffer.from(screenshot.data, 'base64'));
    }
  }
  await panel.command('Emulation.setEmulatedMedia', {
    features: [{ name: 'forced-colors', value: 'active' }, { name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  const forced = await evaluate(panel, `(() => {
    const button = document.querySelector('#persona-mode-reader');
    button.focus();
    const style = getComputedStyle(button);
    return { outlineStyle: style.outlineStyle, minHeight: button.getBoundingClientRect().height };
  })()`);
  assert.notEqual(forced.outlineStyle, 'none');
  assert.ok(forced.minHeight >= 44);
  await panel.command('Emulation.setEmulatedMedia', { features: [] });
  await panel.command('Emulation.clearDeviceMetricsOverride');
}

async function click(cdp, selector) {
  const clicked = await evaluate(cdp, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node || node.disabled) return false;
    node.click();
    return true;
  })()`);
  assert.equal(clicked, true, `controle indisponível: ${selector}`);
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const evaluated = await cdp.command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
  return evaluated.result?.value;
}

async function waitForValue(cdp, expression, predicate, timeoutMs = 10_000) {
  const started = Date.now();
  let latest;
  while (Date.now() - started < timeoutMs) {
    try {
      latest = await evaluate(cdp, expression, true);
      if (predicate(latest)) return latest;
    } catch { /* execution context can rotate during navigation */ }
    await delay(50);
  }
  throw new Error(`Condição E2E não satisfeita: ${expression}; último valor=${JSON.stringify(latest)}`);
}

async function waitForBindingProof(extensionContext, targetTabId, panelTabId, predicate, timeoutMs = 10_000) {
  const started = Date.now();
  let latest;
  while (Date.now() - started < timeoutMs) {
    latest = await readBindingProof(extensionContext, targetTabId, panelTabId);
    if (predicate(latest)) return latest;
    await delay(50);
  }
  throw new Error(`Prova ISOLATED não atingiu o estado esperado: ${JSON.stringify(latest)}`);
}

async function assertServiceWorkerAbsent(browser, workerUrl) {
  const targets = (await browser.command('Target.getTargets')).targetInfos || [];
  assert.equal(targets.some(info => info.type === 'service_worker' && info.url === workerUrl), false,
    `service worker precisa permanecer ausente: ${JSON.stringify(targets)}`);
}

async function attach(browser, targetId) {
  const attached = await browser.command('Target.attachToTarget', { targetId, flatten: true });
  assert.match(attached.sessionId || '', /^[A-Fa-f0-9-]+$/u);
  return new SessionCdp(browser, attached.sessionId);
}

async function waitForTargetInfo(browser, predicate, stderr, includeTabs = false) {
  let latest = [];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const targets = await browser.command('Target.getTargets', includeTabs ? { filter: [{}] } : {});
    latest = targets.targetInfos || [];
    const target = latest.find(predicate);
    if (target) return target;
    await delay(50);
  }
  throw new Error(`Target CDP não apareceu: targets=${JSON.stringify(latest)}; stderr=${stderr}`);
}

async function waitForTargetGone(browser, targetId, stderr, timeoutMs = 10_000) {
  const started = Date.now();
  let latest = [];
  while (Date.now() - started < timeoutMs) {
    const targets = await browser.command('Target.getTargets', { filter: [{}] });
    latest = targets.targetInfos || [];
    if (!latest.some(info => info.targetId === targetId)) return;
    await delay(50);
  }
  throw new Error(`Target CDP permaneceu ativo: targetId=${targetId}; targets=${JSON.stringify(latest)}; stderr=${stderr}`);
}

async function waitForServiceWorkerVersion(browser, cursor, workerUrl, runningStatus, timeoutMs = 10_000) {
  const event = await browser.waitForEvent(cursor, 'ServiceWorker.workerVersionUpdated', params =>
    params?.versions?.some(version => version.scriptURL === workerUrl && version.runningStatus === runningStatus), timeoutMs);
  return event.params.versions.find(version => version.scriptURL === workerUrl && version.runningStatus === runningStatus);
}

async function stopServiceWorker(browser, serviceWorkerCdp, worker, workerInfo, workerVersion, workerUrl, stderr) {
  const stoppedCursor = browser.eventCursor();
  await browser.command('Target.detachFromTarget', { sessionId: worker.sessionId });
  await serviceWorkerCdp.command('ServiceWorker.stopWorker', { versionId: workerVersion.versionId }, 15_000);
  const stoppedVersion = await waitForServiceWorkerVersion(browser, stoppedCursor, workerUrl, 'stopped', 15_000);
  assert.equal(stoppedVersion.versionId, workerVersion.versionId);
  await waitForTargetGone(browser, workerInfo.targetId, stderr, 15_000);
}

async function runAtomicHistoryProofCycle(extensionContext, targetTabId, panelTabId, pushedUrl, finalUrl) {
  const results = await evaluate(extensionContext, `chrome.scripting.executeScript({
    target: { tabId: ${targetTabId}, frameIds: [0] },
    world: 'ISOLATED',
    func: (expectedPanelTabId, expectedTargetTabId, nextUrl, restoredUrl) => {
      const proofKey = Symbol.for('audita.persona.binding-proof.v1');
      const checkerKey = Symbol.for('audita.persona.binding-proof-checker.v1');
      const inspect = () => {
        const proofDescriptor = Object.getOwnPropertyDescriptor(globalThis, proofKey);
        const checkerDescriptor = Object.getOwnPropertyDescriptor(globalThis, checkerKey);
        const proof = proofDescriptor && Object.hasOwn(proofDescriptor, 'value') ? proofDescriptor.value : null;
        const proofMatches = Boolean(proof && Object.getPrototypeOf(proof) === null && Object.isFrozen(proof) &&
          proof.version === 1 && proof.panelTabId === expectedPanelTabId && proof.targetTabId === expectedTargetTabId);
        let checkerMatches = false;
        try { checkerMatches = checkerDescriptor?.value?.(expectedPanelTabId, expectedTargetTabId) === true; }
        catch { checkerMatches = false; }
        return { proofPresent: Boolean(proof), proofMatches, checkerMatches };
      };
      const before = inspect();
      const originalUrl = globalThis.location.href;
      const initialEntryKey = globalThis.navigation?.currentEntry?.key ?? null;
      globalThis.history.pushState(null, '', nextUrl);
      const actualPushedUrl = globalThis.location.href;
      const pushedEntryKey = globalThis.navigation?.currentEntry?.key ?? null;
      globalThis.history.replaceState(null, '', restoredUrl);
      const after = inspect();
      return {
        navigationAvailable: Boolean(globalThis.navigation?.currentEntry),
        originalUrl,
        pushedUrl: actualPushedUrl,
        finalUrl: globalThis.location.href,
        initialEntryKey,
        pushedEntryKey,
        finalEntryKey: globalThis.navigation?.currentEntry?.key ?? null,
        proofPresentBefore: before.proofPresent,
        proofMatchesBefore: before.proofMatches,
        checkerBefore: before.checkerMatches,
        proofPresentAfter: after.proofPresent,
        proofMatchesAfter: after.proofMatches,
        checkerAfter: after.checkerMatches,
      };
    },
    args: [${panelTabId}, ${targetTabId}, ${JSON.stringify(pushedUrl)}, ${JSON.stringify(finalUrl)}],
  }).then(entries => entries.map(entry => ({ frameId: entry.frameId, documentId: entry.documentId, result: entry.result })))`, true);
  assert.equal(results?.length, 1, JSON.stringify(results));
  assert.equal(results[0]?.frameId, 0, JSON.stringify(results));
  return { ...results[0].result, documentId: results[0].documentId };
}

async function readBindingProof(extensionContext, targetTabId, panelTabId) {
  const results = await evaluate(extensionContext, `chrome.scripting.executeScript({
    target: { tabId: ${targetTabId}, frameIds: [0] },
    world: 'ISOLATED',
    func: (expectedPanelTabId, expectedTargetTabId) => {
      const proofDescriptor = Object.getOwnPropertyDescriptor(globalThis, Symbol.for('audita.persona.binding-proof.v1'));
      const checkerDescriptor = Object.getOwnPropertyDescriptor(globalThis, Symbol.for('audita.persona.binding-proof-checker.v1'));
      const runtimeDescriptor = Object.getOwnPropertyDescriptor(globalThis, Symbol.for('audita.accessible-preview.runtime.v1'));
      const proof = proofDescriptor && Object.hasOwn(proofDescriptor, 'value') ? proofDescriptor.value : null;
      const runtime = runtimeDescriptor && Object.hasOwn(runtimeDescriptor, 'value') ? runtimeDescriptor.value : null;
      const singleton = runtime?.getContentSingleton?.() || null;
      let checkerMatches = false;
      try { checkerMatches = checkerDescriptor?.value?.(expectedPanelTabId, expectedTargetTabId) === true; }
      catch { checkerMatches = false; }
      return {
        proofPresent: Boolean(proof),
        proof: proof ? { version: proof.version, panelTabId: proof.panelTabId, targetTabId: proof.targetTabId } : null,
        proofDescriptor: proofDescriptor ? {
          enumerable: proofDescriptor.enumerable,
          configurable: proofDescriptor.configurable,
          writable: proofDescriptor.writable,
          frozen: Object.isFrozen(proof),
          nullPrototype: Object.getPrototypeOf(proof) === null,
        } : null,
        checkerMatches,
        runtimePresent: runtime?.brand === 'audita-accessible-preview' && runtime?.version === 1,
        singletonPresent: Boolean(singleton),
        activeMode: singleton?.getState?.().activeMode ?? null,
      };
    },
    args: [${panelTabId}, ${targetTabId}],
  }).then(entries => entries.map(entry => ({ frameId: entry.frameId, documentId: entry.documentId, result: entry.result })))`, true);
  assert.equal(results?.length, 1, JSON.stringify(results));
  assert.equal(results[0]?.frameId, 0, JSON.stringify(results));
  return results[0];
}

async function listen(server) {
  await new Promise((resolveListen, rejectListen) => server.listen(0, '127.0.0.1', error => error ? rejectListen(error) : resolveListen()));
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise(resolveClose => server.close(resolveClose));
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

class SessionCdp {
  constructor(browser, sessionId) {
    this.browser = browser;
    this.sessionId = sessionId;
  }

  command(method, params = {}, timeoutMs = 10_000) {
    return this.browser.command(method, params, timeoutMs, this.sessionId);
  }
}

class PipeCdp {
  constructor(commandPipe, responsePipe) {
    this.commandPipe = commandPipe;
    this.responsePipe = responsePipe;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.eventSequence = 0;
    this.buffer = Buffer.alloc(0);
    responsePipe.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let delimiter;
      while ((delimiter = this.buffer.indexOf(0)) >= 0) {
        const frame = this.buffer.subarray(0, delimiter);
        this.buffer = this.buffer.subarray(delimiter + 1);
        if (!frame.length) continue;
        const message = JSON.parse(frame.toString('utf8'));
        if (!message.id || !this.pending.has(message.id)) {
          if (message.method) {
            this.events.push({ sequence: ++this.eventSequence, ...message });
            if (this.events.length > 500) this.events.shift();
          }
          continue;
        }
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result);
      }
    });
    responsePipe.on('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('CDP encerrado.'));
      }
      this.pending.clear();
    });
  }

  command(method, params = {}, timeoutMs = 10_000, sessionId = undefined) {
    const id = this.nextId++;
    return new Promise((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCommand(new Error(`CDP timeout em ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      this.commandPipe.write(`${JSON.stringify(message)}\0`);
    });
  }

  eventCursor() {
    return this.eventSequence;
  }

  async waitForEvent(cursor, method, predicate, timeoutMs = 10_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const event = this.events.find(candidate => candidate.sequence > cursor && candidate.method === method && predicate(candidate.params));
      if (event) return event;
      await delay(25);
    }
    const recent = this.events.filter(event => event.sequence > cursor).slice(-20);
    throw new Error(`Evento CDP não apareceu: method=${method}; recentes=${JSON.stringify(recent)}`);
  }

  close() {
    try { this.commandPipe.destroy(); } catch { /* Chrome pode já ter encerrado */ }
    try { this.responsePipe.destroy(); } catch { /* Chrome pode já ter encerrado */ }
  }
}
