const ROLE_LABELS = new Map([
  ['button', 'botão'],
  ['link', 'link'],
  ['checkbox', 'caixa de seleção'],
  ['radio', 'botão de opção'],
  ['textbox', 'campo de texto'],
  ['combobox', 'caixa de combinação'],
  ['listbox', 'caixa de listagem'],
  ['heading', 'cabeçalho'],
  ['img', 'imagem'],
  ['region', 'região'],
  ['table', 'tabela'],
  ['list', 'lista'],
  ['listitem', 'item da lista']
]);
const EMPTY_PROPERTIES = Object.freeze({});

function propertiesOf(input) {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input
    : EMPTY_PROPERTIES;
}

function ownProperty(properties, key) {
  return Object.hasOwn(properties, key) ? properties[key] : undefined;
}

function previewText(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/\s+/gu, ' ').trim().replace(/[,:;.]+$/u, '').trim();
}

function observedState(properties) {
  const states = [];
  const checked = ownProperty(properties, 'checked');
  const selected = ownProperty(properties, 'selected');
  const expanded = ownProperty(properties, 'expanded');
  if (checked === true) states.push('marcado');
  if (checked === false) states.push('desmarcado');
  if (checked === 'mixed') states.push('parcialmente marcado');
  if (selected === true) states.push('selecionado');
  if (selected === false) states.push('não selecionado');
  if (expanded === true) states.push('expandido');
  if (expanded === false) states.push('recolhido');
  if (ownProperty(properties, 'disabled') === true) states.push('indisponível');
  if (ownProperty(properties, 'required') === true) states.push('obrigatório');
  if (ownProperty(properties, 'invalid') === true) states.push('inválido');
  return states;
}

const SENSITIVE_AUTOCOMPLETE = new Set([
  'current-password', 'new-password', 'one-time-code'
]);

function mayDiscloseValue(properties) {
  if (ownProperty(properties, 'valueDisclosure') !== 'safe') return false;
  if (ownProperty(properties, 'sensitive') === true) return false;
  const inputType = previewText(ownProperty(properties, 'inputType') ?? ownProperty(properties, 'type')).toLowerCase();
  if (inputType === 'password') return false;
  const autocomplete = previewText(ownProperty(properties, 'autocomplete')).toLowerCase().split(' ');
  return !autocomplete.some(token => SENSITIVE_AUTOCOMPLETE.has(token));
}

/**
 * Formats a deterministic Portuguese text preview. It is not a claim about
 * the exact speech of NVDA, JAWS, VoiceOver, or any other screen reader.
 */
export function buildAnnouncementPreview(properties = {}) {
  const safeProperties = propertiesOf(properties);
  const role = ROLE_LABELS.get(ownProperty(safeProperties, 'role'));
  const value = mayDiscloseValue(safeProperties)
    ? previewText(ownProperty(safeProperties, 'value'))
    : '';
  const rawLevel = ownProperty(safeProperties, 'level');
  const level = Number.isInteger(rawLevel) && rawLevel > 0
    ? `nível ${rawLevel}`
    : '';
  const parts = [
    previewText(ownProperty(safeProperties, 'name')),
    role,
    previewText(ownProperty(safeProperties, 'description')),
    value && `valor ${value}`,
    level,
    ...observedState(safeProperties)
  ].filter(Boolean);
  const seen = new Set();
  const uniqueParts = parts.filter(part => {
    const key = part.toLocaleLowerCase('pt-BR');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    text: uniqueParts.join(', '),
    kind: 'preview',
    locale: 'pt-BR'
  };
}
