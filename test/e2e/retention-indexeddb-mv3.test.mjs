import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_CHROME_PRODUCT,
  launchUnpackedExtension,
  resolveRealChromeTestBinary,
} from './support/real-chrome.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const chromeBinary = resolveRealChromeTestBinary();
const harnessPath = 'test/e2e/fixtures/retention-harness.html';
const sensitiveMarker = 'RETENTION-PRIVATE-MARKER-641927';
const runtimeProbeByRole = Object.freeze({
  harness: 'AUDITA_RUNTIME_LOG_PROBE_HARNESS',
  'service-worker': 'AUDITA_RUNTIME_LOG_PROBE_SERVICE_WORKER',
  panel: 'AUDITA_RUNTIME_LOG_PROBE_PANEL',
  review: 'AUDITA_RUNTIME_LOG_PROBE_REVIEW',
  export: 'AUDITA_RUNTIME_LOG_PROBE_EXPORT',
});

test('physical download gate waits for Chrome temporary files to leave the correlated history set', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'audita-download-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const expected = [
    'fixture-delivery-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.csv',
    'fixture-delivery-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.html',
    'fixture-delivery-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json',
    'fixture-delivery-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf',
  ];
  const temporary = ['browser-stage.html', 'browser-stage.tmp'];
  await Promise.all([...expected, ...temporary].map(name => writeFile(join(directory, name), 'bytes')));
  const cleanup = delay(30).then(() => Promise.all(temporary.map(name => rm(join(directory, name)))));

  const files = await waitForDownloadedFiles(directory, expected, 1_000);
  await cleanup;

  assert.equal(files.length, expected.length);
  assert.equal(files.every((name, index) => name === [...expected].sort()[index]), true);
});

test('physical download gate waits until every correlated file is nonempty', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'audita-download-size-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const expected = [
    'fixture-delivery-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.html',
  ];
  await writeFile(join(directory, expected[0]), '');
  let filled = false;
  const fill = delay(30).then(async () => {
    await writeFile(join(directory, expected[0]), 'bytes');
    filled = true;
  });

  try {
    await waitForDownloadedFiles(directory, expected, 1_000);
    assert.equal(filled, true);
  } finally {
    await fill;
  }
});

test('auto-attached runtime capture is independent from target URL lifecycle', async t => {
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const extensionUrl = path => `chrome-extension://${extensionId}${path}`;

  await t.test('blank target is enabled before resume and later promoted to panel', async t => {
    const capture = createRuntimeCaptureHarness(t);
    await capture.start(extensionId);
    const resumed = capture.nextCommand(command => command.sessionId === 'blank-panel' &&
      command.method === 'Runtime.runIfWaitingForDebugger');
    capture.attach('target-blank-panel', 'blank-panel', 'page', 'about:blank');
    await resumed;
    capture.change('target-blank-panel', 'page', extensionUrl('/src/panel/index.html'));
    assert.deepEqual(await capture.final(['panel']), { sinksReady: true, sanitized: true });
    assert.deepEqual(capture.runtimeMethods('blank-panel').slice(0, 2), [
      'Runtime.enable', 'Runtime.runIfWaitingForDebugger',
    ]);
  });

  await t.test('exception captured before targetInfoChanged fails after extension promotion', async t => {
    const capture = createRuntimeCaptureHarness(t);
    await capture.start(extensionId);
    const resumed = capture.nextCommand(command => command.sessionId === 'preclassified-leak' &&
      command.method === 'Runtime.runIfWaitingForDebugger');
    capture.attach('target-preclassified-leak', 'preclassified-leak', 'page', 'about:blank');
    await resumed;
    capture.exception('preclassified-leak', sensitiveMarker);
    capture.change('target-preclassified-leak', 'page', extensionUrl('/src/panel/index.html'));
    assert.deepEqual(await capture.final(['panel']), { sinksReady: true, sanitized: false });
  });

  await t.test('one session proves panel and review after navigation', async t => {
    const capture = createRuntimeCaptureHarness(t);
    await capture.start(extensionId);
    capture.attach('target-panel-review', 'panel-review', 'page', extensionUrl('/src/panel/index.html'));
    assert.deepEqual(await capture.final(['panel']), { sinksReady: true, sanitized: true });
    capture.change('target-panel-review', 'page', extensionUrl('/src/review/index.html?auditId=probe'));
    assert.deepEqual(await capture.final(['panel', 'review']), { sinksReady: true, sanitized: true });
  });

  await t.test('non-extension marker is ignored only after pre-resume monitoring', async t => {
    const capture = createRuntimeCaptureHarness(t);
    await capture.start(extensionId);
    const resumed = capture.nextCommand(command => command.sessionId === 'external-page' &&
      command.method === 'Runtime.runIfWaitingForDebugger');
    capture.attach('target-external-page', 'external-page', 'page', 'https://example.test/page');
    await resumed;
    capture.exception('external-page', sensitiveMarker);
    capture.attach('target-clean-panel', 'clean-panel', 'page', extensionUrl('/src/panel/index.html'));
    assert.deepEqual(await capture.final(['panel']), { sinksReady: true, sanitized: true });
    assert.deepEqual(capture.runtimeMethods('external-page').slice(0, 2), [
      'Runtime.enable', 'Runtime.runIfWaitingForDebugger',
    ]);
  });

  await t.test('setup failure still resumes the target and fails extension readiness', async t => {
    const capture = createRuntimeCaptureHarness(t, { failRuntimeEnableFor: ['setup-failure'] });
    await capture.start(extensionId);
    const resumed = capture.nextCommand(command => command.sessionId === 'setup-failure' &&
      command.method === 'Runtime.runIfWaitingForDebugger');
    capture.attach('target-setup-failure', 'setup-failure', 'page', 'about:blank');
    await resumed;
    capture.change('target-setup-failure', 'page', extensionUrl('/src/panel/index.html'));
    assert.deepEqual(await capture.final(['panel']), { sinksReady: false, sanitized: false });
    assert.deepEqual(capture.runtimeMethods('setup-failure').slice(0, 2), [
      'Runtime.enable', 'Runtime.runIfWaitingForDebugger',
    ]);
  });

  await t.test('late extension leak invalidates an already ready role', async t => {
    const capture = createRuntimeCaptureHarness(t);
    await capture.start(extensionId);
    capture.attach('target-late-panel', 'late-panel', 'page', extensionUrl('/src/panel/index.html'));
    assert.deepEqual(await capture.final(['panel']), { sinksReady: true, sanitized: true });
    capture.exception('late-panel', sensitiveMarker);
    assert.deepEqual(await capture.final(['panel']), { sinksReady: true, sanitized: false });
  });
});

test('Chrome teardown stops waiting when a killed process emits no exit event', async () => {
  const listeners = new Map();
  let killSignal = '';
  const chrome = {
    exitCode: null,
    once(event, listener) { listeners.set(event, listener); },
    off(event, listener) { if (listeners.get(event) === listener) listeners.delete(event); },
    kill(signal) { killSignal = signal; return true; },
  };
  const started = Date.now();
  assert.equal(await terminateChromeProcess(chrome, 10), false);
  assert.equal(killSignal, 'SIGKILL');
  assert.ok(Date.now() - started < 1_000, 'o teardown deve ter limite explícito');
});

test('enforces retention and confirmed deletion through the native Side Panel and real MV3 IndexedDB', { timeout: 360_000 }, async t => {
  assert.ok(chromeBinary, 'AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório para o E2E real de retenção.');
  await access(chromeBinary, fsConstants.X_OK);
  const loopback = await startLoopbackSite();
  t.after(() => loopback.close());
  loopback.releaseAuditGate();
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(root), startUrl: loopback.baseUrl + '/source', chromeBinary,
    expectedMajor: 152, downloadMode: 'profile', viewport: { width: 1280, height: 800 },
  });
  assert.equal(extension.chromeProduct, CANONICAL_CHROME_PRODUCT);
  const publicProof = await runPublicBatchRetentionProof({ extension, loopback });
  assert.deepEqual(publicProof, {
    nativePanelOnly: true,
    explicitTwoPageBatch: true,
    crawlerTrapAvoided: true,
    consentBeforePixels: true,
    defaultRetentionPreserved: true,
    expiryNotExtendedByExport: true,
    retainedFourDownloads: true,
    manualDialogKeyboardAndCancel: true,
    manualDeletionCompleted: true,
    reportOptInDefaultOff: true,
    automaticFourDownloads: true,
    automaticDeletionCompleted: true,
    physicalDownloadsPreserved: true,
    narrowLayoutUsable: true,
    storageAndReportsSanitized: true,
  });
  const storageProof = await runRealStorageProof(extension.harnessPage);
  assert.deepEqual(storageProof, {
    databaseVersion: 3,
    retentionIndex: true,
    migratedRecords: 2,
    migrationPrivateKeysPreserved: true,
    metadataLimited: true,
    absoluteExpiry: true,
    casWinners: 1,
    casConflicts: 1,
    cleanupBlocked: 1,
    cleanupDeleted: 1,
    deleteBusy: true,
    deleteAfterRelease: true,
    rollbackAtomic: true,
    reopenPersistent: true,
    partialRetained: true,
    completePreservedBeforeStage: true,
    completeDeletedAfterStage: true,
    batchSingleMetadata: true,
    unauthorizedDeleteRejected: true,
    localStorageLimited: true,
    sessionStorageSanitized: true,
  });
});

function terminateChromeProcess(chrome, timeoutMs = 5_000) {
  if (chrome.exitCode !== null) return Promise.resolve(true);
  return new Promise(resolveExit => {
    let settled = false;
    const finish = exited => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.off?.('exit', onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.once('exit', onExit);
    if (chrome.exitCode !== null) {
      finish(true);
      return;
    }
    try { chrome.kill('SIGKILL'); } catch { finish(false); }
  });
}

function createRuntimeCaptureHarness(t, { failRuntimeEnableFor = [] } = {}) {
  const commandPipe = new PassThrough();
  const responsePipe = new PassThrough();
  const browser = new PipeCdp(commandPipe, responsePipe, [sensitiveMarker]);
  const failures = new Set(failRuntimeEnableFor);
  const commands = [];
  const commandWaiters = new Set();
  let commandBuffer = Buffer.alloc(0);
  const send = message => responsePipe.write(`${JSON.stringify(message)}\0`);
  const record = command => {
    commands.push({ method: command.method, sessionId: command.sessionId });
    for (const waiter of [...commandWaiters]) {
      if (!waiter.predicate(command)) continue;
      commandWaiters.delete(waiter);
      waiter.resolve(command);
    }
  };
  commandPipe.on('data', chunk => {
    commandBuffer = Buffer.concat([commandBuffer, chunk]);
    let delimiter;
    while ((delimiter = commandBuffer.indexOf(0)) >= 0) {
      const frame = commandBuffer.subarray(0, delimiter);
      commandBuffer = commandBuffer.subarray(delimiter + 1);
      if (!frame.length) continue;
      const command = JSON.parse(frame.toString('utf8'));
      record(command);
      if (command.method === 'Runtime.enable' && failures.has(command.sessionId)) {
        send({ id: command.id, sessionId: command.sessionId, error: { code: -32_000, message: 'setup failed' } });
        continue;
      }
      if (command.method === 'Runtime.evaluate') {
        const probe = Object.values(runtimeProbeByRole).find(value => command.params?.expression?.includes(value));
        if (probe) send({
          method: 'Runtime.consoleAPICalled', sessionId: command.sessionId,
          params: { args: [{ type: 'string', value: probe }] },
        });
        send({
          id: command.id, sessionId: command.sessionId,
          result: { result: { type: 'boolean', value: true } },
        });
        continue;
      }
      send({
        id: command.id, sessionId: command.sessionId,
        result: command.method === 'Target.getTargets' ? { targetInfos: [] } : {},
      });
    }
  });
  t.after(() => browser.close());

  return {
    start: extensionId => browser.captureExtensionRuntimeTargets(extensionId),
    attach(targetId, sessionId, type, url) {
      send({ method: 'Target.attachedToTarget', params: {
        sessionId, targetInfo: { targetId, type, url }, waitingForDebugger: true,
      } });
    },
    change(targetId, type, url) {
      send({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId, type, url } } });
    },
    exception(sessionId, marker) {
      send({
        method: 'Runtime.exceptionThrown', sessionId,
        params: { exceptionDetails: { text: marker } },
      });
    },
    final: roles => browser.finalRuntimeLogVerdict(roles),
    runtimeMethods(sessionId) {
      return commands.filter(command => command.sessionId === sessionId).map(command => command.method);
    },
    nextCommand(predicate) {
      const existing = commands.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise(resolveCommand => commandWaiters.add({ predicate, resolve: resolveCommand }));
    },
  };
}

async function startLoopbackSite() {
  const [pixelA, pixelB] = await Promise.all([
    readFile(join(root, 'assets/icons/icon-16.png')),
    readFile(join(root, 'assets/icons/icon-32.png')),
  ]);
  const requests = [];
  const sockets = new Set();
  let releaseAuditGate;
  let auditGateReleased = false;
  const auditGate = new Promise(resolveGate => { releaseAuditGate = resolveGate; });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    requests.push(url.pathname + url.search);
    if (url.pathname === '/pixel-a.png' || url.pathname === '/pixel-b.png') {
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      response.end(url.pathname === '/pixel-a.png' ? pixelA : pixelB);
      return;
    }
    if (url.pathname === '/crawler-trap') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html lang="pt-BR"><title>Armadilha</title><p>Não visitar.</p></html>');
      return;
    }
    if (url.pathname === '/page-a' && !auditGateReleased) await auditGate;
    const page = url.pathname === '/page-b' ? 'B' : url.pathname === '/page-a' ? 'A' : 'Origem';
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(`<!doctype html>
      <html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
      <title>Página local ${page}</title><style>
      body{font:16px/1.5 system-ui;margin:0;padding:24px;color:#17202a;background:#fff}
      main{max-width:42rem}button,a{min-height:44px;padding:10px;display:inline-block}
      </style></head><body><main><h1>Página local ${page}</h1>
      <p>Conteúdo determinístico para a auditoria pública de acessibilidade.</p>
      ${page === 'A' ? '<img src="/pixel-a.png" alt="Símbolo local A"><button type="button">Ação A</button>' : ''}
      ${page === 'B' ? '<img src="/pixel-b.png"><a href="/crawler-trap">Página relacionada</a>' : ''}
      </main></body></html>`);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object' && Number.isSafeInteger(address.port));
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    releaseAuditGate() {
      if (auditGateReleased) return;
      auditGateReleased = true;
      releaseAuditGate();
    },
    close() {
      this.releaseAuditGate();
      return new Promise(resolveClose => {
        server.close(() => resolveClose());
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}

async function runPublicBatchRetentionProof({ extension, loopback }) {
  const harness = extension.harnessPage;
  const urls = [loopback.baseUrl + '/page-a?token=' + sensitiveMarker,
    loopback.baseUrl + '/page-b?auth=' + sensitiveMarker];
  const exports = [];
  let nativePanelOnly = true;
  let consentBeforePixels = true;
  let narrowLayoutUsable = true;
  let manualDialogKeyboardAndCancel = false;
  let defaultRetentionPreserved = false;
  let expiryNotExtendedByExport = false;
  let reportOptInDefaultOff = true;
  let explicitTwoPageBatch = true;
  let sanitized = true;

  for (const optIn of [false, true]) {
    const panel = await extension.openSidePanelFromAction();
    const contexts = await extension.runtimeContexts({ contextTypes: ['SIDE_PANEL', 'POPUP'] });
    nativePanelOnly &&= contexts.filter(value => value.contextType === 'SIDE_PANEL').length === 1 &&
      contexts.every(value => value.contextType !== 'POPUP');
    await extension.waitForValue(panel, "document.querySelector('[data-screen]')?.dataset.screen",
      value => value === 'initial', { timeoutMs: 30_000, intervalMs: 50 });
    await extension.click(panel, '[data-intent="OPEN_BATCH_FORM"]');
    assert.equal(await extension.evaluate(panel, "document.querySelector('#delete-after-export') === null"), true,
      'a escolha de exclusão pertence ao relatório, não ao início da captura');
    await extension.click(panel, '[name="capture-mode"][value="full-evidence"]');
    await extension.evaluate(panel, "(() => { const input=document.querySelector('#audit-urls'); input.value=" +
      JSON.stringify(urls.join('\n')) + "; input.dispatchEvent(new Event('input',{bubbles:true})); })()");
    await extension.click(panel, '[data-action="start-batch-audit"]');

    for (const pageNumber of [1, 2]) {
      const paused = await extension.waitForValue(panel, "(() => { const root=document.querySelector('[data-screen]'); return {" +
        "screen:root?.dataset.screen,status:root?.dataset.sessionStatus,page:Number(root?.dataset.pageNumber)," +
        "confirm:Boolean(root?.querySelector('[data-action=\"confirm-pixel-capture\"]'))}; })()",
      value => value?.screen === 'result' || value?.screen === 'unavailable' ||
        value?.status === 'privacy-paused' && value.page === pageNumber && value.confirm,
      { timeoutMs: 90_000, intervalMs: 50 });
      assert.deepEqual(paused, { screen: 'running', status: 'privacy-paused', page: pageNumber, confirm: true });
      const privacy = await extension.evaluate(harness, "chrome.storage.session.get(null).then(session => ({" +
        "sanitized:!JSON.stringify(session).includes(" + JSON.stringify(sensitiveMarker) + ")," +
        "noInlinePixels:!JSON.stringify(session).includes('data:image')}))", { awaitPromise: true });
      consentBeforePixels &&= privacy.sanitized && privacy.noInlinePixels;
      assert.equal(await extension.evaluate(panel, 'document.body.innerText.includes(' + JSON.stringify(sensitiveMarker) + ')'), false);
      await extension.click(panel, '[data-action="confirm-pixel-capture"]');
    }
    const result = await extension.waitForValue(panel, "(() => { const root=document.querySelector('[data-screen]');" +
      " return {screen:root?.dataset.screen,auditId:root?.dataset.auditId??null}; })()",
    value => ['result', 'unavailable'].includes(value?.screen), { timeoutMs: 120_000, intervalMs: 50 });
    assert.equal(result.screen, 'result');
    assert.match(result.auditId, /^[A-Za-z0-9._:-]{1,160}$/u);
    const auditId = result.auditId;
    const stored = await readNativeAuditProof(extension, auditId);
    assert.equal(stored.present, true);
    assert.equal(stored.retentionOff, true);
    assert.equal(stored.pages, 2);
    assert.ok(stored.fullPageCaptures >= 2, 'as duas páginas devem conservar capturas autorizadas');
    assert.equal(stored.sanitized, true);
    assert.equal(Date.parse(stored.expiresAt) - Date.parse(stored.firstPersistedAt), 30 * 24 * 60 * 60 * 1000);
    explicitTwoPageBatch &&= stored.pages === 2;
    narrowLayoutUsable &&= await narrowLayoutProof(panel, '[data-focus-id="open-report"]');

    await extension.click(panel, '[data-focus-id="open-report"]');
    const report = await extension.waitForReport({ auditId });
    await extension.waitForValue(report,
      "Boolean(document.querySelector('button[data-report-export]')) && !document.querySelector('#delete-audit')?.disabled",
      Boolean, { timeoutMs: 30_000, intervalMs: 50 });
    const control = await extension.evaluate(report, "(() => {const input=document.querySelector('#delete-after-export');" +
      "return {exists:Boolean(input),checked:input?.checked,disabled:input?.disabled};})()");
    assert.deepEqual(control, { exists: true, checked: false, disabled: false });
    reportOptInDefaultOff &&= control.checked === false;
    narrowLayoutUsable &&= await narrowLayoutProof(report, '#delete-audit');

    const spoof = await extension.evaluate(report, "chrome.runtime.sendMessage({type:'AUDIT_DELETED',auditId:" +
      JSON.stringify(auditId) + ",reason:'delete-one'}).catch(()=>null)", { awaitPromise: true });
    void spoof;
    assert.equal((await readNativeAuditProof(extension, auditId)).present, true,
      'uma mensagem de exclusão emitida pelo relatório não concede autorização');
    assert.equal(await extension.evaluate(report, "!document.querySelector('#delete-audit').disabled"), true);
    if (optIn) await extension.click(report, '#delete-after-export');

    const beforeIds = await extension.evaluate(harness, 'chrome.downloads.search({}).then(rows=>rows.map(row=>row.id))',
      { awaitPromise: true });
    await extension.click(report, 'button[data-report-export]');
    // O receipt é apagado pelo cleanup pós-exportação. A prova física não depende de relê-lo depois da exclusão.
    const downloads = await waitForNewPhysicalDownloads(extension, auditId, beforeIds);
    exports.push(downloads);
    const json = JSON.parse((await readFile(join(extension.downloadDirectory,
      downloads.find(row => row.format === 'json').filename), 'utf8')).replace(/^\uFEFF/u, ''));
    assert.equal(json.audit.auditId, auditId);
    assert.equal(json.audit.pages.length, 2);
    for (const row of downloads) {
      const bytes = await readFile(join(extension.downloadDirectory, row.filename));
      sanitized &&= !bytes.includes(Buffer.from(sensitiveMarker));
    }

    if (!optIn) {
      const retained = await extension.waitForValue(harness, nativeAuditProofExpression(auditId),
        value => value?.present === true && value.journalSettled, { timeoutMs: 20_000, intervalMs: 50 });
      defaultRetentionPreserved = retained.retentionOff && retained.present;
      expiryNotExtendedByExport = retained.expiresAt === stored.expiresAt &&
        retained.firstPersistedAt === stored.firstPersistedAt;
      await focus(report, '#delete-audit');
      await pressKey(report, 'Enter', 'Enter', 13);
      await extension.waitForValue(report, 'document.activeElement?.id', value => value === 'delete-audit-cancel');
      await pressKey(report, 'Escape', 'Escape', 27);
      await extension.waitForValue(report, "document.querySelector('#delete-audit-dialog').open", value => value === false);
      assert.equal((await readNativeAuditProof(extension, auditId)).present, true);
      manualDialogKeyboardAndCancel = /exclusão cancelada/iu.test(
        await extension.evaluate(report, "document.querySelector('#review-status').textContent"));
      await focus(report, '#delete-audit');
      await pressKey(report, 'Enter', 'Enter', 13);
      await extension.waitForValue(report, 'document.activeElement?.id', value => value === 'delete-audit-cancel');
      await pressKey(report, 'Tab', 'Tab', 9);
      await extension.waitForValue(report, 'document.activeElement?.id', value => value === 'delete-audit-confirm');
      // O coordinator fecha a própria aba do relatório. O sucesso é comprovado no harness independente.
      await pressKey(report, 'Enter', 'Enter', 13).catch(() => {});
    }
    const deleted = await extension.waitForValue(harness, nativeAuditProofExpression(auditId),
      value => value?.present === false && value.retentionAbsent && value.journalSettled && value.tombstoneAbsent,
      { timeoutMs: 30_000, intervalMs: 50 });
    assert.equal(deleted.receiptAbsent, true);
    assert.equal(deleted.sanitized, true);
    await extension.waitForValue(harness, "chrome.tabs.query({}).then(tabs=>tabs.every(tab=>{" +
      "try{const url=new URL(tab.url);return url.pathname!='/src/review/index.html'||url.searchParams.get('auditId')!==" +
      JSON.stringify(auditId) + ";}catch{return true;}}))", Boolean, { timeoutMs: 20_000, intervalMs: 50 });
  }

  const all = exports.flat();
  const names = await completedDownloadBasenames(harness);
  assert.equal(names.length, 8);
  const physical = await waitForDownloadedFiles(extension.downloadDirectory, names, 30_000);
  const stats = await Promise.all(all.map(row => stat(join(extension.downloadDirectory, row.filename))));
  const hashes = await Promise.all(all.map(async row => createHash('sha256')
    .update(await readFile(join(extension.downloadDirectory, row.filename))).digest('hex')));
  const storage = await extension.evaluate(harness,
    'Promise.all([chrome.storage.local.get(null),chrome.storage.session.get(null)]).then(values=>JSON.stringify(values))',
    { awaitPromise: true });
  sanitized &&= !storage.includes(sensitiveMarker);
  return {
    nativePanelOnly, explicitTwoPageBatch,
    crawlerTrapAvoided: !loopback.requests.some(value => value.startsWith('/crawler-trap')),
    consentBeforePixels, defaultRetentionPreserved, expiryNotExtendedByExport,
    retainedFourDownloads: exports[0].length === 4,
    manualDialogKeyboardAndCancel, manualDeletionCompleted: true, reportOptInDefaultOff,
    automaticFourDownloads: exports[1].length === 4, automaticDeletionCompleted: true,
    physicalDownloadsPreserved: physical.length === 8 && stats.every((value, index) =>
      value.size === all[index].byteLength && hashes[index] === all[index].sha256),
    narrowLayoutUsable, storageAndReportsSanitized: sanitized,
  };
}

function nativeAuditProofExpression(auditId) {
  return "(async()=>{const {createAuditStore}=await import(chrome.runtime.getURL('/src/storage/audit-store.js'));" +
    "const store=createAuditStore();const id=" + JSON.stringify(auditId) + ";" +
    "const [model,retention,journal,lease,tombstones,receipt]=await Promise.all([store.getAudit(id),store.getAuditRetention(id)," +
    "store.getExportDeliveryJournal(id),store.getExportLeaseState(id,{now:new Date().toISOString()})," +
    "store.listDeletionTombstonesV1({limit:25}),store.getExportReceipt(id)]);" +
    "return {present:model?.auditId===id,pages:model?.pages?.length??0," +
    "fullPageCaptures:(model?.evidence??[]).filter(item=>item.kind==='full-page'&&typeof item.dataUrl==='string').length," +
    "retentionOff:retention?.deleteAfterCompleteExport===false,retentionAbsent:retention===undefined," +
    "firstPersistedAt:retention?.firstPersistedAt??null,expiresAt:retention?.expiresAt??null," +
    "journalSettled:journal.length===0&&lease.active!==true,tombstoneAbsent:!tombstones.some(item=>item.auditId===id)," +
    "receiptAbsent:receipt===null||receipt===undefined,sanitized:!JSON.stringify({model,retention}).includes(" +
    JSON.stringify(sensitiveMarker) + ")};})()";
}

async function readNativeAuditProof(extension, auditId) {
  return extension.evaluate(extension.harnessPage, nativeAuditProofExpression(auditId), { awaitPromise: true });
}

async function waitForNewPhysicalDownloads(extension, auditId, beforeIds) {
  const rows = await extension.waitForValue(extension.harnessPage,
    "chrome.downloads.search({}).then(rows=>rows.filter(row=>!" + JSON.stringify(beforeIds) +
    ".includes(row.id)).map(row=>({id:row.id,state:row.state,exists:row.exists,mime:row.mime," +
    "filename:String(row.filename).split(/[\\\\/]/u).at(-1),size:row.fileSize})))",
    rows => rows.length === 4 && rows.every(row => row.state === 'complete' && row.exists !== false && row.size > 0),
    { timeoutMs: 90_000, intervalMs: 50 });
  const formats = rows.map(row => row.filename.split('.').at(-1)).sort();
  assert.deepEqual(formats, ['csv', 'html', 'json', 'pdf']);
  assert.equal(new Set(rows.map(row => row.id)).size, 4);
  const mime = { html: 'text/html', pdf: 'application/pdf', csv: 'text/csv', json: 'application/json' };
  const records = [];
  for (const row of rows) {
    const format = row.filename.split('.').at(-1);
    assert.equal(row.mime.split(';')[0], mime[format]);
    const bytes = await readFile(join(extension.downloadDirectory, row.filename));
    assert.equal(bytes.byteLength, row.size);
    assert.ok(bytes.byteLength > 0);
    records.push({ auditId, format, filename: row.filename, downloadId: row.id, byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return records;
}

async function narrowLayoutProof(page, selector) {
  await page.command('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
  try {
    const state = await evaluate(page, "(()=>{const button=document.querySelector(" + JSON.stringify(selector) +
      ");button?.focus();return {height:button?.getBoundingClientRect().height??0," +
      "overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1," +
      "outline:button?getComputedStyle(button).outlineStyle:'none'};})()");
    return state.height >= 44 && !state.overflow && state.outline !== 'none';
  } finally { await page.command('Emulation.clearDeviceMetricsOverride'); }
}


async function completedDownloadBasenames(page) {
  return evaluate(page, `chrome.downloads.search({}).then(items => items
    .filter(item => item.state === 'complete' && item.exists !== false &&
      /\\.(?:html|json|csv|pdf)$/iu.test(item.filename || ''))
    .map(item => String(item.filename).split(/[\\\\/]/u).at(-1)))`, true, 20_000);
}

async function waitForDownloadedFiles(directory, expectedBasenames, timeoutMs) {
  if (!Array.isArray(expectedBasenames) || expectedBasenames.length === 0 ||
    expectedBasenames.some(name => typeof name !== 'string' || name.length === 0)) {
    throw new TypeError('Nomes físicos esperados inválidos.');
  }
  const expected = new Set(expectedBasenames);
  const started = Date.now();
  let files = [];
  while (Date.now() - started < timeoutMs) {
    files = await readdir(directory);
    if (files.length === expected.size && files.every(name => expected.has(name))) {
      try {
        const stats = await Promise.all(files.map(name => stat(join(directory, name))));
        if (stats.every(value => value.size > 0)) return files.sort();
      } catch { /* o diretório ainda está convergindo */ }
    }
    await delay(50);
  }
  throw new Error(`Arquivos físicos não convergiram com o histórico; contagem segura=${files.length}`);
}


async function runRealStorageProof(page) {
  return evaluate(page, `(async () => {
    const marker = ${JSON.stringify(sensitiveMarker)};
    const T0 = '2026-08-26T14:02:00.000Z';
    const T30 = '2026-09-25T14:02:00.000Z';
    const { SAMPLE_AUDIT } = await import(chrome.runtime.getURL('/fixtures/audits/sample-audit.js'));
    const auditFixture = (auditId, tag = 'fixture') => {
      const model = structuredClone(SAMPLE_AUDIT);
      model.auditId = auditId;
      model.versions.extension = 'test-' + tag;
      return model;
    };
    const request = operation => new Promise((resolve, reject) => {
      operation.onsuccess = () => resolve(operation.result);
      operation.onerror = () => reject(new Error('indexeddb request failed'));
    });
    const transaction = value => new Promise((resolve, reject) => {
      value.oncomplete = () => resolve();
      value.onerror = () => reject(new Error('indexeddb transaction failed'));
      value.onabort = () => reject(new Error('indexeddb transaction aborted'));
    });
    const open = (version, upgrade) => new Promise((resolve, reject) => {
      const operation = indexedDB.open('audita-retention-storage-proof', version);
      operation.onupgradeneeded = () => upgrade?.(operation.result, operation.transaction);
      operation.onsuccess = () => resolve(operation.result);
      operation.onerror = () => reject(new Error('indexeddb open failed'));
      operation.onblocked = () => reject(new Error('indexeddb open blocked'));
    });
    await new Promise((resolve, reject) => {
      const operation = indexedDB.deleteDatabase('audita-retention-storage-proof');
      operation.onsuccess = () => resolve();
      operation.onerror = () => reject(new Error('indexeddb reset failed'));
      operation.onblocked = () => reject(new Error('indexeddb reset blocked'));
    });

    const legacyDb = await open(1, database => database.createObjectStore('audits'));
    const legacyTx = legacyDb.transaction('audits', 'readwrite');
    const legacy = legacyTx.objectStore('audits');
    legacy.put(auditFixture('legacy-batch-a', 'legacy-a'), 'legacy-batch-a');
    legacy.put(auditFixture('legacy-batch-b', 'legacy-b'), 'legacy-batch-b');
    legacy.put({ auditId: 'legacy-batch-a', status: 'complete' }, '__latest__');
    legacy.put(4, '__audit_revision__:legacy-batch-a');
    legacy.put(2, '__audit_export_attempt__:legacy-batch-a');
    legacy.put({ schemaVersion: 1, auditId: 'legacy-batch-a', entries: [] }, '__audit_export_delivery__:legacy-batch-a');
    await transaction(legacyTx);
    legacyDb.close();

    const { createAuditStore } = await import(chrome.runtime.getURL('src/storage/audit-store.js'));
    // Banco separado: nenhuma prova de migração apaga o banco usado pelo worker ou seus Ports.
    const createProofStore = () => createAuditStore({
      indexedDB: { open(_name, version) { return indexedDB.open('audita-retention-storage-proof', version); } },
      IDBKeyRange,
    });
    const first = createProofStore();
    const second = createProofStore();
    const [metaA, metaB] = await Promise.all([
      first.getAuditRetention('legacy-batch-a'), first.getAuditRetention('legacy-batch-b'),
    ]);
    const upgradedDb = await open(3);
    const schemaTx = upgradedDb.transaction(['audits', 'audit-retention'], 'readonly');
    const auditKeys = await request(schemaTx.objectStore('audits').getAllKeys());
    const metadata = await request(schemaTx.objectStore('audit-retention').getAll());
    const retentionIndex = schemaTx.objectStore('audit-retention').indexNames.contains('byExpiresAt');
    await transaction(schemaTx);
    const databaseVersion = upgradedDb.version;
    upgradedDb.close();

    const [snapshotA, snapshotB] = await Promise.all([
      first.getAuditSnapshot('legacy-batch-a'), second.getAuditSnapshot('legacy-batch-a'),
    ]);
    const cas = await Promise.allSettled([
      first.commitAuditIfRevision(
        'legacy-batch-a', auditFixture('legacy-batch-a', 'cas-first'),
        { auditId: 'legacy-batch-a', status: 'complete' }, snapshotA.capability,
      ),
      second.commitAuditIfRevision(
        'legacy-batch-a', auditFixture('legacy-batch-a', 'cas-second'),
        { auditId: 'legacy-batch-a', status: 'complete' }, snapshotB.capability,
      ),
    ]);
    const casWinners = cas.filter(result => result.status === 'fulfilled').length;
    const casConflicts = cas.filter(result => result.status === 'rejected' && result.reason?.code === 'AUDIT_REVISION_CONFLICT').length;

    const currentA = await first.getAuditSnapshot('legacy-batch-a');
    await first.acquireExportLease('legacy-batch-a', currentA.capability, {
      ownerId: 'retention-e2e-owner', now: '2026-10-01T00:00:00.000Z',
    });
    const cleanup = await second.cleanupExpiredAudits({ now: '2026-10-01T00:01:00.000Z', limit: 25 });
    let deleteBusy = false;
    try { await first.deleteAudit('legacy-batch-a', currentA.capability, { now: '2026-10-01T00:01:00.000Z' }); }
    catch (error) { deleteBusy = error?.code === 'AUDIT_DELETE_BUSY'; }
    await first.releaseExportLease('legacy-batch-a', {
      ownerId: 'retention-e2e-owner', now: '2026-10-01T00:01:30.000Z',
    });
    const deletedLegacy = await first.deleteAudit(
      'legacy-batch-a', currentA.capability, { now: '2026-10-01T00:01:31.000Z' },
    );

    const persistedAt = new Date().toISOString();
    await first.commitAudit('rollback-stable', auditFixture('rollback-stable'), { auditId: 'rollback-stable', status: 'complete' }, { now: persistedAt });
    const rollbackDb = await open(3);
    const rollbackTx = rollbackDb.transaction(['audits', 'audit-retention'], 'readwrite');
    rollbackTx.objectStore('audits').put({ auditId: 'rollback-transient' }, 'rollback-transient');
    rollbackTx.objectStore('audit-retention').put({
      auditId: 'rollback-transient', schemaVersion: 1, firstPersistedAt: persistedAt,
      expiresAt: new Date(Date.parse(persistedAt) + 30 * 24 * 60 * 60 * 1000).toISOString(),
      deleteAfterCompleteExport: false,
    });
    const aborted = new Promise(resolve => {
      rollbackTx.onabort = () => resolve(true);
      rollbackTx.onerror = event => event.preventDefault();
    });
    rollbackTx.abort();
    await aborted;
    rollbackDb.close();
    const reopened = createProofStore();
    const rollbackAtomic = (await reopened.getAudit('rollback-transient')) === undefined &&
      (await reopened.getAuditRetention('rollback-transient')) === undefined &&
      (await reopened.getAudit('rollback-stable'))?.auditId === 'rollback-stable';
    await first.commitAudit('reopen-audit', auditFixture('reopen-audit', 'persisted'), { auditId: 'reopen-audit', status: 'complete' }, { now: persistedAt });
    const reopenPersistent = (await createProofStore().getAudit('reopen-audit'))?.versions?.extension === 'test-persisted';

    const prepareDelivery = async (auditId, ownerId, formats, seconds) => {
      let snapshot = await first.getAuditSnapshot(auditId);
      if (!snapshot.model) {
        await first.commitAudit(auditId, auditFixture(auditId, 'delivery-initial'),
          { auditId, status: 'complete' }, { now: persistedAt, deleteAfterCompleteExport: true });
        snapshot = await first.getAuditSnapshot(auditId);
      }
      const prefix = new Date(Date.parse(persistedAt) + seconds * 1000).toISOString().slice(0, -5);
      const lease = await first.acquireExportLease(auditId, snapshot.capability, {
        ownerId, now: prefix + '.000Z', ttlMs: 600000,
      });
      await first.claimExportLease(auditId, snapshot.capability, {
        ownerId, exportAttempt: lease.exportAttempt, now: prefix + '.100Z', ttlMs: 600000,
      });
      await first.beginExportDelivery(auditId, snapshot.capability, {
        ownerId, exportAttempt: lease.exportAttempt, now: prefix + '.200Z', ttlMs: 600000,
      });
      const mime = { html: 'text/html;charset=utf-8', pdf: 'application/pdf',
        csv: 'text/csv;charset=utf-8', json: 'application/json;charset=utf-8' };
      const receiptFormats = [];
      for (const [index, format] of formats.entries()) {
        const identity = { format, filename: 'auditoria.' + format, mimeType: mime[format],
          byteSize: 10 + index, sha256: String(index + 1).repeat(64), downloadId: seconds * 10 + index };
        await first.recordExportDelivery(auditId, snapshot.capability, {
          ownerId, exportAttempt: lease.exportAttempt,
          now: prefix + '.' + String(300 + index).padStart(3, '0') + 'Z',
          ...identity, state: 'terminal',
        });
        receiptFormats.push({ ...identity, status: 'complete' });
      }
      const status = formats.length === 4 ? 'complete' : 'partial';
      const finalized = await first.finalizeExportAndMaybeDelete(
        auditId, snapshot.model,
        { auditId, exportStatus: status,
          exportDeliveryIdentity: { auditId, modelRevision: snapshot.revision,
            modelHash: 'a'.repeat(64), attemptId: String(lease.exportAttempt) },
          deliveryReceipt: { status, limitations: status === 'complete' ? [] : ['Entrega incompleta'],
            formats: receiptFormats } },
        snapshot.capability,
        { ownerId, exportAttempt: lease.exportAttempt, now: prefix + '.900Z',
          clearDeliveryJournal: true, deleteAfterCompleteExport: true },
      );
      return { finalized, receipt: await first.getExportReceipt(auditId), now: prefix + '.950Z' };
    };
    const partial = await prepareDelivery('delete-after-four', 'partial-owner', ['html', 'pdf'], 10);
    const partialStage = await first.stageAuditDeletionV1({ auditId: 'delete-after-four', reason: 'post-export',
      now: partial.now, expectedRevision: partial.finalized.revision, terminalReceipt: partial.receipt });
    const partialRetained = partial.finalized.deleted === false && partialStage.status === 'denied' &&
      Boolean(await first.getAudit('delete-after-four')) && Boolean(await first.getAuditRetention('delete-after-four'));
    const complete = await prepareDelivery('delete-after-four', 'complete-owner', ['html', 'pdf', 'csv', 'json'], 20);
    const completePreservedBeforeStage = complete.finalized.deleted === false &&
      Boolean(await first.getAudit('delete-after-four')) && complete.receipt?.status === 'complete';
    const staged = await first.stageAuditDeletionV1({ auditId: 'delete-after-four', reason: 'post-export',
      now: complete.now, expectedRevision: complete.receipt.modelRevision + 1, terminalReceipt: complete.receipt });
    const completeDeletedAfterStage = staged.status === 'staged' && staged.tombstone.reason === 'post-export' &&
      (await first.getAudit('delete-after-four')) === undefined &&
      (await first.getAuditRetention('delete-after-four')) === undefined &&
      (await first.listDeletionTombstonesV1({ limit: 25 })).some(row => row.auditId === 'delete-after-four');

    for (const auditId of ['ui-one', 'ui-all-a', 'ui-all-b']) {
      await first.commitAudit(auditId, auditFixture(auditId, 'ui'),
        { auditId, status: 'complete', message: 'Auditoria disponível para exclusão.' }, { now: persistedAt });
    }
    const uiMetadata = await Promise.all(['ui-one', 'ui-all-a', 'ui-all-b'].map(id => first.getAuditRetention(id)));
    const unauthorized = await chrome.runtime.sendMessage({ type: 'REQUEST_DELETE_ALL_AUDITS' });
    const local = await chrome.storage.local.get(null);
    const session = await chrome.storage.session.get(null);
    const allowedLocalKeys = new Set(['audita:persona:voiceId', 'audita:persona:rate']);

    return {
      databaseVersion,
      retentionIndex,
      migratedRecords: metadata.length,
      migrationPrivateKeysPreserved: [
        '__latest__', '__audit_revision__:legacy-batch-a',
        '__audit_export_attempt__:legacy-batch-a', '__audit_export_delivery__:legacy-batch-a',
      ].every(key => auditKeys.includes(key)),
      metadataLimited: !JSON.stringify(metadata).includes(marker) && metadata.every(value => Object.keys(value).length === 5),
      absoluteExpiry: metaA.firstPersistedAt === T0 && metaA.expiresAt === T30 &&
        metaB.firstPersistedAt === T0 && metaB.expiresAt === T30,
      casWinners,
      casConflicts,
      cleanupBlocked: cleanup.blocked,
      cleanupDeleted: cleanup.deleted,
      deleteBusy,
      deleteAfterRelease: deletedLegacy.deleted === true,
      rollbackAtomic,
      reopenPersistent,
      partialRetained,
      completePreservedBeforeStage,
      completeDeletedAfterStage,
      batchSingleMetadata: uiMetadata.length === 3 && uiMetadata.every(value => value && Object.keys(value).length === 5),
      unauthorizedDeleteRejected: unauthorized?.ok !== true,
      localStorageLimited: allowedLocalKeys.size === 2 &&
        !allowedLocalKeys.has('audita:persona:voiceId-backup') &&
        Object.keys(local).every(key => allowedLocalKeys.has(key)) &&
        !JSON.stringify(local).includes(marker),
      sessionStorageSanitized: !JSON.stringify(session).includes(marker),
    };
  })()`, true, 35_000);
}


async function focus(page, selector) {
  await page.command('Page.bringToFront');
  await waitForValue(page, 'document.hasFocus()', Boolean);
  const focused = await evaluate(page, `(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    if (!control || control.disabled) return false;
    control.focus();
    return document.activeElement === control;
  })()`);
  assert.equal(focused, true, `controle indisponível: ${selector}`);
}

async function pressKey(page, key, code, virtualKeyCode) {
  const params = { key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode };
  if (key === 'Enter') {
    await page.command('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...params });
  } else if (key === 'Escape') {
    await page.command('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
  } else await page.command('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
  await page.command('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}

async function evaluate(page, expression, awaitPromise = false, timeoutMs = 10_000) {
  const evaluated = await page.command('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true,
  }, timeoutMs);
  if (evaluated.exceptionDetails) {
    throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
  }
  return evaluated.result?.value;
}

async function waitForValue(page, expression, predicate, timeoutMs = 10_000) {
  const started = Date.now();
  let latest;
  while (Date.now() - started < timeoutMs) {
    try {
      latest = await evaluate(page, expression, true);
      if (predicate(latest)) return latest;
    } catch { /* execution context can rotate during navigation */ }
    await delay(50);
  }
  throw new Error(`Condição E2E não satisfeita; último valor seguro=${JSON.stringify(latest)}`);
}


function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function classifyRuntimeTarget(targetInfo, extensionId) {
  if (!targetInfo || !['page', 'service_worker'].includes(targetInfo.type)) return { scope: 'discard' };
  if (!extensionId || targetInfo.url === '' || targetInfo.url === 'about:blank') return { scope: 'pending' };
  let url;
  try { url = new URL(targetInfo.url); } catch { return { scope: 'pending' }; }
  if (url.protocol !== 'chrome-extension:' || url.hostname !== extensionId) return { scope: 'discard' };
  let role = null;
  if (targetInfo.type === 'service_worker' && url.pathname === '/src/background/service-worker.js') {
    role = 'service-worker';
  } else if (targetInfo.type === 'page') {
    if (url.pathname === `/${harnessPath}`) role = 'harness';
    else if (url.pathname === '/src/panel/index.html') role = 'panel';
    else if (url.pathname === '/src/review/index.html') role = 'review';
    else if (url.pathname === '/src/export/index.html') role = 'export';
  }
  return { scope: 'extension', role };
}

class RuntimeTargetCapture {
  constructor({ command, waitForEvent, needles = [] }) {
    this.command = command;
    this.waitForEvent = waitForEvent;
    this.needles = [...needles];
    this.extensionId = '';
    this.sessions = new Map();
    this.targetSessions = new Map();
    this.tasks = new Set();
    this.readyRoles = new Set();
    this.extensionEventSeen = false;
    this.extensionLeak = false;
    this.extensionSetupFailed = false;
  }

  start() {
    return this.command('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [
        { type: 'page', exclude: false },
        { type: 'service_worker', exclude: false },
        { exclude: true },
      ],
    });
  }

  async setExtensionId(extensionId) {
    if (typeof extensionId !== 'string' || !/^[a-p]{32}$/u.test(extensionId)) {
      throw new TypeError('Identificador da extensão inválido.');
    }
    this.extensionId = extensionId;
    const targets = await this.command('Target.getTargets');
    for (const targetInfo of Array.isArray(targets?.targetInfos) ? targets.targetInfos : []) {
      this.classify(targetInfo);
    }
  }

  capture(message) {
    if (message.method === 'Runtime.consoleAPICalled' || message.method === 'Runtime.exceptionThrown') {
      this.captureRuntimeEvent(message);
      return;
    }
    if (message.method === 'Target.attachedToTarget') {
      this.attach(message.params);
      return;
    }
    if (message.method === 'Target.targetInfoChanged') {
      this.classify(message.params?.targetInfo);
      return;
    }
    if (message.method === 'Target.detachedFromTarget') this.detach(message.params?.sessionId);
  }

  attach(params) {
    const sessionId = params?.sessionId;
    const targetInfo = params?.targetInfo;
    const targetId = targetInfo?.targetId;
    if (typeof sessionId !== 'string' || typeof targetId !== 'string' ||
      !['page', 'service_worker'].includes(targetInfo?.type)) return;
    const state = this.sessions.get(sessionId) ?? {
      sessionId,
      scope: 'pending',
      roles: new Set(),
      eventSeen: false,
      leak: false,
      probeHits: new Set(),
      probeInFlight: new Set(),
      runtimeEnabled: false,
      resumeAttempted: false,
      resumeSucceeded: false,
      setupFailed: false,
      detached: false,
    };
    this.sessions.set(sessionId, state);
    this.targetSessions.set(targetId, sessionId);
    this.track(this.setup(state));
    this.classify(targetInfo);
  }

  classify(targetInfo) {
    const sessionId = this.targetSessions.get(targetInfo?.targetId);
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const classification = classifyRuntimeTarget(targetInfo, this.extensionId);
    if (classification.scope === 'pending') return;
    if (classification.scope === 'discard') {
      state.scope = 'discard';
      state.roles.clear();
      state.eventSeen = false;
      state.leak = false;
      state.probeHits.clear();
      return;
    }
    state.scope = 'extension';
    if (classification.role) state.roles.add(classification.role);
    this.promote(state);
    this.scheduleProbes(state);
  }

  async setup(state) {
    try {
      await this.command('Runtime.enable', {}, 10_000, state.sessionId);
      state.runtimeEnabled = true;
    } catch {
      state.setupFailed = true;
    }
    state.resumeAttempted = true;
    try {
      await this.command('Runtime.runIfWaitingForDebugger', {}, 10_000, state.sessionId);
      state.resumeSucceeded = true;
    } catch {
      state.setupFailed = true;
    }
    this.promote(state);
    this.scheduleProbes(state);
  }

  captureRuntimeEvent(message) {
    const state = this.sessions.get(message.sessionId);
    if (!state || state.scope === 'discard' || state.detached) return;
    state.eventSeen = true;
    if (message.method === 'Runtime.consoleAPICalled' && Array.isArray(message.params?.args)) {
      for (const [role, probe] of Object.entries(runtimeProbeByRole)) {
        if (message.params.args.some(argument => argument?.type === 'string' && argument.value === probe)) {
          state.probeHits.add(role);
        }
      }
    }
    try {
      const serialized = JSON.stringify(message.params);
      if (this.needles.some(needle => serialized.includes(needle))) state.leak = true;
    } catch {
      state.leak = true;
    }
    this.promote(state);
  }

  promote(state) {
    if (state.scope !== 'extension') return;
    this.extensionEventSeen ||= state.eventSeen;
    this.extensionLeak ||= state.leak;
    this.extensionSetupFailed ||= state.setupFailed;
    if (!state.runtimeEnabled || !state.resumeAttempted || !state.resumeSucceeded || state.setupFailed) return;
    for (const role of state.roles) {
      if (state.probeHits.has(role)) this.readyRoles.add(role);
    }
  }

  scheduleProbes(state) {
    if (state.scope !== 'extension' || state.detached || !state.runtimeEnabled ||
      !state.resumeAttempted || !state.resumeSucceeded || state.setupFailed) return;
    for (const role of state.roles) {
      if (state.probeHits.has(role) || state.probeInFlight.has(role)) continue;
      state.probeInFlight.add(role);
      this.track(this.probe(state, role));
    }
  }

  async probe(state, role) {
    const probe = runtimeProbeByRole[role];
    const observed = this.waitForEvent(
      'Runtime.consoleAPICalled',
      event => event.sessionId === state.sessionId && Array.isArray(event.params?.args) &&
        event.params.args.some(argument => argument?.type === 'string' && argument.value === probe),
    );
    try {
      const evaluated = await this.command('Runtime.evaluate', {
        expression: `console.debug(${JSON.stringify(probe)}); true`,
        returnByValue: true,
      }, 10_000, state.sessionId);
      if (evaluated?.exceptionDetails) throw new Error('Probe Runtime não executado.');
      await observed;
    } catch {
      observed.catch(() => undefined);
      if (state.scope === 'extension') this.extensionSetupFailed = true;
    } finally {
      state.probeInFlight.delete(role);
      this.promote(state);
    }
  }

  detach(sessionId) {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.detached = true;
      state.roles.clear();
      state.probeHits.clear();
    }
    this.sessions.delete(sessionId);
    for (const [targetId, correlatedSessionId] of this.targetSessions) {
      if (correlatedSessionId === sessionId) this.targetSessions.delete(targetId);
    }
  }

  track(promise) {
    const task = Promise.resolve(promise).finally(() => this.tasks.delete(task));
    this.tasks.add(task);
    return task;
  }

  async finalVerdict(requiredRoles) {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
    const sinksReady = requiredRoles.every(role => this.readyRoles.has(role));
    return {
      sinksReady,
      sanitized: sinksReady && this.extensionEventSeen &&
        !this.extensionSetupFailed && !this.extensionLeak,
    };
  }
}


class PipeCdp {
  constructor(commandPipe, responsePipe, runtimeLogNeedles = []) {
    this.commandPipe = commandPipe;
    this.responsePipe = responsePipe;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Set();
    this.runtimeTargetCapture = new RuntimeTargetCapture({
      command: (method, params = {}, timeoutMs = 10_000, sessionId = undefined) =>
        this.command(method, params, timeoutMs, sessionId),
      waitForEvent: (method, predicate, timeoutMs = 10_000) =>
        this.waitForEvent(method, predicate, timeoutMs),
      needles: runtimeLogNeedles,
    });
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
          this.captureEvent(message);
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
        pending.reject(new Error('CDP encerrado.'));
      }
      this.pending.clear();
      for (const waiter of this.eventWaiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('CDP encerrado.'));
      }
      this.eventWaiters.clear();
    });
  }

  captureEvent(message) {
    this.runtimeTargetCapture.capture(message);
    for (const waiter of [...this.eventWaiters]) {
      if (waiter.method !== message.method) continue;
      let matched = false;
      try { matched = waiter.predicate(message); } catch { matched = false; }
      if (!matched) continue;
      this.eventWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }

  waitForEvent(method, predicate, timeoutMs = 10_000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const waiter = { method, predicate, resolve: resolveEvent, reject: rejectEvent, timer: null };
      waiter.timer = setTimeout(() => {
        this.eventWaiters.delete(waiter);
        rejectEvent(new Error(`CDP timeout em evento ${method}.`));
      }, timeoutMs);
      this.eventWaiters.add(waiter);
    });
  }

  startRuntimeTargetCapture() {
    return this.runtimeTargetCapture.start();
  }

  async captureExtensionRuntimeTargets(extensionId) {
    await this.startRuntimeTargetCapture();
    await this.setRuntimeExtensionId(extensionId);
  }

  setRuntimeExtensionId(extensionId) {
    return this.runtimeTargetCapture.setExtensionId(extensionId);
  }

  finalRuntimeLogVerdict(requiredRoles) {
    return this.runtimeTargetCapture.finalVerdict(requiredRoles);
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

  close() {
    try { this.commandPipe.destroy(); } catch { /* Chrome pode já ter encerrado */ }
    try { this.responsePipe.destroy(); } catch { /* Chrome pode já ter encerrado */ }
  }
}
