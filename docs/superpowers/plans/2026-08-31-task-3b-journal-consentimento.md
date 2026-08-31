# Task 3B — journal único de consentimento e liquidação recuperável

## Base e limites

- Partir do `HEAD` somente depois de Task 2 e Task 3A estarem aprovadas.
- Ler integralmente o plano e sua emenda executiva antes de editar.
- Escopo desta entrega:
  - criar `src/background/pixel-capture-consent.js`;
  - criar `src/background/pixel-consent-expiry.js`;
  - criar os dois testes focados correspondentes.
- Não integrar ainda manifest, service worker, painel, protocolo, runner, lote,
  `owned-tabs` ou captura de pixels. O scheduler não registra listeners.
- TDD obrigatório: registrar os REDs reais antes da implementação e fazer um
  único commit ao final.

## Decisões vinculantes

### Uma autoridade durável por auditoria

Use uma única chave em `storage.session`:

```text
audita:pixel-capture:v1:<auditId>
```

O valor é um `PixelCaptureJournalV1` fechado. Ele reúne consentimento e
suspensão em um único record; não grave duas chaves e não presuma atomicidade
entre chaves. O journal contém somente identidade, política, categorias,
projeções sanitizadas e tempos epoch. Nunca contém URL bruta, valor de campo,
texto, HTML, seletor, pixels ou mensagem de exceção nativa.

Campos comuns obrigatórios:

```js
{
  version: 'PixelCaptureJournalV1', revision, auditId, consentId,
  tabId, windowId, documentId, mode, capturePolicy,
  categories, issuedAt, updatedAt, expiresAt,
  cleanupAttempts, cleanupNotBefore,
  state, resumePhase, revokeReason,
  urlEvidence, urlSessionDigest, source
}
```

- `revision`: inteiro positivo, incrementado uma vez por mutação confirmada.
- tempos: epoch em milissegundos, inteiros seguros; ISO pertence apenas à UI.
- `expiresAt` é calculado pelo state como
  `min(authorityExpiresAt, issuedAt + 10 minutos)`. Os rulings R8 e R10 do
  controller ledger fixam a pausa em 10 minutos e prevalecem sobre a prosa
  histórica de 5 minutos da Task 3 e sobre o preflight anterior.
  `authorityExpiresAt` já é o menor deadline da sessão/operação/lote;
  claim, retry, restart e drift nunca o renovam.
- `auditId` usado na chave é um ID opaco canônico
  `[A-Za-z0-9._:-]{1,160}`, o mesmo contrato único já usado por worker,
  painel e store. Barra, query, fragmento, percent-encoding, arroba e espaços
  são recusados antes de qualquer acesso a storage, portanto uma URL HTTP(S)
  completa nunca pode virar sufixo da chave.
  `consentId` é exatamente o base64url sem padding (22 caracteres) de 16 bytes
  CSPRNG; não aceite o formato genérico de outros IDs do produto.
- `state`: `paused | resuming | revoked | finished`.
- `resumePhase`: `null` em `paused|revoked|finished`; em `resuming`, exatamente
  `consent-claimed | session-running | runner-started`.
- `revokeReason`: `null` fora de `revoked`; em `revoked`, somente código fechado
  previsto neste brief.
- `cleanupAttempts/cleanupNotBefore`: `0/null` em `paused|resuming`;
  `cleanupAttempts` inteiro no intervalo `0..31` e `cleanupNotBefore` epoch em
  `revoked|finished`. A transição para `revoked` inicia em `0/updatedAt`; a
  escrita `finished` reinicia em `0/updatedAt` porque resta apenas remover o
  próprio journal. Backoff de cleanup nunca altera `expiresAt`.
- `capturePolicy` deve ser um `CapturePolicyV1` exato e `mode` deve coincidir.
- A FSM aceita exclusivamente `full-evidence|element-only`. `no-pixels` não
  chama pause/claim/mark/gate, não gera `consentId` e qualquer tentativa é
  recusada antes de RNG/storage; esse modo segue o percurso sem captura da 3D.
- `urlEvidence` deve ser `EvidenceUrlV1` exato; `urlSessionDigest` deve ser um
  HMAC válido. Não persista `.href` isoladamente.
- Invariante cruzada obrigatória: `urlEvidence.queryIncluded === true` somente
  é aceito quando `capturePolicy.includeQuery === true`. A combinação inversa
  é rejeitada antes do primeiro `set`, mesmo se ambos os objetos forem válidos
  isoladamente.
- categorias são lista densa, frozen, sem repetição e na ordem canônica
  `password, otp, payment, private-marker`.
- `source` é uma união fechada:
  - `{kind:'attached'}`;
  - `{kind:'owned-disposable',ownershipId,cleanupMode,pageId}` onde
    `cleanupMode` é `always|pre-observation-failure` e `pageId` é `null` ou ID.

Todos os parsers usam `Reflect.ownKeys` e own data descriptors. Getters,
símbolos, proxies revogados, propriedades extras e protótipos inesperados são
rejeitados sem leitura. Objetos retornados são cópias profundas congeladas.

### Escrita confirmada e falha fechada

Cada mutação segue `read -> validate -> set -> reread exact`. Se `set()` lança
depois de confirmar o valor desejado, trate como commit concluído. Se o valor
anterior continuar íntegro, a operação falha sem conceder nova autoridade. Se
aparecer estado parcial, malformado, estrangeiro ou não classificável, todas as
operações desse auditId falham com `PIXEL_STATE_UNAVAILABLE`; nunca ignore nem
apague por aproximação.

`finish` primeiro confirma `state:'finished'`, depois remove a chave e confirma
ausência. `remove()` commit-then-throw é sucesso somente após releitura; noop ou
estado substituído preserva bloqueio e falha. Um record `finished` jamais volta
a autorizar captura e pode ser limpo por recovery.

Serialize operações que compartilham o mesmo `sessionArea` e `auditId`. Um
segundo factory/restart deve validar o record persistido; não pode depender da
memória da primeira instância. Rollback de relógio falha fechado.

Neste contrato, “restart” significa reativação/substituição do service worker
dentro da mesma sessão do navegador. `chrome.storage.session` é apagado no
reinício completo do navegador ou reload/disable da extensão; não se promete
recovery de consentimento entre sessões do navegador.

Se uma transição de segurança motivada por binding divergente não conseguir
confirmar a revogação e o record anterior continuar intacto, marque uma barreira
volátil compartilhada por `sessionArea+auditId`: claim/mark/gate ficam negados
com `PIXEL_STATE_UNAVAILABLE`. `revokeAudit` permanece autorizado a confirmar a
revogação e então remove a barreira; restart elimina mensagens/Ports antigos e
volta a exigir prova fresca. Nunca transforme a falha de revogar em permissão
para a prova antiga.

## API de estado

```text
createPixelCaptureStateV1({sessionArea, now, randomBytes})

.pause({auditId,observedTarget,mode,capturePolicy,categories,authorityExpiresAt})
  -> AuditSuspensionV1

.claimAndBeginResume({auditId,consentId,proof,mode,categories})
  -> PixelCaptureClaimV1

.markSessionRunning({auditId,consentId})
  -> AuditSuspensionV1

.gateRunnerStart({auditId,consentId,proof,categories})
  -> PixelRunnerGateResultV1

.readSuspension(auditId)
  -> AuditSuspensionV1 | null

.listSuspensions({limit})
  -> PixelSuspensionScanV1

.listRecoveryCandidates({limit,includeResuming})
  -> PixelRecoveryScanV1

.nextExpiresAt()
  -> number | null

.revokeAudit({auditId,consentId,reason})
  -> PixelRevokeResultV1

.deferCleanup({auditId,consentId,expectedRevision})
  -> AuditSuspensionV1 | null

.finish({auditId,consentId})
  -> boolean
```

`observedTarget` desta API já é o contrato final que a Task 3C produzirá; não
aceite silenciosamente o `ObservedTargetV1` intermediário atual:

```js
// attached
{version:'ObservedTargetV1',kind:'attached',tabId,windowId,documentId,
 urlEvidence,urlSessionDigest}

// owned disposable
{version:'ObservedTargetV1',kind:'owned-disposable',ownershipId,tabId,windowId,
 documentId,urlEvidence,urlSessionDigest,cleanupMode,pageId}
```

`urlEvidence` é o objeto `EvidenceUrlV1` completo. A variante owned usa
`cleanupMode:'always'|'pre-observation-failure'`; `pageId` é `null` ou ID. A
Task 3C fará uma migração explícita do shape intermediário (`ownerId`, URL
string e `kind:'disposable'`) para este contrato — a Task 3B não o converte.

`proof` é a prova fresca imediatamente anterior ao claim e nunca contém URL:

```js
// attached
{kind:'attached',tabId,windowId,documentId,urlSessionDigest}

// owned disposable
{kind:'owned-disposable',ownershipId,tabId,windowId,documentId,
 urlSessionDigest,cleanupMode,pageId}
```

O claim compara, dentro da mesma operação serial/CAS, todos os campos de
`proof` com o binding persistido e também as categorias ordenadas. Isso cobre
navegação SPA que preserve `documentId` mas altere o digest, troca de janela e
troca de ownership. Divergência de binding faz CAS imediato para
`revoked:PIXEL_CONSENT_DOCUMENT_CHANGED` e somente após confirmar lança o código
fixo; não escreve claim nem autoriza pixels. Cleanup continua separado.

Regras:

- `pause` cria exatamente um consentimento pendente. Exige categorias sensíveis
  não vazias na criação inicial, `authorityExpiresAt` futuro e recusa record já
  existente. O state calcula e persiste o deadline mínimo, não confia em um
  `expiresAt` já calculado pelo caller.
- `claimAndBeginResume` exige record `paused`, não expirado e igualdade exata de
  audit+consent/mode/proof (tab, window, document, digest e ownership quando
  houver). O `consentId` vem da autoridade interna que emitiu a confirmação,
  nunca de texto visível. Par stale lança `PIXEL_CONSENT_STALE` sem comparar
  drift e sem mutação; uma aprovação atrasada do consentimento A jamais consome
  o consentimento B criado por uma rotação. A comparação da lista ordenada de
  categorias ocorre na mesma mutação CAS que consome o consentimento.
- Canonicalize as categorias atuais antes de comparar. O mesmo conjunto em
  ordem diferente é idêntico e não cria autoridade nova; adição, remoção ou
  substituição gira
  para novo `consentId`, mantenha `state:'paused'`, substitua pelas categorias
  canônicas atuais sem estender `expiresAt`, confirme a escrita e lance apenas
  `PIXEL_CONSENT_SIGNALS_CHANGED`. Lista atual vazia também é drift e exige novo
  aceite; nunca libera pixels automaticamente.
- Um claim bem-sucedido grava `resuming/consent-claimed` antes de retornar e
  carrega a cópia ordenada das categorias. Replay retorna somente
  `PIXEL_CONSENT_ALREADY_USED`.
- `markSessionRunning` é o único passo `consent-claimed -> session-running`,
  exige o mesmo par e `now < expiresAt`; nenhum skip, retorno ou no-op.
- `gateRunnerStart` é o **único** caminho `session-running -> runner-started` e
  fica imediatamente antes da primeira chamada de pixels, sem trabalho assíncrono
  interveniente na integração 3D. No mesmo CAS, exige o mesmo audit+consent,
  `now < expiresAt`, prova fresca integral e categorias atuais. Binding
  divergente faz o mesmo CAS imediato para
  `revoked:PIXEL_CONSENT_DOCUMENT_CHANGED` antes de lançar o código;
  expiração lança
  `PIXEL_CONSENT_EXPIRED`; fase/par stale lança
  `PIXEL_RESUME_TRANSITION_INVALID`.
- Se o conjunto canônico de categorias for idêntico, `gateRunnerStart` grava `runner-started` e
  devolve somente `status:'ready'`. Se divergirem por qualquer motivo, preserva
  binding/source/issuedAt/expiresAt/policy, gira `consentId`, substitui as
  categorias atuais (inclusive vazio), volta a `paused`, zera
  `resumePhase/revokeReason/cleanup*` e devolve `status:'repaused'`. Não existe
  API pública separada de repausa nem outro caminho para `runner-started`; o
  caller não consegue escolher ignorar a sonda final.
- `revokeAudit` é transição CAS pura e idempotente. Exige o `consentId` da
  projeção lida pelo caller e devolve a união fechada `PixelRevokeResultV1`,
  distinguindo `revoked | already-revoked | finished | missing | mismatch`.
  `missing/mismatch` têm `suspension:null` e zero mutação; os demais carregam a
  projeção confirmada. Record já revogado preserva a primeira causa mesmo se o
  novo motivo divergir. Assim o scheduler nunca liquida uma projeção velha
  depois de drift, finish ou concorrência de outro factory. Não remove aba,
  sessão, página, checkpoint ou journal. Códigos aceitos:
  `PIXEL_CONSENT_EXPIRED`, `PIXEL_CONSENT_DOCUMENT_CHANGED`,
  `PIXEL_RESUME_INTERRUPTED`, `AUDIT_CANCELLED`, `AUDIT_DELETED`,
  `SESSION_ENDED`.
- `deferCleanup` aceita somente o mesmo par, a revisão exata lida e state
  `revoked|finished`. Incrementa `cleanupAttempts` com saturação em 31 e grava
  `cleanupNotBefore = now + min(10 min, 60 s * 2^(attempts-1))`, em que a
  primeira falha espera 60 s. Stale/missing retorna `null` sem mutação. É a
  única forma de adiar retry; não altera prazo, binding, source ou motivo.
- `finish({auditId,consentId})` valida o par. Pode concluir um resultado terminal
  já durável em `resuming/runner-started` ou um record `revoked` depois da
  liquidação. Par divergente nunca remove. Ausência retorna `false`.
- Enumeração lê o `now` interno uma vez; nenhum caller fornece `at`. Um record
  malformado no namespace bloqueia operações daquele auditId, mas não impede a
  leitura/cleanup dos demais. Os scans retornam os válidos,
  `unavailableAuditIds` somente para sufixos que já passem o validador canônico
  e `hasUnattributedUnavailable` para chave/payload não atribuível. Esses
  diagnósticos são internos: nunca UI, relatório ou log. O scheduler processa
  os válidos, nunca transforma indisponibilidade em ausência e nunca remove a
  chave corrompida por aproximação.
- `listSuspensions` ordena válidos por `expiresAt,auditId` e limita 1..25.
- `listRecoveryCandidates` não é uma segunda autoridade. Seleciona `resuming`
  primeiro somente quando `includeResuming:true`; depois mistura justamente
  `paused` vencido por `expiresAt` e `revoked|finished` cujo
  `cleanupNotBefore <= now`, ordenando pelo instante devido e `auditId` antes
  de aplicar 1..25. Falha adiada sai do próximo lote e não pode monopolizá-lo;
  pausas futuras nunca ocultam recovery urgente.
- `nextExpiresAt` devolve o menor epoch de `paused.expiresAt` ou
  `revoked|finished.cleanupNotBefore`, ou `null`; apesar do nome histórico, é o
  próximo despertar do scheduler. Para o cálculo, usa todos os records válidos
  e deixa cada malformado bloqueado sem tratá-lo como autoridade/ausência; só
  falha se a leitura global do storage falhar. Não emite ISO.

`AuditSuspensionV1` e `PixelCaptureClaimV1` são projeções fechadas e frozen;
nenhuma delas expõe detalhes internos de recovery além do necessário para a
integração posterior.

Shapes exatos das projeções:

```js
// AuditSuspensionV1
{version:'AuditSuspensionV1',revision,auditId,consentId,tabId,windowId,
 documentId,urlEvidence,urlSessionDigest,mode,capturePolicy,categories,
 issuedAt,updatedAt,expiresAt,cleanupAttempts,cleanupNotBefore,
 state,resumePhase,revokeReason,source}

// PixelCaptureClaimV1
{version:'PixelCaptureClaimV1',auditId,consentId,tabId,windowId,documentId,
 urlSessionDigest,mode,categories,claimedAt,expiresAt,source}

// PixelRunnerGateResultV1
{version:'PixelRunnerGateResultV1',status:'ready'|'repaused',
 suspension:AuditSuspensionV1}

// PixelSuspensionScanV1
{version:'PixelSuspensionScanV1',suspensions,unavailableAuditIds,
 hasUnattributedUnavailable}

// PixelRecoveryScanV1
{version:'PixelRecoveryScanV1',candidates,unavailableAuditIds,
 hasUnattributedUnavailable,blockingCount}

// PixelRevokeResultV1
{version:'PixelRevokeResultV1',
 status:'revoked'|'already-revoked'|'finished'|'missing'|'mismatch',
 suspension:AuditSuspensionV1|null}
```

O claim não expõe `urlEvidence`, mas carrega digest, janela, prazo e source para
que o gate imediatamente anterior aos pixels valide a mesma autoridade sem
reler URL bruta. Toda projeção aninhada é cópia frozen; não retorne referências
ao record armazenado ou ao input do caller.

Os arrays `suspensions/candidates/unavailableAuditIds` são densos, deduplicados
e frozen. IDs indisponíveis são usados apenas para bloquear/diagnosticar aquele
auditId; uma chave privada nunca é copiada para UI, relatório ou log.
`blockingCount` conta somente records válidos ainda `resuming`, inclusive os
que não cabem no lote. Assim a readiness espera a revogação fail-closed de toda
retomada preexistente, mas cleanup já duravelmente revogado fica escopado ao
audit/page/queue e retenta por alarme sem derrubar operações independentes.

## Coordenador único e scheduler

```text
createPixelConsentExpirySchedulerV1(chromeApi, {
  pixelState, liquidator, now, timer = localTimer,
})
// -> {run(trigger),scheduleNext(),recoverOnStartup(),dispose()}
```

`timer` é o adaptador fechado `{set(callback,delayMs),clear(handle)}` usado nos
testes; omitido em produção, delega apenas a `globalThis.setTimeout/clearTimeout`.

- `liquidator.liquidate({auditId,consentId,reason,source,signal})` é a única fronteira
  que futuramente limpará sessão, página/lote, owner e checkpoint. Neste task é
  um fake injetado; resultado confirmado é exatamente `true`.
- Cada chamada ao liquidator recebe também um `AbortSignal` e tem budget fechado
  de 5 segundos, medido pelo `timer` monotônico injetável (produção usa timers
  locais). Timeout equivale a `false`: aborta o signal, chama `deferCleanup` e
  avança para a próxima candidata. Resolução/rejeição tardia é sempre consumida
  e ignorada; jamais chama `finish`, não muda retry e não bloqueia a fila.
- O scheduler nunca registra `alarms.onAlarm`, nunca chama pixels e nunca cria
  outra autoridade. `dispose()` só fecha trabalho local e é idempotente.
- `run`, `scheduleNext` e `recoverOnStartup` compartilham a mesma fila serial
  para toda factory que usa o mesmo objeto `chromeApi.alarms`, não apenas a
  instância. Uma promise tardia de factory antiga não pode limpar nem
  substituir o alarme mais próximo de outra factory; `dispose` recusa novos
  trabalhos locais. Depois de `create/clear`, releia journal e alarme e, se o
  deadline mudou durante o await, recalcule antes de confirmar.
- `run('alarm'|'panel')` é serializado e processa no máximo 25 candidatos
  urgentes com `includeResuming:false`:
  - `paused` vencido -> revoga como `PIXEL_CONSENT_EXPIRED`;
  - `revoked` -> continua liquidação;
  - `finished` -> repete somente `finish`/remoção.
- `run('alarm'|'panel')` **nunca toca `resuming`**. Um alarme ou reabertura do
  painel pode ocorrer durante uma retomada legítima; revogá-la concorrente ao
  runner reabriria uma corrida até pixels.
- O scheduler sempre chama `revokeAudit` com audit+consent da candidata. Somente
  status `revoked|already-revoked` permite liquidar, usando exatamente
  `reason/source` da suspensão devolvida pelo CAS; `missing|mismatch` produz
  zero efeito e `finished` repete somente `finish`/remoção. O liquidator é
  obrigatório ser idempotente e escopado ao par audit+consent e à `source`
  confirmada; nunca aceita somente auditId nem descobre ownership por
  aproximação.
- Depois de `liquidator.liquidate`, somente `true` permite
  `finish({auditId,consentId})`. Throw/false chama `deferCleanup` com a revisão
  confirmada e continua os demais candidatos. Se `finish` confirmar a escrita
  `finished` mas não confirmar a remoção, o scheduler relê o mesmo par/revisão,
  chama `deferCleanup` e nunca repete o liquidator.
- `recoverOnStartup()` é a única variante que usa
  `includeResuming:true`. Sob a barreira única de bootstrap e antes de qualquer
  Port/comando pronto, drena lotes sucessivos de até 25, com yield entre lotes,
  até não restar `resuming` nem outro recovery vencido. Assim o 26º resume não
  fica abandonado. Somente nesse contexto um `resuming` persistido prova
  interrupção e é revogado como `PIXEL_RESUME_INTERRUPTED`; não existe replay
  de claim ou captura.
- A promise de startup é compartilhada. Depois do primeiro sucesso, chamadas
  repetidas na mesma ativação são no-op e jamais classificam como interrompido
  um `resuming` criado após a readiness. Falha de leitura global do storage ou
  impossibilidade de confirmar a transição de algum `resuming` mantém a
  readiness fechada; enquanto ela estiver fechada, nova chamada pode fazer
  retry controlado. Record malformado fica fail-closed apenas para seu auditId.
- Falha de liquidator após a revogação confirmada é primeiro adiada por
  `deferCleanup`, para que o próximo lote avance, e não fecha a readiness
  global: o par revogado já não autoriza pixels. O startup conclui quando o
  scan confirmar `blockingCount:0`; cleanup restante é bloqueio escopado à
  auditoria/página/fila correspondente e retenta pelo alarme, sem loop apertado.
- `scheduleNext()` usa somente o alarme one-shot
  `audita-pixel-consent-expiry-v1`, na menor expiração futura, ou limpa somente
  esse nome quando não houver pendência. Chrome API commit-then-throw deve ser
  confirmado por `alarms.get`; falha não remove o journal.
- `run()` sempre tenta `scheduleNext()` ao final. Records revogados/finished com
  cleanup não confirmado devem agendar retry conservador para no mínimo 60
  segundos depois de `now`, sem loop apertado. Chrome anterior ao 120 — e o
  mínimo suportado aqui é 116 — tinha granularidade mínima de um minuto. Não use
  `persistAcrossSessions`: a extensão suporta Chrome 116 e essa opção só existe
  em versões recentes; o bootstrap recria o alarme por `recoverOnStartup()`.
- Objetos nativos retornados por `alarms.get` são projetados de forma
  descriptor-safe somente para `name/scheduledTime`; campos extras adicionados
  pelo Chrome são tolerados. Isso é uma exceção deliberada à rejeição de extras
  aplicada aos contratos privados da extensão.

## REDs obrigatórios

1. pause/claim vinculados a audit+consent, tab, window, document, digest,
   ownership, mode e categorias; replay, aprovação atrasada A após rotação B e
   fase pulada são rejeitados antes de efeitos.
2. drift por adição, remoção ou troca no claim e no gate final gira
   `consentId`, mantém pausa e não estende deadline; o mesmo conjunto em ordem
   diferente canonicaliza sem criar autoridade. Prova stale não repausa outra
   autoridade. Expiração entre claim e gate ou mudança de documento não alcança
   `runner-started`; zero pixels.
3. `throw-before`, `commit-then-throw`, noop, commit parcial e substituição
   estrangeira em set/remove; nenhuma falha autoriza pixels nem apaga o outro
   auditId.
4. promise tardia e duas instâncias concorrentes preservam revision/CAS e no
   máximo um claim.
5. race entre listagem e revoke: rotação/finish concorrente produz
   `mismatch|finished` e zero chamada ao liquidator; retry de revoked usa o
   par/source/primeiro motivo persistidos e é idempotente.
   Binding B divergente seguido de prova A atrasada encontra o journal já
   revogado e nunca claim/runner-started; falha ao persistir essa revogação ativa
   a barreira volátil compartilhada e também nega A.
6. restart em `paused`, cada fase `resuming`, `revoked` e `finished`; recovery
   nunca chama captura.
7. relógio inválido/rollback/overflow, expiração absoluta de 10 min,
   `cleanupNotBefore` exponencial limitado e `nextExpiresAt` epoch.
8. getters, símbolos, sparse arrays, proxies/revogados e extra fields sem
   invocar accessors.
9. serialização compartilhada do scheduler, duas factories, promises tardias,
   prioridade antes do limite de 25, >25 resumes, 25 cleaners que falham sem
   starvation, retry 60 s..10 min, alarme mais próximo e limpeza restrita ao
   nome canônico.
10. race obrigatório: `run('alarm')` e `run('panel')` durante um record
   `resuming` vivo não revogam, não liquidam e não chamam `finish`; apenas
   `recoverOnStartup()` antes da readiness o classifica como interrompido.
11. JSON do journal **e os nomes das chaves** não contêm URL bruta/query não
   autorizada, valor, texto, HTML, seletor ou erro nativo; auditId URL-like é
   recusado, consentId tem exatamente 16 bytes base64url e
   `queryIncluded:true/includeQuery:false` falha antes do set.
12. um record malformado não invoca getter, permanece bloqueado e aparece só em
   `unavailableAuditIds` interno quando atribuível (ou na flag genérica),
   enquanto records válidos de outros auditIds continuam sendo recuperados e
   a readiness abre após todos os `resuming` válidos estarem revogados.
13. alarmes nativos com campos extras são aceitos; alarmes com getter, nome ou
   horário inválido falham fechados sem clobber de outro deadline.
14. `no-pixels` produz zero chave, zero `randomBytes`, zero alarme e nunca entra
   na FSM de consentimento; policy com prototype customizado é rejeitada antes
   de storage mesmo quando `isCapturePolicyV1` isolado a reconheceria.
15. A malformado + B válido ainda agenda/liquida B e nunca autoriza/remove A;
   liquidator A pendente para sempre sofre timeout, é adiado, B avança e uma
   resolução tardia de A produz zero `finish`/mutação.

## Vinculação futura obrigatória

- Tasks 3C–3E usam o mesmo par audit+consent; não criam um receipt paralelo.
- Na Task 3D, `consentId` é o nonce one-shot do próprio journal e não ganha uma
  segunda autoridade durável. Ele trafega somente no Port `SIDE_PANEL` já
  autenticado e ligado à window/session, fica na memória privada do módulo
  (nunca DOM, dataset, URL, localStorage, modelo, relatório ou log) e o intent
  exato do clique ecoa `{auditId,consentId}`. O handler reprova binding e sinais
  e chama o claim para consumir esse mesmo par; página/content script nunca o
  recebe. Uma rotação invalida naturalmente todo clique atrasado anterior.
- Tasks 3C–3E nunca gravam `consentId` bruto em IndexedDB, modelo, checkpoint
  exportável ou receipt. Antes do runner, criam em `storage.session` um marcador
  não autorizante com `attemptDigest` HMAC domain-separated do mesmo
  `auditId+consentId`; o HMAC usa a autoridade de sessão já existente e o raw
  consent continua apenas no journal/memória. A transação IDB que persiste o
  resultado terminal também confirma, no checkpoint privado não exportável, o
  mesmo `attemptDigest+auditId+pageId/ownershipId`. Assim não existe crash cut
  entre modelo e confirmação terminal; marcador preparado sem commit terminal
  nunca é aceito como resultado.
- Ao liquidar
  `PIXEL_RESUME_INTERRUPTED`, o coordenador consulta esse marcador antes de
  materializar falha: se o resultado da tentativa já for terminal e durável,
  preserva-o, executa apenas cleanup ainda devido e `finish`; nunca sobrescreve
  por `failed`, nunca cria novo modelo e nunca recaptura pixels. Retry do
  liquidator repete a mesma correlação exata. O digest não autoriza claim,
  captura, cleanup nem leitura pública e é removido pelo mesmo cleanup/tombstone.
- O coordenador de integração chama `scheduleNext()` em `finally` após toda
  operação que possa mudar o journal: pause, claim/drift, mark, gate/repausa,
  revoke, defer e finish. O único listener de alarme apenas delega `run`.
  Falha de agendamento não desfaz state confirmado; permanece fail-closed e é
  recriada pelo bootstrap/abertura do painel. REDs futuros cobrem pause→alarme e
  revoke direto→retry, sem uma segunda autoridade de scheduler.
- Na Task 5, a exclusão usa o motivo fechado `AUDIT_DELETED` (não
  `audit-deleted`) e ramifica pelo estado lido: `paused|resuming` chama
  `revokeAudit` com o par; `revoked` preserva a primeira causa e segue cleaners
  com o mesmo par/source; `finished` pula cleaners já confirmados e repete só
  `finish`. `missing|mismatch` exige releitura/decisão, nunca cleanup por
  aproximação. Somente `revokeAudit` não conclui exclusão nem remove journal.

## Gates e entrega

```bash
node --test \
  test/background/pixel-capture-consent.test.js \
  test/background/pixel-consent-expiry.test.js
git diff --check
```

Entregar um commit isolado:

```text
feat: journal pixel consent recovery
```

Relatar RED observado, PASS final, SHA e arquivos alterados. Não empacotar ZIP.
