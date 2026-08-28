import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const chromeBinary = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const harnessPath = 'test/e2e/fixtures/retention-harness.html';
const sensitiveMarker = 'RETENTION-PRIVATE-MARKER-641927';

test('enforces retention and confirmed deletion in real MV3 IndexedDB and UI', { timeout: 90_000 }, async t => {
  await access(chromeBinary, fsConstants.X_OK);
  const profile = await mkdtemp(join(tmpdir(), 'audita-retention-chrome-'));
  const chrome = spawn(chromeBinary, [
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
    '--remote-debugging-pipe', '--window-position=-10000,-10000', '--window-size=1280,800',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let chromeStderr = '';
  chrome.stderr.on('data', chunk => { chromeStderr = `${chromeStderr}${chunk}`.slice(-12_000); });
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
  try { await browser.command('Browser.getVersion'); }
  catch (error) {
    await delay(50);
    throw new Error(`Chrome real não iniciou o CDP: ${error.message}; exit=${chrome.exitCode}; stderr=${chromeStderr}`);
  }
  await browser.command('Target.setDiscoverTargets', { discover: true });
  const loaded = await browser.command('Extensions.loadUnpacked', { path: root }, 15_000);
  const extensionId = loaded?.id;
  assert.match(extensionId || '', /^[a-p]{32}$/u);

  const harnessUrl = `chrome-extension://${extensionId}/${harnessPath}`;
  await browser.command('Target.createTarget', { url: harnessUrl });
  const harnessInfo = await waitForTargetInfo(
    browser,
    info => info.type === 'page' && info.url === harnessUrl,
    chromeStderr,
  );
  const harness = await attach(browser, harnessInfo.targetId);
  await harness.command('Runtime.enable');
  await harness.command('Page.enable');
  await waitForValue(harness, 'document.readyState === "complete"', Boolean);

  const storageProof = await runRealStorageProof(harness);
  assert.deepEqual(storageProof, {
    databaseVersion: 2,
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
    completeDeleted: true,
    batchSingleMetadata: true,
    unauthorizedDeleteRejected: true,
    localStorageLimited: true,
    sessionStorageSanitized: true,
  });

  const reviewUrl = `chrome-extension://${extensionId}/src/review/index.html?auditId=ui-one`;
  const review = await openExtensionPage(browser, reviewUrl, chromeStderr);
  await exerciseDeleteOneDialog(review);

  const panelUrl = `chrome-extension://${extensionId}/src/panel/index.html`;
  const panel = await openExtensionPage(browser, panelUrl, chromeStderr);
  await exerciseDeleteAllDialogAndResponsiveUi(panel);

  const finalProof = await evaluate(panel, `import(chrome.runtime.getURL('src/storage/audit-store.js')).then(async ({ createAuditStore }) => {
    const store = createAuditStore();
    const [one, allA, allB, latest] = await Promise.all([
      store.getAudit('ui-one'), store.getAudit('ui-all-a'), store.getAudit('ui-all-b'), store.getLatest(),
    ]);
    const local = await chrome.storage.local.get(null);
    const session = await chrome.storage.session.get(null);
    return {
      everyAuditDeleted: one === undefined && allA === undefined && allB === undefined && latest === undefined,
      localKeysAllowed: Object.keys(local).every(key => /voice|rate/iu.test(key)),
      sessionHasPrivateMarker: JSON.stringify(session).includes(${JSON.stringify(sensitiveMarker)}),
    };
  })`, true, 20_000);
  assert.deepEqual(finalProof, {
    everyAuditDeleted: true,
    localKeysAllowed: true,
    sessionHasPrivateMarker: false,
  });
});

async function runRealStorageProof(page) {
  return evaluate(page, `(async () => {
    const marker = ${JSON.stringify(sensitiveMarker)};
    const T0 = '2026-08-01T00:00:00.000Z';
    const T30 = '2026-08-31T00:00:00.000Z';
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
      const operation = indexedDB.open('audita-mt', version);
      operation.onupgradeneeded = () => upgrade?.(operation.result, operation.transaction);
      operation.onsuccess = () => resolve(operation.result);
      operation.onerror = () => reject(new Error('indexeddb open failed'));
      operation.onblocked = () => reject(new Error('indexeddb open blocked'));
    });
    await new Promise((resolve, reject) => {
      const operation = indexedDB.deleteDatabase('audita-mt');
      operation.onsuccess = () => resolve();
      operation.onerror = () => reject(new Error('indexeddb reset failed'));
      operation.onblocked = () => reject(new Error('indexeddb reset blocked'));
    });

    const legacyDb = await open(1, database => database.createObjectStore('audits'));
    const legacyTx = legacyDb.transaction('audits', 'readwrite');
    const legacy = legacyTx.objectStore('audits');
    legacy.put({
      auditId: 'legacy-batch-a', timestamps: { endedAt: T0 },
      pages: [
        { pageId: 'page-a', url: 'http://127.0.0.1/a?token=' + marker },
        { pageId: 'page-b', url: 'http://127.0.0.1/b' },
      ],
      evidence: [{ kind: 'full-page', pixels: marker }],
    }, 'legacy-batch-a');
    legacy.put({ auditId: 'legacy-batch-b', timestamps: { endedAt: 'invalid' } }, 'legacy-batch-b');
    legacy.put({ auditId: 'legacy-batch-a', status: 'complete' }, '__latest__');
    legacy.put(4, '__audit_revision__:legacy-batch-a');
    legacy.put(2, '__audit_export_attempt__:legacy-batch-a');
    legacy.put({ schemaVersion: 1, auditId: 'legacy-batch-a', entries: [] }, '__audit_export_delivery__:legacy-batch-a');
    await transaction(legacyTx);
    legacyDb.close();

    const { createAuditStore } = await import(chrome.runtime.getURL('src/storage/audit-store.js'));
    const first = createAuditStore();
    const second = createAuditStore();
    const [metaA, metaB] = await Promise.all([
      first.getAuditRetention('legacy-batch-a'), first.getAuditRetention('legacy-batch-b'),
    ]);
    const upgradedDb = await open(2);
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
        'legacy-batch-a', { ...snapshotA.model, casWinner: 'first' },
        { auditId: 'legacy-batch-a', status: 'complete' }, snapshotA.capability,
      ),
      second.commitAuditIfRevision(
        'legacy-batch-a', { ...snapshotB.model, casWinner: 'second' },
        { auditId: 'legacy-batch-a', status: 'complete' }, snapshotB.capability,
      ),
    ]);
    const casWinners = cas.filter(result => result.status === 'fulfilled').length;
    const casConflicts = cas.filter(result => result.status === 'rejected' && result.reason?.code === 'AUDIT_REVISION_CONFLICT').length;

    const currentA = await first.getAuditSnapshot('legacy-batch-a');
    await first.acquireExportLease('legacy-batch-a', currentA.capability, {
      ownerId: 'retention-e2e-owner', now: '2026-09-01T00:00:00.000Z',
    });
    const cleanup = await second.cleanupExpiredAudits({ now: '2026-09-01T00:01:00.000Z', limit: 25 });
    let deleteBusy = false;
    try { await first.deleteAudit('legacy-batch-a', currentA.capability, { now: '2026-09-01T00:01:00.000Z' }); }
    catch (error) { deleteBusy = error?.code === 'AUDIT_DELETE_BUSY'; }
    await first.releaseExportLease('legacy-batch-a', {
      ownerId: 'retention-e2e-owner', now: '2026-09-01T00:01:30.000Z',
    });
    const deletedLegacy = await first.deleteAudit(
      'legacy-batch-a', currentA.capability, { now: '2026-09-01T00:01:31.000Z' },
    );

    const persistedAt = new Date().toISOString();
    await first.commitAudit('rollback-stable', { auditId: 'rollback-stable' }, { auditId: 'rollback-stable', status: 'complete' }, { now: persistedAt });
    const rollbackDb = await open(2);
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
    const reopened = createAuditStore();
    const rollbackAtomic = (await reopened.getAudit('rollback-transient')) === undefined &&
      (await reopened.getAuditRetention('rollback-transient')) === undefined &&
      (await reopened.getAudit('rollback-stable'))?.auditId === 'rollback-stable';
    await first.commitAudit('reopen-audit', { auditId: 'reopen-audit', marker: 'persisted' }, { auditId: 'reopen-audit', status: 'complete' }, { now: persistedAt });
    const reopenPersistent = (await createAuditStore().getAudit('reopen-audit'))?.marker === 'persisted';

    const prepareDelivery = async (auditId, ownerId, formats, seconds) => {
      let snapshot = await first.getAuditSnapshot(auditId);
      if (!snapshot.model) {
        await first.commitAudit(auditId, {
          auditId, manualReview: [], itemResults: [], occurrences: [], evidence: [],
        }, { auditId, status: 'complete' }, { now: persistedAt, deleteAfterCompleteExport: true });
        snapshot = await first.getAuditSnapshot(auditId);
      }
      const prefix = '2026-09-02T00:00:' + String(seconds).padStart(2, '0');
      const lease = await first.acquireExportLease(auditId, snapshot.capability, {
        ownerId, now: prefix + '.000Z', ttlMs: 600000,
      });
      await first.claimExportLease(auditId, snapshot.capability, {
        ownerId, exportAttempt: lease.exportAttempt, now: prefix + '.100Z', ttlMs: 600000,
      });
      await first.commitAuditIfRevisionWithExportLease(
        auditId, { ...snapshot.model, delivery: formats.length },
        { auditId, status: 'complete', exportStatus: 'delivering' }, snapshot.capability,
        { ownerId, exportAttempt: lease.exportAttempt, now: prefix + '.200Z', phase: 'delivering', ttlMs: 600000 },
      );
      snapshot = await first.getAuditSnapshot(auditId);
      for (const [index, format] of formats.entries()) {
        await first.recordExportDelivery(auditId, snapshot.capability, {
          ownerId, exportAttempt: lease.exportAttempt,
          now: prefix + '.' + String(300 + index).padStart(3, '0') + 'Z',
          format, filename: 'auditoria.' + format, state: 'terminal', downloadId: seconds * 10 + index,
        });
      }
      return first.finalizeExportAndMaybeDelete(
        auditId, { ...snapshot.model, finalized: true },
        { auditId, status: 'complete', exportStatus: formats.length === 4 ? 'complete' : 'partial' },
        snapshot.capability,
        {
          ownerId, exportAttempt: lease.exportAttempt, now: prefix + '.900Z',
          clearDeliveryJournal: true, deleteAfterCompleteExport: true,
        },
      );
    };
    const partial = await prepareDelivery('delete-after-four', 'partial-owner', ['html', 'json', 'pdf'], 10);
    const partialRetained = partial.deleted === false && Boolean(await first.getAudit('delete-after-four')) &&
      Boolean(await first.getAuditRetention('delete-after-four'));
    const complete = await prepareDelivery('delete-after-four', 'complete-owner', ['html', 'json', 'csv', 'pdf'], 20);
    const completeDeleted = complete.deleted === true && (await first.getAudit('delete-after-four')) === undefined &&
      (await first.getAuditRetention('delete-after-four')) === undefined;

    for (const auditId of ['ui-one', 'ui-all-a', 'ui-all-b']) {
      await first.commitAudit(auditId, {
        auditId, manualReview: [], itemResults: [], occurrences: [], evidence: [],
      }, { auditId, status: 'complete', message: 'Auditoria disponível para exclusão.' }, { now: persistedAt });
    }
    const uiMetadata = await Promise.all(['ui-one', 'ui-all-a', 'ui-all-b'].map(id => first.getAuditRetention(id)));
    const unauthorized = await chrome.runtime.sendMessage({ type: 'REQUEST_DELETE_ALL_AUDITS' });
    const local = await chrome.storage.local.get(null);
    const session = await chrome.storage.session.get(null);

    return {
      databaseVersion,
      retentionIndex,
      migratedRecords: metadata.length,
      migrationPrivateKeysPreserved: [
        '__latest__', '__audit_revision__:legacy-batch-a',
        '__audit_export_attempt__:legacy-batch-a', '__audit_export_delivery__:legacy-batch-a',
      ].every(key => auditKeys.includes(key)),
      metadataLimited: !JSON.stringify(metadata).includes(marker) && metadata.every(value => Object.keys(value).length === 5),
      absoluteExpiry: metaA.firstPersistedAt === T0 && metaA.expiresAt === T30 && metaB.expiresAt === '1970-01-01T00:00:00.000Z',
      casWinners,
      casConflicts,
      cleanupBlocked: cleanup.blocked,
      cleanupDeleted: cleanup.deleted,
      deleteBusy,
      deleteAfterRelease: deletedLegacy.deleted === true,
      rollbackAtomic,
      reopenPersistent,
      partialRetained,
      completeDeleted,
      batchSingleMetadata: uiMetadata.length === 3 && uiMetadata.every(value => value && Object.keys(value).length === 5),
      unauthorizedDeleteRejected: unauthorized?.ok === false,
      localStorageLimited: Object.keys(local).every(key => /voice|rate/iu.test(key)) && !JSON.stringify(local).includes(marker),
      sessionStorageSanitized: !JSON.stringify(session).includes(marker) && !JSON.stringify(session).includes('127.0.0.1'),
    };
  })()`, true, 35_000);
}

async function exerciseDeleteOneDialog(review) {
  await waitForValue(review, `(() => ({
    ready: !document.querySelector('#delete-audit').disabled,
    text: document.body.innerText
  }))()`, value => value?.ready === true && !value.text.includes(sensitiveMarker));
  await focus(review, '#delete-audit');
  await pressKey(review, 'Enter', 'Enter', 13);
  await waitForValue(review, `(() => ({
    open: document.querySelector('#delete-audit-dialog').open,
    focus: document.activeElement?.id
  }))()`, value => value?.open === true && value.focus === 'delete-audit-cancel');
  await pressKey(review, 'Escape', 'Escape', 27);
  assert.deepEqual(await evaluate(review, `({
    open: document.querySelector('#delete-audit-dialog').open,
    focus: document.activeElement?.id,
    status: document.querySelector('#review-status').textContent
  })`), { open: false, focus: 'delete-audit', status: 'Exclusão cancelada.' });

  await pressKey(review, 'Enter', 'Enter', 13);
  await waitForValue(review, `document.activeElement?.id`, value => value === 'delete-audit-cancel');
  await pressKey(review, 'Tab', 'Tab', 9);
  await waitForValue(review, `document.activeElement?.id`, value => value === 'delete-audit-confirm');
  await pressKey(review, 'Enter', 'Enter', 13);
  const deleted = await waitForValue(review, `(() => ({
    open: document.querySelector('#delete-audit-dialog').open,
    disabled: document.querySelector('#delete-audit').disabled,
    status: document.querySelector('#review-status').textContent
  }))()`, value => value?.open === false && value.disabled === true && /excluída/iu.test(value.status));
  assert.match(deleted.status, /downloads já salvos foram preservados/iu);
}

async function exerciseDeleteAllDialogAndResponsiveUi(panel) {
  await panel.command('Emulation.setDeviceMetricsOverride', {
    width: 320, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  await panel.command('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
  await panel.command('Emulation.setEmulatedMedia', {
    features: [
      { name: 'forced-colors', value: 'active' },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ],
  });
  const layout = await waitForValue(panel, `(() => {
    const button = document.querySelector('#delete-all-audits');
    button.focus();
    return {
      ready: !button.disabled,
      buttonHeight: button.getBoundingClientRect().height,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      outline: getComputedStyle(button).outlineStyle,
      privateMarkerVisible: document.body.innerText.includes(${JSON.stringify(sensitiveMarker)})
    };
  })()`, value => value?.ready === true);
  assert.ok(layout.buttonHeight >= 44);
  assert.equal(layout.overflow, false);
  assert.notEqual(layout.outline, 'none');
  assert.equal(layout.privateMarkerVisible, false);

  await pressKey(panel, 'Enter', 'Enter', 13);
  await waitForValue(panel, `document.activeElement?.id`, value => value === 'delete-all-cancel');
  await pressKey(panel, 'Escape', 'Escape', 27);
  assert.deepEqual(await evaluate(panel, `({
    open: document.querySelector('#delete-all-dialog').open,
    focus: document.activeElement?.id,
    status: document.querySelector('#audit-status').textContent
  })`), { open: false, focus: 'delete-all-audits', status: 'Exclusão cancelada.' });

  await pressKey(panel, 'Enter', 'Enter', 13);
  await waitForValue(panel, `document.activeElement?.id`, value => value === 'delete-all-cancel');
  await pressKey(panel, 'Tab', 'Tab', 9);
  await waitForValue(panel, `document.activeElement?.id`, value => value === 'delete-all-confirm');
  await pressKey(panel, 'Enter', 'Enter', 13);
  const deleted = await waitForValue(panel, `(() => ({
    open: document.querySelector('#delete-all-dialog').open,
    status: document.querySelector('#audit-status').textContent
  }))()`, value => value?.open === false && /todas as auditorias locais foram excluídas/iu.test(value.status));
  assert.match(deleted.status, /downloads já salvos foram preservados/iu);
}

async function openExtensionPage(browser, url, stderr) {
  await browser.command('Target.createTarget', { url });
  const info = await waitForTargetInfo(browser, target => target.type === 'page' && target.url === url, stderr);
  await browser.command('Target.activateTarget', { targetId: info.targetId });
  const page = await attach(browser, info.targetId);
  await page.command('Runtime.enable');
  await page.command('Page.enable');
  await waitForValue(page, 'document.readyState === "complete"', Boolean);
  return page;
}

async function focus(page, selector) {
  const focused = await evaluate(page, `(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    if (!control || control.disabled) return false;
    control.focus();
    return document.activeElement === control;
  })()`);
  assert.equal(focused, true, `controle indisponível: ${selector}`);
  await waitForValue(page, 'document.hasFocus()', Boolean);
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

async function attach(browser, targetId) {
  const attached = await browser.command('Target.attachToTarget', { targetId, flatten: true });
  assert.match(attached.sessionId || '', /^[A-Fa-f0-9-]+$/u);
  return new SessionCdp(browser, attached.sessionId);
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
  throw new Error(`Target CDP não apareceu; tipos=${latest.map(info => info.type).join(',')}; stderr=${stderr}`);
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
    this.buffer = Buffer.alloc(0);
    responsePipe.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let delimiter;
      while ((delimiter = this.buffer.indexOf(0)) >= 0) {
        const frame = this.buffer.subarray(0, delimiter);
        this.buffer = this.buffer.subarray(delimiter + 1);
        if (!frame.length) continue;
        const message = JSON.parse(frame.toString('utf8'));
        if (!message.id || !this.pending.has(message.id)) continue;
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

  close() {
    try { this.commandPipe.destroy(); } catch { /* Chrome pode já ter encerrado */ }
    try { this.responsePipe.destroy(); } catch { /* Chrome pode já ter encerrado */ }
  }
}
