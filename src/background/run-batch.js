import { canonicalTime, runAuditExecution } from './run-audit.js';
import { mergeExecutionCheckpoint, validateExecutionCheckpoint } from './execution-checkpoint.js';
import {
  createBatchSession,
  transitionBatchSession,
} from './session.js';
import {
  aggregateBatchAudits,
  createBatchFailurePage,
  createBatchReportTemplate,
} from '../core/batch/aggregate-audits.js';
import { remapAuditPage } from '../core/batch/remap-audit.js';
import { isEvidenceUrlV1, sanitizeEvidenceUrlV1 } from '../core/privacy/evidence-url.js';
import { enrichAuditForReport } from '../core/report/enrich-audit.js';
import { canonicalInternalReviewUrl } from '../core/report/report-policy.js';
import { normalizeAuditUrl } from '../core/url.js';
import {
  applyBatchEvidenceBudget,
  DEFAULT_BATCH_EVIDENCE_BUDGET_BYTES,
} from '../core/batch/evidence-budget.js';
import { AUDIT_EXECUTION_INTERNAL, composeChromeAdapter } from './chrome-adapter.js';
import { createAuditModel } from '../core/report/audit-model.js';
import { copyBatchPageFailure } from './batch-page-failure.js';

const DEFAULT_PAGE_TIMEOUT_MS = 120_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
const CLEANUP_FAILURE_CODES = new Set(['TAB_CLOSE_FAILED', 'CDP_DISCONNECT_FAILED']);
const INVALID_BATCH_ENTRIES_MESSAGE = 'Lista normalizada do lote inválida.';
const INVALID_BATCH_CONFIG_MESSAGE = 'Configuração do lote inválida.';
const CHECKPOINT_FAILURE_MESSAGE = 'O checkpoint do lote não pôde ser persistido.';
const BATCH_ENTRY_KEYS = Object.freeze(['line', 'navigationUrl', 'evidenceUrl']);
const EVIDENCE_URL_KEYS = Object.freeze(['version', 'href', 'queryIncluded', 'redactedSegments']);
const HANDOFF_RESULT_KEYS = Object.freeze(['reviewUrl', 'artifact']);
const REPORT_OPTION_KEYS = Object.freeze([
  'timezone', 'manifestVersion', 'rulesVersion', 'browserVersion', 'expectedExtensionId',
]);
const RUN_BATCH_REQUEST_KEYS = Object.freeze([
  'entries',
  'batchAuditId',
  'batchStartedAt',
  'chromeAdapter',
  'runner',
  'now',
  'signal',
  'pageTimeoutMs',
  'cleanupTimeoutMs',
  'evidenceBudgetBytes',
  'reportOptions',
  'onCheckpoint',
  'onExecutionCheckpoint',
  'completedPages',
]);
const COMPLETED_PAGE_KEYS = Object.freeze(['pageId', 'model', 'checkpoint']);
const FAILED_COMPLETED_PAGE_KEYS = Object.freeze([...COMPLETED_PAGE_KEYS, 'failure']);
const CHECKPOINT_FAILURES = new WeakSet();
const BATCH_EXECUTION_RUNNERS = new WeakSet();

/** Brands a worker-local child runner whose result includes cleanup and checkpoint evidence. */
export function createBatchExecutionRunner(handler) {
  if (typeof handler !== 'function') throw new TypeError(INVALID_BATCH_CONFIG_MESSAGE);
  const runner = async options => Reflect.apply(handler, undefined, [options]);
  BATCH_EXECUTION_RUNNERS.add(runner);
  return Object.freeze(runner);
}

/** Audits only the normalized explicit list, exactly one disposable tab at a time. */
export async function runBatch(request) {
  const {
    entries: requestedEntries,
    batchAuditId,
    batchStartedAt: requestedBatchStartedAt,
    chromeAdapter,
    runner = runAuditExecution,
    now = () => new Date().toISOString(),
    signal,
    pageTimeoutMs = DEFAULT_PAGE_TIMEOUT_MS,
    cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
    evidenceBudgetBytes = DEFAULT_BATCH_EVIDENCE_BUDGET_BYTES,
    reportOptions: requestedReportOptions,
    onCheckpoint = async () => {},
    onExecutionCheckpoint = async () => {},
    completedPages: requestedCompletedPages = [],
  } = captureBatchRequest(request);
  const brandedExecutionRunner = BATCH_EXECUTION_RUNNERS.has(runner);
  const entries = captureBatchEntries(requestedEntries, {
    allowDuplicateNavigationUrls: brandedExecutionRunner,
  });
  const reportOptions = captureReportOptions(requestedReportOptions);
  validateInputs({ entries, batchAuditId, chromeAdapter, runner, pageTimeoutMs, cleanupTimeoutMs, evidenceBudgetBytes, reportOptions });
  const completedPages = captureCompletedPages(requestedCompletedPages, batchAuditId, entries);
  const template = createBatchReportTemplate(reportOptions);
  const durableBatchStartedAt = captureBatchStartedAt(requestedBatchStartedAt);
  const startedAt = durableBatchStartedAt ?? (completedPages.length > 0
    ? canonicalTime(completedPages[0].model?.timestamps.startedAt ?? completedPages[0].failure.startedAt)
    : canonicalTime(now()));
  let checkpoint = createBatchSession({ id: batchAuditId, total: entries.length, startedAt });
  let lastProgress = 0;
  let terminal = false;
  const pageResults = [];
  let evidenceBytesUsed = 0;
  let evidenceBudgetExhausted = false;
  let executionCheckpoint = null;
  const executionMode = runner === runAuditExecution || brandedExecutionRunner;
  const pageOrder = entries.map((_entry, index) => `page-${index + 1}`);

  const claimFinalization = ({ allowAborted = false } = {}) => {
    if (terminal) return allowAborted || !signal?.aborted;
    const claimed = chromeAdapter.tryEnterFinalization?.();
    terminal = true;
    return allowAborted || (claimed !== false && !signal?.aborted);
  };

  const saveCheckpoint = async () => {
    await runControllingCallback(
      () => Reflect.apply(onCheckpoint, undefined, [checkpoint]),
      cleanupTimeoutMs,
    );
  };
  const saveExecutionCheckpoint = async () => {
    await runControllingCallback(
      () => Reflect.apply(onExecutionCheckpoint, undefined, [executionCheckpoint]),
      cleanupTimeoutMs,
    );
  };
  const move = async event => {
    checkpoint = transitionBatchSession(checkpoint, event);
    await saveCheckpoint();
  };
  const emitGlobalProgress = async ({ pageIndex, pagePercent, terminalMessage = null }) => {
    if (terminal) return;
    const boundedPagePercent = Math.max(0, Math.min(100, Number.isFinite(pagePercent) ? pagePercent : 0));
    const percent = Math.max(lastProgress, ((pageIndex + boundedPagePercent / 100) / entries.length) * 100);
    lastProgress = Math.min(100, percent);
    const pageNumber = Math.min(entries.length, pageIndex + 1);
    const message = terminalMessage ?? `Página ${pageNumber} de ${entries.length}: auditoria em andamento.`;
    const event = {
      type: 'AUDIT_PROGRESS', sessionId: batchAuditId, auditId: batchAuditId,
      phase: 'batch-page', message, percent: lastProgress, pageNumber,
      total: entries.length, at: canonicalTime(now()),
      statusCounts: { ...checkpoint.statusCounts },
    };
    await runNonControllingCallback(
      () => chromeAdapter.emitProgress?.(event),
      cleanupTimeoutMs,
    );
  };

  await saveCheckpoint();
  await move({ type: 'VALIDATE', at: canonicalTime(now()) });
  await move({ type: 'QUEUE', at: canonicalTime(now()) });
  if (signal?.aborted) {
    await cancelRemaining({ active: false });
  } else {
    await move({ type: 'START', at: canonicalTime(now()) });
    for (let index = 0; index < completedPages.length; index += 1) {
      const recovered = completedPages[index];
      const pageId = recovered.pageId;
      const child = recovered.failure ? null : await enrichAuditForReport(recovered.model, {
        ...reportOptions,
        now,
        browserVersion: reportOptions.browserVersion || recovered.model?.environment?.chromeVersion || 'não disponível',
      });
      let pageResult = recovered.failure
        ? failureFor(entries[index], pageId, 'failed', true, recovered.failure.startedAt,
          recovered.failure.endedAt, 'BATCH_PAGE_FAILED', 'A página não pôde ser auditada.')
        : await remapAuditPage(child, { batchAuditId, pageId });
      const budgeted = await applyBatchEvidenceBudget(pageResult, {
        usedBytes: evidenceBytesUsed, limitBytes: evidenceBudgetBytes,
        exhausted: evidenceBudgetExhausted,
      });
      pageResult = budgeted.result;
      evidenceBytesUsed = budgeted.usedBytes;
      evidenceBudgetExhausted = budgeted.exhausted;
      pageResults.push(pageResult);
      executionCheckpoint = mergeExecutionCheckpoint({
        auditId: batchAuditId,
        prior: executionCheckpoint,
        pageSnapshot: Object.freeze({
          version: 1,
          auditId: batchAuditId,
          pages: [Object.freeze({ ...recovered.checkpoint.pages[0], pageId })],
        }),
        pageOrder,
      });
      await saveExecutionCheckpoint();
      await move({ type: 'PAGE_FINISHED', status: pageResult.page.status, at: canonicalTime(now()) });
      await emitGlobalProgress({
        pageIndex: index,
        pagePercent: 100,
        terminalMessage: `Página ${index + 1} de ${entries.length}: resultado recuperado.`,
      });
    }
    if (completedPages.length === entries.length) claimFinalization();
    for (let index = completedPages.length; index < entries.length; index += 1) {
      if (signal?.aborted) {
        await cancelRemaining({ active: false });
        break;
      }
      const entry = entries[index];
      const pageId = `page-${index + 1}`;
      const childAuditId = `${batchAuditId}:${pageId}`;
      const pageStartedAt = canonicalTime(now());
      let localPercent = 0;
      const childOverrides = {
        async emitProgress(progress) {
          const next = Number.isFinite(progress?.percent) ? Math.max(localPercent, progress.percent) : localPercent;
          localPercent = Math.min(100, next);
          await emitGlobalProgress({ pageIndex: index, pagePercent: localPercent });
        },
        async handoffReport() {
          return { reviewUrl: null, artifact: { status: 'pending', formats: [] } };
        },
      };
      const hasExecutionContract = Boolean(Object.getOwnPropertyDescriptor(chromeAdapter, AUDIT_EXECUTION_INTERNAL));
      const childAdapter = hasExecutionContract
        ? composeChromeAdapter(chromeAdapter, childOverrides)
        : { ...chromeAdapter, ...childOverrides };
      let latestChildCheckpoint = null;
      let outcome = await runPageWithBoundary({
        operation: ({ childSignal }) => runner({
          url: entry.navigationUrl,
          chromeAdapter: childAdapter,
          expectedExtensionId: reportOptions.expectedExtensionId,
          now,
          idFactory: () => childAuditId,
          signal: childSignal,
          closeAuditTab: true,
          pageId,
          cleanupMode: 'always',
          checkpointAuditId: batchAuditId,
          onCheckpoint: async value => { latestChildCheckpoint = value; },
        }),
        externalSignal: signal,
        pageTimeoutMs,
        cleanupTimeoutMs,
      });
      const pageEndedAt = canonicalTime(now());

      if (outcome.kind === 'cancelled') {
        if (executionMode && outcome.settled) {
          const late = outcome.settled;
          const execution = late.kind === 'fulfilled' ? late.value : null;
          const pageCheckpoint = execution?.checkpoint ?? latestChildCheckpoint;
          const ownershipState = execution?.ownershipState;
          if (pageCheckpoint && ['removed', 'cleanup-pending'].includes(ownershipState)) {
            executionCheckpoint = mergeExecutionCheckpoint({
              auditId: batchAuditId, prior: executionCheckpoint,
              pageSnapshot: pageCheckpoint, pageOrder,
            });
            await saveExecutionCheckpoint();
          }
          if (pageCheckpoint && ownershipState === 'removed') {
            await cancelRemaining({ active: true, startedAt: pageStartedAt, endedAt: pageEndedAt });
            break;
          }
          outcome = { kind: 'cleanup-unconfirmed' };
        } else {
          await cancelRemaining({ active: true, startedAt: pageStartedAt, endedAt: pageEndedAt });
          break;
        }
      }
      if (outcome.kind === 'cleanup-unconfirmed') {
        if (!claimFinalization({ allowAborted: true })) {
          await cancelRemaining({ active: true, startedAt: pageStartedAt, endedAt: pageEndedAt });
          break;
        }
        pageResults.push(failureFor(entry, pageId, 'failed', true, pageStartedAt, pageEndedAt,
          'BATCH_PAGE_CLEANUP_UNCONFIRMED', 'A limpeza da página excedeu o prazo; o lote foi interrompido para evitar sobreposição.'));
        await move({ type: 'PAGE_FINISHED', status: 'failed', at: pageEndedAt });
        for (let pending = index + 1; pending < entries.length; pending += 1) {
          const pendingAt = canonicalTime(now());
          pageResults.push(failureFor(entries[pending], `page-${pending + 1}`, 'failed', false, pendingAt, pendingAt,
            'BATCH_NOT_STARTED_CLEANUP_UNCONFIRMED', 'A página não foi iniciada porque a limpeza anterior não foi confirmada.'));
          await move({ type: 'PAGE_FINISHED', status: 'failed', at: pendingAt });
        }
        break;
      }

      let pageResult;
      let executionCleanupPending = false;
      let executionCleanupUnconfirmed = false;
      if (outcome.kind === 'timeout') {
        pageResult = failureFor(entry, pageId, 'failed', true, pageStartedAt, pageEndedAt,
          'BATCH_PAGE_TIMEOUT', 'A página excedeu o tempo limite da auditoria.');
        if (executionMode) {
          const late = outcome.settled;
          const execution = late?.kind === 'fulfilled' ? late.value : null;
          const pageCheckpoint = execution?.checkpoint ?? latestChildCheckpoint;
          if (!pageCheckpoint || !['removed', 'cleanup-pending'].includes(execution?.ownershipState)) {
            executionCleanupUnconfirmed = true;
          } else {
            executionCheckpoint = mergeExecutionCheckpoint({
              auditId: batchAuditId, prior: executionCheckpoint,
              pageSnapshot: pageCheckpoint, pageOrder,
            });
            await saveExecutionCheckpoint();
            executionCleanupPending = execution.ownershipState === 'cleanup-pending';
          }
        }
      } else if (outcome.kind === 'rejected') {
        pageResult = failureFor(entry, pageId, 'failed', true, pageStartedAt, pageEndedAt,
          'BATCH_PAGE_FAILED', 'A página não pôde ser auditada.');
        if (executionMode) executionCleanupUnconfirmed = true;
      } else {
        try {
          const execution = executionMode ? outcome.value : null;
          const childValue = executionMode ? execution?.model : outcome.value;
          if (executionMode) {
            const pageCheckpoint = execution?.checkpoint ?? latestChildCheckpoint;
            if (!pageCheckpoint || !['removed', 'cleanup-pending'].includes(execution?.ownershipState)) {
              throw new TypeError('Execução filha sem fronteira terminal comprovada.');
            }
            executionCheckpoint = mergeExecutionCheckpoint({
              auditId: batchAuditId, prior: executionCheckpoint,
              pageSnapshot: pageCheckpoint, pageOrder,
            });
            await saveExecutionCheckpoint();
            executionCleanupPending = execution.ownershipState === 'cleanup-pending';
            executionCleanupUnconfirmed = execution.ownershipState === 'cleanup-unconfirmed';
          }
          const failure = brandedExecutionRunner && childValue === null
            ? copyBatchPageFailure(execution.failure, execution.checkpoint?.pages[0], entry.evidenceUrl)
            : null;
          if (!failure && childValue?.auditId !== childAuditId) throw new TypeError('Auditoria filha não correlacionada.');
          const child = failure ? null : await enrichAuditForReport(childValue, {
            ...reportOptions,
            now,
            browserVersion: reportOptions.browserVersion || childValue?.environment?.chromeVersion || 'não disponível',
          });
          pageResult = failure
            ? failureFor(entry, pageId, 'failed', true, failure.startedAt, failure.endedAt,
              'BATCH_PAGE_FAILED', 'A página não pôde ser auditada.')
            : await remapAuditPage(child, { batchAuditId, pageId });
          const budgeted = await applyBatchEvidenceBudget(pageResult, {
            usedBytes: evidenceBytesUsed, limitBytes: evidenceBudgetBytes,
            exhausted: evidenceBudgetExhausted,
          });
          pageResult = budgeted.result;
          evidenceBytesUsed = budgeted.usedBytes;
          evidenceBudgetExhausted = budgeted.exhausted;
        } catch (error) {
          if (CHECKPOINT_FAILURES.has(error)) throw error;
          pageResult = failureFor(entry, pageId, 'failed', true, pageStartedAt, pageEndedAt,
            'BATCH_PAGE_MODEL_INVALID', 'O resultado da página não pôde ser validado para o lote.');
        }
      }
      if (executionCleanupUnconfirmed || executionCleanupPending) {
        pageResult = failureFor(entry, pageId, 'failed', true, pageStartedAt, pageEndedAt,
          'BATCH_PAGE_CLEANUP_UNCONFIRMED', 'A limpeza da página excedeu o prazo; o lote foi interrompido para evitar sobreposição.');
      }
      const stopsForCleanup = executionCleanupPending || executionCleanupUnconfirmed || pageResult.page.diagnostics?.some(value => CLEANUP_FAILURE_CODES.has(value.code));
      const endsScheduling = index === entries.length - 1 || stopsForCleanup;
      if (endsScheduling && !claimFinalization({ allowAborted: stopsForCleanup })) {
        await cancelRemaining({ active: true, startedAt: pageStartedAt, endedAt: pageEndedAt });
        break;
      }
      pageResults.push(pageResult);
      await move({ type: 'PAGE_FINISHED', status: pageResult.page.status, at: pageEndedAt });
      await emitGlobalProgress({
        pageIndex: index,
        pagePercent: 100,
        terminalMessage: `Página ${index + 1} de ${entries.length}: processamento encerrado.`,
      });
      if (stopsForCleanup) {
        for (let pending = index + 1; pending < entries.length; pending += 1) {
          const pendingAt = canonicalTime(now());
          pageResults.push(failureFor(entries[pending], `page-${pending + 1}`, 'failed', false, pendingAt, pendingAt,
            'BATCH_NOT_STARTED_CLEANUP_UNCONFIRMED', 'A página não foi iniciada porque a limpeza anterior não foi confirmada.'));
          await move({ type: 'PAGE_FINISHED', status: 'failed', at: pendingAt });
        }
        break;
      }
    }
    if (checkpoint.state === 'running') {
      if (!terminal) throw new Error('A fronteira terminal do lote não foi adquirida.');
      await move({ type: 'FINISH', at: canonicalTime(now()) });
    }
  }

  if (!terminal) claimFinalization();
  const aggregate = aggregateBatchAudits({
    batchAuditId,
    pageResults,
    startedAt,
    endedAt: canonicalTime(now()),
    status: checkpoint.state,
    progress: [],
    diagnostics: [],
    template,
  });
  let finalModel = await enrichAuditForReport(aggregate, { ...reportOptions, now });
  const handoffReport = descriptorDataMethod(chromeAdapter, 'handoffReport');
  const handoffOutcome = handoffReport
    ? await runDescriptorCall(handoffReport, chromeAdapter, [finalModel], cleanupTimeoutMs)
    : null;
  const handoff = handoffOutcome?.kind === 'fulfilled'
    ? captureHandoffResult(handoffOutcome.value)
    : null;
  const reviewUrl = validateTransientReviewUrl(
    handoff?.reviewUrl,
    batchAuditId,
    reportOptions.expectedExtensionId,
  );
  finalModel = await enrichAuditForReport(finalModel, {
    ...reportOptions, now, handoffReviewUrl: reviewUrl,
    expectedExtensionId: reportOptions.expectedExtensionId,
  });
  return finalModel;

  async function cancelRemaining({ active, startedAt: activeStartedAt, endedAt: activeEndedAt }) {
    await move({ type: 'CANCEL', at: activeEndedAt ?? canonicalTime(now()) });
    const firstPending = pageResults.length;
    for (let index = firstPending; index < entries.length; index += 1) {
      const at = index === firstPending && active
        ? activeEndedAt
        : canonicalTime(now());
      pageResults.push(failureFor(
        entries[index], `page-${index + 1}`, 'cancelled', index === firstPending && active,
        index === firstPending && active ? activeStartedAt : at,
        at,
        'BATCH_CANCELLED',
        index === firstPending && active
          ? 'A página ativa foi cancelada e limpa antes do encerramento do lote.'
          : 'A página não foi iniciada porque o lote foi cancelado.',
      ));
    }
    await move({
      type: 'MARK_REMAINING_CANCELLED',
      count: entries.length - checkpoint.completedCount,
      at: activeEndedAt ?? canonicalTime(now()),
    });
  }
}

function captureCompletedPages(value, batchAuditId, entries) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length;
    if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) ||
      length.value < 0 || length.value > entries.length || Reflect.ownKeys(descriptors).length !== length.value + 1) {
      throw new TypeError();
    }
    const captured = [];
    for (let index = 0; index < length.value; index += 1) {
      const slot = descriptors[String(index)];
      if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw new TypeError();
      const page = slot.value;
      if (!page || typeof page !== 'object' || Array.isArray(page) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(page))) throw new TypeError();
      const pageDescriptors = Object.getOwnPropertyDescriptors(page);
      if (!exactOwnDataDescriptors(pageDescriptors, COMPLETED_PAGE_KEYS) &&
        !exactOwnDataDescriptors(pageDescriptors, FAILED_COMPLETED_PAGE_KEYS)) throw new TypeError();
      const pageId = `page-${index + 1}`;
      const childAuditId = `${batchAuditId}:${pageId}`;
      if (pageDescriptors.pageId.value !== pageId) throw new TypeError();
      const checkpoint = validateExecutionCheckpoint({
        auditId: childAuditId,
        checkpoint: pageDescriptors.checkpoint.value,
        pageOrder: ['page-1'],
      });
      if (pageDescriptors.model.value === null) {
        const failure = copyBatchPageFailure(pageDescriptors.failure?.value, checkpoint.pages[0], entries[index].evidenceUrl);
        if (!failure) throw new TypeError();
        captured.push(Object.freeze({ pageId, model: null, failure, checkpoint }));
        continue;
      }
      if (pageDescriptors.failure && pageDescriptors.failure.value !== null) throw new TypeError();
      const model = createAuditModel(pageDescriptors.model.value);
      if (model.auditId !== childAuditId || model.pages.length !== 1 || model.pages[0].pageId !== 'page-1') {
        throw new TypeError();
      }
      const requested = sanitizeEvidenceUrlV1(model.requestedUrl, { includeQuery: false });
      if (requested.href !== entries[index].evidenceUrl.href) throw new TypeError();
      captured.push(Object.freeze({ pageId, model, checkpoint }));
    }
    return Object.freeze(captured);
  } catch {
    throw new TypeError(INVALID_BATCH_CONFIG_MESSAGE);
  }
}

function captureBatchRequest(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string' || !RUN_BATCH_REQUEST_KEYS.includes(key))) {
      throw new TypeError();
    }
    const captured = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) throw new TypeError();
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured);
  } catch {
    throw new TypeError(INVALID_BATCH_CONFIG_MESSAGE);
  }
}

function captureBatchStartedAt(value) {
  if (value === undefined) return null;
  try {
    const canonical = canonicalTime(value);
    if (typeof value !== 'string' || canonical !== value) throw new TypeError();
    return canonical;
  } catch {
    throw new TypeError(INVALID_BATCH_CONFIG_MESSAGE);
  }
}

function captureReportOptions(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (!exactOwnDataDescriptors(descriptors, REPORT_OPTION_KEYS)) throw new TypeError();
    const captured = Object.freeze({
      timezone: descriptors.timezone.value,
      manifestVersion: descriptors.manifestVersion.value,
      rulesVersion: descriptors.rulesVersion.value,
      browserVersion: descriptors.browserVersion.value,
      expectedExtensionId: descriptors.expectedExtensionId.value,
    });
    if (typeof captured.timezone !== 'string' || captured.timezone.length < 1 || captured.timezone.length > 100 ||
      typeof captured.manifestVersion !== 'string' || captured.manifestVersion.length < 1 || captured.manifestVersion.length > 64 ||
      captured.rulesVersion !== '1.0.0' ||
      typeof captured.browserVersion !== 'string' || captured.browserVersion.length < 1 || captured.browserVersion.length > 256 ||
      typeof captured.expectedExtensionId !== 'string' || !/^[a-p]{32}$/u.test(captured.expectedExtensionId)) {
      throw new TypeError();
    }
    return captured;
  } catch {
    throw new TypeError(INVALID_BATCH_CONFIG_MESSAGE);
  }
}

async function runPageWithBoundary({ operation, externalSignal, pageTimeoutMs, cleanupTimeoutMs }) {
  const controller = new AbortController();
  let timeoutId;
  let externalAbort = null;
  let operationStarted = false;
  const abortChild = () => {
    if (controller.signal.aborted) return;
    let reason;
    try { reason = externalSignal?.reason; } catch { reason = null; }
    controller.abort(reason ?? new DOMException('Operação cancelada.', 'AbortError'));
  };
  if (externalSignal?.aborted) {
    abortChild();
    return { kind: 'cancelled' };
  }
  const cancelled = new Promise(resolve => {
    externalAbort = () => {
      abortChild();
      resolve({ kind: 'cancel-boundary' });
    };
    externalSignal?.addEventListener('abort', externalAbort, { once: true });
  });
  if (externalSignal?.aborted) externalAbort();
  const operationNotStarted = Object.freeze({});
  const settled = Promise.resolve().then(() => {
    if (externalSignal?.aborted) {
      externalAbort?.();
      return operationNotStarted;
    }
    operationStarted = true;
    return operation({ childSignal: controller.signal });
  }).then(
    value => value === operationNotStarted
      ? { kind: 'operation-not-started' }
      : { kind: 'fulfilled', value },
    error => ({ kind: 'rejected', error }),
  );
  const timeout = new Promise(resolve => {
    timeoutId = setTimeout(() => {
      controller.abort(new DOMException('A página excedeu o tempo limite.', 'TimeoutError'));
      resolve({ kind: 'timeout-boundary' });
    }, pageTimeoutMs);
  });
  const first = await Promise.race([settled, timeout, cancelled]);
  clearTimeout(timeoutId);
  externalSignal?.removeEventListener('abort', externalAbort);
  if (first.kind === 'operation-not-started' || (first.kind === 'cancel-boundary' && !operationStarted)) {
    return { kind: 'cancelled' };
  }
  if (first.kind === 'fulfilled' || first.kind === 'rejected') return first;
  let cleanupTimerId;
  let cleanup;
  try {
    cleanup = await Promise.race([
      settled,
      new Promise(resolve => {
        cleanupTimerId = setTimeout(() => resolve({ kind: 'cleanup-unconfirmed' }), cleanupTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(cleanupTimerId);
  }
  if (cleanup.kind === 'cleanup-unconfirmed') return cleanup;
  return { kind: first.kind === 'cancel-boundary' ? 'cancelled' : 'timeout', settled: cleanup };
}

function failureFor(entry, pageId, status, attempted, startedAt, endedAt, code, message) {
  return createBatchFailurePage({
    pageId, requestedUrl: entry.evidenceUrl.href, status, attempted, startedAt, endedAt, code, message,
  });
}

async function settleWithin(operation, timeoutMs) {
  let result;
  try {
    result = operation();
  } catch {
    return { kind: 'rejected' };
  }
  const settled = Promise.resolve(result).then(
    value => ({ kind: 'fulfilled', value }),
    () => ({ kind: 'rejected' }),
  );
  return raceSettledWithin(settled, timeoutMs);
}

async function raceSettledWithin(settled, timeoutMs) {
  let timeoutId;
  try {
    return await Promise.race([
      settled,
      new Promise(resolve => {
        timeoutId = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runControllingCallback(operation, timeoutMs) {
  const outcome = await settleWithin(operation, timeoutMs);
  if (outcome.kind !== 'fulfilled') {
    const error = new Error(CHECKPOINT_FAILURE_MESSAGE);
    CHECKPOINT_FAILURES.add(error);
    throw error;
  }
  return outcome.value;
}

async function runNonControllingCallback(operation, timeoutMs) {
  return settleWithin(operation, timeoutMs);
}

async function runDescriptorCall(method, receiver, args, timeoutMs) {
  let result;
  try {
    result = Reflect.apply(method, receiver, args);
  } catch {
    return { kind: 'rejected' };
  }

  let settle;
  const settled = new Promise(resolve => { settle = resolve; });
  try {
    Reflect.apply(Promise.prototype.then, result, [
      value => settle({ kind: 'fulfilled', value }),
      () => settle({ kind: 'rejected' }),
    ]);
  } catch {
    return { kind: 'fulfilled', value: result };
  }
  return raceSettledWithin(settled, timeoutMs);
}

function descriptorDataMethod(receiver, key) {
  try {
    let owner = receiver;
    const visited = new Set();
    for (let depth = 0; owner !== null && depth < 100; depth += 1) {
      if ((typeof owner !== 'object' && typeof owner !== 'function') || visited.has(owner)) return null;
      visited.add(owner);
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor) {
        return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
          ? descriptor.value
          : null;
      }
      owner = Object.getPrototypeOf(owner);
    }
    return null;
  } catch {
    return null;
  }
}

function captureHandoffResult(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (!keys.includes('reviewUrl') || keys.length < 1 || keys.length > HANDOFF_RESULT_KEYS.length ||
      keys.some(key => typeof key !== 'string' || !HANDOFF_RESULT_KEYS.includes(key))) return null;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
    }
    return Object.freeze({ reviewUrl: descriptors.reviewUrl.value });
  } catch {
    return null;
  }
}

function captureBatchEntries(value, { allowDuplicateNavigationUrls = false } = {}) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const length = descriptors.length;
    if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) ||
      length.value < 1 || length.value > 20 || keys.length !== length.value + 1 ||
      keys.some(key => key !== 'length' &&
        (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length.value))) {
      throw new TypeError();
    }

    const captured = new Array(length.value);
    const lines = new Set();
    const navigationUrls = new Set();
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) throw new TypeError();
      const entry = captureBatchEntry(descriptor.value);
      if (lines.has(entry.line) || !allowDuplicateNavigationUrls && navigationUrls.has(entry.navigationUrl)) {
        throw new TypeError();
      }
      lines.add(entry.line);
      navigationUrls.add(entry.navigationUrl);
      captured[index] = entry;
    }
    return Object.freeze(captured);
  } catch {
    throw new TypeError(INVALID_BATCH_ENTRIES_MESSAGE);
  }
}

function captureBatchEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!exactOwnDataDescriptors(descriptors, BATCH_ENTRY_KEYS)) throw new TypeError();
  const line = descriptors.line.value;
  const navigationUrl = descriptors.navigationUrl.value;
  if (!Number.isSafeInteger(line) || line < 1 || typeof navigationUrl !== 'string' ||
    normalizeAuditUrl(navigationUrl) !== navigationUrl) throw new TypeError();
  const evidenceUrl = captureEvidenceUrl(descriptors.evidenceUrl.value);
  const expectedEvidenceUrl = sanitizeEvidenceUrlV1(navigationUrl, { includeQuery: false });
  if (evidenceUrl.href !== expectedEvidenceUrl.href ||
    evidenceUrl.queryIncluded !== expectedEvidenceUrl.queryIncluded ||
    evidenceUrl.redactedSegments !== expectedEvidenceUrl.redactedSegments) throw new TypeError();
  return Object.freeze({ line, navigationUrl, evidenceUrl });
}

function captureEvidenceUrl(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!exactOwnDataDescriptors(descriptors, EVIDENCE_URL_KEYS)) throw new TypeError();
  const captured = Object.freeze({
    version: descriptors.version.value,
    href: descriptors.href.value,
    queryIncluded: descriptors.queryIncluded.value,
    redactedSegments: descriptors.redactedSegments.value,
  });
  if (!isEvidenceUrlV1(captured)) throw new TypeError();
  return captured;
}

function exactOwnDataDescriptors(descriptors, expectedKeys) {
  const keys = Reflect.ownKeys(descriptors);
  return keys.length === expectedKeys.length &&
    keys.every(key => typeof key === 'string' && expectedKeys.includes(key)) &&
    expectedKeys.every(key => {
      const descriptor = descriptors[key];
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
    });
}

function validateInputs({ entries, batchAuditId, chromeAdapter, runner, pageTimeoutMs, cleanupTimeoutMs, evidenceBudgetBytes, reportOptions }) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 20 ||
    typeof batchAuditId !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/u.test(batchAuditId) ||
    !chromeAdapter || typeof chromeAdapter !== 'object' || typeof runner !== 'function' ||
    !Number.isFinite(pageTimeoutMs) || pageTimeoutMs <= 0 ||
    !Number.isFinite(cleanupTimeoutMs) || cleanupTimeoutMs <= 0 || !reportOptions) {
    throw new TypeError(INVALID_BATCH_CONFIG_MESSAGE);
  }
  if (!Number.isSafeInteger(evidenceBudgetBytes) || evidenceBudgetBytes < 0) {
    throw new TypeError('Orçamento de evidências do lote inválido.');
  }
}

function validateTransientReviewUrl(value, auditId, expectedExtensionId) {
  try { return canonicalInternalReviewUrl(value ?? null, auditId, expectedExtensionId); } catch { return null; }
}
