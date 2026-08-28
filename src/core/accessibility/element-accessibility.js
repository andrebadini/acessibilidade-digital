import { buildAnnouncementPreview } from './announcement.js';
import { computeAccessibleText } from './accessible-name.js';

function normalizedText(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function nodeAttribute(node, name) {
  const value = node?.attributes?.[name];
  return typeof value === 'string' ? value : value === true ? '' : undefined;
}

export function isEditableAccessibilityNode(node) {
  const tag = normalizedText(node?.tagName).toLowerCase();
  const contenteditable = normalizedText(nodeAttribute(node, 'contenteditable')).toLowerCase();
  return ['input', 'select', 'textarea'].includes(tag) || (
    Object.hasOwn(node?.attributes || {}, 'contenteditable') && !['false', 'inherit'].includes(contenteditable)
  );
}

function observedBoolean(node, property, ariaName) {
  const direct = Object.hasOwn(node || {}, property) ? node[property] : undefined;
  if (direct === true || direct === false || (property === 'checked' && direct === 'mixed')) return direct;
  const form = Object.hasOwn(node?.form || {}, property) ? node.form[property] : undefined;
  if (form === true || form === false || (property === 'checked' && form === 'mixed')) return form;
  const aria = normalizedText(nodeAttribute(node, ariaName)).toLowerCase();
  if (aria === 'true') return true;
  if (aria === 'false') return false;
  if (property === 'checked' && aria === 'mixed') return 'mixed';
  if (property === 'invalid' && ['grammar', 'spelling'].includes(aria)) return true;
  return undefined;
}

function observedPresence(node, property, ariaName, nativeName = property) {
  const direct = Object.hasOwn(node || {}, property) ? node[property] : undefined;
  const form = Object.hasOwn(node?.form || {}, property) ? node.form[property] : undefined;
  const aria = normalizedText(nodeAttribute(node, ariaName)).toLowerCase();
  const native = Object.hasOwn(node?.attributes || {}, nativeName) ? true : undefined;
  const sources = [direct, form, aria === 'true' ? true : aria === 'false' ? false : undefined, native];
  if (sources.includes(true)) return true;
  if (sources.includes(false)) return false;
  return undefined;
}

function nativeRole(node) {
  const tag = normalizedText(node?.tagName).toLowerCase();
  const type = normalizedText(nodeAttribute(node, 'type') || node?.form?.type || 'text').toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a' && nodeAttribute(node, 'href') !== undefined) return 'link';
  if (tag === 'select') return Object.hasOwn(node?.attributes || {}, 'multiple') || node?.form?.multiple === true ? 'listbox' : 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'img') return 'img';
  if (/^h[1-6]$/u.test(tag)) return 'heading';
  if (tag === 'li') return 'listitem';
  if (tag === 'input') {
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (['button', 'image', 'reset', 'submit'].includes(type)) return 'button';
    if (type === 'range') return 'slider';
    if (type === 'number') return 'spinbutton';
    if (['', 'email', 'password', 'search', 'tel', 'text', 'url'].includes(type)) return 'textbox';
  }
  return '';
}

const CHECKED_ROLES = new Set(['checkbox', 'menuitemcheckbox', 'menuitemradio', 'radio', 'switch']);
const SELECTED_ROLES = new Set(['gridcell', 'option', 'row', 'tab', 'treeitem']);
const EXPANDED_ROLES = new Set(['button', 'combobox', 'link', 'menuitem', 'row', 'treeitem']);
const DISABLED_ROLES = new Set(['button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem']);
const REQUIRED_ROLES = new Set(['checkbox', 'combobox', 'listbox', 'radio', 'slider', 'spinbutton', 'switch', 'textbox']);
const INVALID_ROLES = new Set(['checkbox', 'combobox', 'listbox', 'radio', 'slider', 'spinbutton', 'switch', 'textbox']);

function compatibleState(node, role, property, ariaName, roles, presence = false) {
  if (!roles.has(role)) return undefined;
  return presence ? observedPresence(node, property, ariaName) : observedBoolean(node, property, ariaName);
}

/** One bounded, value-safe projection shared by evidence, maps and reader previews. */
export function projectElementAccessibility(node, indexes) {
  const text = computeAccessibleText(node, indexes, {
    name: normalizedText(node?.accessibleName),
    description: normalizedText(node?.accessibleDescription),
  });
  const role = normalizedText(node?.axRole || node?.role || nodeAttribute(node, 'role') || nativeRole(node)).toLowerCase();
  const editable = isEditableAccessibilityNode(node);
  const checked = compatibleState(node, role, 'checked', 'aria-checked', CHECKED_ROLES);
  const selected = compatibleState(node, role, 'selected', 'aria-selected', SELECTED_ROLES);
  const expanded = compatibleState(node, role, 'expanded', 'aria-expanded', EXPANDED_ROLES);
  const disabled = compatibleState(node, role, 'disabled', 'aria-disabled', DISABLED_ROLES, true);
  const required = compatibleState(node, role, 'required', 'aria-required', REQUIRED_ROLES, true);
  const invalid = compatibleState(node, role, 'invalid', 'aria-invalid', INVALID_ROLES);
  const properties = { ...text, role, checked, selected, expanded, disabled, required, invalid };
  const states = [];
  if (checked === true) states.push('marcado');
  if (checked === false) states.push('desmarcado');
  if (checked === 'mixed') states.push('parcialmente marcado');
  if (selected === true) states.push('selecionado');
  if (selected === false) states.push('não selecionado');
  if (expanded === true) states.push('expandido');
  if (expanded === false) states.push('recolhido');
  if (disabled === true) states.push('indisponível');
  if (required === true) states.push('obrigatório');
  if (invalid === true) states.push('inválido');
  return {
    ...text,
    role,
    ...(editable ? { valueStatus: 'omitted-privacy' } : {}),
    states,
    visibleText: editable ? '' : normalizedText(node?.visibleText),
    announcementPreview: buildAnnouncementPreview(properties).text,
  };
}
