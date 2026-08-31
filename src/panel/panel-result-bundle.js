import { validateExecutionCheckpoint } from '../background/execution-checkpoint.js';
import { verifyAuditIntegritySnapshot } from '../core/report/integrity.js';
import { buildPanelDetail } from './panel-detail.js';
import { buildPanelSummary } from './panel-summary.js';

const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const MAX_ARRAY = 10_000;
const MAX_STRING_CODE_POINTS = 1_048_576;
const MAX_STRING_BYTES = 8_388_608;
const GROUP_NAMES = Object.freeze(['failed', 'alerts', 'humanReview', 'passed']);

function denied() { throw new TypeError('PANEL_RESULT_BUNDLE_DENIED'); }

function copyGraph(root) {
  const seen = new WeakSet();
  const budget = { nodes: 0, bytes: 0 };
  const copy = (value, depth) => {
    if (depth > MAX_DEPTH) denied();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) denied();
      return value;
    }
    if (typeof value === 'string') {
      if ([...value].length > MAX_STRING_CODE_POINTS) denied();
      budget.bytes += new TextEncoder().encode(value).byteLength;
      if (budget.bytes > MAX_STRING_BYTES) denied();
      return value;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) denied();
    seen.add(value);
    budget.nodes += 1;
    if (budget.nodes > MAX_NODES) denied();
    let prototype;
    let keys;
    try { prototype = Object.getPrototypeOf(value); keys = Reflect.ownKeys(value); } catch { denied(); }
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) denied();
      const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ARRAY) denied();
      const expected = ['length', ...Array.from({ length }, (_entry, index) => String(index))];
      if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) denied();
      const result = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) denied();
        result.push(copy(descriptor.value, depth + 1));
      }
      return result;
    }
    if (prototype !== Object.prototype && prototype !== null) denied();
    const result = {};
    for (const key of keys) {
      if (typeof key !== 'string') denied();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) denied();
      result[key] = copy(descriptor.value, depth + 1);
    }
    return result;
  };
  return copy(root, 0);
}

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) denied();
  const own = Object.keys(value);
  if (own.length !== keys.length || keys.some(key => !own.includes(key))) denied();
  return value;
}

function string(value, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string') denied();
}

function stringArray(value) {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) denied();
}

function safeCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) denied();
}

function validateCard(card, auditId) {
  exact(card, [
    'checkKey', 'pageId', 'engine', 'ruleId', 'originalOutcome', 'displayOutcome', 'title', 'impact',
    'wcag', 'abntItemIds', 'occurrenceIds', 'classification', 'context', 'accessibleName',
    'announcement', 'evidence',
  ]);
  for (const key of ['checkKey', 'pageId', 'engine', 'ruleId', 'originalOutcome', 'displayOutcome', 'title', 'classification', 'context']) string(card[key]);
  string(card.impact, true); string(card.accessibleName, true); string(card.announcement, true);
  stringArray(card.wcag); stringArray(card.abntItemIds); stringArray(card.occurrenceIds);
  if (card.occurrenceIds.some(id => !id) || new Set(card.occurrenceIds).size !== card.occurrenceIds.length) denied();
  exact(card.evidence, ['evidenceIds', 'highlightAvailable']);
  stringArray(card.evidence.evidenceIds);
  if (card.evidence.highlightAvailable !== false) denied();
  if (!auditId) denied();
}

function validateSummary(summary, auditId) {
  exact(summary, ['version', 'auditId', 'identity', 'coverage', 'counts', 'distributions', 'limitations', 'groups']);
  if (summary.version !== 1 || summary.auditId !== auditId) denied();
  exact(summary.identity, ['finalUrl', 'completedAt', 'status']);
  string(summary.identity.finalUrl); string(summary.identity.completedAt); string(summary.identity.status);
  if (summary.coverage?.status === 'available') {
    exact(summary.coverage, ['status', 'numerator', 'denominator', 'percent']);
    safeCount(summary.coverage.numerator); safeCount(summary.coverage.denominator); string(summary.coverage.percent);
  } else {
    exact(summary.coverage, ['status', 'reason']);
    if (summary.coverage.status !== 'unavailable') denied(); string(summary.coverage.reason);
  }
  exact(summary.counts, ['errors', 'alerts', 'humanReview', 'positive']);
  for (const row of Object.values(summary.counts)) {
    exact(row, ['checkKeys', 'occurrences']); safeCount(row.checkKeys); safeCount(row.occurrences);
  }
  exact(summary.distributions, ['impact', 'wcag', 'abnt']);
  for (const rows of Object.values(summary.distributions)) {
    if (!Array.isArray(rows)) denied();
    for (const row of rows) { exact(row, ['id', 'count']); string(row.id); safeCount(row.count); }
  }
  exact(summary.limitations, ['codes', 'notStartedPageIds', 'inapplicableCheckKeys', 'untestedCheckKeys']);
  for (const values of Object.values(summary.limitations)) stringArray(values);
  exact(summary.groups, GROUP_NAMES);
  for (const groupName of GROUP_NAMES) {
    if (!Array.isArray(summary.groups[groupName])) denied();
    for (const card of summary.groups[groupName]) validateCard(card, auditId);
  }
}

function nullableStrings(value, keys) {
  exact(value, keys);
  for (const key of keys) string(value[key], true);
}

function validateDetail(detail, auditId) {
  exact(detail, [
    'version', 'auditId', 'occurrenceId', 'checkKey', 'heading', 'affected', 'observed', 'correction',
    'targets', 'accessibility', 'normative', 'legalReference', 'previews', 'technical', 'action',
  ]);
  if (detail.version !== 1 || detail.auditId !== auditId) denied();
  string(detail.occurrenceId); string(detail.checkKey);
  nullableStrings(detail.heading, ['title', 'classification', 'impact', 'context']);
  nullableStrings(detail.affected, ['audience', 'reason']);
  string(detail.observed); string(detail.correction);
  if (!Array.isArray(detail.targets)) denied();
  for (const target of detail.targets) {
    exact(target, ['nodeId', 'position', 'total']); string(target.nodeId, true); safeCount(target.position); safeCount(target.total);
  }
  nullableStrings(detail.accessibility, ['name', 'nameSource', 'announcementPreview']);
  exact(detail.normative, ['wcag', 'level', 'abntItem', 'classification']);
  stringArray(detail.normative.wcag); stringArray(detail.normative.level);
  string(detail.normative.abntItem, true); string(detail.normative.classification, true);
  if (detail.legalReference !== null) nullableStrings(detail.legalReference, ['basisRef', 'abntItem', 'statement', 'qualification']);
  if (!Array.isArray(detail.previews)) denied();
  for (const preview of detail.previews) nullableStrings(preview, ['evidenceId', 'kind', 'dataUrl', 'mediaUrl', 'origin']);
  exact(detail.technical, ['selector', 'framePath', 'snippet', 'styles', 'engine', 'ruleId', 'version', 'hashes']);
  string(detail.technical.selector, true); stringArray(detail.technical.framePath); string(detail.technical.snippet, true);
  if (!Array.isArray(detail.technical.styles)) denied();
  string(detail.technical.engine); string(detail.technical.ruleId); string(detail.technical.version); stringArray(detail.technical.hashes);
  nullableStrings(detail.action, ['kind', 'reason']);
}

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

export function copyPanelResultBundleV1(value) {
  try {
    const bundle = copyGraph(value);
    exact(bundle, ['version', 'auditId', 'modelRevision', 'modelHash', 'summary', 'details']);
    if (bundle.version !== 1 || typeof bundle.auditId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/u.test(bundle.auditId) ||
      !Number.isSafeInteger(bundle.modelRevision) || bundle.modelRevision < 1 ||
      typeof bundle.modelHash !== 'string' || !/^[a-f0-9]{64}$/u.test(bundle.modelHash) || !Array.isArray(bundle.details)) denied();
    validateSummary(bundle.summary, bundle.auditId);
    const expectedIds = GROUP_NAMES.flatMap(name => bundle.summary.groups[name])
      .flatMap(card => card.occurrenceIds).filter(Boolean);
    if (new Set(expectedIds).size !== expectedIds.length) denied();
    const sorted = [...expectedIds].sort((left, right) => left.localeCompare(right));
    if (bundle.details.length !== sorted.length) denied();
    bundle.details.forEach((detail, index) => {
      validateDetail(detail, bundle.auditId);
      if (detail.occurrenceId !== sorted[index]) denied();
      const cards = GROUP_NAMES.flatMap(name => bundle.summary.groups[name])
        .filter(card => card.occurrenceIds.includes(detail.occurrenceId));
      if (cards.length !== 1 || cards[0].checkKey !== detail.checkKey) denied();
    });
    return freeze(bundle);
  } catch { denied(); }
}

export async function createPanelResultBundleV1({ reportRevision, inventory } = {}) {
  try {
    const candidate = copyGraph(reportRevision);
    exact(candidate, ['version', 'auditId', 'modelRevision', 'modelHash', 'model', 'checkpoint']);
    if (candidate.version !== 1 || typeof candidate.auditId !== 'string' ||
      !Number.isSafeInteger(candidate.modelRevision) || candidate.modelRevision < 1 ||
      !/^[a-f0-9]{64}$/u.test(candidate.modelHash ?? '')) denied();
    const model = await verifyAuditIntegritySnapshot(candidate.model);
    if (model.auditId !== candidate.auditId || model.integrity.canonicalModelHash !== candidate.modelHash ||
      !['complete', 'partial', 'failed', 'cancelled'].includes(model.session.status)) denied();
    const checkpoint = validateExecutionCheckpoint({
      auditId: candidate.auditId, checkpoint: candidate.checkpoint,
      pageOrder: model.pages.map(page => page.pageId),
    });
    const summary = await buildPanelSummary({ model, executionCheckpoint: checkpoint, inventory });
    const occurrenceIds = GROUP_NAMES.flatMap(name => summary.groups[name])
      .flatMap(card => card.occurrenceIds).filter(Boolean);
    if (new Set(occurrenceIds).size !== occurrenceIds.length) denied();
    const details = [...occurrenceIds].sort((left, right) => left.localeCompare(right))
      .map(occurrenceId => buildPanelDetail({ model, summary, occurrenceId, highlightAvailability: new Map() }));
    return copyPanelResultBundleV1({
      version: 1, auditId: candidate.auditId, modelRevision: candidate.modelRevision,
      modelHash: candidate.modelHash, summary, details,
    });
  } catch { denied(); }
}
