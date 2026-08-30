# Marco 3 — Privacidade, lote, retenção e entrega Implementation Plan

> **Emenda vinculante de 30 de agosto de 2026:** o popup foi removido do produto. Toda escolha de privacidade, URL, lote e retenção descrita historicamente para `src/popup/*` passa a existir no painel lateral nativo (`src/panel/index.html`, contexto `SIDE_PANEL`). Não criar `action.default_popup`, contexto `POPUP` nem envelopes `POPUP_*`; adaptar os testes reais para ícone/atalho → um `SIDE_PANEL` → auditoria/pausa → resultado → relatório → quatro exportações, sempre comprovando zero `POPUP`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar URL única e lote explícito privados por padrão, aplicar três modos de evidência com consentimento de pixels vinculado ao documento, executar retenção absoluta e liberar exclusão pós-exportação somente após recibo terminal dos quatro arquivos.

**Architecture:** URLs completas, chave HMAC, fila, consentimento de pixels e suspensão vivem exclusivamente em `chrome.storage.session`; IndexedDB recebe somente projeções sanitizadas, digests HMAC e registros de retenção/entrega. `runObservedTabAudit` continua sendo o único dono do ciclo de vida das abas e passa a devolver uma pausa controlada antes do primeiro pixel. Um coordenador único faz exclusão manual, por expiração e pós-exportação: a primeira transação torna o modelo indisponível e grava tombstone; a limpeza transitória é retomável e somente então o tombstone desaparece.

**Tech Stack:** JavaScript ESM, HTML, CSS, Chrome Extensions Manifest V3, `chrome.storage.session`, `chrome.alarms`, IndexedDB, Web Crypto, Chrome Downloads API, Chrome DevTools Protocol e `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-29-fluxo-visual-painel-lateral-design.md`

## Global Constraints

- Este plano começa somente depois de concluídos e aprovados os Marcos 1 e 2.
- Chrome mínimo 116; axe-core permanece 4.13.0 empacotado localmente.
- Não adicionar login, conta, servidor, telemetria, código remoto, crawler ou publicação em Web Store.
- `AuditModel V2` permanece a autoridade e não recebe capability, `tabId`, `documentId`, `backendNodeId`, URL bruta, token, fila, checkpoint, consentimento, suspensão ou binding.
- `full-evidence`, `element-only` e `no-pixels` são os únicos modos; nenhuma captura ocorre antes do gate de privacidade.
- Lote aceita no máximo 20 URLs explícitas, não descobre links e executa uma aba descartável por vez.
- `privacy-paused` não é terminal: uma aba descartável comprovadamente própria permanece em `retained-for-consent` e volta ao mesmo runner somente após confirmação válida. Cancelamento, expiração ou recovery interrompido não recapturam pixels: liquidam a página ativa, confirmam cleanup e, no lote, só então avançam para a próxima entry; somente o runner/coordenador de ownership pode remover a aba.
- Retenção é absoluta por 30 dias desde `firstPersistedAt`; revisão, exportação, lease ou worker suspenso não prolongam `expiresAt`.
- Toda URL persistida/exportada usa `EvidenceUrlV1`; nomes de arquivo usam somente `auditId` e instante UTC.
- HTML, PDF, CSV e JSON técnico partem da mesma revisão imutável; filtros vivos nunca removem conteúdo exportado.
- Privacidade, armazenamento, exclusão e entrega são risco crítico: TDD, duas revisões independentes, suíte completa, E2E real e zero achado Critical/Important.
- Durante cada tarefa, executar somente os testes listados; executar `npm test` e `npm run verify` uma vez no gate final deste marco.
- Não gerar ZIP neste marco.

---

## File map

| Path | Responsibility |
|---|---|
| `src/core/privacy/evidence-url.js` | Canonicaliza HTTP(S) e produz a única URL permitida em estado durável. |
| `src/core/privacy/session-url-digest.js` | Único manager/queue de chave e digest HMAC, criado no Marco 1 e compartilhado por authority, bindings e cofre. |
| `src/background/raw-navigation-vault.js` | Guarda URL completa, tokens e fila somente em `chrome.storage.session`. |
| `src/browser/sensitive-context-probe.js` | Detecta somente categorias fechadas, sem ler valores ou texto. |
| `src/background/pixel-capture-consent.js` | Guarda consentimento one-shot e suspensão vinculados a auditoria/aba/documento/modo. |
| `src/background/pixel-consent-expiry.js` | Agenda a menor expiração de consentimento e recupera a FSM sem repetir pixels. |
| `src/background/worker-protocol.js` | Valida envelopes fechados de início, pausa, confirmação, cancelamento e exclusão. |
| `src/background/observed-tab-runner.js` | Continua sendo o único criador/navegador/removedor de abas e interrompe antes do primeiro pixel. |
| `src/background/run-audit.js` | Consome token efêmero e adapta auditoria de URL única ao runner. |
| `src/background/run-batch.js` | Consome um token por vez, usa cleanup `always` e consolida o lote. |
| `src/background/current-state-assist.js` | Abre/prova uma aba própria para localizar somente o estado atual, sem alterar evidência histórica. |
| `src/background/audit-deletion-coordinator.js` | Unifica exclusão por retenção, gesto manual e entrega completa. |
| `src/background/retention-scheduler.js` | Agenda a próxima expiração absoluta com alarme one-shot e retoma tombstones. |
| `src/background/export-launch.js` | Vincula conclusão da entrega à capability/tab/document/revisão/tentativa e a termina por CAS. |
| `src/export/export-receipt.js` | Congela identidade, blobs, hashes e recibo fechado com quatro formatos. |
| `src/panel/*` | Apresenta escolha de privacidade, pausa, lote, avisos, progresso e entrega. |
| `test/e2e/support/real-chrome.mjs` | Reutiliza o Chrome real do Marco 1, com gesto real, contextos MV3 e downloads observáveis. |

---

### Task 1: Fechar `EvidenceUrlV1`, deduplicação e nomes de artefato

**Files:**

- Create: `src/core/privacy/evidence-url.js`
- Modify: `src/core/privacy.js`
- Modify: `src/core/batch/normalize-url-list.js`
- Modify: `src/browser/download-artifacts.js`
- Modify: `src/export/report-export.js`
- Modify: `src/export/export-controller.js`
- Create: `test/privacy/evidence-url.test.js`
- Modify: `test/core/privacy.test.js`
- Modify: `test/core/normalize-url-list.test.js`
- Modify: `test/browser/download-artifacts.test.js`
- Modify: `test/export/report-export.test.js`
- Modify: `test/export/export-controller.test.js`

**Interfaces:**

- Consumes: `normalizeAuditUrl(value)` de `src/core/url.js`.
- Produces:

```text
export function canonicalNavigationUrl(rawUrl, { base } = {});
// -> string HTTP(S) absoluto, com fragmento preservado para o HMAC e sem credenciais

export function sanitizeEvidenceUrlV1(rawUrl, { base, includeQuery = false } = {});
// -> Readonly<{version:'EvidenceUrlV1',href:string,queryIncluded:boolean,redactedSegments:number}>

export function buildArtifactBaseName(auditId, timestamp);
// -> `audita-<auditId-projetado>-<YYYYMMDDTHHMMSSmmmZ>`
```

- `sanitizeEvidenceUrl(value, options)` em `src/core/privacy.js` delega para `sanitizeEvidenceUrlV1(value, options).href`.
- `normalizeUrlList(input, options)` devolve `entries: [{line,navigationUrl,evidenceUrl}]`; deduplica somente `navigationUrl` canônica exata.

- [ ] **Step 1: Escrever testes RED para base, encoding, esquemas, segmentos e nomes**

```js
test('EvidenceUrlV1 resolves base, decodes once and redacts objective secrets', () => {
  assert.deepEqual(sanitizeEvidenceUrlV1('../123/caf%C3%A9/1234567/%E0%A4%A', {
    base: 'https://Example.TEST/app/', includeQuery: false,
  }), {
    version: 'EvidenceUrlV1',
    href: 'https://example.test/123/:redacted-2/:redacted-3/:redacted-4',
    queryIncluded: false,
    redactedSegments: 3,
  });
});

test('EvidenceUrlV1 always removes credentials and fragment and gates query explicitly', () => {
  const raw = 'https://user:pass@example.test/public?case=7#secret';
  assert.equal(sanitizeEvidenceUrlV1(raw).href, 'https://example.test/public');
  assert.equal(sanitizeEvidenceUrlV1(raw, { includeQuery: true }).href,
    'https://example.test/public?case=7');
});

test('EvidenceUrlV1 rejects non-http schemes without echoing the input', () => {
  for (const value of ['data:text/plain,segredo', 'blob:https://example.test/id', 'javascript:alert(1)']) {
    assert.throws(() => sanitizeEvidenceUrlV1(value), error =>
      error.message === 'URL de evidência HTTP(S) inválida.' && !error.message.includes(value));
  }
});

test('filename accepts audit-1 and removes every ISO punctuation mark', () => {
  assert.equal(buildArtifactBaseName('audit-1', '2026-08-29T12:00:00.123Z'),
    'audita-audit-1-20260829T120000123Z');
});

test('sanitized collisions remain distinct pages and only exact canonical URLs deduplicate', () => {
  const value = normalizeUrlList([
    'https://example.test/client/1234567',
    'https://example.test/client/7654321',
    'https://EXAMPLE.test/client/1234567',
  ].join('\n'));
  assert.equal(value.entries.length, 2);
  assert.deepEqual(value.entries.map(entry => entry.line), [1, 2]);
  assert.deepEqual(value.warnings, [{
    line: 3, code: 'DUPLICATE_URL', firstLine: 1,
    message: 'A URL repete uma entrada anterior e não será auditada novamente.',
  }]);
});
```

- [ ] **Step 2: Executar testes e confirmar RED**

Run: `node --test test/privacy/evidence-url.test.js test/core/privacy.test.js test/core/normalize-url-list.test.js`

Expected: FAIL por módulo inexistente e pela deduplicação atual após redação.

- [ ] **Step 3: Implementar parsing fechado e classificação após um decode**

```js
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EMAIL = /^[^@/\s]+@[^@/\s]+\.[^@/\s]+$/u;
const LONG_NUMBER = /\d{7,}/u;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

function parseHttpUrl(rawUrl, base) {
  try {
    const parsedBase = base === undefined ? undefined : new URL(base);
    if (parsedBase && !['http:', 'https:'].includes(parsedBase.protocol)) throw new TypeError();
    const parsed = parsedBase ? new URL(rawUrl, parsedBase) : new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname === '') throw new TypeError();
    return parsed;
  } catch {
    throw new TypeError('URL de evidência HTTP(S) inválida.');
  }
}

function highEntropyToken(segment) {
  if (!/^[A-Za-z0-9_-]{24,}$/u.test(segment)) return false;
  const classes = [/[a-z]/u, /[A-Z]/u, /\d/u, /[_-]/u]
    .filter(pattern => pattern.test(segment)).length;
  return classes >= 3 || new Set(segment).size / segment.length >= 0.65;
}

function decodeSegmentOnce(encoded) {
  try { return { ok: true, value: decodeURIComponent(encoded) }; }
  catch { return { ok: false, value: '' }; }
}

function safePathSegment(decoded) {
  return SAFE_SEGMENT.test(decoded) && !UUID.test(decoded) && !EMAIL.test(decoded) &&
    !LONG_NUMBER.test(decoded) && !JWT.test(decoded) && !highEntropyToken(decoded);
}

export function canonicalNavigationUrl(rawUrl, { base } = {}) {
  const parsed = parseHttpUrl(rawUrl, base);
  parsed.username = '';
  parsed.password = '';
  return parsed.href;
}

export function sanitizeEvidenceUrlV1(rawUrl, { base, includeQuery = false } = {}) {
  if (typeof includeQuery !== 'boolean') throw new TypeError('Opção de query inválida.');
  const parsed = parseHttpUrl(rawUrl, base);
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  let ordinal = 0;
  let redactedSegments = 0;
  parsed.pathname = parsed.pathname.split('/').map(encoded => {
    if (encoded === '') return '';
    ordinal += 1;
    const decoded = decodeSegmentOnce(encoded);
    if (!decoded.ok || !safePathSegment(decoded.value)) {
      redactedSegments += 1;
      return `:redacted-${ordinal}`;
    }
    return encodeURIComponent(decoded.value).replace(/%2E/giu, '.').replace(/%7E/giu, '~');
  }).join('/');
  if (!includeQuery) parsed.search = '';
  return Object.freeze({
    version: 'EvidenceUrlV1', href: parsed.href,
    queryIncluded: includeQuery && parsed.search.length > 0, redactedSegments,
  });
}
```

`parseHttpUrl` deixa o serializador da plataforma produzir hostname ASCII/punycode e nunca inclui o valor rejeitado no erro.

- [ ] **Step 4: Projetar `auditId` e UTC de forma exata em todos os consumidores**

```js
function artifactAuditId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(value)) {
    throw new TypeError('Identificador de auditoria inválido.');
  }
  return value;
}

function compactUtc(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError('Instante de exportação inválido.');
  return parsed.toISOString().replace(/[-:.]/gu, '');
}

export function buildArtifactBaseName(auditId, timestamp) {
  return `audita-${artifactAuditId(auditId)}-${compactUtc(timestamp)}`;
}
```

Atualizar `download-artifacts.js`, `report-export.js` e `export-controller.js` para receber `{auditId,timestamp}` e derivar uma única base; remover qualquer fallback derivado de título/URL. Testar extensões finais `.html`, `.pdf`, `.csv` e `.json`.

- [ ] **Step 5: Remover a colisão pós-redação do lote**

```text
const firstCanonicalLine = new Map();
const navigationUrl = canonicalNavigationUrl(raw);
const duplicateLine = firstCanonicalLine.get(navigationUrl);
if (duplicateLine !== undefined) {
  warnings.push(issue(line, 'DUPLICATE_URL', duplicateLine));
  continue;
}
firstCanonicalLine.set(navigationUrl, line);
entries.push(Object.freeze({
  line, navigationUrl,
  evidenceUrl: sanitizeEvidenceUrlV1(navigationUrl, { includeQuery: false }),
}));
```

Excluir `DUPLICATE_AFTER_REDACTION` do catálogo. Duas URLs brutas canônicas distintas conservam `pageId` e `line` distintos mesmo quando seus `evidenceUrl.href` coincidem.

- [ ] **Step 6: Executar testes focados e confirmar PASS**

Run: `node --test test/privacy/evidence-url.test.js test/core/privacy.test.js test/core/normalize-url-list.test.js test/browser/download-artifacts.test.js test/export/report-export.test.js test/export/export-controller.test.js`

Expected: PASS para base relativa, credenciais, fragmento, query opt-in, encoding malformado, Unicode/punycode, esquemas proibidos, segmento iniciado por dígito, colisão sanitizada e `audit-1`.

- [ ] **Step 7: Commit**

```bash
git add src/core/privacy/evidence-url.js src/core/privacy.js src/core/batch/normalize-url-list.js src/browser/download-artifacts.js src/export/report-export.js src/export/export-controller.js test/privacy/evidence-url.test.js test/core/privacy.test.js test/core/normalize-url-list.test.js test/browser/download-artifacts.test.js test/export/report-export.test.js test/export/export-controller.test.js
git commit -m "feat: close durable URL projections"
```

---

### Task 2: Isolar chave HMAC, URLs brutas e fila em `storage.session`

**Files:**

- Modify: `src/background/raw-navigation-vault.js`
- Modify: `src/background/service-worker.js`
- Modify: `test/privacy/session-url-digest.test.js`
- Modify: `test/background/raw-navigation-vault.test.js`
- Modify: `test/background/service-worker.test.js`
- Modify: `test/background/run-batch.test.js`

**Interfaces:**

- Consome do Marco 1 o singleton worker-owned abaixo; esta task não cria provider, promise-tail ou chave concorrente:

```text
export function createSessionUrlDigestManager({sessionArea,subtle,randomBytes,now});
// .digest(canonicalUrl) -> `hmac-sha256:<base64url sem padding>`
// .destroy(); única queue e único registro de chave do worker
```

- Produces:

```text
RawNavigationPurposeV1 =
  'single-url'|'batch-page'|'context-menu-link'|'current-state-assist';

export function createRawNavigationVaultV1({ sessionArea, digestManager, now, randomBytes });
// .put(rawUrl,{auditId,purpose:RawNavigationPurposeV1,ttlMs,includeQuery})
//   -> Promise<{navigationToken,evidenceUrl,sessionDigest,expiresAt}>
// .take(navigationToken,{auditId,purpose:RawNavigationPurposeV1}) -> Promise<string>;
//   exige o mesmo auditId+purpose e remove antes de devolver
// .putQueue({auditId,entries}) -> Promise<void>
// .readQueue(auditId) -> Promise<RawNavigationQueueV1|null>
// .replaceQueue(auditId,queue) -> Promise<void>
// .clearAudit(auditId) -> Promise<number>
// .clearExpired() -> Promise<number>
```

```js
// RawNavigationQueueV1, somente storage.session
// {version:1,auditId,nextIndex,entries:[{
//   line,navigationToken,evidenceUrl,sessionDigest,status:'pending'|'running'|'finished'
// }]}
```

- Chaves: `audita:session-hmac-key:v1`, `audita:raw-navigation:v1:<token>` e `audita:raw-navigation-queue:v1:<auditId>`.

- [ ] **Step 1: Escrever testes RED para Chrome 116, reinício e uso único**

```js
function memorySessionArea(initial = {}) {
  const values = structuredClone(initial);
  return {
    async get(key) {
      if (key === null) return structuredClone(values);
      return { [key]: structuredClone(values[key]) };
    },
    async set(input) { Object.assign(values, structuredClone(input)); },
    async remove(key) { for (const item of Array.isArray(key) ? key : [key]) delete values[item]; },
  };
}

test('vault uses Chrome 116 get(null), HMAC prefix and one-shot take', async () => {
  const sessionArea = memorySessionArea();
  const digestManager = createSessionUrlDigestManager({
    sessionArea, subtle: crypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(7),
    now: () => 1_788_004_800_000,
  });
  const vault = createRawNavigationVaultV1({
    sessionArea, digestManager, now: () => '2026-08-29T12:00:00.000Z',
    randomBytes: length => new Uint8Array(length).fill(5),
  });
  const issued = await vault.put('https://example.test/a?secret=1', {
    auditId: 'audit-1', purpose: 'single-url', ttlMs: 60_000, includeQuery: false,
  });
  assert.match(issued.sessionDigest, /^hmac-sha256:[A-Za-z0-9_-]{43}$/u);
  assert.equal(Object.hasOwn(issued, 'rawUrl'), false);
  assert.deepEqual((await sessionArea.get('audita:session-hmac-key:v1'))['audita:session-hmac-key:v1'], {
    version: 1,
    keyBase64Url: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
    createdAt: 1_788_004_800_000,
  });
  assert.equal(await vault.take(issued.navigationToken, {
    auditId: 'audit-1', purpose: 'single-url',
  }), 'https://example.test/a?secret=1');
  await assert.rejects(vault.take(issued.navigationToken, {
    auditId: 'audit-1', purpose: 'single-url',
  }), /expirada ou consumida/iu);
});

test('vault rejects cross-purpose and cross-audit claims without consuming the record', async () => {
  const { vault } = rawNavigationVaultFixture();
  for (const purpose of ['single-url', 'batch-page', 'context-menu-link', 'current-state-assist']) {
    const issued = await vault.put(`https://example.test/${purpose}`, {
      auditId: 'audit-1', purpose, ttlMs: 60_000, includeQuery: false,
    });
    const otherPurpose = purpose === 'single-url' ? 'batch-page' : 'single-url';
    await assert.rejects(vault.take(issued.navigationToken, {
      auditId: 'audit-1', purpose: otherPurpose,
    }), /finalidade não corresponde/iu);
    await assert.rejects(vault.take(issued.navigationToken, {
      auditId: 'audit-2', purpose,
    }), /auditoria não corresponde/iu);
    assert.equal(await vault.take(issued.navigationToken, {
      auditId: 'audit-1', purpose,
    }), `https://example.test/${purpose}`);
  }
});
```

`rawNavigationVaultFixture` é um helper privado no mesmo teste e usa o `memorySessionArea` acima. O teste comprova que mismatch de finalidade/auditoria falha antes de `remove`: um claim de `current-state-assist` nunca consome token de lote, menu de contexto ou URL única, e vice-versa. Cada caller usa uma constante literal da união; propósito desconhecido ou propriedade extra falha antes de gravar.

- [ ] **Step 2: Executar testes e confirmar RED**

Run: `node --test test/privacy/session-url-digest.test.js test/background/raw-navigation-vault.test.js test/background/service-worker.test.js`

Expected: FAIL porque a fila, a extensão pública `put`/`take` do cofre e a injeção do singleton ainda não existem.

- [ ] **Step 3: Compartilhar o único manager HMAC compatível com Chrome 116**

O bootstrap do service worker cria exatamente uma instância de `createSessionUrlDigestManager` e injeta a mesma referência em target authority, recorder de highlight e `createRawNavigationVaultV1`. O vault chama somente `digestManager.digest(canonical)`; não lê/decodifica a chave, não possui queue própria para a chave e não instancia o manager. Um teste concorrente bloqueia a primeira leitura de `storage.session`, dispara preparo attached, binding e `vault.put` ao mesmo tempo e comprova um único `set` de chave e digests estáveis. Reinício do worker cria um novo manager que reutiliza o mesmo registro válido; reinício da sessão cria uma chave nova. Nenhum caminho reconstrói a chave anterior.

- [ ] **Step 4: Implementar vault serializado sem `getKeys()`**

```text
async function allSessionEntries(sessionArea) {
  const value = await sessionArea.get(null);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

const canonical = canonicalNavigationUrl(rawUrl);
const evidenceUrl = sanitizeEvidenceUrlV1(canonical, { includeQuery });
const sessionDigest = await digestManager.digest(canonical);
const record = Object.freeze({
  version: 'RawNavigationUrlV1', auditId, purpose,
  rawUrl: canonical, issuedAt, expiresAt,
});
await sessionArea.set({ [`audita:raw-navigation:v1:${navigationToken}`]: record });
return Object.freeze({ navigationToken, evidenceUrl, sessionDigest, expiresAt });
```

Todas as mutações passam pela mesma promise-tail privada. `navigationToken` contém 16 bytes CSPRNG em base64url. `put` e `take` aceitam somente `RawNavigationPurposeV1`. `take` valida chaves exatas do record, auditoria, propósito e prazo antes de remover; mismatch não consome o record. No claim válido, executa `sessionArea.remove(key)` e só então devolve a URL; falha na remoção nunca devolve o segredo. `clearAudit` e `clearExpired` usam `get(null)`, filtram apenas os dois prefixos do módulo e removem lista explícita de chaves. Entradas de fila são emitidas somente com `batch-page`; painel URL única usa `single-url`, menu de link usa `context-menu-link` e auxílio atual usa `current-state-assist`.

- [ ] **Step 5: Fechar fila e worker sem bearer durável**

`PANEL_START_URL_AUDIT` e `PANEL_START_BATCH_AUDIT` são recebidos somente de `src/panel/index.html` no mesmo extension ID e incluem a `NavigationStartCapabilityV1` da intenção correspondente. O worker normaliza dentro do evento, chama `put` para cada entrada e `putQueue` para o lote e entrega somente o plano tokenizado ao starter único; responde depois da sessão/bootstrap/job persistidos com `{ok:true,auditId,sessionCapabilityId,acceptedCount,warnings}`. `warnings` usa catálogo fechado e nunca repete a entrada. Nenhum `navigationToken` sai do worker ou entra em IndexedDB, latest, checkpoint, modelo, relatório ou log.

Ao reconstruir o service worker, `readQueue(auditId)` retoma apenas se `storage.session` ainda existir. Sessão vazia transforma páginas pendentes em `not-started/session-ended`, sem tentar reconstruir URL ou HMAC.

- [ ] **Step 6: Executar testes focados e confirmar PASS**

Run: `node --test test/privacy/session-url-digest.test.js test/background/raw-navigation-vault.test.js test/background/service-worker.test.js test/background/run-batch.test.js`

Expected: PASS; uma varredura de `JSON.stringify(await sessionArea.get(null))` localiza URL bruta apenas nos records/filas autorizados, e uma varredura dos records IndexedDB não localiza token, capability, query, fragmento ou credenciais.

- [ ] **Step 7: Commit**

```bash
git add src/background/raw-navigation-vault.js src/background/service-worker.js test/privacy/session-url-digest.test.js test/background/raw-navigation-vault.test.js test/background/service-worker.test.js test/background/run-batch.test.js
git commit -m "feat: isolate volatile navigation authority"
```

---

### Task 3: Implementar sonda, consentimento one-shot e retomada segura

**Files:**

- Modify: `src/core/privacy/capture-policy.js`
- Create: `src/browser/sensitive-context-probe.js`
- Create: `src/background/pixel-capture-consent.js`
- Create: `src/background/pixel-consent-expiry.js`
- Modify: `src/background/target-capabilities.js`
- Modify: `src/background/authorized-audit-starter.js`
- Modify: `src/background/owned-tabs.js`
- Modify: `src/background/observed-tab-runner.js`
- Modify: `src/background/run-audit.js`
- Modify: `src/background/run-batch.js`
- Modify: `src/background/worker-protocol.js`
- Modify: `src/background/service-worker.js`
- Modify: `src/popup/index.html`
- Modify: `src/popup/popup.js`
- Modify: `src/popup/popup-state.js`
- Modify: `src/panel/index.html`
- Modify: `src/panel/panel.js`
- Modify: `src/panel/panel-state.js`
- Modify: `test/privacy/capture-policy.test.js`
- Create: `test/browser/sensitive-context-probe.test.js`
- Create: `test/background/pixel-capture-consent.test.js`
- Create: `test/background/pixel-consent-expiry.test.js`
- Modify: `test/background/target-capabilities.test.js`
- Modify: `test/background/authorized-audit-starter.test.js`
- Modify: `test/background/owned-tabs.test.js`
- Modify: `test/background/observed-tab-runner.test.js`
- Modify: `test/background/run-audit.test.js`
- Modify: `test/background/run-batch.test.js`
- Modify: `test/background/worker-protocol.test.js`
- Modify: `test/background/service-worker.test.js`
- Modify: `test/popup/popup-state.test.js`
- Modify: `test/panel/panel-state.test.js`
- Modify: `test/panel/panel-ui.test.js`

**Interfaces:**

- Consumes `normalizeCapturePolicyV1({mode,includeQuery})`, `createTargetCapabilityAuthority({chromeApi,now,randomBytes,probeDocument}).authorizeSession(args)` e `probeDocumentIdentity(tabId)` do Marco 1. Esta task migra explicitamente o runner do contrato intermediário `runObservedTabAudit({auditId,target,capturePolicy,privacyDecision,checkpointRecorder,signal})` para a assinatura final canônica `runObservedTabAudit({auditId,target,chromeAdapter,capturePolicy,privacyGate,onCheckpoint,now,signal,expectedExtensionId})`; todos os callers e testes dos Marcos 1–3 são adaptados no mesmo commit, e a API final rejeita as chaves legadas `privacyDecision` e `checkpointRecorder`.
- Produces:

```text
export function detectSensitiveCaptureSignalsV1(probeResult);
// -> Readonly<{version:'SensitiveCaptureSignalsV1',detected:boolean,categories:readonly SensitiveCategory[]}>

export async function probeSensitiveContextInTab(tabId, { executeScript, documentIds });
// -> Promise<SensitiveCaptureSignalsV1>; nunca devolve valores, texto ou seletores

export function createPixelCaptureStateV1({ sessionArea, now, randomBytes });
// .pause({auditId,observedTarget,mode,capturePolicy,categories,expiresAt})
//   -> Promise<AuditSuspensionV1>
// .claimAndBeginResume({auditId,tabId,documentId,mode}) -> Promise<PixelCaptureClaimV1>
// .advanceResume({auditId,consentId,expectedPhase,nextPhase}) -> Promise<AuditSuspensionV1>
// .readSuspension(auditId) -> Promise<AuditSuspensionV1|null>
// .listSuspensions({limit}) -> Promise<readonly AuditSuspensionV1[]>
// .nextExpiresAt() -> Promise<string|null>
// .finish(consentId) -> Promise<void>
// .revokeAudit(auditId,reason) -> Promise<void>

export const PIXEL_CONSENT_ALARM_NAME = 'audita-pixel-consent-expiry-v1';
export function createPixelConsentExpirySchedulerV1(chromeApi, {
  pixelState, sessionAuthority, ownedTabs, batchCoordinator, checkpointStore, now,
});
// -> {run(trigger),scheduleNext(),recoverOnStartup(),dispose()}

export function createPixelPrivacyGateV1({
  pixelState, consentClaim = null, consentExpiresAt,
});
// .beforePixels({auditId,observedTarget,capturePolicy,signals})
//   -> Promise<{status:'paused'}|{status:'allowed',authorization:'initial-gesture',claim:null}
//              |{status:'allowed',authorization:'sensitive-confirmation',claim:PixelCaptureClaimV1}>
// .afterPixels() -> Promise<void>
```

```js
// PixelCaptureConsentV1, somente storage.session
// {version:1,consentId,auditId,tabId,documentId,mode,issuedAt,expiresAt,
//  state:'pending'|'claimed'|'revoked'}

// AuditSuspensionV1, somente storage.session; state/phase formam uma união discriminada
// {version:1,auditId,kind:'pixel-confirmation',tabId,windowId,documentId,
//  urlEvidence,urlSessionDigest,mode,capturePolicy,categories,issuedAt,expiresAt,
//  state:'paused',resumePhase:null,
//  source:{kind:'attached'}|{kind:'owned-disposable',ownershipId,cleanupMode,pageId:null|string}}
// | os mesmos campos com state:'resuming' e
//   resumePhase:'consent-claimed'|'session-running'|'runner-started'

// PixelCaptureClaimV1, memória da invocação de retomada
// {version:1,consentId,auditId,tabId,documentId,mode,claimedAt}

// OwnedDisposableTabV2, schema final de 2.0
// {version:2,ownershipId,auditId,purpose:'audit'|'current-state-assist',tabId,windowId,
//  cleanupMode:'always'|'pre-observation-failure',
//  state:'created'|'observing'|'retained-for-review'|'retained-for-consent'|'cleanup-pending'|'removed',
//  createdAt,updatedAt}
```

- `runObservedTabAudit` passa a devolver a união fechada:

```text
// {status:'complete'|'partial'|'cancelled',model,observedTarget,
//    observationState:'observed',ownershipState:'attached'|'retained-for-review'|'removed'|'cleanup-pending'}
// | {status:'privacy-paused',model:null,observedTarget,observationState:'observed',
//    ownershipState:'attached'|'retained-for-consent',signals}
// | {status:'failed-before-observation',model:null,observedTarget:null,
//    observationState:'pre-observation-failure',ownershipState:'attached'|'removed'|'cleanup-pending'}
```

- Envelopes fechados novos/alterados:

```js
// PANEL_START_URL_AUDIT
// {type:'PANEL_START_URL_AUDIT',capabilityId,url,captureMode,includeQuery,deleteAfterCompleteExport}
// PANEL_START_BATCH_AUDIT
// {type:'PANEL_START_BATCH_AUDIT',capabilityId,urls,captureMode,includeQuery,deleteAfterCompleteExport}
// CONFIRM_PIXEL_CAPTURE
// {type:'CONFIRM_PIXEL_CAPTURE',sessionCapabilityId,auditId,mode,accepted:true}
// AUDIT_PRIVACY_PAUSED, worker -> UI
// {type:'AUDIT_PRIVACY_PAUSED',auditId,mode,categories,message}
```

- `SensitiveCategory` é `'password'|'otp'|'payment'|'private-marker'`, nessa ordem. Rótulos exatos:

- Este marco estende a união fechada de target com `{kind:'owned-disposable-resume',ownershipId,tabId,windowId,documentId,initialUrlEvidence,initialUrlSessionDigest,cleanupMode}`. `cleanupMode` é exatamente `'always'|'pre-observation-failure'`. O runner aceita essa variante somente após ler `OwnedDisposableTabV2` em `retained-for-consent`, comparar todos os campos e fazer CAS para `observing`; UI e modelo nunca constroem nem recebem esse target. `owned-tabs.js` adiciona as transições CAS de pausa `observing → retained-for-consent → observing|cleanup-pending|removed` às transições terminais já existentes `observing → retained-for-review|cleanup-pending|removed`, preserva ownership/audit/tab/window e expõe `clearAudit(auditId)` para a exclusão unificada.

- `owned-tabs.js` migra explicitamente o schema intermediário do Marco 1: `ownerId` passa a `ownershipId`, `sessionCapabilityId` sai do owner record e a sessão se correlaciona exclusivamente por `targetBinding.ownershipId`. Novos records são somente `OwnedDisposableTabV2`. Em recovery, um V1 well-formed pode servir apenas como prova para cleanup da aba exata e é removido; nunca é retomado nem convertido silenciosamente. Testes de shape/migração provam que a ausência de session capability no owner não reduz a autorização da sessão.

```js
export const SENSITIVE_CATEGORY_LABELS_V1 = Object.freeze({
  password: 'Campo de senha',
  otp: 'Código de uso único',
  payment: 'Dados de pagamento',
  'private-marker': 'Conteúdo marcado como privado',
});
```

- [ ] **Step 1: Escrever testes RED de política, ordem, binding e replay**

```js
test('pixel consent is bound to audit tab document and mode and can begin resume once', async () => {
  const state = createPixelCaptureStateV1(fixtureDependencies());
  await state.pause({
    auditId: 'audit-1',
    observedTarget: observedTarget('doc-a'),
    mode: 'full-evidence', capturePolicy: fullEvidencePolicy,
    categories: ['password'], expiresAt: '2026-08-29T12:05:00.000Z',
  });
  await assert.rejects(state.claimAndBeginResume({
    auditId: 'audit-1', tabId: 7, documentId: 'doc-b', mode: 'full-evidence',
  }), /documento não corresponde/iu);
  const claim = await state.claimAndBeginResume({
    auditId: 'audit-1', tabId: 7, documentId: 'doc-a', mode: 'full-evidence',
  });
  assert.equal(claim.documentId, 'doc-a');
  await assert.rejects(state.claimAndBeginResume({
    auditId: 'audit-1', tabId: 7, documentId: 'doc-a', mode: 'full-evidence',
  }), /já utilizado/iu);
});

test('runner returns privacy-paused before every pixel call', async () => {
  const result = await runObservedTabAudit(pausedRunnerInput());
  assert.equal(result.status, 'privacy-paused');
  assert.deepEqual(calls.order, ['clear-transient-layers', 'prove-document', 'probe-sensitive']);
  assert.equal(calls.captureFullPage, 0);
  assert.equal(calls.captureElement, 0);
});

test('non-sensitive page proceeds from the already-authorized start gesture', async () => {
  const result = await runObservedTabAudit(nonSensitiveRunnerInput());
  assert.equal(result.status, 'complete');
  assert.equal(calls.order.indexOf('probe-sensitive') < calls.order.indexOf('captureFullPage'), true);
  assert.equal(calls.pixelPause, 0);
});

test('closed confirmation rejects extra fields and wrong accepted value', () => {
  assert.equal(parseWorkerMessage({
    type: 'CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: 'session-capability-1',
    auditId: 'audit-1', mode: 'full-evidence', accepted: true, tabId: 7,
  }), null);
  assert.equal(parseWorkerMessage({
    type: 'CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: 'session-capability-1',
    auditId: 'audit-1', mode: 'full-evidence', accepted: false,
  }), null);
});

test('restart settles every resume crash cut without replaying pixels', async () => {
  for (const cut of [
    'after-consent-claimed', 'after-session-cas', 'after-session-running',
    'after-runner-started', 'during-runner', 'after-terminal-result',
  ]) {
    const fixture = pixelResumeCrashFixture({ cut, source: 'attached' });
    await fixture.confirmAndCrash();
    await fixture.restartAndRecover();
    assert.equal(fixture.calls.pixelCaptureAfterRestart, 0);
    assert.equal(fixture.calls.claimCount, 1);
    assert.equal(fixture.calls.sessionTerminal, 1);
  }
});

test('batch resume crash cleans the active owner before continuing pending entries', async () => {
  for (const cut of ['after-consent-claimed', 'after-session-cas',
    'after-session-running', 'after-runner-started', 'during-runner']) {
    const fixture = pixelResumeCrashFixture({
      cut, source: 'batch', activePageId: 'page-2', remaining: ['page-3'],
    });
    await fixture.confirmAndCrash();
    await fixture.restartAndRecover();
    assert.deepEqual(fixture.trace.slice(-4), [
      'mark-page-2-failed:PIXEL_RESUME_INTERRUPTED',
      'cleanup-owner-page-2', 'clear-active-page-2', 'continue-page-3',
    ]);
    assert.equal(fixture.calls.pixelCaptureAfterRestart, 0);
  }
});

test('successful middle-page resume continues once and publishes only the terminal parent', async () => {
  const fixture = pixelResumeFixture({
    source: 'batch', activePageId: 'page-2', remaining: ['page-3'],
  });
  await fixture.confirmAndComplete();
  assert.deepEqual(fixture.trace, [
    'persist-page-2', 'cleanup-owner-page-2', 'clear-active-page-2',
    'continue-page-3', 'publish-parent-result',
  ]);
  assert.equal(fixture.calls.page3, 1);
  assert.equal(fixture.calls.publishedIndividualPageModel, 0);
});

test('expired paused batch page is cleaned before the remaining queue continues', async () => {
  const fixture = pixelExpiryFixture({
    now: '2026-08-29T12:05:00.001Z', activePageId: 'page-2', remaining: ['page-3'],
  });
  await fixture.scheduler.run('alarm');
  assert.deepEqual(fixture.trace, [
    'revoke-session', 'mark-page-2-failed:PIXEL_CONSENT_EXPIRED',
    'cleanup-owner-page-2', 'clear-active-page-2', 'continue-page-3', 'schedule-next',
  ]);
  assert.equal(fixture.calls.pixelCapture, 0);
});
```

Os factories `fixtureDependencies`, `observedTarget`, `pausedRunnerInput`, `pixelResumeFixture`, `pixelResumeCrashFixture` e `pixelExpiryFixture` são helpers privados definidos nos próprios arquivos de teste antes dos casos; eles constroem `storage.session` em memória, relógio fixo, adaptadores spy e todos os argumentos obrigatórios do runner/scheduler. `after-terminal-result` sem `finish` comprova que recovery reconhece o resultado durável e apenas conclui a FSM; os outros cortes encerram a tentativa como interrompida.

- [ ] **Step 2: Executar testes e confirmar RED**

Run: `node --test test/privacy/capture-policy.test.js test/browser/sensitive-context-probe.test.js test/background/pixel-capture-consent.test.js test/background/pixel-consent-expiry.test.js test/background/authorized-audit-starter.test.js test/background/observed-tab-runner.test.js test/background/run-audit.test.js test/background/run-batch.test.js test/background/worker-protocol.test.js`

Expected: FAIL por ausência da sonda/consentimento/scheduler e porque o runner ainda não possui retorno `privacy-paused` nem recovery da FSM.

- [ ] **Step 3: Implementar sonda sem dados sensíveis**

```js
export function inspectSensitiveContext() {
  return {
    password: document.querySelector('input[type="password"], [autocomplete~="current-password"], [autocomplete~="new-password"]') !== null,
    otp: document.querySelector('[autocomplete~="one-time-code"]') !== null,
    payment: document.querySelector('[autocomplete~="cc-number"], [autocomplete~="cc-csc"]') !== null,
    privateMarker: document.querySelector('[data-audita-private]') !== null,
  };
}
```

`executeScript` injeta essa função no frame 0 e nos `documentIds` explicitamente observados. `detectSensitiveCaptureSignalsV1` aceita somente quatro booleanos próprios, ordena/deduplica categorias e descarta contagens, seletores e qualquer propriedade extra. Não ler `.value`, texto, HTML, canvas, pixels, DRM ou Shadow DOM fechado.

- [ ] **Step 4: Implementar estado serializado e one-shot**

`createPixelCaptureStateV1` usa prefixos `audita:pixel-consent:v1:<auditId>` e `audita:audit-suspension:v1:<auditId>`, promise-tail única e `sessionArea.get(key)/set/remove`. `pause` valida closed shapes, gera `consentId` com 16 bytes CSPRNG e grava consentimento+suspensão juntos em uma única chamada `sessionArea.set({[consentKey]:consent,[suspensionKey]:suspension})` antes de emitir a pausa; nenhum caller repete essa persistência. Para origem descartável, grava somente `ownershipId`/`cleanupMode`/`pageId` já validados, nunca URL bruta, e exige transição CAS do owner para `retained-for-consent`. `expiresAt` é o menor entre a expiração da sessão de auditoria e `issuedAt + 5 minutos`.

`claimAndBeginResume` exige `pending`, prazo futuro e igualdade exata de auditoria/aba/documento/modo; sob a mesma promise-tail grava em uma única chamada o consentimento `claimed` e a suspensão `{state:'resuming',resumePhase:'consent-claimed'}` antes de devolver. Consentimento `claimed` nunca volta a `pending`. `advanceResume` é CAS de fase, aceita somente `consent-claimed → session-running → runner-started` e rejeita skip/replay. `listSuspensions` usa `storage.session.get(null)`, aceita somente records íntegros do prefixo e ordena por `expiresAt,auditId`; `nextExpiresAt` ignora revoked/malformed. `finish` remove consentimento e suspensão correlacionados somente depois do resultado terminal durável. `revokeAudit` grava `revoked`, solicita cleanup runner-owned quando a source é descartável e só então remove a suspensão; navegação, fechamento, cancelamento, timeout, expiração e fim da sessão chamam esse método.

`createPixelPrivacyGateV1` sem claim devolve `{status:'allowed',authorization:'initial-gesture',claim:null}` quando `signals.detected === false`, pois modo e aviso já foram autorizados pelo gesto que consumiu a target capability. Quando há qualquer categoria sensível, sem claim chama `pixelState.pause` com o `observedTarget` e devolve `{status:'paused'}`. Com claim, exige sinal sensível e igualdade exata de auditoria/aba/documento/modo, então devolve `{status:'allowed',authorization:'sensitive-confirmation',claim}` sem emitir outro consentimento. `afterPixels` apenas encerra referências/recursos efêmeros da invocação e não remove estado persistido; `authorizedAuditStarter` chama `pixelState.finish(claim.consentId)` somente depois de persistir o resultado terminal. Os caminhos initial-gesture/paused são no-op.

- [ ] **Step 5: Alterar o runner sem criar uma segunda autoridade de aba**

Ordem exata: limpar persona/highlight → provar documento/ownership → sondar contexto → chamar `privacyGate.beforePixels({auditId,observedTarget,capturePolicy,signals})` → se `paused`, persistir `retained-for-consent` e retornar sem executar cleanup terminal → se `allowed`, capturar pristine → axe/core → demais evidências. `no-pixels` não chama `beforePixels` e segue sem captura. Para `cleanupMode:'always'`, “always” significa todo resultado terminal; `privacy-paused` é a única suspensão não terminal.

`privacyGate.beforePixels` retorna somente uma das três variantes fechadas declaradas acima. O runner aceita `authorization:'initial-gesture'` somente quando a sonda retornou `detected:false`; se houver categoria sensível, exige `authorization:'sensitive-confirmation'` e claim correspondente antes de qualquer pixel. A mesma invocação pode produzir captura integral, recortes e mapa, mas o claim não pode iniciar uma segunda invocação. O `finally` chama `privacyGate.afterPixels()` após caminho allowed, inclusive em erro.

- [ ] **Step 6: Implementar pausa e retomada após suspensão do worker**

No primeiro retorno `privacy-paused`, `pixelState.pause` já persistiu consentimento+suspensão exatamente uma vez; o worker apenas grava checkpoint durável sanitizado com status `privacy-paused` e então emite o evento fechado. Em `CONFIRM_PIXEL_CAPTURE`, a ordem é:

1. `authorizeSession({sessionCapabilityId,auditId,intent:'confirm-pixels',sender})`, que deriva a janela do contexto confiável;
2. `readSuspension(auditId)` e igualdade de modo;
3. `probeDocumentIdentity(tabId)` e igualdade de `tabId/windowId/documentId/urlSessionDigest`;
4. nova sonda sensível, sem valores;
5. `claimAndBeginResume({auditId,tabId,documentId,mode})`, que faz o write-ahead `consent-claimed`;
6. `authorizedAuditStarter.resumePrivacyPaused(...)` adquire a mesma `targetQueue` do Marco 2, limpa/confirma highlight e persona sob `cleanupBarrier`, reprova documento/HMAC/ownership dentro do lock, faz CAS da sessão `privacy-paused → running` e depois CAS da fase `consent-claimed → session-running`;
7. antes de chamar o runner, faz CAS write-ahead `session-running → runner-started`; só então chama `runObservedTabAudit` sem navegar/criar aba, com target `attached` ou `owned-disposable-resume` e o claim já consumido;
8. validar o retorno terminal do runner e ramificar pela source. Para attached/URL única, persistir o modelo terminal, publicar `result` e somente depois chamar `finish`. Para source de lote (`pageId` não nulo), persistir apenas o checkpoint/resultado daquela página dentro do agregado pai, confirmar cleanup do mesmo `ownershipId`, limpar o par ativo por CAS e chamar `finish`; se houver entry pendente, reentrar no `runBatch` canônico sem publicar um modelo de página como resultado pai. O pai só é persistido/publicado como `result` quando o lote alcançar seu estado terminal. `privacy-paused` e `failed-before-observation` permanecem sem modelo.

Worker reiniciado reconstitui uma pausa ainda `paused` exclusivamente de `storage.session` e permite uma confirmação futura; nunca reemite nem recria consentimento. Uma suspensão `resuming` é recovery, não autorização para recapturar. O bootstrap compara fase, sessão/job, target binding e eventual resultado terminal durável: se o resultado da mesma tentativa já foi persistido, apenas termina sessão/cleanup e chama `finish`; caso contrário revoga sessão/consentimento, não chama pixels e registra `PIXEL_RESUME_INTERRUPTED`. Para attached ou URL única, encerra a tentativa sem modelo novo; para lote, marca a página ativa `failed`/`attempted:true`, confirma cleanup do mesmo `ownershipId`, limpa o par ativo por CAS e chama `batchCoordinator.continuePending({auditId,afterPageId})`. Só então a próxima entry pode consumir seu token. Cleanup não confirmado preserva journal e bloqueia a continuação, sem tocar aba estrangeira.

Os cortes obrigatórios são: depois de `consent-claimed`; depois da sessão `running` e antes de registrar `session-running`; depois de `session-running`; depois do write-ahead `runner-started` e antes da invocação; durante o runner; e depois do resultado terminal antes de `finish`. Testes reiniciam o worker em cada corte, exigem zero segunda captura, no máximo um claim, conclusão idempotente do resultado já durável e, no lote, continuação somente após cleanup/clearActive confirmados.

Documento ou digest/ownership divergente chama `revokeAudit`, agenda cleanup comprovado quando aplicável e retorna exatamente `{ok:false,code:'PIXEL_CONSENT_DOCUMENT_CHANGED'}`; o painel mapeia o código localmente para `A página mudou; inicie uma nova avaliação.`. Claim já consumido retorna `PIXEL_CONSENT_ALREADY_USED`; não captura. Timeout/cancelamento usa a mesma cleanup path e deixa journal `cleanup-pending` se `tabs.remove` não confirmar.

Ao emitir a sessão da auditoria, `target-capabilities.js` estende a máquina do Marco 1 com o estado `privacy-paused`; nesse estado o painel conserva exatamente `cancel|confirm-pixels`, enquanto `confirm-pixels` não existe nos demais estados. A transição `running → privacy-paused` ocorre depois de persistir a suspensão. Depois do claim, remove `confirm-pixels` e transiciona para `running` antes de reiniciar o runner. `authorizeSession` continua exigindo extension ID, issuer, janela derivada e audit ID exatos; a UI nunca fornece a janela.

`resumePrivacyPaused` uses the same deferred-handshake/held-lock construction as the Marco 2 start path: it can answer the panel after the runner is relaunched while its public `completion` still represents the queue operation through finalization. A race test starts a persona install during pause/confirmation and proves `maxConcurrentTargetOperations === 1`, cleanup occurs before reprobe/claim and no persona DOM survives into pixel capture.

Um teste obrigatório pausa a segunda de três páginas, reinicia o worker, confirma uma vez e prova a sequência `persist-page-2 → cleanup-owner-page-2 → clear-active-page-2 → continue-page-3 → publish-parent-result`; `page-3` executa exatamente uma vez e nenhum modelo individual de `page-2` é publicado no slot do audit pai.

`createPixelConsentExpirySchedulerV1` não registra listeners. O único `alarms.onAlarm` do service worker delega `PIXEL_CONSENT_ALARM_NAME` a `run('alarm')`; o bootstrap chama `recoverOnStartup()` e `run('startup')`. `run` é serializado: lê no máximo 25 suspensões vencidas, chama a mesma liquidação interrompida acima com `PIXEL_CONSENT_EXPIRED`, continua a fila somente após cleanup comprovado e então chama `scheduleNext`. `scheduleNext` mantém um alarme one-shot na menor expiração futura ou limpa somente esse nome quando não houver pendência. `pause`, `claimAndBeginResume`, `finish` e `revokeAudit` pedem reagendamento. `runtime.onStartup` apenas chama o mesmo objeto; não existe segundo listener, timer de página ou intervalo. Falha no Chrome API mantém o record e será retomada no próximo startup/alarme/painel.

- [ ] **Step 7: Fechar protocolo, opções e cópia canônica**

`parseWorkerMessage` valida conjunto exato de chaves com `Object.keys(message).sort()`, tipos, limites (`url` até 8192 code units, `urls` até 64 KiB e 20 entradas aceitas após normalização) e rejeita propriedade extra. Os quatro envelopes de start carregam `deleteAfterCompleteExport:boolean`; popup envia sempre `false`, painel envia a escolha visível. URL/lote também exigem a `capabilityId` preparada pelo painel. O popup e painel mostram os três modos antes do gesto; default `full-evidence`, `includeQuery:false`, sem “lembrar escolha”.

O teste de contrato do runner chama a assinatura final e confirma que qualquer input contendo `privacyDecision` ou `checkpointRecorder` falha antes de criar, navegar, observar ou capturar uma aba. Não permanece overload nem adapter público com os nomes antigos.

Limitações exatas:

- `element-only`: `A captura da página inteira e o mapa anotado não foram coletados neste modo.`
- `no-pixels`: `Nenhuma captura raster foi coletada no modo sem imagens.`
- pausa: `A página pode conter conteúdo sensível visível.`

Nenhuma limitação vira aprovação ou certificação.

- [ ] **Step 8: Executar testes focados e confirmar PASS**

Run: `node --test test/privacy/capture-policy.test.js test/browser/sensitive-context-probe.test.js test/background/pixel-capture-consent.test.js test/background/pixel-consent-expiry.test.js test/background/target-capabilities.test.js test/background/authorized-audit-starter.test.js test/background/owned-tabs.test.js test/background/observed-tab-runner.test.js test/background/run-audit.test.js test/background/run-batch.test.js test/background/worker-protocol.test.js test/background/service-worker.test.js test/popup/popup-state.test.js test/panel/panel-state.test.js test/panel/panel-ui.test.js`

Expected: PASS para os três modos, ordem do gate, sender errado, extra field, replay, documento trocado, expiração, todos os cortes de restart, continuação de lote e zero pixel antes do aceite.

- [ ] **Step 9: Commit**

```bash
git add src/core/privacy/capture-policy.js src/browser/sensitive-context-probe.js src/background/pixel-capture-consent.js src/background/pixel-consent-expiry.js src/background/target-capabilities.js src/background/authorized-audit-starter.js src/background/owned-tabs.js src/background/observed-tab-runner.js src/background/run-audit.js src/background/run-batch.js src/background/worker-protocol.js src/background/service-worker.js src/popup/index.html src/popup/popup.js src/popup/popup-state.js src/panel/index.html src/panel/panel.js src/panel/panel-state.js test/privacy/capture-policy.test.js test/browser/sensitive-context-probe.test.js test/background/pixel-capture-consent.test.js test/background/pixel-consent-expiry.test.js test/background/target-capabilities.test.js test/background/authorized-audit-starter.test.js test/background/owned-tabs.test.js test/background/observed-tab-runner.test.js test/background/run-audit.test.js test/background/run-batch.test.js test/background/worker-protocol.test.js test/background/service-worker.test.js test/popup/popup-state.test.js test/panel/panel-state.test.js test/panel/panel-ui.test.js
git commit -m "feat: bind pixel consent to observed documents"
```

---

### Task 4: Fazer o runner possuir abas e o lote possuir somente tokens

**Files:**

- Modify: `src/background/run-audit.js`
- Modify: `src/background/run-batch.js`
- Modify: `src/background/authorized-audit-starter.js`
- Modify: `src/background/target-capabilities.js`
- Modify: `src/background/context-menu.js`
- Create: `src/background/current-state-assist.js`
- Modify: `src/background/chrome-adapter.js`
- Modify: `src/background/highlight-controller.js`
- Modify: `src/background/worker-protocol.js`
- Modify: `src/background/service-worker.js`
- Modify: `src/background/session.js`
- Modify: `src/core/batch/normalize-url-list.js`
- Modify: `src/storage/audit-retention.js`
- Modify: `src/panel/index.html`
- Modify: `src/panel/panel.js`
- Modify: `src/panel/panel-state.js`
- Modify: `src/review/review.js`
- Modify: `test/background/run-audit.test.js`
- Modify: `test/background/run-batch.test.js`
- Modify: `test/background/authorized-audit-starter.test.js`
- Modify: `test/background/target-capabilities.test.js`
- Modify: `test/background/context-menu.test.js`
- Create: `test/background/current-state-assist.test.js`
- Modify: `test/background/chrome-adapter.test.js`
- Modify: `test/background/worker-protocol.test.js`
- Modify: `test/background/service-worker.test.js`
- Modify: `test/background/session.test.js`
- Modify: `test/core/normalize-url-list.test.js`
- Modify: `test/storage/audit-retention.test.js`
- Modify: `test/panel/panel-state.test.js`
- Modify: `test/panel/panel-ui.test.js`
- Modify: `test/review/review-ui.test.js`

**Interfaces:**

- Consumes `runObservedTabAudit`, `OwnedDisposableTabV1`, `createRawNavigationVaultV1`, `CapturePolicyV1` e o único `createAuthorizedAuditStarter` dos Marcos 1–2. URL/lote não criam dispatcher, sessão ou starter paralelo.
- Produces:

```text
NavigationStartCapabilityV1 = {
  version:1,capabilityId,
  issuer:{type:'extension-document',documentId,path:'/src/panel/index.html'}
    | {type:'worker-event',event:'context-menu-link',eventNonce:`event_<22 base64url chars>`},
  windowId,allowedIntent:'single'|'batch',issuedAt,expiresAt,state:'prepared'|'claimed'|'revoked'
}

PREPARE_PANEL_NAVIGATION_CAPABILITY {type,requestId,intent:'single'|'batch'}
// -> {ok:true,requestId,capabilityId,expiresAt}; no tab/document target, URL or Chrome ID

export async function runUrlAudit({
  auditId, ownershipId, navigationToken, navigationPurpose, evidenceUrl, sessionDigest,
  rawNavigationVault, chromeAdapter, capturePolicy,
  privacyGate, checkpointStore, onProgress, now, signal, expectedExtensionId,
  auditRunner = runObservedTabAudit,
});
// navigationPurpose: 'single-url'|'context-menu-link'
// -> retorno fechado de runObservedTabAudit; observedTarget é retido após observação

export async function runBatch({
  auditId, entries, rawNavigationVault, chromeAdapter, capturePolicy,
  privacyGateFactory, checkpointStore, sessionTargetCoordinator, ownershipIdFactory,
  onProgress, now, signal, expectedExtensionId,
  auditRunner = runObservedTabAudit,
});
// entries: [{line,navigationToken,evidenceUrl,sessionDigest}]

export function createBatchEntryCheckpointV1(input);
// -> {version:1,auditId,pageId,line,evidenceUrl,sessionDigest,status,
//     attempted,startedAt,endedAt,rulesVersion,inventoryVersion,inventoryHash}

export function createSanitizedCheckpointStoreV1({ auditStore });
// .writeSanitized(auditId,checkpoint) -> Promise<void>
// .clearAudit(auditId) -> Promise<number>

export function projectRunnerCheckpointV1({
  auditId, pageId, line, evidenceUrl, sessionDigest, runnerCheckpoint,
});
// -> BatchEntryCheckpointV1; não copia target, token, capability nem URL de navegação

export function createOwnershipId(randomBytes);
// 16 CSPRNG bytes -> `owner_<22 unpadded base64url>`; wrong type/length rejects

// Extensão final da sessão, fora de AuditModel V2:
// targetBinding = {kind:'attached',tabId,documentId,urlSessionDigest}
//   | {kind:'disposable',ownershipId,state:'pending'|'observing'|'retained-for-review'|'retained-for-consent'|'cleanup-pending'|'removed'}
//   | {kind:'batch',activePageId:null|string,activeOwnershipId:null|string}

// AuditRetentionPreferenceV1, IndexedDB fora do modelo:
// {version:1,auditId,deleteAfterCompleteExport,createdAt}

// OPEN_CURRENT_STATE_ASSIST
// {type:'OPEN_CURRENT_STATE_ASSIST',sessionCapabilityId,auditId,occurrenceId,url}

export function createCurrentStateAssistCoordinator({
  sessionAuthority,modelAuthority,rawNavigationVault,ownedTabs,chromeAdapter,
  highlightController,targetQueue,digestManager,now,randomBytes,
});
// .open({sessionCapabilityId,auditId,occurrenceId,rawUrl,sender})
// -> {ok:true,state:'active',notice:'current-state'} | {ok:false,code}
```

- `status` é `'not-started'|'running'|'complete'|'partial'|'failed'|'cancelled'|'privacy-paused'`; `attempted` é `status !== 'not-started'`.

- [ ] **Step 1: Escrever testes RED que proíbem ownership duplicado**

```js
test('single URL delegates creation and cleanup exclusively to observed-tab runner', async () => {
  const calls = [];
  let takeArgs = null;
  const result = await runUrlAudit({
    auditId: 'audit-1', ownershipId:'owner_1111111111111111111111', navigationToken: 'token-1',
    navigationPurpose: 'single-url',
    evidenceUrl: evidenceUrlFixture, sessionDigest: sessionDigestFixture,
    rawNavigationVault: { async take(token, options) {
      takeArgs = {token, options};
      return 'https://example.test/';
    } },
    chromeAdapter: Object.freeze({ marker: 'adapter' }),
    capturePolicy: noPixels, privacyGate: noPixelGate,
    checkpointStore: checkpointSpy, onProgress() {}, now: fixedNow,
    signal: new AbortController().signal, expectedExtensionId: 'extension-id',
    auditRunner: async input => {
      calls.push(input);
      return { status: 'complete', model: modelFixture, observedTarget: targetFixture,
        observationState: 'observed', ownershipState:'retained-for-review' };
    },
  });
  assert.deepEqual(takeArgs, {
    token: 'token-1', options: {auditId:'audit-1',purpose:'single-url'},
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].target, {
    kind: 'disposable', ownershipId:'owner_1111111111111111111111', navigationUrl: 'https://example.test/',
    cleanupMode: 'pre-observation-failure',
  });
  assert.equal(result.observedTarget, targetFixture);
  assert.equal(result.ownershipState,'retained-for-review');
});

test('ownership IDs require exactly 128 CSPRNG bits', () => {
  assert.match(createOwnershipId(length => new Uint8Array(length).fill(1)),/^owner_[A-Za-z0-9_-]{22}$/u);
  assert.throws(() => createOwnershipId(() => new Uint8Array(15)),/ownership/iu);
});

test('URL start publishes one session/bootstrap/job before the runner and leaves no orphan token on failure', async () => {
  const started=await starter.beginAuthorizedNavigationAudit(validSingleStart);
  assert.deepEqual(trace.slice(0,5),['claim-and-session','persist-retention','write-bootstrap','register-job','start-runner']);
  assert.deepEqual(started.response,{ok:true,auditId:'audit-1',acceptedCount:1,warnings:[]});
  assert.match(started.sessionCapabilityId,/^[A-Za-z0-9_-]{22,}$/u);
  await started.completion;
  await assertNoOrphanNavigationFor('audit-1');

  const denied=await starter.beginAuthorizedNavigationAudit({...validSingleStart,senderContext:forgedPanelSender});
  assert.deepEqual(denied.response,{ok:false,code:'CONTEXT_DENIED'});
  await assertNoOrphanNavigationFor('audit-forged');
});

test('batch CAS-binds one active owner at a time under the parent audit id', async () => {
  const result=await starter.beginAuthorizedNavigationAudit(validBatchStart);
  await result.completion;
  assert.deepEqual(runnerAuditIds,['audit-batch','audit-batch']);
  assert.deepEqual(sessionTargetTrace,[
    {pageId:'page-1',ownershipId:'owner-1'},
    {pageId:null,ownershipId:null},
    {pageId:'page-2',ownershipId:'owner-2'},
    {pageId:null,ownershipId:null},
  ]);
  assert.equal(staleOwnerReplayAccepted,false);
});

test('retention preference survives worker restart and is never read from EXPORT_COMPLETE', async () => {
  await starter.beginAuthorizedNavigationAudit({...validSingleStart,retentionPreference:{version:1,deleteAfterCompleteExport:true}});
  await restartWorkerFixture();
  assert.deepEqual(await retentionStore.getPreference('audit-1'),{
    version:1,auditId:'audit-1',deleteAfterCompleteExport:true,createdAt:FIXED_ISO,
  });
});

test('context-menu link normalizes internally and uses the same navigation starter', async () => {
  await contextMenuClick({menuItemId:'audita-audit-link',linkUrl:'https://example.test/a?secret=1'});
  assert.deepEqual(trace.slice(0,4),['side-panel-open','vault-put','worker-event-claim','authorized-navigation-start']);
  assert.deepEqual(vaultPutPurposes,['context-menu-link']);
  assert.equal(JSON.stringify(workerResponses).includes('secret=1'),false);
});

test('navigation issuers are disjoint and context-menu nonce is one-shot', async () => {
  const eventCapability = await authority.issueNavigationForWorkerEvent({
    event: 'context-menu-link', eventNonce: 'event_AAAAAAAAAAAAAAAAAAAAAA', windowId: 3, intent: 'single',
  });
  await assert.rejects(authority.claimNavigation({
    capabilityId: eventCapability.capabilityId, intent: 'single',
    sender: validPanelSender, eventNonce: null,
  }), /emissor não corresponde/iu);
  assert.equal((await authority.claimNavigation({
    capabilityId: eventCapability.capabilityId, intent: 'single',
    sender: null, eventNonce: 'event_AAAAAAAAAAAAAAAAAAAAAA',
  })).ok, true);
  await assert.rejects(authority.claimNavigation({
    capabilityId: eventCapability.capabilityId, intent: 'single',
    sender: null, eventNonce: 'event_AAAAAAAAAAAAAAAAAAAAAA',
  }), /já utilizada/iu);

  const panelCapability = await authority.issueNavigationForPanel(validPanelPreparation);
  await assert.rejects(authority.claimNavigation({
    capabilityId: panelCapability.capabilityId, intent: 'single',
    sender: null, eventNonce: 'event_BBBBBBBBBBBBBBBBBBBBBB',
  }), /emissor não corresponde/iu);
});

test('current-state assist requires a fresh URL and never changes historical evidence', async () => {
  const before=structuredClone(modelSnapshot);
  const result=await currentStateAssist.open({
    sessionCapabilityId:VALID_SESSION,auditId:'audit-batch',occurrenceId:'occ-1',
    rawUrl:'https://example.test/current?secret=1',sender:registeredReportSender,
  });
  assert.deepEqual(result,{ok:true,state:'active',notice:'current-state'});
  assert.deepEqual(modelSnapshot,before);
  assert.equal(calls.order.indexOf('register-owned-about-blank') < calls.order.indexOf('navigate'),true);
  assert.deepEqual(calls.proofInputs.map(value => Object.hasOwn(value,'selectorFromUi')),[false]);
  assert.equal(JSON.stringify({response:result,logs}).includes('secret=1'),false);
});

test('current-state ambiguity removes only its owned tab and produces no overlay', async () => {
  chromeAdapter.currentStateMatchCount=2;
  assert.deepEqual(await currentStateAssist.open(validAssistInput),{ok:false,code:'CURRENT_STATE_TARGET_AMBIGUOUS'});
  assert.equal(calls.overlayInstall,0);
  assert.deepEqual(calls.removedTabIds,[ownedAssistTabId]);
});
```

`noPixels`, `noPixelGate`, `checkpointSpy`, `fixedNow`, `modelFixture`, `targetFixture`, `evidenceUrlFixture`, `sessionDigestFixture`, `validSingleStart`, `validBatchStart`, `retentionStore`, `assertNoOrphanNavigationFor`, `restartWorkerFixture`, `contextMenuClick`, `vaultPutPurposes`, `authority`, `validPanelSender` e `validPanelPreparation` são helpers/fixtures privados declarados no topo dos respectivos testes com as closed shapes dos Marcos 1 e 3.

- [ ] **Step 2: Executar testes e confirmar RED**

Run: `node --test test/background/run-audit.test.js test/background/run-batch.test.js test/background/authorized-audit-starter.test.js test/background/target-capabilities.test.js test/background/context-menu.test.js test/background/current-state-assist.test.js test/background/chrome-adapter.test.js test/background/worker-protocol.test.js test/background/service-worker.test.js test/background/session.test.js test/storage/audit-retention.test.js test/panel/panel-ui.test.js test/review/review-ui.test.js`

Expected: FAIL enquanto `runUrlAudit` ou `runBatch` cria/remove abas diretamente ou aceita URL completa em `entries`.

- [ ] **Step 3: Implementar URL única sem chamar primitives de aba**

`target-capabilities.js` adds a separate one-shot `NavigationStartCapabilityV1`; it never reuses the attached target capability. `PREPARE_PANEL_NAVIGATION_CAPABILITY` derives the exact SIDE_PANEL document/window, emits somente o issuer `extension-document`, binds one intent and needs no active HTTP(S) tab, so URL/lote remain usable even when the current tab is restricted. Claim repeats sender/document/window/intent/expiry proof atomically. O callback confiável de `contextMenus.onClicked` pode emitir somente issuer `worker-event`/evento `context-menu-link`, intent `single` e nonce CSPRNG de 16 bytes; esse claim exige `sender:null`, o mesmo nonce e a mesma janela derivada do `tab`, e consome nonce+capability no mesmo CAS. Um issuer nunca satisfaz o proof do outro. The popup and attached preparation contracts remain unchanged.

`createAuthorizedAuditStarter` gains only the worker-internal `beginAuthorizedNavigationAudit({capabilityId,eventNonce,auditId,capturePolicy,retentionPreference,navigationPlan,senderContext})`, which delegates to the same private atomic start transaction used by `beginAuthorizedAudit`. `navigationPlan` is a frozen internal union `{kind:'single',ownershipId,navigationToken,navigationPurpose:'single-url'|'context-menu-link',evidenceUrl,sessionDigest}` or `{kind:'batch',queueId,acceptedCount}`; it never contains a raw URL. For panel starts, the dispatcher first derives/inspects the matching navigation capability, normalizes and vaults input, then the starter repeats proof, atomically claims it + issues running session, persists `AuditRetentionPreferenceV1`, bootstrap and active job, and starts the runner. Any failure compensates the claimed session/preference and clears only the newly created tokens/queue before answering. The safe response is emitted only after those durable writes and contains no owner/token.

O retorno interno permanece `{response:{ok:true,auditId,acceptedCount,warnings},sessionCapabilityId,completion}`. Somente o dispatcher autorizado constrói a resposta externa `{...response,sessionCapabilityId}`; assim o starter não duplica o ID dentro de `response`, e testes validam os dois shapes exatos separadamente.

`target-capabilities.js` migrates the session `targetBinding` to the final union above. Single URL binds its pre-generated `ownershipId`; batch begins with a null active pair. Before each batch navigation, `sessionTargetCoordinator.bindActive({auditId,pageId,ownershipId})` performs a CAS from null; it freezes the pair through privacy pause and clears it only after the runner confirms terminal cleanup. A stale page/owner cannot cancel, resume or clear a newer owner. `AuditRetentionPreferenceV1` is immutable after start and is reloaded after worker restart; `EXPORT_COMPLETE` never carries or changes it.

```text
const navigationUrl = await rawNavigationVault.take(navigationToken, {
  auditId, purpose: navigationPurpose,
});
return auditRunner({
  auditId,
  target: { kind: 'disposable', ownershipId, navigationUrl, cleanupMode: 'pre-observation-failure' },
  chromeAdapter, capturePolicy, privacyGate,
  onCheckpoint: runnerCheckpoint => checkpointStore.writeSanitized(auditId,
    projectRunnerCheckpointV1({
      auditId, pageId: 'page-1', line: 1, evidenceUrl, sessionDigest, runnerCheckpoint,
    })),
  now, signal, expectedExtensionId,
});
```

`runUrlAudit` não pode citar `tabs.create`, `tabs.update`, `tabs.remove`, `createDisposableTab` ou `removeOwnedTab`; o teste lê seu source e falha se localizar esses tokens. Após `observed`, o target devolvido fica disponível para revisão/destaque; falha pré-observação é limpa pelo runner conforme `cleanupMode`.

- [ ] **Step 4: Implementar lote sequencial com cleanup `always`**

Para cada entry, chamar `take(navigationToken,{auditId,purpose:'batch-page'})` imediatamente antes da tentativa e invocar:

```js
const pageId=`page-${index + 1}`;
const ownershipId=ownershipIdFactory();
await sessionTargetCoordinator.bindActive({auditId,pageId,ownershipId});
await auditRunner({
  auditId,
  target: { kind: 'disposable', ownershipId, navigationUrl, cleanupMode: 'always' },
  chromeAdapter, capturePolicy,
  privacyGate: privacyGateFactory({ auditId, pageId }),
  onCheckpoint: runnerCheckpoint => checkpointStore.writeSanitized(auditId,
    projectRunnerCheckpointV1({
      auditId, pageId, line: entry.line,
      evidenceUrl: entry.evidenceUrl, sessionDigest: entry.sessionDigest, runnerCheckpoint,
    })),
  now, signal, expectedExtensionId,
});
await sessionTargetCoordinator.clearActiveAfterConfirmedCleanup({auditId,pageId,ownershipId});
```

Não iniciar a próxima entry até o runner resolver e confirmar cleanup. Se a entry pausar por privacidade, o lote inteiro fica suspenso com owner `retained-for-consent`; confirmação retoma a mesma entry/aba e só depois do resultado terminal+cleanup avança. Falha de navegação vira página `failed` e o lote continua; cleanup não confirmado interrompe entradas seguintes como `not-started`. Cancelamento marca a ativa `cancelled`, mantém demais `not-started`, chama `rawNavigationVault.clearAudit(auditId)`, conclui ou deixa journal de cleanup da única aba própria e nunca inclui páginas não tentadas no denominador de cobertura.

`context-menu.js` mantém o item de página attached do Marco 1 e adiciona `audita-audit-link` para contexto `link`. No callback de gesto, chama `sidePanel.open` antes do primeiro `await`, cria o nonce worker-owned, emite o issuer `worker-event` e normaliza `info.linkUrl` somente dentro do worker. URL válida entra no mesmo vault com purpose `context-menu-link` e `beginAuthorizedNavigationAudit` com `retentionPreference.deleteAfterCompleteExport:false`; resposta/log/evento nunca contém a URL. URL inválida falha com código leigo fixo e nenhum token. Testes reais do callback cobrem nonce errado/repetido, tentativa de usar sender de painel no issuer de evento, tentativa de usar nonce no issuer de painel e confirmam zero token/sessão/job órfão em toda rejeição. Menu de link não é uma rota UI alternativa nem cria segundo starter.

- [ ] **Step 5: Fechar checkpoint sanitizado e auxílio de estado atual**

`projectRunnerCheckpointV1` lê somente status/timestamps/versões/hash permitidos de `ExecutionCheckpointV1` e os combina com a projeção da entry. `createBatchEntryCheckpointV1` aceita exatamente as 13 chaves documentadas, valida `evidenceUrl.version`, digest `/^hmac-sha256:[A-Za-z0-9_-]{43}$/`, timestamps ISO ou `null` e inventário vindo de `CoreRuleInventoryV1`. `createSanitizedCheckpointStoreV1` persiste esse closed shape sob chave privada correlacionada e rejeita `navigationToken`, `navigationUrl`, capability e propriedade extra.

`OPEN_CURRENT_STATE_ASSIST` é navegação assistiva, não fallback de `HighlightBindingV1`. O painel/relatório mostra, somente em ocorrência com seletor conservador elegível, um card `[data-occurrence-id]` com campo vazio `input[name="current-state-url"]`, ação `data-action="current-state-assist"` e clear compartilhado `data-action="clear-highlight"`; nunca preenche o campo com `EvidenceUrlV1`. A ação envia exatamente o occurrence ID do card e o valor digitado. O coordinator:

1. autoriza a sessão/sender/audit com intent `current-state-assist` e carrega modelo/revisão/hash validados;
2. resolve internamente a ocorrência e exige exatamente um seletor histórico que passe `CSSSelectorV1`; nenhum seletor vem da UI;
3. normaliza a URL nova, guarda-a no raw vault com purpose `current-state-assist` e a consome uma vez;
4. cria `about:blank`, persiste `OwnedDisposableTabV2` com purpose `current-state-assist` antes de navegar, prova janela/documento/HMAC e adquire a target queue;
5. `chromeAdapter.proveCurrentStateTarget` exige uma única correspondência para o seletor, produz backend node, `documentId`, frame e `StructuralSignatureV1` novos; ambiguidade, frame inacessível ou mudança falha fechado;
6. `highlightController.installVerifiedCurrentStateAssistLocked` instala overlay/owner transitório somente a partir desse proof, sem criar/alterar `HighlightBindingV1`, modelo, evidence IDs, URL histórica ou hash;
7. retorna apenas estado seguro e mostra `Estado atual da página; a captura do relatório é a evidência da auditoria.`.

Falha antes do overlay remove apenas a aba própria após CAS/prova; falha de cleanup mantém journal. Sucesso retém a aba própria até clear, fechamento, expiração, deleção ou fim da sessão. `CLEAR_HIGHLIGHT` autoriza `highlight` para binding histórico ou `current-state-assist` quando o owner ativo tem essa proveniência. Sessões `result|view-only` podem receber somente esse intent adicional; ele nunca autoriza destaque histórico direto.

O relatório espelha apenas o estado local fechado `document.body.dataset.currentStateAssist = 'inactive'|'opening'|'active'|'failed'`; ele é derivado da máquina de UI, nunca de IDs/URL, volta a `inactive` após clear e fica `failed` somente até a próxima ação explícita. `test/review/review-ui.test.js` cobre as quatro transições e rejeita qualquer valor fora da união.

- [ ] **Step 6: Atualizar painel e rótulos de lote**

Painel mantém URL em destaque, alternativa de até 20 linhas, erros por linha, progresso `Página n de total`, páginas não iniciadas e ação `Cancelar avaliação`. Catálogo fechado:

Além do `document.body.dataset.screen` canônico, o painel expõe somente espelhos de teste sem segredo: `dataset.sessionStatus` na união `running|privacy-paused|complete|partial|cancelled|failed|view-only`; `dataset.pageNumber` como inteiro decimal positivo apenas enquanto existe página ativa de lote (atributo ausente nos demais estados); e cada linha de lote com `data-batch-page-state` na união `not-started|running|privacy-paused|complete|partial|failed|cancelled`. Esses atributos são projeções da view validada, não autoridades. `test/panel/panel-ui.test.js` percorre valores/transições, remoção de `pageNumber` e rejeição de estado desconhecido.

```js
const BATCH_MESSAGES_V1 = Object.freeze({
  BATCH_EMPTY: 'Informe ao menos uma URL para auditoria em lote.',
  BATCH_INPUT_TOO_LARGE: 'A lista excede o limite seguro de 64 KiB.',
  BATCH_LINE_COUNT_EXCEEDED: 'O lote aceita no máximo 200 linhas não vazias para validação.',
  BATCH_LINE_TOO_LONG: 'A linha excede o limite seguro de 8192 caracteres.',
  BATCH_LIMIT_EXCEEDED: 'O lote aceita no máximo 20 URLs únicas.',
  DUPLICATE_URL: 'A URL repete uma entrada anterior e não será auditada novamente.',
  EMBEDDED_CREDENTIALS: 'A linha contém credenciais embutidas, que não são permitidas.',
  INVALID_URL: 'A linha não contém uma URL HTTP ou HTTPS válida.',
});
```

Nenhuma mensagem repete a URL recebida.

- [ ] **Step 7: Executar testes focados e confirmar PASS**

Run: `node --test test/background/run-audit.test.js test/background/run-batch.test.js test/background/authorized-audit-starter.test.js test/background/target-capabilities.test.js test/background/context-menu.test.js test/background/current-state-assist.test.js test/background/chrome-adapter.test.js test/background/worker-protocol.test.js test/background/service-worker.test.js test/background/session.test.js test/core/normalize-url-list.test.js test/storage/audit-retention.test.js test/panel/panel-state.test.js test/panel/panel-ui.test.js test/review/review-ui.test.js`

Expected: PASS; runner é o único dono de aba, lote mantém concorrência máxima 1, colisões sanitizadas têm page IDs diferentes e estado durável não contém bearer/URL bruta.

- [ ] **Step 8: Commit**

```bash
git add src/background/run-audit.js src/background/run-batch.js src/background/authorized-audit-starter.js src/background/target-capabilities.js src/background/context-menu.js src/background/current-state-assist.js src/background/chrome-adapter.js src/background/highlight-controller.js src/background/worker-protocol.js src/background/service-worker.js src/background/session.js src/core/batch/normalize-url-list.js src/storage/audit-retention.js src/panel/index.html src/panel/panel.js src/panel/panel-state.js src/review/review.js test/background/run-audit.test.js test/background/run-batch.test.js test/background/authorized-audit-starter.test.js test/background/target-capabilities.test.js test/background/context-menu.test.js test/background/current-state-assist.test.js test/background/chrome-adapter.test.js test/background/worker-protocol.test.js test/background/service-worker.test.js test/background/session.test.js test/core/normalize-url-list.test.js test/storage/audit-retention.test.js test/panel/panel-state.test.js test/panel/panel-ui.test.js test/review/review-ui.test.js
git commit -m "feat: serialize tokenized multi-page audits"
```

---

### Task 5: Unificar exclusão atômica e retenção absoluta

**Files:**

- Create: `src/background/audit-deletion-coordinator.js`
- Create: `src/background/blob-url-registry.js`
- Create: `src/background/retention-scheduler.js`
- Modify: `src/background/target-capabilities.js`
- Modify: `src/background/highlight-controller.js`
- Modify: `src/background/highlight-binding-store.js`
- Modify: `src/background/report-launch.js`
- Modify: `src/background/export-launch.js`
- Modify: `src/background/panel-port.js`
- Modify: `src/background/report-port.js`
- Modify: `src/background/owned-tabs.js`
- Modify: `src/background/pixel-capture-consent.js`
- Modify: `src/background/worker-protocol.js`
- Modify: `src/background/service-worker.js`
- Modify: `src/panel/panel.js`
- Modify: `src/review/review.js`
- Modify: `src/storage/audit-retention.js`
- Modify: `src/storage/audit-store.js`
- Create: `test/background/audit-deletion-coordinator.test.js`
- Create: `test/background/blob-url-registry.test.js`
- Create: `test/background/retention-scheduler.test.js`
- Modify: `test/background/target-capabilities.test.js`
- Modify: `test/highlight/highlight-controller.test.js`
- Modify: `test/highlight/highlight-binding-store.test.js`
- Modify: `test/background/report-launch.test.js`
- Modify: `test/background/export-launch.test.js`
- Modify: `test/background/panel-port.test.js`
- Modify: `test/background/report-port.test.js`
- Modify: `test/background/owned-tabs.test.js`
- Modify: `test/background/pixel-capture-consent.test.js`
- Modify: `test/background/service-worker.test.js`
- Modify: `test/background/worker-protocol.test.js`
- Modify: `test/panel/panel-ui.test.js`
- Modify: `test/review/review-ui.test.js`
- Modify: `test/storage/audit-retention.test.js`
- Modify: `test/storage/audit-store.test.js`
- Modify: `test/e2e/retention-indexeddb-mv3.test.mjs`

**Interfaces:**

- Produces:

```text
// DeletionTombstoneV1, object store `audit-deletion-tombstones`
// {version:1,auditId,reason,requestedAt,phase:'transient-cleanup-pending',
//  attempts:0|positiveInteger,lastAttemptAt:null|canonicalIsoInstant}

store.stageAuditDeletionV1({auditId,reason,now,expectedRevision,terminalReceipt});
// -> {status:'staged',tombstone} | {status:'denied',code}
store.listDeletionTombstonesV1({limit});
store.recordDeletionCleanupFailureV1({auditId,at});
store.completeAuditDeletionV1({auditId});
store.nextExpiresAtV1();
store.stageExpiredAuditDeletionsV1({now,limit});
// -> Promise<readonly DeletionTombstoneV1[]>

export function createBlobUrlRegistryV1({ sessionArea, revokeInOwner, isOwnerAlive });
// .register({auditId,blobUrl,ownerDocumentId}) -> Promise<void>
// .release({auditId,blobUrl,ownerDocumentId}) -> Promise<void>
// .clearAudit(auditId) -> Promise<number>

authority.issueDeletionCapability({windowId,scope,auditId,consumers});
// scope: 'one'|'all'; auditId é canônico para 'one' e null para 'all'
// -> Promise<{ok:true,sessionCapabilityId}|{ok:false,code}>
authority.authorizeDeletion({sessionCapabilityId,scope,auditId,sender});
// -> Promise<{ok:true,authorization:ManualDeletionAuthorizationV1}|{ok:false,code}>

// ManualDeletionAuthorizationV1, interno ao worker
// {version:1,scope:'one'|'all',auditId:string|null,authorizedAt:string}

authority.clearAudit(auditId) -> Promise<number>;
panelPortRegistry.clearAudit(auditId) -> Promise<number>;
reportPortRegistry.clearAudit(auditId) -> Promise<number>;
highlightController.clearAudit(auditId) -> Promise<boolean>;
highlightBindingStore.deleteAudit(auditId) -> Promise<boolean>;
rawNavigationVault.clearAudit(auditId) -> Promise<number>;
pixelCaptureState.revokeAudit(auditId,'audit-deleted') -> Promise<boolean>;
blobRegistry.clearAudit(auditId) -> Promise<number>;
exportLaunch.clearAudit(auditId) -> Promise<boolean>;
reportLaunch.clearAudit(auditId) -> Promise<boolean>;
ownedDisposableTabStore.clearAudit(auditId) -> Promise<number>;

export function createAuditDeletionCoordinatorV1({
  store, authority, panelPortRegistry, reportPortRegistry,
  highlightController, highlightBindingStore, reportLaunch, exportLaunch,
  rawNavigationVault, pixelCaptureState, ownedDisposableTabStore, blobRegistry, now,
});
// .request({auditId,reason,expectedRevision,terminalReceipt,manualAuthorization})
// .resumePending({limit})

export function registerRetentionSchedulerV1(chromeApi, {store,deletionCoordinator,now});
// -> {run(trigger),scheduleNext(),dispose()}
```

- Razões fechadas: `'retention-expired'|'manual'|'post-export'`.
- Recursos transitórios expõem cleanup idempotente audit-scoped. Authority invalida capabilities/sessões; panel/report ports descartam a view local; `highlightController.clearAudit` confirma ausência de overlay antes de `highlightBindingStore.deleteAudit`; report/export launch revogam e fecham somente abas comprovadamente próprias; raw vault apaga URL/fila; pixel state revoga consentimento/suspensão; owned-tab store limpa abas de auditoria e `current-state-assist`; Blob registry revoga no documento proprietário. Persona lease não contém `auditId` e fica deliberadamente fora dessa fronteira: uma persona independente nunca é apagada por exclusão de auditoria.

- [ ] **Step 1: Escrever testes RED da fronteira atômica e prazo absoluto**

```js
test('absolute expiry makes model unavailable in the tombstone transaction despite active export', async () => {
  const store = await createStoreFixture({ now: '2026-08-29T12:00:00.000Z' });
  await store.seedAudit({
    auditId: 'audit-1', firstPersistedAt: '2026-07-30T12:00:00.000Z',
    activeExportLease: true,
  });
  const staged = await store.stageAuditDeletionV1({
    auditId: 'audit-1', reason: 'retention-expired',
    now: '2026-08-29T12:00:00.000Z', expectedRevision: null, terminalReceipt: null,
  });
  assert.equal(staged.status, 'staged');
  assert.equal(await store.getAudit('audit-1'), undefined);
  assert.equal((await store.listDeletionTombstonesV1({ limit: 25 })).length, 1);
});

test('failed transient cleanup keeps tombstone but never restores the model', async () => {
  const fixture = deletionCoordinatorFixture({ failingCleaner: 'highlight-overlay' });
  const result = await fixture.coordinator.request({
    auditId: 'audit-1', reason: 'retention-expired', expectedRevision: null,
    terminalReceipt: null, manualAuthorization: null,
  });
  assert.equal(result.status, 'pending');
  assert.equal(await fixture.store.getAudit('audit-1'), undefined);
  assert.equal((await fixture.store.listDeletionTombstonesV1({ limit: 25 }))[0].attempts, 1);
});

test('deletion clears every audit-scoped transient in canonical order and never personas', async () => {
  const fixture = deletionCoordinatorFixture();
  await fixture.coordinator.request({
    auditId: 'audit-1', reason: 'retention-expired', expectedRevision: null,
    terminalReceipt: null, manualAuthorization: null,
  });
  assert.deepEqual(fixture.cleanerTrace, [
    'authority', 'panel-port', 'report-port', 'highlight-overlay', 'highlight-binding',
    'raw-navigation', 'pixel-consent', 'blob-url', 'export-launch', 'report-launch',
    'owned-disposable-tab',
  ]);
  assert.equal(fixture.personaClearCalls, 0);
  assert.equal((await fixture.store.listDeletionTombstonesV1({ limit: 25 })).length, 0);
});
```

`createStoreFixture` e `deletionCoordinatorFixture` são helpers privados definidos no arquivo de teste; o segundo fornece os onze cleaners audit-scoped com spies, uma persona spy separada que deve permanecer em zero e um erro determinístico somente no cleaner indicado. O constructor rejeita a propriedade extra `personaLeaseStore`, impedindo reintrodução acidental dessa dependência.

- [ ] **Step 2: Executar testes e confirmar RED**

Run: `node --test test/background/audit-deletion-coordinator.test.js test/background/blob-url-registry.test.js test/background/retention-scheduler.test.js test/background/target-capabilities.test.js test/highlight/highlight-controller.test.js test/highlight/highlight-binding-store.test.js test/background/report-launch.test.js test/background/export-launch.test.js test/background/panel-port.test.js test/background/report-port.test.js test/background/owned-tabs.test.js test/background/pixel-capture-consent.test.js test/storage/audit-retention.test.js test/storage/audit-store.test.js`

Expected: FAIL por tombstone/coordenador inexistentes e porque lease pode impedir a remoção atual.

- [ ] **Step 3: Implementar uma transação que torna a auditoria indisponível**

Atualizar a versão do banco e criar `audit-deletion-tombstones` com keyPath `auditId`. `stageAuditDeletionV1` abre uma única transação `readwrite` sobre `audits`, `audit-retention` e `audit-deletion-tombstones`; nela:

1. valida revisão para manual/post-export;
2. para pós-exportação valida `ExportReceiptV1` persistido, status `complete`, quatro formatos e mesma tentativa/revisão;
3. para retenção valida `now >= expiresAt` e ignora/revoga lease ativa;
4. apaga modelo, revisão, lease, attempt, delivery journal/receipt, latest correlacionado e todo checkpoint cujo `auditId` corresponda;
5. apaga retention metadata;
6. grava `DeletionTombstoneV1`.

Se qualquer request/validação falhar, abortar toda a transação. Depois do commit, `getAudit`, `getLatest` e `getAuditRetention` não podem devolver a auditoria. `completeAuditDeletionV1` apaga somente o tombstone em transação separada.

- [ ] **Step 4: Implementar o único coordenador para três origens**

`request` exige `ManualDeletionAuthorizationV1` correspondente para razão manual; o handler o obtém com `authority.authorizeDeletion`. Retenção não exige capability; pós-exportação exige receipt terminal. Em seguida chama `stageAuditDeletionV1` e, para o tombstone, executa exatamente esta sequência, sem paralelizar:

1. `authority.clearAudit(auditId)` invalida novas operações;
2. `panelPortRegistry.clearAudit(auditId)` e depois `reportPortRegistry.clearAudit(auditId)` descartam views autorizadas;
3. `highlightController.clearAudit(auditId)` confirma ausência do overlay e só então `highlightBindingStore.deleteAudit(auditId)` remove o binding;
4. `rawNavigationVault.clearAudit(auditId)` remove tokens/fila;
5. `pixelCaptureState.revokeAudit(auditId,'audit-deleted')` revoga pausa/retomada;
6. `blobRegistry.clearAudit(auditId)` revoga blobs enquanto o documento proprietário ainda pode responder;
7. `exportLaunch.clearAudit(auditId)` e depois `reportLaunch.clearAudit(auditId)` CAS-revogam e fecham somente tabs comprovadas;
8. `ownedDisposableTabStore.clearAudit(auditId)` limpa abas de auditoria/auxílio por último, após todos os cleaners que precisam do documento.

Cada método retorna número/boolean e não recebe URL. O cleaner de owner só remove uma aba após CAS e identidade de owner; falha ou ID reutilizado mantém cleanup pendente sem tocar a aba estrangeira. O coordenador não aceita `personaLeaseStore`: persona é window-scoped, não tem `auditId` e não é recurso da auditoria. Testes injetam falha em cada uma das onze posições, exigem que as anteriores não sejam repetidas de forma destrutiva, que o tombstone permaneça e que `resumePending` repita toda a sequência idempotente até a conclusão.

`createBlobUrlRegistryV1` mantém records somente em `storage.session`, correlacionados por `auditId`, `blobUrl` e `ownerDocumentId`. `clearAudit` chama `revokeInOwner` quando `isOwnerAlive` é verdadeiro; owner inexistente é sucesso porque o contexto destruído já não mantém a Blob URL. Owner vivo que não confirma revogação mantém o tombstone. `download-artifacts.js` registra antes de oferecer o download e libera somente após `URL.revokeObjectURL` confirmado.

Somente todas as resoluções bem-sucedidas permitem `completeAuditDeletionV1`. Qualquer rejeição chama `recordDeletionCleanupFailureV1`, retorna `{status:'pending',auditId}` e mantém o tombstone. `resumePending` repete cleaners idempotentes após restart. As três origens chamam esse mesmo método; remover chamadas diretas a `deleteAudit`/`cleanupExpiredAudits`.

- [ ] **Step 5: Implementar alarme one-shot da próxima expiração**

```js
export const RETENTION_ALARM_NAME = 'audita-retention-cleanup-v1';

async function scheduleNext() {
  const next = await store.nextExpiresAtV1();
  if (next === null) {
    await chromeApi.alarms.clear(RETENTION_ALARM_NAME);
    return;
  }
  const current = new Date(now()).getTime();
  if (!Number.isFinite(current)) throw new TypeError('Relógio de retenção inválido.');
  await chromeApi.alarms.create(RETENTION_ALARM_NAME, {
    when: Math.max(current, new Date(next).getTime()),
  });
}
```

`run(trigger)` é serializado: chama `stageExpiredAuditDeletionsV1({now:now(),limit:25})`, `resumePending({limit:25})` e `scheduleNext()`. Executar em inicialização do worker, `runtime.onStartup`, alarme correspondente, abertura do painel e criação de nova retention. Não usar `periodInMinutes`. Startup/painel processam vencidos imediatamente; exportação/revisão nunca altera `firstPersistedAt/expiresAt`.

- [ ] **Step 6: Fechar manual, pós-exportação e UI pendente**

Abrir o diálogo não emite autoridade. Somente no clique de confirmação a UI envia `{type:'PREPARE_DELETE_CAPABILITY',scope:'one',auditId}` ou `{type:'PREPARE_DELETE_CAPABILITY',scope:'all'}`; o worker deriva documento/janela do sender, verifica path e chama `authority.issueDeletionCapability` com TTL 60 segundos. A resposta contém somente `{ok:true,sessionCapabilityId}` e a UI envia imediatamente o pedido correlacionado. Cancelar o diálogo antes da confirmação não deixa capability para invalidar.

`REQUEST_DELETE_AUDIT` permanece fechado, sender-bound e exige exatamente `{type,auditId,sessionCapabilityId}` após confirmação visual. `REQUEST_DELETE_ALL_AUDITS` exige exatamente `{type,sessionCapabilityId}`; o handler autoriza scope `all` uma vez, lista IDs canônicos e passa cada um pelo coordenador com a autorização já validada, sem chamar `clear()` no banco. Capability é one-shot e expira/invalida por mismatch do documento/janela derivados. Pós-exportação chama o coordenador somente depois de persistir receipt complete. A UI mostra `Exclusão pendente; os dados da auditoria já não estão disponíveis localmente.` quando existir tombstone e `Os arquivos já baixados permanecem no dispositivo.` em qualquer sucesso.

- [ ] **Step 7: Executar testes focados e E2E de retenção**

Run: `node --test test/background/audit-deletion-coordinator.test.js test/background/blob-url-registry.test.js test/background/retention-scheduler.test.js test/background/target-capabilities.test.js test/highlight/highlight-controller.test.js test/highlight/highlight-binding-store.test.js test/background/report-launch.test.js test/background/export-launch.test.js test/background/panel-port.test.js test/background/report-port.test.js test/background/owned-tabs.test.js test/background/pixel-capture-consent.test.js test/background/worker-protocol.test.js test/background/service-worker.test.js test/storage/audit-retention.test.js test/storage/audit-store.test.js test/panel/panel-ui.test.js test/review/review-ui.test.js test/e2e/retention-indexeddb-mv3.test.mjs`

Expected: PASS para prazo exato, overdue em startup, lease ativa, corrida manual/receipt/alarme, falha de cleaner, restart com tombstone e remoção final idempotente.

- [ ] **Step 8: Commit**

```bash
git add src/background/audit-deletion-coordinator.js src/background/blob-url-registry.js src/background/retention-scheduler.js src/background/target-capabilities.js src/background/highlight-controller.js src/background/highlight-binding-store.js src/background/report-launch.js src/background/export-launch.js src/background/panel-port.js src/background/report-port.js src/background/owned-tabs.js src/background/pixel-capture-consent.js src/background/worker-protocol.js src/background/service-worker.js src/panel/panel.js src/review/review.js src/storage/audit-retention.js src/storage/audit-store.js test/background/audit-deletion-coordinator.test.js test/background/blob-url-registry.test.js test/background/retention-scheduler.test.js test/background/target-capabilities.test.js test/highlight/highlight-controller.test.js test/highlight/highlight-binding-store.test.js test/background/report-launch.test.js test/background/export-launch.test.js test/background/panel-port.test.js test/background/report-port.test.js test/background/owned-tabs.test.js test/background/pixel-capture-consent.test.js test/background/worker-protocol.test.js test/background/service-worker.test.js test/panel/panel-ui.test.js test/review/review-ui.test.js test/storage/audit-retention.test.js test/storage/audit-store.test.js test/e2e/retention-indexeddb-mv3.test.mjs
git commit -m "feat: enforce absolute recoverable deletion"
```

---

### Task 6: Produzir quatro artefatos imutáveis e recibo não circular

**Files:**

- Create: `src/export/export-receipt.js`
- Modify: `src/export/report-export.js`
- Modify: `src/export/export-controller.js`
- Modify: `src/export/index.js`
- Modify: `src/background/export-launch.js`
- Modify: `src/background/worker-protocol.js`
- Modify: `src/background/service-worker.js`
- Modify: `src/browser/download-artifacts.js`
- Modify: `src/core/report/html.js`
- Modify: `src/core/report/csv.js`
- Modify: `src/core/report/earl-json.js`
- Modify: `src/browser/render-pdf.js`
- Modify: `src/storage/audit-store.js`
- Create: `test/export/export-receipt.test.js`
- Modify: `test/export/report-export.test.js`
- Modify: `test/export/export-controller.test.js`
- Modify: `test/export/export-page.test.js`
- Modify: `test/background/export-launch.test.js`
- Modify: `test/background/worker-protocol.test.js`
- Modify: `test/background/service-worker.test.js`
- Modify: `test/browser/download-artifacts.test.js`
- Modify: `test/browser/render-pdf.test.js`
- Modify: `test/report/html.test.js`
- Modify: `test/report/csv.test.js`
- Modify: `test/report/earl-json.test.js`
- Modify: `test/storage/audit-store.test.js`

**Interfaces:**

- Consumes the Marco 1 projection exactly as `buildReportView({model,summary,modelRevision,modelHash})`. `runReportExport` reloads one validated model revision, rebuilds `summary` and that frozen `ReportViewV1` once, and binds every renderer/artifact identity to those same `modelRevision` and `modelHash` values.

```text
export const EXPORT_FORMATS_V1 = Object.freeze(['html', 'pdf', 'csv', 'json']);

export function createExportDeliveryIdentityV1({
  auditId, modelRevision, modelHash, attemptId,
});
// -> Readonly<{version:'ExportDeliveryIdentityV1',auditId,modelRevision,modelHash,attemptId}>

export async function prepareExportArtifactV1({
  identity, format, mimeType, filename, bytes,
});
// -> Readonly<{version:'PreparedExportArtifactV1',identity,format,mimeType,filename,
//              byteLength,sha256,blob:Blob}>

export function failedExportArtifactV1({format,mimeType,filename,failureCode});

export function createExportReceiptV1({identity,artifactResults,createdAt});
// -> Readonly<{version:'ExportReceiptV1',identity,status:'complete'|'partial',createdAt,
// artifacts:readonly ExportReceiptArtifactV1[]}>

// ExportReceiptArtifactV1, sempre um por EXPORT_FORMATS_V1 e nessa ordem
// {format,mimeType,filename,generationStatus:'ready'|'failed',byteLength,sha256,
//  downloadId,downloadStatus:'complete'|'interrupted'|'unknown'|'not-started',failureCode}
```

- Para `generationStatus:'failed'`, `byteLength`, `sha256` e `downloadId` são `null`, `downloadStatus:'not-started'` e `failureCode` pertence ao catálogo fechado.
- Para `generationStatus:'ready'`, `byteLength` é inteiro positivo, `sha256` tem 64 hex, `failureCode:null`; `downloadId`/status refletem a Downloads API.
- MIME fechado: HTML `text/html;charset=utf-8`, PDF `application/pdf`, CSV `text/csv;charset=utf-8`, JSON técnico `application/ld+json;charset=utf-8`; extensões `.html`, `.pdf`, `.csv`, `.json`.
- `store.persistExportReceiptV1({auditId,expectedRevision,attemptId,receipt})` grava sob a chave privada de delivery na mesma transação que valida modelo/revisão/lease.
- Consome e termina o contrato do Marco 1 sem emitir uma segunda capability:

```text
ExportSessionCapabilityV1 = {
  version:1,sessionCapabilityId,auditId,launchTabId,launchDocumentId,
  expectedRevision,attemptId,intents:['execute-export','complete-export'],
  state:'active'|'terminal'|'revoked',issuedAt,expiresAt
}

exportLaunch.authorizeAndTerminateCompletion({
  sessionCapabilityId,auditId,expectedRevision,attemptId,sender,
});
// CAS do mesmo ExportLaunchV1 connected + capability active para ambos terminal;
// -> {ok:true,binding:{auditId,expectedRevision,attemptId,launchTabId,launchDocumentId}}
//  | {ok:false,code}
```

O método exige extension ID, sender `TAB`, `sender.tab.id === launchTabId`, `sender.documentId === launchDocumentId`, mesma window, URL canônica exata `/src/export/index.html?auditId=<auditId>`, intenção `complete-export`, prazo futuro e igualdade exata de auditoria/revisão/tentativa. Ele serializa por `auditId/attemptId`, relê launch `connected` + capability `active` dentro da queue e grava ambos `terminal` numa única `storage.session.set` antes de responder; se qualquer campo/CAS divergir, não grava nenhum terminal novo nem relê receipt. Reload, navegação, sender diferente, duplicata ou capability revogada falham fechado.

- [ ] **Step 1: Escrever testes RED dos quatro formatos, blobs e falhas**

```js
test('receipt has exactly four formats and hashes immutable Blob bytes', async () => {
  const identity = createExportDeliveryIdentityV1({
    auditId: 'audit-1', modelRevision: 4, modelHash: 'a'.repeat(64), attemptId: 2,
  });
  const input = new Uint8Array([65, 66, 67]);
  const html = await prepareExportArtifactV1({
    identity, format: 'html', mimeType: 'text/html;charset=utf-8',
    filename: 'audita-audit-1-20260829T120000123Z.html', bytes: input,
  });
  input[0] = 90;
  assert.deepEqual(Array.from(new Uint8Array(await html.blob.arrayBuffer())), [65, 66, 67]);
  const receipt = createExportReceiptV1({
    identity,
    artifactResults: completeFourArtifactResults(identity, html),
    createdAt: '2026-08-29T12:00:00.123Z',
  });
  assert.deepEqual(receipt.artifacts.map(item => item.format), ['html', 'pdf', 'csv', 'json']);
  assert.equal(receipt.status, 'complete');
  assert.equal(Object.hasOwn(receipt, 'receiptHash'), false);
});

test('missing or interrupted artifact produces partial receipt without deletion authority', () => {
  const receipt = createExportReceiptV1(partialReceiptFixture('pdf', 'interrupted'));
  assert.equal(receipt.status, 'partial');
  assert.equal(receipt.artifacts.length, 4);
  assert.equal(receipt.artifacts.find(item => item.format === 'pdf').downloadStatus, 'interrupted');
});

test('EXPORT_COMPLETE has one exact envelope and consumes its bound export session once', async () => {
  const completion = {
    sessionCapabilityId: 'export-session-1', auditId: 'audit-1',
    expectedRevision: 4, attemptId: 2,
  };
  const message = { type: 'EXPORT_COMPLETE', ...completion };
  assert.deepEqual(parseWorkerMessage(message), message);
  assert.equal(parseWorkerMessage({ ...message, receipt: {} }), null);
  assert.equal((await exportLaunch.authorizeAndTerminateCompletion({
    ...completion, sender: validExportSender,
  })).ok, true);
  assert.equal((await exportLaunch.authorizeAndTerminateCompletion({
    ...completion, sender: validExportSender,
  })).ok, false);
  assert.equal((await exportLaunch.authorizeAndTerminateCompletion({
    ...completion, sessionCapabilityId: 'export-session-other', sender: validExportSender,
  })).ok, false);
});
```

`completeFourArtifactResults`, `partialReceiptFixture`, `exportLaunch` e `validExportSender` são helpers privados completos nos respectivos testes: criam os quatro formatos em ordem, IDs de download distintos, launch/capability vinculados ao mesmo tab/document/revisão/tentativa e as closed shapes acima.

- [ ] **Step 2: Executar testes e confirmar RED**

Run: `node --test test/export/export-receipt.test.js test/export/report-export.test.js test/export/export-controller.test.js test/background/export-launch.test.js test/background/worker-protocol.test.js test/browser/download-artifacts.test.js test/browser/render-pdf.test.js`

Expected: FAIL por módulo inexistente, receipt legado variável e bytes mutáveis/regerados.

- [ ] **Step 3: Congelar identidade e bytes antes do primeiro download**

`prepareExportArtifactV1` valida identidade/formato/MIME/nome, copia `bytes` uma vez com `Uint8Array.from`, cria `Blob` imutável dessa cópia, calcula SHA-256 sobre `blob.arrayBuffer()` e congela o record. `download-artifacts.js` recebe somente prepared artifacts, cria Blob URL do `artifact.blob`, registra `{auditId,blobUrl,ownerDocumentId}` no `BlobUrlRegistryV1`, chama `chrome.downloads.download`, espera `onChanged/search`, executa `URL.revokeObjectURL` e confirma `release`. Não renderizar/encodar novamente depois do hash.

Calcular `modelHash` da revisão validada, obter `modelRevision/attemptId` do lease, construir uma única `ReportViewV1` por `buildReportView({model,summary,modelRevision,modelHash})` e criar uma única `ExportDeliveryIdentityV1` antes dos renderers. HTML/PDF consomem essa mesma projeção; CSV/JSON técnico recebem a mesma projeção mais o modelo imutável que ela referencia e rejeitam divergência de revisão/hash antes de produzir bytes.

- [ ] **Step 4: Incorporar a mesma identidade nos bytes de cada formato**

- HTML: bloco visível `Integridade da entrega` e `<script type="application/json" id="audita-delivery-identity">` com JSON canônico escapado.
- CSV: colunas fixas `deliveryIdentityVersion`, `deliveryAuditId`, `deliveryModelRevision`, `deliveryModelHash`, `deliveryAttemptId` em todas as linhas.
- JSON: envelope `{deliveryIdentity,audit}` sem modificar a serialização canônica do objeto `audit`.
- PDF: imprimir o HTML já identificado e, depois dos bytes `%PDF`, chamar `appendPdfDeliveryIdentityV1(pdfBytes, identity)`, que anexa após EOF o comentário ASCII `\n% AUDITA-DELIVERY-IDENTITY <base64url(JSON canônico)>\n`. O helper valida `%PDF-` e não altera páginas.

Testes decodificam HTML/CSV/JSON e o comentário PDF, reconstruindo identidade idêntica nos quatro bytes.

- [ ] **Step 5: Observar Downloads API e construir sempre quatro entries**

Cada formato gera um `ExportReceiptArtifactV1`, inclusive falha de geração. `downloads.onChanged`/`search` mapeia somente `complete`, `interrupted` ou `unknown`; timeout é `unknown`. Não abrir/reler o destino escolhido pela pessoa. IDs de download precisam ser inteiros positivos e únicos entre entries ready.

`createExportReceiptV1` copia cada entry, ordena por `EXPORT_FORMATS_V1`, congela entries/array/identity/receipt e rejeita getter, prototype não simples, formato ausente/duplicado e propriedade extra. Persistir o receipt antes de qualquer exclusão. `status:'complete'` exige exatamente os quatro formatos, todos `ready`, hashes válidos e downloads `complete`; qualquer outra condição é `partial`.

- [ ] **Step 6: Encaminhar pós-exportação ao coordenador único**

`finalizeExportAndMaybeDelete` deixa de apagar o store. Depois de `persistExportReceiptV1`, a página de exportação envia exatamente `{type:'EXPORT_COMPLETE',sessionCapabilityId,auditId,expectedRevision,attemptId}`; não envia receipt nem decisão de exclusão. `worker-protocol.js` exige essas cinco chaves exatas e tipos/limites canônicos. O handler chama primeiro `exportLaunch.authorizeAndTerminateCompletion(...)`; somente o primeiro CAS válido da mesma capability/tab/document/auditoria/revisão/tentativa pode continuar. Depois do CAS terminal, o worker relê o receipt persistido, exige identidade idêntica e chama `deletionCoordinator.request({auditId,reason:'post-export',expectedRevision,terminalReceipt:receipt,manualAuthorization:null})` somente quando a preferência foi marcada e `receipt.status === 'complete'`. Divergência, reload, duplicata, missing, interrupted ou unknown preserva auditoria/journal e mostra status do formato; nenhum desses casos reabre a capability ou repete downloads.

- [ ] **Step 7: Executar testes focados e confirmar PASS**

Run: `node --test test/export/export-receipt.test.js test/export/report-export.test.js test/export/export-controller.test.js test/export/export-page.test.js test/background/export-launch.test.js test/background/worker-protocol.test.js test/background/service-worker.test.js test/browser/download-artifacts.test.js test/browser/render-pdf.test.js test/report/html.test.js test/report/csv.test.js test/report/earl-json.test.js test/storage/audit-store.test.js`

Expected: PASS para quatro identidades byte-level, cópia defensiva, hashes pré-download, quatro entries exatas, receipt persistido, falha parcial e ausência de exclusão direta.

- [ ] **Step 8: Commit**

```bash
git add src/export/export-receipt.js src/export/report-export.js src/export/export-controller.js src/export/index.js src/background/export-launch.js src/background/worker-protocol.js src/background/service-worker.js src/browser/download-artifacts.js src/core/report/html.js src/core/report/csv.js src/core/report/earl-json.js src/browser/render-pdf.js src/storage/audit-store.js test/export/export-receipt.test.js test/export/report-export.test.js test/export/export-controller.test.js test/export/export-page.test.js test/background/export-launch.test.js test/background/worker-protocol.test.js test/background/service-worker.test.js test/browser/download-artifacts.test.js test/browser/render-pdf.test.js test/report/html.test.js test/report/csv.test.js test/report/earl-json.test.js test/storage/audit-store.test.js
git commit -m "feat: attest four immutable report deliveries"
```

---

### Task 7: Provar privacidade, lote, retenção e entrega no Chrome real

**Files:**

- Modify: `src/panel/index.html`
- Modify: `src/panel/panel.js`
- Modify: `src/panel/panel.css`
- Modify: `src/core/report/html.js`
- Modify: `src/core/report/report.css.js`
- Modify: `test/e2e/support/real-chrome.mjs`
- Create: `test/e2e/privacy-batch-retention-mv3.test.mjs`
- Create: `test/e2e/fixtures/privacy-sensitive.html`
- Modify: `test/e2e/retention-indexeddb-mv3.test.mjs`
- Modify: `test/panel/panel-ui.test.js`
- Modify: `test/report/html.test.js`
- Create: `docs/qa/2026-08-29-marco-3-privacidade-lote-retencao-review-a.md`
- Create: `docs/qa/2026-08-29-marco-3-privacidade-lote-retencao-review-b.md`

**Interfaces:**

- Consumes do Marco 1: `startFixtureServer`, `launchUnpackedExtension`, `click`, `evaluate`, `waitForValue`, `pressKey`, `captureScreenshot`. Antes deste marco, `click` já usa `Runtime.evaluate({userGesture:true})` ou `Input.dispatchMouseEvent`, e `openActionPopup`/`waitForSidePanel`/`waitForReport` comprovam contextos reais com `chrome.runtime.getContexts()`. O contrato canônico permanece `app.waitForFourDownloads({auditId})`: ele rejeita argumento ausente/extra e devolve quatro records fechados com exatamente `{format,mime,filename,downloadId,state:'complete',byteLength,sha256}` na ordem `html,pdf,csv,json`, depois de correlacionar o receipt e hashear os bytes reais do perfil isolado. Caminho local não faz parte do record; o teste resolve `join(app.downloadDirectory,filename)`.
- Adiciona ao mesmo suporte, sem outro transporte CDP:

```text
export async function assertExtensionContext(worker, {contextType, documentUrlSuffix});
// consulta chrome.runtime.getContexts; contextType é 'POPUP'|'SIDE_PANEL'
export async function terminateServiceWorker(app);
export async function waitForServiceWorkerRestart(app);
export async function cancelNextDownload(app);
export async function waitForDownloadedFiles(downloadDirectory, filenames, timeoutMs);
export async function navigateTarget(target,url);
// usa Page.navigate, aguarda novo documentId e nunca depende de Runtime.evaluate durante unload
export async function readStoredExportReceipt(extensionTarget, auditId);
export async function waitForStoredExportReceipt(extensionTarget,auditId,predicate,timeoutMs);
export async function readExtensionStorageSnapshot(extensionTarget);
// -> {session:Record<string,unknown>,indexedDb:Record<string,unknown>}
export async function readStoredAuditState(extensionTarget, auditId);
// -> {model,retention,tombstones,checkpoints,ownedDisposableTabs}; somente APIs públicas read-only do store
export async function waitForStoredAuditState(extensionTarget,auditId,predicate,timeoutMs);
export async function waitForOwnedCurrentStateAssist(app,{auditId,timeoutMs});
// -> {target,ownershipId}; prova OwnedDisposableTabV2 purpose current-state-assist
export async function waitForTargetClosed(app,target,timeoutMs);
export function observeHttpTargetConcurrency(app);
// -> {stop() -> Promise<{maxActive,remainingUrls}>}
export async function sha256File(path);
```

- `launchUnpackedExtension` devolve também `downloadDirectory` e `chromeProduct`; o teste exige major `>=116`.

- [ ] **Step 1: Escrever E2E RED do fluxo completo e dos três modos**

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  assertExtensionContext, cancelNextDownload, click, evaluate, launchUnpackedExtension,
  observeHttpTargetConcurrency,
  sha256File, startFixtureServer,
  navigateTarget, readExtensionStorageSnapshot, readStoredAuditState,
  terminateServiceWorker, waitForDownloadedFiles,
  waitForOwnedCurrentStateAssist, waitForServiceWorkerRestart,
  waitForStoredAuditState, waitForStoredExportReceipt, waitForTargetClosed, waitForValue,
} from './support/real-chrome.mjs';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const sensitiveHtml = await readFile(new URL('./fixtures/privacy-sensitive.html', import.meta.url), 'utf8');
const DOWNLOAD_RECORD_KEYS = Object.freeze([
  'format', 'mime', 'filename', 'downloadId', 'state', 'byteLength', 'sha256',
].sort());

function privacyRoutes() {
  return new Map([
    ['/privacy-sensitive.html', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: sensitiveHtml }],
    ['/ok-1.html', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<!doctype html><html lang="pt-BR"><title>Um</title><body><img src="data:," alt=""></body></html>' }],
    ['/ok-2.html', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<!doctype html><html lang="pt-BR"><title>Dois</title><body><a href="/">clique aqui</a></body></html>' }],
    ['/slow.html', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<!doctype html><html lang="pt-BR"><title>Lenta</title><body><button>Fim</button></body></html>', delayMs: 30_000 }],
  ]);
}

test('real popup, side panel, privacy pause and four verified downloads', { timeout: 300_000 }, async t => {
  const fixtures = await startFixtureServer(t, privacyRoutes());
  const app = await launchUnpackedExtension(t, {
    extensionPath: workspaceRoot,
    startUrl: `${fixtures.origin}/privacy-sensitive.html`,
    viewport: { width: 1280, height: 900 },
  });
  assert.equal(Number(app.chromeProduct.match(/Chrome\/(\d+)/u)[1]) >= 116, true);
  const popup = await app.openActionPopup();
  await assertExtensionContext(app.worker, { contextType: 'POPUP', documentUrlSuffix: '/src/popup/index.html' });
  await click(popup, '[data-action="audit-current-page"]');
  const panel = await app.waitForSidePanel();
  await assertExtensionContext(app.worker, { contextType: 'SIDE_PANEL', documentUrlSuffix: '/src/panel/index.html' });
  await waitForValue(panel, 'document.body.dataset.screen', value => value === 'privacy-paused');
  assert.doesNotMatch(await evaluate(panel, 'document.body.innerText'), /SEGREDO-NAO-LOGAR/u);
  await terminateServiceWorker(app);
  await waitForServiceWorkerRestart(app);
  await click(panel, '[data-action="confirm-pixels"]');
  await waitForValue(panel, 'document.body.dataset.screen', value => value === 'result');
  const auditId = await evaluate(panel, 'document.body.dataset.auditId');
  await click(panel, '[data-action="open-report"]');
  const report = await app.waitForReport({auditId});
  await click(report, '[data-action="export-all"]');
  const downloads = await app.waitForFourDownloads({auditId});
  assert.deepEqual(downloads.map(item => item.format), ['html', 'pdf', 'csv', 'json']);
  for (const item of downloads) {
    assert.deepEqual(Object.keys(item).sort(), DOWNLOAD_RECORD_KEYS);
  }
  const receipt = await waitForStoredExportReceipt(app.worker, auditId,
    value => value?.status === 'complete', 60_000);
  assert.deepEqual(receipt.artifacts.map(item => item.format), ['html', 'pdf', 'csv', 'json']);
  assert.equal(receipt.artifacts.every(item => item.downloadStatus === 'complete'), true);
  const files = await waitForDownloadedFiles(app.downloadDirectory,
    downloads.map(item => item.filename), 60_000);
  for (const item of receipt.artifacts) {
    assert.equal(await sha256File(files.get(item.filename)), item.sha256);
  }
});
```

Para a falha real de navegação do lote, usar `http://127.0.0.1:1/unreachable`. O servidor de fixtures mantém `Map` e passa a aceitar a propriedade opcional fechada `delayMs` (inteiro de 0 a 30.000) para testar cancelamento; sem ela, preserva o contrato do Marco 1.

- [ ] **Step 2: Adicionar subtestes reais obrigatórios**

No mesmo arquivo, criar casos independentes, cada um por UI e Chrome real:

1. `full-evidence`: pausa, reinício do worker, confirmação, replay rejeitado e quatro artefatos com identidade/hash.
2. `element-only`: pausa/aceite, recortes presentes, captura integral/mapa ausentes e limitação exata.
3. `no-pixels`: nenhuma pausa, zero PNG/data URL e limitação exata.
4. documento navegado durante a pausa: confirmação retorna `PIXEL_CONSENT_DOCUMENT_CHANGED` e zero download/captura.
5. lote `ok → falha de navegação → ok`: três page IDs, attempted `true`, concorrência de aba descartável máxima 1 e terceira página concluída.
6. cancelamento durante segunda página: aba ativa removida, restantes `not-started`, fila/tokens apagados.
7. expiração com lease ativa: modelo indisponível no instante, tombstone persiste após restart e é concluído após cleaners.
8. receipt parcial: `cancelNextDownload` usa `Browser.downloadWillBegin` + `Browser.cancelDownload`; quatro entries permanecem, uma `interrupted`, sem pós-exclusão.
9. storage scan: fora das chaves `audita:raw-navigation:*`, nenhum storage/IndexedDB/UI contém query secreta, token ou `SEGREDO-NAO-LOGAR`; após conclusão/cancelamento nem as chaves voláteis permanecem.
10. lote sensível: pausa na entry ativa, worker reinicia, confirmação retoma a mesma `ownershipId`, cleanup é confirmado antes da próxima entry; expiração/cancelamento deixa no máximo um journal próprio e nunca remove aba anexada/estrangeira.
11. pós-exportação completa: marcar “não reter”, observar quatro downloads completos, comprovar modelo indisponível, tombstone concluído e arquivos ainda presentes no diretório de downloads.
12. auxílio de estado atual: informar URL nova, abrir aba própria, provar overlay em correspondência única, manter hash/modelo histórico idênticos, fechar somente essa aba no clear e falhar sem overlay quando não houver correspondência; ambiguidade permanece coberta no Chrome adapter/coordinator real da Task 4.

Usar estes helpers/casos concretos, no mesmo arquivo:

```js
async function openModeScenario(t, mode) {
  const fixtures = await startFixtureServer(t, privacyRoutes());
  const app = await launchUnpackedExtension(t, {
    extensionPath: workspaceRoot, startUrl: `${fixtures.origin}/privacy-sensitive.html`,
    viewport: { width: 1280, height: 900 },
  });
  const popup = await app.openActionPopup();
  await click(popup, `[name="capture-mode"][value="${mode}"]`);
  await click(popup, '[data-action="audit-current-page"]');
  return { fixtures, app, panel: await app.waitForSidePanel() };
}

test('element-only and no-pixels expose exact evidence boundaries', async t => {
  for (const mode of ['element-only', 'no-pixels']) {
    const { app, panel } = await openModeScenario(t, mode);
    if (mode === 'element-only') {
      await waitForValue(panel, 'document.body.dataset.screen', value => value === 'privacy-paused');
      await click(panel, '[data-action="confirm-pixels"]');
    }
    await waitForValue(panel, 'document.body.dataset.screen', value => value === 'result');
    const auditId = await evaluate(panel, 'document.body.dataset.auditId');
    const { model } = await readStoredAuditState(app.worker, auditId);
    const kinds = model.evidence.map(item => item.kind);
    assert.equal(kinds.includes('full-page'), false);
    assert.equal(kinds.includes('announcement-map'), false);
    if (mode === 'element-only') assert.equal(kinds.includes('element'), true);
    else assert.equal(model.evidence.some(item => Object.hasOwn(item, 'dataUrl')), false);
  }
});

test('navigation during pause invalidates the one-shot consent', async t => {
  const { app, fixtures, panel } = await openModeScenario(t, 'full-evidence');
  await waitForValue(panel, 'document.body.dataset.screen', value => value === 'privacy-paused');
  await navigateTarget(app.startPage, `${fixtures.origin}/ok-1.html`);
  await click(panel, '[data-action="confirm-pixels"]');
  await waitForValue(panel, 'document.body.dataset.errorCode', value => value === 'PIXEL_CONSENT_DOCUMENT_CHANGED');
  const auditId = await evaluate(panel, 'document.body.dataset.auditId');
  assert.equal((await readStoredAuditState(app.worker, auditId)).model, undefined);
});

test('batch is sequential, survives middle navigation failure and cancels pending entries', async t => {
  const { app, fixtures, panel } = await openModeScenario(t, 'no-pixels');
  await waitForValue(panel, 'document.body.dataset.screen', value => value === 'result');
  const probe = observeHttpTargetConcurrency(app);
  await evaluate(panel, `document.querySelector('[name="batch-urls"]').value=${JSON.stringify([
    `${fixtures.origin}/ok-1.html`, 'http://127.0.0.1:1/unreachable', `${fixtures.origin}/ok-2.html`,
  ].join('\n'))}`);
  await click(panel, '[data-action="start-batch"]');
  await waitForValue(panel, 'document.body.dataset.screen', value => value === 'result');
  const firstBatchId = await evaluate(panel, 'document.body.dataset.auditId');
  const firstBatch = (await readStoredAuditState(app.worker, firstBatchId)).model;
  assert.deepEqual(firstBatch.pages.map(page => page.status), ['complete', 'failed', 'complete']);
  assert.equal((await probe.stop()).maxActive, 1);

  await evaluate(panel, `document.querySelector('[name="batch-urls"]').value=${JSON.stringify([
    `${fixtures.origin}/ok-1.html`, `${fixtures.origin}/slow.html`, `${fixtures.origin}/ok-2.html`,
  ].join('\n'))}`);
  await click(panel, '[data-action="start-batch"]');
  await waitForValue(panel, 'document.body.dataset.pageNumber', value => value === '2');
  await click(panel, '[data-action="cancel-audit"]');
  await waitForValue(panel, 'document.body.dataset.screen', value => value === 'result');
  assert.equal(await evaluate(panel, 'document.body.dataset.sessionStatus'), 'cancelled');
  const cancelledId = await evaluate(panel, 'document.body.dataset.auditId');
  const cancelled = await readStoredAuditState(app.worker, cancelledId);
  assert.deepEqual(cancelled.model.pages.map(page => page.status), ['complete', 'cancelled', 'not-started']);
  const snapshot = await readExtensionStorageSnapshot(app.worker);
  const volatileForAudit = Object.entries(snapshot.session).filter(([key, value]) =>
    key.startsWith('audita:raw-navigation:') && JSON.stringify(value).includes(cancelledId));
  assert.deepEqual(volatileForAudit, []);
});

test('current-state assist is visibly separate and never mutates historical evidence', async t => {
  const fixtures = await startFixtureServer(t, privacyRoutes());
  const app = await launchUnpackedExtension(t, {
    extensionPath: workspaceRoot, startUrl: `${fixtures.origin}/ok-2.html`,
    viewport: {width:1280,height:900},
  });
  const popup = await app.openActionPopup();
  await click(popup, '[name="capture-mode"][value="no-pixels"]');
  await click(popup, '[data-action="audit-current-page"]');
  const panel = await app.waitForSidePanel();
  await waitForValue(panel, 'document.body.dataset.screen', value => value === 'result');
  const auditId = await evaluate(panel, 'document.body.dataset.auditId');
  const before = await readStoredAuditState(app.worker, auditId);
  await click(panel, '[data-action="open-report"]');
  const report = await app.waitForReport({auditId});
  await evaluate(report,
    `document.querySelector('[name="current-state-url"]').value=${JSON.stringify(`${fixtures.origin}/ok-2.html`)}`);
  await click(report, '[data-occurrence-id] [data-action="current-state-assist"]');
  await waitForValue(report, 'document.body.dataset.currentStateAssist', value => value === 'active');
  const assist = await waitForOwnedCurrentStateAssist(app, {auditId,timeoutMs:30_000});
  await waitForValue(assist.target,
    'document.querySelector("[data-audita-current-state-assist-overlay]") !== null', value => value === true);
  const afterOpen = await readStoredAuditState(app.worker, auditId);
  assert.equal(afterOpen.model.integrity.canonicalModelHash,
    before.model.integrity.canonicalModelHash);
  await click(report, '[data-action="clear-highlight"]');
  await waitForTargetClosed(app, assist.target, 30_000);

  await evaluate(report,
    `document.querySelector('[name="current-state-url"]').value=${JSON.stringify(`${fixtures.origin}/ok-1.html`)}`);
  await click(report, '[data-occurrence-id] [data-action="current-state-assist"]');
  await waitForValue(report, 'document.body.dataset.errorCode',
    value => value === 'CURRENT_STATE_TARGET_NOT_FOUND');
  await waitForStoredAuditState(app.worker, auditId, value =>
    value?.ownedDisposableTabs?.every(owner => owner.purpose !== 'current-state-assist'), 30_000);
  const afterFailure = await readStoredAuditState(app.worker, auditId);
  assert.equal(afterFailure.model.integrity.canonicalModelHash,
    before.model.integrity.canonicalModelHash);
});

test('interrupted real download keeps a four-entry partial receipt and local model', async t => {
  const { app, panel } = await openModeScenario(t, 'no-pixels');
  await waitForValue(panel, 'document.body.dataset.screen', value => value === 'result');
  await cancelNextDownload(app);
  const auditId = await evaluate(panel, 'document.body.dataset.auditId');
  await click(panel, '[data-action="open-report"]');
  const report = await app.waitForReport({auditId});
  await click(report, '[data-action="export-all"]');
  const receipt = await waitForStoredExportReceipt(app.worker, auditId,
    value => value?.status === 'partial' &&
      value.artifacts?.some(item => item.downloadStatus === 'interrupted'), 60_000);
  assert.equal(receipt.status, 'partial');
  assert.equal(receipt.artifacts.length, 4);
  assert.equal(receipt.artifacts.some(item => item.downloadStatus === 'interrupted'), true);
  assert.notEqual((await readStoredAuditState(app.worker, auditId)).model, undefined);
});

test('complete four-file delivery honors no-retention without deleting downloads', async t => {
  const fixtures = await startFixtureServer(t, privacyRoutes());
  const app = await launchUnpackedExtension(t, {
    extensionPath: workspaceRoot, startUrl: `${fixtures.origin}/ok-1.html`,
    viewport: {width:1280,height:900},
  });
  const popup = await app.openActionPopup();
  await click(popup, '[data-action="open-url-or-batch"]');
  const panel = await app.waitForSidePanel();
  await click(panel, 'input[name="delete-after-export"]');
  await click(panel, '[name="capture-mode"][value="no-pixels"]');
  await click(panel, '[data-action="audit-current-page"]');
  await waitForValue(panel, 'document.body.dataset.screen', value => value === 'result');
  const auditId = await evaluate(panel, 'document.body.dataset.auditId');
  await click(panel, '[data-action="open-report"]');
  const report = await app.waitForReport({auditId});
  await click(report, '[data-action="export-all"]');
  const downloads = await app.waitForFourDownloads({auditId});
  assert.equal(downloads.length, 4);
  assert.deepEqual(downloads.map(item => item.format), ['html','pdf','csv','json']);
  assert.deepEqual(downloads.map(item => item.state), ['complete','complete','complete','complete']);
  const preserved = await Promise.all(downloads.map(async item => ({
    absolutePath: join(app.downloadDirectory,item.filename),
    sha256: await sha256File(join(app.downloadDirectory,item.filename)),
    byteLength: (await readFile(join(app.downloadDirectory,item.filename))).byteLength,
  })));
  await waitForStoredAuditState(app.worker, auditId,
    value => value?.model === undefined && value?.tombstones?.length === 0, 30_000);
  const state = await readStoredAuditState(app.worker, auditId);
  assert.equal(state.model, undefined);
  assert.deepEqual(state.tombstones, []);
  for (const item of preserved) {
    assert.equal((await readFile(item.absolutePath)).byteLength, item.byteLength);
    assert.equal(await sha256File(item.absolutePath), item.sha256);
  }
});
```

`waitForStoredAuditState(app.worker,auditId,predicate,timeoutMs)` e `waitForStoredExportReceipt(app.worker,auditId,predicate,timeoutMs)` são polling read-only sobre as respectivas APIs públicas, com relógio monotônico, intervalo máximo de 50 ms e timeout explícito; os testes aguardam estado terminal antes de reler, nunca usam global de produção nem assumem que o clique já persistiu o receipt. O caso de retenção permanece em `retention-indexeddb-mv3.test.mjs`: seed por API pública do store, alarme real, lease ativa, `getAudit(auditId) === undefined` imediatamente após staging, tombstone após restart e tombstone ausente após todos os cleaners. O replay e extra-field de `CONFIRM_PIXEL_CAPTURE` ficam nos testes reais do worker da Task 3, pois a UI remove o comando assim que o consome. O caso full-evidence lê os quatro arquivos, reconstrói `ExportDeliveryIdentityV1` idêntica em cada um e confirma que URL/HMAC não vazam fora das projeções permitidas.

- [ ] **Step 3: Implementar suporte E2E sem hooks no produto**

`assertExtensionContext` executa no worker:

```js
await chrome.runtime.getContexts({ contextTypes: [contextType] });
```

e exige um único resultado do mesmo extension ID cujo `documentUrl` termina no suffix. `terminateServiceWorker` usa `Target.closeTarget` somente no target do worker da extensão lançada; `waitForServiceWorkerRestart` espera target novo e atualiza `app.worker`. `cancelNextDownload` opera no Browser domain do processo isolado. `readStoredExportReceipt` importa `src/storage/audit-store.js` numa página interna aberta pelo suporte, chama API pública read-only e devolve `structuredClone`; `waitForStoredExportReceipt` repete essa leitura até o predicado terminal ou timeout, sem observar estado privado. `waitForOwnedCurrentStateAssist` lê `OwnedDisposableTabV2` pela mesma superfície read-only, exige audit/purpose/ownership/tab exatos e só então associa o target CDP; `waitForTargetClosed` aguarda `Target.targetDestroyed` do target exato. Nenhum helper injeta global no build. Downloads usam diretório temporário exclusivo e são lidos como bytes depois do evento terminal.

`startFixtureServer` valida exatamente `status`, `headers`, `body` e `delayMs` opcional; para `delayMs`, aguarda com timer cancelado em `request.close`/`t.after` antes de `response.end(body)`. `observeHttpTargetConcurrency` conta somente targets HTTP(S) criados depois do início do probe e remove cada target em `Target.targetDestroyed`; `stop` devolve máximo e URLs ainda ativas sem fechar target do usuário.

- [ ] **Step 4: Ajustar UI/relatório para estados verificáveis**

Mostrar modo, rótulos de categoria, `EvidenceUrlV1.href`, expiração absoluta, exclusão pendente e status de cada formato. Não mostrar query bruta, capability, stack, `tabId`, `documentId`, `backendNodeId`, consent ID ou segredo. Aviso permanente: `A avaliação automática reduz trabalho manual, mas não certifica conformidade jurídica.`

No relatório, limitações de captura aparecem em Metodologia e Evidências ausentes; não contam como resultado positivo. O receipt não é confundido com integridade normativa do `AuditModel V2`.

- [ ] **Step 5: Executar testes de interface e E2E**

Run: `node --test test/panel/panel-ui.test.js test/report/html.test.js test/e2e/privacy-batch-retention-mv3.test.mjs test/e2e/retention-indexeddb-mv3.test.mjs`

Expected: PASS no Chrome real 116+, incluindo contextos `POPUP`/`SIDE_PANEL`, gesto real, três modos, restart, lote, cancelamento, alarme e bytes baixados.

- [ ] **Step 6: Commitar o candidato de implementação antes dos gates/reviews**

```bash
git add src/panel/index.html src/panel/panel.js src/panel/panel.css src/core/report/html.js src/core/report/report.css.js test/e2e/support/real-chrome.mjs test/e2e/privacy-batch-retention-mv3.test.mjs test/e2e/fixtures/privacy-sensitive.html test/e2e/retention-indexeddb-mv3.test.mjs test/panel/panel-ui.test.js test/report/html.test.js
git commit -m "test: prove privacy retention and delivery in Chrome"
```

Registrar `git rev-parse HEAD` como `candidateCommit`. Os arquivos de review ainda não entram neste commit; ambos os reviewers e todos os gates usam exatamente esse SHA limpo.

- [ ] **Step 7: Executar o gate completo no candidato commitado**

Run: `npm test`

Expected: PASS em toda a suíte.

Run: `npm run verify`

Expected: PASS para modelo, CSP, licenças, neutralidade e ativos; nenhum ZIP é criado.

- [ ] **Step 8: Registrar duas revisões independentes de risco crítico**

Review A registra reviewer, commit SHA, Chrome product, comandos e achados de URLs/HMAC/storage.session/sonda/consentimento/protocolo/pixels em `docs/qa/2026-08-29-marco-3-privacidade-lote-retencao-review-a.md`. Review B registra os mesmos campos e cobre transações/tombstones/expiração/leases/bytes/hashes/downloads/receipt/exclusão em `review-b.md`. Reviewers diferentes revisam o mesmo commit; aprovação exige `Critical: 0` e `Important: 0`. Cada achado confirmado recebe teste RED focado antes da correção.

- [ ] **Step 9: Se houver achado, corrigir em novo candidato e repetir gates/reviews**

Para cada achado confirmado, escrever primeiro o teste RED focado, aplicar a correção mínima, executar o teste focado e então criar um novo commit de implementação (sem os arquivos de review). Atualizar `candidateCommit`, executar novamente os comandos abaixo e invalidar/recriar Review A e Review B sobre o novo SHA. Repetir até ambos registrarem `Critical: 0` e `Important: 0` para o mesmo candidato.

Run: `node --test test/privacy test/background/raw-navigation-vault.test.js test/background/pixel-capture-consent.test.js test/background/pixel-consent-expiry.test.js test/background/audit-deletion-coordinator.test.js test/background/retention-scheduler.test.js test/background/export-launch.test.js test/export test/storage/audit-store.test.js test/e2e/privacy-batch-retention-mv3.test.mjs`

Expected: PASS.

Run: `npm test`

Expected: PASS em toda a suíte depois da última mudança material.

Run: `npm run verify`

Expected: PASS depois da última mudança material; revisões registram zero Critical/Important aberto.

- [ ] **Step 10: Commitar somente os registros das revisões aprovadas**

```bash
git add docs/qa/2026-08-29-marco-3-privacidade-lote-retencao-review-a.md docs/qa/2026-08-29-marco-3-privacidade-lote-retencao-review-b.md
git commit -m "docs: record marco 3 critical reviews"
```

## Self-review

- Spec coverage: Tasks 1–2 cobrem minimização de URL, HMAC e cofre efêmero; Task 3 cobre os três modos, pausa one-shot e retomada; Task 4 cobre ownership do runner, URL única e lote; Task 5 cobre exclusão única e retenção absoluta; Task 6 cobre quatro formatos/receipt; Task 7 prova o percurso real.
- Privacy boundary: URL bruta, chave HMAC, tokens, fila, consentimento e suspensão existem somente em `chrome.storage.session`; o digest sempre usa `hmac-sha256:<base64url>` do Marco 1.
- Pixel boundary: documento é provado antes e depois da pausa; consentimento é vinculado a audit/tab/document/mode, consumido uma vez, sobrevive à suspensão do worker e é inválido após navegação, replay ou fim da sessão do navegador.
- Ownership boundary: somente `runObservedTabAudit` cria, navega e remove abas; single usa `pre-observation-failure`, lote usa `always`.
- Retention boundary: a transação de tombstone remove o modelo no prazo mesmo com lease ativa; falha transitória deixa tombstone retomável sem restaurar dados.
- Delivery boundary: os quatro formatos existem no receipt mesmo em falha; blobs são cópias imutáveis, identidade precede hash/download e pós-exclusão usa somente receipt complete persistido.
- Chrome boundary: nenhum código usa `storage.session.getKeys()`; E2E exige Chrome 116+, gesto real e contextos `POPUP`/`SIDE_PANEL` via `runtime.getContexts()`.
- Copy boundary: categorias, limitações, avisos de lote e UTC compacto têm catálogos exatos e testes.
- Placeholder scan: o plano não delega helpers/interfaces sem caminho; helpers privados citados são implementados no mesmo passo ou definidos integralmente no teste correspondente.
