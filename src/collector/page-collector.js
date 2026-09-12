/**
 * Browser-world collector. Keep every dependency inside the function so
 * chrome.scripting can serialize it as `func` under Manifest V3 CSP.
 */
export function collectRuntimePageData() {
  const sensitive = /(?:pass(?:word|wd)?|token|secret|auth(?:orization)?|session|cookie|csrf|xsrf|otp|one[-_ ]?time|api[-_ ]?key)/iu;
  const styleNames = [
    'display', 'visibility', 'opacity', 'color', 'background-color', 'background-image',
    'font-family', 'font-size', 'font-weight', 'line-height', 'text-align', 'direction',
    'letter-spacing', 'word-spacing', 'outline-color', 'outline-style',
    'outline-width', 'box-shadow', 'text-decoration-color', 'overflow-x',
    'overflow-y', 'animation-duration', 'animation-iteration-count',
    'transition-duration'
  ];
  const cleanUrl = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return '';
    if (/^data:/iu.test(value)) return 'data:[redacted]';
    if (/^blob:/iu.test(value)) return 'blob:[redacted]';
    try {
      const url = new URL(value, document.baseURI);
      url.username = '';
      url.password = '';
      for (const key of [...url.searchParams.keys()]) {
        if (sensitive.test(key)) url.searchParams.delete(key);
      }
      if (sensitive.test(url.hash)) url.hash = '';
      return url.href;
    } catch {
      return '';
    }
  };
  const backgroundKind = value => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized || normalized === 'none') return 'none';
    const url = /url\s*\(/u.test(normalized);
    const gradient = /(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/u.test(normalized);
    return url && gradient ? 'mixed' : url ? 'url' : gradient ? 'gradient' : 'mixed';
  };
  const opaqueColor = value => {
    const color = String(value || '').trim().toLowerCase();
    return /^rgb\(/u.test(color) || /^#[0-9a-f]{6}$/u.test(color) || /^#[0-9a-f]{3}$/u.test(color) ||
      /^rgba\([^)]*,\s*1\s*\)$/u.test(color);
  };
  const contrastReliable = element => {
    let current = element;
    let opaqueBackground = false;
    const visited = new Set();
    while (current instanceof Element && !visited.has(current)) {
      visited.add(current);
      const computed = getComputedStyle(current);
      if (Number(computed.opacity) !== 1) return false;
      if (!opaqueBackground) {
        if (backgroundKind(computed.getPropertyValue('background-image')) !== 'none') return false;
        opaqueBackground = opaqueColor(computed.getPropertyValue('background-color'));
      }
      current = current.assignedSlot || current.parentElement || current.getRootNode()?.host || null;
    }
    return opaqueBackground;
  };
  const identifierIsSensitive = (element) => sensitive.test([
    element.getAttribute('name'), element.id, element.getAttribute('autocomplete')
  ].filter(Boolean).join(' '));
  const isSensitiveControl = element => element instanceof HTMLInputElement && (
    element.type === 'password' ||
    /^(?:current-password|new-password|one-time-code)$/iu.test(element.autocomplete || '') ||
    (element.type === 'hidden' && identifierIsSensitive(element))
  );
  const isEditable = element => {
    if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) return true;
    const value = String(element.getAttribute?.('contenteditable') ?? '').trim().toLowerCase();
    return element.hasAttribute?.('contenteditable') === true && !['false', 'inherit'].includes(value);
  };
  const contextState = element => {
    let current = element;
    const visited = new Set();
    try {
      while (current instanceof Element && !visited.has(current) && visited.size < 64) {
        visited.add(current);
        if (isSensitiveControl(current) || isEditable(current)) return 'private';
        if (current.hasAttribute?.('hidden') === true || current.hasAttribute?.('inert') === true ||
          String(current.getAttribute?.('aria-hidden') || '').trim().toLowerCase() === 'true') return 'inaccessible';
        const computed = getComputedStyle(current);
        if (String(computed.display || computed.getPropertyValue?.('display') || '').trim().toLowerCase() === 'none' ||
          String(computed.visibility || computed.getPropertyValue?.('visibility') || '').trim().toLowerCase() === 'hidden') {
          return 'inaccessible';
        }
        current = current.parentElement;
      }
      return current instanceof Element ? 'unknown' : 'accessible';
    } catch {
      return 'unknown';
    }
  };
  const safeContextText = element => {
    if (!(element instanceof Element) || contextState(element) !== 'accessible') return '';
    try { return String(element.innerText || '').replace(/\s+/gu, ' ').trim().slice(0, 512); } catch { return ''; }
  };
  const contextReadable = element => element instanceof Element && contextState(element) === 'accessible';
  const warningText = value => {
    const normalized = String(value || '').normalize('NFKC').toLocaleLowerCase('pt-BR').replace(/\s+/gu, ' ').trim();
    return ['nova aba', 'nova guia', 'nova janela', 'abre em nova aba', 'abre em nova guia', 'abre em nova janela']
      .some(phrase => normalized.includes(phrase));
  };
  const contextObservation = element => {
    const parent = element.parentElement;
    if (!(parent instanceof Element) || contextState(element) !== 'accessible') return 'unknown-context';
    try {
      const siblings = [...(parent.children || [])].filter(candidate => candidate !== element);
      if (siblings.some(candidate => contextReadable(candidate) && safeContextText(candidate))) return 'potential-context';
      return siblings.every(contextReadable) ? 'missing-context' : 'unknown-context';
    } catch {
      return 'unknown-context';
    }
  };
  const adjacentWarning = element => {
    try {
      if (contextState(element) !== 'accessible') return undefined;
      const directions = [
        ['previousSibling', 'previousSibling'],
        ['nextSibling', 'nextSibling'],
      ];
      for (const [initialField, nextField] of directions) {
        let current = element[initialField];
        for (let count = 0; current && count < 4; count += 1) {
          const elementNode = current instanceof Element;
          const textNode = current?.nodeType === Node.TEXT_NODE;
          if (!elementNode && !textNode) return undefined;
          const state = contextState(elementNode ? current : current.parentElement);
          if (state === 'private' || state === 'unknown') return undefined;
          if (state === 'accessible') {
            let value;
            try {
              value = elementNode ? current.innerText : current.nodeValue;
            } catch {
              return undefined;
            }
            if (warningText(String(value || '').slice(0, 512))) return true;
          }
          current = current[nextField];
        }
        if (current) return undefined;
      }
      return false;
    } catch {
      return undefined;
    }
  };
  const cssEscape = value => {
    if (globalThis.CSS?.escape) return CSS.escape(value);
    return [...String(value)].map((char, index) => {
      const code = char.codePointAt(0);
      if (code === 0) return '\uFFFD';
      if ((index === 0 && /[0-9]/u.test(char)) || (index === 1 && /[0-9]/u.test(char) && value[0] === '-')) return `\\${code.toString(16)} `;
      return /[a-zA-Z0-9_-]/u.test(char) ? char : `\\${char}`;
    }).join('');
  };
  const selector = (element) => {
    if (element.id && !sensitive.test(element.id)) return `#${cssEscape(element.id)}`;
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 12) {
      let part = current.localName;
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(item => item.localName === current.localName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      const root = current.getRootNode();
      if (root instanceof ShadowRoot) {
        current = root.host;
        parts.unshift('::shadow');
      } else {
        current = parent;
      }
    }
    return parts.join(' > ');
  };
  const elements = [];
  const visit = root => {
    for (const element of root.children || []) {
      elements.push(element);
      if (element.shadowRoot) visit(element.shadowRoot);
      visit(element);
    }
  };
  visit(document);
  // Reuse a single read-only geometry sample. No focus, scroll, emulation or
  // synthetic input is needed to measure ordinary visible native controls.
  const geometry = new Map(elements.map(element => [element, {
    rect: element.getBoundingClientRect(), computed: getComputedStyle(element)
  }]));
  const composedParent = element => element.assignedSlot || element.parentElement || element.getRootNode()?.host || null;
  const containsComposed = (parent, child) => {
    for (let current = child; current; current = composedParent(current)) if (current === parent) return true;
    return false;
  };
  const nativeTarget = element => ['button', 'input', 'select', 'textarea'].includes(element.localName) ||
    (element.localName === 'a' && element.hasAttribute('href'));
  const pseudoContent = new Map();
  const hasPseudoContent = element => {
    if (!pseudoContent.has(element)) pseudoContent.set(element,
      ['::before', '::after'].some(pseudo => !['none', 'normal'].includes(getComputedStyle(element, pseudo).content)));
    return pseudoContent.get(element);
  };
  const targetSizeRect = element => {
    try {
      // Local frame coordinates cannot prove scaling/clipping by its embedder.
      if (window !== window.top) return null;
      const { rect } = geometry.get(element);
      if (!nativeTarget(element) || element.matches(':disabled') || element.getClientRects().length !== 1 ||
        ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 ||
        rect.x < 0 || rect.y < 0 || rect.right > innerWidth || rect.bottom > innerHeight) return null;
      for (let current = element; current; current = composedParent(current)) {
        const css = geometry.get(current)?.computed || getComputedStyle(current);
        if (css.display === 'none' || css.visibility !== 'visible' || Number(css.opacity) !== 1 ||
          css.pointerEvents === 'none' || css.transform !== 'none' || css.perspective !== 'none' ||
          css.clipPath !== 'none' || !['auto', 'none'].includes(css.clip) || css.maskImage !== 'none' ||
          (current !== element && (css.overflowX !== 'visible' || css.overflowY !== 'visible' || hasPseudoContent(current)))) return null;
      }
      for (const [other, sample] of geometry) {
        if (other === element || containsComposed(other, element)) continue;
        const descendant = containsComposed(element, other);
        if (descendant && !nativeTarget(other) && !other.hasAttribute('role') && !other.hasAttribute('tabindex')) continue;
        const css = sample.computed;
        if (css.display === 'none' || css.visibility !== 'visible') continue;
        const box = sample.rect;
        if (box.width > 0 && box.height > 0 && box.left < rect.right && box.right > rect.left &&
          box.top < rect.bottom && box.bottom > rect.top) return null;
        // A pseudo-element can paint beyond its originating element's box.
        // Without its own geometry, do not certify this target from bounds alone.
        if (hasPseudoContent(other)) return null;
      }
      const root = element.getRootNode();
      for (const x of [rect.left + 0.5, rect.left + rect.width / 2, rect.right - 0.5]) {
        for (const y of [rect.top + 0.5, rect.top + rect.height / 2, rect.bottom - 0.5]) {
          const hit = root.elementFromPoint(x, y);
          if (!hit || !containsComposed(element, hit)) return null;
        }
      }
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    } catch { return null; }
  };

  const signature = (element, token) => {
    try {
      const tag = String(element.localName || '').toLowerCase();
      const id = String(element.id || '').toLowerCase();
      const classes = typeof element.className === 'string' ? element.className.toLowerCase() : '';
      if (token === 'vlibras') return tag === 'vlibras-widget' || element.hasAttribute?.('vw') === true ||
        /(?:^|[\s_-])vlibras(?:$|[\s_-])/u.test(`${id} ${classes}`) || /(?:^|\s)vw(?:$|\s)/u.test(classes);
      return element.hasAttribute?.('data-handtalk') === true || /hand[\s_-]?talk/u.test(`${tag} ${id} ${classes}`);
    } catch {
      return false;
    }
  };
  const scriptSignature = (element, token) => {
    if (String(element?.localName || '').toLowerCase() !== 'script') return false;
    try {
      const source = String(element.getAttribute?.('src') || '').normalize('NFKC').toLowerCase().slice(0, 2048);
      return token === 'vlibras' ? /(?:^|[/.?&_-])vlibras(?:[/.?&=_-]|$)/u.test(source) : /hand[\s_-]?talk/u.test(source);
    } catch {
      return false;
    }
  };
  const widgetSignals = {
    vlibras: {
      dom: elements.some(element => signature(element, 'vlibras')),
      script: elements.some(element => scriptSignature(element, 'vlibras')),
    },
    'hand-talk': {
      dom: elements.some(element => signature(element, 'hand-talk')),
      script: elements.some(element => scriptSignature(element, 'hand-talk')),
    },
  };

  const nodes = elements.map((element, order) => {
    const { computed, rect } = geometry.get(element);
    const styles = {};
    for (const name of styleNames) styles[name] = computed.getPropertyValue(name);
    const sensitiveControl = isSensitiveControl(element);
    const visible = computed.display !== 'none' && computed.visibility !== 'hidden' && Number(computed.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    let hasRenderedBox = visible && computed.visibility !== 'collapse';
    for (let ancestor = composedParent(element); hasRenderedBox && ancestor; ancestor = composedParent(ancestor)) {
      const css = geometry.get(ancestor)?.computed || getComputedStyle(ancestor);
      if (css.display === 'none' || Number(css.opacity) === 0) hasRenderedBox = false;
    }
    const nativeControl = ['button', 'input', 'select', 'textarea'].includes(element.localName);
    const disabled = nativeControl && element.matches(':disabled');
    const measuredTarget = targetSizeRect(element);
    const record = {
      order,
      tagName: element.localName,
      selectorHint: selector(element),
      viewportRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      documentRect: { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height },
      ...(measuredTarget ? { targetSizeRect: measuredTarget } : {}),
      styles,
      contrastReliable: contrastReliable(element),
      backgroundImageKind: backgroundKind(computed.getPropertyValue('background-image')),
      hidden: !visible,
      hasRenderedBox,
      visibleText: sensitiveControl ? '' : (element.innerText || '').replace(/\s+/gu, ' ').trim(),
      focusable: element.matches('a[href],button,input:not([type="hidden"]),select,textarea,[tabindex],[contenteditable="true"]') && !disabled,
      ...(nativeControl ? { disabled } : {}),
      active: document.activeElement === element,
      shadowHost: Boolean(element.shadowRoot),
      shadowRootMode: element.shadowRoot?.mode || null
    };
    const nativeLink = element.localName === 'a' && element.hasAttribute?.('href') === true;
    const roleLink = String(element.getAttribute?.('role') || '').trim().toLowerCase() === 'link';
    const linkLike = nativeLink || roleLink;
    if (linkLike && contextState(element) === 'accessible') {
      record.linkPurposeContext = contextObservation(element);
      const warning = adjacentWarning(element);
      if (typeof warning === 'boolean') record.adjacentNewWindowWarning = warning;
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
      record.form = {
        type: element instanceof HTMLInputElement ? element.type : element.localName,
        checked: element instanceof HTMLInputElement ? element.checked : undefined,
        disabled: element.disabled,
        required: element.required,
        multiple: 'multiple' in element ? Boolean(element.multiple) : undefined,
        selectedIndex: element instanceof HTMLSelectElement ? element.selectedIndex : undefined
      };
    }
    if (element instanceof HTMLMediaElement) {
      const captionTracks = [...element.textTracks]
        .filter(track => track.kind === 'captions')
        .map(track => ({ kind: track.kind, srclang: track.language }));
      record.media = {
        kind: element.localName,
        currentSrc: cleanUrl(element.currentSrc || element.getAttribute('src') || ''),
        durationSeconds: Number.isFinite(element.duration) ? element.duration : null,
        muted: element.muted,
        autoplay: element.autoplay,
        controls: element.controls,
        captionTracks,
        ...(element instanceof HTMLAudioElement ? { hasAudio: true } : {})
      };
    } else if (element instanceof HTMLImageElement) {
      record.media = { kind: 'image', currentSrc: cleanUrl(element.currentSrc || element.src) };
    } else if (element instanceof HTMLCanvasElement) {
      record.media = { kind: 'canvas' };
    }
    const animations = typeof element.getAnimations === 'function' ? element.getAnimations() : [];
    if (animations.length > 0) record.animations = animations.map(animation => ({
      playState: animation.playState,
      currentTime: Number.isFinite(animation.currentTime) ? animation.currentTime : null
    }));
    return record;
  });
  return {
    url: cleanUrl(location.href),
    framePath: [],
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
    focusedSelector: document.activeElement instanceof Element ? selector(document.activeElement) : '',
    prefersReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    widgetSignals,
    nodes
  };
}
