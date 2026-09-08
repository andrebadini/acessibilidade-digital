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

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
const chromeBinary = resolveRealChromeTestBinary();
const queryMarkerA = 'AUDITA5B_QUERY_A_1A4D095F';
const queryMarkerB = 'AUDITA5B_QUERY_B_7CC93E21';
const fragmentMarkerA = 'AUDITA5B_FRAGMENT_A_3803AF74';
const fragmentMarkerB = 'AUDITA5B_FRAGMENT_B_D4F812B6';
const privateFieldNames = Object.freeze([
  'navigationToken', 'sessionDigest', 'urlSessionDigest', 'ownershipId', 'capabilityId', 'consentId',
]);

function hostDocument() {
  return `<!doctype html>
    <html lang="pt-BR">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Origem preservada</title></head>
      <body><main><h1>Página original preservada</h1><textarea id="local-state">conteúdo local intacto</textarea></main></body>
    </html>`;
}

function sensitiveDocument() {
  return `<!doctype html>
    <html lang="pt-BR">
      <head>
        <meta charset="utf-8"><meta name="viewport" content="width=device-width">
        <title>Página sensível do lote</title>
        <style>body{font-family:system-ui;min-height:1000px}main{max-width:720px;margin:24px auto}.private{padding:16px;border:1px solid #bbb}</style>
      </head>
      <body><main>
        <h1>Página sensível do lote</h1>
        <label for="password-field">Senha</label><input id="password-field" type="password" autocomplete="current-password">
        <section class="private" data-audita-private><p>Conteúdo local marcado como privado.</p></section>
        <img id="missing-alt-a" src="/pixel.gif">
        <button id="missing-name-a"></button>
      </main></body>
    </html>`;
}

function secondSensitiveDocument() {
  return `<!doctype html>
    <html lang="pt-BR">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Segunda página sensível do lote</title></head>
      <body><main>
        <h1>Segunda página sensível do lote</h1>
        <label for="password-field-b">Senha</label><input id="password-field-b" type="password" autocomplete="current-password">
        <section data-audita-private><p>Outro conteúdo local marcado como privado.</p></section>
        <label>Rótulo sem associação</label><input id="missing-label-b" type="text">
        <a href="/sensitive-b">clique aqui</a>
      </main></body>
    </html>`;
}

async function armOriginalPageProof(extension) {
  const identity = await extension.identityOf(extension.startPage);
  const armed = await extension.evaluate(extension.startPage.page, `(async()=>{
    try{globalThis.__auditaBatchPixelSourceProofV1?.observer?.disconnect?.();}catch{}
    const snapshot=()=>({
      href:location.href,
      title:document.title,
      html:document.documentElement.outerHTML,
      history:{length:history.length,state:JSON.stringify(history.state),restoration:history.scrollRestoration},
      scroll:{x:scrollX,y:scrollY},
      viewport:{
        innerWidth,innerHeight,devicePixelRatio,
        clientWidth:document.documentElement.clientWidth,
        clientHeight:document.documentElement.clientHeight
      }
    });
    const stable=await new Promise(resolve=>{
      let prior=null,equal=0,elapsed=0;
      const sample=()=>{
        const value=JSON.stringify(snapshot().viewport);
        equal=value===prior?equal+1:0;prior=value;elapsed+=50;
        if(equal>=4){resolve(true);return;}
        if(elapsed>=2000){resolve(false);return;}
        setTimeout(sample,50);
      };
      sample();
    });
    if(!stable)return false;
    const baseline=snapshot();
    const mutations={childList:0,attributes:0,characterData:0};
    const observer=new MutationObserver(records=>{
      for(const record of records)mutations[record.type]+=1;
    });
    observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
    const actions=Object.fromEntries([
      'scroll','beforeinput','input','change','click','pointerdown','pointerup',
      'keydown','keyup','popstate','hashchange'
    ].map(name=>[name,0]));
    for(const name of Object.keys(actions))addEventListener(name,event=>{
      if(event.isTrusted)actions[name]+=1;
    },true);
    Object.defineProperty(globalThis,'__auditaBatchPixelSourceProofV1',{
      value:{observer,compare(){
        for(const record of observer.takeRecords())mutations[record.type]+=1;
        const current=snapshot();
        return{
          sameSnapshot:JSON.stringify(current)===JSON.stringify(baseline),
          href:current.href===baseline.href,
          title:current.title===baseline.title,
          html:current.html===baseline.html,
          history:JSON.stringify(current.history)===JSON.stringify(baseline.history),
          scroll:JSON.stringify(current.scroll)===JSON.stringify(baseline.scroll),
          viewport:JSON.stringify(current.viewport)===JSON.stringify(baseline.viewport),
          mutationTotal:Object.values(mutations).reduce((sum,value)=>sum+value,0),
          actionTotal:Object.values(actions).reduce((sum,value)=>sum+value,0)
        };
      }},configurable:true,enumerable:false,writable:false
    });
    return true;
  })()`, { awaitPromise: true });
  assert.equal(armed, true, 'P5B_SOURCE_PROOF_UNAVAILABLE');
  return identity;
}

async function assertOriginalPageIntact(extension, identityBefore) {
  const comparison = await extension.evaluate(
    extension.startPage.page,
    'globalThis.__auditaBatchPixelSourceProofV1.compare()',
  );
  assert.deepEqual(comparison, {
    sameSnapshot: true,
    href: true,
    title: true,
    html: true,
    history: true,
    scroll: true,
    viewport: true,
    mutationTotal: 0,
    actionTotal: 0,
  }, 'P5B_ORIGINAL_PAGE_MUTATED');
  assert.deepEqual(
    await extension.identityOf(extension.startPage),
    identityBefore,
    'P5B_ORIGINAL_DOCUMENT_IDENTITY_CHANGED',
  );
}

async function armTabTimeline(extension) {
  assert.equal(await extension.evaluate(extension.harnessPage, `(()=>{
    try{globalThis.__auditaBatchPixelTabsProofV1?.dispose?.();}catch{}
    const sourceTabId=${JSON.stringify(extension.startPage.tabId)};
    const sourceWindowId=${JSON.stringify(extension.startPage.windowId)};
    const state={events:[],created:[],activated:[],sourceUpdates:[]};
    let order=0;
    const onCreated=tab=>{
      if(tab.windowId!==sourceWindowId||tab.id===sourceTabId)return;
      state.created.push({tabId:tab.id,active:tab.active===true});
      state.events.push({order:++order,kind:'created',tabId:tab.id});
    };
    const onRemoved=(tabId,info)=>{
      if(info.windowId!==sourceWindowId)return;
      state.events.push({order:++order,kind:'removed',tabId});
    };
    const onActivated=info=>{
      if(info.windowId===sourceWindowId)state.activated.push(info.tabId);
    };
    const onUpdated=(tabId,changeInfo)=>{
      if(tabId===sourceTabId&&(Object.hasOwn(changeInfo,'url')||Object.hasOwn(changeInfo,'discarded'))){
        state.sourceUpdates.push(Object.keys(changeInfo).filter(key=>key==='url'||key==='discarded').sort());
      }
    };
    chrome.tabs.onCreated.addListener(onCreated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    Object.defineProperty(globalThis,'__auditaBatchPixelTabsProofV1',{
      value:{state,dispose(){
        chrome.tabs.onCreated.removeListener(onCreated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        chrome.tabs.onActivated.removeListener(onActivated);
        chrome.tabs.onUpdated.removeListener(onUpdated);
      }},configurable:true,enumerable:false,writable:false
    });
    return true;
  })()`), true, 'P5B_TAB_TIMELINE_UNAVAILABLE');
}

async function readPausedTabTimeline(extension, pausedTabId) {
  return extension.evaluate(extension.harnessPage, `(async()=>{
    const proof=globalThis.__auditaBatchPixelTabsProofV1;
    const created=proof.state.created;
    const active=await chrome.tabs.query({active:true,windowId:${JSON.stringify(extension.startPage.windowId)}});
    return{
      createdCount:created.length,
      firstMatchesPaused:created[0]?.tabId===${JSON.stringify(pausedTabId)},
      firstInactive:created[0]?.active===false,
      ownedActivations:proof.state.activated.filter(tabId=>created.some(item=>item.tabId===tabId)).length,
      originalOnlyActive:active.length===1&&active[0].id===${JSON.stringify(extension.startPage.tabId)},
      sourceUpdateCount:proof.state.sourceUpdates.length
    };
  })()`, { awaitPromise: true });
}

async function readFinalTabTimeline(extension, pausedTabId) {
  return extension.evaluate(extension.harnessPage, `(async()=>{
    await new Promise(resolve=>setTimeout(resolve,100));
    const proof=globalThis.__auditaBatchPixelTabsProofV1;
    const created=proof.state.created;
    const createdIds=created.map(item=>item.tabId);
    const firstId=createdIds[0]??null;
    const secondId=createdIds[1]??null;
    const firstRemovedAt=proof.state.events.find(item=>item.kind==='removed'&&item.tabId===firstId)?.order??null;
    const secondCreatedAt=proof.state.events.find(item=>item.kind==='created'&&item.tabId===secondId)?.order??null;
    const removedIds=proof.state.events.filter(item=>item.kind==='removed').map(item=>item.tabId);
    const stillPresent=[];
    for(const tabId of createdIds){try{await chrome.tabs.get(tabId);stillPresent.push(tabId);}catch{}}
    const active=await chrome.tabs.query({active:true,windowId:${JSON.stringify(extension.startPage.windowId)}});
    return{
      createdCount:created.length,
      allCreatedInactive:created.every(item=>item.active===false),
      firstMatchesPaused:firstId===${JSON.stringify(pausedTabId)},
      firstRemovedBeforeSecondCreated:Number.isSafeInteger(firstRemovedAt)&&Number.isSafeInteger(secondCreatedAt)&&firstRemovedAt<secondCreatedAt,
      bothRemoved:new Set(removedIds.filter(tabId=>createdIds.includes(tabId))).size===2,
      stillPresentCount:stillPresent.length,
      ownedActivationCount:proof.state.activated.filter(tabId=>createdIds.includes(tabId)).length,
      originalOnlyActive:active.length===1&&active[0].id===${JSON.stringify(extension.startPage.tabId)},
      sourceUpdateCount:proof.state.sourceUpdates.length
    };
  })()`, { awaitPromise: true });
}

async function startFullEvidenceBatch(extension, panel, rawUrlA, rawUrlB) {
  await extension.waitForValue(
    panel,
    `document.querySelector('[data-screen]')?.dataset.screen`,
    value => value === 'initial',
    { timeoutMs: 30_000, intervalMs: 50 },
  );
  await extension.click(panel, 'button[data-intent="OPEN_BATCH_FORM"]');
  await extension.waitForValue(panel, `Boolean(document.querySelector('#batch-audit-form'))`, Boolean, {
    timeoutMs: 10_000,
    intervalMs: 25,
  });
  const modes = await extension.evaluate(panel, `(()=>{
    const inputs=[...document.querySelectorAll('input[name="capture-mode"]')];
    const full=inputs.find(input=>input.value==='full-evidence')??null;
    return{
      values:inputs.map(input=>input.value).sort(),
      fullAvailable:Boolean(full)&&full.disabled===false
    };
  })()`);
  assert.deepEqual(modes, {
    values: ['element-only', 'full-evidence', 'no-pixels'],
    fullAvailable: true,
  }, 'P5B_BATCH_PIXEL_MODES_UNAVAILABLE');
  await extension.click(panel, 'input[data-capture-mode="full-evidence"]');
  const entry = await extension.evaluate(panel, `(()=>{
    const textarea=document.querySelector('#audit-urls');
    textarea.value=${JSON.stringify(`${rawUrlA}\n${rawUrlB}`)};
    textarea.dispatchEvent(new Event('input',{bubbles:true}));
    return{
      selected:document.querySelector('input[name="capture-mode"]:checked')?.value??null,
      lineCount:textarea.value.split('\\n').length,
      submitDisabled:document.querySelector('[data-action="start-batch-audit"]')?.disabled??null
    };
  })()`);
  assert.deepEqual(entry, {
    selected: 'full-evidence',
    lineCount: 2,
    submitDisabled: false,
  }, 'P5B_BATCH_FULL_EVIDENCE_SELECTION_FAILED');
  await extension.click(panel, '[data-action="start-batch-audit"]');
}

function safePauseExpression() {
  return `(()=>{
    const root=document.querySelector('[data-screen="running"][data-session-status="privacy-paused"]');
    if(!root)return{
      screen:document.querySelector('[data-screen]')?.dataset.screen??null,
      sessionStatus:document.querySelector('[data-screen]')?.dataset.sessionStatus??null,
      fieldError:document.querySelector('.field-error')?.textContent??null,
      status:document.querySelector('[role="status"]')?.textContent??null
    };
    return{
      screen:root.dataset.screen,
      sessionStatus:root.dataset.sessionStatus,
      pageNumber:Number(root.dataset.pageNumber),
      total:Number(root.dataset.total),
      categories:[...root.querySelectorAll('.privacy-signals li')].map(item=>item.textContent),
      confirm:root.querySelector('[data-action="confirm-pixel-capture"]')?.textContent??null,
      cancel:root.querySelector('button[data-intent="CANCEL_AUDIT"]')?.textContent??null
    };
  })()`;
}

async function waitForBatchPrivacyPause(extension, panel, pageNumber = 1) {
  try {
    const observed = await extension.waitForValue(panel, safePauseExpression(), value =>
      ['unavailable', 'result'].includes(value?.screen) ||
      value?.screen === 'initial' && typeof value.fieldError === 'string' && value.fieldError.length > 0 ||
      value?.screen === 'running' && value?.sessionStatus === 'privacy-paused' && value.pageNumber === pageNumber, {
        timeoutMs: pageNumber === 1 ? 30_000 : 90_000,
        intervalMs: 50,
      });
    const valid = observed?.screen === 'running' && observed?.sessionStatus === 'privacy-paused' &&
      observed.pageNumber === pageNumber && observed.total === 2 &&
      observed.categories?.includes('Campo de senha') &&
      observed.categories?.includes('Conteúdo marcado como privado') &&
      /Continuar e capturar/u.test(observed.confirm ?? '') &&
      /Cancelar auditoria/u.test(observed.cancel ?? '');
    if (!valid) throw new Error(`P5B_BATCH_START_REJECTED:${JSON.stringify(observed)}`);
    return observed;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('P5B_BATCH_START_REJECTED:')) throw error;
    const safe = await extension.evaluate(panel, `(()=>({
      screen:document.querySelector('[data-screen]')?.dataset.screen??null,
      sessionStatus:document.querySelector('[data-screen]')?.dataset.sessionStatus??null,
      pageNumber:document.querySelector('[data-page-number]')?.getAttribute('data-page-number')??null,
      total:document.querySelector('[data-total]')?.getAttribute('data-total')??null,
      selected:document.querySelector('input[name="capture-mode"]:checked')?.value??null,
      categories:[...document.querySelectorAll('.privacy-signals li')].map(item=>item.textContent),
      fieldError:document.querySelector('.field-error')?.textContent??null,
      status:document.querySelector('[role="status"]')?.textContent??null
    }))()`);
    throw new Error(`P5B_BATCH_PRIVACY_PAUSE_MISSING:${JSON.stringify(safe)}`, { cause: error });
  }
}

async function readPausedPersistence(extension, pageNumber = 1) {
  return extension.evaluate(extension.harnessPage, `(async()=>{
    const stored=await chrome.storage.session.get(null);
    const active=stored['audita:active-audit-job:v1']??null;
    const auditId=typeof active?.auditId==='string'?active.auditId:null;
    const pageId=${JSON.stringify(`page-${pageNumber}`)};
    const owners=Object.entries(stored).filter(([key,value])=>
      key.startsWith('audita:owned-tab:v2:')&&typeof value?.auditId==='string'&&
      auditId!==null&&value.auditId===auditId+':'+pageId).map(([,value])=>({
        tabId:value.tabId,state:value.state,cleanupMode:value.cleanupMode,activeAuditMatch:true
      }));
    const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
    const [parentReport,childReport]=auditId===null?[null,null]:await Promise.all([
      store.getReportRevision(auditId),store.getReportRevision(auditId+':'+pageId)
    ]);
    const progressStore=(await import(chrome.runtime.getURL('/src/background/batch-progress-store.js')))
      .createBatchProgressStoreV1({indexedDB});
    const progress=auditId===null?null:await progressStore.readCompleted({auditId});
    const records=await new Promise(resolve=>{
      const opening=indexedDB.open('audita-mt');
      opening.onerror=()=>resolve([]);
      opening.onsuccess=()=>{
        const database=opening.result;
        let transaction;
        try{transaction=database.transaction('audits','readonly');}catch{database.close();resolve([]);return;}
        const request=transaction.objectStore('audits').getAll();
        request.onerror=()=>{database.close();resolve([]);};
        request.onsuccess=()=>{const values=request.result;database.close();resolve(values);};
      };
    });
    const sessionText=JSON.stringify(stored);
    const durableText=JSON.stringify(records);
    return{
      auditId,
      active:active?{state:active.state,mode:active.mode}:null,
      owners,
      parentReportPresent:Boolean(parentReport),
      childReportPresent:Boolean(childReport),
      completedProgressPageIds:(progress?.pages??[]).map(page=>page.pageId),
      sessionRasterCount:(sessionText.match(/data:image\\/(?:png|jpeg|webp);base64,/giu)||[]).length,
      durableRasterCount:(durableText.match(/data:image\\/(?:png|jpeg|webp);base64,/giu)||[]).length
    };
  })()`, { awaitPromise: true });
}

async function assertAndArmPrivateOwnerContinuity(extension, paused, pageNumber = 1) {
  const result = await extension.evaluate(extension.harnessPage, `(()=>{
    try{globalThis.__auditaBatchPixelOwnerProofV1?.dispose?.();}catch{}
    const auditId=${JSON.stringify(paused.auditId)};
    const pageId=${JSON.stringify(`page-${pageNumber}`)};
    const expectedTabId=${JSON.stringify(paused.owners[0].tabId)};
    return chrome.storage.session.get(null).then(stored=>{
      const matches=Object.entries(stored).filter(([key,value])=>
        key.startsWith('audita:owned-tab:v2:')&&value?.auditId===auditId+':'+pageId&&value?.tabId===expectedTabId);
      if(matches.length!==1)return{armed:false,initialState:null,sameTab:false};
      const [privateKey,record]=matches[0];
      const states=[{state:record.state,sameTab:record.tabId===expectedTabId}];
      const onChanged=(changes,areaName)=>{
        if(areaName!=='session'||!Object.hasOwn(changes,privateKey))return;
        const value=changes[privateKey]?.newValue;
        states.push({state:typeof value?.state==='string'?value.state:'absent',sameTab:value?.tabId===expectedTabId});
      };
      chrome.storage.onChanged.addListener(onChanged);
      Object.defineProperty(globalThis,'__auditaBatchPixelOwnerProofV1',{
        value:{privateKey,expectedTabId,states,dispose(){chrome.storage.onChanged.removeListener(onChanged);}},
        configurable:true,enumerable:false,writable:false
      });
      return{armed:true,initialState:record.state,sameTab:record.tabId===expectedTabId};
    });
  })()`, { awaitPromise: true });
  assert.deepEqual(result, {
    armed: true,
    initialState: 'retained-for-consent',
    sameTab: true,
  }, 'P5B_PRIVATE_OWNER_CONTINUITY_UNAVAILABLE');
}

async function readPrivateOwnerContinuity(extension) {
  return extension.evaluate(extension.harnessPage, `(async()=>{
    const proof=globalThis.__auditaBatchPixelOwnerProofV1;
    if(!proof)return null;
    const stored=await chrome.storage.session.get(proof.privateKey);
    const current=stored[proof.privateKey]??null;
    return{
      currentPresent:current!==null,
      currentState:current?.state??null,
      currentSameTab:current===null?null:current.tabId===proof.expectedTabId,
      states:proof.states.map(item=>({state:item.state,sameTab:item.sameTab}))
    };
  })()`, { awaitPromise: true });
}

async function stopServiceWorker(extension) {
  const worker = await waitForServiceWorker(extension);
  assert.equal(await extension.evaluate(worker, `(()=>{
    globalThis.__auditaBatchPixelRestartProof='old-worker';
    return globalThis.__auditaBatchPixelRestartProof;
  })()`), 'old-worker');
  const expectedUrl = `chrome-extension://${extension.extensionId}/src/background/service-worker.js`;
  await extension.command(extension.harnessPage, 'ServiceWorker.disable');
  const runningEvent = extension.harnessPage.waitForEvent('ServiceWorker.workerVersionUpdated', value =>
    Array.isArray(value?.versions) && value.versions.some(version =>
      version?.scriptURL === expectedUrl && version?.runningStatus === 'running'), { timeoutMs: 10_000 });
  await extension.command(extension.harnessPage, 'ServiceWorker.enable');
  const running = await runningEvent;
  const versions = running.versions.filter(version =>
    version?.scriptURL === expectedUrl && version?.runningStatus === 'running');
  assert.equal(versions.length, 1, 'P5B_WORKER_RESTART_PRECONDITION_FAILED');
  const versionId = versions[0].versionId;
  const stoppedEvent = extension.harnessPage.waitForEvent('ServiceWorker.workerVersionUpdated', value =>
    Array.isArray(value?.versions) && value.versions.some(version =>
      version?.versionId === versionId && version?.runningStatus === 'stopped'), { timeoutMs: 10_000 });
  await extension.command(extension.harnessPage, 'ServiceWorker.stopWorker', { versionId });
  await stoppedEvent;
}

async function proveReplacementServiceWorker(extension) {
  const replacement = await waitForServiceWorker(extension, { timeoutMs: 20_000, intervalMs: 50 });
  assert.equal(await extension.evaluate(
    replacement,
    `typeof globalThis.__auditaBatchPixelRestartProof==='undefined'`,
  ), true, 'P5B_WORKER_VOLATILE_REALM_WAS_REUSED');
  return replacement;
}

async function confirmOnce(extension, panel) {
  // Confirm and inspect the synchronous one-shot guard in the same browser task.
  // A small second page may resume before a separate CDP poll sees this transient UI.
  const pending = await extension.evaluate(panel, `(()=>{
    const initial=document.querySelector('[data-action="confirm-pixel-capture"]');
    if(!initial||initial.disabled)return null;
    initial.click();
    const button=document.querySelector('[data-action="confirm-pixel-capture"]');
    if(!button)return null;
    const state={
      label:button.textContent,
      ariaDisabled:button.getAttribute('aria-disabled'),
      count:document.querySelectorAll('[data-action="confirm-pixel-capture"]').length
    };
    button.click();
    return {...state,replayDisabled:button.getAttribute('aria-disabled')};
  })()`, { userGesture: true });
  assert.deepEqual(pending, {
    label: 'Confirmação enviada',
    ariaDisabled: 'true',
    count: 1,
    replayDisabled: 'true',
  }, 'P5B_CONFIRMATION_NOT_ONE_SHOT');
}

async function readSafeBatchRuntimeState(extension, expectedAuditId) {
  return extension.evaluate(extension.harnessPage, `(async()=>{
    const expectedAuditId=${JSON.stringify(expectedAuditId)};
    const stored=await chrome.storage.session.get(null);
    const active=stored['audita:active-audit-job:v1']??null;
    const queues=[];const owners=[];const sessions=[];const pixels=[];
    for(const [key,value] of Object.entries(stored)){
      if(key.startsWith('audita:raw-navigation-queue:v1:'))queues.push({
        nextIndex:Number.isSafeInteger(value?.nextIndex)?value.nextIndex:null,
        statuses:Array.isArray(value?.entries)?value.entries.map(entry=>entry?.status??null):[]
      });
      else if(key.startsWith('audita:owned-tab:v2:'))owners.push({
        state:value?.state??null,cleanupMode:value?.cleanupMode??null,
        expectedAudit:Boolean(typeof value?.auditId==='string'&&value.auditId.startsWith(expectedAuditId+':page-'))
      });
      else if(key.startsWith('audita:audit-session-capability:v1:'))sessions.push({
        mode:value?.mode??null,state:value?.state??null,binding:value?.targetBinding?.kind??null,
        activePage:Boolean(value?.targetBinding?.activePageId),activeOwner:Boolean(value?.targetBinding?.activeOwnershipId)
      });
      else if(key.startsWith('audita:pixel-capture:v1:'))pixels.push({
        state:value?.suspension?.state??null,phase:value?.suspension?.resumePhase??null,
        consentState:value?.consent?.state??null,page:Boolean(value?.suspension?.source?.pageId)
      });
    }
    let progress=null;
    try{
      const module=await import(chrome.runtime.getURL('/src/background/batch-progress-store.js'));
      const storedProgress=await module.createBatchProgressStoreV1({indexedDB}).readCompleted({auditId:expectedAuditId});
      progress=storedProgress?{revision:storedProgress.revision,pages:storedProgress.pages.length}:null;
    }catch{progress={unavailable:true};}
    const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
    const [latest,report]=await Promise.all([store.getLatest(),store.getReportRevision(expectedAuditId)]);
    const proof=globalThis.__auditaBatchPixelTabsProofV1?.state??null;
    return{
      active:active?{mode:active.mode??null,state:active.state??null,commitState:active.commitState??null}:null,
      queues,owners,sessions,pixels,progress,
      latest:latest?.auditId===expectedAuditId?{status:latest.status??null,revision:latest.modelRevision??null}:null,
      report:report?{revision:report.modelRevision??null,status:report.model?.session?.status??null}:null,
      tabs:proof?{created:proof.created.length,events:proof.events.map(item=>item.kind)}:null
    };
  })()`, { awaitPromise: true });
}

async function waitForBatchResult(extension, panel, expectedAuditId) {
  let terminal;
  try {
    terminal = await extension.waitForValue(panel, `(()=>({
      screen:document.querySelector('[data-screen]')?.dataset.screen??null,
      auditId:document.querySelector('[data-screen="result"]')?.dataset.auditId??null,
      status:document.querySelector('[role="status"]')?.textContent??null
    }))()`, value => ['result', 'initial', 'unavailable'].includes(value?.screen), {
      timeoutMs: 180_000,
      intervalMs: 50,
    });
  } catch (error) {
    const panelState = await extension.evaluate(panel, `(()=>({
      screen:document.querySelector('[data-screen]')?.dataset.screen??null,
      sessionStatus:document.querySelector('[data-screen]')?.dataset.sessionStatus??null,
      pageNumber:document.querySelector('[data-page-number]')?.getAttribute('data-page-number')??null,
      total:document.querySelector('[data-total]')?.getAttribute('data-total')??null,
      progress:document.querySelector('progress[data-audit-progress]')?.getAttribute('value')??null
    }))()`);
    const runtimeState = await readSafeBatchRuntimeState(extension, expectedAuditId);
    throw new Error(`P5B_BATCH_RESULT_TIMEOUT:${JSON.stringify({panelState,runtimeState})}`, { cause: error });
  }
  if (terminal.screen !== 'result') {
    const runtimeState = await readSafeBatchRuntimeState(extension, expectedAuditId);
    assert.equal(terminal.screen, 'result',
      `P5B_BATCH_TERMINAL_${terminal.screen ?? 'missing'}:${JSON.stringify({terminal,runtimeState})}`);
  }
  assert.match(terminal.auditId ?? '', /^[A-Za-z0-9._:-]{1,160}$/u, 'P5B_BATCH_AUDIT_ID_MISSING');
  return terminal.auditId;
}

async function readConsolidatedModel(extension, auditId) {
  return extension.evaluate(extension.harnessPage, `(async()=>{
    const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
    const [revision,latest,stored]=await Promise.all([
      store.getReportRevision(${JSON.stringify(auditId)}),
      store.getLatest(),
      chrome.storage.session.get(null)
    ]);
    const model=revision?.model??null;
    const pageIds=Array.isArray(model?.pages)?model.pages.map(page=>page.pageId):[];
    const occurrenceCounts=Object.fromEntries(pageIds.map(pageId=>[
      pageId,(model?.occurrences??[]).filter(item=>item?.pageId===pageId).length
    ]));
    const evidenceCounts=Object.fromEntries(pageIds.map(pageId=>[pageId,{
      fullPage:(model?.evidence??[]).filter(item=>item?.pageId===pageId&&item?.kind==='full-page'&&
        /^data:image\\/png;base64,/u.test(item.dataUrl??'')).length,
      elements:(model?.evidence??[]).filter(item=>item?.pageId===pageId&&item?.kind==='element'&&
        /^data:image\\/png;base64,/u.test(item.dataUrl??'')).length
    }]));
    const text=JSON.stringify(model??null);
    const sessionText=JSON.stringify(stored);
    const forbidden=${JSON.stringify([queryMarkerA, queryMarkerB, fragmentMarkerA, fragmentMarkerB, ...privateFieldNames])};
    const owners=Object.entries(stored).filter(([key,value])=>
      key.startsWith('audita:owned-tab:v2:')&&typeof value?.auditId==='string'&&value.auditId.startsWith(${JSON.stringify(`${auditId}:page-`)}));
    return{
      revision:revision?.modelRevision??null,
      latest:latest?.auditId===${JSON.stringify(auditId)}?{status:latest.status,modelRevision:latest.modelRevision}:null,
      sessionStatus:model?.session?.status??null,
      requestedScope:model?.requestedScope?.mode??null,
      pages:(model?.pages??[]).map(page=>({pageId:page.pageId,attempted:page.attempted,status:page.status})),
      occurrenceCounts,
      evidenceCounts,
      forbiddenModel:forbidden.filter(value=>text.includes(value)),
      activeParent:stored['audita:active-audit-job:v1']?.auditId===${JSON.stringify(auditId)},
      nonRemovedOwnerCount:owners.filter(([,value])=>value?.state!=='removed').length,
      sessionRasterCount:(sessionText.match(/data:image\\/(?:png|jpeg|webp);base64,/giu)||[]).length
    };
  })()`, { awaitPromise: true });
}

async function openAndProveConsolidatedReport(extension, panel, auditId, model) {
  await extension.click(panel, 'button[data-intent="OPEN_REPORT"]');
  const report = await extension.waitForReport({ auditId });
  const proof = await extension.waitForValue(report, `(()=>{
    const text=document.documentElement?.outerHTML??'';
    const body=document.body?.textContent??'';
    const checklistCounts={};
    for(const row of document.querySelectorAll('[data-checklist-question]')){
      const pageId=JSON.parse(row.dataset.checklistQuestion)[0];
      const paragraph=[...row.querySelectorAll('p')].find(p=>p.textContent.startsWith('Registros originais: '));
      const ids=paragraph.textContent.slice('Registros originais: '.length).split('. Dados e evidências integrais')[0].split(', ').filter(Boolean);
      checklistCounts[pageId]=(checklistCounts[pageId]??0)+ids.length;
    }
    const forbidden=${JSON.stringify([queryMarkerA, queryMarkerB, fragmentMarkerA, fragmentMarkerB, ...privateFieldNames])};
    return{
      ready:Boolean(document.querySelector('[data-report-navigation]')&&document.querySelector('[data-report-export]')),
      status:document.querySelector('#review-status')?.textContent??null,
      page1Issues:document.querySelectorAll('[data-report-issue][data-page="page-1"]').length,
      page2Issues:document.querySelectorAll('[data-report-issue][data-page="page-2"]').length,
      page1Occurrences:document.querySelectorAll('[data-report-issue][data-page="page-1"] [data-report-occurrence-technical]').length,
      page2Occurrences:document.querySelectorAll('[data-report-issue][data-page="page-2"] [data-report-occurrence-technical]').length,
      checklistCounts,
      evidenceImages:document.querySelectorAll('[data-evidence-preview-image],img.evidence-media').length,
      wcag:/WCAG 2\.2:/u.test(body),
      abnt:/ABNT NBR 17225:/u.test(body),
      forbidden:forbidden.filter(value=>text.includes(value))
    };
  })()`, value => typeof value?.status === 'string' && value.status !== 'Carregando a auditoria.', {
    timeoutMs: 30_000,
    intervalMs: 50,
  });
  assert.equal(proof.ready, true, `P5B_REPORT_NOT_READY_${proof.status ?? 'missing'}`);
  assert.equal(proof.page1Issues > 0 && proof.page2Issues > 0, true, 'P5B_REPORT_PAGE_SECTIONS_MISSING');
  assert.equal(proof.page1Occurrences+(proof.checklistCounts['page-1']??0), model.occurrenceCounts['page-1'], 'P5B_REPORT_PAGE_1_TRUNCATED');
  assert.equal(proof.page2Occurrences+(proof.checklistCounts['page-2']??0), model.occurrenceCounts['page-2'], 'P5B_REPORT_PAGE_2_TRUNCATED');
  assert.equal(proof.evidenceImages >= 4, true, 'P5B_REPORT_RASTER_EVIDENCE_MISSING');
  assert.equal(proof.wcag, true, 'P5B_REPORT_WCAG_REFERENCE_MISSING');
  assert.equal(proof.abnt, true, 'P5B_REPORT_ABNT_REFERENCE_MISSING');
  assert.deepEqual(proof.forbidden, [], 'P5B_REPORT_PRIVATE_DATA_LEAK');
  await extension.click(report, 'button[data-report-export]');
  const downloads = await extension.waitForFourDownloads({ auditId, timeoutMs: 90_000, intervalMs: 50 });
  assert.deepEqual(downloads.map(row => row.format), ['html', 'pdf', 'csv', 'json'],
    'P5B_REPORT_EXPORT_FORMATS_MISSING');
  assert.equal(downloads.every(row => row.state === 'complete' && row.byteLength > 0 &&
    /^[a-f0-9]{64}$/u.test(row.sha256)), true, 'P5B_REPORT_EXPORT_INCOMPLETE');
}

test('full-evidence batch resumes after restart, separately confirms both sensitive hidden pages, and exports their report', {
  timeout: 360_000,
}, async t => {
  assert.ok(chromeBinary, 'AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório para o E2E real de lote com pixels.');
  await access(chromeBinary, fsConstants.X_OK);
  const fixture = await startFixtureServer(t, new Map([
    ['/host', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      body: hostDocument(),
    }],
    ['/sensitive', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      body: sensitiveDocument(),
    }],
    ['/sensitive-b', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      body: secondSensitiveDocument(),
    }],
    ['/pixel.gif', {
      status: 200,
      headers: { 'content-type': 'image/gif', 'cache-control': 'no-store' },
      body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'),
    }],
  ]));
  const rawUrlA = `${fixture.origin}/sensitive?private_a=${queryMarkerA}#${fragmentMarkerA}`;
  const rawUrlB = `${fixture.origin}/sensitive-b?private_b=${queryMarkerB}#${fragmentMarkerB}`;
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(workspaceRoot),
    startUrl: `${fixture.origin}/host`,
    downloadMode: 'profile',
    viewport: { width: 1280, height: 900 },
    chromeBinary,
    expectedMajor: 152,
  });
  assert.equal(extension.chromeProduct, CANONICAL_CHROME_PRODUCT);
  const panel = await extension.openSidePanelFromAction();
  await extension.waitForValue(panel,
    `document.querySelector('[data-screen]')?.dataset.screen`, value => value === 'initial');
  const originalIdentity = await armOriginalPageProof(extension);
  await armTabTimeline(extension);

  await startFullEvidenceBatch(extension, panel, rawUrlA, rawUrlB);
  await waitForBatchPrivacyPause(extension, panel);
  const paused = await readPausedPersistence(extension);
  assert.match(paused.auditId ?? '', /^[A-Za-z0-9._:-]{1,160}$/u, 'P5B_PAUSED_AUDIT_ID_MISSING');
  assert.deepEqual(paused.active, { state: 'privacy-paused', mode: 'batch' }, 'P5B_BATCH_NOT_DURABLY_PAUSED');
  assert.equal(paused.owners.length, 1, 'P5B_PAUSED_OWNER_COUNT_INVALID');
  assert.deepEqual(paused.owners[0], {
    tabId: paused.owners[0].tabId,
    state: 'retained-for-consent',
    cleanupMode: 'always',
    activeAuditMatch: true,
  }, 'P5B_PAUSED_OWNER_STATE_INVALID');
  assert.equal(Number.isSafeInteger(paused.owners[0].tabId), true, 'P5B_PAUSED_TAB_ID_INVALID');
  assert.equal(paused.parentReportPresent, false, 'P5B_PARENT_REPORT_WRITTEN_BEFORE_CONSENT');
  assert.equal(paused.childReportPresent, false, 'P5B_CHILD_REPORT_WRITTEN_BEFORE_CONSENT');
  assert.equal(paused.sessionRasterCount, 0, 'P5B_SESSION_RASTER_WRITTEN_BEFORE_CONSENT');
  assert.equal(paused.durableRasterCount, 0, 'P5B_DURABLE_RASTER_WRITTEN_BEFORE_CONSENT');
  assert.deepEqual(paused.completedProgressPageIds, [], 'P5B_PAGE_COMPLETED_BEFORE_CONSENT');
  await assertAndArmPrivateOwnerContinuity(extension, paused);
  assert.deepEqual(await readPausedTabTimeline(extension, paused.owners[0].tabId), {
    createdCount: 1,
    firstMatchesPaused: true,
    firstInactive: true,
    ownedActivations: 0,
    originalOnlyActive: true,
    sourceUpdateCount: 0,
  }, 'P5B_FIRST_PAGE_WAS_VISIBLE_OR_REPLACED');
  await assertOriginalPageIntact(extension, originalIdentity);

  await stopServiceWorker(extension);
  await proveReplacementServiceWorker(extension);
  await waitForBatchPrivacyPause(extension, panel);
  const rehydrated = await readPausedPersistence(extension);
  assert.equal(rehydrated.auditId, paused.auditId, 'P5B_BATCH_ID_CHANGED_AFTER_RESTART');
  assert.deepEqual(rehydrated.active, paused.active, 'P5B_BATCH_PAUSE_NOT_REHYDRATED');
  assert.equal(rehydrated.owners.length, 1, 'P5B_OWNER_MISSING_AFTER_RESTART');
  assert.equal(rehydrated.owners[0].tabId, paused.owners[0].tabId, 'P5B_TAB_CHANGED_AFTER_RESTART');
  assert.equal(rehydrated.parentReportPresent, false, 'P5B_REPORT_APPEARED_DURING_RESTART');
  assert.equal(rehydrated.sessionRasterCount, 0, 'P5B_RASTER_APPEARED_DURING_RESTART');
  assert.equal(rehydrated.durableRasterCount, 0, 'P5B_DURABLE_RASTER_APPEARED_DURING_RESTART');
  const continuityAfterRestart = await readPrivateOwnerContinuity(extension);
  assert.deepEqual({
    currentPresent: continuityAfterRestart?.currentPresent,
    currentState: continuityAfterRestart?.currentState,
    currentSameTab: continuityAfterRestart?.currentSameTab,
  }, {
    currentPresent: true,
    currentState: 'retained-for-consent',
    currentSameTab: true,
  }, 'P5B_PRIVATE_OWNER_CHANGED_AFTER_RESTART');

  await confirmOnce(extension, panel);
  await waitForBatchPrivacyPause(extension, panel, 2);
  const secondPause = await readPausedPersistence(extension, 2);
  assert.equal(secondPause.auditId, paused.auditId, 'P5B_BATCH_ID_CHANGED_AT_SECOND_CONSENT');
  assert.deepEqual(secondPause.active, paused.active, 'P5B_SECOND_PAGE_NOT_DURABLY_PAUSED');
  assert.equal(secondPause.owners.length, 1, 'P5B_SECOND_PAUSED_OWNER_COUNT_INVALID');
  assert.equal(secondPause.owners[0].state, 'retained-for-consent', 'P5B_SECOND_OWNER_DID_NOT_WAIT_FOR_CONSENT');
  assert.notEqual(secondPause.owners[0].tabId, paused.owners[0].tabId, 'P5B_SECOND_PAGE_REUSED_FIRST_TAB');
  assert.equal(secondPause.parentReportPresent, false, 'P5B_PARENT_REPORT_BEFORE_SECOND_CONSENT');
  assert.equal(secondPause.childReportPresent, false, 'P5B_SECOND_CHILD_REPORT_BEFORE_CONSENT');
  assert.equal(secondPause.sessionRasterCount, 0, 'P5B_RASTER_RETAINED_IN_SESSION_WHILE_SECOND_PAGE_PAUSED');
  assert.equal(secondPause.durableRasterCount, 0, 'P5B_REPORT_RASTER_WRITTEN_BEFORE_SECOND_CONSENT');
  assert.deepEqual(secondPause.completedProgressPageIds, ['page-1'], 'P5B_SECOND_PAUSE_LOST_FIRST_PAGE_PROGRESS');
  const ownerContinuity = await readPrivateOwnerContinuity(extension);
  assert.equal(ownerContinuity?.states.some(item => item.state === 'observing' && item.sameTab === true), true,
    'P5B_SAME_PRIVATE_OWNER_DID_NOT_RESUME');
  assert.equal(ownerContinuity?.states.filter(item => item.state === 'observing').length, 1,
    'P5B_CONFIRMATION_WAS_REPLAYED');
  assert.equal(ownerContinuity?.states.some(item => item.state === 'removed' && item.sameTab === true), true,
    'P5B_FIRST_PRIVATE_OWNER_WAS_NOT_CLEANED');
  await assertOriginalPageIntact(extension, originalIdentity);
  await assertAndArmPrivateOwnerContinuity(extension, secondPause, 2);
  await confirmOnce(extension, panel);
  const auditId = await waitForBatchResult(extension, panel, paused.auditId);
  assert.equal(auditId, paused.auditId, 'P5B_BATCH_ID_CHANGED_AFTER_CONFIRMATION');
  const secondOwnerContinuity = await readPrivateOwnerContinuity(extension);
  assert.equal(secondOwnerContinuity?.states.some(item => item.state === 'observing' && item.sameTab === true), true,
    'P5B_SECOND_PRIVATE_OWNER_DID_NOT_RESUME');
  assert.equal(secondOwnerContinuity?.states.filter(item => item.state === 'observing').length, 1,
    'P5B_SECOND_CONFIRMATION_WAS_REPLAYED');
  assert.equal(secondOwnerContinuity?.states.some(item => item.state === 'removed' && item.sameTab === true), true,
    'P5B_SECOND_PRIVATE_OWNER_WAS_NOT_CLEANED');

  assert.deepEqual(await readFinalTabTimeline(extension, paused.owners[0].tabId), {
    createdCount: 2,
    allCreatedInactive: true,
    firstMatchesPaused: true,
    firstRemovedBeforeSecondCreated: true,
    bothRemoved: true,
    stillPresentCount: 0,
    ownedActivationCount: 0,
    originalOnlyActive: true,
    sourceUpdateCount: 0,
  }, 'P5B_HIDDEN_SEQUENTIAL_TAB_CONTRACT_BROKEN');
  await assertOriginalPageIntact(extension, originalIdentity);

  // Publication precedes final checkpoint/attempt cleanup. Observe completion,
  // not merely the first result frame; a permanently retained job still fails.
  await extension.waitForValue(extension.harnessPage, `(async()=>{
    const stored=await chrome.storage.session.get('audita:active-audit-job:v1');
    return stored['audita:active-audit-job:v1']?.auditId!==${JSON.stringify(auditId)};
  })()`, value => value === true, { timeoutMs: 10_000, intervalMs: 50 });
  const model = await readConsolidatedModel(extension, auditId);
  assert.equal(model.revision, 1, 'P5B_CONSOLIDATED_REPORT_REVISION_MISSING');
  assert.deepEqual(model.latest, { status: model.sessionStatus, modelRevision: 1 }, 'P5B_LATEST_REPORT_POINTER_INVALID');
  assert.equal(['complete', 'partial'].includes(model.sessionStatus), true, 'P5B_BATCH_REPORT_STATUS_INVALID');
  assert.equal(model.requestedScope, 'batch', 'P5B_REPORT_SCOPE_INVALID');
  assert.deepEqual(model.pages.map(page => ({ pageId: page.pageId, attempted: page.attempted })), [
    { pageId: 'page-1', attempted: true },
    { pageId: 'page-2', attempted: true },
  ], 'P5B_REPORT_PAGE_ORDER_INVALID');
  assert.equal(model.occurrenceCounts['page-1'] > 0, true, 'P5B_PAGE_1_OCCURRENCES_MISSING');
  assert.equal(model.occurrenceCounts['page-2'] > 0, true, 'P5B_PAGE_2_OCCURRENCES_MISSING');
  assert.equal(model.evidenceCounts['page-1']?.fullPage >= 1, true, 'P5B_PAGE_1_FULL_PAGE_EVIDENCE_MISSING');
  assert.equal(model.evidenceCounts['page-2']?.fullPage >= 1, true, 'P5B_PAGE_2_FULL_PAGE_EVIDENCE_MISSING');
  assert.equal(model.evidenceCounts['page-1']?.elements >= 1, true, 'P5B_PAGE_1_ELEMENT_EVIDENCE_MISSING');
  assert.equal(model.evidenceCounts['page-2']?.elements >= 1, true, 'P5B_PAGE_2_ELEMENT_EVIDENCE_MISSING');
  assert.deepEqual(model.forbiddenModel, [], 'P5B_CONSOLIDATED_MODEL_PRIVATE_DATA_LEAK');
  assert.equal(model.activeParent, false, 'P5B_BATCH_ACTIVE_JOB_RETAINED_AFTER_TERMINAL');
  assert.equal(model.nonRemovedOwnerCount, 0, 'P5B_BATCH_OWNER_NOT_CLEANED');
  assert.equal(model.sessionRasterCount, 0, 'P5B_RASTER_RETAINED_IN_SESSION_STORAGE');

  await openAndProveConsolidatedReport(extension, panel, auditId, model);
  await assertOriginalPageIntact(extension, originalIdentity);
  t.diagnostic('Chrome=152; source=batch; mode=full-evidence; sensitive-pages=2; pre-consent-report-raster=0; worker-restart=rehydrated; one-shot=confirmed-per-page; audit-tabs=inactive-sequential; original=untouched; report=consolidated; downloads=4; private-diagnostics=0');
});
