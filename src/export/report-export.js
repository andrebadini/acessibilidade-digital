import {
  buildArtifactBaseName,
  captureBlobLifecycle,
  downloadArtifacts,
} from '../browser/download-artifacts.js';
import { renderPdf } from '../browser/render-pdf.js';
import { renderOccurrenceCsv } from '../core/report/csv.js';
import { createAuditModel } from '../core/report/audit-model.js';
import { canonicalStringify } from '../core/report/canonical-json.js';
import { sha256Hex } from '../core/report/hash.js';
import { renderTechnicalJson } from '../core/report/earl-json.js';
import { enrichAuditForReport } from '../core/report/enrich-audit.js';
import { renderHtmlReport } from '../core/report/html.js';
import { REPORT_HASH_BASE, verifyAuditIntegritySnapshot } from '../core/report/integrity.js';
import { preparedReportFormats } from '../core/report/report-policy.js';
import { createExportDeliveryIdentityV1, EXPORT_FORMATS_V1 } from './export-formats.js';
export { EXPORT_FORMATS_V1 };
import { deriveSystemLimitations } from '../core/report/text-policy.js';
import { inspectAuditSnapshotCapability } from '../storage/audit-store.js';
import {
  captureCanonicalExportIssues,
  createExportIssue,
  issueForPrintStage,
  PDF_GENERATION_FAILURE_CODES,
  REPORT_GENERATION_ISSUE_CODES,
  reportExportInputError,
} from './export-issues.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const PDF_COMMAND_TIMEOUT_MS = 45_000;
const MAX_FINALIZATION_PASSES = 6;
const GENERATED_REPORT_RESULTS = new WeakMap();
const REPORT_REQUEST_KEYS = new Set([
  'auditModel', 'auditSnapshotCapability', 'exportLeaseOwnerId', 'exportAttempt',
  'manifestVersion', 'browserVersion', 'timezone', 'now', 'timeoutMs', 'brand',
]);
const DELIVERY_LEASE_ATTESTATION_KEYS = Object.freeze([
  'active', 'phase', 'retryAt', 'revision', 'exportAttempt', 'deliveryAt',
]);
const PENDING_REPORT_RESERVATIONS = new WeakMap();

class OwnershipTransferTimeoutError extends DOMException {
  constructor() {
    super('Operação excedeu o tempo limite.', 'TimeoutError');
  }
}

export async function runReportExport(request, dependencies) {
  const capturedRequest = captureReportExportRequest(request);
  let snapshotCapability = null;
  let exportLeaseOwnerId = null;
  let exportAttempt = null;
  let snapshotRevision = null;
  let sourceModel;
  if (capturedRequest.auditSnapshotCapability !== undefined) {
    const snapshot = inspectAuditSnapshotCapability(capturedRequest.auditSnapshotCapability);
    if (!snapshot) throw reportExportInputError();
    snapshotCapability = capturedRequest.auditSnapshotCapability;
    exportLeaseOwnerId = validLeaseOwnerId(capturedRequest.exportLeaseOwnerId);
    exportAttempt = validExportAttempt(capturedRequest.exportAttempt);
    snapshotRevision = snapshot.revision;
    sourceModel = createAuditModel(snapshot.model);
    if (typeof dependencies.assertDelivery !== 'function') {
      throw new TypeError('Revalidação da exclusividade de entrega indisponível para o snapshot persistido.');
    }
    if (typeof dependencies.recordDelivery !== 'function') {
      throw new TypeError('Journal persistente de entrega indisponível para o snapshot persistido.');
    }
  } else {
    sourceModel = createAuditModel(capturedRequest.auditModel);
  }
  validateDependencies(dependencies);
  const blobLifecycle = captureBlobLifecycle(dependencies.blobLifecycle);
  const timeoutMs = capturedRequest.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Timeout de exportação inválido.');
  const deliveryAt = snapshotCapability === null
    ? safeCanonicalNow(capturedRequest.now)
    : captureDeliveryLeaseTimestamp(await boundary(
        Promise.resolve().then(() => dependencies.assertDelivery({
          snapshotCapability,
          exportLeaseOwnerId,
          exportAttempt,
          stage: 'identity',
        })),
        timeoutMs,
        'A atestação persistente da identidade da entrega excedeu o tempo limite.',
      ), snapshotRevision, exportAttempt);
  if (snapshotCapability !== null && dependencies.reportView !== undefined) {
    return runImmutableRevisionExport({
      sourceModel,
      reportView: dependencies.reportView,
      snapshotCapability,
      exportLeaseOwnerId,
      exportAttempt,
      artifactTimestamp: deliveryAt,
      timeoutMs: capturedRequest.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      dependencies,
      blobLifecycle,
    });
  }
  const at = deliveryAt;
  if (snapshotCapability !== null) {
    sourceModel = await enrichAuditForReport(sourceModel, {
      now: () => at,
      timezone: capturedRequest.timezone ?? sourceModel.timezone,
      manifestVersion: capturedRequest.manifestVersion,
      rulesVersion: sourceModel.methodology?.version ?? sourceModel.versions?.rules,
      browserVersion: capturedRequest.browserVersion ?? sourceModel.environment?.chromeVersion,
    });
  }
  const original = sanitizeReportMessages(sourceModel);
  const generationIssues = [];
  const printCleanupLimitations = [];
  let hasCsv = true;
  let hasPdf = true;
  let expectedPdfFallback = false;
  let model = null;
  let html = null;
  let json = null;
  let csv = null;
  let pdf = null;
  let pdfFallback = false;
  let settled = false;

  for (let pass = 0; pass < MAX_FINALIZATION_PASSES; pass += 1) {
    model = await finalizeGeneratedModel(original, at, generationIssues, hasPdf, expectedPdfFallback, true, hasCsv);
    html = renderHtmlReport(model);
    json = renderTechnicalJson(model);

    if (hasCsv) {
      try {
        csv = renderCanonicalCsv(model, dependencies.csvRenderer);
      } catch {
        csv = null;
        hasCsv = false;
        addIssue(generationIssues, createExportIssue('REPORT_CSV_UNAVAILABLE'));
        continue;
      }
    } else {
      csv = null;
    }

    if (!hasPdf) {
      pdf = null;
      pdfFallback = false;
      settled = true;
      break;
    }

    const printed = await printFinalHtml(html, dependencies, timeoutMs, expectedPdfFallback, blobLifecycle);
    if (printed.cleanupLimited) {
      addUnique(printCleanupLimitations, createExportIssue('REPORT_PRINT_CLEANUP_LIMITED').message);
    }
    if (printed.issue) {
      hasPdf = false;
      expectedPdfFallback = false;
      removeIssue(generationIssues, 'REPORT_PDF_TAGGING_UNSUPPORTED');
      addIssue(generationIssues, printed.issue);
      continue;
    }
    if (printed.usedFallback !== expectedPdfFallback) {
      if (!expectedPdfFallback && printed.usedFallback) {
        expectedPdfFallback = true;
        addIssue(generationIssues, createExportIssue('REPORT_PDF_TAGGING_UNSUPPORTED'));
      } else {
        hasPdf = false;
        expectedPdfFallback = false;
        removeIssue(generationIssues, 'REPORT_PDF_TAGGING_UNSUPPORTED');
        addIssue(generationIssues, createExportIssue('REPORT_PDF_UNAVAILABLE'));
      }
      continue;
    }
    pdf = printed.bytes;
    pdfFallback = expectedPdfFallback;
    settled = true;
    break;
  }

  if (!settled) {
    hasCsv = false;
    hasPdf = false;
    expectedPdfFallback = false;
    csv = null;
    pdf = null;
    pdfFallback = false;
    removeIssue(generationIssues, 'REPORT_PDF_TAGGING_UNSUPPORTED');
    addIssue(generationIssues, createExportIssue('REPORT_CSV_UNAVAILABLE'));
    addIssue(generationIssues, createExportIssue('REPORT_PDF_UNAVAILABLE'));
    model = await finalizeGeneratedModel(original, at, generationIssues, false, false, true, false);
    html = renderHtmlReport(model);
    json = renderTechnicalJson(model);
  }

  if (snapshotCapability !== null) {
    if (typeof dependencies.reserveDelivery !== 'function') {
      throw new TypeError('Reserva atômica de entrega indisponível para o snapshot persistido.');
    }
    const previousSnapshot = inspectAuditSnapshotCapability(snapshotCapability);
    const reservation = Promise.resolve().then(() => dependencies.reserveDelivery({
      model: JSON.parse(canonicalStringify(model)),
    })).then(value => validatedReservationCapability(value, previousSnapshot, model));
    PENDING_RESERVATION_RECORDS.set(reservation, Object.freeze({
      auditId: previousSnapshot.auditId,
      previousRevision: previousSnapshot.revision,
      previousModel: canonicalStringify(previousSnapshot.model),
      expectedModel: canonicalStringify(model),
    }));
    snapshotCapability = await adoptPersistentReservation(reservation, timeoutMs);
  }

  const baseName = buildArtifactBaseName(model.auditId, at);
  const downloadOptions = {
    timeoutMs,
    ...(blobLifecycle ? { blobLifecycle } : {}),
    ...(snapshotCapability === null ? {} : {
      assertCanDownload: ({ format }) => dependencies.assertDelivery({
        snapshotCapability,
        exportLeaseOwnerId,
        format,
      }),
      recordDeliveryState: entry => dependencies.recordDelivery({
        snapshotCapability,
        exportLeaseOwnerId,
        ...entry,
      }),
    }),
  };
  const downloads = await downloadArtifacts({
    baseName, html, json, ...(csv === null ? {} : { csv }), ...(pdf ? { pdf } : {}),
  }, dependencies.downloadsAdapter, downloadOptions);
  const missingGenerationLimitations = [];
  if (csv === null) missingGenerationLimitations.push(createExportIssue('REPORT_CSV_UNAVAILABLE').message);
  if (!pdf) {
    const pdfIssue = generationIssues.find(issue => PDF_GENERATION_FAILURE_CODES.includes(issue.code));
    missingGenerationLimitations.push((pdfIssue ?? createExportIssue('REPORT_PDF_UNAVAILABLE')).message);
  }
  const deliveryLimitations = [...new Set([
    ...missingGenerationLimitations,
    ...printCleanupLimitations,
    ...downloads.limitations,
  ])];
  const deliveryReceipt = {
    status: downloads.formats.length === 4 && downloads.formats.every(format => format.status === 'complete') && deliveryLimitations.length === 0
      ? 'complete'
      : 'partial',
    formats: downloads.formats,
    limitations: deliveryLimitations,
  };
  const deliverySnapshot = snapshotCapability === null ? null : inspectAuditSnapshotCapability(snapshotCapability);
  if (snapshotCapability !== null && (!deliverySnapshot || deliverySnapshot.auditId !== model.auditId ||
    canonicalStringify(deliverySnapshot.model) !== canonicalStringify(model))) {
    throw new TypeError('Snapshot reservado não corresponde ao relatório entregue.');
  }
  const result = {
    model,
    html,
    json,
    csv,
    pdf,
    formats: downloads.formats,
    deliveryReceipt,
    limitations: [...new Set([
      ...generationIssues.map(issue => issue.message),
      ...printCleanupLimitations,
      ...downloads.limitations,
    ])],
    pdfFallback,
    ...(deliverySnapshot === null ? {} : {
      exportDeliveryIdentity: createExportDeliveryIdentityV1({
        auditId: model.auditId,
        modelRevision: deliverySnapshot.revision,
        modelHash: model.integrity.canonicalModelHash,
        attemptId: String(exportAttempt),
      }),
    }),
  };
  return attestReportExportResult(result, snapshotCapability, exportLeaseOwnerId, exportAttempt, baseName);
}

async function runImmutableRevisionExport({
  sourceModel, reportView, snapshotCapability, exportLeaseOwnerId, exportAttempt, artifactTimestamp, timeoutMs, dependencies, blobLifecycle,
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !reportView || reportView.version !== 1 ||
    reportView.auditId !== sourceModel.auditId || reportView.modelHash !== sourceModel.integrity.canonicalModelHash ||
    !Object.isFrozen(reportView)) throw reportExportInputError();
  const model = await verifyAuditIntegritySnapshot(sourceModel);
  const deliveryIdentity = createExportDeliveryIdentityV1({
    auditId: model.auditId, modelRevision: reportView.modelRevision, modelHash: reportView.modelHash,
    attemptId: String(exportAttempt),
  });
  const html = renderHtmlReport(model, { reportView, deliveryIdentity });
  const json = renderTechnicalJson(model, { deliveryIdentity });
  let csv = null;
  let pdf = null;
  let pdfFallback = false;
  const limitations = [];
  try { csv = renderCanonicalCsv(model, dependencies.csvRenderer, deliveryIdentity); }
  catch { limitations.push(createExportIssue('REPORT_CSV_UNAVAILABLE').message); }
  if (csv !== null) {
    const printed = await printFinalHtml(html, dependencies, timeoutMs, false, blobLifecycle);
    if (printed.cleanupLimited) limitations.push(createExportIssue('REPORT_PRINT_CLEANUP_LIMITED').message);
    if (printed.issue) limitations.push(printed.issue.message);
    else {
      pdf = printed.bytes;
      pdfFallback = printed.usedFallback;
      if (pdfFallback) limitations.push(createExportIssue('REPORT_PDF_TAGGING_UNSUPPORTED').message);
    }
  }
  if (!pdf && !limitations.some(value => value === createExportIssue('REPORT_PDF_UNAVAILABLE').message)) {
    limitations.push(createExportIssue('REPORT_PDF_UNAVAILABLE').message);
  }
  const baseName = buildArtifactBaseName(model.auditId, artifactTimestamp);
  const downloads = await downloadArtifacts({
    baseName, html, json, ...(csv === null ? {} : { csv }), ...(pdf ? { pdf } : {}),
  }, dependencies.downloadsAdapter, {
    timeoutMs,
    ...(blobLifecycle ? { blobLifecycle } : {}),
    assertCanDownload: ({ format }) => dependencies.assertDelivery({ snapshotCapability, exportLeaseOwnerId, format }),
    recordDeliveryState: entry => dependencies.recordDelivery({ snapshotCapability, exportLeaseOwnerId, ...entry }),
  });
  const receiptLimitations = [...new Set([...limitations, ...downloads.limitations])];
  const deliveryReceipt = {
    status: downloads.formats.length === EXPORT_FORMATS_V1.length &&
      downloads.formats.every((entry, index) => entry.status === 'complete' && entry.format === EXPORT_FORMATS_V1[index]) &&
      receiptLimitations.length === 0 ? 'complete' : 'partial',
    formats: downloads.formats,
    limitations: receiptLimitations,
  };
  return attestReportExportResult({
    model, html, json, csv, pdf, formats: downloads.formats, deliveryReceipt, exportDeliveryIdentity: deliveryIdentity,
    limitations: receiptLimitations, pdfFallback,
  }, snapshotCapability, exportLeaseOwnerId, exportAttempt, baseName);
}

/** Safe identity probe used before any reflection on a caller-provided result. */
export function isGeneratedReportExportResult(value) {
  return (typeof value === 'object' && value !== null) ? GENERATED_REPORT_RESULTS.has(value) : false;
}

/** Returns the privately bound audit snapshot capability without minting one. */
export function generatedReportExportSnapshotCapability(result) {
  const provenance = (typeof result === 'object' && result !== null) ? GENERATED_REPORT_RESULTS.get(result) : null;
  return provenance?.snapshotCapability ?? null;
}

/** Returns the privately bound persistent delivery-lease owner. */
export function generatedReportExportLeaseOwnerId(result) {
  const provenance = (typeof result === 'object' && result !== null) ? GENERATED_REPORT_RESULTS.get(result) : null;
  return provenance?.exportLeaseOwnerId ?? null;
}

/** Returns the privately bound monotonically allocated export attempt. */
export function generatedReportExportAttempt(result) {
  const provenance = (typeof result === 'object' && result !== null) ? GENERATED_REPORT_RESULTS.get(result) : null;
  return provenance?.exportAttempt ?? null;
}

/** Returns the trusted public artifact base selected once for this delivery. */
export function generatedReportExportArtifactBaseName(result) {
  const provenance = (typeof result === 'object' && result !== null) ? GENERATED_REPORT_RESULTS.get(result) : null;
  return provenance?.artifactBaseName ?? null;
}

/** Verifies a persistence-owned snapshot against the private generation record. */
export async function verifyGeneratedReportExportResult(result, snapshot) {
  try {
    const provenance = GENERATED_REPORT_RESULTS.get(result);
    if (!provenance || canonicalStringify(await projectGeneratedResult(snapshot)) !== canonicalStringify(provenance.projection)) {
      throw new TypeError();
    }
    return provenance.snapshotCapability;
  } catch {
    throw new TypeError('Proveniência dos artefatos HTML/JSON/CSV/PDF inválida ou ausente.');
  }
}

async function attestReportExportResult(result, snapshotCapability, exportLeaseOwnerId, exportAttempt, artifactBaseName) {
  try {
    if (typeof artifactBaseName !== 'string' || !/^audita-[A-Za-z0-9._-]+-\d{8}T\d{9}Z$/u.test(artifactBaseName)) {
      throw new TypeError();
    }
    const provenance = Object.freeze({
      projection: Object.freeze(await projectGeneratedResult(result)),
      snapshotCapability,
      exportLeaseOwnerId,
      exportAttempt,
      artifactBaseName,
    });
    GENERATED_REPORT_RESULTS.set(result, provenance);
    return result;
  } catch {
    throw new TypeError('Resultado final de exportação não pôde ser atestado.');
  }
}

function validLeaseOwnerId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/u.test(value)) {
    throw new TypeError('Identificador de exclusividade da exportação inválido.');
  }
  return value;
}

async function projectGeneratedResult(value) {
  return {
    model: await sha256Hex(canonicalStringify(value.model)),
    html: await generatedTextHash(value.html, false),
    json: await generatedTextHash(value.json, false),
    csv: await generatedTextHash(value.csv, true),
    pdf: await generatedBinaryHash(value.pdf, true),
    formats: await sha256Hex(canonicalStringify(value.formats)),
    deliveryReceipt: await sha256Hex(canonicalStringify(value.deliveryReceipt)),
    exportDeliveryIdentity: value.exportDeliveryIdentity === undefined ? null : await sha256Hex(canonicalStringify(createExportDeliveryIdentityV1(value.exportDeliveryIdentity))),
    limitations: await sha256Hex(canonicalStringify(value.limitations)),
    pdfFallback: value.pdfFallback === true ? true : value.pdfFallback === false ? false : invalidGeneratedValue(),
  };
}

async function generatedTextHash(value, nullable) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') throw new TypeError();
  return sha256Hex(value);
}

async function generatedBinaryHash(value, nullable) {
  if (nullable && value === null) return null;
  if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) throw new TypeError();
  return sha256Hex(value);
}

function invalidGeneratedValue() {
  throw new TypeError();
}

function safeReservationCapability(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError();
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes('revision') || !keys.includes('capability')) throw new TypeError();
    const revision = Object.getOwnPropertyDescriptor(value, 'revision');
    const capability = Object.getOwnPropertyDescriptor(value, 'capability');
    if (!revision?.enumerable || !Object.hasOwn(revision, 'value') || !Number.isSafeInteger(revision.value) || revision.value < 1 ||
      !capability?.enumerable || !Object.hasOwn(capability, 'value')) throw new TypeError();
    return capability.value;
  } catch {
    throw new TypeError('Reserva atômica de entrega inválida.');
  }
}

function validatedReservationCapability(reservation, previousSnapshot, model) {
  const reservedCapability = safeReservationCapability(reservation);
  const reservedSnapshot = inspectAuditSnapshotCapability(reservedCapability);
  if (!previousSnapshot || !reservedSnapshot || reservedSnapshot.auditId !== previousSnapshot.auditId ||
    reservedSnapshot.revision !== previousSnapshot.revision + 1 ||
    canonicalStringify(reservedSnapshot.model) !== canonicalStringify(model)) {
    throw new TypeError('Reserva atômica de entrega não corresponde ao relatório preparado.');
  }
  return reservedCapability;
}

async function adoptPersistentReservation(reservation, timeoutMs) {
  const primary = await settleWithin(reservation, timeoutMs);
  if (primary.status === 'fulfilled') return primary.value;
  if (primary.status === 'rejected') throw primary.reason;

  const grace = await settleWithin(reservation, timeoutMs);
  if (grace.status === 'fulfilled') return grace.value;
  if (grace.status === 'rejected') throw persistentReservationPendingError(reservation);
  throw persistentReservationPendingError(reservation);
}

function settleWithin(promise, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    let timer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    Promise.resolve(promise).then(
      value => finish({ status: 'fulfilled', value }),
      reason => finish({ status: 'rejected', reason }),
    );
    timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
  });
}

function persistentReservationPendingError(reservation) {
  const error = new Error('A confirmação da reserva persistente continua pendente; mantenha esta aba aberta.');
  Object.defineProperties(error, {
    name: { value: 'AuditExportReservationPendingError', enumerable: false },
    code: { value: 'AUDIT_EXPORT_RESERVATION_PENDING', enumerable: true },
  });
  const tracked = Promise.resolve(reservation);
  void tracked.catch(() => {});
  PENDING_REPORT_RESERVATIONS.set(error, tracked);
  return error;
}

export function isPendingReportReservationError(error) {
  try {
    return Boolean(error && (typeof error === 'object' || typeof error === 'function') &&
      PENDING_REPORT_RESERVATIONS.has(error));
  } catch {
    return false;
  }
}

export async function advancePendingReportReservation(error, readSnapshot, options = undefined) {
  let reservation;
  try {
    reservation = error && (typeof error === 'object' || typeof error === 'function')
      ? PENDING_REPORT_RESERVATIONS.get(error)
      : undefined;
  } catch {
    return { status: 'waiting' };
  }
  if (!reservation || typeof readSnapshot !== 'function') return { status: 'waiting' };
  const timeoutMs = pendingReservationTimeout(options);
  const settlement = await settleWithin(reservation, timeoutMs);
  if (settlement.status === 'fulfilled') {
    const snapshot = inspectAuditSnapshotCapability(settlement.value);
    if (!snapshot) return { status: 'waiting' };
    PENDING_REPORT_RESERVATIONS.delete(error);
    return { status: 'reserved', revision: snapshot.revision, snapshotCapability: settlement.value };
  }

  const currentResult = await settleWithin(
    Promise.resolve().then(() => Reflect.apply(readSnapshot, undefined, [])),
    timeoutMs,
  );
  if (currentResult.status !== 'fulfilled') return { status: 'waiting' };
  const current = safeStoredSnapshot(currentResult.value);
  const pending = pendingReservationRecord(reservation);
  if (!current || !pending || current.auditId !== pending.auditId) return { status: 'waiting' };
  if (current.revision === pending.previousRevision + 1 &&
    canonicalStringify(current.model) === pending.expectedModel) {
    PENDING_REPORT_RESERVATIONS.delete(error);
    return { status: 'reserved', revision: current.revision, snapshotCapability: current.capability };
  }
  if (current.revision > pending.previousRevision) {
    PENDING_REPORT_RESERVATIONS.delete(error);
    return { status: 'superseded' };
  }
  if (settlement.status === 'rejected' && current.revision === pending.previousRevision &&
    canonicalStringify(current.model) === pending.previousModel) {
    PENDING_REPORT_RESERVATIONS.delete(error);
    return { status: 'not-reserved', revision: current.revision, snapshotCapability: current.capability };
  }
  return { status: 'waiting' };
}

function pendingReservationTimeout(options) {
  try {
    if (options === undefined) return 5_000;
    if (!options || typeof options !== 'object' || Array.isArray(options)) return 5_000;
    const descriptor = Reflect.getOwnPropertyDescriptor(options, 'timeoutMs');
    const value = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    return Number.isFinite(value) && value > 0 ? value : 5_000;
  } catch {
    return 5_000;
  }
}

function safeStoredSnapshot(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, 'capability');
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    const snapshot = inspectAuditSnapshotCapability(descriptor.value);
    return snapshot ? { ...snapshot, capability: descriptor.value } : null;
  } catch {
    return null;
  }
}

const PENDING_RESERVATION_RECORDS = new WeakMap();

function pendingReservationRecord(reservation) {
  try { return PENDING_RESERVATION_RECORDS.get(reservation) ?? null; } catch { return null; }
}

async function printFinalHtml(html, dependencies, timeoutMs, forceCompatible, blobLifecycle) {
  let bytes = null;
  let usedFallback = false;
  let issue = null;
  let cleanupLimited = false;
  let printUrl = null;
  let tabId = null;
  let cdp = null;
  let stage = 'blob';
  let locallyRevoked = false;
  try {
    printUrl = dependencies.urlApi.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    if (typeof printUrl !== 'string' || !printUrl.startsWith('blob:')) {
      throw new TypeError('A preparação da impressão não forneceu Blob URL válido.');
    }
    if (blobLifecycle) {
      const registration = Promise.resolve().then(() => blobLifecycle.register(printUrl));
      try {
        await boundary(registration, timeoutMs, 'O registro do endereço de impressão excedeu o tempo limite.');
      } catch (error) {
        void registration.then(() => {
          if (locallyRevoked) return blobLifecycle.release(printUrl);
        }).catch(() => {});
        throw error;
      }
    }
    stage = 'tab';
    const tab = await adoptBoundary(
      dependencies.tabAdapter.createPrintTab({ url: printUrl, active: false }), timeoutMs,
      lateTab => {
        try { return dependencies.tabAdapter.removeTab(snapshotTabId(lateTab)); } catch { return undefined; }
      },
    );
    tabId = snapshotTabId(tab);
    stage = 'load';
    await boundary(dependencies.tabAdapter.waitForReady(tabId, { timeoutMs }), timeoutMs, 'A preparação da aba de impressão excedeu o tempo limite.');
    stage = 'cdp';
    cdp = await adoptBoundary(
      dependencies.tabAdapter.connectCdp(tabId, { commandTimeoutMs: PDF_COMMAND_TIMEOUT_MS }), timeoutMs,
      lateCdp => lateCdp?.disconnect?.(),
    );
    stage = 'assets';
    await boundary(dependencies.tabAdapter.waitForAssets(cdp, { timeoutMs }), timeoutMs, 'A preparação de fontes e imagens excedeu o tempo limite.');
    stage = 'pdf';
    const renderedPdf = await boundary(
      (dependencies.pdfRenderer ?? renderPdf)(cdp, forceCompatible ? { forceCompatible: true } : undefined),
      Math.max(timeoutMs, PDF_COMMAND_TIMEOUT_MS + 5_000),
      'A impressão do PDF excedeu o tempo limite.',
    );
    const checkedPdf = snapshotPdfResult(renderedPdf);
    bytes = checkedPdf.bytes;
    usedFallback = checkedPdf.usedFallback;
  } catch (error) {
    if (error instanceof OwnershipTransferTimeoutError) cleanupLimited = true;
    issue = issueForPrintStage(stage, error);
  } finally {
    if (cdp) {
      try { await boundary(cdp.disconnect(), timeoutMs, 'A desconexão de impressão excedeu o tempo limite.'); } catch { cleanupLimited = true; }
    }
    if (tabId !== null) {
      try { await boundary(dependencies.tabAdapter.removeTab(tabId), timeoutMs, 'A remoção da aba de impressão excedeu o tempo limite.'); } catch { cleanupLimited = true; }
    }
    if (printUrl !== null) {
      try { dependencies.urlApi.revokeObjectURL(printUrl); locallyRevoked = true; } catch { cleanupLimited = true; }
      if (locallyRevoked && blobLifecycle) {
        try {
          await boundary(Promise.resolve().then(() => blobLifecycle.release(printUrl)), timeoutMs,
            'A liberação do registro de impressão excedeu o tempo limite.');
        } catch { cleanupLimited = true; }
      }
    }
  }
  return { bytes, usedFallback, issue, cleanupLimited };
}

function renderCanonicalCsv(model, csvRenderer, deliveryIdentity = undefined) {
  const canonicalCsv = renderOccurrenceCsv(model, deliveryIdentity === undefined ? undefined : { deliveryIdentity });
  const renderedCsv = csvRenderer ? csvRenderer(model, deliveryIdentity) : canonicalCsv;
  if (typeof renderedCsv !== 'string' || renderedCsv !== canonicalCsv) {
    throw new TypeError('O renderizador CSV não retornou a projeção canônica esperada.');
  }
  return renderedCsv;
}

export async function finalizeGeneratedModel(model, at, issues, hasPdf, pdfFallback = false, artifactsPrepared = true, hasCsv = true) {
  const canonical = createAuditModel(model);
  const controlled = captureCanonicalExportIssues(issues, {
    allowedCodes: [...REPORT_GENERATION_ISSUE_CODES, 'REPORT_EXPORT_PREPARATION_FAILED'],
  });
  if (/^[a-f0-9]{64}$/u.test(canonical.integrity?.canonicalModelHash ?? '') &&
    /^[a-f0-9]{64}$/u.test(canonical.integrity?.evidenceManifestHash ?? '')) {
    await verifyAuditIntegritySnapshot(canonical);
  }
  const next = sanitizeReportMessages(canonical);
  const generatedAt = canonicalGeneratedAt(at);
  next.timestamps = { ...next.timestamps, generatedAt };
  next.pages = next.pages.map(page => ({
    ...page,
    timestamps: { ...page.timestamps, generatedAt },
  }));
  const generationCode = code => REPORT_GENERATION_ISSUE_CODES.includes(code) ||
    code === 'REPORT_EXPORT_PREPARATION_FAILED';
  next.session.diagnostics = [
    ...(next.session.diagnostics ?? []).filter(entry => !generationCode(entry.code)),
    ...controlled.map(issue => ({
    code: issue.code,
    message: issue.message,
    at: generatedAt,
    recoverable: true,
    })),
  ];
  const messages = controlled.map(issue => issue.message);
  const reportStatus = controlled.length || next.session.status !== 'complete' ? 'partial' : 'complete';
  next.report = {
    status: reportStatus,
    reviewUrl: null,
    artifact: {
      status: controlled.length ? 'partial' : 'complete',
      pdfFallback,
      limitations: messages,
      formats: artifactsPrepared ? preparedReportFormats({ hasCsv, hasPdf }) : [],
    },
  };
  next.limitations = deriveSystemLimitations(next);
  next.integrity = {
    algorithm: 'SHA-256', evidenceManifestHash: 'pending', canonicalModelHash: 'pending', hashBase: REPORT_HASH_BASE,
  };
  return enrichAuditForReport(next, {
    now: () => generatedAt,
    timezone: next.timezone,
    manifestVersion: next.versions?.extension,
    rulesVersion: next.versions?.rules,
    browserVersion: next.versions?.browser,
  });
}

function canonicalNow(now) {
  const raw = typeof now === 'function' ? now() : new Date().toISOString();
  const date = raw instanceof Date ? raw : new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Instante de exportação inválido.');
  return date.toISOString();
}

function safeCanonicalNow(now) {
  try { return canonicalNow(now); } catch { throw reportExportInputError(); }
}

function canonicalGeneratedAt(value) {
  try {
    if (typeof value !== 'string') throw new TypeError();
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new TypeError();
    return value;
  } catch {
    throw reportExportInputError();
  }
}

function captureDeliveryLeaseTimestamp(value, expectedRevision, expectedAttempt) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== DELIVERY_LEASE_ATTESTATION_KEYS.length ||
      keys.some(key => typeof key !== 'string' || !DELIVERY_LEASE_ATTESTATION_KEYS.includes(key)) ||
      DELIVERY_LEASE_ATTESTATION_KEYS.some(key => {
        const descriptor = descriptors[key];
        return descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value');
      })) throw new TypeError();
    if (descriptors.active.value !== true ||
      !['running', 'delivering'].includes(descriptors.phase.value) ||
      descriptors.revision.value !== expectedRevision ||
      descriptors.exportAttempt.value !== expectedAttempt) throw new TypeError();
    return canonicalGeneratedAt(descriptors.deliveryAt.value);
  } catch {
    throw reportExportInputError();
  }
}

function validExportAttempt(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Tentativa da exportação inválida.');
  return value;
}

function captureReportExportRequest(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string' || !REPORT_REQUEST_KEYS.has(key))) throw new TypeError();
    const output = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError();
      if (key !== 'brand') output[key] = descriptor.value;
    }
    const hasModel = Object.hasOwn(output, 'auditModel');
    const hasCapability = Object.hasOwn(output, 'auditSnapshotCapability');
    if (hasModel === hasCapability) throw new TypeError();
    if (hasCapability && (!Object.hasOwn(output, 'exportLeaseOwnerId') || !Object.hasOwn(output, 'exportAttempt'))) {
      throw new TypeError();
    }
    if (hasCapability && Object.hasOwn(output, 'now')) throw new TypeError();
    return Object.freeze(output);
  } catch {
    throw reportExportInputError();
  }
}

function validateDependencies(dependencies) {
  if (!dependencies?.urlApi || typeof dependencies.urlApi.createObjectURL !== 'function' || typeof dependencies.urlApi.revokeObjectURL !== 'function') {
    throw new TypeError('API de Blob URL indisponível.');
  }
  for (const method of ['createPrintTab', 'waitForReady', 'connectCdp', 'waitForAssets', 'removeTab']) {
    if (typeof dependencies.tabAdapter?.[method] !== 'function') throw new TypeError(`Adaptador de aba sem ${method}.`);
  }
  if (!dependencies.downloadsAdapter) throw new TypeError('Adaptador de downloads indisponível.');
}

function snapshotPdfResult(value) {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('O renderizador PDF não retornou um registro válido.');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || !['bytes', 'usedFallback', 'limitations'].every(key => keys.includes(key))) {
    throw new TypeError('O renderizador PDF não retornou o esquema esperado.');
  }
  const fields = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new TypeError('O renderizador PDF retornou campos inseguros.');
    }
    fields[key] = descriptor.value;
  }
  if (typeof fields.usedFallback !== 'boolean' || !Array.isArray(fields.limitations)) {
    throw new TypeError('O renderizador PDF retornou metadados inválidos.');
  }
  const limitations = snapshotStringArray(fields.limitations);
  if (!fields.usedFallback && limitations.length !== 0) {
    throw new TypeError('O renderizador PDF retornou limitações incompatíveis.');
  }
  const bytes = snapshotPdfBytes(fields.bytes);
  try { structuredClone(value); } catch { throw new TypeError('O renderizador PDF retornou proxy ou valor inseguro.'); }
  return { bytes, usedFallback: fields.usedFallback };
}

function snapshotTabId(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('A aba de impressão não forneceu registro válido.');
  }
  const keys = Reflect.ownKeys(value);
  if (!keys.includes('id')) throw new TypeError('A aba de impressão não forneceu ID válido.');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('A aba de impressão retornou propriedade insegura.');
    }
  }
  const id = Object.getOwnPropertyDescriptor(value, 'id').value;
  if (!Number.isSafeInteger(id) || id < 0) throw new TypeError('A aba de impressão não forneceu ID válido.');
  try { structuredClone(value); } catch { throw new TypeError('A aba de impressão retornou proxy ou valor inseguro.'); }
  return id;
}

function snapshotStringArray(value) {
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError('Lista de limitações PDF inválida.');
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > 8) {
    throw new TypeError('Lista de limitações PDF inválida.');
  }
  const values = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable || typeof descriptor.value !== 'string') {
      throw new TypeError('Lista de limitações PDF inválida.');
    }
    values.push(descriptor.value);
  }
  if (Reflect.ownKeys(value).length !== lengthDescriptor.value + 1) throw new TypeError('Lista de limitações PDF inválida.');
  return values;
}

function snapshotPdfBytes(value) {
  let source;
  if (value instanceof ArrayBuffer) {
    source = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new TypeError('O renderizador PDF não retornou bytes válidos.');
  }
  const bytes = Uint8Array.from(source);
  if (bytes.length < 5 || bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46 || bytes[4] !== 0x2d) {
    throw new TypeError('O renderizador PDF não retornou assinatura válida.');
  }
  return bytes;
}

function boundary(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new DOMException(message, 'TimeoutError')), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function adoptBoundary(promise, timeoutMs, disposeLate) {
  let timedOut = false;
  let timer;
  const source = Promise.resolve(promise);
  void source.then(value => {
    if (!timedOut) return;
    void Promise.resolve().then(() => disposeLate(value)).catch(() => {});
  }, () => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new OwnershipTransferTimeoutError());
    }, timeoutMs);
  });
  return Promise.race([source, timeout]).finally(() => clearTimeout(timer));
}

function addIssue(issues, issue) {
  if (!issues.some(current => current.code === issue.code)) issues.push(issue);
}

function removeIssue(issues, code) {
  const index = issues.findIndex(issue => issue.code === code);
  if (index >= 0) issues.splice(index, 1);
}

function addUnique(values, value) {
  if (!values.includes(value)) values.push(value);
}

function sanitizeReportMessages(value) {
  let model;
  try {
    const serialized = canonicalStringify(value);
    structuredClone(value);
    model = JSON.parse(serialized);
  } catch {
    throw new TypeError('Modelo de auditoria contém propriedade não segura ou valor inválido.');
  }
  if (Array.isArray(model?.limitations)) model.limitations = model.limitations.map(sanitizeFailureText);
  if (Array.isArray(model?.session?.diagnostics)) {
    model.session.diagnostics = model.session.diagnostics.map(entry => ({
      ...entry,
      message: sanitizeFailureText(entry.message),
      ...(Object.hasOwn(entry, 'details') ? { details: sanitizeFailureValue(entry.details) } : {}),
    }));
  }
  if (Array.isArray(model?.report?.artifact?.limitations)) {
    model.report.artifact.limitations = model.report.artifact.limitations.map(sanitizeFailureText);
  }
  return model;
}

function sanitizeFailureValue(value) {
  if (typeof value === 'string') return sanitizeFailureText(value);
  if (Array.isArray(value)) return value.map(sanitizeFailureValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizeFailureValue(child)]));
}

function sanitizeFailureText(value) {
  const text = typeof value === 'string' ? value : 'Limitação técnica não detalhada.';
  return text
    .replace(/\b(?:blob:[^\s<>"']+|(?:https?|chrome-extension):\/\/[^\s<>"']+)/giu, '[endereço omitido]')
    .replace(/\b(?:token|password|passwd|pass|secret|auth|session|otp|api[-_]?key)\s*[:=]\s*[^\s,;]+/giu, '[credencial redigida]')
    .replace(/\b[A-Z0-9_-]*SECRET[A-Z0-9_-]*\b/giu, '[redigido]')
    .replace(/\s+/gu, ' ')
    .trim() || 'Limitação técnica não detalhada.';
}
