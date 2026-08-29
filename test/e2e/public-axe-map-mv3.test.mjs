import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = join(root, 'test/e2e/fixtures');
const chromeBinary = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const expectedChromeProduct = 'Chrome/151.0.7922.174';
const expectedBrowser = 'Google Chrome 151.0.7922.174';
const privateMarkers = Object.freeze([
  'AXE-MAP-PRIVATE-TOKEN-847261',
  'AXE-MAP-PRIVATE-HTML-592314',
  'AXE-MAP-PRIVATE-FRAME-318405',
]);
const strictCsp = "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self' data:; frame-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; report-uri /csp-report";

test('audits through action → real panel → Auditar and downloads axe/map proof', { timeout: 300_000 }, async t => {
  await access(chromeBinary, fsConstants.X_OK);
  const loopback = await startLoopback();
  const profile = await mkdtemp(join(tmpdir(), 'audita-public-axe-map-'));
  const downloadDir = join(profile, 'downloads');
  await mkdir(downloadDir, { recursive: true });
  const chrome = spawn(chromeBinary, [
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
    '--remote-debugging-pipe', '--window-position=-10000,-10000', '--window-size=1280,800',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let chromeStderr = '';
  chrome.stderr.on('data', chunk => { chromeStderr = `${chromeStderr}${chunk}`.slice(-20_000); });
  t.after(async () => {
    try { await terminateChrome(chrome); }
    finally {
      await loopback.close();
      await rm(profile, { recursive: true, force: true });
    }
  });

  const browser = new PipeCdp(chrome.stdio[3], chrome.stdio[4]);
  t.after(() => browser.close());
  let version;
  try { version = await browser.command('Browser.getVersion'); }
  catch (error) {
    await delay(50);
    throw new Error(`Chrome real não iniciou o CDP: ${error.message}; exit=${chrome.exitCode}; signal=${chrome.signalCode}; stderr=${chromeStderr}`);
  }
  assert.equal(version.product, expectedChromeProduct);
  await browser.command('Target.setDiscoverTargets', { discover: true });
  await browser.command('Browser.setDownloadBehavior', {
    behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true,
  });

  const fixtureUrl = `${loopback.origin}/public-axe-map.html`;
  const response = await fetch(fixtureUrl);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-security-policy'), strictCsp);
  await response.arrayBuffer();
  const created = await browser.command('Target.createTarget', { url: fixtureUrl });
  const fixturePageInfo = await waitForTarget(browser,
    info => info.targetId === created.targetId && info.type === 'page' && info.url === fixtureUrl, chromeStderr);
  const fixturePage = await attach(browser, fixturePageInfo.targetId);
  await fixturePage.command('Runtime.enable');
  await fixturePage.command('Page.enable');
  await waitForValue(fixturePage, 'document.readyState === "complete"', Boolean);
  const fixtureTab = await waitForTarget(browser,
    info => info.type === 'tab' && info.url === fixtureUrl, chromeStderr, 20_000, [{ type: 'tab', exclude: false }, { exclude: true }]);
  await browser.command('Target.activateTarget', { targetId: fixturePageInfo.targetId });

  const loaded = await browser.command('Extensions.loadUnpacked', { path: root }, 20_000);
  const extensionId = loaded?.id;
  assert.match(extensionId || '', /^[a-p]{32}$/u);
  const installed = await browser.command('Extensions.getExtensions');
  assert.ok(installed.extensions?.some(extension => extension.id === extensionId && extension.name === 'Audita Acessibilidade'));
  await waitForStableTarget(browser, info => info.type === 'service_worker' &&
    info.url === `chrome-extension://${extensionId}/src/background/service-worker.js`, chromeStderr);

  const panelUrl = `chrome-extension://${extensionId}/src/panel/index.html`;
  await browser.command('Target.activateTarget', { targetId: fixtureTab.targetId });
  const beforeAction = new Set((await browser.command('Target.getTargets')).targetInfos.map(info => info.targetId));
  await browser.command('Extensions.triggerAction', { id: extensionId, targetId: fixtureTab.targetId }, 20_000);
  const panelInfo = await waitForTarget(browser, info => info.type === 'page' && info.url === panelUrl &&
    !beforeAction.has(info.targetId), chromeStderr, 30_000);
  const panel = await attach(browser, panelInfo.targetId);
  await panel.command('Runtime.enable');
  await panel.command('Page.enable');
  await waitForValue(panel, 'document.readyState === "complete"', Boolean);
  await waitForValue(panel, '!document.querySelector(\'#audit-form button[type="submit"]\')?.disabled', Boolean, 20_000);

  const submitted = await evaluate(panel, `(() => {
    const form = document.querySelector('#audit-form');
    const input = document.querySelector('#audit-url');
    const submit = form?.querySelector('button[type="submit"]');
    if (!form || !input || !submit || submit.disabled || submit.textContent.trim() !== 'Auditar') return {
      submitted: false,
      form: Boolean(form),
      input: Boolean(input),
      submit: Boolean(submit),
      disabled: submit?.disabled ?? null,
      label: submit?.textContent?.trim() ?? null,
      href: location.href,
      readyState: document.readyState,
    };
    input.value = ${JSON.stringify(fixtureUrl)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    submit.click();
    return { submitted: true };
  })()`);
  assert.equal(submitted?.submitted, true,
    `o botão público Auditar não iniciou a URL única: ${JSON.stringify(submitted)}`);

  const files = await waitForDownloadedFiles(downloadDir, panel, 240_000);
  assert.deepEqual(files.map(name => extname(name)).sort(), ['.csv', '.html', '.json', '.pdf']);
  const jsonName = files.find(name => extname(name) === '.json');
  const htmlName = files.find(name => extname(name) === '.html');
  const [jsonBytes, html] = await Promise.all([
    readFile(join(downloadDir, jsonName), 'utf8'),
    readFile(join(downloadDir, htmlName), 'utf8'),
  ]);
  const technical = JSON.parse(jsonBytes.replace(/^\uFEFF/u, ''));
  const audit = technical.audit;

  assert.equal(technical.schemaVersion, 2);
  assert.equal(technical.assertions.length, 146);
  assert.equal(audit.schemaVersion, 2);
  assert.equal(audit.requestedScope.mode, 'single');
  assert.equal(audit.pages.length, 1);
  assert.equal(audit.axe.status, 'complete', JSON.stringify({
    diagnostics: audit.axe.diagnostics,
    limitations: audit.axe.limitations,
  }));
  assert.deepEqual(audit.axe.diagnostics, []);
  assert.deepEqual(audit.axe.limitations, []);
  assert.equal(JSON.stringify(audit.axe).includes('AXE_RESULTS_TRUNCATED'), false);
  assert.equal(audit.axe.provenance.version, '4.13.0');
  assert.equal(audit.axe.provenance.config.preload, false);
  assert.equal(audit.axe.provenance.config.iframes, false);
  assert.deepEqual(audit.axe.provenance.config.rules['target-size'], { enabled: true });
  assert.deepEqual(audit.axe.provenance.gate, {
    enabled: true,
    targetSizeEnabled: true,
    code: 'AXE_MV3_CSP_E2E_PASSED',
    testedBrowser: expectedBrowser,
  });

  const targetSize = audit.occurrences.filter(occurrence => occurrence.source?.engine === 'axe-core' &&
    occurrence.source.engineRuleId === 'target-size');
  const topAxe = targetSize.find(occurrence => occurrence.target.framePath.length === 0);
  const frameAxe = targetSize.find(occurrence => occurrence.target.framePath.length > 0);
  const coreRule = audit.ruleResults.find(rule => rule.source?.engine === 'audita-core' &&
    rule.ruleId === 'target-size-minimum');
  assert.ok(topAxe, 'o axe não publicou target-size no documento principal');
  assert.equal(coreRule?.outcome, 'cantTell', 'exceções equivalente/essencial não podem ser descartadas automaticamente');
  assert.equal(topAxe.outcome, 'cantTell');
  assert.match(topAxe.nodeId || '', /^n-/u);
  assert.equal(topAxe.target.nodeId, topAxe.nodeId);
  assert.equal(topAxe.presentationTargetKey, `node:${topAxe.nodeId}`);
  assert.equal(topAxe.applicabilityEvidence, null);
  assert.deepEqual(topAxe.testedWcagRefs, []);
  assert.deepEqual(topAxe.foreignBenchmarkRefs, []);
  assert.equal(topAxe.legalAnalysis, null);
  assert.ok(audit.manualReview.some(entry => entry.occurrenceId === topAxe.occurrenceId));
  assert.ok(audit.axe.ruleResults.find(rule => rule.ruleId === 'axe.target-size')?.limitations
    .includes('A aplicabilidade ABNT não foi confirmada; o resultado permanece cantTell.'));
  assert.equal(frameAxe?.outcome, 'cantTell');
  assert.equal(frameAxe?.nodeId, null);
  assert.deepEqual(frameAxe?.testedWcagRefs, []);
  assert.equal(frameAxe?.legalAnalysis, null);

  const original = audit.evidence.find(artifact => artifact.kind === 'full-page' && artifact.state === 'pristine');
  const map = audit.evidence.find(artifact => artifact.kind === 'announcement-map' && artifact.state === 'derived');
  assert.ok(original, 'a captura pristine não chegou ao relatório técnico');
  assert.ok(map, 'o wrapper produtivo não publicou o mapa derivado');
  assert.equal(map.fullPageEvidenceId, original.evidenceId);
  assert.equal(map.derivation.sourceEvidenceId, original.evidenceId);
  assert.equal(map.derivation.sourceHash, original.hash);
  assert.match(original.hash, /^[a-f0-9]{64}$/u);
  assert.match(map.hash, /^[a-f0-9]{64}$/u);
  assert.match(map.derivation.geometrySnapshotHash, /^[a-f0-9]{64}$/u);
  assert.ok(map.segments.length > 0);
  assert.ok(map.legend.length > 0);
  assert.ok(map.segments.every(segment => /^[a-f0-9]{64}$/u.test(segment.contentHash)));
  assert.match(html, /data-announcement-map-page="page-1"/u);
  assert.match(html, new RegExp(map.hash, 'u'));
  assert.match(html, new RegExp(original.hash, 'u'));

  const publicTextOutputs = [html, chromeStderr, ...loopback.cspReports];
  for (const marker of privateMarkers) {
    assert.deepEqual(pathsContaining(technical, marker), [], 'o JSON técnico contém marcador privado');
    for (const output of publicTextOutputs) {
      assert.equal(output.includes(marker), false, 'uma saída pública textual contém marcador privado');
    }
  }
  assert.equal(loopback.cspReports.length, 0, `violações CSP: ${loopback.cspReports.join(' ')}`);
  assert.doesNotMatch(`${html}\n${chromeStderr}\n${loopback.cspReports.join('\n')}`, /unsafe-eval|EvalError/iu);
});

function pathsContaining(value, marker, path = '$', output = [], seen = new WeakSet()) {
  if (typeof value === 'string') {
    if (value.includes(marker)) output.push(path);
    return output;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) value.forEach((entry, index) => pathsContaining(entry, marker, `${path}[${index}]`, output, seen));
  else for (const [key, entry] of Object.entries(value)) pathsContaining(entry, marker, `${path}.${key}`, output, seen);
  return output;
}

async function startLoopback() {
  const cspReports = [];
  const files = new Map([
    ['/public-axe-map.html', ['public-axe-map.html', 'text/html; charset=utf-8', true]],
    ['/public-axe-map-frame.html', ['public-axe-map-frame.html', 'text/html; charset=utf-8', true]],
    ['/public-axe-map.css', ['public-axe-map.css', 'text/css; charset=utf-8', false]],
  ]);
  const server = createServer(async (request, response) => {
    if (request.url === '/csp-report' && request.method === 'POST') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { if (body.length < 16_384) body += chunk; });
      request.on('end', () => { cspReports.push(body.slice(0, 16_384)); response.writeHead(204); response.end(); });
      return;
    }
    const fixture = files.get(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!fixture) { response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); response.end('not found'); return; }
    const [name, contentType, html] = fixture;
    response.writeHead(200, {
      'content-type': contentType,
      ...(html ? { 'content-security-policy': strictCsp } : {}),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(await readFile(join(fixtureRoot, name)));
  });
  await new Promise((resolveListen, rejectListen) => server.listen(0, '127.0.0.1', error =>
    error ? rejectListen(error) : resolveListen()));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    cspReports,
    close: () => new Promise(resolveClose => server.close(resolveClose)),
  };
}

async function waitForDownloadedFiles(directory, panel, timeoutMs) {
  const started = Date.now();
  let latest = [];
  while (Date.now() - started < timeoutMs) {
    latest = await readdir(directory);
    const terminal = latest.filter(name => ['.csv', '.html', '.json', '.pdf'].includes(extname(name)));
    const temporary = latest.filter(name => /(?:\.crdownload|\.tmp)$/iu.test(name));
    if (terminal.length === 4 && temporary.length === 0) {
      const sizes = await Promise.all(terminal.map(name => stat(join(directory, name)).then(value => value.size)));
      if (sizes.every(size => size > 0)) return terminal.sort();
    }
    await delay(250);
  }
  const status = await evaluate(panel, 'document.querySelector(\'#audit-status\')?.textContent || ""').catch(() => 'unavailable');
  throw new Error(`downloads públicos não concluíram; arquivos=${latest.length}; status=${String(status).slice(0, 200)}`);
}

async function waitForTarget(browser, predicate, stderr, timeoutMs = 20_000, filter = undefined) {
  const started = Date.now();
  let latest = [];
  while (Date.now() - started < timeoutMs) {
    const targets = await browser.command('Target.getTargets', filter ? { filter } : {});
    latest = targets.targetInfos || [];
    const target = latest.find(predicate);
    if (target) return target;
    await delay(50);
  }
  const summary = latest.map(info => `${info.type}:${safeTargetUrl(info.url)}`).join(',');
  throw new Error(`target público não apareceu; targets=${summary}; lifecycle=${browser.targetLifecycleSummary()}; stderr=${String(stderr).slice(-2_000)}`);
}

async function waitForStableTarget(browser, predicate, stderr, timeoutMs = 20_000) {
  const started = Date.now();
  let stableTargetId = null;
  let stableObservations = 0;
  while (Date.now() - started < timeoutMs) {
    const targets = await browser.command('Target.getTargets');
    const target = (targets.targetInfos || []).find(predicate);
    if (!target) { stableTargetId = null; stableObservations = 0; }
    else if (target.targetId === stableTargetId) {
      stableObservations += 1;
      if (stableObservations >= 20) return target;
    } else {
      stableTargetId = target.targetId;
      stableObservations = 1;
    }
    await delay(50);
  }
  throw new Error(`worker produtivo não estabilizou; stderr=${String(stderr).slice(-2_000)}`);
}

function safeTargetUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
  } catch { return 'sem-url'; }
}

async function attach(browser, targetId) {
  const attached = await browser.command('Target.attachToTarget', { targetId, flatten: true });
  return new Session(browser, attached.sessionId);
}

async function evaluate(session, expression, awaitPromise = false, timeoutMs = 20_000) {
  const evaluated = await session.command('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: false,
  }, timeoutMs);
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
  return evaluated.result?.value;
}

async function waitForValue(session, expression, predicate, timeoutMs = 20_000) {
  const started = Date.now();
  let latest;
  while (Date.now() - started < timeoutMs) {
    latest = await evaluate(session, expression, true, Math.min(20_000, timeoutMs));
    if (predicate(latest)) return latest;
    await delay(50);
  }
  throw new Error(`valor público não estabilizou; observado=${JSON.stringify(latest)}`);
}

function terminateChrome(chrome, timeoutMs = 5_000) {
  if (chrome.exitCode !== null) return Promise.resolve(true);
  return new Promise(resolveExit => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.off('exit', onExit);
      resolveExit(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.once('exit', onExit);
    try { chrome.kill('SIGKILL'); } catch { finish(false); }
  });
}

function delay(ms) { return new Promise(resolveDelay => setTimeout(resolveDelay, ms)); }

class Session {
  constructor(browser, sessionId) { this.browser = browser; this.sessionId = sessionId; }
  command(method, params = {}, timeoutMs) { return this.browser.command(method, params, timeoutMs, this.sessionId); }
}

class PipeCdp {
  constructor(commandPipe, responsePipe) {
    this.commandPipe = commandPipe;
    this.responsePipe = responsePipe;
    this.nextId = 1;
    this.pending = new Map();
    this.targetLifecycle = [];
    this.buffer = Buffer.alloc(0);
    responsePipe.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let delimiter;
      while ((delimiter = this.buffer.indexOf(0)) >= 0) {
        const frame = this.buffer.subarray(0, delimiter);
        this.buffer = this.buffer.subarray(delimiter + 1);
        if (!frame.length) continue;
        const message = JSON.parse(frame.toString('utf8'));
        if (!message.id) {
          if (['Target.targetCreated', 'Target.targetInfoChanged', 'Target.targetDestroyed'].includes(message.method)) {
            const info = message.params?.targetInfo;
            this.targetLifecycle.push(message.method === 'Target.targetDestroyed'
              ? `destroyed:${message.params?.targetId || 'unknown'}`
              : `${message.method.slice('Target.'.length)}:${info?.targetId || 'unknown'}:${info?.type || 'unknown'}:${safeTargetUrl(info?.url)}`);
            if (this.targetLifecycle.length > 100) this.targetLifecycle.shift();
          }
          continue;
        }
        if (!this.pending.has(message.id)) continue;
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
        pending.reject(new Error('CDP_CLOSED'));
      }
      this.pending.clear();
    });
  }

  command(method, params = {}, timeoutMs = 30_000, sessionId = undefined) {
    const id = this.nextId++;
    const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCommand(new Error(`CDP_TIMEOUT_${method.replace(/[^A-Za-z0-9]/gu, '_')}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
      this.commandPipe.write(`${JSON.stringify(message)}\0`);
    });
  }

  targetLifecycleSummary() { return this.targetLifecycle.slice(-30).join(','); }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CDP_CLOSED'));
    }
    this.pending.clear();
    try { this.commandPipe.destroy(); } catch { /* Chrome pode já ter encerrado. */ }
    try { this.responsePipe.destroy(); } catch { /* Chrome pode já ter encerrado. */ }
  }
}
