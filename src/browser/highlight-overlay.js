export async function runAuditaHighlightCommand(command, environment = globalThis) {
  // Contour and tab vocabulary, shared with the page signals: a rectangle drawn OUTSIDE the element
  // with a gap, a white halo on both sides of the border and a tab glued to its top-left corner.
  const GAP = 3;
  const BORDER = 3;
  const LABEL_HEIGHT = 24;
  const MIN_ABOVE = 22;
  const MAX_LABEL_WIDTH = 320;
  const MIN_LABEL_WIDTH = 28;
  const MAX_HIGHLIGHT_SEGMENTS = 64;
  const MAX_HIGHLIGHT_COMPLEXITY = 320;
  const MAX_HIGHLIGHT_ANCESTRY = 64;

  function rgba(color, alpha) {
    const match = /^rgb\((\d{1,3}), (\d{1,3}), (\d{1,3})\)$/u.exec(String(color));
    if (!match) return `rgba(0, 0, 0, ${alpha})`;
    return `rgba(${Number(match[1])}, ${Number(match[2])}, ${Number(match[3])}, ${alpha})`;
  }

  // Inner halo, outer halo, then the coloured glow — the contour never covers the element's content.
  function ringShadow(color) {
    return `inset 0 0 0 1px #ffffff, 0 0 0 1px #ffffff, 0 0 0 4px ${rgba(color, 0.35)}`;
  }

  function exactKeys(value, expectedKeys) {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const prototype = Reflect.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return null;
      const keys = Reflect.ownKeys(value);
      if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== 'string') ||
        expectedKeys.some(key => !keys.includes(key))) return null;
      const snapshot = Object.create(null);
      for (const key of expectedKeys) {
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

  function parseInstall(value) {
    try {
      const record = exactKeys(value, [
        'version', 'op', 'nonce', 'documentId', 'frameId', 'selector',
        'structuralSignature', 'kind', 'markerNumber',
      ]);
      if (!record || record.version !== 1 || record.op !== 'install' ||
        typeof record.nonce !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(record.nonce) ||
        typeof record.documentId !== 'string' || !/^[A-Za-z0-9._:-]{1,240}$/u.test(record.documentId) ||
        !Number.isSafeInteger(record.frameId) || record.frameId < 0 ||
        !['failed', 'manual'].includes(record.kind) ||
        !Number.isSafeInteger(record.markerNumber) || record.markerNumber < 1 || record.markerNumber > 5_000) return null;

      const selector = exactKeys(record.selector, ['syntax', 'value', 'byteLength', 'complexity']);
      if (!selector || selector.syntax !== 'CSSSelectorV1' || typeof selector.value !== 'string' ||
        selector.value.length < 1 || selector.value.length > 2_048 ||
        !Number.isSafeInteger(selector.byteLength) || selector.byteLength < 1 || selector.byteLength > 2_048 ||
        !Number.isSafeInteger(selector.complexity) || selector.complexity < 1 ||
        selector.complexity > MAX_HIGHLIGHT_COMPLEXITY) return null;

      const bytes = new TextEncoder().encode(selector.value);
      if (bytes.byteLength !== selector.byteLength || bytes.byteLength > 2_048) return null;
      // Ids and classes that merely carry digits (post-1234, card-2024, 1f2e3d4c) are part of the
      // page the person is already reading: they are accepted here just like the page signals accept
      // them. Only credential-shaped names, URLs and UUIDs stay refused.
      const sensitive = /(?:pass(?:word|wd)?|token|secret|auth(?:orization)?|session|cookie|csrf|xsrf|otp|one[-_]?time|api[-_]?key)/iu;
      const urlLike = /@|:\/\/|www\./iu;
      const uuid = /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/iu;
      const sensitiveToken = value => sensitive.test(value) || urlLike.test(value) || uuid.test(value);
      const rawToken = /[#.]([^#.\[\]:()>\t\n\f\r ,\\*]+)/gu;
      for (const match of selector.value.matchAll(rawToken)) {
        if (sensitiveToken(match[1])) return null;
      }

      const segments = selector.value.split(' > ');
      if (segments.length < 1 || segments.length > MAX_HIGHLIGHT_SEGMENTS) return null;
      const segmentPattern = /^([a-z][a-z0-9-]{0,62})(?:#(-?[_A-Za-z][_A-Za-z0-9-]*))?((?:\.-?[_A-Za-z][_A-Za-z0-9-]*){0,2})(?:\[(role|type)="([a-z]+)"\])?(?::nth-of-type\(([1-9][0-9]*)\))?$/u;
      const classPattern = /\.(-?[_A-Za-z][_A-Za-z0-9-]*)/gu;
      const allowedRoles = new Set([
        'alert', 'button', 'checkbox', 'dialog', 'heading', 'img', 'link', 'list', 'listitem',
        'main', 'menu', 'menuitem', 'navigation', 'option', 'radio', 'region', 'search', 'slider',
        'spinbutton', 'status', 'switch', 'tab', 'tabpanel', 'textbox',
      ]);
      const allowedTypes = new Set([
        'button', 'checkbox', 'email', 'file', 'number', 'password', 'radio', 'range', 'reset',
        'search', 'submit', 'tel', 'text', 'url',
      ]);
      const safeToken = token => typeof token === 'string' && token.length >= 1 && token.length <= 23 &&
        /^-?[_A-Za-z][_A-Za-z0-9-]*$/u.test(token) && !sensitiveToken(token);
      let complexity = Math.max(0, segments.length - 1);
      for (const segment of segments) {
        const match = segmentPattern.exec(segment);
        if (!match) return null;
        const [, , id, rawClasses = '', attributeName, attributeValue, rawNth] = match;
        if (id !== undefined && !safeToken(id)) return null;
        const classes = [...rawClasses.matchAll(classPattern)].map(entry => entry[1]);
        if (classes.some(className => !safeToken(className))) return null;
        if (attributeName !== undefined && !(attributeName === 'role' ? allowedRoles : allowedTypes).has(attributeValue)) return null;
        if (rawNth !== undefined && (!Number.isSafeInteger(Number(rawNth)) || Number(rawNth) < 1)) return null;
        complexity += 1 + (id === undefined ? 0 : 1) + classes.length +
          (attributeName === undefined ? 0 : 2) + (rawNth === undefined ? 0 : 3);
        if (complexity > MAX_HIGHLIGHT_COMPLEXITY) return null;
      }
      if (complexity !== selector.complexity) return null;

      const structuralSignature = exactKeys(record.structuralSignature, ['version', 'sha256']);
      if (!structuralSignature || structuralSignature.version !== 'StructuralSignatureV1' ||
        typeof structuralSignature.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(structuralSignature.sha256)) return null;

      return Object.freeze({
        version: 1,
        op: 'install',
        nonce: record.nonce,
        documentId: record.documentId,
        frameId: record.frameId,
        selector: Object.freeze({
          syntax: 'CSSSelectorV1',
          value: selector.value,
          byteLength: selector.byteLength,
          complexity: selector.complexity,
        }),
        structuralSignature: Object.freeze({
          version: 'StructuralSignatureV1',
          sha256: structuralSignature.sha256,
        }),
        kind: record.kind,
        markerNumber: record.markerNumber,
      });
    } catch {
      return null;
    }
  }

  function parseClear(value) {
    const record = exactKeys(value, ['version', 'op', 'nonce']);
    if (!record || record.version !== 1 || record.op !== 'clear' ||
      typeof record.nonce !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(record.nonce)) return null;
    return Object.freeze({ version: 1, op: 'clear', nonce: record.nonce });
  }

  function inspectInstallClaim() {
    try {
      const descriptor = Reflect.getOwnPropertyDescriptor(environment, '__auditaHighlightInstallV1');
      if (!descriptor) return { state: 'absent' };
      if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable || !descriptor.configurable || descriptor.writable) {
        return { state: 'invalid' };
      }
      const claim = exactKeys(descriptor.value, ['version', 'nonce', 'token']);
      if (!claim || claim.version !== 1 || typeof claim.nonce !== 'string' ||
        !/^[A-Za-z0-9_-]{22}$/u.test(claim.nonce) || exactKeys(claim.token, []) === null ||
        !Object.isFrozen(claim.token)) {
        return { state: 'invalid' };
      }
      return {
        state: 'active',
        claim: descriptor.value,
        nonce: claim.nonce,
      };
    } catch {
      return { state: 'invalid' };
    }
  }

  function acquireInstallClaim(nonce) {
    const inspected = inspectInstallClaim();
    if (inspected.state !== 'absent') return inspected;
    const claim = Object.freeze({
      version: 1,
      nonce,
      token: Object.freeze({}),
    });
    try {
      Object.defineProperty(environment, '__auditaHighlightInstallV1', {
        value: claim,
        enumerable: false,
        configurable: true,
        writable: false,
      });
    } catch {
      return { state: 'invalid' };
    }
    return claimOwned(claim) ? { state: 'owned', claim, nonce } : { state: 'invalid' };
  }

  function claimOwned(claim) {
    try {
      const descriptor = Reflect.getOwnPropertyDescriptor(environment, '__auditaHighlightInstallV1');
      return Boolean(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value === claim &&
        !descriptor.enumerable && descriptor.configurable && !descriptor.writable);
    } catch {
      return false;
    }
  }

  function releaseInstallClaim(claim) {
    let released = false;
    try {
      if (claimOwned(claim)) {
        released = Reflect.deleteProperty(environment, '__auditaHighlightInstallV1') &&
          !Object.hasOwn(environment, '__auditaHighlightInstallV1');
      }
    } catch {
      released = false;
    }
    return released;
  }

  function queryExact(selector) {
    try {
      const matches = environment.document.querySelectorAll(selector.value);
      if (!matches || matches.length !== 1) return null;
      return matches[0] ?? null;
    } catch {
      return null;
    }
  }

  function roleForSignature(node) {
    const allowedRoles = new Set([
      'alert', 'button', 'checkbox', 'dialog', 'heading', 'img', 'link', 'list', 'listitem',
      'main', 'menu', 'menuitem', 'navigation', 'option', 'radio', 'region', 'search', 'slider',
      'spinbutton', 'status', 'switch', 'tab', 'tabpanel', 'textbox',
    ]);
    const tag = node.tag;
    const explicitRole = node.role;
    if (explicitRole !== null) {
      for (const token of explicitRole.split(/[\t\n\f\r ]+/u)) if (allowedRoles.has(token)) return token;
    }
    if ((tag === 'a' || tag === 'area') && node.href !== null) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const rawType = node.type;
      const type = rawType === null || rawType === '' ? 'text' : rawType.toLowerCase();
      if (new Set(['button', 'file', 'image', 'reset', 'submit']).has(type)) return 'button';
      if (new Set(['email', 'password', 'search', 'tel', 'text', 'url']).has(type)) return 'textbox';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'number') return 'spinbutton';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (new Set(['color', 'date', 'datetime-local', 'hidden', 'month', 'time', 'week']).has(type)) return null;
      return 'textbox';
    }
    if (tag === 'select') return null;
    if (tag === 'textarea') return 'textbox';
    if (tag === 'img') return 'img';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'listitem';
    if (/^h[1-6]$/u.test(tag)) return 'heading';
    if (tag === 'dialog') return 'dialog';
    return null;
  }

  function safeAttribute(element, name) {
    if (!element || typeof element.getAttribute !== 'function') throw new TypeError('invalid element');
    const value = element.getAttribute(name);
    if (value !== null && typeof value !== 'string') throw new TypeError('invalid attribute');
    return value;
  }

  function boundedAttribute(element, name, maximum) {
    const value = safeAttribute(element, name);
    if (value !== null && value.length > maximum) throw new TypeError('attribute budget');
    return value;
  }

  function elementTag(element) {
    const rawTag = element?.tagName;
    if (typeof rawTag !== 'string' || rawTag.length > 63) throw new TypeError('invalid tag');
    const tag = rawTag.toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,62}$/u.test(tag)) throw new TypeError('invalid tag');
    return tag;
  }

  function childSnapshot(parent) {
    const collection = parent?.children;
    const length = collection?.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > 10_000) throw new TypeError('invalid children');
    const children = [];
    for (let index = 0; index < length; index += 1) {
      const child = collection[index];
      if (!child) throw new TypeError('invalid child');
      children.push(child);
    }
    if (collection.length !== length) throw new TypeError('changed children');
    return children;
  }

  function nthOfType(element) {
    const tag = elementTag(element);
    const parent = element.parentElement ?? element.parentNode;
    let ordinal = 0;
    let found = null;
    for (const sibling of childSnapshot(parent)) {
      if (elementTag(sibling) !== tag) continue;
      ordinal += 1;
      if (sibling === element) found = ordinal;
    }
    if (!Number.isSafeInteger(found) || found < 1) throw new TypeError('invalid ordinal');
    return found;
  }

  function signatureSafeToken(value) {
    const sensitive = /(?:pass(?:word|wd)?|token|secret|auth(?:orization)?|session|cookie|csrf|xsrf|otp|one[-_]?time|api[-_]?key)/iu;
    return typeof value === 'string' && value.length >= 1 && value.length <= 23 &&
      /^-?[_A-Za-z][_A-Za-z0-9-]*$/u.test(value) && !sensitive.test(value) && !/@|:\/\/|www\./iu.test(value) &&
      !/[0-9]{4}/u.test(value) && !/[0-9a-f]{8}/iu.test(value) &&
      !/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/iu.test(value);
  }

  function snapshotStructure(element) {
    const nodes = [];
    const seen = new Set();
    let current = element;
    let reachedDocument = false;
    for (let depth = 1; depth <= MAX_HIGHLIGHT_ANCESTRY; depth += 1) {
      if (!current || seen.has(current)) throw new TypeError('invalid ancestry');
      seen.add(current);
      nodes.push({
        element: current,
        tag: elementTag(current),
        nthOfType: nthOfType(current),
        role: boundedAttribute(current, 'role', 512),
        type: boundedAttribute(current, 'type', 128),
        href: safeAttribute(current, 'href'),
      });
      if (current.parentNode === environment.document) {
        reachedDocument = true;
        break;
      }
      current = current.parentElement;
    }
    if (!reachedDocument) throw new TypeError('document not reached');
    return {
      element,
      computedRole: roleForSignature(nodes[0]),
      nodes,
    };
  }

  function sameStructure(left, right) {
    if (!left || !right || left.element !== right.element || left.computedRole !== right.computedRole ||
      left.nodes.length !== right.nodes.length) return false;
    for (let index = 0; index < left.nodes.length; index += 1) {
      const before = left.nodes[index];
      const after = right.nodes[index];
      if (before.element !== after.element || before.tag !== after.tag || before.nthOfType !== after.nthOfType ||
        before.role !== after.role || before.type !== after.type || before.href !== after.href) return false;
    }
    return true;
  }

  async function canonicalSignatureInput({ documentId, frameId, structure }) {
    const ancestry = [];
    for (const node of structure.nodes) {
      const attributes = [];
      for (const [name, rawValue] of [['role', node.role], ['type', node.type]]) {
        if (rawValue !== null && signatureSafeToken(rawValue)) {
          attributes.push({
            name,
            valueSha256: await digestHex(new TextEncoder().encode(rawValue)),
          });
        }
      }
      ancestry.push({ tag: node.tag, nthOfType: node.nthOfType, attributes });
    }

    const record = {
      version: 'StructuralSignatureInputV1',
      documentId,
      frameId,
      tag: structure.nodes[0].tag,
      computedRole: structure.computedRole,
      ancestry,
    };

    const serialize = value => {
      if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
        if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('invalid number');
        return JSON.stringify(value);
      }
      if (Array.isArray(value)) return `[${value.map(entry => serialize(entry)).join(',')}]`;
      const keys = Object.keys(value).sort();
      return `{${keys.map(key => `${JSON.stringify(key)}:${serialize(value[key])}`).join(',')}}`;
    };
    return serialize(record);
  }

  async function digestHex(bytes) {
    const subtle = environment?.crypto?.subtle;
    if (!subtle || typeof subtle.digest !== 'function') throw new TypeError('crypto unavailable');
    const digest = await subtle.digest('SHA-256', bytes);
    const output = new Uint8Array(digest);
    if (output.byteLength !== 32) throw new TypeError('invalid digest');
    return [...output].map(value => value.toString(16).padStart(2, '0')).join('');
  }

  function sameDigest(expected, actual) {
    if (typeof expected !== 'string' || typeof actual !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(expected) || !/^[0-9a-f]{64}$/u.test(actual)) return false;
    let difference = 0;
    for (let index = 0; index < 64; index += 2) {
      difference |= Number.parseInt(expected.slice(index, index + 2), 16) ^
        Number.parseInt(actual.slice(index, index + 2), 16);
    }
    return difference === 0;
  }

  function sameInstallCommand(left, right) {
    try {
      return Boolean(left && right && left.version === right.version && left.op === right.op &&
        left.nonce === right.nonce && left.documentId === right.documentId && left.frameId === right.frameId &&
        left.kind === right.kind && left.markerNumber === right.markerNumber &&
        left.selector?.syntax === right.selector.syntax && left.selector?.value === right.selector.value &&
        left.selector?.byteLength === right.selector.byteLength && left.selector?.complexity === right.selector.complexity &&
        left.structuralSignature?.version === right.structuralSignature.version &&
        left.structuralSignature?.sha256 === right.structuralSignature.sha256);
    } catch {
      return false;
    }
  }

  function inlineStyleFingerprint(element) {
    const style = element?.style;
    if (!style || typeof style !== 'object') throw new TypeError('style unavailable');
    if (typeof style.cssText === 'string') return `css:${style.cssText}`;
    const keys = Reflect.ownKeys(style);
    if (keys.some(key => typeof key !== 'string')) throw new TypeError('invalid style');
    keys.sort();
    const entries = [];
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(style, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('invalid style');
      entries.push([key, descriptor.value]);
    }
    return `plain:${JSON.stringify(entries)}`;
  }

  function makeRoot(install) {
    const document = environment.document;
    const root = document.createElement('div');
    const marker = document.createElement('span');
    const label = document.createElement('span');
    root.setAttribute('data-audita-highlight-root', 'v1');
    root.setAttribute('aria-hidden', 'true');
    root.tabIndex = -1;
    Object.defineProperty(root, '__auditaHighlightOwnerV1', {
      value: install.nonce,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    const color = install.kind === 'failed' ? 'rgb(139, 30, 30)' : 'rgb(107, 78, 0)';
    const shadow = ringShadow(color);
    root.style.all = 'initial';
    root.style.position = 'fixed';
    root.style.display = 'block';
    root.style.visibility = 'visible';
    root.style.opacity = '1';
    root.style.boxSizing = 'border-box';
    root.style.pointerEvents = 'none';
    root.style.zIndex = '2147483647';
    root.style.background = 'transparent';
    root.style.outline = '2px solid CanvasText';
    root.style.outlineOffset = '2px';
    root.style.borderWidth = `${BORDER}px`;
    // Dashed keeps a non-colour cue for the manual-review kind; both are solid at the core because
    // the contour is now a rectangle outside the element, not a heavy inner frame.
    root.style.borderStyle = install.kind === 'failed' ? 'solid' : 'dashed';
    root.style.borderColor = color;
    root.style.borderRadius = '3px';
    root.style.boxShadow = shadow;

    // The tab is the marker chip ("17×") glued to the descriptor: one visual piece, two spans, so
    // the number and the plain-language meaning stay separate for the runtime integrity check.
    const chip = (element, padding, lineHeight) => {
      element.tabIndex = -1;
      element.style.all = 'initial';
      element.style.position = 'absolute';
      element.style.display = 'flex';
      element.style.alignItems = 'center';
      element.style.justifyContent = 'center';
      element.style.boxSizing = 'border-box';
      element.style.visibility = 'visible';
      element.style.opacity = '1';
      element.style.pointerEvents = 'none';
      element.style.height = `${LABEL_HEIGHT}px`;
      element.style.padding = padding;
      element.style.border = '1px solid #ffffff';
      element.style.background = color;
      element.style.color = '#ffffff';
      element.style.font = `700 14px/${lineHeight} system-ui, sans-serif`;
      element.style.whiteSpace = 'nowrap';
    };
    marker.textContent = `${install.markerNumber}${install.kind === 'failed' ? '×' : '?'}`;
    chip(marker, '0 8px', '1');
    label.textContent = install.kind === 'failed' ? 'Falha confirmada' : 'Revisão humana necessária';
    chip(label, '0 10px', '1.25');

    root.appendChild(marker);
    root.appendChild(label);
    return {
      root,
      marker,
      label,
      markerText: marker.textContent,
      labelText: label.textContent,
      borderWidth: root.style.borderWidth,
      borderStyle: root.style.borderStyle,
      borderColor: root.style.borderColor,
      // Read back like every other property: Chrome rewrites a shadow into its own order and
      // serialization, and the runtime integrity check compares against what the DOM returns.
      boxShadow: root.style.boxShadow,
      chipBackground: color,
      // Read back from the DOM: Chrome rewrites `#ffffff` as `rgb(255, 255, 255)` in both
      // `style.color` and `style.border`, and the runtime check compares against the DOM.
      chipColor: marker.style.color,
      chipBorder: marker.style.border,
      markerFont: marker.style.font,
      labelFont: label.style.font,
    };
  }

  // The tab is never measured from the page unless the browser reports a usable inline size.
  function tabWidth(element) {
    try {
      const measured = Number(element.offsetWidth);
      if (Number.isFinite(measured) && measured >= 16 && measured <= MAX_LABEL_WIDTH) return measured;
    } catch { /* fall through to the character estimate */ }
    const text = typeof element.textContent === 'string' ? element.textContent : '';
    return Math.min(MAX_LABEL_WIDTH, Math.max(MIN_LABEL_WIDTH, 12 + (text.length * 8)));
  }

  function viewportBounds() {
    const width = environment.innerWidth;
    const height = environment.innerHeight;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
    }
    return { left: 0, top: 0, right: width, bottom: height };
  }

  // Candidates in order: glued above the contour, hanging below it when there is no room (the
  // 22px rule), riding the top of the viewport when the element starts above the screen, and always
  // clamped inside the viewport so the tab can never leave the screen.
  function placeTab(ring, width, height, bounds) {
    const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
    const maxLeft = Math.max(bounds.left, bounds.right - width);
    const minTop = bounds.top;
    const maxTop = Math.max(bounds.top, bounds.bottom - height);
    const aboveTop = ring.top - height;
    if (ring.top - bounds.top >= MIN_ABOVE && aboveTop >= bounds.top) {
      return { left: clamp(ring.left, bounds.left, maxLeft), top: clamp(aboveTop, minTop, maxTop), side: 'above' };
    }
    if (ring.top < bounds.top) {
      const bandLeft = clamp(ring.left, bounds.left, maxLeft);
      const bandRight = clamp(ring.left + ring.width - width, bandLeft, maxLeft);
      return { left: clamp(ring.left, bandLeft, bandRight), top: minTop, side: 'above' };
    }
    return { left: clamp(ring.left, bounds.left, maxLeft),
      top: clamp(ring.top + ring.height, minTop, maxTop), side: 'below' };
  }

  function renderedRect(target) {
    if (!target || target.isConnected !== true || typeof target.getBoundingClientRect !== 'function') return null;
    const rect = target.getBoundingClientRect();
    if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top) ||
      !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) return null;
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }

  function positionRoot(state, rect) {
    if (state.disposed || !rect) return false;
    const root = state.root;
    const left = rect.left - GAP - BORDER;
    const top = rect.top - GAP - BORDER;
    const width = rect.width + (2 * (GAP + BORDER));
    const height = rect.height + (2 * (GAP + BORDER));
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    root.style.width = `${width}px`;
    root.style.height = `${height}px`;
    root.style.borderWidth = `${BORDER}px`;

    // Children are positioned against the padding box, so the border offset is added back here.
    const markerWidth = tabWidth(state.marker);
    const labelWidth = tabWidth(state.label);
    const spot = placeTab({ left, top, width, height }, markerWidth + labelWidth - 1,
      LABEL_HEIGHT, viewportBounds());
    const originX = left + BORDER;
    const originY = top + BORDER;
    const markerLeft = `${spot.left - originX}px`;
    const markerTop = `${spot.top - originY}px`;
    state.marker.style.width = `${markerWidth}px`;
    state.marker.style.height = `${LABEL_HEIGHT}px`;
    state.marker.style.left = markerLeft;
    state.marker.style.top = markerTop;
    state.marker.style.borderRadius = spot.side === 'below' ? '0 0 0 4px' : '4px 0 0 0';
    state.label.style.width = `${labelWidth}px`;
    state.label.style.height = `${LABEL_HEIGHT}px`;
    state.label.style.left = `${spot.left - originX + markerWidth - 1}px`;
    state.label.style.top = markerTop;
    state.label.style.borderRadius = spot.side === 'below' ? '0 0 4px 0' : '0 4px 0 0';

    state.geometry = {
      left: root.style.left,
      top: root.style.top,
      width: root.style.width,
      height: root.style.height,
      // Read back from the DOM like the root rectangle: the browser may normalize the serialization
      // of a fractional offset, and the runtime integrity check compares against what it reads.
      markerLeft: state.marker.style.left,
      markerTop: state.marker.style.top,
      markerWidth: state.marker.style.width,
      markerHeight: state.marker.style.height,
      markerRadius: state.marker.style.borderRadius,
      labelLeft: state.label.style.left,
      labelTop: state.label.style.top,
      labelWidth: state.label.style.width,
      labelHeight: state.label.style.height,
      labelRadius: state.label.style.borderRadius,
      side: spot.side,
    };
    state.rootStyleFingerprint = inlineStyleFingerprint(root);
    state.markerStyleFingerprint = inlineStyleFingerprint(state.marker);
    state.labelStyleFingerprint = inlineStyleFingerprint(state.label);
    return true;
  }

  function overlayRuntimeIntact(state) {
    try {
      if (!state || state.version !== 1 || state.disposed || typeof state.nonce !== 'string') return false;
      const { root, marker, label } = state;
      const owner = Reflect.getOwnPropertyDescriptor(root, '__auditaHighlightOwnerV1');
      if (!owner || owner.value !== state.nonce || owner.enumerable || owner.configurable || owner.writable ||
        root.isConnected !== true || root.parentNode !== environment.document.documentElement ||
        root.getAttribute('data-audita-highlight-root') !== 'v1' || root.getAttribute('aria-hidden') !== 'true' ||
        root.getAttribute('id') !== null || root.getAttribute('class') !== null || root.getAttribute('hidden') !== null ||
        root.getAttribute('inert') !== null ||
        root.tabIndex !== -1 || root.style.pointerEvents !== 'none' || root.style.position !== 'fixed' ||
        root.style.borderWidth !== state.borderWidth || root.style.borderStyle !== state.borderStyle ||
        root.style.borderColor !== state.borderColor || root.style.borderRadius !== '3px' ||
        root.style.boxShadow !== state.boxShadow || root.style.left !== state.geometry.left ||
        root.style.top !== state.geometry.top || root.style.width !== state.geometry.width ||
        root.style.height !== state.geometry.height || inlineStyleFingerprint(root) !== state.rootStyleFingerprint ||
        inlineStyleFingerprint(marker) !== state.markerStyleFingerprint ||
        inlineStyleFingerprint(label) !== state.labelStyleFingerprint) return false;
      const children = childSnapshot(root);
      if (children.length !== 2 || children[0] !== marker || children[1] !== label) return false;
      for (const [child, expectedText, geometry, prefix] of [
        [marker, state.markerText, { left: state.geometry.markerLeft, top: state.geometry.markerTop,
          width: state.geometry.markerWidth, height: state.geometry.markerHeight,
          radius: state.geometry.markerRadius }, 'marker'],
        [label, state.labelText, { left: state.geometry.labelLeft, top: state.geometry.labelTop,
          width: state.geometry.labelWidth, height: state.geometry.labelHeight,
          radius: state.geometry.labelRadius }, 'label'],
      ]) {
        if (child.parentNode !== root || child.isConnected !== true || elementTag(child) !== 'span' ||
          child.tabIndex !== -1 || child.style.pointerEvents !== 'none' || child.textContent !== expectedText ||
          child.style.left !== geometry.left || child.style.top !== geometry.top ||
          child.style.width !== geometry.width || child.style.height !== geometry.height ||
          child.style.borderRadius !== geometry.radius || child.style.background !== state.chipBackground ||
          child.style.color !== state.chipColor || child.style.border !== state.chipBorder ||
          child.style.font !== (prefix === 'marker' ? state.markerFont : state.labelFont) ||
          child.style.opacity !== '1' || child.style.visibility !== 'visible' ||
          childSnapshot(child).length !== 0 || child.getAttribute('role') !== null ||
          child.getAttribute('href') !== null || child.getAttribute('contenteditable') !== null ||
          child.getAttribute('id') !== null || child.getAttribute('class') !== null ||
          child.getAttribute('hidden') !== null || child.getAttribute('inert') !== null) return false;
      }
      if (typeof environment.getComputedStyle === 'function') {
        const computedRoot = environment.getComputedStyle(root);
        const computedMarker = environment.getComputedStyle(marker);
        const computedLabel = environment.getComputedStyle(label);
        for (const [computed, display, position] of [
          [computedRoot, 'block', 'fixed'],
          [computedMarker, 'flex', 'absolute'],
          [computedLabel, 'flex', 'absolute'],
        ]) {
          if (!computed || computed.display !== display || computed.visibility !== 'visible' ||
            Number(computed.opacity) !== 1 || computed.pointerEvents !== 'none' ||
            computed.position !== position || computed.boxSizing !== 'border-box') return false;
        }
        const transparent = String(computedRoot.backgroundColor).toLowerCase().replaceAll(' ', '');
        if (computedRoot.zIndex !== '2147483647' ||
          !['transparent', 'rgba(0,0,0,0)'].includes(transparent) ||
          computedRoot.outlineStyle !== 'solid' || computedRoot.outlineWidth !== '2px' ||
          computedRoot.outlineOffset !== '2px' || computedRoot.borderWidth !== state.borderWidth ||
          computedRoot.borderStyle !== state.borderStyle ||
          String(computedRoot.boxShadow) !== state.boxShadow ||
          computedMarker.width !== state.geometry.markerWidth ||
          computedMarker.height !== state.geometry.markerHeight ||
          computedLabel.width !== state.geometry.labelWidth ||
          computedLabel.height !== state.geometry.labelHeight) return false;
        let forcedColors = false;
        if (typeof environment.matchMedia === 'function') {
          const query = environment.matchMedia('(forced-colors: active)');
          if (!query || typeof query.matches !== 'boolean') return false;
          forcedColors = query.matches;
        }
        if (!forcedColors) {
          const expectedBackground = state.borderColor.toLowerCase().replaceAll(' ', '');
          if (String(computedMarker.backgroundColor).toLowerCase().replaceAll(' ', '') !== expectedBackground ||
            String(computedLabel.backgroundColor).toLowerCase().replaceAll(' ', '') !== expectedBackground) return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  function validateActiveState(state) {
    if (!overlayRuntimeIntact(state)) return { ok: false, reason: 'runtime-error' };
    if (state.target.isConnected !== true || queryExact(state.selector) !== state.target) {
      return { ok: false, reason: 'target-not-unique' };
    }
    let currentStructure;
    try {
      currentStructure = snapshotStructure(state.target);
    } catch {
      return { ok: false, reason: 'signature-mismatch' };
    }
    if (!sameStructure(state.structure, currentStructure)) return { ok: false, reason: 'signature-mismatch' };
    const rect = renderedRect(state.target);
    if (rect === null) return { ok: false, reason: 'target-not-rendered' };
    return { ok: true, rect };
  }

  function notifyInvalidation(state) {
    if (state.notified) return;
    state.notified = true;
    try {
      const sendMessage = environment?.chrome?.runtime?.sendMessage;
      if (typeof sendMessage !== 'function') return;
      const pending = sendMessage.call(environment.chrome.runtime, {
        type: 'AUDITA_HIGHLIGHT_INVALIDATED',
        nonce: state.nonce,
      });
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {
      // Invalidation is best-effort because page teardown can stop the extension runtime first.
    }
  }

  function dispose(state, autonomous) {
    if (!state || state.disposed) return;
    state.disposed = true;
    if (state.animationFrame !== null) {
      try { environment.cancelAnimationFrame(state.animationFrame); } catch { /* best effort */ }
      state.animationFrame = null;
    }
    try { state.observer?.disconnect(); } catch { /* best effort */ }
    for (const [type, listener, options] of state.listeners) {
      try { environment.removeEventListener(type, listener, options); } catch { /* best effort */ }
    }
    state.listeners.length = 0;
    try {
      if (typeof state.root.remove === 'function') state.root.remove();
      else state.root.parentNode?.removeChild(state.root);
    } catch { /* best effort */ }
    try {
      const descriptor = Reflect.getOwnPropertyDescriptor(environment, '__auditaHighlightOverlayV1');
      if (descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value === state) {
        Reflect.deleteProperty(environment, '__auditaHighlightOverlayV1');
      }
    } catch { /* best effort */ }
    if (autonomous) notifyInvalidation(state);
  }

  let ownedInstallClaim = null;
  let provisionalState = null;
  try {
    const install = parseInstall(command);
    const clear = install === null ? parseClear(command) : null;
    if (install === null && clear === null) return { ok: false, reason: 'invalid-command' };

    if (install !== null) {
      const claim = acquireInstallClaim(install.nonce);
      if (claim.state === 'invalid') return { ok: false, reason: 'runtime-error' };
      if (claim.state === 'active') return { ok: false, reason: 'runtime-error' };
      ownedInstallClaim = claim.claim;
    } else {
      const claim = inspectInstallClaim();
      if (claim.state === 'invalid') return { ok: false, reason: 'runtime-error' };
      if (claim.state === 'active') {
        if (claim.nonce !== clear.nonce) return { ok: false, reason: 'nonce-mismatch' };
        return { ok: false, reason: 'runtime-error' };
      }
    }

    const currentDescriptor = Reflect.getOwnPropertyDescriptor(environment, '__auditaHighlightOverlayV1');
    if (currentDescriptor && (!Object.hasOwn(currentDescriptor, 'value') || !currentDescriptor.value ||
      typeof currentDescriptor.value !== 'object' || typeof currentDescriptor.value.dispose !== 'function')) {
      return { ok: false, reason: 'runtime-error' };
    }
    const current = currentDescriptor?.value ?? null;

    if (clear !== null) {
      if (current === null) return { ok: true, nonce: clear.nonce };
      if (current.nonce !== clear.nonce) return { ok: false, reason: 'nonce-mismatch' };
      current.dispose(false);
      return { ok: true, nonce: clear.nonce };
    }

    if (!claimOwned(ownedInstallClaim)) {
      return { ok: false, reason: 'runtime-error' };
    }

    if (current?.nonce === install.nonce) {
      if (!sameInstallCommand(current.install, install)) return { ok: false, reason: 'runtime-error' };
      const validation = validateActiveState(current);
      if (!validation.ok) {
        current.dispose(true);
        return { ok: false, reason: validation.reason };
      }
      positionRoot(current, validation.rect);
      return { ok: true, nonce: install.nonce };
    }
    if (current !== null) current.dispose(false);

    const target = queryExact(install.selector);
    if (target === null) return { ok: false, reason: 'target-not-unique' };
    const structure = snapshotStructure(target);
    const canonical = await canonicalSignatureInput({
      documentId: install.documentId,
      frameId: install.frameId,
      structure,
    });
    if (!claimOwned(ownedInstallClaim)) return { ok: false, reason: 'runtime-error' };
    const actualDigest = await digestHex(new TextEncoder().encode(canonical));
    if (!claimOwned(ownedInstallClaim)) return { ok: false, reason: 'runtime-error' };
    if (!sameDigest(install.structuralSignature.sha256, actualDigest)) {
      return { ok: false, reason: 'signature-mismatch' };
    }
    if (renderedRect(target) === null) return { ok: false, reason: 'target-not-rendered' };
    if (typeof target.scrollIntoView !== 'function') return { ok: false, reason: 'runtime-error' };
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    const finalTarget = queryExact(install.selector);
    if (finalTarget !== target) return { ok: false, reason: 'target-not-unique' };
    const finalStructure = snapshotStructure(target);
    if (!sameStructure(structure, finalStructure)) return { ok: false, reason: 'signature-mismatch' };
    const rect = renderedRect(target);
    if (rect === null) return { ok: false, reason: 'target-not-rendered' };
    if (!claimOwned(ownedInstallClaim)) return { ok: false, reason: 'runtime-error' };

    const documentElement = environment?.document?.documentElement;
    if (!documentElement || typeof documentElement.appendChild !== 'function' ||
      typeof environment.addEventListener !== 'function' || typeof environment.removeEventListener !== 'function' ||
      typeof environment.requestAnimationFrame !== 'function' || typeof environment.cancelAnimationFrame !== 'function' ||
      typeof environment.MutationObserver !== 'function') return { ok: false, reason: 'runtime-error' };

    const visual = makeRoot(install);
    const { root } = visual;

    const state = {
      version: 1,
      nonce: install.nonce,
      install,
      selector: install.selector,
      target,
      structure,
      root,
      marker: visual.marker,
      label: visual.label,
      markerText: visual.markerText,
      labelText: visual.labelText,
      borderWidth: visual.borderWidth,
      borderStyle: visual.borderStyle,
      borderColor: visual.borderColor,
      boxShadow: visual.boxShadow,
      chipBackground: visual.chipBackground,
      chipColor: visual.chipColor,
      chipBorder: visual.chipBorder,
      markerFont: visual.markerFont,
      labelFont: visual.labelFont,
      rootStyleFingerprint: '',
      markerStyleFingerprint: '',
      labelStyleFingerprint: '',
      geometry: null,
      observer: null,
      listeners: [],
      animationFrame: null,
      notified: false,
      disposed: false,
      dispose: null,
    };
    state.dispose = autonomous => dispose(state, autonomous === true);
    provisionalState = state;
    // The first placement fixes the contour, the tab side and the style fingerprints the runtime
    // integrity check compares against on every later validation.
    positionRoot(state, rect);
    if (!claimOwned(ownedInstallClaim)) {
      state.dispose(false);
      return { ok: false, reason: 'runtime-error' };
    }

    Object.defineProperty(environment, '__auditaHighlightOverlayV1', {
      value: state,
      enumerable: false,
      configurable: true,
      writable: false,
    });
    documentElement.appendChild(root);
    if (!overlayRuntimeIntact(state)) {
      state.dispose(false);
      return { ok: false, reason: 'runtime-error' };
    }

    const scheduleValidation = () => {
      if (state.disposed || state.animationFrame !== null) return;
      try {
        const animationFrame = environment.requestAnimationFrame(() => {
          state.animationFrame = null;
          const validation = validateActiveState(state);
          if (!validation.ok) {
            dispose(state, true);
            return;
          }
          positionRoot(state, validation.rect);
        });
        if (!Number.isSafeInteger(animationFrame) || animationFrame < 0) {
          dispose(state, true);
          return;
        }
        state.animationFrame = animationFrame;
      } catch {
        dispose(state, true);
      }
    };
    const onKeyDown = event => {
      if (event?.key === 'Escape') dispose(state, true);
    };
    const onPageHide = () => dispose(state, true);
    for (const [type, listener, options] of [
      ['scroll', scheduleValidation, true],
      ['resize', scheduleValidation, true],
      ['keydown', onKeyDown, true],
      ['pagehide', onPageHide, true],
    ]) {
      state.listeners.push([type, listener, options]);
      environment.addEventListener(type, listener, options);
    }

    state.observer = new environment.MutationObserver(records => {
      if (state.disposed) return;
      if (!overlayRuntimeIntact(state)) {
        dispose(state, true);
        return;
      }
      let onlyOwnedStyle = false;
      try {
        const length = records?.length;
        onlyOwnedStyle = Number.isSafeInteger(length) && length > 0 && length <= 10_000;
        for (let index = 0; onlyOwnedStyle && index < length; index += 1) {
          const record = records[index];
          if (record?.type !== 'attributes' || record.attributeName !== 'style' ||
            ![state.root, state.marker, state.label].includes(record.target)) onlyOwnedStyle = false;
        }
      } catch {
        onlyOwnedStyle = false;
      }
      if (!onlyOwnedStyle) scheduleValidation();
    });
    state.observer.observe(documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    return { ok: true, nonce: install.nonce };
  } catch {
    try {
      if (provisionalState !== null) {
        provisionalState.dispose(false);
      } else {
        const descriptor = Reflect.getOwnPropertyDescriptor(environment, '__auditaHighlightOverlayV1');
        if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value?.dispose === 'function') {
          descriptor.value.dispose(false);
        }
      }
    } catch { /* closed runtime failure */ }
    return { ok: false, reason: 'runtime-error' };
  } finally {
    if (ownedInstallClaim !== null) releaseInstallClaim(ownedInstallClaim);
  }
}
