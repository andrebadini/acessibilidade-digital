import { EXPORT_SURFACE, deriveTrustedExtensionContext } from './target-capabilities.js';
import {
  canonicalExportFormatsV1,
  EXPORT_FORMATS_V1,
  isCanonicalExportFormatsV1,
} from '../export/export-formats.js';
import { canonicalAuditId } from '../storage/audit-retention.js';

const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const CAPABILITY = /^[A-Za-z0-9_-]{22}$/u;
const ATTEMPT = /^[1-9][0-9]*$/u;
const EXPORT_MIME_V1 = Object.freeze({
  html: 'text/html;charset=utf-8', pdf: 'application/pdf',
  csv: 'text/csv;charset=utf-8', json: 'application/json;charset=utf-8',
});
// `formats` é opcional para que registros gravados antes da exportação por formato continuem
// abrindo: a ausência sempre significa os quatro formatos canônicos.
const LAUNCH_RECORD_KEYS = Object.freeze(['version','auditId','sourceReviewSessionCapabilityId','expectedRevision','attemptId','tabId','windowId','path','documentId','state','issuedAt','expiresAt']);
const LAUNCH_RECORD_OPTIONS = Object.freeze([
  // A ordem de `formats` antes de `terminalProof` acompanha a gravação: o registro nasce com
  // `formats` e só recebe `terminalProof` depois, então a leitura confirmada compara a mesma
  // sequência de chaves. Registros antigos, sem `formats`, continuam aceitos pelas opções seguintes.
  Object.freeze([...LAUNCH_RECORD_KEYS, 'formats', 'terminalProof']),
  Object.freeze([...LAUNCH_RECORD_KEYS, 'terminalProof']),
  Object.freeze([...LAUNCH_RECORD_KEYS, 'formats']),
  LAUNCH_RECORD_KEYS,
]);
const SESSION_RECORD_KEYS = Object.freeze(['version','sessionCapabilityId','auditId','launchTabId','launchDocumentId','expectedRevision','attemptId','intents','state','issuedAt','expiresAt']);
const TERMINAL_PROOF_KEYS = Object.freeze(['version','auditId','sessionCapabilityId','attemptId','modelRevision','receiptStatus','applied','deleted','status','notified']);
const RECEIPT_KEYS = Object.freeze(['version','auditId','modelRevision','modelHash','attemptId','status','formats']);
const RECEIPT_FORMAT_KEYS = Object.freeze(['format','mimeType','byteSize','sha256','downloadId','state']);
const PATH = '/src/export/index.html';
const TTL_MS = 15 * 60 * 1000;
// Janela em que o estado INTERMEDIÁRIO da navegação que a própria autoridade iniciou é tolerado. Medido em
// 18/09/2026 (revisão adversarial da 1.1.49, achado N-2): sob carga, `tabs.get` responde `about:blank` SEM
// `pendingUrl` por tempo suficiente para `handleTabUpdated` revogar a concessão — a exportação do usuário
// morria sem produzir arquivo, e o relatório já havia respondido "ok". Só uma navegação CONFIRMADA para
// outro destino (ou a janela/aba sumindo) revoga; e a tolerância é limitada no tempo.
const STAGING_GRACE_MS = 30_000;
const SHARED_QUEUES = new WeakMap();
const launchKey = auditId => `audita:export-launch:v1:${auditId}`;
const indexKey = tabId => `audita:export-launch-tab:v1:${tabId}`;
const sessionKey = id => `audita:export-session:v1:${id}`;

function fail(code) { return Object.freeze({ ok: false, code }); }
function safeId(value) { return Number.isSafeInteger(value) && value >= 0; }
function ownDataDescriptor(value, key, optional = false) {
  try {
    if (!value || typeof value !== 'object') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return optional ? Object.freeze({ present: false, value: undefined }) : null;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    return Object.freeze({ present: true, value: descriptor.value });
  } catch { return null; }
}
function tabSnapshot(value) {
  const id = ownDataDescriptor(value, 'id');
  const windowId = ownDataDescriptor(value, 'windowId');
  const url = ownDataDescriptor(value, 'url');
  const pendingUrl = ownDataDescriptor(value, 'pendingUrl', true);
  if (!id || !windowId || !url || !pendingUrl) return null;
  return Object.freeze({
    id: id.value, windowId: windowId.value, url: url.value,
    pendingUrlPresent: pendingUrl.present, pendingUrl: pendingUrl.value,
  });
}
function exactStagingTab(tab, launch, expectedUrl) {
  if (!tab || tab.id !== launch.tabId || tab.windowId !== launch.windowId) return false;
  if (tab.url === expectedUrl) return !tab.pendingUrlPresent || tab.pendingUrl === expectedUrl;
  return tab.url === 'about:blank' && tab.pendingUrlPresent && tab.pendingUrl === expectedUrl;
}
// O complemento tolerante de `exactStagingTab`: a aba continua sendo a NOSSA enquanto a URL é `about:blank` ou
// a esperada, e qualquer `pendingUrl` publicado é a esperada. É o estado intermediário que o Chrome publica
// durante a navegação iniciada por `tabs.update`.
function stagingNavigationPending(tab, launch, expectedUrl) {
  if (!tab || tab.id !== launch.tabId || tab.windowId !== launch.windowId) return false;
  const urlAllowed = tab.url === expectedUrl || tab.url === 'about:blank';
  const pendingAllowed = !tab.pendingUrlPresent || tab.pendingUrl === expectedUrl;
  return urlAllowed && pendingAllowed;
}
function exactConnectedTab(tab, launch, expectedUrl) {
  return Boolean(tab && tab.id === launch.tabId && tab.windowId === launch.windowId &&
    tab.url === expectedUrl && !tab.pendingUrlPresent);
}
function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value); for (const child of Object.values(value)) deepFreeze(child, seen); return Object.freeze(value);
}
function exact(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const own = Reflect.ownKeys(value); if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const copy = {};
    for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null; copy[key] = descriptor.value; }
    return copy;
  } catch { return null; }
}
function readEpoch(now) { const value = now(); if (!Number.isSafeInteger(value) || value < 0) throw new Error('EXPORT_CLOCK_DENIED'); return value; }
function validAttempt(value) {
  if (!ATTEMPT.test(value ?? '')) return false;
  const numeric = Number(value); return Number.isSafeInteger(numeric) && numeric > 0 && String(numeric) === value;
}
export function deriveExportLeaseOwner(auditId, attemptId) {
  if (!AUDIT_ID.test(auditId ?? '') || !validAttempt(attemptId)) throw new Error('EXPORT_ATTEMPT_DENIED');
  return `export:${auditId}:${attemptId}`;
}
function terminalProofRecord(value) {
  const proof = exact(value, TERMINAL_PROOF_KEYS);
  if (!proof || proof.version !== 1 || !AUDIT_ID.test(proof.auditId ?? '') ||
    !CAPABILITY.test(proof.sessionCapabilityId ?? '') || !validAttempt(proof.attemptId) ||
    !Number.isSafeInteger(proof.modelRevision) || proof.modelRevision < 1 ||
    !['complete','partial'].includes(proof.receiptStatus) || typeof proof.applied !== 'boolean' ||
    typeof proof.deleted !== 'boolean' || typeof proof.notified !== 'boolean' ||
    (proof.applied ? !['complete','partial'].includes(proof.status) : proof.status !== null) ||
    (!proof.applied && (proof.deleted || proof.notified)) || (proof.notified && !proof.applied) ||
    (proof.receiptStatus === 'partial' && (proof.deleted || (proof.applied && proof.status !== 'partial')))) return null;
  return deepFreeze(proof);
}
function proofMatchesLaunch(proof, launch) {
  return Boolean(proof && proof.auditId === launch.auditId && proof.attemptId === launch.attemptId &&
    proof.modelRevision === launch.expectedRevision);
}
function proofMatchesSession(proof, session) {
  return Boolean(proof && proof.auditId === session.auditId && proof.sessionCapabilityId === session.sessionCapabilityId &&
    proof.attemptId === session.attemptId && proof.modelRevision === session.expectedRevision);
}
function sameTerminalProof(left, right) {
  return Boolean(left && right && TERMINAL_PROOF_KEYS.every(key => left[key] === right[key]));
}
function launchRecord(value) {
  let row = null;
  for (const keys of LAUNCH_RECORD_OPTIONS) {
    row = exact(value, keys);
    if (row) break;
  }
  const hasTerminalProof = Boolean(row && Object.hasOwn(row, 'terminalProof'));
  const terminalProof = hasTerminalProof ? terminalProofRecord(row.terminalProof) : null;
  if (!row || (Object.hasOwn(row, 'formats') && (typeof row.formats !== 'string' ||
      !isCanonicalExportFormatsV1(row.formats))) ||
    row.version !== 1 || !AUDIT_ID.test(row.auditId ?? '') || !CAPABILITY.test(row.sourceReviewSessionCapabilityId ?? '') ||
    !Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 1 || !validAttempt(row.attemptId) || !safeId(row.tabId) || !safeId(row.windowId) ||
    row.path !== PATH || !['allocated','awaiting-connection','connected','terminal','revoked'].includes(row.state) ||
    !Number.isSafeInteger(row.issuedAt) || !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= row.issuedAt ||
    (['allocated','awaiting-connection'].includes(row.state) && row.documentId !== null) ||
    (['connected','terminal'].includes(row.state) && (typeof row.documentId !== 'string' || !row.documentId)) ||
    (row.state === 'revoked' && row.documentId !== null && (typeof row.documentId !== 'string' || !row.documentId)) ||
    (row.state === 'terminal' ? !hasTerminalProof || !proofMatchesLaunch(terminalProof, row) : hasTerminalProof)) return null;
  return deepFreeze(hasTerminalProof ? {...row,terminalProof} : row);
}
function sessionRecord(value) {
  const row = exact(value, [...SESSION_RECORD_KEYS, 'terminalProof']) ?? exact(value, SESSION_RECORD_KEYS);
  const hasTerminalProof = Boolean(row && Object.hasOwn(row, 'terminalProof'));
  const terminalProof = hasTerminalProof ? terminalProofRecord(row.terminalProof) : null;
  if (!row || row.version !== 1 || !CAPABILITY.test(row.sessionCapabilityId ?? '') || !AUDIT_ID.test(row.auditId ?? '') ||
    !safeId(row.launchTabId) || typeof row.launchDocumentId !== 'string' || !row.launchDocumentId ||
    !Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 1 || !validAttempt(row.attemptId) ||
    !Array.isArray(row.intents) || row.intents.length !== 2 || row.intents[0] !== 'execute-export' || row.intents[1] !== 'complete-export' ||
    !['active','terminal','revoked'].includes(row.state) || !Number.isSafeInteger(row.issuedAt) || !Number.isSafeInteger(row.expiresAt) ||
    (row.state === 'terminal' ? !hasTerminalProof || !proofMatchesSession(terminalProof, row) : hasTerminalProof)) return null;
  return deepFreeze(hasTerminalProof ? {...row,terminalProof} : row);
}
function exportReceiptRecord(value, { auditId, attemptId, modelRevision }) {
  const receipt = exact(value, RECEIPT_KEYS);
  if (!receipt || receipt.version !== 1 || receipt.auditId !== auditId || receipt.attemptId !== attemptId ||
    receipt.modelRevision !== modelRevision || !/^[a-f0-9]{64}$/u.test(receipt.modelHash ?? '') ||
    !['complete','partial'].includes(receipt.status) || !Array.isArray(receipt.formats) ||
    receipt.formats.length > EXPORT_FORMATS_V1.length ||
    (receipt.status === 'complete' && receipt.formats.length !== EXPORT_FORMATS_V1.length)) return null;
  const formats = [];
  const downloadIds = new Set();
  let priorFormatIndex = -1;
  for (const value of receipt.formats) {
    const row = exact(value, RECEIPT_FORMAT_KEYS);
    const formatIndex = row ? EXPORT_FORMATS_V1.indexOf(row.format) : -1;
    if (!row || formatIndex <= priorFormatIndex || row.mimeType !== EXPORT_MIME_V1[row.format] || row.state !== 'complete' ||
      !Number.isSafeInteger(row.byteSize) || row.byteSize < 0 || !/^[a-f0-9]{64}$/u.test(row.sha256 ?? '') ||
      !Number.isSafeInteger(row.downloadId) || row.downloadId < 0 || downloadIds.has(row.downloadId)) return null;
    priorFormatIndex = formatIndex;
    downloadIds.add(row.downloadId);
    formats.push(Object.freeze(row));
  }
  if (receipt.status === 'complete' && formats.some((row, index) => row.format !== EXPORT_FORMATS_V1[index])) return null;
  return deepFreeze({ ...receipt, formats });
}
async function stored(area, key, parse) { const envelope = await area.get(key); return parse(envelope?.[key]); }
async function confirmed(area, key, value, parse) {
  await area.set({ [key]: value }); const result = await stored(area, key, parse);
  return result && JSON.stringify(result) === JSON.stringify(value) ? result : null;
}
function queues(area) { let value = SHARED_QUEUES.get(area); if (!value) { value = new Map(); SHARED_QUEUES.set(area, value); } return value; }
function serialize(area, key, task) {
  const map = queues(area); const prior = map.get(key) ?? Promise.resolve(); const current = prior.then(task, task);
  const tail = current.then(() => undefined, () => undefined); map.set(key, tail);
  return current.finally(() => { if (map.get(key) === tail) map.delete(key); });
}
function canonicalUrl(chromeApi, auditId) {
  const url = new URL(chromeApi.runtime.getURL('src/export/index.html')); url.searchParams.set('auditId', auditId);
  if (url.pathname !== PATH || url.hash || url.searchParams.getAll('auditId').length !== 1 || [...url.searchParams.keys()].length !== 1) throw new Error();
  return url.href;
}
function opaqueId(randomBytes) {
  const bytes = randomBytes(16); if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) throw new Error();
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  const value = btoa(binary).replace(/\+/gu,'-').replace(/\//gu,'_').replace(/=+$/gu,'');
  if (!CAPABILITY.test(value)) throw new Error(); return value;
}

export function createExportLaunchAuthority(raw) {
  const input = exact(raw, ['chromeApi','sessionArea','auditStore','reportLaunch','epochNow','modelNow','randomBytes']);
  if (!input || typeof input.chromeApi?.runtime?.getURL !== 'function' || typeof input.chromeApi.runtime.getContexts !== 'function' ||
    typeof input.chromeApi?.tabs?.create !== 'function' || typeof input.chromeApi.tabs.update !== 'function' || typeof input.chromeApi.tabs.get !== 'function' ||
    typeof input.sessionArea?.get !== 'function' ||
    typeof input.sessionArea.set !== 'function' || typeof input.auditStore?.getAuditSnapshot !== 'function' || typeof input.auditStore.acquireExportLease !== 'function' ||
    typeof input.auditStore.releaseExportLease !== 'function' ||
    typeof input.reportLaunch?.authorizeExport !== 'function' || typeof input.epochNow !== 'function' || typeof input.modelNow !== 'function' || typeof input.randomBytes !== 'function') {
    throw new TypeError('EXPORT_LAUNCH_INVALID');
  }
  const getLaunch = auditId => AUDIT_ID.test(auditId ?? '') ? stored(input.sessionArea, launchKey(auditId), launchRecord) : Promise.resolve(null);
  const getSession = id => CAPABILITY.test(id ?? '') ? stored(input.sessionArea, sessionKey(id), sessionRecord) : Promise.resolve(null);

  async function requestExport({ auditId, sessionCapabilityId, sender, deleteAfterCompleteExport = false, formats = undefined } = {}) {
    if (typeof deleteAfterCompleteExport !== 'boolean') return fail('REPORT_EXPORT_DENIED');
    let requestedFormats;
    try { requestedFormats = formats === undefined ? EXPORT_FORMATS_V1 : canonicalExportFormatsV1(formats); }
    catch { return fail('REPORT_EXPORT_DENIED'); }
    // A exclusão só é honesta quando os quatro formatos foram pedidos nesta exportação;
    // botões individuais nunca podem apagar a auditoria local.
    if (deleteAfterCompleteExport && requestedFormats.length !== EXPORT_FORMATS_V1.length) return fail('REPORT_EXPORT_DENIED');
    const authorization = await input.reportLaunch.authorizeExport({ auditId, sessionCapabilityId, sender });
    if (!authorization?.ok) return fail(authorization?.code === 'CONTEXT_DENIED' ? 'CONTEXT_DENIED' : 'REPORT_EXPORT_DENIED');
    return serialize(input.sessionArea, auditId, async () => {
      const active = await getLaunch(auditId);
      if (active && !['terminal','revoked'].includes(active.state) && active.expiresAt > readEpoch(input.epochNow)) return fail('EXPORT_ALREADY_ACTIVE');
      const snapshot = await input.auditStore.getAuditSnapshot(auditId);
      if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) return fail('EXPORT_REVISION_DENIED');
      const ownerSeed = `export:${auditId}:pending`;
      const leaseNow = input.modelNow();
      const lease = await input.auditStore.acquireExportLease(auditId, snapshot.capability, { ownerId: ownerSeed, now: leaseNow });
      if (!lease?.acquired) return fail('EXPORT_LEASE_DENIED');
      if (!Number.isSafeInteger(lease.exportAttempt) || lease.exportAttempt < 1 || lease.revision !== snapshot.revision) {
        await input.auditStore.releaseExportLease(auditId, { ownerId: ownerSeed, now: leaseNow }).catch(() => false);
        return fail('EXPORT_LEASE_DENIED');
      }
      const attemptId = String(lease.exportAttempt);
      let ownedTabId = null;
      try {
        await input.auditStore.setRetentionIntent(auditId, snapshot.capability, {
          now: leaseNow, deleteAfterCompleteExport,
        });
        const tab = await input.chromeApi.tabs.create({ url: 'about:blank', active: false, windowId: authorization.windowId });
        if (!safeId(tab?.id) || tab.windowId !== authorization.windowId) throw new Error('EXPORT_OPEN_FAILED');
        ownedTabId = tab.id;
        const now = readEpoch(input.epochNow);
        const launch = deepFreeze({ version:1,auditId,sourceReviewSessionCapabilityId:sessionCapabilityId,expectedRevision:snapshot.revision,
          attemptId,tabId:tab.id,windowId:authorization.windowId,path:PATH,documentId:null,state:'allocated',issuedAt:now,expiresAt:now+TTL_MS,
          formats: requestedFormats.join(',') });
        if (!await confirmed(input.sessionArea, launchKey(auditId), launch, launchRecord)) throw new Error('EXPORT_OPEN_FAILED');
        await input.sessionArea.set({ [indexKey(tab.id)]: auditId });
        await input.chromeApi.tabs.update(tab.id, { url: canonicalUrl(input.chromeApi,auditId), active:false });
        const current = await getLaunch(auditId);
        if (!current || current.tabId !== tab.id || current.state !== 'allocated') throw new Error('EXPORT_OPEN_FAILED');
        const awaiting = deepFreeze({...current,state:'awaiting-connection'});
        if (!await confirmed(input.sessionArea,launchKey(auditId),awaiting,launchRecord)) throw new Error('EXPORT_OPEN_FAILED');
        return deepFreeze({ok:true,auditId,state:'awaiting-connection'});
      } catch {
        const current = await getLaunch(auditId).catch(() => null);
        if (current && current.attemptId === attemptId && !['terminal','revoked'].includes(current.state)) {
          await confirmed(input.sessionArea,launchKey(auditId),deepFreeze({...current,state:'revoked'}),launchRecord).catch(() => null);
        }
        await input.auditStore.releaseExportLease(auditId, {
          ownerId: ownerSeed, now: leaseNow,
        }).catch(() => false);
        if (ownedTabId !== null) { try { await input.chromeApi.tabs.remove?.(ownedTabId); } catch {} }
        return fail('EXPORT_OPEN_FAILED');
      }
    });
  }

  async function sourceActive(launch) {
    if (typeof input.reportLaunch.validateConsumer === 'function') return input.reportLaunch.validateConsumer(launch.sourceReviewSessionCapabilityId,launch.auditId);
    const consumer = await input.reportLaunch.getConsumer?.(launch.sourceReviewSessionCapabilityId);
    return consumer?.auditId === launch.auditId && consumer.state === 'active';
  }

  async function connect({auditId,sender}={}) {
    if (!AUDIT_ID.test(auditId ?? '')) return fail('EXPORT_CONNECT_DENIED');
    let context; try { context = await deriveTrustedExtensionContext({sender,chromeApi:input.chromeApi,surface:EXPORT_SURFACE}); } catch { return fail('CONTEXT_DENIED'); }
    return serialize(input.sessionArea,auditId,async()=>{
      const launch=await getLaunch(auditId); const now=readEpoch(input.epochNow);
      if (!launch || !['allocated','awaiting-connection'].includes(launch.state) || launch.expiresAt<=now ||
        launch.tabId!==context.tabId || launch.windowId!==context.windowId || context.documentUrl!==canonicalUrl(input.chromeApi,auditId) || !await sourceActive(launch)) return fail('EXPORT_CONNECT_DENIED');
      const sessionCapabilityId=opaqueId(input.randomBytes);
      const session=deepFreeze({version:1,sessionCapabilityId,auditId,launchTabId:launch.tabId,launchDocumentId:sender.documentId,
        expectedRevision:launch.expectedRevision,attemptId:launch.attemptId,intents:['execute-export','complete-export'],state:'active',issuedAt:now,expiresAt:launch.expiresAt});
      if (!await confirmed(input.sessionArea,sessionKey(sessionCapabilityId),session,sessionRecord)) return fail('EXPORT_CONNECT_DENIED');
      const current=await getLaunch(auditId);
      if (!current || current.state!==launch.state || current.tabId!==launch.tabId) { await confirmed(input.sessionArea,sessionKey(sessionCapabilityId),deepFreeze({...session,state:'revoked'}),sessionRecord); return fail('EXPORT_CONNECT_DENIED'); }
      if (!await confirmed(input.sessionArea,launchKey(auditId),deepFreeze({...launch,documentId:sender.documentId,state:'connected'}),launchRecord)) return fail('EXPORT_CONNECT_DENIED');
      return deepFreeze({
        ok:true, sessionCapabilityId, auditId, expectedRevision:launch.expectedRevision, attemptId:launch.attemptId,
        formats: launch.formats === undefined ? EXPORT_FORMATS_V1 : canonicalExportFormatsV1(launch.formats),
      });
    });
  }

  async function complete({sessionCapabilityId,auditId,attemptId,sender}={}) {
    if (!CAPABILITY.test(sessionCapabilityId ?? '') || !AUDIT_ID.test(auditId ?? '') || !validAttempt(attemptId)) return fail('EXPORT_COMPLETE_DENIED');
    let context; try { context=await deriveTrustedExtensionContext({sender,chromeApi:input.chromeApi,surface:EXPORT_SURFACE}); } catch { return fail('CONTEXT_DENIED'); }
    return serialize(input.sessionArea,auditId,async()=>{
      const [launch,session]=await Promise.all([getLaunch(auditId),getSession(sessionCapabilityId)]);
      const documentId=context.issuer.documentId;
      const correlated = launch && launch.auditId===auditId && launch.attemptId===attemptId && launch.documentId===documentId &&
        launch.tabId===context.tabId && launch.windowId===context.windowId && context.documentUrl===canonicalUrl(input.chromeApi,auditId) &&
        session && session.sessionCapabilityId===sessionCapabilityId && session.auditId===auditId && session.attemptId===attemptId &&
        session.expectedRevision===launch.expectedRevision && session.launchTabId===launch.tabId && session.launchDocumentId===documentId &&
        session.expiresAt===launch.expiresAt;
      const active = launch?.state==='connected' && session?.state==='active';
      const terminal = launch?.state==='terminal' && session?.state==='terminal';
      if (!correlated || (!active && !terminal)) return fail('EXPORT_COMPLETE_DENIED');
      if (active) {
        const now=readEpoch(input.epochNow);
        if (session.expiresAt<=now || launch.expiresAt<=now) return fail('EXPORT_COMPLETE_DENIED');
      }

      let terminalLaunch=launch;
      let terminalSession=session;
      let proof;
      let receipt=null;
      if (active) {
        receipt=exportReceiptRecord(await input.auditStore.getExportReceipt?.(auditId), {
          auditId,attemptId,modelRevision:launch.expectedRevision,
        });
        if (!receipt) return fail('EXPORT_RECEIPT_DENIED');
        proof=deepFreeze({version:1,auditId,sessionCapabilityId,attemptId,modelRevision:launch.expectedRevision,
          receiptStatus:receipt.status,applied:false,deleted:false,status:null,notified:false});
        const persisted=await persistTerminal(launch,session,proof);
        if (!persisted) return fail('EXPORT_COMPLETE_DENIED');
        ({ launch: terminalLaunch, session: terminalSession }=persisted);
      } else {
        const launchProof=terminalProofRecord(launch.terminalProof);
        const sessionProof=terminalProofRecord(session.terminalProof);
        if (!proofMatchesLaunch(launchProof,launch) || !proofMatchesSession(sessionProof,session) ||
          !sameTerminalProof(launchProof,sessionProof) || launchProof.sessionCapabilityId!==sessionCapabilityId) {
          return fail('EXPORT_COMPLETE_DENIED');
        }
        proof=launchProof;
      }

      if (!proof.applied) {
        const completionOptions=receipt
          ? deepFreeze({attemptId,receipt,terminalProof:proof})
          : deepFreeze({attemptId,terminalProof:proof});
        const completed=await input.auditStore.completeExport?.(auditId,completionOptions);
        proof=deepFreeze({...proof,applied:true,
          deleted:proof.receiptStatus==='complete' && completed?.deleted===true,
          status:proof.receiptStatus==='partial' || completed?.status==='partial' ? 'partial' : 'complete'});
        const persisted=await persistTerminal(terminalLaunch,terminalSession,proof);
        if (!persisted) return fail('EXPORT_COMPLETE_DENIED');
        ({ launch: terminalLaunch, session: terminalSession }=persisted);
      }
      if (!proof.notified) {
        await input.auditStore.emitTerminal?.(deepFreeze({ type:'EXPORT_COMPLETE',auditId,
          deleted:proof.deleted,status:proof.status,exportRevision:proof.modelRevision+1 }));
        proof=deepFreeze({...proof,notified:true});
        const persisted=await persistTerminal(terminalLaunch,terminalSession,proof);
        if (!persisted) return fail('EXPORT_COMPLETE_DENIED');
      }
      return deepFreeze({ok:true,auditId,state:'terminal'});

      async function persistTerminal(currentLaunch,currentSession,terminalProof) {
        const nextSession=deepFreeze({...currentSession,state:'terminal',terminalProof});
        const nextLaunch=deepFreeze({...currentLaunch,state:'terminal',terminalProof});
        await input.sessionArea.set({[sessionKey(sessionCapabilityId)]:nextSession,[launchKey(auditId)]:nextLaunch});
        const [confirmedSession,confirmedLaunch]=await Promise.all([getSession(sessionCapabilityId),getLaunch(auditId)]);
        if (!confirmedSession || confirmedSession.state!=='terminal' || !confirmedLaunch || confirmedLaunch.state!=='terminal' ||
          JSON.stringify(confirmedSession)!==JSON.stringify(nextSession) || JSON.stringify(confirmedLaunch)!==JSON.stringify(nextLaunch) ||
          !sameTerminalProof(confirmedSession.terminalProof,terminalProof) || !sameTerminalProof(confirmedLaunch.terminalProof,terminalProof)) return null;
        return Object.freeze({launch:confirmedLaunch,session:confirmedSession});
      }
    });
  }

  async function revoke(launch) {
    if (!launch || ['terminal','revoked'].includes(launch.state)) return false;
    let envelope;
    try { envelope=await input.sessionArea.get(null); } catch { return false; }
    for (const [key,value] of Object.entries(envelope ?? {})) {
      const session=key.startsWith('audita:export-session:v1:')?sessionRecord(value):null;
      if (session?.auditId===launch.auditId && session.state==='active') {
        try {
          if (!await confirmed(input.sessionArea,key,deepFreeze({...session,state:'revoked'}),sessionRecord)) return false;
        } catch { return false; }
      }
    }
    try {
      if (!await confirmed(input.sessionArea,launchKey(launch.auditId),deepFreeze({...launch,state:'revoked'}),launchRecord)) return false;
    } catch { return false; }
    const owners = launch.state === 'connected'
      ? [deriveExportLeaseOwner(launch.auditId, launch.attemptId), `export:${launch.auditId}:pending`]
      : [`export:${launch.auditId}:pending`, deriveExportLeaseOwner(launch.auditId, launch.attemptId)];
    for (const ownerId of owners) {
      try {
        if (await input.auditStore.releaseExportLease(launch.auditId, { ownerId, now: input.modelNow() })) break;
      } catch { /* the alternate owner can still be attempted */ }
    }
    try { await input.chromeApi.tabs.remove?.(launch.tabId); } catch {}
    return true;
  }

  async function deletionGraph(auditId) {
    const inventory = await input.sessionArea.get(null);
    const root = exact(inventory, Reflect.ownKeys(inventory));
    if (!root) throw new Error('EXPORT_CLEANUP_DENIED');
    const rows = new Map();
    const targets = new Map();
    const addTarget = (tabId, windowId, documentId) => {
      let target = targets.get(tabId);
      if (!target) {
        target = { tabId, windowId, documents: new Set(), launch: null };
        targets.set(tabId, target);
      }
      if (windowId !== null) {
        if (target.windowId !== null && target.windowId !== windowId) throw new Error('EXPORT_CLEANUP_DENIED');
        target.windowId = windowId;
      }
      if (documentId !== null) target.documents.add(documentId);
      return target;
    };
    for (const [key, value] of Object.entries(root)) {
      if (key === launchKey(auditId)) {
        const launch = launchRecord(value);
        if (!launch || launch.auditId !== auditId) throw new Error('EXPORT_CLEANUP_DENIED');
        rows.set(key, launch); addTarget(launch.tabId, launch.windowId, launch.documentId).launch = launch;
      } else if (key.startsWith('audita:export-launch:v1:') && ownDataDescriptor(value, 'auditId')?.value === auditId) {
        throw new Error('EXPORT_CLEANUP_DENIED');
      } else if (key.startsWith('audita:export-session:v1:') && ownDataDescriptor(value, 'auditId')?.value === auditId) {
        const session = sessionRecord(value);
        if (!session || key !== sessionKey(session.sessionCapabilityId)) throw new Error('EXPORT_CLEANUP_DENIED');
        rows.set(key, session); addTarget(session.launchTabId, null, session.launchDocumentId);
      } else if (key.startsWith('audita:export-launch-tab:v1:') && value === auditId) {
        const tabId = Number(key.slice('audita:export-launch-tab:v1:'.length));
        if (!safeId(tabId) || key !== indexKey(tabId)) throw new Error('EXPORT_CLEANUP_DENIED');
        rows.set(key, value);
      }
    }
    for (const target of targets.values()) {
      const key = indexKey(target.tabId);
      if (Object.hasOwn(root, key) && root[key] !== auditId) throw new Error('EXPORT_CLEANUP_DENIED');
      rows.set(key, root[key]);
    }
    return { rows, targets: [...targets.values()].sort((left, right) => left.tabId - right.tabId) };
  }

  async function deletionRowsMatch(rows) {
    const inventory = await input.sessionArea.get([...rows.keys()]);
    const root = exact(inventory, Reflect.ownKeys(inventory));
    if (!root || Object.keys(root).some(key => !rows.has(key))) return false;
    for (const [key, expected] of rows) {
      if (expected === undefined) { if (Object.hasOwn(root, key)) return false; }
      else if (typeof expected === 'string') { if (root[key] !== expected) return false; }
      else {
        const actual = exact(root[key], Object.keys(expected));
        if (!actual) return false;
        if (Object.hasOwn(expected, 'terminalProof')) {
          const proof = terminalProofRecord(actual.terminalProof);
          if (!sameTerminalProof(proof, expected.terminalProof)) return false;
          actual.terminalProof = proof;
        }
        if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
      }
    }
    return true;
  }

  async function replaceDeletionRows(rows, replacements) {
    if (!await deletionRowsMatch(rows)) return false;
    if (Object.keys(replacements).length > 0) {
      try { await input.sessionArea.set(replacements); } catch { /* readback resolves an ambiguous write */ }
      for (const [key, value] of Object.entries(replacements)) rows.set(key, value);
    }
    return deletionRowsMatch(rows);
  }

  async function tabAbsenceConfirmed(tabId) {
    if (typeof input.chromeApi.tabs.query !== 'function') return false;
    const tabs = await input.chromeApi.tabs.query({});
    if (!Array.isArray(tabs)) return false;
    for (const tab of tabs) {
      const id = ownDataDescriptor(tab, 'id');
      if (!id || !safeId(id.value) || id.value === tabId) return false;
    }
    return true;
  }

  async function deletionDocumentProof(target, auditId) {
    let tab;
    try { tab = tabSnapshot(await input.chromeApi.tabs.get(target.tabId)); }
    catch { return await tabAbsenceConfirmed(target.tabId) ? { absent: true } : null; }
    const expectedUrl = canonicalUrl(input.chromeApi, auditId);
    const observed = { tabId: target.tabId, windowId: target.windowId ?? tab?.windowId };
    if (!safeId(observed.windowId) || !exactConnectedTab(tab, observed, expectedUrl)) return null;
    const contexts = await input.chromeApi.runtime.getContexts({ tabIds: [target.tabId], contextTypes: ['TAB'] });
    if (!Array.isArray(contexts) || contexts.length !== 1) return null;
    const context = contexts[0];
    if (context?.contextType !== 'TAB' || context.tabId !== target.tabId || context.windowId !== observed.windowId ||
      context.documentUrl !== expectedUrl || typeof context.documentId !== 'string' || !context.documentId) return null;
    if (!target.documents.has(context.documentId) && target.launch?.documentId !== null) return null;
    const stableTab = tabSnapshot(await input.chromeApi.tabs.get(target.tabId));
    if (!exactConnectedTab(stableTab, observed, expectedUrl)) return null;
    return { absent: false, documentId: context.documentId };
  }

  async function clearAudit(auditId) {
    try { canonicalAuditId(auditId); } catch { return false; }
    return serialize(input.sessionArea, auditId, async () => {
      try {
        if (typeof input.sessionArea.remove !== 'function' || typeof input.chromeApi.tabs.remove !== 'function') return false;
        const { rows, targets } = await deletionGraph(auditId);
        if (rows.size === 0) return true;
        const revoked = {};
        for (const [key, value] of rows) {
          if (value && typeof value === 'object' && value.state !== 'revoked') {
            const record = { ...value, state: 'revoked' };
            delete record.terminalProof;
            revoked[key] = deepFreeze(record);
          }
        }
        if (!await replaceDeletionRows(rows, revoked)) return false;
        for (const target of targets) {
          let proof = await deletionDocumentProof(target, auditId);
          if (!proof) return false;
          if (!proof.absent && target.launch?.documentId === null) {
            const key = launchKey(auditId);
            const bound = deepFreeze({ ...rows.get(key), documentId: proof.documentId });
            if (!await replaceDeletionRows(rows, { [key]: bound })) return false;
            target.launch = bound; target.documents.add(proof.documentId);
          }
          if (!await deletionRowsMatch(rows)) return false;
          if (!proof.absent) {
            proof = await deletionDocumentProof(target, auditId);
            if (!proof) return false;
            if (!proof.absent) {
              try { await input.chromeApi.tabs.remove(target.tabId); } catch { /* only confirmed absence allows cleanup */ }
              if (!await tabAbsenceConfirmed(target.tabId)) return false;
            }
          }
        }
        if (!await deletionRowsMatch(rows)) return false;
        const keys = [...rows].filter(([, value]) => value !== undefined).map(([key]) => key);
        try { await input.sessionArea.remove(keys); } catch { /* verify even when removal reports failure */ }
        return deletionRowsMatch(new Map([...rows.keys()].map(key => [key, undefined])));
      } catch { return false; }
    });
  }
  async function auditForTab(tabId) { const result=await input.sessionArea.get(indexKey(tabId)); const value=result?.[indexKey(tabId)]; return AUDIT_ID.test(value??'')?value:null; }
  async function readOwnedTab(launch) {
    try { return tabSnapshot(await input.chromeApi.tabs.get(launch.tabId)); } catch { return null; }
  }
  async function connectedDocumentIsCurrent(launch, expectedUrl) {
    const tab = await readOwnedTab(launch);
    if (!exactConnectedTab(tab, launch, expectedUrl)) return false;
    let contexts;
    try { contexts = await input.chromeApi.runtime.getContexts({ documentIds: [launch.documentId] }); } catch { return false; }
    return Array.isArray(contexts) && contexts.filter(context => context?.contextType === 'TAB' &&
      context.documentId === launch.documentId && context.documentUrl === expectedUrl &&
      context.tabId === launch.tabId && context.windowId === launch.windowId).length === 1;
  }
  async function handleTabUpdated(tabId,changeInfo) {
    const auditId=safeId(tabId)?await auditForTab(tabId):null;
    if(!auditId)return revokeInvalidSourceExports();
    return serialize(input.sessionArea,auditId,async()=>{
      const launch=await getLaunch(auditId);
      if(!launch||launch.tabId!==tabId||['terminal','revoked'].includes(launch.state))return false;
      const url=typeof changeInfo?.url==='string'?changeInfo.url:null;
      const navigationStarted=url!==null||changeInfo?.status==='loading';
      if(!navigationStarted)return false;
      const expectedUrl=canonicalUrl(input.chromeApi,auditId);
      if(launch.state==='connected'){
        if(await connectedDocumentIsCurrent(launch,expectedUrl))return false;
        return revoke(launch);
      }
      if(url!==null&&url!=='about:blank'&&url!==expectedUrl)return revoke(launch);
      const current=await readOwnedTab(launch);
      if(exactStagingTab(current,launch,expectedUrl))return false;
      // A navegação iniciada pela própria autoridade passa por estados intermediários; revogar em cima deles
      // era o defeito medido (N-2). A tolerância vale só dentro da janela e só para o estado pendente.
      const ageMs=readEpoch(input.epochNow)-launch.issuedAt;
      if(stagingNavigationPending(current,launch,expectedUrl)&&Number.isFinite(ageMs)&&ageMs>=0&&ageMs<=STAGING_GRACE_MS)return false;
      return revoke(launch);
    });
  }
  async function revokeInvalidSourceExports(){
    const envelope=await input.sessionArea.get(null);let changed=false;
    for(const [key,value] of Object.entries(envelope??{})){
      const launch=key.startsWith('audita:export-launch:v1:')?launchRecord(value):null;
      if(launch&&!['terminal','revoked'].includes(launch.state)){
        try {
          if(!await sourceActive(launch)) changed=await serialize(input.sessionArea,launch.auditId,()=>revokeCapturedLaunch(launch))||changed;
        } catch { /* one unavailable source cannot block later independent revocations */ }
      }
    }
    return changed;
  }
  async function revokeCapturedLaunch(captured) {
    const current = await getLaunch(captured.auditId);
    if (!current || JSON.stringify(current) !== JSON.stringify(captured)) return false;
    return revoke(current);
  }
  async function handleTabRemoved(tabId) {
    const auditId = safeId(tabId) ? await auditForTab(tabId) : null;
    if (!auditId) return revokeInvalidSourceExports();
    return serialize(input.sessionArea, auditId, async () => {
      const current = await getLaunch(auditId);
      return current?.tabId === tabId ? revoke(current) : false;
    });
  }
  async function handleWindowRemoved(windowId) {
    if (!safeId(windowId)) return false;
    const envelope = await input.sessionArea.get(null);
    let changed = false;
    for (const [key, value] of Object.entries(envelope ?? {})) {
      const launch = key.startsWith('audita:export-launch:v1:') ? launchRecord(value) : null;
      if (launch?.windowId === windowId) {
        changed = await serialize(input.sessionArea, launch.auditId, () => revokeCapturedLaunch(launch)) || changed;
      }
    }
    return await revokeInvalidSourceExports() || changed;
  }

  return deepFreeze({requestExport,connect,complete,getLaunch,getSession,handleTabUpdated,handleTabRemoved,handleWindowRemoved,clearAudit});
}
