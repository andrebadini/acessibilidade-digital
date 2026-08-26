function dimensions(metrics = {}) {
  const size = metrics.cssContentSize || metrics.contentSize || {};
  return {
    width: Number.isFinite(size.width) && size.width > 0 ? size.width : null,
    height: Number.isFinite(size.height) && size.height > 0 ? size.height : null
  };
}

function validBase64(value) {
  return typeof value === 'string' && value.length >= 12 && value.length % 4 !== 1 && /^[A-Za-z0-9+/]*={0,2}$/u.test(value);
}

function pngDataUrl(value) {
  if (!validBase64(value)) throw new TypeError('A captura não contém base64 PNG válido.');
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw new TypeError('A captura não contém base64 PNG válido.');
  }
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (binary.length < signature.length || signature.some((byte, index) => binary.charCodeAt(index) !== byte)) {
    throw new TypeError('A captura retornada não possui assinatura PNG.');
  }
  return `data:image/png;base64,${value}`;
}

function stableId(prefix, value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}-${hash.toString(16).padStart(8, '0')}`;
}

async function capture(cdp, params, kind, metadata = {}) {
  if (!cdp || typeof cdp.command !== 'function') throw new TypeError('O cliente CDP de captura é inválido.');
  const response = await cdp.command('Page.captureScreenshot', params);
  const dataUrl = pngDataUrl(response?.data);
  return {
    status: 'captured',
    evidenceId: stableId(kind, `${response.data}\u0000${JSON.stringify(metadata)}`),
    dataUrl,
    metadata: { kind, mimeType: 'image/png', ...metadata }
  };
}

export async function captureFullPage(cdp, metrics = {}) {
  const size = dimensions(metrics);
  const clip = size.width !== null && size.height !== null
    ? { x: 0, y: 0, width: size.width, height: size.height, scale: 1 }
    : null;
  return capture(cdp, {
    format: 'png', captureBeyondViewport: true, fromSurface: true,
    ...(clip ? { clip } : {})
  }, 'full-page', size);
}

function normalizedClip(rect, metrics) {
  if (!rect || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) || rect.width <= 0 || rect.height <= 0) return null;
  const size = dimensions(metrics);
  const viewportRelative = rect.coordinateSpace === 'viewport';
  if (viewportRelative && (!Number.isFinite(metrics.scrollX) || !Number.isFinite(metrics.scrollY))) return null;
  const documentX = rect.x + (viewportRelative ? metrics.scrollX : 0);
  const documentY = rect.y + (viewportRelative ? metrics.scrollY : 0);
  const left = Math.max(0, documentX);
  const top = Math.max(0, documentY);
  const right = size.width === null ? documentX + rect.width : Math.min(size.width, documentX + rect.width);
  const bottom = size.height === null ? documentY + rect.height : Math.min(size.height, documentY + rect.height);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top, scale: 1 };
}

export async function captureElement(cdp, rect, metrics = {}) {
  const clip = normalizedClip(rect, metrics);
  if (!clip) return { status: 'cantTell', reason: 'invalid-or-outside-rect', evidenceId: null, fullPageEvidenceId: metrics.fullPageEvidenceId ?? metrics.evidenceId ?? null };
  const result = await capture(cdp, { format: 'png', captureBeyondViewport: true, fromSurface: true, clip }, 'thumbnail', {
    width: clip.width, height: clip.height, clip
  });
  return { ...result, fullPageEvidenceId: metrics.fullPageEvidenceId ?? metrics.evidenceId ?? null };
}
