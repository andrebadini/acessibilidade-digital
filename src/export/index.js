import { createDownloadsAdapter, reconcileStaleDownloads } from '../browser/download-artifacts.js';
import { createInstalledCoreRuleInventory } from '../core/rules/core-rule-inventory.js';
import { createAuditModel } from '../core/report/audit-model.js';
import { verifyAuditIntegritySnapshot } from '../core/report/integrity.js';
import { createPanelResultBundleV1 } from '../panel/panel-result-bundle.js';
import { buildReportView } from '../review/report-view.js';
import { normalizeReviewAuditId } from '../review/review-state.js';
import { createAuditStore, isAuditExportLeaseConflict, isAuditRevisionConflict } from '../storage/audit-store.js';
import { deriveExportLeaseOwner } from '../background/export-launch.js';
import { createExportTabAdapter } from './chrome-export-adapter.js';
import {
  createExportFailureRequest,
  createExportSuccessRequest,
  persistExportFailure,
  persistExportSuccess,
} from './export-controller.js';
import { runReportExport } from './report-export.js';

const status = document.querySelector('#export-status');
const store = createAuditStore();
const downloadsAdapter = createDownloadsAdapter(chrome);
const auditId = normalizeReviewAuditId(new URL(location.href).searchParams.get('auditId'));
let sourceModel = null;
let sourceRevision = null;
let sourceSnapshotCapability = null;
let exportAttempt = null;
let leaseOwnerId = null;
let latestState = null;
let leaseClaimed = false;
let completionPending = false;

function sendWorkerRequest(message) {
  return new Promise(resolve => {
    try { chrome.runtime.sendMessage(message, response => resolve(chrome.runtime.lastError ? { ok: false } : response)); }
    catch { resolve({ ok: false }); }
  });
}

void start().catch(error => fail(error));

async function start() {
  if (!auditId) throw new TypeError('Auditoria não identificada.');
  const connected = await sendWorkerRequest({ type: 'EXPORT_CONNECT', auditId });
  if (!connected?.ok || connected.auditId !== auditId || !Number.isSafeInteger(connected.expectedRevision) ||
    !/^[1-9][0-9]*$/u.test(connected.attemptId ?? '')) throw new TypeError('Exportação não autorizada.');
  exportAttempt = Number(connected.attemptId);
  leaseOwnerId = deriveExportLeaseOwner(auditId, connected.attemptId);
  await generate(connected);
}

async function generate(connected) {
  const [snapshot, storedRevision, inventory] = await Promise.all([
    store.getAuditSnapshot(auditId), store.getReportRevision(auditId), createInstalledCoreRuleInventory(),
  ]);
  if (!snapshot?.model || snapshot.revision !== connected.expectedRevision || storedRevision?.modelRevision !== connected.expectedRevision) {
    throw new Error('A revisão autorizada não está mais disponível.');
  }
  const verified = await verifyAuditIntegritySnapshot(createAuditModel(storedRevision.model));
  if (verified.integrity.canonicalModelHash !== storedRevision.modelHash || verified.auditId !== auditId) throw new Error('Integridade da revisão negada.');
  const bundle = await createPanelResultBundleV1({ reportRevision: storedRevision, inventory });
  const reportView = buildReportView({ model: verified, summary: bundle.summary, modelRevision: storedRevision.modelRevision, modelHash: storedRevision.modelHash });
  sourceModel = verified;
  sourceRevision = snapshot.revision;
  sourceSnapshotCapability = snapshot.capability;
  const latest = await store.getLatest();
  latestState = { ...(latest?.auditId === auditId ? latest : {}), auditId, exportStatus: 'running', exportRevision: sourceRevision,
    exportAttempt, leaseOwnerId, message: 'Gerando os arquivos do relatório.' };
  await store.claimExportLease(auditId, sourceSnapshotCapability, {
    ownerId: leaseOwnerId, exportAttempt, now: new Date().toISOString(), ttlMs: 10 * 60 * 1000, latestState,
  });
  leaseClaimed = true;
  await reconcileStaleDownloads(await store.getExportDeliveryJournal(auditId), downloadsAdapter,
    (entry, outcome) => store.resolveExportDelivery(auditId, { ...entry, now: new Date().toISOString(), outcome }),
    { auditId });
  await store.beginExportDelivery(auditId, sourceSnapshotCapability, {
    ownerId: leaseOwnerId, exportAttempt, now: new Date().toISOString(), ttlMs: 10 * 60 * 1000,
    latestState: { ...latestState, exportStatus: 'delivering', message: 'Transferindo os arquivos do relatório.' },
  });
  const result = await runReportExport({
    auditSnapshotCapability: sourceSnapshotCapability, exportLeaseOwnerId: leaseOwnerId, exportAttempt,
    manifestVersion: chrome.runtime.getManifest().version, browserVersion: verified.environment?.chromeVersion || navigator.userAgent,
    timezone: verified.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  }, {
    reportView, urlApi: globalThis.URL, tabAdapter: createExportTabAdapter(chrome), downloadsAdapter,
    assertDelivery({ snapshotCapability, exportLeaseOwnerId }) {
      if (exportLeaseOwnerId !== leaseOwnerId) throw new TypeError('Exclusividade divergente.');
      return store.assertExportLease(auditId, snapshotCapability,
        { ownerId: leaseOwnerId, exportAttempt, now: new Date().toISOString(), phase: 'delivering' });
    },
    recordDelivery({ snapshotCapability, exportLeaseOwnerId, state, format, filename, downloadId, mimeType, byteSize, sha256 }) {
      if (exportLeaseOwnerId !== leaseOwnerId) throw new TypeError('Journal divergente.');
      if (state === 'cleaned' || state === 'cleanup-failed') return store.resolveExportDelivery(auditId,
        { ownerId: leaseOwnerId, exportAttempt, now: new Date().toISOString(), format, filename,
          ...(downloadId === undefined ? {} : { downloadId }), outcome: state });
      return store.recordExportDelivery(auditId, snapshotCapability,
        { ownerId: leaseOwnerId, exportAttempt, now: new Date().toISOString(), format, filename,
          ...(downloadId === undefined ? {} : { downloadId }), mimeType, byteSize, sha256, state });
    },
  });
  await persistExportSuccess(createExportSuccessRequest({ auditId, result, latest: latestState }), store);
  leaseClaimed = false;
  completionPending = true;
  await confirmExportCompletion(connected);
  completionPending = false;
  status.textContent = 'Os quatro arquivos foram baixados e o recibo local foi confirmado.';
  await closeOwnTab();
}

async function confirmExportCompletion(connected) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const completed = await sendWorkerRequest({ type: 'EXPORT_COMPLETE', sessionCapabilityId: connected.sessionCapabilityId,
      auditId, attemptId: connected.attemptId });
    if (completed?.ok) return completed;
  }
  throw new Error('O recibo dos downloads não pôde ser confirmado.');
}

async function fail(error) {
  if (completionPending) {
    status.textContent = 'Os quatro arquivos foram baixados; a confirmação local continua pendente nesta aba.';
    return;
  }
  let message = 'Não foi possível preparar os artefatos do relatório.';
  const busy = isAuditExportLeaseConflict(error);
  const invalidated = isAuditRevisionConflict(error);
  if (leaseClaimed && sourceModel && sourceSnapshotCapability) {
    try {
      const persisted = await persistExportFailure(createExportFailureRequest({
        snapshotCapability: sourceSnapshotCapability, leaseOwnerId, exportAttempt, latest: latestState,
      }), store);
      message = persisted.latest.message;
    } catch { /* preserve fixed limitation */ }
  }
  if (busy) message = 'Este relatório já está sendo gerado em outra aba; tente novamente após a conclusão.';
  if (invalidated) message = 'A auditoria foi atualizada durante a exportação; a versão mais nova foi preservada.';
  status.textContent = message;
  if (!busy) await closeOwnTab();
}

async function closeOwnTab() {
  try { const own = await chrome.tabs.getCurrent(); if (Number.isSafeInteger(own?.id)) await chrome.tabs.remove(own.id); }
  catch { /* owned tab may already be gone */ }
}
