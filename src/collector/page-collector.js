/**
 * Browser-world collector. Keep every dependency inside the function so
 * chrome.scripting can serialize it as `func` under Manifest V3 CSP.
 */
export function collectRuntimePageData() {
  const sensitive = /(?:pass(?:word|wd)?|token|secret|auth(?:orization)?|session|cookie|csrf|xsrf|otp|one[-_ ]?time|api[-_ ]?key)/iu;
  const styleNames = [
    'display', 'visibility', 'opacity', 'color', 'background-color',
    'font-size', 'font-weight', 'line-height',
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
  const identifierIsSensitive = (element) => sensitive.test([
    element.getAttribute('name'), element.id, element.getAttribute('autocomplete')
  ].filter(Boolean).join(' '));
  const isSensitiveControl = element => element instanceof HTMLInputElement && (
    element.type === 'password' ||
    /^(?:current-password|new-password|one-time-code)$/iu.test(element.autocomplete || '') ||
    (element.type === 'hidden' && identifierIsSensitive(element))
  );
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

  const nodes = elements.map((element, order) => {
    const computed = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const styles = {};
    for (const name of styleNames) styles[name] = computed.getPropertyValue(name);
    const sensitiveControl = isSensitiveControl(element);
    const visible = computed.display !== 'none' && computed.visibility !== 'hidden' && Number(computed.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    const record = {
      order,
      tagName: element.localName,
      selectorHint: selector(element),
      viewportRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      documentRect: { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height },
      styles,
      backgroundImageKind: backgroundKind(computed.getPropertyValue('background-image')),
      hidden: !visible,
      visibleText: sensitiveControl ? '' : (element.innerText || '').replace(/\s+/gu, ' ').trim(),
      focusable: element.matches('a[href],button,input:not([type="hidden"]),select,textarea,[tabindex],[contenteditable="true"]') && !element.disabled,
      active: document.activeElement === element,
      shadowHost: Boolean(element.shadowRoot),
      shadowRootMode: element.shadowRoot?.mode || null
    };
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
      record.media = {
        kind: element.localName,
        currentSrc: cleanUrl(element.currentSrc || element.getAttribute('src') || ''),
        durationSeconds: Number.isFinite(element.duration) ? element.duration : null,
        muted: element.muted,
        autoplay: element.autoplay,
        controls: element.controls,
        captionTracks: [...element.textTracks].filter(track => track.kind === 'captions').length
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
    nodes
  };
}
