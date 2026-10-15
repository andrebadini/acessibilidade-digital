/**
 * Mapa do teclado: paradas de Tab e suspeitos do documento principal.
 *
 * O cálculo é determinístico e sai inteiro do instantâneo da auditoria — nenhuma ida extra ao
 * navegador, nenhuma tecla pressionada e nenhum valor digitado lido. A ordem vem do que está
 * declarado na página (tabindex positivo primeiro, depois a ordem do documento), e é por isso que o
 * resultado se declara *estimado*: quem aperta Tab de verdade é a pessoa, e a leitura guiada pede
 * que ela confira a lista contra o que vê.
 *
 * As mesmas regras de privacidade do mapa de anúncios valem aqui (`privacy-taint`): um nó que guarda
 * valor digitado, ou que depende de um nó assim, entra na lista — porque a parada de Tab existe e
 * omiti-la mentiria sobre a ordem — mas sem nenhum texto projetado.
 */
import { isEditableAccessibilityNode, projectElementAccessibility } from '../accessibility/element-accessibility.js';
import { ancestorState, privacyTaintedNodeIds, privateMarker } from '../evidence/privacy-taint.js';
import { usefulRect, visibleRect } from '../evidence/visible-geometry.js';
import { buildSnapshotIndexes } from '../snapshot-schema.js';

/** Teto de paradas e de suspeitos desenhados e listados: o resto vira contagem declarada. */
export const KEYBOARD_MAP_STOP_LIMIT = 400;
export const KEYBOARD_MAP_SUSPECT_LIMIT = 60;

export const KEYBOARD_MAP_STOP_KINDS = Object.freeze([
  'link', 'button', 'field', 'summary', 'media', 'frame', 'contenteditable', 'tabindex',
]);

export const KEYBOARD_MAP_SUSPECT_REASONS = Object.freeze(['keyboard-rule', 'interactive-role', 'cursor-pointer']);

/**
 * Regras cujos alvos são candidatos a "parece clicável, mas o Tab não chega".
 *
 * A lista é fechada e tolerante: um identificador que ainda não existe no produto simplesmente
 * nunca casa com nenhuma ocorrência. `hover-only-interactive-content` é a regra do conteúdo que só
 * aparece com o mouse; as três seguintes são as de conteúdo adicional por hover/foco; a última
 * aponta componentes customizados que podem não entrar na ordem de Tab.
 */
export const KEYBOARD_SUSPECT_RULE_IDS = Object.freeze([
  'hover-only-interactive-content',
  'hover-focus-additional-content',
  'hover-focus-content-persistent',
  'hover-focus-content-dismissible',
  'focusable-elements-interactive',
]);

export const KEYBOARD_MAP_LIMITATIONS = Object.freeze([
  // Obrigatórias: valem para todo mapa, sempre.
  'tab-order-estimated-not-observed',
  'top-document-open-shadow-only',
  'closed-shadow-root-omitted',
  'frame-content-omitted',
  // Só entram quando acontecem.
  'non-uniform-pixel-scale',
  'stops-outside-source-clamped',
  'ancestor-clipped-stops-omitted',
  'cursor-style-not-collected',
  'privacy-content-omitted',
  'stop-limit-reached',
  'suspect-limit-reached',
  'badge-overlap-unresolved',
]);

export const KEYBOARD_MAP_REQUIRED_LIMITATIONS = Object.freeze([
  'tab-order-estimated-not-observed',
  'top-document-open-shadow-only',
]);

const BUTTON_INPUT_TYPES = new Set(['button', 'image', 'reset', 'submit']);
const DISABLEABLE_TAGS = new Set(['button', 'input', 'select', 'textarea']);
const MEDIA_TAGS = new Set(['audio', 'video']);
const NATIVE_INTERACTIVE_TAGS = new Set(['a', 'area', 'button', 'input', 'select', 'textarea', 'summary', 'label', 'option', 'audio', 'video', 'iframe']);
/** Papéis que só se alcançam com Tab: sem parada, o item fica inalcançável pelo teclado. */
const INTERACTIVE_ROLES = new Set(['button', 'checkbox', 'combobox', 'link', 'listbox', 'searchbox', 'slider', 'spinbutton', 'switch', 'textbox']);
/**
 * Papéis que se alcançam sem Tab, dentro do próprio componente (setas, roving tabindex). Marcá-los
 * como suspeitos acusaria de falha o que é o padrão correto do componente.
 */
const COMPOSITE_REACHABLE_ROLES = new Set(['gridcell', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'row', 'tab', 'treeitem']);
const EDITING_VALUES = new Set(['', 'true', 'plaintext-only']);
const EDITABLE_CONTROL_TAGS = new Set(['input', 'select', 'textarea']);

function normalizedText(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function tagOf(node) {
  const value = typeof node?.tagName === 'string' ? node.tagName.replace(/\s+/gu, ' ').trim().toLowerCase() : '';
  return /^[a-z][a-z0-9-]{0,63}$/u.test(value) ? value : '';
}

function attributeOf(node, name) {
  const value = node?.attributes?.[name];
  if (typeof value === 'string') return value;
  return value === true ? '' : null;
}

function hasAttribute(node, name) {
  return Object.hasOwn(node?.attributes || {}, name);
}

function integerAttribute(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^([+-]?\d+)$/u);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function styleValue(node, name) {
  const styles = node?.styles;
  if (!styles || typeof styles !== 'object') return '';
  const camel = name.replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
  const value = styles[name] ?? styles[camel];
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().toLowerCase() : '';
}

function childNodes(node, indexes) {
  return (Array.isArray(node?.children) ? node.children : [])
    .map(id => indexes.byNodeId.get(String(id)))
    .filter(Boolean);
}

/** O primeiro `summary` do `details` é o controle de abertura; os demais não são paradas de Tab. */
function isFirstSummaryOfDetails(node, indexes) {
  if (tagOf(node) !== 'summary') return false;
  const parent = node.parentId === null || node.parentId === undefined
    ? null
    : indexes.byNodeId.get(String(node.parentId));
  if (tagOf(parent) !== 'details') return false;
  const first = childNodes(parent, indexes).find(child => tagOf(child) === 'summary');
  return Boolean(first) && String(first.nodeId) === String(node.nodeId);
}

function declaresEditing(node) {
  const value = attributeOf(node, 'contenteditable');
  return value !== null && EDITING_VALUES.has(value.replace(/\s+/gu, ' ').trim().toLowerCase());
}

/**
 * Hospedeiro de edição: declara `contenteditable` e não tem ancestral editável. Um descendente de
 * área editável não é parada própria — quem recebe o foco é o hospedeiro.
 */
function isEditingHost(node, indexes) {
  if (!declaresEditing(node) || hasAttribute(node, 'tabindex')) return false;
  let current = node.parentId === null || node.parentId === undefined
    ? null
    : indexes.byNodeId.get(String(node.parentId));
  const visited = new Set();
  while (current && !visited.has(String(current.nodeId))) {
    visited.add(String(current.nodeId));
    if (declaresEditing(current)) return false;
    current = current.parentId === null || current.parentId === undefined
      ? null
      : indexes.byNodeId.get(String(current.parentId));
  }
  return true;
}

function isDisabledControl(node, indexes) {
  const tag = tagOf(node);
  if (!DISABLEABLE_TAGS.has(tag)) return false;
  if (node?.disabled === true || hasAttribute(node, 'disabled')) return true;
  // `fieldset[disabled]` desabilita os controles de dentro, menos os do primeiro `legend`.
  return ancestorState(node, indexes, ancestor => tagOf(ancestor) === 'fieldset' &&
    (ancestor?.disabled === true || hasAttribute(ancestor, 'disabled')));
}

function isHiddenInput(node) {
  return tagOf(node) === 'input' && (attributeOf(node, 'type') || '').replace(/\s+/gu, ' ').trim().toLowerCase() === 'hidden';
}

/**
 * Motivo pelo qual o nó não aparece no documento. O instantâneo já propaga parte disso, mas não
 * tudo (o modo simplificado não propaga ancestral nenhum), então a subida é feita aqui.
 */
function invisibleReason(node, indexes) {
  let current = node;
  let insideSummary = false;
  const visited = new Set();
  while (current && !visited.has(String(current.nodeId))) {
    visited.add(String(current.nodeId));
    if (current.hidden === true || current.hasRenderedBox === false) return 'not-rendered';
    if (hasAttribute(current, 'hidden')) return 'not-rendered';
    if (hasAttribute(current, 'inert') || current.inert === true) return 'inert';
    if ((attributeOf(current, 'aria-hidden') || '').replace(/\s+/gu, ' ').trim().toLowerCase() === 'true') return 'aria-hidden';
    if (tagOf(current) === 'details' && !hasAttribute(current, 'open') && current.open !== true) {
      const summary = childNodes(current, indexes).find(child => tagOf(child) === 'summary');
      if (!summary || !insideSummary) return 'collapsed-details';
    }
    if (tagOf(current) === 'summary') insideSummary = true;
    if (current === node && tagOf(current) === 'input' && isHiddenInput(current)) return 'not-rendered';
    current = current.parentId === null || current.parentId === undefined
      ? null
      : indexes.byNodeId.get(String(current.parentId));
  }
  return null;
}

/** Tipo de parada nativa do elemento, ou `null` quando ele não é focável por natureza. */
function nativeStopKind(node, indexes) {
  const tag = tagOf(node);
  const disabled = isDisabledControl(node, indexes);
  if (isEditingHost(node, indexes)) return 'contenteditable';
  if (['a', 'area'].includes(tag) && hasAttribute(node, 'href')) return 'link';
  if (tag === 'button') return disabled ? null : 'button';
  if (tag === 'input') {
    if (isHiddenInput(node) || disabled) return null;
    const type = (attributeOf(node, 'type') || '').replace(/\s+/gu, ' ').trim().toLowerCase() || 'text';
    return BUTTON_INPUT_TYPES.has(type) ? 'button' : 'field';
  }
  if (['select', 'textarea'].includes(tag)) return disabled ? null : 'field';
  if (isFirstSummaryOfDetails(node, indexes)) return 'summary';
  if (MEDIA_TAGS.has(tag) && hasAttribute(node, 'controls') && !disabled) return 'media';
  if (tag === 'iframe') return 'frame';
  return null;
}

function declaredTabIndex(node) {
  return hasAttribute(node, 'tabindex') ? integerAttribute(attributeOf(node, 'tabindex')) : null;
}

function observedRole(node) {
  const explicit = typeof node?.axRole === 'string' && node.axRole.trim() !== ''
    ? node.axRole
    : typeof node.attributes?.role === 'string' ? node.attributes.role : '';
  const value = explicit.replace(/\s+/gu, ' ').trim().toLowerCase().split(' ')[0];
  if (value && !['none', 'presentation'].includes(value)) return value;
  const tag = tagOf(node);
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'a' && hasAttribute(node, 'href')) return 'link';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    const type = (attributeOf(node, 'type') || 'text').replace(/\s+/gu, ' ').trim().toLowerCase();
    if (type === 'checkbox' || type === 'radio') return type;
    if (BUTTON_INPUT_TYPES.has(type)) return 'button';
    if (type === 'range') return 'slider';
    if (type === 'number') return 'spinbutton';
    if (type === 'hidden') return '';
    return 'textbox';
  }
  return '';
}

/**
 * Ocorrências das regras de teclado, por nó. Aceita a lista de ocorrências já montada pela
 * auditoria; regra desconhecida ou ocorrência sem nó simplesmente não entra.
 */
function ruleSuspectsByNode(occurrences) {
  const byNode = new Map();
  if (!Array.isArray(occurrences)) return byNode;
  for (const occurrence of occurrences) {
    const ruleId = typeof occurrence?.ruleId === 'string' ? occurrence.ruleId : '';
    if (!KEYBOARD_SUSPECT_RULE_IDS.includes(ruleId)) continue;
    const nodeId = occurrence?.nodeId ?? occurrence?.target?.nodeId;
    if (typeof nodeId !== 'string' || nodeId === '' || nodeId === 'document') continue;
    if (!byNode.has(nodeId)) byNode.set(nodeId, ruleId);
  }
  return byNode;
}

/**
 * Controles de formulário cujo rótulo pode ser projetado mesmo sob contaminação por privacidade.
 *
 * A contaminação existe porque o mapa nunca pode projetar o valor digitado — e continua valendo: o
 * valor não passa por aqui. O *nome* de um campo, porém, é conteúdo do autor (`label`, `aria-label`,
 * `title`, `placeholder`) e é justamente ele que deixa a pessoa reconhecer o campo na lista. Sem essa
 * exceção, todo campo — inclusive caixa de seleção e botão de envio — sairia como "sem nome", e a
 * pergunta da leitura guiada ("algum campo que você usaria está sem caixa?") ficaria sem âncora.
 *
 * A exceção é estreita de propósito: só entra `input`, `select` e `textarea`; `contenteditable` fica
 * de fora porque o texto digitado vive no próprio conteúdo; e nada entra quando há marcador de
 * privacidade no nó, ancestral editável ou privado, ou rótulo/`aria-labelledby` apontando para nó
 * editável ou privado. Um `input`/`select`/`textarea` não tem filhos, então não existe descendente
 * contaminado por dentro.
 */
function projectableControlName(node, indexes, privateLabelsByNodeId) {
  if (!EDITABLE_CONTROL_TAGS.has(tagOf(node)) || declaresEditing(node) || privateMarker(node)) return false;
  const sensitive = current => isEditableAccessibilityNode(current) || privateMarker(current);
  const parent = node.parentId === null || node.parentId === undefined ? null : indexes.byNodeId.get(String(node.parentId));
  if (ancestorState(parent, indexes, sensitive)) return false;
  for (const attribute of ['aria-labelledby', 'aria-describedby']) {
    for (const reference of normalizedText(attributeOf(node, attribute)).split(' ').filter(Boolean)) {
      for (const match of indexes.byDomId.get(reference) ?? []) if (sensitive(match)) return false;
    }
  }
  for (const labelId of Array.isArray(node.labels) ? node.labels : []) {
    const label = indexes.byNodeId.get(String(labelId));
    if (label && sensitive(label)) return false;
  }
  return !(privateLabelsByNodeId.get(String(node.nodeId)) ?? []).some(sensitive);
}

/** Rótulos `label[for]` por nó apontado: um deles editável ou privado contamina o nome do campo. */
function privateLabelsByTarget(snapshot, indexes) {
  const byTarget = new Map();
  for (const node of Array.isArray(snapshot?.nodes) ? snapshot.nodes : []) {
    if (tagOf(node) !== 'label') continue;
    const target = normalizedText(attributeOf(node, 'for'));
    if (!target) continue;
    for (const match of indexes.byDomId.get(target) ?? []) {
      const list = byTarget.get(String(match.nodeId)) ?? [];
      list.push(node);
      byTarget.set(String(match.nodeId), list);
    }
  }
  return byTarget;
}

/**
 * Texto visível como último recurso de nome para um item sem nome acessível.
 *
 * O caso real é um cartão de serviço: `<li>` com texto, `cursor: pointer` e nenhum papel declarado.
 * A pessoa vê "Consultar processo" na tela e não tem como conferir se aquele item recebe o Tab — a
 * única âncora possível é o próprio texto visível, e sem ele a lista de itens sem caixa fica cheia
 * de "sem nome visível", inútil para quem não sabe inspecionar a página. O texto visível já está na
 * captura em pixels do relatório, então projetá-lo não revela nada que o relatório não mostre.
 *
 * A fronteira de privacidade é a mesma do resto do mapa e é o que torna isso seguro: a contaminação
 * sobe para todos os ancestrais, então um cartão que contenha campo de senha, texto digitado ou
 * rótulo privado chega aqui já contaminado e nunca projeta texto nenhum. Controles de formulário
 * ficam de fora por precaução extra: neles o texto visível pode ecoar o valor que o mapa não pode
 * revelar, e o nome do campo já tem o caminho próprio de `projectableControlName`.
 */
function visibleTextFallback(node) {
  if (EDITABLE_CONTROL_TAGS.has(tagOf(node))) return '';
  return normalizedText(node.visibleText).slice(0, 160);
}

function projectEntry(node, indexes, tainted, name, privateLabelsByNodeId) {
  const isTainted = tainted.has(String(node.nodeId));
  if (isTainted && !projectableControlName(node, indexes, privateLabelsByNodeId)) {
    return { name: '', nameSource: 'omitted-privacy', nameStatus: 'omitted-privacy' };
  }
  const projection = projectElementAccessibility(node, indexes);
  const value = typeof projection?.[name] === 'string' ? projection[name].replace(/\s+/gu, ' ').trim() : '';
  if (value !== '' || isTainted) {
    return {
      name: value.slice(0, 512),
      nameSource: typeof projection?.nameSource === 'string' && projection.nameSource ? projection.nameSource : 'none',
      nameStatus: 'projected',
    };
  }
  const fallback = visibleTextFallback(node);
  return fallback === ''
    ? { name: '', nameSource: 'none', nameStatus: 'projected' }
    : { name: fallback, nameSource: 'visible-text', nameStatus: 'projected' };
}

/**
 * Calcula as paradas de Tab e os suspeitos do documento principal.
 *
 * @param {object} snapshot Instantâneo V1 já normalizado.
 * @param {{occurrences?: Array<object>}} [options] Ocorrências da auditoria (opcional).
 */
export function selectKeyboardMapStops(snapshot, options = {}) {
  const indexes = buildSnapshotIndexes(snapshot);
  const tainted = privacyTaintedNodeIds(snapshot, indexes);
  const privateLabels = privateLabelsByTarget(snapshot, indexes);
  const ruleSuspects = ruleSuspectsByNode(options.occurrences);
  const limitations = new Set(['tab-order-estimated-not-observed', 'top-document-open-shadow-only']);
  const counts = {
    eligible: 0, stops: 0, suspects: 0,
    omittedNotVisible: 0, omittedNoRect: 0, omittedClipped: 0, omittedFrame: 0, omittedLimit: 0,
  };
  const stopCandidates = [];
  const suspectCandidates = [];
  let cursorStyleCollected = false;
  let closedShadowOmitted = false;
  let privacyOmitted = false;

  for (const node of Array.isArray(snapshot?.nodes) ? snapshot.nodes : []) {
    const tag = tagOf(node);
    if (tag === '') continue; // nó de texto: não recebe foco nem clique
    if (Array.isArray(node.framePath) && node.framePath.length > 0) {
      counts.omittedFrame += 1;
      limitations.add('frame-content-omitted');
      continue;
    }
    if (ancestorState(node, indexes, current => current.shadowRootType === 'closed')) {
      closedShadowOmitted = true;
      continue;
    }
    if (invisibleReason(node, indexes)) {
      counts.omittedNotVisible += 1;
      continue;
    }
    if (!usefulRect(node.rect)) {
      counts.omittedNoRect += 1;
      continue;
    }
    if (!visibleRect(node, indexes)) {
      counts.omittedClipped += 1;
      continue;
    }
    if (styleValue(node, 'cursor') !== '') cursorStyleCollected = true;

    const declared = declaredTabIndex(node);
    const kind = nativeStopKind(node, indexes) ?? (declared !== null && declared >= 0 ? 'tabindex' : null);
    const tabIndex = kind === null ? null : declared !== null ? declared : 0;
    const bounds = { x: node.rect.x, y: node.rect.y, width: node.rect.width, height: node.rect.height };
    if (kind !== null && tabIndex >= 0) {
      stopCandidates.push({ node, bounds, kind, tabIndex, order: stopCandidates.length });
      continue;
    }
    suspectCandidates.push({ node, bounds });
  }

  // Ordem de Tab: índice positivo em ordem crescente (empate pela ordem do documento) e, depois,
  // tudo o que é zero na ordem do documento.
  const ordered = [...stopCandidates].sort((left, right) => {
    const leftPositive = left.tabIndex > 0 ? left.tabIndex : Number.POSITIVE_INFINITY;
    const rightPositive = right.tabIndex > 0 ? right.tabIndex : Number.POSITIVE_INFINITY;
    return leftPositive - rightPositive || left.order - right.order;
  });
  const keptStops = ordered.slice(0, KEYBOARD_MAP_STOP_LIMIT);
  if (ordered.length > keptStops.length) {
    counts.omittedLimit += ordered.length - keptStops.length;
    limitations.add('stop-limit-reached');
  }
  const stopIds = new Set(keptStops.map(candidate => String(candidate.node.nodeId)));
  const belongsToStop = new Set();
  const insideStop = new Set();
  for (const candidate of stopCandidates) {
    let current = candidate.node.parentId === null || candidate.node.parentId === undefined
      ? null
      : indexes.byNodeId.get(String(candidate.node.parentId));
    const visited = new Set();
    while (current && !visited.has(String(current.nodeId))) {
      visited.add(String(current.nodeId));
      belongsToStop.add(String(current.nodeId));
      current = current.parentId === null || current.parentId === undefined
        ? null
        : indexes.byNodeId.get(String(current.parentId));
    }
    // O outro lado da mesma relação: o que está DENTRO de uma parada do Tab também é alcançado por
    // ela. É o caso da imagem ou do ícone dentro de um link ou botão — a pessoa que usa o teclado
    // chega até aquele cartão pelo Tab e o clique do mouse na imagem segue o link do dono dela. A
    // seta de clique, sozinha, não distingue esse desenho de um item de verdade, então o desenho
    // entrava na lista de "parece clicável e o Tab não alcança" e escondia os itens reais.
    const stack = [candidate.node];
    const seen = new Set();
    while (stack.length > 0) {
      const node = stack.pop();
      if (seen.has(String(node.nodeId))) continue;
      seen.add(String(node.nodeId));
      for (const child of childNodes(node, indexes)) {
        insideStop.add(String(child.nodeId));
        stack.push(child);
      }
    }
  }
  const stops = keptStops.map((candidate, offset) => {
    const entry = projectEntry(candidate.node, indexes, tainted, 'name', privateLabels);
    if (entry.nameStatus === 'omitted-privacy') privacyOmitted = true;
    return {
      number: offset + 1,
      nodeId: String(candidate.node.nodeId),
      tag: tagOf(candidate.node),
      kind: candidate.kind,
      tabIndex: candidate.tabIndex,
      name: entry.name,
      nameSource: entry.nameSource,
      nameStatus: entry.nameStatus,
      bounds: candidate.bounds,
    };
  });

  const suspects = [];
  const suspectIds = new Set();
  const parentOf = node => node?.parentId === null || node?.parentId === undefined
    ? null : indexes.byNodeId.get(String(node.parentId));
  for (const candidate of suspectCandidates) {
    if (stopIds.has(String(candidate.node.nodeId))) continue;
    // Um texto dentro de um item já apontado (o título do cartão que só abre com o mouse) não é outro
    // item: listar os dois repetia o mesmo cartão três vezes e escondia o achado no meio do ruído.
    if (ancestorState(parentOf(candidate.node), indexes, current => suspectIds.has(String(current.nodeId)))) continue;
    // Controle desabilitado não é parada de Tab por decisão do autor: acusar aqui seria apontar como
    // falha o comportamento correto.
    if (isDisabledControl(candidate.node, indexes)) continue;
    const ruleId = ruleSuspects.get(String(candidate.node.nodeId)) ?? null;
    const declared = declaredTabIndex(candidate.node);
    // `tabindex` negativo é decisão declarada do autor, como o controle desabilitado acima: o item
    // saiu da ordem do Tab de propósito (roving tabindex em barra de ferramentas, item acionado pelas
    // setas, contêiner de foco de diálogo). Sem ocorrência de regra que sustente a acusação, apontar
    // isso seria falso positivo — e o caso real do mapa não passa por aqui: os cartões que só abrem
    // com o mouse não declaram `tabindex` nenhum e continuam na lista.
    if (declared !== null && declared < 0 && ruleId === null) continue;
    const role = observedRole(candidate.node);
    const tag = tagOf(candidate.node);
    // `cursor` é herdado: só conta quando o próprio elemento o declara de forma diferente do pai.
    const cursor = cursorStyleCollected && styleValue(candidate.node, 'cursor') === 'pointer' &&
      styleValue(parentOf(candidate.node), 'cursor') !== 'pointer';
    const projection = ruleId === null && !INTERACTIVE_ROLES.has(role) && !(cursor && !NATIVE_INTERACTIVE_TAGS.has(tag))
      ? null
      : projectEntry(candidate.node, indexes, tainted, 'name', privateLabels);
    const name = projection?.name ?? '';
    // "Tem rótulo" é o que separa um item que a pessoa usaria de uma caixa decorativa: vale o nome
    // acessível projetado ou o texto visível do próprio elemento — o cartão de serviço do caso real
    // tem texto e nenhum papel declarado, e sem isso ele ficaria fora da lista de suspeitos. O texto
    // serve só como sinal de presença: nada dele é projetado, e por isso olhar o texto de um nó
    // contaminado não revela nada — o que a contaminação bloqueia é a projeção do nome, logo acima.
    const hasLabel = name !== '' || normalizedText(candidate.node.visibleText) !== '';
    let reason = null;
    if (ruleId !== null) reason = 'keyboard-rule';
    else if (INTERACTIVE_ROLES.has(role) && !COMPOSITE_REACHABLE_ROLES.has(role)) reason = 'interactive-role';
    // A ocorrência de regra e o papel interativo falam do próprio item: quem declara `role="button"`
    // precisa ser alcançado por si, mesmo dentro de outra parada. Só o desenho apontado pela seta de
    // clique é que se explica pelo dono (estar dentro de um link, de um botão ou de um item que o Tab
    // já alcança), e é por isso que a dispensa vale apenas para este motivo.
    else if (cursor && !NATIVE_INTERACTIVE_TAGS.has(tag) && !COMPOSITE_REACHABLE_ROLES.has(role) &&
      !belongsToStop.has(String(candidate.node.nodeId)) && !insideStop.has(String(candidate.node.nodeId)) &&
      hasLabel) reason = 'cursor-pointer';
    if (reason === null) continue;
    if (projection?.nameStatus === 'omitted-privacy') privacyOmitted = true;
    suspectIds.add(String(candidate.node.nodeId));
    suspects.push({
      nodeId: String(candidate.node.nodeId),
      tag,
      role,
      reason,
      ruleId,
      name,
      nameSource: projection?.nameSource ?? 'none',
      nameStatus: projection?.nameStatus ?? 'projected',
      bounds: candidate.bounds,
    });
  }
  const keptSuspects = suspects.slice(0, KEYBOARD_MAP_SUSPECT_LIMIT);
  if (suspects.length > keptSuspects.length) {
    counts.omittedLimit += suspects.length - keptSuspects.length;
    limitations.add('suspect-limit-reached');
  }
  counts.stops = stops.length;
  counts.suspects = keptSuspects.length;
  counts.eligible = stops.length + counts.omittedNoRect + counts.omittedClipped + counts.omittedLimit;
  if (counts.omittedClipped > 0) limitations.add('ancestor-clipped-stops-omitted');
  if (!cursorStyleCollected) limitations.add('cursor-style-not-collected');
  if (privacyOmitted) limitations.add('privacy-content-omitted');
  if (closedShadowOmitted) limitations.add('closed-shadow-root-omitted');
  for (const value of Object.values(counts)) if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Contagens do mapa do teclado inválidas.');
  return {
    stops,
    suspects: keptSuspects.map((entry, offset) => ({ number: offset + 1, ...entry })),
    counts,
    limitations: KEYBOARD_MAP_LIMITATIONS.filter(value => limitations.has(value)),
  };
}
