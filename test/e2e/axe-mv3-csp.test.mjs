import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AXE_MV3_CSP_GATE, AXE_RUN_CONFIG } from '../../src/browser/axe-adapter.js';
import { decideAxeE2eExecution } from '../../scripts/axe-e2e-decision.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtures = join(root, 'test', 'e2e', 'fixtures');
const chromeBinary = process.env.CHROME_BIN;
const strictCsp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'; base-uri 'none'; form-action 'none'";
const debug = message => { if (process.env.AUDITA_E2E_DEBUG === '1') process.stderr.write(`[axe-e2e] ${message}\n`); };

test('runs pinned local axe in every isolated frame under real MV3 and strict page CSP', { timeout: 45_000 }, async t => {
  const server = createServer(async (request, response) => {
    debug(`fixture request: ${request.url}`);
    const name = request.url === '/axe-csp-frame.html' ? 'axe-csp-frame.html' : 'axe-csp.html';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': strictCsp });
    response.end(await readFile(join(fixtures, name)));
  });
  await new Promise((resolveListen, rejectListen) => server.listen(0, '127.0.0.1', error => error ? rejectListen(error) : resolveListen()));
  debug('fixture server listening');
  t.after(() => new Promise(resolveClose => server.close(resolveClose)));
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

  const profile = await mkdtemp(join(tmpdir(), 'audita-axe-chrome-'));
  const chrome = spawn(chromeBinary, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    `--disable-extensions-except=${root}`, `--load-extension=${root}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeStderr = '';
  chrome.stderr.on('data', chunk => { chromeStderr = `${chromeStderr}${chunk}`.slice(-8_000); });
  t.after(async () => {
    if (chrome.exitCode === null) {
      const exited = new Promise(resolveExit => chrome.once('exit', resolveExit));
      chrome.kill('SIGKILL');
      await exited;
    }
    await rm(profile, { recursive: true, force: true });
  });

  const port = await waitForDevToolsPort(profile, chrome);
  debug(`DevTools active on ${port}`);
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(value => value.json());
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  debug('browser CDP connected');
  t.after(() => cdp.close());

  const id = extensionId(root);
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
  t.after(() => extensionCdp.close());
  debug('real extension panel CDP connected');
  const expression = `(() => {
    globalThis.__axeE2eResult = null;
    globalThis.__axeE2eError = null;
    globalThis.__axeE2eTrace = [];
    globalThis.__axeE2eStage = 'create-fixture-tab';
    chrome.tabs.create({ url: ${JSON.stringify(fixtureUrl)}, active: false }).then(tab => new Promise((resolveTab, rejectTab) => {
      const startedAt = Date.now();
      const check = () => chrome.tabs.get(tab.id).then(current => {
        if (current.status === 'complete' && current.url === ${JSON.stringify(fixtureUrl)}) resolveTab(current);
        else if (Date.now() - startedAt >= 10000) rejectTab(new Error('fixture tab did not complete'));
        else setTimeout(check, 50);
      }, rejectTab);
      check();
    })).then(tab => {
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

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function extensionId(path) {
  const alphabet = 'abcdefghijklmnop';
  return [...createHash('sha256').update(path).digest().subarray(0, 16)]
    .map(byte => `${alphabet[byte >> 4]}${alphabet[byte & 15]}`).join('');
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
