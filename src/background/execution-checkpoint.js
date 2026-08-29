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
    record({ ruleId, outcome }) {
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

function copyPage(page, auditId) {
  if (!page || typeof page !== 'object' || Array.isArray(page)) denyMerge();
  const keys = ['pageId', 'attempted', 'startedAt', 'rulesVersion', 'inventoryVersion', 'inventoryHash', 'outcomes'];
  let ownKeys;
  try { ownKeys = Reflect.ownKeys(page); } catch { denyMerge(); }
  if (ownKeys.length !== keys.length || keys.some(key => !ownKeys.includes(key)) || !validId(page.pageId) ||
    typeof page.attempted !== 'boolean' || typeof page.rulesVersion !== 'string' ||
    typeof page.inventoryVersion !== 'string' || !/^[a-f0-9]{64}$/u.test(page.inventoryHash) ||
    (page.attempted ? !validTime(page.startedAt) : page.startedAt !== null) || !Array.isArray(page.outcomes) ||
    (!page.attempted && page.outcomes.length > 0)) denyMerge();
  const seen = new Set();
  const outcomes = page.outcomes.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
      Reflect.ownKeys(row).length !== 2 || !Object.hasOwn(row, 'ruleId') || !Object.hasOwn(row, 'outcome') ||
      !validId(row.ruleId) || !CORE_OUTCOMES.has(row.outcome) || seen.has(row.ruleId)) denyMerge();
    seen.add(row.ruleId);
    return { ruleId: row.ruleId, outcome: row.outcome };
  });
  if (outcomes.some((row, index) => index > 0 && outcomes[index - 1].ruleId.localeCompare(row.ruleId) >= 0)) denyMerge();
  return {
    pageId: page.pageId, attempted: page.attempted, startedAt: page.startedAt,
    rulesVersion: page.rulesVersion, inventoryVersion: page.inventoryVersion,
    inventoryHash: page.inventoryHash, outcomes,
  };
}

function copyCheckpoint(value, auditId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
    value.auditId !== auditId || !Array.isArray(value.pages) ||
    Reflect.ownKeys(value).length !== 3 || !Object.hasOwn(value, 'version') ||
    !Object.hasOwn(value, 'auditId') || !Object.hasOwn(value, 'pages')) denyMerge();
  const pages = value.pages.map(page => copyPage(page, auditId));
  if (new Set(pages.map(page => page.pageId)).size !== pages.length) denyMerge();
  return pages;
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
