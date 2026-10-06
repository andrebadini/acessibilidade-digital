import { isAuditIntegrityVerified } from '../core/report/integrity.js';
import { sanitizeHtmlSnippetSource } from '../core/evidence/snippet.js';
import { classifySelectorToken, parseCssSelectorV1 } from './highlight-locator.js';
import { classifyPanelResultV1, deriveResultContextV1 } from '../panel/panel-result-contract.js';

const MAX_ROWS = 5_000;
const MAX_REFS = 25_000;
const MAX_SNIPPET = 32_768;
const PRIORITY = Object.freeze({ failed: 4, alert: 3, 'manual-review': 2, passed: 1 });

function deny() { throw new TypeError('PAGE_MARKER_PROJECTION_INVALID'); }

function exactData(value, fields) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) return null;
    const result = {};
    for (const key of fields) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch { return null; }
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function classificationFor(occurrence, decision) {
  const originalOutcome = occurrence.outcome;
  const displayOutcome = ['failed', 'passed'].includes(originalOutcome) ? originalOutcome
    : decision?.answer === 'não conforme' ? 'failed'
      : decision?.answer === 'conforme' ? 'passed'
        : decision?.answer === 'não se aplica' ? 'inapplicable' : 'cantTell';
  const normative = occurrence.classification === 'requirement';
  const group = displayOutcome === 'passed' ? 'passed'
    : displayOutcome === 'inapplicable' ? null
    : displayOutcome === 'failed' ? (normative ? 'failed' : 'alerts')
      : ['requirement', 'recommendation'].includes(occurrence.classification) ? 'humanReview' : null;
  return { originalOutcome, displayOutcome, classification: group ? classifyPanelResultV1(group) : null };
}

// Read only the canonical opening tag produced by the existing sanitizer.
// No markup is mounted; only bounded locator tokens leave this function.
function rootIdentity(snippet) {
  if (typeof snippet !== 'string' || snippet.length === 0 || snippet.length > MAX_SNIPPET) return null;
  const opening = /^<([a-z][a-z0-9-]*)([^<>]*)>/u.exec(sanitizeHtmlSnippetSource(snippet));
  if (!opening) return null;
  const attributes = opening[2].replace(/\s*\/\s*$/u, '');
  const token = / ([a-z][a-z0-9:._-]*)(?:="([^"]*)")?/uy;
  let position = 0;
  const values = Object.create(null);
  while (position < attributes.length) {
    token.lastIndex = position;
    const match = token.exec(attributes);
    if (!match) return null;
    position = token.lastIndex;
    if (['id', 'class', 'role', 'type'].includes(match[1])) {
      if (Object.hasOwn(values, match[1]) || match[2] === undefined) return null;
      values[match[1]] = match[2];
    }
  }
  return { tag: opening[1], id: values.id ?? null,
    classes: [...new Set((values.class ?? '').split(/[\t\n\f\r ]+/u).filter(classifySelectorToken))].sort(),
    role: values.role ?? null, type: values.type ?? null };
}

function locatorFor(evidence) {
  if ((evidence.selector?.framePath?.length ?? 0) > 0 || evidence.selector?.css?.includes(' >>> ')) {
    return { reason: 'unsupported-context' };
  }
  const identity = rootIdentity(evidence.snippet);
  const css = evidence.selector?.css;
  let parsed;
  try {
    parsed = parseCssSelectorV1(typeof css === 'string' && css.startsWith('#') && identity
      ? `${identity.tag}${css}` : css);
  } catch {
    return { reason: typeof css === 'string' && css.startsWith('#') && !identity
      ? 'insufficient-correspondence' : 'unsupported-selector' };
  }
  const last = parsed.segments.at(-1);
  if (!identity || last.tag !== identity.tag || last.id !== identity.id) {
    return { reason: 'insufficient-correspondence' };
  }
  let match = { tag: last.tag, id: last.id };
  if (last.id === null) {
    if (!identity.classes.length || parsed.segments.some(segment =>
      segment.id !== null || segment.classes.length || segment.enumAttribute !== null)) {
      return { reason: 'insufficient-correspondence' };
    }
    // Sanitized snippets normalize whitespace. Require the recorded structural path
    // and the independent class conjunction to resolve to the same unique live element.
    match = { tag: last.tag, id: null, classes: identity.classes.slice(0, 2), path: parsed.value };
  }
  return {
    selector: { syntax: parsed.syntax, value: parsed.value, byteLength: parsed.byteLength, complexity: parsed.complexity },
    match,
  };
}

function resolveCandidate(rows, evidenceById) {
  const artifacts = new Map();
  for (const { occurrence } of rows) {
    for (const id of occurrence.evidenceRefs) {
      const evidence = evidenceById.get(id);
      if (evidence?.kind === 'element' && evidence.pageId === occurrence.pageId && evidence.nodeId === occurrence.nodeId) {
        artifacts.set(id, evidence);
      }
    }
  }
  if (artifacts.size === 0) return { reason: 'missing-evidence' };
  let locator = null;
  for (const evidence of artifacts.values()) {
    const next = locatorFor(evidence);
    if (next.reason) return next;
    if (locator && JSON.stringify(locator) !== JSON.stringify(next)) return { reason: 'conflicting-evidence' };
    locator = next;
  }
  return { ...locator, evidenceRefs: [...artifacts.keys()].sort() };
}

/**
 * Pure post-audit presentation projection. Only `public` is suitable for UI.
 * `private` must remain in the worker; it is not capture/evidence authorization.
 * W2 must freshly prove the original document and corroborate each locator there.
 */
export function projectPageMarkers(raw) {
  try {
    const args = exactData(raw, ['snapshot', 'pageId']);
    const snapshot = args && exactData(args.snapshot, ['model', 'modelRevision', 'modelHash']);
    if (!snapshot || !isAuditIntegrityVerified(snapshot.model) ||
      !Number.isSafeInteger(snapshot.modelRevision) || snapshot.modelRevision < 1 ||
      snapshot.modelHash !== snapshot.model.integrity.canonicalModelHash ||
      typeof args.pageId !== 'string' || !snapshot.model.pages.some(page => page.pageId === args.pageId)) deny();
    const model = snapshot.model;
    if (model.occurrences.length > MAX_ROWS || model.evidence.length > MAX_ROWS ||
      model.occurrences.reduce((count, row) => count + row.evidenceRefs.length, 0) > MAX_REFS) deny();
    const occurrences = model.occurrences.filter(row => row.pageId === args.pageId)
      .sort((a, b) => a.occurrenceId.localeCompare(b.occurrenceId));
    const evidenceById = new Map(model.evidence.map(row => [row.evidenceId, row]));
    const decisions = new Map(model.reviewDecisions.map(row => [row.occurrenceId, row]));
    const signals = [];
    const groups = new Map();
    const general = [];
    const unlocated = [];
    for (const occurrence of occurrences) {
      const signal = {
        selectionId: `s${signals.length + 1}`, occurrenceId: occurrence.occurrenceId,
        pageId: occurrence.pageId,
        checkKey: JSON.stringify([occurrence.pageId, occurrence.source.engine, occurrence.source.ruleId]),
        abntItem: occurrence.nbrItemRef,
        ...classificationFor(occurrence, decisions.get(occurrence.occurrenceId)),
        impact: occurrence.impact,
      };
      signals.push(signal);
      let context;
      try {
        context = deriveResultContextV1({ occurrences: [occurrence], evidenceById });
      } catch (error) {
        if (!(error instanceof TypeError) || error.message !== 'RESULT_CONTEXT_DENIED') throw error;
        unlocated.push({ selectionId: signal.selectionId, classification: signal.classification,
          reason: 'conflicting-evidence' });
        continue;
      }
      if (signal.classification === null) {
        unlocated.push({ selectionId: signal.selectionId, classification: null, reason: 'not-displayed' });
      } else if (context === 'page-or-process' || occurrence.presentationTargetKey === 'document') {
        general.push({ selectionId: signal.selectionId, classification: signal.classification });
      } else if (context !== 'top-document') {
        unlocated.push({ selectionId: signal.selectionId, classification: signal.classification, reason: 'unsupported-context' });
      } else if (occurrence.nodeId === null) {
        unlocated.push({ selectionId: signal.selectionId, classification: signal.classification, reason: 'missing-evidence' });
      } else {
        const key = JSON.stringify([occurrence.pageId, occurrence.nodeId]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ occurrence, signal });
      }
    }
    const candidates = [];
    const markers = [];
    for (const rows of groups.values()) {
      const resolved = resolveCandidate(rows, evidenceById);
      const selectionIds = rows.map(row => row.signal.selectionId);
      if (resolved.reason) {
        for (const { signal } of rows) unlocated.push({ selectionId: signal.selectionId,
          classification: signal.classification, reason: resolved.reason });
        continue;
      }
      const markerId = `m${markers.length + 1}`;
      candidates.push({ markerId, pageId: args.pageId, nodeId: rows[0].occurrence.nodeId,
        selector: resolved.selector, match: resolved.match, evidenceRefs: resolved.evidenceRefs, selectionIds });
      const classification = rows.map(row => row.signal.classification)
        .reduce((best, value) => PRIORITY[value] > PRIORITY[best] ? value : best, 'passed');
      markers.push({ markerId, number: markers.length + 1, count: selectionIds.length, classification, selectionIds });
    }
    return freeze({
      public: {
        version: 1, markers, general, unlocated,
        counts: { totalOccurrences: occurrences.length, locatedOccurrences: markers.reduce((n, marker) => n + marker.count, 0),
          generalOccurrences: general.length, unlocatedOccurrences: unlocated.length },
        limits: { maxOccurrences: MAX_ROWS, maxEvidence: MAX_ROWS, maxEvidenceRefs: MAX_REFS },
      },
      private: { kind: 'PageMarkerPrivateProjectionV1', auditId: model.auditId, pageId: args.pageId,
        modelRevision: snapshot.modelRevision, modelHash: snapshot.modelHash, candidates, signals },
    });
  } catch { deny(); }
}
