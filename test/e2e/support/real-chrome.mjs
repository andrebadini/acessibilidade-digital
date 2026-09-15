import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access, chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const MAX_CDP_FRAME_BYTES = 16 * 1024 * 1024;
export const CANONICAL_CHROME_PRODUCT = 'Chrome/152.0.7977.64';
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const HARNESS_PATH = '/test/e2e/fixtures/real-tab-harness.html';
const BLANK_PATH = '/test/e2e/fixtures/real-tab-blank.html';
const EXTENSION_PAGE_SCHEMAS = Object.freeze({
  [HARNESS_PATH]: Object.freeze([]),
  '/src/panel/index.html': Object.freeze([]),
  '/src/review/index.html': Object.freeze(['auditId']),
  '/src/export/index.html': Object.freeze(['auditId']),
  '/test/e2e/fixtures/retention-harness.html': Object.freeze([]),
});
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const PANEL_LAUNCH_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const METHOD = /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/u;
const OPERATION_ID = /^[A-Za-z0-9_-]{1,96}$/u;
const CHROME_ID = /^[a-p]{32}$/u;
const ATTRIBUTE = /^[A-Za-z_:][A-Za-z0-9_.:-]{0,127}$/u;
const QA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.png$/u;
const CONTEXT_TYPES = new Set(['BACKGROUND', 'POPUP', 'SIDE_PANEL', 'TAB', 'OFFSCREEN_DOCUMENT']);
const DOWNLOAD_FORMATS = Object.freeze(['html', 'pdf', 'csv', 'json']);
const DOWNLOAD_MIME = Object.freeze({
  html: 'text/html;charset=utf-8', pdf: 'application/pdf', csv: 'text/csv;charset=utf-8', json: 'application/json;charset=utf-8',
});
const DECLARED_SHORTCUTS = new WeakMap();

function fixed(code) {
  return Object.assign(new Error(code), { code });
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function resolveRealChromeTestBinary(env = process.env) {
  if (!env || typeof env !== 'object') throw fixed('CHROME_BINARY_INVALID');
  const primary = env.AUDITA_E2E_CHROME;
  const fallback = env.CHROME_BIN;
  if (primary !== undefined && typeof primary !== 'string') throw fixed('CHROME_BINARY_INVALID');
  if (fallback !== undefined && typeof fallback !== 'string') throw fixed('CHROME_BINARY_INVALID');
  return primary || fallback || null;
}

function canonicalAbsolute(value) {
  return typeof value === 'string' && isAbsolute(value) && resolve(value) === value;
}

function safeChromeFlagPath(value) {
  return canonicalAbsolute(value) && !/[\0\r\n,]/u.test(value);
}

export async function resolveUnpackedExtensionPath(value) {
  if (!safeChromeFlagPath(value)) throw fixed('EXTENSION_PATH_INVALID');
  const entry = await lstat(value).catch(() => null);
  if (!entry?.isDirectory() || entry.isSymbolicLink() || await realpath(value).catch(() => null) !== value) {
    throw fixed('EXTENSION_PATH_INVALID');
  }
  const manifestPath = join(value, 'manifest.json');
  const manifest = await lstat(manifestPath).catch(() => null);
  if (!manifest?.isFile() || manifest.isSymbolicLink() || await realpath(manifestPath).catch(() => null) !== manifestPath) {
    throw fixed('EXTENSION_PATH_INVALID');
  }
  return value;
}

export function buildChromeLaunchArgv(raw = {}) {
  const keys = ['chromeBinary', 'extensionPath', 'platform', 'startUrl', 'userDataDir', 'viewport'];
  if (!plain(raw) || Reflect.ownKeys(raw).length !== keys.length ||
    Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !keys.includes(key)) ||
    !canonicalAbsolute(raw.chromeBinary) || !safeChromeFlagPath(raw.extensionPath) ||
    !safeChromeFlagPath(raw.userDataDir) || !['darwin', 'linux', 'win32'].includes(raw.platform) ||
    raw.startUrl !== 'about:blank' || !plain(raw.viewport) ||
    Reflect.ownKeys(raw.viewport).length !== 2 || !positiveInteger(raw.viewport.width) || !positiveInteger(raw.viewport.height)) {
    const code = typeof raw?.extensionPath === 'string' && !safeChromeFlagPath(raw.extensionPath)
      ? 'EXTENSION_PATH_INVALID'
      : 'CHROME_LAUNCH_INVALID';
    throw fixed(code);
  }
  const args = [
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    ...(raw.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    '--window-position=-10000,-10000', `--window-size=${raw.viewport.width},${raw.viewport.height}`,
    `--user-data-dir=${raw.userDataDir}`,
    `--disable-extensions-except=${raw.extensionPath}`,
    `--load-extension=${raw.extensionPath}`,
    raw.startUrl,
  ];
  return Object.freeze({
    file: raw.chromeBinary,
    args: Object.freeze(args),
    options: Object.freeze({ shell: false, stdio: Object.freeze(['ignore', 'ignore', 'ignore', 'pipe', 'pipe']) }),
  });
}

function safeOperationId(value = randomUUID().replaceAll('-', '')) {
  if (!OPERATION_ID.test(value ?? '')) throw fixed('HARNESS_OPERATION_DENIED');
  return value;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'chrome-extension:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch { return null; }
}

export function createCdpPipeTransport({
  readable, writable, maxFrameBytes = MAX_CDP_FRAME_BYTES, commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
} = {}) {
  if (!readable?.on || typeof writable?.write !== 'function' || !positiveInteger(maxFrameBytes) ||
    !positiveInteger(commandTimeoutMs)) throw fixed('CDP_TRANSPORT_INVALID');
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  let settled = false;
  let explicitlyClosed = false;
  const pending = new Map();
  const completed = new Set();
  const eventWaiters = new Set();
  let resolveClosed;
  let rejectClosed;
  const closed = new Promise((resolvePromise, rejectPromise) => {
    resolveClosed = resolvePromise;
    rejectClosed = rejectPromise;
  });
  // Consumers commonly observe `closed` only on failures; keep Node from treating
  // the internally owned promise as unhandled in successful command-only tests.
  void closed.catch(() => {});

  const settle = (error = null) => {
    if (settled) return;
    settled = true;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error ?? fixed('CDP_CLOSED'));
    }
    pending.clear();
    for (const waiter of eventWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error ?? fixed('CDP_CLOSED'));
    }
    eventWaiters.clear();
    if (error) rejectClosed(error); else resolveClosed(true);
  };

  const fatal = code => {
    const error = fixed(code);
    settle(error);
    try { readable.destroy?.(); } catch {}
    try { writable.destroy?.(); } catch {}
  };

  const deliverEvent = message => {
    for (const waiter of [...eventWaiters]) {
      if (waiter.method !== message.method || (waiter.sessionId !== undefined && waiter.sessionId !== message.sessionId)) continue;
      let matches = false;
      try { matches = waiter.predicate(message.params) === true; } catch { matches = false; }
      if (!matches) continue;
      eventWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message.params);
    }
  };

  const accept = message => {
    if (!plain(message)) return fatal('CDP_FRAME_INVALID');
    if (!Object.hasOwn(message, 'id')) {
      if (typeof message.method !== 'string') return fatal('CDP_FRAME_INVALID');
      deliverEvent(message);
      return;
    }
    if (!positiveInteger(message.id)) return fatal('CDP_FRAME_INVALID');
    if (completed.has(message.id)) return fatal('CDP_RESPONSE_DUPLICATE');
    const item = pending.get(message.id);
    if (!item) return fatal('CDP_RESPONSE_UNKNOWN');
    pending.delete(message.id);
    completed.add(message.id);
    clearTimeout(item.timer);
    if (plain(message.error)) item.reject(fixed('CDP_COMMAND_FAILED'));
    else if (Object.hasOwn(message, 'result') && plain(message.result)) item.resolve(message.result);
    else fatal('CDP_FRAME_INVALID');
  };

  const onData = chunk => {
    if (settled) return;
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) return fatal('CDP_FRAME_INVALID');
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    let delimiter;
    while ((delimiter = buffer.indexOf(0)) >= 0) {
      if (delimiter > maxFrameBytes) return fatal('CDP_FRAME_TOO_LARGE');
      const frame = buffer.subarray(0, delimiter);
      buffer = buffer.subarray(delimiter + 1);
      if (frame.length === 0) continue;
      let source;
      let message;
      try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(frame);
        message = JSON.parse(source);
      } catch { return fatal('CDP_FRAME_INVALID'); }
      accept(message);
      if (settled) return;
    }
    if (buffer.byteLength > maxFrameBytes) fatal('CDP_FRAME_TOO_LARGE');
  };
  const onStreamClosed = () => { if (!settled) settle(explicitlyClosed ? null : fixed('CDP_CLOSED')); };
  readable.on('data', onData);
  readable.on('error', () => fatal('CDP_CLOSED'));
  readable.on('close', onStreamClosed);
  writable.on?.('error', () => fatal('CDP_CLOSED'));

  const transport = {
    closed,
    command(method, params = {}, options = {}) {
      if (settled || !METHOD.test(method ?? '') || !plain(params) || !plain(options)) return Promise.reject(fixed('CDP_COMMAND_INVALID'));
      const timeoutMs = options.timeoutMs ?? commandTimeoutMs;
      const sessionId = options.sessionId;
      if (!positiveInteger(timeoutMs) || (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId))) {
        return Promise.reject(fixed('CDP_COMMAND_INVALID'));
      }
      const id = nextId++;
      const frame = Buffer.from(`${JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) })}\0`);
      if (frame.byteLength - 1 > maxFrameBytes) return Promise.reject(fixed('CDP_FRAME_TOO_LARGE'));
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          completed.add(id);
          rejectPromise(fixed('CDP_COMMAND_TIMEOUT'));
        }, timeoutMs);
        pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
        try { writable.write(frame); } catch {
          clearTimeout(timer);
          pending.delete(id);
          rejectPromise(fixed('CDP_CLOSED'));
        }
      });
    },
    waitForEvent(method, predicate = () => true, options = {}) {
      if (settled || !METHOD.test(method ?? '') || typeof predicate !== 'function' || !plain(options)) {
        return Promise.reject(fixed('CDP_EVENT_INVALID'));
      }
      const timeoutMs = options.timeoutMs ?? commandTimeoutMs;
      if (!positiveInteger(timeoutMs)) return Promise.reject(fixed('CDP_EVENT_INVALID'));
      return new Promise((resolvePromise, rejectPromise) => {
        const waiter = { method, predicate, sessionId: options.sessionId, resolve: resolvePromise, reject: rejectPromise, timer: null };
        waiter.timer = setTimeout(() => {
          eventWaiters.delete(waiter);
          rejectPromise(fixed('CDP_EVENT_TIMEOUT'));
        }, timeoutMs);
        eventWaiters.add(waiter);
      });
    },
    close() {
      if (settled || explicitlyClosed) return false;
      explicitlyClosed = true;
      const hadPending = pending.size > 0 || eventWaiters.size > 0;
      settle(hadPending ? fixed('CDP_CLOSED') : null);
      try { readable.destroy?.(); } catch {}
      try { writable.destroy?.(); } catch {}
      return true;
    },
  };
  return Object.freeze(transport);
}

export async function command(target, method, params = {}) {
  if (typeof target?.command !== 'function' || !METHOD.test(method ?? '') || !plain(params)) throw fixed('CDP_COMMAND_INVALID');
  return target.command(method, params);
}

export async function evaluate(target, expression, options = {}) {
  const normalized = typeof options === 'boolean' ? { awaitPromise: options } : options;
  if (typeof expression !== 'string' || !expression || !plain(normalized)) throw fixed('EVALUATION_DENIED');
  const result = await command(target, 'Runtime.evaluate', {
    expression,
    awaitPromise: normalized.awaitPromise === true,
    returnByValue: true,
    ...(normalized.userGesture === true ? { userGesture: true } : {}),
  });
  if (result?.exceptionDetails || !plain(result?.result) || !Object.hasOwn(result.result, 'value')) throw fixed('EVALUATION_FAILED');
  return result.result.value;
}

export async function click(target, selector) {
  if (typeof selector !== 'string' || !selector || selector.length > 512) throw fixed('CLICK_DENIED');
  const value = await evaluate(target, `(() => { const node=document.querySelector(${JSON.stringify(selector)}); if(!node||node.disabled)return false; node.click(); return true; })()`, { userGesture: true });
  if (value !== true) throw fixed('CLICK_DENIED');
  return true;
}

export async function waitForValue(target, expression, predicate, options = {}) {
  if (typeof predicate !== 'function' || !plain(options)) throw fixed('WAIT_INVALID');
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 50;
  if (!positiveInteger(timeoutMs) || !positiveInteger(intervalMs)) throw fixed('WAIT_INVALID');
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const value = await evaluate(target, expression, { awaitPromise: true });
      if (predicate(value)) return value;
    } catch { /* a navigation may rotate the execution context */ }
    if (Date.now() >= deadline) break;
    await new Promise(resolvePromise => setTimeout(resolvePromise, intervalMs));
  } while (true);
  throw fixed('WAIT_TIMEOUT');
}

export async function pressKey(target, descriptor) {
  if (!plain(descriptor) || typeof descriptor.key !== 'string' || !descriptor.key || typeof descriptor.code !== 'string' ||
    !descriptor.code || !Number.isSafeInteger(descriptor.virtualKeyCode) || descriptor.virtualKeyCode < 0 ||
    !Number.isSafeInteger(descriptor.modifiers ?? 0) || descriptor.modifiers < 0 || descriptor.modifiers > 15) throw fixed('KEY_DENIED');
  const params = {
    key: descriptor.key, code: descriptor.code, modifiers: descriptor.modifiers ?? 0,
    windowsVirtualKeyCode: descriptor.virtualKeyCode, nativeVirtualKeyCode: descriptor.virtualKeyCode,
  };
  let failed = false;
  try { await command(target, 'Input.dispatchKeyEvent', { type: descriptor.raw === true ? 'rawKeyDown' : 'keyDown', ...params }); } catch {
    failed = true;
  }
  try { await command(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...params }); } catch {
    failed = true;
  }
  if (failed) throw fixed('KEY_DISPATCH_FAILED');
  return true;
}

export async function pressShortcut(target, shortcut, options = {}) {
  if (!plain(options) || Reflect.ownKeys(options).length !== 0 || typeof shortcut !== 'string' ||
    (shortcut !== 'Shift+Tab' && !DECLARED_SHORTCUTS.get(target)?.has(shortcut))) throw fixed('SHORTCUT_DENIED');
  const parts = shortcut.split('+');
  const key = parts.at(-1);
  const modifiers = parts.slice(0, -1);
  const accepted = new Set(['Alt', 'Ctrl', 'Command', 'MacCtrl', 'Shift']);
  if (!key || modifiers.some(value => !accepted.has(value)) || new Set(modifiers).size !== modifiers.length) throw fixed('SHORTCUT_DENIED');
  const mask = modifiers.reduce((value, modifier) => value |
    (modifier === 'Alt' ? 1 : modifier === 'Ctrl' || modifier === 'MacCtrl' ? 2 : modifier === 'Command' ? 4 : 8), 0);
  const named = { Tab: ['Tab', 9], Enter: ['Enter', 13], Escape: ['Escape', 27] };
  const upper = key.length === 1 && /^[A-Za-z0-9]$/u.test(key) ? key.toUpperCase() : null;
  const mapping = named[key] ?? (upper ? [`Key${upper}`, upper.codePointAt(0)] : null);
  if (!mapping) throw fixed('SHORTCUT_DENIED');
  return pressKey(target, { key: upper ?? key, code: mapping[0], virtualKeyCode: mapping[1], modifiers: mask, raw: true });
}

export async function captureScreenshot(target, options = {}) {
  if (!plain(options) || (Object.hasOwn(options, 'fromSurface') && typeof options.fromSurface !== 'boolean')) {
    throw fixed('SCREENSHOT_DENIED');
  }
  const result = await command(target, 'Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: options.captureBeyondViewport !== false,
    ...(Object.hasOwn(options, 'fromSurface') ? { fromSurface: options.fromSurface } : {}),
  });
  if (typeof result?.data !== 'string') throw fixed('SCREENSHOT_DENIED');
  const bytes = Buffer.from(result.data, 'base64');
  if (bytes.length === 0) throw fixed('SCREENSHOT_DENIED');
  return bytes;
}

export async function readAttribute(target, selector, attribute) {
  if (typeof selector !== 'string' || !selector || selector.length > 512 || !ATTRIBUTE.test(attribute ?? '')) {
    throw fixed('ATTRIBUTE_DENIED');
  }
  const value = await evaluate(target,
    `(() => { const node=document.querySelector(${JSON.stringify(selector)}); return node?node.getAttribute(${JSON.stringify(attribute)}):null; })()`);
  if (value !== null && typeof value !== 'string') throw fixed('ATTRIBUTE_DENIED');
  return value;
}

export async function identityOf(target) {
  const targetId = target?.targetId;
  if (typeof targetId !== 'string' || !targetId) throw fixed('IDENTITY_DENIED');
  const result = await command(target.page ?? target, 'Page.getFrameTree');
  const frame = result?.frameTree?.frame;
  if (!plain(frame) || typeof frame.id !== 'string' || !frame.id || typeof frame.loaderId !== 'string' || !frame.loaderId ||
    safeUrl(frame.url) !== frame.url) throw fixed('IDENTITY_DENIED');
  return Object.freeze({ targetId, frameId: frame.id, loaderId: frame.loaderId, url: frame.url });
}

export async function startFixtureServer(t, routes) {
  if (!(routes instanceof Map) || [...routes.entries()].some(([path, route]) =>
    typeof path !== 'string' || !path.startsWith('/') || !plain(route) || !Number.isSafeInteger(route.status) ||
    route.status < 100 || route.status > 599 || !plain(route.headers ?? {}) || !['string', 'object'].includes(typeof route.body))) {
    throw fixed('FIXTURE_ROUTES_INVALID');
  }
  let closed = false;
  const server = createServer((request, response) => {
    let path;
    try { path = new URL(request.url, 'http://127.0.0.1').pathname; } catch { path = '/'; }
    const route = routes.get(path);
    if (!route) { response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); response.end('not found'); return; }
    response.writeHead(route.status, route.headers ?? {});
    response.end(route.body);
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => { server.off('error', rejectPromise); resolvePromise(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw fixed('FIXTURE_SERVER_DENIED');
  const close = async () => {
    if (closed) return false;
    closed = true;
    server.closeAllConnections?.();
    await new Promise(resolvePromise => server.close(() => resolvePromise()));
    return true;
  };
  if (typeof t?.after === 'function') t.after(close);
  return Object.freeze({ origin: `http://127.0.0.1:${address.port}`, close });
}

export async function resolveChromeBinary({ explicit, env = process.env, platform = process.platform, candidates } = {}) {
  const choices = explicit ? [explicit] : env.AUDITA_E2E_CHROME ? [env.AUDITA_E2E_CHROME] : (Array.isArray(candidates) ? candidates : []);
  for (const candidate of choices) {
    try {
      if (!canonicalAbsolute(candidate)) continue;
      const entry = await lstat(candidate);
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const canonical = await realpath(candidate);
      const canonicalEntry = await lstat(canonical);
      if (!canonicalEntry.isFile() || canonicalEntry.isSymbolicLink()) continue;
      await access(canonical, fsConstants.X_OK);
      return canonical;
    } catch { /* try the next closed candidate */ }
  }
  throw fixed('CHROME_BINARY_INVALID');
}

export function resolveExpectedChromeMajor({ explicit, env = process.env } = {}) {
  const source = explicit ?? env.AUDITA_EXPECT_CHROME_MAJOR;
  if (source === undefined) return null;
  if (typeof source === 'string' && !/^[1-9][0-9]{0,2}$/u.test(source)) throw fixed('CHROME_MAJOR_INVALID');
  const value = typeof source === 'string' ? Number(source) : source;
  if (!positiveInteger(value) || value > 999) throw fixed('CHROME_MAJOR_INVALID');
  return value;
}

export function validateChromeProduct(product, expectedMajor = null) {
  const match = /^Chrome\/([1-9][0-9]{0,2})\.[0-9]+\.[0-9]+\.[0-9]+$/u.exec(product ?? '');
  const major = match ? Number(match[1]) : null;
  if (!positiveInteger(major) || (expectedMajor === null ? major < 116 : major !== expectedMajor)) {
    throw fixed('CHROME_VERSION_DENIED');
  }
  return major;
}

async function canonicalDirectory(path, code) {
  if (!canonicalAbsolute(path)) throw fixed(code);
  let entry;
  try { entry = await lstat(path); } catch { throw fixed(code); }
  if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(path) !== path) throw fixed(code);
  return path;
}

async function childDirectory(root, candidate, fallback) {
  const path = candidate ?? join(root, fallback);
  if (!canonicalAbsolute(path)) throw fixed('UNSAFE_LAUNCH_DIRECTORY');
  const parent = dirname(path);
  if (parent !== root) {
    const canonicalTmp = await realpath(tmpdir());
    const externalRoot = await canonicalDirectory(parent, 'UNSAFE_LAUNCH_DIRECTORY');
    if (dirname(externalRoot) !== canonicalTmp || !basename(externalRoot).startsWith('audita-marco-1-')) {
      throw fixed('UNSAFE_LAUNCH_DIRECTORY');
    }
  }
  if (candidate === undefined) {
    try { await mkdir(path); } catch (error) { if (error?.code !== 'EEXIST') throw fixed('UNSAFE_LAUNCH_DIRECTORY'); }
  }
  return canonicalDirectory(path, 'UNSAFE_LAUNCH_DIRECTORY');
}

export async function resolveLaunchDirectories({ runRoot, downloadDirectory, qaDirectory } = {}) {
  const root = await canonicalDirectory(runRoot, 'UNSAFE_LAUNCH_DIRECTORY');
  const externalParents = new Set([downloadDirectory, qaDirectory].filter(Boolean).map(dirname).filter(parent => parent !== root));
  if (externalParents.size > 1) throw fixed('UNSAFE_LAUNCH_DIRECTORY');
  return Object.freeze({
    runRoot: root,
    downloadDirectory: await childDirectory(root, downloadDirectory, 'downloads'),
    qaDirectory: await childDirectory(root, qaDirectory, 'qa'),
  });
}

function resolveDownloadMode(value) {
  const mode = value ?? 'cdp';
  if (mode !== 'cdp' && mode !== 'profile') throw fixed('CHROME_LAUNCH_INVALID');
  return mode;
}

export async function writeProfileDownloadPreferences(raw = {}) {
  const keys = ['runRoot', 'downloadDirectory'];
  if (!plain(raw) || Reflect.ownKeys(raw).length !== keys.length ||
    Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !keys.includes(key))) {
    throw fixed('CHROME_LAUNCH_INVALID');
  }
  const runRoot = await canonicalDirectory(raw.runRoot, 'UNSAFE_LAUNCH_DIRECTORY');
  const canonicalTmp = await realpath(tmpdir());
  if (dirname(runRoot) !== canonicalTmp || !/^audita-real-chrome-[A-Za-z0-9]{6}$/u.test(basename(runRoot))) {
    throw fixed('UNSAFE_LAUNCH_DIRECTORY');
  }
  const downloadDirectory = await canonicalDirectory(raw.downloadDirectory, 'UNSAFE_LAUNCH_DIRECTORY');
  const defaultDirectory = join(runRoot, 'Default');
  try {
    await mkdir(defaultDirectory, { mode: 0o700 });
    if (await realpath(defaultDirectory) !== defaultDirectory) throw fixed('UNSAFE_LAUNCH_DIRECTORY');
    const preferencesPath = join(defaultDirectory, 'Preferences');
    await writeFile(preferencesPath, `${JSON.stringify({
      download: {
        default_directory: downloadDirectory,
        prompt_for_download: false,
        directory_upgrade: true,
      },
    })}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return preferencesPath;
  } catch (error) {
    throw error?.code === 'UNSAFE_LAUNCH_DIRECTORY' ? error : fixed('CHROME_LAUNCH_INVALID');
  }
}

export async function configureDownloadBehavior(browser, downloadDirectory, downloadMode = 'cdp') {
  const mode = resolveDownloadMode(downloadMode);
  if (typeof browser?.command !== 'function' || !safeChromeFlagPath(downloadDirectory)) {
    throw fixed('CHROME_LAUNCH_INVALID');
  }
  if (mode === 'profile') return false;
  await browser.command('Browser.setDownloadBehavior', {
    behavior: 'allow', downloadPath: downloadDirectory, eventsEnabled: true,
  });
  return true;
}

function sessionFor(browser, sessionId) {
  return Object.freeze({
    sessionId,
    command(method, params = {}) { return browser.command(method, params, { sessionId }); },
    waitForEvent(method, predicate, options = {}) { return browser.waitForEvent(method, predicate, { ...options, sessionId }); },
  });
}

async function attachPage(launch, targetId) {
  if (typeof launch.attachPage === 'function') return launch.attachPage(targetId);
  const attached = await launch.browser.command('Target.attachToTarget', { targetId, flatten: true });
  if (typeof attached?.sessionId !== 'string' || !attached.sessionId) throw fixed('CDP_ATTACH_DENIED');
  return sessionFor(launch.browser, attached.sessionId);
}

async function waitForPageTarget(launch, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 50;
  const excluded = options.excluded ?? new Set();
  const deadline = Date.now() + timeoutMs;
  do {
    const listed = await launch.browser.command('Target.getTargets');
    const matches = (listed?.targetInfos ?? []).filter(info => info?.type === 'page' && !excluded.has(info.targetId) && predicate(info));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw fixed('CDP_PAGE_AMBIGUOUS');
    if (Date.now() >= deadline) break;
    await new Promise(resolvePromise => setTimeout(resolvePromise, intervalMs));
  } while (true);
  throw fixed('CDP_PAGE_TIMEOUT');
}

export async function waitForServiceWorker(launch, options = {}) {
  if (!CHROME_ID.test(launch?.extensionId ?? '') || !plain(options)) throw fixed('CDP_WORKER_DENIED');
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 50;
  if (!positiveInteger(timeoutMs) || !positiveInteger(intervalMs)) throw fixed('CDP_WORKER_DENIED');
  const expected = `chrome-extension://${launch.extensionId}/src/background/service-worker.js`;
  const deadline = Date.now() + timeoutMs;
  do {
    const listed = await launch.browser.command('Target.getTargets');
    const matches = (listed?.targetInfos ?? []).filter(info => info?.type === 'service_worker' && info.url === expected);
    if (matches.length === 1) return attachPage(launch, matches[0].targetId);
    if (matches.length > 1) throw fixed('CDP_WORKER_DENIED');
    if (Date.now() >= deadline) break;
    await new Promise(resolvePromise => setTimeout(resolvePromise, intervalMs));
  } while (true);
  throw fixed('CDP_WORKER_TIMEOUT');
}

export async function discoverProcessLoadedExtension(launch, options = {}) {
  if (!launch?.browser || !plain(options) ||
    Reflect.ownKeys(options).some(key => !['timeoutMs', 'intervalMs'].includes(key))) {
    throw fixed('EXTENSION_DISCOVERY_DENIED');
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 50;
  if (!positiveInteger(timeoutMs) || !positiveInteger(intervalMs)) throw fixed('EXTENSION_DISCOVERY_DENIED');
  const deadline = Date.now() + timeoutMs;
  do {
    const listed = await launch.browser.command('Target.getTargets');
    const matches = (listed?.targetInfos ?? []).flatMap(info => {
      if (info?.type !== 'service_worker' || typeof info.targetId !== 'string' || !info.targetId) return [];
      try {
        const url = new URL(info.url);
        return url.protocol === 'chrome-extension:' && CHROME_ID.test(url.hostname) &&
          url.pathname === '/src/background/service-worker.js' && url.search === '' && url.hash === ''
          ? [{ extensionId: url.hostname, targetId: info.targetId }]
          : [];
      } catch { return []; }
    });
    if (matches.length === 1) {
      const worker = await attachPage(launch, matches[0].targetId);
      return Object.freeze({ extensionId: matches[0].extensionId, worker });
    }
    if (matches.length > 1) throw fixed('EXTENSION_DISCOVERY_DENIED');
    if (Date.now() >= deadline) break;
    await new Promise(resolvePromise => setTimeout(resolvePromise, intervalMs));
  } while (true);
  throw fixed('EXTENSION_DISCOVERY_TIMEOUT');
}

async function runHarness(launch, operation) {
  const page = await openTabHarness(launch);
  const result = await evaluate(page, `globalThis.__auditaRealTabHarnessV1.run(${JSON.stringify(operation)})`, { awaitPromise: true, userGesture: operation.kind === 'activate' });
  if (!plain(result) || result.ok !== true || result.operationId !== operation.operationId || !Number.isSafeInteger(result.tabId) ||
    result.tabId < 0 || !Number.isSafeInteger(result.windowId) || result.windowId < 0) throw fixed('TAB_HARNESS_DENIED');
  return result;
}

export async function openTabHarness(launch) {
  if (launch?.harnessPage) return launch.harnessPage;
  if (!CHROME_ID.test(launch?.extensionId ?? '') || !launch?.browser) throw fixed('TAB_HARNESS_DENIED');
  const page = await openExtensionPage(launch, { path: HARNESS_PATH, query: {} });
  launch.harnessPage = page;
  return page;
}

function stagingUrl(launch, operationId) {
  const url = new URL(`chrome-extension://${launch.extensionId}${BLANK_PATH}`);
  url.searchParams.set('run', launch.runId ?? 'run');
  url.searchParams.set('operation', operationId);
  return url.href;
}

export async function createRealPage(launch, { url, active = false, operationId } = {}) {
  const expected = safeUrl(url);
  const op = safeOperationId(operationId);
  if (!expected || typeof active !== 'boolean') throw fixed('TAB_HARNESS_DENIED');
  const before = new Set(((await launch.browser.command('Target.getTargets'))?.targetInfos ?? []).map(info => info.targetId));
  const staging = stagingUrl(launch, op);
  const proof = await runHarness(launch, { kind: 'create', operationId: op, url: staging, active });
  const target = await waitForPageTarget(launch, info => info.url === staging, { excluded: before });
  const page = await attachPage(launch, target.targetId);
  await command(page, 'Page.enable');
  const ref = { ...proof, targetId: target.targetId, targetType: 'page', page };
  await navigateRealPage(launch, ref, { url: expected, operationId: `${op}-navigate` });
  return Object.freeze(ref);
}

export async function navigateRealPage(launch, pageRef, { url, operationId } = {}) {
  const expected = safeUrl(url);
  const op = safeOperationId(operationId);
  if (!expected || !Number.isSafeInteger(pageRef?.tabId) || pageRef?.targetType !== 'page' || !pageRef.page) throw fixed('TAB_HARNESS_DENIED');
  const load = typeof pageRef.page.waitForEvent === 'function'
    ? pageRef.page.waitForEvent('Page.loadEventFired', () => true, { timeoutMs: 15_000 })
    : Promise.resolve(true);
  const proof = await runHarness(launch, { kind: 'navigate', operationId: op, tabId: pageRef.tabId, url: expected });
  if (proof.tabId !== pageRef.tabId) throw fixed('TAB_HARNESS_DENIED');
  await load;
  await waitForCdpPageLoad(pageRef.page, expected);
  return pageRef;
}

export async function activateRealTab(launch, pageRef, { operationId } = {}) {
  const op = safeOperationId(operationId);
  const proof = await runHarness(launch, { kind: 'activate', operationId: op, tabId: pageRef?.tabId });
  if (proof.tabId !== pageRef.tabId || proof.state !== 'active') throw fixed('TAB_HARNESS_DENIED');
  await command(pageRef.page, 'Page.bringToFront');
  await waitForValue(pageRef.page, 'document.hasFocus()', Boolean);
  return pageRef;
}

export async function removeRealTab(launch, pageRef, { operationId } = {}) {
  const op = safeOperationId(operationId);
  const proof = await runHarness(launch, { kind: 'remove', operationId: op, tabId: pageRef?.tabId });
  if (proof.tabId !== pageRef.tabId || proof.state !== 'removed') throw fixed('TAB_HARNESS_DENIED');
  await waitForTargetGone(launch, pageRef.targetId);
  return true;
}

async function waitForTargetGone(launch, targetId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const listed = await launch.browser.command('Target.getTargets');
    if (!(listed?.targetInfos ?? []).some(info => info.targetId === targetId)) return true;
    if (Date.now() >= deadline) break;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  } while (true);
  throw fixed('CDP_PAGE_REMAINED');
}

export async function waitForCdpPageLoad(page, expectedUrl, options = {}) {
  const expected = safeUrl(expectedUrl);
  if (!expected) throw fixed('CDP_PAGE_DENIED');
  await command(page, 'Page.enable');
  await waitForValue(page, `({href:location.href,readyState:document.readyState})`, value =>
    plain(value) && value.href === expected && value.readyState === 'complete', options);
  return true;
}

export async function runtimeContexts(launch, filter = {}) {
  if (!plain(filter) || !launch?.harnessPage || Reflect.ownKeys(filter).some(key => key !== 'contextTypes') ||
    (Object.hasOwn(filter, 'contextTypes') && (!Array.isArray(filter.contextTypes) || filter.contextTypes.length === 0 ||
      filter.contextTypes.some(value => !CONTEXT_TYPES.has(value)) || new Set(filter.contextTypes).size !== filter.contextTypes.length))) {
    throw fixed('CONTEXT_PROOF_DENIED');
  }
  const result = await evaluate(launch.harnessPage, `chrome.runtime.getContexts(${JSON.stringify(filter)})`, { awaitPromise: true });
  if (!Array.isArray(result) || result.some(value => !plain(value))) throw fixed('CONTEXT_PROOF_DENIED');
  return Object.freeze(result.map(value => Object.freeze({ ...value })));
}

export async function openExtensionPage(launch, { path, query = {} } = {}) {
  const keys = EXTENSION_PAGE_SCHEMAS[path];
  if (!keys || !plain(query) || Reflect.ownKeys(query).some(key => typeof key !== 'string' || !keys.includes(key)) ||
    keys.some(key => !Object.hasOwn(query, key)) || Object.values(query).some(value => !AUDIT_ID.test(value ?? ''))) throw fixed('EXTENSION_PAGE_DENIED');
  const url = new URL(`chrome-extension://${launch.extensionId}${path}`);
  for (const key of keys) url.searchParams.set(key, query[key]);
  const before = new Set(((await launch.browser.command('Target.getTargets'))?.targetInfos ?? []).map(info => info.targetId));
  await launch.browser.command('Target.createTarget', { url: url.href });
  const info = await waitForPageTarget(launch, value => value.url === url.href, { excluded: before });
  const page = await attachPage(launch, info.targetId);
  await waitForCdpPageLoad(page, url.href);
  return Object.freeze({ targetId: info.targetId, targetType: 'page', page,
    command: page.command.bind(page), waitForEvent: page.waitForEvent?.bind(page) });
}

async function removeOwnedRunRoot(path) {
  const canonicalTmp = await realpath(tmpdir());
  const checked = await realpath(path);
  if (dirname(checked) !== canonicalTmp || !/^audita-real-chrome-[A-Za-z0-9]{6}$/u.test(basename(checked))) {
    throw fixed('UNSAFE_QA_CLEANUP');
  }
  // Chrome can still be finishing writes in its temporary profile after the browser
  // process exits, which makes a single recursive removal fail with ENOTEMPTY or EBUSY.
  // Retry only those transient races on the already validated owned path; any other
  // failure still surfaces unchanged.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(checked, { recursive: true, force: false });
      return;
    } catch (error) {
      if (!['ENOTEMPTY', 'EBUSY', 'ENOENT'].includes(error?.code) || attempt >= 20) throw error;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    }
  }
}

export async function terminateChromeProcess(chrome, options = {}) {
  if (!chrome || typeof chrome !== 'object' || typeof chrome.once !== 'function' ||
    typeof chrome.removeListener !== 'function' || typeof chrome.kill !== 'function' ||
    !plain(options) || Reflect.ownKeys(options).some(key => key !== 'timeoutMs')) {
    throw fixed('CHROME_PROCESS_INVALID');
  }
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!positiveInteger(timeoutMs)) throw fixed('CHROME_PROCESS_INVALID');
  const readState = () => {
    try {
      const exitCode = Object.getOwnPropertyDescriptor(chrome, 'exitCode');
      const signalCode = Object.getOwnPropertyDescriptor(chrome, 'signalCode');
      if (!exitCode || !signalCode || !Object.hasOwn(exitCode, 'value') || !Object.hasOwn(signalCode, 'value') ||
        (exitCode.value !== null && !Number.isInteger(exitCode.value)) ||
        (signalCode.value !== null && (typeof signalCode.value !== 'string' || !signalCode.value))) return null;
      return Object.freeze({ exited: exitCode.value !== null || signalCode.value !== null });
    } catch { return null; }
  };
  const initial = readState();
  if (!initial) throw fixed('CHROME_PROCESS_INVALID');
  if (initial.exited) return true;

  let timer;
  let onExit;
  const exited = new Promise(resolvePromise => {
    onExit = () => resolvePromise(true);
    chrome.once('exit', onExit);
  });
  const rechecked = readState();
  if (!rechecked) {
    chrome.removeListener('exit', onExit);
    throw fixed('CHROME_PROCESS_INVALID');
  }
  if (rechecked.exited) {
    chrome.removeListener('exit', onExit);
    return true;
  }
  try { chrome.kill('SIGKILL'); } catch { /* the exit proof below remains authoritative */ }
  const timeout = new Promise(resolvePromise => {
    timer = setTimeout(() => resolvePromise(false), timeoutMs);
  });
  const confirmed = await Promise.race([exited, timeout]);
  clearTimeout(timer);
  chrome.removeListener('exit', onExit);
  if (!confirmed) throw fixed('CHROME_PROCESS_REMAINED');
  return true;
}

export function createBoundedBrowserCleanup(raw = {}) {
  const keys = ['closeClients', 'terminateChrome', 'closeServer', 'removeProfile', 'stageTimeoutMs'];
  if (!plain(raw) || Reflect.ownKeys(raw).length !== keys.length ||
    Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !keys.includes(key)) ||
    keys.slice(0, 4).some(key => typeof raw[key] !== 'function') || !positiveInteger(raw.stageTimeoutMs)) {
    throw fixed('BROWSER_CLEANUP_INVALID');
  }
  const stages = Object.freeze([
    Object.freeze(['clients', raw.closeClients]),
    Object.freeze(['chrome', raw.terminateChrome]),
    Object.freeze(['server', raw.closeServer]),
    Object.freeze(['profile', raw.removeProfile]),
  ]);
  let cleanupPromise = null;

  const runStage = (stage, operation) => {
    let timer;
    const operationResult = Promise.resolve().then(operation).then(
      () => Object.freeze({ ok: true }),
      () => Object.freeze({ ok: false, stage, code: 'failed' }),
    );
    const timeout = new Promise(resolvePromise => {
      timer = setTimeout(() => resolvePromise(Object.freeze({ ok: false, stage, code: 'timeout' })), raw.stageTimeoutMs);
    });
    return Promise.race([operationResult, timeout]).finally(() => clearTimeout(timer));
  };

  return () => {
    if (cleanupPromise !== null) return cleanupPromise;
    cleanupPromise = (async () => {
      const failures = [];
      let chromeExitConfirmed = false;
      for (const [stage, operation] of stages) {
        if (stage === 'profile' && !chromeExitConfirmed) continue;
        const result = await runStage(stage, operation);
        if (stage === 'chrome') chromeExitConfirmed = result.ok;
        if (!result.ok) failures.push(Object.freeze({ stage: result.stage, code: result.code }));
      }
      return Object.freeze({ ok: failures.length === 0, failures: Object.freeze(failures) });
    })();
    return cleanupPromise;
  };
}

export async function launchUnpackedExtension(t, options = {}) {
  const optionKeys = [
    'extensionPath', 'startUrl', 'downloadDirectory', 'viewport', 'chromeBinary', 'expectedMajor', 'qaDirectory', 'downloadMode',
  ];
  if (!plain(options) || Reflect.ownKeys(options).some(key => typeof key !== 'string' || !optionKeys.includes(key)) ||
    !canonicalAbsolute(options.extensionPath) || !safeUrl(options.startUrl)) throw fixed('CHROME_LAUNCH_INVALID');
  const downloadMode = resolveDownloadMode(options.downloadMode);
  const extensionPath = await resolveUnpackedExtensionPath(options.extensionPath);
  const chromeBinary = await resolveChromeBinary({ explicit: options.chromeBinary });
  const expectedMajor = resolveExpectedChromeMajor({ explicit: options.expectedMajor });
  if (expectedMajor === null) throw fixed('CHROME_MAJOR_INVALID');
  const viewport = options.viewport ?? { width: 1280, height: 900 };
  if (!plain(viewport) || !positiveInteger(viewport.width) || !positiveInteger(viewport.height)) throw fixed('CHROME_LAUNCH_INVALID');
  const runRoot = await realpath(await mkdtemp(join(tmpdir(), 'audita-real-chrome-')));
  let directories;
  try {
    directories = await resolveLaunchDirectories({
      runRoot, downloadDirectory: options.downloadDirectory, qaDirectory: options.qaDirectory,
    });
    if (downloadMode === 'profile') {
      await writeProfileDownloadPreferences({
        runRoot: directories.runRoot, downloadDirectory: directories.downloadDirectory,
      });
    }
  } catch (error) {
    await removeOwnedRunRoot(runRoot).catch(() => {});
    throw error;
  }
  const spawnSpec = buildChromeLaunchArgv({
    chromeBinary, extensionPath, platform: process.platform, startUrl: 'about:blank',
    userDataDir: directories.runRoot, viewport,
  });
  const chrome = spawn(spawnSpec.file, spawnSpec.args, spawnSpec.options);
  const browser = createCdpPipeTransport({ readable: chrome.stdio[4], writable: chrome.stdio[3] });
  let closePromise = null;
  const launch = {
    extensionId: null, chromeProduct: null, downloadDirectory: directories.downloadDirectory, qaDirectory: directories.qaDirectory,
    extensionPath, runRoot: directories.runRoot, runId: basename(directories.runRoot), browser, worker: null, startPage: null, harnessPage: null,
    command, click, evaluate, waitForValue, pressKey, pressShortcut, captureScreenshot, readAttribute, identityOf,
  };
  launch.attachPage = targetId => attachPage({ ...launch, attachPage: undefined }, targetId);
  launch.runtimeContexts = filter => runtimeContexts(launch, filter);
  launch.openExtensionPage = args => openExtensionPage(launch, args);
  launch.openSidePanelFromAction = () => openSidePanelFromAction(launch);
  launch.waitForSidePanel = () => waitForSidePanel(launch);
  launch.waitForReport = args => waitForReport(launch, args);
  launch.waitForFourDownloads = args => waitForFourDownloads(launch, args);
  launch.captureJourney = (name, target, captureOptions) => captureJourney(launch, name, target, captureOptions);
  launch.captureVisualComparison = args => captureVisualComparison(launch, args);
  launch.close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      browser.close();
      await terminateChromeProcess(chrome);
      await removeOwnedRunRoot(directories.runRoot);
      return true;
    })();
    return closePromise;
  };
  if (typeof t?.after === 'function') t.after(() => launch.close());
  try {
    const version = await browser.command('Browser.getVersion');
    validateChromeProduct(version?.product, expectedMajor);
    launch.chromeProduct = version.product;
    await browser.command('Target.setDiscoverTargets', { discover: true });
    const loaded = await discoverProcessLoadedExtension(launch);
    launch.extensionId = loaded.extensionId;
    launch.worker = loaded.worker;
    await configureDownloadBehavior(browser, directories.downloadDirectory, downloadMode);
    const harness = await openTabHarness(launch);
    await command(harness, 'ServiceWorker.enable');
    launch.startPage = await createRealPage(launch, { url: options.startUrl, active: true });
    return Object.freeze(launch);
  } catch (error) {
    await launch.close().catch(() => {});
    throw error?.code ? error : fixed('CHROME_LAUNCH_FAILED');
  }
}

export async function openSidePanelFromAction(launch, options = {}) {
  if (!plain(options) || Reflect.ownKeys(options).some(key => !['platform', 'shortcut'].includes(key))) {
    throw fixed('SHORTCUT_DENIED');
  }
  let manifest;
  try { manifest = JSON.parse(await readFile(join(launch.extensionPath, 'manifest.json'), 'utf8')); } catch {
    throw fixed('SHORTCUT_DENIED');
  }
  const runtimePlatform = options.platform ?? process.platform;
  const manifestPlatform = runtimePlatform === 'darwin' ? 'mac' : 'default';
  const declared = manifest?.commands?._execute_action?.suggested_key?.[manifestPlatform] ??
    manifest?.commands?._execute_action?.suggested_key?.default;
  const shortcut = options.shortcut ?? declared;
  if (typeof shortcut !== 'string' || shortcut !== declared) throw fixed('SHORTCUT_DENIED');
  await waitForValue(await openTabHarness(launch),
    'chrome.sidePanel.getPanelBehavior().then(value=>value?.openPanelOnActionClick===false)', Boolean,
    { timeoutMs: 10_000, intervalMs: 50 });
  await waitForValue(await openTabHarness(launch), `new Promise(resolve =>
    chrome.contextMenus.update('audita.accessibility.audit-page', { visible: true }, () =>
      resolve(!chrome.runtime.lastError)))`, Boolean, { timeoutMs: 10_000, intervalMs: 50 });
  await activateRealTab(launch, launch.startPage, { operationId: safeOperationId() });
  DECLARED_SHORTCUTS.set(launch.startPage.page, new Set([shortcut]));
  await pressShortcut(launch.startPage.page, shortcut);
  const contexts = await waitForExactContext(launch, 'SIDE_PANEL', '/src/panel/index.html');
  const popups = await runtimeContexts(launch, { contextTypes: ['POPUP'] });
  if (popups.length !== 0) throw fixed('CONTEXT_PROOF_DENIED');
  const info = await waitForPageTarget(launch, value => value.url === contexts[0].documentUrl);
  if (contexts.length !== 1) throw fixed('CONTEXT_PROOF_DENIED');
  const page = await attachPage(launch, info.targetId);
  await waitForCdpPageLoad(page, contexts[0].documentUrl);
  return Object.freeze({ targetId: info.targetId, targetType: 'page', page,
    command: page.command.bind(page), waitForEvent: page.waitForEvent?.bind(page) });
}

async function waitForExactContext(launch, contextType, path, auditId = null) {
  const deadline = Date.now() + 10_000;
  do {
    const contexts = await runtimeContexts(launch, { contextTypes: [contextType] });
    const matches = contexts.filter(context => {
      try {
        const url = new URL(context.documentUrl);
        return url.protocol === 'chrome-extension:' && url.hostname === launch.extensionId && url.pathname === path && !url.hash &&
          (auditId === null
            ? path === '/src/panel/index.html' && url.searchParams.size === 1 && url.searchParams.getAll('launch').length === 1 &&
              PANEL_LAUNCH_TOKEN.test(url.searchParams.get('launch') ?? '')
            : url.searchParams.size === 1 && url.searchParams.getAll('auditId').length === 1 && url.searchParams.get('auditId') === auditId);
      } catch { return false; }
    });
    if (matches.length === 1) return matches;
    if (matches.length > 1) throw fixed('CONTEXT_PROOF_DENIED');
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  } while (Date.now() < deadline);
  throw fixed('CONTEXT_PROOF_DENIED');
}

export async function waitForSidePanel(launch) {
  const [context] = await waitForExactContext(launch, 'SIDE_PANEL', '/src/panel/index.html');
  const info = await waitForPageTarget(launch, value => value.url === context.documentUrl);
  return attachPage(launch, info.targetId);
}

export async function waitForReboundSidePanel(launch, options = {}) {
  if (!plain(options) || Reflect.ownKeys(options).some(key => !['priorDocumentId', 'timeoutMs'].includes(key)) ||
    typeof options.priorDocumentId !== 'string' || !options.priorDocumentId ||
    !positiveInteger(options.timeoutMs ?? 10_000)) throw fixed('CONTEXT_PROOF_DENIED');
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  do {
    const contexts = await runtimeContexts(launch, { contextTypes: ['SIDE_PANEL'] });
    const candidates = contexts.filter(context => {
      if (context.documentId === options.priorDocumentId) return false;
      try {
        const url = new URL(context.documentUrl);
        return url.protocol === 'chrome-extension:' && url.hostname === launch.extensionId &&
          url.pathname === '/src/panel/index.html' && !url.hash && url.searchParams.size === 1 &&
          url.searchParams.getAll('launch').length === 1 &&
          PANEL_LAUNCH_TOKEN.test(url.searchParams.get('launch') ?? '');
      } catch { return false; }
    });
    if (candidates.length > 1) throw fixed('CONTEXT_PROOF_DENIED');
    if (candidates.length === 1) {
      const [context] = candidates;
      const info = await waitForPageTarget(launch, value => value.url === context.documentUrl);
      const page = await attachPage(launch, info.targetId);
      await waitForCdpPageLoad(page, context.documentUrl);
      return Object.freeze({ context: Object.freeze({ ...context }), page });
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  } while (Date.now() < deadline);
  throw fixed('CONTEXT_PROOF_DENIED');
}

export async function waitForReport(launch, args) {
  if (!plain(args) || Reflect.ownKeys(args).length !== 1 || !AUDIT_ID.test(args.auditId ?? '')) throw fixed('REPORT_CONTEXT_DENIED');
  const [context] = await waitForExactContext(launch, 'TAB', '/src/review/index.html', args.auditId);
  const info = await waitForPageTarget(launch, value => value.url === context.documentUrl);
  return attachPage(launch, info.targetId);
}

async function readDurableExportReceipt(launch, auditId) {
  if (typeof launch?.readExportReceipt === 'function') return launch.readExportReceipt(auditId);
  const harness = await openTabHarness(launch);
  return evaluate(harness,
    `import(chrome.runtime.getURL('/src/storage/audit-store.js')).then(module=>module.createAuditStore().getExportReceipt(${JSON.stringify(auditId)}))`,
    { awaitPromise: true });
}

function validReceipt(receipt, auditId) {
  return plain(receipt) && receipt.version === 1 && receipt.auditId === auditId && receipt.status === 'complete' &&
    Array.isArray(receipt.formats) && receipt.formats.length === DOWNLOAD_FORMATS.length &&
    receipt.formats.every((row, index) => plain(row) && row.format === DOWNLOAD_FORMATS[index] &&
      row.mimeType === DOWNLOAD_MIME[row.format] && row.state === 'complete' && Number.isSafeInteger(row.downloadId) &&
      row.downloadId >= 0 && Number.isSafeInteger(row.byteSize) && row.byteSize > 0 && /^[a-f0-9]{64}$/u.test(row.sha256 ?? ''));
}

async function proveDownloadedFiles(directory, receipt) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some(entry => entry.name.endsWith('.crdownload'))) return null;
  const records = [];
  for (const expected of receipt.formats) {
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(`.${expected.format}`)) continue;
      const path = join(directory, entry.name);
      const bytes = await readFile(path);
      if (bytes.length === expected.byteSize && hashBytes(bytes) === expected.sha256) candidates.push(entry.name);
    }
    if (candidates.length !== 1) return null;
    records.push(Object.freeze({ format: expected.format, mime: expected.mimeType, filename: candidates[0],
      downloadId: expected.downloadId, state: 'complete', byteLength: expected.byteSize, sha256: expected.sha256 }));
  }
  return Object.freeze(records);
}

export async function waitForFourDownloads(launch, args = {}) {
  if (!plain(args) || !AUDIT_ID.test(args.auditId ?? '') ||
    Reflect.ownKeys(args).some(key => !['auditId', 'timeoutMs', 'intervalMs'].includes(key))) throw fixed('DOWNLOAD_PROOF_DENIED');
  const timeoutMs = args.timeoutMs ?? 30_000;
  const intervalMs = args.intervalMs ?? 50;
  if (!positiveInteger(timeoutMs) || !positiveInteger(intervalMs)) throw fixed('DOWNLOAD_PROOF_DENIED');
  const directory = await canonicalDirectory(launch?.downloadDirectory, 'DOWNLOAD_PROOF_DENIED');
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const receipt = await readDurableExportReceipt(launch, args.auditId);
      if (validReceipt(receipt, args.auditId)) {
        const records = await proveDownloadedFiles(directory, receipt);
        if (records) return records;
      }
    } catch { /* export and atomic receipt persistence may still be in flight */ }
    if (Date.now() >= deadline) break;
    await new Promise(resolvePromise => setTimeout(resolvePromise, intervalMs));
  } while (true);
  throw fixed('DOWNLOAD_PROOF_TIMEOUT');
}

async function qaFile(directory, name, code, mustExist = false) {
  const root = await canonicalDirectory(directory, code);
  if (!QA_NAME.test(name ?? '') || dirname(join(root, name)) !== root) throw fixed(code);
  const path = join(root, name);
  if (mustExist) {
    const entry = await lstat(path).catch(() => null);
    if (!entry?.isFile() || entry.isSymbolicLink() || await realpath(path) !== path) throw fixed(code);
  }
  return path;
}

export async function captureJourney(launch, name, target, captureOptions = {}) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,155}$/u.test(name)) throw fixed('QA_CAPTURE_DENIED');
  if (!plain(captureOptions) || Reflect.ownKeys(captureOptions).some(key => !['captureBeyondViewport', 'fromSurface'].includes(key)) ||
    (Object.hasOwn(captureOptions, 'captureBeyondViewport') && typeof captureOptions.captureBeyondViewport !== 'boolean') ||
    (Object.hasOwn(captureOptions, 'fromSurface') && typeof captureOptions.fromSurface !== 'boolean')) {
    throw fixed('QA_CAPTURE_DENIED');
  }
  const filename = `${name}.png`;
  const path = await qaFile(launch?.qaDirectory, filename, 'QA_CAPTURE_DENIED');
  const bytes = await captureScreenshot(target, captureOptions);
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o444 }); } catch { throw fixed('QA_CAPTURE_DENIED'); }
  return Object.freeze({ name: filename, byteLength: bytes.length, sha256: await hashFile(path) });
}

async function canonicalPng(path) {
  if (!canonicalAbsolute(path)) throw fixed('QA_COMPARISON_DENIED');
  const entry = await lstat(path).catch(() => null);
  if (!entry?.isFile() || entry.isSymbolicLink() || await realpath(path) !== path) throw fixed('QA_COMPARISON_DENIED');
  return path;
}

async function renderVisualComparison(launch, actualBytes, referenceBytes) {
  if (typeof launch?.renderVisualComparison === 'function') return launch.renderVisualComparison(actualBytes, referenceBytes);
  const target = await openTabHarness(launch);
  const value = await evaluate(target, `(async()=>{const load=source=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=reject;image.src=source});const [actual,reference]=await Promise.all([load('data:image/png;base64,${actualBytes.toString('base64')}'),load('data:image/png;base64,${referenceBytes.toString('base64')}')]);const canvas=document.createElement('canvas');canvas.width=actual.naturalWidth+reference.naturalWidth;canvas.height=Math.max(actual.naturalHeight,reference.naturalHeight);const context=canvas.getContext('2d');context.drawImage(actual,0,0);context.drawImage(reference,actual.naturalWidth,0);return {png:canvas.toDataURL('image/png').slice('data:image/png;base64,'.length),actual:{width:actual.naturalWidth,height:actual.naturalHeight},reference:{width:reference.naturalWidth,height:reference.naturalHeight},output:{width:canvas.width,height:canvas.height}}})()`, { awaitPromise: true });
  if (!plain(value) || typeof value.png !== 'string') throw fixed('QA_COMPARISON_DENIED');
  return { ...value, png: Buffer.from(value.png, 'base64') };
}

function measuredDimensions(value) {
  return plain(value) && positiveInteger(value.width) && positiveInteger(value.height)
    ? Object.freeze({ width: value.width, height: value.height })
    : null;
}

export async function captureVisualComparison(launch, args = {}) {
  if (!plain(args) || Reflect.ownKeys(args).length !== 3 || typeof args.actual !== 'string' ||
    typeof args.reference !== 'string' || typeof args.output !== 'string') throw fixed('QA_COMPARISON_DENIED');
  const actualPath = await qaFile(launch?.qaDirectory, args.actual, 'QA_COMPARISON_DENIED', true);
  const referencePath = await canonicalPng(args.reference);
  const outputPath = await qaFile(launch?.qaDirectory, args.output, 'QA_COMPARISON_DENIED');
  const actualBytes = await readFile(actualPath);
  const referenceBytes = await readFile(referencePath);
  const rendered = await renderVisualComparison(launch, actualBytes, referenceBytes);
  const png = Buffer.isBuffer(rendered?.png) ? rendered.png : null;
  const actualDimensions = measuredDimensions(rendered?.actual);
  const referenceDimensions = measuredDimensions(rendered?.reference);
  const outputDimensions = measuredDimensions(rendered?.output);
  if (!png?.length || !actualDimensions || !referenceDimensions || !outputDimensions ||
    outputDimensions.width !== actualDimensions.width + referenceDimensions.width ||
    outputDimensions.height !== Math.max(actualDimensions.height, referenceDimensions.height)) throw fixed('QA_COMPARISON_DENIED');
  try { await writeFile(outputPath, png, { flag: 'wx', mode: 0o444 }); } catch { throw fixed('QA_COMPARISON_DENIED'); }
  return Object.freeze({
    actual: Object.freeze({ sha256: hashBytes(actualBytes), dimensions: actualDimensions }),
    reference: Object.freeze({ sha256: hashBytes(referenceBytes), dimensions: referenceDimensions }),
    output: Object.freeze({ sha256: await hashFile(outputPath), dimensions: outputDimensions }),
  });
}

export async function readCandidateCommit(workspaceRoot) {
  const root = await canonicalDirectory(workspaceRoot, 'CANDIDATE_DENIED');
  const run = args => new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)));
    child.once('error', () => rejectPromise(fixed('CANDIDATE_DENIED')));
    child.once('exit', code => code === 0 ? resolvePromise(Buffer.concat(chunks).toString('utf8').trim()) : rejectPromise(fixed('CANDIDATE_DENIED')));
  });
  const commit = await run(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw fixed('CANDIDATE_DENIED');
  await run(['diff', '--quiet']);
  return commit;
}

async function hashFile(path) {
  return hashBytes(await readFile(path));
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function preserveQaRun({ sourceDir, destinationRoot, chromeMajor, candidateCommit } = {}) {
  const source = await canonicalDirectory(sourceDir, 'QA_PRESERVE_DENIED');
  const temp = await realpath(tmpdir());
  if (!source.startsWith(`${temp}${sep}`) || basename(destinationRoot ?? '') !== 'marco-1' ||
    basename(dirname(destinationRoot ?? '')) !== 'qa' || basename(dirname(dirname(destinationRoot ?? ''))) !== 'artifacts' ||
    !positiveInteger(chromeMajor) ||
    !/^[a-f0-9]{40}$/u.test(candidateCommit ?? '')) throw fixed('QA_PRESERVE_DENIED');
  const root = await canonicalDirectory(destinationRoot, 'QA_PRESERVE_DENIED');
  const majorRoot = join(root, String(chromeMajor));
  await mkdir(majorRoot, { recursive: true });
  if (await canonicalDirectory(majorRoot, 'QA_PRESERVE_DENIED') !== majorRoot || dirname(majorRoot) !== root) throw fixed('QA_PRESERVE_DENIED');
  const destination = join(majorRoot, candidateCommit);
  try { await mkdir(destination); } catch (error) { if (error?.code !== 'EEXIST') throw fixed('QA_PRESERVE_DENIED'); }
  if (await canonicalDirectory(destination, 'QA_PRESERVE_DENIED') !== destination || dirname(destination) !== majorRoot) {
    throw fixed('QA_PRESERVE_DENIED');
  }
  const sourceEntries = await readdir(source, { withFileTypes: true });
  if (sourceEntries.some(entry => !entry.isFile())) throw fixed('QA_PRESERVE_DENIED');
  const files = sourceEntries.map(entry => entry.name).sort();
  const index = [];
  for (const name of files) {
    if (!/^[A-Za-z0-9._-]{1,160}$/u.test(name)) throw fixed('QA_PRESERVE_DENIED');
    const from = join(source, name);
    const to = join(destination, name);
    const digest = await hashFile(from);
    try { await copyFile(from, to, fsConstants.COPYFILE_EXCL); } catch (error) {
      if (error?.code !== 'EEXIST' || await hashFile(to) !== digest) throw fixed('QA_PRESERVE_DENIED');
    }
    if (await hashFile(to) !== digest) throw fixed('QA_PRESERVE_DENIED');
    const copied = await open(to, 'r');
    try { await copied.sync(); } finally { await copied.close(); }
    await chmod(to, 0o444);
    index.push({ name, sha256: digest, byteLength: (await stat(from)).size });
  }
  const sourceIndex = `${JSON.stringify({ version: 1, chromeMajor, candidateCommit, files: index })}\n`;
  const indexPath = join(destination, 'index.json');
  try { await writeFile(indexPath, sourceIndex, { flag: 'wx', mode: 0o444 }); } catch (error) {
    if (error?.code !== 'EEXIST' || await readFile(indexPath, 'utf8') !== sourceIndex) throw fixed('QA_PRESERVE_DENIED');
  }
  const handle = await open(indexPath, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  await chmod(indexPath, 0o444);
  const preservedNames = (await readdir(destination)).sort();
  const expectedNames = [...files, 'index.json'].sort();
  if (JSON.stringify(preservedNames) !== JSON.stringify(expectedNames)) throw fixed('QA_PRESERVE_DENIED');
  await chmod(destination, 0o555);
  return createHash('sha256').update(sourceIndex).digest('hex');
}

export function redactDiagnostic(value) {
  if (typeof value !== 'string') return 'E2E_DENIED';
  return value
    .replace(/\b(?:https?|chrome-extension):\/\/[^\s]+/giu, '[redacted-url]')
    .replace(/\bBearer\s+[^\s]+/giu, 'Bearer [redacted]')
    .replace(/\b[a-p]{32}\b/gu, '[redacted-extension]')
    .replace(/([?#])[^\s]*/gu, '$1[redacted]');
}
