import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { ANNOTATION_MAP_MV3_GATE } from '../../src/browser/annotation-map.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const chromeBinary = process.env.CHROME_BIN;
const sourceBytes = pngBytes(300, 100);
const sourcePng = `data:image/png;base64,${Buffer.from(sourceBytes).toString('base64')}`;
const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngBytes(width, height) {
  const chunk = (type, data) => {
    const typeBytes = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
    return Buffer.concat([length, typeBytes, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const raster = Buffer.alloc(height * (1 + width * 4), 255);
  for (let row = 0; row < height; row += 1) raster[row * (1 + width * 4)] = 0;
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raster)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

test('composes the strict annotation map inside the real MV3 service worker under extension CSP', { timeout: 45_000 }, async t => {
  if (!chromeBinary && ANNOTATION_MAP_MV3_GATE.enabled === false) {
    assert.equal(ANNOTATION_MAP_MV3_GATE.code, 'ANNOTATION_MAP_MV3_E2E_UNAVAILABLE');
    t.skip(ANNOTATION_MAP_MV3_GATE.code);
    return;
  }
  assert.ok(chromeBinary, 'CHROME_BIN é obrigatório para o gate E2E real do compositor.');
  const profile = await mkdtemp(join(tmpdir(), 'audita-map-chrome-'));
  const chrome = spawn(chromeBinary, [
    '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--remote-debugging-pipe',
    '--window-position=-10000,-10000', '--window-size=1280,800',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
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

  const browser = new PipeCdp(chrome.stdio[3], chrome.stdio[4]);
  t.after(() => browser.close());
  await browser.command('Browser.getVersion');
  await browser.command('Target.setDiscoverTargets', { discover: true });
  let loaded;
  try { loaded = await browser.command('Extensions.loadUnpacked', { path: root }, 15_000); }
  catch (error) {
    await delay(50);
    throw new Error(`ANNOTATION_MAP_MV3_EXTENSIONS_LOAD_FAILED: ${error.message}; exit=${chrome.exitCode}; signal=${chrome.signalCode}; stderr=${chromeStderr}`);
  }
  const id = loaded?.id;
  assert.match(id || '', /^[a-p]{32}$/u, JSON.stringify(loaded));
  const installed = await browser.command('Extensions.getExtensions');
  assert.ok(installed.extensions?.some(extension => extension.id === id && extension.name === 'Audita Acessibilidade'));
  const workerUrl = `chrome-extension://${id}/src/background/service-worker.js`;
  const annotationUrl = `chrome-extension://${id}/src/browser/annotation-map.js`;
  const initialWorkerInfo = await waitForTargetInfo(browser,
    info => info.type === 'service_worker' && info.url === workerUrl, chromeStderr);
  await browser.command('Extensions.uninstall', { id });
  await waitForTargetGone(browser, initialWorkerInfo.targetId, chromeStderr, 15_000);
  await browser.command('Target.setAutoAttach', {
    autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [{ type: 'service_worker', exclude: false }, { exclude: true }],
  });
  const reloadCursor = browser.eventCursor();
  const reloadCommand = browser.command('Extensions.loadUnpacked', { path: root }, 15_000);
  const attached = await browser.waitForEvent(reloadCursor, 'Target.attachedToTarget', params =>
    params?.waitingForDebugger === true && params?.targetInfo?.type === 'service_worker' &&
    params.targetInfo.url === workerUrl && params.targetInfo.targetId !== initialWorkerInfo.targetId, 15_000);
  const serviceWorker = new SessionCdp(browser, attached.params.sessionId);
  await serviceWorker.command('Runtime.enable');
  await serviceWorker.command('Debugger.enable');
  const workerSource = await readFile(join(root, 'src/background/service-worker.js'), 'utf8');
  const annotationSource = await readFile(join(root, 'src/browser/annotation-map.js'), 'utf8');
  const adapterBreakpoint = await setBreakpointAtMarker(
    serviceWorker, workerUrl, workerSource, 'export function registerServiceWorker', 1,
  );
  const wrapperBreakpoint = await setBreakpointAtMarker(
    serviceWorker, annotationUrl, annotationSource, 'export async function composeAnnouncementMapForProduction', 1,
  );
  const adapterPauseCursor = browser.eventCursor();
  await serviceWorker.command('Runtime.runIfWaitingForDebugger');
  const adapterPaused = await browser.waitForEvent(adapterPauseCursor, 'Debugger.paused', params =>
    params?.hitBreakpoints?.includes(adapterBreakpoint) &&
    params.callFrames?.some(frame => frame.functionName === 'registerServiceWorker'),
  15_000, attached.params.sessionId);
  const adapterFrame = adapterPaused.params.callFrames.find(frame =>
    frame.functionName === 'registerServiceWorker');
  await evaluateOnCallFrame(serviceWorker, adapterFrame.callFrameId,
    'globalThis.__auditaAnnotationMapAdapter = createChromeAdapter(chromeApi); true');
  await serviceWorker.command('Debugger.removeBreakpoint', { breakpointId: adapterBreakpoint });
  await serviceWorker.command('Debugger.resume');
  const reloaded = await reloadCommand;
  assert.equal(reloaded?.id, id, JSON.stringify(reloaded));

  const wrapperPauseCursor = browser.eventCursor();
  const wrapperCommand = serviceWorker.command('Runtime.evaluate', {
    expression: `globalThis.__auditaAnnotationMapWrapperProbe =
      globalThis.__auditaAnnotationMapAdapter.composeAnnouncementMap({}).catch(error => ({
        code: String(error?.code || ''), name: String(error?.name || '')
      })); true`,
    returnByValue: true, allowUnsafeEvalBlockedByCSP: false,
  }, 15_000);
  const wrapperPaused = await browser.waitForEvent(wrapperPauseCursor, 'Debugger.paused', params =>
    params?.hitBreakpoints?.includes(wrapperBreakpoint) &&
    params.callFrames?.some(frame => frame.functionName === 'composeAnnouncementMapForProduction'),
  15_000, attached.params.sessionId);
  const wrapperFrame = wrapperPaused.params.callFrames.find(frame =>
    frame.functionName === 'composeAnnouncementMapForProduction');
  await evaluateOnCallFrame(serviceWorker, wrapperFrame.callFrameId,
    'globalThis.__auditaAnnotationMapRaw = composeAnnouncementMap; true');
  await serviceWorker.command('Debugger.removeBreakpoint', { breakpointId: wrapperBreakpoint });
  await serviceWorker.command('Debugger.resume');
  await wrapperCommand;
  const wrapperProbe = await evaluate(serviceWorker,
    'globalThis.__auditaAnnotationMapWrapperProbe', true);
  assert.deepEqual(wrapperProbe, {
    code: 'ANNOTATION_MAP_MV3_E2E_UNAVAILABLE', name: 'AnnotationMapError',
  });

  const expression = `(async () => {
    try {
      const source = {
        evidenceId: 'full-page-e2e', pageId: 'page-1', kind: 'full-page', state: 'pristine',
        dataUrl: ${JSON.stringify(sourcePng)}, hash: ${JSON.stringify(sourceHash)}, metadata: {}
      };
      const before = JSON.stringify(source);
      const artifact = await globalThis.__auditaAnnotationMapRaw({
        pageId: 'page-1', fullPageEvidence: source, timeoutMs: 10000,
        layoutMetrics: { cssContentSize: { width: 300, height: 100 }, deviceScaleFactor: 2 },
        snapshot: {
          schemaVersion: 1,
          document: { nodeId: 'document', title: 'Fixture MV3', url: 'https://example.test/' },
          nodes: [{
            nodeId: 'n-1', parentId: null, children: [], tagName: 'button', attributes: {}, framePath: [], hidden: false,
            accessibleName: 'Executar auditoria', axRole: 'button', rect: { x: 10, y: 10, width: 180, height: 30 }
          }]
        }
      });
      return {
        api: { offscreenCanvas: typeof OffscreenCanvas, createImageBitmap: typeof createImageBitmap },
        status: artifact.status, segments: artifact.segments.length, legend: artifact.legend.length,
        sourceUnchanged: JSON.stringify(source) === before,
        hash: artifact.hash, geometryHash: artifact.derivation.geometrySnapshotHash,
        segmentHash: artifact.segments[0]?.contentHash,
        png: artifact.segments[0]?.dataUrl.startsWith('data:image/png;base64,') === true,
      };
    } catch (error) {
      return { errorName: String(error?.name || 'Error'), errorCode: String(error?.code || ''), errorMessage: String(error?.message || error).slice(0, 500) };
    } finally {
      delete globalThis.__auditaAnnotationMapRaw;
      delete globalThis.__auditaAnnotationMapAdapter;
      delete globalThis.__auditaAnnotationMapWrapperProbe;
    }
  })()`;
  const evaluated = await serviceWorker.command('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: false,
  }, 20_000);
  const result = evaluated.result?.value;

  assert.equal(evaluated.exceptionDetails, undefined, JSON.stringify(evaluated.exceptionDetails));
  assert.deepEqual(result?.api, { offscreenCanvas: 'function', createImageBitmap: 'function' });
  assert.equal(result?.status, 'complete', JSON.stringify(result));
  assert.equal(result?.segments, 1);
  assert.equal(result?.legend, 1);
  assert.equal(result?.sourceUnchanged, true);
  assert.equal(result?.png, true);
  for (const key of ['hash', 'geometryHash', 'segmentHash']) assert.match(result[key], /^[a-f0-9]{64}$/u, key);
  assert.deepEqual(await evaluate(serviceWorker, `({
    raw: Object.hasOwn(globalThis, '__auditaAnnotationMapRaw'),
    adapter: Object.hasOwn(globalThis, '__auditaAnnotationMapAdapter'),
    probe: Object.hasOwn(globalThis, '__auditaAnnotationMapWrapperProbe')
  })`), { raw: false, adapter: false, probe: false });
  await serviceWorker.command('Debugger.disable');
});

async function evaluate(cdp, expression, awaitPromise = false) {
  const evaluated = await cdp.command('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: false,
  });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
  return evaluated.result?.value;
}

async function evaluateOnCallFrame(cdp, callFrameId, expression) {
  const evaluated = await cdp.command('Debugger.evaluateOnCallFrame', {
    callFrameId, expression, returnByValue: true, silent: false,
  });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
  return evaluated.result?.value;
}

async function setBreakpointAtMarker(cdp, url, source, marker, lineOffset = 0) {
  const lineNumber = source.split('\n').findIndex(line => line.includes(marker));
  assert.ok(lineNumber >= 0, marker);
  const breakpoint = await cdp.command('Debugger.setBreakpointByUrl', {
    url, lineNumber: lineNumber + lineOffset, columnNumber: 0,
  });
  assert.equal(typeof breakpoint.breakpointId, 'string');
  return breakpoint.breakpointId;
}

async function waitForTargetInfo(browser, predicate, stderr) {
  let latest = [];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const targets = await browser.command('Target.getTargets');
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

  async waitForEvent(cursor, method, predicate, timeoutMs = 10_000, sessionId = undefined) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const event = this.events.find(candidate => candidate.sequence > cursor && candidate.method === method &&
        (!sessionId || candidate.sessionId === sessionId) && predicate(candidate.params));
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
