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

  function validInstallationId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/u.test(value);
  }

  function validOpaqueId(value, prefix) {
    if (typeof value !== 'string' || !new RegExp(`^${prefix}[1-9][0-9]*$`, 'u').test(value)) return false;
    const numeric = Number(value.slice(1));
    return Number.isSafeInteger(numeric) && numeric > 0;
  }

  function validStableCssId(value) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 23 ||
      !/^-?[_A-Za-z][_A-Za-z0-9-]*$/u.test(value)) return false;
    const sensitive = /(?:pass(?:word|wd)?|token|secret|auth(?:orization)?|session|cookie|csrf|xsrf|otp|one[-_]?time|api[-_]?key)/iu;
    return !sensitive.test(value) && !/@|:\/\/|www\./iu.test(value) && !/[0-9]{4}/u.test(value) &&
      !/[0-9a-f]{8}/iu.test(value) &&
      !/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/iu.test(value);
  }

  function validStructuralPath(value, tag) {
    if (typeof value !== 'string' || value.length > 2048) return false;
    const parts = value.split(' > ');
    if (parts.length > 16) return false;
    let complexity = parts.length - 1;
    for (let index = 0; index < parts.length; index += 1) {
      const segment = /^([a-z][a-z0-9-]{0,62})(?::nth-of-type\(([1-9][0-9]*)\))?$/u.exec(parts[index]);
      if (!segment || (segment[2] && !Number.isSafeInteger(Number(segment[2]))) ||
        (index === parts.length - 1 && segment[1] !== tag)) return false;
      complexity += segment[2] ? 4 : 1;
    }
    return complexity <= 64;
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
      const targets = denseArray(record.targets, 64);
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
        const match = exactRecord(target.match, ['tag', 'id']) ?? exactRecord(target.match, ['tag', 'classes', 'path']);
        if (!match || typeof match.tag !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/u.test(match.tag)) return null;
        let parsedMatch;
        if (!Object.hasOwn(match, 'id')) {
          const classes = denseArray(match.classes, 2, 1);
          if (!classes || classes.some(value => !validStableCssId(value)) || new Set(classes).size !== classes.length ||
            !validStructuralPath(match.path, match.tag)) return null;
          parsedMatch = Object.freeze({ tag: match.tag, id: null, classes: Object.freeze(classes.sort()), path: match.path });
        } else {
          if (!validStableCssId(match.id)) return null;
          parsedMatch = Object.freeze({ tag: match.tag, id: match.id });
        }
        const signals = denseArray(target.signals, 64, 1);
        if (!signals) return null;
        const parsedSignals = [];
        for (const signalValue of signals) {
          const signal = exactRecord(signalValue, ['selectionId', 'classification']);
          if (!signal || !validOpaqueId(signal.selectionId, 's') || selectionIds.has(signal.selectionId) ||
            !['failed', 'alert', 'manual-review', 'passed'].includes(signal.classification)) return null;
          selectionIds.add(signal.selectionId);
          parsedSignals.push(Object.freeze({ selectionId: signal.selectionId, classification: signal.classification }));
          signalCount += 1;
          if (signalCount > 64) return null;
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
      const entries = denseArray(record.selectionIds, 64);
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
      if (a.markerId !== b.markerId || a.number !== b.number || a.match.tag !== b.match.tag || a.match.id !== b.match.id ||
        JSON.stringify(a.match.classes) !== JSON.stringify(b.match.classes) ||
        a.match.path !== b.match.path ||
        a.signals.length !== b.signals.length) return false;
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

  function resolveTarget(target) {
    let matches;
    try {
      const suffix = target.match.id === null ? target.match.classes.map(value => `.${value}`).join('') : `#${target.match.id}`;
      matches = environment.document.querySelectorAll(`${target.match.tag}${suffix}`);
    } catch {
      return { reason: 'not-found' };
    }
    if (!matches || matches.length === 0) return { reason: 'not-found' };
    if (matches.length !== 1) return { reason: 'ambiguous' };
    const element = matches[0];
    try {
      if (typeof element?.tagName !== 'string' || element.tagName.toLowerCase() !== target.match.tag ||
        typeof element.getAttribute !== 'function' || element.getAttribute('id') !== target.match.id) {
        return { reason: 'not-found' };
      }
      if (target.match.id === null) {
        const classes = (element.getAttribute('class') ?? '').split(/[\t\n\f\r ]+/u);
        if (!target.match.classes.every(value => classes.includes(value))) return { reason: 'not-found' };
        const pathMatches = environment.document.querySelectorAll(target.match.path);
        if (pathMatches.length !== 1) return { reason: pathMatches.length ? 'ambiguous' : 'not-found' };
        if (pathMatches[0] !== element) return { reason: 'not-found' };
      }
    } catch {
      return { reason: 'not-found' };
    }
    const reason = renderedReason(element);
    return reason ? { reason } : { element };
  }

  const visual = Object.freeze({
    failed: Object.freeze({ symbol: '×', phrase: 'falha registrada na auditoria', color: '#8b1e1e' }),
    alert: Object.freeze({ symbol: '!', phrase: 'alerta registrado na auditoria', color: '#8a5a00' }),
    'manual-review': Object.freeze({ symbol: '?', phrase: 'revisão manual registrada na auditoria', color: '#6b4e00' }),
    passed: Object.freeze({ symbol: '✓', phrase: 'resultado positivo registrado na auditoria', color: '#1f6f43' }),
  });
  const priority = Object.freeze({ failed: 4, alert: 3, 'manual-review': 2, passed: 1 });

  function installSession(install) {
    const response = { ok: true, locatedMarkerIds: [], unlocated: [] };
    const resolvedRows = [];
    for (const target of install.targets) {
      const resolved = resolveTarget(target);
      if (resolved.reason) response.unlocated.push({ markerId: target.markerId, reason: resolved.reason });
      else {
        response.locatedMarkerIds.push(target.markerId);
        resolvedRows.push({ target, element: resolved.element });
      }
    }

    let host = null;
    let observer = null;
    let frame = null;
    let timer = null;
    let disposed = false;
    let notified = false;
    const listeners = [];
    const groups = [];
    const groupByElement = new Map();
    const selectionToGroup = new Map();
    const knownSelections = new Set(install.targets.flatMap(target => target.signals.map(signal => signal.selectionId)));
    let visibleSelections = new Set(knownSelections);
    let selectedId = null;
    const originalDocumentElement = environment.document.documentElement;
    let state = null;

    function ownsSlot() {
      try {
        const descriptor = Reflect.getOwnPropertyDescriptor(environment, '__auditaPageMarkersOverlayV1');
        return Boolean(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value === state &&
          !descriptor.enumerable && descriptor.configurable && !descriptor.writable);
      } catch {
        return false;
      }
    }

    function dispose(autonomous) {
      if (disposed) return;
      disposed = true;
      if (frame !== null) {
        try { environment.cancelAnimationFrame(frame); } catch {}
        frame = null;
      }
      if (timer !== null) {
        try { environment.clearTimeout(timer); } catch {}
        timer = null;
      }
      try { observer?.disconnect(); } catch {}
      observer = null;
      for (const group of groups) {
        try { group.button.removeEventListener('click', group.onClick); } catch {}
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

    function positionGroup(group) {
      if (disposed || environment.document.documentElement !== originalDocumentElement ||
        renderedReason(group.element) !== null) return false;
      const rect = group.element.getBoundingClientRect();
      group.ring.style.left = `${rect.left}px`;
      group.ring.style.top = `${rect.top}px`;
      group.ring.style.width = `${rect.width}px`;
      group.ring.style.height = `${rect.height}px`;
      group.button.style.left = `${rect.left}px`;
      group.button.style.top = `${Math.max(0, rect.top - 22)}px`;
      return true;
    }

    function stillExact(group) {
      const resolution = resolveTarget(group.firstTarget);
      return resolution.element === group.element;
    }

    function verifyAndPosition() {
      if (disposed) return;
      frame = null;
      if (environment.document.documentElement !== originalDocumentElement ||
        groups.some(group => !stillExact(group) || !positionGroup(group))) dispose(true);
    }

    function scheduleVerification() {
      if (disposed || frame !== null) return;
      try {
        frame = environment.requestAnimationFrame(verifyAndPosition);
      } catch {
        dispose(true);
      }
    }

    function updateGroup(group) {
      const visible = group.signals.filter(signal => visibleSelections.has(signal.selectionId));
      if (visible.length === 0) {
        group.button.style.display = 'none';
        group.ring.style.display = 'none';
        return;
      }
      let classification = visible[0].classification;
      for (const signal of visible) {
        if (priority[signal.classification] > priority[classification]) classification = signal.classification;
      }
      const treatment = visual[classification];
      group.button.style.display = 'flex';
      group.button.style.background = treatment.color;
      group.button.style.borderColor = treatment.color;
      group.button.textContent = `${group.number}${treatment.symbol}${visible.length}`;
      const occurrences = visible.length === 1 ? '1 ocorrência' : `${visible.length} ocorrências`;
      group.button.setAttribute('aria-label',
        `Sinal ${group.number}: ${treatment.phrase}, ${occurrences}. Abrir no painel.`);
      group.ring.style.borderColor = treatment.color;
      group.ring.style.display = selectedId !== null && group.signals.some(signal => signal.selectionId === selectedId) &&
        visibleSelections.has(selectedId) ? 'block' : 'none';
    }

    function applyFilter(selectionIds) {
      if (selectionIds.some(selectionId => !knownSelections.has(selectionId))) {
        return { ok: false, reason: 'invalid-command' };
      }
      visibleSelections = new Set(selectionIds);
      if (selectedId !== null && !visibleSelections.has(selectedId)) selectedId = null;
      for (const group of groups) updateGroup(group);
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
          for (const current of groups) updateGroup(current);
          return { ok: false, reason: 'selection-unavailable' };
        }
        selectedId = next.selectionId;
        for (const current of groups) updateGroup(current);
        if (next.scroll) {
          try {
            group.element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
          } catch {
            return { ok: false, reason: 'runtime-unavailable' };
          }
          scheduleVerification();
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
      style.textContent = '.audita-marker:focus-visible{outline:3px solid #005fcc;outline-offset:2px}';
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
          ring.style.borderWidth = '3px';
          ring.style.borderStyle = 'solid';
          ring.style.borderRadius = '4px';
          ring.style.display = 'none';
          button.style.all = 'initial';
          button.style.position = 'fixed';
          button.style.display = 'flex';
          button.style.alignItems = 'center';
          button.style.justifyContent = 'center';
          button.style.boxSizing = 'border-box';
          button.style.minWidth = '38px';
          button.style.height = '30px';
          button.style.padding = '0 7px';
          button.style.borderWidth = '2px';
          button.style.borderStyle = 'solid';
          button.style.borderRadius = '999px';
          button.style.color = '#ffffff';
          button.style.font = '700 14px/1 system-ui, sans-serif';
          button.style.cursor = 'pointer';
          button.style.pointerEvents = 'auto';
          button.style.zIndex = '2147483647';
          group = { element: row.element, firstTarget: row.target, number: row.target.number,
            signals: [], container, ring, button, onClick: null };
          group.onClick = event => {
            try { event?.preventDefault?.(); } catch {}
            try { event?.stopPropagation?.(); } catch {}
            const firstVisible = group.signals.find(signal => visibleSelections.has(signal.selectionId));
            if (firstVisible) safelySend({ type: 'AUDITA_PAGE_MARKER_SELECTED',
              installationId: install.installationId, selectionId: firstVisible.selectionId });
          };
          button.addEventListener('click', group.onClick);
          container.appendChild(ring);
          container.appendChild(button);
          shadow.appendChild(container);
          groupByElement.set(row.element, group);
          groups.push(group);
        }
        for (const signal of row.target.signals) {
          group.signals.push(signal);
          selectionToGroup.set(signal.selectionId, group);
        }
      }

      for (const group of groups) {
        updateGroup(group);
        if (!positionGroup(group)) throw new Error('geometry unavailable');
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

      const onGeometry = () => scheduleVerification();
      const onEscape = event => { if (event?.key === 'Escape') dispose(true); };
      const onNavigation = () => dispose(true);
      for (const [type, listener, options] of [
        ['scroll', onGeometry, true],
        ['resize', onGeometry, true],
        ['keydown', onEscape, true],
        ['pagehide', onNavigation, true],
        ['popstate', onNavigation, true],
        ['hashchange', onNavigation, true],
      ]) {
        listeners.push([type, listener, options]);
        environment.addEventListener(type, listener, options);
      }

      observer = new environment.MutationObserver(records => {
        if (disposed) return;
        try {
          let touchesTarget = false;
          for (const record of records ?? []) {
            let node = record?.target;
            if (node === host) continue;
            while (node) {
              if (groupByElement.has(node)) { touchesTarget = true; break; }
              node = node.parentNode;
            }
            if (touchesTarget) break;
          }
          if (touchesTarget) dispose(true);
          else scheduleVerification();
        } catch {
          dispose(true);
        }
      });
      observer.observe(environment.document, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = environment.setTimeout(() => dispose(true), install.ttlMs);
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
