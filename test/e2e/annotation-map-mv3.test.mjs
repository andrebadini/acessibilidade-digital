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
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(value => value.json());
  const browser = await Cdp.connect(version.webSocketDebuggerUrl);
  t.after(() => browser.close());
  const id = extensionId(root);
  await browser.command('Target.createTarget', { url: `chrome-extension://${id}/src/panel/index.html` });

  let worker;
  for (let attempt = 0; attempt < 120 && !worker; attempt += 1) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(value => value.json());
    worker = targets.find(target => target.type === 'service_worker' &&
      target.url === `chrome-extension://${id}/src/background/service-worker.js` && target.webSocketDebuggerUrl);
    if (!worker) await delay(50);
  }
  assert.ok(worker, `service worker MV3 real não apareceu: ${chromeStderr}`);
  const serviceWorker = await Cdp.connect(worker.webSocketDebuggerUrl);
  t.after(() => serviceWorker.close());
  await serviceWorker.command('Runtime.enable');

  const expression = `(async () => {
    try {
      const module = await import(chrome.runtime.getURL('src/browser/annotation-map.js'));
      const source = {
        evidenceId: 'full-page-e2e', pageId: 'page-1', kind: 'full-page', state: 'pristine',
        dataUrl: ${JSON.stringify(sourcePng)}, hash: ${JSON.stringify(sourceHash)}, metadata: {}
      };
      const before = JSON.stringify(source);
      const artifact = await module.composeAnnouncementMap({
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
    }
  })()`;
  const evaluated = await serviceWorker.command('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
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
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  command(method, params = {}, timeoutMs = 5_000) {
    const id = this.nextId++;
    return new Promise((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCommand(new Error(`CDP timeout em ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CDP encerrado.'));
    }
    this.pending.clear();
    this.socket.close();
  }
}
