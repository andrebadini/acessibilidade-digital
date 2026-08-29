# Marco 2 — Personas e destaque seguro Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar personas reversíveis e destaque visual seguro no fluxo já criado pelo Marco 1, sem permitir que a interface escolha o alvo e sem contaminar auditoria, evidência ou exportação.

**Architecture:** O service worker continua sendo a única autoridade. Uma fila serializada por documento coordena capability, lease de persona, limpeza de auxílios vivos e início da auditoria. Leases e bindings ficam em registros fechados de `chrome.storage.session`; toda ação reprova remetente, aba, janela, documento, prazo e digest HMAC antes de injetar no `documentId` autorizado. O popup apenas emite intenções opacas, o painel/relatório escolhem uma ocorrência do modelo validado, e os scripts injetados retornam somente dados serializáveis.

**Tech Stack:** JavaScript ESM, HTML/CSS locais, Chrome Extensions Manifest V3, Side Panel API Chrome 116+, `chrome.storage.session`, Chrome DevTools Protocol, Web Crypto, `SpeechSynthesis` e `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-29-fluxo-visual-painel-lateral-design.md`

**Depends on:** `docs/superpowers/plans/2026-08-29-marco-1-painel-relatorio.md` concluído e verificado.

## Global Constraints

- O Marco 1 é a autoridade para `src/panel/index.html`, abertura do side panel, menu de contexto, capability de alvo, capability de sessão, runner observado e suporte E2E Chrome real. Este plano estende esses contratos; não cria outro launcher, handler de menu, runner, caminho de painel ou suporte de navegador paralelo.
- Não criar `src/background/side-panel-launch.js`, não registrar um segundo `chrome.contextMenus.onClicked`, `chrome.runtime.onMessage`, `chrome.tabs.onUpdated` ou `chrome.tabs.onRemoved`, e não reintroduzir `chrome.action.onClicked`.
- O popup conserva `createPopupCapabilityClient({ chromeApi, now, renewSkewMs, requestIdFactory })`, `data-action="audit-current-page"` e a resposta correlacionada do Marco 1. Este marco apenas passa a consumir `personaCapabilityId` e acrescenta `consume(kind)` sem mudar a assinatura do construtor.
- UI nunca envia URL, `tabId`, `windowId`, `frameId`, `documentId`, seletor, `backendNodeId`, assinatura ou instante para autorizar persona/destaque. Somente IDs opacos e intenções fechadas atravessam o protocolo de UI.
- Relógio de segurança é sempre a função `now` injetada no worker/store. Nenhum `createdAt`, `explicitActionAt`, `expiresAt` ou TTL fornecido por mensagem é aceito.
- Há no máximo um owner de persona por `(tabId, documentId)` e um overlay de destaque por `tabId`. Toda mutação desses owners passa por um único registro serializado no worker.
- Ações explícitas bem-sucedidas de persona renovam o lease por 30 minutos; reidratação, recuperação do worker, inspeção e limpeza automática não renovam prazo.
- Iniciar auditoria de aba anexada exige, dentro da mesma exclusão por alvo: limpar destaque, limpar e revogar persona, confirmar ambos os cleanups, reprovar o documento e somente então reclamar a capability `start-audit`. Falha de limpeza impede claim e auditoria.
- O modelo `AuditModel V2`, a evidência histórica e os bytes HTML/PDF/CSV/JSON nunca recebem lease, binding, `tabId`, `documentId`, seletor vivo ou estado de overlay.
- `HighlightBindingV1` é transitório, fechado, profundamente congelado em memória, persistido apenas em `chrome.storage.session` confiável e expira sem renovação no menor valor entre fim da sessão e `createdAt + 30 minutos`.
- O worker configura e confirma `chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})` antes de criar capability, lease, binding ou chave; falha interrompe esses recursos. Conteúdo injetado nunca lê o storage.
- O digest de URL é exatamente o contrato do Marco 1: `hmac-sha256:<43 caracteres base64url>` sobre a URL canônica completa, incluindo query e fragmento, com chave aleatória mantida somente em `chrome.storage.session`. SHA-256 simples não satisfaz essa prova.
- Scripts de persona e destaque usam `chrome.scripting.executeScript({ target:{tabId,documentIds:[documentId]}, world:'ISOLATED', ... })`. `frameIds` pode aparecer somente como metadado observado/validado no resultado, nunca como substituto de `documentIds` na injeção autorizada.
- O protocolo rejeita propriedades extras, propriedades herdadas, tipos fora da união, strings acima do limite e combinações de estado inválidas. Falha é fechada e não produz fallback por seletor parecido.
- O overlay não altera atributo, classe, estilo, valor ou foco do elemento autoral. Personas alteram somente a experiência viva e devem limpar integralmente DOM, CSS, listeners, fala, timers e estado antes da auditoria.
- O Marco 2 continua em `no-pixels`. Capturas de elemento, página e mapa anotado permanecem responsabilidade do Marco 3; destaque é auxílio vivo e nunca é chamado de evidência histórica.
- Durante implementação, rodar somente testes focados. A suíte completa e `verify` rodam uma vez no fechamento do marco. As áreas críticas recebem duas revisões independentes e só passam com zero achado Critical ou Important.
- Tasks are sequential at shared-file boundaries. Documentation/review and new isolated test fixtures may run in parallel only when no two workers edit the same path.

---

## File structure and interfaces

| File | Responsibility |
|---|---|
| `src/popup/popup-state.js` | Cliente de capabilities do Marco 1, consumo separado e projeção do estado de persona. |
| `src/popup/popup.js` | Gestos reais de auditoria/persona e reidratação do popup. |
| `src/background/worker-protocol.js` | Envelopes fechados de persona, destaque, limpeza e invalidação interna. |
| `src/background/target-operation-queue.js` | Exclusão serial por `(tabId, documentId)` compartilhada por persona, destaque e auditoria. |
| `src/background/persona-lease-store.js` | Registro fechado `PersonaLeaseRegistryV1` em `storage.session`, FSM e relógio interno. |
| `src/background/persona-coordinator.js` | Claim, set-mode, stop, rehydrate, revoke, rollback, recuperação e expiração. |
| `src/background/persona-start-orchestrator.js` | Claim/rehydrate de capability de persona sob a mesma fila usada pela auditoria. |
| `src/background/persona-runtime.js` | Singleton do coordenador e adaptador de injeção por `documentIds`. |
| `src/background/persona-controller.js` | Compatibilidade fina para chamadas legadas; não registra listeners nem mantém segunda FSM. |
| `src/personas/content.js` | Factory local já existente de leitor, acromatopsia, motor e cleanup. |
| `src/personas/persona-command.js` | Ponte autocontida/serializável para instalar, inspecionar e limpar o factory no documento autorizado. |
| `src/background/live-aid-cleanup.js` | Barreira ordenada `highlight → persona → reprobe → audit claim`. |
| `src/background/highlight-locator.js` | Parser/gerador `CSSSelectorV1` e `StructuralSignatureV1`. |
| `src/background/highlight-model-authority.js` | Carrega e valida snapshot imutável de modelo/revisão/hash para bindings e ações. |
| `src/background/highlight-binding.js` | Schema fechado, construção e validação modelo–ocorrência–evidência. |
| `src/background/highlight-binding-store.js` | Binding/overlay registry serializado em `storage.session`. |
| `src/background/highlight-live-verifier.js` | Reprova aba, janela, documento, HMAC, seletor, nó CDP e assinatura. |
| `src/background/highlight-controller.js` | Autoriza sessão, resolve ocorrência interna, injeta, limpa e invalida overlay. |
| `src/browser/highlight-overlay.js` | Função autocontida de overlay completo, idempotente e reversível. |
| `src/background/chrome-adapter.js` | Provas CDP/DOM e injeção exata por `documentIds`. |
| `src/background/authorized-audit-starter.js` | Único starter do Marco 1, estendido para início attached sob fila comum e barreira de cleanup antes do claim atômico. |
| `src/background/service-worker.js` | Único owner dos listeners Chrome e roteamento dos novos comandos. |
| `src/panel/highlight-action.js` | Projeção pura da ação destaque/evidência/limpeza. |
| `src/panel/panel.js` | Ações acessíveis no detalhe do resultado. |
| `src/review/report-view.js` | Intenções vivas no relatório local; exportações continuam estáticas. |
| `test/personas/*` | FSM, runtime, rollback, recuperação, TTL e limpeza. |
| `test/highlight/*` | Parser, binding, store, live verifier, overlay e controller. |
| `test/e2e/persona-highlight-flow-mv3.test.mjs` | Jornada real popup → personas → auditoria → detalhe → destaque → evidências. |

```text
// src/background/persona-lease-store.js
export function createPersonaLeaseStore({ sessionArea, now, randomBytes });
// .claimPrepared({ target, consumer, mode })
// .activate({ leaseId, expectedRevision })
// .beginSetMode({ leaseId, consumer, mode })
// .commitSetMode({ leaseId, expectedRevision })
// .rollbackSetMode({ leaseId, expectedRevision })
// .beginStop({ leaseId, consumer, explicit })
// .completeStop({ leaseId, expectedRevision, explicit })
// .rehydrate({ target, consumer })
// .revoke({ leaseId, reason })
// .findOwner(target), .snapshot(), .listRecoverable(), .listExpired()

// src/background/persona-coordinator.js
export function createPersonaCoordinator({ leaseStore, targetQueue, personaRuntime, probeDocument, scheduleExpiry });
// .claimLocked({ target, consumer, mode, lock })
// .setMode({ leaseId, consumer, mode })
// .stop({ leaseId, consumer, explicit:true })
// .rehydrateLocked({ target, consumer, lock })
// .revokeTargetLocked({ target, reason, lock })
// .recover(), .expireDue(), .invalidateTab(tabId,reason), .invalidateWindow(windowId,reason)

// src/background/persona-start-orchestrator.js
export function createPersonaStartOrchestrator({ targetAuthority, targetQueue, personaCoordinator });
// .start({capabilityId,mode,sender,consumer}), .rehydrate({capabilityId,sender,consumer})

// src/background/persona-runtime.js
export function createPersonaInjectionRuntime({ chromeApi });
// .apply({target,op,mode})

// src/personas/persona-command.js
export function applyAuditaPersonaCommand(command, environment = globalThis);

// src/background/live-aid-cleanup.js
export function createLiveAidCleanup({ highlightCleaner, personaCoordinator, targetQueue });
// .clearForAuditLocked({target,lock})
export function createAbsentHighlightCleaner({ sessionArea, targetQueue });
// .clearForTargetLocked(target,reason,lock)

// src/background/authorized-audit-starter.js
// createAuthorizedAuditStarter permanece o único owner de claim, sessão, bootstrap e runner.
// O Marco 2 injeta targetQueue e cleanupBarrier e mantém a assinatura pública exata:
// .beginAuthorizedAudit({capabilityId,eventNonce,auditId,capturePolicy,retentionPreference,senderContext})

// src/background/target-operation-queue.js
export function createTargetOperationQueue();
// .withTarget({ tabId, documentId }, lock => operation(lock)), .assertHeld(lock,target)

// src/background/highlight-locator.js
export function classifySelectorToken(value);
export function parseCssSelectorV1(value);
export function canonicalPath(element, { scopeRoot, maxSegments });
export function selectorMatchesOne(scopeRoot, selector, expectedElement);
export function roleForStructuralSignature(element);
export async function createStructuralSignatureV1({ documentId, frameId, element, scopeRoot, subtle });
export async function structuralSignatureMatches(expected, input);

// src/background/highlight-binding.js
export function createHighlightBindingV1(input);
export function validateHighlightBindingV1(input);
export function assertBindingMatchesModel({ binding, snapshot });
export function recordHighlightBindingV1({ snapshot, observedTarget, chromeAdapter, digestManager, now });

// src/background/highlight-binding-store.js
export function createHighlightBindingStore({ sessionArea, now });
// .put(binding), .findTarget({auditId,occurrenceId,expectedModelRevision,expectedModelHash}), .deleteAudit(auditId)
// .beginOverlay(record), .activateOverlay({tabId,nonce,expectedRevision})
// .beginOverlayClear({tabId,nonce,expectedRevision}), .completeOverlayClear({tabId,nonce,expectedRevision})
// .getActiveOverlay(tabId), .listRecoverableOverlays(), .invalidateTab(tabId), .snapshot()

// src/background/highlight-model-authority.js
export function createHighlightModelAuthority({ auditStore });
// .loadValidated({auditId}) -> {model,modelRevision,modelHash}

// src/background/highlight-live-verifier.js
export function createHighlightLiveVerifier({ chromeApi, chromeAdapter, digestManager, now });
// .verify({binding,target}) -> {ok:true,tabId,windowId,documentId,frameId}|{ok:false,reason}

// src/background/highlight-controller.js
export function createHighlightController({ chromeApi, sessionAuthority, modelAuthority, bindingStore, liveVerifier, targetQueue, now, randomBytes });
// .availability({sessionCapabilityId,auditId,occurrenceId,sender})
// .highlight({sessionCapabilityId,auditId,occurrenceId,sender})
// .clear({sessionCapabilityId,auditId,sender})
// .clearForTargetLocked(target,reason,lock), .clearAudit(auditId,reason)
// .invalidateContent({message,sender}), .invalidateTab(tabId,reason), .recover(), .expireDue()

// src/browser/highlight-overlay.js
export async function runAuditaHighlightCommand(command, environment = globalThis);

// src/panel/highlight-action.js
export function highlightActionForOccurrence({ occurrence, bindingStatus, activeOccurrenceId });
```

### Closed records

`PersonaLeaseV1` has exactly:

```text
{
  version: 1,
  leaseId,
  target: { tabId, windowId, documentId, urlSessionDigest },
  consumer: { extensionId, documentId, path, windowId },
  activeMode: null | 'reader' | 'achromatopsia' | 'motor',
  pendingMode: null | 'reader' | 'achromatopsia' | 'motor',
  createdAt,
  lastExplicitActionAt,
  expiresAt,
  state: 'prepared' | 'active' | 'stopping' | 'revoked',
  revision,
  revokeReason: null | 'expired' | 'navigation' | 'tab-removed' | 'window-changed' | 'audit-start' | 'runtime-failure' | 'recovery'
}
```

`PersonaLeaseRegistryV1` is one storage value at `audita:persona-leases:v1` and has exactly `{version:1,leases,ownerByTarget}`. `ownerByTarget` maps the internal key `${tabId}\u0000${documentId}` to one `leaseId`; a single `sessionArea.set()` persists each complete transition.

`HighlightBindingV1` has exactly:

```text
{
  version: 1,
  auditId,
  pageId,
  modelRevision,
  modelHash,
  tabId,
  windowId,
  topDocumentId,
  topUrlEvidence,
  topUrlSessionDigest,
  createdAt,
  expiresAt,
  locatorVersion: 'CSSSelectorV1+StructuralSignatureV1',
  targets: {
    [occurrenceId]: {
      documentId,
      frameId,
      backendNodeId,
      evidenceId,
      selector: { syntax: 'CSSSelectorV1', value, byteLength, complexity },
      structuralSignature: { version: 'StructuralSignatureV1', sha256 },
      rectBucket: null | { x, y, width, height }
    }
  }
}
```

`HighlightBindingRegistryV1` is one storage value at `audita:highlight-bindings:v1` and has exactly `{version:1,bindingsByAuditPage,activeOverlayByTab}`. An active overlay record has exactly `{version:1,tabId,windowId,topDocumentId,documentId,frameId,nonce,auditId,occurrenceId,createdAt,expiresAt,state:'installing'|'active'|'clearing',revision}`. Every persona/audit/highlight operation for the tab serializes on `(tabId, topDocumentId)`; `documentId` is only the exact frame receiving overlay injection.

---

## Task 1: Extend the Marco 1 popup and close the UI protocol

**Risk:** Medium, with security-critical message validation.

**Files:**

- Modify: `src/popup/popup-state.js`
- Modify: `src/popup/popup.js`
- Modify: `src/popup/index.html`
- Modify: `src/popup/popup.css`
- Modify: `src/background/worker-protocol.js`
- Modify: `src/background/target-capabilities.js`
- Modify: `src/background/service-worker.js`
- Modify: `test/popup/popup-state.test.js`
- Modify: `test/background/worker-protocol.test.js`
- Modify: `test/background/service-worker.test.js`
- Modify: `test/extension-shell.test.js`

**Interfaces and protocol:**

- Preserve `PREPARE_POPUP_CAPABILITIES {type,requestId}` and its exact Marco 1 response `{ok:true,requestId,auditCapabilityId,personaCapabilityId,windowId,expiresAt}`. The client validates `ok === true` and every exact key, then omits `ok` from its in-memory `current()` capability state.
- Extend the existing client with `.consume('audit'|'persona')`. It nulls only the selected capability in the in-memory frozen state; `.prepare()` and `.renewIfNeeded()` still replace both after a fresh worker proof.
- UI persona messages are exactly:
  - `POPUP_START_PERSONA {type,capabilityId,mode}`;
  - `PERSONA_SET_MODE {type,leaseId,mode}`;
  - `PERSONA_STOP {type,leaseId}`;
  - `PERSONA_REHYDRATE {type,capabilityId}`.
- UI highlight messages are exactly:
  - `GET_HIGHLIGHT_AVAILABILITY {type,sessionCapabilityId,auditId,occurrenceId}`;
  - `HIGHLIGHT_OCCURRENCE {type,sessionCapabilityId,auditId,occurrenceId}`;
  - `CLEAR_HIGHLIGHT {type,sessionCapabilityId,auditId}`.
- No envelope accepts target coordinates or timestamps. `mode` is exactly `reader|achromatopsia|motor`. Opaque IDs keep the Marco 1 rule: 20–240 printable base64url-style characters beginning with an ASCII letter. Audit/occurrence IDs are 1–160 characters from the already accepted Marco 1 alphabet.
- Success responses expose only JSON-safe data: `{ok:true,lease:{leaseId,activeMode,expiresAt}}`, `{ok:true,lease:null}`, `{ok:true,bindingStatus:{state:'available'}}`, `{ok:true,bindingStatus:{state:'unavailable',reason}}`, `{ok:true,highlight:{state:'active',occurrenceId}}` or `{ok:true,highlight:{state:'clear'}}`. Availability `reason` uses the closed Task 7 union. Errors are exact `{ok:false,code}` with a closed code union and no raw exception, selector, URL or Chrome ID.

The new branch error-code union is exactly `PERSONA_NOT_FOUND|PERSONA_EXPIRED|PERSONA_CONFLICT|PERSONA_RUNTIME_FAILED|PERSONA_CLEANUP_UNCONFIRMED|PERSONA_REVOKED_AFTER_RUNTIME_FAILURE|SESSION_INTENT_DENIED|AUDIT_MODEL_INVALID|HIGHLIGHT_UNAVAILABLE|HIGHLIGHT_EXPIRED|HIGHLIGHT_DOCUMENT_CHANGED|HIGHLIGHT_WINDOW_CHANGED|HIGHLIGHT_URL_CHANGED|HIGHLIGHT_TARGET_CHANGED|HIGHLIGHT_TARGET_INACCESSIBLE|HIGHLIGHT_RUNTIME_FAILED|HIGHLIGHT_CLEANUP_UNCONFIRMED|HIGHLIGHT_INVALIDATION_DENIED`; the inherited Marco 1 invalid-context/capability codes remain unchanged. Popup, panel and report validate exact own response keys and union members and discard an entire response/event with an extra, inherited or invalid field.

- [ ] **Step 1: Write failing popup and closed-schema tests**

```js
test('consumes persona without discarding the prepared audit capability', async () => {
  const client = createPopupCapabilityClient({
    chromeApi, now: () => 0, renewSkewMs: 10_000, requestIdFactory: () => 'request-1',
  });
  await client.prepare();
  client.consume('persona');
  assert.deepEqual(client.current(), {
    requestId: 'request-1', auditCapabilityId: 'cap-audit', personaCapabilityId: null,
    windowId: 3, expiresAt: 60_000,
  });
});

test('accepts only the four exact persona envelopes', () => {
  assert.deepEqual(parseWorkerMessage({
    type: 'POPUP_START_PERSONA', capabilityId: VALID_CAPABILITY, mode: 'reader',
  }), { type: 'POPUP_START_PERSONA', capabilityId: VALID_CAPABILITY, mode: 'reader' });
  assert.equal(parseWorkerMessage({
    type: 'PERSONA_SET_MODE', leaseId: VALID_LEASE, mode: 'motor', tabId: 7,
  }), null);
  assert.equal(parseWorkerMessage({
    type: 'PERSONA_STOP', leaseId: VALID_LEASE, explicitActionAt: 123,
  }), null);
});

test('rejects selector and target fields in highlight requests', () => {
  assert.deepEqual(parseWorkerMessage({
    type: 'GET_HIGHLIGHT_AVAILABILITY', sessionCapabilityId: VALID_SESSION,
    auditId: 'audit-1', occurrenceId: 'occ-1',
  }), {
    type: 'GET_HIGHLIGHT_AVAILABILITY', sessionCapabilityId: VALID_SESSION,
    auditId: 'audit-1', occurrenceId: 'occ-1',
  });
  assert.equal(parseWorkerMessage({
    type: 'GET_HIGHLIGHT_AVAILABILITY', sessionCapabilityId: VALID_SESSION,
    auditId: 'audit-1', occurrenceId: 'occ-1', frameId: 0,
  }), null);
  assert.equal(parseWorkerMessage({
    type: 'HIGHLIGHT_OCCURRENCE', sessionCapabilityId: VALID_SESSION,
    auditId: 'audit-1', occurrenceId: 'occ-1', selector: '#forged',
  }), null);
  assert.equal(parseWorkerMessage({
    type: 'CLEAR_HIGHLIGHT', sessionCapabilityId: VALID_SESSION,
    auditId: 'audit-1', documentId: 'forged',
  }), null);
});
```

`VALID_CAPABILITY`, `VALID_LEASE` and `VALID_SESSION` are fixed 24-character base64url test constants declared at the top of `test/background/worker-protocol.test.js`; tests do not call the real authority to fabricate them.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test test/popup/popup-state.test.js test/background/worker-protocol.test.js test/background/service-worker.test.js test/extension-shell.test.js`

Expected: FAIL because persona is still unavailable, `consume` is absent and the new envelopes are not recognized.

- [ ] **Step 3: Implement exact validators and popup projection**

Extend the schema table used by the existing `parseWorkerMessage`; do not add a second parser or listener. The helper contract in `worker-protocol.js` is complete:

```js
const PERSONA_MODES = new Set(['reader', 'achromatopsia', 'motor']);
const OPAQUE_ID = /^[A-Za-z][A-Za-z0-9_-]{19,239}$/u;

function isOpaqueId(value) {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

function isPersonaMode(value) {
  return typeof value === 'string' && PERSONA_MODES.has(value);
}
```

Extend the existing frozen `MESSAGE_SCHEMAS` using its Marco 1 exact-key comparison, `isRecordId`, `isOpaqueId` and 4,096-byte guard; do not introduce a parallel key/parser implementation. Each branch validates every field and `parseWorkerMessage` returns a fresh frozen plain object. As in Marco 1, an unknown type, inherited field or failed validator returns `null`; the single dispatcher maps that to its fixed invalid-message response without side effect.

In `popup-state.js`, implement `consume` by creating a new frozen object, never mutating the response. In `popup.js`, startup is:

1. `prepare()`;
2. consume the prepared persona capability and send `PERSONA_REHYDRATE`;
3. render the returned lease without extending its TTL;
4. call `prepare()` again so the next explicit start has a fresh one-use persona capability.

The first persona gesture sends `POPUP_START_PERSONA`. Subsequent switches send `PERSONA_SET_MODE`; clicking the active mode sends `PERSONA_STOP`. Every handler disables only its control while pending and restores it in `finally`. The audit handler keeps the Marco 1 ordering: `openSidePanelFromGesture()` is invoked synchronously before any await and still uses `data-action="audit-current-page"`.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/popup/popup-state.test.js test/background/worker-protocol.test.js test/background/service-worker.test.js test/extension-shell.test.js`

Expected: PASS; envelopes with any extra field fail, popup rehydration consumes a fresh persona capability without extending a lease, and the audit gesture keeps the Marco 1 selector/order.

- [ ] **Step 5: Commit the protocol boundary**

```bash
git add src/popup/popup-state.js src/popup/popup.js src/popup/index.html src/popup/popup.css src/background/worker-protocol.js src/background/service-worker.js test/popup/popup-state.test.js test/background/worker-protocol.test.js test/background/service-worker.test.js test/extension-shell.test.js
git commit -m "feat: close persona and highlight intents"
```

## Task 2: Implement the serialized PersonaLease FSM

**Risk:** Critical.

**Files:**

- Create: `src/background/target-operation-queue.js`
- Create: `src/background/persona-lease-store.js`
- Create: `test/personas/persona-lease-store.test.js`
- Create: `test/background/target-operation-queue.test.js`

**State graph:**

```text
no owner --claimPrepared--> prepared --activate--> active(mode)
active(mode) --beginSetMode--> active(mode,pending) --commitSetMode--> active(new mode)
active(mode,pending) --rollbackSetMode--> active(mode)
active(mode|null) --beginStop(explicit:true)--> stopping --completeStop--> active(null)
prepared|active(mode,pending?) --beginStop(explicit:false)--> stopping
active(mode|null) --rehydrate--> active(same mode, new consumer, same expiry)
prepared|active|stopping --revoke--> revoked + owner removed
```

`claimPrepared`, `commitSetMode` and an explicit successful `completeStop` obtain `actionAt = now()` internally and set `expiresAt = actionAt + 30 * 60_000`. `activate` preserves the time established by `claimPrepared`. `beginStop(explicit:false)`, `rehydrate`, recovery, inspection and automatic cleanup preserve the existing timestamps. An explicit `beginStop` requires the exact consumer and an active lease; the worker-internal non-explicit form requires `consumer:null`, accepts `prepared|active|stopping`, clears `pendingMode`, and leaves a recoverable `stopping` owner until absence is confirmed. All transitions require exact `leaseId`, `revision`, state and consumer where applicable.

- [ ] **Step 1: Write failing FSM, race and clock tests**

```js
test('serializes concurrent claims to one owner per document', async () => {
  const store = createPersonaLeaseStore({ sessionArea, now, randomBytes });
  const [left, right] = await Promise.all([
    store.claimPrepared({ target, consumer: popupA, mode: 'reader' }),
    store.claimPrepared({ target, consumer: popupA, mode: 'motor' }),
  ]);
  assert.equal([left, right].filter(result => result.ok).length, 1);
  const snapshot = await store.snapshot();
  assert.equal(Object.keys(snapshot.ownerByTarget).length, 1);
  assert.equal(Object.values(snapshot.ownerByTarget)[0], [left, right].find(result => result.ok).lease.leaseId);
});

test('uses only the injected clock and rehydrate does not renew', async () => {
  clock.value = 1_000;
  const prepared = await store.claimPrepared({ target, consumer: popupA, mode: 'reader' });
  const active = await store.activate({ leaseId: prepared.lease.leaseId, expectedRevision: prepared.lease.revision });
  assert.equal(active.lease.expiresAt, 1_801_000);
  clock.value = 900_000;
  const rehydrated = await store.rehydrate({ target, consumer: popupB });
  assert.equal(rehydrated.lease.expiresAt, 1_801_000);
  assert.equal(rehydrated.lease.lastExplicitActionAt, 1_000);
});

test('rolls back a pending mode without renewing or changing the active mode', async () => {
  const changing = await store.beginSetMode({ leaseId, consumer: popupA, mode: 'motor' });
  clock.value += 20_000;
  const restored = await store.rollbackSetMode({ leaseId, expectedRevision: changing.lease.revision });
  assert.equal(restored.lease.activeMode, 'reader');
  assert.equal(restored.lease.pendingMode, null);
  assert.equal(restored.lease.expiresAt, originalExpiry);
});

test('recovery can identify prepared and stopping records after suspension', async () => {
  assert.deepEqual((await store.listRecoverable()).map(value => value.state).sort(), ['prepared', 'stopping']);
});

test('lock token is exact to one target and one operation lifetime', async () => {
  let captured;
  await targetQueue.withTarget(target, lock => {
    captured = lock;
    assert.doesNotThrow(() => targetQueue.assertHeld(lock, target));
    assert.throws(() => targetQueue.assertHeld(lock, otherTarget), /lock inválido/iu);
  });
  assert.throws(() => targetQueue.assertHeld(captured, target), /lock inválido/iu);
  assert.throws(() => targetQueue.assertHeld(Object.freeze({}), target), /lock inválido/iu);
});
```

`now` in tests is `() => clock.value`; `randomBytes` returns distinct deterministic 16-byte arrays. Test fixtures `target`, `popupA` and `popupB` use the exact closed shapes declared above.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test test/personas/persona-lease-store.test.js test/background/target-operation-queue.test.js`

Expected: FAIL because neither module exists.

- [ ] **Step 3: Implement one registry and one serial queue**

`createPersonaLeaseStore` is constructed only after the worker confirms trusted-context-only session storage and owns one promise tail. Every public mutation appends to it, loads the single registry, validates it, computes a fresh registry and persists it with one `sessionArea.set()` call. Reads return `structuredClone` followed by recursive freeze. The complete local helpers are:

```js
const REGISTRY_KEY = 'audita:persona-leases:v1';
const MODES = new Set(['reader', 'achromatopsia', 'motor']);
const TTL_MS = 30 * 60_000;

function targetKey(target) {
  return `${target.tabId}\u0000${target.documentId}`;
}

function cloneFrozen(value) {
  const clone = structuredClone(value);
  const freeze = current => {
    if (!current || typeof current !== 'object' || Object.isFrozen(current)) return current;
    Object.freeze(current);
    for (const nested of Object.values(current)) freeze(nested);
    return current;
  };
  return freeze(clone);
}

function newRegistry() {
  return { version: 1, leases: Object.create(null), ownerByTarget: Object.create(null) };
}

function encodeLeaseId(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 16) throw new TypeError('Entropia insuficiente.');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `lease-${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`;
}
```

The module also defines `assertExactLease`, `assertExactRegistry`, `assertTarget`, `assertConsumer` and `assertTransition`; each checks exact own keys, integer Chrome IDs, bounded document/path/digest strings, the HMAC prefix, mode/state unions, monotonic timestamps and `ownerByTarget` consistency. Malformed persisted state is not repaired in place: `snapshot()` throws `PERSONA_REGISTRY_INVALID`; the coordinator will perform conservative cleanup and replace it with `newRegistry()` only after cleanup succeeds.

`createTargetOperationQueue()` keeps `Map<targetKey, Promise>` plus a private `WeakMap` of active lock objects. `withTarget(target, operation)` validates positive integer `tabId`, bounded `documentId` and function `operation`, chains both resolve/reject paths, creates one frozen lock after the predecessor settles, registers it only for the duration of `await operation(lock)`, and deletes the map entry only if it still points to that tail. `assertHeld(lock,target)` requires object identity and the exact derived target key; every locked coordinator/cleanup method calls it first. The queue never accepts a UI-provided key or lock.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/personas/persona-lease-store.test.js test/background/target-operation-queue.test.js`

Expected: PASS for concurrent ownership, every legal/illegal transition, internal clock, expiry, deep freeze, malformed storage and recovery enumeration.

- [ ] **Step 5: Commit the FSM**

```bash
git add src/background/target-operation-queue.js src/background/persona-lease-store.js test/personas/persona-lease-store.test.js test/background/target-operation-queue.test.js
git commit -m "feat: serialize persona lease ownership"
```

## Task 3: Coordinate persona runtime, rollback, recovery and audit cleanup

**Risk:** Critical.

**Files:**

- Create: `src/background/persona-coordinator.js`
- Create: `src/background/persona-start-orchestrator.js`
- Create: `src/background/live-aid-cleanup.js`
- Modify: `src/background/authorized-audit-starter.js`
- Modify: `src/background/persona-runtime.js`
- Modify: `src/background/persona-controller.js`
- Modify: `src/personas/content.js`
- Create: `src/personas/persona-command.js`
- Modify: `src/personas/personas.css`
- Modify: `src/personas/screen-reader-module.js`
- Modify: `src/background/target-capabilities.js`
- Modify: `src/background/service-worker.js`
- Modify: `test/personas/persona-controller.test.js`
- Modify: `test/personas/persona-runtime.test.js`
- Modify: `test/personas/content.test.js`
- Create: `test/personas/persona-coordinator.test.js`
- Create: `test/personas/persona-start-orchestrator.test.js`
- Modify: `test/background/authorized-audit-starter.test.js`
- Modify: `test/background/service-worker.test.js`

**Runtime contract:**

`personaRuntime.apply({target,op,mode})` accepts a trusted target `{tabId,windowId,documentId,urlSessionDigest}` and `op:'install'|'inspect'|'clear'`. `mode` is required only for install. It first runs the self-contained bridge probe in `target:{tabId,documentIds:[documentId]}`. Install injects, in this order, `src/core/accessibility/accessible-preview-runtime.classic.js`, `src/personas/screen-reader-module.js` and `src/personas/content.js` only when that probe reports the namespace absent; it then inserts `src/personas/personas.css` with `origin:'AUTHOR'` by the same `documentIds` and invokes `applyAuditaPersonaCommand`. Inspect/clear never install a missing runtime; missing means inactive. Clear removes that exact CSS file with the same target/origin. It returns only:

```text
{ ok: true, documentId, frameId, mode: null | 'reader' | 'achromatopsia' | 'motor' }
// or
{ ok: false, reason: 'document-missing' | 'result-mismatch' | 'runtime-error' | 'cleanup-unconfirmed' }
```

It requires exactly one `InjectionResult`, exact `documentId`, safe integer `frameId === 0` for the top document and an exact JSON-safe result. It never returns a disposer/function through Chrome messaging.

`applyAuditaPersonaCommand(command, environment = globalThis)` in `src/personas/persona-command.js` is self-contained for `executeScript`. Its command schemas are exactly `{version:1,op:'probe'}`, `{version:1,op:'install',mode}`, `{version:1,op:'inspect'}` and `{version:1,op:'clear'}`. Probe returns exactly `{ok:true,present:boolean,mode:null|'reader'|'achromatopsia'|'motor'}`; install/inspect/clear return exactly `{ok:true,mode:null|'reader'|'achromatopsia'|'motor'}` or `{ok:false,reason}`, with `reason` exactly `invalid-command|runtime-missing|runtime-brand-mismatch|runtime-error|cleanup-unconfirmed`. It resolves only `Symbol.for('audita.accessible-preview.runtime.v1')`, requires the frozen local namespace brand/version, obtains or creates its existing content singleton, and stores only bridge correlation at `environment.__auditaPersonaV1`. It never calls `installMessaging` and therefore adds no content-message listener. The registered local runtime implements:

- `reader`: class `audita-persona-reader`, owned curtain/caption, focus traversal observation and the existing local-only `screen-reader-module.js`; no accessibility claim and no interception of Tab;
- `achromatopsia`: class `audita-persona-achromatopsia` applying grayscale through the injected local CSS;
- `motor`: class `audita-persona-motor` plus capture listeners for pointer/mouse/click/contextmenu that prevent page interaction while leaving keyboard events intact;
- owned DOM is marked `data-audita-persona-owned="audita-accessible-preview-v1"`; the document root ownership marker is `data-audita-persona-root="audita-accessible-preview-v1"`;
- every switch calls the previous mode disposer first;
- clear cancels owned speech, removes owned curtain/labels/classes/attributes, removes every listener with the same reference/options, clears timers/observers and bridge state; `personaRuntime` then calls `removeCSS` for the exact local file/document and confirms with `inspect`;
- install/inspect/clear return only `{ok:true,mode}` or `{ok:false,reason}`.

- [ ] **Step 1: Write failing coordinator and cleanup-order tests**

```js
test('claims, installs and activates; injection failure clears and revokes', async () => {
  runtime.queue.push({ ok: false, reason: 'runtime-error' }, { ok: true, mode: null, documentId: target.documentId, frameId: 0 });
  const result = await targetQueue.withTarget(target, lock => coordinator.claimLocked({ target, consumer, mode: 'reader', lock }));
  assert.deepEqual(result, { ok: false, code: 'PERSONA_RUNTIME_FAILED' });
  assert.deepEqual(runtime.calls.map(call => call.op), ['install', 'clear']);
  assert.equal(await leaseStore.findOwner(target), null);
});

test('set-mode failure restores the prior mode or revokes when restoration fails', async () => {
  runtime.queue.push(
    { ok: false, reason: 'runtime-error' },
    { ok: false, reason: 'cleanup-unconfirmed' },
    { ok: true, mode: null, documentId: target.documentId, frameId: 0 },
  );
  const result = await coordinator.setMode({ leaseId, consumer, mode: 'motor' });
  assert.deepEqual(result, { ok: false, code: 'PERSONA_REVOKED_AFTER_RUNTIME_FAILURE' });
  assert.deepEqual(runtime.calls.map(call => [call.op, call.mode ?? null]), [
    ['install', 'motor'], ['install', 'reader'], ['clear', null],
  ]);
});

test('rehydrates only the same live document and never changes expiry', async () => {
  const before = await leaseStore.findOwner(target);
  const result = await targetQueue.withTarget(target, lock => coordinator.rehydrateLocked({ target, consumer: reopenedPopup, lock }));
  assert.equal(result.ok, true);
  assert.equal(result.lease.expiresAt, before.expiresAt);
  assert.equal(runtime.calls.at(-1).op, 'inspect');
});

test('keeps a stopping owner when two cleanup attempts cannot confirm absence', async () => {
  runtime.queue.push(
    { ok:false, reason:'cleanup-unconfirmed' },
    { ok:false, reason:'cleanup-unconfirmed' },
  );
  const result = await coordinator.stop({ leaseId, consumer, explicit:true });
  assert.deepEqual(result, {ok:false,code:'PERSONA_CLEANUP_UNCONFIRMED'});
  assert.equal((await leaseStore.findOwner(target)).state, 'stopping');
});

test('cleans live aids before audit claim and never audits after cleanup failure', async () => {
  const trace = [];
  const starter = authorizedAuditStarterFixture({
    targetAuthority: fakeAuthority(trace), targetQueue,
    cleanupBarrier: fakeCleanupBarrier(trace, { ok: false, code: 'PERSONA_CLEANUP_UNCONFIRMED' }),
    startRunner: async () => { trace.push('start-runner'); },
  });
  const result = await starter.beginAuthorizedAudit({
    capabilityId: CAPABILITY, eventNonce: null, auditId: 'audit-1', capturePolicy,
    retentionPreference:{version:1,deleteAfterCompleteExport:false}, senderContext: sender,
  });
  assert.deepEqual(result, {
    response: { ok: false, code: 'PERSONA_CLEANUP_UNCONFIRMED' },
    sessionCapabilityId: null, completion: null,
  });
  assert.deepEqual(trace, ['inspect', 'lock', 'clear-highlight', 'clear-persona']);
  for (const forbidden of ['claim-and-session','persist-retention','write-bootstrap','register-job','start-runner']) {
    assert.equal(trace.includes(forbidden), false);
  }
});

test('successful audit preserves the sole atomic starter after pristine cleanup', async () => {
  const result = await starter.beginAuthorizedAudit({
    capabilityId: CAPABILITY, eventNonce: null, auditId: 'audit-1', capturePolicy,
    retentionPreference:{version:1,deleteAfterCompleteExport:false}, senderContext: sender,
  });
  assert.deepEqual(result.response, { ok: true, auditId: 'audit-1' });
  assert.deepEqual(trace, [
    'inspect', 'lock', 'clear-highlight', 'clear-persona', 'cleanup-confirmed',
    'reprobe', 'claim-and-session', 'persist-retention', 'write-bootstrap', 'register-job', 'start-runner',
  ]);
});

test('persona start and attached audit cannot cross after target inspection', async () => {
  const persona = personaStart.start({capabilityId:PERSONA_CAPABILITY,mode:'reader',sender,consumer});
  const audit = starter.beginAuthorizedAudit({
    capabilityId:AUDIT_CAPABILITY,eventNonce:null,auditId:'audit-1',capturePolicy,
    retentionPreference:{version:1,deleteAfterCompleteExport:false},senderContext:sender,
  });
  await Promise.all([persona,audit]);
  assert.equal(trace.includes('audit-during-persona-install'), false);
  assert.equal(trace.includes('persona-install-during-audit'), false);
  assert.equal(maxConcurrentTargetOperations, 1);
});

test('navigation removal and window movement clear and revoke matching owners', async () => {
  await coordinator.invalidateTab(target.tabId, 'navigation');
  assert.equal((await leaseStore.findOwner(target)), null);
  assert.deepEqual(runtime.calls.at(-1).op, 'clear');
  await activateFixtureLease({target: movedTarget});
  await coordinator.invalidateWindow(movedTarget.windowId, 'window-changed');
  assert.equal((await leaseStore.findOwner(movedTarget)), null);
});
```

Fakes are local test objects with the exact interfaces declared in this task. `activateFixtureLease({target})` is a test-only helper declared in `persona-coordinator.test.js`; it performs `claimPrepared` and `activate` with the fixed consumer. `capturePolicy` is the frozen Marco 1 `no-pixels` fixture.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test test/personas/persona-coordinator.test.js test/personas/persona-start-orchestrator.test.js test/personas/persona-runtime.test.js test/personas/content.test.js test/background/authorized-audit-starter.test.js test/background/service-worker.test.js`

Expected: FAIL because coordinator, serialized cleanup barrier and attached-audit orchestrator do not exist.

- [ ] **Step 3: Implement coordinator transactions and recovery**

Queue ownership is explicit to avoid nested-lock deadlock. `setMode`, `stop`, `recover` and `expireDue` derive a target from the lease store and acquire `targetQueue.withTarget` internally, then reread the lease inside the lock. Capability-based start/rehydrate and audit already hold that same lock in their orchestrators and therefore call only the `*Locked` methods. Exact sequences are:

- `claimLocked`: verify the caller's target lock → reprobe target → `claimPrepared` → install mode → `activate`; on failure, enter `stopping`, clear the exact document and revoke only after confirmed absence. Unconfirmed cleanup retains the `stopping` owner and returns failure.
- `setMode`: load/validate owner+consumer → reprobe → `beginSetMode` → install new mode → `commitSetMode`; on failure, reinstall the prior mode and `rollbackSetMode`. If restoration is not confirmed, enter `stopping`, clear, and revoke only after confirmed absence; otherwise retain the recoverable owner and return failure.
- `stop`: load/validate owner+consumer → reprobe → `beginStop(explicit:true)` → clear → `completeStop(explicit:true)` only after confirmed absence. One failed clear triggers one second best-effort clear under the same lock; if both fail, the owner remains `stopping`, the call returns `PERSONA_CLEANUP_UNCONFIRMED`, and later audit remains blocked.
- `rehydrateLocked`: verify the target lock obtained for a newly consumed `start-persona` capability → load owner → reject expiry → reprobe tab/window/document/HMAC → inspect injected mode → require exact equality with stored `activeMode` → replace consumer via store without changing TTL. Missing/mismatched runtime is cleared and revoked.
- `revokeTargetLocked`: verify the caller's target lock, load the owner, call `beginStop(explicit:false)`, clear the exact document, and call `revoke` only after confirmed absence. If the document no longer exists, absence is confirmed; a live document that cannot confirm clear returns failure and keeps the `stopping` owner for recovery.
- `recover`: for each `prepared|stopping` record, first normalize it to `stopping`, then clear and revoke only after confirmed absence; for `active`, reprobe and inspect, preserving it only when owner/document/mode/expiry all match. A failed live cleanup retains `stopping`; recovery never installs or renews a mode.
- `expireDue`: under target lock, clear/revoke every expired owner. Schedule the nearest deadline with the existing worker-owned alarms listener and alarm name `audita-persona-expiry-v1`.
- `invalidateTab`/`invalidateWindow`: enumerate matching owners, acquire each target lock, clear when the document still exists and revoke. Missing removed tabs/documents count as absent; a live cleanup failure remains recoverable and blocks audit for that target.

`persona-controller.js` becomes a compatibility adapter that delegates its public methods to the coordinator. Remove its independent target map, proof registry, TTL and listener registration rather than keeping two owners. Preserve the existing hardened accessible-preview runtime, screen-reader factory and content factory; the new bridge calls them directly instead of duplicating accessible-name/speech logic. `persona-runtime.js` creates exactly one coordinator per Chrome realm and the service worker routes all commands through it.

`createPersonaStartOrchestrator` handles both capability-based paths. `start` performs inspect → target lock → fresh capability claim → `claimLocked({... ,lock})`. `rehydrate` performs inspect → target lock → fresh capability claim → `rehydrateLocked({... ,lock})`. A consumed capability is never restored after runtime failure. Because audit, start and rehydrate all use the same `targetQueue`, persona cannot install between audit cleanup and collector start.

For every persona message, the existing dispatcher calls `deriveTrustedExtensionContext` with allowed path `/src/popup/index.html` and constructs the exact consumer `{extensionId:chrome.runtime.id,documentId:issuer.documentId,path:issuer.path,windowId:derived.windowId}`. The message cannot provide or override any consumer field. `setMode` and `stop` require exact equality with the current lease consumer; a reopened popup must first complete capability-based rehydrate.

The existing service-worker-owned tab update/removal handlers delegate navigation/loading/removal to both target authority and persona invalidation. Add service-worker-owned `tabs.onDetached` and `windows.onRemoved` delegates only if the worker does not already register them; modules never register Chrome listeners themselves. Tab/window movement therefore revokes without waiting for another persona command.

- [ ] **Step 4: Extend target authority without trusting the UI**

Add worker-internal `inspectPrepared({capabilityId,intent,sender})`. It performs the same sender/path/window/intent/state/expiry/document/HMAC validation as `claim`, returns a recursively frozen target only to the caller in the worker, and does not mutate the record. `claim` repeats every check and probe; no inspection result is accepted as proof.

`createAuthorizedAuditStarter.beginAuthorizedAudit` remains the sole Marco 1 starter and, for an attached target, performs:

1. `inspectPrepared({intent:'start-audit'})`;
2. `targetQueue.withTarget(inspected.target, lock => ...)`;
3. `cleanupBarrier.clearForAuditLocked({target,lock})`, ordered highlight then persona;
4. fresh `probeDocument` inside `claim`;
5. the same Marco 1 atomic capability claim plus audit-session issue;
6. one-use panel bootstrap persistence and active-job registration;
7. Marco 1 `runObservedTabAudit` through the existing runner callback.

No second dispatcher or starter is introduced. The starter opens one `targetQueue.withTarget` operation and uses an internal deferred handshake: after atomic claim/session/bootstrap/job registration, it resolves the public start response while the queue callback continues awaiting `startRunner`. The public `completion` is derived from that still-held queue operation, never from an independently released runner promise. It resolves only after `runObservedTabAudit`, checkpoint/failure cleanup, Task 5 binding recording, result-state publication and lock release have all finished. Thus `beginAuthorizedAudit` remains promptly responsive without releasing the target lock between pristine cleanup, observation and creation of the live proof. It serializes only that document key and does not block other tabs/documents. Cleanup failure resolves the exact failed starter envelope tested above and performs no claim, session, bootstrap, job registration or runner start.

`createLiveAidCleanup({highlightCleaner,personaCoordinator,targetQueue})` defines `clearForAuditLocked({target,lock})`, verifies the target lock, calls `highlightCleaner.clearForTargetLocked(target,'audit-start',lock)` and then `personaCoordinator.revokeTargetLocked({target,reason:'audit-start',lock})`, returning success only after both report confirmed absence. Task 3 implements `createAbsentHighlightCleaner({sessionArea,targetQueue})`: while no highlight implementation exists, it verifies the same lock and returns `{ok:true,state:'absent'}` only when `audita:highlight-bindings:v1` is absent; any value under that key fails closed without interpretation. Task 6 removes this transitional export and wires `highlightController.clearForTargetLocked` into the same interface. No audit code imports overlay internals.

- [ ] **Step 5: Run focused persona and audit tests**

Run: `node --test test/personas/persona-lease-store.test.js test/personas/persona-coordinator.test.js test/personas/persona-start-orchestrator.test.js test/personas/persona-controller.test.js test/personas/persona-runtime.test.js test/personas/content.test.js test/background/target-capabilities.test.js test/background/authorized-audit-starter.test.js test/background/service-worker.test.js`

Expected: PASS; tests prove no second owner, internal time, successful rollback, failure revocation, recovery, expiry and confirmed cleanup before audit claim.

- [ ] **Step 6: Perform the first independent critical review**

Assign a reviewer who did not implement Tasks 2–3. Review exact state transitions, storage atomicity, sender/document proof, service-worker suspension, rollback, cleanup ordering and listener ownership. Record findings and evidence in `docs/qa/2026-08-29-marco-2-critical-review-a.md`. Resolve every Critical/Important finding and rerun the focused command from Step 5 before proceeding.

- [ ] **Step 7: Commit persona coordination**

```bash
git add src/background/persona-coordinator.js src/background/persona-start-orchestrator.js src/background/live-aid-cleanup.js src/background/authorized-audit-starter.js src/background/persona-runtime.js src/background/persona-controller.js src/personas/content.js src/personas/persona-command.js src/personas/personas.css src/personas/screen-reader-module.js src/background/target-capabilities.js src/background/service-worker.js test/personas test/background/authorized-audit-starter.test.js test/background/target-capabilities.test.js test/background/service-worker.test.js docs/qa/2026-08-29-marco-2-critical-review-a.md
git commit -m "feat: coordinate reversible personas before audit"
```

## Task 4: Implement conservative CSSSelectorV1 and StructuralSignatureV1

**Risk:** Critical.

**Files:**

- Create: `src/background/highlight-locator.js`
- Create: `test/highlight/highlight-locator.test.js`

**CSSSelectorV1 grammar:**

```text
selector := segment (" > " segment){0,15}
segment  := tag id? class{0,2} enumAttribute? nth?
id       := "#" safeToken
class    := "." safeToken
enumAttribute := "[role=\"" allowedRole "\"]" | "[type=\"" allowedType "\"]"
nth      := ":nth-of-type(" positiveInteger ")"
```

- `tag` is lowercase ASCII `/^[a-z][a-z0-9-]{0,62}$/`.
- `allowedRole` is the frozen set `alert|button|checkbox|dialog|heading|img|link|list|listitem|main|menu|menuitem|navigation|option|radio|region|search|slider|spinbutton|status|switch|tab|tabpanel|textbox`.
- `allowedType` is the frozen set `button|checkbox|email|file|number|password|radio|range|reset|search|submit|tel|text|url`.
- `safeToken` is 1–23 ASCII characters matching `/^-?[_A-Za-z][_A-Za-z0-9-]*$/`; it is rejected by the exact sensitive detector `/(?:pass(?:word|wd)?|token|secret|auth(?:orization)?|session|cookie|csrf|xsrf|otp|one[-_]?time|api[-_]?key)/iu`, by `/@|:\/\/|www\./iu`, by four consecutive decimal digits, by eight consecutive hexadecimal digits or by a UUID-shaped substring.
- The unanchored UUID-shaped detector is `/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/iu`; therefore every version nibble is conservative and `cliente-550e8400-e29b-41d4-a716-446655440000-final` is rejected even though the UUID is embedded.
- Backslash escapes, commas, whitespace other than the exact child separator, `*`, arbitrary attributes, selector lists, pseudo-elements, `:has`, `:is`, `:not`, shadow-piercing tokens and empty segments are rejected.
- UTF-8 length is at most 2,048 bytes. Cost is tag/id/class = 1 each, enumerated attribute = 2, `nth-of-type` = 3, child combinator = 1; total above 64 rejects before any DOM query.

**Canonical record constructed internally for StructuralSignatureV1:**

```text
{
  version: 'StructuralSignatureInputV1',
  documentId,
  frameId,
  tag,
  computedRole: null | allowedRole,
  ancestry: [
    { tag, nthOfType, attributes: [{ name: 'role' | 'type', valueSha256 }] }
  ]
}
```

The public constructor receives exactly `{documentId,frameId,element,scopeRoot,subtle}` and constructs the record above; no caller supplies `tag`, `computedRole` or `ancestry`. The list starts at the target and ends at the declared injection scope. It contains at most 16 entries, every `nthOfType` is a positive safe integer, attribute values enter only as SHA-256 after the same non-sensitive classification, and canonical bytes use the existing `canonicalStringify`. `computedRole` is produced locally by `roleForStructuralSignature(element)`: first valid explicit role token from the frozen allowed-role set, otherwise a closed native mapping for `a[href]`, `area[href]`, `button`, `input[type]`, `select`, `textarea`, `img`, `nav`, `main`, `ul|ol`, `li`, `h1`–`h6` and `dialog`, otherwise `null`. It never trusts a caller-supplied role. `StructuralSignatureV1` is exactly `{version:'StructuralSignatureV1',sha256:<64 lowercase hex>}`. Name, text, URL, raw `id`, raw class and accessible name never enter the signature.

- [ ] **Step 1: Write failing parser, generator and signature tests**

```js
test('rejects embedded UUID and long opaque selector tokens', () => {
  assert.equal(classifySelectorToken('primary-navigation'), true);
  assert.equal(classifySelectorToken('cliente-550e8400-e29b-41d4-a716-446655440000-final'), false);
  assert.equal(classifySelectorToken('session_Az19kLm28Qr74Ty92Bx50'), false);
  assert.throws(() => parseCssSelectorV1('button.cliente-550e8400-e29b-41d4-a716-446655440000-final'), /token sensível/iu);
});

test('parses the closed grammar and recomputes deterministic cost', () => {
  const parsed = parseCssSelectorV1('main > button.primary[type="button"]:nth-of-type(2)');
  assert.equal(parsed.syntax, 'CSSSelectorV1');
  assert.equal(parsed.byteLength, 51);
  assert.equal(parsed.complexity, 9);
  assert.equal(Object.isFrozen(parsed.segments), true);
});

test('canonicalPath reaches the declared root or rejects instead of truncating', () => {
  assert.equal(canonicalPath(button, { scopeRoot: document, maxSegments: 16 }).value, 'html > body > main > button');
  assert.throws(() => canonicalPath(deepButton, { scopeRoot: document, maxSegments: 16 }), /escopo não alcançado/iu);
  assert.throws(() => canonicalPath(detachedButton, { scopeRoot: document, maxSegments: 16 }), /escopo não alcançado/iu);
});

test('selector must resolve exactly the expected element', () => {
  assert.equal(selectorMatchesOne(document, 'button#unique', uniqueButton), true);
  assert.equal(selectorMatchesOne(document, 'button.duplicate', uniqueButton), false);
  assert.equal(selectorMatchesOne(document, 'button#other', uniqueButton), false);
});

test('signature changes on document, frame, node or ancestry replacement', async () => {
  const original = await createStructuralSignatureV1(signatureInput);
  assert.equal(await structuralSignatureMatches(original, signatureInput), true);
  assert.equal(await structuralSignatureMatches(original, {...signatureInput, documentId:'doc-reload'}), false);
  assert.equal(await structuralSignatureMatches(original, {...signatureInput, frameId:4}), false);
  assert.equal(await structuralSignatureMatches(original, {...signatureInput, element:replacement}), false);
});
```

The DOM fixture implements only standards used by the module: `tagName`, `parentElement`, `children`, `getRootNode`, `getAttribute`, `matches` and `querySelectorAll`. `TextEncoder` determines the asserted byte count; update the literal only if the exact fixture string changes.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test test/highlight/highlight-locator.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the parser before querying DOM**

`parseCssSelectorV1` first validates primitive string and UTF-8 limit, then runs UUID/sensitive scans over each complete raw id/class candidate before applying the 23-character limit, rejects forbidden characters/tokens, splits only on exact ` > `, parses each segment with one anchored expression and validates every capture. It returns a recursively frozen exact object `{syntax:'CSSSelectorV1',value,byteLength,complexity,segments}`. `segments` is internal validation data and is not persisted in a binding.

`canonicalPath` walks from `element` to the explicit `scopeRoot`. For each element it emits a conservative segment and adds `:nth-of-type` whenever the shorter segment is not unique among same-tag siblings. The root is reached only when the next `parentNode` is exactly `scopeRoot`, or when there is no `parentElement` and `getRootNode() === scopeRoot` (the `Document` case). At 16 emitted segments it may return only when that root condition is already satisfied; otherwise it throws `Escopo não alcançado em CSSSelectorV1.` It also throws on cycle, detached node, different root, closed shadow root, forbidden token or final non-unique selector. It never returns a truncated suffix.

The implementation defines these private helpers in the same module: `isScopeRoot(node,scopeRoot)`, `parentWithinScope(node,scopeRoot)`, `tagToken(node)`, `nthOfType(node)`, `segmentFor(node)`, `exactQuery(scopeRoot,value)`, `canonicalSignatureInput(args)`, `sha256Hex(bytes,subtle)` and `deepFreezePlain(value)`. Each helper receives every dependency as an argument and no snippet relies on an undeclared global except web standards explicitly passed through public parameters.

`selectorMatchesOne` catches `DOMException` and returns false. `createStructuralSignatureV1` first computes the role through `roleForStructuralSignature`, builds the full ancestry and requires the scope root to be reached; then hashes canonical UTF-8 bytes. `structuralSignatureMatches` validates the expected closed object, recomputes through `createStructuralSignatureV1` and performs constant-length byte comparison rather than string-prefix comparison. A parity test passes the same fixture through the module and the self-contained overlay signature routine so their native-role maps cannot drift.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/highlight/highlight-locator.test.js`

Expected: PASS for valid grammar, every forbidden construct, byte/cost boundary, embedded UUID, root reachability, uniqueness, deep freeze and signature mutation.

- [ ] **Step 5: Commit locator primitives**

```bash
git add src/background/highlight-locator.js test/highlight/highlight-locator.test.js
git commit -m "feat: add conservative live target locators"
```

## Task 5: Bind a validated model occurrence to transient live evidence

**Risk:** Critical.

**Files:**

- Create: `src/background/highlight-model-authority.js`
- Create: `src/background/highlight-binding.js`
- Create: `src/background/highlight-binding-store.js`
- Modify: `src/background/chrome-adapter.js`
- Modify: `src/background/observed-tab-runner.js`
- Modify: `src/background/service-worker.js`
- Create: `test/highlight/highlight-model-authority.test.js`
- Create: `test/highlight/highlight-binding.test.js`
- Create: `test/highlight/highlight-binding-store.test.js`
- Modify: `test/background/chrome-adapter.test.js`
- Modify: `test/background/observed-tab-runner.test.js`

**Model authority:**

`createHighlightModelAuthority({auditStore}).loadValidated({auditId})` calls the existing `auditStore.getAuditSnapshot(auditId)`, requires a positive `snapshot.revision`, validates `snapshot.model` through `createAuditModel`, then calls the existing `verifyAuditIntegritySnapshot` and requires its complete `integrity.canonicalModelHash`. It returns recursively frozen `{model:verifiedModel,modelRevision:snapshot.revision,modelHash:verifiedModel.integrity.canonicalModelHash}`; the store's private snapshot capability is not copied. `modelHash` is 64 lowercase hex. Missing, malformed, pending-integrity, stale or hash-divergent data returns a closed failure to the controller; unvalidated model objects never reach binding logic.

**Binding construction:**

`createHighlightBindingV1(input)` accepts only worker-owned input and returns a recursively frozen closed record. It recomputes selector byte length/complexity with `parseCssSelectorV1`, validates the exact `/^hmac-sha256:[A-Za-z0-9_-]{43}$/u` digest, validates all timestamps/limits, rejects extra nested fields and bounds `targets` to 5,000 entries. It accepts only `createdAt <= expiresAt <= createdAt + 30 * 60_000`.

`validateHighlightBindingV1(input)` returns a newly reconstructed/deeply frozen canonical binding or throws fixed `TypeError('HighlightBindingV1 inválido.')`; `createHighlightBindingV1` delegates to it. The recorder, not UI, calls `now()` once and supplies `createdAt/expiresAt` to that constructor. `assertBindingMatchesModel` returns the canonical binding on success and throws fixed `TypeError('Relação modelo-evidência inválida.')` on mismatch. `recordHighlightBindingV1` returns a binding with at least one target or `null` when no candidate survives proof; it never emits an empty/partially unvalidated record.

`rectBucket`, when present, contains signed safe integers quantized to 16 CSS px and bounded to ±1,000,000 for `x|y|width|height`; negative width/height reject. It is session-only diagnostic metadata and never breaks a tie or authorizes a node.

`assertBindingMatchesModel({binding,snapshot})` requires:

1. exact `auditId`, `modelRevision` and `modelHash`;
2. `pageId` exists in `model.pages` and its sanitized final URL equals `topUrlEvidence`;
3. each target key names one occurrence from the same page;
4. `evidenceId` exists, belongs to the same page, is present in that occurrence's `evidenceRefs`, is node-bearing and has the same `backendNodeId`;
5. the occurrence resolves to exactly one node-bearing evidence item; ambiguous evidence produces no binding;
6. selector, structural signature, document/frame and backend-node values pass the closed schemas; `rectBucket` is diagnostic only and is never consulted for authorization or fallback.

The relationship is rechecked on every read used for highlight, not only at store insertion.

**Live proof recording:**

After `runObservedTabAudit` returns a validated model but before its result session is exposed, `recordHighlightBindingV1({snapshot,observedTarget,chromeAdapter,digestManager,now})` selects only eligible element occurrences and asks `chromeAdapter.proveHighlightTargets({tabId,windowId,topDocumentId,candidates})`. Candidates contain model-derived `occurrenceId`, `evidenceId`, `backendNodeId` and parsed selector; no UI data participates.

The adapter uses the existing authorized CDP attachment to prove the backend node, resolve its current execution context, require a unique selector in the same document, obtain the Chrome `documentId` from an isolated-world probe, and compute `StructuralSignatureV1` in that document. The proof result is exactly `{occurrenceId,evidenceId,documentId,frameId,backendNodeId,selector,structuralSignature,rectBucket}`. Main and accessible child frames are allowed. Open/closed Shadow DOM, inaccessible frames, ambiguous selector, changed backend node or unmatched Chrome/CDP document identity produce no target rather than a weaker locator.

The recorder requires `observedTarget.urlSessionDigest === await digestManager.digest(currentTab.url)` and copies the sanitized `observedTarget.urlEvidence`; raw current URL is discarded immediately. Failure to create a live binding does not change the audit model and is projected as evidence-only availability.

- [ ] **Step 1: Write failing schema, model relation and storage tests**

```js
test('deep-freezes a closed binding and rejects SHA-256 in place of URL HMAC', () => {
  const binding = createHighlightBindingV1(validBindingInput);
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(Object.isFrozen(binding.targets['occ-1'].selector), true);
  assert.throws(() => createHighlightBindingV1({
    ...validBindingInput, topUrlSessionDigest: `sha256:${'a'.repeat(64)}`,
  }), /HMAC/iu);
  assert.throws(() => createHighlightBindingV1({
    ...validBindingInput, debugUrl: 'https://private.test/?token=x',
  }), /binding inválido/iu);
});

test('requires evidence to belong to the exact occurrence and page', () => {
  assert.doesNotThrow(() => assertBindingMatchesModel({ binding, snapshot }));
  assert.throws(() => assertBindingMatchesModel({
    binding: bindingWith({ evidenceId: 'evidence-from-other-occurrence' }), snapshot,
  }), /relação modelo-evidência/iu);
  assert.throws(() => assertBindingMatchesModel({
    binding: bindingWith({ pageId: 'page-2' }), snapshot,
  }), /relação modelo-evidência/iu);
});

test('rejects changed model revision or digest on every store read', async () => {
  await store.put(binding);
  assert.equal((await store.findTarget({ auditId:'audit-1', occurrenceId:'occ-1' })).binding.modelRevision, 4);
  await assert.rejects(
    () => store.findTarget({ auditId:'audit-1', occurrenceId:'occ-1', expectedModelRevision:5, expectedModelHash:'b'.repeat(64) }),
    /modelo divergente/iu,
  );
});

test('serializes active overlay ownership to one record per tab', async () => {
  const starts = await Promise.all([store.beginOverlay(overlayA), store.beginOverlay(overlayB)]);
  assert.equal(starts.filter(value => value.ok).length, 1);
  const active = await store.getActiveOverlay(7);
  assert.equal([overlayA.nonce, overlayB.nonce].includes(active.nonce), true);
  assert.equal(active.state, 'installing');
  assert.equal(Object.keys((await store.snapshot()).activeOverlayByTab).length, 1);
});

test('records only adapter proofs correlated to the validated model', async () => {
  const binding = await recordHighlightBindingV1({ snapshot, observedTarget, chromeAdapter, digestManager, now });
  assert.deepEqual(Object.keys(binding.targets), ['occ-1']);
  assert.equal(binding.targets['occ-1'].documentId, 'document-main');
  assert.equal(binding.targets['occ-1'].backendNodeId, 91);
});
```

`bindingWith` is a test-only immutable clone helper declared in the test file. Production modules never expose a mutation helper.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test test/highlight/highlight-model-authority.test.js test/highlight/highlight-binding.test.js test/highlight/highlight-binding-store.test.js test/background/chrome-adapter.test.js test/background/observed-tab-runner.test.js`

Expected: FAIL because binding authority/store/recorder and live target proof do not exist.

- [ ] **Step 3: Implement exact schema, deep freeze and serialized storage**

`highlight-binding.js` defines all validators locally: `hasExactOwnKeys`, `plainRecord`, `boundedId`, `positiveInteger`, `validHmacDigest`, `validSha256`, `validateSelectorRecord`, `validateSignatureRecord`, `validateRectBucket` and `deepFreezePlain`. `createHighlightBindingV1` reconstructs every nested object rather than freezing caller objects. Dynamic `targets` keys reject `__proto__|prototype|constructor`, are created with `Object.create(null)`, and are always accessed with `Object.hasOwn`; registry maps follow the same rule even after a storage round trip. The only exported construction functions are:

```text
export function createHighlightBindingV1(input);
export function validateHighlightBindingV1(input);
export function assertBindingMatchesModel({ binding, snapshot });
export async function recordHighlightBindingV1({ snapshot, observedTarget, chromeAdapter, digestManager, now });
```

`createHighlightBindingStore` owns one promise tail and one registry key. `put` validates/clones and returns the frozen stored binding. `findTarget` loads a fresh frozen record, checks expiry with its internal `now()`, requires expected revision/hash for controller calls and returns exactly `{binding,target}` or `null` for absent/expired occurrence. A malformed registry or revision/hash mismatch throws a fixed error and fails closed; it is never silently repaired. Expired well-formed bindings are removed from the fresh registry before returning `null`. Overlay and binding updates persist a complete registry with one `sessionArea.set()`. `beginOverlay` succeeds only when the tab has no owner and stores `installing`; `activateOverlay` requires exact nonce/revision and moves to `active`; `beginOverlayClear` moves the same owner to `clearing`; `completeOverlayClear` deletes only that exact nonce/revision after the caller confirms absence. None of these transitions renews `expiresAt`, and an unconfirmed cleanup record is never deleted.

Worker startup asks the store to purge expired bindings; Task 6 first clears every expired or recoverable overlay owner and only then removes its record. Existing tab navigation/removal and audit-deleted delegates call `invalidateTab`/`deleteAudit`; browser-session teardown naturally removes the session registry. A storage failure propagates to the existing deletion workflow, which keeps its standard `exclusão pendente` state; no new binding-specific retention state is invented.

`observed-tab-runner.js` preserves the complete Marco 1 `ObservedAuditResultV1` union, including `status`, `observationState` and `ownershipState`. The service-worker orchestration calls the recorder only for a variant carrying a validated model and observed target; no transient proof is added to `AuditModel V2` or the runner result. On successful recording it stores the binding before transitioning the existing audit session to `result` and publishing the result summary.

Do not change the exact Marco 1 `PanelSummaryV1` schema or reinterpret its aggregate `card.evidence.highlightAvailable` as proof for an individual occurrence. Panel/report ask the worker's read-only `GET_HIGHLIGHT_AVAILABILITY` with their authorized session and opaque occurrence ID when opening a detail. That query reloads the validated model and current binding, reruns `assertBindingMatchesModel`, checks model revision/hash and expiry, and returns only the closed safe `bindingStatus`; it performs no DOM injection and does not renew the binding. Static exports make no such query.

- [ ] **Step 4: Run focused binding tests**

Run: `node --test test/highlight/highlight-model-authority.test.js test/highlight/highlight-binding.test.js test/highlight/highlight-binding-store.test.js test/highlight/highlight-locator.test.js test/background/chrome-adapter.test.js test/background/observed-tab-runner.test.js test/background/service-worker.test.js`

Expected: PASS for closed keys, recursive freeze, HMAC format, expiry, revision/hash mismatch, evidence ownership, frame proof, one serialized active-overlay record per tab and unchanged model/runner contracts; no overlay DOM exists before Task 6.

- [ ] **Step 5: Commit binding authority**

```bash
git add src/background/highlight-model-authority.js src/background/highlight-binding.js src/background/highlight-binding-store.js src/background/chrome-adapter.js src/background/observed-tab-runner.js src/background/service-worker.js test/highlight test/background/chrome-adapter.test.js test/background/observed-tab-runner.test.js test/background/service-worker.test.js
git commit -m "feat: bind validated findings to live documents"
```

## Task 6: Revalidate and render one complete reversible overlay

**Risk:** Critical.

**Files:**

- Create: `src/background/highlight-live-verifier.js`
- Create: `src/background/highlight-controller.js`
- Create: `src/browser/highlight-overlay.js`
- Modify: `src/background/chrome-adapter.js`
- Modify: `src/background/live-aid-cleanup.js`
- Modify: `src/background/worker-protocol.js`
- Modify: `src/background/report-launch.js`
- Create: `src/background/report-port.js`
- Modify: `src/background/service-worker.js`
- Modify: `src/review/review.js`
- Create: `test/highlight/highlight-live-verifier.test.js`
- Create: `test/highlight/highlight-controller.test.js`
- Create: `test/highlight/highlight-overlay.test.js`
- Modify: `test/background/chrome-adapter.test.js`
- Modify: `test/background/worker-protocol.test.js`
- Modify: `test/background/report-launch.test.js`
- Create: `test/background/report-port.test.js`
- Modify: `test/background/target-capabilities.test.js`
- Modify: `test/background/service-worker.test.js`
- Modify: `test/background/authorized-audit-starter.test.js`
- Modify: `test/review/review-ui.test.js`

**Immediate proof sequence:**

The live report receives highlight authority without a bearer in its URL. Upgrade newly allocated trusted records to exact `ReportLaunchV2 = {version:2,auditId,tabId,windowId,path:'/src/review/index.html',documentId:null|string,state:'allocated'|'awaiting-connection'|'connected'|'revoked',issuedAt,expiresAt,sourceSessionCapabilityId,sourceSessionState:'result'|'view-only'}`. It preserves every Marco 1 state and invariant: `documentId` is `null` in `allocated|awaiting-connection`, nonempty in `connected`, and either prior value in terminal `revoked`. `PANEL_OPEN_REPORT` accepts an authorized source session in `result|view-only`, persists its opaque ID and exact state while the owned `about:blank` tab is still `allocated`, and follows the same navigation/CAS sequence from `ReportLaunchV1`.

`REPORT_CONNECT` validates registered tab/path/window and first `documentId`, then reauthorizes the exact `sourceSessionCapabilityId` before its one connection CAS. A revoked/expired/mismatched V2 source fails closed and issues no consumer. A still-current `result` source plus current binding issues intents `['export','highlight']` and response exactly `{ok:true,auditId,sessionCapabilityId,state:'result'}`; `view-only`, missing or stale binding issues only `['export']` and response state `view-only`. Persisted `ReportLaunchV1` records remain readable under their complete Marco 1 tab/path/window/document/expiry proof until terminal/expiry, issue only `['export']`, return `state:'view-only'`, and are never rewritten or augmented with a source ID. Unknown versions fail closed. Thus an upgrade does not strand a retained report, and a V1 record never gains highlight authority.

After successful report connection, `review.js` opens port `audita-report-v1` through the worker's existing single `runtime.onConnect` listener. Its first packet is exactly `{protocol:'audita-report',version:1,type:'hello',auditId,sessionCapabilityId}`; sender tab/path/window/document and report-consumer session must match. This port and the existing panel port may receive exact worker event `{version:1,type:'HIGHLIGHT_STATE_CHANGED',auditId,occurrenceId,state:'active'|'clear'}`. Unknown/extra event fields are ignored closed, and no nonce, selector or Chrome target leaves the worker.

`GET_HIGHLIGHT_AVAILABILITY` authorizes the same sender/session/audit with `intent:'highlight'`, reloads the validated model and binding, calls `findTarget` with the expected revision/hash, reruns `assertBindingMatchesModel`, checks `now() < expiresAt`, and returns only the exact Task 7 `bindingStatus`. It neither acquires a selector from UI nor injects/renews anything. A view-only report or missing/stale binding returns unavailable evidence state. `HIGHLIGHT_OCCURRENCE` repeats all of those checks and the complete live proof below, so availability is never treated as authorization.

For each `HIGHLIGHT_OCCURRENCE`, the controller performs, in this order:

1. parse the exact UI envelope;
2. `sessionAuthority.authorizeSession({sessionCapabilityId,auditId,intent:'highlight',sender})`, deriving the sender/window internally;
3. `modelAuthority.loadValidated({auditId})`;
4. `bindingStore.findTarget` with expected model revision/hash;
5. acquire `targetQueue.withTarget({tabId:binding.tabId,documentId:binding.topDocumentId}, ...)` and reread session/model/binding inside the lock;
6. `assertBindingMatchesModel` again;
7. require `now() < binding.expiresAt`;
8. `chrome.tabs.get(binding.tabId)` and require exact `windowId`, HTTP/HTTPS URL and non-discarded tab;
9. recompute complete URL HMAC and compare exact digest;
10. `chromeAdapter.verifyHighlightTarget` to require the same top document, target `documentId`, `frameId`, backend node, unique selector pointing to that node and structural signature;
11. clear any previous active overlay for the tab;
12. persist an `installing` owner with exact nonce/revision and binding expiry;
13. inject by the verified `documentId` and validate the single serializable result;
14. transition that exact owner to `active`; on failure, enter `clearing`, clear, and remove only after confirmed absence.

Any mismatch stops before install, invalidates the stale binding target and returns an evidence-only reason. Reload at the same URL fails on `documentId`. SPA replacement fails on backend node/signature. Multiple matches, inaccessible frame and open/closed Shadow DOM fail without fallback.

Extend the Marco 1 internal authorization result, not its request: `authorizeSession({sessionCapabilityId,auditId,intent,sender})` returns frozen `{ok:true,session:{auditId,windowId,state,intents}}` after deriving the sender/window itself. It never accepts a caller-supplied `windowId` and the dispatcher never forwards this internal session record to UI.

**Injection command:**

Install is exactly:

```text
{
  version: 1,
  op: 'install',
  nonce,
  documentId,
  frameId,
  selector,
  structuralSignature,
  kind: 'failed' | 'manual',
  markerNumber
}
```

Clear is exactly `{version:1,op:'clear',nonce}`. `markerNumber` is an integer 1–5,000 derived from the occurrence's stable position in the validated model. `selector` and signature come only from the internal binding. The injected function validates exact keys again, queries exactly once, recomputes the structural signature using Web Crypto before creating DOM, and returns only `{ok:true,nonce}` or `{ok:false,reason}`, where `reason` is exactly `invalid-command|target-not-unique|signature-mismatch|target-not-rendered|nonce-mismatch|runtime-error`. Clear of an already absent matching state is idempotent success; a different active nonce is `nonce-mismatch`.

`chromeAdapter.injectHighlight({tabId,documentId,command})` calls:

```js
chromeApi.scripting.executeScript({
  target: { tabId, documentIds: [documentId] },
  world: 'ISOLATED',
  func: runAuditaHighlightCommand,
  args: [command],
});
```

It requires exactly one result, `result.documentId === documentId`, safe integer `result.frameId` equal to the verified frame and a result with exact own keys. No function, DOM node, Error or disposer crosses the Chrome boundary.

**Overlay behavior:**

- one extension-owned fixed root appended to `document.documentElement`, with `pointer-events:none`, `aria-hidden="true"`, `tabIndex=-1` and no interactive descendant;
- target is scrolled with `{block:'center',inline:'nearest'}` but never focused or mutated;
- confirmed failure: 6 CSS px solid `#8b1e1e`, visible marker `×`, number and text `Falha confirmada`;
- human review: 5 CSS px dashed `#6b4e00`, visible marker `?`, number and text `Revisão humana necessária`;
- geometry updates on captured `scroll` and `resize`; zero-sized/disconnected target disposes;
- `Escape` disposes; `pagehide` disposes; `MutationObserver` only tests that the same target remains connected and uniquely selected, then disposes on invalidation; it never relocates;
- disposer removes root, observers, `scroll`, `resize`, `keydown`, `pagehide`, scheduled animation frame and isolated-world state;
- same nonce is idempotent; a new install disposes the previous state first;
- after every autonomous disposal (`Escape`, `pagehide`, zero-size, disconnect or mutation), the injected code best-effort sends exactly one `{type:'AUDITA_HIGHLIGHT_INVALIDATED',nonce}` through `chrome.runtime.sendMessage` when available. Explicit clear/replacement is acknowledged synchronously instead and sends no duplicate event.

- [ ] **Step 1: Write failing verifier, injection and cleanup tests**

```js
test('revalidates tab window document HMAC backend selector signature and expiry', async () => {
  const result = await verifier.verify({ binding, target: binding.targets['occ-1'] });
  assert.deepEqual(result, { ok:true, tabId:7, windowId:3, documentId:'doc-main', frameId:0 });
  assert.deepEqual(trace, [
    'tabs.get', 'digest.complete-url', 'probe.top-document', 'cdp.backend-node',
    'selector.unique-same-node', 'signature.recompute',
  ]);
});

test('reload at identical URL and forged window both fail before injection', async () => {
  probe.topDocumentId = 'doc-after-reload';
  assert.deepEqual(await controller.highlight(request), { ok:false, code:'HIGHLIGHT_DOCUMENT_CHANGED' });
  assert.equal(chromeApi.scripting.calls.length, 0);
  probe.topDocumentId = binding.topDocumentId;
  tabs.current.windowId = binding.windowId + 1;
  assert.deepEqual(await controller.highlight(request), { ok:false, code:'HIGHLIGHT_WINDOW_CHANGED' });
  assert.equal(chromeApi.scripting.calls.length, 0);
});

test('injects only by documentIds and validates the returned document and frame', async () => {
  const result = await adapter.injectHighlight({tabId:7,documentId:'doc-child',command});
  assert.equal(result.ok, true);
  assert.deepEqual(chromeApi.scripting.calls[0].target, {tabId:7,documentIds:['doc-child']});
  assert.equal(Object.hasOwn(chromeApi.scripting.calls[0].target, 'frameIds'), false);
  injectionResult.documentId = 'forged-document';
  assert.deepEqual(await adapter.injectHighlight({tabId:7,documentId:'doc-child',command}), {ok:false,reason:'result-mismatch'});
});

test('creates the required visual treatment without mutating the target', async () => {
  const before = authorSnapshot(targetElement);
  const result = await runAuditaHighlightCommand(failedCommand, fixtureEnvironment);
  assert.deepEqual(result, {ok:true,nonce:failedCommand.nonce});
  assert.equal(root.style.borderWidth, '6px');
  assert.equal(root.style.borderStyle, 'solid');
  assert.equal(root.style.borderColor, 'rgb(139, 30, 30)');
  assert.match(root.textContent, /×.*Falha confirmada/u);
  assert.deepEqual(authorSnapshot(targetElement), before);
});

test('cleans root listeners observer speech and state on every exit', async () => {
  await runAuditaHighlightCommand(manualCommand, fixtureEnvironment);
  fixtureEnvironment.dispatchKey('Escape');
  assert.equal(fixtureEnvironment.document.querySelector('[data-audita-highlight-root]'), null);
  assert.deepEqual(fixtureEnvironment.listenerCounts(), {scroll:0,resize:0,keydown:0,pagehide:0});
  assert.equal(fixtureEnvironment.activeObserverCount(), 0);
  assert.equal(Object.hasOwn(fixtureEnvironment, '__auditaHighlightOverlayV1'), false);
});

test('accepts only the correlated content invalidation nonce and sender', async () => {
  assert.deepEqual(await controller.invalidateContent({
    message:{type:'AUDITA_HIGHLIGHT_INVALIDATED',nonce:ACTIVE_NONCE}, sender:exactContentSender,
  }), {ok:true});
  assert.deepEqual(await controller.invalidateContent({
    message:{type:'AUDITA_HIGHLIGHT_INVALIDATED',nonce:'other-nonce'}, sender:exactContentSender,
  }), {ok:false,code:'HIGHLIGHT_INVALIDATION_DENIED'});
  assert.deepEqual(await controller.invalidateContent({
    message:{type:'AUDITA_HIGHLIGHT_INVALIDATED',nonce:ACTIVE_NONCE}, sender:otherDocumentSender,
  }), {ok:false,code:'HIGHLIGHT_INVALIDATION_DENIED'});
});

test('report connect mints live highlight authority only from a current result launch', async () => {
  const connected = await dispatch({type:'REPORT_CONNECT',auditId:'audit-1'}, exactReportSender);
  assert.deepEqual(Object.keys(connected).sort(),['auditId','ok','sessionCapabilityId','state']);
  assert.deepEqual({ok:connected.ok,auditId:connected.auditId,state:connected.state},{ok:true,auditId:'audit-1',state:'result'});
  assert.match(connected.sessionCapabilityId, /^[A-Za-z][A-Za-z0-9_-]{19,239}$/u);
  assert.deepEqual((await reportConsumerFor(connected.sessionCapabilityId)).intents,['export','highlight']);

  const recovered = await dispatch({type:'REPORT_CONNECT',auditId:'audit-2'}, exactViewOnlyReportSender);
  assert.deepEqual({ok:recovered.ok,auditId:recovered.auditId,state:recovered.state},{ok:true,auditId:'audit-2',state:'view-only'});
  assert.deepEqual((await reportConsumerFor(recovered.sessionCapabilityId)).intents,['export']);
  assert.deepEqual(await dispatch({
    type:'HIGHLIGHT_OCCURRENCE',sessionCapabilityId:recovered.sessionCapabilityId,
    auditId:'audit-2',occurrenceId:'occ-2',
  }, exactViewOnlyReportSender), {ok:false,code:'SESSION_INTENT_DENIED'});

  revokedSourceSession.state='revoked';
  assert.deepEqual(await dispatch({type:'REPORT_CONNECT',auditId:'audit-3'}, exactRevokedSourceReportSender),{ok:false,code:'REPORT_CONNECT_DENIED'});
  assert.equal(calls.reportConsumersIssuedForAudit3,0);
});

test('retains ReportLaunchV1 as export-only without upgrading its stored record', async () => {
  const before=structuredClone(await reportLaunchFor('audit-v1'));
  const connected=await dispatch({type:'REPORT_CONNECT',auditId:'audit-v1'}, exactLegacyReportSender);
  assert.equal(connected.state,'view-only');
  assert.deepEqual((await reportConsumerFor(connected.sessionCapabilityId)).intents,['export']);
  assert.deepEqual(await reportLaunchFor('audit-v1'),{...before,documentId:exactLegacyReportSender.documentId,state:'connected'});
  assert.equal((await reportLaunchFor('audit-v1')).version,1);
});
```

`authorSnapshot` is declared in `test/highlight/highlight-overlay.test.js` and copies only the fixture target's attributes, class name, inline style and active element. Fixture event/observer counters are explicit test doubles.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test test/highlight/highlight-live-verifier.test.js test/highlight/highlight-controller.test.js test/highlight/highlight-overlay.test.js test/background/chrome-adapter.test.js test/background/worker-protocol.test.js test/background/report-launch.test.js test/background/report-port.test.js test/background/target-capabilities.test.js test/background/service-worker.test.js test/background/authorized-audit-starter.test.js test/review/review-ui.test.js`

Expected: FAIL because verifier, controller, overlay and cleanup integration do not exist.

- [ ] **Step 3: Implement the live verifier and controller**

`createHighlightLiveVerifier` uses only binding fields and worker services. It validates `now()` before and after asynchronous CDP proof and discards the `chrome.tabs.get` object and raw current URL after the HMAC comparison. Its success is exactly `{ok:true,tabId,windowId,documentId,frameId}`; failure is `{ok:false,reason}` from a closed internal union. `verifyHighlightTarget` in `chrome-adapter.js` returns a frozen exact proof; it never returns raw URL, DOM text or HTML. The controller derives `kind:'failed'` for consolidated confirmed failure or human decision of nonconformity and `kind:'manual'` for pending human review; other outcomes have no live highlight. It derives the marker number from model order and creates a 128-bit nonce with its injected `randomBytes`. Highlight and clear acquire the same `targetQueue` used by persona/audit; after acquiring it they repeat authorization and binding reads so an inspected value never crosses a concurrent audit cleanup.

Before installing, the controller reads `activeOverlayByTab`. If present, it enters `clearing` and sends exact clear to its stored `documentId`; confirmed missing document is treated as clear, while a live document returning nonce mismatch is an error and blocks replacement. It then persists `installing` before injection and transitions to `active` only after the correlated result. `recover()` clears `installing|clearing` owners after worker restart and verifies an `active` owner against its exact document/nonce; `expireDue()` clears owners at `expiresAt` under the same top-document lock. Both retain unconfirmed records, and the worker-owned alarms listener schedules `audita-highlight-expiry-v1` without adding another listener.

`clear` authorizes the session/sender, finds the active record by internally correlated audit/tab, acquires `(tabId,topDocumentId)` and clears by stored target-frame `documentId`/nonce. `clearForTargetLocked(target,reason,lock)` is worker-internal, verifies the audit orchestrator's existing top-document lock and uses trusted record values without reacquiring it. `invalidateContent` first parses the two-key internal message, finds the active record without trusting the message, acquires its `(tabId,topDocumentId)` lock, rereads the record, then requires `sender.id === chrome.runtime.id`, exact `sender.tab.id`, `sender.documentId`, `sender.frameId` and active nonce before removing it. It never accepts a target from the message. Thus child-frame clear/invalidation cannot race a top-document audit lock.

After confirmed install/clear/invalidation, the worker publishes the exact safe view event above through already authorized panel/report ports for that audit. A view validates exact keys/audit correlation before updating its local action.

The worker's existing tab loading/removal listeners delegate to both the Marco 1 authority and `highlightController.invalidateTab`; the Task 3 worker-owned detach/window-removal delegates do the same. No highlight/persona module registers a Chrome listener. Each invalidator acquires the relevant target lock, removes its active record only after confirmed clear or confirmed document absence, and retains an unconfirmed record so later audit remains blocked. The cleanup barrier now receives `highlightController` as `highlightCleaner`, so attached audit tests must prove a previously active overlay is cleared before persona and before claim.

The existing audit-deleted delegate calls `highlightController.clearAudit(auditId,'audit-deleted')` before `bindingStore.deleteAudit(auditId)`. It acquires each affected target lock and confirms clear or confirmed document absence. Failure propagates to the standard deletion-pending flow and never reports cleanup complete while a live overlay remains.

- [ ] **Step 4: Implement the self-contained overlay**

`runAuditaHighlightCommand` contains all private functions inside its own function body so Chrome can serialize it: `exactKeys`, `parseInstall`, `parseClear`, `queryExact`, `roleForSignature`, `canonicalSignatureInput`, `digestHex`, `sameDigest`, `makeRoot`, `positionRoot`, `notifyInvalidation` and `dispose`. `roleForSignature` mirrors the frozen mapping from `roleForStructuralSignature` and is covered by the parity test. The injected function uses only `command` and `environment`; no imported constant or closure is referenced at runtime.

Apply the required border to the root and use separate child nodes for marker and text label. Tests assert the individual `borderWidth`, `borderStyle` and `borderColor` properties rather than browser-specific shorthand serialization. Apply a forced-colors-friendly outline in addition to the required treatment. All text is fixed locally and inserted with `textContent`.

- [ ] **Step 5: Run focused critical tests**

Run: `node --test test/highlight/highlight-locator.test.js test/highlight/highlight-model-authority.test.js test/highlight/highlight-binding.test.js test/highlight/highlight-binding-store.test.js test/highlight/highlight-live-verifier.test.js test/highlight/highlight-controller.test.js test/highlight/highlight-overlay.test.js test/personas/persona-coordinator.test.js test/background/chrome-adapter.test.js test/background/worker-protocol.test.js test/background/report-launch.test.js test/background/report-port.test.js test/background/target-capabilities.test.js test/background/authorized-audit-starter.test.js test/background/service-worker.test.js test/review/review-ui.test.js`

Expected: PASS; no request extra is ignored, no stale model/document/digest authorizes injection, exactly one serializable result is accepted, prior overlay is cleaned, and audit remains behind the complete live-aid cleanup barrier.

- [ ] **Step 6: Perform the second independent critical review**

Assign a second reviewer who did not implement Tasks 2–6 and is not the Task 3 reviewer. Review binding schema, recursive freeze, model/evidence correlation, HMAC semantics, expiry, CDP/Chrome document correlation, TOCTOU handling, `documentIds`, injection serialization, overlay teardown, content invalidation and audit cleanup. Record evidence in `docs/qa/2026-08-29-marco-2-critical-review-b.md`. Resolve every Critical/Important finding and rerun the focused command from Step 5.

- [ ] **Step 7: Commit secure highlight execution**

```bash
git add src/background/highlight-live-verifier.js src/background/highlight-controller.js src/browser/highlight-overlay.js src/background/chrome-adapter.js src/background/live-aid-cleanup.js src/background/worker-protocol.js src/background/report-launch.js src/background/report-port.js src/background/target-capabilities.js src/background/service-worker.js src/review/review.js test/highlight test/background/chrome-adapter.test.js test/background/worker-protocol.test.js test/background/report-launch.test.js test/background/report-port.test.js test/background/target-capabilities.test.js test/background/service-worker.test.js test/background/authorized-audit-starter.test.js test/review/review-ui.test.js docs/qa/2026-08-29-marco-2-critical-review-b.md
git commit -m "feat: add verified reversible page highlight"
```

## Task 7: Make highlight, evidence fallback and persona state usable

**Risk:** Medium.

**Files:**

- Create: `src/panel/highlight-action.js`
- Modify: `src/panel/panel-state.js`
- Modify: `src/panel/panel.js`
- Modify: `src/panel/panel.css`
- Modify: `src/panel/index.html`
- Modify: `src/review/report-view.js`
- Modify: `src/review/review.js`
- Modify: `src/review/review.css`
- Modify: `src/popup/popup.js`
- Modify: `src/popup/popup.css`
- Create: `test/panel/highlight-action.test.js`
- Modify: `test/panel/panel-state.test.js`
- Modify: `test/panel/panel-ui.test.js`
- Modify: `test/review/report-view.test.js`
- Modify: `test/review/review-ui.test.js`
- Modify: `test/popup/popup-state.test.js`
- Modify: `test/extension-shell.test.js`

**Action projection:**

`bindingStatus` is exactly `{state:'available'}` or `{state:'unavailable',reason}`, where `reason` is one of `page-or-process|no-binding|expired|inaccessible|ambiguous|shadow-root|document-changed|live-proof-failed`. Panel/report derive the initial state from the current safe `occurrence.evidence.highlightAvailable` projection and their authorized result/view-only session; a controller failure replaces it locally with the mapped unavailable reason. `activeOccurrenceId` is either `null` or the occurrence ID from the correlated safe worker event; the UI never infers active ownership from a boolean alone.

`highlightActionForOccurrence({occurrence,bindingStatus,activeOccurrenceId})` returns exactly one recursively frozen object:

```text
{ kind:'highlight', label:'Ver e destacar na página', enabled:true, reason:null }
{ kind:'evidence', label:'Consultar evidências', enabled:true, reason:'Esta verificação não possui um elemento único destacável no estado atual.' }
{ kind:'clear', label:'Limpar destaque', enabled:true, reason:null }
```

It returns `clear` only when `activeOccurrenceId === occurrence.occurrenceId`, `highlight` only when the current safe projection exposes a binding candidate, and `evidence` for page/process findings, missing locator, expired/restarted binding, inaccessible frame, ambiguous selector, Shadow DOM, changed document/node/signature or any safe highlight failure. The worker still performs the complete live validation only after the click. “Consultar evidências” is never disabled.

**Panel/report behavior:**

- Result cards and report occurrences expose `data-occurrence-id`, `data-rule-id` and one `data-action="open-occurrence"` button with an accessible name containing the finding title.
- Opening a detail sends exact `GET_HIGHLIGHT_AVAILABILITY` through the already authorized panel/report session, shows a local busy state, and projects the closed response. A denied, disconnected or malformed response conservatively becomes enabled `Consultar evidências`; it never hides the detail.
- The side-panel document mirrors its top-level reducer state as `document.body.dataset.screen`; live actions use exactly `data-action="highlight-occurrence"`, `data-action="clear-highlight"` and `data-action="consult-evidence"`.
- Detail renders the ten Marco 1 sections. Technical evidence uses `<details data-section="technical-evidence">` with `<summary>Evidências técnicas</summary>`.
- Evidence action sets the `details.open` property, scrolls its summary into view, focuses the summary and announces the objective reason in the existing status live region. It does not message the worker.
- Highlight action sends only the four allowed UI fields, shows `Localizando o elemento…`, and in `finally` always restores enabled state. Success changes the local action to `Limpar destaque`; failure changes it to actionable evidence fallback and preserves the worker's fixed reason mapping.
- Clear sends only `CLEAR_HIGHLIGHT`, always restores the button in `finally`, and returns the action to highlight only after the worker confirms clear and the binding remains available.
- Changing occurrence first requests clear for an active overlay; navigation away from result/detail also clears best-effort without altering model state.
- The live report uses the same projection/callbacks. `renderReportView` extends its `onIntent` union to exact objects `{type:'HIGHLIGHT_OCCURRENCE',occurrenceId}`, `{type:'CLEAR_HIGHLIGHT'}`, `{type:'OPEN_EVIDENCE',occurrenceId}` and `{type:'REQUEST_EXPORT'}`; it emits only IDs already present in the frozen view. `review.js` adds its worker-held audit/session IDs only when creating a closed protocol message. Export renderers do not receive callbacks and emit no live action.
- Popup persona controls are three 44×44 toggle buttons with `aria-pressed`, visible text `Leitura simulada`, `Acromatopsia`, `Somente teclado`, one concise status and `Processamento local; nenhum dado é enviado.` Active mode is never indicated only by color.

- [ ] **Step 1: Write failing action and accessibility tests**

```js
test('offers highlight only for a current safe binding candidate', () => {
  assert.deepEqual(highlightActionForOccurrence({
    occurrence: failedOccurrence, bindingStatus:{state:'available'}, activeOccurrenceId:null,
  }), {kind:'highlight',label:'Ver e destacar na página',enabled:true,reason:null});
});

test('evidence fallback is enabled and opens the technical evidence region', async () => {
  const action = highlightActionForOccurrence({
    occurrence: pageOccurrence,
    bindingStatus:{state:'unavailable',reason:'ambiguous'}, activeOccurrenceId:null,
  });
  assert.deepEqual(action, {
    kind:'evidence', label:'Consultar evidências', enabled:true,
    reason:'Esta verificação não possui um elemento único destacável no estado atual.',
  });
  const ui = renderPanelFixture({ action });
  ui.querySelector('[data-action="consult-evidence"]').click();
  assert.equal(ui.querySelector('[data-section="technical-evidence"]').open, true);
  assert.equal(ui.ownerDocument.activeElement, ui.querySelector('[data-section="technical-evidence"] > summary'));
});

test('highlight request never carries selector or Chrome target identifiers', async () => {
  await panelController.openOccurrence('occ-1');
  assert.deepEqual(runtimeMessages.at(-1), {
    type:'GET_HIGHLIGHT_AVAILABILITY', sessionCapabilityId:SESSION,
    auditId:'audit-1', occurrenceId:'occ-1',
  });
  await panelController.highlight('occ-1');
  assert.deepEqual(runtimeMessages.at(-1), {
    type:'HIGHLIGHT_OCCURRENCE', sessionCapabilityId:SESSION,
    auditId:'audit-1', occurrenceId:'occ-1',
  });
});

test('restores action state in finally and falls back to evidence on failure', async () => {
  runtimeReply.value = {ok:false,code:'HIGHLIGHT_DOCUMENT_CHANGED'};
  await panelController.highlight('occ-1');
  assert.equal(view.action.enabled, true);
  assert.equal(view.action.kind, 'evidence');
  assert.match(view.status, /estado atual da página/iu);
});

test('persona buttons expose mutually exclusive pressed state and plain-language status', async () => {
  await popupController.setPersonaMode('reader');
  assert.equal(button('reader').getAttribute('aria-pressed'), 'true');
  assert.equal(button('motor').getAttribute('aria-pressed'), 'false');
  assert.match(status.textContent, /Leitura simulada ativa/u);
});
```

`renderPanelFixture`, `panelController`, `button` and DOM fixtures are declared in their respective test files and use the production exported constructors; no browser global is assumed by `node:test`.

- [ ] **Step 2: Run focused UI tests and confirm RED**

Run: `node --test test/panel/highlight-action.test.js test/panel/panel-state.test.js test/panel/panel-ui.test.js test/review/report-view.test.js test/review/review-ui.test.js test/popup/popup-state.test.js test/extension-shell.test.js`

Expected: FAIL because evidence fallback is inert and live highlight/clear/persona state is not projected.

- [ ] **Step 3: Implement pure projection and accessible DOM actions**

Implement `highlightActionForOccurrence` as a total switch over the closed `bindingStatus` union and exact `activeOccurrenceId`; unknown states conservatively return evidence. Reuse it in panel/report rather than duplicating availability logic. Every external string goes through `textContent`, every pending state uses `aria-busy`, every status update uses the existing `role="status"` region, and focus returns to the invoking occurrence control after clear.

The worker maps internal highlight failure codes to these fixed user messages before UI receives them:

- document/window/HMAC/expiry: `A página mudou desde a auditoria. Consulte as evidências registradas.`;
- node/selector/signature/frame/shadow: `O elemento não pôde ser localizado no estado atual da página.`;
- runtime/cleanup: `Não foi possível mostrar o destaque com segurança. Consulte as evidências registradas.`

No message includes URL, selector, DOM snippet, raw exception or internal ID. Detailed historical code/seletor remains only in the existing technical evidence section.

- [ ] **Step 4: Run focused UI and protocol tests**

Run: `node --test test/panel/highlight-action.test.js test/panel/panel-state.test.js test/panel/panel-ui.test.js test/panel/panel-voice-privacy.test.js test/review/report-view.test.js test/review/review-ui.test.js test/popup/popup-state.test.js test/background/worker-protocol.test.js test/extension-shell.test.js`

Expected: PASS; both live views expose the safe action, fallback opens evidence, pending states recover, persona state is accessible and exports remain free of live controls.

- [ ] **Step 5: Perform the medium-risk independent review**

Assign one reviewer who did not implement Task 7. Check keyboard-only use, focus order/restoration, visible focus, 200% zoom, 320 CSS px reflow, status announcements, contrast, non-color state, evidence fallback, no raw technical errors and absence of live action in exported HTML. Record evidence in `docs/qa/2026-08-29-marco-2-ui-review.md`; resolve findings that block the required journey and rerun Step 4.

- [ ] **Step 6: Commit the usable live actions**

```bash
git add src/panel/highlight-action.js src/panel/panel-state.js src/panel/panel.js src/panel/panel.css src/panel/index.html src/review/report-view.js src/review/review.js src/review/review.css src/popup/popup.js src/popup/popup.css test/panel test/review test/popup/popup-state.test.js test/extension-shell.test.js docs/qa/2026-08-29-marco-2-ui-review.md
git commit -m "feat: expose highlight and evidence actions"
```

## Task 8: Prove the complete journey in the Marco 1 real-Chrome harness

**Risk:** Critical integration.

**Files:**

- Read: `test/e2e/support/real-chrome.mjs`
- Modify: `test/e2e/support/real-chrome.test.mjs`
- Create: `test/e2e/fixtures/persona-highlight.html`
- Create: `test/e2e/fixtures/persona-highlight-frame.html`
- Create: `test/e2e/fixtures/pixel.png`
- Create: `test/e2e/persona-highlight-flow-mv3.test.mjs`
- Create: `docs/qa/2026-08-29-marco-2-personas-destaque.md`
- Create: `docs/qa/artifacts/marco-2/.gitkeep`
- Modify: `README.md`

**Real browser boundary:**

Consume the cumulative Marco 1 exports `startFixtureServer`, `launchUnpackedExtension`, `click`, `evaluate`, `waitForValue`, `pressKey`, `captureScreenshot` and `command`. Do not create another launcher, fake extension page, Playwright dependency or fabricated capability/binding. Retain this exact already-tested primitive:

```js
export async function command(target, method, params = {}) {
  if (!target?.cdp || typeof target.cdp.send !== 'function' || typeof target.sessionId !== 'string') {
    throw new TypeError('E2E_TARGET_INVALID');
  }
  if (typeof method !== 'string' || !method || !params || Object.getPrototypeOf(params) !== Object.prototype) {
    throw new TypeError('E2E_COMMAND_INVALID');
  }
  return target.cdp.send(method, params, target.sessionId);
}
```

`command` is the only way this plan requests `Page.reload`; no `startPage.command` property is assumed. Task 8 first reruns the Marco 1 support contract test to prove that optional validated launch defaults and all prior exports remain present, and does not edit the support source unless that focused test exposes a genuine contract defect. The inherited `click` continues to use the Marco 1 `Runtime.evaluate` call with `userGesture:true`, which is the harness's real-extension user activation contract.

**Fixture:**

The top page has a unique `<img id="product-image" src="/pixel.png">` without `alt`, a visible button whose counter proves motor-mode pointer blocking, enough vertical space to exercise scrolling, a same-origin iframe containing a second missing-alt image, a second `<iframe sandbox="allow-scripts">` pointed at the same loopback route so it has an opaque inaccessible origin, one open-shadow missing-alt image and one closed-shadow missing-alt image. Its CSP permits only its local fixture resources. No network other than the loopback fixture is used.

- [ ] **Step 1: Write the complete failing E2E journey**

```js
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  startFixtureServer, launchUnpackedExtension, click, evaluate, waitForValue,
  pressKey, captureScreenshot, command,
} from './support/real-chrome.mjs';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

async function fixtureRoutes() {
  const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
  return new Map([
    ['/persona-highlight.html', {status:200,headers:{'content-type':'text/html; charset=utf-8'},body:await readFile(join(fixtures,'persona-highlight.html'))}],
    ['/persona-highlight-frame.html', {status:200,headers:{'content-type':'text/html; charset=utf-8'},body:await readFile(join(fixtures,'persona-highlight-frame.html'))}],
    ['/pixel.png', {status:200,headers:{'content-type':'image/png'},body:await readFile(join(fixtures,'pixel.png'))}],
  ]);
}

test('persona to audit to highlight uses only real extension surfaces', async t => {
  const fixture = await startFixtureServer(t, await fixtureRoutes());
  const configuredArtifacts = process.env.AUDITA_QA_ARTIFACT_DIR;
  const artifacts = configuredArtifacts || await mkdtemp(join(tmpdir(), 'audita-marco-2-'));
  if (!configuredArtifacts) t.after(() => rm(artifacts, {recursive:true,force:true}));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: workspaceRoot, startUrl: `${fixture.origin}/persona-highlight.html`,
    viewport:{width:1280,height:900},
  });
  const page = extension.startPage;
  let popup = await extension.openActionPopup();

  await click(popup, 'button[data-persona-mode="reader"]');
  await waitForValue(page, 'document.documentElement.classList.contains("audita-persona-reader")', Boolean, 5_000);
  await click(popup, 'button[data-persona-mode="achromatopsia"]');
  assert.equal(await evaluate(page, 'document.documentElement.classList.contains("audita-persona-achromatopsia")'), true);
  assert.equal(await evaluate(page, 'document.documentElement.classList.contains("audita-persona-reader")'), false);
  await click(popup, 'button[data-persona-mode="motor"]');
  await click(page, '#pointer-counter');
  assert.equal(await evaluate(page, 'Number(document.querySelector("#pointer-counter").dataset.count)'), 0);

  await click(popup, 'button[data-action="audit-current-page"]');
  const panel = await extension.waitForSidePanel();
  await waitForValue(panel, 'document.body.dataset.screen', value => value === 'result', 30_000);
  assert.equal(await evaluate(page, 'document.querySelectorAll("[data-audita-persona-root], [data-audita-highlight-root]").length'), 0);
  assert.equal(await evaluate(page, 'document.documentElement.className.includes("audita-persona-")'), false);

  await click(panel, '[data-occurrence-id][data-rule-id="image-alt"] [data-action="open-occurrence"]');
  assert.match(await evaluate(panel, 'document.body.innerText'), /Nome acessível.*Anúncio estimado.*WCAG 2\.2.*ABNT NBR 17225/su);
  await click(panel, '[data-action="highlight-occurrence"]');
  await waitForValue(page, 'document.querySelector("[data-audita-highlight-root]")?.textContent || ""', value => /Falha confirmada/u.test(value), 5_000);
  assert.match(await evaluate(page, 'document.querySelector("[data-audita-highlight-root]").textContent'), /×.*Falha confirmada/u);
  await captureScreenshot(panel, join(artifacts, '01-painel-detalhe-destaque.png'));
  await captureScreenshot(page, join(artifacts, '02-pagina-com-destaque.png'));

  await click(panel, '[data-action="clear-highlight"]');
  await waitForValue(page, 'Boolean(document.querySelector("[data-audita-highlight-root]"))', value => value === false, 5_000);
  await click(panel, '[data-action="highlight-occurrence"]');
  await pressKey(page, 'Escape');
  await waitForValue(page, 'Boolean(document.querySelector("[data-audita-highlight-root]"))', value => value === false, 5_000);

  await command(page, 'Page.reload', {ignoreCache:true});
  await waitForValue(page, 'document.readyState', value => value === 'complete', 10_000);
  await click(panel, '[data-action="highlight-occurrence"]');
  await waitForValue(panel, 'document.querySelector("[data-action=consult-evidence]")?.disabled === false', Boolean, 5_000);
  await click(panel, '[data-action="consult-evidence"]');
  assert.equal(await evaluate(panel, 'document.querySelector("[data-section=technical-evidence]").open'), true);

  const auditId = await evaluate(panel, 'document.body.dataset.auditId');
  await click(panel, 'button[data-action="open-report"]');
  const report = await extension.waitForReport({auditId});
  assert.match(await evaluate(report, 'document.body.innerText'), /ABNT NBR 17225.*WCAG 2\.2/su);
  assert.match(await evaluate(report, 'document.body.innerText'), /Consultar evidências/u);
  await captureScreenshot(report, join(artifacts, '03-relatorio-evidencias.png'));
});
```

`fixtureRoutes()` is declared in the same E2E file and returns the required `Map<string,{status,headers,body}>` by loading the two checked-in fixture HTML files plus the fixed local PNG. It never starts a second server or reaches the public web.

- [ ] **Step 2: Add frame/shadow and recovery assertions**

In a second test using the same support module:

- same-origin iframe obtains a binding only when Chrome/CDP document correlation is exact and injects into its `documentId`;
- sandbox/cross-origin inaccessible frame renders enabled `Consultar evidências`;
- an open-Shadow-DOM occurrence exposed by the auditor renders enabled `Consultar evidências`, because `CSSSelectorV1` does not cross a shadow boundary;
- the closed Shadow DOM fixture never receives a binding or injection; when the auditor cannot observe it, the test asserts absence of a fabricated occurrence plus the existing automatic-coverage caveat, not a fabricated evidence action;
- replacing the image in an SPA invalidates the overlay and the exact nonce message removes active state;
- reload at the same URL revokes persona/binding because `documentId` changed;
- opening a second occurrence leaves exactly one overlay root in the tab.

Use only public UI for persona/highlight actions. Service-worker suspension and recovery remain covered by the deterministic Task 3 unit/integration tests; this E2E adds no production backdoor and does not assume a restart helper absent from the Marco 1 harness.

- [ ] **Step 3: Run the focused real-Chrome test and confirm RED**

Run: `node --test test/e2e/support/real-chrome.test.mjs`

Expected: PASS; the Marco 1 cumulative harness, validated optional defaults and retained `command` primitive have not regressed.

Run: `node --test test/e2e/persona-highlight-flow-mv3.test.mjs`

Expected: FAIL until the real popup, worker, panel, injected page and report complete the required journey.

- [ ] **Step 4: Complete integration and capture QA evidence**

Wire the Task 1 message handlers, Task 3 coordinator/barrier, Task 5 recorder and Task 6 controller through the existing service-worker dispatcher. Keep the Marco 1 `src/panel/index.html`, context-menu router and real-Chrome lifecycle.

Run: `AUDITA_QA_ARTIFACT_DIR=docs/qa/artifacts/marco-2 node --test test/e2e/persona-highlight-flow-mv3.test.mjs`

Expected: PASS and three PNGs are written under `docs/qa/artifacts/marco-2/`. Record Chrome product/version, viewport, candidate commit, exact test command, screenshot paths, expected safe fallbacks and observed cleanup in `docs/qa/2026-08-29-marco-2-personas-destaque.md`.

- [ ] **Step 5: Commit the review candidate**

```bash
git add test/e2e/support/real-chrome.test.mjs test/e2e/fixtures/persona-highlight.html test/e2e/fixtures/persona-highlight-frame.html test/e2e/fixtures/pixel.png test/e2e/persona-highlight-flow-mv3.test.mjs docs/qa/2026-08-29-marco-2-personas-destaque.md docs/qa/artifacts/marco-2 README.md
git commit -m "test: prove persona and highlight journey in Chrome"
```

Record the resulting code candidate SHA in all three QA reports. Later review-fix commits replace that SHA explicitly; do not describe two different code trees as the same candidate.

- [ ] **Step 6: Close both independent critical reviews against one candidate**

Reviewer A from Task 3 independently reviews the final binding/highlight/runtime additions from Tasks 4–8. Reviewer B from Task 6 independently reviews the final persona/audit/protocol/UI additions from Tasks 1–3 and 7–8. Each records candidate commit, files inspected, attack cases, commands and resolution status in their existing QA report. Neither reviewer accepts the other report as evidence. Resolve each Critical/Important finding with a focused RED regression test, rerun only affected focused commands and have its reviewer record closure. Gate passes only when both reports state zero open Critical and zero open Important on the same candidate.

If either review changes product/test code, commit all scoped corrections before closure:

```bash
git add src/background src/browser src/personas src/popup src/panel src/review test/background test/personas test/highlight test/panel test/review test/e2e
git commit -m "fix: close marco 2 critical review findings"
```

Both reviewers then inspect that new SHA and replace the earlier candidate SHA in their reports. A review of the superseded SHA does not satisfy the gate.

- [ ] **Step 7: Run the milestone suite once after review fixes**

Run: `npm test`

Expected: PASS for the complete repository test suite.

Run: `npm run verify`

Expected: PASS; no remote code, inline script, persistent content script, new host permission, duplicate listener or exported live binding is present.

Do not run `npm run build:release` and do not generate a ZIP in this milestone. Packaging occurs only at the release milestone.

- [ ] **Step 8: Commit review closure records**

```bash
git add docs/qa/2026-08-29-marco-2-personas-destaque.md docs/qa/2026-08-29-marco-2-critical-review-a.md docs/qa/2026-08-29-marco-2-critical-review-b.md docs/qa/2026-08-29-marco-2-ui-review.md
git commit -m "docs: close marco 2 review gates"
```

---

## Milestone acceptance gate

- Popup → `Leitura simulada` → `Acromatopsia` → `Somente teclado` uses one current document owner, exact modes and no TTL supplied by UI.
- Close/reopen popup rehydrates only an exact live lease and does not renew it; expiration/navigation/reload/removal/recovery clean and revoke.
- Starting attached audit clears and confirms highlight/persona before capability claim and collector execution; cleanup failure starts nothing.
- `CSSSelectorV1` rejects embedded UUID/opaque/sensitive tokens and never truncates before reaching the declared root.
- Binding is closed, recursively frozen, session-only, model/revision/hash/evidence-correlated and URL-bound by the Marco 1 HMAC.
- Every highlight reproves session, sender, tab, window, URL HMAC, top/target document, frame, backend node, unique selector, structural signature and expiry immediately before injection.
- Injections target `documentIds`, accept one matching serializable result and never accept an extra UI selector/target field.
- Overlay presents the exact solid/dashed treatments, mutates no author element, maintains one root per tab and completely disposes on clear, Escape, pagehide, navigation, mutation or replacement.
- Missing/stale/ambiguous/inaccessible target always exposes enabled `Consultar evidências` and moves focus to the technical evidence; no live failure changes the audit model or historical evidence.
- Live action appears only in panel/report application. Exported HTML/PDF/CSV/JSON contains the historical report without a nonfunctional highlight control or transient binding.
- Real Chrome proves the required minimum path: abrir extensão → persona → avaliar página → sumário → ocorrência → destacar → consultar ABNT/WCAG/anúncio/evidências → limpar → abrir relatório.
- Two independent final critical reviews report zero open Critical and zero open Important on the same candidate; the medium-risk UI review is closed.
- Focused tests pass during work; `npm test` and `npm run verify` pass once after final review fixes; no release ZIP is generated.

## Self-review

- **Spec coverage:** Task 1 activates the Marco 1 popup contract; Tasks 2–3 close persona lifecycle and pristine-audit ordering; Tasks 4–6 close locator, binding, proof, injection and overlay; Task 7 supplies the actionable visual flow; Task 8 proves it in real Chrome and both final review gates.
- **Ownership:** `service-worker.js` remains the only Chrome-listener owner; Marco 1 remains owner of side-panel/context-menu/runner/E2E launch. This plan creates no alternate panel path or context-menu launcher.
- **Security boundary:** all UI schemas are exact and target-free; all live state is session-only; model/evidence relation and HMAC are revalidated; `documentIds` and serializable results are mandatory; cleanup precedes audit claim.
- **Type consistency:** mode, state, reason, message, lease, binding, signature, action, overlay and result unions are defined once above and reused verbatim in tasks/tests.
- **Test discipline:** every behavior starts RED, gets a focused PASS, receives risk-calibrated independent review, then one milestone-wide suite and verification run.
