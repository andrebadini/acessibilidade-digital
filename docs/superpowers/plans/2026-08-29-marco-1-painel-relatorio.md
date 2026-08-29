# Marco 1 — Painel lateral e relatório visual Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar o percurso local e reproduzível popup → painel lateral → relatório, com autorização opaca, auditoria segura da página aberta, sumário visual completo e exportação acionável sem login ou servidor.

**Architecture:** O service worker é a única autoridade sobre alvo, aba, documento, sessão, porta, relatório e exportação. A UI nunca autoriza IDs Chrome, URL, seletor ou documento. Um coordinator atômico reclama a capability, grava a sessão e o bootstrap do painel antes de iniciar o runner. O runner separa propriedade de aba, checkpoint core e pausa de privacidade. `PanelSummaryV1`, `PanelDetailV1` e `ReportViewV1` são projeções puras de entradas canônicas validadas.

**Tech Stack:** JavaScript ESM, HTML/CSS locais, Chrome Extensions Manifest V3, Side Panel API Chrome 116+, Chrome DevTools Protocol por pipe NUL-delimited, `chrome.storage.session`, IndexedDB, Web Crypto e `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-29-fluxo-visual-painel-lateral-design.md`

## Global invariants

- Chrome mínimo 116; `action.default_popup` é o único lançador do ícone e `side_panel.default_path` é `src/panel/index.html`.
- O produto permanece local, neutro, sem login, servidor, telemetria, identidade estatal, código remoto ou upload de HTML/arquivo.
- `chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})` conclui antes de qualquer listener operacional.
- A UI fornece somente IDs opacos ou IDs canônicos do modelo; URL, `tabId`, `windowId`, `frameId`, `documentId`, seletor e bytes de relatório nunca são autoridade.
- Capabilities têm ao menos 128 bits CSPRNG, não entram em URL, log, diagnóstico, exportação ou nome de arquivo e usam records de shape fechado.
- Abas `attached` nunca são criadas, navegadas, fechadas ou reutilizadas pelo runner. Abas `disposable` só são alteradas após prova de propriedade da sessão.
- `RawNavigationUrlV1` permanece apenas na memória do worker ou em `storage.session` confiável até o consumo; nunca cruza a fronteira do modelo/falha.
- `navigationToken` é exclusivamente interno ao worker. Marco 1 não reconhece mensagens UI de URL/lote; Marco 3 adicionará os envelopes `{url}`/`{urls}` e criará tokens somente depois da validação interna. O token nunca aparece em resposta, evento de porta ou estado de UI.
- Marco 1 aceita somente `no-pixels`. A interface de privacidade já representa pausa, consentimento, aborto e documento trocado sem depender de uma `Promise` viva durante suspensão MV3.
- Cobertura mede execução automática, não nota, conformidade ou certificação. Denominador zero e inventário não verificável são estados indisponíveis.
- `AuditModel V2` não recebe checkpoint, inventário, capability, tab/document IDs, ownership ou binding vivo.
- HTML/PDF são derivados da mesma projeção integral; filtros vivos não removem conteúdo dos bytes exportados.
- Toda string externa entra no DOM via `textContent`; CSP não recebe script inline, `unsafe-eval`, recurso remoto, content script permanente ou `web_accessible_resources`.

## Closed contracts used by every task

```text
TrustedSurfaceV1 =
  { path:'/src/popup/index.html', contextType:'POPUP', allowQuery:false }
| { path:'/src/panel/index.html', contextType:'SIDE_PANEL', allowQuery:false }
| { path:'/src/review/index.html', contextType:'TAB', allowQuery:'auditId-only' }
| { path:'/src/export/index.html', contextType:'TAB', allowQuery:'auditId-only' }

AuditTargetDescriptorV1 =
  { kind:'attached', tabId, windowId, documentId, initialUrlEvidence, initialUrlSessionDigest }
| { kind:'disposable', ownerId, navigationToken, cleanupMode:'always'|'retain-after-observation' }

PrivacyGateDecisionV1 =
  { status:'allowed', consentCapabilityId, documentId, urlSessionDigest }
| { status:'no-pixels', limitationCode:'PIXEL_CAPTURE_OMITTED' }
| { status:'privacy-paused', pauseId }
| { status:'target-changed', code:'PRIVACY_TARGET_CHANGED' }
| { status:'aborted', code:'AUDIT_ABORTED' }

ObservedAuditResultV1 =
  { status:'completed', model, observedTarget, observationState:'observed', ownershipState:'attached'|'retained-for-review'|'removed' }
| { status:'paused', auditId, pauseId, checkpoint, observedTarget }
| { status:'failed', model, observedTarget:null|ObservedTargetV1, observationState:'not-started'|'pre-observation-failure'|'observed', ownershipState:'attached'|'cleanup-pending'|'removed' }

ExecutionCheckpointV1 = {
  version:1, auditId,
  pages:[
    { pageId, attempted:false, startedAt:null, rulesVersion, inventoryVersion, inventoryHash, outcomes:[] }
  | { pageId, attempted:true, startedAt, rulesVersion, inventoryVersion, inventoryHash,
      outcomes:[{ruleId,outcome:'passed'|'failed'|'cantTell'|'inapplicable'|'untested'}] }
  ]
}
```

## File map

| File | Exact responsibility |
|---|---|
| `src/background/target-capabilities.js` | Trusted surface proof, target claim, session issue/transition and one-record invalidation. |
| `src/core/privacy/session-url-digest.js` | Closed session-key record and HMAC-SHA-256 of complete canonical URL. |
| `src/background/owned-tabs.js` | `OwnedDisposableTabV1` CAS transitions and verified cleanup. |
| `src/background/raw-navigation-vault.js` | Cofre canônico one-shot de `RawNavigationUrlV1`; Marco 3 estende este mesmo módulo com fila/HMAC, sem criar segunda autoridade. |
| `src/background/observed-tab-runner.js` | Attached/disposable observation, privacy decision and ownership result. |
| `src/background/execution-checkpoint.js` | Immutable per-page recorder and deterministic batch merge. |
| `src/background/audit-pipeline.js` | Collection/rules/model only; never creates, navigates or removes tabs. |
| `src/core/rules/core-rule-inventory.js` | Resolve and cryptographically verify installed core inventory. |
| `src/panel/panel-summary.js` | Pure coverage/checkKey projection. |
| `src/panel/panel-detail.js` | Pure ten-block occurrence detail projection. |
| `src/background/worker-protocol.js` | Closed runtime/port schemas and byte limits. |
| `src/background/authorized-audit-starter.js` | Atomic claim/session/bootstrap before runner launch. |
| `src/background/panel-port.js` | SIDE_PANEL proof and one-hello port state machine. |
| `src/review/report-view.js` | Independent frozen report projection and safe DOM renderer. |
| `src/background/report-launch.js` | Owned report tab lifecycle and first-document binding. |
| `src/background/export-launch.js` | Owned hidden export-tab lifecycle, source-session binding and first-document proof without bearer in URL. |

---

### Task 1: Trusted surfaces, atomic capability records and HMAC lifecycle

**Files:**

- Create: `src/background/target-capabilities.js`
- Create: `src/core/privacy/session-url-digest.js`
- Modify: `src/background/chrome-adapter.js:89-296`
- Modify: `src/background/service-worker.js:1-193`
- Create: `test/background/target-capabilities.test.js`
- Modify: `test/background/chrome-adapter.test.js`
- Modify: `test/background/service-worker.test.js`
- Create: `test/privacy/session-url-digest.test.js`

**Interfaces:**

- `deriveTrustedExtensionContext({sender,chromeApi,surface})` returns `{issuer,windowId,tabId,contextType,documentUrl}`. It never requires `sender.tab` for POPUP/SIDE_PANEL.
- Surface constants are exported frozen values: `POPUP_SURFACE={path:'/src/popup/index.html',contextType:'POPUP',allowQuery:false}`, `PANEL_SURFACE={path:'/src/panel/index.html',contextType:'SIDE_PANEL',allowQuery:false}`, `REVIEW_SURFACE={path:'/src/review/index.html',contextType:'TAB',allowQuery:'auditId-only'}` and `EXPORT_SURFACE={path:'/src/export/index.html',contextType:'TAB',allowQuery:'auditId-only'}`.
- `CapabilityIssuerV1` is exactly `{type:'extension-document',documentId,path}` or `{type:'worker-event',event:'context-menu',eventNonce}`. `contextType` remains a separately derived proof value and is never persisted inside the issuer.
- Target record is exactly `{version:1,capabilityId,kind,tabId,windowId,documentId,initialUrlEvidence,initialUrlSessionDigest,createdBy,allowedIntent,issuer,issuedAt,expiresAt,state}`.
- Session record is exactly `{version:1,sessionCapabilityId,auditId,windowId,mode,targetBinding,consumers,intents,state,issuedAt,expiresAt}`. `targetBinding` is `{kind:'attached',tabId,documentId,urlSessionDigest}` or `{kind:'disposable',ownerId}`; consumers are exactly `{name:'panel',path:'/src/panel/index.html',contextType:'SIDE_PANEL'}` and `{name:'review',path:'/src/review/index.html',contextType:'TAB'}`. `intents` is the closed map `{panel:{running:['cancel'],result:['open-report'],'view-only':['open-report']},review:{running:[],result:['export'],'view-only':['export']}}`; Marco 2 may add panel `highlight` only after a live binding exists.
- `authority.claimAndIssueAuditSession(args)` performs one serialized read/proof and one `storage.session.set()` containing claimed target + running session; it returns no result until both are persisted.
- `createTargetCapabilityAuthority(...)` returns exactly `prepare`, `claimAndIssueAuditSession`, `claimWorkerEventAndIssueAuditSession`, `authorizeSession`, `transitionAuditSession`, `invalidateCapability`, `invalidateForTab`, `invalidateForWindow` and `rehydrateViewOnly`.
- `authority.invalidateCapability(capabilityId,reason)` changes one record only. Tab/window invalidation scans are reserved for browser lifecycle listeners.
- Worker-event claims require the exact random `eventNonce` retained in the context-menu callback closure.
- HMAC key record is exactly `{version:1,keyBase64Url,createdAt}`. `destroy()` is serialized, terminal for that manager instance and prevents a queued digest from recreating the key.
- `createSessionHmacKeyBytes(randomBytes)` returns one fresh `Uint8Array(32)` or rejects a wrong-length/non-byte CSPRNG result. `createSessionUrlDigest(rawUrl,sessionKey,subtle)` validates the 32-byte key, computes HMAC-SHA-256 over the complete canonical URL and returns `hmac-sha256:<43 unpadded base64url chars>` without storage.
- `createSessionUrlDigestManager({sessionArea,subtle,randomBytes,now})` returns exactly `digest(canonicalUrl)` and `destroy()`. It reuses the two primitives above, owns key persistence/lifecycle and never exports its stored key. `digest` accepts one already canonical HTTP/HTTPS URL string and includes query and fragment; only the 32-byte random key record is stored.

- [ ] **Step 1: Write failing trusted-surface, atomicity and HMAC tests**

```js
test('accepts Node WHATWG chrome-extension URL without origin comparison', async () => {
  const context = await deriveTrustedExtensionContext({sender:panelSenderWithoutTab,chromeApi,surface:PANEL_SURFACE});
  assert.equal(context.contextType,'SIDE_PANEL');
  assert.equal(context.tabId,null);
});

test('rejects scheme host query context and document mismatches', async () => {
  for (const sender of [httpsSender,wrongHostSender,panelQuerySender,panelAsTabSender,unknownDocumentSender]) {
    await assert.rejects(() => deriveTrustedExtensionContext({sender,chromeApi,surface:PANEL_SURFACE}), /CONTEXT_DENIED/u);
  }
});

test('claims target and persists running session atomically', async () => {
  const result = await authority.claimAndIssueAuditSession(validStart);
  assert.equal(result.ok,true);
  assert.equal((await targetRecord(result.capabilityId)).state,'claimed');
  assert.equal((await sessionRecord(result.sessionCapabilityId)).state,'running');
  assert.equal(storageWrites.at(-1).keys.length,2);
});

test('worker event nonce cannot be replayed by another click', async () => {
  const first={...workerClaim,eventNonce:'nonce-12345678901234567890'};
  assert.equal((await authority.claimWorkerEventAndIssueAuditSession(first)).ok,true);
  assert.deepEqual(await authority.claimWorkerEventAndIssueAuditSession(first),{ok:false,code:'CAPABILITY_UNAVAILABLE'});
  assert.deepEqual(await authority.claimWorkerEventAndIssueAuditSession({...workerClaim,eventNonce:'nonce-09876543210987654321'}),{ok:false,code:'CAPABILITY_UNAVAILABLE'});
});

test('destroy wins against an interleaved digest and rejects later use', async () => {
  const pending=manager.digest('https://example.test/?token=private');
  const destroyed=manager.destroy();
  await Promise.allSettled([pending,destroyed]);
  assert.deepEqual(await sessionArea.get('audita:session-hmac-key:v1'),{});
  await assert.rejects(() => manager.digest('https://example.test/'),/HMAC_MANAGER_DESTROYED/u);
});

test('digests the complete canonical URL and never stores its plaintext', async () => {
  const first=await manager.digest('https://example.test/a?token=SEGREDO-NAO-LOGAR#one');
  const changedQuery=await manager.digest('https://example.test/a?token=outro#one');
  const changedFragment=await manager.digest('https://example.test/a?token=SEGREDO-NAO-LOGAR#two');
  assert.notEqual(first,changedQuery);
  assert.notEqual(first,changedFragment);
  assert.doesNotMatch(JSON.stringify(await sessionArea.get(null)),/SEGREDO-NAO-LOGAR/u);
});

test('exports the same stateless HMAC primitives consumed by Marco 3', async () => {
  const key=createSessionHmacKeyBytes(length => new Uint8Array(length).fill(7));
  assert.equal(key.byteLength,32);
  assert.match(await createSessionUrlDigest('https://example.test/?secret=1',key,crypto.subtle),
    /^hmac-sha256:[A-Za-z0-9_-]{43}$/u);
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test test/background/target-capabilities.test.js test/background/chrome-adapter.test.js test/background/service-worker.test.js test/privacy/session-url-digest.test.js`

Expected: FAIL because trusted surfaces, atomic claim/session and terminal HMAC destruction do not exist.

- [ ] **Step 3: Implement the closed authority**

Use this URL proof; do not compare `URL.origin` for the extension scheme:

```js
export const POPUP_SURFACE=Object.freeze({path:'/src/popup/index.html',contextType:'POPUP',allowQuery:false});
export const PANEL_SURFACE=Object.freeze({path:'/src/panel/index.html',contextType:'SIDE_PANEL',allowQuery:false});
export const REVIEW_SURFACE=Object.freeze({path:'/src/review/index.html',contextType:'TAB',allowQuery:'auditId-only'});
export const EXPORT_SURFACE=Object.freeze({path:'/src/export/index.html',contextType:'TAB',allowQuery:'auditId-only'});
const TRUSTED_SURFACES=new Set([POPUP_SURFACE,PANEL_SURFACE,REVIEW_SURFACE,EXPORT_SURFACE]);

export async function deriveTrustedExtensionContext({sender,chromeApi,surface}) {
  if (!TRUSTED_SURFACES.has(surface)) throw new Error('CONTEXT_DENIED');
  if (sender?.id !== chromeApi.runtime.id || typeof sender.documentId !== 'string' || typeof sender.url !== 'string') throw new Error('CONTEXT_DENIED');
  const url=new URL(sender.url);
  const credentialsEmpty=url.username === '' && url.password === '' && url.port === '';
  const auditIds=url.searchParams.getAll('auditId');
  const queryAllowed=surface.allowQuery === true || (surface.allowQuery === 'auditId-only' && [...url.searchParams.keys()].every(key => key === 'auditId') && auditIds.length === 1 && /^[A-Za-z0-9_-]{1,160}$/u.test(auditIds[0]));
  if (url.protocol !== 'chrome-extension:' || url.hostname !== chromeApi.runtime.id || !credentialsEmpty || url.pathname !== surface.path || url.hash !== '' || (!queryAllowed && url.search !== '')) throw new Error('CONTEXT_DENIED');
  const contexts=await chromeApi.runtime.getContexts({documentIds:[sender.documentId]});
  const exact=contexts.filter(value => value.documentId === sender.documentId && value.documentUrl === sender.url && value.contextType === surface.contextType && Number.isInteger(value.windowId));
  if (exact.length !== 1) throw new Error('CONTEXT_DENIED');
  return Object.freeze({issuer:{type:'extension-document',documentId:sender.documentId,path:surface.path},windowId:exact[0].windowId,tabId:Number.isInteger(exact[0].tabId)?exact[0].tabId:null,contextType:exact[0].contextType,documentUrl:exact[0].documentUrl});
}
```

Implement the authority under one promise mutex. `claimAndIssueAuditSession` validates exact record keys, expiry, intent, issuer `(documentId,path)`, separately derived `contextType`, window and fresh document/HMAC proof, generates a 16-byte session ID and writes both records in one call. `authorizeSession` derives the requested consumer surface and compares audit, state, intent, window, path and the separate trusted context type. `transitionAuditSession` permits only `running→result|revoked` and `result|view-only→revoked`.

In the module service worker entrypoint, top-level initialization awaits `setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})`; only its fulfilled branch registers `onMessage`, `onConnect`, tab/window/context-menu listeners. The rejection branch emits one fixed code to the local diagnostic sink and registers no operational listener. Add a service-worker test that holds the access-level promise pending and proves every listener count remains zero, then resolves it and proves registration happens once.

Implement and directly test `createSessionHmacKeyBytes` and `createSessionUrlDigest`; the manager delegates key generation and digest computation to them. The HMAC manager uses one queued `operate(fn)` function and `destroyed` flag. A key record with extra/missing keys, non-safe-integer `createdAt`, padded/wrong-alphabet base64url or decoded length other than 32 is malformed and replaced. `digest()` never stores its input.

- [ ] **Step 4: Run authority security tests**

Run: `node --test test/background/target-capabilities.test.js test/background/chrome-adapter.test.js test/background/service-worker.test.js test/privacy/session-url-digest.test.js`

Expected: PASS for Node/Chrome URL parsing, sender without tab, one-use claim, atomic session, nonce, precise invalidation, suspension and HMAC destruction.

- [ ] **Step 5: Commit the authority boundary**

```bash
git add src/background/target-capabilities.js src/background/chrome-adapter.js src/background/service-worker.js src/core/privacy/session-url-digest.js test/background/target-capabilities.test.js test/background/chrome-adapter.test.js test/background/service-worker.test.js test/privacy/session-url-digest.test.js
git commit -m "feat: authorize extension surfaces atomically"
```

---

### Task 2: Owned-tab runner, suspension-safe privacy and exact checkpoints

**Files:**

- Create: `src/background/owned-tabs.js`
- Create: `src/background/raw-navigation-vault.js`
- Create: `src/background/observed-tab-runner.js`
- Create: `src/background/execution-checkpoint.js`
- Create: `src/background/audit-pipeline.js`
- Create: `src/core/privacy/capture-policy.js`
- Create: `src/core/rules/core-rule-inventory.js`
- Modify: `src/background/run-audit.js:361-751`
- Modify: `src/background/run-batch.js:26-249`
- Modify: `src/background/chrome-adapter.js:238-295`
- Create: `test/background/owned-tabs.test.js`
- Create: `test/background/raw-navigation-vault.test.js`
- Create: `test/background/observed-tab-runner.test.js`
- Create: `test/background/execution-checkpoint.test.js`
- Create: `test/background/audit-pipeline.test.js`
- Create: `test/privacy/capture-policy.test.js`
- Create: `test/core/core-rule-inventory.test.js`
- Modify: `test/background/run-audit.test.js`
- Modify: `test/background/run-batch.test.js`

**Interfaces:**

```text
OwnedDisposableTabV1 = {
  version:1, ownerId, auditId, sessionCapabilityId, tabId, windowId,
  cleanupMode:'always'|'retain-after-observation',
  state:'created'|'observing'|'retained-for-review'|'cleanup-pending'|'removed',
  createdAt, updatedAt
}

CapturePolicyV1 = {
  version:'CapturePolicyV1', mode:'full-evidence'|'element-only'|'no-pixels', includeQuery,
  captureFullPage, captureElements, composeAnnouncementMap
}

RawNavigationRecordV1 = {
  version:1,navigationToken,ownerId,rawUrl,issuedAt,expiresAt,state:'prepared'
}
```

- `createOwnedTabRegistry({sessionArea,chromeAdapter,now})` exposes `registerCreated`, `transition`, `removeOwned`, `markCleanupPending` and `get`; every mutation is a CAS on owner/audit/tab/state.
- `createRawNavigationVaultV1({sessionArea,now,randomBytes})` is the only raw-URL authority and exposes exactly `putInternal({ownerId,rawUrl})`, `takeInternal({ownerId,navigationToken})` and `invalidateInternal({ownerId,navigationToken})`. `putInternal` accepts only normalized HTTP/HTTPS URL strings produced inside the worker, returns `{navigationToken,expiresAt}`, and writes under `audita:raw-navigation:v1:<token>`. `takeInternal` serially validates exact record keys/owner/state/expiry, removes the storage key, verifies removal, and only then returns the raw URL once; failure to remove fails closed without returning it. `invalidateInternal` removes only the exact owner-bound record.
- Marco 1 keeps `AuditTargetDescriptorV1.kind:'disposable'` with internal `navigationToken` to refactor the existing runner without exposing URL/lote UI. Marco 3 modifies this same vault to add `put`/`take`, HMAC metadata and `RawNavigationQueueV1`; only there, after `take`, the runner call migrates to `{kind:'disposable',navigationUrl,...}`. There is no `navigation-authority.js`, adapter alias or second token store.
- `createPageCheckpointRecorder({auditId,pageId,startedAt,rulesVersion,inventory,onCheckpoint})` records only installed core rule IDs. Supplemental axe/editorial results remain in `AuditModel V2` and feed checkKeys, not the coverage denominator.
- `mergeExecutionCheckpoint({auditId,prior,pageSnapshot,pageOrder})` rejects another audit, duplicate/unknown page IDs, duplicate rule outcomes and order drift; it returns a deep-frozen aggregate.
- `verifyCoreRuleInventory(inventory)` checks exact keys, installed rulesVersion, sorted unique rule IDs and recomputed SHA-256 of `{inventoryVersion,rulesVersion,ruleIds}`; it resolves to a deep-frozen named-field copy or rejects with `CORE_INVENTORY_UNVERIFIED`.
- `runObservedTabAudit({auditId,target,capturePolicy,privacyDecision,checkpointRecorder,signal})` returns only `ObservedAuditResultV1`; it owns target proof/ownership/privacy and delegates collection after those gates.
- `executeObservedAuditPipeline({auditId,observedTarget,capturePolicy,checkpointRecorder,signal})` receives only a proven `ObservedTargetV1`, owns collection/rules/model persistence, and returns `{model,checkpoint,observationState:'observed'}`. It imports no tabs/ownership/raw-navigation module and cannot create, update or remove tabs.

- [ ] **Step 1: Write failing ownership, privacy and checkpoint tests**

```js
test('attached target is never created navigated or removed on every exit', async () => {
  for (const exit of ['success','cancel','timeout','cdp-failure','worker-interruption']) {
    await runAttachedFixture(exit);
    assert.deepEqual({create:calls.createTab,navigate:calls.navigateTab,remove:calls.removeTab},{create:0,navigate:0,remove:0});
  }
});

test('registers disposable ownership before navigation and retains observed URL audit', async () => {
  const result=await runDisposableFixture({cleanupMode:'retain-after-observation'});
  assert.deepEqual(calls.order.slice(0,3),['create-about-blank','register-owner','navigate']);
  assert.equal(result.ownershipState,'retained-for-review');
  assert.equal((await owned.get(result.ownerId)).state,'retained-for-review');
});

test('takes a raw URL once, erases it before return and never leaks it', async () => {
  const issued=await rawNavigationVault.putInternal({ownerId:'owner-a',rawUrl:'https://example.test/?token=SEGREDO-NAO-LOGAR#private'});
  assert.equal(await rawNavigationVault.takeInternal({ownerId:'owner-a',navigationToken:issued.navigationToken}),'https://example.test/?token=SEGREDO-NAO-LOGAR#private');
  assert.deepEqual(await sessionArea.get(`audita:raw-navigation:v1:${issued.navigationToken}`),{});
  await assert.rejects(() => rawNavigationVault.takeInternal({ownerId:'owner-a',navigationToken:issued.navigationToken}),/RAW_NAVIGATION_UNAVAILABLE/u);
  assert.doesNotMatch(JSON.stringify({stored:await sessionArea.get(null),failures,logs,model}),/SEGREDO-NAO-LOGAR/u);
});

test('refuses foreign tab removal and journals failed owned cleanup', async () => {
  await assert.rejects(() => owned.removeOwned({ownerId:'owner-a',tabId:99}),/OWNERSHIP_DENIED/u);
  adapter.removeError=true;
  assert.equal((await owned.removeOwned({ownerId:'owner-a',tabId:41})).state,'cleanup-pending');
});

test('emits immutable checkpoints in event-time order', async () => {
  await recorder.started();
  const first=recorder.record({ruleId:'rule-a',outcome:'passed'});
  const second=recorder.record({ruleId:'rule-b',outcome:'failed'});
  await Promise.all([first,second]);
  assert.deepEqual(emitted.map(value => value.pages[0].outcomes.map(row => row.ruleId)),[[],['rule-a'],['rule-a','rule-b']]);
});

test('privacy pause survives recreation and requires document reproving', async () => {
  const paused=await runnerWithPrivacy({decision:{status:'privacy-paused',pauseId:'pause-1'}});
  assert.equal(paused.status,'paused');
  const resumed=await recreateRunnerAndResume(paused.pauseId,{documentId:'changed'});
  assert.equal(resumed.code,'PRIVACY_TARGET_CHANGED');
  assert.equal(calls.pixelOperations,0);
});

test('never reads values or captures pixels before an allowed decision', async () => {
  const result=await runnerWithPrivacy({decision:{status:'privacy-paused',pauseId:'pause-2'},signals:[{category:'password-field'}]});
  assert.equal(result.status,'paused');
  assert.deepEqual(calls.order,['probe-structure-without-values','persist-privacy-pause']);
  assert.equal(calls.readInputValue,0);
  assert.equal(calls.captureVisibleTab,0);
  assert.equal(calls.captureScreenshot,0);
});

test('same-document SPA URL change fails digest reproving before collection', async () => {
  const result=await runAttachedFixture('spa-url-change-before-observation');
  assert.equal(result.status,'failed');
  assert.equal(result.model.session.diagnostics.at(-1).code,'TARGET_CHANGED');
  assert.equal(calls.collect,0);
  assert.equal(calls.pixelOperations,0);
});

test('batch records a failed page and stops cleanly on cancellation', async () => {
  const result=await runBatchFixture(['complete','pre-observation-failure','cancelled-before-start']);
  assert.deepEqual(result.checkpoint.pages.map(page => [page.pageId,page.attempted]),[['page-1',true],['page-2',true]]);
  assert.deepEqual(result.cleanupStates,['removed','removed']);
  assert.deepEqual(result.notStartedPageIds,['page-3']);
});
```

- [ ] **Step 2: Run focused runner tests and confirm RED**

Run: `node --test test/background/owned-tabs.test.js test/background/raw-navigation-vault.test.js test/background/observed-tab-runner.test.js test/background/execution-checkpoint.test.js test/background/audit-pipeline.test.js test/background/run-audit.test.js test/background/run-batch.test.js test/privacy/capture-policy.test.js test/core/core-rule-inventory.test.js`

Expected: FAIL because ownership, page-aware checkpoints and persisted privacy decisions are absent.

- [ ] **Step 3: Implement event-time checkpoints and the runner state machine**

```js
import { verifyCoreRuleInventory } from '../core/rules/core-rule-inventory.js';

const CORE_OUTCOMES=new Set(['passed','failed','cantTell','inapplicable','untested']);

function freezeCheckpoint(value,seen=new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeCheckpoint(child,seen);
  return Object.freeze(value);
}

export async function createPageCheckpointRecorder({auditId,pageId,startedAt,rulesVersion,inventory,onCheckpoint}) {
  const verifiedInventory=await verifyCoreRuleInventory(inventory);
  if (verifiedInventory.rulesVersion !== rulesVersion) throw new TypeError('CHECKPOINT_INVENTORY_VERSION_MISMATCH');
  let started=false;
  let tail=Promise.resolve();
  const outcomes=new Map();
  const snapshot=() => freezeCheckpoint({version:1,auditId,pages:[{pageId,attempted:true,startedAt,rulesVersion,inventoryVersion:verifiedInventory.inventoryVersion,inventoryHash:verifiedInventory.sha256,outcomes:[...outcomes].sort(([a],[b]) => a.localeCompare(b)).map(([ruleId,outcome]) => ({ruleId,outcome}))}]});
  const enqueue=value => { tail=tail.then(() => onCheckpoint(value)); return tail; };
  return Object.freeze({
    started() { if (started) throw new Error('CHECKPOINT_ALREADY_STARTED'); started=true; return enqueue(snapshot()); },
    record({ruleId,outcome}) { if (!started || outcomes.has(ruleId) || !verifiedInventory.ruleIds.includes(ruleId) || !CORE_OUTCOMES.has(outcome)) throw new TypeError('CHECKPOINT_RESULT_DENIED'); outcomes.set(ruleId,outcome); const captured=snapshot(); return enqueue(captured); },
    snapshot,
  });
}
```

`freezeCheckpoint` above is private to `execution-checkpoint.js`; no undefined shared helper is assumed. The constructor first awaits `verifyCoreRuleInventory`, copies the verified inventory, validates `auditId/pageId/startedAt/rulesVersion/onCheckpoint` and rejects any version mismatch before exposing the recorder.

`runObservedTabAudit` validates the target union before effects and calls the existing exported `canonicalTime(now())`. For disposable targets it creates visible `about:blank`, records ownership, atomically consumes `navigationToken` through `createRawNavigationVaultV1`, navigates, clears every local variable holding the raw URL in `finally`, observes and transitions to retained/cleanup. It passes only `{code}` and sanitized evidence URL to failure-model constructors. Native errors, URL components and stacks never enter diagnostics, model, UI or logs. Removal failure returns `cleanup-pending`; it is never swallowed.

For pixels, the runner branches exhaustively on `PrivacyGateDecisionV1`: the structural probe reports only category/count and is forbidden to read `.value`, text or accessible names; `allowed` must match observed document/HMAC and consume a one-use consent capability; `no-pixels` skips the probe and disables all booleans with limitation; `privacy-paused` persists/returns paused without pixels; `target-changed` and `aborted` fail closed. No capture API is reachable before the persisted decision branch. Marco 1 always supplies `no-pixels`, but tests cover every branch for forward safety.

`run-batch.js` assigns `page-1…page-N`, runs disposable pages sequentially with `cleanupMode:'always'`, merges each captured snapshot even for partial/cancelled pages and confirms ownership state `removed|cleanup-pending` before advancing. No hardcoded page ID or rules version remains inside the common runner.

- [ ] **Step 4: Run runner and batch regressions**

Run: `node --test test/background/owned-tabs.test.js test/background/raw-navigation-vault.test.js test/background/observed-tab-runner.test.js test/background/execution-checkpoint.test.js test/background/audit-pipeline.test.js test/background/run-audit.test.js test/background/run-batch.test.js test/background/session.test.js test/core/core-rule-inventory.test.js test/privacy/capture-policy.test.js`

Expected: PASS for attached preservation, owned disposable lifecycle, raw-URL boundary, immutable checkpoint sequence, batch failure/cancellation and privacy pause/restart.

- [ ] **Step 5: Commit runner ownership and checkpoints**

```bash
git add src/background/owned-tabs.js src/background/raw-navigation-vault.js src/background/observed-tab-runner.js src/background/execution-checkpoint.js src/background/audit-pipeline.js src/background/run-audit.js src/background/run-batch.js src/background/chrome-adapter.js src/core/privacy/capture-policy.js src/core/rules/core-rule-inventory.js test/background/owned-tabs.test.js test/background/raw-navigation-vault.test.js test/background/observed-tab-runner.test.js test/background/execution-checkpoint.test.js test/background/audit-pipeline.test.js test/background/run-audit.test.js test/background/run-batch.test.js test/privacy/capture-policy.test.js test/core/core-rule-inventory.test.js
git commit -m "feat: run audits with proven tab ownership"
```

---

### Task 3: Verified PanelSummaryV1 and complete PanelDetailV1

**Files:**

- Create: `src/panel/panel-summary.js`
- Create: `src/panel/panel-detail.js`
- Create: `src/panel/panel-result-contract.js`
- Create: `test/panel/panel-summary.test.js`
- Create: `test/panel/panel-detail.test.js`
- Modify: `test/core/core-rule-inventory.test.js`

**Interfaces:**

```text
ResultClassificationV1 = 'failed'|'alert'|'manual-review'|'passed'
ResultContextV1 = 'page-or-process'|'top-document'|'same-origin-frame'|'open-shadow-root'|'mixed'

PanelSummaryV1 = {
  version:1, auditId,
  identity:{finalUrl,completedAt,status:'complete'|'partial'|'failed'|'cancelled'},
  coverage:{status:'available',numerator,denominator,percent}
         | {status:'unavailable',reason:'EXECUTION_NOT_STARTED'|'CORE_INVENTORY_UNVERIFIED'},
  counts:{
    errors:{checkKeys,occurrences}, alerts:{checkKeys,occurrences},
    humanReview:{checkKeys,occurrences}, positive:{checkKeys,occurrences}
  },
  distributions:{impact:[{id,count}],wcag:[{id,count}],abnt:[{id,count}]},
  limitations:{codes,notStartedPageIds,inapplicableCheckKeys,untestedCheckKeys},
  groups:{failed:[PanelResultCardV1],alerts:[PanelResultCardV1],humanReview:[PanelResultCardV1],passed:[PanelResultCardV1]}
}

PanelResultCardV1 = {
  checkKey,pageId,engine,ruleId,originalOutcome,displayOutcome,title,impact,wcag,
  abntItemIds,occurrenceIds,classification:ResultClassificationV1,context:ResultContextV1,
  accessibleName,announcement,evidence
}

PanelDetailV1 = {
  version:1,auditId,occurrenceId,checkKey,
  heading:{title,classification:ResultClassificationV1,impact,context:ResultContextV1},
  affected:{audience,reason}, observed, correction,
  targets:[{nodeId,position,total}], accessibility:{name,nameSource,announcementPreview},
  normative:{wcag,level,abntItem,classification:'requirement'|'recommendation'}, legalReference,
  previews:[{evidenceId,kind,dataUrl,mediaUrl,origin}],
  technical:{selector,framePath,snippet,styles,engine,ruleId,version,hashes},
  action:{kind:'highlight'|'consult-evidence',reason}
}
```

- `buildPanelSummary({model,executionCheckpoint,inventory})` is async, pure and deterministic: it first rebuilds a named-field frozen copy with `createAuditModel(model)`, then awaits `verifyCoreRuleInventory(inventory)` and never trusts a persisted UI projection. It catches only `CORE_INVENTORY_UNVERIFIED` to return the explicit unavailable coverage state and model-backed nonpositive cards; malformed model/checkpoint graphs still reject closed.
- Coverage uses only `(attempted page, installed core rule)` pairs. Cards/counts use all unique `(pageId,engine,ruleId)` checkKeys.
- Core passes come from the checkpoint. Failed/cantTell core, axe, editorial and manual cards are grouped from occurrences by `occurrence.source.engine/ruleId`; rule metadata is joined by `(source.engine,source.ruleId)`, never by nonexistent `rule.pageId`.
- `displayOutcome` is derived from the canonical decision graph: original conclusive result wins; otherwise a valid “não conforme” decision yields failed, a valid “conforme” decision yields passed, and unanswered remains cantTell.
- `classifyPanelResultV1(groupName)` is the single total derivation of presentation classification: `failed→failed`, `alerts→alert`, `humanReview→manual-review`, `passed→passed`. It accepts no persisted/UI classification, rejects any other group, and the summary/detail builders assert that the classification agrees with the card's group and consolidated outcome.
- `deriveResultContextV1({occurrences,evidenceById})` uses only validated canonical facts. A target without node/selector is `page-or-process`; a correlated element selector containing the validated ` >>> ` shadow-boundary token is `open-shadow-root`; an observed nonempty `framePath` is `same-origin-frame`; every other observed node is `top-document`; more than one distinct context in one checkKey is `mixed`. Cross-origin, sandboxed or closed-shadow content that was not observed remains a limitation and never becomes a fabricated card/context.
- The coverage projection renders the fixed copy `Frames cross-origin ou com sandbox não observados aparecem como limitação.` whenever validated collection metadata reports either boundary; it never manufactures a `ResultContextV1` or a manual-review card for unobserved content. Closed Shadow DOM renders the separate fixed caveat `Shadow DOM fechado não pode ser inspecionado automaticamente.` from the validated limitation catalog.
- Accessibility uses evidence fields `accessibility.name`, `nameSource` and `announcementPreview`.
- `highlightAvailable` is never inferred from `presentationTargetKey`. Marco 1 passes an empty trusted availability map, so actions are `consult-evidence`.

- [ ] **Step 1: Write failing projection tests**

```js
test('separates coverage pairs from all-engine checkKeys', async () => {
  const summary=await buildPanelSummary({model:modelWithCoreAxeEditorialSameRuleId,executionCheckpoint:checkpoint,inventory});
  const cards=Object.values(summary.groups).flat();
  assert.equal(summary.coverage.denominator,130);
  assert.equal(new Set(cards.map(row => row.checkKey)).size,cards.length);
  assert.equal(cards.some(row => row.engine === 'axe-core'),true);
  assert.equal(cards.some(row => row.engine === 'audita-editorial'),true);
});

test('rejects checkpoint from another audit or duplicate page/rule', async () => {
  await assert.rejects(() => buildPanelSummary({model,executionCheckpoint:foreignCheckpoint,inventory}),/CHECKPOINT_GRAPH_DENIED/u);
  await assert.rejects(() => buildPanelSummary({model,executionCheckpoint:duplicateCheckpoint,inventory}),/CHECKPOINT_GRAPH_DENIED/u);
});

test('distinguishes zero denominator, started-no-result, not-started and partial batch', async () => {
  const zero=await buildPanelSummary({model:emptyBatchModel,executionCheckpoint:noStartedPages,inventory});
  assert.deepEqual(zero.coverage,{status:'unavailable',reason:'EXECUTION_NOT_STARTED'});
  const started=await buildPanelSummary({model:oneStartedModel,executionCheckpoint:startedWithoutOutcomes,inventory});
  assert.deepEqual(started.coverage,{status:'available',numerator:0,denominator:130,percent:'0,0%'});
  const partial=await buildPanelSummary({model:partialBatchModel,executionCheckpoint:oneStartedOneNotStarted,inventory});
  assert.equal(partial.coverage.denominator,130);
  assert.deepEqual(partial.limitations.notStartedPageIds,['page-2']);
});

test('reports unavailable coverage for an unverified inventory without inventing passes', async () => {
  const summary=await buildPanelSummary({model,executionCheckpoint:checkpoint,inventory:tamperedInventory});
  assert.deepEqual(summary.coverage,{status:'unavailable',reason:'CORE_INVENTORY_UNVERIFIED'});
  assert.deepEqual(summary.groups.passed,[]);
  assert.equal(summary.groups.failed.length > 0,true);
});

test('uses decision displayOutcome without overwriting original outcome', async () => {
  const reviewedSummary=await buildPanelSummary({model:reviewedModel,executionCheckpoint:checkpoint,inventory});
  const card=Object.values(reviewedSummary.groups).flat().find(row => row.ruleId === 'manual-check');
  assert.equal(card.originalOutcome,'cantTell');
  assert.equal(card.displayOutcome,'failed');
});

test('derives the closed result classification and context instead of trusting UI data', async () => {
  assert.deepEqual(['failed','alerts','humanReview','passed'].map(classifyPanelResultV1),['failed','alert','manual-review','passed']);
  assert.throws(() => classifyPanelResultV1('unknown'),/RESULT_CLASSIFICATION_DENIED/u);
  const projected=await buildPanelSummary({model:contextModel,executionCheckpoint:checkpoint,inventory});
  const cards=Object.values(projected.groups).flat();
  assert.equal(cards.find(row => row.occurrenceIds.includes('occ-frame')).context,'same-origin-frame');
  assert.equal(cards.find(row => row.occurrenceIds.includes('occ-shadow')).context,'open-shadow-root');
  assert.equal(cards.every(row => ['failed','alert','manual-review','passed'].includes(row.classification)),true);
});

test('detail contains ten ordered evidence blocks and no live highlight claim', () => {
  const detail=buildPanelDetail({model,summary,occurrenceId:'occ-1',highlightAvailability:new Map()});
  assert.deepEqual(Object.keys(detail).slice(4),['heading','affected','observed','correction','targets','accessibility','normative','legalReference','previews','technical','action']);
  const card=Object.values(summary.groups).flat().find(row => row.occurrenceIds.includes('occ-1'));
  assert.equal(detail.heading.classification,card.classification);
  assert.equal(detail.heading.context,card.context);
  assert.deepEqual(detail.action,{kind:'consult-evidence',reason:'Esta verificação não possui um elemento único destacável no estado atual.'});
});
```

- [ ] **Step 2: Run projection tests and confirm RED**

Run: `node --test test/core/core-rule-inventory.test.js test/panel/panel-summary.test.js test/panel/panel-detail.test.js`

Expected: FAIL because the current summary conflates pairs/checkKeys and no complete detail projection exists.

- [ ] **Step 3: Implement the deterministic algorithms**

Implement `validateCheckpointGraph` with exact-key checks, `checkpoint.auditId === model.auditId`, unique pages/outcomes, exact page membership/order, `attempted:false ⇔ startedAt:null + outcomes:[]`, installed version/hash and model/checkpoint page-state compatibility. `coveragePercent` uses integer half-up arithmetic: `tenths=Math.floor((numerator*1000*2+denominator)/(2*denominator))`; the displayed value is exactly `` `${Math.floor(tenths/10)},${tenths%10}%` ``.

Implement `buildCheckKeyIndex` in three passes: core checkpoint pairs; occurrence groups keyed with `JSON.stringify([pageId,engine,ruleId])`; deterministic merge/sort. It rejects duplicate authoritative rule identities. ABNT/WCAG distributions count cards, while the secondary occurrence counters sum unique occurrence IDs. `panel-result-contract.js` owns the two closed enums and both total derivations; summary and detail import them instead of maintaining parallel mappings.

Implement `buildPanelDetail` by copying only named fields. It obtains corrections/audience/observations from canonical rule/item/occurrence data, joins evidence only through `evidenceRefs`, sanitizes data/local resource URLs through the existing evidence URL validator and never retains an input reference.

- [ ] **Step 4: Run model/projection regressions**

Run: `node --test test/panel/panel-summary.test.js test/panel/panel-detail.test.js test/report/audit-model-v2.test.js test/core/batch-aggregation.test.js`

Expected: PASS for zero denominator, unverified inventory, same rule in two engines, supplemental-only findings, decisions, batch pages and immutable inputs.

- [ ] **Step 5: Commit projections**

```bash
git add src/panel/panel-summary.js src/panel/panel-detail.js src/panel/panel-result-contract.js test/panel/panel-summary.test.js test/panel/panel-detail.test.js test/core/core-rule-inventory.test.js
git commit -m "feat: project verified panel results"
```

---

### Task 4: Manifest and real popup gesture

**Files:**

- Modify: `manifest.json:1-40`
- Create: `src/popup/index.html`
- Create: `src/popup/popup.css`
- Create: `src/popup/popup.js`
- Create: `src/popup/popup-state.js`
- Modify: `src/panel/index.html:1-133`
- Modify: `src/panel/panel.css`
- Modify: `test/extension-shell.test.js`
- Create: `test/popup/popup-state.test.js`

**Interfaces:**

- `PREPARE_POPUP_CAPABILITIES {type,requestId}` returns `{ok:true,requestId,auditCapabilityId,personaCapabilityId,windowId,expiresAt}` after POPUP/document proof.
- `createPopupAuditMessage(capabilityId)` returns exactly `{type:'POPUP_START_AUDIT',capabilityId,captureMode:'no-pixels',includeQuery:false,deleteAfterCompleteExport:false}`. Popup has no retention checkbox, so Marco 1 accepts only literal `false` there.
- `handleAuditClick()` reads the already-prepared value synchronously, calls `sidePanel.open({windowId})` as its first Chrome API call, awaits success and only then sends the start message. Open failure sends no audit message.
- Each failed sibling preparation invalidates only its own newly created capability.

- [ ] **Step 1: Write failing gesture-order tests**

```js
test('opens side panel before start and does not start when opening fails', async () => {
  const ok=createPopupController(popupFixture({openResult:'ok'}));
  await ok.handleAuditClick();
  assert.deepEqual(ok.calls.map(call => call.type),['sidePanel.open','runtime.sendMessage']);
  const failed=createPopupController(popupFixture({openResult:'reject'}));
  await failed.handleAuditClick();
  assert.deepEqual(failed.calls.map(call => call.type),['sidePanel.open']);
});

test('creates the exact no-pixels message', () => {
  assert.deepEqual(createPopupAuditMessage('cap-12345678901234567890'),{type:'POPUP_START_AUDIT',capabilityId:'cap-12345678901234567890',captureMode:'no-pixels',includeQuery:false,deleteAfterCompleteExport:false});
});
```

- [ ] **Step 2: Run popup tests and confirm RED**

Run: `node --test test/extension-shell.test.js test/popup/popup-state.test.js`

Expected: FAIL because the popup/side-panel manifest contract and exact click controller are absent.

- [ ] **Step 3: Implement local surfaces**

Manifest incorporates `minimum_chrome_version:"116"`, permissions `alarms,contextMenus,debugger,downloads,scripting,sidePanel,storage,tabs`, `side_panel.default_path`, `action.default_popup` and `_execute_action` shortcut; it removes the historical `action.onClicked` registration.

Popup contains domain/title, `Avaliar esta página`, `Outra URL ou lote`, three disabled 44×44 persona controls and the notices `Processamento local; nenhum dado é enviado.` and `Capturas visuais serão habilitadas somente após a etapa de privacidade.`. The controller prepares capabilities on load; it never renews asynchronously inside the click gesture. Expired capability disables the control until a fresh preparation completes.

- [ ] **Step 4: Run shell verification**

Run: `node --test test/extension-shell.test.js test/popup/popup-state.test.js`

Expected: PASS for manifest, exact message, side-panel-first order and failed-open no-start.

- [ ] **Step 5: Commit extension surfaces**

```bash
git add manifest.json src/popup src/panel/index.html src/panel/panel.css test/extension-shell.test.js test/popup/popup-state.test.js
git commit -m "feat: launch audits from a minimal popup"
```

---

### Task 5: Atomic audit starter, closed runtime protocol and SIDE_PANEL port

**Files:**

- Create: `src/background/worker-protocol.js`
- Create: `src/background/authorized-audit-starter.js`
- Create: `src/background/panel-port.js`
- Create: `src/background/side-panel-intent-router.js`
- Modify: `src/background/service-worker.js:194-607`
- Modify: `src/background/context-menu.js:68-286`
- Create: `test/background/worker-protocol.test.js`
- Create: `test/background/authorized-audit-starter.test.js`
- Create: `test/background/panel-port.test.js`
- Modify: `test/background/service-worker.test.js`
- Modify: `test/background/context-menu.test.js`

**Closed runtime messages:**

```text
PREPARE_POPUP_CAPABILITIES {type,requestId}
PREPARE_PANEL_CAPABILITY {type,requestId}
POPUP_START_AUDIT | PANEL_START_ATTACHED_AUDIT {type,capabilityId,captureMode,includeQuery,deleteAfterCompleteExport}
POPUP_START_PERSONA {type,capabilityId,mode}
PANEL_CANCEL_AUDIT | PANEL_OPEN_REPORT | REPORT_REQUEST_EXPORT {type,sessionCapabilityId,auditId}
PANEL_REHYDRATE_VIEW | REPORT_CONNECT | EXPORT_CONNECT {type,auditId}
```

- IDs opacos have 20–240 base64url-style characters; model IDs have 1–160 closed characters; envelopes reject extra keys and exceedance of 4096 UTF-8 bytes.
- `PREPARE_PANEL_CAPABILITY` derives SIDE_PANEL/window, queries the one active HTTP/HTTPS tab and returns exactly `{ok:true,requestId,capabilityId,expiresAt}` for one `start-audit` capability; it never relies on `sender.tab` and never returns a Chrome ID, URL or navigation token.
- Marco 1 rejects pixel modes and personas before capability lookup. `PANEL_START_URL_AUDIT` and `PANEL_START_BATCH_AUDIT` are absent from the schema and fail as unknown without side effects; Marco 3 adds its `{url}`/`{urls}` branches without exposing navigation tokens.
- `beginAuthorizedAudit({capabilityId,eventNonce,auditId,capturePolicy,retentionPreference,senderContext})` returns `{response:{ok:true,auditId},sessionCapabilityId,completion}`. `retentionPreference` is exactly `{version:1,deleteAfterCompleteExport:false}` in Marco 1; Marco 3 allows the panel-owned boolean and persists it outside `AuditModel V2`. For an extension document `eventNonce` is `null`; for a worker event `senderContext` is `null`. It calls the corresponding atomic claim/session method, persists the preference plus a one-use `PanelBootstrapV1` under the proven window, registers active job, then starts the runner. State-specific grants come only from the closed session `intents`: panel cancel while running, panel open-report after persisted result, and review export after `REPORT_CONNECT`; Marco 1 grants no highlight intent.
- `PanelBootstrapV1` is `{version:1,kind:'audit-session',auditId,sessionCapabilityId,windowId,createdAt,expiresAt,state:'pending'|'consumed'}`. Popup and context menu use the same producer.
- `PanelPortBindingV1` is `{version:1,documentId,windowId,state:'idle',auditId:null,sessionCapabilityId:null}` or `{version:1,documentId,windowId,state:'session',auditId,sessionCapabilityId}`. Port name is `audita-panel-v1`. First UI packet is exactly `{protocol:'audita-panel',version:1,type:'bootstrap'}`; it contains no window/audit/session supplied by UI. The worker may answer `{protocol:'audita-panel',version:1,type:'bootstrap-result',state:'initial',auditId:null,sessionCapabilityId:null}` when the panel wins the popup-open/start race. When a pending bootstrap exists or later arrives for that proven window, the worker atomically consumes it and sends the same packet with `state:'running'|'result'|'view-only'`, `auditId` and `sessionCapabilityId`. Later packets use the closed event union in `panel-port.js` and never contain a raw URL, Chrome ID or navigation token.

- [ ] **Step 1: Write failing protocol, starter and port tests**

```js
test('persists session and panel bootstrap before runner starts', async () => {
  const started=await starter.beginAuthorizedAudit(validStart);
  assert.deepEqual(calls.order.slice(0,4),['claim-and-session','persist-retention','write-bootstrap','start-runner']);
  await started.completion;
  assert.equal((await readStoredSession(started.sessionCapabilityId)).state,'result');
});

test('attaches a SIDE_PANEL without sender.tab after one closed bootstrap hello', async () => {
  const port=panelPortFixture({sender:panelSenderWithoutTab});
  attachPanelPort(port);
  port.receive({protocol:'audita-panel',version:1,type:'bootstrap'});
  await port.settled();
  assert.equal(calls.bound.documentId,'panel-document-1');
  assert.equal(calls.bound.auditId,'audit-1');
});

test('converges when the idle panel or authorized start wins the race', async () => {
  const panelFirst=panelPortFixture({sender:panelSenderWithoutTab});
  attachPanelPort(panelFirst);
  panelFirst.receive({protocol:'audita-panel',version:1,type:'bootstrap'});
  await panelFirst.waitForState('initial');
  await starter.beginAuthorizedAudit(validStart);
  assert.equal((await panelFirst.waitForState('running')).auditId,'audit-1');

  await starter.beginAuthorizedAudit(secondValidStart);
  const startFirst=panelPortFixture({sender:secondPanelSenderWithoutTab});
  attachPanelPort(startFirst);
  startFirst.receive({protocol:'audita-panel',version:1,type:'bootstrap'});
  assert.equal((await startFirst.waitForState('running')).auditId,'audit-2');
});

test('prepares the active target from SIDE_PANEL without leaking authority', async () => {
  const response=await dispatch({type:'PREPARE_PANEL_CAPABILITY',requestId:'request-1'},panelSenderWithoutTab);
  assert.deepEqual(Object.keys(response).sort(),['capabilityId','expiresAt','ok','requestId']);
  assert.equal(response.ok,true);
  assert.match(response.capabilityId,/^[A-Za-z0-9_-]{20,240}$/u);
  assert.equal(Object.hasOwn(response,'navigationToken'),false);
  assert.equal(Object.hasOwn(response,'tabId'),false);
  assert.equal(Object.hasOwn(response,'windowId'),false);
});

test('Marco 1 rejects URL and batch envelopes before effects', async () => {
  for (const message of [
    {type:'PANEL_START_URL_AUDIT',url:'https://example.test/?token=SEGREDO-NAO-LOGAR'},
    {type:'PANEL_START_BATCH_AUDIT',urls:['https://example.test/?token=SEGREDO-NAO-LOGAR']},
  ]) assert.deepEqual(await dispatch(message,panelSenderWithoutTab),{ok:false,code:'UNKNOWN_MESSAGE'});
  assert.deepEqual(effectCalls,[]);
  assert.doesNotMatch(JSON.stringify({session:await sessionArea.get(null),logs,diagnostics}),/SEGREDO-NAO-LOGAR/u);
});

test('closes forged timed-out duplicate and cross-audit port hellos', async () => {
  for (const fixture of [panelAsTab,helloWithExtra,duplicateHello,foreignSession,noHelloBeforeDeadline]) {
    const port=panelPortFixture(fixture); attachPanelPort(port); await fixture.drive(port); assert.equal(port.disconnected,true);
  }
});

test('context menu and popup call the same authorized starter', async () => {
  await popupDispatch(); await contextMenuClick();
  assert.deepEqual(calls.starter.map(value => Object.keys(value).sort()),[START_KEYS,START_KEYS]);
});
```

- [ ] **Step 2: Run worker boundary tests and confirm RED**

Run: `node --test test/background/worker-protocol.test.js test/background/authorized-audit-starter.test.js test/background/panel-port.test.js test/background/service-worker.test.js test/background/context-menu.test.js`

Expected: FAIL because the atomic starter, bootstrap transfer and closed port state machine are absent.

- [ ] **Step 3: Implement exact dispatch and port state machine**

`parseWorkerMessage` checks plain-object prototype, exact sorted keys, byte size and the predicates above. The type discriminator is selected only after the total-size/plain-object checks, and unknown types return the fixed `UNKNOWN_MESSAGE` code without stringifying or retaining their fields. Dispatch derives a trusted surface before every UI operation. `REPORT_REQUEST_EXPORT` authorizes `export`; cancel/open report authorize their own intents. No dispatcher accepts model, report view, URL, navigation token or Chrome ID. Settlement maps a committed complete/partial/cancelled model to `result`; privacy pause, pre-model failure and explicit revocation map to `revoked`; the transition runs once after model persistence and before `completion` resolves.

`attachPanelPort` performs these states only: `awaiting-hello → bound-idle → bound-session → disconnected`. It validates port name/sender immediately; installs a 5-second hello deadline and a single temporary listener; parses one exact hello; derives/binds document + window and serializes against starter publication for that window. Zero pending bootstraps yields `bound-idle`; exactly one consumes/authorizes it for `{name:'panel',path:'/src/panel/index.html',contextType:'SIDE_PANEL'}` and yields `bound-session`; ambiguity fails closed. A later worker-published bootstrap upgrades that same proven idle binding atomically. The temporary listener is removed after the one hello; later UI packets use only the state-event parser. Any second hello, invalid/oversized packet, ambiguity, timeout or disconnect clears listeners and closes the port.

On worker restart, a running durable checkpoint returns `AUDIT_INTERRUPTED` and never restarts. A validated complete/partial model can receive a new view-only session via `PANEL_REHYDRATE_VIEW`; its panel consumer has only `open-report`, and its review consumer receives `export` only after the registered report connects. It never receives cancel/highlight. Context-menu handler calls `sidePanel.open` before its first await, creates a nonce-bound worker capability and uses the same starter. Catches persist only fixed codes.

- [ ] **Step 4: Run worker/security regressions**

Run: `node --test test/background/worker-protocol.test.js test/background/authorized-audit-starter.test.js test/background/panel-port.test.js test/background/service-worker.test.js test/background/context-menu.test.js test/extension-shell.test.js`

Expected: PASS for atomic start/result transition, popup/menu bootstrap, no-tab panel, forged/duplicate ports, restart and closed envelopes.

- [ ] **Step 5: Commit worker authorization**

```bash
git add src/background/worker-protocol.js src/background/authorized-audit-starter.js src/background/panel-port.js src/background/side-panel-intent-router.js src/background/service-worker.js src/background/context-menu.js test/background/worker-protocol.test.js test/background/authorized-audit-starter.test.js test/background/panel-port.test.js test/background/service-worker.test.js test/background/context-menu.test.js
git commit -m "feat: bind audit sessions to the side panel"
```

---

### Task 6: Immutable four-state panel with working filters and details

**Files:**

- Modify: `src/panel/index.html:15-131`
- Modify: `src/panel/panel.css`
- Modify: `src/panel/panel-state.js:1-591`
- Modify: `src/panel/panel.js:1-809`
- Create: `src/panel/panel-view.js`
- Modify: `test/panel/panel-state.test.js`
- Modify: `test/panel/panel-ui.test.js`
- Create: `test/panel/panel-view.test.js`

**Interfaces:**

- `PanelStateV1.screen` is `initial|running|result|unavailable`; every reducer result is recursively frozen.
- Events are exactly `BOOTSTRAP_INITIAL`, `START_REQUESTED`, `AUDIT_RUNNING`, `AUDIT_RESULT`, `AUDIT_UNAVAILABLE`, `FILTER_SET`, `OCCURRENCE_SELECTED`, `EVIDENCE_TOGGLED`, `RETRY_REQUESTED`, `PORT_INTERRUPTED`.
- UI intents are exactly `START_ATTACHED`, `OPEN_URL_FORM`, `OPEN_BATCH_FORM`, `CANCEL_AUDIT`, `OPEN_REPORT`, `SELECT_OCCURRENCE`, `CONSULT_EVIDENCE`, `RETRY`.
- `buildPanelView({state,summary,detail})` copies data into a frozen render model. Filters apply to cards only and never alter summary/model/detail.

- [ ] **Step 1: Write failing reducer/view tests**

```js
test('every transition is frozen and filters preserve selection focus and scroll', () => {
  const state=reducePanelState(resultState,{type:'FILTER_SET',filter:'impact',values:['critical']});
  assert.equal(Object.isFrozen(state),true);
  assert.equal(state.selectedOccurrenceId,'occ-1');
  assert.equal(state.focusId,'filter-impact');
  assert.equal(state.scrollTop,160);
});

test('renders the exact ten detail blocks from PanelDetailV1', () => {
  const root=renderPanelView({view:buildPanelView({state,summary,detail}),document:createTestDocument(),onIntent:collect});
  assert.deepEqual([...root.querySelectorAll('[data-detail-block]')].map(node => node.dataset.detailBlock),['heading','affected','observed','correction','targets','accessibility','normative','legal','previews','technical']);
});

test('renders closed result metadata and stable impact WCAG and ABNT filter selectors', () => {
  const root=renderPanelView({view:buildPanelView({state,summary:filterSummary,detail}),document:createTestDocument(),onIntent:collect});
  const card=root.querySelector('[data-result-card][data-check-key]');
  assert.equal(card.dataset.classification,'failed');
  assert.equal(card.dataset.context,'top-document');
  const detailRoot=root.querySelector('[data-result-detail]');
  assert.equal(detailRoot.dataset.classification,detail.heading.classification);
  assert.equal(detailRoot.dataset.context,detail.heading.context);
  assert.ok(root.querySelector('button[data-filter-dimension="impact"][data-filter-value="critical"]'));
  assert.ok(root.querySelector('button[data-filter-dimension="wcag"][data-filter-value="AA"]'));
  assert.ok(root.querySelector('button[data-filter-dimension="abnt"][data-filter-value="5.1.1"]'));
});
```

- [ ] **Step 2: Run panel tests and confirm RED**

Run: `node --test test/panel/panel-state.test.js test/panel/panel-view.test.js test/panel/panel-ui.test.js`

Expected: FAIL because current state is mutable and its view cannot render complete details or working filters.

- [ ] **Step 3: Implement the complete renderer**

The reducer uses an exhaustive switch and `deepFreeze` on every new state. `initial` exposes current page plus URL/lote choices; unavailable Marco 1 features receive leigo `Disponível no Marco 3`, not a dead control. `running` renders five phases, one polite live region and cancel. `result` renders identity, coverage disclaimer, four checkKey/occurrence counts, impact/WCAG/ABNT filters, all four groups, details and report action; its result root sets only the canonical model ID as `data-audit-id`, never a capability. `unavailable` renders fixed reason and retry.

`renderPanelView` has one exhaustive switch per screen and one exhaustive switch per intent. It creates nodes with `createElement`, sets strings with `textContent`, uses `<details>` for technical evidence and never assigns `innerHTML`. Every result card root is exactly addressable by `[data-result-card][data-check-key]` and copies only its closed `ResultClassificationV1`/`ResultContextV1` to `data-classification`/`data-context`; the detail root uses `[data-result-detail]` and copies the same two values from `detail.heading`. These datasets never contain a selector, URL, Chrome ID or opaque authority.

Each filter is a `<button>` addressable by exactly one of `button[data-filter-dimension="impact"][data-filter-value]`, `button[data-filter-dimension="wcag"][data-filter-value]` or `button[data-filter-dimension="abnt"][data-filter-value]`, with an accessible name and `aria-pressed="true|false"`; the dimension is a closed literal and the value comes only from the validated frozen distribution. The event listener reads `currentTarget.dataset` and passes the two strings to the reducer without constructing a selector from user input. Every primary interactive target is at least 44×44 CSS px. Re-render restores `scrollTop` and focus through stable `data-focus-id`. `CONSULT_EVIDENCE` expands previews; no highlight action appears in Marco 1.

For `START_ATTACHED`, `panel.js` sends exact `PREPARE_PANEL_CAPABILITY`, validates the closed response, then sends `PANEL_START_ATTACHED_AUDIT` with only the returned opaque capability and fixed `no-pixels/includeQuery:false/deleteAfterCompleteExport:false`; it never reads the active-tab URL or Chrome IDs. The already-bound idle port receives the resulting worker-published bootstrap. URL/lote intents render the fixed Marco 3 availability explanation and send no start message.

- [ ] **Step 4: Run panel accessibility tests**

Run: `node --test test/panel/panel-state.test.js test/panel/panel-view.test.js test/panel/panel-ui.test.js test/panel/panel-voice-privacy.test.js test/extension-shell.test.js`

Expected: PASS for four screens, filters, ten detail blocks, focus/scroll, live region, keyboard order, 44×44 and zero `innerHTML`.

- [ ] **Step 5: Commit panel UI**

```bash
git add src/panel/index.html src/panel/panel.css src/panel/panel-state.js src/panel/panel-view.js src/panel/panel.js test/panel/panel-state.test.js test/panel/panel-view.test.js test/panel/panel-ui.test.js
git commit -m "feat: render complete side panel results"
```

---

### Task 7: Independent ReportViewV1, qualified legal basis and authorized export

**Files:**

- Create: `src/review/report-view.js`
- Modify: `src/review/review.js:1-251`
- Modify: `src/review/index.html`
- Modify: `src/review/review.css`
- Create: `src/background/report-launch.js`
- Create: `src/background/export-launch.js`
- Modify: `src/background/worker-protocol.js`
- Modify: `src/export/index.html`
- Modify: `src/export/index.js`
- Modify: `src/background/service-worker.js:289-351,782-787`
- Modify: `src/core/legal/consumer-basis.js`
- Modify: `src/core/report/html.js`
- Modify: `src/export/report-export.js`
- Modify: `src/export/export-controller.js`
- Create: `test/review/report-view.test.js`
- Modify: `test/review/review-ui.test.js`
- Create: `test/background/report-launch.test.js`
- Create: `test/background/export-launch.test.js`
- Modify: `test/background/worker-protocol.test.js`
- Modify: `test/export/export-page.test.js`
- Modify: `test/background/service-worker.test.js`
- Modify: `test/legal/consumer-basis.test.js`
- Modify: `test/report/html.test.js`
- Modify: `test/export/report-export.test.js`
- Modify: `test/export/export-controller.test.js`

**Interfaces:**

```text
EXPORT_FORMATS_V1 = ['html','pdf','csv','json']

ReportViewV1 = {
  version:1,auditId,modelRevision,modelHash,filters,
  executive:{identity,scope,status,coverage,counts,pages,limitations},
  issues:{failed,alerts,humanReview,passed},
  technicalEvidence:[...], readerMaps:[...], methodology:{...},
  exports:{availability,formats,limitations}, matrix:[146 rows]
}

ReportLaunchV1 = {
  version:1,auditId,tabId,windowId,path:'/src/review/index.html',
  documentId:null|string,state:'allocated'|'awaiting-connection'|'connected'|'revoked',issuedAt,expiresAt
}

ExportLaunchV1 = {
  version:1,auditId,sourceReviewSessionCapabilityId,expectedRevision,attemptId,
  tabId,windowId,path:'/src/export/index.html',documentId:null|string,
  state:'allocated'|'awaiting-connection'|'connected'|'terminal'|'revoked',issuedAt,expiresAt
}

ExportSessionCapabilityV1 = {
  version:1,sessionCapabilityId,auditId,launchTabId,launchDocumentId,
  expectedRevision,attemptId,intents:['execute-export','complete-export'],
  state:'active'|'terminal'|'revoked',issuedAt,expiresAt
}
```

- `buildReportView({model,summary,modelRevision,modelHash})` is the closed concrete signature for the spec's pure report projection: the extra context is necessary because the same spec forbids adding checkpoint/inventory to `AuditModel V2`. It validates/copies `model` through `createAuditModel`, accepts only a freshly rebuilt `PanelSummaryV1` for the same `auditId`, requires a positive safe-integer `modelRevision` and `modelHash === model.integrity.canonicalModelHash`, reads no storage/global/time/randomness, shares no input references and returns all datasets required by the spec. Cryptographic verification is the caller's asynchronous gate below, keeping this projection pure and synchronous.
- `EXPORT_FORMATS_V1` is one frozen shared constant in `src/export/report-export.js`; `ReportViewV1.exports.formats`, generation, download dispatch, receipt validation and E2E assertions all preserve exactly `html,pdf,csv,json` order. No surface sorts or reconstructs this list independently.
- `renderReportView` renders identity plus seven `h2` sections from that view. It does not recalculate normativity.
- `qualifiedConsumerReference({occurrence,item,displayOutcome,decision,normativeItems})` supports original failed and validated human “não conforme”, while preserving original result and decision.
- `REPORT_REQUEST_EXPORT` is authorized only for the registered review TAB/session and never accepts model, summary, projection or bytes from UI.
- `REPORT_CONNECT {type,auditId}` returns exactly `{ok:true,auditId,sessionCapabilityId,state:'view-only'}` in Marco 1 after its first-document CAS. The state describes this export-only report consumer, not the persisted audit outcome; Marco 2 may return `result` only after adding and proving live highlight authority.
- Task 7 extends the one existing frozen `MESSAGE_SCHEMAS` table with exact `EXPORT_CONNECT {type,auditId}`; no second parser/listener is created. It is the only unauthenticated first packet from the owned export TAB. Its URL contains exactly `?auditId=<auditId>` and never lease owner, attempt, revision or capability. After first-document proof, the worker returns exactly `{ok:true,sessionCapabilityId,auditId,expectedRevision,attemptId}` from its launch record; those values are not accepted from the URL.
- Stored revision is exactly `{version:1,auditId,modelRevision,modelHash,model,checkpoint}` with a positive safe-integer revision and the 64-character lowercase hex `model.integrity.canonicalModelHash`. `runReportExport` reloads the record, rebuilds it with `createAuditModel`, awaits `verifyIntegrityLinks(model)`, compares the stored hash to the verified model, resolves/verifies installed inventory, rebuilds summary/view once and gives that immutable revision to HTML/PDF/CSV/JSON. A stale persisted summary is ignored. The existing delivery-receipt validator recomputes SHA-256 over the exact four byte arrays before any success is reported.
- `ReportLaunchV1` requires `documentId:null` in `allocated|awaiting-connection`, one nonempty document ID in `connected`, and either prior value in terminal `revoked`. Every transition is a CAS over audit/tab/window/state/expiry; allocation and cleanup are serialized per audit.
- `ExportLaunchV1` follows the same allocate-before-navigation proof for an inactive `about:blank` tab. It additionally binds the authorized review source session and one worker-derived model revision/attempt. `documentId` is null before connection and nonempty in `connected|terminal`; reload/navigation after connection revokes the export session rather than repeating downloads. Every export transition is serialized per audit/attempt.

- [ ] **Step 1: Write failing projection, legal, launch and export tests**

```js
const MODEL_HASH=model.integrity.canonicalModelHash;

async function sha256Bytes(bytes) {
  const view=bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest=await crypto.subtle.digest('SHA-256',view);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,'0')).join('');
}

test('report projection owns copies of every required dataset', () => {
  const view=buildReportView({model,summary,modelRevision:1,modelHash:MODEL_HASH});
  assert.deepEqual(Object.keys(view),['version','auditId','modelRevision','modelHash','filters','executive','issues','technicalEvidence','readerMaps','methodology','exports','matrix']);
  assert.equal(view.issues.alerts.length > 0,true);
  assert.equal(view.issues.passed.length > 0,true);
  assert.notEqual(view.executive.counts,summary.counts);
  assert.equal(Object.isFrozen(view.matrix),true);
});

test('manual nonconformity receives fixed legal text without changing the occurrence', () => {
  const before=structuredClone(reviewOccurrence);
  const ref=qualifiedConsumerReference({occurrence:reviewOccurrence,item:officialItem,displayOutcome:'failed',decision:nonconformingDecision,normativeItems:NBR17225_ITEMS});
  assert.match(ref.text,/item 5\.1\.1 da ABNT NBR 17225:2025/u);
  assert.deepEqual(reviewOccurrence,before);
});

test('registers report ownership before navigation and revalidates before focus', async () => {
  await openRegisteredReport(validOpen);
  assert.deepEqual(calls.order.slice(0,4),['create-about-blank','write-launch','navigate-report','await-connect']);
  await openRegisteredReport(validOpen);
  assert.deepEqual(calls.focusValidation,['tab','context','window','document','expiry']);
});

test('connects the first report document with an export-only closed session response', async () => {
  const connected=await dispatch({type:'REPORT_CONNECT',auditId:'audit-1'},registeredReportSender);
  assert.deepEqual(Object.keys(connected).sort(),['auditId','ok','sessionCapabilityId','state']);
  assert.deepEqual({ok:connected.ok,auditId:connected.auditId,state:connected.state},{ok:true,auditId:'audit-1',state:'view-only'});
  assert.deepEqual((await reportConsumerFor(connected.sessionCapabilityId)).intents,['export']);
});

test('failed report navigation revokes ownership and removes only its allocated tab', async () => {
  chrome.tabs.updateError=new Error('private native text');
  await assert.rejects(() => openRegisteredReport(validOpen),/REPORT_OPEN_FAILED/u);
  assert.deepEqual(calls.removedTabIds,[allocatedReportTabId]);
  assert.equal((await reportLaunchFor('audit-1')).state,'revoked');
  assert.doesNotMatch(JSON.stringify({logs,diagnostics}),/private native text/u);
});

test('authorized export ignores UI projection and rebuilds one revision for four formats', async () => {
  await dispatch({type:'REPORT_REQUEST_EXPORT',sessionCapabilityId:VALID_REVIEW_SESSION,auditId:'audit-1'},registeredReportSender);
  assert.equal(calls.buildReportView,1);
  assert.deepEqual(calls.formatRevisions,[1,1,1,1]);
  assert.equal(calls.uiModelAccepted,false);
  assert.deepEqual(calls.deliveryReceipt.formats.map(row => row.format),['html','pdf','csv','json']);
  for (const row of calls.deliveryReceipt.formats) assert.equal(row.sha256,await sha256Bytes(calls.formatBytes[row.format]));
});

test('allocates export ownership before a bearer-free URL and binds its first document', async () => {
  await dispatch({type:'REPORT_REQUEST_EXPORT',sessionCapabilityId:VALID_REVIEW_SESSION,auditId:'audit-1'},registeredReportSender);
  assert.deepEqual(calls.exportOrder.slice(0,3),['create-about-blank','write-export-launch','navigate-export']);
  assert.equal(calls.exportUrl,'chrome-extension://test/src/export/index.html?auditId=audit-1');
  assert.doesNotMatch(calls.exportUrl,/capability|lease|attempt|revision/iu);
  const connected=await dispatch({type:'EXPORT_CONNECT',auditId:'audit-1'},registeredExportSender);
  assert.deepEqual(Object.keys(connected).sort(),['attemptId','auditId','expectedRevision','ok','sessionCapabilityId']);
});

test('rejects forged export tab, duplicate connect and reload without repeating work', async () => {
  for (const sender of [wrongExportTab,wrongExportPath,wrongExportDocument,wrongExportWindow]) {
    assert.deepEqual(await dispatch({type:'EXPORT_CONNECT',auditId:'audit-1'},sender),{ok:false,code:'CONTEXT_DENIED'});
  }
  assert.deepEqual(await dispatch({type:'EXPORT_CONNECT',auditId:'audit-1'},registeredExportSender),{ok:false,code:'EXPORT_CONNECT_DENIED'});
  await simulateExportReload();
  assert.equal((await exportLaunchFor('audit-1')).state,'revoked');
  assert.equal(calls.downloadAttempts,1);
});
```

- [ ] **Step 2: Run report tests and confirm RED**

Run: `node --test test/review/report-view.test.js test/review/review-ui.test.js test/background/report-launch.test.js test/background/export-launch.test.js test/background/service-worker.test.js test/legal/consumer-basis.test.js test/export/export-page.test.js test/export/report-export.test.js test/export/export-controller.test.js test/report/html.test.js`

Expected: FAIL because report datasets, owned launch lifecycle, consolidated legal eligibility and export capability are incomplete.

- [ ] **Step 3: Implement projection and fixed official legal basis**

Projection functions are exact total functions: `projectExecutive(model,summary)`, `projectIssues(model,summary)`, `projectTechnicalEvidence(model)`, `projectReaderMaps(model)`, `projectMethodology(model)`, `projectExports(model)`, `projectMatrix(model)`, and `collectFilterOptions(model,summary)`. Each creates new arrays/records, sorts stable IDs and deep-freezes the result. Renderers consume only `ReportViewV1` and use exhaustive section keys.

Preserve exactly these two official sources; no third legal source is part of this contract:

```js
const CONSUMER_SOURCES=deepFreeze([
  {id:'br.cdc.law8078',publisher:'Câmara dos Deputados',title:'Lei nº 8.078/1990',url:'https://www2.camara.leg.br/legin/fed/lei/1990/lei-8078-11-setembro-1990-365086-normaatualizada-pl.html',verifiedAt:'2026-08-29'},
  {id:'br.decree2181.art12.ix.a',publisher:'Câmara dos Deputados',title:'Decreto nº 2.181/1997, art. 12, IX, “a”',url:'https://www2.camara.leg.br/legin/fed/decret/1997/decreto-2181-20-marco-1997-445015-normaatualizada-pe.html',verifiedAt:'2026-08-29'},
]);
export const CONSUMER_ACCESSIBILITY_FIXED_BASIS=deepFreeze({
  id:'br.consumer.accessibility.fixed.v1',version:'1',label:'Base consumerista padronizada para análise',
  sentencePrefix:'A referida desconformidade infringe o disposto nos arts. 7º, caput, 20, § 2º, e 39, VIII, da Lei nº 8.078/1990, c/c o art. 12, IX, “a”, do Decreto nº 2.181/1997',
  display:'Arts. 7º, caput, 20, § 2º, e 39, VIII, da Lei nº 8.078/1990, c/c art. 12, IX, “a”, do Decreto nº 2.181/1997.',
  qualification:'Referência normativa automatizada; não constitui conclusão automática de infração, responsabilidade, sanção, certificação jurídica ou dispensa de revisão humana.',
  sources:CONSUMER_SOURCES,
});
```

Eligibility requires official frozen ABNT item, matching occurrence/item graph and `displayOutcome:'failed'`. Original failure requires canonical `legalAnalysis.basisRef`; human failure requires a canonical decision for the occurrence with answer `não conforme`, evaluator, timestamp and note. `conforme`/unanswered/inapplicable/editorial returns `null`.

- [ ] **Step 4: Implement race-free report lifecycle and export dispatch**

Serialize report operations per audit. Derive `auditId/windowId` only from the authorized panel session. Create an active `about:blank` tab in that window, persist `allocated`, update to `chrome.runtime.getURL('src/review/index.html') + '?auditId=' + encodeURIComponent(auditId)`, then transition `awaiting-connection`. A failed update first CAS-revokes and then removes only the still-proven allocated tab; errors exposed outside the worker are fixed codes. `REPORT_CONNECT` retries a bounded 2 seconds only while state is allocated; it validates TAB/path/exactly-one-audit query/window/tab/document and CAS-binds the first document. Before focusing a connected record, query tab + `getContexts` and verify expiry/path/window/document. `tabs.onUpdated` resets to awaiting only for the same exact report URL/reload; another URL and `tabs.onRemoved` revoke launch and review session. Concurrent open returns/focuses the one proven tab.

`REPORT_REQUEST_EXPORT` first authorizes the connected review session and reserves `expectedRevision/attemptId` in the store, then creates an inactive `about:blank` tab, persists `ExportLaunchV1`, and navigates only to `/src/export/index.html?auditId=<id>`. `EXPORT_CONNECT` derives `EXPORT_SURFACE`, proves exact tab/window/path/query/first document, reauthorizes the source review session, CAS-connects the launch and issues `ExportSessionCapabilityV1`. The packaged export page uses only the returned job metadata to call the store/export controller, whose snapshot lease again enforces audit/revision/attempt. Marco 3 binds `EXPORT_COMPLETE` to this export session and re-reads the persisted terminal receipt. Tab removal, wrong navigation, timeout, reload after connection or source-session revocation CAS-revokes launch/session and prevents repeated downloads. No export authority appears in a URL or DOM dataset.

The registered review consumer has only `export`; it does not receive `open-report`, cancel or highlight in Marco 1. `REPORT_REQUEST_EXPORT` calls the internal rebuild described above. HTML/PDF consume the same `ReportViewV1`; CSV/JSON consume the same canonical model revision. Filters toggle only live DOM `hidden` state.

- [ ] **Step 5: Run report/export regression tests**

Run: `node --test test/review/report-view.test.js test/review/review-ui.test.js test/review/review-state.test.js test/background/report-launch.test.js test/background/export-launch.test.js test/background/service-worker.test.js test/legal/consumer-basis.test.js test/export/export-page.test.js test/export/report-export.test.js test/export/export-controller.test.js test/report/html.test.js`

Expected: PASS for all groups/datasets, independent projection, fixed two-source legal basis, early connect, concurrent open, stale tab/reload, authorized export and one revision across formats.

- [ ] **Step 6: Commit report and export**

```bash
git add src/review/report-view.js src/review/review.js src/review/index.html src/review/review.css src/background/report-launch.js src/background/export-launch.js src/background/worker-protocol.js src/background/service-worker.js src/export/index.html src/export/index.js src/core/legal/consumer-basis.js src/core/report/html.js src/export/report-export.js src/export/export-controller.js test/review/report-view.test.js test/review/review-ui.test.js test/background/report-launch.test.js test/background/export-launch.test.js test/background/worker-protocol.test.js test/background/service-worker.test.js test/export/export-page.test.js test/legal/consumer-basis.test.js test/report/html.test.js test/export/report-export.test.js test/export/export-controller.test.js
git commit -m "feat: authorize complete visual reports"
```

---

### Task 8: Real Chrome 116/current E2E, efficient gates and two reviews

**Files:**

- Create: `test/e2e/support/real-chrome.mjs`
- Create: `test/e2e/support/real-chrome.test.mjs`
- Create: `test/e2e/sidepanel-flow-mv3.test.mjs`
- Create: `artifacts/qa/marco-1/.gitkeep`
- Create: `docs/qa/2026-08-29-marco-1-painel-relatorio.md`
- Create: `docs/reviews/2026-08-29-marco-1-review-a.md`
- Create: `docs/reviews/2026-08-29-marco-1-review-b.md`
- Modify: `README.md`

**Interfaces:**

- `createCdpPipeTransport({readable,writable,maxFrameBytes})` reads/writes NUL-terminated UTF-8 JSON frames, rejects malformed/duplicate/oversized frames and defaults to 16 MiB. It never uses newline framing.
- `startFixtureServer(t,routes)` binds loopback on an OS-selected port, rejects non-Map routes and returns `{origin,close}` with idempotent cleanup.
- `launchUnpackedExtension(t,{extensionPath,startUrl,downloadDirectory?,viewport?,chromeBinary?,expectedMajor?,qaDirectory?})` returns `{extensionId,chromeProduct,downloadDirectory,browser,worker,startPage,openActionPopup,openExtensionPage,click,evaluate,waitForValue,pressKey,captureScreenshot,readAttribute,waitForSidePanel,waitForReport,runtimeContexts,identityOf,waitForFourDownloads,captureJourney,captureVisualComparison,close}`; cleanup is idempotent and removes only its own `mkdtemp` profile after canonical containment proof.
- Launch defaults are closed and validated, never guessed after process start: `viewport` defaults to `{width:1280,height:900}`; omitted `downloadDirectory` and `qaDirectory` become newly created nonsymlink children of that launch's owned `mkdtemp` run root; `chromeBinary` resolves in order from the explicit option, `AUDITA_E2E_CHROME`, then a frozen platform-specific list of absolute Chrome/Chrome-for-Testing paths; every candidate must `realpath`, be a regular executable file and be opened without a shell. `expectedMajor` resolves from the explicit positive safe integer, then decimal `AUDITA_EXPECT_CHROME_MAJOR`; when both are absent the probed product must still be Chrome major ≥116. A supplied directory must be a canonical nonsymlink directory under the test-owned temporary root or the explicit milestone QA root, otherwise launch fails before Chrome.
- The module exports named `click`, `evaluate`, `waitForValue`, `pressKey`, `pressShortcut`, `captureScreenshot` and `command` functions with the same implementations used by launch-result methods where present. This is a cumulative contract: later milestones may add named/result members but may not delete, rename or replace any existing member. `real-chrome.test.mjs` calls the explicit and default launch-option resolvers, asserts exact error codes for a symlink/non-executable/wrong major, and asserts every returned method is the identical exported implementation rather than a second CDP client.
- `pressShortcut(target,shortcut)` accepts either the validated Chrome shortcut grammar read from the packaged manifest or the single harness navigation chord `Shift+Tab`, and emits balanced `Input.dispatchKeyEvent` down/up events with the exact modifier bitmask; every other undeclared chord rejects. `openActionPopup()` uses it for `_execute_action` and proves exactly one `POPUP` context. `command(target,method,params={})` is the one raw CDP support primitive and validates target/method/plain params before forwarding on the target session. `openExtensionPage({path,query={}})` accepts only a frozen allowlist of packaged extension paths and a closed query schema with model IDs, never a capability/lease/token; it opens a real extension target and grants no production authority. `click()` uses `Runtime.evaluate({userGesture:true})`. `waitForSidePanel()` proves exactly one `SIDE_PANEL` via `chrome.runtime.getContexts`.
- `waitForReport({auditId})` rejects missing/extra arguments, validates the closed model-ID grammar, then requires exactly one `TAB` context whose parsed `documentUrl` has extension protocol/host, exact `/src/review/index.html`, no fragment/credentials, and exactly `?auditId=<auditId>`; bearer or any extra/duplicate query is rejected.
- `waitForFourDownloads({auditId})` returns four closed records `{format,mime,filename,downloadId,state:'complete',byteLength,sha256}` in canonical `html,pdf,csv,json` order after hashing the actual downloaded bytes and matching the persisted delivery receipt.
- `preserveQaRun({sourceDir,destinationRoot,chromeMajor,candidateCommit})` accepts a source canonical child of `tmpdir()` and a nonsymlink destination root exactly at `artifacts/qa/marco-1`. It validates every indexed file/hash, creates the previously absent directory `artifacts/qa/marco-1/${chromeMajor}/${candidateCommit}` without overwrite, copies explicit files, fsyncs, rehashes the copy and returns the artifact-index hash. An existing identical directory is reused read-only; a differing one fails.
- `readCandidateCommit(workspaceRoot)` invokes `git rev-parse HEAD` without a shell, requires 40 lowercase hex characters and rejects tracked changes with `git diff --quiet`. `captureVisualComparison` hashes actual/reference PNGs and creates a measured side-by-side PNG in Chrome; it records dimensions and hashes, never claims pixel equality.

- [ ] **Step 1: Write failing real-Chrome journey**

```js
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { launchUnpackedExtension, preserveQaRun, readCandidateCommit, startFixtureServer } from './support/real-chrome.mjs';

const workspaceRoot=fileURLToPath(new URL('../../',import.meta.url));
const e2eReady=typeof process.env.AUDITA_E2E_CHROME === 'string' && /^\d+$/u.test(process.env.AUDITA_EXPECT_CHROME_MAJOR ?? '');

async function createSafeRunDirectories(t) {
  const canonicalTmp=await realpath(tmpdir());
  const runRoot=await mkdtemp(join(tmpdir(),'audita-marco-1-'));
  const canonicalRoot=await realpath(runRoot);
  const allowedPrefix=`${canonicalTmp}${sep}`;
  if (!canonicalRoot.startsWith(allowedPrefix)) throw new Error('UNSAFE_QA_DIRECTORY');
  const downloadDirectory=join(canonicalRoot,'downloads');
  const qaDirectory=join(canonicalRoot,'qa');
  await mkdir(downloadDirectory);
  await mkdir(qaDirectory);
  t.after(async () => {
    const checked=await realpath(canonicalRoot);
    if (dirname(checked) !== canonicalTmp || !basename(checked).startsWith('audita-marco-1-')) throw new Error('UNSAFE_QA_CLEANUP');
    await rm(checked,{recursive:true,force:false});
  });
  return {downloadDirectory,qaDirectory};
}

test('real popup panel detail report and export preserve the attached page',{skip:e2eReady?false:'Chrome E2E configurado somente nos gates explícitos'},async t => {
  assert.match(process.env.AUDITA_QA_PRESERVE ?? '',/^[01]$/u);
  const {downloadDirectory,qaDirectory}=await createSafeRunDirectories(t);
  const failureRoute={status:200,headers:{'content-type':'text/html; charset=utf-8'},body:'<!doctype html><html lang="pt-BR"><title>Fixture</title><body><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><button>Continuar</button></body></html>'};
  const fixture=await startFixtureServer(t,new Map([['/',failureRoute]]));
  const extension=await launchUnpackedExtension(t,{extensionPath:workspaceRoot,startUrl:fixture.origin,downloadDirectory,viewport:{width:1280,height:900},chromeBinary:process.env.AUDITA_E2E_CHROME,expectedMajor:Number(process.env.AUDITA_EXPECT_CHROME_MAJOR),qaDirectory});
  const before=await extension.identityOf(extension.startPage);
  const popup=await extension.openActionPopup();
  assert.equal((await extension.runtimeContexts({contextTypes:['POPUP']})).length,1);
  await extension.captureJourney('popup',popup);
  await extension.click(popup,'button[data-action="audit-current-page"]');
  const panel=await extension.waitForSidePanel();
  assert.equal((await extension.runtimeContexts({contextTypes:['SIDE_PANEL']})).length,1);
  await extension.waitForValue(panel,'document.body.dataset.screen',value => value === 'result',30_000);
  const auditId=await extension.readAttribute(panel,'[data-audit-id]','data-audit-id');
  assert.match(auditId,/^[A-Za-z0-9_-]{1,160}$/u);
  await extension.captureJourney('panel-summary',panel);
  await extension.click(panel,'button[data-action="open-occurrence"]');
  await extension.captureJourney('panel-detail',panel);
  await extension.click(panel,'button[data-action="consult-evidence"]');
  await extension.click(panel,'button[data-action="open-report"]');
  const report=await extension.waitForReport({auditId});
  await extension.captureJourney('report',report);
  await extension.click(report,'button[data-action="export-all"]');
  const downloads=await extension.waitForFourDownloads({auditId});
  assert.deepEqual(downloads.map(row => row.format),['html','pdf','csv','json']);
  assert.deepEqual(await extension.identityOf(extension.startPage),before);
  await extension.captureVisualComparison({actual:'panel-summary.png',reference:join(workspaceRoot,'docs/superpowers/specs/assets/2026-08-29-sidepanel-option-2.png'),output:'panel-reference-side-by-side.png'});
  if (process.env.AUDITA_QA_PRESERVE === '1') {
    const candidateCommit=await readCandidateCommit(workspaceRoot);
    await preserveQaRun({sourceDir:qaDirectory,destinationRoot:join(workspaceRoot,'artifacts/qa/marco-1'),chromeMajor:Number(process.env.AUDITA_EXPECT_CHROME_MAJOR),candidateCommit});
  }
});
```

- [ ] **Step 2: Run E2E and confirm RED on current Chrome**

Run: `AUDITA_E2E_CHROME="$AUDITA_CHROME_CURRENT" AUDITA_EXPECT_CHROME_MAJOR="$AUDITA_CURRENT_MAJOR" AUDITA_QA_PRESERVE="0" node --test test/e2e/sidepanel-flow-mv3.test.mjs`

Expected: FAIL until the NUL CDP transport and complete UI journey are integrated.

- [ ] **Step 3: Implement real-Chrome support**

Launch Chrome with `--remote-debugging-pipe`, fresh explicit `--user-data-dir`, `--disable-extensions-except=${canonicalExtensionPath}`, `--load-extension=${canonicalExtensionPath}`, deterministic viewport and configured download directory. Pipe parser accumulates chunks, splits byte `0x00`, enforces 16 MiB before JSON parse and resolves monotonically numbered pending requests. `close()` caches one promise, closes CDP/process/server handles, validates the profile still lies under `tmpdir()` and removes only that directory.

All wait helpers poll immediately then at 50 ms with fixed timeout. Target lookup correlates `getContexts().documentId/documentUrl/contextType` to one CDP target; it never uses prefix matching alone. QA starts in `mkdtemp`, hashes the selected visual reference at `docs/superpowers/specs/assets/2026-08-29-sidepanel-option-2.png`, creates a side-by-side PNG and preserves only an indexed run. The E2E asserts final audit ID/session state, nonzero verified coverage denominator, one real failure card, evidence fallback, 146 matrix rows, no capability in URL/storage visible to UI, four export downloads and unchanged attached target ID/URL/document identity.

- [ ] **Step 4: Prove GREEN on current Chrome, check the diff and commit the candidate**

Run: `node --test test/e2e/support/real-chrome.test.mjs`

Expected: PASS for NUL framing, timeouts, exact report URL, temp containment, hash/index validation and idempotent cleanup.

Run: `AUDITA_E2E_CHROME="$AUDITA_CHROME_CURRENT" AUDITA_EXPECT_CHROME_MAJOR="$AUDITA_CURRENT_MAJOR" AUDITA_QA_PRESERVE="0" node --test test/e2e/sidepanel-flow-mv3.test.mjs`

Expected: PASS for the complete journey without preserving pre-candidate artifacts.

Run: `git diff --check`

Expected: no output.

```bash
git add test/e2e/support/real-chrome.mjs test/e2e/support/real-chrome.test.mjs test/e2e/sidepanel-flow-mv3.test.mjs artifacts/qa/marco-1/.gitkeep README.md
git commit -m "test: prove the side panel journey in Chrome"
```

- [ ] **Step 5: Run Chrome 116 and current candidate gates separately**

Run: `AUDITA_E2E_CHROME="$AUDITA_CHROME_116" AUDITA_EXPECT_CHROME_MAJOR="116" AUDITA_QA_PRESERVE="1" node --test test/e2e/sidepanel-flow-mv3.test.mjs`

Expected: PASS and a validated indexed run under `artifacts/qa/marco-1/116/${candidateCommit}/`, where the directory name equals the 40-character commit read by the helper.

Run: `AUDITA_E2E_CHROME="$AUDITA_CHROME_CURRENT" AUDITA_EXPECT_CHROME_MAJOR="$AUDITA_CURRENT_MAJOR" AUDITA_QA_PRESERVE="1" node --test test/e2e/sidepanel-flow-mv3.test.mjs`

Expected: PASS and a validated indexed run under `artifacts/qa/marco-1/${AUDITA_CURRENT_MAJOR}/${candidateCommit}/`, with both values recorded in the index.

- [ ] **Step 6: Run the suite once and the nonduplicating verifier**

Run: `npm test`

Expected: PASS for the complete suite once at milestone closure.

Run: `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify`

Expected: PASS for manifest/CSP, local axe, neutral identity, normative inventory, report security and secret/remote-code scan without rerunning the suite.

- [ ] **Step 7: Record QA measurements and candidate identity**

Write `docs/qa/2026-08-29-marco-1-painel-relatorio.md` from the two validated artifact indexes only: candidate commit, manifest SHA-256, Chrome products, fixture hash, commands, exact POPUP/SIDE_PANEL/TAB context records, audit ID, attached identity before/after, four byte-derived download hashes, screenshot/reference/side-by-side hashes and dimensions. Include the observed steps/result of a manual pinned/unpinned toolbar check because CDP cannot pin toolbar actions. Do not record a boolean without the command, selector, record or measurement that produced it.

- [ ] **Step 8: Complete two independent critical reviews on the same Marco 1 candidate**

Reviewer A writes `docs/reviews/2026-08-29-marco-1-review-a.md`; Reviewer B, a distinct reviewer working independently, writes `docs/reviews/2026-08-29-marco-1-review-b.md`. Each record has exact fields `reviewer`, `candidateCommit`, `manifestSha256`, `qaIndexSha256ByChrome`, `scope`, `commands`, `findings[{severity,file,line,evidence,requiredFix}]`, `verdict`, `reviewedAt`. Both inspect capability/session races, sender/path/port forgery, worker suspension, HMAC erasure, attached/disposable ownership, raw URL boundary, privacy decisions, checkpoint/coverage math, panel/report completeness, legal eligibility, registered report tab and real E2E. Any Critical/Important finding creates a focused RED test, invalidates both approvals and requires a new candidate commit plus Steps 5–8 again. Marco 4 performs two new reviews on its final release candidate and ZIP.

- [ ] **Step 9: Commit the immutable Marco 1 evidence**

```bash
git add artifacts/qa/marco-1 docs/qa/2026-08-29-marco-1-painel-relatorio.md docs/reviews/2026-08-29-marco-1-review-a.md docs/reviews/2026-08-29-marco-1-review-b.md
git commit -m "docs: record Marco 1 verification evidence"
```

## Final self-review gate

- [ ] Every public function named above has one producer file, exact input/output and at least one RED/GREEN test.
- [ ] No deferred marker, analogy in place of implementation, undefined product helper, raw URL/error handoff or permissive message schema remains.
- [ ] `PanelSummaryV1` separates core coverage pairs from all-engine checkKeys and `PanelDetailV1` supplies the ten ordered blocks.
- [ ] `buildReportView` copies all required datasets and export rebuilds from one validated model revision.
- [ ] Popup start, menu start and port bootstrap use the same atomic session path; SIDE_PANEL succeeds without `sender.tab`.
- [ ] Attached tabs are unchanged; disposable/report tabs have persisted ownership before navigation and verified cleanup/focus.
- [ ] Chrome 116/current, one full suite, nonduplicating verify and two same-candidate reviews are recorded with measured artifacts.
- [ ] Official legal sources remain only Lei nº 8.078/1990 and Decreto nº 2.181/1997 at the Câmara dos Deputados URLs above.
