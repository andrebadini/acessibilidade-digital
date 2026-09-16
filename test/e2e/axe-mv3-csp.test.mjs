import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AXE_MV3_CSP_GATE, AXE_RUN_CONFIG } from '../../src/browser/axe-adapter.js';
import { decideAxeE2eExecution } from '../../scripts/axe-e2e-decision.mjs';
import {
  CANONICAL_CHROME_PRODUCT,
  createBoundedBrowserCleanup,
  resolveRealChromeTestBinary,
  terminateChromeProcess,
} from './support/real-chrome.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtures = join(root, 'test', 'e2e', 'fixtures');
const chromeBinary = resolveRealChromeTestBinary();
const strictCsp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'; base-uri 'none'; form-action 'none'";
const debug = message => { if (process.env.AUDITA_E2E_DEBUG === '1') process.stderr.write(`[axe-e2e] ${message}\n`); };

test('runs pinned local axe in every isolated frame under real MV3 and strict page CSP', { timeout: 45_000 }, async t => {
  let chrome = null;
  let profile = null;
  const cdpClients = [];
  const server = createServer(async (request, response) => {
    debug(`fixture request: ${request.url}`);
    const name = request.url === '/axe-csp-frame.html' ? 'axe-csp-frame.html' : 'axe-csp.html';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': strictCsp });
    response.end(await readFile(join(fixtures, name)));
  });
  await new Promise((resolveListen, rejectListen) => server.listen(0, '127.0.0.1', error => error ? rejectListen(error) : resolveListen()));
  debug('fixture server listening');
  const cleanup = createBoundedBrowserCleanup({
    closeClients() {
      for (const client of cdpClients.toReversed()) client.close();
    },
    terminateChrome() {
      return chrome === null ? true : terminateChromeProcess(chrome, { timeoutMs: 1_500 });
    },
    closeServer() {
      server.closeAllConnections?.();
      return new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose(true)));
    },
    removeProfile() {
      return profile === null ? true : rm(profile, { recursive: true, force: true });
    },
    // 2 000 ms was measured to be too tight for the recursive removal of a Chrome profile when
    // the machine is loaded: the same file passes alone in ~1,1 s, but the batch run failed with
    // `{"stage":"profile","code":"failed"}` while its assertions had already passed. This bounds
    // a stuck removal, it does not excuse a failed one: `rm` still has to actually succeed.
    stageTimeoutMs: 15_000,
  });
  t.after(async () => {
    const result = await cleanup();
    assert.deepEqual(result, { ok: true, failures: [] }, `cleanup axe limitado falhou: ${JSON.stringify(result.failures)}`);
  });
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/axe-csp.html`;
  const response = await fetch(fixtureUrl);
  assert.equal(response.headers.get('content-security-policy'), strictCsp);
  debug('fixture CSP verified');
  const decision = decideAxeE2eExecution({ gate: AXE_MV3_CSP_GATE, chromeBinary });
  if (decision.action === 'skip') {
    assert.equal(AXE_RUN_CONFIG.rules['target-size'].enabled, false);
    t.skip(decision.code);
    return;
  }
  assert.equal(decision.action, 'run', decision.code);

  profile = await mkdtemp(join(tmpdir(), 'audita-axe-chrome-'));
  chrome = spawn(chromeBinary, [
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--use-mock-keychain',
    '--window-position=-10000,-10000', '--window-size=1280,800',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeStderr = '';
  chrome.stderr.on('data', chunk => { chromeStderr = `${chromeStderr}${chunk}`.slice(-8_000); });

  const port = await waitForDevToolsPort(profile, chrome);
  debug(`DevTools active on ${port}`);
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(value => value.json());
  assert.equal(version.Browser, CANONICAL_CHROME_PRODUCT);
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  cdpClients.push(cdp);
  debug('browser CDP connected');

  const fixtureCreated = await cdp.command('Target.createTarget', { url: fixtureUrl });
  let listedFixture;
  for (let attempt = 0; attempt < 200 && !listedFixture; attempt += 1) {
    const listedTargets = await fetch(`http://127.0.0.1:${port}/json/list`).then(value => value.json());
    listedFixture = listedTargets.find(info => info.id === fixtureCreated.targetId && info.url === fixtureUrl && info.webSocketDebuggerUrl);
    if (!listedFixture) await delay(50);
  }
  assert.ok(listedFixture, `fixture real não carregou: ${chromeStderr}`);
  const fixtureCdp = await Cdp.connect(listedFixture.webSocketDebuggerUrl);
  cdpClients.push(fixtureCdp);
  await fixtureCdp.command('Runtime.enable');
  await fixtureCdp.command('Page.enable');
  await waitForPageContext(fixtureCdp, { expectedUrl: fixtureUrl, timeoutMs: 10_000 });
  debug('fixture tab criada pelo CDP e estabilizada');

  const loaded = await cdp.command('Extensions.loadUnpacked', { path: root });
  const id = loaded?.id;
  assert.match(id || '', /^[a-p]{32}$/u, `extensão real não carregou: ${chromeStderr}`);
  const extensionUrl = `chrome-extension://${id}/src/panel/index.html`;
  debug(`expected extension id: ${id}`);
  const created = await cdp.command('Target.createTarget', { url: extensionUrl });
  let listedExtension;
  for (let attempt = 0; attempt < 100 && !listedExtension; attempt += 1) {
    const listedTargets = await fetch(`http://127.0.0.1:${port}/json/list`).then(value => value.json());
    listedExtension = listedTargets.find(info => info.id === created.targetId && info.url === extensionUrl && info.webSocketDebuggerUrl);
    if (!listedExtension) await delay(50);
  }
  assert.ok(listedExtension, `página real da extensão não carregou: ${chromeStderr}`);
  const extensionCdp = await Cdp.connect(listedExtension.webSocketDebuggerUrl);
  cdpClients.push(extensionCdp);
  await extensionCdp.command('Runtime.enable');
  await extensionCdp.command('Page.enable');
  const readyContext = await waitForExtensionContext(extensionCdp, {
    extensionUrl,
    extensionId: id,
    timeoutMs: 10_000,
  });
  assert.deepEqual(readyContext, {
    href: extensionUrl,
    readyState: 'complete',
    extensionId: id,
  });
  debug('real extension panel CDP connected');

  const expression = `(() => {
    globalThis.__axeE2eResult = null;
    globalThis.__axeE2eError = null;
    globalThis.__axeE2eTrace = [];
    globalThis.__axeE2eStage = 'find-fixture-tab';
    new Promise((resolveTab, rejectTab) => {
      const startedAt = Date.now();
      const check = () => chrome.tabs.query({}).then(tabs => {
        const matches = tabs.filter(tab => tab.status === 'complete' && tab.url === ${JSON.stringify(fixtureUrl)});
        if (matches.length === 1) resolveTab(matches[0]);
        else if (matches.length > 1) rejectTab(new Error('fixture tab ambiguous'));
        else if (Date.now() - startedAt >= 10000) rejectTab(new Error('fixture tab did not correlate'));
        else setTimeout(check, 50);
      }, rejectTab);
      check();
    }).then(tab => {
      globalThis.__axeE2eStage = 'import-adapter';
      return Promise.all([tab, import(chrome.runtime.getURL('src/browser/axe-adapter.js'))]);
    }).then(([tab, adapter]) => {
      globalThis.__axeE2eStage = 'run-adapter';
      return adapter.runAxeInTab(tab.id, {
        timeoutMs: 20000,
        executeScript: options => {
          const phase = options.files ? 'inject' : 'run';
          globalThis.__axeE2eTrace.push(phase + '-start');
          return chrome.scripting.executeScript(options).then(value => {
            globalThis.__axeE2eTrace.push(phase + '-return');
            return value;
          }, error => {
            globalThis.__axeE2eTrace.push(phase + '-reject:' + String(error?.name || 'Error'));
            throw error;
          });
        },
      });
    }).then(value => {
      globalThis.__axeE2eResult = value;
      globalThis.__axeE2eStage = 'adapter-returned';
    }, error => {
      globalThis.__axeE2eError = String(error?.stack || error || 'Error').slice(0, 2000);
      globalThis.__axeE2eStage = 'adapter-rejected';
    });
    return { started: true };
  })()`;
  const started = await extensionCdp.command('Runtime.evaluate', {
    expression, returnByValue: true,
  });
  assert.equal(started.exceptionDetails, undefined,
    started.exceptionDetails?.exception?.description || started.exceptionDetails?.text);
  assert.deepEqual(started.result.value, { started: true });
  let state;
  for (let attempt = 0; attempt < 60 && state?.stage !== 'adapter-returned' && state?.stage !== 'adapter-rejected'; attempt += 1) {
    await delay(500);
    const observed = await extensionCdp.command('Runtime.evaluate', {
      expression: '({ stage: globalThis.__axeE2eStage, result: globalThis.__axeE2eResult, error: globalThis.__axeE2eError, trace: globalThis.__axeE2eTrace })',
      returnByValue: true,
    });
    state = observed.result.value;
    debug(`adapter pending at: ${state.stage} (${state.trace.join(',')})`);
  }
  assert.equal(state?.stage, 'adapter-returned', state?.error || `adapter pending at ${state?.stage}`);
  debug('adapter evaluation returned');
  const result = state.result;

  assert.equal(result.status, 'complete', JSON.stringify({ diagnostics: result.diagnostics, trace: state.trace }));
  assert.equal(result.provenance.version, '4.13.0');
  assert.equal(result.provenance.config.rules['target-size'].enabled, true);
  assert.ok(result.frames.length >= 2, JSON.stringify(result));
  assert.ok(result.frames.every(frame => frame.status === 'success'));
  assert.ok(result.frames.some(frame => frame.result.violations.some(rule => rule.id === 'image-alt')));
  const top = result.frames.find(frame => frame.frameId === 0).result;
  for (const ruleId of ['image-alt', 'button-name', 'input-button-name']) {
    const nodes = top.violations.find(rule => rule.id === ruleId)?.nodes;
    assert.ok(nodes?.length > 0, `${ruleId} must exercise its fixture`);
    for (const node of nodes) {
      assert.notEqual(node.target, '[target-unavailable]', `${ruleId}: target lost through depth/custom/center ancestor`);
      const checked = await fixtureCdp.command('Runtime.evaluate', {
        expression: `document.querySelectorAll(${JSON.stringify(node.target)}).length`, returnByValue: true,
      });
      assert.equal(checked.result.value, 1, 'the returned structural selector must locate exactly one real element');
    }
  }
  assert.doesNotMatch(JSON.stringify(result), /private-customer-widget/);
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /unsafe-eval|EvalError|https?:/iu);
  debug('result assertions passed');
});

async function waitForDevToolsPort(profile, chrome) {
  const path = join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (chrome.exitCode !== null) throw new Error(`Chrome encerrou antes do CDP (${chrome.exitCode}).`);
    try {
      const [port] = (await readFile(path, 'utf8')).trim().split('\n');
      if (/^\d+$/u.test(port)) return Number(port);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await delay(50);
  }
  throw new Error('Chrome não publicou DevToolsActivePort.');
}

async function waitForPageContext(cdp, { expectedUrl, timeoutMs }) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const observed = await cdp.command('Runtime.evaluate', {
        expression: `({ href: globalThis.location?.href || '', readyState: globalThis.document?.readyState || '' })`,
        returnByValue: true,
      });
      if (!observed.exceptionDetails) latest = observed.result?.value ?? null;
    } catch { latest = null; }
    if (latest?.href === expectedUrl && latest.readyState === 'complete') return latest;
    await delay(50);
  }
  throw new Error(`fixture não estabilizou: ${JSON.stringify(latest)}`);
}

async function waitForExtensionContext(cdp, { extensionUrl, extensionId, timeoutMs }) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const observed = await cdp.command('Runtime.evaluate', {
        expression: `(() => ({
          href: globalThis.location?.href || '',
          readyState: globalThis.document?.readyState || '',
          extensionId: globalThis.chrome?.runtime?.id || null
        }))()`,
        returnByValue: true,
      });
      if (!observed.exceptionDetails) latest = observed.result?.value ?? null;
    } catch { latest = null; }
    if (latest?.href === extensionUrl && latest.readyState === 'complete' && latest.extensionId === extensionId) {
      return latest;
    }
    await delay(50);
  }
  throw new Error(`contexto da extensão não estabilizou: ${JSON.stringify(latest)}`);
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

class Cdp {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, rejectOpen) => {
      socket.addEventListener('open', resolveOpen, { once: true });
      socket.addEventListener('error', rejectOpen, { once: true });
    });
    return new Cdp(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve: resolveCommand, reject: rejectCommand } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) rejectCommand(new Error(message.error.message));
      else resolveCommand(message.result);
    });
  }

  command(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolveCommand, rejectCommand) => {
      this.pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
      this.socket.send(JSON.stringify(message));
    });
  }

  close() {
    this.socket.close();
  }
}
