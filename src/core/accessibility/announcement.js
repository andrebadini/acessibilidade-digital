const ROLE_LABELS = Object.freeze({
  button: 'botão',
  link: 'link',
  checkbox: 'caixa de seleção',
  radio: 'botão de opção',
  textbox: 'campo de texto',
  combobox: 'caixa de combinação',
  heading: 'cabeçalho',
  img: 'imagem',
  region: 'região',
  table: 'tabela',
  list: 'lista',
  listitem: 'item da lista'
});

function previewText(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/\s+/gu, ' ').trim().replace(/[,:;.]+$/u, '').trim();
}

function observedState(properties) {
  const states = [];
  if (properties.checked === true) states.push('marcado');
  if (properties.checked === false) states.push('desmarcado');
  if (properties.checked === 'mixed') states.push('parcialmente marcado');
  if (properties.selected === true) states.push('selecionado');
  if (properties.selected === false) states.push('não selecionado');
  if (properties.expanded === true) states.push('expandido');
  if (properties.expanded === false) states.push('recolhido');
  if (properties.disabled === true) states.push('indisponível');
  if (properties.required === true) states.push('obrigatório');
  if (properties.invalid === true) states.push('inválido');
  return states;
}

/**
 * Formats a deterministic Portuguese text preview. It is not a claim about
 * the exact speech of NVDA, JAWS, VoiceOver, or any other screen reader.
 */
export function buildAnnouncementPreview(properties = {}) {
  const role = ROLE_LABELS[properties.role];
  const value = previewText(properties.value);
  const level = Number.isInteger(properties.level) && properties.level > 0
    ? `nível ${properties.level}`
    : '';
  const parts = [
    previewText(properties.name),
    role,
    previewText(properties.description),
    value && `valor ${value}`,
    level,
    ...observedState(properties)
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
