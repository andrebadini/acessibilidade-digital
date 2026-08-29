# Marco 4 — QA, documentação e release 2.0.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Demonstrar, revisar e empacotar a versão 2.0.0 do fluxo popup → painel lateral → relatório com evidência reproduzível em Chrome 116 e Chrome atual, QA visual/acessível/PDF mensurado e distribuição exclusivamente por ZIP local.

**Architecture:** O único transporte E2E é `test/e2e/support/real-chrome.mjs`, criado no Marco 1; o Marco 4 apenas amplia essa implementação canônica e a compõe em cenários de aceite. Um executor de gates produz medições, capturas, hashes, manifesto do ZIP e recibos estruturados ligados a um único commit candidato. Dois revisores independentes inspecionam o mesmo commit, o mesmo artefato QA e o mesmo ZIP; a promoção final copia exatamente os bytes revisados.

**Tech Stack:** JavaScript ESM, `node:test`, Node.js (`child_process`, `crypto`, `fs`, `http`, `os`, `path`), Chrome DevTools Protocol, Chrome Extensions Manifest V3, HTML/CSS, `Accessibility.getFullAXTree`, `Page.captureScreenshot`, `Page.printToPDF`, Chrome for Testing 116.0.5845.96 provisionado automaticamente, Info-ZIP 3.0 e SHA-256.

**Spec:** `docs/superpowers/specs/2026-08-29-fluxo-visual-painel-lateral-design.md`

## Global Constraints

- Versão final exatamente `2.0.0`; saída exatamente `release/audita-acessibilidade-2.0.0.zip`.
- MV3, `minimum_chrome_version: "116"`, `side_panel.default_path: "src/panel/index.html"` e `action.default_popup: "src/popup/index.html"` são obrigatórios.
- `action.default_popup` substitui `chrome.action.onClicked`; nenhum runtime ou teste depende do listener histórico.
- Permissões somente `alarms`, `contextMenus`, `debugger`, `downloads`, `scripting`, `sidePanel`, `storage`, `tabs`, e hosts `http://*/*`, `https://*/*`.
- Sem `content_scripts` permanentes, `web_accessible_resources`, código remoto, `unsafe-eval`, origem remota em CSP, login, telemetria, servidor, sincronização, identidade governamental ou publicação em loja.
- O suporte CDP do Marco 1 é a única autoridade de navegador. `click()` usa `Runtime.evaluate({userGesture:true})`; teclado usa `Input.dispatchKeyEvent`. Uma abertura só conta como popup/painel quando `chrome.runtime.getContexts()` informa, respectivamente, `POPUP` e `SIDE_PANEL` com a URL interna esperada.
- O gate provisiona automaticamente o Chrome for Testing exatamente `116.0.5845.96` a partir da URL HTTPS oficial fixada para a plataforma, mede o SHA-256 do arquivo baixado e exige `Browser.getVersion().product === 'Chrome/116.0.5845.96'`. `CHROME_CURRENT_BIN` continua obrigatório e precisa ter major maior que `116`; ausência, igualdade ou versão divergente bloqueia a release.
- O percurso observado é popup → `sidePanel.open()` no gesto → auditoria → sumário → detalhe → destaque seguro → normas/evidências → relatório → “Exportar todos” → HTML/PDF/CSV/JSON-EARL.
- Aba `attached` nunca é navegada nem fechada; apenas `disposable` com propriedade provada é removida.
- Capturas obedecem `full-evidence`, `element-only`, `no-pixels`; sinal sensível pausa antes de pixels e confirmação vinculada ao documento e ao `auditId` é obrigatória nos dois primeiros modos.
- QA compara apenas a região controlada pela extensão contra `docs/superpowers/specs/assets/2026-08-29-sidepanel-option-2.png`, usando o crop `{x:792,y:0,width:695,height:1058}`.
- WCAG 2.2 AA no popup/painel/relatório: teclado, foco, nomes/regiões, exatamente uma região viva por superfície, `forced-colors`, `prefers-reduced-motion`, alvos de pelo menos 44 × 44 CSS px e reflow sem rolagem bidimensional em 320, 380 e 600 CSS px e a 200%.
- O recibo QA armazena observações brutas e hashes: AXTree, sequência real de foco, pixels alterados no indicador, dimensões, `scrollWidth/clientWidth`, durações, cores e marcadores do PDF. Aprovação é calculada desses dados; o executor não grava constantes de sucesso.
- PDF contém todas as ocorrências apesar de filtros. O gate registra `/StructTreeRoot`, `/MarkInfo`, outline e páginas; se o Chrome não os produzir, registra o índice visível de fallback realmente impresso e a limitação, sem alegar PDF marcado.
- A cópia pública declara processamento local, ausência de certificação e instalação por ZIP local. `store-assets/` e toda menção a Chrome Web Store na cópia pública são removidos.
- O diretório vivo de QA nasce sob `realpath(tmpdir())`, não é link simbólico e tem basename `marco-4-output`. Uma cópia fechada e hashada é preservada em `docs/qa/2026-08-29-marco-4/artifact/`.
- O ZIP usa caminhos POSIX ordenados, arquivos modo `0644`, timestamp UTC fixo, Info-ZIP 3.0 com `-X -9`, e manifesto com caminho, modo, tamanho e SHA-256. Dois builds isolados precisam ser byte a byte iguais.
- Reviews de segurança/privacidade e produto/acessibilidade têm revisores distintos do implementador e entre si; ambos ligam o mesmo commit candidato, manifesto, recibo QA, referência visual, ZIP e manifesto de entradas.
- Depois das revisões não se reconstrói o pacote. O ZIP final é uma cópia byte-idêntica do ZIP revisado e o verificador reprova qualquer mudança posterior na árvore de runtime.

---

## File structure and responsibility

| Path | Responsibility |
|---|---|
| `test/e2e/support/real-chrome.mjs` | Transporte CDP canônico do Marco 1; gesto, teclado, contexts, worker e teardown do processo/perfil próprio. |
| `scripts/marco4-e2e-support.mjs` | Composição sem transporte próprio: contexts, downloads, hashes, persistência e recursos observados. |
| `test/e2e/marco4-support-contract.test.mjs` | Prova gesto/Input e ausência de segundo cliente CDP. |
| `test/e2e/marco4-flow-mv3.test.mjs` | Percurso real até quatro exports e recibo recalculado. |
| `test/e2e/marco4-edge-cases-mv3.test.mjs` | SPA, frames, Shadow DOM, privacidade, personas, lote, cancelamento, restart, ownership e rede. |
| `scripts/marco4-qa-measurements.mjs` | Medições brutas de AXTree, foco, alvo, reflow, media, visual e PDF. |
| `scripts/capture-marco4-qa.mjs` | Orquestra superfícies reais e grava o conjunto fechado de QA. |
| `test/e2e/marco4-visual-a11y-pdf.test.mjs` | Recalcula critérios das medições, sem confiar em flags prontas. |
| `docs/qa/2026-08-29-marco-4/{README.md,expected-files.txt}` | Método e lista fechada dos artefatos preservados. |
| `scripts/build-release.mjs` | ZIP determinístico temporário; promoção final não o reinvoca. |
| `scripts/marco4-release-evidence.mjs` | Tipos, validação e hashes dos gates/reviews. |
| `scripts/chrome-116-pins.json`, `scripts/provision-chrome-116.mjs` | Matriz fechada de URLs oficiais por plataforma e provisionamento automático do Chrome for Testing 116.0.5845.96. |
| `scripts/run-marco4-release-gates.mjs` | Executa gates uma vez e preserva QA/ZIP candidato. |
| `scripts/record-marco4-review.mjs` | Grava decisões contra hashes derivados do gate. |
| `scripts/promote-reviewed-release.mjs` | Copia bytes revisados ao `release/`. |
| `scripts/verify-marco4-release.mjs` | Recalcula vínculos, árvore runtime, artefatos e ZIP final. |
| `scripts/marco4-packaged-smoke-mv3.mjs` | Smoke intencionalmente fora do discovery de `node --test`; recebe somente o runtime extraído aprovado. |
| `README.md`, `docs/POLITICA-DE-PRIVACIDADE.md`, `docs/USO-FISCAL.md` | Instalação ZIP, privacidade, retenção e limites reais. |

### Task 1: Prove the real popup → side panel → report → four-export path

**Files:**

- Modify: `test/e2e/support/real-chrome.mjs`
- Create: `scripts/marco4-e2e-support.mjs`
- Create: `test/e2e/marco4-support-contract.test.mjs`
- Create: `test/e2e/fixtures/marco4-flow.html`
- Create: `test/e2e/marco4-flow-mv3.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Consumes `startFixtureServer`, `launchUnpackedExtension`, `click`, `evaluate`, `waitForValue`, `pressKey`, `pressShortcut` and `captureScreenshot` from the Marco 1 support.
- The cumulative launch result is exactly `{extensionId,chromeProduct,downloadDirectory,browser,worker,startPage,networkRecorder,openActionPopup,openExtensionPage,click,evaluate,waitForValue,pressKey,pressShortcut,captureScreenshot,readAttribute,waitForSidePanel,waitForReport,runtimeContexts,identityOf,waitForFourDownloads,captureJourney,captureVisualComparison,suspendWorker,waitForWorkerRestart,close}`. Marco 4 preserves every Marco 1–3 member, adds only the canonical target-stream-backed `networkRecorder`, and creates no second CDP client, profile launcher or fixture server.
- Produces `probeChromeProduct(chromeBinary) -> Promise<string>` and extends the canonical launch result with `.suspendWorker() -> Promise<{previousTargetId:string}>` plus `.waitForWorkerRestart(previousTargetId) -> Promise<Target>`, all by reusing its private CDP/target stream.
- Produces:

```text
export async function readRuntimeContexts(worker)
// -> Array<{contextType,documentId,documentOrigin,documentUrl,tabId,windowId}>

export async function verifyReceiptAgainstDownloads({ worker, receipt, downloadDirectory })
// -> {files:Map<'html'|'pdf'|'csv'|'json',{basename,byteLength,sha256,bytes:Uint8Array}>}

export async function readStoredExportReceipt(worker,auditId)
// -> validated ExportReceiptV1 read directly from the extension's IndexedDB in the worker context

export async function waitForStoredExportReceipt(worker,auditId,{status,timeoutMs})
// -> validated terminal ExportReceiptV1; polls readStoredExportReceipt until status matches or rejects on timeout

export function sha256Hex(bytes)
// -> 64 lowercase hexadecimal characters
```

- `verifyReceiptAgainstDownloads` accepts only a complete `ExportReceiptV1` with four unique formats, calls `chrome.downloads.search({id})`, rejects symlink/non-file/path outside `realpath(downloadDirectory)`, reads bytes and recomputes size/SHA-256.

- [ ] **Step 1: Write the deterministic fixture and failing gesture contract**

```html
<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Marco 4 flow</title></head>
<body><main><h1>Fluxo de aceite</h1>
<img id="missing-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
<label for="name">Nome</label><input id="name" type="text"><p>Evidência local.</p>
</main></body></html>
```

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { CANONICAL_LAUNCH_RESULT_KEYS_V4, click, pressKey, pressShortcut } from './support/real-chrome.mjs';

test('canonical click carries user activation and keyboard uses Input', async () => {
  const calls = [];
  const target = { sessionId: 'session-1', cdp: { send: async (...args) => calls.push(args) } };
  await click(target, '#audit');
  assert.equal(calls[0][0], 'Runtime.evaluate');
  assert.equal(calls[0][1].userGesture, true);
  calls.length = 0;
  await pressKey(target, 'Enter');
  assert.deepEqual(calls.map(call => call[0]), ['Input.dispatchKeyEvent', 'Input.dispatchKeyEvent']);
  calls.length = 0;
  await pressShortcut(target, 'Shift+Tab');
  assert.deepEqual(calls.map(call => call[0]), ['Input.dispatchKeyEvent', 'Input.dispatchKeyEvent']);
  assert.equal(calls[0][1].modifiers, 8);
  assert.deepEqual([...CANONICAL_LAUNCH_RESULT_KEYS_V4].sort(), [
    'extensionId','chromeProduct','downloadDirectory','browser','worker','startPage','networkRecorder',
    'openActionPopup','openExtensionPage','click','evaluate','waitForValue','pressKey','pressShortcut',
    'captureScreenshot','readAttribute','waitForSidePanel','waitForReport','runtimeContexts','identityOf',
    'waitForFourDownloads','captureJourney','captureVisualComparison','suspendWorker',
    'waitForWorkerRestart','close',
  ].sort());
});
```

The same test parses every static import in `scripts/marco4-e2e-support.mjs` and permits only `node:` built-ins plus `../test/e2e/support/real-chrome.mjs`. It rejects `child_process`, `net`, `ws`, `WebSocket`, `spawn`, `exec`, `--remote-debugging-*`, Playwright/Puppeteer/chrome-launcher imports and any locally declared class/object whose name or methods open a CDP transport. A source mutation for each forbidden family proves the boundary test fails. `CANONICAL_LAUNCH_RESULT_KEYS_V4` is a frozen array owned by the canonical support, and its unit fixture validates missing/extra/renamed members.

- [ ] **Step 2: Run focused support test and verify RED**

Run: `node --test test/e2e/marco4-support-contract.test.mjs`

Expected: FAIL if canonical click omits `userGesture:true`, keyboard is not dispatched through `Input`, or the composition module is absent.

- [ ] **Step 3: Make canonical gesture and context interfaces exact**

```js
export async function click(target, selector) {
  const expression = `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!(node instanceof HTMLElement)) throw new Error('Controle não encontrado.'); node.click(); })()`;
  return target.cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  }, target.sessionId);
}
export async function pressKey(target, key) {
  await target.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key }, target.sessionId);
  await target.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key }, target.sessionId);
}
```

`readRuntimeContexts` evaluates `chrome.runtime.getContexts({})`, projects only the six declared fields and sorts by type/URL. `probeChromeProduct` uses the existing launcher, reads `Browser.getVersion().product` and closes its own process/profile in `finally`.

- [ ] **Step 4: Write the failing positive E2E**

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  readRuntimeContexts, readStoredExportReceipt, verifyReceiptAgainstDownloads,
  waitForStoredExportReceipt,
} from '../../scripts/marco4-e2e-support.mjs';
import {
  CANONICAL_LAUNCH_RESULT_KEYS_V4, click, evaluate, launchUnpackedExtension,
  startFixtureServer, waitForValue,
} from './support/real-chrome.mjs';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixturePath = fileURLToPath(new URL('./fixtures/marco4-flow.html', import.meta.url));
const chromeBinary = process.env.CHROME_BIN;
if (!chromeBinary) throw new Error('CHROME_BIN obrigatório.');

test('uses actual POPUP and SIDE_PANEL and verifies downloaded bytes', { timeout: 300_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([
    ['/', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: await readFile(fixturePath, 'utf8') }],
  ]));
  const downloadDirectory = await makeScopedDownloadDirectory(t);
  const app = await launchUnpackedExtension(t, { extensionPath: workspaceRoot, startUrl: `${fixture.origin}/`, downloadDirectory, viewport: { width: 1280, height: 900 }, chromeBinary });
  assert.deepEqual(Object.keys(app).sort(), [...CANONICAL_LAUNCH_RESULT_KEYS_V4].sort());
  const popup = await app.openActionPopup();
  assert.deepEqual((await readRuntimeContexts(app.worker)).filter(item => item.contextType === 'POPUP').map(item => new URL(item.documentUrl).pathname), ['/src/popup/index.html']);
  await click(popup, '[data-action="audit-current-page"]');
  const panel = await app.waitForSidePanel();
  assert.deepEqual((await readRuntimeContexts(app.worker)).filter(item => item.contextType === 'SIDE_PANEL').map(item => new URL(item.documentUrl).pathname), ['/src/panel/index.html']);
  await waitForValue(panel, 'document.body.dataset.screen', value => value === 'result', 120_000);
  await click(panel, 'button[data-filter-dimension="impact"][data-filter-value="critical"]');
  assert.equal(await evaluate(panel, 'document.querySelector(\'button[data-filter-dimension="impact"][data-filter-value="critical"]\').getAttribute("aria-pressed")'), 'true');
  await click(panel, '[data-action="open-occurrence"]');
  await click(panel, '[data-action="highlight-occurrence"]');
  assert.equal(await evaluate(app.startPage, 'document.querySelectorAll("[data-audita-highlight-root]").length'), 1);
  await click(panel, '[data-action="consult-evidence"]');
  assert.match(await evaluate(panel, 'document.body.innerText'), /WCAG 2\.2/iu);
  assert.match(await evaluate(panel, 'document.body.innerText'), /ABNT NBR 17225:2025/iu);
  const auditId = await evaluate(panel, 'document.querySelector("[data-audit-id]")?.dataset.auditId');
  assert.match(auditId, /^[A-Za-z0-9_-]{1,160}$/u);
  await click(panel, '[data-action="open-report"]');
  const report = await app.waitForReport({ auditId });
  const reportContexts = (await readRuntimeContexts(app.worker)).filter(item => item.contextType === 'TAB' && new URL(item.documentUrl).pathname === '/src/review/index.html');
  assert.equal(reportContexts.length, 1);
  assert.equal(new URL(reportContexts[0].documentUrl).search, `?auditId=${encodeURIComponent(auditId)}`);
  const ids = await evaluate(report, '[...document.querySelectorAll("[data-occurrence-id]")].map(node => node.dataset.occurrenceId)');
  await click(report, '[data-action="export-all"]');
  await app.waitForFourDownloads({ auditId });
  const receipt = await waitForStoredExportReceipt(app.worker, auditId, { status: 'complete', timeoutMs: 120_000 });
  assert.deepEqual(receipt, await readStoredExportReceipt(app.worker, auditId));
  const verified = await verifyReceiptAgainstDownloads({ worker: app.worker, receipt, downloadDirectory });
  assert.deepEqual([...verified.files.keys()].sort(), ['csv', 'html', 'json', 'pdf']);
  assert.equal(new TextDecoder().decode(verified.files.get('pdf').bytes.slice(0, 5)), '%PDF-');
  assert.equal(receipt.artifacts.every(item => item.sha256 === verified.files.get(item.format).sha256), true);
  for (const id of ids) for (const format of ['html', 'csv', 'json']) assert.equal(new TextDecoder().decode(verified.files.get(format).bytes).includes(id), true);
  for (const file of verified.files.values()) {
    assert.doesNotMatch(new TextDecoder().decode(file.bytes), /sessionCapabilityId|navigationToken|PixelCaptureConsentV1|PersonaLeaseV1|documentId|tabId|windowId/iu);
  }
});
```

Test-local download setup is exact:

```js
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

async function makeScopedDownloadDirectory(t) {
  const temporaryRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'audita-downloads-'));
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink() || dirname(await realpath(directory)) !== temporaryRoot) throw new Error('Diretório de download inseguro.');
  t.after(() => rm(directory, {recursive:true,force:true}));
  return directory;
}
```

- [ ] **Step 5: Run positive browser gate and verify GREEN**

Run: `CHROME_BIN='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test test/e2e/marco4-support-contract.test.mjs test/e2e/marco4-flow-mv3.test.mjs`

Expected: PASS; actual `POPUP`/`SIDE_PANEL`, highlight, normative/evidence copy, four completed files and recalculated hashes match the receipt.

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/marco4-e2e-support.mjs test/e2e/support/real-chrome.mjs test/e2e/marco4-support-contract.test.mjs test/e2e/fixtures/marco4-flow.html test/e2e/marco4-flow-mv3.test.mjs
git commit -m "test: prove real popup panel and export flow"
```

### Task 2: Prove frames, Shadow DOM, SPA, privacy, personas, batch, restart, and ownership

**Files:**

- Modify: `test/e2e/support/real-chrome.mjs`
- Modify: `scripts/marco4-e2e-support.mjs`
- Create: `test/e2e/fixtures/marco4-spa.html`
- Create: `test/e2e/fixtures/marco4-frame.html`
- Create: `test/e2e/fixtures/marco4-frame-child.html`
- Create: `test/e2e/fixtures/marco4-shadow.html`
- Create: `test/e2e/fixtures/marco4-sensitive.html`
- Create: `test/e2e/marco4-edge-cases-mv3.test.mjs`

**Interfaces:**

- Consumes Task 1 support plus `HighlightBindingV1`, `AuditTargetCapabilityV1`, `PersonaLeaseV1`, `PixelCaptureConsentV1`, `EvidenceUrlV1` and the unified deletion coordinator.
- Consumes the cumulative Task 1 launch-result shape unchanged; `suspendWorker()` and `waitForWorkerRestart(previousTargetId)` remain methods on that same object and reuse its private target-discovery stream.
- Produces:

```text
export async function readPersistenceCorpus(worker)
// -> {localStorageJson,sessionStorageJson,indexedDbJson}
export async function readObservedResourceUrls(app)
// -> {urls:sorted unique request/WebSocket URLs,contextTypes:sorted unique observed context types}
export function assertOnlyLocalRuntimeUrls(observation, {extensionId,loopbackOrigins,requiredContextTypes})
```

- Test-scenario functions, all exported by `scripts/marco4-e2e-support.mjs`, are exact:

```text
export async function completedAudit(t, {app,fixtureName,crossOrigin})
// -> {app,fixture,page,worker,panel,auditId}; starts through popup UI and waits for document.body.dataset.screen=result
export async function startSensitiveAudit(t, {app,mode})
// -> {app,fixture,page,worker,panel,auditId}; selects mode in popup and stops at result or privacy-paused
export async function countCards(panel, {context,classification})
// -> integer count of [data-context][data-classification]
export async function readRasterEvidenceCounts(worker,auditId)
// -> {fullPage:number,elements:number,announcementMaps:number}; read-only from validated AuditModelV2
export async function waitForResult(panel)
// waits for document.body.dataset.screen === 'result'
export async function openBatchPanel(t, {app})
// -> {app,fixture,page,worker,panel}; opens the empty batch form against its own deterministic fixture server
export async function setBatchUrls(panel,urls)
// validates an array of 1..20 http(s) URLs, fills textarea[name=batch-urls] and dispatches input/change
export async function readBatchStates(panel)
// -> waits for a terminal panel screen, then returns ordered closed data-batch-page-state strings
export async function readTargetState(target)
// -> {targetId,url,closed} from Target.getTargetInfo
export async function waitForDocumentChange(target, previousDocumentId)
// -> new nonempty documentId from Runtime context/target observation
export async function readTargetDocumentId(target)
// -> current nonempty documentId from the canonical CDP context stream
export async function reloadTarget(target)
// uses Page.reload and waits for a different proven documentId
export async function openReport(panel, app)
// reads the panel auditId, clicks [data-action=open-report] with userGesture,
// and returns app.waitForReport({auditId})
export async function openEdgeCaseHarness(t,{chromeBinary})
// -> {app,crossOrigin}; owns two deterministic loopback fixture origins and teardown
```

- `readPersistenceCorpus` reads `chrome.storage.local/session` and enumerates every IndexedDB database/store by read-only cursor. It writes no test hook.
- `networkRecorder` is attached by the canonical launcher's existing target stream before the first extension/page navigation. It enables CDP `Network` on every discovered page, popup, panel, report, export and service-worker session and records `Network.requestWillBeSent`, `Network.webSocketCreated` and redirect URLs with the proven context type; worker restarts and newly opened contexts are enrolled by that same stream. `readObservedResourceUrls(app)` reads and freezes that recorder without creating a transport. `assertOnlyLocalRuntimeUrls` requires every declared `requiredContextTypes` member to have been observed and permits only `chrome-extension://<extensionId>/`, `data:`, `blob:` and the exact loopback origins.

- [ ] **Step 1: Write deterministic adverse fixtures**

`marco4-spa.html` replaces `#stable-target` with a new node at the same selector. `marco4-frame.html` has same-origin and sandboxed frames; the E2E assigns a second loopback origin to `#cross-origin-frame`. `marco4-shadow.html` creates open and closed roots with missing-alt images. `marco4-sensitive.html` contains `PASSWORD-7zK2`, `OTP-483921`, `CARD-4111111111111111`, `PRIVATE-MARKER-Q9` and no remote resource. The route map used by `openBatchPanel` also defines `/ok-one`, `/ok-two`, and all `/slow-0` through `/slow-19`; each slow route has `delayMs:30_000`, a local HTML body and cancellation-aware timers inherited from `startFixtureServer`.

- [ ] **Step 2: Write concrete failing navigation/privacy subtests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertOnlyLocalRuntimeUrls, completedAudit, countCards, openBatchPanel, openReport,
  openEdgeCaseHarness, readBatchStates, readObservedResourceUrls, readPersistenceCorpus, readRasterEvidenceCounts,
  readTargetDocumentId, readTargetState, reloadTarget, setBatchUrls, startSensitiveAudit,
  waitForDocumentChange, waitForResult,
} from '../../scripts/marco4-e2e-support.mjs';
import { click, evaluate, waitForValue } from './support/real-chrome.mjs';

const SENSITIVE_SENTINELS = Object.freeze(['PASSWORD-7zK2', 'OTP-483921', 'CARD-4111111111111111', 'PRIVATE-MARKER-Q9']);
const chromeBinary = process.env.CHROME_BIN;
if (!chromeBinary) throw new Error('CHROME_BIN obrigatório.');

export async function runNavigationPrivacySubtests({t,app,crossOrigin}) {
await t.test('rejects replaced SPA node at same selector', async () => {
  const run = await completedAudit(t, { app, fixtureName: 'marco4-spa.html' });
  await click(run.panel, '[data-occurrence-id][data-rule-id="image-alt"] [data-action="open-occurrence"]');
  await click(run.page, '#replace');
  await click(run.panel, '[data-action="highlight-occurrence"]');
  assert.equal(await evaluate(run.page, 'document.querySelectorAll("[data-audita-highlight-root]").length'), 0);
});
await t.test('fails closed in frame and shadow boundaries', async () => {
  const frame = await completedAudit(t, { app, fixtureName: 'marco4-frame.html', crossOrigin });
  assert.equal(await countCards(frame.panel, { context: 'same-origin-frame', classification: 'failed' }), 1);
  assert.match(await evaluate(frame.panel, 'document.body.innerText'), /frames cross-origin ou com sandbox não observados aparecem como limitação/iu);
  const shadow = await completedAudit(t, { app, fixtureName: 'marco4-shadow.html' });
  assert.equal(await countCards(shadow.panel, { context: 'open-shadow-root', classification: 'failed' }), 1);
  assert.match(await evaluate(shadow.panel, 'document.body.innerText'), /Shadow DOM fechado não pode ser inspecionado automaticamente/iu);
});
await t.test('exercises three modes and persists no sentinel', async () => {
  for (const mode of ['full-evidence', 'element-only']) {
    const run = await startSensitiveAudit(t, { app, mode });
    assert.equal(await evaluate(run.panel, 'document.body.dataset.screen'), 'privacy-paused');
    assert.deepEqual(await readRasterEvidenceCounts(run.worker, run.auditId), {
      fullPage: 0, elements: 0, announcementMaps: 0,
    });
    await click(run.panel, '[data-action="confirm-pixels"]');
    await waitForResult(run.panel);
    const raster = await readRasterEvidenceCounts(run.worker, run.auditId);
    assert.equal(raster.elements > 0, true);
    assert.equal(raster.fullPage > 0, mode === 'full-evidence');
    assert.equal(raster.announcementMaps > 0, mode === 'full-evidence');
    assert.equal(await evaluate(run.panel, 'document.querySelector("[data-action=confirm-pixels]") === null'), true);
  }
  const noPixels = await startSensitiveAudit(t, { app, mode: 'no-pixels' });
  await waitForResult(noPixels.panel);
  assert.deepEqual(await readRasterEvidenceCounts(noPixels.worker, noPixels.auditId), {
    fullPage: 0, elements: 0, announcementMaps: 0,
  });
  assert.match(await evaluate(noPixels.panel, 'document.body.innerText'), /nenhuma captura raster/iu);
  const corpus = JSON.stringify(await readPersistenceCorpus(noPixels.worker));
  for (const secret of SENSITIVE_SENTINELS) assert.equal(corpus.includes(secret), false);
});
}
```

- [ ] **Step 3: Add batch/cancel/attached, restart/persona, and network subtests**

```js
export async function runBatchRestartNetworkSubtests({t,app}) {
await t.test('continues batch, cancels and preserves attached tab', async () => {
  const run = await openBatchPanel(t, { app });
  const okOneUrl = new URL('/ok-one', run.fixture.origin).href;
  const okTwoUrl = new URL('/ok-two', run.fixture.origin).href;
  await setBatchUrls(run.panel, [okOneUrl, 'http://127.0.0.1:1/middle-failure', okTwoUrl]);
  await click(run.panel, '[data-action="start-batch"]');
  assert.deepEqual(await readBatchStates(run.panel), ['complete', 'failed', 'complete']);
  const sourceBefore = await readTargetState(run.page);
  const slowUrls = Array.from({length:20}, (_, index) => new URL(`/slow-${index}`, run.fixture.origin).href);
  await setBatchUrls(run.panel, slowUrls);
  await click(run.panel, '[data-action="start-batch"]');
  await waitForValue(run.panel, 'document.body.dataset.screen', value => value === 'running', 10_000);
  await click(run.panel, '[data-action="cancel-audit"]');
  await waitForResult(run.panel);
  assert.equal(await evaluate(run.panel, 'document.body.dataset.sessionStatus'), 'cancelled');
  assert.deepEqual(await readTargetState(run.page), sourceBefore);
});
await t.test('rehydrates same-document persona and re-probes after worker suspension', async () => {
  const run = await startSensitiveAudit(t, { app, mode: 'element-only' });
  const popup = await run.app.openActionPopup();
  await click(popup, 'button[data-persona-mode="reader"]');
  assert.equal(await evaluate(run.page, 'document.documentElement.classList.contains("audita-persona-reader")'), true);
  const { previousTargetId } = await run.app.suspendWorker();
  const rehydratedPopup = await run.app.openActionPopup();
  assert.equal(await evaluate(rehydratedPopup, 'document.querySelector(\'button[data-persona-mode="reader"]\').getAttribute("aria-pressed")'), 'true');
  await click(run.panel, '[data-action="confirm-pixels"]');
  const worker = await run.app.waitForWorkerRestart(previousTargetId);
  await waitForResult(run.panel);
  assert.equal(await evaluate(run.page, 'document.documentElement.classList.contains("audita-persona-reader")'), false);
  const previousDocumentId = await readTargetDocumentId(run.page);
  await reloadTarget(run.page);
  await waitForDocumentChange(run.page, previousDocumentId);
  assert.equal(await evaluate(run.page, 'document.documentElement.className.includes("audita-persona-")'), false);
  assert.equal(await evaluate(run.panel, 'document.querySelector("[data-action=confirm-pixels]") === null'), true);
  const corpus = JSON.stringify(await readPersistenceCorpus(worker));
  for (const secret of SENSITIVE_SENTINELS) assert.equal(corpus.includes(secret), false);
});
await t.test('keeps audit personas report and export local', async () => {
  const run = await completedAudit(t, { app, fixtureName: 'marco4-flow.html' });
  const popup = await run.app.openActionPopup();
  for (const persona of ['reader', 'achromatopsia', 'motor']) {
    await click(popup, `button[data-persona-mode="${persona}"]`);
  }
  await openReport(run.panel, run.app);
  const observation = await readObservedResourceUrls(run.app);
  assertOnlyLocalRuntimeUrls(observation, {
    extensionId: run.app.extensionId, loopbackOrigins: [run.fixture.origin],
    requiredContextTypes: ['PAGE','SERVICE_WORKER','POPUP','SIDE_PANEL','TAB'],
  });
});
}

test('executes every hostile navigation privacy batch restart and network scenario', {timeout:300_000}, async t => {
  const {app,crossOrigin}=await openEdgeCaseHarness(t,{chromeBinary});
  await runNavigationPrivacySubtests({t,app,crossOrigin});
  await runBatchRestartNetworkSubtests({t,app});
});
```

Every scenario function above composes the canonical support and queries documented `data-*` state only. The reload waits for a new `documentId`; consent replay is rejected; attached state is `{targetId,url,closed}` from CDP.

- [ ] **Step 4: Run adverse suite and verify RED**

Run: `CHROME_BIN='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test test/e2e/marco4-edge-cases-mv3.test.mjs`

Expected: FAIL until every named fixture/scenario function exists and behavior fails closed.

- [ ] **Step 5: Implement read-only scenario functions and close regressions**

Generic IndexedDB traversal sorts database/store/key records and replaces unsupported values with type labels. `readRasterEvidenceCounts` uses the public read-only store boundary, validates the model when present, counts only its three raster evidence kinds and returns zeros for a valid pre-model privacy suspension; it never queries marker attributes in the audited DOM. `readTargetDocumentId`/`reloadTarget` use the canonical CDP stream and never expose `documentId` to extension UI. Resource/WebSocket URLs come only from the launch-time canonical CDP `Network` recorder described above, including popup and earlier requests. Cross-origin and sandboxed content not observed is rendered as the fixed limitation from Marco 1 and never as a fabricated card or conforming result. A closed ShadowRoot is not observable and therefore produces no fabricated occurrence/card: the UI records and renders the explicit caveat `Shadow DOM fechado não pode ser inspecionado automaticamente`.

- [ ] **Step 6: Run adverse and focused security tests**

Run: `CHROME_BIN='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test test/e2e/marco4-edge-cases-mv3.test.mjs test/background/run-audit.test.js test/background/run-batch.test.js test/storage/audit-retention.test.js test/core/privacy.test.js test/personas/persona-controller.test.js`

Expected: PASS; all subtests run, attached target is unchanged, stale binding draws nothing, sentinels are absent, restart is safe and runtime URLs are local.

- [ ] **Step 7: Commit**

```bash
git add test/e2e/support/real-chrome.mjs scripts/marco4-e2e-support.mjs test/e2e/fixtures/marco4-spa.html test/e2e/fixtures/marco4-frame.html test/e2e/fixtures/marco4-frame-child.html test/e2e/fixtures/marco4-shadow.html test/e2e/fixtures/marco4-sensitive.html test/e2e/marco4-edge-cases-mv3.test.mjs
git commit -m "test: cover hostile navigation privacy and restart flows"
```

### Task 3: Produce measured visual, accessibility, and PDF QA

**Files:**

- Create: `scripts/marco4-qa-measurements.mjs`
- Create: `scripts/capture-marco4-qa.mjs`
- Create: `test/e2e/fixtures/marco4-qa-empty.html`
- Create: `test/e2e/fixtures/marco4-qa-one.html`
- Create: `test/e2e/fixtures/marco4-qa-many.html`
- Create: `test/e2e/marco4-visual-a11y-pdf.test.mjs`
- Create: `docs/qa/2026-08-29-marco-4/README.md`
- Create: `docs/qa/2026-08-29-marco-4/expected-files.txt`

**Interfaces:**

```text
export async function createMarco4QaWorkspace()
// -> {root:string,outputDirectory:string,close:()=>Promise<void>}
export async function useMarco4QaWorkspace(outputDirectory)
// -> {root:string,outputDirectory:string,close:async()=>{}} after the same tmpdir/realpath/lstat/basename checks
export async function runMarco4Qa({ chromeBinary, extensionRoot, outputDirectory, referenceImage })
// -> frozen QaReceiptV1 also persisted at outputDirectory/qa-receipt.json
export async function measureSurface({ target, surface, viewport, scale })
// -> SurfaceMeasurementV1
export function inspectPdfBytes({ bytes, expectedOccurrenceIds, renderedOccurrenceIds })
// -> PdfMeasurementV1
export const QA_SURFACE_MATRIX_V1
// frozen ordered records {id,surface,state,fixture,viewport,scale,media,artifact}
```

- `createMarco4QaWorkspace` calls `realpath(tmpdir())`, creates one owned parent with `mkdtemp`, creates child `marco-4-output` mode `0700`, and rejects a symlink, nonempty child or path outside that parent.
- `SurfaceMeasurementV1` exact shape:

```text
{
  id, surface: 'popup'|'sidepanel'|'report', state, viewport: {width,height}, scale,
  ax: {nodeCount,headingNames,landmarkRoles,liveRegionNodeIds,unnamedInteractiveNodeIds},
  keyboard: {forwardSelectors,reverseSelectors},
  focus: [{selector,rect,changedPixelCount,outlineWidth,outlineStyle,boxShadow}],
  targets: [{selector,width,height}],
  layout: {clientWidth,scrollWidth,clippedSelectors,overlappingSelectors},
  media: {
    forcedColors: {color,backgroundColor,outlineColor,screenshotSha256},
    reducedMotion: {animationDurationsMs,transitionDurationsMs},
  },
}
```

- `PdfMeasurementV1` exact shape:

```text
{
  sha256,byteLength,pageObjectCount,structTreeRootObjectCount,
  markInfoMarkedTrueCount,outlineObjectCount,
  expectedOccurrenceIds,renderedOccurrenceIds,
  fallback: {reason:'none'|'untagged-by-browser',visibleIndexEntryCount},
}
```

- `QaReceiptV1` contains `schemaVersion:1`, `chromeProduct`, `manifestSha256`, `reference:{path,sha256,crop}`, raw surface measurements, `pdf`, `visualComparison`, and `files:[{path,sha256,byteLength}]`. `files` excludes `qa-receipt.json` to avoid circular hashing.
- `QA_SURFACE_MATRIX_V1` is exactly, in this order: popup `initial` at 1280×800 → `popup-1280x800.png`; side panel `initial|progress|summary|detail|error` at 695×1058 → the five correspondingly named PNGs; side panel `summary` at 320×568, 380×844, 600×800, 695×1058 scale 2 and 695×1058 forced-colors → the five named responsive/media PNGs; report `empty|one-occurrence|many-occurrences` at 794×1123 CSS px → the three named report PNGs. Each record names one of the three deterministic fixtures, except panel error, which starts the production single-URL flow against the harness-owned loopback route `/qa-navigation-failure`; that route accepts the connection and closes it before response headers only after the worker has accepted the authorized start. The audit must enter `failed-before-observation`, publish no model, clean its owned tab and show the fixed visible copy `Não foi possível avaliar esta página.`. IDs and artifacts are unique; `receipt.surfaces` must contain exactly all 14 records in this order and `receipt.files` must contain exactly the 18 preserved files other than `qa-receipt.json`.

- [ ] **Step 1: Define the exact preserved file set**

```text
popup-1280x800.png
sidepanel-initial-695x1058.png
sidepanel-progress-695x1058.png
sidepanel-summary-695x1058.png
sidepanel-detail-695x1058.png
sidepanel-error-695x1058.png
sidepanel-320x568.png
sidepanel-380x844.png
sidepanel-600x800.png
sidepanel-200pct-695x1058.png
sidepanel-forced-colors-695x1058.png
report-empty-a4.png
report-one-occurrence-a4.png
report-many-occurrences-a4.png
visual-reference-crop.png
visual-side-by-side.png
visual-comparison.json
report.pdf
qa-receipt.json
```

- [ ] **Step 2: Write failing measurement test**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createMarco4QaWorkspace, QA_SURFACE_MATRIX_V1, runMarco4Qa, useMarco4QaWorkspace,
} from '../../scripts/capture-marco4-qa.mjs';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const referencePath = fileURLToPath(new URL('../../docs/superpowers/specs/assets/2026-08-29-sidepanel-option-2.png', import.meta.url));
const chromeBinary = process.env.CHROME_BIN;
if (!chromeBinary) throw new Error('CHROME_BIN obrigatório.');

test('derives QA from AXTree, focus pixels, dimensions, layout, media and PDF bytes', { timeout: 300_000 }, async t => {
  const workspace = process.env.AUDITA_MARCO4_QA_OUTPUT
    ? await useMarco4QaWorkspace(process.env.AUDITA_MARCO4_QA_OUTPUT)
    : await createMarco4QaWorkspace();
  if (!process.env.AUDITA_MARCO4_QA_OUTPUT) t.after(workspace.close);
  const receipt = await runMarco4Qa({ chromeBinary, extensionRoot: workspaceRoot, outputDirectory: workspace.outputDirectory, referenceImage: referencePath });
  assert.equal(Number.parseInt(receipt.chromeProduct.match(/Chrome\/(\d+)/u)[1], 10) >= 116, true);
  assert.deepEqual(receipt.reference.crop, { x: 792, y: 0, width: 695, height: 1058 });
  assert.deepEqual(receipt.surfaces.map(({id,state,viewport,scale}) => ({id,state,viewport,scale})),
    QA_SURFACE_MATRIX_V1.map(({id,state,viewport,scale}) => ({id,state,viewport,scale})));
  assert.equal(receipt.surfaces.length, 14);
  assert.deepEqual(receipt.files.map(item => item.path), [
    'popup-1280x800.png','sidepanel-initial-695x1058.png','sidepanel-progress-695x1058.png',
    'sidepanel-summary-695x1058.png','sidepanel-detail-695x1058.png','sidepanel-error-695x1058.png',
    'sidepanel-320x568.png','sidepanel-380x844.png','sidepanel-600x800.png',
    'sidepanel-200pct-695x1058.png','sidepanel-forced-colors-695x1058.png',
    'report-empty-a4.png','report-one-occurrence-a4.png','report-many-occurrences-a4.png',
    'visual-reference-crop.png','visual-side-by-side.png','visual-comparison.json','report.pdf',
  ]);
  for (const surface of receipt.surfaces) {
    assert.equal(surface.ax.headingNames.length > 0, true);
    assert.equal(surface.ax.landmarkRoles.length > 0, true);
    assert.equal(surface.ax.liveRegionNodeIds.length, 1);
    assert.deepEqual(surface.ax.unnamedInteractiveNodeIds, []);
    assert.equal(surface.keyboard.forwardSelectors.length > 1, true);
    assert.deepEqual([...surface.keyboard.forwardSelectors].reverse(), surface.keyboard.reverseSelectors);
    assert.equal(surface.focus.every(item => item.changedPixelCount > 0), true);
    assert.equal(surface.targets.every(item => item.width >= 44 && item.height >= 44), true);
    assert.equal(surface.layout.scrollWidth <= surface.layout.clientWidth, true);
    assert.deepEqual(surface.layout.clippedSelectors, []);
    assert.deepEqual(surface.layout.overlappingSelectors, []);
  }
  assert.equal(receipt.surfaces.flatMap(item => item.media.reducedMotion.animationDurationsMs).every(value => value <= 1), true);
  assert.equal(receipt.surfaces.flatMap(item => item.media.reducedMotion.transitionDurationsMs).every(value => value <= 1), true);
  assert.deepEqual(receipt.pdf.renderedOccurrenceIds, receipt.pdf.expectedOccurrenceIds);
  const structured = receipt.pdf.structTreeRootObjectCount > 0 && receipt.pdf.markInfoMarkedTrueCount > 0;
  const realFallback = receipt.pdf.fallback.reason === 'untagged-by-browser' && receipt.pdf.fallback.visibleIndexEntryCount === receipt.pdf.expectedOccurrenceIds.length;
  assert.equal(structured || realFallback, true);
});
```

The assertions compute pass/fail from recorded values. `runMarco4Qa` never writes `keyboardOnly`, `focusVisible`, `reflow`, `tagged`, `allOccurrencesPrinted` or another predeclared success flag.

- [ ] **Step 3: Run measurement test and verify RED**

Run: `CHROME_BIN='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test test/e2e/marco4-visual-a11y-pdf.test.mjs`

Expected: FAIL because measurement/capture modules do not exist.

- [ ] **Step 4: Implement measured QA and visual comparison**

Use `Accessibility.getFullAXTree` for roles/names/live state. Traverse controls with Tab through `pressKey` and Shift+Tab through `pressShortcut(target,'Shift+Tab')`, recording `activeElement` selectors. For every focused control capture its rectangle before/after focus and compare pixels in a browser canvas; record changed pixels and computed focus styles. Measure every visible `button`, `a[href]`, `input`, `select`, `textarea`, `[role=button]`, and nonnegative `[tabindex]`.

For 320, 380, 600 and 695 CSS px plus 200%, use `Emulation.setDeviceMetricsOverride` and `Emulation.setPageScaleFactor`; record `clientWidth`, `scrollWidth`, clipped controls and intersecting sibling rectangles. For media, use `Emulation.setEmulatedMedia` with `forced-colors: active` and `prefers-reduced-motion: reduce`, then record colors, durations and screenshot hashes.

Crop `{x:792,y:0,width:695,height:1058}` from the selected reference in a loopback canvas page. Render the crop and `sidepanel-summary-695x1058.png` side by side at native size and capture `visual-side-by-side.png`. Write exact comparison data:

```text
{
  schemaVersion: 1,
  reference: {path:'docs/superpowers/specs/assets/2026-08-29-sidepanel-option-2.png',sha256,crop:{x:792,y:0,width:695,height:1058}},
  actual: {path:'sidepanel-summary-695x1058.png',sha256:actualSha256,viewport:{width:695,height:1058}},
  composite: {path:'visual-side-by-side.png',sha256:compositeSha256},
  pixelMeasurement: {comparedPixels,changedPixels,meanAbsoluteChannelDelta},
}
```

Pixel difference is descriptive because fixture content differs from the concept. The product reviewer uses the side-by-side artifact for hierarchy, spacing, crop, typography, borders and state treatment.

Drive every `QA_SURFACE_MATRIX_V1` record through production UI and assert its state before capture. `initial` is captured before start. `progress` uses a loopback `/qa-hold` response barrier, waits for `dataset.screen === 'running'` plus the visible phase `Coletando evidências`, captures, then releases the response. `summary` waits for result with no selected occurrence; `detail` opens the first occurrence. For `error`, open **Outra URL ou lote**, submit the harness-owned HTTP URL ending in `/qa-navigation-failure` through the production single-URL action and let the loopback server destroy that request before headers after start authorization; wait for `dataset.screen === 'error'`, the unavailable copy, absence of a stored result model and confirmed owned-tab cleanup. Responsive/scale/media captures reuse a fresh summary state. Empty/one/many report fixtures are separately audited and opened through the authorized report path. Apply a visible report filter before PDF export, collect the unfiltered occurrence IDs from rendered print DOM, click the production export, await `waitForStoredExportReceipt(worker,auditId,{status:'complete',timeoutMs:120_000})` and `waitForFourDownloads({auditId})`, then inspect the completed `%PDF-` bytes and count `/Type /Page`, `/StructTreeRoot`, `/MarkInfo` with `/Marked true`, and `/Outlines`. If structural markers are absent, count the visible printed fallback index before recording `untagged-by-browser`. A missing matrix member, wrong state, duplicate artifact, empty surface array or incomplete 18-file list rejects before `qa-receipt.json` is written.

- [ ] **Step 5: Run measured and report gates**

Run: `CHROME_BIN='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test test/e2e/marco4-visual-a11y-pdf.test.mjs test/browser/render-pdf.test.js test/report/html.test.js test/report/report-interactions.test.js`

Expected: PASS; all 19 files exist, results derive from observations, all occurrences reach PDF despite active filter, and reference/actual/composite hashes exist.

- [ ] **Step 6: Commit**

```bash
git add scripts/marco4-qa-measurements.mjs scripts/capture-marco4-qa.mjs test/e2e/fixtures/marco4-qa-empty.html test/e2e/fixtures/marco4-qa-one.html test/e2e/fixtures/marco4-qa-many.html test/e2e/marco4-visual-a11y-pdf.test.mjs docs/qa/2026-08-29-marco-4/README.md docs/qa/2026-08-29-marco-4/expected-files.txt
git commit -m "test: measure visual accessibility and PDF quality"
```

### Task 4: Align public copy, version, and deterministic local ZIP contract

**Files:**

- Modify: `manifest.json`
- Modify: `scripts/verify-project.mjs`
- Modify: `scripts/build-release.mjs`
- Modify: `package.json`
- Modify: `test/extension-shell.test.js`
- Modify: `test/integration/project-delivery.test.js`
- Modify: `test/release-assets.test.js`
- Modify: `test/release-package.test.js`
- Modify: `README.md`
- Modify: `docs/POLITICA-DE-PRIVACIDADE.md`
- Modify: `docs/USO-FISCAL.md`
- Delete: `store-assets/STORE-LISTING.md`
- Delete: `store-assets/TEST-INSTRUCTIONS.md`
- Delete: `store-assets/privacy.html`
- Delete: `store-assets/screenshot-panel.png`
- Delete: `store-assets/screenshot-evidence-failed.png`
- Delete: `store-assets/screenshot-evidence-review.png`
- Delete: `release/audita-acessibilidade-1.0.1.zip`

**Interfaces:**

- `build-release.mjs` rejects invocation without `--temporary-release-directory`; with that option it accepts only the canonical directory returned by `mkdtemp(join(realpath(tmpdir()), 'audita-release-test-'))`, then writes one `audita-acessibilidade-2.0.0.zip` and adjacent `audita-acessibilidade-2.0.0.manifest.json`. Only Task 5's promotion script may write the final release path.
- `parseAppleInfoZipVersion(stdout) -> {name:'Info-ZIP',modifier:'Apple Inc.',version:'3.0',releaseDate:'July 5th 2008',display:'Zip 3.0 (July 5th 2008)'}` normalizes CRLF, accepts exactly one whole line matching `This is Zip 3.0 (July 5th 2008), by Info-ZIP, with modifications by Apple Inc.` in the Apple `/usr/bin/zip -v` banner, and rejects missing, duplicate or variant version/date/vendor/modifier lines. `test/release-package.test.js` covers the checked-in representative Apple banner plus CRLF, duplicate, vendor/version/date/modifier mutations and unrelated `zip` output.
- Archive manifest exact shape:

```text
{
  schemaVersion:1,archive:'audita-acessibilidade-2.0.0.zip',sha256,
  zipTool:{path:'/usr/bin/zip',version:'Zip 3.0 (July 5th 2008)'},
  timestampUtc:'2026-08-29T00:00:00.000Z',
  entries:[{path,mode:'0644',byteLength,sha256}],
}
```

- Public copy scan is limited to `manifest.json`, `README.md`, `docs/POLITICA-DE-PRIVACIDADE.md`, `docs/USO-FISCAL.md`, and runtime text files under `src/`. It rejects case-insensitive `Chrome Web Store`, `Web Store`, `publicação em loja`, `console da loja`, government/agency identity and login claims. Planning/research/test history is outside this public-copy scan.
- ZIP roots are exactly `manifest.json`, `src/`, `vendor/`, `assets/icons/`; no docs, tests, fixtures, scripts, QA, source maps, store assets, symlinks or extra ZIP is accepted.

- [ ] **Step 1: Write failing version/copy/deletion/archive assertions**

```js
import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const serviceWorkerSource = await readFile('src/background/service-worker.js', 'utf8');

const STORE_ASSET_PATHS = [
  'store-assets/STORE-LISTING.md', 'store-assets/TEST-INSTRUCTIONS.md',
  'store-assets/privacy.html', 'store-assets/screenshot-panel.png',
  'store-assets/screenshot-evidence-failed.png', 'store-assets/screenshot-evidence-review.png',
];
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function walkRegularFiles(directory) {
  const found = [];
  for (const entry of (await readdir(directory, {withFileTypes:true})).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walkRegularFiles(path));
    else if (entry.isFile()) found.push(path);
    else throw new Error(`Entrada pública não regular: ${path}`);
  }
  return found;
}
async function readPublicCopyCorpus() {
  const fixed = ['manifest.json', 'README.md', 'docs/POLITICA-DE-PRIVACIDADE.md', 'docs/USO-FISCAL.md'];
  const runtimeText = (await walkRegularFiles('src')).filter(path => /\.(?:css|html|js)$/u.test(path));
  return Promise.all([...fixed, ...runtimeText.sort()].map(path => readFile(path, 'utf8')));
}
assert.equal(manifest.version, '2.0.0');
assert.equal(manifest.minimum_chrome_version, '116');
assert.equal(manifest.action.default_popup, 'src/popup/index.html');
assert.deepEqual(manifest.side_panel, { default_path: 'src/panel/index.html' });
assert.equal(serviceWorkerSource.includes('chromeApi.action.onClicked.addListener'), false);
for (const path of STORE_ASSET_PATHS) assert.equal(await exists(path), false);
assert.equal(await exists('release/audita-acessibilidade-1.0.1.zip'), false);
for (const text of await readPublicCopyCorpus()) {
  const forbiddenPublicCopy=new RegExp([
    'Chrome Web Store','Web Store','publicação em loja','console da loja',
    `${'Go'+'verno'} de Mato Grosso`,`${'PRO'+'CON'}-?MT`,'órgão estatal',
  ].join('|'),'iu');
  assert.doesNotMatch(text,forbiddenPublicCopy);
}
for (const path of ['README.md', 'docs/POLITICA-DE-PRIVACIDADE.md', 'docs/USO-FISCAL.md']) {
  assert.match(await readFile(path, 'utf8'), /sem login/iu);
}
```

`test/release-package.test.js` creates two directories with `mkdtemp(join(realpath(tmpdir()), 'audita-release-test-'))`, invokes temporary build once per directory, compares bytes, asserts sorted paths, mode `0644`, fixed timestamp/tool metadata and exact root allowlist.

- [ ] **Step 2: Run delivery tests and verify RED**

Run: `node --test test/extension-shell.test.js test/integration/project-delivery.test.js test/release-assets.test.js test/release-package.test.js`

Expected: FAIL because baseline version/Chrome/surfaces/store materials/legacy ZIP and archive metadata do not meet 2.0.0.

- [ ] **Step 3: Implement deterministic archive and public documentation**

Normalize staged regular files to `0644`, fixed mtime `2026-08-29T00:00:00.000Z`, POSIX separators and bytewise English order. Reject links. Spawn `/usr/bin/zip -v` without shell, pass stdout to `parseAppleInfoZipVersion`, require the exact parsed record above, store only its deterministic `display`, and call `/usr/bin/zip` with `-X`, `-9`, `-q`, then sorted files. Set `TZ=UTC`, `LC_ALL=C`, `SOURCE_DATE_EPOCH=1787961600`. Re-read with `/usr/bin/zipinfo -l` and compare stored mode/path to the adjacent manifest. Never compare or persist the compiler/OS/features lines, which vary across Apple builds despite the same Info-ZIP release.

```js
import { Buffer } from 'node:buffer';

export function parseAppleInfoZipVersion(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > 64_000) throw new TypeError('ZIP_VERSION_OUTPUT_INVALID');
  const normalized = stdout.replace(/\r\n?/gu, '\n');
  const matches = [...normalized.matchAll(/^This is Zip ([0-9]+\.[0-9]+) \(([^)\n]+)\), by (Info-ZIP), with modifications by (Apple Inc)\.$/gmu)];
  if (matches.length !== 1) throw new Error('ZIP_VERSION_BANNER_INVALID');
  const [, version, releaseDate, name, modifierName] = matches[0];
  const modifier = `${modifierName}.`;
  if (version !== '3.0' || releaseDate !== 'July 5th 2008' || name !== 'Info-ZIP' || modifier !== 'Apple Inc.') throw new Error('ZIP_VERSION_UNSUPPORTED');
  return Object.freeze({ name, modifier, version, releaseDate, display: `Zip ${version} (${releaseDate})` });
}
```

Revise the three public documents to observed behavior: local processing; warning and three evidence modes; sensitive pause; sanitized URL; absolute 30-day retention; pending deletion; four formats; no automatic certification/legal conclusion; installation by extracting to a dedicated folder, opening `chrome://extensions`, enabling developer mode, selecting `Carregar sem compactação`, choosing the extracted folder and optionally pinning the icon.

Delete every listed store file and the legacy ZIP explicitly. Do not leave `store-assets/` or create final 2.0.0 ZIP in this task.

Change the temporary builder so a no-argument call fails with `Diretório temporário obrigatório; use a promoção revisada para release final.` Task 5 will repoint `npm run build:release` to the promotion script; there is no command that rebuilds final bytes after review.

- [ ] **Step 4: Run delivery gates separately**

Run: `node --test test/extension-shell.test.js test/integration/project-delivery.test.js test/release-assets.test.js test/release-package.test.js`

Expected: PASS; version, surfaces, public copy, removal, deterministic bytes, modes, order and tool agree.

Run: `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify`

Expected: PASS; manifest/CSP/permissions/vendor/runtime/local-distribution checks pass and no final ZIP is created.

- [ ] **Step 5: Commit**

```bash
git add manifest.json scripts/verify-project.mjs scripts/build-release.mjs package.json test/extension-shell.test.js test/integration/project-delivery.test.js test/release-assets.test.js test/release-package.test.js README.md docs/POLITICA-DE-PRIVACIDADE.md docs/USO-FISCAL.md
git add -u store-assets release/audita-acessibilidade-1.0.1.zip
git commit -m "docs: define deterministic local Audita 2.0.0 package"
```

### Task 5: Implement structured release evidence and byte-preserving promotion

**Files:**

- Create: `scripts/marco4-release-evidence.mjs`
- Create: `scripts/chrome-116-pins.json`
- Create: `scripts/provision-chrome-116.mjs`
- Create: `scripts/run-marco4-release-gates.mjs`
- Create: `scripts/record-marco4-review.mjs`
- Create: `scripts/promote-reviewed-release.mjs`
- Create: `scripts/verify-marco4-release.mjs`
- Create: `scripts/marco4-packaged-smoke-mv3.mjs`
- Create: `test/chrome-116-provisioner.test.js`
- Create: `test/release-evidence-schema.test.js`
- Modify: `test/e2e/privacy-batch-retention-mv3.test.mjs`
- Modify: `test/e2e/retention-indexeddb-mv3.test.mjs`
- Modify: `package.json`

**Interfaces:**

```text
export async function computeRuntimeTreeV1(root)
// -> {sha256,entries:[{path,mode,byteLength,sha256}]}
export async function computeToolingTreeV1(root)
// -> same closed shape for package.json, scripts/** and test/**
export function resolveChrome116Pin({platform,arch})
// -> exact frozen pin for darwin-arm64 or darwin-x64 from scripts/chrome-116-pins.json
export async function provisionChrome116({outputDirectory,platform,arch,fetchImpl,spawnImpl,probeChromeProduct})
// -> {schemaVersion:1,version,platform,sourceUrl,archiveByteLength,archiveSha256,executablePath,chromeProduct}
export function sha256Hex(bytes)
// -> 64 lowercase hexadecimal characters
export function validateGateEvidenceV1(value)
export function validateIndependentReviewsV1({gate,securityReview,productReview})
export async function assertCandidateLineageV1({root,gate,phase})
// phase:'review' requires HEAD===candidateCommit and only gate-generated QA paths dirty;
// phase:'promotion' requires HEAD===candidateCommit and only validated gate/review paths dirty;
// phase:'promotion-state' requires HEAD===candidateCommit and only validated QA/review/release paths dirty;
// phase:'final' requires a clean descendant whose committed diff contains only closed QA/review/release paths
export async function promoteReviewedZipV1({root,gatePath,securityReviewPath,productReviewPath})
// -> {releasePath,sha256,byteIdentical:true}
export const SECURITY_CHECK_IDS = Object.freeze(['manifest-minimal','capability-binding','attached-disposable','privacy-modes','sensitive-pause','worker-restart','retention-deletion','four-artifact-integrity','no-secrets','network-local-only']);
export const PRODUCT_CHECK_IDS = Object.freeze(['popup-sidepanel-contexts','main-flow','persona-actions','visual-reference-comparison','ax-semantics','keyboard-focus','target-size','reflow','forced-colors-reduced-motion','pdf-completeness-structure','local-zip-installation','public-copy-no-store']);
export const RELEASE_GATE_IDS = Object.freeze(['provision-chrome-116','full-suite-current','verify-project','flow-chrome-116','edge-chrome-116','retention-deletion-chrome-116','visual-a11y-pdf-chrome-116','build-candidate-a','build-candidate-b','packaged-smoke-chrome-116','packaged-smoke-current']);
export const GATE_ARTIFACT_PATHS = Object.freeze([
  'artifact/popup-1280x800.png',
  'artifact/sidepanel-initial-695x1058.png',
  'artifact/sidepanel-progress-695x1058.png',
  'artifact/sidepanel-summary-695x1058.png',
  'artifact/sidepanel-detail-695x1058.png',
  'artifact/sidepanel-error-695x1058.png',
  'artifact/sidepanel-320x568.png',
  'artifact/sidepanel-380x844.png',
  'artifact/sidepanel-600x800.png',
  'artifact/sidepanel-200pct-695x1058.png',
  'artifact/sidepanel-forced-colors-695x1058.png',
  'artifact/report-empty-a4.png',
  'artifact/report-one-occurrence-a4.png',
  'artifact/report-many-occurrences-a4.png',
  'artifact/visual-reference-crop.png',
  'artifact/visual-side-by-side.png',
  'artifact/visual-comparison.json',
  'artifact/report.pdf',
  'artifact/qa-receipt.json',
  'artifact/retention-complete-no-retention.json',
  'artifact/retention-expired-tombstone.json',
  'artifact/reviewed-runtime.zip',
  'artifact/reviewed-runtime.manifest.json',
]);
// Private runner-local runGate({id,execArgv,evidenceArgv,env})
// -> Promise<{id,argv:evidenceArgv,startedAt,finishedAt,exitCode,stdoutSha256,stderrSha256}>
```

`execArgv` is used only in memory for `spawn` and is never serialized. `evidenceArgv` is a separately constructed frozen array from the closed gate template; it contains only repository-relative command tokens and the literals `<owned-chrome-116-dir>`, `<owned-build-a>`, `<owned-build-b>` or `<owned-unpacked-runtime>` where execution uses an absolute temporary path. Validation rejects an absolute path, home/tmp prefix, secret-bearing value, extra token or mismatch between the gate ID and its exact evidence template.

The retention gate writes exactly two bounded structured receipts when the runner supplies its owned output paths. `retention-complete-no-retention.json` is `{schemaVersion:1,scenario:'complete-no-retention',auditIdDigest,exportStatus:'complete',formats:['html','pdf','csv','json'],modelVisibleBefore:true,modelVisibleAfter:false,tombstoneCountAfter:0,downloadsPreserved:true}`. `retention-expired-tombstone.json` is `{schemaVersion:1,scenario:'expired-tombstone-recovery',auditIdDigest,modelVisibleAfterStage:false,tombstoneCountAfterStage:1,tombstoneCountAfterRestart:1,tombstoneCountAfterCleanup:0,foreignTabTouched:false}`. `auditIdDigest` is SHA-256 of the canonical local fixture ID; no raw URL, Chrome ID, capability or secret is accepted. The runner validates exact keys/types/transitions before copying/hashing these two files into the gate artifact set.

- `computeRuntimeTreeV1` includes only `manifest.json`, `src/**`, `vendor/**`, `assets/icons/**`, using canonical JSON over sorted entry records.
- `GateEvidenceV1` exact shape:

```text
{
  schemaVersion:1,implementerId,candidateCommit,createdAt,
  chrome:{floorProduct,currentProduct,floorProvision:{version,platform,sourceUrl,archiveByteLength,archiveSha256}},
  manifestSha256,runtimeTreeSha256,toolingTreeSha256,referenceSha256,qaReceiptSha256,
  reviewedZipSha256,reviewedZipManifestSha256,zipTool,
  reproducibility:{archiveASha256,archiveBSha256,manifestASha256,manifestBSha256,byteComparison:0},
  commands:[{id,argv,startedAt,finishedAt,exitCode,stdoutSha256,stderrSha256}],
  artifactFiles:[{path,byteLength,sha256}],
}
```

- Review record exact shape:

```text
{
  schemaVersion:1,
  scope:'security-privacy'|'product-accessibility',reviewerId,reviewedAt,
  candidateCommit,manifestSha256,runtimeTreeSha256,toolingTreeSha256,qaReceiptSha256,
  referenceSha256,reviewedZipSha256,reviewedZipManifestSha256,
  checks:[{id,result:'pass',evidence:[string],notes:string}],
  findings:{
    critical:readonly ReviewFindingV1[],
    important:readonly ReviewFindingV1[],
    minor:readonly ReviewFindingV1[]
  },
  decision:'approved'|'changes-required',
}

ReviewFindingV1 = {id,summary}
```

- The exported arrays above are the only accepted review check IDs and preserve their declared order.
- `scripts/chrome-116-pins.json` is exactly:

```json
{
  "schemaVersion": 1,
  "version": "116.0.5845.96",
  "platforms": {
    "darwin-arm64": {
      "url": "https://storage.googleapis.com/chrome-for-testing-public/116.0.5845.96/mac-arm64/chrome-mac-arm64.zip",
      "archiveByteLength": 124002688,
      "archiveSha256": "5d1ed2c87a9fb47b20aa6ac3bff49e193ea3ddfbaba07b062c8d1782cf853e69",
      "archiveRoot": "chrome-mac-arm64",
      "executable": "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    },
    "darwin-x64": {
      "url": "https://storage.googleapis.com/chrome-for-testing-public/116.0.5845.96/mac-x64/chrome-mac-x64.zip",
      "archiveByteLength": 131215789,
      "archiveSha256": "edc8e78f7a4b618037067593b2cb79ff571c16da0b955bc05a500af34b77d2fe",
      "archiveRoot": "chrome-mac-x64",
      "executable": "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    }
  }
}
```

Extra platforms/keys, redirects outside `https://storage.googleapis.com/chrome-for-testing-public/116.0.5845.96/`, byte length/SHA-256 different from the committed pin, a mismatched archive root, non-ZIP response, unsafe link, path traversal, non-owned output or a product other than exact `Chrome/116.0.5845.96` reject closed. The two pin values above were measured from the exact official objects and are independently re-downloaded/rehashed in the security review; changing URL, size or digest requires a new candidate and both reviews.
- `provisionChrome116` receives the gate runner's newly created empty owned directory under `realpath(tmpdir())`, downloads with Node `fetch` and a 120-second abort deadline, bounds bytes to the exact pinned size, hashes the exact response bytes and compares both size and SHA-256 before writing/extracting. Before extraction it parses the ZIP central directory and stored symlink payloads with bounded Node code, rejecting absolute/backslash/NUL/`.`/`..` paths, device entries, duplicate names and anything outside the pinned `archiveRoot`. A symlink is allowed only when its payload is a relative POSIX target with no empty/`.`/`..` component and resolving it from the link's parent stays under `archiveRoot`; cycles, links to links not proven safe and unsupported compression reject. Only after every entry passes may `/usr/bin/ditto -x -k` extract beside the archive. A post-walk accepts directories, regular files and only those predeclared symlinks; it uses `lstat`/`readlink`, revalidates the relative target and canonical containment without following an unvalidated chain. It requires exactly `chrome-116.zip` plus the pinned root at top level and proves the executable's realpath remains under that root before canonical `probeChromeProduct`. Its CLI accepts exactly `--output-directory <path> --json` and emits one JSON line; tests inject fetch/spawn/probe doubles and therefore never use the network.
- `validateGateEvidenceV1` requires the exact `RELEASE_GATE_IDS` sequence, every `exitCode` equal to zero, exact floor product/provision pin, current Chrome major greater than 116, `artifactFiles` with exactly the 23 `GATE_ARTIFACT_PATHS` records in declared order, valid retention receipts at their two fixed positions, and identical A/B archive/manifests before it accepts a candidate.
- Each `ReviewFindingV1` is a newly copied plain record with exactly `{id,summary}`. `id` matches `/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u`, is unique across all three severity arrays, and `summary` has 1–2,000 UTF-8 bytes after requiring at least one non-whitespace character. Getters, inherited fields, extra keys and duplicate IDs reject the complete review.
- Review-record validation requires the exact scope ID set, nonempty evidence/notes, every recorded check `pass`, reviewer identity distinct from `implementerId`, and all eight binding fields identical to the gate. `decision:'approved'` is valid exactly when `critical` and `important` are empty; any nonempty `critical` or `important` requires and preserves `decision:'changes-required'`. `minor` alone does not block approval. `validateIndependentReviewsV1` additionally requires two distinct reviewers, both decisions `approved`, and therefore empty critical/important arrays before promotion.
- Promotion requires candidate lineage in `promotion`, recomputes current runtime/tooling/artifact hashes, validates both reviews, and copies `docs/qa/2026-08-29-marco-4/artifact/reviewed-runtime.zip` to `release/audita-acessibilidade-2.0.0.zip`; then it requires `Buffer.compare(reviewed,released) === 0`. It never calls the build script.

- [ ] **Step 1: Write failing schema, independence, mutation and promotion tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GATE_ARTIFACT_PATHS, PRODUCT_CHECK_IDS, RELEASE_GATE_IDS, SECURITY_CHECK_IDS,
  validateIndependentReviewsV1,
} from '../scripts/marco4-release-evidence.mjs';

const HASH = 'a'.repeat(64);
const EVIDENCE_ARGV_BY_GATE = Object.freeze({
  'provision-chrome-116': ['node','scripts/provision-chrome-116.mjs','--output-directory','<owned-chrome-116-dir>','--json'],
  'full-suite-current': ['npm','test'],
  'verify-project': ['npm','run','verify'],
  'flow-chrome-116': ['node','--test','test/e2e/marco4-flow-mv3.test.mjs'],
  'edge-chrome-116': ['node','--test','test/e2e/marco4-edge-cases-mv3.test.mjs'],
  'retention-deletion-chrome-116': ['node','--test','test/e2e/privacy-batch-retention-mv3.test.mjs','test/e2e/retention-indexeddb-mv3.test.mjs'],
  'visual-a11y-pdf-chrome-116': ['node','--test','test/e2e/marco4-visual-a11y-pdf.test.mjs'],
  'build-candidate-a': ['node','scripts/build-release.mjs','--temporary-release-directory','<owned-build-a>'],
  'build-candidate-b': ['node','scripts/build-release.mjs','--temporary-release-directory','<owned-build-b>'],
  'packaged-smoke-chrome-116': ['node','--test','scripts/marco4-packaged-smoke-mv3.mjs'],
  'packaged-smoke-current': ['node','--test','scripts/marco4-packaged-smoke-mv3.mjs'],
});
function validGateEvidence() {
  return {
    schemaVersion: 1, implementerId: 'implementer', candidateCommit: '1'.repeat(40), createdAt: '2026-08-29T12:00:00.000Z',
    chrome: { floorProduct: 'Chrome/116.0.5845.96', currentProduct: 'Chrome/140.0.7339.82', floorProvision: { version: '116.0.5845.96', platform: 'darwin-arm64', sourceUrl: 'https://storage.googleapis.com/chrome-for-testing-public/116.0.5845.96/mac-arm64/chrome-mac-arm64.zip', archiveByteLength: 124002688, archiveSha256: '5d1ed2c87a9fb47b20aa6ac3bff49e193ea3ddfbaba07b062c8d1782cf853e69' } },
    manifestSha256: HASH, runtimeTreeSha256: HASH, toolingTreeSha256: HASH, referenceSha256: HASH, qaReceiptSha256: HASH,
    reviewedZipSha256: HASH, reviewedZipManifestSha256: HASH, zipTool: {path:'/usr/bin/zip',version:'Zip 3.0 (July 5th 2008)'},
    reproducibility: { archiveASha256: HASH, archiveBSha256: HASH, manifestASha256: HASH, manifestBSha256: HASH, byteComparison: 0 },
    commands: RELEASE_GATE_IDS.map(id => ({ id, argv: EVIDENCE_ARGV_BY_GATE[id], startedAt: '2026-08-29T12:00:00.000Z', finishedAt: '2026-08-29T12:01:00.000Z', exitCode: 0, stdoutSha256: HASH, stderrSha256: HASH })),
    artifactFiles: GATE_ARTIFACT_PATHS.map(path => ({ path, byteLength: 100, sha256: HASH })),
  };
}
function validReview(scope, reviewerId) {
  const gate = validGateEvidence();
  const ids = scope === 'security-privacy' ? SECURITY_CHECK_IDS : PRODUCT_CHECK_IDS;
  return {
    schemaVersion: 1, scope, reviewerId, reviewedAt: '2026-08-29T13:00:00.000Z',
    candidateCommit: gate.candidateCommit, manifestSha256: HASH, runtimeTreeSha256: HASH, toolingTreeSha256: HASH,
    qaReceiptSha256: HASH, referenceSha256: HASH, reviewedZipSha256: HASH, reviewedZipManifestSha256: HASH,
    checks: ids.map(id => ({ id, result: 'pass', evidence: ['gate-evidence.json'], notes: `Inspeção factual: ${id}` })),
    findings: { critical: [], important: [], minor: [] }, decision: 'approved',
  };
}
test('reviews bind one candidate and two independent reviewers', () => {
  const gate = validGateEvidence();
  const security = validReview('security-privacy', 'reviewer-security');
  const product = validReview('product-accessibility', 'reviewer-product');
  assert.doesNotThrow(() => validateIndependentReviewsV1({ gate, securityReview: security, productReview: product }));
  assert.throws(() => validateIndependentReviewsV1({ gate, securityReview: security, productReview: { ...product, reviewerId: security.reviewerId } }), /revisores distintos/iu);
  assert.throws(() => validateIndependentReviewsV1({ gate, securityReview: security, productReview: { ...product, reviewedZipSha256: '0'.repeat(64) } }), /ZIP revisado/iu);
  assert.throws(() => validateIndependentReviewsV1({ gate, securityReview: { ...security, findings: { critical: [{id:'leak',summary:'segredo'}], important: [], minor: [] } }, productReview: product }), /achado crítico/iu);
});
```

Add filesystem cases for a changed runtime file, changed `package.json`/`scripts/**`/`test/**`, candidate `HEAD` mismatch, dirty path outside the exact QA allowlist, missing/reordered/extra `GATE_ARTIFACT_PATHS`, QA receipt, ZIP byte, symlink artifact, mismatched archive manifest and final file differing by one byte. Add recorder cases in which bounded nonempty critical/important findings persist unchanged with `decision:'changes-required'` and are rejected by promotion; duplicate IDs, extra finding keys, oversized summaries and an `approved` decision with blocking findings reject closed. Add rerun cases proving that a prior regular, schema-valid `changes-required` review whose scope/path and eight bindings match the prior gate is removed only after every candidate file validates; a wrong scope/path, candidate/hash binding, decision/findings relation, reviewer identity, symlink or malformed review must fail before any removal occurs. In `test/chrome-116-provisioner.test.js`, cover both exact Darwin size/SHA pins, one-byte/one-length mutation, unsupported platform/arch, redirect outside the pinned prefix, timeout, non-ZIP bytes, ZIP traversal/root mismatch, safe in-root relative framework symlinks, absolute/parent/cyclic/out-of-root symlinks, extraction failure, product mismatch, exact success JSON and cleanup limited to the owned output; use injected fetch/spawn/probe doubles only.

- [ ] **Step 2: Run evidence tests and verify RED**

Run: `node --test test/chrome-116-provisioner.test.js test/release-evidence-schema.test.js`

Expected: FAIL because provisioner/evidence/recorder/verifier/promotion modules do not exist.

- [ ] **Step 3: Implement gate runner with a closed command set**

`run-marco4-release-gates.mjs` requires nonempty `AUDITA_IMPLEMENTER_ID` and `CHROME_CURRENT_BIN`; it rejects `CHROME_116_BIN` so the floor cannot be silently substituted. At entry it inspects `git status --porcelain=v1 -z`. A first run requires no generated QA/gate/review files. On a rerun, it first reads and validates the prior `gate-evidence.json` without modifying disk. It may then remove only regular, non-symlink paths from the exact generated allowlist under `docs/qa/2026-08-29-marco-4/`: QA/archive files whose current size/hash equals the prior gate's exact `artifactFiles`, plus `gate-evidence.json` after its complete validation. A prior review file is removable without a self-hash only after its complete record passes the closed review-record validator, its filename agrees with its scope, and all eight binding fields equal the validated prior gate; both `approved` and `changes-required` records are eligible. A review with wrong scope/path, candidate, binding, decision/findings relation, schema or reviewer identity fails closed. Any other dirty path, changed generated file, symlink/non-file entry, missing prior binding, `release-evidence.json`, or existing final release ZIP fails closed. After validating every candidate for removal, the runner removes the explicit list, requires a clean worktree and records the new `HEAD` as the candidate. It creates one owned temporary browser directory, runs the `provision-chrome-116` command first, parses its single closed JSON line, then independently re-probes its executable. It probes `CHROME_CURRENT_BIN` separately; the floor product must be exact and current major greater than 116. `docs/qa/2026-08-29-marco-4/README.md` is completed and committed in Task 3, remains unchanged after candidate selection and is never part of the generated allowlist; all later factual results live only in the closed structured evidence files.

Create QA only through `createMarco4QaWorkspace`. Set `AUDITA_MARCO4_QA_OUTPUT` to that safe directory so the current-Chrome full suite produces the one retained QA set. Execute sequentially with `spawn`, never a shell:

```js
const gates = [
  {id:'full-suite-current',execArgv:['npm','test'],evidenceArgv:['npm','test'],chrome:'current',qaOutput:true},
  {id:'verify-project',execArgv:['npm','run','verify'],evidenceArgv:['npm','run','verify'],env:{AUDITA_VERIFY_SKIP_TESTS:'1'}},
  {id:'flow-chrome-116',execArgv:['node','--test','test/e2e/marco4-flow-mv3.test.mjs'],evidenceArgv:['node','--test','test/e2e/marco4-flow-mv3.test.mjs'],chrome:'floor'},
  {id:'edge-chrome-116',execArgv:['node','--test','test/e2e/marco4-edge-cases-mv3.test.mjs'],evidenceArgv:['node','--test','test/e2e/marco4-edge-cases-mv3.test.mjs'],chrome:'floor'},
  {id:'retention-deletion-chrome-116',execArgv:['node','--test','test/e2e/privacy-batch-retention-mv3.test.mjs','test/e2e/retention-indexeddb-mv3.test.mjs'],evidenceArgv:['node','--test','test/e2e/privacy-batch-retention-mv3.test.mjs','test/e2e/retention-indexeddb-mv3.test.mjs'],chrome:'floor',retentionEvidence:true},
  {id:'visual-a11y-pdf-chrome-116',execArgv:['node','--test','test/e2e/marco4-visual-a11y-pdf.test.mjs'],evidenceArgv:['node','--test','test/e2e/marco4-visual-a11y-pdf.test.mjs'],chrome:'floor'},
];
```

Before this array, the runner executes `provision-chrome-116` with `execArgv:['node','scripts/provision-chrome-116.mjs','--output-directory',chrome116Directory,'--json']` and records only `evidenceArgv:['node','scripts/provision-chrome-116.mjs','--output-directory','<owned-chrome-116-dir>','--json']`; `chrome116Directory` is a newly created empty owned child of the runner's canonical temporary root. It requires stdout of at most 8 KiB containing exactly one newline-terminated JSON object and assigns `chrome116` only from its closed validated `executablePath`.

For each later record, `chrome:'current'` sets only `CHROME_BIN=process.env.CHROME_CURRENT_BIN`; `chrome:'floor'` sets only `CHROME_BIN=chrome116`; `qaOutput:true` additionally sets `AUDITA_MARCO4_QA_OUTPUT` to the validated safe QA directory. `retentionEvidence:true` sets two exact output file paths under the same owned live QA directory; the two tests write atomically only after their observed terminal assertions, and the runner validates them before copying. Other environment variables are inherited, while `AUDITA_IMPLEMENTER_ID`, `CHROME_CURRENT_BIN`, browser/provisioner/QA/retention output paths and resulting control values are never copied into logs or evidence argv.

The security-review check `retention-deletion` must cite the `retention-deletion-chrome-116` command record plus both fixed retention receipt artifact paths. `record-marco4-review.mjs` rejects that check if any of the three citations is absent or points to a different ID/path; evidence from the current-Chrome full suite alone cannot satisfy it.

After these pass, append command records `build-candidate-a`, `build-candidate-b`, `packaged-smoke-chrome-116`, and `packaged-smoke-current`. Build into two separately validated temp directories, compare archive and adjacent manifest bytes, unpack the first ZIP under another owned temp directory, and invoke `node --test scripts/marco4-packaged-smoke-mv3.mjs` once with floor Chrome and once with current Chrome. Keeping the smoke under `scripts/` makes exclusion from the default `node --test` discovery structural rather than filename-convention dependent. The smoke imports only `../test/e2e/support/real-chrome.mjs` and `./marco4-e2e-support.mjs`, launches `AUDITA_EXTENSION_ROOT`, obtains real `POPUP`/`SIDE_PANEL`, completes one audit and proves no source outside four allowed runtime roots is needed.

```js
export async function runArchiveAndPackagedGates({runGate,releaseDirectoryA,releaseDirectoryB,chrome116,chromeCurrent,unpackedRoot}) {
await runGate({id:'build-candidate-a',execArgv:['node','scripts/build-release.mjs','--temporary-release-directory',releaseDirectoryA],evidenceArgv:['node','scripts/build-release.mjs','--temporary-release-directory','<owned-build-a>']});
await runGate({id:'build-candidate-b',execArgv:['node','scripts/build-release.mjs','--temporary-release-directory',releaseDirectoryB],evidenceArgv:['node','scripts/build-release.mjs','--temporary-release-directory','<owned-build-b>']});
await runGate({id:'packaged-smoke-chrome-116',execArgv:['node','--test','scripts/marco4-packaged-smoke-mv3.mjs'],evidenceArgv:['node','--test','scripts/marco4-packaged-smoke-mv3.mjs'],env:{CHROME_BIN:chrome116,AUDITA_EXTENSION_ROOT:unpackedRoot}});
await runGate({id:'packaged-smoke-current',execArgv:['node','--test','scripts/marco4-packaged-smoke-mv3.mjs'],evidenceArgv:['node','--test','scripts/marco4-packaged-smoke-mv3.mjs'],env:{CHROME_BIN:chromeCurrent,AUDITA_EXTENSION_ROOT:unpackedRoot}});
}
```

Copy the closed 19-file QA set plus the two validated retention receipts, first ZIP as `artifact/reviewed-runtime.zip`, and its manifest as `artifact/reviewed-runtime.manifest.json`. Validate the archive destination as a real directory inside the repository; on a rerun remove only paths enumerated by `expected-files.txt`, the two named retention receipts and the two reviewed-runtime files. Compute and store both `runtimeTreeSha256` and `toolingTreeSha256`; the tooling tree covers `package.json`, every regular non-symlink file under `scripts/` and every regular non-symlink file under `test/`, all sorted canonically. Hash every copied file, then write `gate-evidence.json` last. Command records store output hashes, not raw output that could contain secrets.

- [ ] **Step 4: Implement review recorder and promotion**

`record-marco4-review.mjs` accepts exactly `--scope`, `--reviewer-id`, `--evidence-json`, `--notes-json`, `--findings-json`. Evidence JSON maps each fixed ID to existing gate IDs/artifact paths; notes JSON maps each ID to a nonempty factual observation. Findings JSON has exact shape `{critical:[{id,summary}],important:[{id,summary}],minor:[{id,summary}]}` with bounded unique IDs and nonempty summaries. The recorder first requires candidate lineage in `review`, derives all hash/commit fields from the gate, refuses implementer ID and an ID used by the other scope, and writes `decision:'changes-required'` when critical or important is nonempty; only empty critical/important permits `approved`.

`promote-reviewed-release.mjs` accepts no path argument, validates fixed repository-relative paths, requires candidate lineage in `promotion`, recomputes runtime/tooling/bindings, copies reviewed bytes, and writes `docs/qa/2026-08-29-marco-4/release-evidence.json`:

```text
{schemaVersion:1,candidateCommit,runtimeTreeSha256,toolingTreeSha256,reviewedZipSha256,finalZipSha256,byteComparison:0,promotedAt}
```

`verify-marco4-release.mjs` accepts exactly zero arguments, `--candidate-state` or `--promotion-state`. `--candidate-state` runs `assertCandidateLineageV1({phase:'review'})` plus runtime/tooling/hash checks and is the mandatory pre-review check. `--promotion-state` runs `assertCandidateLineageV1({phase:'promotion-state'})`, requires `HEAD === candidateCommit`, recomputes all runtime/tooling/QA/reference/archive/review/final bindings, requires `release-evidence.json` and the final ZIP, and permits dirty paths only from the exact generated QA/review/release allowlist produced by the validated gate, recorders and promotion; missing, extra, staged, modified source/tooling or symlink paths fail closed. It is the mandatory verification after promotion and before committing generated evidence. With no argument the verifier validates final lineage after that commit: the candidate must be an ancestor of `HEAD`, the committed diff may contain only the exact QA/review/release allowlist, every binding is recomputed, and the worktree must be clean. Set package scripts exactly to `"build:release": "node scripts/promote-reviewed-release.mjs"` and `"verify:release": "node scripts/verify-marco4-release.mjs"`. The gate runner invokes the temporary builder directly with the validated option; neither package command rebuilds an archive.

- [ ] **Step 5: Run schema and archive gates**

Run: `node --test test/chrome-116-provisioner.test.js test/release-evidence-schema.test.js test/release-package.test.js`

Expected: PASS; mutations/independence fail closed, ZIP metadata is deterministic, and promotion cannot rebuild or accept changed bytes.

- [ ] **Step 6: Commit infrastructure before selecting candidate**

```bash
git add package.json scripts/chrome-116-pins.json scripts/provision-chrome-116.mjs scripts/marco4-release-evidence.mjs scripts/run-marco4-release-gates.mjs scripts/record-marco4-review.mjs scripts/promote-reviewed-release.mjs scripts/verify-marco4-release.mjs scripts/marco4-packaged-smoke-mv3.mjs test/chrome-116-provisioner.test.js test/release-evidence-schema.test.js test/e2e/privacy-batch-retention-mv3.test.mjs test/e2e/retention-indexeddb-mv3.test.mjs
git commit -m "test: bind release evidence to reviewed bytes"
```

Run: `git status --short`

Expected: no output. This clean `HEAD` is the candidate consumed by Task 6.

### Task 6: Execute candidate gates, obtain independent reviews, and promote exact bytes

**Files:**

- Create: `docs/qa/2026-08-29-marco-4/artifact/popup-1280x800.png`
- Create: `docs/qa/2026-08-29-marco-4/artifact/sidepanel-initial-695x1058.png`
- Create: `docs/qa/2026-08-29-marco-4/artifact/sidepanel-progress-695x1058.png`
- Create: `docs/qa/2026-08-29-marco-4/artifact/sidepanel-summary-695x1058.png`
- Create: `docs/qa/2026-08-29-marco-4/artifact/sidepanel-detail-695x1058.png`
- Create: `docs/qa/2026-08-29-marco-4/artifact/sidepanel-error-695x1058.png`
- Create: `docs/qa/2026-08-29-marco-4/artifact/sidepanel-320x568.png`
- Create: `docs/qa/2026-08-29-marco-4/artifact/sidepanel-380x844.png`
- Create: `docs/qa/2026-08-29-marco-4/artifact/sidepanel-600x800.png`
- Create: `docs/qa/2026-08-29-marco-4/artifact/sidepanel-200pct-695x1058.png`
- Create: `docs/qa/2026-08-29-marco-4/artifact/sidepanel-forced-colors-695x1058.png`
- Create: `docs/qa/2026-08-29-marco-4/artifact/report-empty-a4.png`
- Create: `docs/qa/2026-08-29-marco-4/artifact/report-one-occurrence-a4.png`
- Create: `docs/qa/2026-08-29-marco-4/artifact/report-many-occurrences-a4.png`
- Create: `docs/qa/2026-08-29-marco-4/artifact/visual-reference-crop.png`
- Create: `docs/qa/2026-08-29-marco-4/artifact/visual-side-by-side.png`
- Create: `docs/qa/2026-08-29-marco-4/artifact/visual-comparison.json`
- Create: `docs/qa/2026-08-29-marco-4/artifact/report.pdf`
- Create: `docs/qa/2026-08-29-marco-4/artifact/qa-receipt.json`
- Create: `docs/qa/2026-08-29-marco-4/artifact/retention-complete-no-retention.json`
- Create: `docs/qa/2026-08-29-marco-4/artifact/retention-expired-tombstone.json`
- Create: `docs/qa/2026-08-29-marco-4/artifact/reviewed-runtime.zip`
- Create: `docs/qa/2026-08-29-marco-4/artifact/reviewed-runtime.manifest.json`
- Create: `docs/qa/2026-08-29-marco-4/gate-evidence.json`
- Create: `docs/qa/2026-08-29-marco-4/review-security-privacy.json`
- Create: `docs/qa/2026-08-29-marco-4/review-product-accessibility.json`
- Create: `docs/qa/2026-08-29-marco-4/release-evidence.json`
- Create: `release/audita-acessibilidade-2.0.0.zip`

**Interfaces:**

- Consumes committed Task 5 runner/validators and candidate `HEAD`; no runtime file may change after gate start.
- Produces one preserved QA artifact, two independently authored reviews, byte-identical final ZIP and machine-verifiable release record.

- [ ] **Step 1: Execute complete candidate gate once**

Before this step, set only `AUDITA_IMPLEMENTER_ID` and `CHROME_CURRENT_BIN` in the execution environment; leave `CHROME_116_BIN` unset. The gate automatically downloads/extracts the exact pinned Chrome for Testing 116 into its owned temporary directory, validates both products through CDP and accepts no skip/fallback/substitution flag.

Run: `node scripts/run-marco4-release-gates.mjs`

Expected: PASS; output reports candidate commit, the `provision-chrome-116` record with exact pinned size/SHA and `Chrome/116.0.5845.96`, current Chrome product, 19 QA files, two retention receipts, identical temporary ZIP hashes, two packaged-ZIP smokes and all 23 preserved artifact paths. Current major is greater than 116.

- [ ] **Step 2: Confirm the candidate remains immutable before review**

Run: `node scripts/verify-marco4-release.mjs --candidate-state`

Expected: PASS only when `HEAD` still equals `gate.candidateCommit`, runtime/tooling hashes match and every dirty path belongs to the exact gate-generated QA allowlist.

Run: `node --test test/chrome-116-provisioner.test.js test/release-evidence-schema.test.js test/release-package.test.js`

Expected: PASS; the already-committed mutation, review-independence and byte-preserving promotion tests remain green. No source or test file is created after candidate selection.

- [ ] **Step 3: Complete security/privacy review against candidate**

A reviewer whose ID differs from `gate.implementerId` reads the full spec, candidate diff, gate record, archive manifest, QA receipt and security evidence. They inspect all ten fixed checks and record factual evidence/notes/findings. A critical or important finding blocks approval; correct it with focused RED test, commit, rerun Step 1 for the new candidate and review new hashes.

The security reviewer writes the exact fixed-ID maps to `/tmp/audita-marco4-security-evidence.json` and `/tmp/audita-marco4-security-notes.json`, plus the closed findings object to `/tmp/audita-marco4-security-findings.json`; the recorder rejects links, non-files and keys outside the security ID set. When findings require changes, run the recorder once to preserve `changes-required`, then fix with a RED test, commit and rerun the complete gate for a new candidate before a new review.

Run: `node scripts/record-marco4-review.mjs --scope security-privacy --reviewer-id reviewer-security --evidence-json /tmp/audita-marco4-security-evidence.json --notes-json /tmp/audita-marco4-security-notes.json --findings-json /tmp/audita-marco4-security-findings.json`

Expected: PASS and a persisted `changes-required` record when bounded critical/important findings are nonempty; PASS with `approved` only after all ten checks, empty critical/important arrays and gate-derived bindings. Only the latter may proceed to promotion.

- [ ] **Step 4: Complete product/accessibility review independently**

A second reviewer inspects actual popup/panel/report, `visual-reference-crop.png`, `sidepanel-summary-695x1058.png`, and `visual-side-by-side.png` together; then layout, padding, crop, typography, borders, focus, AXTree, targets, reflow, media features, empty/one/many reports, PDF structure/fallback, packaged ZIP and public copy. They record all twelve product IDs and a factual visual conclusion.

The product reviewer writes the exact fixed-ID maps to `/tmp/audita-marco4-product-evidence.json` and `/tmp/audita-marco4-product-notes.json`, plus `/tmp/audita-marco4-product-findings.json`; the recorder applies the same file/key validation and `changes-required` behavior.

Run: `node scripts/record-marco4-review.mjs --scope product-accessibility --reviewer-id reviewer-product --evidence-json /tmp/audita-marco4-product-evidence.json --notes-json /tmp/audita-marco4-product-notes.json --findings-json /tmp/audita-marco4-product-findings.json`

Expected: PASS and a persisted `changes-required` record when bounded critical/important findings are nonempty; PASS with `approved` only when reviewers are distinct from each other/implementer, both bind the same candidate/artifacts, and no critical/important finding remains. Only two `approved` records may proceed to promotion.

- [ ] **Step 5: Promote, verify, and commit exact reviewed bytes**

Run: `node scripts/promote-reviewed-release.mjs`

Expected: PASS; final ZIP is copied, not rebuilt; `byteComparison` is `0` and reviewed/final hashes are equal.

Run: `node scripts/verify-marco4-release.mjs --promotion-state`

Expected: PASS before commit only when runtime and tooling trees still equal the candidate, `HEAD === candidateCommit`, every dirty path belongs to the exact generated QA/review/release allowlist, and review/QA/reference/archive/final bindings match.

Run: `node --test test/integration/project-delivery.test.js`

Expected: PASS; only 2.0.0 ZIP remains, public-copy/store rules pass, QA is preserved and final bytes equal reviewed bytes.

```bash
git add docs/qa/2026-08-29-marco-4 release/audita-acessibilidade-2.0.0.zip
git add -u release
git commit -m "release: publish reviewed Audita 2.0.0 bytes"
```

## Final verification commands

Run: `node scripts/verify-marco4-release.mjs`

Expected: PASS after the release commit with candidate/runtime/tooling/QA/reference/archive/review/final hashes equal to structured records, only the committed QA/review/release diff permitted after the candidate, and a clean worktree.

Run: `node --test test/integration/project-delivery.test.js test/chrome-116-provisioner.test.js test/release-evidence-schema.test.js test/release-package.test.js`

Expected: PASS without rebuilding final ZIP or rerunning gates already represented by immutable evidence.

Run: `git status --short`

Expected: no output.

## Result expected

Uma release MV3 2.0.0 instalada exclusivamente por ZIP local, com fluxo completo provado em `POPUP` e `SIDE_PANEL` reais, três modos de evidência, personas, casos hostis e quatro exports verificados byte a byte. O QA preserva medições e comparação visual, Chrome 116 e atual estão registrados, os dois reviews independentes vinculam o mesmo candidato e o ZIP final é exatamente o ZIP revisado.

## Self-review

- Spec coverage: Task 1 prova percurso/export-all; Task 2 contém subtestes executáveis para SPA, frames, Shadow DOM, modos, personas, lote/falha/cancelamento, aba anexada, restart, segredos e rede; Task 3 mede visual/a11y/PDF; Task 4 remove loja/legado e fixa pacote; Tasks 5–6 ligam gates, revisores e bytes finais.
- Type consistency: tipos locais são `SurfaceMeasurementV1`, `PdfMeasurementV1`, `QaReceiptV1`, `GateEvidenceV1` e dois scopes fechados. Hashes são SHA-256 hexadecimal minúsculo e reviews usam os mesmos oito bindings.
- Safety: QA vivo usa diretório próprio sob `tmpdir`; limpeza valida owner/path e remove lista fechada; promotion lê paths fixos, recalcula hashes e nunca constrói archive.
- Browser truth: `userGesture:true`, `Input.dispatchKeyEvent`, `chrome.runtime.getContexts()`, `Browser.getVersion`, download IDs e bytes reais são obrigatórios; não há storage seeding nem capability fabricada.
- Run: `rg -n -e 'TO''DO' -e 'T''BD' -e 'place''holder' -e 'simi''lar' -e 'Play''wright' -e '^Run: .*(&&|;)' docs/superpowers/plans/2026-08-29-marco-4-qa-release.md`

Expected: no matches.

- Run: `git diff --check -- docs/superpowers/plans/2026-08-29-marco-4-qa-release.md`

Expected: PASS with no whitespace errors.
