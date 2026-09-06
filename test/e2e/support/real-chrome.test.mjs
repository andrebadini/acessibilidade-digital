import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { createNodeTestArgs, createTestPlan } from '../../../scripts/run-tests.mjs';
import {
  CANONICAL_CHROME_PRODUCT,
  MAX_CDP_FRAME_BYTES,
  activateRealTab,
  buildChromeLaunchArgv,
  captureJourney,
  captureScreenshot,
  captureVisualComparison,
  click,
  command,
  configureDownloadBehavior,
  createBoundedBrowserCleanup,
  createCdpPipeTransport,
  createRealPage,
  discoverProcessLoadedExtension,
  evaluate,
  identityOf,
  launchUnpackedExtension,
  navigateRealPage,
  openSidePanelFromAction,
  openTabHarness,
  pressKey,
  pressShortcut,
  preserveQaRun,
  readAttribute,
  redactDiagnostic,
  removeRealTab,
  resolveChromeBinary,
  resolveExpectedChromeMajor,
  resolveRealChromeTestBinary,
  resolveLaunchDirectories,
  resolveUnpackedExtensionPath,
  startFixtureServer,
  terminateChromeProcess,
  runtimeContexts,
  validateChromeProduct,
  waitForCdpPageLoad,
  waitForFourDownloads,
  waitForServiceWorker,
  waitForValue,
  writeProfileDownloadPreferences,
} from './real-chrome.mjs';

test('real Chrome E2Es share one explicit binary resolution and one exact Chrome 152 product', () => {
  assert.equal(CANONICAL_CHROME_PRODUCT, 'Chrome/152.0.7977.64');
  assert.equal(resolveRealChromeTestBinary({ AUDITA_E2E_CHROME: '/cft-152', CHROME_BIN: '/fallback' }), '/cft-152');
  assert.equal(resolveRealChromeTestBinary({ CHROME_BIN: '/fallback' }), '/fallback');
  assert.equal(resolveRealChromeTestBinary({}), null);
  assert.equal(resolveRealChromeTestBinary({ AUDITA_E2E_CHROME: '', CHROME_BIN: '/fallback' }), '/fallback');
  assert.throws(() => resolveRealChromeTestBinary({ AUDITA_E2E_CHROME: 152 }),
    error => error.code === 'CHROME_BINARY_INVALID');
});

test('default suite keeps fast tests parallel and classifies every real-Chrome E2E for serial execution', () => {
  const files = [
    'test/background/service-worker.test.js',
    'test/e2e/axe-mv3-csp-decision.test.mjs',
    'test/e2e/axe-mv3-csp.test.mjs',
    'test/e2e/batch-audit-mv3.test.mjs',
    'test/e2e/batch-pixel-consent-mv3.test.mjs',
    'test/e2e/download-uniquify-mv3.test.mjs',
    'test/e2e/personas-mv3-csp.test.mjs',
    'test/e2e/public-axe-map-mv3.test.mjs',
    'test/e2e/report-print-layout.test.mjs',
    'test/e2e/retention-indexeddb-mv3.test.mjs',
    'test/e2e/sidepanel-flow-mv3.test.mjs',
    'test/e2e/support/real-chrome.test.mjs',
    'test/e2e/url-audit-mv3.test.mjs',
    'test/e2e/url-pixel-consent-mv3.test.mjs',
  ];
  const plan = createTestPlan(files);
  assert.deepEqual(plan.parallel, [
    'test/background/service-worker.test.js',
    'test/e2e/axe-mv3-csp-decision.test.mjs',
    'test/e2e/support/real-chrome.test.mjs',
  ]);
  assert.deepEqual(plan.serial, [
    'test/e2e/axe-mv3-csp.test.mjs',
    'test/e2e/batch-audit-mv3.test.mjs',
    'test/e2e/batch-pixel-consent-mv3.test.mjs',
    'test/e2e/download-uniquify-mv3.test.mjs',
    'test/e2e/personas-mv3-csp.test.mjs',
    'test/e2e/public-axe-map-mv3.test.mjs',
    'test/e2e/report-print-layout.test.mjs',
    'test/e2e/retention-indexeddb-mv3.test.mjs',
    'test/e2e/sidepanel-flow-mv3.test.mjs',
    'test/e2e/url-audit-mv3.test.mjs',
    'test/e2e/url-pixel-consent-mv3.test.mjs',
  ]);
  assert.deepEqual(createNodeTestArgs(plan.parallel), ['--test', ...plan.parallel]);
  assert.deepEqual(createNodeTestArgs(plan.serial, { serial: true }),
    ['--test', '--test-concurrency=1', ...plan.serial]);
  assert.throws(() => createTestPlan([...files, 'test/e2e/new-real-browser.test.mjs']),
    error => error.code === 'TEST_PLAN_UNCLASSIFIED_E2E');
});

function decodeFrames(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean).map(value => JSON.parse(value));
}

function transportFixture(options = {}) {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const written = [];
  writable.on('data', chunk => written.push(Buffer.from(chunk)));
  const transport = createCdpPipeTransport({ readable, writable, ...options });
  return { readable, writable, written, transport };
}

test('Chrome launch argv is closed, canonical and isolates the macOS Keychain', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'audita-launch-argv-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extensionPath = join(root, 'extension');
  const userDataDir = join(root, 'profile');
  await mkdir(extensionPath);
  await mkdir(userDataDir);
  await writeFile(join(extensionPath, 'manifest.json'), '{"manifest_version":3}');

  assert.equal(await resolveUnpackedExtensionPath(extensionPath), extensionPath);
  const common = {
    chromeBinary: '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    extensionPath,
    userDataDir,
    viewport: { width: 1280, height: 900 },
    startUrl: 'about:blank',
  };
  const darwin = buildChromeLaunchArgv({ ...common, platform: 'darwin' });
  assert.equal(darwin.file, common.chromeBinary);
  assert.equal(darwin.options.shell, false);
  assert.equal(darwin.args.filter(value => value === '--use-mock-keychain').length, 1);
  assert.equal(darwin.args.filter(value => value === `--load-extension=${extensionPath}`).length, 1);
  assert.equal(darwin.args.filter(value => value === `--disable-extensions-except=${extensionPath}`).length, 1);
  assert.equal(darwin.args.some(value => value.includes('Extensions.loadUnpacked')), false);

  const linux = buildChromeLaunchArgv({ ...common, platform: 'linux' });
  assert.equal(linux.options.shell, false);
  assert.equal(linux.args.filter(value => value === '--use-mock-keychain').length, 0);
  assert.equal(linux.args.filter(value => value.startsWith('--load-extension=')).length, 1);
  assert.equal(linux.args.filter(value => value.startsWith('--disable-extensions-except=')).length, 1);

  for (const unsafe of [`${extensionPath},decoy`, `${extensionPath}\0decoy`, `${extensionPath}\ndecoy`, `${extensionPath}\rdecoy`]) {
    assert.throws(() => buildChromeLaunchArgv({ ...common, extensionPath: unsafe, platform: 'darwin' }),
      error => error.code === 'EXTENSION_PATH_INVALID');
  }
  const link = join(root, 'extension-link');
  await symlink(extensionPath, link);
  await assert.rejects(resolveUnpackedExtensionPath(link), error => error.code === 'EXTENSION_PATH_INVALID');
});

test('Chrome teardown proves process exit before cleanup may continue', async t => {
  await t.test('missing process lifecycle state is denied', async () => {
    const chrome = new EventEmitter();
    chrome.kill = () => true;
    await assert.rejects(terminateChromeProcess(chrome, { timeoutMs: 10 }),
      error => error.code === 'CHROME_PROCESS_INVALID');
  });

  await t.test('already exited process needs no signal', async () => {
    const chrome = new EventEmitter();
    chrome.exitCode = 0;
    chrome.signalCode = null;
    chrome.kill = () => { throw new Error('must not signal an exited process'); };
    assert.equal(await terminateChromeProcess(chrome, { timeoutMs: 10 }), true);
  });

  await t.test('running process resolves only after its exit event', async () => {
    const chrome = new EventEmitter();
    chrome.exitCode = null;
    chrome.signalCode = null;
    let signals = 0;
    chrome.kill = signal => {
      signals += 1;
      assert.equal(signal, 'SIGKILL');
      setImmediate(() => {
        chrome.signalCode = 'SIGKILL';
        chrome.emit('exit', null, 'SIGKILL');
      });
      return true;
    };
    assert.equal(await terminateChromeProcess(chrome, { timeoutMs: 100 }), true);
    assert.equal(signals, 1);
  });

  await t.test('stubborn process fails closed instead of permitting profile removal', async () => {
    const chrome = new EventEmitter();
    chrome.exitCode = null;
    chrome.signalCode = null;
    chrome.kill = signal => {
      assert.equal(signal, 'SIGKILL');
      return true;
    };
    await assert.rejects(terminateChromeProcess(chrome, { timeoutMs: 10 }),
      error => error.code === 'CHROME_PROCESS_REMAINED');
  });
});

test('bounded browser cleanup is idempotent and preserves clients → Chrome → server → profile order', async () => {
  const trace = [];
  const cleanup = createBoundedBrowserCleanup({
    closeClients() { trace.push('clients'); },
    terminateChrome() { trace.push('chrome'); },
    closeServer() { trace.push('server'); },
    removeProfile() { trace.push('profile'); },
    stageTimeoutMs: 25,
  });

  const first = cleanup();
  assert.strictEqual(cleanup(), first, 'concurrent and repeated callers share exactly one cleanup');
  assert.deepEqual(await first, { ok: true, failures: [] });
  assert.strictEqual(cleanup(), first);
  assert.deepEqual(trace, ['clients', 'chrome', 'server', 'profile']);
});

test('bounded browser cleanup closes the server but preserves the profile when Chrome exit is unconfirmed', async () => {
  const trace = [];
  const cleanup = createBoundedBrowserCleanup({
    closeClients() { trace.push('clients'); return new Promise(() => {}); },
    terminateChrome() { trace.push('chrome'); throw new Error('private process detail'); },
    closeServer() { trace.push('server'); return new Promise(() => {}); },
    removeProfile() { trace.push('profile'); },
    stageTimeoutMs: 5,
  });
  const startedAt = Date.now();
  const result = await cleanup();
  const elapsedMs = Date.now() - startedAt;

  assert.deepEqual(trace, ['clients', 'chrome', 'server'],
    'profile removal is forbidden after an unconfirmed Chrome exit');
  assert.deepEqual(result, {
    ok: false,
    failures: [
      { stage: 'clients', code: 'timeout' },
      { stage: 'chrome', code: 'failed' },
      { stage: 'server', code: 'timeout' },
    ],
  });
  assert.ok(elapsedMs < 250, `cleanup excedeu o limite observável: ${elapsedMs}ms`);
});

test('Pipe CDP writes NUL frames and correlates one response', async t => {
  const fixture = transportFixture();
  t.after(() => fixture.transport.close());
  const pending = fixture.transport.command('Browser.getVersion');
  await new Promise(resolve => setImmediate(resolve));
  const [request] = decodeFrames(Buffer.concat(fixture.written));
  assert.deepEqual(request, { id: 1, method: 'Browser.getVersion', params: {} });
  fixture.readable.write(`${JSON.stringify({ id: request.id, result: { product: 'Chrome/152.0.0.0' } })}\0`);
  assert.deepEqual(await pending, { product: 'Chrome/152.0.0.0' });
});

test('Pipe CDP rejects invalid UTF-8, malformed, oversized and duplicate-id frames', async t => {
  await t.test('fatal UTF-8', async () => {
    const fixture = transportFixture();
    const closed = fixture.transport.closed;
    fixture.readable.write(Buffer.from([0xc3, 0x28, 0]));
    await assert.rejects(closed, error => error.code === 'CDP_FRAME_INVALID');
  });
  await t.test('malformed JSON', async () => {
    const fixture = transportFixture();
    const closed = fixture.transport.closed;
    fixture.readable.write('{nope}\0');
    await assert.rejects(closed, error => error.code === 'CDP_FRAME_INVALID');
  });
  await t.test('oversized before delimiter', async () => {
    const fixture = transportFixture({ maxFrameBytes: 8 });
    const closed = fixture.transport.closed;
    fixture.readable.write('123456789');
    await assert.rejects(closed, error => error.code === 'CDP_FRAME_TOO_LARGE');
  });
  await t.test('duplicate response id', async () => {
    const fixture = transportFixture();
    const first = fixture.transport.command('Browser.getVersion');
    await new Promise(resolve => setImmediate(resolve));
    fixture.readable.write('{"id":1,"result":{}}\0');
    await first;
    const closed = fixture.transport.closed;
    fixture.readable.write('{"id":1,"result":{}}\0');
    await assert.rejects(closed, error => error.code === 'CDP_RESPONSE_DUPLICATE');
  });
});

test('Pipe CDP bounds commands and rejects pending work on idempotent close', async t => {
  const fixture = transportFixture({ commandTimeoutMs: 10 });
  await assert.rejects(fixture.transport.command('Never.responds'), error => error.code === 'CDP_COMMAND_TIMEOUT');
  const pending = fixture.transport.command('Still.pending', {}, { timeoutMs: 1_000 });
  assert.equal(fixture.transport.close(), true);
  assert.equal(fixture.transport.close(), false);
  await assert.rejects(pending, error => error.code === 'CDP_CLOSED');
  await assert.rejects(fixture.transport.closed, error => error.code === 'CDP_CLOSED');
});

test('launch option resolvers reject unsafe binaries, versions and directories', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'audita-real-chrome-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'chrome');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.equal(await resolveChromeBinary({ explicit: executable, env: {}, platform: process.platform, candidates: [] }), executable);
  const notExecutable = join(root, 'plain');
  await writeFile(notExecutable, 'plain', { mode: 0o600 });
  await assert.rejects(resolveChromeBinary({ explicit: notExecutable, env: {}, platform: process.platform, candidates: [] }),
    error => error.code === 'CHROME_BINARY_INVALID');
  const link = join(root, 'chrome-link');
  await symlink(executable, link);
  await assert.rejects(resolveChromeBinary({ explicit: link, env: {}, platform: process.platform, candidates: [] }),
    error => error.code === 'CHROME_BINARY_INVALID');
  const binaryDirectory = join(root, 'browser-directory');
  await mkdir(binaryDirectory);
  const nestedExecutable = join(binaryDirectory, 'chrome');
  await writeFile(nestedExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const parentAlias = join(root, 'browser-alias');
  await symlink(binaryDirectory, parentAlias);
  assert.equal(await resolveChromeBinary({ explicit: join(parentAlias, 'chrome'), env: {}, platform: process.platform, candidates: [] }),
    nestedExecutable);
  await assert.rejects(resolveChromeBinary({ env: {}, platform: 'darwin' }),
    error => error.code === 'CHROME_BINARY_INVALID');
  assert.equal(resolveExpectedChromeMajor({ explicit: 152, env: {} }), 152);
  assert.equal(resolveExpectedChromeMajor({ env: { AUDITA_EXPECT_CHROME_MAJOR: '116' } }), 116);
  assert.throws(() => resolveExpectedChromeMajor({ env: { AUDITA_EXPECT_CHROME_MAJOR: '0152' } }),
    error => error.code === 'CHROME_MAJOR_INVALID');
  assert.equal(validateChromeProduct('Chrome/152.0.8123.0', 152), 152);
  assert.throws(() => validateChromeProduct('Chrome/151.0.0.0', 152), error => error.code === 'CHROME_VERSION_DENIED');

  const directories = await resolveLaunchDirectories({ runRoot: root });
  assert.equal(directories.runRoot, root);
  assert.match(directories.downloadDirectory, /\/downloads$/u);
  assert.match(directories.qaDirectory, /\/qa$/u);
  const outside = await mkdtemp(join(tmpdir(), 'audita-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await assert.rejects(resolveLaunchDirectories({ runRoot: root, downloadDirectory: outside }),
    error => error.code === 'UNSAFE_LAUNCH_DIRECTORY');

  const callerRoot = await realpath(await mkdtemp(join(tmpdir(), 'audita-marco-1-')));
  t.after(() => rm(callerRoot, { recursive: true, force: true }));
  const callerDownloads = join(callerRoot, 'downloads');
  const callerQa = join(callerRoot, 'qa');
  await mkdir(callerDownloads);
  await mkdir(callerQa);
  assert.deepEqual(await resolveLaunchDirectories({ runRoot: root, downloadDirectory: callerDownloads, qaDirectory: callerQa }), {
    runRoot: root, downloadDirectory: callerDownloads, qaDirectory: callerQa,
  });
});

test('profile download mode writes only the exact Chrome Preferences under its owned run root', async t => {
  const runRoot = await realpath(await mkdtemp(join(tmpdir(), 'audita-real-chrome-')));
  t.after(() => rm(runRoot, { recursive: true, force: true }));
  const downloadDirectory = join(runRoot, 'downloads');
  await mkdir(downloadDirectory);

  const preferencesPath = await writeProfileDownloadPreferences({ runRoot, downloadDirectory });

  assert.equal(preferencesPath, join(runRoot, 'Default', 'Preferences'));
  assert.deepEqual(JSON.parse(await readFile(preferencesPath, 'utf8')), {
    download: {
      default_directory: downloadDirectory,
      prompt_for_download: false,
      directory_upgrade: true,
    },
  });
});

test('profile download mode alone skips the default CDP download override', async () => {
  const calls = [];
  const browser = { async command(method, params) { calls.push([method, params]); return {}; } };
  const downloadDirectory = resolve(tmpdir(), 'audita-real-chrome-test', 'downloads');

  assert.equal(await configureDownloadBehavior(browser, downloadDirectory, 'profile'), false);
  assert.deepEqual(calls, []);
  assert.equal(await configureDownloadBehavior(browser, downloadDirectory, 'cdp'), true);
  assert.deepEqual(calls, [[
    'Browser.setDownloadBehavior',
    { behavior: 'allow', downloadPath: downloadDirectory, eventsEnabled: true },
  ]]);
});

test('launch preflight rejects unknown options and removes its owned temporary profile on failure', async () => {
  const workspaceRoot = await realpath(new URL('../../../', import.meta.url).pathname);
  const canonicalTmp = await realpath(tmpdir());
  const fakeBinaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'audita-fake-browser-')));
  const fakeBinary = join(fakeBinaryRoot, 'chrome');
  await writeFile(fakeBinary, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const ownedProfiles = async () => new Set((await readdir(canonicalTmp)).filter(name => /^audita-real-chrome-[A-Za-z0-9]{6}$/u.test(name)));
  const before = await ownedProfiles();
  await assert.rejects(launchUnpackedExtension(null, {
    extensionPath: workspaceRoot, startUrl: 'http://127.0.0.1/', downloadDirectory: canonicalTmp,
    chromeBinary: fakeBinary, expectedMajor: 152,
  }), error => error.code === 'UNSAFE_LAUNCH_DIRECTORY');
  assert.deepEqual(await ownedProfiles(), before);
  await assert.rejects(launchUnpackedExtension(null, {
    extensionPath: workspaceRoot, startUrl: 'http://127.0.0.1/', surprise: true,
  }), error => error.code === 'CHROME_LAUNCH_INVALID');

  try {
    await assert.rejects(launchUnpackedExtension(null, {
      extensionPath: workspaceRoot, startUrl: 'http://127.0.0.1/', chromeBinary: fakeBinary,
      expectedMajor: 0,
    }), error => error.code === 'CHROME_MAJOR_INVALID');
  } finally {
    await rm(fakeBinaryRoot, { recursive: true, force: true });
  }
});

test('fixture server accepts a Map, binds loopback and closes idempotently', async t => {
  const fixture = await startFixtureServer(t, new Map([
    ['/ok', { status: 201, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'ready' }],
  ]));
  const response = await fetch(`${fixture.origin}/ok?secret=not-logged`);
  assert.equal(response.status, 201);
  assert.equal(await response.text(), 'ready');
  assert.equal(await fixture.close(), true);
  assert.equal(await fixture.close(), false);
  await assert.rejects(startFixtureServer(t, {}), error => error.code === 'FIXTURE_ROUTES_INVALID');
});

test('shared CDP helpers use the target command boundary and closed gestures', async () => {
  const calls = [];
  const target = {
    async command(method, params) {
      calls.push([method, params]);
      if (method === 'Runtime.evaluate') return { result: { value: params.expression.includes('querySelector') ? true : 'value' } };
      if (method === 'Page.captureScreenshot') return { data: Buffer.from('png').toString('base64') };
      return {};
    },
  };
  assert.deepEqual(await command(target, 'Page.enable'), {});
  assert.equal(await evaluate(target, '1+1'), 'value');
  assert.equal(await click(target, '#go'), true);
  assert.deepEqual(calls.find(([method]) => method === 'Runtime.evaluate')[1].userGesture, undefined);
  assert.equal(calls.filter(([method, params]) => method === 'Runtime.evaluate' && params.userGesture === true).length, 1);
  await pressKey(target, { key: 'Tab', code: 'Tab', virtualKeyCode: 9, modifiers: 8 });
  await pressShortcut(target, 'Shift+Tab');
  await assert.rejects(pressShortcut(target, 'Alt+Shift+A', { declaredShortcuts: ['Alt+Shift+A'] }),
    error => error.code === 'SHORTCUT_DENIED');
  await assert.rejects(pressShortcut(target, 'Ctrl+X'),
    error => error.code === 'SHORTCUT_DENIED');
  const keyEvents = calls.filter(([method]) => method === 'Input.dispatchKeyEvent').map(([, params]) => params);
  assert.equal(keyEvents.filter(event => event.type === 'keyDown' || event.type === 'rawKeyDown').length,
    keyEvents.filter(event => event.type === 'keyUp').length);
  assert.deepEqual(await captureScreenshot(target), Buffer.from('png'));
});

test('key dispatch attempts a balanced release and exposes only a fixed failure', async () => {
  const events = [];
  const target = { async command(method, params) {
    if (method === 'Input.dispatchKeyEvent') events.push(params.type);
    if (params.type === 'rawKeyDown') throw new Error('native keyboard detail');
    return {};
  } };
  await assert.rejects(pressKey(target, { key: 'A', code: 'KeyA', virtualKeyCode: 65, modifiers: 8, raw: true }),
    error => error.code === 'KEY_DISPATCH_FAILED' && !/native/u.test(error.message));
  assert.deepEqual(events, ['rawKeyDown', 'keyUp']);
});

test('waitForValue polls immediately and redacts its fixed timeout', async () => {
  let reads = 0;
  const target = { async command() { reads += 1; return { result: { value: reads } }; } };
  assert.equal(await waitForValue(target, 'private?token=x', value => value === 2, { timeoutMs: 100, intervalMs: 1 }), 2);
  await assert.rejects(waitForValue(target, 'private?token=x', () => false, { timeoutMs: 5, intervalMs: 1 }), error => {
    assert.equal(error.code, 'WAIT_TIMEOUT');
    assert.doesNotMatch(error.message, /private|token/u);
    return true;
  });
});

function fakeHarnessLaunch() {
  const calls = [];
  let pageUrl = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/test/e2e/fixtures/real-tab-blank.html?run=run&operation=op-1';
  let targetPresent = false;
  let removed = false;
  const page = {
    targetId: 'harness-page',
    async command(method, params) {
      calls.push([method, params]);
      if (method === 'Runtime.evaluate') {
        const serialized = /\.run\((\{.*\})\)$/u.exec(params.expression)?.[1];
        const operation = JSON.parse(serialized);
        if (operation.kind === 'create') targetPresent = true;
        if (operation.kind === 'navigate') pageUrl = operation.url;
        if (operation.kind === 'remove') removed = true;
        const state = operation.kind === 'activate' ? 'active' : operation.kind === 'remove' ? 'removed' : 'complete';
        return { result: { value: { ok: true, operationId: operation.operationId, tabId: 17, windowId: 4, state } } };
      }
      return {};
    },
  };
  const attached = {
    async command(method) {
      calls.push([method]);
      if (method === 'Runtime.evaluate') return { result: { value: { href: pageUrl, readyState: 'complete' } } };
      return {};
    },
  };
  const launch = {
    extensionId: 'a'.repeat(32), browser: { async command(method) {
      calls.push([method]);
      if (method === 'Target.getTargets') return { targetInfos: removed || !targetPresent ? [] : [{ targetId: 'page-17', type: 'page', url: pageUrl }] };
      return {};
    } },
    attachPage: async () => attached,
    harnessPage: page,
  };
  return { calls, launch, page };
}

test('tab harness helpers invoke the extension controller and accept only CDP page targets', async () => {
  const fixture = fakeHarnessLaunch();
  assert.equal((await openTabHarness(fixture.launch)).targetId, 'harness-page');
  const created = await createRealPage(fixture.launch, { url: 'http://127.0.0.1:1234/page?secret=x', active: true, operationId: 'op-1' });
  assert.equal(created.tabId, 17);
  assert.equal(created.targetId, 'page-17');
  assert.equal(created.targetType, 'page');
  await navigateRealPage(fixture.launch, created, { url: 'http://127.0.0.1:1234/next?secret=x', operationId: 'op-2' });
  await activateRealTab(fixture.launch, created, { operationId: 'op-3' });
  await removeRealTab(fixture.launch, created, { operationId: 'op-4' });
  assert.equal(fixture.calls.some(([method]) => method === 'Extensions.triggerAction'), false);
});

test('CDP load waiter requires the exact final page without serializing its URL in failures', async () => {
  let calls = 0;
  const page = { async command(method) {
    if (method === 'Page.enable') return {};
    calls += 1;
    return { result: { value: calls > 1 ? { href: 'http://127.0.0.1:1/final?token=x', readyState: 'complete' } : null } };
  } };
  assert.equal(await waitForCdpPageLoad(page, 'http://127.0.0.1:1/final?token=x', { timeoutMs: 100, intervalMs: 1 }), true);
});

test('service worker correlation accepts only the exact extension worker target', async () => {
  const attached = { command() {} };
  const launch = {
    extensionId: 'a'.repeat(32),
    browser: { async command() {
      return { targetInfos: [
        { targetId: 'decoy', type: 'page', url: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/src/background/service-worker.js' },
        { targetId: 'worker-1', type: 'service_worker', url: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/src/background/service-worker.js' },
      ] };
    } },
    async attachPage(targetId) { assert.equal(targetId, 'worker-1'); return attached; },
  };
  assert.equal(await waitForServiceWorker(launch, { timeoutMs: 100, intervalMs: 1 }), attached);
});

test('process-loaded extension discovery derives one exact service worker without CDP loading', async () => {
  const attached = { command() {} };
  const calls = [];
  const launch = {
    browser: { async command(method) {
      calls.push(method);
      if (method === 'Target.getTargets') return { targetInfos: [
        { targetId: 'decoy', type: 'page', url: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/src/background/service-worker.js' },
        { targetId: 'worker-1', type: 'service_worker', url: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/src/background/service-worker.js' },
      ] };
      return {};
    } },
    async attachPage(targetId) { assert.equal(targetId, 'worker-1'); return attached; },
  };
  const found = await discoverProcessLoadedExtension(launch, { timeoutMs: 100, intervalMs: 1 });
  assert.deepEqual(found, { extensionId: 'a'.repeat(32), worker: attached });
  assert.equal(calls.includes('Extensions.loadUnpacked'), false);
});

test('the declared _execute_action shortcut opens one tokenized Side Panel while action-click auto-open stays disabled', async () => {
  const extensionId = 'a'.repeat(32);
  const shortcut = process.platform === 'darwin' ? 'MacCtrl+Shift+A' : 'Alt+Shift+A';
  let opened = false;
  let behaviorReads = 0;
  let runtimeReadinessReads = 0;
  const launchToken = 'A'.repeat(43);
  const panelUrl = `chrome-extension://${extensionId}/src/panel/index.html?launch=${launchToken}`;
  const harnessPage = {
    targetId: 'harness',
    async command(method, params) {
      if (method !== 'Runtime.evaluate') return {};
      if (params.expression.includes('__auditaRealTabHarnessV1.run')) {
        const operation = JSON.parse(/\.run\((\{.*\})\)$/u.exec(params.expression)[1]);
        return { result: { value: { ok: true, operationId: operation.operationId, tabId: 17, windowId: 4, state: 'active' } } };
      }
      if (params.expression.includes('chrome.runtime.getContexts')) {
        if (params.expression.includes('SIDE_PANEL')) return { result: { value: opened ? [
          { contextType: 'SIDE_PANEL', documentId: 'panel-document', documentUrl: panelUrl },
        ] : [] } };
        if (params.expression.includes('POPUP')) return { result: { value: [] } };
      }
      if (params.expression.includes('chrome.sidePanel.getPanelBehavior')) {
        behaviorReads += 1;
        return { result: { value: params.expression.includes('openPanelOnActionClick===false') } };
      }
      if (params.expression.includes('chrome.contextMenus.update')) {
        runtimeReadinessReads += 1;
        return { result: { value: runtimeReadinessReads >= 2 } };
      }
      return { result: { value: true } };
    },
  };
  const startPageTarget = {
    async command(method, params) {
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp') opened = true;
      return {};
    },
  };
  const panelTarget = { async command(method) {
    if (method === 'Page.enable') return {};
    if (method === 'Runtime.evaluate') return { result: { value: { href: panelUrl, readyState: 'complete' } } };
    return {};
  } };
  const launch = {
    extensionId,
    extensionPath: await realpath(new URL('../../../', import.meta.url).pathname),
    harnessPage,
    startPage: { tabId: 17, targetId: 'source', targetType: 'page', page: startPageTarget },
    browser: { async command(method) {
      if (method === 'Target.getTargets') return { targetInfos: opened ? [
        { targetId: 'panel-target', type: 'page', url: panelUrl },
      ] : [] };
      return {};
    } },
    async attachPage(targetId) { assert.equal(targetId, 'panel-target'); return panelTarget; },
  };
  const panel = await openSidePanelFromAction(launch, { platform: process.platform, shortcut });
  assert.equal(panel.targetId, 'panel-target');
  assert.equal((await runtimeContexts(launch, { contextTypes: ['SIDE_PANEL'] })).length, 1);
  assert.equal((await runtimeContexts(launch, { contextTypes: ['POPUP'] })).length, 0);
  assert.equal(behaviorReads, 1);
  assert.equal(runtimeReadinessReads, 2,
    'o atalho só pode ser enviado depois que o comando público instalado comprova o runtime pronto');
  const panelLaunch = new URL(panelUrl);
  assert.equal(panelLaunch.pathname, '/src/panel/index.html');
  assert.deepEqual([...panelLaunch.searchParams.keys()], ['launch']);
  assert.match(panelLaunch.searchParams.get('launch'), /^[A-Za-z0-9_-]{43}$/u);
});

test('foundation constants and fixture files remain bounded', async () => {
  assert.equal(MAX_CDP_FRAME_BYTES, 16 * 1024 * 1024);
  const html = await readFile(new URL('../fixtures/real-tab-harness.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../fixtures/real-tab-harness.js', import.meta.url), 'utf8');
  const blank = await readFile(new URL('../fixtures/real-tab-blank.html', import.meta.url), 'utf8');
  assert.match(html, /real-tab-harness\.js/u);
  assert.doesNotMatch(html, /<script(?![^>]*src=)/iu);
  assert.match(script, /chrome\.tabs\.(?:create|update|remove)/u);
  assert.match(script, /onCreated|onUpdated|onActivated|onRemoved/u);
  assert.doesNotMatch(`${html}\n${script}\n${blank}`, /https?:\/\//u);
});

test('packaged tab controller observes synchronous Chrome events before API promises settle', async () => {
  const script = await readFile(new URL('../fixtures/real-tab-harness.js', import.meta.url), 'utf8');
  const listeners = new Set();
  const event = {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(...args) { for (const listener of [...listeners]) listener(...args); },
  };
  const tab = { id: 17, windowId: 4, status: 'complete', active: false };
  const sandbox = {
    setTimeout, clearTimeout,
    chrome: { tabs: {
      onCreated: event, onUpdated: event, onActivated: event, onRemoved: event,
      async query() { return []; },
      async create(options) {
        assert.equal(listeners.size, 1);
        tab.pendingUrl = options.url;
        event.emit({ ...tab });
        await Promise.resolve();
        return { ...tab };
      },
      async get() { return { ...tab }; },
      async update() { throw new Error('not used'); },
      async remove() { throw new Error('not used'); },
    } },
  };
  runInNewContext(script, sandbox);
  const proof = await sandbox.__auditaRealTabHarnessV1.run({
    kind: 'create', operationId: 'op-1',
    url: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/test/e2e/fixtures/real-tab-blank.html?run=run&operation=op-1',
    active: false,
  });
  assert.equal(proof.tabId, 17);
  assert.equal(listeners.size, 0);
});

test('attribute and identity helpers return closed document proofs', async () => {
  const target = {
    targetId: 'page-1',
    async command(method, params) {
      if (method === 'Runtime.evaluate') {
        assert.match(params.expression, /getAttribute/u);
        return { result: { value: 'audit-1' } };
      }
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'frame-1', loaderId: 'loader-1', url: 'http://127.0.0.1/page?private=x' } } };
      }
      return {};
    },
  };
  assert.equal(await readAttribute(target, '[data-audit-id]', 'data-audit-id'), 'audit-1');
  assert.deepEqual(await identityOf(target), {
    targetId: 'page-1', frameId: 'frame-1', loaderId: 'loader-1', url: 'http://127.0.0.1/page?private=x',
  });
  assert.deepEqual(await identityOf({ targetId: 'page-1', page: target }), {
    targetId: 'page-1', frameId: 'frame-1', loaderId: 'loader-1', url: 'http://127.0.0.1/page?private=x',
  });
  await assert.rejects(readAttribute(target, '', 'data-audit-id'), error => error.code === 'ATTRIBUTE_DENIED');
});

test('runtime context query accepts only the exact closed filter and result shape', async () => {
  const launch = { harnessPage: { async command(method, params) {
    assert.equal(method, 'Runtime.evaluate');
    assert.match(params.expression, /contextTypes/u);
    return { result: { value: [{ contextType: 'SIDE_PANEL', documentId: 'doc-1', documentUrl: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/src/panel/index.html' }] } };
  } } };
  assert.equal((await runtimeContexts(launch, { contextTypes: ['SIDE_PANEL'] })).length, 1);
  await assert.rejects(runtimeContexts(launch, { documentUrls: ['https://private.invalid/'] }),
    error => error.code === 'CONTEXT_PROOF_DENIED');
});

test('four-download proof hashes bytes and matches the durable receipt in canonical order', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'audita-real-chrome-downloads-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rows = [
    ['html', 'text/html;charset=utf-8', 'audit.html', '<!doctype html>', 11],
    ['pdf', 'application/pdf', 'audit.pdf', '%PDF-1.7', 12],
    ['csv', 'text/csv;charset=utf-8', 'audit.csv', '\uFEFF"id"\r\n', 13],
    ['json', 'application/json;charset=utf-8', 'audit.json', '{"version":1}', 14],
  ];
  const formats = [];
  for (const [format, mimeType, filename, value, downloadId] of rows) {
    await writeFile(join(root, filename), value);
    const bytes = Buffer.from(value);
    formats.push({ format, mimeType, byteSize: bytes.length,
      sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'), downloadId, state: 'complete' });
  }
  const launch = { downloadDirectory: root, async readExportReceipt(auditId) {
    return { version: 1, auditId, status: 'complete', formats };
  } };
  const result = await waitForFourDownloads(launch, { auditId: 'audit-1', timeoutMs: 100, intervalMs: 1 });
  assert.deepEqual(result.map(item => item.format), ['html', 'pdf', 'csv', 'json']);
  assert.deepEqual(result.map(item => item.filename), ['audit.html', 'audit.pdf', 'audit.csv', 'audit.json']);
  assert.equal(Object.isFrozen(result), true);
  formats[0] = { ...formats[0], sha256: '0'.repeat(64) };
  await assert.rejects(waitForFourDownloads(launch, { auditId: 'audit-1', timeoutMs: 5, intervalMs: 1 }),
    error => error.code === 'DOWNLOAD_PROOF_TIMEOUT');
});

test('journey and visual captures hash measured files without claiming equality', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'audita-real-chrome-qa-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const actualBytes = Buffer.from('actual-png');
  const reference = join(root, 'reference.png');
  await writeFile(reference, 'reference-png');
  const launch = {
    qaDirectory: root,
    harnessPage: {},
    async renderVisualComparison() {
      return { png: Buffer.from('combined-png'), actual: { width: 100, height: 50 }, reference: { width: 90, height: 40 }, output: { width: 190, height: 50 } };
    },
  };
  const journey = await captureJourney(launch, 'panel-summary', { async command(_method, params) {
    assert.equal(params.captureBeyondViewport, false);
    return { data: actualBytes.toString('base64') };
  } }, { captureBeyondViewport: false });
  assert.equal(journey.name, 'panel-summary.png');
  const comparison = await captureVisualComparison(launch, {
    actual: 'panel-summary.png', reference, output: 'panel-reference-side-by-side.png',
  });
  assert.deepEqual(comparison.actual.dimensions, { width: 100, height: 50 });
  assert.deepEqual(comparison.reference.dimensions, { width: 90, height: 40 });
  assert.deepEqual(comparison.output.dimensions, { width: 190, height: 50 });
  assert.equal(Object.hasOwn(comparison, 'equal'), false);
  assert.equal(await readFile(join(root, 'panel-reference-side-by-side.png'), 'utf8'), 'combined-png');
});

test('diagnostic redaction removes URLs, Chrome IDs, query secrets and bearer values', () => {
  const value = redactDiagnostic('failed https://private.invalid/path?token=secret chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/page Bearer abc.def');
  assert.doesNotMatch(value, /private|secret|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|abc\.def|https?:|chrome-extension:/u);
});

test('QA preservation is indexed, immutable and idempotent for an exact milestone root', async t => {
  const source = await realpath(await mkdtemp(join(tmpdir(), 'audita-real-chrome-qa-source-')));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'audita-real-chrome-workspace-')));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(async () => {
    await chmod(join(workspace, 'artifacts', 'qa', 'marco-1', '152', 'a'.repeat(40)), 0o755).catch(() => {});
    await rm(workspace, { recursive: true, force: true });
  });
  const artifacts = join(workspace, 'artifacts');
  const qa = join(artifacts, 'qa');
  const destination = join(qa, 'marco-1');
  await mkdir(destination, { recursive: true });
  await writeFile(join(source, 'panel.png'), 'png-bytes');
  const args = { sourceDir: source, destinationRoot: destination, chromeMajor: 152, candidateCommit: 'a'.repeat(40) };
  const first = await preserveQaRun(args);
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.equal(await preserveQaRun(args), first);
  assert.equal((await stat(join(destination, '152', 'a'.repeat(40), 'panel.png'))).mode & 0o777, 0o444);
  assert.equal((await stat(join(destination, '152', 'a'.repeat(40), 'index.json'))).mode & 0o777, 0o444);
  const falseMilestone = join(workspace, 'not-artifacts', 'marco-1');
  await mkdir(falseMilestone, { recursive: true });
  await assert.rejects(preserveQaRun({ ...args, destinationRoot: falseMilestone }),
    error => error.code === 'QA_PRESERVE_DENIED');
  await writeFile(join(source, 'extra.png'), 'different');
  await assert.rejects(preserveQaRun(args), error => error.code === 'QA_PRESERVE_DENIED');
});
