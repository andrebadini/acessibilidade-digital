import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const chromeBinary = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const harnessPath = 'test/e2e/fixtures/retention-harness.html';
const sensitiveMarker = 'RETENTION-PRIVATE-MARKER-641927';

test('enforces retention and confirmed deletion in real MV3 IndexedDB and UI', { timeout: 300_000 }, async t => {
  await access(chromeBinary, fsConstants.X_OK);
  const loopback = await startLoopbackSite();
  const profile = await mkdtemp(join(tmpdir(), 'audita-retention-chrome-'));
  const downloadDir = join(profile, 'downloads');
  await mkdir(downloadDir, { recursive: true });
  const chrome = spawn(chromeBinary, [
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
    '--remote-debugging-pipe', '--window-position=-10000,-10000', '--window-size=1280,800',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let chromeStderr = '';
  chrome.stderr.on('data', chunk => { chromeStderr = `${chromeStderr}${chunk}`.slice(-12_000); });
  t.after(async () => {
    try {
      if (chrome.exitCode === null) {
        const exited = new Promise(resolveExit => chrome.once('exit', resolveExit));
        chrome.kill('SIGKILL');
        await exited;
      }
    } finally {
      await loopback.close();
      await rm(profile, { recursive: true, force: true });
    }
  });

  const browser = new PipeCdp(chrome.stdio[3], chrome.stdio[4], [
    sensitiveMarker, '?token=', '?auth=',
  ]);
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
  await browser.command('Browser.setDownloadBehavior', {
    behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true,
  });

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
  const runtimeLogProbe = browser.waitForEvent(
    'Runtime.consoleAPICalled',
    event => JSON.stringify(event.params).includes('AUDITA_RUNTIME_LOG_PROBE'),
  );
  await evaluate(harness, `console.debug('AUDITA_RUNTIME_LOG_PROBE'); true`);
  await runtimeLogProbe;
  const indexedDbPreflight = await evaluate(harness, `(async () => {
    try {
      const { createAuditStore } = await import(chrome.runtime.getURL('src/storage/audit-store.js'));
      const store = globalThis.__retentionE2eStore ??= createAuditStore();
      const [latest, retention, cleanup] = await Promise.all([
        store.getLatest(), store.getAuditRetention('preflight-audit'),
        store.cleanupExpiredAudits({ now: '2026-08-28T00:00:00.000Z', limit: 1 })
      ]);
      return { ok: latest === undefined && retention === undefined, scanned: cleanup.scanned };
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code)
        ? error.code : 'EVALUATION_FAILED';
      return { ok: false, code };
    }
  })()`, true, 20_000);
  assert.deepEqual(indexedDbPreflight, { ok: true, scanned: 0 });

  const publicProof = await runPublicBatchRetentionProof({
    browser, harness, extensionId, loopback, downloadDir, chromeStderr: () => chromeStderr,
  });
  assert.deepEqual(publicProof, {
    panelActionOpened: true,
    explicitTwoPageBatch: true,
    crawlerTrapAvoided: true,
    activeCheckpointSanitized: true,
    busyAuditVisible: true,
    busyDeleteInsideDialogAx: true,
    retentionOffAtFirstCommit: true,
    firstCommitPixels: true,
    firstCommitPrivateDataAbsent: true,
    firstCommitSingleBatchRecord: true,
    retainedDeliveryFourOfFour: true,
    retainedAuditPreserved: true,
    retainedDeliveryJournalSettled: true,
    terminalCheckpointCleared: true,
    reviewMismatchRejected: true,
    deletionSpoofIgnored: true,
    explicitDeletionRendered: true,
    explicitAuditDeleted: true,
    automaticRetentionAtFirstCommit: true,
    automaticFirstCommitValid: true,
    automaticDeliveryFourOfFour: true,
    automaticDeletionRendered: true,
    automaticAuditDeleted: true,
    downloadsPreserved: true,
    panelResponsiveAtTwoHundredPercent: true,
    reviewResponsiveAtTwoHundredPercent: true,
    storageReportsAndLogsSanitized: true,
  });

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
    const allowedLocalKeys = new Set(['audita:persona:voiceId', 'audita:persona:rate']);
    return {
      everyAuditDeleted: one === undefined && allA === undefined && allB === undefined && latest === undefined,
      localKeysAllowed: allowedLocalKeys.size === 2 &&
        !allowedLocalKeys.has('audita:persona:voiceId-backup') &&
        Object.keys(local).every(key => allowedLocalKeys.has(key)),
      sessionHasPrivateMarker: JSON.stringify(session).includes(${JSON.stringify(sensitiveMarker)}),
    };
  })`, true, 20_000);
  assert.deepEqual(finalProof, {
    everyAuditDeleted: true,
    localKeysAllowed: true,
    sessionHasPrivateMarker: false,
  });
});

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

async function runPublicBatchRetentionProof({ browser, harness, extensionId, loopback, downloadDir, chromeStderr }) {
  const pageUrls = [
    `${loopback.baseUrl}/page-a?token=${sensitiveMarker}`,
    `${loopback.baseUrl}/page-b?auth=${sensitiveMarker}`,
  ];
  const firstPanel = await openPanelThroughAction(
    browser, extensionId, `${loopback.baseUrl}/source`, chromeStderr,
  );
  const secondPanel = await openPanelThroughAction(
    browser, extensionId, `${loopback.baseUrl}/source-2`, chromeStderr,
  );
  await submitExplicitBatch(firstPanel, pageUrls, false);

  const active = await waitForValue(harness, `(async () => {
    const { createAuditStore } = await import(chrome.runtime.getURL('src/storage/audit-store.js'));
    const store = globalThis.__retentionE2eStore ??= createAuditStore();
    const latest = await store.getLatest();
    const session = await chrome.storage.session.get(null);
    const activeBatch = session['audita-mt:session:active-batch'];
    return {
      ready: latest?.mode === 'batch' && latest.status === 'running' && activeBatch?.id === latest.auditId,
      auditId: latest?.auditId || null,
      sanitized: !JSON.stringify(session).includes(${JSON.stringify(sensitiveMarker)}) &&
        !JSON.stringify(session).includes('data:image')
    };
  })()`, value => value?.ready === true, 60_000);
  const auditId = active.auditId;

  await submitExplicitBatch(secondPanel, pageUrls, false);
  const busyAudit = await waitForValue(secondPanel,
    `document.querySelector('#audit-status').textContent`,
    value => /auditoria em andamento/iu.test(value), 20_000);
  const panelResponsive = await responsiveAtTwoHundredPercent(secondPanel, '#delete-all-audits');
  await openAndConfirmDialog(secondPanel, '#delete-all-audits', '#delete-all-confirm');
  const activeBusy = await waitForValue(secondPanel, `(() => ({
    open: document.querySelector('#delete-all-dialog').open,
    internal: document.querySelector('#delete-all-dialog-status').textContent,
    external: document.querySelector('#audit-status').textContent
  }))()`, value => value?.open === true && /exportada|entrega pendente/iu.test(value.internal), 20_000);
  const activeBusyAx = await dialogStatusInAxTree(secondPanel, /excluir todas as auditorias locais/iu,
    /exportada|entrega pendente/iu);
  assert.equal(activeBusyAx, true);
  assert.doesNotMatch(activeBusy.external, /exportada|entrega pendente/iu);
  await pressKey(secondPanel, 'Escape', 'Escape', 27);
  await assertLiveStatusInAxTree(secondPanel, /exclusão cancelada/iu);
  loopback.releaseAuditGate();

  const firstCommit = await waitForValue(harness, `(async () => {
    const { createAuditStore } = await import(chrome.runtime.getURL('src/storage/audit-store.js'));
    const store = globalThis.__retentionE2eStore ??= createAuditStore();
    try {
      const [snapshot, retention] = await Promise.all([
        store.getAuditSnapshot(${JSON.stringify(auditId)}),
        store.getAuditRetention(${JSON.stringify(auditId)})
      ]);
      const model = snapshot?.model;
      const evidence = Array.isArray(model?.evidence) ? model.evidence : [];
      const text = JSON.stringify({ model, retention });
      return {
        ready: Boolean(model && retention),
        pages: Array.isArray(model?.pages) ? model.pages.length : 0,
        retentionOff: retention?.deleteAfterCompleteExport === false,
        firstPersistedAt: retention?.firstPersistedAt || null,
        expiresAt: retention?.expiresAt || null,
        pixels: evidence.filter(item => item?.kind === 'full-page' && /^data:image\\/png;base64,/u.test(item.dataUrl)).length,
        privateAbsent: !text.includes(${JSON.stringify(sensitiveMarker)}) && !text.includes('?token=') && !text.includes('?auth=')
      };
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code)
        ? error.code : 'EVALUATION_FAILED';
      let latestState = 'unavailable';
      let checkpointState = 'unavailable';
      try {
        const latest = await store.getLatest();
        latestState = latest?.auditId === ${JSON.stringify(auditId)} ? latest.status ?? 'correlated' : latest ? 'other' : 'absent';
      } catch {}
      try {
        const session = await chrome.storage.session.get(null);
        checkpointState = session['audita-mt:session:active-batch']?.id === ${JSON.stringify(auditId)} ? 'active' : 'absent';
      } catch {}
      return { ready: false, code, latestState, checkpointState };
    }
  })()`, value => value?.ready === true, 150_000);
  const databaseAtFirstCommit = await inspectBatchDatabase(harness, auditId);

  const retainedDelivery = await waitForValue(harness, `(async () => {
      const { createAuditStore } = await import(chrome.runtime.getURL('src/storage/audit-store.js'));
      const store = globalThis.__retentionE2eStore ??= createAuditStore();
      const [snapshot, retention, latest, journal, lease, physicalDownloads] = await Promise.all([
        store.getAuditSnapshot(${JSON.stringify(auditId)}),
        store.getAuditRetention(${JSON.stringify(auditId)}),
        store.getLatest(),
        store.getExportDeliveryJournal(${JSON.stringify(auditId)}),
        store.getExportLeaseState(${JSON.stringify(auditId)}, { now: new Date().toISOString() }),
        chrome.downloads.search({})
      ]);
      const receipt = latest?.auditId === ${JSON.stringify(auditId)} ? latest.deliveryReceipt : null;
      const correlatedLatest = latest?.auditId === ${JSON.stringify(auditId)} ? latest : null;
      const receiptFormats = Array.isArray(receipt?.formats) ? receipt.formats : [];
      const receiptIds = receiptFormats.map(item => item?.downloadId);
      return {
        ready: Boolean(snapshot?.model && retention && latest?.auditId === ${JSON.stringify(auditId)} &&
          latest.exportStatus === 'complete'),
        terminal: ['complete', 'partial', 'failed'].includes(correlatedLatest?.exportStatus),
        retained: Boolean(snapshot?.model && retention),
        formats: Array.isArray(receipt?.formats)
          ? receipt.formats.filter(item => item?.status === 'complete').map(item => item.format).sort() : [],
        receiptEvidenceValid: receipt?.status === 'complete' && receiptFormats.length === 4 &&
          new Set(receiptIds).size === 4 && receiptFormats.every(item => item?.status === 'complete' &&
            Number.isSafeInteger(item.downloadId) && item.downloadId >= 0 &&
            /^[a-f0-9]{64}$/u.test(item.sha256 || '') &&
            /-delivery-[a-f0-9]{64}\\.(?:html|json|csv|pdf)$/u.test(item.filename || '')),
        receiptIdsComplete: receiptFormats.length === 4 && receiptFormats.every(entry =>
          physicalDownloads.some(item => item?.id === entry.downloadId && item?.state === 'complete' &&
            item?.exists !== false)),
        journalSettled: Array.isArray(journal) && journal.length === 0 && lease?.active !== true,
        exportStatus: latest?.auditId === ${JSON.stringify(auditId)} ? latest.exportStatus || 'missing' : 'uncorrelated',
        journalStates: Array.isArray(journal) ? journal.map(item => item?.state || 'invalid').sort() : ['unavailable'],
        leaseState: lease?.active === true ? lease.phase || 'active' : 'inactive',
        downloadStates: Array.isArray(physicalDownloads)
          ? physicalDownloads.map(item => item?.state || 'unknown').sort() : ['unavailable'],
        expiryUnchanged: retention?.firstPersistedAt === ${JSON.stringify(firstCommit.firstPersistedAt)} &&
          retention?.expiresAt === ${JSON.stringify(firstCommit.expiresAt)}
      };
    })()`, value => value?.ready === true || value?.terminal === true, 60_000);
  if (!retainedDelivery.ready) {
    throw new Error(`Finalização da primeira entrega divergiu; estado seguro=${JSON.stringify(retainedDelivery)}`);
  }
  assert.deepEqual(retainedDelivery.formats, ['csv', 'html', 'json', 'pdf']);
  assert.equal(retainedDelivery.journalSettled, true);
  assert.deepEqual(retainedDelivery.downloadStates, ['complete', 'complete', 'complete', 'complete']);
  const firstDownloads = await waitForCompletedDownloads(harness, 4, 60_000);
  const firstFiles = await waitForDownloadedFiles(downloadDir, 4, 30_000);
  const firstFileExtensions = firstFiles.map(name => name.split('.').at(-1)).sort();
  const firstFileStats = await Promise.all(firstFiles.map(name => stat(join(downloadDir, name))));
  const checkpointCleared = await waitForValue(harness, `chrome.storage.session.get(null).then(session => ({
    active: Object.hasOwn(session, 'audita-mt:session:active-batch'),
    correlated: Object.hasOwn(session, 'audita-mt:session:' + ${JSON.stringify(auditId)}),
    marker: JSON.stringify(session).includes(${JSON.stringify(sensitiveMarker)})
  }))`, value => value && value.active === false && value.correlated === false, 20_000);

  const review = await followLatestReportLink(firstPanel, auditId);
  const reviewResponsive = await responsiveAtTwoHundredPercent(review, '#delete-audit');
  const mismatch = await evaluate(review, `new Promise(resolve => chrome.runtime.sendMessage({
    type: 'REQUEST_DELETE_AUDIT', auditId: 'mismatch-audit'
  }, response => resolve(response)))`, true);
  assert.equal(mismatch?.ok, false);
  const spoofBaseline = await evaluate(secondPanel, `(() => ({
    status: document.querySelector('#audit-status').textContent,
    reportHidden: document.querySelector('#latest-report').hidden
  }))()`);
  const reviewBaseline = await evaluate(review, `(() => ({
    status: document.querySelector('#review-status').textContent,
    disabled: document.querySelector('#delete-audit').disabled,
    cards: document.querySelector('#review-list').childElementCount
  }))()`);
  await evaluate(review, `Promise.resolve(chrome.runtime.sendMessage({
    type: 'AUDIT_DELETED', auditId: ${JSON.stringify(auditId)}, reason: 'delete-one'
  })).catch(() => undefined)`, true);
  const [spoofedPanel, spoofedReview, spoofedDurable] = await Promise.all([
    evaluate(secondPanel, `(() => ({
      status: document.querySelector('#audit-status').textContent,
      reportHidden: document.querySelector('#latest-report').hidden,
      deletedMessage: /auditoria local foi excluída/iu.test(document.querySelector('#audit-status').textContent)
    }))()`),
    evaluate(review, `(() => ({
      status: document.querySelector('#review-status').textContent,
      disabled: document.querySelector('#delete-audit').disabled,
      cards: document.querySelector('#review-list').childElementCount
    }))()`),
    evaluate(harness, `import(chrome.runtime.getURL('src/storage/audit-store.js')).then(async ({ createAuditStore }) =>
      Boolean((await (globalThis.__retentionE2eStore ??= createAuditStore())
        .getAuditSnapshot(${JSON.stringify(auditId)})).model))`, true),
  ]);
  const spoofIgnored = {
    panelUnchanged: spoofedPanel.status === spoofBaseline.status &&
      spoofedPanel.reportHidden === spoofBaseline.reportHidden && spoofedPanel.deletedMessage === false,
    reviewPreserved: spoofedReview.status === reviewBaseline.status &&
      spoofedReview.disabled === reviewBaseline.disabled && spoofedReview.cards === reviewBaseline.cards,
    durablePreserved: spoofedDurable === true,
  };

  await exerciseDeleteOneDialog(review);
  const explicitDeletion = await waitForValue(review, `(() => ({
    disabled: document.querySelector('#delete-audit').disabled,
    status: document.querySelector('#review-status').textContent,
    cards: document.querySelector('#review-list').childElementCount
  }))()`, value => value?.disabled === true && /auditoria local excluída/iu.test(value.status), 20_000);
  const explicitDurableDeletion = await evaluate(harness, `(async () => {
    const { createAuditStore } = await import(chrome.runtime.getURL('src/storage/audit-store.js'));
    const store = globalThis.__retentionE2eStore ??= createAuditStore();
    const [snapshot, retention, latest, journal, session] = await Promise.all([
      store.getAuditSnapshot(${JSON.stringify(auditId)}),
      store.getAuditRetention(${JSON.stringify(auditId)}),
      store.getLatest(),
      store.getExportDeliveryJournal(${JSON.stringify(auditId)}),
      chrome.storage.session.get(null)
    ]);
    const open = indexedDB.open('audita-mt', 2);
    const keys = await new Promise((resolve, reject) => {
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('audits', 'readonly');
        const request = tx.objectStore('audits').getAllKeys();
        request.onsuccess = () => { const value = request.result; db.close(); resolve(value); };
        request.onerror = () => reject(new Error('read failed'));
      };
      open.onerror = () => reject(new Error('open failed'));
    });
    return {
      absent: snapshot?.model === undefined && retention === undefined && latest?.auditId !== ${JSON.stringify(auditId)},
      privateKeysAbsent: !keys.some(key => typeof key === 'string' && key.includes(${JSON.stringify(auditId)})),
      journalSettled: Array.isArray(journal) && journal.length === 0,
      sessionAbsent: !Object.hasOwn(session, 'audita-mt:session:' + ${JSON.stringify(auditId)}) &&
        !Object.hasOwn(session, 'audita-mt:session:active-batch'),
      markerAbsent: !JSON.stringify({ keys, session }).includes(${JSON.stringify(sensitiveMarker)})
    };
  })()`, true, 20_000);

  const automaticPanel = await openPanelThroughAction(
    browser, extensionId, `${loopback.baseUrl}/source-automatic`, chromeStderr,
  );
  await submitExplicitBatch(automaticPanel, pageUrls, true);
  const automaticActive = await waitForValue(harness, `(async () => {
    const { createAuditStore } = await import(chrome.runtime.getURL('src/storage/audit-store.js'));
    const store = globalThis.__retentionE2eStore ??= createAuditStore();
    const latest = await store.getLatest();
    const session = await chrome.storage.session.get(null);
    const activeBatch = session['audita-mt:session:active-batch'];
    return {
      ready: latest?.mode === 'batch' && latest.status === 'running' &&
        latest.auditId !== ${JSON.stringify(auditId)} && activeBatch?.id === latest.auditId,
      auditId: latest?.auditId || null,
      sanitized: !JSON.stringify(session).includes(${JSON.stringify(sensitiveMarker)}) &&
        !JSON.stringify(session).includes('data:image')
    };
  })()`, value => value?.ready === true, 60_000);
  const automaticAuditId = automaticActive.auditId;
  const automaticCommit = await waitForValue(harness, `(async () => {
    const { createAuditStore } = await import(chrome.runtime.getURL('src/storage/audit-store.js'));
    const store = globalThis.__retentionE2eStore ??= createAuditStore();
    const [snapshot, retention] = await Promise.all([
      store.getAuditSnapshot(${JSON.stringify(automaticAuditId)}),
      store.getAuditRetention(${JSON.stringify(automaticAuditId)})
    ]);
    const model = snapshot?.model;
    const evidence = Array.isArray(model?.evidence) ? model.evidence : [];
    const text = JSON.stringify({ model, retention });
    return {
      ready: Boolean(model && retention),
      pages: Array.isArray(model?.pages) ? model.pages.length : 0,
      retentionOn: retention?.deleteAfterCompleteExport === true,
      firstPersistedAt: retention?.firstPersistedAt || null,
      expiresAt: retention?.expiresAt || null,
      pixels: evidence.filter(item => item?.kind === 'full-page' && /^data:image\\/png;base64,/u.test(item.dataUrl)).length,
      privateAbsent: !text.includes(${JSON.stringify(sensitiveMarker)}) &&
        !text.includes('?token=') && !text.includes('?auth=')
    };
  })()`, value => value?.ready === true, 150_000);
  const databaseAtAutomaticCommit = await inspectBatchDatabase(harness, automaticAuditId);
  const automaticDownloads = await waitForCompletedDownloads(harness, 8, 60_000);
  const automaticPanelDeletion = await waitForValue(automaticPanel, `(() => ({
    status: document.querySelector('#audit-status').textContent,
    reportHidden: document.querySelector('#latest-report').hidden,
    submitEnabled: !document.querySelector('#audit-form button[type="submit"]').disabled
  }))()`, value => value?.reportHidden === true && value.submitEnabled === true &&
    /auditoria local foi excluída/iu.test(value.status), 60_000);
  await assertLiveStatusInAxTree(automaticPanel, /auditoria local foi excluída/iu);
  const automaticDurableDeletion = await evaluate(harness, `(async () => {
    const { createAuditStore } = await import(chrome.runtime.getURL('src/storage/audit-store.js'));
    const store = globalThis.__retentionE2eStore ??= createAuditStore();
    const [snapshot, retention, latest, journal, lease, session] = await Promise.all([
      store.getAuditSnapshot(${JSON.stringify(automaticAuditId)}),
      store.getAuditRetention(${JSON.stringify(automaticAuditId)}),
      store.getLatest(),
      store.getExportDeliveryJournal(${JSON.stringify(automaticAuditId)}),
      store.getExportLeaseState(${JSON.stringify(automaticAuditId)}, { now: new Date().toISOString() }),
      chrome.storage.session.get(null)
    ]);
    return {
      absent: snapshot?.model === undefined && retention === undefined &&
        latest?.auditId !== ${JSON.stringify(automaticAuditId)},
      journalSettled: Array.isArray(journal) && journal.length === 0 && lease?.active !== true,
      sessionAbsent: !Object.hasOwn(session, 'audita-mt:session:' + ${JSON.stringify(automaticAuditId)}) &&
        !Object.hasOwn(session, 'audita-mt:session:active-batch'),
      markerAbsent: !JSON.stringify(session).includes(${JSON.stringify(sensitiveMarker)})
    };
  })()`, true, 20_000);

  const files = await waitForDownloadedFiles(downloadDir, 8, 30_000);
  const fileExtensions = files.map(name => name.split('.').at(-1)).sort();
  const fileStats = await Promise.all(files.map(name => stat(join(downloadDir, name))));
  const firstFileSet = new Set(firstFiles);
  const automaticFiles = files.filter(name => !firstFileSet.has(name));
  const automaticFileExtensions = automaticFiles.map(name => name.split('.').at(-1)).sort();
  const automaticFileStats = await Promise.all(automaticFiles.map(name => stat(join(downloadDir, name))));
  const reportBytes = await Promise.all(files.map(name => readFile(join(downloadDir, name))));
  const localAndSession = await evaluate(harness, `Promise.all([
    chrome.storage.local.get(null), chrome.storage.session.get(null)
  ]).then(([local, session]) => JSON.stringify({ local, session }))`, true);
  const pageTextSanitized = await Promise.all([review, secondPanel, automaticPanel].map(page =>
    evaluate(page, `document.body.innerText.includes(${JSON.stringify(sensitiveMarker)})`)));
  const auditedRequests = loopback.requests.filter(value => /^\/page-[ab](?:\?|$)/u.test(value));

  return {
    panelActionOpened: true,
    explicitTwoPageBatch: firstCommit.pages === 2 && auditedRequests.some(value => value.startsWith('/page-a')) &&
      auditedRequests.some(value => value.startsWith('/page-b')),
    crawlerTrapAvoided: !loopback.requests.some(value => value.startsWith('/crawler-trap')),
    activeCheckpointSanitized: active.sanitized === true && automaticActive.sanitized === true,
    busyAuditVisible: /auditoria em andamento/iu.test(busyAudit),
    busyDeleteInsideDialogAx: activeBusyAx,
    retentionOffAtFirstCommit: firstCommit.retentionOff === true && firstCommit.expiresAt === new Date(
      Date.parse(firstCommit.firstPersistedAt) + 30 * 24 * 60 * 60 * 1000,
    ).toISOString(),
    firstCommitPixels: firstCommit.pixels >= 2,
    firstCommitPrivateDataAbsent: firstCommit.privateAbsent,
    firstCommitSingleBatchRecord: databaseAtFirstCommit.singleBatchRecord && databaseAtFirstCommit.metadataLimited,
    retainedDeliveryFourOfFour: firstDownloads.count === 4 &&
      ['csv', 'html', 'json', 'pdf'].every(format => firstDownloads.formats.includes(format)) &&
      retainedDelivery.formats.length === 4 && retainedDelivery.receiptEvidenceValid === true &&
      retainedDelivery.receiptIdsComplete === true && firstFiles.length === 4 &&
      firstFileStats.every(value => value.size > 0) &&
      ['csv', 'html', 'json', 'pdf'].every(format => firstFileExtensions.filter(value => value === format).length === 1),
    retainedAuditPreserved: retainedDelivery.retained && retainedDelivery.expiryUnchanged,
    retainedDeliveryJournalSettled: retainedDelivery.journalSettled,
    terminalCheckpointCleared: checkpointCleared.active === false && checkpointCleared.correlated === false && checkpointCleared.marker === false,
    reviewMismatchRejected: mismatch?.ok === false,
    deletionSpoofIgnored: spoofIgnored.panelUnchanged && spoofIgnored.reviewPreserved && spoofIgnored.durablePreserved,
    explicitDeletionRendered: explicitDeletion.disabled === true && explicitDeletion.cards === 0,
    explicitAuditDeleted: explicitDurableDeletion.absent && explicitDurableDeletion.privateKeysAbsent &&
      explicitDurableDeletion.journalSettled && explicitDurableDeletion.sessionAbsent &&
      explicitDurableDeletion.markerAbsent,
    automaticRetentionAtFirstCommit: automaticCommit.retentionOn === true &&
      automaticCommit.expiresAt === new Date(
        Date.parse(automaticCommit.firstPersistedAt) + 30 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    automaticFirstCommitValid: automaticCommit.pages === 2 && automaticCommit.pixels >= 2 &&
      automaticCommit.privateAbsent && databaseAtAutomaticCommit.singleBatchRecord &&
      databaseAtAutomaticCommit.metadataLimited,
    automaticDeliveryFourOfFour: automaticDownloads.count === 8 &&
      ['csv', 'html', 'json', 'pdf'].every(format =>
        automaticDownloads.formats.filter(value => value === format).length === 2) &&
      automaticFiles.length === 4 && automaticFileStats.every(value => value.size > 0) &&
      ['csv', 'html', 'json', 'pdf'].every(format =>
        automaticFileExtensions.filter(value => value === format).length === 1),
    automaticDeletionRendered: automaticPanelDeletion.reportHidden === true &&
      automaticPanelDeletion.submitEnabled === true,
    automaticAuditDeleted: automaticDurableDeletion.absent && automaticDurableDeletion.journalSettled &&
      automaticDurableDeletion.sessionAbsent && automaticDurableDeletion.markerAbsent,
    downloadsPreserved: files.length === 8 && fileStats.every(value => value.size > 0) &&
      ['csv', 'html', 'json', 'pdf'].every(format => fileExtensions.filter(value => value === format).length === 2),
    panelResponsiveAtTwoHundredPercent: panelResponsive,
    reviewResponsiveAtTwoHundredPercent: reviewResponsive,
    storageReportsAndLogsSanitized: !localAndSession.includes(sensitiveMarker) &&
      reportBytes.every(bytes => !bytes.includes(Buffer.from(sensitiveMarker))) &&
      pageTextSanitized.every(value => value === false) && !chromeStderr().includes(sensitiveMarker) &&
      browser.runtimeLogsSanitized(),
  };
}

async function openPanelThroughAction(browser, extensionId, sourceUrl, stderr) {
  const panelUrl = `chrome-extension://${extensionId}/src/panel/index.html`;
  const sourceTarget = await browser.command('Target.createTarget', { url: sourceUrl });
  const sourceInfo = await waitForTargetInfo(
    browser,
    info => info.targetId === sourceTarget.targetId && info.type === 'page' && info.url === sourceUrl,
    stderr(),
  );
  const source = await attach(browser, sourceInfo.targetId);
  await source.command('Runtime.enable');
  await source.command('Page.enable');
  await waitForValue(source, 'document.readyState === "complete"', Boolean);
  const sourceTab = await waitForTabTarget(browser, sourceUrl);
  const workerInfo = await waitForTargetInfo(
    browser,
    info => info.type === 'service_worker' &&
      info.url === `chrome-extension://${extensionId}/src/background/service-worker.js`,
    stderr(),
  );
  const worker = await attach(browser, workerInfo.targetId);
  await worker.command('Runtime.enable');
  await waitForValue(worker, 'chrome.action.onClicked.hasListeners()', value => value === true, 15_000);
  const sourceChromeTabId = await evaluate(worker, `chrome.tabs.query({}).then(tabs =>
    tabs.find(tab => tab.url === ${JSON.stringify(sourceUrl)})?.id)`, true);
  assert.ok(Number.isSafeInteger(sourceChromeTabId), 'a página de origem não possui uma aba Chrome correlacionável');
  await evaluate(worker, `chrome.tabs.update(${sourceChromeTabId}, { active: true }).then(() => true)`, true);
  await waitForValue(worker, `chrome.tabs.query({ active: true }).then(tabs =>
    tabs.some(tab => tab.id === ${sourceChromeTabId}))`, Boolean);
  const before = new Set((await browser.command('Target.getTargets')).targetInfos.map(info => info.targetId));
  await browser.command('Extensions.triggerAction', {
    id: extensionId, targetId: sourceTab.targetId,
  }, 20_000);
  const panelInfo = await waitForTargetInfo(
    browser,
    info => info.type === 'page' && info.url === panelUrl && !before.has(info.targetId),
    stderr(),
  );
  await browser.command('Target.activateTarget', { targetId: panelInfo.targetId });
  const panel = await attach(browser, panelInfo.targetId);
  await panel.command('Runtime.enable');
  await panel.command('Page.enable');
  await panel.command('Accessibility.enable');
  await waitForValue(panel, 'document.readyState === "complete"', Boolean);
  await waitForValue(panel, `!document.querySelector('#audit-form button[type="submit"]').disabled`, Boolean, 20_000);
  return panel;
}

async function waitForTabTarget(browser, url) {
  let latest = [];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const targets = await browser.command('Target.getTargets', {
      filter: [{ type: 'tab', exclude: false }, { exclude: true }],
    });
    latest = targets.targetInfos || [];
    const target = latest.find(info => info.type === 'tab' && info.url === url);
    if (target) return target;
    await delay(50);
  }
  throw new Error(`Target de aba não apareceu; contagem segura=${latest.length}`);
}

async function submitExplicitBatch(panel, urls, deleteAfterCompleteExport) {
  const submitted = await evaluate(panel, `(() => {
    const form = document.querySelector('#audit-form');
    const mode = form.querySelector('input[name="audit-mode"][value="batch"]');
    const list = document.querySelector('#audit-urls');
    const retention = document.querySelector('#delete-after-export');
    const submit = form.querySelector('button[type="submit"]');
    if (!form || !mode || !list || !retention || !submit || submit.disabled) return false;
    mode.click();
    list.value = ${JSON.stringify(urls.join('\n'))};
    list.dispatchEvent(new Event('input', { bubbles: true }));
    retention.checked = ${deleteAfterCompleteExport === true};
    submit.click();
    return true;
  })()`);
  assert.equal(submitted, true, 'o formulário público do lote não pôde ser enviado');
}

async function responsiveAtTwoHundredPercent(page, buttonSelector) {
  await page.command('Emulation.setDeviceMetricsOverride', {
    width: 640, height: 1_600, deviceScaleFactor: 1, mobile: false,
  });
  const zoomed = await evaluate(page, `new Promise(resolve => chrome.tabs.getCurrent(tab => {
    if (!Number.isSafeInteger(tab?.id)) { resolve(false); return; }
    chrome.tabs.setZoom(tab.id, 2, () => resolve(!chrome.runtime.lastError));
  }))`, true);
  let layout;
  try {
    layout = await waitForValue(page, `(() => {
      const control = document.querySelector(${JSON.stringify(buttonSelector)});
      const rect = control?.getBoundingClientRect();
      return {
        width: innerWidth,
        height: rect?.height || 0,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`, value => value && value.width <= 321, 10_000);
  } finally {
    await evaluate(page, `new Promise(resolve => chrome.tabs.getCurrent(tab => {
      if (!Number.isSafeInteger(tab?.id)) { resolve(false); return; }
      chrome.tabs.setZoom(tab.id, 1, () => resolve(!chrome.runtime.lastError));
    }))`, true).catch(() => false);
    await page.command('Emulation.clearDeviceMetricsOverride').catch(() => {});
  }
  return zoomed === true && layout.width >= 319 && layout.width <= 321 && layout.height >= 44 && layout.overflow === false;
}

async function openAndConfirmDialog(page, openSelector, confirmSelector) {
  await focus(page, openSelector);
  await pressKey(page, 'Enter', 'Enter', 13);
  await waitForValue(page, `document.querySelector(${JSON.stringify(confirmSelector)})?.closest('dialog')?.open`, Boolean);
  await focus(page, confirmSelector);
  await pressKey(page, 'Enter', 'Enter', 13);
}

async function dialogStatusInAxTree(page, dialogName, statusText) {
  const tree = await page.command('Accessibility.getFullAXTree');
  const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const role = node => String(node?.role?.value || '').toLowerCase();
  const name = node => String(node?.name?.value || '');
  const dialog = nodes.find(node => role(node) === 'dialog' && dialogName.test(name(node)));
  if (!dialog) return false;
  const modal = dialog.properties?.some(property => property.name === 'modal' && property.value?.value === true);
  if (!modal) return false;
  if (statusText === null) return true;
  const descendants = new Set();
  const pending = [...(dialog.childIds || [])];
  while (pending.length) {
    const nodeId = pending.shift();
    if (descendants.has(nodeId)) continue;
    descendants.add(nodeId);
    pending.push(...(byId.get(nodeId)?.childIds || []));
  }
  for (const nodeId of descendants) {
    const node = byId.get(nodeId);
    if (role(node) !== 'status') continue;
    const text = subtreeAxText(node, byId);
    if (statusText.test(text)) return true;
  }
  return false;
}

async function assertLiveStatusInAxTree(page, expected) {
  const tree = await page.command('Accessibility.getFullAXTree');
  const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const role = node => String(node?.role?.value || '').toLowerCase();
  const insideDialog = node => {
    let current = node;
    const seen = new Set();
    while (current?.parentId && !seen.has(current.parentId)) {
      seen.add(current.parentId);
      current = byId.get(current.parentId);
      if (role(current) === 'dialog') return true;
    }
    return false;
  };
  const match = nodes.find(node => role(node) === 'status' && !insideDialog(node) &&
    expected.test(subtreeAxText(node, byId)));
  assert.ok(match, 'a região viva externa não apareceu na árvore de acessibilidade');
}

function subtreeAxText(rootNode, byId) {
  const values = [];
  const pending = [rootNode];
  const seen = new Set();
  while (pending.length) {
    const node = pending.shift();
    if (!node || seen.has(node.nodeId)) continue;
    seen.add(node.nodeId);
    const value = String(node.name?.value || '').trim();
    if (value) values.push(value);
    pending.push(...(node.childIds || []).map(nodeId => byId.get(nodeId)));
  }
  return values.join(' ');
}

async function inspectBatchDatabase(page, auditId) {
  return evaluate(page, `(async () => {
    const operation = indexedDB.open('audita-mt');
    const db = await new Promise((resolve, reject) => {
      operation.onsuccess = () => resolve(operation.result);
      operation.onerror = () => reject(new Error('open failed'));
    });
    const tx = db.transaction(['audits', 'audit-retention'], 'readonly');
    const request = value => new Promise((resolve, reject) => {
      value.onsuccess = () => resolve(value.result);
      value.onerror = () => reject(new Error('read failed'));
    });
    const [keys, metadata, model] = await Promise.all([
      request(tx.objectStore('audits').getAllKeys()),
      request(tx.objectStore('audit-retention').getAll()),
      request(tx.objectStore('audits').get(${JSON.stringify(auditId)}))
    ]);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(new Error('transaction failed'));
      tx.onabort = () => reject(new Error('transaction aborted'));
    });
    db.close();
    const publicKeys = keys.filter(key => typeof key === 'string' && !key.startsWith('__'));
    const serialized = JSON.stringify({ keys, metadata, model });
    return {
      singleBatchRecord: publicKeys.length === 1 && publicKeys[0] === ${JSON.stringify(auditId)} &&
        Array.isArray(model?.pages) && model.pages.length === 2 &&
        !keys.some(key => typeof key === 'string' && key.includes(':page-')),
      metadataLimited: metadata.length === 1 && metadata[0]?.auditId === ${JSON.stringify(auditId)} &&
        Object.keys(metadata[0]).length === 5 && !serialized.includes(${JSON.stringify(sensitiveMarker)}) &&
        !serialized.includes('?token=') && !serialized.includes('?auth=')
    };
  })()`, true, 20_000);
}

async function waitForCompletedDownloads(page, expected, timeoutMs) {
  return waitForValue(page, `chrome.downloads.search({}).then(items => {
    const complete = items.filter(item => item.state === 'complete' && item.exists !== false &&
      /\\.(?:html|json|csv|pdf)$/iu.test(item.filename || ''));
    return {
      count: complete.length,
      formats: complete.map(item => item.filename.match(/\\.(html|json|csv|pdf)$/iu)?.[1].toLowerCase()).filter(Boolean).sort()
    };
  })`, value => value?.count >= expected, timeoutMs);
}

async function waitForDownloadedFiles(directory, expected, timeoutMs) {
  const started = Date.now();
  let files = [];
  while (Date.now() - started < timeoutMs) {
    files = (await readdir(directory)).filter(name => /\.(?:html|json|csv|pdf)$/iu.test(name));
    if (files.length >= expected) return files.sort();
    await delay(50);
  }
  throw new Error(`Arquivos físicos não chegaram ao total esperado; contagem segura=${files.length}`);
}

async function followLatestReportLink(panel, auditId) {
  await waitForValue(panel, `(() => {
    const link = document.querySelector('#latest-report');
    return !link.hidden && link.href.includes('auditId=' + encodeURIComponent(${JSON.stringify(auditId)}));
  })()`, Boolean, 20_000);
  await focus(panel, '#latest-report');
  await pressKey(panel, 'Enter', 'Enter', 13);
  await waitForValue(panel, `location.pathname === '/src/review/index.html' &&
    new URL(location.href).searchParams.get('auditId') === ${JSON.stringify(auditId)} &&
    !document.querySelector('#delete-audit')?.disabled`, Boolean, 20_000);
  await panel.command('Accessibility.enable');
  return panel;
}

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
      localStorageLimited: allowedLocalKeys.size === 2 &&
        !allowedLocalKeys.has('audita:persona:voiceId-backup') &&
        Object.keys(local).every(key => allowedLocalKeys.has(key)) &&
        !JSON.stringify(local).includes(marker),
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
  assert.equal(await dialogStatusInAxTree(review, /excluir esta auditoria local/iu, null), true);
  await pressKey(review, 'Escape', 'Escape', 27);
  assert.deepEqual(await evaluate(review, `({
    open: document.querySelector('#delete-audit-dialog').open,
    focus: document.activeElement?.id,
    status: document.querySelector('#review-status').textContent
  })`), { open: false, focus: 'delete-audit', status: 'Exclusão cancelada.' });

  await review.command('Page.reload', { ignoreCache: true });
  await waitForValue(review, 'document.readyState === "complete"', Boolean);
  await waitForValue(review, `!document.querySelector('#delete-audit').disabled`, Boolean);
  await focus(review, '#delete-audit');
  await pressKey(review, 'Enter', 'Enter', 13);
  await waitForValue(review, `document.activeElement?.id`, value => value === 'delete-audit-cancel');
  await pressKey(review, 'Tab', 'Tab', 9);
  await waitForValue(review, `document.activeElement?.id`, value => value === 'delete-audit-confirm');
  await pressKey(review, 'Enter', 'Enter', 13);
  const deleted = await waitForValue(review, `(() => ({
    open: document.querySelector('#delete-audit-dialog').open,
    disabled: document.querySelector('#delete-audit').disabled,
    focus: document.activeElement?.id,
    status: document.querySelector('#review-status').textContent
  }))()`, value => value?.open === false && value.disabled === true && value.focus === 'review-status' &&
    /excluída/iu.test(value.status));
  assert.match(deleted.status, /downloads já salvos foram preservados/iu);
  await assertLiveStatusInAxTree(review, /auditoria local excluída/iu);
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

  await focus(panel, '#delete-all-audits');
  await pressKey(panel, 'Enter', 'Enter', 13);
  await waitForValue(panel, `document.activeElement?.id`, value => value === 'delete-all-cancel');
  await pressKey(panel, 'Escape', 'Escape', 27);
  assert.deepEqual(await evaluate(panel, `({
    open: document.querySelector('#delete-all-dialog').open,
    focus: document.activeElement?.id,
    status: document.querySelector('#audit-status').textContent
  })`), { open: false, focus: 'delete-all-audits', status: 'Exclusão cancelada.' });

  await panel.command('Page.reload', { ignoreCache: true });
  await waitForValue(panel, 'document.readyState === "complete"', Boolean);
  await waitForValue(panel, `!document.querySelector('#delete-all-audits').disabled`, Boolean);
  await focus(panel, '#delete-all-audits');
  await pressKey(panel, 'Enter', 'Enter', 13);
  await waitForValue(panel, `document.activeElement?.id`, value => value === 'delete-all-cancel');
  await pressKey(panel, 'Tab', 'Tab', 9);
  await waitForValue(panel, `document.activeElement?.id`, value => value === 'delete-all-confirm');
  await pressKey(panel, 'Enter', 'Enter', 13);
  const deleted = await waitForValue(panel, `(() => ({
    open: document.querySelector('#delete-all-dialog').open,
    focus: document.activeElement?.id,
    status: document.querySelector('#audit-status').textContent
  }))()`, value => value?.open === false && value.focus === 'audit-status' &&
    /todas as auditorias locais foram excluídas/iu.test(value.status));
  assert.match(deleted.status, /downloads já salvos foram preservados/iu);
  await assertLiveStatusInAxTree(panel, /todas as auditorias locais foram excluídas/iu);
}

async function openExtensionPage(browser, url, stderr) {
  await browser.command('Target.createTarget', { url });
  const info = await waitForTargetInfo(browser, target => target.type === 'page' && target.url === url, stderr);
  await browser.command('Target.activateTarget', { targetId: info.targetId });
  const page = await attach(browser, info.targetId);
  await page.command('Runtime.enable');
  await page.command('Page.enable');
  await page.command('Accessibility.enable');
  await waitForValue(page, 'document.readyState === "complete"', Boolean);
  return page;
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
  throw new Error(`Target CDP não apareceu; alvos=${latest.map(safeTargetSummary).join(',')}; stderr=${stderr}`);
}

function safeTargetSummary(info) {
  try {
    const url = new URL(info.url);
    return `${info.type}:${url.protocol}//${url.hostname}${url.pathname}`;
  } catch {
    return `${info.type}:sem-url`;
  }
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
  constructor(commandPipe, responsePipe, runtimeLogNeedles = []) {
    this.commandPipe = commandPipe;
    this.responsePipe = responsePipe;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Set();
    this.runtimeLogNeedles = [...runtimeLogNeedles];
    this.runtimeLogEventCount = 0;
    this.runtimeLogLeak = false;
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
    if (message.method === 'Runtime.consoleAPICalled' || message.method === 'Runtime.exceptionThrown') {
      this.runtimeLogEventCount += 1;
      try {
        const serialized = JSON.stringify(message.params);
        if (this.runtimeLogNeedles.some(needle => serialized.includes(needle))) this.runtimeLogLeak = true;
      } catch {
        this.runtimeLogLeak = true;
      }
    }
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

  runtimeLogsSanitized() {
    return this.runtimeLogEventCount > 0 && this.runtimeLogLeak === false;
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
