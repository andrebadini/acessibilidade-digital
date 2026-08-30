import { EXPORT_SURFACE, deriveTrustedExtensionContext } from './target-capabilities.js';
import { EXPORT_FORMATS_V1 } from '../export/export-formats.js';

const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const CAPABILITY = /^[A-Za-z0-9_-]{22}$/u;
const ATTEMPT = /^[1-9][0-9]*$/u;
const EXPORT_MIME_V1 = Object.freeze({
  html: 'text/html;charset=utf-8', pdf: 'application/pdf',
  csv: 'text/csv;charset=utf-8', json: 'application/json;charset=utf-8',
});
const PATH = '/src/export/index.html';
const TTL_MS = 15 * 60 * 1000;
const SHARED_QUEUES = new WeakMap();
const launchKey = auditId => `audita:export-launch:v1:${auditId}`;
const indexKey = tabId => `audita:export-launch-tab:v1:${tabId}`;
const sessionKey = id => `audita:export-session:v1:${id}`;

function fail(code) { return Object.freeze({ ok: false, code }); }
function safeId(value) { return Number.isSafeInteger(value) && value >= 0; }
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
function launchRecord(value) {
  const row = exact(value, ['version','auditId','sourceReviewSessionCapabilityId','expectedRevision','attemptId','tabId','windowId','path','documentId','state','issuedAt','expiresAt']);
  if (!row || row.version !== 1 || !AUDIT_ID.test(row.auditId ?? '') || !CAPABILITY.test(row.sourceReviewSessionCapabilityId ?? '') ||
    !Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 1 || !validAttempt(row.attemptId) || !safeId(row.tabId) || !safeId(row.windowId) ||
    row.path !== PATH || !['allocated','awaiting-connection','connected','terminal','revoked'].includes(row.state) ||
    !Number.isSafeInteger(row.issuedAt) || !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= row.issuedAt ||
    (['allocated','awaiting-connection'].includes(row.state) ? row.documentId !== null : typeof row.documentId !== 'string' || !row.documentId)) return null;
  return deepFreeze(row);
}
function sessionRecord(value) {
  const row = exact(value, ['version','sessionCapabilityId','auditId','launchTabId','launchDocumentId','expectedRevision','attemptId','intents','state','issuedAt','expiresAt']);
  if (!row || row.version !== 1 || !CAPABILITY.test(row.sessionCapabilityId ?? '') || !AUDIT_ID.test(row.auditId ?? '') ||
    !safeId(row.launchTabId) || typeof row.launchDocumentId !== 'string' || !row.launchDocumentId ||
    !Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 1 || !validAttempt(row.attemptId) ||
    !Array.isArray(row.intents) || row.intents.length !== 2 || row.intents[0] !== 'execute-export' || row.intents[1] !== 'complete-export' ||
    !['active','terminal','revoked'].includes(row.state) || !Number.isSafeInteger(row.issuedAt) || !Number.isSafeInteger(row.expiresAt)) return null;
  return deepFreeze(row);
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
    typeof input.chromeApi?.tabs?.create !== 'function' || typeof input.chromeApi.tabs.update !== 'function' || typeof input.sessionArea?.get !== 'function' ||
    typeof input.sessionArea.set !== 'function' || typeof input.auditStore?.getAuditSnapshot !== 'function' || typeof input.auditStore.acquireExportLease !== 'function' ||
    typeof input.reportLaunch?.authorizeExport !== 'function' || typeof input.epochNow !== 'function' || typeof input.modelNow !== 'function' || typeof input.randomBytes !== 'function') {
    throw new TypeError('EXPORT_LAUNCH_INVALID');
  }
  const getLaunch = auditId => AUDIT_ID.test(auditId ?? '') ? stored(input.sessionArea, launchKey(auditId), launchRecord) : Promise.resolve(null);
  const getSession = id => CAPABILITY.test(id ?? '') ? stored(input.sessionArea, sessionKey(id), sessionRecord) : Promise.resolve(null);

  async function requestExport({ auditId, sessionCapabilityId, sender } = {}) {
    const authorization = await input.reportLaunch.authorizeExport({ auditId, sessionCapabilityId, sender });
    if (!authorization?.ok) return fail(authorization?.code === 'CONTEXT_DENIED' ? 'CONTEXT_DENIED' : 'REPORT_EXPORT_DENIED');
    return serialize(input.sessionArea, auditId, async () => {
      const active = await getLaunch(auditId);
      if (active && !['terminal','revoked'].includes(active.state) && active.expiresAt > readEpoch(input.epochNow)) return fail('EXPORT_ALREADY_ACTIVE');
      const snapshot = await input.auditStore.getAuditSnapshot(auditId);
      if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) return fail('EXPORT_REVISION_DENIED');
      const ownerSeed = `export:${auditId}:pending`;
      const lease = await input.auditStore.acquireExportLease(auditId, snapshot.capability, { ownerId: ownerSeed, now: input.modelNow() });
      if (!lease?.acquired || !Number.isSafeInteger(lease.exportAttempt) || lease.exportAttempt < 1 || lease.revision !== snapshot.revision) return fail('EXPORT_LEASE_DENIED');
      const attemptId = String(lease.exportAttempt);
      const tab = await input.chromeApi.tabs.create({ url: 'about:blank', active: false, windowId: authorization.windowId });
      if (!safeId(tab?.id) || tab.windowId !== authorization.windowId) return fail('EXPORT_OPEN_FAILED');
      const now = readEpoch(input.epochNow);
      const launch = deepFreeze({ version:1,auditId,sourceReviewSessionCapabilityId:sessionCapabilityId,expectedRevision:snapshot.revision,
        attemptId,tabId:tab.id,windowId:authorization.windowId,path:PATH,documentId:null,state:'allocated',issuedAt:now,expiresAt:now+TTL_MS });
      if (!await confirmed(input.sessionArea, launchKey(auditId), launch, launchRecord)) return fail('EXPORT_OPEN_FAILED');
      await input.sessionArea.set({ [indexKey(tab.id)]: auditId });
      try { await input.chromeApi.tabs.update(tab.id, { url: canonicalUrl(input.chromeApi,auditId), active:false }); }
      catch { await confirmed(input.sessionArea,launchKey(auditId),deepFreeze({...launch,state:'revoked'}),launchRecord); try { await input.chromeApi.tabs.remove?.(tab.id); } catch {} return fail('EXPORT_OPEN_FAILED'); }
      const awaiting = deepFreeze({...launch,state:'awaiting-connection'});
      if (!await confirmed(input.sessionArea,launchKey(auditId),awaiting,launchRecord)) return fail('EXPORT_OPEN_FAILED');
      return deepFreeze({ok:true,auditId,attemptId,state:'awaiting-connection'});
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
      return deepFreeze({ok:true,sessionCapabilityId,auditId,expectedRevision:launch.expectedRevision,attemptId:launch.attemptId});
    });
  }

  async function complete({sessionCapabilityId,auditId,attemptId,sender}={}) {
    if (!CAPABILITY.test(sessionCapabilityId ?? '') || !AUDIT_ID.test(auditId ?? '') || !validAttempt(attemptId)) return fail('EXPORT_COMPLETE_DENIED');
    let context; try { context=await deriveTrustedExtensionContext({sender,chromeApi:input.chromeApi,surface:EXPORT_SURFACE}); } catch { return fail('CONTEXT_DENIED'); }
    return serialize(input.sessionArea,auditId,async()=>{
      const [launch,session]=await Promise.all([getLaunch(auditId),getSession(sessionCapabilityId)]); const now=readEpoch(input.epochNow);
      if (!launch || launch.state!=='connected' || launch.attemptId!==attemptId || launch.documentId!==sender.documentId ||
        launch.tabId!==context.tabId || launch.windowId!==context.windowId || !session || session.state!=='active' || session.expiresAt<=now ||
        session.auditId!==auditId || session.attemptId!==attemptId || session.expectedRevision!==launch.expectedRevision || session.launchDocumentId!==sender.documentId) return fail('EXPORT_COMPLETE_DENIED');
      const receipt=await input.auditStore.getExportReceipt?.(auditId);
      if (!receipt || receipt.status!=='complete' || receipt.auditId!==auditId || receipt.attemptId!==attemptId || receipt.modelRevision!==launch.expectedRevision ||
        !Array.isArray(receipt.formats) || receipt.formats.length!==EXPORT_FORMATS_V1.length || receipt.formats.some((row,index)=>
          row?.format!==EXPORT_FORMATS_V1[index] || row.mimeType!==EXPORT_MIME_V1[row.format] || row.state!=='complete' ||
          !Number.isSafeInteger(row.byteSize) || row.byteSize<0 || !/^[a-f0-9]{64}$/u.test(row.sha256??'') ||
          !Number.isSafeInteger(row.downloadId) || row.downloadId<0)) return fail('EXPORT_RECEIPT_DENIED');
      const terminalSession=await confirmed(input.sessionArea,sessionKey(sessionCapabilityId),deepFreeze({...session,state:'terminal'}),sessionRecord);
      if (!terminalSession) return fail('EXPORT_COMPLETE_DENIED');
      const latest=await getLaunch(auditId);
      if (!latest || latest.state!=='connected') return fail('EXPORT_COMPLETE_DENIED');
      if (!await confirmed(input.sessionArea,launchKey(auditId),deepFreeze({...latest,state:'terminal'}),launchRecord)) return fail('EXPORT_COMPLETE_DENIED');
      await input.auditStore.completeExport?.(auditId,{attemptId,receipt});
      return deepFreeze({ok:true,auditId,state:'terminal'});
    });
  }

  async function revoke(launch) {
    if (!launch || ['terminal','revoked'].includes(launch.state)) return false;
    const envelope=await input.sessionArea.get(null);
    for (const [key,value] of Object.entries(envelope ?? {})) {
      const session=key.startsWith('audita:export-session:v1:')?sessionRecord(value):null;
      if (session?.auditId===launch.auditId && session.state==='active') await confirmed(input.sessionArea,key,deepFreeze({...session,state:'revoked'}),sessionRecord);
    }
    await confirmed(input.sessionArea,launchKey(launch.auditId),deepFreeze({...launch,state:'revoked'}),launchRecord); return true;
  }
  async function auditForTab(tabId) { const result=await input.sessionArea.get(indexKey(tabId)); const value=result?.[indexKey(tabId)]; return AUDIT_ID.test(value??'')?value:null; }
  async function handleTabUpdated(tabId,changeInfo) {
    const auditId=safeId(tabId)?await auditForTab(tabId):null; if(!auditId)return false;
    return serialize(input.sessionArea,auditId,async()=>{const launch=await getLaunch(auditId);if(!launch||launch.tabId!==tabId)return false;
      let url=typeof changeInfo?.url==='string'?changeInfo.url:null;if(!url&&changeInfo?.status==='loading')url=canonicalUrl(input.chromeApi,auditId);
      if(launch.state==='connected' || (url&&url!==canonicalUrl(input.chromeApi,auditId)))return revoke(launch);return false;});
  }
  async function handleTabRemoved(tabId){const auditId=safeId(tabId)?await auditForTab(tabId):null;if(!auditId)return false;return serialize(input.sessionArea,auditId,async()=>revoke(await getLaunch(auditId)));}
  async function handleWindowRemoved(windowId){if(!safeId(windowId))return false;const envelope=await input.sessionArea.get(null);let changed=false;for(const [key,value] of Object.entries(envelope??{})){const launch=key.startsWith('audita:export-launch:v1:')?launchRecord(value):null;if(launch?.windowId===windowId){changed=await serialize(input.sessionArea,launch.auditId,()=>revoke(launch))||changed;}}return changed;}

  return deepFreeze({requestExport,connect,complete,getLaunch,getSession,handleTabUpdated,handleTabRemoved,handleWindowRemoved});
}
