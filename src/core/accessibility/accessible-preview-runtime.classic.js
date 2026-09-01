(function installAuditaAccessiblePreviewRuntime(root) {
  'use strict';

  var namespaceKey = Symbol.for('audita.accessible-preview.runtime.v1');
  var ownNamespace = Object.getOwnPropertyDescriptor(root, namespaceKey);
  if (ownNamespace) {
    var installed = Object.hasOwn(ownNamespace, 'value') ? ownNamespace.value : null;
    if (installed && installed.brand === 'audita-accessible-preview' && installed.version === 1 &&
      typeof installed.createRuntime === 'function') return;
    throw new Error('Conflito no namespace do runtime de prévia acessível.');
  }

  var NO_SOURCE = 'none';
  var MAX_TEXT = 2048;
  var MAX_REFERENCE_IDS = 16;
  var MAX_REFERENCE_ID = 128;
  var EMPTY_PROPERTIES = Object.freeze(Object.create(null));
  var screenReaderFactory = null;
  var contentFactory = null;
  var contentSingleton = null;

  var ROLE_LABELS = new Map([
    ['button', 'botão'], ['link', 'link'], ['checkbox', 'caixa de seleção'],
    ['radio', 'botão de opção'], ['textbox', 'campo de texto'],
    ['combobox', 'caixa de combinação'], ['listbox', 'caixa de listagem'],
    ['heading', 'cabeçalho'], ['img', 'imagem'], ['image', 'imagem'], ['region', 'região'],
    ['table', 'tabela'], ['list', 'lista'], ['listitem', 'item da lista'],
    ['switch', 'alternância'], ['tab', 'guia'], ['menuitem', 'item de menu'],
    ['progressbar', 'barra de progresso'], ['meter', 'medidor'],
    ['slider', 'controle deslizante'], ['spinbutton', 'campo numérico']
  ]);
  var CONTENT_NAME_TAGS = new Set(['a', 'button', 'label', 'legend', 'option', 'summary']);
  var CONTENT_NAME_ROLES = new Set([
    'button', 'checkbox', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'radio', 'switch', 'tab', 'treeitem'
  ]);
  var LABELABLE_TAGS = new Set(['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea']);
  var SENSITIVE_AUTOCOMPLETE = new Set(['current-password', 'new-password', 'one-time-code']);

  function normalizeText(value, limit) {
    if (typeof value !== 'string') return '';
    var normalized = value.replace(/\s+/gu, ' ').trim();
    var cap = Number.isSafeInteger(limit) && limit > 0 ? limit : MAX_TEXT;
    return Array.from(normalized).slice(0, cap).join('');
  }

  function ownDataValue(record, key) {
    if (!record || (typeof record !== 'object' && typeof record !== 'function')) return undefined;
    var descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(record, key); } catch (_error) { return undefined; }
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  }

  function attributesOf(node) {
    var attributes = ownDataValue(node, 'attributes');
    return attributes && typeof attributes === 'object' && !Array.isArray(attributes)
      ? attributes
      : EMPTY_PROPERTIES;
  }

  function attribute(node, name) {
    var value = ownDataValue(attributesOf(node), name);
    return typeof value === 'string' ? normalizeText(value, MAX_TEXT) : value === true ? '' : undefined;
  }

  function tagOf(node) {
    return normalizeText(ownDataValue(node, 'tagName'), 64).toLowerCase();
  }

  function isPrivate(node) {
    return ownDataValue(node, 'private') === true || Object.hasOwn(attributesOf(node), 'data-audita-private');
  }

  function isHidden(node) {
    var attributes = attributesOf(node);
    return ownDataValue(node, 'hidden') === true
      || Object.hasOwn(attributes, 'hidden')
      || ownDataValue(attributes, 'aria-hidden') === true
      || ownDataValue(attributes, 'aria-hidden') === 'true';
  }

  function isSnapshotIndexes(index) {
    return index && typeof index === 'object' && index.byNodeId instanceof Map && index.byDomId instanceof Map;
  }

  function nodesFromIndex(index) {
    if (isSnapshotIndexes(index)) return Array.from(index.byNodeId.values());
    if (index instanceof Map) return Array.from(index.values());
    if (Array.isArray(index)) return index;
    if (index && typeof index === 'object') return Object.values(index);
    return [];
  }

  function legacyId(node) {
    return normalizeText(ownDataValue(node, 'id'), MAX_REFERENCE_ID) || normalizeText(attribute(node, 'id'), MAX_REFERENCE_ID);
  }

  function findByNodeId(index, id) {
    if (id === null || id === undefined || id === '') return undefined;
    if (isSnapshotIndexes(index)) return index.byNodeId.get(String(id));
    if (index instanceof Map) return index.get(id);
    if (Array.isArray(index)) return index.find(function findNode(node) {
      return String(ownDataValue(node, 'nodeId') ?? legacyId(node)) === String(id);
    });
    if (index && typeof index === 'object') return ownDataValue(index, id) ?? nodesFromIndex(index).find(function findNode(node) {
      return String(ownDataValue(node, 'nodeId') ?? legacyId(node)) === String(id);
    });
    return undefined;
  }

  function findByDomId(index, id) {
    if (id === null || id === undefined || id === '') return undefined;
    if (isSnapshotIndexes(index)) {
      var matches = index.byDomId.get(id);
      return matches && matches.length === 1 ? matches[0] : undefined;
    }
    if (index instanceof Map) return index.get(id);
    if (Array.isArray(index)) return index.find(function findNode(node) { return legacyId(node) === id; });
    if (index && typeof index === 'object') return ownDataValue(index, id) ?? nodesFromIndex(index).find(function findNode(node) {
      return legacyId(node) === id;
    });
    return undefined;
  }

  function hasAttribute(node, name) {
    return Object.hasOwn(attributesOf(node), name);
  }

  function textFromContents(node, index, allowHidden, visiting) {
    var seen = visiting || new Set();
    if (!node || isPrivate(node) || (!allowHidden && isHidden(node)) || seen.has(node)) return '';
    var nextVisiting = new Set(seen);
    nextVisiting.add(node);
    var ownText = normalizeText(ownDataValue(node, 'text'));
    var children = ownDataValue(node, 'children');
    var childText = Array.isArray(children)
      ? children.slice(0, 512).map(function childName(child) {
        var childNode = child && typeof child === 'object' ? child : findByNodeId(index, child);
        return textFromContents(childNode, index, allowHidden, nextVisiting);
      }).filter(Boolean).join(' ')
      : '';
    return normalizeText([ownText, childText].filter(Boolean).join(' '));
  }

  function roleOf(node) {
    return normalizeText(attribute(node, 'role'), 64).toLowerCase();
  }

  function isLabelable(node) {
    var tag = tagOf(node);
    return LABELABLE_TAGS.has(tag) && !(tag === 'input' && normalizeText(attribute(node, 'type'), 64).toLowerCase() === 'hidden');
  }

  function acceptsContents(node, fromReference) {
    if (fromReference) return true;
    var role = roleOf(node);
    return role ? CONTENT_NAME_ROLES.has(role) : CONTENT_NAME_TAGS.has(tagOf(node));
  }

  function axText(axNode, property) {
    if (!axNode || typeof axNode !== 'object') return '';
    var candidate = ownDataValue(axNode, property);
    if (typeof candidate === 'string') return normalizeText(candidate);
    if (candidate && typeof candidate === 'object') return normalizeText(ownDataValue(candidate, 'value'));
    return '';
  }

  function resolveReferences(ids, index, visiting) {
    var parts = [];
    var tokens = normalizeText(ids).split(' ').slice(0, MAX_REFERENCE_IDS);
    for (var position = 0; position < tokens.length; position += 1) {
      var id = normalizeText(tokens[position], MAX_REFERENCE_ID);
      if (!id) continue;
      var referenced = findByDomId(index, id);
      if (!referenced || isPrivate(referenced) || visiting.has(referenced)) continue;
      var text = fallbackName(referenced, index, new Set(visiting), true, true).value;
      if (text) parts.push(text);
    }
    return normalizeText(parts.join(' '));
  }

  function nativeLabelText(node, index, visiting) {
    if (!isLabelable(node)) return '';
    var labels = ownDataValue(node, 'labels');
    var safeLabels = Array.isArray(labels) ? labels.slice(0, MAX_REFERENCE_IDS) : [];
    var fromLabels = safeLabels.map(function labelName(label) {
      if (typeof label === 'string' || Number.isSafeInteger(label)) {
        var referenced = isSnapshotIndexes(index) ? findByNodeId(index, label) : findByDomId(index, label);
        return referenced && !isPrivate(referenced)
          ? fallbackName(referenced, index, new Set(visiting), true, true).value
          : '';
      }
      return label && !isPrivate(label)
        ? fallbackName(label, index, new Set(visiting), true, true).value
        : '';
    }).filter(Boolean);
    var id = normalizeText(attribute(node, 'id'), MAX_REFERENCE_ID) || (!isSnapshotIndexes(index) ? normalizeText(ownDataValue(node, 'id'), MAX_REFERENCE_ID) : '');
    var matches = isSnapshotIndexes(index) && id ? index.byDomId.get(id) : null;
    var uniqueTarget = !isSnapshotIndexes(index) || (matches && matches.length === 1);
    var fromFor = id && uniqueTarget
      ? nodesFromIndex(index).filter(function isMatchingLabel(candidate) {
        return !isPrivate(candidate) && tagOf(candidate) === 'label' && attribute(candidate, 'for') === id;
      }).slice(0, MAX_REFERENCE_IDS).map(function labelName(label) {
        return fallbackName(label, index, new Set(visiting), true, true).value;
      }).filter(Boolean)
      : [];
    return normalizeText(fromLabels.concat(fromFor).join(' '));
  }

  function fallbackName(node, index, visiting, allowHiddenRoot, fromReference) {
    var seen = visiting || new Set();
    if (!node || isPrivate(node) || (!allowHiddenRoot && isHidden(node))) return { value: '', source: NO_SOURCE };
    if (seen.has(node)) return { value: '', source: NO_SOURCE };
    var nextVisiting = new Set(seen);
    nextVisiting.add(node);
    var labelledBy = attribute(node, 'aria-labelledby');
    if (labelledBy) {
      var referenced = resolveReferences(labelledBy, index, nextVisiting);
      if (referenced) return { value: referenced, source: 'aria-labelledby' };
    }
    var ariaLabel = normalizeText(attribute(node, 'aria-label'));
    if (ariaLabel) return { value: ariaLabel, source: 'aria-label' };
    var nativeLabel = nativeLabelText(node, index, nextVisiting);
    if (nativeLabel) return { value: nativeLabel, source: 'label' };
    var isImageInput = tagOf(node) === 'input' && normalizeText(attribute(node, 'type'), 64).toLowerCase() === 'image';
    if (hasAttribute(node, 'alt') && (['area', 'img'].includes(tagOf(node)) || isImageInput)) {
      return { value: normalizeText(attribute(node, 'alt')), source: 'alt' };
    }
    if (acceptsContents(node, fromReference)) {
      var contents = textFromContents(node, index, Boolean(allowHiddenRoot && isHidden(node)));
      if (contents) return { value: contents, source: 'contents' };
    }
    var title = normalizeText(attribute(node, 'title'));
    if (title) return { value: title, source: 'title' };
    return { value: '', source: NO_SOURCE };
  }

  function fallbackDescription(node, index, finalName) {
    var describedBy = attribute(node, 'aria-describedby');
    if (describedBy) {
      var value = resolveReferences(describedBy, index, new Set([node]));
      if (value) return { value: value, source: 'aria-describedby' };
    }
    var title = normalizeText(attribute(node, 'title'));
    if (title && title !== finalName) return { value: title, source: 'title' };
    return { value: '', source: NO_SOURCE };
  }

  function computeAccessibleText(node, index, axNode) {
    if (isPrivate(node)) return { name: '', nameSource: NO_SOURCE, description: '', descriptionSource: NO_SOURCE };
    var axName = axText(axNode, 'name');
    var axDescription = axText(axNode, 'description');
    var fallback = fallbackName(node, index);
    var name = axName || fallback.value;
    var description = fallbackDescription(node, index, name);
    return {
      name: name,
      nameSource: axName ? 'accessibility-tree' : fallback.source,
      description: axDescription || description.value,
      descriptionSource: axDescription ? 'accessibility-tree' : description.source
    };
  }

  function propertiesOf(input) {
    return input !== null && typeof input === 'object' && !Array.isArray(input) ? input : EMPTY_PROPERTIES;
  }

  function ownProperty(properties, key) {
    return ownDataValue(properties, key);
  }

  function previewText(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    return normalizeText(String(value)).replace(/[,:;.]+$/u, '').trim();
  }

  function observedState(properties) {
    var states = [];
    var checked = ownProperty(properties, 'checked');
    var selected = ownProperty(properties, 'selected');
    var expanded = ownProperty(properties, 'expanded');
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

  function mayDiscloseValue(properties) {
    if (ownProperty(properties, 'valueDisclosure') !== 'safe') return false;
    if (ownProperty(properties, 'sensitive') === true) return false;
    var inputType = previewText(ownProperty(properties, 'inputType') ?? ownProperty(properties, 'type')).toLowerCase();
    if (inputType === 'password') return false;
    var autocomplete = previewText(ownProperty(properties, 'autocomplete')).toLowerCase().split(' ');
    return !autocomplete.some(function isSensitive(token) { return SENSITIVE_AUTOCOMPLETE.has(token); });
  }

  function buildAnnouncementPreview(properties) {
    var safeProperties = propertiesOf(properties === undefined ? {} : properties);
    var role = ROLE_LABELS.get(ownProperty(safeProperties, 'role'));
    var value = mayDiscloseValue(safeProperties) ? previewText(ownProperty(safeProperties, 'value')) : '';
    var rawLevel = ownProperty(safeProperties, 'level');
    var level = Number.isInteger(rawLevel) && rawLevel > 0 ? `nível ${rawLevel}` : '';
    var parts = [
      previewText(ownProperty(safeProperties, 'name')), role,
      previewText(ownProperty(safeProperties, 'description')),
      value && `valor ${value}`, level
    ].concat(observedState(safeProperties)).filter(Boolean);
    var seen = new Set();
    var uniqueParts = parts.filter(function unique(part) {
      var key = part.toLocaleLowerCase('pt-BR');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { text: normalizeText(uniqueParts.join(', ')), kind: 'preview', locale: 'pt-BR' };
  }

  var limits = Object.assign(Object.create(null), {
    maxText: MAX_TEXT, maxReferenceIds: MAX_REFERENCE_IDS, maxReferenceId: MAX_REFERENCE_ID
  });
  Object.freeze(limits);
  var runtime = Object.assign(Object.create(null), {
    computeAccessibleText: computeAccessibleText,
    buildAnnouncementPreview: buildAnnouncementPreview,
    limits: limits
  });
  Object.freeze(runtime);

  function registerFactory(kind, factory) {
    if (typeof factory !== 'function') throw new TypeError('Fábrica de persona inválida.');
    if (kind === 'reader') {
      if (!screenReaderFactory) screenReaderFactory = factory;
      return screenReaderFactory;
    }
    if (!contentFactory) contentFactory = factory;
    return contentFactory;
  }

  function createRegisteredFactory(kind, options) {
    var factory = kind === 'reader' ? screenReaderFactory : contentFactory;
    if (!factory) throw new Error('Fábrica de persona não registrada.');
    return factory(options);
  }

  var namespace = Object.assign(Object.create(null), {
    brand: 'audita-accessible-preview',
    version: 1,
    createRuntime: function createRuntime() { return runtime; },
    registerScreenReaderFactory: function registerScreenReaderFactory(factory) { return registerFactory('reader', factory); },
    createScreenReaderModule: function createScreenReaderModule(options) { return createRegisteredFactory('reader', options); },
    registerContentFactory: function registerContentFactory(factory) { return registerFactory('content', factory); },
    createContentRuntime: function createContentRuntime(options) { return createRegisteredFactory('content', options); },
    getContentSingleton: function getContentSingleton() { return contentSingleton; },
    setContentSingleton: function setContentSingleton(singleton) {
      if (!contentSingleton) contentSingleton = singleton;
      return contentSingleton;
    }
  });
  Object.freeze(namespace);
  Object.defineProperty(root, namespaceKey, {
    value: namespace,
    enumerable: false,
    configurable: false,
    writable: false
  });
})(globalThis);
