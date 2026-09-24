/** Self-contained: Chrome serializes this function into its isolated execution world. */
export function tabReadingPageCommand(command) {
  'use strict';
  const root = globalThis;
  const key = Symbol.for('audita.tab-reading.inspector.v1');
  const runtimeKey = Symbol.for('audita.accessible-preview.runtime.v1');
  const MAX_NODES = 5000;
  const MAX_ENTRIES = 1000;
  const MAX_TEXT = 512;
  const LIFETIME = 600000;
  const validSession = typeof command?.sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(command.sessionId);
  const reply = (ok, reason) => ({ version: 1, sessionId: validSession ? command.sessionId : '', ok, ...(reason ? { reason } : {}) });
  if (!validSession || !['collect', 'highlight', 'observe', 'clear'].includes(command.type)) return reply(false, 'invalid-command');
  const document = root.document;
  if (!document?.documentElement) return reply(false, 'document-unavailable');
  const previous = root[key];
  if (command.type === 'clear') {
    if (previous?.sessionId !== command.sessionId) return reply(false, 'session-unavailable');
    previous.clear();
    return reply(true);
  }
  if (command.type !== 'collect') {
    if (!previous || previous.sessionId !== command.sessionId || previous.document !== document) return reply(false, 'session-unavailable');
    if (previous.expired()) { previous.dispose(); return reply(false, 'session-unavailable'); }
    // Num percurso guiado, um Escape pressionado depois do início encerra o percurso, antes de qualquer outra verificação.
    const walkEscapes = command.type === 'highlight' && Number.isSafeInteger(command.walkEscapes) && command.walkEscapes >= 0 ? command.walkEscapes : null;
    if (walkEscapes !== null && previous.escapes() > walkEscapes) return { ...reply(false, 'walk-escaped'), escapes: previous.escapes() };
    if (previous.changed()) return reply(false, 'page-changed');
    return command.type === 'highlight' ? previous.highlight(command.elementId) : previous.observe();
  }
  previous?.dispose?.();
  const namespace = root[runtimeKey];
  if (namespace?.brand !== 'audita-accessible-preview' || namespace.version !== 1 || typeof namespace.createRuntime !== 'function') {
    return reply(false, 'runtime-unavailable');
  }
  const runtime = namespace.createRuntime();
  const limitations = new Set([
    'estimated-order-not-literal-screen-reader', 'top-document-open-shadow-only',
    'closed-shadow-not-inspected', 'editable-values-omitted', 'observed-state-may-change',
  ]);
  const sensitiveWords = /(?:senha|password|passcode|secret|segredo|token|api[\s_-]?key|chave\s+(?:secreta|privada|api)|authorization|bearer|cookie|session|sess[aã]o|one[\s_-]?time|\botp\b)/iu;
  function safeText(value, maximum = MAX_TEXT) {
    if (typeof value !== 'string') return '';
    const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, '')
      .replace(/\s+/gu, ' ').trim();
    // The live legend cannot depend on the controller's later report sanitization.
    if (sensitiveWords.test(text) || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u.test(text) || /\b[A-Za-z0-9+/_=-]{40,}\b/u.test(text)) return '[conteúdo omitido por privacidade]';
    return Array.from(text).slice(0, maximum).join('');
  }
  function attr(element, name) {
    try { return element.getAttribute(name); } catch { return null; }
  }
  function has(element, name) {
    try { return element.hasAttribute(name); } catch { return false; }
  }
  const tagOf = element => String(element?.localName || element?.tagName || '').toLowerCase();
  const roleOf = element => (attr(element, 'role') || '').trim().toLowerCase().split(/\s+/u)[0];
  function parentOf(element) {
    return element?.assignedSlot || element?.parentElement || element?.getRootNode?.()?.host || null;
  }
  function parents(element) {
    const result = []; const seen = new Set();
    for (let current = element; current && !seen.has(current) && result.length < 100; current = parentOf(current)) {
      seen.add(current); result.push(current);
    }
    return result;
  }
  function isPrivate(element) {
    return has(element, 'data-audita-private') || has(element, 'data-private') || has(element, 'data-nosnippet') ||
      (typeof element.getAttributeNames === 'function' && element.getAttributeNames().some(name => /^data-.*(?:password|secret|token|credential|api-key)/iu.test(name)));
  }
  function isEditable(element) {
    const editable = attr(element, 'contenteditable');
    return ['input', 'textarea', 'select'].includes(tagOf(element)) ||
      ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(roleOf(element)) ||
      (editable !== null && !['false', 'inherit'].includes(editable.trim().toLowerCase()));
  }
  function isCredential(element) {
    if (!isEditable(element)) return false;
    const type = (attr(element, 'type') || '').toLowerCase();
    const auto = (attr(element, 'autocomplete') || '').toLowerCase().split(/\s+/u);
    return type === 'password' || auto.some(token => /^(?:current-password|new-password|one-time-code|cc-number|cc-csc)$/u.test(token)) ||
      sensitiveWords.test(`${attr(element, 'id') || ''} ${attr(element, 'name') || ''}`);
  }
  function nativeRole(element) {
    const explicit = roleOf(element);
    if (explicit && !['none', 'presentation'].includes(explicit)) return explicit;
    const tag = tagOf(element); const type = (attr(element, 'type') || 'text').toLowerCase();
    if (tag === 'button' || tag === 'summary') return 'button';
    if ((tag === 'a' || tag === 'area') && has(element, 'href')) return 'link';
    if (tag === 'input') {
      if (['checkbox', 'radio'].includes(type)) return type;
      if (['button', 'image', 'submit', 'reset'].includes(type)) return 'button';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'hidden') return '';
      return 'textbox';
    }
    if (tag === 'textarea' || isEditable(element) && !['input', 'select'].includes(tag)) return 'textbox';
    if (tag === 'select') return has(element, 'multiple') || Number(attr(element, 'size')) > 1 ? 'listbox' : 'combobox';
    if (/^h[1-6]$/u.test(tag)) return 'heading';
    return ({ img: 'img', ul: 'list', ol: 'list', li: 'listitem', table: 'table', nav: 'navigation', main: 'main', aside: 'complementary', header: 'banner', footer: 'contentinfo', progress: 'progressbar', meter: 'meter', iframe: 'iframe' })[tag] || '';
  }
  const controlRoles = new Set(['button', 'checkbox', 'radio', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'option']);
  const structuralTags = new Set(['p', 'img', 'ul', 'ol', 'li', 'table', 'caption', 'main', 'nav', 'aside', 'header', 'footer', 'iframe', 'audio', 'video', 'progress', 'meter']);
  const structuralRoles = new Set(['heading', 'img', 'list', 'listitem', 'table', 'region', 'navigation', 'main', 'complementary', 'banner', 'contentinfo', 'status', 'alert', 'dialog', 'alertdialog', 'progressbar', 'meter']);
  const nonContentTags = new Set(['head', 'script', 'style', 'noscript', 'template']);
  const allowedAttributes = ['id', 'for', 'role', 'type', 'aria-labelledby', 'aria-describedby', 'aria-label', 'title', 'alt'];
  const elements = []; const snapshots = new Map(); const byNodeId = new Map(); const byDomId = new Map();
  const seen = new Set(); let truncated = false; let omittedPrivate = 0;
  function boundedChildren(collection) {
    const result = [];
    for (const child of collection || []) {
      if (result.length >= MAX_NODES) { truncated = true; limitations.add('node-limit-reached'); break; }
      result.push(child);
    }
    return result;
  }
  function childrenOf(element) {
    if (isPrivate(element) || isEditable(element) || nonContentTags.has(tagOf(element))) return [];
    if (element.shadowRoot?.mode === 'open') {
      limitations.add('open-shadow-order-estimated');
      return boundedChildren(element.shadowRoot.children);
    }
    if (tagOf(element) === 'slot' && typeof element.assignedElements === 'function') {
      try { const assigned = element.assignedElements({ flatten: true }); if (assigned.length) return boundedChildren(assigned); } catch { limitations.add('slot-content-unavailable'); }
    }
    return boundedChildren(element.children);
  }
  const stack = [document.documentElement];
  while (stack.length) {
    const element = stack.pop();
    if (!element || seen.has(element) || element.nodeType !== 1) continue;
    if (seen.size >= MAX_NODES) { truncated = true; limitations.add('node-limit-reached'); break; }
    seen.add(element);
    if (isPrivate(element)) { omittedPrivate += 1; limitations.add('private-content-omitted'); continue; }
    elements.push(element);
    const children = childrenOf(element);
    for (let offset = children.length - 1; offset >= 0; offset -= 1) stack.push(children[offset]);
  }
  function visibility(element) {
    let hidden = false; let inert = false; let ariaHidden = false;
    for (const current of parents(element)) {
      if (has(current, 'inert')) inert = true;
      if ((attr(current, 'aria-hidden') || '').toLowerCase() === 'true') ariaHidden = true;
      if (has(current, 'hidden') || current.hidden === true) hidden = true;
      try { const style = root.getComputedStyle(current); if (style.display === 'none' || current === element && ['hidden', 'collapse'].includes(style.visibility)) hidden = true; } catch { hidden = true; }
      if (tagOf(current) === 'details' && !has(current, 'open') && current.open !== true && current !== element) {
        const summary = Array.from(current.children || []).find(child => tagOf(child) === 'summary');
        if (!summary || !parents(element).includes(summary)) hidden = true;
      }
    }
    return { hidden, inert, ariaHidden };
  }
  for (const [position, element] of elements.entries()) {
    const credential = isCredential(element);
    const attributes = Object.create(null);
    for (const name of allowedAttributes) {
      if (credential && !['id', 'type', 'role'].includes(name)) continue;
      const value = attr(element, name);
      if (value !== null) attributes[name] = ['id', 'for', 'aria-labelledby', 'aria-describedby'].includes(name) ? value.slice(0, 512) : safeText(value);
    }
    if (has(element, 'href')) attributes.href = '';
    const visibleState = visibility(element);
    const snapshot = { nodeId: `reader-${position + 1}`, tagName: tagOf(element), attributes, text: '', children: [], private: credential,
      hidden: visibleState.hidden || visibleState.inert || visibleState.ariaHidden };
    snapshots.set(element, snapshot); byNodeId.set(snapshot.nodeId, snapshot);
    if (attributes.id) { const matches = byDomId.get(attributes.id) || []; matches.push(snapshot); byDomId.set(attributes.id, matches); }
    if (credential) limitations.add('credential-content-omitted');
  }
  let textCounter = 0; let textLength = 0;
  for (const element of elements) {
    const snapshot = snapshots.get(element);
    if (snapshot.private || isEditable(element) || nonContentTags.has(tagOf(element))) continue;
    if (tagOf(element) === 'img') snapshot.text = safeText(attr(element, 'alt') || '');
    let children;
    if (element.shadowRoot?.mode === 'open' || tagOf(element) === 'slot') children = childrenOf(element);
    else children = Array.from(element.childNodes || []);
    if (children.length > 1000) { truncated = true; limitations.add('text-limit-reached'); }
    for (const child of children.slice(0, 1000)) {
      if (child.nodeType === 3) {
        if (textCounter >= 5000 || textLength >= 65536) { truncated = true; limitations.add('text-limit-reached'); continue; }
        const value = safeText(child.nodeValue);
        textLength += value.length;
        if (value) snapshot.children.push({ nodeId: `text-${++textCounter}`, tagName: 'span', text: value, attributes: {}, children: [] });
      } else if (snapshots.has(child)) {
        const childSnapshot = snapshots.get(child);
        // Editable values are never a naming source, including implicit labels.
        if (!isEditable(child)) snapshot.children.push(childSnapshot);
      }
    }
  }
  for (const element of elements) {
    if (!['input', 'textarea', 'select', 'button'].includes(tagOf(element))) continue;
    const label = parents(element).slice(1).find(parent => tagOf(parent) === 'label');
    if (label && !has(label, 'for') && snapshots.has(label)) snapshots.get(element).labels = [snapshots.get(label)];
  }
  const indexes = { byNodeId, byDomId };
  function contentText(snapshot, visited = new Set(), allowHidden = false) {
    if (!snapshot || snapshot.private || !allowHidden && snapshot.hidden || visited.has(snapshot)) return '';
    visited.add(snapshot);
    return safeText([snapshot.text, ...(snapshot.children || []).map(child => contentText(child, visited, allowHidden))].filter(Boolean).join(' '));
  }
  function structuralSelector(element) {
    const parts = []; let current = element;
    for (let depth = 0; current && depth < 8; depth += 1) {
      const tag = tagOf(current);
      if (!/^[a-z][a-z0-9-]*$/u.test(tag)) break;
      const siblings = Array.from(current.parentElement?.children || current.parentNode?.children || []).filter(node => tagOf(node) === tag);
      parts.unshift(`${tag}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ''}`);
      if (!current.parentElement && current.getRootNode?.()?.host) parts.unshift('>>>');
      current = current.parentElement || current.getRootNode?.()?.host || null;
    }
    return parts.join(' > ').replaceAll(' > >>> > ', ' >>> ').slice(0, 512);
  }
  function stateProperties(element, role) {
    const states = []; const values = {};
    const boolean = name => { const value = (attr(element, name) || '').toLowerCase(); return value === 'true' ? true : value === 'false' ? false : undefined; };
    if (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role)) {
      values.checked = (attr(element, 'aria-checked') || '') === 'mixed' ? 'mixed' : boolean('aria-checked');
      if (tagOf(element) === 'input' && ['checkbox', 'radio'].includes((attr(element, 'type') || '').toLowerCase())) values.checked = element.indeterminate === true ? 'mixed' : element.checked === true;
      if (values.checked !== undefined) states.push(values.checked === 'mixed' ? 'parcialmente marcado' : values.checked ? 'marcado' : 'desmarcado');
    }
    for (const [property, aria, yes, no] of [['selected', 'aria-selected', 'selecionado', 'não selecionado'], ['expanded', 'aria-expanded', 'expandido', 'recolhido']]) {
      values[property] = boolean(aria);
      if (property === 'expanded' && tagOf(element) === 'summary' && tagOf(element.parentElement) === 'details') values.expanded = has(element.parentElement, 'open') || element.parentElement.open === true;
      if (values[property] !== undefined) states.push(values[property] ? yes : no);
    }
    let disabled = false;
    try { disabled = element.matches(':disabled'); } catch { disabled = element.disabled === true; }
    values.disabled = disabled || boolean('aria-disabled') === true;
    values.required = has(element, 'required') || boolean('aria-required') === true;
    values.invalid = ['true', 'grammar', 'spelling'].includes((attr(element, 'aria-invalid') || '').toLowerCase());
    if (values.disabled) states.push('indisponível');
    if (values.required) states.push('obrigatório');
    if (values.invalid) states.push('inválido');
    return { values, states, disabled };
  }
  function previewFingerprint(element, role) {
    const credential = isCredential(element);
    const metadata = ['aria-labelledby', 'aria-describedby', 'aria-label', 'title', 'alt', 'aria-hidden'];
    return JSON.stringify({
      attributes: credential ? [] : metadata.map(name => safeText(attr(element, name) || '')),
      states: stateProperties(element, role), visibility: visibility(element),
    });
  }
  const entries = []; const references = new Map(); const radios = [];
  for (const element of elements) {
    const snapshot = snapshots.get(element); const tag = tagOf(element); const role = nativeRole(element);
    const rawTabIndex = element.tabIndex;
    const declaresEditing = node => ['', 'true', 'plaintext-only'].includes((attr(node, 'contenteditable') ?? 'false').toLowerCase());
    const editingHost = !has(element, 'tabindex') && (element.isContentEditable === true ||
      typeof element.isContentEditable !== 'boolean' && declaresEditing(element)) &&
      !parents(element).slice(1).some(parent => parent.isContentEditable === true || declaresEditing(parent));
    // Chromium reports .tabIndex === -1 for an editing host that is nevertheless a natural Tab stop.
    const tabIndex = editingHost ? 0 : Number.isInteger(rawTabIndex) ? rawTabIndex : null;
    const control = controlRoles.has(role) || ['button', 'input', 'select', 'textarea', 'summary'].includes(tag) || isEditable(element) || has(element, 'onclick');
    const structural = structuralTags.has(tag) || structuralRoles.has(role) || /^h[1-6]$/u.test(tag);
    if (!control && !structural && !has(element, 'tabindex')) continue;
    if (entries.length >= MAX_ENTRIES) { truncated = true; limitations.add('entry-limit-reached'); break; }
    const state = stateProperties(element, role); const visibilityState = visibility(element); const reasons = [];
    if (editingHost) reasons.push('implicit-editing-host');
    if (tag === 'iframe') { limitations.add('frame-content-not-inspected'); reasons.push('frame-content-not-inspected'); }
    if (visibilityState.hidden || tag === 'input' && (attr(element, 'type') || '').toLowerCase() === 'hidden') reasons.push('not-rendered');
    if (visibilityState.inert) reasons.push('inert');
    if (visibilityState.ariaHidden) reasons.push('aria-hidden');
    if (state.disabled) reasons.push('native-disabled');
    if (state.values.disabled && !state.disabled) reasons.push('aria-disabled-remains-focusable');
    let sequential = tabIndex !== null && tabIndex >= 0 && !state.disabled;
    if (!has(element, 'tabindex')) {
      if (['a', 'area'].includes(tag) && !has(element, 'href')) sequential = false;
      if (['audio', 'video'].includes(tag) && !has(element, 'controls')) sequential = false;
      if (tag === 'summary' && (tagOf(element.parentElement) !== 'details' || Array.from(element.parentElement.children || []).find(child => tagOf(child) === 'summary') !== element)) sequential = false;
    }
    let category = reasons.includes('not-rendered') || visibilityState.inert ? 'hidden' : sequential ? 'tab' : control || has(element, 'tabindex') ? 'outside-tab' : 'reading';
    if (visibilityState.ariaHidden && category !== 'tab') category = 'hidden';
    if (category === 'outside-tab') {
      if (has(element, 'tabindex') && tabIndex < 0) reasons.push('negative-tabindex');
      if (!state.disabled) reasons.push('control-outside-tab');
    }
    if (category === 'reading') reasons.push('structural-reading-not-tab');
    if (snapshot.private) reasons.push('credential-content-omitted');
    // A hidden row remains identifiable, but hidden descendants of visible names stay excluded.
    const nameSnapshot = snapshot.hidden ? { ...snapshot, hidden: false } : snapshot;
    const accessible = runtime.computeAccessibleText(nameSnapshot, indexes);
    const contentName = ['p', 'li', 'caption'].includes(tag) || role === 'heading';
    const name = safeText(accessible.name || (contentName ? contentText(snapshot, new Set(), snapshot.hidden) : ''));
    const description = safeText(accessible.description);
    if (!name && control) reasons.push('accessible-name-unavailable');
    const level = role === 'heading' ? /^h[1-6]$/u.test(tag) ? Number(tag.slice(1)) : Number(attr(element, 'aria-level')) : undefined;
    const extraRoleLabel = ({ navigation: 'navegação', main: 'região principal', complementary: 'região complementar', banner: 'cabeçalho da página', contentinfo: 'rodapé', status: 'mensagem de status', alert: 'alerta', dialog: 'diálogo', alertdialog: 'diálogo de alerta', iframe: 'quadro incorporado', menuitemcheckbox: 'item de menu com caixa de seleção', menuitemradio: 'item de menu com botão de opção', treeitem: 'item de árvore', option: 'opção', searchbox: 'campo de pesquisa' })[role];
    const preview = safeText(runtime.buildAnnouncementPreview({ name: extraRoleLabel ? [name, extraRoleLabel].filter(Boolean).join(', ') : name, description, role: extraRoleLabel ? '' : role, ...state.values, level }).text) || (control ? 'Controle sem nome acessível' : 'Elemento sem texto acessível');
    let bounds = null;
    try {
      const rect = element.getBoundingClientRect();
      const scrollX = root.scrollX || root.pageXOffset || 0;
      const scrollY = root.scrollY || root.pageYOffset || 0;
      if ([rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0) {
        bounds = { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height };
      }
    } catch { bounds = null; }
    const entry = { id: `element-${entries.length + 1}`, selector: structuralSelector(element), tag, role, name, description,
      states: state.states, preview, tabIndex, tabOrder: null, category, reasons, bounds };
    entries.push(entry);
    const identity = [tag, attr(element, 'id'), attr(element, 'role'), attr(element, 'type'), attr(element, 'tabindex')];
    references.set(entry.id, { element, entry, identity, fingerprint: previewFingerprint(element, role) });
    if (tag === 'input' && (attr(element, 'type') || '').toLowerCase() === 'radio' && category === 'tab') radios.push({ element, entry });
  }
  const radioGroups = [];
  for (const radio of radios) {
    const name = attr(radio.element, 'name');
    if (!name) continue;
    const owner = radio.element.form || null; const tree = radio.element.getRootNode?.();
    let group = radioGroups.find(candidate => candidate.name === name && candidate.owner === owner && candidate.tree === tree);
    if (!group) { group = { name, owner, tree, radios: [] }; radioGroups.push(group); }
    group.radios.push(radio);
  }
  for (const group of radioGroups) {
    const chosen = group.radios.find(radio => radio.element.checked === true) || group.radios[0];
    for (const radio of group.radios) if (radio !== chosen) {
      radio.entry.category = 'outside-tab'; radio.entry.reasons.push('radio-group-arrow-navigation');
    }
  }
  const tabEntries = entries.filter(entry => entry.category === 'tab').sort((left, right) => {
    if (left.tabIndex > 0 || right.tabIndex > 0) return (left.tabIndex > 0 ? left.tabIndex : Infinity) - (right.tabIndex > 0 ? right.tabIndex : Infinity);
    return 0;
  });
  for (const [position, entry] of tabEntries.entries()) entry.tabOrder = position + 1;
  const counts = { total: entries.length, tab: tabEntries.length, outsideTab: entries.filter(entry => entry.category === 'outside-tab').length,
    reading: entries.filter(entry => entry.category === 'reading').length, hidden: entries.filter(entry => entry.category === 'hidden').length,
    scanned: seen.size, omittedPrivate, truncated };
  let overlay = null; let box = null; let legend = null; let observing = false; let current = null; let timeout = null; let scheduled = null; let closed = false;
  let pageChanged = false; let mutationObserver = null;
  // Conta os Escape na página: o percurso guiado de Tab para quando a pessoa pressiona Escape.
  let escapes = 0;
  const ownedNodes = new WeakSet();
  const expiresAt = Date.now() + LIFETIME;
  const expired = () => closed || Date.now() >= expiresAt;
  function clear() {
    observing = false;
    root.clearTimeout(scheduled); scheduled = null;
    document.removeEventListener('focusin', focusIn, true); document.removeEventListener('keydown', keyDown, true);
    document.removeEventListener('input', stateEvent, true); document.removeEventListener('change', stateEvent, true);
    root.removeEventListener('scroll', reposition, true); root.removeEventListener('resize', reposition, true);
    overlay?.remove(); overlay = null; box = null; legend = null; current = null;
  }
  function dispose() {
    if (closed) return;
    closed = true;
    clear(); root.clearTimeout(timeout);
    mutationObserver?.disconnect(); mutationObserver = null;
    for (const event of ['pagehide', 'beforeunload', 'popstate', 'hashchange']) root.removeEventListener(event, dispose, true);
    references.clear();
    if (root[key]?.dispose === dispose) delete root[key];
  }
  function validReference(reference) {
    const element = reference?.element;
    if (expired()) { dispose(); return false; }
    if (changed()) return false;
    if (!element || element.isConnected === false || element.ownerDocument !== document) return false;
    if (parents(element).some(isPrivate) || isCredential(element) !== reference.entry.reasons.includes('credential-content-omitted')) return false;
    if (!reference.identity.every((value, index) => value === [tagOf(element), attr(element, 'id'), attr(element, 'role'), attr(element, 'type'), attr(element, 'tabindex')][index])) return false;
    if (previewFingerprint(element, reference.entry.role) !== reference.fingerprint) { invalidate(); return false; }
    return true;
  }
  function invalidate() {
    if (closed || pageChanged) return;
    pageChanged = true; observing = false; current = null;
    root.clearTimeout(scheduled); scheduled = null;
    document.removeEventListener('focusin', focusIn, true);
    document.removeEventListener('input', stateEvent, true); document.removeEventListener('change', stateEvent, true);
    mutationObserver?.disconnect();
    if (box) box.style.setProperty('display', 'none');
    if (legend) legend.textContent = 'Página alterada; atualize a inspeção. Escape encerra os destaques.';
  }
  function isOwned(node) {
    if (!node) return false;
    if (ownedNodes.has(node)) return true;
    const element = node.nodeType === 1 ? node : node.parentNode;
    return element && parents(element).some(candidate => ownedNodes.has(candidate));
  }
  const materialAttributes = new Set(['id', 'for', 'role', 'type', 'name', 'form', 'autocomplete', 'href', 'controls', 'tabindex', 'disabled', 'checked', 'selected', 'hidden', 'inert', 'contenteditable', 'open', 'alt', 'title', 'required', 'multiple', 'size', 'class', 'style', 'slot']);
  function materialMutations(records) {
    if (closed || pageChanged) return;
    if (records.length > 2000) { invalidate(); return; }
    for (const record of records) {
      if (isOwned(record.target)) continue;
      if (record.type === 'attributes') {
        const name = record.attributeName || '';
        if (materialAttributes.has(name) || name.startsWith('aria-') || /^(?:data-(?:audita-)?private|data-nosnippet|data-.*(?:password|secret|token|credential|api-key))$/iu.test(name)) {
          invalidate(); return;
        }
        continue;
      }
      const element = record.target?.nodeType === 1 ? record.target : record.target?.host || record.target?.parentNode;
      // These subtrees never contribute text or values to the recorded previews.
      if (element && parents(element).some(candidate => isPrivate(candidate) || isEditable(candidate) || nonContentTags.has(tagOf(candidate)))) continue;
      if (record.type === 'childList') {
        const changedNodes = [...(record.addedNodes || []), ...(record.removedNodes || [])];
        if (changedNodes.length && changedNodes.every(isOwned)) continue;
      }
      if (record.type === 'childList' || record.type === 'characterData') { invalidate(); return; }
    }
  }
  function changed() {
    if (!pageChanged && mutationObserver) materialMutations(mutationObserver.takeRecords());
    return pageChanged;
  }
  function ensureOverlay() {
    if (overlay?.isConnected !== false && overlay) return;
    overlay = document.createElement('div'); overlay.setAttribute('data-audita-tab-reading', ''); overlay.setAttribute('aria-hidden', 'true'); overlay.setAttribute('tabindex', '-1');
    overlay.style.setProperty('all', 'initial', 'important'); overlay.style.setProperty('position', 'fixed', 'important');
    overlay.style.setProperty('pointer-events', 'none', 'important'); overlay.style.setProperty('z-index', '2147483647', 'important');
    overlay.style.setProperty('inset', '0', 'important');
    const shadow = overlay.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = ':host{all:initial!important;pointer-events:none!important}.box{position:fixed;box-sizing:border-box;border:4px solid #ffbf47;outline:2px solid #10293a;border-radius:4px;pointer-events:none}.legend{position:fixed;left:12px;bottom:12px;max-width:min(640px,calc(100vw - 24px));padding:12px 16px;box-sizing:border-box;background:#10293a;color:white;border:2px solid #ffbf47;border-radius:6px;font:16px/1.4 system-ui,sans-serif;white-space:normal;overflow-wrap:anywhere;pointer-events:none}';
    box = document.createElement('div'); box.setAttribute('class', 'box');
    legend = document.createElement('div'); legend.setAttribute('class', 'legend');
    for (const node of [overlay, shadow, style, box, legend]) ownedNodes.add(node);
    shadow.appendChild(style); shadow.appendChild(box); shadow.appendChild(legend);
    (document.body || document.documentElement).appendChild(overlay);
    document.addEventListener('keydown', keyDown, true);
    document.addEventListener('input', stateEvent, true); document.addEventListener('change', stateEvent, true);
    root.addEventListener('scroll', reposition, true); root.addEventListener('resize', reposition, true);
  }
  function hideMarker() { current = null; if (box) box.style.setProperty('display', 'none'); if (legend) legend.textContent = pageChanged ? 'Página alterada; atualize a inspeção. Escape encerra os destaques.' : 'Foco fora dos elementos registrados. Escape encerra o acompanhamento.'; }
  function render(reference) {
    if (!validReference(reference)) { hideMarker(); return false; }
    current = reference; ensureOverlay();
    const rect = reference.element.getBoundingClientRect();
    if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) { hideMarker(); return false; }
    box.style.setProperty('display', rect.width > 0 && rect.height > 0 ? 'block' : 'none');
    for (const [property, value] of [['left', rect.left], ['top', rect.top], ['width', rect.width], ['height', rect.height]]) box.style.setProperty(property, `${value}px`);
    const entry = reference.entry;
    legend.textContent = `${entry.tabOrder ? `Tab ${entry.tabOrder}. ` : ''}${entry.preview}${entry.reasons.includes('aria-hidden') ? ' Atenção: oculto na árvore de acessibilidade.' : ''} — Prévia estimada. Escape encerra.`;
    return true;
  }
  function reposition() { if (current) render(current); }
  function stateEvent() { if (current) render(current); }
  function focusIn(event) {
    if (!observing || closed) return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    const reference = path.map(element => [...references.values()].find(candidate => candidate.element === element)).find(Boolean);
    if (reference) render(reference); else hideMarker();
  }
  function activeReference() {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return [...references.values()].find(candidate => candidate.element === element);
  }
  function keyDown(event) {
    if (event.key === 'Escape') { escapes += 1; clear(); return; }
    if (observing && event.key === 'Tab') {
      root.clearTimeout(scheduled);
      scheduled = root.setTimeout(() => { if (!closed) { const reference = activeReference(); if (reference) render(reference); else hideMarker(); } }, 0);
    }
  }
  function highlight(id) {
    const reference = references.get(id);
    if (!validReference(reference)) return reply(false, pageChanged ? 'page-changed' : 'stale-element');
    reference.element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
    return { ...reply(render(reference), 'highlighted'), escapes };
  }
  function observe() {
    if (expired()) { dispose(); return reply(false, 'session-unavailable'); }
    if (changed()) return reply(false, 'page-changed');
    if (!observing) { observing = true; document.addEventListener('focusin', focusIn, true); }
    ensureOverlay();
    const reference = activeReference(); if (reference) render(reference); else hideMarker();
    return reply(!pageChanged, pageChanged ? 'page-changed' : undefined);
  }
  const state = { sessionId: command.sessionId, document, clear, dispose, expired, changed, highlight, observe, escapes: () => escapes };
  root[key] = state;
  if (typeof root.MutationObserver === 'function') {
    mutationObserver = new root.MutationObserver(materialMutations);
    const options = { subtree: true, attributes: true, characterData: true, childList: true };
    mutationObserver.observe(document.documentElement, options);
    for (const element of elements) if (element.shadowRoot?.mode === 'open' && !isEditable(element)) mutationObserver.observe(element.shadowRoot, options);
  }
  for (const event of ['pagehide', 'beforeunload', 'popstate', 'hashchange']) root.addEventListener(event, dispose, true);
  timeout = root.setTimeout(dispose, LIFETIME);
  return { version: 1, sessionId: command.sessionId, entries, limitations: [...limitations], counts };
}
