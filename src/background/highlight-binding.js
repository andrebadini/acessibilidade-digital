import { sanitizeResourceUrl } from '../core/normalize-snapshot.js';
import { isAuditIntegrityVerified } from '../core/report/integrity.js';
import { parseHighlightSelectorV1 } from './highlight-locator.js';

const BINDING_KEYS = Object.freeze([
  'version', 'auditId', 'pageId', 'modelRevision', 'modelHash', 'tabId', 'windowId',
  'topDocumentId', 'topUrlEvidence', 'topUrlSessionDigest', 'createdAt', 'expiresAt',
  'locatorVersion', 'targets',
]);
const TARGET_KEYS = Object.freeze([
  'documentId', 'frameId', 'backendNodeId', 'evidenceId', 'selector',
  'structuralSignature', 'rectBucket',
]);
const SELECTOR_KEYS = Object.freeze(['syntax', 'value', 'byteLength', 'complexity']);
const SIGNATURE_KEYS = Object.freeze(['version', 'sha256']);
const RECT_KEYS = Object.freeze(['x', 'y', 'width', 'height']);
const SNAPSHOT_KEYS = Object.freeze(['model', 'modelRevision', 'modelHash']);
const OBSERVED_KEYS = Object.freeze({
  attached: Object.freeze([
    'version', 'kind', 'tabId', 'windowId', 'documentId', 'urlSessionDigest', 'urlEvidence',
  ]),
  disposable: Object.freeze([
    'version', 'kind', 'ownerId', 'tabId', 'windowId', 'documentId', 'urlSessionDigest', 'urlEvidence',
  ]),
});
const PROOF_KEYS = Object.freeze([
  'occurrenceId', 'evidenceId', 'documentId', 'frameId', 'backendNodeId', 'selector',
  'structuralSignature', 'rectBucket',
]);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,200}$/u;
const DOCUMENT_ID = /^[A-Za-z0-9._:-]{1,240}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const HMAC = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const MAX_TARGETS = 5_000;
const MAX_MODEL_RELATION_ENTRIES = 5_000;
const MAX_MODEL_EVIDENCE_REFS = 25_000;
const MAX_URL_CODE_UNITS = 8_192;
const TTL_MS = 30 * 60_000;
const INVALID_BINDING = 'HighlightBindingV1 inválido.';
const INVALID_RELATION = 'Relação modelo-evidência inválida.';

function exactDataRecord(value, expectedKeys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== 'string') ||
      expectedKeys.some(key => !keys.includes(key))) return null;
    const result = Object.create(null);
    for (const key of expectedKeys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function dynamicDataEntries(value, maximum = MAX_TARGETS) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length > maximum || keys.some(key => typeof key !== 'string' || DANGEROUS_KEYS.has(key))) return null;
    const entries = [];
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      entries.push([key, descriptor.value]);
    }
    return entries;
  } catch {
    return null;
  }
}

function denseArrayValues(value, maximum) {
  try {
    if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Reflect.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) return null;
    const keys = Reflect.ownKeys(value);
    const expected = ['length', ...Array.from({ length }, (_entry, index) => String(index))];
    if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) return null;
    const result = new Array(length);
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      result[index] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function boundedId(value) {
  return typeof value === 'string' && IDENTIFIER.test(value) && !DANGEROUS_KEYS.has(value);
}

function validChromeId(value, { positive = false } = {}) {
  return Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0);
}

function safeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function canonicalEvidenceUrl(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_URL_CODE_UNITS) return false;
  try {
    return /^https?:\/\//u.test(value) && sanitizeResourceUrl(value) === value;
  } catch {
    return false;
  }
}

function selectorRecord(value) {
  const record = exactDataRecord(value, SELECTOR_KEYS);
  if (!record || record.syntax !== 'CSSSelectorV1') return null;
  let parsed;
  try {
    parsed = parseHighlightSelectorV1(record.value);
  } catch {
    return null;
  }
  if (record.byteLength !== parsed.byteLength || record.complexity !== parsed.complexity) return null;
  return {
    syntax: 'CSSSelectorV1',
    value: parsed.value,
    byteLength: parsed.byteLength,
    complexity: parsed.complexity,
  };
}

function signatureRecord(value) {
  const record = exactDataRecord(value, SIGNATURE_KEYS);
  return record && record.version === 'StructuralSignatureV1' && typeof record.sha256 === 'string' &&
    SHA256.test(record.sha256)
    ? { version: 'StructuralSignatureV1', sha256: record.sha256 }
    : null;
}

function rectRecord(value) {
  if (value === null) return null;
  const record = exactDataRecord(value, RECT_KEYS);
  if (!record) return undefined;
  for (const key of RECT_KEYS) {
    if (!Number.isSafeInteger(record[key]) || Math.abs(record[key]) > 1_000_000 || record[key] % 16 !== 0) {
      return undefined;
    }
  }
  if (record.width < 0 || record.height < 0) return undefined;
  return { x: record.x, y: record.y, width: record.width, height: record.height };
}

function targetRecord(value) {
  const record = exactDataRecord(value, TARGET_KEYS);
  if (!record || typeof record.documentId !== 'string' || !DOCUMENT_ID.test(record.documentId) ||
    !validChromeId(record.frameId) || !validChromeId(record.backendNodeId, { positive: true }) ||
    !boundedId(record.evidenceId)) return null;
  const selector = selectorRecord(record.selector);
  const structuralSignature = signatureRecord(record.structuralSignature);
  const rectBucket = rectRecord(record.rectBucket);
  if (!selector || !structuralSignature || rectBucket === undefined) return null;
  return {
    documentId: record.documentId,
    frameId: record.frameId,
    backendNodeId: record.backendNodeId,
    evidenceId: record.evidenceId,
    selector,
    structuralSignature,
    rectBucket,
  };
}

function bindingRecord(input) {
  const record = exactDataRecord(input, BINDING_KEYS);
  if (!record || record.version !== 1 || !boundedId(record.auditId) || !boundedId(record.pageId) ||
    !Number.isSafeInteger(record.modelRevision) || record.modelRevision < 1 ||
    typeof record.modelHash !== 'string' || !SHA256.test(record.modelHash) || !validChromeId(record.tabId) ||
    !validChromeId(record.windowId) || typeof record.topDocumentId !== 'string' ||
    !DOCUMENT_ID.test(record.topDocumentId) || !canonicalEvidenceUrl(record.topUrlEvidence) ||
    typeof record.topUrlSessionDigest !== 'string' || !HMAC.test(record.topUrlSessionDigest) ||
    !safeTimestamp(record.createdAt) ||
    !safeTimestamp(record.expiresAt) || record.expiresAt < record.createdAt ||
    !Number.isSafeInteger(record.createdAt + TTL_MS) || record.expiresAt > record.createdAt + TTL_MS ||
    record.locatorVersion !== 'CSSSelectorV1+StructuralSignatureV1') return null;

  const entries = dynamicDataEntries(record.targets);
  if (!entries || entries.length < 1) return null;
  const targets = Object.create(null);
  for (const [occurrenceId, rawTarget] of entries) {
    if (!boundedId(occurrenceId) || Object.hasOwn(targets, occurrenceId)) return null;
    const target = targetRecord(rawTarget);
    if (!target) return null;
    targets[occurrenceId] = target;
  }
  return {
    version: 1,
    auditId: record.auditId,
    pageId: record.pageId,
    modelRevision: record.modelRevision,
    modelHash: record.modelHash,
    tabId: record.tabId,
    windowId: record.windowId,
    topDocumentId: record.topDocumentId,
    topUrlEvidence: record.topUrlEvidence,
    topUrlSessionDigest: record.topUrlSessionDigest,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    locatorVersion: 'CSSSelectorV1+StructuralSignatureV1',
    targets,
  };
}

function deepFreezePlain(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreezePlain(value[key]);
  return Object.freeze(value);
}

function invalidBinding() {
  throw new TypeError(INVALID_BINDING);
}

export function validateHighlightBindingV1(input) {
  try {
    const canonical = bindingRecord(input);
    if (!canonical) invalidBinding();
    return deepFreezePlain(canonical);
  } catch {
    invalidBinding();
  }
}

export function createHighlightBindingV1(input) {
  return validateHighlightBindingV1(input);
}

function authoritySnapshot(value) {
  const snapshot = exactDataRecord(value, SNAPSHOT_KEYS);
  if (!snapshot || !isAuditIntegrityVerified(snapshot.model) ||
    !Number.isSafeInteger(snapshot.modelRevision) || snapshot.modelRevision < 1 ||
    typeof snapshot.modelHash !== 'string' || !SHA256.test(snapshot.modelHash) ||
    snapshot.model?.integrity?.canonicalModelHash !== snapshot.modelHash) {
    return null;
  }
  return snapshot;
}

function selectorFromEvidence(evidence) {
  try {
    const selector = evidence?.selector?.css;
    if (typeof selector !== 'string') return null;
    const parsed = parseHighlightSelectorV1(selector);
    return {
      syntax: 'CSSSelectorV1', value: parsed.value,
      byteLength: parsed.byteLength, complexity: parsed.complexity,
    };
  } catch {
    return null;
  }
}

function createRelationshipIndex(model) {
  if (!Array.isArray(model.pages) || model.pages.length > MAX_MODEL_RELATION_ENTRIES ||
    !Array.isArray(model.evidence) || model.evidence.length > MAX_MODEL_RELATION_ENTRIES ||
    !Array.isArray(model.occurrences) || model.occurrences.length > MAX_MODEL_RELATION_ENTRIES) return null;

  const pageById = new Map();
  const pagesByFinalUrl = new Map();
  for (const page of model.pages) {
    if (pageById.has(page.pageId)) return null;
    pageById.set(page.pageId, page);
    const matching = pagesByFinalUrl.get(page.finalUrl) ?? [];
    matching.push(page);
    pagesByFinalUrl.set(page.finalUrl, matching);
  }

  const evidenceById = new Map();
  for (const evidence of model.evidence) {
    if (evidenceById.has(evidence.evidenceId)) return null;
    evidenceById.set(evidence.evidenceId, evidence);
  }

  const occurrenceById = new Map();
  const relationByOccurrenceId = new Map();
  let evidenceRefWork = 0;
  for (const occurrence of model.occurrences) {
    if (occurrenceById.has(occurrence.occurrenceId) || !Array.isArray(occurrence.evidenceRefs)) return null;
    evidenceRefWork += occurrence.evidenceRefs.length;
    if (!Number.isSafeInteger(evidenceRefWork) || evidenceRefWork > MAX_MODEL_EVIDENCE_REFS) return null;
    occurrenceById.set(occurrence.occurrenceId, occurrence);

    let nodeEvidence = null;
    let ambiguous = false;
    for (const evidenceId of occurrence.evidenceRefs) {
      const evidence = evidenceById.get(evidenceId);
      if (!evidence || evidence.pageId !== occurrence.pageId ||
        typeof evidence.nodeId !== 'string' || evidence.nodeId !== occurrence.nodeId ||
        !validChromeId(evidence.backendNodeId, { positive: true })) continue;
      if (nodeEvidence !== null) {
        ambiguous = true;
        break;
      }
      nodeEvidence = evidence;
    }
    const selector = !ambiguous && nodeEvidence ? selectorFromEvidence(nodeEvidence) : null;
    relationByOccurrenceId.set(occurrence.occurrenceId,
      nodeEvidence && selector && !ambiguous ? { occurrence, evidence: nodeEvidence, selector } : null);
  }

  return { pageById, pagesByFinalUrl, occurrenceById, evidenceById, relationByOccurrenceId };
}

function sameSelector(left, right) {
  return left.syntax === right.syntax && left.value === right.value &&
    left.byteLength === right.byteLength && left.complexity === right.complexity;
}

function bindingMatchesIndexedModel(binding, snapshot, index) {
  // Export bookkeeping advances the storage revision without changing the model.
  // Keep the original proof revision/expiry; require identical verified content
  // and refuse rollback before checking every occurrence/evidence relationship.
  if (!index || binding.auditId !== snapshot.model.auditId ||
    binding.modelRevision > snapshot.modelRevision || binding.modelHash !== snapshot.modelHash) throw new Error();
  const page = index.pageById.get(binding.pageId);
  if (!page || page.finalUrl !== binding.topUrlEvidence) throw new Error();
  for (const [occurrenceId, target] of Object.entries(binding.targets)) {
    const relation = index.relationByOccurrenceId.get(occurrenceId);
    if (!relation || relation.occurrence.pageId !== binding.pageId ||
      relation.evidence.evidenceId !== target.evidenceId ||
      relation.evidence.pageId !== binding.pageId || relation.evidence.backendNodeId !== target.backendNodeId ||
      !sameSelector(relation.selector, target.selector)) throw new Error();
  }
  return binding;
}

export function assertBindingMatchesModel(raw) {
  try {
    const args = exactDataRecord(raw, ['binding', 'snapshot']);
    if (!args) throw new Error();
    const binding = validateHighlightBindingV1(args.binding);
    const snapshot = authoritySnapshot(args.snapshot);
    if (!snapshot) throw new Error();
    return bindingMatchesIndexedModel(binding, snapshot, createRelationshipIndex(snapshot.model));
  } catch {
    throw new TypeError(INVALID_RELATION);
  }
}

function observedTargetRecord(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const kind = Reflect.getOwnPropertyDescriptor(value, 'kind');
    if (!kind?.enumerable || !Object.hasOwn(kind, 'value')) return null;
    const record = exactDataRecord(value, OBSERVED_KEYS[kind.value] ?? []);
    if (!record || record.version !== 1 || !['attached', 'disposable'].includes(record.kind) ||
      !validChromeId(record.tabId) || !validChromeId(record.windowId) ||
      typeof record.documentId !== 'string' || !DOCUMENT_ID.test(record.documentId) ||
      typeof record.urlSessionDigest !== 'string' || !HMAC.test(record.urlSessionDigest) ||
      !canonicalEvidenceUrl(record.urlEvidence) ||
      (record.kind === 'disposable' && !boundedId(record.ownerId))) return null;
    return record;
  } catch {
    return null;
  }
}

function ownMethod(value, name) {
  try {
    const descriptor = value && typeof value === 'object'
      ? Reflect.getOwnPropertyDescriptor(value, name)
      : null;
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function eligibleCandidates(snapshot, pageId, index) {
  const output = [];
  for (const occurrence of snapshot.model.occurrences) {
    if (occurrence.pageId !== pageId || output.length >= MAX_TARGETS) continue;
    const relation = index.relationByOccurrenceId.get(occurrence.occurrenceId);
    if (!relation) continue;
    output.push(Object.freeze({
      occurrenceId: occurrence.occurrenceId,
      evidenceId: relation.evidence.evidenceId,
      backendNodeId: relation.evidence.backendNodeId,
      selector: deepFreezePlain({ ...relation.selector }),
    }));
  }
  return Object.freeze(output);
}

function proofRecord(value) {
  const proof = exactDataRecord(value, PROOF_KEYS);
  return proof && boundedId(proof.occurrenceId) ? proof : null;
}

function correlatedProof(proof, candidates) {
  if (!proof || !boundedId(proof.occurrenceId)) return null;
  const candidate = candidates.get(proof.occurrenceId);
  if (!candidate || proof.evidenceId !== candidate.evidenceId ||
    proof.backendNodeId !== candidate.backendNodeId) return null;
  const target = targetRecord({
    documentId: proof.documentId,
    frameId: proof.frameId,
    backendNodeId: proof.backendNodeId,
    evidenceId: proof.evidenceId,
    selector: proof.selector,
    structuralSignature: proof.structuralSignature,
    rectBucket: proof.rectBucket,
  });
  return target && sameSelector(target.selector, candidate.selector)
    ? { occurrenceId: proof.occurrenceId, target }
    : null;
}

function candidateProofOccurrenceId(proof, candidates) {
  return proof && boundedId(proof.occurrenceId) && candidates.has(proof.occurrenceId)
    ? proof.occurrenceId
    : null;
}

export async function recordHighlightBindingV1(raw) {
  const args = exactDataRecord(raw, ['snapshot', 'observedTarget', 'chromeAdapter', 'digestManager', 'now']);
  const snapshot = args && authoritySnapshot(args.snapshot);
  const observedTarget = args && observedTargetRecord(args.observedTarget);
  const getFinalUrl = args && ownMethod(args.chromeAdapter, 'getFinalUrl');
  const proveHighlightTargets = args && ownMethod(args.chromeAdapter, 'proveHighlightTargets');
  const digest = args && ownMethod(args.digestManager, 'digest');
  if (!args || !snapshot || !observedTarget || !getFinalUrl || !proveHighlightTargets || !digest ||
    typeof args.now !== 'function') throw new TypeError('HIGHLIGHT_RECORD_INVALID');

  const relationshipIndex = createRelationshipIndex(snapshot.model);
  if (!relationshipIndex) return null;
  const pages = relationshipIndex.pagesByFinalUrl.get(observedTarget.urlEvidence) ?? [];
  if (pages.length !== 1) return null;
  const page = pages[0];
  const candidates = eligibleCandidates(snapshot, page.pageId, relationshipIndex);
  if (candidates.length === 0) return null;

  let rawCurrentUrl;
  let currentDigest;
  try {
    rawCurrentUrl = await Reflect.apply(getFinalUrl, args.chromeAdapter, [observedTarget.tabId]);
    if (typeof rawCurrentUrl !== 'string' || rawCurrentUrl.length < 1 || rawCurrentUrl.length > 32_768) return null;
    currentDigest = await Reflect.apply(digest, args.digestManager, [rawCurrentUrl]);
  } catch {
    return null;
  }
  if (typeof currentDigest !== 'string' || !HMAC.test(currentDigest) ||
    currentDigest !== observedTarget.urlSessionDigest) return null;
  let rawProofs;
  try {
    rawProofs = await Reflect.apply(proveHighlightTargets, args.chromeAdapter, [{
      tabId: observedTarget.tabId,
      windowId: observedTarget.windowId,
      topDocumentId: observedTarget.documentId,
      candidates,
    }]);
  } catch {
    return null;
  }

  let confirmedRawUrl;
  let confirmedDigest;
  try {
    confirmedRawUrl = await Reflect.apply(getFinalUrl, args.chromeAdapter, [observedTarget.tabId]);
    if (typeof confirmedRawUrl !== 'string' || confirmedRawUrl.length < 1 || confirmedRawUrl.length > 32_768) return null;
    confirmedDigest = await Reflect.apply(digest, args.digestManager, [confirmedRawUrl]);
  } catch {
    return null;
  }
  const stableUrl = confirmedRawUrl === rawCurrentUrl;
  rawCurrentUrl = null;
  confirmedRawUrl = null;
  if (!stableUrl || typeof confirmedDigest !== 'string' || !HMAC.test(confirmedDigest) ||
    confirmedDigest !== observedTarget.urlSessionDigest) return null;
  confirmedDigest = null;

  const proofs = denseArrayValues(rawProofs, MAX_TARGETS);
  if (!proofs) return null;
  const candidateByOccurrence = new Map(candidates.map(candidate => [candidate.occurrenceId, candidate]));
  const proofByOccurrence = new Map();
  const ambiguous = new Set();
  const seenProofOccurrences = new Set();
  for (const rawProof of proofs) {
    const proofSnapshot = proofRecord(rawProof);
    const claimedOccurrenceId = candidateProofOccurrenceId(proofSnapshot, candidateByOccurrence);
    if (claimedOccurrenceId !== null) {
      if (seenProofOccurrences.has(claimedOccurrenceId)) ambiguous.add(claimedOccurrenceId);
      seenProofOccurrences.add(claimedOccurrenceId);
    }
    const proof = correlatedProof(proofSnapshot, candidateByOccurrence);
    if (!proof) continue;
    proofByOccurrence.set(proof.occurrenceId, proof.target);
  }
  for (const occurrenceId of ambiguous) proofByOccurrence.delete(occurrenceId);
  if (proofByOccurrence.size === 0) return null;

  const createdAt = args.now();
  const expiresAt = createdAt + TTL_MS;
  if (!safeTimestamp(createdAt) || !safeTimestamp(expiresAt)) throw new TypeError('HIGHLIGHT_RECORD_INVALID');
  const targets = Object.create(null);
  for (const candidate of candidates) {
    const target = proofByOccurrence.get(candidate.occurrenceId);
    if (target) targets[candidate.occurrenceId] = target;
  }
  try {
    const binding = createHighlightBindingV1({
      version: 1,
      auditId: snapshot.model.auditId,
      pageId: page.pageId,
      modelRevision: snapshot.modelRevision,
      modelHash: snapshot.modelHash,
      tabId: observedTarget.tabId,
      windowId: observedTarget.windowId,
      topDocumentId: observedTarget.documentId,
      topUrlEvidence: observedTarget.urlEvidence,
      topUrlSessionDigest: observedTarget.urlSessionDigest,
      createdAt,
      expiresAt,
      locatorVersion: 'CSSSelectorV1+StructuralSignatureV1',
      targets,
    });
    return bindingMatchesIndexedModel(binding, snapshot, relationshipIndex);
  } catch {
    return null;
  }
}
