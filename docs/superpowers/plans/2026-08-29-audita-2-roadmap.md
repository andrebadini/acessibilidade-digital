# Audita Acessibilidade 2.0 Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir a experiência técnica da versão 1.0.1 por um fluxo completo e local de fiscalização — popup → painel lateral → sumário → ficha → destaque/evidências → relatório → quatro exportações — e entregar a versão 2.0.0 por ZIP local.

**Architecture:** Quatro marcos sequenciais compartilham um único limite de autoridade no service worker, um runner observado com gate anterior a pixels, `AuditModel V2` imutável como fonte normativa e projeções puras para painel/relatório. Capabilities, leases, bindings, URL bruta e checkpoints ficam fora do modelo; somente a URL bruta fica restrita à sessão, enquanto checkpoints duráveis contêm apenas evidência sanitizada. A release só existe depois dos gates reais e das revisões independentes.

**Tech Stack:** HTML, CSS e JavaScript locais; Chrome Extensions Manifest V3; axe-core 4.13.0 empacotado; Chrome Side Panel API 116+; CDP por pipe; IndexedDB; `chrome.storage.session`; Web Crypto; `node:test`; HTML/PDF/CSV/JSON-EARL.

**Spec:** `docs/superpowers/specs/2026-08-29-fluxo-visual-painel-lateral-design.md`

## Global Constraints

- Executar os marcos estritamente em ordem: Marco 1 → Marco 2 → Marco 3 → Marco 4.
- Usar `src/panel/index.html` como side panel, `src/popup/index.html` como popup e `src/review/index.html` como relatório vivo.
- Manter `AuditModel V2` e seu closed schema sem IDs Chrome, capability, lease, binding, checkpoint, URL bruta ou estado visual efêmero.
- Processamento local, sem login, telemetria, servidor, código remoto, identidade governamental, crawler ou publicação em loja.
- Não criar ZIP durante correções ou marcos 1–3. No Marco 4, congelar um único ZIP candidato em diretório QA temporário seguro, vincular os dois pareceres ao mesmo commit/hash e somente então copiar aqueles mesmos bytes para `release/audita-acessibilidade-2.0.0.zip`; é proibido recompilar entre revisão e publicação local.
- Testes focados durante tarefas; `npm test` e `npm run verify` uma vez no fechamento de cada marco e novamente somente depois da última correção material.
- Risco crítico (privacidade, pixels, URLs, armazenamento, retenção, receipt, exclusão e permissões): TDD, duas revisões independentes, E2E real e zero Critical/Important.
- Risco médio (painel, relatório, personas, destaque, filtros e mapa): TDD focado, uma revisão independente no fechamento e zero Critical/Important.
- Risco baixo (cópia/documentação/ajustes visuais): teste relacionado e QA visual/acessível; suíte completa no marco.
- Tarefas que editam `manifest.json`, `service-worker.js`, `run-audit.js`, `panel.js`, `review.js` ou o store não rodam em paralelo. Pesquisa, fixtures, documentação e revisões podem ser paralelas quando não compartilham arquivos.
- Toda correção confirmada começa por teste RED. Depois de duas correções semelhantes na mesma fronteira, parar remendos e redesenhar o contrato.
- O service worker registra um único `chrome.alarms.onAlarm`; o dispatcher aceita somente `audita-persona-expiry-v1`, `audita-highlight-expiry-v1`, `audita-pixel-consent-expiry-v1` e `audita-retention-cleanup-v1`. Módulos de persona, destaque, consentimento de pixels e retenção apenas agendam/delegam e nunca registram listeners concorrentes.

## Plan suite and ownership

| Order | Plan | Exclusive ownership |
|---|---|---|
| 1 | `2026-08-29-marco-1-painel-relatorio.md` | capabilities/sessão, runner, capture-policy shape, inventário/checkpoint, popup, side panel, roteador genérico de menu, sumário e relatório vivo |
| 2 | `2026-08-29-marco-2-personas-destaque.md` | leases/FSM de persona, controles/intents ativos, locator/binding e overlay vivo |
| 3 | `2026-08-29-marco-3-privacidade-lote-retencao.md` | `EvidenceUrlV1`, cofre de URL bruta, sonda/pausa, URL/lote, retenção e receipt não circular |
| 4 | `2026-08-29-marco-4-qa-release.md` | E2E hostil, QA visual/a11y/PDF, documentação, versão 2.0.0 e ZIP final |

## Canonical cross-plan contracts

```text
export async function runObservedTabAudit({
  auditId, target, chromeAdapter, capturePolicy, privacyGate, onCheckpoint,
  now, signal, expectedExtensionId,
});

// target
// {kind:'attached',tabId,windowId,documentId,initialUrlEvidence,initialUrlSessionDigest}
// | {kind:'disposable',ownershipId,navigationUrl,cleanupMode:'always'|'pre-observation-failure'}
// | {kind:'owned-disposable-resume',ownershipId,tabId,windowId,documentId,
//    initialUrlEvidence,initialUrlSessionDigest,
//    cleanupMode:'always'|'pre-observation-failure'}

// return
// {status:'complete'|'partial'|'cancelled',model,observedTarget,
//  observationState:'observed',ownershipState:'attached'|'retained-for-review'|'removed'|'cleanup-pending'}
// | {status:'privacy-paused',model:null,observedTarget,
//    observationState:'observed',ownershipState:'attached'|'retained-for-consent',signals}
// | {status:'failed-before-observation',model:null,observedTarget:null,
//    observationState:'pre-observation-failure',ownershipState:'attached'|'removed'|'cleanup-pending'}
// observedTarget = {tabId,windowId,documentId,urlEvidence,urlSessionDigest}

export function normalizeCapturePolicyV1({ mode, includeQuery });
// mode = 'full-evidence'|'element-only'|'no-pixels'
// -> {version:'CapturePolicyV1',mode,includeQuery,
//     captureFullPage,captureElements,composeAnnouncementMap}

privacyGate.beforePixels({auditId,observedTarget,capturePolicy,signals});
// -> {status:'paused'}
//  | {status:'allowed',authorization:'initial-gesture',claim:null}
//  | {status:'allowed',authorization:'sensitive-confirmation',claim:PixelCaptureClaimV1}

export function createSessionUrlDigestManager({sessionArea,randomBytes,subtle,now});
// digest(rawUrl) -> `hmac-sha256:<base64url>`; key only in trusted storage.session

export function buildPanelSummary({model,executionCheckpoint,inventory});
export function buildReportView({model,summary,modelRevision,modelHash}); // frozen JSON-safe data
export function renderReportView({view,document,onIntent}); // DOM-only adapter

ResultClassificationV1 = 'failed'|'alert'|'manual-review'|'passed'
ResultContextV1 = 'page-or-process'|'top-document'|'same-origin-frame'|'open-shadow-root'|'mixed'
EXPORT_FORMATS_V1 = ['html','pdf','csv','json']
```

`ResultClassificationV1`, `ResultContextV1` and the frozen `EXPORT_FORMATS_V1` have one owner in Marco 1. Panel/report datasets copy only members of those closed unions; every generator, download, receipt and gate preserves the declared export order rather than sorting formats independently. Unobserved cross-origin, sandbox or closed-shadow content is represented as an explicit limitation, never as a fabricated result context.

`CapabilityIssuerV1` is exactly `{type:'extension-document',documentId,path} | {type:'worker-event',event:'context-menu',eventNonce}`. `eventNonce` is nonempty, emitted by the worker, one-shot and consumed atomically with the claim. `MessageSender`/`port.sender` are correlated with `chrome.runtime.getContexts()`; popup and side panel never need `sender.tab`, and UI-supplied window/tab/document values never authorize an action. URL/document digests use only `hmac-sha256:<base64url>` with a 32-byte key in trusted `chrome.storage.session`.

`createAuthorizedAuditStarter` remains the sole owner of atomic session/bootstrap/job publication for attached, disposable and batch starts and for privacy resume. Its public start contract is `beginAuthorizedAudit({capabilityId,eventNonce,auditId,capturePolicy,retentionPreference,senderContext})`; its worker-internal URL/batch branches receive only already normalized vault tokens/queue IDs. `retentionPreference` is exactly `{version:1,deleteAfterCompleteExport:boolean}`, is persisted outside `AuditModel V2` before runner launch and is never accepted from `EXPORT_COMPLETE`. The final session target binding is one of attached, `{kind:'disposable',ownershipId,state}`, or `{kind:'batch',activePageId:null|string,activeOwnershipId:null|string}`; batch updates the active pair by CAS before navigation and clears it only after confirmed cleanup.

Mensagens de UI usam somente estes nomes fechados:

```text
PREPARE_POPUP_CAPABILITIES
PREPARE_PANEL_CAPABILITY
PREPARE_PANEL_NAVIGATION_CAPABILITY
POPUP_START_AUDIT
POPUP_START_PERSONA
PERSONA_SET_MODE
PERSONA_STOP
PERSONA_REHYDRATE
PANEL_START_ATTACHED_AUDIT
PANEL_START_URL_AUDIT
PANEL_START_BATCH_AUDIT
PANEL_CANCEL_AUDIT
PANEL_OPEN_REPORT
PANEL_REHYDRATE_VIEW
REPORT_CONNECT
REPORT_REQUEST_EXPORT
EXPORT_CONNECT
GET_HIGHLIGHT_AVAILABILITY
HIGHLIGHT_OCCURRENCE
CLEAR_HIGHLIGHT
OPEN_CURRENT_STATE_ASSIST
CONFIRM_PIXEL_CAPTURE
PREPARE_DELETE_CAPABILITY
REQUEST_DELETE_AUDIT
REQUEST_DELETE_ALL_AUDITS
EXPORT_COMPLETE
```

Os envelopes são exatos e rejeitam propriedade extra:

```text
PREPARE_POPUP_CAPABILITIES | PREPARE_PANEL_CAPABILITY {type,requestId}
PREPARE_PANEL_NAVIGATION_CAPABILITY {type,requestId,intent:'single'|'batch'}
POPUP_START_AUDIT {type,capabilityId,captureMode,includeQuery,deleteAfterCompleteExport:false}
PANEL_START_ATTACHED_AUDIT {type,capabilityId,captureMode,includeQuery,deleteAfterCompleteExport}
POPUP_START_PERSONA {type,capabilityId,mode}
PERSONA_SET_MODE {type,leaseId,mode}
PERSONA_STOP {type,leaseId}
PERSONA_REHYDRATE {type,capabilityId}
PANEL_START_URL_AUDIT {type,capabilityId,url,captureMode,includeQuery,deleteAfterCompleteExport}
PANEL_START_BATCH_AUDIT {type,capabilityId,urls,captureMode,includeQuery,deleteAfterCompleteExport}
PANEL_CANCEL_AUDIT | PANEL_OPEN_REPORT | REPORT_REQUEST_EXPORT {type,sessionCapabilityId,auditId}
PANEL_REHYDRATE_VIEW | REPORT_CONNECT | EXPORT_CONNECT {type,auditId}
GET_HIGHLIGHT_AVAILABILITY | HIGHLIGHT_OCCURRENCE {type,sessionCapabilityId,auditId,occurrenceId}
CLEAR_HIGHLIGHT {type,sessionCapabilityId,auditId}
OPEN_CURRENT_STATE_ASSIST {type,sessionCapabilityId,auditId,occurrenceId,url}
CONFIRM_PIXEL_CAPTURE {type,sessionCapabilityId,auditId,mode,accepted:true}
PREPARE_DELETE_CAPABILITY {type,scope:'one',auditId} | {type,scope:'all'}
REQUEST_DELETE_AUDIT {type,auditId,sessionCapabilityId}
REQUEST_DELETE_ALL_AUDITS {type,sessionCapabilityId}
EXPORT_COMPLETE {type,sessionCapabilityId,auditId,expectedRevision,attemptId}
```

`PREPARE_POPUP_CAPABILITIES` retorna exatamente `{ok:true,requestId,auditCapabilityId,personaCapabilityId,windowId,expiresAt}`; `PREPARE_PANEL_CAPABILITY` retorna exatamente `{ok:true,requestId,capabilityId,expiresAt}` para o alvo attached; `PREPARE_PANEL_NAVIGATION_CAPABILITY` retorna o mesmo shape seguro para uma capability sem alvo Chrome, vinculada ao documento/janela do painel e ao intent canônico `single|batch`. `url` e `urls` entram somente do painel autorizado, são normalizadas dentro do worker e nunca reaparecem em resposta. Mensagens de destaque não contêm seletor, URL, aba, frame, documento ou backend node; `OPEN_CURRENT_STATE_ASSIST` é uma operação distinta de navegação explícita e sua URL nova entra somente no raw vault. Além dos pacotes base fechados de bootstrap/progresso/resultado do `panel-port`, os únicos eventos nomeados adicionados pelos marcos seguintes são `AUDIT_PRIVACY_PAUSED {type,auditId,mode,categories,message}` e `HIGHLIGHT_STATE_CHANGED {version:1,type,auditId,occurrenceId,state}`.

O protocolo de relatório/exportação sempre segue `PANEL_OPEN_REPORT → REPORT_CONNECT → REPORT_REQUEST_EXPORT → EXPORT_CONNECT → EXPORT_COMPLETE`. `REPORT_CONNECT` responde exatamente `{ok:true,auditId,sessionCapabilityId,state:'result'|'view-only'}`; `result` só existe quando o Marco 2 prova uma fonte `result` e binding vivo, enquanto Marco 1, uma fonte `view-only`, binding ausente/stale ou `ReportLaunchV1` recebem `view-only` e somente `export`. `EXPORT_CONNECT` responde exatamente `{ok:true,sessionCapabilityId,auditId,expectedRevision,attemptId}`. `EXPORT_COMPLETE` só é aceito no Marco 3 depois da tentativa correlacionada produzir um recibo terminal; nenhuma etapa posterior pode ser chamada antes da anterior ou aceitar seus campos da URL.

O bloco jurídico elegível usa uma constante local única. Somente `{itemABNT}` varia:

```text
A referida desconformidade infringe o disposto nos arts. 7º, caput, 20, § 2º,
e 39, VIII, da Lei nº 8.078/1990, c/c o art. 12, IX, “a”, do Decreto
nº 2.181/1997, e no item {itemABNT} da ABNT NBR 17225:2025.
```

O texto aparece somente para falha consolidada elegível e sempre junto à qualificação de que não constitui conclusão automática de infração, responsabilidade, sanção ou certificação.

### Task 1: Freeze baseline and execution order

**Files:**
- Read: `manifest.json`
- Read: `package.json`
- Read: `docs/superpowers/specs/2026-08-29-fluxo-visual-painel-lateral-design.md`
- Read: all four plans in this suite

- [ ] **Step 1: Record clean execution baseline**

Run: `git status --short`

Expected: only the approved plan/spec commit range and intentional user changes are present; unrelated changes are identified and left untouched.

Run: `git rev-parse --short HEAD`

Expected: record the exact starting commit in the Marco 1 QA note.

- [ ] **Step 2: Confirm plan contracts before code**

Search all four plans for `src/sidepanel`, `src/report-view`, legacy `START_PERSONA`, undefined release path, or a second CDP transport. Resolve any mismatch in plans before implementation.

### Task 2: Execute and gate Marco 1

**Plan:** `docs/superpowers/plans/2026-08-29-marco-1-painel-relatorio.md`

- [ ] Execute every checkbox in order with TDD and its prescribed commit.
- [ ] Complete both independent critical reviews prescribed by Marco 1 against the same milestone candidate; fix every Critical/Important finding with a RED test and regenerate the two reviews after any material correction. Marco 4 performs two new independent reviews against the final release candidate and ZIP.
- [ ] Run the closing gates once.

Run: `node --test test/e2e/sidepanel-flow-mv3.test.mjs`

Expected: PASS for popup → side panel → summary → report in real Chrome.

Run: `npm test`

Expected: PASS.

Run: `npm run verify`

Expected: PASS without building a ZIP.

### Task 3: Execute and gate Marco 2

**Plan:** `docs/superpowers/plans/2026-08-29-marco-2-personas-destaque.md`

- [ ] Execute every checkbox in order; consume, do not redefine, Marco 1 contracts.
- [ ] Complete the two independent critical reviews for persona/audit and binding/highlight plus the independent medium-risk UI review after Chrome/screenshots exist.
- [ ] Run the closing gates once.

Run: `node --test test/e2e/persona-highlight-flow-mv3.test.mjs`

Expected: PASS, including cleanup and fail-closed reload/SPA/frame/closed-Shadow cases.

Run: `npm test`

Expected: PASS.

Run: `npm run verify`

Expected: PASS without building a ZIP.

### Task 4: Execute and gate Marco 3

**Plan:** `docs/superpowers/plans/2026-08-29-marco-3-privacidade-lote-retencao.md`

- [ ] Execute every checkbox in order; preserve the Marco 1 runner and Marco 2 binding boundaries.
- [ ] Complete both independent critical-risk reviews only after the real-Chrome evidence exists.
- [ ] Run the closing gates once after the last material correction.

Run: `node --test test/e2e/privacy-batch-retention-mv3.test.mjs test/e2e/retention-indexeddb-mv3.test.mjs`

Expected: PASS for pre-pixel pause, three modes, URL/lote, retention and receipt.

Run: `npm test`

Expected: PASS.

Run: `npm run verify`

Expected: PASS without building a ZIP.

### Task 5: Execute Marco 4 and create the only release artifact

**Plan:** `docs/superpowers/plans/2026-08-29-marco-4-qa-release.md`

- [ ] Execute positive, hostile and visual/a11y/PDF gates against the unpacked extension.
- [ ] Create evidence-backed security/privacy and product/accessibility reviews; templates remain `PENDING` until actually completed.
- [ ] Require zero open Critical/Important findings and rerun affected gates after every correction.
- [ ] Only then set version 2.0.0, execute the immutable candidate gate, bind both independent reviews to that candidate commit, runtime tree, tooling tree, QA receipt and ZIP, and promote the already-reviewed bytes.

Run: `node scripts/run-marco4-release-gates.mjs`

Expected: PASS with a clean candidate commit, Chrome 116/current products, the dedicated `retention-deletion-chrome-116` gate, immutable QA evidence, reproducible temporary ZIP bytes, runtime/tooling tree hashes and both packaged smoke tests.

Run: `node scripts/record-marco4-review.mjs --scope security-privacy --reviewer-id <independent-security-reviewer> --evidence-json <closed-evidence-map> --notes-json <closed-notes-map> --findings-json <closed-findings-object>`

Expected: PASS only for a reviewer distinct from the implementer, all fixed checks evidenced, a schema-valid findings record and zero Critical/Important findings for approval.

Run: `node scripts/record-marco4-review.mjs --scope product-accessibility --reviewer-id <independent-product-reviewer> --evidence-json <closed-evidence-map> --notes-json <closed-notes-map> --findings-json <closed-findings-object>`

Expected: PASS only for a second independent reviewer bound to the same commit, runtime/tooling trees, QA receipt, visual reference, ZIP and ZIP manifest, with a schema-valid findings record and zero Critical/Important findings for approval.

Run: `npm run build:release`

Expected: validates both reviews and copies the exact reviewed ZIP bytes to `release/audita-acessibilidade-2.0.0.zip`; it does not rebuild an archive.

Run: `node scripts/verify-marco4-release.mjs --promotion-state`

Expected: PASS after recomputing candidate/runtime/QA/reference/archive/review/final bindings while allowing only the exact uncommitted generated-evidence set.

Commit only the exact generated QA/review/release allowlist enumerated by Marco 4, without rebuilding the ZIP.

Run: `npm run verify:release`

Expected: PASS in final lineage mode with the candidate as ancestor, generated-evidence-only commit and clean worktree.

Run: `shasum -a 256 release/audita-acessibilidade-2.0.0.zip`

Expected: one lowercase 64-character SHA-256 recorded in the release checklist.

Run: `unzip -Z1 release/audita-acessibilidade-2.0.0.zip`

Expected: only `manifest.json`, `src/`, `vendor/` and `assets/icons/` runtime entries; no tests, docs, QA files, source maps or store assets.

## Spec traceability

| Spec section | Implementation owner | Closing evidence |
|---|---|---|
| 1–3 objective, references, UX principles | Marcos 1 and 4 | real flow + visual comparison |
| 4.1 popup | Marcos 1–3 | popup state/unit + Chrome flow |
| 4.2 side panel | Marco 1; actions in 2–3 | reducer/UI + screenshots |
| 4.3 report/exports | Marcos 1 and 3 | report tests + four-download receipt |
| 5 highlight | Marco 2 | locator/controller + hostile E2E |
| 6 modes/aba/lote/personas | Marcos 1–3 | ownership, persona and batch E2E |
| 7 presentation model | Marco 1 | `PanelSummaryV1`/`buildReportView` tests |
| 8 errors | Marcos 1–3 | catalog/sanitization negative tests |
| 9 manifest/privacy/retention | Marcos 1 and 3 | manifest, privacy and retention gates |
| 10 interface accessibility | Marcos 1, 2 and 4 | keyboard/focus/reflow/forced-colors receipt |
| 11 risk strategy | roadmap and every marco | QA notes and independent reviews |
| 12 mandatory tests | every marco; consolidated in 4 | unit/integration/Chrome/visual/PDF logs |
| 13 acceptance criteria | Marco 4 | release checklist with all 18 criteria |
| 14 out of scope | verifier/docs | no crawler/login/cloud/store/certification |

## Self-review

- Every spec section and all 18 acceptance criteria have an implementation owner and closing evidence.
- Cross-plan paths, message names, capture policy, runner return, legal basis and E2E support have one canonical definition.
- No milestone may fabricate review approval, reuse a bearer in a URL, persist raw navigation URL in the model, or create an intermediate ZIP.
- The final release remains neutral, local, installable without login and explicit about automated coverage versus human/legal judgment.

## Execution handoff

Plan suite complete and saved under `docs/superpowers/plans/`. Two execution options:

1. **Subagent-Driven (recommended):** dispatch a fresh implementation subagent per task, followed by spec-compliance and code-quality review before the next task.
2. **Inline Execution:** execute the same tasks in this session with `superpowers:executing-plans`, in batches with review checkpoints.
