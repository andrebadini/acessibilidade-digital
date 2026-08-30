import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { launchUnpackedExtension, redactDiagnostic, startFixtureServer } from './support/real-chrome.mjs';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
const chromeBinary = process.env.AUDITA_E2E_CHROME;
const chromeMajorText = process.env.AUDITA_EXPECT_CHROME_MAJOR;
const e2eReady = typeof chromeBinary === 'string' && chromeBinary.startsWith('/') &&
  /^[1-9][0-9]{0,2}$/u.test(chromeMajorText ?? '');

async function createSafeRunDirectories(t) {
  const canonicalTmp = await realpath(tmpdir());
  const runRoot = await realpath(await mkdtemp(join(canonicalTmp, 'audita-marco-1-')));
  if (dirname(runRoot) !== canonicalTmp || !basename(runRoot).startsWith('audita-marco-1-')) {
    throw new Error('UNSAFE_QA_DIRECTORY');
  }
  const downloadDirectory = join(runRoot, 'downloads');
  const qaDirectory = join(runRoot, 'qa');
  await mkdir(downloadDirectory);
  await mkdir(qaDirectory);
  t.after(async () => {
    const checked = await realpath(runRoot);
    if (dirname(checked) !== canonicalTmp || !checked.startsWith(`${canonicalTmp}${sep}`) ||
      !basename(checked).startsWith('audita-marco-1-')) throw new Error('UNSAFE_QA_CLEANUP');
    await rm(checked, { recursive: true, force: false });
  });
  return { downloadDirectory, qaDirectory };
}

test('real toolbar shortcut opens the Side Panel and completes the attached audit journey', {
  skip: e2eReady ? false : 'Chrome E2E executa somente no gate explícito com binário e versão canônica.',
}, async t => {
  assert.equal(chromeMajorText, '152');
  assert.match(process.env.AUDITA_QA_PRESERVE ?? '', /^[01]$/u);
  const { downloadDirectory, qaDirectory } = await createSafeRunDirectories(t);
  const fixture = await startFixtureServer(t, new Map([['/', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Fixture Audita</title></head><body><main><h1>Teste local</h1><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><a href="/">clique aqui</a><button>Continuar</button></main></body></html>',
  }]]));

  let extension;
  try {
    extension = await launchUnpackedExtension(t, {
      extensionPath: await realpath(workspaceRoot),
      startUrl: fixture.origin,
      downloadDirectory,
      qaDirectory,
      viewport: { width: 1280, height: 900 },
      chromeBinary,
      expectedMajor: Number(chromeMajorText),
    });
    assert.equal(extension.chromeProduct, 'Chrome/152.0.7977.64');
    const before = await extension.identityOf(extension.startPage);
    const panel = await extension.openSidePanelFromAction();
    const sidePanels = await extension.runtimeContexts({ contextTypes: ['SIDE_PANEL'] });
    const popups = await extension.runtimeContexts({ contextTypes: ['POPUP'] });
    assert.equal(sidePanels.length, 1);
    assert.equal(popups.length, 0);
    const contextProof = sidePanels.map(({ contextType, documentId, tabId, windowId }) => ({ contextType, documentId, tabId, windowId }));
    const panelDocumentId = sidePanels[0].documentId;
    const proveStablePanel = async stage => {
      const [currentPanels, currentPopups] = await Promise.all([
        extension.runtimeContexts({ contextTypes: ['SIDE_PANEL'] }),
        extension.runtimeContexts({ contextTypes: ['POPUP'] }),
      ]);
      assert.equal(currentPanels.length, 1, stage);
      assert.equal(currentPanels[0].documentId, panelDocumentId, stage);
      assert.equal(currentPopups.length, 0, stage);
      t.diagnostic(`panel-stability=${stage}; SIDE_PANEL=${currentPanels.length}; POPUP=${currentPopups.length}`);
    };
    t.diagnostic(`Chrome=${extension.chromeProduct}; SIDE_PANEL=${sidePanels.length}; POPUP=${popups.length}; contexts=${JSON.stringify(contextProof)}`);

    await extension.waitForValue(panel, "document.querySelector('[data-screen]')?.dataset.screen", value => typeof value === 'string');
    const initialState = await extension.evaluate(panel, `(() => ({
      screen: document.querySelector('[data-screen]')?.dataset.screen ?? null,
      heading: document.querySelector('[data-screen] h2')?.textContent ?? null,
      status: document.querySelector('[role="status"]')?.textContent ?? null
    }))()`);
    t.diagnostic(`panel-initial=${JSON.stringify(initialState)}`);
    assert.equal(initialState.screen, 'initial');
    assert.equal(initialState.heading, 'Avaliar acessibilidade');
    await proveStablePanel('initial');
    await extension.captureJourney('panel-initial', panel);

    await extension.click(panel, 'button[data-focus-id="start-attached"][data-intent="START_ATTACHED"]');
    const startState = await extension.waitForValue(panel, `(() => ({
      screen: document.querySelector('[data-screen]')?.dataset.screen ?? null,
      heading: document.querySelector('[data-screen] h2')?.textContent ?? null,
      status: document.querySelector('[role="status"]')?.textContent ?? null
    }))()`, value => ['running', 'result', 'unavailable'].includes(value?.screen), { timeoutMs: 10_000, intervalMs: 50 });
    t.diagnostic(`panel-after-start=${JSON.stringify(startState)}`);
    assert.notEqual(startState.screen, 'unavailable');

    const terminalState = await extension.waitForValue(panel, `(() => ({
      screen: document.querySelector('[data-screen]')?.dataset.screen ?? null,
      heading: document.querySelector('[data-screen] h2')?.textContent ?? null,
      status: document.querySelector('[role="status"]')?.textContent ?? null
    }))()`, value => ['result', 'initial', 'unavailable'].includes(value?.screen), {
      timeoutMs: 60_000, intervalMs: 50,
    });
    if (terminalState.screen !== 'result') {
      const executionState = await extension.evaluate(extension.harnessPage, `(async()=>{
        try{
          const module=await import(chrome.runtime.getURL('/src/storage/audit-store.js'));
          const latest=await module.createAuditStore().getLatest();
          return latest&&typeof latest==='object'?{
            keys:Object.keys(latest),auditIdPresent:typeof latest.auditId==='string',status:latest.status??null,
            percent:latest.percent??null,message:latest.message??null,failureCode:latest.failureCode??null,
            modelRevision:latest.modelRevision??null
          }:null;
        }catch{return {readFailed:true}}
      })()`, { awaitPromise: true });
      t.diagnostic(`panel-terminal=${JSON.stringify(terminalState)}; execution=${JSON.stringify(executionState)}`);
    }
    assert.equal(terminalState.screen, 'result');
    await proveStablePanel('result');

    const auditId = await extension.readAttribute(panel, '[data-screen="result"]', 'data-audit-id');
    assert.match(auditId, /^[A-Za-z0-9._:-]{1,160}$/u);
    const summary = await extension.evaluate(panel, `(() => ({
      coverage: Number(document.querySelector('progress.coverage-progress')?.max ?? 0),
      failures: document.querySelectorAll('[data-result-card][data-classification="failed"]').length,
      occurrenceButton: Boolean(document.querySelector('button.card-select,button.occurrence-select'))
    }))()`);
    assert.ok(summary.coverage > 0);
    assert.ok(summary.failures > 0);
    assert.equal(summary.occurrenceButton, true);
    await extension.captureJourney('panel-summary', panel);

    await extension.click(panel, 'button.card-select,button.occurrence-select');
    await extension.waitForValue(panel, "Boolean(document.querySelector('[data-result-detail]'))", Boolean);
    await extension.captureJourney('panel-detail', panel);
    await extension.click(panel, 'button[data-focus-id="consult-evidence"]');
    await extension.waitForValue(panel, "document.querySelector('details[data-detail-block=" + '"previews"' + "]')?.open", Boolean);
    await proveStablePanel('detail-and-evidence');
    await extension.captureJourney('panel-evidence', panel);

    await extension.click(panel, 'button[data-focus-id="open-report"]');
    const report = await extension.waitForReport({ auditId });
    const reportState = await extension.waitForValue(report, `(() => ({
      readyState: document.readyState,
      navigation: Boolean(document.querySelector('[data-report-navigation]')),
      status: document.querySelector('#review-status')?.textContent ?? null,
      rootChildren: document.querySelector('#report-root')?.childElementCount ?? null,
      exportReady: Boolean(document.querySelector('button[data-report-export]')),
      title: document.querySelector('h1')?.textContent ?? null
    }))()`, value => value?.navigation === true && value?.exportReady === true && value?.rootChildren > 0 &&
      typeof value?.status === 'string' && value.status !== 'Carregando a auditoria.', {
      timeoutMs: 30_000, intervalMs: 50,
    });
    t.diagnostic(`report-state=${JSON.stringify(reportState)}`);
    assert.equal(reportState.navigation, true);
    assert.equal(reportState.exportReady, true);
    assert.ok(reportState.rootChildren > 0);
    assert.notEqual(reportState.status, 'Carregando a auditoria.');
    await extension.captureJourney('report', report, { captureBeyondViewport: false });

    await extension.click(report, 'button[data-report-export]');
    const downloads = await extension.waitForFourDownloads({ auditId, timeoutMs: 60_000, intervalMs: 50 });
    assert.deepEqual(downloads.map(row => row.format), ['html', 'pdf', 'csv', 'json']);
    assert.equal(downloads.every(row => row.state === 'complete' && row.byteLength > 0 && /^[a-f0-9]{64}$/u.test(row.sha256)), true);
    assert.deepEqual(await extension.identityOf(extension.startPage), before);
    const downloadProofs = downloads.map(row => ({
      format: row.format,
      path: join(downloadDirectory, row.filename),
      byteLength: row.byteLength,
      sha256: row.sha256,
    }));
    t.diagnostic(`auditId=${auditId}; coverage=${summary.coverage}; failures=${summary.failures}; receipt=complete; downloads=${JSON.stringify(downloadProofs)}`);
  } catch (error) {
    t.diagnostic(`controlled-failure=${redactDiagnostic(error?.code ?? error?.message ?? 'E2E_DENIED')}`);
    throw error;
  } finally {
    await extension?.close().catch(() => {});
  }
});
