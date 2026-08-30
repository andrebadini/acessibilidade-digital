import { PANEL_UNPREPARED_MESSAGE } from './panel-status.js';

const PANEL_AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const PANEL_FILTERS = Object.freeze(['impact', 'wcag', 'abnt']);
const PANEL_UNAVAILABLE_REASONS = new Set([
  PANEL_UNPREPARED_MESSAGE,
  'O resultado local não pôde ser exibido com segurança.',
  'Não foi possível concluir a operação local.',
]);

export function createInitialPanelState() {
  return deepFreezePanelState({
    version: 1,
    screen: 'initial',
    auditId: null,
    filters: { impact: [], wcag: [], abnt: [] },
    selectedOccurrenceId: null,
    evidenceExpanded: false,
    focusId: 'start-attached',
    scrollTop: 0,
    reason: null,
  });
}

export function reducePanelState(current, event) {
  if (!panelState(current)) return current;
  current = immutablePanelState(current);
  if (!event || typeof event !== 'object' || Array.isArray(event)) return current;
  switch (event.type) {
    case 'BOOTSTRAP_INITIAL':
      return createInitialPanelState();
    case 'START_REQUESTED':
      return nextPanelState(current, {
        screen: 'running', auditId: null, selectedOccurrenceId: null,
        evidenceExpanded: false, focusId: 'cancel-audit', scrollTop: 0, reason: null,
      });
    case 'AUDIT_RUNNING':
      if (!validPanelAuditId(event.auditId)) return current;
      return nextPanelState(current, {
        screen: 'running', auditId: event.auditId, selectedOccurrenceId: null,
        evidenceExpanded: false, focusId: 'cancel-audit', reason: null,
      });
    case 'AUDIT_RESULT': {
      if (!validPanelAuditId(event.auditId) || event.result?.auditId !== event.auditId) {
        return unavailablePanelState(current, validPanelAuditId(event.auditId) ? event.auditId : current.auditId,
          'O resultado local não pôde ser exibido com segurança.');
      }
      const occurrenceIds = resultOccurrenceIds(event.result);
      if (!occurrenceIds) {
        return unavailablePanelState(current, event.auditId,
          'O resultado local não pôde ser exibido com segurança.');
      }
      const selected = occurrenceIds.includes(current.selectedOccurrenceId)
        ? current.selectedOccurrenceId
        : (occurrenceIds[0] ?? null);
      return nextPanelState(current, {
        screen: 'result', auditId: event.auditId, selectedOccurrenceId: selected,
        evidenceExpanded: false, focusId: 'result-summary',
        reason: null,
      });
    }
    case 'AUDIT_UNAVAILABLE': {
      const auditId = validPanelAuditId(event.auditId) ? event.auditId : current.auditId;
      const reason = PANEL_UNAVAILABLE_REASONS.has(event.reason)
        ? event.reason
        : 'Não foi possível concluir a operação local.';
      return unavailablePanelState(current, auditId, reason);
    }
    case 'FILTER_SET': {
      if (current.screen !== 'result' || !PANEL_FILTERS.includes(event.filter)) return current;
      const values = panelFilterValues(event.values);
      if (!values) return current;
      return nextPanelState(current, {
        filters: { ...current.filters, [event.filter]: values },
        focusId: panelFocusId(event.focusId, current.focusId),
        scrollTop: panelScrollTop(event.scrollTop, current.scrollTop),
      });
    }
    case 'OCCURRENCE_SELECTED':
      if (current.screen !== 'result' || !validPanelOccurrenceId(event.occurrenceId)) return current;
      return nextPanelState(current, {
        selectedOccurrenceId: event.occurrenceId,
        evidenceExpanded: false,
        focusId: panelFocusId(event.focusId, `occurrence-${event.occurrenceId}`),
        scrollTop: panelScrollTop(event.scrollTop, current.scrollTop),
      });
    case 'EVIDENCE_TOGGLED':
      if (current.screen !== 'result' || typeof event.expanded !== 'boolean') return current;
      return nextPanelState(current, {
        evidenceExpanded: event.expanded,
        focusId: panelFocusId(event.focusId, 'evidence-summary'),
        scrollTop: panelScrollTop(event.scrollTop, current.scrollTop),
      });
    case 'RETRY_REQUESTED':
      if (current.screen !== 'unavailable') return current;
      return nextPanelState(current, { focusId: 'retry' });
    case 'PORT_INTERRUPTED':
      return unavailablePanelState(current, current.auditId, PANEL_UNPREPARED_MESSAGE);
    default:
      return current;
  }
}

function panelState(value) {
  return Boolean(value) && value.version === 1 &&
    ['initial', 'running', 'result', 'unavailable'].includes(value.screen) &&
    value.filters && PANEL_FILTERS.every(filter => Array.isArray(value.filters[filter]));
}

function immutablePanelState(value) {
  if (Object.isFrozen(value) && Object.isFrozen(value.filters) &&
    PANEL_FILTERS.every(filter => Object.isFrozen(value.filters[filter]))) return value;
  return deepFreezePanelState({
    version: value.version,
    screen: value.screen,
    auditId: value.auditId,
    filters: Object.fromEntries(PANEL_FILTERS.map(filter => [filter, [...value.filters[filter]]])),
    selectedOccurrenceId: value.selectedOccurrenceId,
    evidenceExpanded: value.evidenceExpanded,
    focusId: value.focusId,
    scrollTop: value.scrollTop,
    reason: value.reason,
  });
}

function nextPanelState(current, patch) {
  return deepFreezePanelState({ ...current, ...patch });
}

function unavailablePanelState(current, auditId, reason) {
  return nextPanelState(current, {
    screen: 'unavailable',
    auditId: validPanelAuditId(auditId) ? auditId : null,
    filters: { impact: [], wcag: [], abnt: [] },
    selectedOccurrenceId: null,
    evidenceExpanded: false,
    focusId: 'retry',
    scrollTop: 0,
    reason,
  });
}

function resultOccurrenceIds(result) {
  try {
    if (!result || result.summary?.auditId !== result.auditId || !Array.isArray(result.details)) return null;
    const groups = result.summary?.groups;
    if (!groups || !['failed', 'alerts', 'humanReview', 'passed'].every(name => Array.isArray(groups[name]))) return null;
    const occurrenceIds = [];
    for (const name of ['failed', 'alerts', 'humanReview', 'passed']) {
      for (const card of groups[name]) {
        if (!Array.isArray(card.occurrenceIds)) return null;
        for (const occurrenceId of card.occurrenceIds) {
          if (!validPanelOccurrenceId(occurrenceId) || occurrenceIds.includes(occurrenceId)) return null;
          occurrenceIds.push(occurrenceId);
        }
      }
    }
    if (result.details.length !== occurrenceIds.length) return null;
    const detailIds = result.details.map(detail => detail?.occurrenceId);
    if (detailIds.some(id => !validPanelOccurrenceId(id)) || new Set(detailIds).size !== detailIds.length) return null;
    if (occurrenceIds.some(id => detailIds.filter(detailId => detailId === id).length !== 1)) return null;
    return occurrenceIds;
  } catch { return null; }
}

function panelFilterValues(values) {
  if (!Array.isArray(values) || values.length > 100) return null;
  const copy = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 200 || copy.includes(value)) return null;
    copy.push(value);
  }
  return copy;
}

function validPanelAuditId(value) { return typeof value === 'string' && PANEL_AUDIT_ID.test(value); }
function validPanelOccurrenceId(value) { return typeof value === 'string' && value.length >= 1 && value.length <= 200; }
function panelFocusId(value, fallback) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,240}$/u.test(value) ? value : fallback;
}
function panelScrollTop(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function deepFreezePanelState(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreezePanelState(child, seen);
  return Object.freeze(value);
}
