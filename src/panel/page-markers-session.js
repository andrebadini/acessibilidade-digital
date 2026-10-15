// Once a current-page audit finishes, the source page has no live extension surface, so
// repeating the audit cannot create one. The notice therefore stops promising a retry it
// cannot deliver and points at what still works: the recorded evidence in the report.
const UNAVAILABLE = 'Não foi possível mostrar os sinais nesta página. Esta página não tem mais um canal ativo da extensão, então repetir a auditoria não resolve; consulte as evidências e as capturas no relatório.';
const REMOVE_FAILED = 'Não foi possível confirmar a remoção dos sinais. Tente remover novamente.';
// Picking an occurrence whose element has no signal on the page right now (not found, inside an
// iframe, or no longer in the page) is an expected answer, not a failure of the signals.
const SELECTION_UNAVAILABLE = 'Esta ocorrência não tem sinal na página neste momento. Consulte a evidência registrada ou o relatório.';
// A página recarregou depois da auditoria: o endereço confere e o trabalho registrado continua
// valendo, então o painel convida a recolocar os sinais na versão de agora, por gesto explícito.
const RELOAD_OFFER = 'A página foi recarregada depois da auditoria. Mostrar os sinais na versão atual?';
// Depois de aceitar, o que está na tela são sinais reencontrados, não os sinais originais: o aviso
// acompanha o estado enquanto eles estiverem visíveis.
const RELOADED_NOTE = 'Sinais reencontrados na versão recarregada — confira se correspondem ao que foi auditado.';
// Endereço diferente: repetir a projeção seria mostrar sinais de outra página, então a saída honesta
// é refazer a auditoria.
const CHANGED_ADDRESS = 'O endereço da página mudou depois da auditoria. Para ver os sinais na página de agora, refaça a auditoria.';
// Matches the ceiling the worker, the controller, the projection and the page overlay share, so a
// full inventory of 500 findings is never truncated by the panel.
export const MAX_PAGE_MARKER_SIGNALS = 500;
const empty = () => ({ status: 'idle', groups: [], counts: null, selectedOccurrenceId: null, reasons: [], message: null, relocated: false });
// O painel não desenha nada nesses estados: não há sinais na página para remover.
const NOTHING_DRAWN = ['idle', 'unavailable', 'reload-offer', 'changed-address'];
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
    const ids = bundle.details.slice(0, MAX_PAGE_MARKER_SIGNALS).map(detail => detail.occurrenceId);
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
        ['state', 'modelRevision', 'groups', 'counts', 'selectedOrdinal', 'reasons']);
      const counts = markers && exact(markers.counts, ['markers', 'located', 'general', 'unlocated', 'omitted']);
      if (!counts || markers.modelRevision !== captured.revision || !['active', 'clear'].includes(markers.state) ||
        !Array.isArray(markers.groups) || markers.groups.length > MAX_PAGE_MARKER_SIGNALS ||
        !Array.isArray(markers.reasons) || markers.reasons.length > 32 ||
        Object.values(counts).some(value => !Number.isSafeInteger(value) || value < 0 || value > 25_000)) return null;
      if (markers.state === 'clear') return markers.groups.length === 0 && markers.selectedOrdinal === null &&
        Object.values(counts).every(value => value === 0) ? empty() : null;
      const seen = new Set(), numbers = new Set(), groups = [];
      for (const rawGroup of markers.groups) {
        const group = exact(rawGroup, ['number', 'ordinals']);
        if (!group || !Number.isSafeInteger(group.number) || group.number < 1 || group.number > 5000 ||
          numbers.has(group.number) || !Array.isArray(group.ordinals) || group.ordinals.length < 1 ||
          group.ordinals.length > MAX_PAGE_MARKER_SIGNALS) return null;
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
      // Reasons are counts of signals the page could not show, grouped by category. They carry no
      // element identity, so they survive the strict copy into presentation state.
      const reasons = [];
      for (const raw of markers.reasons) {
        const row = exact(raw, ['reason', 'count']);
        if (!row || typeof row.reason !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/u.test(row.reason) ||
          !Number.isSafeInteger(row.count) || row.count < 1 || row.count > MAX_PAGE_MARKER_SIGNALS) return null;
        reasons.push({ reason: row.reason, count: row.count });
      }
      return { status: 'active', groups, counts, reasons, relocated: false,
        selectedOccurrenceId: markers.selectedOrdinal === null ? null : captured.ids[markers.selectedOrdinal], message: null };
    } catch { return null; }
  }
  async function request(type, extras, captured) {
    try { return await requestIntent({ type, modelRevision: captured.revision, ...extras }); }
    catch { return null; }
  }
  // `reloaded` é o modo aceito pelo gesto explícito: o mesmo pedido, com o aviso de que a página foi
  // recarregada. Sem ele, o worker nunca recoloca sinais em um documento novo.
  async function show(reloaded = false) {
    if (typeof reloaded !== 'boolean') return false;
    if (!context || ['active', 'showing', 'hiding'].includes(state.status)) return false;
    const captured = context, version = ++generation, selected = selectionVersion;
    publish({ ...empty(), status: 'showing', message: 'Preparando sinais na página…' });
    const response = await request(reloaded ? 'PANEL_SHOW_PAGE_MARKERS_RELOADED' : 'PANEL_SHOW_PAGE_MARKERS', {}, captured);
    if (context !== captured || version !== generation) return false;
    const next = responseState(response, captured);
    if (!next || next.status !== 'active') {
      const code = exact(response, ['ok', 'code'])?.code;
      if (code === 'PAGE_MARKERS_RELOADED_PAGE') {
        publish({ ...empty(), status: 'reload-offer', message: RELOAD_OFFER }); return false;
      }
      if (code === 'PAGE_MARKERS_DOCUMENT_CHANGED') {
        publish({ ...empty(), status: 'changed-address', message: CHANGED_ADDRESS }); return false;
      }
      publish({ ...empty(), status: 'unavailable', message: UNAVAILABLE }); return false;
    }
    if (reloaded) next.relocated = true;
    if (selected !== selectionVersion) next.selectedOccurrenceId = state.selectedOccurrenceId;
    publish(next); return true;
  }
  const showReloaded = () => show(true);
  async function hide() {
    if (!context || NOTHING_DRAWN.includes(state.status)) return true;
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
        const code = exact(response, ['ok', 'code'])?.code;
        if (selectionRequest && (code === 'PAGE_MARKERS_SELECTION_UNAVAILABLE' || code === 'PAGE_MARKERS_INVALID')) {
          publish({ ...state, selectedOccurrenceId: null, message: SELECTION_UNAVAILABLE });
          return false;
        }
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
  async function highlight(occurrenceId) {
    if (ordinal(occurrenceId) < 0 || ['showing', 'hiding'].includes(state.status)) return false;
    const captured = context;
    // O convite já estava na tela (região viva) quando a pessoa clicou em "Destacar elemento na
    // página": o clique aceita a versão recarregada, do mesmo jeito que o botão do convite.
    if (state.status !== 'active' && !await show(state.status === 'reload-offer')) return false;
    if (context !== captured || state.status !== 'active') return false;
    if (!state.groups.some(group => group.occurrenceIds.includes(occurrenceId))) {
      publish({ ...state, message: 'O elemento não foi localizado com segurança nesta página. Consulte a captura registrada ou refaça a auditoria.' });
      return false;
    }
    return select(occurrenceId, true);
  }
  function filter(visibleOccurrenceIds) {
    if (!context || !Array.isArray(visibleOccurrenceIds)) return Promise.resolve(false);
    const visible = new Set(visibleOccurrenceIds);
    return mutate('PANEL_FILTER_PAGE_MARKERS', {
      visibleOrdinals: context.ids.flatMap((id, index) => visible.has(id) ? [index] : []).join(','),
    });
  }
  return Object.freeze({
    setResult, receive, show, showReloaded, hide, select, highlight, filter, reset, read: () => state,
  });
}
