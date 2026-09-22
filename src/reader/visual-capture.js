import { createCdpClient, createChromeDebuggerTransport } from '../browser/cdp-client.js';
import { captureFullPage } from '../browser/capture-evidence.js';
import { decodePngDataUrl, pngDataUrlFromBytes } from '../core/evidence/png.js';

const THUMB_MAX = 320;
const THUMB_MARGIN = 8;

function dataUrlToBytes(dataUrl) {
  const prefix = 'data:image/png;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) throw new TypeError('Captura PNG inválida.');
  const binary = atob(dataUrl.slice(prefix.length));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function loadImage(dataUrl) {
  const bytes = dataUrlToBytes(dataUrl);
  const blob = new Blob([bytes], { type: 'image/png' });
  return createImageBitmap(blob);
}

function emptyCanvas(width, height) {
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
  return { canvas, context: canvas.getContext('2d') };
}

/** Crop a document-space rect from a full-page raster into a self-contained PNG data URL. */
export async function cropElementImage(fullPageDataUrl, bounds, { maxSide = THUMB_MAX, margin = THUMB_MARGIN } = {}) {
  if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key])) || bounds.width <= 0 || bounds.height <= 0) return null;
  const source = await loadImage(fullPageDataUrl);
  const left = Math.max(0, Math.floor(bounds.x - margin));
  const top = Math.max(0, Math.floor(bounds.y - margin));
  const right = Math.min(source.width, Math.ceil(bounds.x + bounds.width + margin));
  const bottom = Math.min(source.height, Math.ceil(bounds.y + bounds.height + margin));
  const width = right - left;
  const height = bottom - top;
  if (width < 1 || height < 1) return null;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  const { canvas, context } = emptyCanvas(outWidth, outHeight);
  context.drawImage(source, left, top, width, height, 0, 0, outWidth, outHeight);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return pngDataUrlFromBytes(bytes);
}

/**
 * Capture the inspected page once and crop a thumbnail per inventory entry.
 * Failure is non-fatal: the text report remains complete without pixels.
 */
export async function captureReadingVisuals(chromeApi, { tabId, entries, metrics } = {}) {
  const limitations = [];
  const elementImages = Object.create(null);
  if (!chromeApi?.debugger || !Number.isSafeInteger(tabId) || tabId < 0) {
    limitations.push('visual-capture-unavailable');
    return { fullPage: null, elementImages, limitations };
  }
  const target = { tabId };
  const cdp = createCdpClient({ ...createChromeDebuggerTransport(chromeApi), commandTimeoutMs: 20_000 });
  let attached = false;
  try {
    await cdp.connect(tabId);
    attached = true;
    await cdp.command('Page.enable', {});
    const layout = await cdp.command('Page.getLayoutMetrics', {});
    const size = metrics || {
      cssContentSize: layout.cssContentSize || layout.contentSize,
      scrollX: 0,
      scrollY: 0,
    };
    const fullPage = await captureFullPage(cdp, size);
    if (fullPage?.status !== 'captured' || !fullPage.dataUrl) {
      limitations.push('full-page-capture-unavailable');
      return { fullPage: null, elementImages, limitations };
    }
    const decode = decodePngDataUrl(fullPage.dataUrl);
    void decode;
    for (const entry of entries || []) {
      if (!entry?.bounds) continue;
      try {
        const image = await cropElementImage(fullPage.dataUrl, entry.bounds);
        if (image) elementImages[entry.id] = image;
      } catch {
        limitations.push('element-crop-failed');
      }
    }
    return { fullPage: fullPage.dataUrl, elementImages, limitations };
  } catch {
    limitations.push('visual-capture-unavailable');
    return { fullPage: null, elementImages, limitations };
  } finally {
    if (attached) { try { await cdp.disconnect(target); } catch { /* already detached */ } }
  }
}
