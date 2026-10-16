import { captureElement, captureFullPage } from '../browser/capture-evidence.js';
import { warmUpFullPageLayout } from './full-page-warm-up.js';
import { mapSourceGeometry } from '../core/evidence/map-source-geometry.js';
import { measureElementTarget } from '../browser/measure-element.js';
import { collectPage } from '../browser/collect-page.js';
import { AXE_PROVENANCE, runAxeInTab } from '../browser/axe-adapter.js';
import { dedupeFindingsForPresentation } from '../core/axe/dedupe-findings.js';
import { normalizeAxeResults } from '../core/axe/normalize-axe-results.js';
import {
  NBR17225_ITEMS,
  buildSnapshotIndexes,
  buildStableSelector,
  hashEvidenceArtifact,
  mergeProbesIntoSnapshot,
  mergeAxeSupplementalResults,
  normalizeProbes,
  normalizeSnapshot,
  projectElementAccessibility,
  detectAccessibilityWidgets,
  runCoreAudit,
  runEditorialRules,
  sanitizeHtmlSnippetSource,
  sanitizeResourceUrl,
} from '../core/index.js';
import { canonicalStringify } from '../core/report/canonical-json.js';
import { sha256Hex } from '../core/report/hash.js';
import { canonicalInternalReviewUrl } from '../core/report/report-policy.js';
import { normalizeAuditUrl } from '../core/url.js';
import { axeEquivalenceForAuditaRule } from '../core/normative/axe-nbr-crosswalk.js';
import { runDynamicProbes } from '../collector/dynamic-probes.js';
import { applyHoverOnlyProbe } from '../browser/hover-only-probe.js';
import { section508ReferencesForWcag } from '../core/normative/section508.js';
import { AUDIT_EXECUTION_INTERNAL } from './chrome-adapter.js';
import { projectAuditResourceOrigin } from '../core/privacy.js';
import { createOwnedTabRegistry } from './owned-tabs.js';
import { createRawNavigationVaultV1 } from './raw-navigation-vault.js';
import { readObservedAuditInterruption, runObservedTabAudit } from './observed-tab-runner.js';
import { createObservedPipelineRunner } from './audit-pipeline.js';
import { createPageCheckpointRecorder } from './execution-checkpoint.js';
import { createInstalledCoreRuleInventory } from '../core/rules/core-rule-inventory.js';
import { coreRuleImpact } from '../core/rules/impact-policy.js';
import { createCapturePolicyV1, isCapturePolicyV1 } from '../core/privacy/capture-policy.js';
import { enrichAuditForReport } from '../core/report/enrich-audit.js';
import { createAuditModel } from '../core/report/audit-model.js';
import { testedWcagRefsForCoreRule } from '../core/report/tested-criteria.js';
import {
  ATTACHED_COPY_RELOADED_MESSAGE, DYNAMIC_PROBES_OMITTED_PASSIVE_MESSAGE, ELEMENT_CAPTURE_BUDGET_MESSAGE,
  ELEMENT_CAPTURE_FRAME_CONTEXT_MESSAGE, ELEMENT_MEASUREMENT_FALLBACK_MESSAGE,
  FULL_PAGE_CAPTURE_TRUNCATED_MESSAGE, PAGE_NAVIGATION_HELD_MESSAGE,
} from '../core/report/diagnostic-policy.js';
import { validateExecutionCheckpoint } from './execution-checkpoint.js';
import { isEvidenceUrlV1, sanitizeEvidenceUrlV1 } from '../core/privacy/evidence-url.js';
import {
  createPixelRasterBoundaryV1,
  createPixelPipelinePreflightV1,
  didPixelRasterStartV1,
  didPixelRasterTargetChangeV1,
  isPixelRasterBoundaryInterruptionV1,
  isPixelPrivacyGateV1,
  isPixelPrivacyPauseInterruptionV1,
  settleRefusedPixelRasterV1,
} from './pixel-privacy-gate.js';

const SCHEMA_VERSION = 1;
const METHODOLOGY = Object.freeze({ name: 'Audita Acessibilidade — ABNT NBR 17225 e WCAG 2.2', version: '1.0.0', ruleCount: 131, itemCount: 146 });
const ANNOTATION_MAP_DIAGNOSTIC_CODES = new Set([
  'ANNOTATION_MAP_MV3_E2E_UNAVAILABLE',
  'ANNOTATION_MAP_COMPOSITOR_UNAVAILABLE',
  'ANNOTATION_MAP_SOURCE_INVALID',
  'ANNOTATION_MAP_SOURCE_HASH_MISMATCH',
  'ANNOTATION_MAP_SOURCE_LIMIT',
  'ANNOTATION_MAP_GEOMETRY_INVALID',
  'ANNOTATION_MAP_SEGMENT_LIMIT',
  'ANNOTATION_MAP_PRINT_SEGMENT_LIMIT',
  'ANNOTATION_MAP_LEGEND_PRINT_LIMIT',
  'ANNOTATION_MAP_LEGEND_WIDTH_LIMIT',
  'ANNOTATION_MAP_DERIVED_BYTES_LIMIT',
  'ANNOTATION_MAP_OUTPUT_INVALID',
  'ANNOTATION_MAP_TIMEOUT',
]);
// Mesmos códigos fechados do compositor do mapa do teclado. A lista fica aqui, e não derivada do erro,
// porque o diagnóstico persistido só aceita código que a política de diagnóstico já conhece.
const KEYBOARD_MAP_DIAGNOSTIC_CODES = new Set([
  'KEYBOARD_MAP_COMPOSITOR_UNAVAILABLE',
  'KEYBOARD_MAP_SOURCE_INVALID',
  'KEYBOARD_MAP_SOURCE_HASH_MISMATCH',
  'KEYBOARD_MAP_SOURCE_LIMIT',
  'KEYBOARD_MAP_SEGMENT_LIMIT',
  'KEYBOARD_MAP_PRINT_SEGMENT_LIMIT',
  'KEYBOARD_MAP_DERIVED_BYTES_LIMIT',
  'KEYBOARD_MAP_OUTPUT_INVALID',
  'KEYBOARD_MAP_TIMEOUT',
]);
// Orçamento de miniaturas por página (1.1.53). Cada miniatura passa pela porta de privacidade (várias
// injeções) e custa ~150 ms; uma vitrine com 1.800 ocorrências levava mais de 2 min só nisso e ainda mais para
// finalizar. As ocorrências excedentes mantêm seletor, trecho e descrição; o limite vira limitação declarada.
export const ELEMENT_CAPTURE_BUDGET = Object.freeze({ maxThumbnails: 150, maxMilliseconds: 45_000, maxEvidenceMilliseconds: 75_000 });
const PIXEL_BOUNDARY_INTERRUPTION = new WeakSet();
const OBSERVED_LEGACY_RASTER_BOUNDARIES = new WeakMap();
const PASSIVE_ATTACHED_ADAPTERS = new WeakSet();

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value) || Object.isFrozen(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function canonicalTime(value = new Date().toISOString()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('O relógio da auditoria retornou uma data inválida.');
  return date.toISOString();
}

export function createOwnershipId(randomBytes) {
  if (typeof randomBytes !== 'function') throw new TypeError('OWNERSHIP_ID_INVALID');
  let bytes;
  try { bytes = randomBytes(16); } catch { throw new TypeError('OWNERSHIP_ID_INVALID'); }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) throw new TypeError('OWNERSHIP_ID_INVALID');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
  if (!/^[A-Za-z0-9_-]{22}$/u.test(encoded)) throw new TypeError('OWNERSHIP_ID_INVALID');
  return `owner_${encoded}`;
}

const URL_AUDIT_KEYS = Object.freeze([
  'auditId', 'ownershipId', 'windowId', 'navigationToken', 'navigationPurpose', 'evidenceUrl', 'sessionDigest',
  'rawNavigationVault', 'chromeAdapter', 'capturePolicy', 'checkpointStore', 'onProgress', 'now',
  'signal', 'expectedExtensionId', 'auditRunner',
]);
const URL_PIXEL_AUDIT_KEYS = Object.freeze([...URL_AUDIT_KEYS, 'privacyGate']);
const URL_RESUME_AUDIT_KEYS = Object.freeze([
  'auditId', 'requestedUrlEvidence', 'resumeTarget', 'resumeCheckpoint', 'chromeAdapter', 'capturePolicy', 'privacyGate',
  'checkpointStore', 'onProgress', 'now', 'signal', 'expectedExtensionId', 'auditRunner',
]);

function captureUrlAuditArgs(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) return null;
    const variants = [
      ['initial', URL_AUDIT_KEYS], ['initial-pixel', URL_PIXEL_AUDIT_KEYS],
      ['resume', URL_RESUME_AUDIT_KEYS],
    ];
    const variant = variants.find(([_kind, expected]) =>
      keys.length === expected.length && expected.every(key => keys.includes(key)));
    if (!variant) return null;
    const args = {};
    for (const key of variant[1]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      args[key] = descriptor.value;
    }
    return Object.freeze({ kind: variant[0], args: Object.freeze(args) });
  } catch { return null; }
}

function copyUrlResumeTarget(value) {
  const target = captureExactRecord(value, [
    'kind', 'ownershipId', 'tabId', 'windowId', 'documentId',
    'initialUrlEvidence', 'initialUrlSessionDigest', 'navigationPurpose', 'cleanupMode', 'pageId',
  ]);
  const evidence = target && copyEvidenceUrlV1(target.initialUrlEvidence);
  if (!target || target.kind !== 'owned-disposable-resume' ||
    !/^owner_[A-Za-z0-9_-]{22}$/u.test(target.ownershipId ?? '') ||
    !Number.isSafeInteger(target.tabId) || target.tabId < 0 ||
    !Number.isSafeInteger(target.windowId) || target.windowId < 0 ||
    !/^[A-Za-z0-9._:-]{1,160}$/u.test(target.documentId ?? '') ||
    !evidence || evidence.queryIncluded ||
    !/^hmac-sha256:[A-Za-z0-9_-]{43}$/u.test(target.initialUrlSessionDigest ?? '') ||
    !(
      target.navigationPurpose === 'single-url' && target.cleanupMode === 'pre-observation-failure' ||
      ['attached-copy', 'batch-page'].includes(target.navigationPurpose) && target.cleanupMode === 'always'
    ) || target.pageId !== 'page-1') return null;
  return Object.freeze({ ...target, initialUrlEvidence: evidence });
}

/** Worker-internal single-URL boundary. Raw navigation is released only to the observed runner adapter. */
export async function runUrlAudit(rawArgs = {}) {
  const capturedInput = captureUrlAuditArgs(rawArgs);
  const resuming = capturedInput?.kind === 'resume';
  const args = capturedInput?.args ?? null;
  const policy = args && captureExactRecord(args.capturePolicy, [
    'version', 'mode', 'includeQuery', 'captureFullPage', 'captureElements', 'composeAnnouncementMap',
  ]);
  const resumeTarget = resuming && copyUrlResumeTarget(args.resumeTarget);
  const evidenceUrl = resuming ? resumeTarget?.initialUrlEvidence : args && copyEvidenceUrlV1(args.evidenceUrl);
  const requestedUrlEvidence = resuming
    ? args && copyEvidenceUrlV1(args.requestedUrlEvidence)
    : evidenceUrl;
  const writeSanitized = args && optionalAdapterMethod(args.checkpointStore, 'writeSanitized');
  const persistSanitizedModel = args && optionalAdapterMethod(args.checkpointStore, 'persistAuditModel');
  const take = !resuming && args && optionalAdapterMethod(args.rawNavigationVault, 'take');
  const privacyGate = Object.hasOwn(args ?? {}, 'privacyGate') ? args.privacyGate : null;
  const ownershipId = resuming ? resumeTarget?.ownershipId : args?.ownershipId;
  const windowId = resuming ? resumeTarget?.windowId : args?.windowId;
  const sessionDigest = resuming ? resumeTarget?.initialUrlSessionDigest : args?.sessionDigest;
  const navigationPurpose = resuming ? resumeTarget?.navigationPurpose : args?.navigationPurpose;
  const cleanupMode = ['attached-copy', 'batch-page'].includes(navigationPurpose)
    ? 'always'
    : 'pre-observation-failure';
  if (!args || !/^[A-Za-z0-9._:-]{1,160}$/u.test(args.auditId ?? '') ||
    !/^owner_[A-Za-z0-9_-]{22}$/u.test(ownershipId ?? '') ||
    !Number.isSafeInteger(windowId) || windowId < 0 ||
    (!resuming && (!/^[A-Za-z0-9_-]{22}$/u.test(args.navigationToken ?? '') ||
      !['single-url', 'context-menu-link', 'attached-copy', 'batch-page'].includes(args.navigationPurpose) || !take)) ||
    !evidenceUrl || evidenceUrl.queryIncluded || !requestedUrlEvidence || requestedUrlEvidence.queryIncluded ||
    !/^hmac-sha256:[A-Za-z0-9_-]{43}$/u.test(sessionDigest ?? '') ||
    !policy || !isCapturePolicyV1(policy) || policy.includeQuery !== false ||
    (policy.mode === 'no-pixels'
      ? resuming || privacyGate !== null
      : !isPixelPrivacyGateV1(privacyGate)) ||
    !writeSanitized || typeof args.onProgress !== 'function' || typeof args.now !== 'function' ||
    typeof args.auditRunner !== 'function' || !args.chromeAdapter || typeof args.chromeAdapter !== 'object' ||
    (args.signal !== undefined && (!args.signal || typeof args.signal !== 'object')) ||
    typeof args.expectedExtensionId !== 'string') throw new TypeError('URL_AUDIT_DENIED');

  let consumed = false;
  const resolveNavigationToken = async navigationToken => {
    if (resuming || consumed || navigationToken !== args.navigationToken) throw new TypeError('URL_AUDIT_DENIED');
    const url = normalizeAuditUrl(await take(args.navigationToken, {
      auditId: args.auditId, purpose: args.navigationPurpose,
      expectedEvidenceUrl: requestedUrlEvidence, expectedSessionDigest: sessionDigest,
    }));
    const requestedEvidence = sanitizeEvidenceUrlV1(url, { includeQuery: false });
    if (requestedEvidence.href !== requestedUrlEvidence.href ||
      requestedEvidence.queryIncluded !== requestedUrlEvidence.queryIncluded ||
      requestedEvidence.redactedSegments !== requestedUrlEvidence.redactedSegments) throw new TypeError('URL_AUDIT_DENIED');
    consumed = true;
    return url;
  };

  // Unit callers may inject a narrow runner to prove only the vault boundary.
  // The production runner receives a locally composed, branded pipeline and
  // ownership registry; neither capability crosses the public worker protocol.
  if (args.auditRunner !== runObservedTabAudit) {
    const executionAdapter = Object.freeze(resuming
      ? { ...args.chromeAdapter }
      : { ...args.chromeAdapter, resolveNavigationToken });
    return args.auditRunner({
      auditId: args.auditId,
      target: resuming ? resumeTarget : Object.freeze({
        kind: 'owned-disposable', ownershipId: args.ownershipId, navigationToken: args.navigationToken,
        cleanupMode, pageId: 'page-1',
      }),
      chromeAdapter: executionAdapter,
      capturePolicy: Object.freeze(policy),
      privacyGate,
      onCheckpoint: checkpoint => writeSanitized(args.auditId, checkpoint),
      now: args.now,
      signal: args.signal,
      expectedExtensionId: args.expectedExtensionId,
    });
  }

  let internals;
  let createTab;
  let navigateTab;
  let waitForStable;
  let probeDocumentIdentity;
  let probeSensitiveCaptureSignals;
  let removeTab;
  let getTab;
  let baseGetEvidenceUrl;
  let baseGetFinalUrl;
  let legacyEffects;
  try {
    internals = internalContract(args.chromeAdapter);
    probeDocumentIdentity = requiredAdapterMethod(args.chromeAdapter, 'probeDocumentIdentity');
    removeTab = requiredAdapterMethod(args.chromeAdapter, 'removeTab');
    getTab = requiredAdapterMethod(args.chromeAdapter, 'getTab');
    if (!resuming) {
      createTab = requiredAdapterMethod(args.chromeAdapter, 'createTab');
      navigateTab = requiredAdapterMethod(args.chromeAdapter, 'navigateTab');
      waitForStable = requiredAdapterMethod(args.chromeAdapter, 'waitForStable');
      baseGetEvidenceUrl = optionalAdapterMethod(args.chromeAdapter, 'getEvidenceUrl');
      baseGetFinalUrl = optionalAdapterMethod(args.chromeAdapter, 'getFinalUrl');
    }
    legacyEffects = Object.freeze({ ...captureLegacyEffects(args.chromeAdapter), emitProgress: args.onProgress });
    if (policy.mode !== 'no-pixels') {
      probeSensitiveCaptureSignals = requiredAdapterMethod(args.chromeAdapter, 'probeSensitiveCaptureSignals');
      if (policy.captureFullPage && typeof legacyEffects.captureFullPage !== 'function' ||
        policy.captureElements && typeof legacyEffects.captureElement !== 'function') {
        throw new TypeError('URL_AUDIT_DENIED');
      }
    }
  } catch { throw new TypeError('URL_AUDIT_DENIED'); }
  const ownedTabs = createOwnedTabRegistry({
    sessionArea: internals.sessionArea,
    chromeAdapter: Object.freeze({ removeTab, getTab }),
    now: args.now,
  });
  const inventory = await createInstalledCoreRuleInventory();
  let resumeCheckpoint = null;
  if (resuming) {
    try {
      resumeCheckpoint = validateExecutionCheckpoint({
        auditId: args.auditId, checkpoint: args.resumeCheckpoint, pageOrder: ['page-1'],
      });
    } catch { throw new TypeError('URL_AUDIT_DENIED'); }
    const page = resumeCheckpoint.pages[0];
    if (page.attempted !== true || page.rulesVersion !== inventory.rulesVersion ||
      page.inventoryVersion !== inventory.inventoryVersion || page.inventoryHash !== inventory.sha256 ||
      page.outcomes.length !== 0) throw new TypeError('URL_AUDIT_DENIED');
  }
  const startedAt = resumeCheckpoint?.pages[0].startedAt ?? canonicalTime(args.now());
  const checkpointRecorder = await createPageCheckpointRecorder({
    auditId: args.auditId, pageId: 'page-1', startedAt,
    rulesVersion: inventory.rulesVersion, inventory,
    onCheckpoint: checkpoint => writeSanitized(args.auditId, checkpoint),
  });
  let terminalModel = null;
  let pixelRasterBoundary = null;
  let pixelCollectionStarted = false;
  let pixelStarted = false;
  const services = Object.freeze({
    async collectObservedPage({ observedTarget }) {
      const safeTarget = copyOwnedObservedTarget(observedTarget);
      if (!safeTarget || safeTarget.ownershipId !== ownershipId ||
        safeTarget.cleanupMode !== cleanupMode || safeTarget.pageId !== 'page-1') {
        throw new TypeError('URL_AUDIT_DENIED');
      }
      if (policy.mode !== 'no-pixels') pixelCollectionStarted = true;
      pixelRasterBoundary = policy.mode === 'no-pixels' ? null : createPixelRasterBoundaryV1({
        auditId: args.auditId, observedTarget: safeTarget, capturePolicy: policy, privacyGate,
        probeDocumentIdentity, probeSensitiveCaptureSignals, signal: args.signal,
        captureFullPage: policy.captureFullPage ? legacyEffects.captureFullPage : null,
        captureElement: policy.captureElements ? legacyEffects.captureElement : null,
      });
      const observedAdapter = createObservedLegacyAdapter(
        legacyEffects, safeTarget, policy, privacyGate, pixelRasterBoundary,
      );
      const collectedDraft = await runLegacyAudit({
        url: requestedUrlEvidence.href,
        chromeAdapter: observedAdapter,
        now: args.now, idFactory: () => args.auditId, signal: args.signal,
        closeAuditTab: false, expectedExtensionId: args.expectedExtensionId, startedAt,
      });
      if (policy.mode === 'element-only' &&
        !['failed', 'cancelled'].includes(collectedDraft.session.status)) {
        await observedAdapter.settlePixelBoundary();
      }
      let draft = alignLegacyDraftWithObservedEvidence(
        collectedDraft, safeTarget.urlEvidence.href, requestedUrlEvidence.href,
      );
      if (navigationPurpose === 'attached-copy') {
        const copy = structuredClone(draft);
        const diagnostics = Array.isArray(copy.session?.diagnostics) ? copy.session.diagnostics : [];
        if (!diagnostics.some(entry => entry?.code === 'ATTACHED_COPY_RELOADED' &&
          entry.message === ATTACHED_COPY_RELOADED_MESSAGE)) {
          diagnostics.push(diagnostic(
            'ATTACHED_COPY_RELOADED',
            ATTACHED_COPY_RELOADED_MESSAGE,
            canonicalTime(copy.timestamps?.endedAt ?? args.now()),
            true,
          ));
        }
        copy.session.diagnostics = diagnostics;
        draft = deepFreeze(copy);
      }
      terminalModel = await enrichAuditForReport(draft, {
        now: args.now,
        manifestVersion: legacyEffects.manifestVersion,
        expectedExtensionId: args.expectedExtensionId,
        browserVersion: draft.environment?.chromeVersion || 'não disponível',
        rulesVersion: draft.methodology?.version || inventory.rulesVersion,
      });
      return Object.freeze({ version: 1, kind: 'legacy-observation' });
    },
    async runCoreRules() {
      return Object.freeze({
        ruleResults: terminalModel.ruleResults.filter(result => result.source?.engine === 'audita-core'),
      });
    },
    async buildAuditModel() { return terminalModel; },
    async persistAuditModel(model, context) {
      if (persistSanitizedModel) await persistSanitizedModel(model, context?.observedTarget ?? null);
    },
  });
  const pixelPreflight = policy.mode === 'no-pixels' ? null : createPixelPipelinePreflightV1(privacyGate, {
    probeSensitiveCaptureSignals: observedTarget =>
      probeSensitiveCaptureSignals(observedTarget.tabId, observedTarget.documentId),
  });
  const runPipeline = createObservedPipelineRunner({
    checkpointRecorder, services,
    ...(policy.mode === 'no-pixels' ? {} : { privacyGate, pixelPreflight }),
  });
  const createTabInAuthorizedWindow = async details => {
    const request = captureExactRecord(details, ['url', 'active']);
    if (!request || request.url !== 'about:blank' || request.active !== true) {
      throw new Error('TARGET_CREATION_FAILED');
    }
    const created = await createTab({ ...request, active: false, windowId });
    const createdTabId = ownValue(created, 'id');
    const createdWindowId = ownValue(created, 'windowId');
    if (Number.isSafeInteger(createdTabId) && createdTabId >= 0 && createdWindowId !== windowId) {
      try { await removeTab(createdTabId); } catch { /* about:blank never receives the protected URL */ }
      throw new Error('TARGET_CREATION_FAILED');
    }
    return created;
  };
  const getEvidenceUrl = async (tabId, includeQuery) => {
    if (includeQuery !== false) throw new TypeError('URL_AUDIT_DENIED');
    const pending = typeof baseGetEvidenceUrl === 'function'
      ? baseGetEvidenceUrl(tabId, false)
      : typeof baseGetFinalUrl === 'function'
        ? baseGetFinalUrl(tabId)
        : (() => { throw new TypeError('URL_AUDIT_DENIED'); })();
    const value = await pending;
    const safe = copyEvidenceUrlV1(value) ??
      (typeof value === 'string' ? sanitizeEvidenceUrlV1(value, { includeQuery: false }) : null);
    if (!safe || safe.queryIncluded) throw new TypeError('URL_AUDIT_DENIED');
    return safe;
  };
  const executionAdapter = Object.freeze(resuming
    ? { runPipeline, probeDocumentIdentity, ownedTabs, removeTab }
    : {
        runPipeline, probeDocumentIdentity, ownedTabs, createTab: createTabInAuthorizedWindow,
        navigateTab, waitForStable, resolveNavigationToken, getEvidenceUrl, removeTab,
      });
  let runnerOutput;
  try {
    runnerOutput = await args.auditRunner({
      auditId: args.auditId,
      target: resuming ? resumeTarget : Object.freeze({
      kind: 'owned-disposable', ownershipId: args.ownershipId, navigationToken: args.navigationToken,
      cleanupMode, pageId: 'page-1',
      }),
      chromeAdapter: executionAdapter,
      capturePolicy: Object.freeze(policy),
      privacyGate,
      onCheckpoint: checkpoint => writeSanitized(args.auditId, checkpoint),
      now: args.now,
      signal: args.signal,
      expectedExtensionId: args.expectedExtensionId,
    });
  } finally {
    pixelStarted = pixelStarted || didPixelRasterStartV1(pixelRasterBoundary);
    if (pixelCollectionStarted && runnerOutput?.status !== 'privacy-paused') {
      await privacyGate.afterPixels({ auditId: args.auditId, pixelStarted });
    }
  }
  return runnerOutput;
}

function stableHash(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (const character of text) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function safeUrl(value) {
  if (typeof value !== 'string') return '';
  return sanitizeResourceUrl(value);
}

function validateTransientReviewUrl(value, auditId, expectedExtensionId) {
  try { canonicalInternalReviewUrl(value ?? null, auditId, expectedExtensionId); } catch { /* capability descartada */ }
}

function diagnostic(code, message, at, recoverable = false, details = {}) {
  return {
    code, message, at, recoverable,
    ...(Object.keys(details).length > 0 ? { details: { ...details } } : {}),
  };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason?.name === 'AbortError') throw signal.reason;
  throw new DOMException('Operação cancelada.', 'AbortError');
}

function rethrowAbort(_error, signal) {
  if (signal?.aborted) throwIfAborted(signal);
}

const PAGE_RESPONSIVE_BUDGET_MS = 120_000;
const PAGE_RESPONSIVE_PROBE_MS = 3_000;
async function waitForPageResponsive(chromeAdapter, tabId, signal) {
  if (typeof chromeAdapter?.executeScript !== 'function') return false;
  const deadline = Date.now() + PAGE_RESPONSIVE_BUDGET_MS;
  while (Date.now() < deadline && !signal?.aborted) {
    let timer;
    const answered = await Promise.race([
      Promise.resolve(chromeAdapter.executeScript({
        target: { tabId, frameIds: [0] }, world: 'ISOLATED', injectImmediately: true, func: () => true,
      })).then(results => Array.isArray(results) && results[0]?.result === true, () => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), PAGE_RESPONSIVE_PROBE_MS); }),
    ]).finally(() => clearTimeout(timer));
    if (answered) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

function probesTimedOut(raw, normalized) {
  if (raw?.timedOut === true || raw?.incompleteReason === 'timeout') return true;
  return [...(Array.isArray(raw?.warnings) ? raw.warnings : []), ...(Array.isArray(normalized?.warnings) ? normalized.warnings : [])]
    .some(warning => typeof warning?.code === 'string' && /TIMEOUT/u.test(warning.code));
}

function fallbackItems() {
  return NBR17225_ITEMS.map(item => ({ ...item, wcag: item.wcag.map(reference => ({ ...reference })), outcome: 'cantTell', ruleResults: [] }));
}

function targetNodeId(target) {
  if (typeof target === 'string' || Number.isSafeInteger(target)) return String(target);
  if (target && (typeof target.nodeId === 'string' || Number.isSafeInteger(target.nodeId))) return String(target.nodeId);
  return null;
}

function normalizedText(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function nodeAttribute(node, name) {
  const value = node?.attributes?.[name];
  return typeof value === 'string' ? value : value === true ? '' : undefined;
}

function privateTextElement(node) {
  const tag = normalizedText(node?.tagName).toLowerCase();
  if (tag === 'textarea') return true;
  if (['input', 'select'].includes(tag)) return false;
  const contenteditable = normalizedText(nodeAttribute(node, 'contenteditable')).toLowerCase();
  return Object.hasOwn(node?.attributes || {}, 'contenteditable') && !['false', 'inherit'].includes(contenteditable);
}

function hasPrivateTextAncestor(node, indexes) {
  const visited = new Set();
  let current = node?.parentId ? indexes.byNodeId.get(node.parentId) : null;
  while (current && !visited.has(current.nodeId)) {
    visited.add(current.nodeId);
    if (privateTextElement(current)) return true;
    current = current.parentId ? indexes.byNodeId.get(current.parentId) : null;
  }
  return false;
}

function makeOccurrences(auditId, ruleResults, itemResults) {
  const itemById = new Map(NBR17225_ITEMS.map(item => [item.id, item]));
  const occurrences = [];
  const add = input => {
    const signature = [auditId, input.itemId, input.ruleId || 'manual', input.nodeId || 'document', occurrences.length].join('\u0000');
    occurrences.push({ occurrenceId: `occurrence-${stableHash(signature)}`, ...input });
  };
  for (const result of ruleResults) {
    if (!['failed', 'cantTell'].includes(result.outcome)) continue;
    const itemIds = Array.isArray(result.nbrItems) ? result.nbrItems : [];
    const targets = Array.isArray(result.targets) && result.targets.length ? result.targets : [null];
    for (const itemId of itemIds) for (const target of targets) {
      const nodeId = targetNodeId(target);
      const equivalence = axeEquivalenceForAuditaRule(result.ruleId);
      const itemWcagRefs = itemById.get(itemId)?.wcag.map(reference => reference.id) ?? [];
      const sourceWcagRefs = result.ruleId === 'new-window-link-warning'
        ? []
        : [...new Set((Array.isArray(result.wcag) ? result.wcag : [])
          .filter(reference => itemWcagRefs.includes(reference)))];
      const testedWcagRefs = testedWcagRefsForCoreRule(result.ruleId, result.outcome, sourceWcagRefs);
      add({
        itemId,
        nbrItemRef: itemId,
        ruleId: result.ruleId,
        outcome: result.outcome,
        mode: result.mode,
        nodeId: nodeId && nodeId !== 'document' ? nodeId : null,
        pageId: 'page-1',
        source: { engine: 'audita-core', ruleId: result.ruleId, version: METHODOLOGY.version },
        target: {
          nodeId: nodeId && nodeId !== 'document' ? nodeId : null,
          selector: null,
          framePath: [],
        },
        equivalenceKey: equivalence?.equivalenceKey ?? `audita:${result.ruleId}`,
        presentationTargetKey: equivalence?.targetScope === 'document'
          ? 'document'
          : nodeId && nodeId !== 'document' ? `node:${nodeId}` : null,
        evidenceIds: [],
        itemWcagRefs, sourceWcagRefs, testedWcagRefs,
        wcagRefs: [...testedWcagRefs],
        foreignBenchmarkRefs: [...section508ReferencesForWcag(testedWcagRefs)],
        ...(result.ruleId === 'new-window-link-warning' ? {
          reason: result.outcome === 'failed'
            ? { code: 'missing-new-window-warning', context: {
              behavior: ['target-blank', 'observed-new-window'].includes(target?.data?.behavior) ? target.data.behavior : 'unknown',
              warning: 'absent',
            } }
            : { code: 'new-window-warning-observation-incomplete', context: {
              behavior: ['target-blank', 'observed-new-window'].includes(target?.data?.behavior) ? target.data.behavior : 'unknown',
              warning: 'unknown',
            } },
        } : {}),
        justification: typeof target?.message === 'string' && target.message.trim() ? target.message.trim() : result.summary || 'A ocorrência exige verificação humana.',
        // Graduação fechada por regra (src/core/rules/impact-policy.js): a mesma ocorrência vale
        // para falha confirmada e para suspeita ('cantTell'), que a interface apresenta como
        // "Impacto se confirmado".
        impact: coreRuleImpact(result.ruleId),
      });
    }
  }
  for (const item of itemResults) {
    if (item.outcome !== 'cantTell' || !['manual', 'assisted'].includes(item.evaluation)) continue;
    if (occurrences.some(occurrence => occurrence.itemId === item.id)) continue;
    add({
      itemId: item.id, ruleId: null, outcome: 'cantTell', mode: item.evaluation,
      nodeId: null, evidenceIds: [],
      pageId: 'page-1', nbrItemRef: item.id,
      source: { engine: 'audita-manual-review', ruleId: `manual:${item.id}`, version: METHODOLOGY.version },
      target: { nodeId: null, selector: null, framePath: [] },
      equivalenceKey: `manual:${item.id}`, presentationTargetKey: null,
      itemWcagRefs: [], sourceWcagRefs: [], testedWcagRefs: [],
      wcagRefs: [], foreignBenchmarkRefs: [],
      justification: item.humanReason || 'O item depende de revisão humana no nível da página.',
    });
  }
  return occurrences;
}

function makeEditorialOccurrences(auditId, ruleResults) {
  const occurrences = [];
  for (const rule of ruleResults) {
    if (rule.ruleId !== 'editorial.placeholder-text' || rule.outcome !== 'failed') continue;
    for (const value of rule.targets.slice(0, 64)) {
      const nodeId = targetNodeId(value);
      const signature = [auditId, rule.ruleId, nodeId || 'document', occurrences.length].join('\u0000');
      occurrences.push({
        occurrenceId: `occurrence-${stableHash(signature)}`,
        itemId: null,
        nbrItemRef: null,
        ruleId: rule.ruleId,
        outcome: 'failed',
        mode: 'automated',
        classification: 'editorial',
        impact: 'minor',
        confidence: 'high',
        nodeId,
        pageId: 'page-1',
        source: { engine: 'audita-editorial', ruleId: rule.ruleId, version: METHODOLOGY.version },
        target: { nodeId, selector: null, framePath: [] },
        itemWcagRefs: [],
        sourceWcagRefs: [],
        testedWcagRefs: [],
        wcagRefs: [],
        foreignBenchmarkRefs: [],
        accessiblePreview: null,
        evidenceIds: [],
        legalAnalysis: null,
        justification: 'Há conteúdo provisório inequívoco na página.',
      });
    }
  }
  return occurrences;
}

function allocateOccurrenceIds(state) {
  state.occurrences = state.occurrences.map((occurrence, index) => {
    const occurrenceId = `occurrence-${occurrence.pageId}-${String(index + 1).padStart(6, '0')}`;
    return { ...occurrence, occurrenceId };
  });
  if (state.axe) {
    const axeIds = state.occurrences.filter(occurrence => occurrence.source?.engine === 'axe-core').map(occurrence => occurrence.occurrenceId);
    const axe = structuredClone(state.axe);
    axe.occurrences = axe.occurrences.map((occurrence, index) => ({ ...occurrence, occurrenceId: axeIds[index] }));
    state.axe = deepFreeze(axe);
  }
}

function resolvePresentationTargets(occurrences, artifacts) {
  const selectorToNodeIds = new Map();
  for (const artifact of artifacts) {
    const selector = artifact?.selector?.css;
    if (typeof selector !== 'string' || !selector || !artifact.nodeId) continue;
    const ids = selectorToNodeIds.get(selector) ?? [];
    ids.push(artifact.nodeId);
    selectorToNodeIds.set(selector, ids);
  }
  for (const occurrence of occurrences) {
    if (occurrence.classification === 'editorial') continue;
    if (occurrence.presentationTargetKey === 'document') continue;
    if (occurrence.nodeId) {
      occurrence.presentationTargetKey = `node:${occurrence.nodeId}`;
      continue;
    }
    if (occurrence.source?.engine === 'axe-core') continue;
    const selector = occurrence.target?.selector ?? occurrence.selector;
    const candidates = typeof selector === 'string' ? selectorToNodeIds.get(selector) : null;
    if (candidates?.length === 1) occurrence.presentationTargetKey = `node:${candidates[0]}`;
  }
}

function manualQueue(occurrences, itemResults) {
  const itemById = new Map(itemResults.map(item => [item.id, item]));
  return occurrences.filter(occurrence =>
    occurrence.itemId && occurrence.outcome === 'cantTell').map(occurrence => {
    const item = itemById.get(occurrence.itemId);
    return {
      occurrenceId: occurrence.occurrenceId,
      itemId: occurrence.itemId,
      ruleId: occurrence.ruleId,
      mode: occurrence.mode === 'manual' ? 'manual' : 'assisted',
      status: 'unanswered',
      question: `O requisito “${item?.title || occurrence.itemId}” está conforme no contexto apresentado?`,
      reason: occurrence.justification,
    };
  });
}

async function draftModel(state) {
  const snapshotHash = await sha256Hex(canonicalStringify(state.snapshot || null));
  const ruleResultsHash = await sha256Hex(canonicalStringify(state.ruleResults));
  const evidenceHash = await sha256Hex(canonicalStringify(state.artifacts.map(artifact => ({
    evidenceId: artifact.evidenceId, kind: artifact.kind, nodeId: artifact.nodeId || null, hash: artifact.hash,
  }))));
  const model = {
    schemaVersion: SCHEMA_VERSION,
    auditId: state.auditId,
    requestedUrl: state.requestedUrl,
    finalUrl: state.finalUrl || state.requestedUrl,
    attempted: state.attempted,
    finalUrlObserved: state.finalUrlObserved,
    timestamps: { startedAt: state.startedAt, ...(state.endedAt ? { endedAt: state.endedAt } : {}) },
    environment: state.environment,
    methodology: {
      ...METHODOLOGY,
      ruleCount: state.ruleResults.length,
      coreRuleCount: state.coreRuleResults.length,
      supplementalRuleCount: Math.max(0, state.ruleResults.length - state.coreRuleResults.length),
    },
    session: { status: state.status, diagnostics: state.diagnostics, partial: state.status === 'partial' },
    snapshot: state.snapshot ? {
      schemaVersion: state.snapshot.schemaVersion,
      document: state.snapshot.document,
      nodes: state.snapshot.nodes,
      coverage: state.snapshot.document?.coverage || {},
      warnings: state.snapshot.document?.warnings || [],
    } : null,
    ruleResults: state.ruleResults,
    itemResults: state.itemResults,
    occurrences: state.occurrences,
    evidence: { stateCount: state.fullPage ? 1 : 0, artifacts: state.artifacts },
    manualReview: state.manualReview,
    reviewDecisions: [],
    ...(state.axe === undefined ? {} : { axe: state.axe }),
    accessibilityWidgets: state.accessibilityWidgets,
    limitations: state.limitations,
    presentation: state.presentation,
    progress: state.progress,
    report: state.report,
    reproducibility: {
      methodologyVersion: METHODOLOGY.version,
      snapshotHash,
      ruleResultsHash,
      evidenceHash,
      capturedStateCount: state.fullPage ? 1 : 0,
    },
  };
  const output = deepFreeze(structuredClone(model));
  return output;
}

/** Devolve a sessão (congelamento + depurador) que a leitura da página entregou a quem chamou. */
async function releaseNavigationHold(hold) {
  if (!hold || typeof hold.release !== 'function') return;
  const release = hold.release;
  hold.release = null;
  try { await release(); } catch { /* limpeza best-effort: o desanexo desfaz o que sobrar */ }
}

/** Runs one local audit in one disposable tab using only injected Chrome effects. */
async function runLegacyAudit({
  url, chromeAdapter, now = () => new Date().toISOString(), idFactory = () => crypto.randomUUID(), signal,
  closeAuditTab = true, expectedExtensionId, startedAt: suppliedStartedAt, navigationHold = null,
}) {
  if (navigationHold !== null && (typeof navigationHold !== 'object' || Array.isArray(navigationHold))) {
    throw new TypeError('A posse da navegação é inválida.');
  }
  if (!chromeAdapter || typeof chromeAdapter !== 'object') throw new TypeError('O adapter Chrome é obrigatório.');
  const navigationUrl = normalizeAuditUrl(url);
  const generatedId = idFactory('audit');
  const auditId = typeof generatedId === 'string' ? generatedId.trim() : '';
  if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(auditId)) throw new TypeError('O identificador da auditoria é inválido.');
  const state = {
    auditId,
    requestedUrl: projectAuditResourceOrigin(navigationUrl),
    finalUrl: '',
    attempted: false,
    finalUrlObserved: false,
    startedAt: suppliedStartedAt === undefined ? canonicalTime(now()) : canonicalTime(suppliedStartedAt),
    endedAt: '',
    environment: { chromeVersion: '', viewport: { width: null, height: null, deviceScaleFactor: null } },
    status: 'running', diagnostics: [], progress: [], snapshot: null,
    ruleResults: [], coreRuleResults: [], itemResults: fallbackItems(), occurrences: [], manualReview: [],
    editorialRuleResults: [],
    axe: normalizeAxeResults({ status: 'disabled', provenance: AXE_PROVENANCE, frames: [], diagnostics: [{ code: 'AXE_FEATURE_DISABLED' }] }, { pageId: 'page-1' }),
    rawAxe: null, limitations: [], presentation: { groups: [], occurrenceCount: 0, hiddenOccurrenceCount: 0 },
    accessibilityWidgets: detectAccessibilityWidgets(null),
    artifacts: [], fullPage: null,
    report: { status: 'pending', reviewUrl: null, artifact: { status: 'pending', formats: [] } },
  };
  let tab = null;
  let cdp = null;
  let navigationFreeze = null;
  let fatal = false;
  let recoverableFailure = false;
  let furtherPixelCaptureSuppressed = false;

  const awaitStep = async operation => {
    throwIfAborted(signal);
    const value = await operation();
    throwIfAborted(signal);
    return value;
  };

  const progress = async (phase, message, percent) => {
    throwIfAborted(signal);
    const previous = state.progress.at(-1)?.percent ?? -1;
    const entry = { type: 'AUDIT_PROGRESS', sessionId: auditId, auditId, phase, message, percent: Math.max(previous, percent), at: canonicalTime(now()) };
    state.progress.push(entry);
    try {
      const pending = chromeAdapter.emitProgress?.(entry);
      if (pending !== undefined) void Promise.resolve(pending).catch(() => {});
    } catch { /* Progress transport must not abort or block the audit. */ }
    throwIfAborted(signal);
  };
  const recoverable = (code, message, details = {}) => {
    recoverableFailure = true;
    const signature = canonicalStringify({ code, message, details });
    if (!state.diagnostics.some(entry => canonicalStringify({
      code: entry.code, message: entry.message, details: entry.details ?? {},
    }) === signature)) {
      state.diagnostics.push(diagnostic(code, message, canonicalTime(now()), true, details));
    }
  };
  const appendDiagnosticOnce = (code, message, recoverableValue) => {
    if (!state.diagnostics.some(entry => entry.code === code && entry.message === message &&
      entry.recoverable === recoverableValue)) {
      state.diagnostics.push(diagnostic(code, message, canonicalTime(now()), recoverableValue));
    }
  };
  const settleFatalAxeObservation = () => {
    if (state.coreRuleResults.length > 0) return;
    if (state.diagnostics.some(entry => entry.code === 'COLLECTION_FAILED')) {
      state.axe = undefined;
      state.rawAxe = null;
      return;
    }
    if (['disabled', 'partial'].includes(state.rawAxe?.status)) {
      state.axe = normalizeAxeResults(state.rawAxe, {
        pageId: 'page-1', auditId, snapshot: state.snapshot,
        coreRuleResults: [], rulesVersion: METHODOLOGY.version,
      });
      if (state.axe.status === 'disabled') appendDiagnosticOnce(
        'AXE_FEATURE_DISABLED',
        'O motor suplementar axe-core permaneceu desativado pelo gate MV3/CSP; o motor próprio continuou normalmente.',
        true,
      );
      if (state.axe.status === 'partial') appendDiagnosticOnce(
        'AXE_EXECUTION_FAILED',
        'O motor suplementar axe-core teve cobertura parcial; o motor próprio continuou normalmente.',
        true,
      );
    } else {
      state.axe = undefined;
    }
    state.rawAxe = null;
  };
  const fail = (code, message, error) => {
    fatal = true;
    state.status = signal?.aborted ? 'cancelled' : 'failed';
    state.diagnostics.push(diagnostic(code, message, canonicalTime(now()), false));
  };

  try {
    throwIfAborted(signal);
    await progress('opening', 'Abrindo o site', 5);
    const createdTab = await awaitStep(() => chromeAdapter.createTab({ url: 'about:blank', active: false }));
    if (!Number.isInteger(createdTab?.id)) throw new Error('Tab inválida');
    tab = createdTab;
    await awaitStep(() => {
      state.attempted = true;
      return chromeAdapter.navigateTab(tab.id, navigationUrl, { signal });
    });
    const navigation = await awaitStep(() => chromeAdapter.waitForStable(tab.id, { signal, timeoutMs: 30_000 }));
    const observedUrl = navigation?.url || await awaitStep(() => chromeAdapter.getFinalUrl?.(tab.id)) || navigationUrl;
    state.finalUrl = projectAuditResourceOrigin(observedUrl);
    state.finalUrlObserved = true;
    cdp = await awaitStep(() => chromeAdapter.connectCdp(tab.id, { signal }));
    if (!cdp || typeof cdp.command !== 'function') throw new Error('CDP inválido');
    // Congelamento de navegação (1.1.58). Só depois do anexo — e, portanto, depois da navegação que a
    // própria extensão pediu (`navigateTab` acontece bem antes, na linha 856) — a página passa a ter as
    // trocas de documento do frame principal seguradas. É best-effort: uma recusa aqui não derruba a
    // auditoria, apenas a deixa como era antes do congelamento.
    if (typeof chromeAdapter.beginNavigationFreeze === 'function') {
      try {
        navigationFreeze = await chromeAdapter.beginNavigationFreeze(cdp, tab.id);
      } catch { navigationFreeze = null; }
    }

    let pristineMetrics = {};
    // Métricas do viewport lidas agora, ainda antes do axe, só para o ambiente. A captura integral saiu
    // daqui em 1.1.60 e passou a sair colada na leitura da estrutura (ver `capturePristineFullPage`).
    if (chromeAdapter.captureFullPageEnabled === false) {
      appendDiagnosticOnce(
        chromeAdapter.captureElementsEnabled === false ? 'PIXEL_CAPTURE_OMITTED' : 'FULL_PAGE_CAPTURE_OMITTED',
          chromeAdapter.captureElementsEnabled === false
          ? 'Nenhuma captura raster foi coletada no modo sem imagens.'
          : 'A captura integral e o mapa anotado foram omitidos pela política; miniaturas de elementos permaneceram permitidas.',
        true,
      );
    }
    try {
      pristineMetrics = await awaitStep(() => cdp.command('Page.getLayoutMetrics', {}));
    } catch (error) {
      rethrowAbort(error, signal);
      pristineMetrics = {};
    }
    // `mapSource` carrega a decisão "a imagem e os retângulos são do mesmo estado?" usada pelos dois mapas.
    let mapSource = null;
    // Captura integral com as métricas do próprio instante da captura. Antes (até 1.1.59) a imagem era
    // tirada logo depois da navegação e a estrutura era lida segundos depois, após o axe: em páginas que
    // crescem sozinhas (carregamento sob demanda, listas que se completam) a imagem ficava de um estado e os
    // retângulos de outro. O resultado eram caixas de mapa deslocadas — pior, para quem não programa, do que
    // caixa nenhuma. Agora a captura acontece no mesmo instante da leitura da estrutura e `mapSourceGeometry`
    // confere se as duas concordam; quando não concordam, o mapa vai sem caixas.
    async function capturePristineFullPage() {
      try {
        const captureMetrics = await awaitStep(() => cdp.command('Page.getLayoutMetrics', {}));
        state.fullPage = await awaitStep(() => (chromeAdapter.captureFullPage || captureFullPage)(cdp, captureMetrics));
        const artifact = {
          evidenceId: state.fullPage.evidenceId,
          kind: 'full-page',
          state: 'pristine',
          dataUrl: state.fullPage.dataUrl,
          metadata: state.fullPage.metadata,
          hash: state.fullPage.hash,
        };
        state.artifacts.push(artifact);
        const observedHeight = (captureMetrics?.cssContentSize || captureMetrics?.contentSize)?.height;
        const capturedHeight = state.fullPage?.metadata?.height;
        if (Number.isFinite(observedHeight) && Number.isFinite(capturedHeight) && capturedHeight + 1 < observedHeight) {
          state.fullPageCapturedHeight = capturedHeight;
          recoverable('FULL_PAGE_CAPTURE_TRUNCATED', FULL_PAGE_CAPTURE_TRUNCATED_MESSAGE);
        }
        // Métricas depois da captura: se a própria captura mexeu no leiaute (por exemplo, ao sair da
        // viewport), a imagem já não serve de base para desenhar caixas.
        let captureMetricsAfter = null;
        try {
          captureMetricsAfter = await awaitStep(() => cdp.command('Page.getLayoutMetrics', {}));
        } catch (error) {
          rethrowAbort(error, signal);
        }
        mapSource = mapSourceGeometry({
          captureMetrics,
          captureMetricsAfter,
          // Os retângulos vêm do instantâneo lido pela coleta, então o estado a comparar é o do instantâneo
          // (`layoutMetricsAtSnapshot`), não o do fim da coleta: numa página que cresce sozinha, o fim da
          // coleta já é outro leiaute e a comparação passaria batido.
          observedMetrics: raw?.layoutMetricsAtSnapshot || state.snapshot?.document?.layoutMetrics,
          capturedHeight: state.fullPageCapturedHeight,
          deviceScaleFactor: state.environment?.viewport?.deviceScaleFactor,
        });
      } catch (error) {
        if (isPixelBoundaryInterruption(error, chromeAdapter)) {
          if (!canContinueWithoutFurtherPixels(error, chromeAdapter, signal)) throw error;
          furtherPixelCaptureSuppressed = true;
        }
        rethrowAbort(error, signal);
        recoverable('FULL_PAGE_CAPTURE_FAILED', 'Não foi possível capturar a página completa no estado original.');
      }
    }

    try {
      const axeRunner = typeof chromeAdapter.runAxeInTab === 'function'
        ? chromeAdapter.runAxeInTab.bind(chromeAdapter)
        : runAxeInTab;
      state.rawAxe = await awaitStep(() => axeRunner(tab.id));
    } catch (error) {
      rethrowAbort(error, signal);
      state.rawAxe = {
        status: 'partial', provenance: AXE_PROVENANCE, frames: [],
        diagnostics: [{ code: 'AXE_EXECUTION_FAILED', frameId: null }],
      };
    }
    // O prazo do axe expira do nosso lado, mas o axe continua rodando na thread da página até terminar. Se
    // seguirmos direto, cada comando seguinte (estrutura, ambiente) esgota o próprio prazo enquanto a página
    // está ocupada e a coleta falha. Esperamos a página voltar a responder, com teto (1.1.53).
    if (state.rawAxe?.diagnostics?.some(entry => entry?.code === 'AXE_TIMEOUT')) {
      await awaitStep(() => waitForPageResponsive(chromeAdapter, tab.id, signal));
    }

    try {
      const environment = await awaitStep(() => chromeAdapter.getEnvironment?.(tab.id, cdp, pristineMetrics));
      const viewport = environment?.viewport;
      if (!environment || typeof environment !== 'object' || typeof environment.chromeVersion !== 'string' ||
        !viewport ||
        ![viewport.width, viewport.height, viewport.deviceScaleFactor].every(value => Number.isFinite(value) && value > 0)) {
        throw new TypeError('Ambiente incompleto.');
      }
      state.environment = {
        chromeVersion: environment.chromeVersion.trim(),
        viewport: {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: viewport.deviceScaleFactor,
        },
      };
      if (!state.environment.chromeVersion) {
        recoverable('BROWSER_VERSION_UNAVAILABLE', 'A versão do navegador não pôde ser lida; as dimensões observadas foram preservadas.');
      }
    } catch (error) {
      rethrowAbort(error, signal);
      recoverable('ENVIRONMENT_UNAVAILABLE', 'Os metadados públicos do ambiente não puderam ser lidos.');
    }

    // Aquecimento descartável (1.1.60), imediatamente antes da coleta: ver src/background/full-page-warm-up.js.
    // Em páginas que montam conteúdo sob demanda, é a captura integral que acorda o resto da página. Sem
    // isso, o crescimento cai entre a captura e a leitura, o acordo de leiaute falha e o mapa sai sem caixa
    // nenhuma. A condição é a da captura integral: `captureFullPageEnabled === false` significa que não há
    // captura de página inteira para alinhar (nos modos `element-only` e `no-pixels` o aquecimento não roda),
    // e uma pausa de privacidade pendente significa que a auditoria nem chegou aqui — a execução observada só
    // acontece depois da porta de pixels, e o pedido de captura de quem está auditando a própria página é o
    // mesmo do modo `full-evidence`, onde a captura integral já acontece logo depois. Falha aqui é silenciosa
    // — a auditoria segue como em 1.1.59 —, mas cancelamento atravessa. Nada do resultado entra no modelo: o
    // catálogo de diagnósticos é fechado e não carrega números internos; a medida serve aos testes e à QA
    // (docs/qa/mapa-alinhado-1.1.60.md).
    if (chromeAdapter.captureFullPageEnabled !== false) {
      try {
        state.fullPageWarmUp = await warmUpFullPageLayout({ cdp, step: awaitStep, signal });
      } catch (error) {
        rethrowAbort(error, signal);
      }
    }

    await progress('collecting', 'Lendo a estrutura', 25);
    let raw;
    try {
      raw = chromeAdapter.collectPage
        ? await awaitStep(() => chromeAdapter.collectPage(cdp, tab.id, { signal }))
        : await awaitStep(() => collectPage(cdp, tab.id, { executeScript: chromeAdapter.executeScript, signal }));
      state.snapshot = structuredClone(normalizeSnapshot(raw));
      state.snapshot.document.url = projectAuditResourceOrigin(state.snapshot.document.url);
      state.accessibilityWidgets = detectAccessibilityWidgets(state.snapshot.document?.accessibilityWidgetSignals);
    } catch (error) {
      rethrowAbort(error, signal);
      fail('COLLECTION_FAILED', 'A estrutura da página não pôde ser coletada com segurança.', error);
    }

    // Colada na leitura da estrutura: os retângulos lidos acima e os pixels da imagem passam a ser do mesmo
    // estado da página. Nada interativo aconteceu entre uma coisa e outra (o axe e o ambiente vêm antes da
    // coleta; as verificações dinâmicas, depois).
    if (chromeAdapter.captureFullPageEnabled !== false) await capturePristineFullPage();

    if (fatal) throw Object.assign(new Error('AUDIT_FATAL_HANDLED'), { auditHandled: true });

    // A página atual é observada sem interação (promessa publicada de leitura); a página descartável
    // aceita sondas que mexem nela. Uma única leitura da política, usada pelas sondas dinâmicas e
    // pela sondagem de hover.
    const passive = PASSIVE_ATTACHED_ADAPTERS.has(chromeAdapter);

    try {
      const rawProbes = passive ? { targetSizes: state.snapshot.nodes.flatMap(node => {
        const rect = node.targetSizeRect;
        return rect ? [{ nodeId: node.nodeId, width: rect.width, height: rect.height, exception: 'unknown' }] : [];
      }) } : chromeAdapter.runDynamicProbes
        ? await awaitStep(() => chromeAdapter.runDynamicProbes(tab.id, cdp, { signal }))
        : await awaitStep(() => runDynamicProbes({ adapter: chromeAdapter.createProbeAdapter?.(tab.id, cdp), signal }));
      const normalizedProbes = normalizeProbes(rawProbes);
      if (passive) appendDiagnosticOnce('DYNAMIC_PROBES_OMITTED_PASSIVE', DYNAMIC_PROBES_OMITTED_PASSIVE_MESSAGE, true);
      if (probesTimedOut(rawProbes, normalizedProbes)) recoverable('DYNAMIC_PROBES_INCOMPLETE', 'As verificações dinâmicas atingiram o tempo limite.');
      state.snapshot = mergeProbesIntoSnapshot(state.snapshot, normalizedProbes);
      throwIfAborted(signal);
    } catch (error) {
      rethrowAbort(error, signal);
      recoverable('DYNAMIC_PROBES_FAILED', 'As verificações dinâmicas não puderam ser concluídas.');
    }

    // Conteúdo interativo revelado apenas por hover (5.1.13 / WCAG 2.1.1). Roda em modo descartável e
    // também na página atual: `CSS.forcePseudoState` não dispara eventos nem executa JS do site, e o
    // estado forçado é sempre desfeito antes da auditoria seguir — a página permanece como estava. A
    // única exceção é a confirmação de menu que abre por script com o ponteiro de verdade
    // (`Input.dispatchMouseEvent`), e por isso ela só é autorizada quando a página é descartável:
    // na página atual a promessa é de leitura, e ali o indício segue como revisão humana.
    try {
      state.snapshot = await awaitStep(() => applyHoverOnlyProbe(state.snapshot, cdp, {
        signal, allowPointerInteraction: !passive,
      }));
      throwIfAborted(signal);
    } catch (error) {
      rethrowAbort(error, signal);
      recoverable('DYNAMIC_PROBES_FAILED', 'As verificações dinâmicas não puderam ser concluídas.');
    }

    await progress('testing', 'Verificando acessibilidade', 50);
    try {
      const core = await awaitStep(() => runCoreAudit(state.snapshot));
      state.coreRuleResults = [...core.ruleResults];
      state.axe = normalizeAxeResults(state.rawAxe, {
        pageId: 'page-1', auditId, snapshot: state.snapshot,
        coreRuleResults: state.coreRuleResults, rulesVersion: METHODOLOGY.version,
      });
      state.limitations.push(...state.axe.limitations);
      if (state.axe.status === 'disabled') {
        state.diagnostics.push(diagnostic(
          'AXE_FEATURE_DISABLED',
          'O motor suplementar axe-core permaneceu desativado pelo gate MV3/CSP; o motor próprio continuou normalmente.',
          canonicalTime(now()), true,
        ));
      } else if (state.axe.status === 'partial') {
        recoverable('AXE_EXECUTION_FAILED', 'O motor suplementar axe-core teve cobertura parcial; o motor próprio continuou normalmente.');
      }
      const hybrid = mergeAxeSupplementalResults(core, state.axe);
      state.editorialRuleResults = [...await runEditorialRules(state.snapshot)];
      state.ruleResults = [...hybrid.ruleResults, ...state.editorialRuleResults];
      state.itemResults = [...hybrid.itemResults];
    } catch (error) {
      rethrowAbort(error, signal);
      fail('CORE_AUDIT_FAILED', 'O núcleo de regras não pôde concluir a auditoria.', error);
      settleFatalAxeObservation();
    } finally {
      state.rawAxe = null;
    }
    if (fatal) throw Object.assign(new Error('AUDIT_FATAL_HANDLED'), { auditHandled: true });

    await progress('evidence', 'Preparando evidências', 72);
    state.occurrences = [
      ...makeOccurrences(auditId, state.coreRuleResults, state.itemResults),
      ...structuredClone(state.axe.occurrences),
    ];
    allocateOccurrenceIds(state);
    const indexes = buildSnapshotIndexes(state.snapshot);
    const artifactByNode = new Map();
    const canCaptureElements = chromeAdapter.captureElementsEnabled !== false &&
      (Boolean(state.fullPage) || chromeAdapter.captureElementsWithoutFullPage === true);
    if (chromeAdapter.captureElementsEnabled !== false && !canCaptureElements &&
      state.occurrences.some(occurrence => occurrence.nodeId)) {
      recoverable('ELEMENT_CAPTURE_SKIPPED_NO_FULL_PAGE', 'As miniaturas de elementos não foram tentadas porque a captura original da página falhou.');
    }
    const thumbnailBudget = { started: Date.now(), attempted: 0, reached: false };
    for (const occurrence of state.occurrences) {
      throwIfAborted(signal);
      if (state.fullPage) occurrence.evidenceIds.push(state.fullPage.evidenceId);
      if (!occurrence.nodeId) continue;
      if (artifactByNode.has(occurrence.nodeId)) {
        occurrence.evidenceIds.push(artifactByNode.get(occurrence.nodeId).evidenceId);
        continue;
      }
      const node = indexes.byNodeId.get(occurrence.nodeId);
      if (!node) {
        recoverable('EVIDENCE_NODE_MISSING', 'Um elemento relacionado à ocorrência não estava mais disponível.', { occurrenceId: occurrence.occurrenceId });
        continue;
      }
      try {
        let snippet = '';
        // Numa página com milhares de ocorrências, um trecho de código por elemento (uma chamada CDP cada)
        // levava minutos. Passado o orçamento da fase, os elementos restantes ficam com seletor e descrição.
        const evidenceBudgetSpent = Date.now() - thumbnailBudget.started >= ELEMENT_CAPTURE_BUDGET.maxEvidenceMilliseconds;
        if (evidenceBudgetSpent && !thumbnailBudget.reached) {
          thumbnailBudget.reached = true;
          recoverable('ELEMENT_CAPTURE_BUDGET_REACHED', ELEMENT_CAPTURE_BUDGET_MESSAGE);
        }
        if (!evidenceBudgetSpent) try {
          const response = await awaitStep(() => cdp.command('DOM.getOuterHTML', { backendNodeId: node.backendNodeId }));
          snippet = sanitizeHtmlSnippetSource(typeof response?.outerHTML === 'string' ? response.outerHTML : '', {
            privateTextDescendant: hasPrivateTextAncestor(node, indexes),
          });
        } catch (error) {
          rethrowAbort(error, signal);
          recoverable('SNIPPET_CAPTURE_FAILED', 'O trecho de código do elemento não pôde ser capturado.', { occurrenceId: occurrence.occurrenceId });
        }
        let thumbnail = null;
        if (canCaptureElements && !furtherPixelCaptureSuppressed && !thumbnailBudget.reached &&
          (thumbnailBudget.attempted >= ELEMENT_CAPTURE_BUDGET.maxThumbnails ||
            Date.now() - thumbnailBudget.started >= ELEMENT_CAPTURE_BUDGET.maxMilliseconds)) {
          thumbnailBudget.reached = true;
          recoverable('ELEMENT_CAPTURE_BUDGET_REACHED', ELEMENT_CAPTURE_BUDGET_MESSAGE);
        }
        if (canCaptureElements && !furtherPixelCaptureSuppressed && !thumbnailBudget.reached) {
          thumbnailBudget.attempted += 1;
          try {
            // Remedição do alvo no instante da captura. O rect do snapshot é medido muito antes desta
            // fase; entre uma coisa e outra a página rola e troca de layout, e o inline multilinha vem
            // como caixa envolvente. `DOM.getContentQuads` devolve um quadrilátero por fragmento de
            // linha, em coordenadas da viewport, convertidas para o documento com as métricas tomadas
            // no mesmo momento. Falhou? O rect do snapshot continua valendo, e a limitação é declarada.
            let measurement = null;
            if (!evidenceBudgetSpent) {
              try {
                measurement = await awaitStep(() => measureElementTarget(cdp, node));
              } catch (error) {
                rethrowAbort(error, signal);
                measurement = null;
              }
            }
            if (measurement === null) {
              appendDiagnosticOnce('ELEMENT_MEASUREMENT_FALLBACK', ELEMENT_MEASUREMENT_FALLBACK_MESSAGE, true);
            } else if (measurement.status === 'frame-context') {
              appendDiagnosticOnce('ELEMENT_CAPTURE_FRAME_CONTEXT', ELEMENT_CAPTURE_FRAME_CONTEXT_MESSAGE, true);
            } else if (measurement.status !== 'measured') {
              appendDiagnosticOnce('ELEMENT_MEASUREMENT_FALLBACK', ELEMENT_MEASUREMENT_FALLBACK_MESSAGE, true);
            }
            thumbnail = await awaitStep(() => (chromeAdapter.captureElement || captureElement)(cdp, node.rect, {
              ...(state.snapshot.document.layoutMetrics || raw.layoutMetrics || pristineMetrics),
              ...(measurement?.status === 'measured' ? measurement.metrics : {}),
              ...(measurement?.status === 'measured' ? { measuredRects: measurement.rects } : {}),
              ...(Array.isArray(node.framePath) && node.framePath.length > 0 ? { framePath: node.framePath } : {}),
              ...(state.fullPage ? { fullPageEvidenceId: state.fullPage.evidenceId } : {}),
            }));
            if (thumbnail.status !== 'captured' && thumbnail.reason !== 'frame-context') {
              recoverable('ELEMENT_CAPTURE_FAILED', 'A miniatura do elemento não pôde ser capturada.', { occurrenceId: occurrence.occurrenceId });
            }
          } catch (error) {
            if (isPixelBoundaryInterruption(error, chromeAdapter)) {
              if (!canContinueWithoutFurtherPixels(error, chromeAdapter, signal)) throw error;
              furtherPixelCaptureSuppressed = true;
            }
            rethrowAbort(error, signal);
            recoverable('ELEMENT_CAPTURE_FAILED', 'A miniatura do elemento não pôde ser capturada.', { occurrenceId: occurrence.occurrenceId });
          }
        }
        const selector = buildStableSelector(node, indexes);
        const accessibility = projectElementAccessibility(node, indexes);
        const artifact = {
          evidenceId: `element-${stableHash(`${auditId}\u0000${node.nodeId}`)}`,
          kind: 'element', nodeId: node.nodeId, backendNodeId: node.backendNodeId,
          selector, snippet, accessibility,
          ...(thumbnail?.status === 'captured' ? {
            dataUrl: thumbnail.dataUrl,
            // SHA-256 do arquivo PNG capturado, já calculado na captura (`capture-evidence.js`). Fica
            // guardado para que o relatório entregue possa mostrá-lo sem recalcular nada: o anexo de
            // evidências é montado de forma síncrona, e o hash é o mesmo que o recálculo do artefato
            // obtém dos próprios pixels (`artifact-hash.js`), então nenhum hash guardado muda por causa
            // deste campo — auditorias anteriores, sem ele, continuam válidas.
            binarySha256: thumbnail.hash,
            ...(thumbnail.fullPageEvidenceId ? { fullPageEvidenceId: thumbnail.fullPageEvidenceId } : {}),
            metadata: thumbnail.metadata,
          } : {}),
          ...(node.media?.currentSrc ? { mediaUrl: safeUrl(node.media.currentSrc) } : {}),
        };
        artifact.hash = await awaitStep(() => hashEvidenceArtifact(artifact));
        artifactByNode.set(node.nodeId, artifact);
        state.artifacts.push(artifact);
        occurrence.evidenceIds.push(artifact.evidenceId);
      } catch (error) {
        if (isPixelBoundaryInterruption(error, chromeAdapter)) throw error;
        rethrowAbort(error, signal);
        recoverable('EVIDENCE_CAPTURE_FAILED', 'As evidências de uma ocorrência não puderam ser preparadas.', { occurrenceId: occurrence.occurrenceId });
      }
      throwIfAborted(signal);
    }
    if (state.fullPage && mapSource && typeof chromeAdapter.composeAnnouncementMap === 'function') {
      const pristineArtifact = state.artifacts.find(artifact => artifact.kind === 'full-page' && artifact.state === 'pristine');
      const sourceBefore = canonicalStringify(pristineArtifact);
      try {
        const map = await awaitStep(() => chromeAdapter.composeAnnouncementMap({
          pageId: 'page-1',
          snapshot: state.snapshot,
          fullPageEvidence: structuredClone({ ...pristineArtifact, pageId: 'page-1' }),
          // Geometria do instante da captura: inclui o teto de segurança (`mapSource.truncated`) e o fator de
          // escala do dispositivo. Os dois mapas usam exatamente os mesmos números.
          layoutMetrics: mapSource.layoutMetrics,
          sourceAligned: mapSource.aligned,
          signal,
        }));
        if (canonicalStringify(pristineArtifact) !== sourceBefore) {
          throw Object.assign(new Error('A captura pristine foi alterada durante a derivação.'), { code: 'ANNOTATION_MAP_SOURCE_INVALID' });
        }
        const recomputedMapHash = await awaitStep(() => hashEvidenceArtifact(map, {
          sourceArtifact: structuredClone({ ...pristineArtifact, pageId: 'page-1' }),
        }));
        if (map?.hash !== recomputedMapHash) {
          throw Object.assign(new Error('O hash do mapa derivado não corresponde ao conteúdo.'), { code: 'ANNOTATION_MAP_OUTPUT_INVALID' });
        }
        state.artifacts.push(structuredClone(map));
        if (map.status === 'partial') {
          recoverable('ANNOTATION_MAP_PARTIAL', 'O mapa visual foi gerado com cobertura parcial e limitações explícitas.');
        }
      } catch (error) {
        rethrowAbort(error, signal);
        const code = ANNOTATION_MAP_DIAGNOSTIC_CODES.has(error?.code) ? error.code : 'ANNOTATION_MAP_OUTPUT_INVALID';
        recoverable(code, 'O mapa visual derivado não pôde ser gerado localmente; a captura original foi preservada.');
      }
    }
    // Mapa do teclado: deriva da mesma captura integral pristine do mapa de anúncios, mas é julgado
    // pelas próprias regras. Sem captura integral (modos sem pixels) não há mapa — a lista numerada
    // do relatório continua existindo a partir do instantâneo, sem pixels.
    if (state.fullPage && mapSource && typeof chromeAdapter.composeKeyboardMap === 'function') {
      const pristineArtifact = state.artifacts.find(artifact => artifact.kind === 'full-page' && artifact.state === 'pristine');
      const sourceBefore = canonicalStringify(pristineArtifact);
      try {
        const map = await awaitStep(() => chromeAdapter.composeKeyboardMap({
          pageId: 'page-1',
          snapshot: state.snapshot,
          occurrences: state.occurrences,
          fullPageEvidence: structuredClone({ ...pristineArtifact, pageId: 'page-1' }),
          layoutMetrics: mapSource.layoutMetrics,
          sourceAligned: mapSource.aligned,
          signal,
        }));
        if (canonicalStringify(pristineArtifact) !== sourceBefore) {
          throw Object.assign(new Error('A captura pristine foi alterada durante a derivação.'), { code: 'KEYBOARD_MAP_SOURCE_INVALID' });
        }
        const recomputedMapHash = await awaitStep(() => hashEvidenceArtifact(map, {
          sourceArtifact: structuredClone({ ...pristineArtifact, pageId: 'page-1' }),
        }));
        if (map?.hash !== recomputedMapHash) {
          throw Object.assign(new Error('O hash do mapa do teclado não corresponde ao conteúdo.'), { code: 'KEYBOARD_MAP_OUTPUT_INVALID' });
        }
        state.artifacts.push(structuredClone(map));
        if (map.status === 'partial') {
          recoverable('KEYBOARD_MAP_PARTIAL', 'O mapa do teclado foi gerado com cobertura parcial e limitações explícitas.');
        }
      } catch (error) {
        rethrowAbort(error, signal);
        const code = KEYBOARD_MAP_DIAGNOSTIC_CODES.has(error?.code) ? error.code : 'KEYBOARD_MAP_OUTPUT_INVALID';
        recoverable(code, 'O mapa do teclado não pôde ser gerado localmente; a captura original foi preservada.');
      }
    }
    state.occurrences.push(...makeEditorialOccurrences(auditId, state.editorialRuleResults));
    allocateOccurrenceIds(state);
    state.manualReview = manualQueue(state.occurrences, state.itemResults);
    resolvePresentationTargets(state.occurrences, state.artifacts);
    const canonicalNodeByOccurrenceId = new Map(state.occurrences
      .filter(occurrence => occurrence.nodeId && occurrence.target?.nodeId === occurrence.nodeId &&
        occurrence.presentationTargetKey === `node:${occurrence.nodeId}`)
      .map(occurrence => [occurrence.occurrenceId, occurrence.nodeId]));
    state.presentation = dedupeFindingsForPresentation(state.occurrences, { canonicalNodeByOccurrenceId });

    await progress('reporting', 'Gerando relatório', 92);
    throwIfAborted(signal);
    state.status = recoverableFailure ? 'partial' : 'complete';
    try {
      const handoffModel = await awaitStep(() => draftModel({ ...state, endedAt: canonicalTime(now()) }));
      const handoff = await awaitStep(() => chromeAdapter.handoffReport?.(handoffModel));
      validateTransientReviewUrl(handoff?.reviewUrl, auditId, expectedExtensionId);
      state.report = {
        status: 'review-ready',
        reviewUrl: null,
        artifact: { status: 'pending', formats: [] },
      };
    } catch (error) {
      rethrowAbort(error, signal);
      recoverable('REPORT_HANDOFF_FAILED', 'A fila de revisão não pôde ser preparada.');
      state.status = 'partial';
    }
    throwIfAborted(signal);
    await progress('complete', 'Auditoria concluída', 100);
  } catch (error) {
    if (isPixelBoundaryInterruption(error, chromeAdapter)) throw error;
    if (!error?.auditHandled) fail('NAVIGATION_FAILED', signal?.aborted ? 'A auditoria foi cancelada.' : 'O site não pôde ser aberto de forma estável.', error);
  } finally {
    // O congelamento morre ANTES do desanexo, em qualquer desfecho: `Fetch.disable` libera os pedidos
    // eventualmente pausados, e o depurador só então é desanexado. Nenhuma interceptação sobrevive à
    // auditoria — e o e2e prova isso medindo a recarga da página depois do fim.
    //
    // Quem chama pode pedir a POSSE dessa sessão (`navigationHold`, usado pela auditoria anexada): a leitura
    // da página termina aqui, mas o relatório ainda leva segundos, e é sobre a página lida que ele fala. Com
    // a posse, o congelamento e o depurador continuam vivos até a hora em que o resultado estiver decidido —
    // a navegação da própria página não derruba, no meio do relatório, uma auditoria que já observou tudo.
    if (navigationFreeze || cdp) {
      const freeze = navigationFreeze;
      navigationFreeze = null;
      let blocked = 0;
      try { blocked = freeze ? freeze.blocked() : 0; } catch { blocked = 0; }
      if (Number.isSafeInteger(blocked) && blocked > 0) {
        appendDiagnosticOnce('PAGE_NAVIGATION_HELD', PAGE_NAVIGATION_HELD_MESSAGE, true);
      }
      const retained = navigationHold && typeof navigationHold === 'object';
      const stopFreeze = async () => {
        if (!freeze) return;
        try { await freeze.stop(); } catch { /* best-effort: o desanexo também desfaz o Fetch */ }
      };
      const disconnect = async () => {
        if (!cdp) return;
        try { await cdp.disconnect(); } catch { state.diagnostics.push(diagnostic('CDP_DISCONNECT_FAILED', 'A sessão de depuração não pôde ser encerrada automaticamente.', canonicalTime(now()), true)); if (state.status === 'complete') state.status = 'partial'; }
      };
      if (retained) {
        navigationHold.release = async () => { await stopFreeze(); await disconnect(); };
      } else {
        await stopFreeze();
        await disconnect();
      }
    }
    if (tab && closeAuditTab !== false) {
      try { await chromeAdapter.removeTab(tab.id); } catch { state.diagnostics.push(diagnostic('TAB_CLOSE_FAILED', 'A aba descartável não pôde ser fechada automaticamente.', canonicalTime(now()), true)); if (state.status === 'complete') state.status = 'partial'; }
    }
  }
  return finalize();

  async function finalize() {
    if (state.status === 'running') state.status = recoverableFailure ? 'partial' : fatal ? 'failed' : 'complete';
    if (['failed', 'cancelled'].includes(state.status)) settleFatalAxeObservation();
    if (state.finalUrlObserved && chromeAdapter.captureFullPageEnabled !== false && !state.fullPage &&
      !state.diagnostics.some(entry => entry.code === 'FULL_PAGE_CAPTURE_FAILED')) {
      appendDiagnosticOnce(
        'FULL_PAGE_CAPTURE_FAILED',
        'Não foi possível capturar a página completa no estado original.',
        true,
      );
    }
    state.endedAt = canonicalTime(now());
    if (!state.occurrences.length && state.coreRuleResults.length) {
      state.occurrences = makeOccurrences(auditId, state.coreRuleResults, state.itemResults);
    }
    if (state.occurrences.length) allocateOccurrenceIds(state);
    if (!state.manualReview.length && state.occurrences.length) state.manualReview = manualQueue(state.occurrences, state.itemResults);
    const final = await draftModel(state);
    return final;
  }
}

function opaqueId(randomBytes, prefix) {
  const bytes = randomBytes(16);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) throw new TypeError('AUDIT_EXECUTION_DENIED');
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return `${prefix}-${btoa(text).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')}`;
}

function internalContract(chromeAdapter) {
  const descriptor = chromeAdapter && typeof chromeAdapter === 'object'
    ? Object.getOwnPropertyDescriptor(chromeAdapter, AUDIT_EXECUTION_INTERNAL)
    : null;
  const value = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
  if (!value?.sessionArea || typeof value.sessionArea.get !== 'function' || typeof value.sessionArea.set !== 'function' ||
    typeof value.sessionArea.remove !== 'function' || typeof value.randomBytes !== 'function') {
    throw new TypeError('AUDIT_EXECUTION_DENIED');
  }
  return value;
}

function ownValue(value, key) {
  const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : null;
  return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function captureExactRecord(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function copyEvidenceUrlV1(value) {
  const copy = captureExactRecord(value, ['version', 'href', 'queryIncluded', 'redactedSegments']);
  return copy && isEvidenceUrlV1(copy) ? Object.freeze(copy) : null;
}

function copyOwnedObservedTarget(value) {
  const copy = captureExactRecord(value, [
    'version', 'kind', 'ownershipId', 'tabId', 'windowId', 'documentId', 'urlEvidence',
    'urlSessionDigest', 'cleanupMode', 'pageId',
  ]);
  const urlEvidence = copy && copyEvidenceUrlV1(copy.urlEvidence);
  if (!copy || copy.version !== 'ObservedTargetV1' || copy.kind !== 'owned-disposable' ||
    typeof copy.ownershipId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(copy.ownershipId) ||
    !Number.isSafeInteger(copy.tabId) || copy.tabId < 0 ||
    !Number.isSafeInteger(copy.windowId) || copy.windowId < 0 ||
    typeof copy.documentId !== 'string' || copy.documentId.length < 1 || copy.documentId.length > 512 ||
    typeof copy.urlSessionDigest !== 'string' || !/^hmac-sha256:[A-Za-z0-9_-]{43}$/u.test(copy.urlSessionDigest) ||
    !['always', 'pre-observation-failure'].includes(copy.cleanupMode) ||
    !(copy.pageId === null || typeof copy.pageId === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(copy.pageId)) ||
    !urlEvidence || urlEvidence.queryIncluded) return null;
  return Object.freeze({ ...copy, urlEvidence });
}

function copyAttachedObservedTarget(value) {
  const copy = captureExactRecord(value, [
    'version', 'kind', 'tabId', 'windowId', 'documentId', 'urlEvidence', 'urlSessionDigest',
  ]);
  const urlEvidence = copy && copyEvidenceUrlV1(copy.urlEvidence);
  if (!copy || copy.version !== 'ObservedTargetV1' || copy.kind !== 'attached' ||
    !Number.isSafeInteger(copy.tabId) || copy.tabId < 0 ||
    !Number.isSafeInteger(copy.windowId) || copy.windowId < 0 ||
    typeof copy.documentId !== 'string' || copy.documentId.length < 1 || copy.documentId.length > 512 ||
    typeof copy.urlSessionDigest !== 'string' || !/^hmac-sha256:[A-Za-z0-9_-]{43}$/u.test(copy.urlSessionDigest) ||
    !urlEvidence || urlEvidence.queryIncluded) return null;
  return Object.freeze({ ...copy, urlEvidence });
}

function recoveredOwnedCleanupState(value, { auditId, ownershipId, observedTarget, cleanupMode }) {
  const record = captureExactRecord(value, [
    'version', 'ownershipId', 'auditId', 'purpose', 'tabId', 'windowId',
    'cleanupMode', 'state', 'createdAt', 'updatedAt',
  ]);
  if (!record || record.version !== 2 || record.ownershipId !== ownershipId || record.auditId !== auditId ||
    record.purpose !== 'audit' || record.tabId !== observedTarget.tabId || record.windowId !== observedTarget.windowId ||
    record.cleanupMode !== cleanupMode || !['removed', 'cleanup-pending', 'retained-for-review'].includes(record.state) ||
    (record.state === 'retained-for-review' && cleanupMode !== 'pre-observation-failure')) return null;
  try {
    if (canonicalTime(record.createdAt) !== record.createdAt || canonicalTime(record.updatedAt) !== record.updatedAt) return null;
  } catch { return null; }
  return record.state;
}

function copyOwnedInterruption(value, { auditId, ownershipId, cleanupMode }) {
  const copy = captureExactRecord(value, [
    'version', 'auditId', 'observationState', 'observedTarget', 'ownershipState', 'reason',
  ]);
  const observedTarget = copy && copyOwnedObservedTarget(copy.observedTarget);
  if (!copy || copy.version !== 1 || copy.auditId !== auditId || copy.observationState !== 'observed' ||
    !['cancelled', 'failed'].includes(copy.reason) || !observedTarget || observedTarget.ownershipId !== ownershipId ||
    observedTarget.cleanupMode !== cleanupMode ||
    !['removed', 'cleanup-pending', 'retained-for-review'].includes(copy.ownershipState)) return null;
  return Object.freeze({ ...copy, observedTarget });
}

function copyAttachedInterruption(value, { auditId, target }) {
  const copy = captureExactRecord(value, [
    'version', 'auditId', 'observationState', 'observedTarget', 'ownershipState', 'reason',
  ]);
  const observedTarget = copy && copyAttachedObservedTarget(copy.observedTarget);
  if (!copy || copy.version !== 1 || copy.auditId !== auditId || copy.observationState !== 'observed' ||
    copy.ownershipState !== 'attached' || copy.reason !== 'cancelled' || !observedTarget ||
    observedTarget.tabId !== target.tabId || observedTarget.windowId !== target.windowId ||
    observedTarget.documentId !== target.documentId || observedTarget.urlSessionDigest !== target.initialUrlSessionDigest ||
    observedTarget.urlEvidence.href !== target.initialUrlEvidence.href) return null;
  return Object.freeze({ ...copy, observedTarget });
}

function attachedTarget(value) {
  const target = captureExactRecord(value, [
    'kind', 'tabId', 'windowId', 'documentId', 'initialUrlEvidence', 'initialUrlSessionDigest',
  ]);
  if (!target || target.kind !== 'attached' || !Number.isSafeInteger(target.tabId) || target.tabId < 0 ||
    !Number.isSafeInteger(target.windowId) || target.windowId < 0 ||
    typeof target.documentId !== 'string' || !/^[A-Za-z0-9._:-]{1,240}$/u.test(target.documentId) ||
    typeof target.initialUrlSessionDigest !== 'string' ||
    !/^hmac-sha256:[A-Za-z0-9_-]{43}$/u.test(target.initialUrlSessionDigest)) throw new TypeError('ATTACHED_AUDIT_EXECUTION_DENIED');
  let initialUrlEvidence;
  try {
    initialUrlEvidence = typeof target.initialUrlEvidence === 'string'
      ? sanitizeEvidenceUrlV1(target.initialUrlEvidence, { includeQuery: false })
      : copyEvidenceUrlV1(target.initialUrlEvidence);
  } catch { throw new TypeError('ATTACHED_AUDIT_EXECUTION_DENIED'); }
  if (!initialUrlEvidence || initialUrlEvidence.queryIncluded) throw new TypeError('ATTACHED_AUDIT_EXECUTION_DENIED');
  return Object.freeze({ ...target, initialUrlEvidence });
}

function proofMatchesAttached(value, target) {
  const proof = captureExactRecord(value, ['tabId', 'windowId', 'documentId', 'urlSessionDigest']);
  return Boolean(proof && proof.tabId === target.tabId && proof.windowId === target.windowId &&
    proof.documentId === target.documentId && proof.urlSessionDigest === target.initialUrlSessionDigest);
}

function captureAttachedFacadeArgs(value) {
  const allowed = [
    'auditId', 'sessionCapabilityId', 'target', 'capturePolicy', 'chromeAdapter', 'modelNow', 'signal',
    'expectedExtensionId', 'pageId', 'onCheckpoint', 'persistAuditModel', 'privacyGate', 'resumeCheckpoint',
    'onObservationComplete',
  ];
  const required = [
    'auditId', 'sessionCapabilityId', 'target', 'capturePolicy', 'chromeAdapter', 'modelNow',
    'onCheckpoint', 'persistAuditModel',
  ];
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' || !allowed.includes(key)) || required.some(key => !keys.includes(key))) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function pixelBoundaryError() {
  const error = new TypeError('PIXEL_CAPTURE_BOUNDARY_DENIED');
  PIXEL_BOUNDARY_INTERRUPTION.add(error);
  return error;
}

function isPixelBoundaryInterruption(error, adapter) {
  return Boolean(error && typeof error === 'object' &&
    (PIXEL_BOUNDARY_INTERRUPTION.has(error) || isPixelRasterBoundaryInterruptionV1(error) ||
      (adapter?.privacyGate && isPixelPrivacyPauseInterruptionV1(error, adapter.privacyGate))));
}

function canContinueWithoutFurtherPixels(error, adapter, signal) {
  const boundary = OBSERVED_LEGACY_RASTER_BOUNDARIES.get(adapter);
  const safeRefusal = Boolean(!signal?.aborted && boundary && isPixelRasterBoundaryInterruptionV1(error) &&
    !isPixelPrivacyPauseInterruptionV1(error, adapter?.privacyGate) &&
    !didPixelRasterTargetChangeV1(boundary));
  if (!safeRefusal) return false;
  if (didPixelRasterStartV1(boundary)) return true;
  try { return settleRefusedPixelRasterV1(boundary) === true; }
  catch { return false; }
}

function createObservedLegacyAdapter(chromeAdapter, observedTarget, capturePolicy, privacyGate, rasterBoundary) {
  const pixelMode = capturePolicy.mode !== 'no-pixels';
  const adapter = {
    ...chromeAdapter,
    privacyGate,
    captureFullPageEnabled: capturePolicy.captureFullPage,
    captureElementsEnabled: capturePolicy.captureElements,
    captureElementsWithoutFullPage: capturePolicy.captureElements && !capturePolicy.captureFullPage,
    async createTab() { return { id: observedTarget.tabId, windowId: observedTarget.windowId }; },
    async navigateTab() {},
    async waitForStable() { return { url: observedTarget.urlEvidence.href }; },
    async getFinalUrl() { return observedTarget.urlEvidence.href; },
    async removeTab() {},
    async captureFullPage(...args) {
      if (!pixelMode || !rasterBoundary) throw pixelBoundaryError();
      return rasterBoundary.captureFullPage(...args);
    },
    async captureElement(...args) {
      if (!pixelMode || !rasterBoundary) throw pixelBoundaryError();
      return rasterBoundary.captureElement(...args);
    },
    composeAnnouncementMap: capturePolicy.composeAnnouncementMap ? chromeAdapter.composeAnnouncementMap : undefined,
    async settlePixelBoundary() {
      if (!pixelMode || !rasterBoundary || didPixelRasterStartV1(rasterBoundary)) return;
      await rasterBoundary.settle();
    },
  };
  OBSERVED_LEGACY_RASTER_BOUNDARIES.set(adapter, rasterBoundary);
  if (observedTarget.kind === 'attached') PASSIVE_ATTACHED_ADAPTERS.add(adapter);
  return adapter;
}

function alignLegacyDraftWithObservedEvidence(draft, evidenceUrl, requestedEvidenceUrl = null) {
  const aligned = structuredClone(draft);
  if (requestedEvidenceUrl !== null) aligned.requestedUrl = requestedEvidenceUrl;
  aligned.finalUrl = evidenceUrl;
  aligned.finalUrlObserved = true;
  return deepFreeze(aligned);
}

function projectCancelledAuditDraft(draft, cancellationAt) {
  const cancelled = structuredClone(draft);
  cancelled.session.status = 'cancelled';
  cancelled.session.partial = false;
  cancelled.session.diagnostics = (Array.isArray(cancelled.session.diagnostics) ? cancelled.session.diagnostics : [])
    .filter(entry => entry?.recoverable !== false);
  cancelled.timestamps = { ...cancelled.timestamps, endedAt: cancellationAt };
  cancelled.progress = (Array.isArray(cancelled.progress) ? cancelled.progress : [])
    .filter(entry => entry?.phase !== 'complete' && !/concluída/iu.test(entry?.message ?? ''));
  cancelled.progress.push({
    type: 'AUDIT_PROGRESS', sessionId: cancelled.auditId, auditId: cancelled.auditId,
    phase: 'cancelled', message: 'Auditoria cancelada', percent: 100, at: cancellationAt,
  });
  cancelled.report = {
    status: 'pending', reviewUrl: null,
    artifact: { status: 'pending', formats: [] },
  };
  cancelled.session.diagnostics.push(diagnostic(
    'NAVIGATION_FAILED', 'A auditoria foi cancelada.', cancellationAt, false,
  ));
  return deepFreeze(cancelled);
}

async function createInterruptedObservedDraft({ auditId, requestedUrl, observedTarget, capturePolicy, startedAt, now }) {
  const endedAt = canonicalTime(now());
  const captureDiagnostic = capturePolicy.mode === 'no-pixels'
    ? ['PIXEL_CAPTURE_OMITTED', 'Nenhuma captura raster foi coletada no modo sem imagens.']
    : capturePolicy.mode === 'element-only'
      ? ['FULL_PAGE_CAPTURE_OMITTED', 'A captura integral e o mapa anotado foram omitidos pela política; miniaturas de elementos permaneceram permitidas.']
      : ['FULL_PAGE_CAPTURE_NOT_ATTEMPTED', 'A captura integral não foi tentada porque a execução terminou antes da etapa de pixels.'];
  return draftModel({
    auditId,
    requestedUrl,
    finalUrl: observedTarget.urlEvidence.href,
    attempted: true,
    finalUrlObserved: true,
    startedAt,
    endedAt,
    environment: {
      chromeVersion: '',
      viewport: { width: null, height: null, deviceScaleFactor: null },
    },
    status: 'failed',
    diagnostics: [diagnostic(
      captureDiagnostic[0],
      captureDiagnostic[1],
      endedAt,
      true,
    )],
    progress: [],
    snapshot: null,
    ruleResults: [],
    coreRuleResults: [],
    itemResults: fallbackItems(),
    occurrences: [],
    manualReview: [],
    reviewDecisions: [],
    editorialRuleResults: [],
    axe: undefined,
    accessibilityWidgets: detectAccessibilityWidgets(null),
    limitations: [],
    presentation: { groups: [], occurrenceCount: 0, hiddenOccurrenceCount: 0 },
    artifacts: [],
    fullPage: null,
    report: { status: 'pending', reviewUrl: null, artifact: { status: 'pending', formats: [] } },
  });
}

async function cancelledAuditProjection({ draft, now, expectedExtensionId, rulesVersion, manifestVersion }) {
  const cancellationAt = canonicalTime(now());
  const cancelled = projectCancelledAuditDraft(draft, cancellationAt);
  const model = await enrichAuditForReport(cancelled, {
    now,
    manifestVersion,
    expectedExtensionId,
    browserVersion: cancelled.environment?.chromeVersion || 'não disponível',
    rulesVersion: cancelled.methodology?.version || rulesVersion,
  });
  return Object.freeze({ draft: cancelled, model });
}

async function cancelledAuditModel(args) {
  return (await cancelledAuditProjection(args)).model;
}

/** Production attached-page façade. It never accepts or owns a raw navigation target. */
export async function runAttachedAuditExecution(rawArgs = {}) {
  const args = captureAttachedFacadeArgs(rawArgs);
  if (!args) throw new TypeError('ATTACHED_AUDIT_EXECUTION_DENIED');
  const {
    auditId, sessionCapabilityId, target: inputTarget, capturePolicy, chromeAdapter, modelNow,
    signal, expectedExtensionId, pageId = 'page-1', onCheckpoint, persistAuditModel, privacyGate = null,
    resumeCheckpoint: inputResumeCheckpoint = null, onObservationComplete = null,
  } = args;
  const target = attachedTarget(inputTarget);
  const policyRecord = captureExactRecord(capturePolicy, [
    'version', 'mode', 'includeQuery', 'captureFullPage', 'captureElements', 'composeAnnouncementMap',
  ]);
  const safeCapturePolicy = policyRecord && isCapturePolicyV1(policyRecord) ? Object.freeze(policyRecord) : null;
  if (typeof auditId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(auditId) ||
    typeof sessionCapabilityId !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(sessionCapabilityId) ||
    !safeCapturePolicy || safeCapturePolicy.includeQuery !== false ||
    (safeCapturePolicy.mode === 'no-pixels' ? privacyGate !== null : !isPixelPrivacyGateV1(privacyGate)) ||
    pageId !== 'page-1' ||
    typeof modelNow !== 'function' || typeof onCheckpoint !== 'function' || typeof persistAuditModel !== 'function' ||
    !(onObservationComplete === null || typeof onObservationComplete === 'function') ||
    !chromeAdapter || typeof chromeAdapter !== 'object') {
    throw new TypeError('ATTACHED_AUDIT_EXECUTION_DENIED');
  }
  let probeDocumentIdentity;
  let probeSensitiveCaptureSignals;
  let legacyEffects;
  try {
    probeDocumentIdentity = requiredAdapterMethod(chromeAdapter, 'probeDocumentIdentity');
    legacyEffects = captureLegacyEffects(chromeAdapter);
    if (safeCapturePolicy.mode !== 'no-pixels') {
      probeSensitiveCaptureSignals = requiredAdapterMethod(chromeAdapter, 'probeSensitiveCaptureSignals');
      if (safeCapturePolicy.captureFullPage && typeof legacyEffects.captureFullPage !== 'function' ||
        safeCapturePolicy.captureElements && typeof legacyEffects.captureElement !== 'function' ||
        safeCapturePolicy.composeAnnouncementMap && typeof legacyEffects.composeAnnouncementMap !== 'function') {
        throw new TypeError('ATTACHED_AUDIT_EXECUTION_DENIED');
      }
    }
  } catch { throw new TypeError('ATTACHED_AUDIT_EXECUTION_DENIED'); }
  const inventory = await createInstalledCoreRuleInventory();
  let resumeCheckpoint = null;
  if (inputResumeCheckpoint !== null) {
    try {
      resumeCheckpoint = validateExecutionCheckpoint({
        auditId,
        checkpoint: inputResumeCheckpoint,
        pageOrder: [pageId],
      });
    } catch { throw new TypeError('ATTACHED_AUDIT_EXECUTION_DENIED'); }
    const resumePage = resumeCheckpoint.pages[0];
    if (safeCapturePolicy.mode === 'no-pixels' || resumePage.attempted !== true ||
      resumePage.rulesVersion !== inventory.rulesVersion ||
      resumePage.inventoryVersion !== inventory.inventoryVersion ||
      resumePage.inventoryHash !== inventory.sha256 || resumePage.outcomes.length !== 0) {
      throw new TypeError('ATTACHED_AUDIT_EXECUTION_DENIED');
    }
  }
  const startedAt = resumeCheckpoint?.pages[0].startedAt ?? canonicalTime(modelNow());
  const checkpointRecorder = await createPageCheckpointRecorder({
    auditId, pageId, startedAt, rulesVersion: inventory.rulesVersion, inventory, onCheckpoint,
  });
  let legacyDraft = null;
  let terminalModel = null;
  let terminalPersistenceStarted = false;
  let runnerTargetChanged = false;
  let runnerProofCount = 0;
  let runnerFinalProofAttempted = false;
  let runnerFinalProofMatched = false;
  let finalProofAttempted = false;
  let finalProofMatched = false;
  let closedFailureCode = 'AUDIT_FAILED';
  let pixelCollectionStarted = false;
  let pixelStarted = false;
  let pixelTargetChanged = false;
  let pixelRasterBoundary = null;
  // Posse da sessão entregue pela leitura da página: fica viva até o resultado estar decidido, para que a
  // navegação da própria página não caia no meio de um relatório já calculado sobre ela.
  const navigationHold = {};
  const services = Object.freeze({
    async collectObservedPage({ observedTarget }) {
      if (safeCapturePolicy.mode !== 'no-pixels') pixelCollectionStarted = true;
      pixelRasterBoundary = safeCapturePolicy.mode === 'no-pixels' ? null : createPixelRasterBoundaryV1({
        auditId,
        observedTarget,
        capturePolicy: safeCapturePolicy,
        privacyGate,
        probeDocumentIdentity,
        probeSensitiveCaptureSignals,
        signal,
        captureFullPage: safeCapturePolicy.captureFullPage ? legacyEffects.captureFullPage : null,
        captureElement: safeCapturePolicy.captureElements ? legacyEffects.captureElement : null,
      });
      const observedAdapter = createObservedLegacyAdapter(
        legacyEffects,
        observedTarget,
        safeCapturePolicy,
        privacyGate,
        pixelRasterBoundary,
      );
      legacyDraft = await runLegacyAudit({
        url: target.initialUrlEvidence.href,
        chromeAdapter: observedAdapter,
        now: modelNow,
        idFactory: () => auditId,
        signal,
        closeAuditTab: false,
        expectedExtensionId,
        startedAt,
        navigationHold,
      });
      if (safeCapturePolicy.mode === 'element-only' &&
        !['failed', 'cancelled'].includes(legacyDraft.session.status)) {
        await observedAdapter.settlePixelBoundary();
      }
      // A observação acabou — inclusive a última fronteira de pixels do modo `element-only`: daqui para a frente
      // nada mais lê nem fotografa o documento vivo, o que falta é montar o relatório. Só uma observação que
      // terminou de verdade avisa; falha ou cancelamento seguem o caminho de sempre. A identidade do documento
      // continua provada em `persistAuditModel` antes de gravar. O aviso é best-effort e nunca derruba a auditoria.
      if (onObservationComplete !== null && !['failed', 'cancelled'].includes(legacyDraft.session.status)) {
        try { onObservationComplete(); } catch { /* aviso interno; a auditoria segue */ }
      }
      legacyDraft = alignLegacyDraftWithObservedEvidence(
        legacyDraft,
        observedTarget.urlEvidence.href,
        target.initialUrlEvidence.href,
      );
      terminalModel = await enrichAuditForReport(legacyDraft, {
        now: modelNow,
        manifestVersion: legacyEffects.manifestVersion,
        expectedExtensionId,
        browserVersion: legacyDraft.environment?.chromeVersion || 'não disponível',
        rulesVersion: legacyDraft.methodology?.version || inventory.rulesVersion,
      });
      return Object.freeze({ version: 1, kind: 'legacy-observation' });
    },
    async runCoreRules() {
      return Object.freeze({
        ruleResults: terminalModel.ruleResults.filter(result => result.source?.engine === 'audita-core'),
      });
    },
    async buildAuditModel() { return terminalModel; },
    async persistAuditModel(model) {
      finalProofAttempted = true;
      let finalProof;
      try { finalProof = await probeDocumentIdentity(target.tabId); } catch {
        closedFailureCode = 'AUDIT_FAILED';
        throw new Error('TARGET_PROOF_UNAVAILABLE');
      }
      if (!proofMatchesAttached(finalProof, target)) {
        closedFailureCode = 'TARGET_CHANGED';
        throw new Error('TARGET_CHANGED');
      }
      finalProofMatched = true;
      if (signal?.aborted) {
        closedFailureCode = 'AUDIT_ABORTED';
        throw new Error('AUDIT_ABORTED');
      }
      if (model?.session?.status === 'cancelled') {
        closedFailureCode = 'AUDIT_FAILED';
        throw new Error('AUDIT_FAILED');
      }
      terminalPersistenceStarted = true;
      await persistAuditModel(model);
    },
  });
  const pixelPreflight = safeCapturePolicy.mode === 'no-pixels' ? null : createPixelPipelinePreflightV1(privacyGate, {
    probeSensitiveCaptureSignals: observedTarget =>
      probeSensitiveCaptureSignals(observedTarget.tabId, observedTarget.documentId),
  });
  const runPipeline = createObservedPipelineRunner({
    checkpointRecorder, services,
    ...(safeCapturePolicy.mode === 'no-pixels' ? {} : { privacyGate, pixelPreflight }),
  });
  const runnerAdapter = Object.freeze({
    async probeDocumentIdentity(tabId) {
      runnerProofCount += 1;
      const finalAttempt = runnerProofCount >= 2;
      if (finalAttempt) runnerFinalProofAttempted = true;
      let proof;
      try { proof = await probeDocumentIdentity(tabId); } catch {
        if (finalAttempt) closedFailureCode = 'AUDIT_FAILED';
        throw new Error('TARGET_PROOF_UNAVAILABLE');
      }
      const matched = proofMatchesAttached(proof, target);
      if (finalAttempt) runnerFinalProofMatched = matched;
      if (!matched) {
        runnerTargetChanged = true;
        closedFailureCode = 'TARGET_CHANGED';
      }
      return proof;
    },
    runPipeline,
  });
  let observed = null;
  let observedInterruption = null;
  try {
    observed = await runObservedTabAudit({
      auditId,
      target,
      chromeAdapter: runnerAdapter,
      capturePolicy: safeCapturePolicy,
      privacyGate,
      onCheckpoint,
      now: modelNow,
      signal,
      expectedExtensionId,
    });
  } catch (error) {
    observedInterruption = copyAttachedInterruption(
      readObservedAuditInterruption(error),
      { auditId, target },
    );
    if (terminalPersistenceStarted && !(signal?.aborted && legacyDraft)) {
      throw new TypeError('ATTACHED_AUDIT_EXECUTION_DENIED');
    }
    pixelStarted = pixelStarted || didPixelRasterStartV1(pixelRasterBoundary);
    pixelTargetChanged = pixelTargetChanged || didPixelRasterTargetChangeV1(pixelRasterBoundary);
    if (runnerTargetChanged || pixelTargetChanged) closedFailureCode = 'TARGET_CHANGED';
    const attestationAttempted = runnerFinalProofAttempted || finalProofAttempted;
    const attestationsMatched = (!runnerFinalProofAttempted || runnerFinalProofMatched) &&
      (!finalProofAttempted || finalProofMatched);
    if (signal?.aborted && legacyDraft && closedFailureCode !== 'TARGET_CHANGED' &&
      (!attestationAttempted || attestationsMatched)) closedFailureCode = 'AUDIT_ABORTED';
  } finally {
    pixelStarted = pixelStarted || didPixelRasterStartV1(pixelRasterBoundary);
    pixelTargetChanged = pixelTargetChanged || didPixelRasterTargetChangeV1(pixelRasterBoundary);
    if (pixelTargetChanged) closedFailureCode = 'TARGET_CHANGED';
    if (pixelCollectionStarted && observed?.status !== 'privacy-paused') {
      await privacyGate.afterPixels({ auditId, pixelStarted });
    }
    // O relatório já foi decidido (ou já falhou): a página volta a navegar como quiser.
    await releaseNavigationHold(navigationHold);
  }
  let lastCheckpoint = null;
  try {
    lastCheckpoint = validateExecutionCheckpoint({
      auditId,
      checkpoint: checkpointRecorder.snapshot(),
      pageOrder: [pageId],
    });
  } catch { /* a execução não chegou ao primeiro checkpoint */ }
  if (observedInterruption && signal?.aborted && !pixelStarted &&
    !terminalPersistenceStarted && !legacyDraft && lastCheckpoint) {
    const draft = await createInterruptedObservedDraft({
      auditId,
      requestedUrl: target.initialUrlEvidence.href,
      observedTarget: observedInterruption.observedTarget,
      capturePolicy: safeCapturePolicy,
      startedAt,
      now: modelNow,
    });
    const model = await cancelledAuditModel({
      draft, now: modelNow, expectedExtensionId, rulesVersion: inventory.rulesVersion,
      manifestVersion: legacyEffects.manifestVersion,
    });
    return deepFreeze({ version: 1, auditId, state: 'model', failureCode: null, model, checkpoint: lastCheckpoint });
  }
  if (observed?.observationState === 'pre-observation-failure') {
    return deepFreeze({
      version: 1,
      auditId,
      state: 'revoked',
      failureCode: runnerTargetChanged ? 'TARGET_CHANGED' : 'AUDIT_FAILED',
      model: null,
      checkpoint: lastCheckpoint,
    });
  }
  if (observed?.status === 'privacy-paused' && observed.observationState === 'observed' && lastCheckpoint) {
    return deepFreeze({ version: 1, auditId, state: 'privacy-paused', failureCode: null, model: null, checkpoint: lastCheckpoint });
  }
  if (observed?.observationState === 'observed' && ['complete', 'partial', 'cancelled', 'failed'].includes(observed.status)) {
    let model;
    try { model = createAuditModel(observed.model); } catch { throw new TypeError('ATTACHED_AUDIT_EXECUTION_DENIED'); }
    if (model.auditId !== auditId || model.session.status !== observed.status || !lastCheckpoint) {
      throw new TypeError('ATTACHED_AUDIT_EXECUTION_DENIED');
    }
    return deepFreeze({ version: 1, auditId, state: 'model', failureCode: null, model, checkpoint: lastCheckpoint });
  }
  if (closedFailureCode === 'AUDIT_ABORTED' && legacyDraft && lastCheckpoint) {
    const model = await cancelledAuditModel({
      draft: legacyDraft, now: modelNow, expectedExtensionId, rulesVersion: inventory.rulesVersion,
      manifestVersion: legacyEffects.manifestVersion,
    });
    if (terminalPersistenceStarted) await persistAuditModel(model);
    return deepFreeze({ version: 1, auditId, state: 'model', failureCode: null, model, checkpoint: lastCheckpoint });
  }
  return deepFreeze({
    version: 1,
    auditId,
    state: 'revoked',
    failureCode: closedFailureCode === 'TARGET_CHANGED' ? 'TARGET_CHANGED' : 'AUDIT_FAILED',
    model: null,
    checkpoint: lastCheckpoint,
  });
}

function checkpointProjection(checkpoint, { sourceAuditId, sourcePageId, auditId, pageId }) {
  const source = validateExecutionCheckpoint({
    auditId: sourceAuditId,
    checkpoint,
    pageOrder: [sourcePageId],
  });
  const projected = {
    version: source.version,
    auditId,
    pages: [{ ...source.pages[0], pageId }],
  };
  return validateExecutionCheckpoint({ auditId, checkpoint: projected, pageOrder: [pageId] });
}

function requiredAdapterMethod(adapter, name) {
  const value = ownValue(adapter, name);
  if (typeof value !== 'function') throw new TypeError('AUDIT_EXECUTION_DENIED');
  return value.bind(adapter);
}

function optionalAdapterMethod(adapter, name) {
  const value = ownValue(adapter, name);
  if (value === undefined) return undefined;
  if (typeof value !== 'function') throw new TypeError('AUDIT_EXECUTION_DENIED');
  return value.bind(adapter);
}

function captureLegacyEffects(adapter) {
  const version = ownValue(adapter, 'manifestVersion');
  const captured = { manifestVersion: typeof version === 'string' && /^\d{1,5}(?:\.\d{1,5}){0,3}$/u.test(version)
    ? version : 'não disponível' };
  for (const name of [
    'connectCdp', 'beginNavigationFreeze', 'runAxeInTab', 'collectPage', 'runDynamicProbes', 'getEnvironment',
    'emitProgress', 'handoffReport', 'executeScript', 'createProbeAdapter',
    'captureFullPage', 'captureElement', 'composeAnnouncementMap', 'composeKeyboardMap',
  ]) {
    const method = optionalAdapterMethod(adapter, name);
    if (method) captured[name] = method;
  }
  return Object.freeze(captured);
}

/** Internal orchestration result; its pipeline persists only a validated AuditModel V2. */
async function runAuditExecutionInternal({
  url, chromeAdapter, now = () => new Date().toISOString(), idFactory = () => crypto.randomUUID(), signal,
  closeAuditTab = true, expectedExtensionId, pageId = 'page-1', cleanupMode,
  checkpointAuditId = null, onCheckpoint,
}) {
  if (checkpointAuditId === null && pageId !== 'page-1') throw new TypeError('AUDIT_EXECUTION_DENIED');
  const internals = internalContract(chromeAdapter);
  const createTab = requiredAdapterMethod(chromeAdapter, 'createTab');
  const navigateTab = requiredAdapterMethod(chromeAdapter, 'navigateTab');
  const waitForStable = requiredAdapterMethod(chromeAdapter, 'waitForStable');
  const probeDocumentIdentity = requiredAdapterMethod(chromeAdapter, 'probeDocumentIdentity');
  const removeTab = requiredAdapterMethod(chromeAdapter, 'removeTab');
  // Reatestação viva da limpeza (achado D1 da revisão da 1.1.37): sem esta leitura o registro de
  // propriedade não distingue a aba da auditoria de um id reciclado pelo Chrome.
  const getTab = requiredAdapterMethod(chromeAdapter, 'getTab');
  const baseGetEvidenceUrl = optionalAdapterMethod(chromeAdapter, 'getEvidenceUrl');
  const baseGetFinalUrl = optionalAdapterMethod(chromeAdapter, 'getFinalUrl');
  const legacyEffects = captureLegacyEffects(chromeAdapter);
  let navigationUrl = normalizeAuditUrl(url);
  const requestedUrlEvidence = sanitizeEvidenceUrlV1(navigationUrl, { includeQuery: false });
  const generatedId = idFactory('audit');
  const auditId = typeof generatedId === 'string' ? generatedId.trim() : '';
  const externalAuditId = checkpointAuditId ?? auditId;
  const selectedCleanupMode = cleanupMode ?? (closeAuditTab === false ? 'pre-observation-failure' : 'always');
  if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(auditId) ||
    !/^[A-Za-z0-9._:-]{1,160}$/u.test(externalAuditId) ||
    !/^[A-Za-z0-9._:-]{1,160}$/u.test(pageId) ||
    !['always', 'pre-observation-failure'].includes(selectedCleanupMode) ||
    (onCheckpoint !== undefined && typeof onCheckpoint !== 'function')) {
    throw new TypeError('AUDIT_EXECUTION_DENIED');
  }
  const capturePolicy = createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false });
  const ownershipId = opaqueId(internals.randomBytes, 'ownership');
  const rawNavigationVault = createRawNavigationVaultV1({
    sessionArea: internals.sessionArea,
    now: ownValue(internals, 'epochNow') ?? Date.now,
    randomBytes: internals.randomBytes,
  });
  const ownedTabs = createOwnedTabRegistry({
    sessionArea: internals.sessionArea,
    chromeAdapter: Object.freeze({ removeTab, getTab }),
    now,
  });
  const inventory = await createInstalledCoreRuleInventory();
  const startedAt = canonicalTime(now());
  const internalPageId = 'page-1';
  const checkpointSink = onCheckpoint ?? ownValue(internals, 'onExecutionCheckpoint') ?? (async () => {});
  if (typeof checkpointSink !== 'function') throw new TypeError('AUDIT_EXECUTION_DENIED');
  const checkpointRecorder = await createPageCheckpointRecorder({
    auditId,
    pageId: internalPageId,
    startedAt,
    rulesVersion: inventory.rulesVersion,
    inventory,
    onCheckpoint: checkpoint => checkpointSink(checkpointProjection(checkpoint, {
      sourceAuditId: auditId,
      sourcePageId: internalPageId,
      auditId: externalAuditId,
      pageId,
    })),
  });
  const persistAuditModel = ownValue(internals, 'persistAuditModel');
  if (persistAuditModel !== undefined && typeof persistAuditModel !== 'function') {
    throw new TypeError('AUDIT_EXECUTION_DENIED');
  }
  let terminalModel = null;
  let compatibilityDraft = null;
  let recoveryObservedTarget = null;
  let pipelinePersistenceStarted = false;
  const services = Object.freeze({
    async collectObservedPage({ observedTarget }) {
      recoveryObservedTarget = copyOwnedObservedTarget(observedTarget);
      if (!recoveryObservedTarget || recoveryObservedTarget.ownershipId !== ownershipId ||
        recoveryObservedTarget.cleanupMode !== selectedCleanupMode) throw new TypeError('AUDIT_EXECUTION_DENIED');
      const collectedDraft = await runLegacyAudit({
        url: requestedUrlEvidence.href,
        chromeAdapter: createObservedLegacyAdapter(legacyEffects, observedTarget, capturePolicy, null, null),
        now,
        idFactory: () => auditId,
        signal,
        closeAuditTab: false,
        expectedExtensionId,
        startedAt,
      });
      const draft = alignLegacyDraftWithObservedEvidence(
        collectedDraft,
        observedTarget.urlEvidence.href,
        requestedUrlEvidence.href,
      );
      compatibilityDraft = draft;
      terminalModel = await enrichAuditForReport(draft, {
        now,
        manifestVersion: legacyEffects.manifestVersion,
        expectedExtensionId,
        browserVersion: draft.environment?.chromeVersion || 'não disponível',
        rulesVersion: draft.methodology?.version || inventory.rulesVersion,
      });
      return Object.freeze({ version: 1, kind: 'legacy-observation' });
    },
    async runCoreRules() {
      return Object.freeze({
        ruleResults: terminalModel.ruleResults.filter(result => result.source?.engine === 'audita-core'),
      });
    },
    async buildAuditModel() { return terminalModel; },
    async persistAuditModel(model) {
      pipelinePersistenceStarted = true;
      if (persistAuditModel) await Reflect.apply(persistAuditModel, internals, [model]);
    },
  });
  const runPipeline = createObservedPipelineRunner({ checkpointRecorder, services });
  let tokenConsumed = false;
  const executionAdapter = Object.freeze({
    runPipeline,
    probeDocumentIdentity,
    ownedTabs,
    createTab,
    navigateTab,
    waitForStable,
    async resolveNavigationToken(navigationToken) {
      const resolved = await rawNavigationVault.takeInternal({ ownerId: ownershipId, navigationToken });
      tokenConsumed = true;
      return resolved;
    },
    async getEvidenceUrl(tabId, includeQuery) {
      const pending = typeof baseGetEvidenceUrl === 'function'
        ? baseGetEvidenceUrl(tabId, includeQuery)
        : typeof baseGetFinalUrl === 'function'
          ? baseGetFinalUrl(tabId)
          : (() => { throw new Error('TARGET_EVIDENCE_UNAVAILABLE'); })();
      const synchronous = copyEvidenceUrlV1(pending);
      if (synchronous) return synchronous;
      if (typeof pending === 'string') return sanitizeEvidenceUrlV1(pending, { includeQuery: false });
      const candidate = await pending;
      const copied = copyEvidenceUrlV1(candidate);
      if (copied) return copied;
      if (typeof candidate === 'string') return sanitizeEvidenceUrlV1(candidate, { includeQuery: false });
      throw new TypeError('AUDIT_EXECUTION_DENIED');
    },
    removeTab,
  });
  const issued = await rawNavigationVault.putInternal({ ownerId: ownershipId, rawUrl: navigationUrl });
  navigationUrl = null;
  let observed;
  let thrown = null;
  let interruption = null;
  try {
    observed = await runObservedTabAudit({
      auditId,
      target: Object.freeze({
        kind: 'owned-disposable',
        ownershipId,
        navigationToken: issued.navigationToken,
        cleanupMode: selectedCleanupMode,
        pageId: checkpointAuditId === null ? pageId : null,
      }),
      chromeAdapter: executionAdapter,
      capturePolicy,
      privacyGate: null,
      onCheckpoint: checkpointSink,
      now,
      signal,
      expectedExtensionId,
    });
  } catch (error) {
    thrown = error;
    interruption = copyOwnedInterruption(readObservedAuditInterruption(error), {
      auditId, ownershipId, cleanupMode: selectedCleanupMode,
    });
  } finally {
    if (!tokenConsumed) {
      try {
        await rawNavigationVault.invalidateInternal({ ownerId: ownershipId, navigationToken: issued.navigationToken });
      } catch (error) {
        thrown ??= error;
      }
    }
  }
  const interruptedTarget = recoveryObservedTarget ?? interruption?.observedTarget ?? null;
  if (thrown && signal?.aborted && interruption?.reason === 'cancelled' && interruptedTarget && !pipelinePersistenceStarted) {
    let ownershipState = null;
    try {
      ownershipState = recoveredOwnedCleanupState(await ownedTabs.get(ownershipId), {
        auditId, ownershipId, observedTarget: interruptedTarget, cleanupMode: selectedCleanupMode,
      });
    } catch { ownershipState = null; }
    if (interruption && ownershipState !== interruption.ownershipState) ownershipState = null;
    if (ownershipState) {
      const draft = compatibilityDraft ?? await createInterruptedObservedDraft({
        auditId,
        requestedUrl: requestedUrlEvidence.href,
        observedTarget: interruptedTarget,
        capturePolicy,
        startedAt,
        now,
      });
      const cancelled = await cancelledAuditProjection({
        draft, now, expectedExtensionId, rulesVersion: inventory.rulesVersion,
        manifestVersion: legacyEffects.manifestVersion,
      });
      const checkpoint = checkpointProjection(checkpointRecorder.snapshot(), {
        sourceAuditId: auditId,
        sourcePageId: internalPageId,
        auditId: externalAuditId,
        pageId,
      });
      return Object.freeze({
        execution: deepFreeze({
          status: 'cancelled', model: cancelled.model, observedTarget: interruptedTarget,
          observationState: 'observed', ownershipState, checkpoint,
        }),
        compatibilityDraft: cancelled.draft,
      });
    }
  }
  if (thrown) throw thrown;
  const checkpoint = checkpointProjection(checkpointRecorder.snapshot(), {
    sourceAuditId: auditId,
    sourcePageId: internalPageId,
    auditId: externalAuditId,
    pageId,
  });
  if (observed) return Object.freeze({
    execution: deepFreeze({ ...observed, checkpoint }),
    compatibilityDraft,
  });
  throw new TypeError('AUDIT_EXECUTION_DENIED');
}

export async function runAuditExecution(args) {
  return (await runAuditExecutionInternal(args)).execution;
}

/** Compatibility façade: exact legacy call shape and model-only return. */
export async function runAudit({ url, chromeAdapter, now = () => new Date().toISOString(), idFactory = () => crypto.randomUUID(), signal, closeAuditTab = true, expectedExtensionId }) {
  const { execution, compatibilityDraft } = await runAuditExecutionInternal({
    url, chromeAdapter, now, idFactory, signal, closeAuditTab, expectedExtensionId,
  });
  if (execution?.observationState !== 'observed' || !execution.model ||
    execution.status !== execution.model.session?.status || !compatibilityDraft ||
    !['removed', 'retained-for-review'].includes(execution.ownershipState)) {
    throw new TypeError('AUDIT_EXECUTION_DENIED');
  }
  if (compatibilityDraft.session.status !== 'cancelled' || signal?.aborted) return compatibilityDraft;
  const compatible = structuredClone(compatibilityDraft);
  compatible.session.status = 'failed';
  compatible.session.partial = false;
  compatible.session.diagnostics = compatible.session.diagnostics.filter(entry =>
    entry?.code !== 'AUDIT_ABORTED' && !/cancelad/iu.test(entry?.message ?? ''));
  compatible.session.diagnostics.push(diagnostic(
    'AUDIT_FAILED',
    'A auditoria falhou antes de concluir a observação.',
    canonicalTime(compatible.timestamps?.endedAt ?? now()),
    false,
  ));
  return deepFreeze(compatible);
}
