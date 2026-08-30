import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_CHROME_PRODUCT,
  launchUnpackedExtension,
  navigateRealPage,
  redactDiagnostic,
  resolveRealChromeTestBinary,
  startFixtureServer,
  waitForReboundSidePanel,
} from './support/real-chrome.mjs';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
const chromeBinary = resolveRealChromeTestBinary();

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

test('real toolbar shortcut opens the Side Panel and completes the attached audit journey', async t => {
  assert.ok(chromeBinary, 'AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório para o E2E real do painel lateral.');
  const { downloadDirectory, qaDirectory } = await createSafeRunDirectories(t);
  const fixture = await startFixtureServer(t, new Map([['/', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Fixture Audita</title></head><body><main><h1>Teste local</h1><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><a href="/">clique aqui</a><button>Continuar</button></main></body></html>',
  }], ['/after-navigation', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Fixture após navegação</title></head><body><main><h1>Página navegada</h1><button>Continuar</button></main></body></html>',
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
      expectedMajor: 152,
    });
    assert.equal(extension.chromeProduct, CANONICAL_CHROME_PRODUCT);
    const panelBehavior = await extension.evaluate(extension.harnessPage,
      'chrome.sidePanel.getPanelBehavior()', { awaitPromise: true });
    assert.equal(panelBehavior?.openPanelOnActionClick, false);
    const before = await extension.identityOf(extension.startPage);
    const panel = await extension.openSidePanelFromAction();
    const sidePanels = await extension.runtimeContexts({ contextTypes: ['SIDE_PANEL'] });
    const popups = await extension.runtimeContexts({ contextTypes: ['POPUP'] });
    assert.equal(sidePanels.length, 1);
    assert.equal(popups.length, 0);
    const panelLaunchUrl = new URL(sidePanels[0].documentUrl);
    assert.equal(panelLaunchUrl.protocol, 'chrome-extension:');
    assert.equal(panelLaunchUrl.hostname, extension.extensionId);
    assert.equal(panelLaunchUrl.pathname, '/src/panel/index.html');
    assert.deepEqual([...panelLaunchUrl.searchParams.keys()], ['launch']);
    const launchToken = panelLaunchUrl.searchParams.get('launch');
    assert.match(launchToken, /^[A-Za-z0-9_-]{43}$/u);
    assert.notEqual(panelLaunchUrl.search, '');
    const contextProof = sidePanels.map(({ contextType, documentId, tabId, windowId }) => ({ contextType, documentId, tabId, windowId }));
    const panelDocumentId = sidePanels[0].documentId;
    const stablePanelWidths = [];
    const assertTokenNotExposed = async (target, surface) => {
      const exposure = await extension.evaluate(target, `(() => {
        const token=${JSON.stringify(launchToken)};
        const storageHasToken=storage=>Object.keys(storage).some(key=>key.includes(token)||String(storage.getItem(key)).includes(token));
        return {
          dom: document.documentElement.outerHTML.includes(token),
          rendered: (document.body?.innerText ?? '').includes(token),
          localStorage: storageHasToken(localStorage),
          sessionStorage: storageHasToken(sessionStorage)
        };
      })()`);
      assert.deepEqual(exposure, { dom: false, rendered: false, localStorage: false, sessionStorage: false }, surface);
    };
    const proveStablePanel = async stage => {
      const [currentPanels, currentPopups] = await Promise.all([
        extension.runtimeContexts({ contextTypes: ['SIDE_PANEL'] }),
        extension.runtimeContexts({ contextTypes: ['POPUP'] }),
      ]);
      assert.equal(currentPanels.length, 1, stage);
      assert.equal(currentPanels[0].documentId, panelDocumentId, stage);
      assert.equal(currentPopups.length, 0, stage);
      const widths = await extension.evaluate(panel, `(async()=>{
        const values=[];
        for(let index=0;index<4;index+=1){
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          values.push({innerWidth,clientWidth:document.documentElement.clientWidth,bodyWidth:document.body?.clientWidth??0});
        }
        return values;
      })()`, { awaitPromise: true });
      assert.equal(widths.length, 4, stage);
      assert.equal(widths.every(value => Number.isInteger(value.innerWidth) && value.innerWidth > 0 &&
        value.clientWidth === value.innerWidth && value.bodyWidth === value.innerWidth), true, stage);
      assert.equal(new Set(widths.map(value => value.innerWidth)).size, 1, `${stage}: no width oscillation`);
      stablePanelWidths.push(widths[0].innerWidth);
      t.diagnostic(`panel-stability=${stage}; SIDE_PANEL=${currentPanels.length}; POPUP=${currentPopups.length}; width=${widths[0].innerWidth}`);
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
    await assertTokenNotExposed(panel, 'panel initial must not expose launch authority');
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
    await assertTokenNotExposed(panel, 'panel result must not expose launch authority');

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

    const occurrenceCount = await extension.evaluate(panel,
      "document.querySelectorAll('button.card-select,button.occurrence-select').length");
    assert.ok(Number.isInteger(occurrenceCount) && occurrenceCount > 0);
    let selectedOccurrenceId = null;
    for (let index = 0; index < Math.min(occurrenceCount, 40); index += 1) {
      const selected = await extension.evaluate(panel, `(() => {
        const button=[...document.querySelectorAll('button.card-select,button.occurrence-select')][${index}];
        if(!button)return false;
        button.click();
        return true;
      })()`, { userGesture: true });
      assert.equal(selected, true);
      const availability = await extension.waitForValue(panel, `(() => ({
        highlight:Boolean(document.querySelector('[data-action="highlight-occurrence"]')),
        unavailable:/Não foi possível destacar este item/iu.test(document.querySelector('[role="status"]')?.textContent??''),
        focusId:document.querySelector('[aria-pressed="true"][data-focus-id^="occurrence-"]')?.dataset.focusId??null
      }))()`, value => value?.highlight === true || value?.unavailable === true,
      { timeoutMs: 5_000, intervalMs: 50 }).catch(() => null);
      if (availability?.highlight === true && typeof availability.focusId === 'string') {
        selectedOccurrenceId = availability.focusId.slice('occurrence-'.length);
        break;
      }
    }
    assert.match(selectedOccurrenceId, /^[A-Za-z0-9._:-]{1,200}$/u);
    await extension.waitForValue(panel, "Boolean(document.querySelector('[data-result-detail]'))", Boolean);
    await extension.captureJourney('panel-detail', panel);
    await extension.click(panel, 'details[data-detail-block="previews"] > summary');
    await extension.waitForValue(panel, "document.querySelector('details[data-detail-block=" + '"previews"' + "]')?.open", Boolean);
    await proveStablePanel('detail-and-evidence');
    assert.equal(new Set(stablePanelWidths).size, 1, 'the native panel width remains fixed across the journey');
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
    await assertTokenNotExposed(report, 'report must not expose panel launch authority');
    await extension.captureJourney('report', report, { captureBeyondViewport: false });

    const reportHighlightSelector = `[data-report-highlight-control="${selectedOccurrenceId}"] button`;
    await extension.click(report, `${reportHighlightSelector}[data-highlight-action="check"]`);
    await extension.waitForValue(report,
      `document.querySelector(${JSON.stringify(reportHighlightSelector)})?.getAttribute('data-report-highlight')`,
      value => value === 'highlight', { timeoutMs: 10_000, intervalMs: 50 });
    await extension.click(report, `${reportHighlightSelector}[data-report-highlight="highlight"]`);
    try {
      await Promise.all([
        extension.waitForValue(report,
          `document.querySelector(${JSON.stringify(reportHighlightSelector)})?.getAttribute('data-report-highlight')`,
          value => value === 'clear', { timeoutMs: 10_000, intervalMs: 50 }),
        extension.waitForValue(panel, "Boolean(document.querySelector('[data-action=\"clear-highlight\"]'))", Boolean,
          { timeoutMs: 10_000, intervalMs: 50 }),
        extension.waitForValue(extension.startPage.page,
          "document.querySelectorAll('[data-audita-highlight-root=\"v1\"]').length", value => value === 1,
          { timeoutMs: 10_000, intervalMs: 50 }),
      ]);
    } catch (error) {
      const highlightDiagnostic = await extension.evaluate(extension.harnessPage, `(async()=>({
        frames:await chrome.scripting.executeScript({
          target:{tabId:${extension.startPage.tabId},allFrames:true},
          world:'ISOLATED',
          func:()=>({
            href:location.href,
            roots:document.querySelectorAll('[data-audita-highlight-root="v1"]').length,
            runtime:Boolean(globalThis.__auditaHighlightOverlayV1),
            disposed:globalThis.__auditaHighlightOverlayV1?.disposed??null,
            notified:globalThis.__auditaHighlightOverlayV1?.notified??null
          })
        }),
        report:document.title
      }))()`, { awaitPromise: true }).catch(value => ({ diagnosticFailure: String(value?.code || value) }));
      const surfaces = {
        report: await extension.evaluate(report,
          `document.querySelector(${JSON.stringify(reportHighlightSelector)})?.getAttribute('data-report-highlight')`),
        reportAction: await extension.evaluate(report, `(() => {
          const button=document.querySelector(${JSON.stringify(reportHighlightSelector)});
          return button?{
            action:button.getAttribute('data-highlight-action'),
            disabled:button.disabled,
            ariaDisabled:button.getAttribute('aria-disabled'),
            text:button.textContent,
            status:document.querySelector('#review-status')?.textContent??null
          }:null;
        })()`),
        panel: await extension.evaluate(panel, "Boolean(document.querySelector('[data-action=\"clear-highlight\"]'))"),
        panelState: await extension.evaluate(panel, `(() => ({
          screen:document.querySelector('[data-screen]')?.dataset.screen??null,
          status:document.querySelector('[role="status"]')?.textContent??null,
          action:document.querySelector('[data-action]')?.dataset.action??null
        }))()`),
        page: await extension.evaluate(extension.startPage.page,
          "document.querySelectorAll('[data-audita-highlight-root=\"v1\"]').length"),
        activeTabs: await extension.evaluate(extension.harnessPage,
          `chrome.tabs.query({active:true,currentWindow:true}).then(tabs=>tabs.map(tab=>({id:tab.id,url:new URL(tab.url).pathname})))`,
          { awaitPromise: true }),
      };
      t.diagnostic(`highlight-install=${JSON.stringify({ surfaces, highlightDiagnostic })}`);
      throw error;
    }
    assert.equal(await extension.evaluate(panel, `(() => {
      const button=document.querySelector('button[data-action="clear-highlight"]');
      if(!button||button.disabled)return false;
      button.focus();
      button.click();
      return true;
    })()`, { userGesture: true }), true);
    await Promise.all([
      extension.waitForValue(extension.startPage.page,
        "document.querySelectorAll('[data-audita-highlight-root=\"v1\"]').length", value => value === 0,
        { timeoutMs: 10_000, intervalMs: 50 }),
      extension.waitForValue(panel, `(() => ({
        action:document.querySelector('[data-action="highlight-occurrence"]')?.dataset.action??null,
        focusId:document.activeElement?.dataset?.focusId??null
      }))()`, value => value?.action === 'highlight-occurrence' && value?.focusId === 'live-highlight-action',
      { timeoutMs: 10_000, intervalMs: 50 }),
      extension.waitForValue(report,
        `document.querySelector(${JSON.stringify(reportHighlightSelector)})?.getAttribute('data-report-highlight')`,
        value => value === 'highlight', { timeoutMs: 10_000, intervalMs: 50 }),
    ]);

    await extension.click(report, `${reportHighlightSelector}[data-report-highlight="highlight"]`);
    await extension.waitForValue(extension.startPage.page,
      "document.querySelectorAll('[data-audita-highlight-root=\"v1\"]').length", value => value === 1,
      { timeoutMs: 10_000, intervalMs: 50 });
    assert.deepEqual(await extension.identityOf(extension.startPage), before,
      'the audit and live highlight did not navigate the audited page');
    await navigateRealPage(extension, extension.startPage, {
      url: `${fixture.origin}/after-navigation`, operationId: 'highlight-navigation-cleanup',
    });
    try {
      await Promise.all([
        extension.waitForValue(extension.startPage.page,
          "document.querySelectorAll('[data-audita-highlight-root=\"v1\"]').length", value => value === 0,
          { timeoutMs: 10_000, intervalMs: 50 }),
        extension.waitForValue(report,
          `document.querySelector(${JSON.stringify(reportHighlightSelector)})?.getAttribute('data-highlight-action')`,
          value => value === 'unavailable', { timeoutMs: 10_000, intervalMs: 50 }),
      ]);
      const rebound = await waitForReboundSidePanel(extension, {
        priorDocumentId: panelDocumentId,
        timeoutMs: 10_000,
      });
      const reboundState = await extension.waitForValue(rebound.page, `(() => ({
        screen:document.querySelector('[data-screen]')?.dataset.screen??null,
        clear:Boolean(document.querySelector('[data-action="clear-highlight"]')),
        status:document.querySelector('[role="status"]')?.textContent??null
      }))()`, value => value?.screen === 'result' && value?.clear === false, {
        timeoutMs: 10_000, intervalMs: 50,
      });
      const reboundContexts = await extension.waitForValue(extension.harnessPage,
        `chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']}).then(values=>values.map(value=>({
          documentId:value.documentId,
          documentUrl:value.documentUrl
        })))`, values => Array.isArray(values) && values.length === 1 && (() => {
          try {
            const url=new URL(values[0].documentUrl);
            return url.pathname==='/src/panel/index.html' && url.searchParams.getAll('launch').length===1;
          } catch { return false; }
        })(), { timeoutMs: 10_000, intervalMs: 50 });
      t.diagnostic(`panel-rebound=${JSON.stringify({
        screen: reboundState.screen,
        clear: reboundState.clear,
        sidePanels: reboundContexts.length,
      })}`);
    } catch (error) {
      const navigationDiagnostic = {
        page: await extension.evaluate(extension.startPage.page, `({
          href:location.href,
          roots:document.querySelectorAll('[data-audita-highlight-root="v1"]').length
        })`),
        panel: await extension.evaluate(panel, `(() => ({
          screen:document.querySelector('[data-screen]')?.dataset.screen??null,
          status:document.querySelector('[role="status"]')?.textContent??null,
          clear:Boolean(document.querySelector('[data-action="clear-highlight"]')),
          highlight:Boolean(document.querySelector('[data-action="highlight-occurrence"]')),
          unavailable:Boolean(document.querySelector('[data-action="consult-evidence"]'))
        }))()`),
        report: await extension.evaluate(report, `(() => {
          const button=document.querySelector(${JSON.stringify(reportHighlightSelector)});
          return button?{
            action:button.getAttribute('data-highlight-action'),
            state:button.getAttribute('data-report-highlight'),
            ariaDisabled:button.getAttribute('aria-disabled'),
            text:button.textContent
          }:null;
        })()`),
        contexts: await extension.runtimeContexts({ contextTypes: ['SIDE_PANEL'] }),
      };
      t.diagnostic(`highlight-navigation=${JSON.stringify(navigationDiagnostic)}`);
      throw error;
    }
    t.diagnostic(`highlight-sync=active-panel-report; clear-focus=preserved; navigation-cleanup=confirmed; occurrence=${selectedOccurrenceId}`);

    await extension.click(report, 'button[data-report-export]');
    const downloads = await extension.waitForFourDownloads({ auditId, timeoutMs: 60_000, intervalMs: 50 });
    assert.deepEqual(downloads.map(row => row.format), ['html', 'pdf', 'csv', 'json']);
    assert.equal(downloads.every(row => row.state === 'complete' && row.byteLength > 0 && /^[a-f0-9]{64}$/u.test(row.sha256)), true);
    const exportsContainingLaunchAuthority = (await Promise.all(downloads.map(async row => ({
      format: row.format,
      containsToken: (await readFile(join(downloadDirectory, row.filename))).includes(Buffer.from(launchToken)),
    })))).filter(row => row.containsToken).map(row => row.format);
    assert.deepEqual(exportsContainingLaunchAuthority, []);
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
