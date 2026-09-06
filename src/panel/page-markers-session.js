const UNAVAILABLE = 'Não foi possível mostrar os sinais nesta página. Refaça a auditoria da página atual ou consulte as evidências do relatório.';
const REMOVE_FAILED = 'Não foi possível confirmar a remoção dos sinais. Tente remover novamente.';
const empty = () => ({ status: 'idle', groups: [], counts: null, selectedOccurrenceId: null, message: null });
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    if (Reflect.ownKeys(value).length !== keys.length) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

// This is presentation state only. The admitted Port owns authorization and the
// background controller owns document proof; neither is reconstructed here.
export function createPanelPageMarkersSession({ requestIntent, onChange, onSelection }) {
  let context = null, generation = 0, selectionVersion = 0;
  let requestedSelection = null;
  let state = freeze(empty()), queue = Promise.resolve();
  const pendingByType = new Map();
  function publish(next) {
    state = freeze(next);
    try { onChange(state); } catch { /* rendering cannot change authority */ }
  }
  function reset() {
    generation++; selectionVersion++; context = null; pendingByType.clear();
    requestedSelection = null; queue = Promise.resolve();
    publish(empty());
  }
  function setResult(bundle) {
    if (!bundle) { reset(); return; }
    const ids = bundle.details.slice(0, 64).map(detail => detail.occurrenceId);
    if (context?.auditId === bundle.auditId && context.revision === bundle.modelRevision &&
      JSON.stringify(context.ids) === JSON.stringify(ids)) return;
    reset();
    context = { auditId: bundle.auditId, revision: bundle.modelRevision, ids };
  }
  const ordinal = id => context ? context.ids.indexOf(id) : -1;
  function responseState(raw, captured) {
    try {
      const response = exact(raw, ['ok', 'markers']);
      const markers = response?.ok === true && exact(response.markers,
        ['state', 'modelRevision', 'groups', 'counts', 'selectedOrdinal']);
      const counts = markers && exact(markers.counts, ['markers', 'located', 'general', 'unlocated', 'omitted']);
      if (!counts || markers.modelRevision !== captured.revision || !['active', 'clear'].includes(markers.state) ||
        !Array.isArray(markers.groups) || markers.groups.length > 64 ||
        Object.values(counts).some(value => !Number.isSafeInteger(value) || value < 0 || value > 25_000)) return null;
      if (markers.state === 'clear') return markers.groups.length === 0 && markers.selectedOrdinal === null &&
        Object.values(counts).every(value => value === 0) ? empty() : null;
      const seen = new Set(), numbers = new Set(), groups = [];
      for (const rawGroup of markers.groups) {
        const group = exact(rawGroup, ['number', 'ordinals']);
        if (!group || !Number.isSafeInteger(group.number) || group.number < 1 || group.number > 5000 ||
          numbers.has(group.number) || !Array.isArray(group.ordinals) || group.ordinals.length < 1 || group.ordinals.length > 64) return null;
        numbers.add(group.number);
        const occurrenceIds = [];
        for (const value of group.ordinals) {
          if (!Number.isSafeInteger(value) || value < 0 || value >= captured.ids.length || seen.has(value)) return null;
          seen.add(value); occurrenceIds.push(captured.ids[value]);
        }
        groups.push({ number: group.number, occurrenceIds });
      }
      if (counts.markers !== groups.length || counts.located !== seen.size ||
        counts.located + counts.general + counts.unlocated !== captured.ids.length ||
        markers.selectedOrdinal !== null && !seen.has(markers.selectedOrdinal)) return null;
      return { status: 'active', groups, counts,
        selectedOccurrenceId: markers.selectedOrdinal === null ? null : captured.ids[markers.selectedOrdinal], message: null };
    } catch { return null; }
  }
  async function request(type, extras, captured) {
    try { return await requestIntent({ type, modelRevision: captured.revision, ...extras }); }
    catch { return null; }
  }
  async function show() {
    if (!context || ['active', 'showing', 'hiding'].includes(state.status)) return false;
    const captured = context, version = ++generation, selected = selectionVersion;
    publish({ ...empty(), status: 'showing', message: 'Preparando sinais na página…' });
    const response = await request('PANEL_SHOW_PAGE_MARKERS', {}, captured);
    if (context !== captured || version !== generation) return false;
    const next = responseState(response, captured);
    if (!next || next.status !== 'active') {
      publish({ ...empty(), status: 'unavailable', message: UNAVAILABLE }); return false;
    }
    if (selected !== selectionVersion) next.selectedOccurrenceId = state.selectedOccurrenceId;
    publish(next); return true;
  }
  async function hide() {
    if (!context || ['idle', 'unavailable'].includes(state.status)) return true;
    if (state.status === 'hiding') return false;
    const captured = context, before = state, version = ++generation;
    publish({ ...state, status: 'hiding', message: 'Removendo sinais da página…' });
    const response = await request('PANEL_HIDE_PAGE_MARKERS', {}, captured);
    if (context !== captured) return false;
    if (version !== generation) return state.status === 'idle';
    const next = responseState(response, captured);
    if (next?.status === 'idle') { selectionVersion++; publish(next); return true; }
    publish({ ...before, status: 'active', message: REMOVE_FAILED }); return false;
  }
  function receive(raw) {
    const packet = exact(raw, ['modelRevision', 'state', 'selectedOrdinal']);
    if (!context || packet?.modelRevision !== context.revision || !['clear', 'active'].includes(packet.state) ||
      packet.selectedOrdinal !== null && (!Number.isSafeInteger(packet.selectedOrdinal) ||
        packet.selectedOrdinal < 0 || packet.selectedOrdinal >= context.ids.length)) return;
    if (packet.state === 'clear') {
      if (packet.selectedOrdinal !== null) return;
      generation++; selectionVersion++; publish(empty()); return;
    }
    if (!['showing', 'active'].includes(state.status)) return;
    const selectedOccurrenceId = packet.selectedOrdinal === null ? null : context.ids[packet.selectedOrdinal];
    selectionVersion++;
    const changed = state.selectedOccurrenceId !== selectedOccurrenceId;
    publish({ ...state, selectedOccurrenceId });
    if (changed && selectedOccurrenceId !== null && requestedSelection?.occurrenceId !== selectedOccurrenceId) {
      try { onSelection(selectedOccurrenceId); } catch { /* selection only changes presentation */ }
    }
  }
  function mutate(type, extras) {
    if (!context || !['active', 'showing'].includes(state.status)) return Promise.resolve(false);
    const captured = context, version = generation, token = {};
    pendingByType.set(type, token);
    const operation = queue.then(async () => {
      if (context !== captured || generation !== version || pendingByType.get(type) !== token || state.status !== 'active') return false;
      pendingByType.delete(type);
      const selected = selectionVersion;
      const selectionRequest = type === 'PANEL_SELECT_PAGE_MARKER' ? { occurrenceId: captured.ids[extras.ordinal] } : null;
      if (selectionRequest) requestedSelection = selectionRequest;
      const response = await request(type, extras, captured);
      if (selectionRequest && requestedSelection === selectionRequest) requestedSelection = null;
      if (context !== captured || generation !== version) return false;
      const next = responseState(response, captured);
      if (!next) {
        publish({ ...state, message: 'Não foi possível atualizar este sinal. Consulte a evidência ou tente novamente.' });
        return false;
      }
      if (next.status === 'idle') { generation++; selectionVersion++; publish(next); return true; }
      // Filters and selection never replace the inventory delivered by SHOW.
      publish({ ...state, selectedOccurrenceId: selected === selectionVersion ? next.selectedOccurrenceId : state.selectedOccurrenceId,
        message: null });
      return true;
    });
    queue = operation.catch(() => false);
    return operation;
  }
  function select(occurrenceId, scroll = false) {
    const value = ordinal(occurrenceId);
    if (value < 0 || typeof scroll !== 'boolean') return Promise.resolve(false);
    return mutate('PANEL_SELECT_PAGE_MARKER', { ordinal: value, scroll });
  }
  function filter(visibleOccurrenceIds) {
    if (!context || !Array.isArray(visibleOccurrenceIds)) return Promise.resolve(false);
    const visible = new Set(visibleOccurrenceIds);
    return mutate('PANEL_FILTER_PAGE_MARKERS', {
      visibleOrdinals: context.ids.flatMap((id, index) => visible.has(id) ? [index] : []).join(','),
    });
  }
  return Object.freeze({ setResult, receive, show, hide, select, filter, reset, read: () => state });
}
