import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_CHROME_PRODUCT,
  launchUnpackedExtension,
  resolveRealChromeTestBinary,
  startFixtureServer,
  waitForServiceWorker,
} from './support/real-chrome.mjs';
import { isEvidenceUrlV1, sanitizeEvidenceUrlV1 } from '../../src/core/privacy/evidence-url.js';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
const chromeBinary = resolveRealChromeTestBinary();
const queryMarker = 'AUDITA4AP_QUERY_49C182D7';
const fragmentMarker = 'AUDITA4AP_FRAGMENT_75B30E91';
const privateFieldNames = Object.freeze([
  'navigationToken', 'sessionDigest', 'urlSessionDigest', 'ownershipId', 'capabilityId', 'consentId',
]);

function hostDocument() {
  return `<!doctype html>
    <html lang="pt-BR">
      <head><meta charset="utf-8"><title>Página hospedeira</title></head>
      <body><main><h1 id="host-title">Página hospedeira preservada</h1></main></body>
    </html>`;
}

function sensitiveDocument() {
  return `<!doctype html>
    <html lang="pt-BR">
      <head>
        <meta charset="utf-8">
        <title>Alvo sensível determinístico</title>
        <style>body{font-family:system-ui;min-height:1100px}main{max-width:720px;margin:24px auto}section{padding:16px;border:1px solid #ccc}</style>
      </head>
      <body>
        <main>
          <h1>Alvo sensível determinístico</h1>
          <label for="password-field">Senha</label>
          <input id="password-field" type="password" autocomplete="current-password" value="">
          <section data-audita-private><p>Área local marcada como privada.</p></section>
          <img id="missing-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
          <input id="missing-label" type="text">
          <button id="missing-name"></button>
          <a href="/sensitive-a">clique aqui</a>
        </main>
      </body>
    </html>`;
}

function changedDocument() {
  return `<!doctype html>
    <html lang="pt-BR">
      <head><meta charset="utf-8"><title>Documento alterado</title></head>
      <body><main><h1>Documento B</h1><button>Continuar</button></main></body>
    </html>`;
}

async function startUrlAudit(extension, panel, rawUrl, mode) {
  await extension.waitForValue(panel,
    `document.querySelector('[data-screen]')?.dataset.screen`, value => value === 'initial', {
      timeoutMs: 30_000, intervalMs: 50,
    });
  const hasForm = await extension.evaluate(panel, `Boolean(document.querySelector('#audit-form'))`);
  if (!hasForm) await extension.click(panel, 'button[data-intent="OPEN_URL_FORM"]');
  await extension.waitForValue(panel, `Boolean(document.querySelector('#audit-form'))`, Boolean, {
    timeoutMs: 10_000, intervalMs: 25,
  });
  await extension.click(panel, `input[data-capture-mode="${mode}"]`);
  const entry = await extension.evaluate(panel, `(() => {
    const input=document.querySelector('#audit-url');
    const submit=document.querySelector('[data-action="start-url-audit"]');
    input.value=${JSON.stringify(rawUrl)};
    input.dispatchEvent(new Event('input',{bubbles:true}));
    return {
      mode:document.querySelector('input[name="capture-mode"]:checked')?.value??null,
      disabled:submit?.disabled??null,
      value:input.value
    };
  })()`);
  assert.deepEqual(entry, { mode, disabled: false, value: rawUrl });
  await extension.click(panel, '[data-action="start-url-audit"]');
}

function pauseExpression() {
  return `(() => {
    const root=document.querySelector('[data-screen="running"][data-session-status="privacy-paused"]');
    return root?{
      screen:root.dataset.screen,
      sessionStatus:root.dataset.sessionStatus,
      categories:[...root.querySelectorAll('.privacy-signals li')].map(item=>item.textContent),
      confirm:root.querySelector('[data-action="confirm-pixel-capture"]')?.textContent??null,
      cancel:root.querySelector('button[data-intent="CANCEL_AUDIT"]')?.textContent??null
    }:null;
  })()`;
}

async function waitForPrivacyPause(extension, panel) {
  // TRAVA REMOVIDA: sinal sensível não pausa. Este helper prova a AUSÊNCIA de pausa e de diálogo
  // de autorização enquanto a auditoria avança (running com auditId, ou já em resultado).
  let last = null;
  const limite = Date.now() + 30_000;
  do {
    last = await extension.evaluate(panel, `(() => ({
      screen:document.querySelector('[data-screen]')?.dataset.screen??null,
      sessionStatus:document.querySelector('[data-screen]')?.dataset.sessionStatus??null,
      confirma:Boolean(document.querySelector('[data-action="confirm-pixel-capture"]')),
    }))()`);
    if (last?.confirma === true) {
      throw new Error(`PRIVACY_PAUSE_UNEXPECTED:${JSON.stringify(last)}`);
    }
    if (last?.screen === 'result' || last?.screen === 'unavailable') return last;
    if (last?.screen === 'running') {
      const attempt = await readPrivateAttempt(extension).catch(() => null);
      if (attempt?.auditId) return last;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < limite);
  const diagnostic = await extension.evaluate(panel, `(() => ({
    screen:document.querySelector('[data-screen]')?.dataset.screen??null,
    sessionStatus:document.querySelector('[data-screen]')?.dataset.sessionStatus??null,
    status:document.querySelector('[role="status"]')?.textContent??null,
    fieldError:document.querySelector('.field-error')?.textContent??null
  }))()`);
  throw new Error(`AUDIT_DID_NOT_START:${JSON.stringify({ diagnostic, last })}`);
}

async function readPrivateAttempt(extension, auditId = null) {
  return extension.evaluate(extension.harnessPage, `(async()=>{
    const stored=await chrome.storage.session.get(null);
    const active=stored['audita:active-audit-job:v1']??null;
    const selectedAuditId=${JSON.stringify(auditId)}??active?.auditId??null;
    const owners=Object.entries(stored)
      .filter(([key,value])=>key.startsWith('audita:owned-tab:v2:')&&value?.auditId===selectedAuditId)
      .map(([,value])=>({tabId:value.tabId,windowId:value.windowId,state:value.state,cleanupMode:value.cleanupMode}));
    const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
    const revision=selectedAuditId?await store.getReportRevision(selectedAuditId):null;
    const sessionText=JSON.stringify(stored);
    return {
      auditId:selectedAuditId,
      active:active&&active.auditId===selectedAuditId?{state:active.state,mode:active.mode}:null,
      owners,
      reportPresent:Boolean(revision),
      sessionRasterDataUrls:(sessionText.match(/data:image\\/(?:png|jpeg|webp);base64,/giu)||[]).length
    };
  })()`, { awaitPromise: true });
}

async function assertPausedPersistence(extension) {
  // TRAVA REMOVIDA: não há mais estado `privacy-paused` nem owner retido para consentimento.
  // O helper passa a devolver a tentativa em andamento/resultado, com o owner da aba temporária.
  const state = await readPrivateAttempt(extension);
  assert.match(state.auditId ?? '', /^[A-Za-z0-9._:-]{1,160}$/u);
  assert.notEqual(state.active?.state, 'privacy-paused', 'a trava de consentimento não deve existir');
  assert.equal(state.owners.length, 1);
  assert.equal(Number.isSafeInteger(state.owners[0].tabId), true);
  return state;
}

async function stopServiceWorker(extension) {
  const worker = await waitForServiceWorker(extension);
  assert.equal(await extension.evaluate(worker,
    `(() => { globalThis.__auditaE2eWorkerRestartProof='before-stop'; return globalThis.__auditaE2eWorkerRestartProof; })()`),
  'before-stop');
  const expectedUrl = `chrome-extension://${extension.extensionId}/src/background/service-worker.js`;
  await extension.command(extension.harnessPage, 'ServiceWorker.disable');
  const runningEvent = extension.harnessPage.waitForEvent('ServiceWorker.workerVersionUpdated', value =>
    Array.isArray(value?.versions) && value.versions.some(version =>
      version?.scriptURL === expectedUrl && version?.runningStatus === 'running'), { timeoutMs: 10_000 });
  await extension.command(extension.harnessPage, 'ServiceWorker.enable');
  const running = await runningEvent;
  const versions = running.versions.filter(version =>
    version?.scriptURL === expectedUrl && version?.runningStatus === 'running');
  assert.equal(versions.length, 1);
  const versionId = versions[0].versionId;
  assert.equal(typeof versionId, 'string');
  const stoppedEvent = extension.harnessPage.waitForEvent('ServiceWorker.workerVersionUpdated', value =>
    Array.isArray(value?.versions) && value.versions.some(version =>
      version?.versionId === versionId && version?.runningStatus === 'stopped'), { timeoutMs: 10_000 });
  await extension.command(extension.harnessPage, 'ServiceWorker.stopWorker', { versionId });
  await stoppedEvent;
  return versionId;
}

async function proveReplacementServiceWorker(extension) {
  const replacement = await waitForServiceWorker(extension, { timeoutMs: 20_000, intervalMs: 50 });
  assert.equal(await extension.evaluate(replacement,
    `typeof globalThis.__auditaE2eWorkerRestartProof==='undefined'`), true,
  'the service worker must resume in a new volatile execution realm');
}

async function confirmOnce(extension, panel) {
  await extension.click(panel, '[data-action="confirm-pixel-capture"]');
  const pending = await extension.waitForValue(panel, `(() => {
    const button=document.querySelector('[data-action="confirm-pixel-capture"]');
    return button?{
      label:button.textContent,
      ariaDisabled:button.getAttribute('aria-disabled'),
      count:document.querySelectorAll('[data-action="confirm-pixel-capture"]').length
    }:null;
  })()`, value => value?.label === 'Confirmação enviada' && value?.ariaDisabled === 'true', {
    timeoutMs: 10_000, intervalMs: 20,
  });
  assert.deepEqual(pending, { label: 'Confirmação enviada', ariaDisabled: 'true', count: 1 });
  assert.equal(await extension.evaluate(panel, `(() => {
    const button=document.querySelector('[data-action="confirm-pixel-capture"]');
    button?.click();
    return button?.getAttribute('aria-disabled')??null;
  })()`, { userGesture: true }), 'true');
}

async function waitForResult(extension, panel) {
  const terminal = await extension.waitForValue(panel, `(() => ({
    screen:document.querySelector('[data-screen]')?.dataset.screen??null,
    auditId:document.querySelector('[data-screen="result"]')?.dataset.auditId??null,
    status:document.querySelector('[role="status"]')?.textContent??null
  }))()`, value => ['result', 'initial', 'unavailable'].includes(value?.screen), {
    timeoutMs: 120_000, intervalMs: 50,
  });
  assert.equal(terminal.screen, 'result', JSON.stringify(terminal));
  assert.match(terminal.auditId ?? '', /^[A-Za-z0-9._:-]{1,160}$/u);
  return terminal.auditId;
}

async function readReportEvidence(extension, auditId) {
  return extension.evaluate(extension.harnessPage, `(async()=>{
    const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
    const revision=await store.getReportRevision(${JSON.stringify(auditId)});
    const model=revision?.model??null;
    const evidence=Array.isArray(model?.evidence)?model.evidence:[];
    const text=JSON.stringify(revision);
    const forbidden=${JSON.stringify([queryMarker, fragmentMarker, ...privateFieldNames])};
    return {
      revision:revision?.modelRevision??null,
      status:model?.session?.status??null,
      fullPage:evidence.filter(item=>item?.kind==='full-page'&&/^data:image\\/png;base64,/u.test(item.dataUrl??'')).length,
      elements:evidence.filter(item=>item?.kind==='element'&&/^data:image\\/png;base64,/u.test(item.dataUrl??'')).length,
      diagnosticCodes:Array.isArray(model?.session?.diagnostics)?model.session.diagnostics.map(item=>item.code):[],
      requestedUrl:model?.requestedUrl??null,
      finalUrl:model?.finalUrl??null,
      pageRequestedUrl:model?.pages?.[0]?.requestedUrl??null,
      pageFinalUrl:model?.pages?.[0]?.finalUrl??null,
      forbidden:forbidden.filter(value=>text.includes(value))
    };
  })()`, { awaitPromise: true });
}

function publicLeakExpression(rawUrl) {
  return `(() => {
    const text=document.documentElement?.outerHTML??'';
    const forbidden=${JSON.stringify([rawUrl, queryMarker, fragmentMarker, ...privateFieldNames])};
    return {
      forbidden:forbidden.filter(value=>text.includes(value)),
      evidenceImages:document.querySelectorAll(
        '[data-report-evidence-preview] img.evidence-media, [data-report-evidence-preview] svg.evidence-media image'
      ).length,
      rasterDataUrls:(text.match(/data:image\\/(?:png|jpeg|webp);base64,/giu)||[]).length
    };
  })()`;
}

async function openAndProveReport(extension, panel, auditId, rawUrl, expected, resources) {
  await extension.click(panel, 'button[data-intent="OPEN_REPORT"]');
  const report = await extension.waitForReport({ auditId });
  resources.report = report;
  const state = await extension.waitForValue(report, `(() => ({
    ready:Boolean(document.querySelector('button[data-report-export]')),
    issues:document.querySelectorAll('[data-report-issue]').length,
    text:document.body?.textContent??'',
    limitationHeadline:document.querySelector('[data-report-limitations] summary')?.textContent??''
  }))()`, value => value?.ready === true && value?.issues > 0, { timeoutMs: 30_000, intervalMs: 50 });
  assert.match(state.text, /WCAG 2\.2:/u);
  assert.match(state.text, /ABNT NBR 17225:/u);
  if (expected.limitation) assert.match(state.text, expected.limitation);
  // A alternância acima é satisfeita pela ENTRADA CODIFICADA, que sempre existe na lista: por isso
  // ela não provava que a cláusula em linguagem simples chegou ao artefato entregue — o Minor 5 da
  // revisão da 1.1.21 e o achado N2 da 1.1.22 vêm exatamente dessa diferença. Aqui a exigência é a
  // manchete (`[data-report-limitations] summary`), onde a pessoa lê antes de abrir os detalhes.
  if (expected.limitationHeadline) assert.match(state.limitationHeadline, expected.limitationHeadline);
  const leak = await extension.evaluate(report, publicLeakExpression(rawUrl));
  assert.deepEqual(leak.forbidden, []);
  assert.ok(leak.evidenceImages >= expected.minimumImages);
  assert.ok(leak.rasterDataUrls >= expected.minimumImages);
  return report;
}

function durableDeletionExpression(auditId) {
  return `(async()=>{
    const auditId=${JSON.stringify(auditId)};
    const stored=await chrome.storage.session.get(null);
    const entries=Object.entries(stored);
    const active=stored['audita:active-audit-job:v1']??null;
    const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
    const [audit,revision]=await Promise.all([store.getAudit(auditId),store.getReportRevision(auditId)]);
    const owners=[];
    for(const [,value] of entries.filter(([key,value])=>
      key.startsWith('audita:owned-tab:v2:')&&value?.auditId===auditId)){
      let tabExists=true;
      try{await chrome.tabs.get(value.tabId);}catch{tabExists=false;}
      owners.push({tabId:value.tabId,state:value.state,tabExists});
    }
    const rawNavigationCount=entries.filter(([key,value])=>
      (key.startsWith('audita:raw-navigation:v1:')||
       key.startsWith('audita:raw-navigation-queue:v1:')||
       key==='audita:raw-navigation-cleanup:v1')&&value?.auditId===auditId).length;
    const pixelSessionCount=entries.filter(([key,value])=>
      (key.startsWith('audita:pixel-capture:v1:')||key.startsWith('audita:pixel-attempt:v1:'))&&
      value?.auditId===auditId).length;
    const pixelCompanionPresent=await new Promise(resolve=>{
      const opening=indexedDB.open('audita-mt');
      opening.onerror=()=>resolve(null);
      opening.onsuccess=()=>{
        const database=opening.result;
        let transaction;
        try{transaction=database.transaction('audits','readonly');}catch{database.close();resolve(null);return;}
        const request=transaction.objectStore('audits').get('__audit_checkpoint__:/pixel-attempt/:'+auditId);
        request.onerror=()=>{database.close();resolve(null);};
        request.onsuccess=()=>{const present=request.result!==undefined;database.close();resolve(present);};
      };
    });
    return {
      auditPresent:Boolean(audit),reportPresent:Boolean(revision),activeSame:active?.auditId===auditId,
      owners,rawNavigationCount,pixelSessionCount,pixelCompanionPresent
    };
  })()`;
}

async function readDurableDeletionProof(extension, auditId) {
  return extension.evaluate(extension.harnessPage, durableDeletionExpression(auditId), { awaitPromise: true });
}

async function waitForDurableDeletion(extension, auditId, ownerTabId) {
  try {
    return await extension.waitForValue(extension.harnessPage, durableDeletionExpression(auditId),
      value => isDurableDeletionProof(value, ownerTabId), { timeoutMs: 20_000, intervalMs: 50 });
  } catch {
    const observed = await readDurableDeletionProof(extension, auditId).catch(() => null);
    const error = new Error(`E2E_AUDIT_RESOURCES_REMAIN:${JSON.stringify(observed)}`);
    error.code = 'E2E_AUDIT_RESOURCES_REMAIN';
    throw error;
  }
}

async function deleteAudit(extension, panel, report, auditId, ownerTabId) {
  await extension.waitForValue(report, `document.querySelector('#return-to-page')?.disabled===false`, Boolean, {
    timeoutMs: 10_000, intervalMs: 25,
  });
  await extension.click(report, '#return-to-page');
  await extension.waitForValue(extension.harnessPage,
    `chrome.tabs.query({active:true,windowId:${JSON.stringify(extension.startPage.windowId)}})
      .then(tabs=>tabs.length===1&&tabs[0].id===${JSON.stringify(extension.startPage.tabId)})`, Boolean, {
      timeoutMs: 10_000, intervalMs: 25,
    });
  await extension.click(report, '#delete-audit');
  await extension.waitForValue(report, `document.querySelector('#delete-audit-dialog')?.open`, Boolean, {
    timeoutMs: 10_000, intervalMs: 25,
  });
  await extension.click(report, '#delete-audit-confirm');
  const proof = await waitForDurableDeletion(extension, auditId, ownerTabId);
  let panelInitial = false;
  try {
    await extension.waitForValue(panel,
      `document.querySelector('[data-screen]')?.dataset.screen`, value => value === 'initial', {
        timeoutMs: 5_000, intervalMs: 50,
      });
    panelInitial = true;
  } catch { /* durable cleanup is authoritative; a stale panel only prevents profile reuse */ }
  if (!panelInitial) {
    try { await extension.close(); } catch { /* the stale instance is never reused */ }
    return { cleaned: true, closed: true, proof };
  }
  return { cleaned: true, closed: false, proof };
}

function assertSafeEvidenceUrls(evidence, fixtureOrigin) {
  const pairs = [
    ['requestedUrl', evidence.requestedUrl],
    ['finalUrl', evidence.finalUrl],
    ['pageRequestedUrl', evidence.pageRequestedUrl],
    ['pageFinalUrl', evidence.pageFinalUrl],
  ];
  for (const [name, value] of pairs) {
    assert.equal(typeof value, 'string', name);
    const parsed = new URL(value);
    assert.ok(['http:', 'https:'].includes(parsed.protocol), name);
    assert.equal(parsed.origin, fixtureOrigin, name);
    assert.equal(parsed.search, '', name);
    assert.equal(parsed.hash, '', name);
    assert.equal(value.includes(queryMarker), false, name);
    assert.equal(value.includes(fragmentMarker), false, name);
    const canonical = sanitizeEvidenceUrlV1(value, { includeQuery: false });
    assert.equal(isEvidenceUrlV1(canonical), true, name);
    assert.equal(canonical.href, value, name);
    assert.equal(canonical.queryIncluded, false, name);
  }
  assert.equal(evidence.requestedUrl, evidence.pageRequestedUrl);
  assert.equal(evidence.finalUrl, evidence.pageFinalUrl);
}

function isDurableDeletionProof(value, ownerTabId) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    value.auditPresent === false && value.reportPresent === false && value.activeSame === false &&
    Array.isArray(value.owners) && value.owners.every(owner => owner?.state === 'removed' &&
      owner.tabExists === false && Number.isSafeInteger(owner.tabId)) &&
    value.owners.some(owner => owner.tabId === ownerTabId) &&
    value.rawNavigationCount === 0 && value.pixelSessionCount === 0 && value.pixelCompanionPresent === false);
}

function classifyNavigationDrift(value, changedUrl) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === 'outcome' && value.outcome === 'owner-removed') return 'owner-removed';
  if (keys.length !== 4 || !keys.includes('outcome') || !keys.includes('url') ||
    !keys.includes('status') || !keys.includes('document') || value.outcome !== 'document-b' ||
    value.url !== changedUrl || value.status !== 'complete') return null;
  const document = value.document;
  if (!document || typeof document !== 'object' || Array.isArray(document) ||
    Object.keys(document).length !== 3 || document.href !== changedUrl ||
    document.title !== 'Documento alterado' || document.heading !== 'Documento B') return null;
  return 'document-b';
}

async function waitForNavigationDriftOutcome(extension, tabId, changedUrl) {
  return extension.waitForValue(extension.harnessPage, `(async()=>{
    let tab;
    try{tab=await chrome.tabs.get(${JSON.stringify(tabId)});}catch{return {outcome:'owner-removed'};}
    if(tab.url!==${JSON.stringify(changedUrl)}||tab.status!=='complete') return null;
    let frames;
    try{
      frames=await chrome.scripting.executeScript({
        target:{tabId:${JSON.stringify(tabId)}},world:'ISOLATED',
        func:()=>({href:location.href,title:document.title,heading:document.querySelector('h1')?.textContent??null})
      });
    }catch{
      try{await chrome.tabs.get(${JSON.stringify(tabId)});}catch{return {outcome:'owner-removed'};}
      return null;
    }
    return {outcome:'document-b',url:tab.url,status:tab.status,document:frames[0]?.result??null};
  })()`, value => classifyNavigationDrift(value, changedUrl) !== null,
  { timeoutMs: 15_000, intervalMs: 50 });
}

async function cleanupSubcase(extension, panel, resources) {
  if (resources.deleted || resources.cleaned) return { closed: false };
  const closeIsolatedChrome = async () => {
    try { await extension.close(); } catch { /* the failed instance is never reused */ }
    return { closed: true };
  };
  try {
    const current = await extension.evaluate(panel, `(() => ({
      screen:document.querySelector('[data-screen]')?.dataset.screen??null,
      status:document.querySelector('[data-screen]')?.dataset.sessionStatus??null,
      auditId:document.querySelector('[data-audit-id]')?.dataset.auditId??null
    }))()`);
    if (current.screen === 'running') {
      await extension.click(panel, 'button[data-intent="CANCEL_AUDIT"]');
      await extension.waitForValue(panel,
        `document.querySelector('[data-screen]')?.dataset.screen`, value => value === 'initial', {
          timeoutMs: 30_000, intervalMs: 50,
        });
      if (resources.auditId && Number.isSafeInteger(resources.ownerTabId)) {
        await assertAttemptRemoved(extension, resources.auditId, resources.ownerTabId);
        resources.cleaned = true;
        return { closed: false };
      }
      return closeIsolatedChrome();
    }
    if (current.screen !== 'result') return closeIsolatedChrome();
    const auditId = resources.auditId ?? current.auditId;
    if (!auditId) return closeIsolatedChrome();
    let report = resources.report;
    if (!report) {
      const contexts = await extension.runtimeContexts({ contextTypes: ['TAB'] });
      const existing = contexts.some(context => {
        try {
          const url = new URL(context.documentUrl);
          return url.pathname === '/src/review/index.html' && url.searchParams.get('auditId') === auditId;
        } catch { return false; }
      });
      if (!existing) await extension.click(panel, 'button[data-intent="OPEN_REPORT"]');
      report = await extension.waitForReport({ auditId });
    }
    const deletion = await deleteAudit(
      extension, panel, report, auditId, resources.ownerTabId,
    );
    resources.deleted = deletion.cleaned === true;
    return { closed: deletion.closed === true };
  } catch (error) {
    const closed = await closeIsolatedChrome();
    if (error?.code === 'E2E_AUDIT_RESOURCES_REMAIN') throw error;
    return closed;
  }
}

test('cleanup tears down the isolated Chrome when a known audit cannot be proven removed from the initial screen', async () => {
  let closeCalls = 0;
  const extension = {
    async evaluate() { return { screen: 'initial', status: null, auditId: null }; },
    async close() { closeCalls += 1; return true; },
  };
  const result = await cleanupSubcase(extension, {}, {
    auditId: 'audit-cleanup-proof', report: null, deleted: false, cleaned: false,
  });
  assert.deepEqual(result, { closed: true });
  assert.equal(closeCalls, 1);
});

test('cleanup tears down the isolated Chrome after a pre-start failure without an audit id', async () => {
  let closeCalls = 0;
  const extension = {
    async evaluate() { return { screen: 'initial', status: null, auditId: null }; },
    async close() { closeCalls += 1; return true; },
  };
  const result = await cleanupSubcase(extension, {}, {
    auditId: null, report: null, deleted: false, cleaned: false,
  });
  assert.deepEqual(result, { closed: true });
  assert.equal(closeCalls, 1);
});

test('cleanup converts a report deletion timeout into isolated Chrome teardown', async () => {
  let closeCalls = 0;
  const extension = {
    async evaluate() { return { screen: 'result', status: null, auditId: 'audit-delete-timeout' }; },
    async waitForValue() { throw Object.assign(new Error('WAIT_TIMEOUT'), { code: 'WAIT_TIMEOUT' }); },
    async close() { closeCalls += 1; return true; },
  };
  const result = await cleanupSubcase(extension, {}, {
    auditId: 'audit-delete-timeout', report: {}, deleted: false, cleaned: false,
  });
  assert.deepEqual(result, { closed: true });
  assert.equal(closeCalls, 1);
});

test('durable deletion proof rejects every retained audit resource family', () => {
  const clean = {
    auditPresent: false, reportPresent: false, activeSame: false,
    owners: [{ tabId: 41, state: 'removed', tabExists: false }],
    rawNavigationCount: 0, pixelSessionCount: 0, pixelCompanionPresent: false,
  };
  assert.equal(isDurableDeletionProof(clean, 41), true);
  for (const mutation of [
    { auditPresent: true }, { reportPresent: true }, { activeSame: true },
    { owners: [{ tabId: 41, state: 'cleanup-pending', tabExists: false }] },
    { owners: [{ tabId: 41, state: 'removed', tabExists: true }] },
    { rawNavigationCount: 1 }, { pixelSessionCount: 1 }, { pixelCompanionPresent: true },
  ]) {
    assert.equal(isDurableDeletionProof({ ...clean, ...mutation }, 41), false, JSON.stringify(mutation));
  }
});

test('navigation drift accepts only a proven document B or a removed owner', () => {
  const changedUrl = 'http://127.0.0.1:8080/changed-b';
  assert.equal(classifyNavigationDrift({ outcome: 'owner-removed' }, changedUrl), 'owner-removed');
  assert.equal(classifyNavigationDrift({
    outcome: 'document-b', url: changedUrl, status: 'complete',
    document: { href: changedUrl, title: 'Documento alterado', heading: 'Documento B' },
  }, changedUrl), 'document-b');
  for (const invalid of [
    null,
    { outcome: 'document-b', url: changedUrl, status: 'loading', document: null },
    { outcome: 'document-b', url: changedUrl, status: 'complete', document: { href: changedUrl, title: 'Outro', heading: 'Documento B' } },
    { outcome: 'owner-removed', extra: true },
  ]) assert.equal(classifyNavigationDrift(invalid, changedUrl), null);
});

async function assertAttemptRemoved(extension, auditId, tabId) {
  const result = await waitForDurableDeletion(extension, auditId, tabId);
  assert.equal(isDurableDeletionProof(result, tabId), true, JSON.stringify(result));
}

async function beginTabVisibilityProof(extension) {
  assert.equal(await extension.evaluate(extension.harnessPage, `(() => {
    const activations=[];
    const onActivated=info=>activations.push({tabId:info.tabId,windowId:info.windowId});
    chrome.tabs.onActivated.addListener(onActivated);
    Object.defineProperty(globalThis,'__auditaUrlTabVisibilityV1',{
      value:{activations,onActivated},configurable:true,enumerable:false,writable:false
    });
    return true;
  })()`), true);
}

async function resetTabVisibilityProof(extension) {
  assert.equal(await extension.evaluate(extension.harnessPage, `(() => {
    const proof=globalThis.__auditaUrlTabVisibilityV1;
    if(!proof||!Array.isArray(proof.activations)) return false;
    proof.activations.length=0;
    return true;
  })()`), true);
}

async function assertHostStayedActive(extension, ownerTabId) {
  const hostTabId = extension.startPage.tabId;
  const hostWindowId = extension.startPage.windowId;
  const proof = await extension.evaluate(extension.harnessPage, `(async()=>{
    const state=globalThis.__auditaUrlTabVisibilityV1;
    const active=await chrome.tabs.query({active:true,windowId:${JSON.stringify(hostWindowId)}});
    let ownerActive=null;
    try{ownerActive=(await chrome.tabs.get(${JSON.stringify(ownerTabId)})).active;}catch{}
    return {
      activeIds:active.map(tab=>tab.id),
      ownerActive,
      ownerActivations:state.activations.filter(info=>info.tabId===${JSON.stringify(ownerTabId)}).length
    };
  })()`, { awaitPromise: true });
  assert.deepEqual(proof.activeIds, [hostTabId]);
  assert.notEqual(proof.ownerActive, true);
  assert.equal(proof.ownerActivations, 0);
}

test('URL pixel modes complete without privacy pause and clean owned tabs', { timeout: 600_000 }, async t => {
  assert.ok(chromeBinary, 'AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório para o E2E real de consentimento por URL.');
  await access(chromeBinary, fsConstants.X_OK);
  const fixture = await startFixtureServer(t, new Map([
    ['/host', {
      status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: hostDocument(),
    }],
    ['/sensitive-a', {
      status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: sensitiveDocument(),
    }],
    ['/changed-b', {
      status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: changedDocument(),
    }],
  ]));
  const rawUrl = `${fixture.origin}/sensitive-a?private_marker=${queryMarker}#${fragmentMarker}`;
  const changedUrl = `${fixture.origin}/changed-b`;
  let extension = null;
  let hostIdentity = null;
  let panel = null;
  const ensureChrome = async () => {
    if (extension) return;
    extension = await launchUnpackedExtension(t, {
      extensionPath: await realpath(workspaceRoot),
      startUrl: `${fixture.origin}/host`,
      downloadMode: 'profile',
      viewport: { width: 1280, height: 900 },
      chromeBinary,
      expectedMajor: 152,
    });
    assert.equal(extension.chromeProduct, CANONICAL_CHROME_PRODUCT);
    hostIdentity = await extension.identityOf(extension.startPage);
    panel = await extension.openSidePanelFromAction();
    await beginTabVisibilityProof(extension);
  };
  const finishCleanup = async resources => {
    try {
      const result = await cleanupSubcase(extension, panel, resources);
      if (!result.closed) return;
    } catch (error) {
      extension = null;
      panel = null;
      hostIdentity = null;
      throw error;
    }
    extension = null;
    panel = null;
    hostIdentity = null;
  };

  await t.test('full-evidence completes without privacy pause and keeps the host tab active', async () => {
    await ensureChrome();
    const resources = { auditId: null, ownerTabId: null, report: null, deleted: false, cleaned: false };
    try {
      await resetTabVisibilityProof(extension);
      await startUrlAudit(extension, panel, rawUrl, 'full-evidence');
      await waitForPrivacyPause(extension, panel);
      const running = await assertPausedPersistence(extension);
      resources.auditId = running.auditId;
      resources.ownerTabId = running.owners[0]?.tabId ?? null;
      const auditId = await waitForResult(extension, panel);
      assert.equal(auditId, running.auditId);
      const evidence = await readReportEvidence(extension, auditId);
      assert.equal(evidence.revision, 1);
      assert.ok(['complete', 'partial'].includes(evidence.status));
      assert.ok(evidence.fullPage >= 1, JSON.stringify(evidence));
      assert.ok(evidence.elements >= 1, JSON.stringify(evidence));
      assert.deepEqual(evidence.forbidden, []);
      assertSafeEvidenceUrls(evidence, fixture.origin);
      await openAndProveReport(extension, panel, auditId, rawUrl, {
        minimumImages: 1, limitation: null,
      }, resources);
    } finally {
      await finishCleanup(resources);
    }
  });

  await t.test('element-only omits the full page and explains the factual limitation', async () => {
    await ensureChrome();
    const resources = { auditId: null, ownerTabId: null, report: null, deleted: false, cleaned: false };
    try {
      await resetTabVisibilityProof(extension);
      await startUrlAudit(extension, panel, rawUrl, 'element-only');
      await waitForPrivacyPause(extension, panel);
      const running = await assertPausedPersistence(extension);
      resources.auditId = running.auditId;
      resources.ownerTabId = running.owners[0]?.tabId ?? null;
      const auditId = await waitForResult(extension, panel);
      assert.equal(auditId, running.auditId);
      const evidence = await readReportEvidence(extension, auditId);
      assert.equal(evidence.fullPage, 0);
      assert.ok(evidence.elements >= 1, JSON.stringify(evidence));
      assert.ok(evidence.diagnosticCodes.includes('FULL_PAGE_CAPTURE_OMITTED'));
      assert.equal(evidence.diagnosticCodes.includes('PIXEL_CAPTURE_OMITTED'), false);
      assert.deepEqual(evidence.forbidden, []);
      assertSafeEvidenceUrls(evidence, fixture.origin);
      await openAndProveReport(extension, panel, auditId, rawUrl, {
        minimumImages: 1,
        limitation: /captura integral.*omitida|FULL_PAGE_CAPTURE_OMITTED/iu,
        limitationHeadline: /Captura integral omitida/u,
      }, resources);
    } finally {
      await finishCleanup(resources);
    }
  });

  t.diagnostic('Chrome=152; source=single-url; modes=full-evidence,element-only; privacy-pause=removed');
});
