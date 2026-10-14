export function runAuditaPageMarkersCommand(command, environment = globalThis) {
  function exactRecord(value, fields) {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const prototype = Reflect.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return null;
      const keys = Reflect.ownKeys(value);
      if (keys.length !== fields.length || keys.some(key => typeof key !== 'string') ||
        fields.some(field => !keys.includes(field))) return null;
      const snapshot = Object.create(null);
      for (const field of fields) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, field);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
        Object.defineProperty(snapshot, field, {
          value: descriptor.value,
          enumerable: true,
          configurable: false,
          writable: false,
        });
      }
      return Object.freeze(snapshot);
    } catch {
      return null;
    }
  }

  function denseArray(value, maximum, minimum = 0) {
    try {
      if (!Array.isArray(value)) return null;
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length');
      if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < minimum ||
        lengthDescriptor.value > maximum) return null;
      const length = lengthDescriptor.value;
      const keys = Reflect.ownKeys(value);
      if (keys.length !== length + 1 || keys.some(key => typeof key !== 'string') || !keys.includes('length')) return null;
      const output = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
        output.push(descriptor.value);
      }
      return output;
    } catch {
      return null;
    }
  }

  // Chrome drops null dictionary fields from injected arguments, so a record may arrive with a
  // shorter tail than it was built with. Keys stay closed: anything outside the allowed sets is
  // refused, and every required field must be present.
  function subsetRecord(value, required, optional) {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const prototype = Reflect.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return null;
      const keys = Reflect.ownKeys(value);
      if (keys.some(key => typeof key !== 'string' || !(required.includes(key) || optional.includes(key))) ||
        required.some(field => !keys.includes(field))) return null;
      const snapshot = Object.create(null);
      for (const key of keys) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
        Object.defineProperty(snapshot, key, {
          value: descriptor.value,
          enumerable: true,
          configurable: false,
          writable: false,
        });
      }
      return Object.freeze(snapshot);
    } catch {
      return null;
    }
  }

  function validInstallationId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/u.test(value);
  }

  function validOpaqueId(value, prefix) {
    if (typeof value !== 'string' || !new RegExp(`^${prefix}[1-9][0-9]*$`, 'u').test(value)) return false;
    const numeric = Number(value.slice(1));
    return Number.isSafeInteger(numeric) && numeric > 0;
  }

  // The signals match runs INSIDE the audited page, on data that already lives in that page's own
  // DOM and never leaves it. Ids and classes with four digits or eight hex characters are accepted
  // here — a `id="secao-2024"` is a legitimate anchor, not a credential. Credential-shaped names
  // keep being refused, and the report/export path keeps its stricter rule.
  function validStableCssId(value) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 23 ||
      !/^-?[_A-Za-z][_A-Za-z0-9-]*$/u.test(value)) return false;
    const sensitive = /(?:pass(?:word|wd)?|token|secret|auth(?:orization)?|session|cookie|csrf|xsrf|otp|one[-_]?time|api[-_]?key)/iu;
    return !sensitive.test(value) && !/@|:\/\/|www\./iu.test(value) &&
      !/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/iu.test(value);
  }

  function validAttributeValue(value) {
    return typeof value === 'string' && value.length >= 1 && value.length <= 256 &&
      !/[\u0000-\u001f\u007f]/u.test(value);
  }

  function validRoleOrType(value) {
    return typeof value === 'string' && /^[A-Za-z0-9 _-]{1,128}$/u.test(value);
  }

  function validStructuralPath(value, tag) {
    if (typeof value !== 'string' || value.length > 2048 || value.length < 1) return false;
    const parts = value.split(' > ');
    if (parts.length < 1 || parts.length > 64) return false;
    let complexity = parts.length - 1;
    for (let index = 0; index < parts.length; index += 1) {
      const segment = /^([a-z][a-z0-9-]{0,62})(?::nth-of-type\(([1-9][0-9]*)\))?$/u.exec(parts[index]);
      if (!segment || (segment[2] && !Number.isSafeInteger(Number(segment[2]))) ||
        (index === parts.length - 1 && segment[1] !== tag)) return false;
      complexity += segment[2] ? 4 : 1;
    }
    return complexity <= 320;
  }

  const SIGNAL_ATTRIBUTES = Object.freeze(['name', 'alt', 'title', 'aria-label', 'data-testid', 'role']);
  const MAX_TARGETS = 500;
  const MAX_SIGNALS = 500;

  // Three shapes, each with a closed key set so nothing extra can travel in the envelope.
  function parseMatch(raw) {
    const match = exactRecord(raw, ['tag', 'id']) ?? exactRecord(raw, ['tag', 'attribute']) ??
      subsetRecord(raw, ['tag', 'classes', 'path'], ['id', 'role', 'type']);
    if (!match || typeof match.tag !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/u.test(match.tag)) return null;
    if (Object.hasOwn(match, 'attribute')) {
      const attribute = exactRecord(match.attribute, ['name', 'value']);
      if (!attribute || !SIGNAL_ATTRIBUTES.includes(attribute.name) || !validAttributeValue(attribute.value)) return null;
      return Object.freeze({ tag: match.tag,
        attribute: Object.freeze({ name: attribute.name, value: attribute.value }) });
    }
    if (!Object.hasOwn(match, 'path')) {
      if (!validStableCssId(match.id)) return null;
      return Object.freeze({ tag: match.tag, id: match.id });
    }
    const classes = denseArray(match.classes, 24, 0);
    if (!classes || classes.some(value => !validStableCssId(value)) || new Set(classes).size !== classes.length) return null;
    const id = match.id ?? null;
    const role = match.role ?? null;
    const type = match.type ?? null;
    if (id !== null && !validStableCssId(id)) return null;
    if (role !== null && !validRoleOrType(role)) return null;
    if (type !== null && !validRoleOrType(type)) return null;
    if (!validStructuralPath(match.path, match.tag)) return null;
    return Object.freeze({ tag: match.tag, classes: Object.freeze([...classes].sort()),
      path: match.path, id, role, type });
  }

  function sameMatch(left, right) {
    if (!left || !right || left.tag !== right.tag) return false;
    if (Boolean(left.attribute) !== Boolean(right.attribute)) return false;
    if (left.attribute) {
      return left.attribute.name === right.attribute.name && left.attribute.value === right.attribute.value;
    }
    if (left.path !== right.path || left.id !== right.id || left.role !== right.role || left.type !== right.type) return false;
    return JSON.stringify(left.classes) === JSON.stringify(right.classes);
  }

  function parseCommand(value) {
    const envelope = exactRecord(value, ['version', 'op', ...(
      exactRecord(value, ['version', 'op', 'installationId', 'ttlMs', 'targets']) ? ['installationId', 'ttlMs', 'targets'] :
        exactRecord(value, ['version', 'op', 'installationId', 'selectionId', 'scroll']) ? ['installationId', 'selectionId', 'scroll'] :
          exactRecord(value, ['version', 'op', 'installationId', 'selectionIds']) ? ['installationId', 'selectionIds'] :
            exactRecord(value, ['version', 'op', 'installationId']) ? ['installationId'] : []
    )]);
    if (!envelope || envelope.version !== 1 || typeof envelope.op !== 'string') return null;

    if (envelope.op === 'install') {
      const record = exactRecord(value, ['version', 'op', 'installationId', 'ttlMs', 'targets']);
      if (!record || !validInstallationId(record.installationId) || !Number.isSafeInteger(record.ttlMs) ||
        record.ttlMs < 1 || record.ttlMs > 1_800_000) return null;
      const targets = denseArray(record.targets, MAX_TARGETS);
      if (!targets) return null;
      const markerIds = new Set();
      const selectionIds = new Set();
      const parsedTargets = [];
      let signalCount = 0;
      for (const targetValue of targets) {
        const target = exactRecord(targetValue, ['markerId', 'number', 'match', 'signals']);
        if (!target || !validOpaqueId(target.markerId, 'm') || markerIds.has(target.markerId) ||
          !Number.isSafeInteger(target.number) || target.number < 1 || target.number > 5_000) return null;
        markerIds.add(target.markerId);
        const parsedMatch = parseMatch(target.match);
        if (!parsedMatch) return null;
        const signals = denseArray(target.signals, MAX_SIGNALS, 1);
        if (!signals) return null;
        const parsedSignals = [];
        for (const signalValue of signals) {
          const signal = exactRecord(signalValue, ['selectionId', 'classification']);
          if (!signal || !validOpaqueId(signal.selectionId, 's') || selectionIds.has(signal.selectionId) ||
            !['failed', 'alert', 'manual-review', 'passed'].includes(signal.classification)) return null;
          selectionIds.add(signal.selectionId);
          parsedSignals.push(Object.freeze({ selectionId: signal.selectionId, classification: signal.classification }));
          signalCount += 1;
          if (signalCount > MAX_SIGNALS) return null;
        }
        parsedTargets.push(Object.freeze({
          markerId: target.markerId,
          number: target.number,
          match: parsedMatch,
          signals: Object.freeze(parsedSignals),
        }));
      }
      return Object.freeze({ version: 1, op: 'install', installationId: record.installationId,
        ttlMs: record.ttlMs, targets: Object.freeze(parsedTargets) });
    }

    if (envelope.op === 'select') {
      const record = exactRecord(value, ['version', 'op', 'installationId', 'selectionId', 'scroll']);
      if (!record || !validInstallationId(record.installationId) || !validOpaqueId(record.selectionId, 's') ||
        typeof record.scroll !== 'boolean') return null;
      return Object.freeze({ version: 1, op: 'select', installationId: record.installationId,
        selectionId: record.selectionId, scroll: record.scroll });
    }

    if (envelope.op === 'filter') {
      const record = exactRecord(value, ['version', 'op', 'installationId', 'selectionIds']);
      if (!record || !validInstallationId(record.installationId)) return null;
      const entries = denseArray(record.selectionIds, MAX_SIGNALS);
      if (!entries) return null;
      const seen = new Set();
      for (const selectionId of entries) {
        if (!validOpaqueId(selectionId, 's') || seen.has(selectionId)) return null;
        seen.add(selectionId);
      }
      return Object.freeze({ version: 1, op: 'filter', installationId: record.installationId,
        selectionIds: Object.freeze([...entries]) });
    }

    if (envelope.op === 'clear') {
      const record = exactRecord(value, ['version', 'op', 'installationId']);
      if (!record || !validInstallationId(record.installationId)) return null;
      return Object.freeze({ version: 1, op: 'clear', installationId: record.installationId });
    }
    return null;
  }

  function runtimeAvailable() {
    try {
      const document = environment?.document;
      const runtime = environment?.chrome?.runtime;
      if (!document || !document.documentElement || typeof document.createElement !== 'function' ||
        typeof document.querySelectorAll !== 'function' || typeof document.documentElement.appendChild !== 'function' ||
        typeof environment.addEventListener !== 'function' || typeof environment.removeEventListener !== 'function' ||
        typeof environment.requestAnimationFrame !== 'function' || typeof environment.cancelAnimationFrame !== 'function' ||
        typeof environment.setTimeout !== 'function' || typeof environment.clearTimeout !== 'function' ||
        typeof environment.MutationObserver !== 'function' || typeof environment.getComputedStyle !== 'function' ||
        !runtime || typeof runtime.sendMessage !== 'function') return false;
      const probe = document.createElement('div');
      return Boolean(probe?.style && typeof probe.attachShadow === 'function' && typeof probe.setAttribute === 'function');
    } catch {
      return false;
    }
  }

  function inspectState() {
    try {
      const descriptor = Reflect.getOwnPropertyDescriptor(environment, '__auditaPageMarkersOverlayV1');
      if (!descriptor) return { kind: 'absent' };
      if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable || !descriptor.configurable || descriptor.writable ||
        !descriptor.value || typeof descriptor.value !== 'object') return { kind: 'foreign' };
      const value = descriptor.value;
      const version = Reflect.getOwnPropertyDescriptor(value, 'version');
      const installationId = Reflect.getOwnPropertyDescriptor(value, 'installationId');
      const dispose = Reflect.getOwnPropertyDescriptor(value, 'dispose');
      const execute = Reflect.getOwnPropertyDescriptor(value, 'execute');
      if (!version || !installationId || !dispose || !execute ||
        ![version, installationId, dispose, execute].every(item => Object.hasOwn(item, 'value')) ||
        version.value !== 1 || !validInstallationId(installationId.value) ||
        typeof dispose.value !== 'function' || typeof execute.value !== 'function') return { kind: 'foreign' };
      return { kind: 'owned-shape', value, installationId: installationId.value, execute: execute.value };
    } catch {
      return { kind: 'foreign' };
    }
  }

  function sameInstall(left, right) {
    if (!left || !right || left.installationId !== right.installationId || left.ttlMs !== right.ttlMs ||
      left.targets.length !== right.targets.length) return false;
    for (let index = 0; index < left.targets.length; index += 1) {
      const a = left.targets[index];
      const b = right.targets[index];
      if (a.markerId !== b.markerId || a.number !== b.number ||
        !sameMatch(a.match, b.match) || a.signals.length !== b.signals.length) return false;
      for (let signalIndex = 0; signalIndex < a.signals.length; signalIndex += 1) {
        if (a.signals[signalIndex].selectionId !== b.signals[signalIndex].selectionId ||
          a.signals[signalIndex].classification !== b.signals[signalIndex].classification) return false;
      }
    }
    return true;
  }

  function safelySend(message) {
    try {
      Promise.resolve(environment.chrome.runtime.sendMessage(message)).catch(() => {});
    } catch {
      // Autonomous cleanup and selection remain local if the worker is unavailable.
    }
  }

  function renderedReason(element) {
    try {
      if (!element || element.isConnected === false) return 'not-rendered';
      if (typeof element.getRootNode !== 'function' || element.getRootNode() !== environment.document) return 'unsupported-context';
      const rect = element.getBoundingClientRect();
      if (!rect || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) ||
        rect.width <= 0 || rect.height <= 0) return 'not-rendered';
      const computed = environment.getComputedStyle(element);
      if (!computed || computed.display === 'none' || ['hidden', 'collapse'].includes(computed.visibility)) return 'not-rendered';
      return null;
    } catch {
      return 'not-rendered';
    }
  }

  // Attribute values are re-escaped for a quoted CSS string; backslashes and quotes are the only
  // characters that can terminate one, and control characters were rejected during parsing.
  function escapeAttributeValue(value) {
    return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
  }

  // Structural resolution. The path is a closed grammar of tag and tag:nth-of-type(n) segments, so
  // it cannot smuggle arbitrary selectors. Classes, id, role and type are corroboration only:
  // a global uniqueness requirement on classes is what used to hide most legitimate signals.
  function resolveElement(target) {
    const match = target.match;
    const semantic = Object.hasOwn(match, 'attribute');
    const structural = Object.hasOwn(match, 'path');
    const selector = semantic ? `${match.tag}[${match.attribute.name}="${escapeAttributeValue(match.attribute.value)}"]`
      : structural ? match.path
        : `${match.tag}#${match.id}`;
    let elements;
    try {
      elements = environment.document.querySelectorAll(selector);
    } catch {
      return { reason: 'not-found' };
    }
    if (!elements || elements.length === 0) return { reason: 'not-found' };
    if (elements.length !== 1) return { reason: 'ambiguous' };
    const element = elements[0];
    try {
      if (typeof element?.tagName !== 'string' || element.tagName.toLowerCase() !== match.tag ||
        typeof element.getAttribute !== 'function') return { reason: 'not-found' };
      if (semantic) {
        if (element.getAttribute(match.attribute.name) !== match.attribute.value) return { reason: 'not-found' };
      } else if (structural) {
        if (match.id !== null && element.getAttribute('id') !== match.id) return { reason: 'not-found' };
        if (match.role !== null && element.getAttribute('role') !== match.role) return { reason: 'not-found' };
        if (match.type !== null && element.getAttribute('type') !== match.type) return { reason: 'not-found' };
        const classes = (element.getAttribute('class') ?? '').split(/[\t\n\f\r ]+/u);
        if (!match.classes.every(value => classes.includes(value))) return { reason: 'not-found' };
      } else if (element.getAttribute('id') !== match.id) return { reason: 'not-found' };
    } catch {
      return { reason: 'not-found' };
    }
    return { element };
  }

  const visual = Object.freeze({
    failed: Object.freeze({ symbol: '×', phrase: 'falha registrada na auditoria', color: '#8b1e1e' }),
    alert: Object.freeze({ symbol: '!', phrase: 'alerta registrado na auditoria', color: '#8a5a00' }),
    'manual-review': Object.freeze({ symbol: '?', phrase: 'revisão manual registrada na auditoria', color: '#6b4e00' }),
    passed: Object.freeze({ symbol: '✓', phrase: 'resultado positivo registrado na auditoria', color: '#1f6f43' }),
  });
  const priority = Object.freeze({ failed: 4, alert: 3, 'manual-review': 2, passed: 1 });

  const GAP = 3;
  const BORDER = 2;
  const SELECTED_BORDER = 3;
  const MIN_BOX = 12;
  const LABEL_HEIGHT = 20;
  const LABEL_HEIGHT_SELECTED = 24;
  const HOVER_BORDER = 3;
  const MAX_ANCESTORS = 32;
  const MAX_FRAGMENTS = 8;
  const LABEL_STEP = 4;
  // Above this area an obstacle is a container (a section, a card): a label may rest on it.
  const SMALL_OBSTACLE_AREA = 60000;
  const CHECK_INTERVAL_MS = 100;
  const REPOSITION_INTERVAL_MS = 400;

  function rgba(hex, alpha) {
    const value = typeof hex === 'string' && /^#[0-9a-f]{6}$/iu.test(hex) ? hex : '#000000';
    const red = Number.parseInt(value.slice(1, 3), 16);
    const green = Number.parseInt(value.slice(3, 5), 16);
    const blue = Number.parseInt(value.slice(5, 7), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  function ringShadow(selected, hovered, color) {
    const layers = ['inset 0 0 0 1px #ffffff', '0 0 0 1px #ffffff'];
    if (selected) layers.push(`0 0 0 4px ${rgba(color, 0.35)}`);
    else if (hovered) layers.push(`0 0 0 3px ${rgba(color, 0.25)}`);
    return layers.join(', ');
  }

  function overlapArea(left, right) {
    const width = Math.min(left.right, right.right) - Math.max(left.left, right.left);
    const height = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
    return width > 0 && height > 0 ? width * height : 0;
  }

  function covers(outer, inner) {
    return outer.left <= inner.left && outer.top <= inner.top &&
      outer.right >= inner.right && outer.bottom >= inner.bottom;
  }

  function clips(value) {
    return typeof value === 'string' && value !== '' && value !== 'visible';
  }

  function installSession(install) {
    const response = { ok: true, locatedMarkerIds: [], unlocated: [] };
    const resolvedRows = [];
    // An element that exists but is hidden right now (a carousel slide, a closed accordion) still
    // gets its signal: it stays hidden and appears as soon as the element is rendered. Only an
    // element that cannot be found, or not found unambiguously, is reported as unlocated.
    for (const target of install.targets) {
      let resolution = resolveElement(target);
      if (!resolution.reason) {
        // Hidden is fine; detached or inside another root (shadow tree, other document) is not.
        const reason = renderedReason(resolution.element);
        if (reason === 'unsupported-context' || resolution.element.isConnected === false) resolution = { reason };
      }
      if (resolution.reason) response.unlocated.push({ markerId: target.markerId, reason: resolution.reason });
      else {
        response.locatedMarkerIds.push(target.markerId);
        resolvedRows.push({ target, element: resolution.element });
      }
    }

    let host = null;
    let observer = null;
    let frame = null;
    let cooldown = null;
    let timer = null;
    let periodic = null;
    let disposed = false;
    let notified = false;
    let lastCheckAt = 0;
    const listeners = [];
    const groups = [];
    const groupByElement = new Map();
    const selectionToGroup = new Map();
    const knownSelections = new Set(install.targets.flatMap(target => target.signals.map(signal => signal.selectionId)));
    let visibleSelections = new Set(knownSelections);
    let selectedId = null;
    const originalDocumentElement = environment.document.documentElement;
    const originalLocation = `${environment.location?.pathname ?? ''}${environment.location?.search ?? ''}`;
    let state = null;

    function clockNow() {
      try {
        const clock = environment.performance;
        if (clock && typeof clock.now === 'function') return Number(clock.now()) || 0;
      } catch {}
      return Date.now();
    }

    function viewportRect() {
      const width = Number(environment.innerWidth);
      const height = Number(environment.innerHeight);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
      return { left: 0, top: 0, right: width, bottom: height };
    }

    function documentHidden() {
      try {
        return environment.document?.hidden === true || environment.document?.visibilityState === 'hidden';
      } catch {
        return false;
      }
    }

    function ownsSlot() {
      try {
        const descriptor = Reflect.getOwnPropertyDescriptor(environment, '__auditaPageMarkersOverlayV1');
        return Boolean(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value === state &&
          !descriptor.enumerable && descriptor.configurable && !descriptor.writable);
      } catch {
        return false;
      }
    }

    function clearScheduled() {
      for (const [key, clear] of [['frame', 'cancelAnimationFrame'], ['cooldown', 'clearTimeout'],
        ['periodic', 'clearTimeout'], ['timer', 'clearTimeout']]) {
        const handle = key === 'frame' ? frame : key === 'cooldown' ? cooldown : key === 'periodic' ? periodic : timer;
        if (handle !== null) {
          try { environment[clear](handle); } catch {}
        }
      }
      frame = null;
      cooldown = null;
      periodic = null;
      timer = null;
    }

    function dispose(autonomous) {
      if (disposed) return;
      disposed = true;
      clearScheduled();
      try { observer?.disconnect(); } catch {}
      observer = null;
      for (const group of groups) {
        for (const [type, listener] of [['click', group.onClick], ['mouseenter', group.onEnter],
          ['mouseleave', group.onLeave], ['focus', group.onEnter], ['blur', group.onLeave]]) {
          try { group.button.removeEventListener(type, listener); } catch {}
        }
      }
      for (const [type, listener, options] of listeners.splice(0)) {
        try { environment.removeEventListener(type, listener, options); } catch {}
      }
      try { host?.remove(); } catch {}
      if (ownsSlot()) {
        try { Reflect.deleteProperty(environment, '__auditaPageMarkersOverlayV1'); } catch {}
      }
      if (autonomous === true && !notified) {
        notified = true;
        safelySend({ type: 'AUDITA_PAGE_MARKERS_CLEARED', installationId: install.installationId });
      }
    }

    function connectedInDocument(element) {
      try {
        if (typeof environment.document.contains === 'function') return environment.document.contains(element);
        return typeof element?.getRootNode === 'function' && element.getRootNode() === environment.document;
      } catch {
        return false;
      }
    }

    function isSelected(group) {
      return selectedId !== null && visibleSelections.has(selectedId) &&
        group.signals.some(signal => signal.selectionId === selectedId);
    }

    // A disappeared element hides only its own signal: the session survives and the next pass tries
    // to locate the element again, so a re-rendered node gets its marker back.
    function repairGroup(group) {
      if (group.element && group.element.isConnected !== false && connectedInDocument(group.element)) return;
      const resolution = resolveElement(group.firstTarget);
      if (!resolution.element || resolution.element === group.element) return;
      try { groupByElement.delete(group.element); } catch {}
      group.element = resolution.element;
      groupByElement.set(group.element, group);
    }

    function clipByAncestors(element, cache, box) {
      let node = element.parentElement;
      let depth = 0;
      while (node && depth < MAX_ANCESTORS && typeof node.getBoundingClientRect === 'function') {
        depth += 1;
        let clip = cache.get(node);
        if (clip === undefined) {
          clip = null;
          try {
            const style = environment.getComputedStyle(node);
            if (style) {
              const clipX = clips(style.overflowX ?? style.overflow);
              const clipY = clips(style.overflowY ?? style.overflow);
              const rect = clipX || clipY ? node.getBoundingClientRect() : null;
              if (rect && [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) {
                clip = { left: rect.left, top: rect.top, right: rect.left + rect.width,
                  bottom: rect.top + rect.height, x: clipX, y: clipY };
              }
            }
          } catch {
            clip = null;
          }
          cache.set(node, clip);
        }
        if (clip) {
          if (clip.x) { box.left = Math.max(box.left, clip.left); box.right = Math.min(box.right, clip.right); }
          if (clip.y) { box.top = Math.max(box.top, clip.top); box.bottom = Math.min(box.bottom, clip.bottom); }
        }
        node = node.parentElement;
      }
    }

    // An inline element that wraps (a long link in a paragraph) gets one contour per line fragment;
    // its bounding box would also enclose the neighbouring words of the first and last lines.
    function rawRects(element) {
      const rects = [];
      try {
        const display = environment.getComputedStyle(element)?.display ?? '';
        if (display === 'inline' && typeof element.getClientRects === 'function') {
          const list = element.getClientRects();
          for (let index = 0; index < (list?.length ?? 0) && rects.length < MAX_FRAGMENTS; index += 1) {
            const rect = list[index];
            if (rect && [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) &&
              rect.width > 0 && rect.height > 0) rects.push(rect);
          }
        }
      } catch {
        rects.length = 0;
      }
      if (rects.length > 1) return rects;
      try {
        const rect = element.getBoundingClientRect();
        return rect ? [rect] : [];
      } catch {
        return [];
      }
    }

    function visibleBox(element, cache, rect) {
      let box;
      try {
        if (!rect || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) return null;
        box = { left: rect.left, top: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height };
      } catch {
        return null;
      }
      if (box.right - box.left < MIN_BOX) {
        const extra = (MIN_BOX - (box.right - box.left)) / 2;
        box.left -= extra;
        box.right += extra;
      }
      if (box.bottom - box.top < MIN_BOX) {
        const extra = (MIN_BOX - (box.bottom - box.top)) / 2;
        box.top -= extra;
        box.bottom += extra;
      }
      clipByAncestors(element, cache, box);
      const viewport = viewportRect();
      if (viewport) {
        box.left = Math.max(box.left, viewport.left);
        box.top = Math.max(box.top, viewport.top);
        box.right = Math.min(box.right, viewport.right);
        box.bottom = Math.min(box.bottom, viewport.bottom);
      }
      if (!(box.right > box.left) || !(box.bottom > box.top)) return null;
      return { left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top };
    }

    // Width from the text itself, never from the box we sized on the previous pass (that fed back
    // and wrapped "1 × (4)" onto two lines). Canvas metrics when available, a safe estimate otherwise.
    const widthCache = new Map();
    let measureContext;
    function labelWidth(button, selected) {
      const text = typeof button.textContent === 'string' ? button.textContent : '';
      const font = `700 ${selected ? 14 : 12}px system-ui, sans-serif`;
      const key = `${font}\u0000${text}`;
      if (widthCache.has(key)) return widthCache.get(key);
      let width = null;
      try {
        if (measureContext === undefined) {
          const canvas = environment.document.createElement('canvas');
          measureContext = typeof canvas?.getContext === 'function' ? canvas.getContext('2d') : null;
        }
        if (measureContext && typeof measureContext.measureText === 'function') {
          measureContext.font = font;
          const measured = Number(measureContext.measureText(text)?.width);
          if (Number.isFinite(measured) && measured > 0) width = Math.ceil(measured) + 16;
        }
      } catch {
        measureContext = null;
      }
      if (width === null) width = 12 + (text.length * (selected ? 9 : 8));
      width = Math.min(320, Math.max(28, width));
      widthCache.set(key, width);
      return width;
    }

    function distanceBetween(a, b) {
      const dx = Math.max(0, a.left - b.right, b.left - a.right);
      const dy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
      return Math.hypot(dx, dy);
    }

    // The label is a tab glued to the contour: bottom edge on the contour's top edge, flipped under
    // it when there is no room above. When every glued spot would hide another label or another
    // marked element, it moves to the nearest free row above or below and a thin leader joins it to
    // its contour. A label never buries another label.
    function placeLabel(ring, width, height, placed, obstacles) {
      const viewport = viewportRect();
      const bounds = viewport ?? { left: 0, top: 0, right: ring.left + ring.width, bottom: ring.top + ring.height };
      const clampLeft = value => Math.min(Math.max(value, bounds.left), Math.max(bounds.left, bounds.right - width));
      const ringBox = { left: ring.left, top: ring.top, right: ring.left + ring.width, bottom: ring.top + ring.height };
      const aboveTop = ring.top - height;
      const belowTop = ring.top + ring.height;
      const startsAboveViewport = ring.top - height < bounds.top;
      const candidates = [];
      const seen = new Set();
      const push = (left, top, side) => {
        if (top < bounds.top || top + height > bounds.bottom) return;
        const key = `${Math.round(left)}:${Math.round(top)}`;
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ left, top, side });
      };
      push(clampLeft(ring.left), aboveTop, 'above');
      push(clampLeft((ring.left + ring.width) - width), aboveTop, 'above');
      if (startsAboveViewport) {
        push(clampLeft(ring.left), bounds.top, 'above');
        push(clampLeft((ring.left + ring.width) - width), bounds.top, 'above');
      }
      push(clampLeft(ring.left), belowTop, 'below');
      push(clampLeft((ring.left + ring.width) - width), belowTop, 'below');
      for (const ratio of [0.25, 0.5, 0.75]) {
        const centered = clampLeft(ring.left + (ring.width * ratio) - (width / 2));
        push(centered, aboveTop, 'above');
        push(centered, belowTop, 'below');
      }
      for (let row = 1; row <= 3; row += 1) {
        for (const column of [0, 1, -1, 2, -2, 3, -3]) {
          const left = clampLeft(ring.left + (column * (width + LABEL_STEP)));
          push(left, aboveTop - (row * (height + LABEL_STEP)), 'detached');
          push(left, belowTop + (row * (height + LABEL_STEP)), 'detached');
        }
      }
      push(clampLeft(ring.left + 3), Math.min(Math.max(bounds.top, ring.top + 3), bounds.bottom - height), 'inside');
      if (candidates.length === 0) {
        candidates.push({ left: clampLeft(ring.left), top: Math.min(Math.max(bounds.top, aboveTop), bounds.bottom - height), side: 'inside' });
      }

      let chosen = null;
      let bestCost = Infinity;
      for (const candidate of candidates) {
        const rect = { left: candidate.left, top: candidate.top,
          right: candidate.left + width, bottom: candidate.top + height };
        let cost = distanceBetween(rect, ringBox);
        let buried = false;
        for (const other of placed) {
          const area = overlapArea(rect, other);
          if (area === 0) continue;
          cost += area * 1000;
          if (covers(other, rect) || covers(rect, other)) buried = true;
        }
        for (const obstacle of obstacles) {
          const area = overlapArea(rect, obstacle);
          if (area === 0) continue;
          const obstacleArea = (obstacle.right - obstacle.left) * (obstacle.bottom - obstacle.top);
          cost += area * (obstacleArea <= SMALL_OBSTACLE_AREA ? 40 : 0.05);
        }
        // Never sit on the marked element itself unless nothing else fits (a contour taller than the
        // viewport keeps its label pinned to the top of the visible band).
        cost += overlapArea(rect, ringBox) * 40;
        if (candidate.side === 'inside') cost += width * height * 20;
        if (buried) cost += 1e12;
        if (cost < bestCost) { bestCost = cost; chosen = { ...candidate, rect }; }
      }
      placed.push(chosen.rect);
      return chosen;
    }

    function leaderBetween(label, ringBox) {
      const labelCenterX = (label.left + label.right) / 2;
      const labelCenterY = (label.top + label.bottom) / 2;
      const toX = Math.min(Math.max(labelCenterX, ringBox.left), ringBox.right);
      const toY = Math.min(Math.max(labelCenterY, ringBox.top), ringBox.bottom);
      const fromX = Math.min(Math.max(toX, label.left), label.right);
      const fromY = Math.min(Math.max(toY, label.top), label.bottom);
      const length = Math.hypot(toX - fromX, toY - fromY);
      return length < 2 ? null : { x: fromX, y: fromY, length, angle: Math.atan2(toY - fromY, toX - fromX) };
    }

    function hideGroup(group) {
      group.ring.style.display = 'none';
      group.button.style.display = 'none';
      group.leader.style.display = 'none';
      for (const extra of group.extraRings) extra.style.display = 'none';
    }

    function ringElement(group, index) {
      if (index === 0) return group.ring;
      while (group.extraRings.length < index) {
        const extra = environment.document.createElement('div');
        extra.setAttribute('class', 'audita-ring');
        extra.style.all = 'initial';
        extra.style.position = 'fixed';
        extra.style.boxSizing = 'border-box';
        extra.style.pointerEvents = 'none';
        extra.style.borderStyle = 'solid';
        extra.style.zIndex = '2147483646';
        group.container.appendChild(extra);
        group.extraRings.push(extra);
      }
      return group.extraRings[index - 1];
    }

    // First pass: contours. Returns the contour boxes so the label pass can avoid them.
    function layoutGroup(group, cache) {
      if (group.visible.length === 0) return null;
      if (renderedReason(group.element) !== null) {
        hideGroup(group);
        return null;
      }
      const boxes = [];
      for (const rect of rawRects(group.element)) {
        const box = visibleBox(group.element, cache, rect);
        if (box) boxes.push(box);
      }
      if (boxes.length === 0) {
        hideGroup(group);
        return null;
      }
      const selected = isSelected(group);
      const hovered = group.hovered === true && !selected;
      const border = selected ? SELECTED_BORDER : hovered ? HOVER_BORDER : BORDER;
      const rings = boxes.map((box, index) => {
        const ring = {
          left: box.left - GAP - border, top: box.top - GAP - border,
          width: box.width + (2 * (GAP + border)), height: box.height + (2 * (GAP + border)),
        };
        const element = ringElement(group, index);
        element.style.left = `${ring.left}px`;
        element.style.top = `${ring.top}px`;
        element.style.width = `${ring.width}px`;
        element.style.height = `${ring.height}px`;
        element.style.borderWidth = `${border}px`;
        element.style.borderRadius = '3px';
        element.style.borderColor = group.color;
        element.style.boxShadow = ringShadow(selected, hovered, group.color);
        element.style.opacity = group.faded ? '0.6' : '1';
        element.style.display = 'block';
        return ring;
      });
      // Extra fragments from an earlier pass (the element re-wrapped onto fewer lines) are hidden.
      for (let index = Math.max(0, rings.length - 1); index < group.extraRings.length; index += 1) {
        group.extraRings[index].style.display = 'none';
      }
      return { group, selected, rings,
        boxes: rings.map(ring => ({ left: ring.left, top: ring.top, right: ring.left + ring.width, bottom: ring.top + ring.height })) };
    }

    // Second pass: the label of each contour, glued to the first line fragment when possible.
    function placeGroupLabel(layout, obstacles, placed) {
      const { group, selected, rings, boxes } = layout;
      const label = group.button;
      const width = labelWidth(label, selected);
      const height = selected ? LABEL_HEIGHT_SELECTED : LABEL_HEIGHT;
      const others = obstacles.filter(entry => entry.owner !== group);
      const spot = placeLabel(rings[0], width, height, placed, others);
      label.style.width = `${width}px`;
      label.style.height = `${height}px`;
      label.style.left = `${spot.left}px`;
      label.style.top = `${spot.top}px`;
      label.style.borderRadius = spot.side === 'below' ? '0 0 4px 4px' : spot.side === 'above' ? '4px 4px 0 0' : '4px';
      label.style.display = 'flex';
      const leader = spot.side === 'detached' ? leaderBetween(spot.rect, boxes[0]) : null;
      if (leader) {
        group.leader.style.left = `${leader.x}px`;
        group.leader.style.top = `${leader.y}px`;
        group.leader.style.width = `${leader.length}px`;
        group.leader.style.transform = `rotate(${leader.angle}rad)`;
        group.leader.style.borderTopColor = group.color;
        group.leader.style.opacity = group.faded ? '0.6' : '1';
        group.leader.style.display = 'block';
      } else {
        group.leader.style.display = 'none';
      }
      return true;
    }

    function pulseGroup(group) {
      try {
        if (environment.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true) return;
        if (typeof group.button.offsetWidth !== 'number') return;
        // Clearing and re-reading the box restarts the animation when the same signal is picked again.
        group.button.style.animation = '';
        void group.button.offsetWidth;
        group.button.style.animation = 'audita-signal-pulse 320ms ease-out';
      } catch {
        // A missing animation runtime must never break the signal itself.
      }
    }

    // Every located element keeps its own contour. Classification, occurrence count, selection and
    // filter only change colour, size and emphasis — never whether the contour is drawn.
    function updateGroup(group) {
      const visible = group.signals.filter(signal => visibleSelections.has(signal.selectionId));
      group.visible = visible;
      if (visible.length === 0) {
        hideGroup(group);
        return;
      }
      let classification = visible[0].classification;
      for (const signal of visible) {
        if (priority[signal.classification] > priority[classification]) classification = signal.classification;
      }
      const treatment = visual[classification];
      group.classification = classification;
      group.color = treatment.color;
      const selected = isSelected(group);
      // "3 ×" reads as "signal 3, failure"; the occurrence count goes in parentheses so it is never
      // read as a multiplication ("3×2").
      group.button.textContent = visible.length > 1
        ? `${group.number} ${treatment.symbol} (${visible.length})` : `${group.number} ${treatment.symbol}`;
      group.button.style.background = treatment.color;
      group.button.style.borderColor = '#ffffff';
      group.button.style.color = '#ffffff';
      group.button.style.font = `700 ${selected ? 14 : 12}px/1 system-ui, sans-serif`;
      group.button.style.height = `${selected ? LABEL_HEIGHT_SELECTED : LABEL_HEIGHT}px`;
      // Only the contour steps back when another signal is selected: a faded label would turn the
      // white-on-colour text into a low-contrast pink.
      const faded = selectedId !== null && !selected;
      group.faded = faded;
      group.button.style.opacity = '1';
      group.ring.style.borderColor = treatment.color;
      const occurrences = visible.length === 1 ? '1 ocorrência' : `${visible.length} ocorrências`;
      group.button.setAttribute('aria-label',
        `Sinal ${group.number}: ${treatment.phrase}, ${occurrences}. Abrir no painel.`);
    }

    // One resolution per group, one geometry read per visible group, one rAF per burst of events.
    function runPass() {
      if (disposed) return false;
      if (environment.document.documentElement !== originalDocumentElement) {
        dispose(true);
        return false;
      }
      const cache = new Map();
      const placed = [];
      const layouts = [];
      for (const group of groups) {
        repairGroup(group);
        updateGroup(group);
        const layout = layoutGroup(group, cache);
        if (layout) layouts.push(layout);
      }
      const obstacles = layouts.flatMap(layout => layout.boxes.map(box => ({ ...box, owner: layout.group })));
      // The selected signal chooses first, then smaller contours (crowded icons) before large ones.
      layouts.sort((left, right) => (Number(right.selected) - Number(left.selected)) ||
        ((left.rings[0].width * left.rings[0].height) - (right.rings[0].width * right.rings[0].height)));
      for (const layout of layouts) placeGroupLabel(layout, obstacles, placed);
      return true;
    }

    function scheduleFrame() {
      if (disposed || frame !== null) return;
      try {
        frame = environment.requestAnimationFrame(() => {
          frame = null;
          if (disposed) return;
          lastCheckAt = clockNow();
          runPass();
        });
      } catch {
        dispose(true);
      }
    }

    // Mutations only ask for a fresh check, at most once per CHECK_INTERVAL_MS.
    function scheduleMutationCheck() {
      if (disposed || frame !== null || cooldown !== null) return;
      const elapsed = clockNow() - lastCheckAt;
      if (elapsed >= CHECK_INTERVAL_MS) {
        scheduleFrame();
        return;
      }
      try {
        cooldown = environment.setTimeout(() => {
          cooldown = null;
          scheduleFrame();
        }, CHECK_INTERVAL_MS - elapsed);
      } catch {
        dispose(true);
      }
    }

    function applyFilter(selectionIds) {
      if (selectionIds.some(selectionId => !knownSelections.has(selectionId))) {
        return { ok: false, reason: 'invalid-command' };
      }
      visibleSelections = new Set(selectionIds);
      if (selectedId !== null && !visibleSelections.has(selectedId)) selectedId = null;
      runPass();
      return { ok: true };
    }

    function execute(next) {
      if (disposed || next.installationId !== install.installationId) {
        return { ok: false, reason: 'installation-mismatch' };
      }
      if (next.op === 'install') {
        return sameInstall(next, install) ? {
          ok: true,
          locatedMarkerIds: [...response.locatedMarkerIds],
          unlocated: response.unlocated.map(entry => ({ ...entry })),
        } : { ok: false, reason: 'installation-mismatch' };
      }
      if (next.op === 'clear') {
        dispose(false);
        return { ok: true };
      }
      if (next.op === 'filter') return applyFilter(next.selectionIds);
      if (next.op === 'select') {
        const group = selectionToGroup.get(next.selectionId);
        if (!group || !visibleSelections.has(next.selectionId)) {
          selectedId = null;
          runPass();
          return { ok: false, reason: 'selection-unavailable' };
        }
        const changed = selectedId !== next.selectionId;
        selectedId = next.selectionId;
        runPass();
        if (changed) pulseGroup(group);
        if (next.scroll) {
          try {
            group.element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
          } catch {
            return { ok: false, reason: 'runtime-unavailable' };
          }
          scheduleFrame();
        }
        return { ok: true };
      }
      return { ok: false, reason: 'invalid-command' };
    }

    try {
      host = environment.document.createElement('div');
      host.setAttribute('data-audita-page-markers-root', 'v1');
      host.style.all = 'initial';
      host.style.position = 'fixed';
      host.style.left = '0';
      host.style.top = '0';
      host.style.width = '0';
      host.style.height = '0';
      host.style.pointerEvents = 'none';
      host.style.zIndex = '2147483647';
      const shadow = host.attachShadow({ mode: 'open' });
      const style = environment.document.createElement('style');
      style.textContent = [
        '@keyframes audita-signal-pulse{0%{transform:scale(1.25)}100%{transform:scale(1)}}',
        '.audita-marker:focus-visible{outline:3px solid #005fcc !important;outline-offset:2px !important}',
        '@media (prefers-reduced-motion: reduce){.audita-marker{animation:none !important}}',
        '@media (forced-colors: active){',
        '.audita-ring{border-color:CanvasText !important;box-shadow:none !important}',
        '.audita-leader{border-top-color:CanvasText !important;box-shadow:none !important}',
        '.audita-marker{background:CanvasText !important;color:Canvas !important;',
        'border-color:Canvas !important;forced-color-adjust:none}',
        '}',
      ].join('');
      shadow.appendChild(style);

      for (const row of resolvedRows) {
        let group = groupByElement.get(row.element);
        if (!group) {
          const container = environment.document.createElement('div');
          const ring = environment.document.createElement('div');
          const button = environment.document.createElement('button');
          container.setAttribute('class', 'audita-group');
          ring.setAttribute('class', 'audita-ring');
          button.setAttribute('class', 'audita-marker');
          button.setAttribute('type', 'button');
          container.style.all = 'initial';
          ring.style.all = 'initial';
          ring.style.position = 'fixed';
          ring.style.boxSizing = 'border-box';
          ring.style.pointerEvents = 'none';
          ring.style.borderStyle = 'solid';
          ring.style.display = 'none';
          ring.style.zIndex = '2147483646';
          button.style.all = 'initial';
          button.style.position = 'fixed';
          button.style.display = 'flex';
          button.style.alignItems = 'center';
          button.style.justifyContent = 'center';
          button.style.boxSizing = 'border-box';
          button.style.padding = '0 6px';
          button.style.whiteSpace = 'nowrap';
          button.style.overflow = 'hidden';
          button.style.borderWidth = '1px';
          button.style.borderStyle = 'solid';
          button.style.borderColor = '#ffffff';
          button.style.borderRadius = '4px 4px 0 0';
          button.style.color = '#ffffff';
          button.style.cursor = 'pointer';
          button.style.pointerEvents = 'auto';
          button.style.zIndex = '2147483647';
          const leader = environment.document.createElement('div');
          leader.setAttribute('class', 'audita-leader');
          leader.style.all = 'initial';
          leader.style.position = 'fixed';
          leader.style.height = '0';
          leader.style.borderTopWidth = '2px';
          leader.style.borderTopStyle = 'solid';
          leader.style.boxShadow = '0 0 0 1px #ffffff';
          leader.style.transformOrigin = '0 0';
          leader.style.pointerEvents = 'none';
          leader.style.display = 'none';
          leader.style.zIndex = '2147483646';
          group = { element: row.element, firstTarget: row.target, number: row.target.number,
            signals: [], visible: [], classification: 'passed', color: visual.passed.color, faded: false,
            hovered: false, container, ring, button, leader, extraRings: [], onClick: null, onEnter: null, onLeave: null };
          group.onClick = event => {
            try { event?.preventDefault?.(); } catch {}
            try { event?.stopPropagation?.(); } catch {}
            const firstVisible = group.signals.find(signal => visibleSelections.has(signal.selectionId));
            if (firstVisible) safelySend({ type: 'AUDITA_PAGE_MARKER_SELECTED',
              installationId: install.installationId, selectionId: firstVisible.selectionId });
          };
          group.onEnter = () => { group.hovered = true; scheduleFrame(); };
          group.onLeave = () => { group.hovered = false; scheduleFrame(); };
          button.addEventListener('click', group.onClick);
          button.addEventListener('mouseenter', group.onEnter);
          button.addEventListener('mouseleave', group.onLeave);
          button.addEventListener('focus', group.onEnter);
          button.addEventListener('blur', group.onLeave);
          // Order is ring, label, then the optional pieces (leader, extra line fragments); z-index,
          // not document order, keeps the label above them.
          container.appendChild(ring);
          container.appendChild(button);
          container.appendChild(leader);
          shadow.appendChild(container);
          groupByElement.set(row.element, group);
          groups.push(group);
        }
        for (const signal of row.target.signals) {
          group.signals.push(signal);
          selectionToGroup.set(signal.selectionId, group);
        }
      }

      state = Object.freeze({ version: 1, installationId: install.installationId, dispose, execute });
      Object.defineProperty(environment, '__auditaPageMarkersOverlayV1', {
        value: state,
        enumerable: false,
        configurable: true,
        writable: false,
      });
      if (!ownsSlot()) throw new Error('registration unavailable');
      originalDocumentElement.appendChild(host);
      lastCheckAt = clockNow();
      runPass();

      const onGeometry = () => scheduleFrame();
      const onEscape = event => { if (event?.key === 'Escape') dispose(true); };
      const onPageHide = () => dispose(true);
      const onHashChange = () => scheduleFrame();
      const onPopState = () => {
        const current = `${environment.location?.pathname ?? ''}${environment.location?.search ?? ''}`;
        if (current === originalLocation) scheduleFrame();
        else dispose(true);
      };
      for (const [type, listener, options] of [
        ['scroll', onGeometry, true],
        ['resize', onGeometry, true],
        ['keydown', onEscape, true],
        ['pagehide', onPageHide, true],
        ['popstate', onPopState, true],
        ['hashchange', onHashChange, true],
      ]) {
        listeners.push([type, listener, options]);
        environment.addEventListener(type, listener, options);
      }

      observer = new environment.MutationObserver(records => {
        if (disposed) return;
        if (environment.document.documentElement !== originalDocumentElement) {
          dispose(true);
          return;
        }
        try {
          // Only the light DOM matters, and our own host (and its shadow tree) is never a reason to
          // re-check the page.
          for (const record of records ?? []) {
            const node = record?.target;
            if (!node || node === host) continue;
            if (typeof node.getRootNode === 'function' && node.getRootNode() !== environment.document) continue;
            scheduleMutationCheck();
            return;
          }
        } catch {
          scheduleMutationCheck();
        }
      });
      observer.observe(environment.document, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = environment.setTimeout(() => dispose(true), install.ttlMs);
      periodic = environment.setTimeout(function reposition() {
        periodic = null;
        if (disposed) return;
        try {
          if (!documentHidden()) {
            lastCheckAt = clockNow();
            runPass();
          }
        } catch {}
        try {
          periodic = environment.setTimeout(reposition, REPOSITION_INTERVAL_MS);
        } catch {
          dispose(true);
        }
      }, REPOSITION_INTERVAL_MS);
      return response;
    } catch {
      dispose(false);
      return { ok: false, reason: 'runtime-unavailable' };
    }
  }

  const parsed = parseCommand(command);
  if (!parsed) return { ok: false, reason: 'invalid-command' };
  if (!runtimeAvailable()) return { ok: false, reason: 'runtime-unavailable' };
  const inspected = inspectState();
  if (inspected.kind === 'absent') {
    return parsed.op === 'install' ? installSession(parsed) : { ok: false, reason: 'installation-mismatch' };
  }
  if (inspected.kind !== 'owned-shape' || inspected.installationId !== parsed.installationId) {
    return { ok: false, reason: 'installation-mismatch' };
  }
  try {
    return inspected.execute(parsed);
  } catch {
    return { ok: false, reason: 'runtime-unavailable' };
  }
}
