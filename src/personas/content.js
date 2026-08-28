(function registerAuditaPersonaContent(root) {
  'use strict';

  var namespaceKey = Symbol.for('audita.accessible-preview.runtime.v1');
  var descriptor = Object.getOwnPropertyDescriptor(root, namespaceKey);
  var namespace = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
  if (!namespace || namespace.brand !== 'audita-accessible-preview' || namespace.version !== 1 ||
    typeof namespace.registerContentFactory !== 'function') {
    throw new Error('Runtime de prévia acessível ausente ou incompatível.');
  }

  namespace.registerContentFactory(function createContentRuntime(environment) {
    if (!environment || typeof environment !== 'object' || !environment.document) {
      throw new TypeError('Ambiente de conteúdo da persona inválido.');
    }
    var document = environment.document;
    var windowObject = environment.window || document.defaultView || root;
    var previewRuntime = namespace.createRuntime();
    var speechSynthesis = environment.speechSynthesis === null
      ? null
      : (environment.speechSynthesis || windowObject.speechSynthesis || null);
    var Utterance = environment.Utterance || windowObject.SpeechSynthesisUtterance || root.SpeechSynthesisUtterance;
    var now = typeof environment.now === 'function' ? environment.now : Date.now;
    var emitEvent = typeof environment.emitEvent === 'function' ? environment.emitEvent : function noop() {};
    var MutationObserverConstructor = environment.MutationObserver || windowObject.MutationObserver || root.MutationObserver;
    var activeMode = null;
    var reader = null;
    var readerState = idleReaderState();
    var currentReaderElement = null;
    var readerCandidateElements = new Set();
    var suppressReaderEvents = false;
    var limitations = [];
    var ownedClasses = new Set();
    var ownsRootAttribute = false;
    var artifacts = [];
    var artifactIdentities = new WeakSet();
    var artifactMetadata = new WeakMap();
    var cleanupListeners = [];
    var pointerSequenceUntil = 0;
    var escapeCount = 0;
    var lastEscapeAt = 0;
    var destroyed = false;
    var messagingCleanup = null;
    var eventPort = null;
    var eventCounter = 0;
    var session = null;
    var seenRequests = new Set();
    var discoveryMetrics = null;

    function dispatchPersonaEvent(event) {
      try { emitEvent(event); } catch (_error) { /* injected observer is optional */ }
      if (!eventPort || !session) return;
      var state = event?.event === 'state' ? {
        activeMode: event.activeMode,
        reader: sanitizeReaderState(event.reader),
        limitations: getLimitations(),
        coverage: 'dom-fallback-top-document-open-shadow'
      } : undefined;
      try {
        eventPort.postMessage({
          protocol: 'audita-persona-content', version: 1, type: 'event',
          event: event?.event === 'state' ? 'state' : String(event?.event || 'lifecycle-stop').slice(0, 64),
          eventId: `event-${++eventCounter}`, token: session.token,
          generation: session.generation, documentId: session.documentId,
          ...(state ? { state: state } : {})
        });
      } catch (_error) { /* local emergency cleanup never depends on the worker */ }
    }

    var ALLOWED_ATTRIBUTES = [
      'id', 'aria-labelledby', 'aria-describedby', 'aria-label', 'role', 'title',
      'alt', 'type', 'href', 'for', 'hidden', 'disabled', 'inert', 'contenteditable',
      'autocomplete', 'aria-hidden', 'aria-disabled', 'aria-checked', 'aria-selected',
      'aria-expanded', 'aria-required', 'aria-invalid', 'aria-level', 'aria-valuenow',
      'value', 'controls', 'tabindex', 'sandbox'
    ];
    var MATERIAL_ATTRIBUTES = [
      'id', 'class', 'style', 'hidden', 'inert', 'disabled', 'tabindex',
      'data-audita-private', 'contenteditable', 'alt', 'title', 'role', 'href',
      'controls', 'value', 'for', 'type'
    ];
    var ROOT_OWNERSHIP_ATTRIBUTE = 'data-audita-persona-root';
    var ROOT_OWNERSHIP_VALUE = 'audita-accessible-preview-v1';
    var MODE_CLASSES = ['audita-persona-reader', 'audita-persona-achromatopsia', 'audita-persona-motor'];
    var ARTIFACT_CLASSES = ['audita-persona-reader-overlay', 'audita-persona-reader-marker'];

    function idleReaderState() {
      return {
        playback: 'idle', index: -1, total: 0, caption: '', canPrevious: false,
        canNext: false, speechAvailability: speechSynthesis ? 'available' : 'unavailable',
        voiceId: '', rate: 1
      };
    }

    function textValue(value, limit) {
      if (typeof value !== 'string') return '';
      return Array.from(value.replace(/\s+/gu, ' ').trim()).slice(0, limit || 2048).join('');
    }

    function tagOf(element) {
      return textValue(element?.tagName, 64).toLowerCase();
    }

    function attribute(element, name) {
      if (!element || typeof element.getAttribute !== 'function') return null;
      try {
        var value = element.getAttribute(name);
        return value === null ? null : textValue(String(value), 2048);
      } catch (_error) { return null; }
    }

    function hasAttribute(element, name) {
      try { return Boolean(element && typeof element.hasAttribute === 'function' && element.hasAttribute(name)); }
      catch (_error) { return false; }
    }

    function parentElementOf(element) {
      if (!element) return null;
      if (element.assignedSlot) return element.assignedSlot;
      if (element.parentElement) return element.parentElement;
      try { return element.getRootNode?.()?.host || null; } catch (_error) { return null; }
    }

    function ancestors(element) {
      var result = [];
      var current = element;
      var seen = new Set();
      while (current && !seen.has(current)) {
        seen.add(current);
        result.push(current);
        current = parentElementOf(current);
      }
      return result;
    }

    function isEditableSelf(element) {
      var tag = tagOf(element);
      if (['input', 'select', 'textarea'].includes(tag)) return true;
      var role = (attribute(element, 'role') || '').toLowerCase();
      if (['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(role)) return true;
      var autocomplete = (attribute(element, 'autocomplete') || '').toLowerCase().split(/\s+/u);
      if (autocomplete.some(function sensitive(token) {
        return ['current-password', 'new-password', 'one-time-code'].includes(token);
      })) return true;
      if (!hasAttribute(element, 'contenteditable')) return false;
      var editable = (attribute(element, 'contenteditable') || '').toLowerCase();
      return !['false', 'inherit'].includes(editable);
    }

    function isTaintedByAncestry(element) {
      return ancestors(element).some(function tainted(ancestor) {
        return hasAttribute(ancestor, 'data-audita-private') || isEditableSelf(ancestor) ||
          ancestor.hidden === true || hasAttribute(ancestor, 'hidden') || hasAttribute(ancestor, 'inert') ||
          (attribute(ancestor, 'aria-hidden') || '').toLowerCase() === 'true';
      });
    }

    function childElements(container, includeLightWithShadow) {
      if (!container) return [];
      var element = container.nodeType === 1 ? container : null;
      if (element && tagOf(element) === 'slot' && typeof element.assignedElements === 'function') {
        try {
          var assigned = element.assignedElements({ flatten: true });
          if (Array.isArray(assigned) && assigned.length) return boundedElements(assigned, 2000);
        } catch (_error) { /* fall through to ordinary children */ }
      }
      if (element && !includeLightWithShadow && element.shadowRoot && element.shadowRoot.mode === 'open') {
        return boundedElements(element.shadowRoot.children || [], 2000);
      }
      return boundedElements(container.children || [], 2000);
    }

    function boundedElements(collection, limit) {
      var values = Array.from(collection || []);
      if (discoveryMetrics && values.length > limit) {
        discoveryMetrics.truncated = true;
        discoveryMetrics.count = Math.min(10000, discoveryMetrics.count + values.length - limit);
      }
      return values.slice(0, limit);
    }

    function recordTraversalCut(count) {
      if (!discoveryMetrics || count < 1) return;
      discoveryMetrics.truncated = true;
      discoveryMetrics.count = Math.min(10000, discoveryMetrics.count + count);
    }

    function walkComposed() {
      var result = [];
      var seen = new Set();
      function visit(element) {
        if (!element || element.nodeType !== 1 || seen.has(element)) return;
        if (result.length >= 5000) {
          recordTraversalCut(1);
          return;
        }
        seen.add(element);
        result.push(element);
        var children = childElements(element, false);
        for (var position = 0; position < children.length; position += 1) visit(children[position]);
      }
      var roots = childElements(document, true);
      for (var position = 0; position < roots.length; position += 1) visit(roots[position]);
      return result;
    }

    function walkAllOpenDom() {
      var result = [];
      var seen = new Set();
      function visit(element) {
        if (!element || element.nodeType !== 1 || seen.has(element)) return;
        if (result.length >= 5000) {
          recordTraversalCut(1);
          return;
        }
        seen.add(element);
        result.push(element);
        for (var light of childElements(element, true)) visit(light);
        if (element.shadowRoot && element.shadowRoot.mode === 'open') {
          for (var shadow of boundedElements(element.shadowRoot.children || [], 2000)) visit(shadow);
        }
      }
      for (var rootElement of childElements(document, true)) visit(rootElement);
      return result;
    }

    function referencedIds(element) {
      var ids = [];
      for (var name of ['aria-labelledby', 'aria-describedby']) {
        var value = attribute(element, name);
        if (value) ids.push.apply(ids, value.split(/\s+/u).slice(0, 16));
      }
      return ids.filter(function valid(id) { return id && Array.from(id).length <= 128; });
    }

    function createTaintSet(elements) {
      var tainted = new Set(elements.filter(isTaintedByAncestry));
      var byId = new Map();
      var labelsByTargetId = new Map();
      for (var element of elements) {
        var id = attribute(element, 'id');
        if (id) {
          if (!byId.has(id)) byId.set(id, []);
          byId.get(id).push(element);
        }
        if (tagOf(element) === 'label') {
          var targetId = attribute(element, 'for');
          if (targetId) {
            if (!labelsByTargetId.has(targetId)) labelsByTargetId.set(targetId, []);
            labelsByTargetId.get(targetId).push(element);
          }
        }
      }

      var pending = Array.from(tainted);
      var processed = new Set();
      function addTainted(element) {
        if (!element || tainted.has(element) || tainted.size >= 5000) return;
        tainted.add(element);
        pending.push(element);
      }
      while (pending.length && processed.size < 5000) {
        var source = pending.shift();
        if (!source || processed.has(source)) continue;
        processed.add(source);
        for (var child of childElements(source, true)) addTainted(child);
        if (source.shadowRoot && source.shadowRoot.mode === 'open') {
          for (var shadowChild of Array.from(source.shadowRoot.children || []).slice(0, 2000)) addTainted(shadowChild);
        }
        if (tagOf(source) === 'slot' && typeof source.assignedElements === 'function') {
          try {
            for (var assigned of source.assignedElements({ flatten: true }).slice(0, 2000)) addTainted(assigned);
          } catch (_error) { /* uma distribuição inacessível permanece excluída pelo slot privado */ }
        }
        for (var referencedId of referencedIds(source)) {
          for (var referenced of byId.get(referencedId) || []) addTainted(referenced);
        }
        var sourceId = attribute(source, 'id');
        if (sourceId) {
          for (var label of labelsByTargetId.get(sourceId) || []) addTainted(label);
        }
      }
      return tainted;
    }

    function directText(element, tainted) {
      if (tainted.has(element)) return '';
      var parts = [];
      for (var node of Array.from(element.childNodes || []).slice(0, 512)) {
        if (node?.nodeType !== 3) continue;
        var value;
        try { value = node.nodeValue; } catch (_error) { return ''; }
        var normalized = textValue(value, 2048);
        if (normalized) parts.push(normalized);
      }
      return textValue(parts.join(' '), 2048);
    }

    function createSnapshotIndexes(elements, tainted) {
      var byElement = new Map();
      var byNodeId = new Map();
      var byDomId = new Map();
      for (var position = 0; position < elements.length; position += 1) {
        var element = elements[position];
        var attributes = Object.create(null);
        var isTainted = tainted.has(element);
        for (var name of ALLOWED_ATTRIBUTES) {
          if (isTainted && !['id', 'data-audita-private'].includes(name)) continue;
          if (!hasAttribute(element, name)) continue;
          var value = attribute(element, name);
          attributes[name] = value === null ? '' : value;
        }
        var snapshot = Object.assign(Object.create(null), {
          nodeId: `persona-${position + 1}`,
          tagName: tagOf(element),
          attributes: attributes,
          private: isTainted,
          hidden: element.hidden === true,
          text: directText(element, tainted),
          children: []
        });
        byElement.set(element, snapshot);
        byNodeId.set(snapshot.nodeId, snapshot);
        var domId = attribute(element, 'id');
        if (domId) {
          if (!byDomId.has(domId)) byDomId.set(domId, []);
          byDomId.get(domId).push(snapshot);
        }
      }
      for (var element of elements) {
        var snapshot = byElement.get(element);
        if (snapshot.private) continue;
        snapshot.children = childElements(element, false).map(function childSnapshot(child) {
          return byElement.get(child);
        }).filter(Boolean).slice(0, 512);
      }
      return { byElement: byElement, indexes: { byNodeId: byNodeId, byDomId: byDomId } };
    }

    function hiddenOrInert(element) {
      return ancestors(element).some(function excluded(ancestor) {
        if (ancestor.hidden === true || hasAttribute(ancestor, 'hidden') || hasAttribute(ancestor, 'inert')) return true;
        if ((attribute(ancestor, 'aria-hidden') || '').toLowerCase() === 'true') return true;
        try {
          var style = windowObject.getComputedStyle?.(ancestor);
          return style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse';
        } catch (_error) { return true; }
      });
    }

    function disabled(element) {
      return element.disabled === true || hasAttribute(element, 'disabled') ||
        (attribute(element, 'aria-disabled') || '').toLowerCase() === 'true';
    }

    function usefulGeometry(element) {
      try {
        var rect = element.getBoundingClientRect();
        var rects = element.getClientRects?.();
        return Number.isFinite(rect?.width) && Number.isFinite(rect?.height) && rect.width > 0 && rect.height > 0 &&
          (!rects || rects.length > 0);
      } catch (_error) { return false; }
    }

    function tabIndexOf(element) {
      var raw = attribute(element, 'tabindex');
      if (raw !== null && /^[-+]?\d+$/u.test(raw)) return Number(raw);
      var value = element.tabIndex;
      return Number.isInteger(value) ? value : -1;
    }

    function nativeFocusable(element) {
      var tag = tagOf(element);
      if (tag === 'a' || tag === 'area') return hasAttribute(element, 'href');
      if (['button', 'summary'].includes(tag)) return true;
      if (['audio', 'video'].includes(tag)) return hasAttribute(element, 'controls');
      return false;
    }

    function nativeRole(element) {
      var explicit = (attribute(element, 'role') || '').toLowerCase();
      if (explicit) return explicit;
      var tag = tagOf(element);
      if (tag === 'button' || tag === 'summary') return 'button';
      if ((tag === 'a' || tag === 'area') && hasAttribute(element, 'href')) return 'link';
      if (tag === 'progress') return 'progressbar';
      if (tag === 'meter') return 'meter';
      if (/^h[1-6]$/u.test(tag)) return 'heading';
      return '';
    }

    function booleanState(element, name, property) {
      var value = (attribute(element, name) || '').toLowerCase();
      if (value === 'true') return true;
      if (value === 'false') return false;
      if (property === 'checked' && value === 'mixed') return 'mixed';
      return undefined;
    }

    function safeValue(element, role) {
      var tag = tagOf(element);
      if (['meter', 'progress'].includes(tag)) return attribute(element, 'value') || '';
      if (['meter', 'progressbar'].includes(role)) return attribute(element, 'aria-valuenow') || '';
      return '';
    }

    function frameLimitations(elements) {
      var counts = new Map();
      for (var frame of elements.filter(function iframe(element) { return tagOf(element) === 'iframe'; })) {
        // Every frame is deliberately uninspected in this release. Only the
        // fixed sandbox signal is observed; URLs and frame DOM never cross.
        var code = hasAttribute(frame, 'sandbox') ? 'frame-sandboxed' : 'frame-uncoordinated';
        counts.set(code, (counts.get(code) || 0) + 1);
      }
      return Array.from(counts.entries()).sort(function byCode(a, b) { return a[0].localeCompare(b[0], 'en'); })
        .map(function limitation(entry) { return { code: entry[0], count: entry[1] }; });
    }

    function collectReaderCandidates() {
      discoveryMetrics = { count: 0, truncated: false };
      var traversal = walkComposed();
      var allElements = walkAllOpenDom();
      var tainted = createTaintSet(allElements);
      var snapshots = createSnapshotIndexes(allElements, tainted);
      limitations = frameLimitations(allElements);
      var candidates = [];
      var position = 0;
      for (; position < traversal.length && candidates.length < 2000; position += 1) {
        var element = traversal[position];
        if (tagOf(element) === 'iframe' || tainted.has(element) || hiddenOrInert(element) || disabled(element) || !usefulGeometry(element)) continue;
        var tabIndex = tabIndexOf(element);
        if (tabIndex < 0 || (!nativeFocusable(element) && tabIndex === -1)) continue;
        var snapshot = snapshots.byElement.get(element);
        if (!snapshot) continue;
        var accessible = previewRuntime.computeAccessibleText(snapshot, snapshots.indexes);
        var role = nativeRole(element);
        var value = safeValue(element, role);
        var level = /^h[1-6]$/u.test(tagOf(element)) ? Number(tagOf(element).slice(1)) : Number(attribute(element, 'aria-level'));
        var preview = previewRuntime.buildAnnouncementPreview({
          name: accessible.name,
          description: accessible.description,
          role: role,
          checked: booleanState(element, 'aria-checked', 'checked'),
          selected: booleanState(element, 'aria-selected', 'selected'),
          expanded: booleanState(element, 'aria-expanded', 'expanded'),
          required: booleanState(element, 'aria-required', 'required'),
          invalid: booleanState(element, 'aria-invalid', 'invalid'),
          value: value,
          valueDisclosure: value ? 'safe' : undefined,
          level: Number.isInteger(level) && level > 0 ? level : undefined
        });
        if (!preview.text) continue;
        candidates.push({
          element: element,
          caption: preview.text,
          tabIndex: tabIndex,
          traversalIndex: position
        });
      }
      if (position < traversal.length) recordTraversalCut(traversal.length - position);
      if (discoveryMetrics.truncated) {
        limitations.push({
          code: 'dom-traversal-truncated',
          count: Math.max(1, discoveryMetrics.count),
          truncated: true
        });
      }
      discoveryMetrics = null;
      candidates.sort(function keyboardOrder(first, second) {
        var firstPositive = first.tabIndex > 0;
        var secondPositive = second.tabIndex > 0;
        if (firstPositive !== secondPositive) return firstPositive ? -1 : 1;
        if (firstPositive && first.tabIndex !== second.tabIndex) return first.tabIndex - second.tabIndex;
        return first.traversalIndex - second.traversalIndex;
      });
      var publicCandidates = candidates.map(function publicCandidate(candidate) {
        return { element: candidate.element, caption: candidate.caption };
      });
      readerCandidateElements = new Set(publicCandidates.map(function candidateElement(candidate) { return candidate.element; }));
      return publicCandidates;
    }

    function addOwnedClass(name) {
      var rootElement = document.documentElement;
      if (!ownsRootAttribute || rootElement?.classList?.contains(name)) return false;
      rootElement?.classList?.add(name);
      if (!rootElement?.classList?.contains(name)) return false;
      ownedClasses.add(name);
      return true;
    }

    function removeOwnedClasses() {
      for (var name of ownedClasses) document.documentElement?.classList?.remove(name);
      ownedClasses.clear();
    }

    function acquireRootOwnership() {
      var rootElement = document.documentElement;
      if (!rootElement || hasAttribute(rootElement, ROOT_OWNERSHIP_ATTRIBUTE) ||
        MODE_CLASSES.some(function collidingClass(name) { return rootElement.classList?.contains(name); })) return false;
      if (!proveNoPersonaCollision()) return false;
      try { rootElement.setAttribute(ROOT_OWNERSHIP_ATTRIBUTE, ROOT_OWNERSHIP_VALUE); }
      catch (_error) { return false; }
      ownsRootAttribute = attribute(rootElement, ROOT_OWNERSHIP_ATTRIBUTE) === ROOT_OWNERSHIP_VALUE;
      if (!ownsRootAttribute) {
        try { rootElement.removeAttribute(ROOT_OWNERSHIP_ATTRIBUTE); } catch (_error) { /* remain fail-closed */ }
      }
      return ownsRootAttribute;
    }

    function proveNoPersonaCollision() {
      var pending = [];
      var seen = new Set();
      var queued = new Set();
      function appendBounded(collection) {
        try {
          for (var element of collection || []) {
            if (!element || seen.has(element) || queued.has(element)) continue;
            pending.push(element);
            queued.add(element);
            if (seen.size + pending.length > 5000) return false;
          }
          return true;
        } catch (_error) { return false; }
      }
      if (!appendBounded(document.children || [])) return false;
      while (pending.length) {
        var element = pending.shift();
        queued.delete(element);
        if (!element || element.nodeType !== 1 || seen.has(element)) continue;
        seen.add(element);
        if (hasAttribute(element, 'data-audita-persona-owned') ||
          ARTIFACT_CLASSES.some(function collidingArtifact(name) { return element.classList?.contains(name); })) return false;
        if (!appendBounded(element.children || [])) return false;
        if (element.shadowRoot && element.shadowRoot.mode === 'open' &&
          !appendBounded(element.shadowRoot.children || [])) return false;
      }
      return true;
    }

    function releaseRootOwnership() {
      if (!ownsRootAttribute) return;
      var rootElement = document.documentElement;
      if (attribute(rootElement, ROOT_OWNERSHIP_ATTRIBUTE) === ROOT_OWNERSHIP_VALUE) {
        try { rootElement.removeAttribute(ROOT_OWNERSHIP_ATTRIBUTE); } catch (_error) { /* detached page */ }
      }
      ownsRootAttribute = false;
    }

    function createArtifact(className) {
      var node = document.createElement('div');
      node.classList?.add(className);
      node.setAttribute('data-audita-persona-owned', ROOT_OWNERSHIP_VALUE);
      node.setAttribute('aria-hidden', 'true');
      node.setAttribute('tabindex', '-1');
      (document.body || document.documentElement).appendChild(node);
      artifacts.push(node);
      artifactIdentities.add(node);
      artifactMetadata.set(node, { className: className, style: attribute(node, 'style') });
      return node;
    }

    function ensureReaderArtifacts() {
      if (artifacts.length) return;
      createArtifact('audita-persona-reader-overlay');
      createArtifact('audita-persona-reader-marker');
    }

    function removeArtifacts() {
      for (var artifact of artifacts) {
        try { artifact.remove(); } catch (_error) { /* detached page */ }
        artifactIdentities.delete(artifact);
        artifactMetadata.delete(artifact);
      }
      artifacts = [];
    }

    function sanitizeReaderState(value) {
      var safe = value && typeof value === 'object' ? value : idleReaderState();
      return {
        playback: ['idle', 'playing', 'paused'].includes(safe.playback) ? safe.playback : 'idle',
        index: Number.isSafeInteger(safe.index) ? safe.index : -1,
        total: Number.isSafeInteger(safe.total) ? safe.total : 0,
        caption: textValue(safe.caption, 2048),
        canPrevious: safe.canPrevious === true,
        canNext: safe.canNext === true,
        speechAvailability: textValue(safe.speechAvailability, 32) || 'unavailable',
        voiceId: textValue(safe.voiceId, 200),
        rate: Math.max(0.5, Math.min(2, Number(safe.rate) || 1))
      };
    }

    function publishReader(value) {
      readerState = sanitizeReaderState(value);
      if (!suppressReaderEvents) {
        dispatchPersonaEvent({ event: 'state', activeMode: activeMode, reader: readerState, limitations: getLimitations() });
      }
    }

    function createReader() {
      return namespace.createScreenReaderModule({
        collectCandidates: collectReaderCandidates,
        activeElement: function activeElement() { return document.activeElement; },
        isSafeElement: function isSafeElement(element) {
          return Boolean(element?.isConnected !== false && !isTaintedByAncestry(element) && !hiddenOrInert(element));
        },
        focus: function focus(element, options) { element.focus(options); },
        restoreFocus: function restoreFocus(element, options) { element.focus(options); },
        render: function render(current) {
          ensureReaderArtifacts();
          currentReaderElement = current?.element || null;
          var marker = artifacts[1];
          if (!marker) return;
          if (!current?.element) {
            marker.style?.removeProperty?.('display');
            rememberArtifactStyle(marker);
            return;
          }
          var rect;
          try { rect = current.element.getBoundingClientRect(); } catch (_error) { return; }
          marker.style?.setProperty?.('--audita-marker-x', `${Math.max(0, rect.left ?? rect.x ?? 0)}px`);
          marker.style?.setProperty?.('--audita-marker-y', `${Math.max(0, rect.top ?? rect.y ?? 0)}px`);
          marker.style?.setProperty?.('--audita-marker-width', `${Math.max(1, rect.width ?? 1)}px`);
          marker.style?.setProperty?.('--audita-marker-height', `${Math.max(1, rect.height ?? 1)}px`);
          rememberArtifactStyle(marker);
        },
        publish: publishReader,
        onFocus: function onFocus(listener) {
          var handler = function focusIn(event) { listener(event.target); };
          document.addEventListener('focusin', handler, true);
          return function removeFocus() { document.removeEventListener('focusin', handler, true); };
        },
        onVoicesChanged: function onVoicesChanged(listener) {
          if (!speechSynthesis?.addEventListener) return function noop() {};
          speechSynthesis.addEventListener('voiceschanged', listener);
          return function removeVoices() { speechSynthesis.removeEventListener?.('voiceschanged', listener); };
        },
        speechSynthesis: speechSynthesis,
        Utterance: Utterance
      });
    }

    function block(event) {
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
    }

    function installMotorListeners() {
      var pointerEvents = [
        'pointerdown', 'pointerup', 'pointermove', 'pointercancel',
        'pointerover', 'pointerenter', 'pointerout', 'pointerleave',
        'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseenter', 'mouseout', 'mouseleave',
        'dblclick', 'auxclick', 'touchstart', 'touchmove', 'touchend', 'touchcancel'
      ];
      for (var type of pointerEvents) {
        var listener = function pointerListenerFactory(eventType) {
          return function pointerListener(event) {
            var instant = Number(now());
            if (['pointerdown', 'mousedown', 'touchstart'].includes(eventType)) {
              pointerSequenceUntil = Number.isFinite(instant) ? instant + 1200 : 0;
            } else if (['pointercancel', 'touchcancel'].includes(eventType)) {
              pointerSequenceUntil = 0;
            }
            block(event);
          };
        }(type);
        document.addEventListener(type, listener, { capture: true, passive: false });
        cleanupListeners.push(function removePointer(eventType, handler) {
          return function cleanupPointer() { document.removeEventListener(eventType, handler, { capture: true }); };
        }(type, listener));
      }
      for (var blockedType of ['wheel', 'contextmenu']) {
        var blocked = function blockedListener(event) { block(event); };
        document.addEventListener(blockedType, blocked, { capture: true, passive: false });
        cleanupListeners.push(function removeBlocked(eventType, handler) {
          return function cleanupBlocked() { document.removeEventListener(eventType, handler, { capture: true }); };
        }(blockedType, blocked));
      }
      var click = function clickListener(event) {
        var instant = Number(now());
        var pointerSequence = pointerSequenceUntil > 0 && Number.isFinite(instant) && instant <= pointerSequenceUntil;
        var keyboardActivation = event.detail === 0 && pointerSequence === false;
        if (!keyboardActivation) block(event);
        pointerSequenceUntil = 0;
      };
      document.addEventListener('click', click, { capture: true, passive: false });
      cleanupListeners.push(function removeClick() { document.removeEventListener('click', click, { capture: true }); });
    }

    function installEmergencyExit() {
      var keydown = function emergencyKey(event) {
        if (event?.isTrusted !== true || event.key !== 'Escape' || event.repeat === true) return;
        var instant = Number(now());
        if (!Number.isFinite(instant) || instant - lastEscapeAt > 1500) escapeCount = 0;
        lastEscapeAt = instant;
        escapeCount += 1;
        if (escapeCount < 3) return;
        stop('emergency');
        dispatchPersonaEvent({ event: 'emergency-stop' });
      };
      document.addEventListener('keydown', keydown, true);
      cleanupListeners.push(function removeEmergency() { document.removeEventListener('keydown', keydown, true); });
    }

    function installLifecycle() {
      var leave = function leavePage() { transitionToInactive('page-exit'); };
      windowObject.addEventListener?.('pagehide', leave, { once: true });
      windowObject.addEventListener?.('unload', leave, { once: true });
      var spa = function leaveSpa() {
        if (!activeMode) return;
        var transition = transitionToInactive('spa-navigation');
        if (transition.wasActive) dispatchPersonaEvent({ event: 'lifecycle-stop' });
      };
      windowObject.addEventListener?.('popstate', spa);
      windowObject.addEventListener?.('hashchange', spa);
      var observer = null;
      if (typeof MutationObserverConstructor === 'function') {
        var observedShadowRoots = new Set();
        for (var possibleHost of walkAllOpenDom()) {
          if (possibleHost.shadowRoot && possibleHost.shadowRoot.mode === 'open') observedShadowRoots.add(possibleHost.shadowRoot);
        }
        observer = new MutationObserverConstructor(function onMutation(records) {
          if (!activeMode || !Array.isArray(records)) return;
          var material = currentReaderElement?.isConnected === false || records.length > 128 || !rootOwnershipIntact();
          for (var record of records.slice(0, 128)) {
            if (record?.type === 'attributes') {
              if (isOwnedArtifact(record.target)) {
                if (record.attributeName === 'style' && artifactIntegrity(record.target, true)) continue;
                material = true;
                break;
              }
              if (isMaterialAttribute(record.attributeName)) {
                material = true;
                break;
              }
              continue;
            }
            if (record?.type === 'characterData') {
              if (activeMode === 'reader') {
                material = true;
                break;
              }
              continue;
            }
            if (record?.type !== 'childList') continue;
            var changed = Array.from(record.addedNodes || []).concat(Array.from(record.removedNodes || []));
            if (isOwnedArtifact(record.target) || changed.some(isOwnedArtifact)) {
              material = true;
              break;
            }
            if (changedIntroducesPersonaCollision(changed)) {
              material = true;
              break;
            }
            if (activeMode === 'reader' && childListChangesReaderQueue(record.target, changed)) {
              material = true;
              break;
            }
            var mutationRoot = null;
            try { mutationRoot = record.target?.nodeType === 11 ? record.target : record.target?.getRootNode?.(); }
            catch (_error) { mutationRoot = null; }
            if (observedShadowRoots.has(mutationRoot) || record.target === document.body ||
              record.target === document.documentElement || changed.length >= 20 ||
              changed.some(function containsCurrent(node) {
                return node === currentReaderElement || node?.contains?.(currentReaderElement);
              })) {
              material = true;
              break;
            }
          }
          if (!material) return;
          var transition = transitionToInactive('material-dom-change');
          if (transition.wasActive) dispatchPersonaEvent({ event: 'lifecycle-stop' });
        });
        try {
          var observerInit = {
            childList: true, subtree: true, attributes: true, characterData: true
          };
          observer.observe(document, observerInit);
          for (var shadowRoot of observedShadowRoots) observer.observe(shadowRoot, observerInit);
        }
        catch (_error) {
          try { observer?.disconnect?.(); } catch (_ignored) { /* partial observer cleanup */ }
          observer = null;
        }
      }
      cleanupListeners.push(function removeLeave() {
        windowObject.removeEventListener?.('pagehide', leave);
        windowObject.removeEventListener?.('unload', leave);
        windowObject.removeEventListener?.('popstate', spa);
        windowObject.removeEventListener?.('hashchange', spa);
        observer?.disconnect?.();
      });
    }

    function isOwnedArtifact(node) {
      if (!node) return false;
      var element = node.nodeType === 1 ? node : (node.parentElement || node.parentNode);
      if (!element || element.nodeType !== 1) return false;
      if (artifactIdentities.has(element)) return true;
      return ancestors(element).some(function ownedAncestor(ancestor) {
        return artifactIdentities.has(ancestor);
      });
    }

    function artifactIntegrity(node, requireExpectedStyle) {
      if (!node || !artifactIdentities.has(node)) return false;
      var metadata = artifactMetadata.get(node);
      if (!metadata || attribute(node, 'data-audita-persona-owned') !== ROOT_OWNERSHIP_VALUE ||
        attribute(node, 'aria-hidden') !== 'true' || attribute(node, 'tabindex') !== '-1' ||
        !node.classList?.contains(metadata.className) || classListSize(node) !== 1 ||
        Array.from(node.childNodes || []).length !== 0) return false;
      return !requireExpectedStyle || attribute(node, 'style') === metadata.style;
    }

    function classListSize(node) {
      if (Number.isSafeInteger(node?.classList?.length)) return node.classList.length;
      if (Number.isSafeInteger(node?.classList?.values?.size)) return node.classList.values.size;
      var value = attribute(node, 'class');
      return value ? value.split(/\s+/u).filter(Boolean).length : 0;
    }

    function rememberArtifactStyle(node) {
      var metadata = artifactMetadata.get(node);
      if (metadata) metadata.style = attribute(node, 'style');
    }

    function isMaterialAttribute(name) {
      return typeof name === 'string' && (name.startsWith('aria-') || MATERIAL_ATTRIBUTES.includes(name));
    }

    function rootOwnershipIntact() {
      var rootElement = document.documentElement;
      var modeClass = activeMode ? `audita-persona-${activeMode}` : '';
      return Boolean(ownsRootAttribute && rootElement &&
        attribute(rootElement, ROOT_OWNERSHIP_ATTRIBUTE) === ROOT_OWNERSHIP_VALUE &&
        modeClass && ownedClasses.has(modeClass) && rootElement.classList?.contains(modeClass));
    }

    function changedIntroducesPersonaCollision(changed) {
      if (changed.length > 512) return true;
      var pending = changed.slice();
      var seen = new Set();
      while (pending.length) {
        if (seen.size + pending.length > 512) return true;
        var node = pending.shift();
        if (!node || node.nodeType !== 1 || seen.has(node)) continue;
        seen.add(node);
        if (hasAttribute(node, 'data-audita-persona-owned') ||
          hasAttribute(node, ROOT_OWNERSHIP_ATTRIBUTE) ||
          MODE_CLASSES.some(function reservedMode(name) { return node.classList?.contains(name); }) ||
          ARTIFACT_CLASSES.some(function reservedArtifact(name) { return node.classList?.contains(name); })) return true;
        var descendants = childElements(node, true);
        if (seen.size + pending.length + descendants.length > 512) return true;
        pending.push.apply(pending, descendants);
        if (node.shadowRoot && node.shadowRoot.mode === 'open') {
          var shadowChildren = Array.from(node.shadowRoot.children || []);
          if (seen.size + pending.length + shadowChildren.length > 512) return true;
          pending.push.apply(pending, shadowChildren);
        }
      }
      return false;
    }

    function childListChangesReaderQueue(target, changed) {
      if (changed.length > 512) return true;
      if (readerCandidateElements.has(target)) return true;
      for (var candidate of readerCandidateElements) {
        try {
          if (target?.contains?.(candidate)) return true;
        } catch (_error) { return true; }
      }
      var pending = changed.slice(0, 512);
      var seen = new Set();
      while (pending.length && seen.size < 512) {
        var node = pending.shift();
        if (!node || seen.has(node)) continue;
        seen.add(node);
        if (node.nodeType === 3) return true;
        if (node.nodeType !== 1) continue;
        if (readerCandidateElements.has(node)) return true;
        for (var existingCandidate of readerCandidateElements) {
          try {
            if (node.contains?.(existingCandidate)) return true;
          } catch (_error) { return true; }
        }
        if (nativeFocusable(node) || hasAttribute(node, 'tabindex') || tagOf(node) === 'label' ||
          hasAttribute(node, 'id') || hasAttribute(node, 'role')) return true;
        var descendants = childElements(node, true);
        var remaining = 512 - seen.size - pending.length;
        if (descendants.length > remaining) return true;
        pending.push.apply(pending, descendants);
        if (node.shadowRoot && node.shadowRoot.mode === 'open') {
          var shadowChildren = Array.from(node.shadowRoot.children || []);
          remaining = 512 - seen.size - pending.length;
          if (shadowChildren.length > remaining) return true;
          pending.push.apply(pending, shadowChildren);
        }
      }
      return pending.length > 0;
    }

    function clearListeners() {
      for (var cleanup of cleanupListeners.splice(0)) {
        try { cleanup(); } catch (_error) { /* cleanup remains idempotent */ }
      }
      pointerSequenceUntil = 0;
      escapeCount = 0;
      lastEscapeAt = 0;
    }

    function activate(mode, preferences) {
      if (destroyed || !['reader', 'achromatopsia', 'motor'].includes(mode)) return getState();
      if (activeMode === mode) return getState();
      transitionToInactive('switch-mode');
      if (!acquireRootOwnership()) return getState();
      try {
        var className = `audita-persona-${mode}`;
        if (!addOwnedClass(className)) throw new Error('Colisão de classe da persona.');
        activeMode = mode;
        if (mode === 'reader') {
          ensureReaderArtifacts();
          reader = createReader();
          readerState = sanitizeReaderState(reader.start(preferences || {}));
        } else if (mode === 'motor') installMotorListeners();
        installEmergencyExit();
        installLifecycle();
      } catch (_error) {
        transitionToInactive('activation-failure');
      }
      return getState();
    }

    function stop() {
      return transitionToInactive('stop').state;
    }

    function transitionToInactive(_reason) {
      var wasActive = Boolean(activeMode || reader || cleanupListeners.length || artifacts.length || ownedClasses.size);
      var activeReader = reader;
      reader = null;
      activeMode = null;
      if (activeReader) {
        suppressReaderEvents = true;
        try { readerState = sanitizeReaderState(activeReader.stop()); }
        catch (_error) { readerState = idleReaderState(); }
        finally { suppressReaderEvents = false; }
      }
      currentReaderElement = null;
      readerCandidateElements.clear();
      clearListeners();
      removeArtifacts();
      removeOwnedClasses();
      releaseRootOwnership();
      readerState = idleReaderState();
      return { wasActive: wasActive, state: getState() };
    }

    function readerAction(action) {
      if (activeMode !== 'reader' || !reader) return getState();
      if (action === 'start') reader.start();
      else if (action === 'pause') reader.pause();
      else if (action === 'resume') reader.resume();
      else if (action === 'stop') return stop('reader-stop');
      else if (action === 'repeat') reader.repeat();
      else if (action === 'previous') reader.previous();
      else if (action === 'next') reader.next();
      readerState = sanitizeReaderState(reader.getState());
      return getState();
    }

    function setPreferences(preferences) {
      if (reader) readerState = sanitizeReaderState(reader.setPreferences(preferences || {}));
      return getState();
    }

    function getLimitations() {
      return limitations.map(function copy(item) {
        return item.truncated === true
          ? { code: item.code, count: item.count, truncated: true }
          : { code: item.code, count: item.count };
      });
    }

    function getState() {
      return {
        activeMode: activeMode,
        reader: sanitizeReaderState(readerState),
        limitations: getLimitations(),
        coverage: 'dom-fallback-top-document-open-shadow'
      };
    }

    function destroy() {
      stop('destroy');
      messagingCleanup?.();
      messagingCleanup = null;
      destroyed = true;
    }

    return Object.freeze({
      activate: activate,
      stop: stop,
      readerAction: readerAction,
      setPreferences: setPreferences,
      collectReaderCandidates: collectReaderCandidates,
      getLimitations: getLimitations,
      getState: getState,
      destroy: destroy,
      installMessaging: installMessaging
    });

    function installMessaging(chromeApi) {
      if (messagingCleanup || !chromeApi?.runtime?.onMessage?.addListener) return messagingCleanup || function noop() {};
      var listener = function onMessage(message, sender, sendResponse) {
        return handleMessage(message, sender, sendResponse, chromeApi);
      };
      var connectListener = function onConnect(port) {
        if (!port || port.name !== 'audita-persona-content-v1' || port.sender?.id !== chromeApi.runtime.id ||
          typeof port.postMessage !== 'function' || !port.onMessage?.addListener) return;
        var bound = false;
        var bindListener = function bindEventPort(message) {
          if (bound) return;
          var binding = parseEventPortBinding(message);
          if (!binding || !session || binding.token !== session.token ||
            binding.documentId !== session.documentId || binding.generation !== session.generation ||
            (eventPort && eventPort !== port)) {
            try { port.disconnect?.(); } catch (_error) { /* rejeição local fail-closed */ }
            return;
          }
          bound = true;
          eventPort = port;
          port.onMessage.removeListener?.(bindListener);
          try {
            port.postMessage({
              protocol: 'audita-persona-content', version: 1, type: 'events-bound',
              token: session.token, generation: session.generation, documentId: session.documentId
            });
          } catch (_error) {
            eventPort = null;
            transitionToInactive('event-bind-failure');
            try { port.disconnect?.(); } catch (_ignored) { /* falha de handshake permanece local */ }
          }
        };
        var disconnect = function onPortDisconnect() {
          if (eventPort === port) {
            eventPort = null;
            transitionToInactive('worker-disconnect');
          }
          port.onMessage.removeListener?.(bindListener);
        };
        port.onMessage.addListener(bindListener);
        port.onDisconnect?.addListener?.(disconnect);
      };
      chromeApi.runtime.onMessage.addListener(listener);
      chromeApi.runtime.onConnect?.addListener?.(connectListener);
      messagingCleanup = function removeMessaging() {
        chromeApi.runtime.onMessage.removeListener?.(listener);
        chromeApi.runtime.onConnect?.removeListener?.(connectListener);
        eventPort = null;
      };
      return messagingCleanup;
    }

    function handleMessage(message, sender, sendResponse, chromeApi) {
      var parsed = parseContentCommand(message);
      if (!parsed || sender?.id !== chromeApi.runtime.id) return false;
      if (parsed.command === 'initialize') {
        if (seenRequests.has(parsed.requestId)) {
          sendResponse?.({ ok: false, code: 'PERSONA_REPLAY_REJECTED' });
          return true;
        }
        if (session && parsed.token === session.token && parsed.generation <= session.generation) {
          sendResponse?.({ ok: false, code: 'PERSONA_CORRELATION_REJECTED' });
          return true;
        }
        if (session) stop('reinitialize');
        session = {
          token: parsed.token,
          generation: parsed.generation,
          documentId: parsed.documentId
        };
        seenRequests.clear();
      } else if (seenRequests.has(parsed.requestId)) {
        sendResponse?.({ ok: false, code: 'PERSONA_REPLAY_REJECTED' });
        return true;
      } else if (!session || parsed.token !== session.token || parsed.generation !== session.generation + 1 ||
        parsed.documentId !== session.documentId) {
        sendResponse?.({ ok: false, code: 'PERSONA_CORRELATION_REJECTED' });
        return true;
      }
      seenRequests.add(parsed.requestId);
      if (seenRequests.size > 128) seenRequests.delete(seenRequests.values().next().value);
      session.generation = parsed.generation;
      var result;
      if (parsed.command === 'initialize') result = getState();
      else if (parsed.command === 'activate') result = activate(parsed.args.mode, parsed.args.preferences);
      else if (parsed.command === 'stop') result = stop('worker-command');
      else if (parsed.command === 'reader-action') result = readerAction(parsed.args.action);
      else if (parsed.command === 'preferences') result = setPreferences(parsed.args.preferences);
      else return false;
      sendResponse?.({
        protocol: 'audita-persona-content', version: 1, type: 'ack',
        requestId: parsed.requestId, token: parsed.token, generation: parsed.generation,
        documentId: parsed.documentId, ok: true, state: result
      });
      return true;
    }
  });

  function parseContentCommand(message) {
    var cloned = clonePlain(message);
    if (!cloned) return null;
    var keys = Object.keys(cloned).sort();
    var expected = ['args', 'command', 'documentId', 'generation', 'protocol', 'requestId', 'token', 'type', 'version'].sort();
    if (keys.length !== expected.length || keys.some(function mismatch(key, index) { return key !== expected[index]; })) return null;
    if (cloned.protocol !== 'audita-persona-content' || cloned.version !== 1 || cloned.type !== 'command' ||
      !boundedIdentifier(cloned.requestId) || !boundedIdentifier(cloned.token) ||
      !boundedIdentifier(cloned.documentId) || !Number.isSafeInteger(cloned.generation) || cloned.generation < 1) return null;
    if (!['initialize', 'activate', 'stop', 'reader-action', 'preferences'].includes(cloned.command) || !validContentArgs(cloned.command, cloned.args)) return null;
    return cloned;
  }

  function parseEventPortBinding(message) {
    var cloned = clonePlain(message);
    if (!cloned || !exactKeys(cloned, ['protocol', 'version', 'type', 'token', 'generation', 'documentId']) ||
      cloned.protocol !== 'audita-persona-content' || cloned.version !== 1 || cloned.type !== 'bind-events' ||
      !boundedIdentifier(cloned.token) || !boundedIdentifier(cloned.documentId) ||
      !Number.isSafeInteger(cloned.generation) || cloned.generation < 1) return null;
    return cloned;
  }

  function clonePlain(value) {
    var result = copyDataRecord(value, 0, { count: 0 });
    return result?.ok === true && result.value && typeof result.value === 'object' && !Array.isArray(result.value)
      ? result.value
      : null;
  }

  function copyDataRecord(value, depth, budget) {
    if (depth > 6 || budget.count > 128) return { ok: false };
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return { ok: true, value: value };
    if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value: value };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
    var descriptors;
    try { descriptors = Object.getOwnPropertyDescriptors(value); } catch (_error) { return { ok: false }; }
    var output = Object.create(null);
    for (var key of Object.keys(descriptors)) {
      budget.count += 1;
      var descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return { ok: false };
      var copied = copyDataRecord(descriptor.value, depth + 1, budget);
      if (!copied.ok) return copied;
      output[key] = copied.value;
    }
    return { ok: true, value: output };
  }

  function exactKeys(value, expected) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var keys = Object.keys(value).sort();
    var wanted = expected.slice().sort();
    return keys.length === wanted.length && keys.every(function same(key, index) { return key === wanted[index]; });
  }

  function validPreferences(value) {
    return exactKeys(value, ['voiceId', 'rate']) && typeof value.voiceId === 'string' &&
      Array.from(value.voiceId).length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value.voiceId) &&
      typeof value.rate === 'number' && Number.isFinite(value.rate) && value.rate >= 0.5 && value.rate <= 2;
  }

  function validContentArgs(command, args) {
    if (command === 'initialize' || command === 'stop') return exactKeys(args, []);
    if (command === 'activate') {
      return exactKeys(args, ['mode', 'preferences']) && ['reader', 'achromatopsia', 'motor'].includes(args.mode) && validPreferences(args.preferences);
    }
    if (command === 'reader-action') {
      return exactKeys(args, ['action']) && ['start', 'pause', 'resume', 'stop', 'repeat', 'previous', 'next'].includes(args.action);
    }
    return command === 'preferences' && exactKeys(args, ['preferences']) && validPreferences(args.preferences);
  }

  function boundedIdentifier(value) {
    return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/u.test(value);
  }

  if (root.document && root.chrome?.runtime?.onMessage) {
    var existing = namespace.getContentSingleton();
    if (!existing) {
      var singleton = namespace.createContentRuntime({
        document: root.document,
        window: root,
        speechSynthesis: root.speechSynthesis || null,
        Utterance: root.SpeechSynthesisUtterance
      });
      namespace.setContentSingleton(singleton);
      singleton.installMessaging(root.chrome);
    }
  }
})(globalThis);
