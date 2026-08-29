import { canonicalTime, runAuditExecution } from './run-audit.js';
import { mergeExecutionCheckpoint } from './execution-checkpoint.js';
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
import { sanitizeResourceUrl } from '../core/normalize-snapshot.js';
import { enrichAuditForReport } from '../core/report/enrich-audit.js';
import { canonicalInternalReviewUrl } from '../core/report/report-policy.js';
import { normalizeAuditUrl } from '../core/url.js';
import {
  applyBatchEvidenceBudget,
  DEFAULT_BATCH_EVIDENCE_BUDGET_BYTES,
} from '../core/batch/evidence-budget.js';
import { AUDIT_EXECUTION_INTERNAL } from './chrome-adapter.js';

const DEFAULT_PAGE_TIMEOUT_MS = 120_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
const CLEANUP_FAILURE_CODES = new Set(['TAB_CLOSE_FAILED', 'CDP_DISCONNECT_FAILED']);

/** Audits only the normalized explicit list, exactly one disposable tab at a time. */
export async function runBatch({
  entries,
  batchAuditId,
  chromeAdapter,
  runner = runAuditExecution,
  now = () => new Date().toISOString(),
  signal,
  pageTimeoutMs = DEFAULT_PAGE_TIMEOUT_MS,
  cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
  evidenceBudgetBytes = DEFAULT_BATCH_EVIDENCE_BUDGET_BYTES,
  reportOptions,
  onCheckpoint = async () => {},
  onExecutionCheckpoint = async () => {},
}) {
  validateInputs({ entries, batchAuditId, chromeAdapter, runner, pageTimeoutMs, cleanupTimeoutMs, evidenceBudgetBytes, reportOptions });
  const template = createBatchReportTemplate(reportOptions);
  const startedAt = canonicalTime(now());
  let checkpoint = createBatchSession({ id: batchAuditId, total: entries.length, startedAt });
  let lastProgress = 0;
  let terminal = false;
  const pageResults = [];
  let evidenceBytesUsed = 0;
  let evidenceBudgetExhausted = false;
  let executionCheckpoint = null;
  const executionMode = runner === runAuditExecution;
  const pageOrder = entries.map((_entry, index) => `page-${index + 1}`);

  const claimFinalization = () => {
    if (terminal) return !signal?.aborted;
    const claimed = chromeAdapter.tryEnterFinalization?.();
    terminal = true;
    return claimed !== false && !signal?.aborted;
  };

  const saveCheckpoint = async () => {
    await onCheckpoint(checkpoint);
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
    try { await chromeAdapter.emitProgress?.(event); } catch { /* progresso não controla o lote */ }
  };

  await saveCheckpoint();
  await move({ type: 'VALIDATE', at: canonicalTime(now()) });
  await move({ type: 'QUEUE', at: canonicalTime(now()) });
  if (signal?.aborted) {
    await cancelRemaining({ active: false });
  } else {
    await move({ type: 'START', at: canonicalTime(now()) });
    for (let index = 0; index < entries.length; index += 1) {
      if (signal?.aborted) {
        await cancelRemaining({ active: false });
        break;
      }
      const entry = entries[index];
      const pageId = `page-${index + 1}`;
      const childAuditId = `${batchAuditId}:${pageId}`;
      const pageStartedAt = canonicalTime(now());
      let localPercent = 0;
      const childAdapter = {
        ...chromeAdapter,
        async emitProgress(progress) {
          const next = Number.isFinite(progress?.percent) ? Math.max(localPercent, progress.percent) : localPercent;
          localPercent = Math.min(100, next);
          await emitGlobalProgress({ pageIndex: index, pagePercent: localPercent });
        },
        async handoffReport() {
          return { reviewUrl: null, artifact: { status: 'pending', formats: [] } };
        },
      };
      const executionInternals = Object.getOwnPropertyDescriptor(chromeAdapter, AUDIT_EXECUTION_INTERNAL);
      if (executionInternals && Object.hasOwn(executionInternals, 'value')) {
        Object.defineProperty(childAdapter, AUDIT_EXECUTION_INTERNAL, {
          enumerable: false, value: executionInternals.value,
        });
      }
      const outcome = await runPageWithBoundary({
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
        }),
        externalSignal: signal,
        pageTimeoutMs,
        cleanupTimeoutMs,
      });
      const pageEndedAt = canonicalTime(now());

      if (outcome.kind === 'cancelled') {
        await cancelRemaining({ active: true, startedAt: pageStartedAt, endedAt: pageEndedAt });
        break;
      }
      if (outcome.kind === 'cleanup-unconfirmed') {
        if (!claimFinalization()) {
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
      if (outcome.kind === 'timeout') {
        pageResult = failureFor(entry, pageId, 'failed', true, pageStartedAt, pageEndedAt,
          'BATCH_PAGE_TIMEOUT', 'A página excedeu o tempo limite da auditoria.');
      } else if (outcome.kind === 'rejected') {
        pageResult = failureFor(entry, pageId, 'failed', true, pageStartedAt, pageEndedAt,
          'BATCH_PAGE_FAILED', 'A página não pôde ser auditada.');
      } else {
        try {
          const execution = executionMode ? outcome.value : null;
          const childValue = executionMode ? execution?.model : outcome.value;
          if (executionMode) {
            if (!execution?.checkpoint || !['removed', 'cleanup-pending'].includes(execution.ownershipState)) {
              throw new TypeError('Execução filha sem fronteira terminal comprovada.');
            }
            executionCheckpoint = mergeExecutionCheckpoint({
              auditId: batchAuditId, prior: executionCheckpoint,
              pageSnapshot: execution.checkpoint, pageOrder,
            });
            await onExecutionCheckpoint(executionCheckpoint);
            executionCleanupPending = execution.ownershipState === 'cleanup-pending';
          }
          if (childValue?.auditId !== childAuditId) throw new TypeError('Auditoria filha não correlacionada.');
          const child = await enrichAuditForReport(childValue, {
            ...reportOptions,
            now,
            browserVersion: reportOptions.browserVersion || childValue?.environment?.chromeVersion || 'não disponível',
          });
          pageResult = await remapAuditPage(child, { batchAuditId, pageId });
          const budgeted = await applyBatchEvidenceBudget(pageResult, {
            usedBytes: evidenceBytesUsed, limitBytes: evidenceBudgetBytes,
            exhausted: evidenceBudgetExhausted,
          });
          pageResult = budgeted.result;
          evidenceBytesUsed = budgeted.usedBytes;
          evidenceBudgetExhausted = budgeted.exhausted;
        } catch {
          pageResult = failureFor(entry, pageId, 'failed', true, pageStartedAt, pageEndedAt,
            'BATCH_PAGE_MODEL_INVALID', 'O resultado da página não pôde ser validado para o lote.');
        }
      }
      const stopsForCleanup = executionCleanupPending || pageResult.page.diagnostics?.some(value => CLEANUP_FAILURE_CODES.has(value.code));
      const endsScheduling = index === entries.length - 1 || stopsForCleanup;
      if (endsScheduling && !claimFinalization()) {
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
  let handoff = null;
  try { handoff = await chromeAdapter.handoffReport?.(finalModel); } catch { handoff = null; }
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

async function runPageWithBoundary({ operation, externalSignal, pageTimeoutMs, cleanupTimeoutMs }) {
  const controller = new AbortController();
  let timeoutId;
  let externalAbort = null;
  const settled = Promise.resolve().then(() => operation({ childSignal: controller.signal })).then(
    value => ({ kind: 'fulfilled', value }),
    error => ({ kind: 'rejected', error }),
  );
  const timeout = new Promise(resolve => {
    timeoutId = setTimeout(() => {
      controller.abort(new DOMException('A página excedeu o tempo limite.', 'TimeoutError'));
      resolve({ kind: 'timeout-boundary' });
    }, pageTimeoutMs);
  });
  const cancelled = new Promise(resolve => {
    externalAbort = () => {
      if (!controller.signal.aborted) controller.abort(externalSignal.reason ?? new DOMException('Operação cancelada.', 'AbortError'));
      resolve({ kind: 'cancel-boundary' });
    };
    externalSignal?.addEventListener('abort', externalAbort, { once: true });
  });
  const first = await Promise.race([settled, timeout, cancelled]);
  clearTimeout(timeoutId);
  externalSignal?.removeEventListener('abort', externalAbort);
  if (first.kind === 'fulfilled' || first.kind === 'rejected') return first;
  const cleanup = await Promise.race([
    settled,
    new Promise(resolve => setTimeout(() => resolve({ kind: 'cleanup-unconfirmed' }), cleanupTimeoutMs)),
  ]);
  if (cleanup.kind === 'cleanup-unconfirmed') return cleanup;
  return { kind: first.kind === 'cancel-boundary' ? 'cancelled' : 'timeout', settled: cleanup };
}

function failureFor(entry, pageId, status, attempted, startedAt, endedAt, code, message) {
  return createBatchFailurePage({
    pageId, requestedUrl: entry.reportUrl, status, attempted, startedAt, endedAt, code, message,
  });
}

function validateInputs({ entries, batchAuditId, chromeAdapter, runner, pageTimeoutMs, cleanupTimeoutMs, evidenceBudgetBytes, reportOptions }) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 20 ||
    typeof batchAuditId !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/u.test(batchAuditId) ||
    !chromeAdapter || typeof chromeAdapter !== 'object' || typeof runner !== 'function' ||
    !Number.isFinite(pageTimeoutMs) || pageTimeoutMs <= 0 ||
    !Number.isFinite(cleanupTimeoutMs) || cleanupTimeoutMs <= 0 || !reportOptions) {
    throw new TypeError('Configuração do lote inválida.');
  }
  if (!Number.isSafeInteger(evidenceBudgetBytes) || evidenceBudgetBytes < 0) {
    throw new TypeError('Orçamento de evidências do lote inválido.');
  }
  const reportUrls = new Set();
  for (const entry of entries) {
    if (!entry || !Number.isSafeInteger(entry.line) || entry.line < 1 ||
      normalizeAuditUrl(entry.navigationUrl) !== entry.navigationUrl ||
      sanitizeResourceUrl(entry.navigationUrl) !== entry.reportUrl || reportUrls.has(entry.reportUrl)) {
      throw new TypeError('Lista normalizada do lote inválida.');
    }
    reportUrls.add(entry.reportUrl);
  }
}

function validateTransientReviewUrl(value, auditId, expectedExtensionId) {
  try { return canonicalInternalReviewUrl(value ?? null, auditId, expectedExtensionId); } catch { return null; }
}
