import { verifyCoreRuleInventory } from '../core/rules/core-rule-inventory.js';

const CORE_OUTCOMES = new Set(['passed', 'failed', 'cantTell', 'inapplicable', 'untested']);

function freezeCheckpoint(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeCheckpoint(child, seen);
  return Object.freeze(value);
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(value);
}

function validTime(value) {
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime()) && new Date(value).toISOString() === value;
}

export async function createPageCheckpointRecorder({ auditId, pageId, startedAt, rulesVersion, inventory, onCheckpoint }) {
  const verifiedInventory = await verifyCoreRuleInventory(inventory);
  if (verifiedInventory.rulesVersion !== rulesVersion) throw new TypeError('CHECKPOINT_INVENTORY_VERSION_MISMATCH');
  if (!validId(auditId) || !validId(pageId) || !validTime(startedAt) ||
    typeof rulesVersion !== 'string' || typeof onCheckpoint !== 'function') {
    throw new TypeError('CHECKPOINT_RECORDER_INVALID');
  }
  let started = false;
  let tail = Promise.resolve();
  const outcomes = new Map();
  const snapshot = () => freezeCheckpoint({
    version: 1,
    auditId,
    pages: [{
      pageId, attempted: true, startedAt, rulesVersion,
      inventoryVersion: verifiedInventory.inventoryVersion,
      inventoryHash: verifiedInventory.sha256,
      outcomes: [...outcomes].sort(([a], [b]) => a.localeCompare(b))
        .map(([ruleId, outcome]) => ({ ruleId, outcome })),
    }],
  });
  const enqueue = value => {
    tail = tail.then(() => onCheckpoint(value));
    return tail;
  };
  return Object.freeze({
    started() {
      if (started) throw new Error('CHECKPOINT_ALREADY_STARTED');
      started = true;
      return enqueue(snapshot());
    },
    record(input) {
      let captured;
      try { captured = captureExact(input, ['ruleId', 'outcome']); } catch { throw new TypeError('CHECKPOINT_RESULT_DENIED'); }
      const { ruleId, outcome } = captured;
      if (!started || outcomes.has(ruleId) || !verifiedInventory.ruleIds.includes(ruleId) || !CORE_OUTCOMES.has(outcome)) {
        throw new TypeError('CHECKPOINT_RESULT_DENIED');
      }
      outcomes.set(ruleId, outcome);
      return enqueue(snapshot());
    },
    snapshot,
  });
}

function denyMerge() {
  throw new TypeError('CHECKPOINT_MERGE_DENIED');
}

function captureExact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) denyMerge();
  let ownKeys;
  try { ownKeys = Reflect.ownKeys(value); } catch { denyMerge(); }
  if (ownKeys.length !== keys.length || keys.some(key => !ownKeys.includes(key))) denyMerge();
  const copy = {};
  for (const key of keys) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { denyMerge(); }
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) denyMerge();
    copy[key] = descriptor.value;
  }
  return copy;
}

function captureArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) denyMerge();
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { denyMerge(); }
  const expected = ['length', ...Array.from({ length: value.length }, (_v, index) => String(index))];
  const keySet = new Set(keys); // O(n): includes() por índice era quadrático em listas grandes (1.1.53)
  if (keys.length !== expected.length || expected.some(key => !keySet.has(key))) denyMerge();
  return Array.from({ length: value.length }, (_v, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) denyMerge();
    return descriptor.value;
  });
}

function copyPage(page, auditId) {
  const keys = ['pageId', 'attempted', 'startedAt', 'rulesVersion', 'inventoryVersion', 'inventoryHash', 'outcomes'];
  const captured = captureExact(page, keys);
  const rawOutcomes = captureArray(captured.outcomes);
  if (!validId(captured.pageId) || typeof captured.attempted !== 'boolean' || typeof captured.rulesVersion !== 'string' ||
    typeof captured.inventoryVersion !== 'string' || !/^[a-f0-9]{64}$/u.test(captured.inventoryHash) ||
    (captured.attempted ? !validTime(captured.startedAt) : captured.startedAt !== null) ||
    (!captured.attempted && rawOutcomes.length > 0)) denyMerge();
  const seen = new Set();
  const outcomes = rawOutcomes.map(row => {
    const capturedRow = captureExact(row, ['ruleId', 'outcome']);
    if (!validId(capturedRow.ruleId) || !CORE_OUTCOMES.has(capturedRow.outcome) || seen.has(capturedRow.ruleId)) denyMerge();
    seen.add(capturedRow.ruleId);
    return { ruleId: capturedRow.ruleId, outcome: capturedRow.outcome };
  });
  if (outcomes.some((row, index) => index > 0 && outcomes[index - 1].ruleId.localeCompare(row.ruleId) >= 0)) denyMerge();
  return {
    pageId: captured.pageId, attempted: captured.attempted, startedAt: captured.startedAt,
    rulesVersion: captured.rulesVersion, inventoryVersion: captured.inventoryVersion,
    inventoryHash: captured.inventoryHash, outcomes,
  };
}

function copyCheckpoint(value, auditId) {
  const captured = captureExact(value, ['version', 'auditId', 'pages']);
  if (captured.version !== 1 || captured.auditId !== auditId) denyMerge();
  const pages = captureArray(captured.pages).map(page => copyPage(page, auditId));
  if (new Set(pages.map(page => page.pageId)).size !== pages.length) denyMerge();
  return pages;
}

export function validateExecutionCheckpoint({ auditId, checkpoint, pageOrder }) {
  try {
    if (!validId(auditId)) denyMerge();
    const orderedPageIds = captureArray(pageOrder);
    if (orderedPageIds.length === 0 || orderedPageIds.some(pageId => !validId(pageId)) ||
      new Set(orderedPageIds).size !== orderedPageIds.length) denyMerge();
    const pages = copyCheckpoint(checkpoint, auditId);
    if (pages.length !== orderedPageIds.length ||
      pages.some((page, index) => page.pageId !== orderedPageIds[index])) denyMerge();
    return freezeCheckpoint({ version: 1, auditId, pages });
  } catch {
    denyMerge();
  }
}

export function mergeExecutionCheckpoint({ auditId, prior, pageSnapshot, pageOrder }) {
  if (!validId(auditId) || !Array.isArray(pageOrder) || pageOrder.length === 0 ||
    pageOrder.some(pageId => !validId(pageId)) || new Set(pageOrder).size !== pageOrder.length) denyMerge();
  const priorPages = prior === null ? [] : copyCheckpoint(prior, auditId);
  const incomingPages = copyCheckpoint(pageSnapshot, auditId);
  if (incomingPages.length !== 1) denyMerge();
  for (let index = 0; index < priorPages.length; index += 1) {
    if (priorPages[index].pageId !== pageOrder[index]) denyMerge();
  }
  const incoming = incomingPages[0];
  if (pageOrder[priorPages.length] !== incoming.pageId || priorPages.some(page => page.pageId === incoming.pageId)) denyMerge();
  if (priorPages.length > 0) {
    const reference = priorPages[0];
    if (incoming.rulesVersion !== reference.rulesVersion || incoming.inventoryVersion !== reference.inventoryVersion ||
      incoming.inventoryHash !== reference.inventoryHash) denyMerge();
  }
  return freezeCheckpoint({ version: 1, auditId, pages: [...priorPages, incoming] });
}
