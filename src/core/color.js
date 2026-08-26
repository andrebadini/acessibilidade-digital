function finiteChannel(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 255
    ? value
    : null;
}

function finiteAlpha(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function fromObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = finiteChannel(value.r);
  const g = finiteChannel(value.g);
  const b = finiteChannel(value.b);
  const a = value.a === undefined ? 1 : finiteAlpha(value.a);
  return [r, g, b, a].includes(null) ? null : { r, g, b, a };
}

function fromHex(value) {
  const match = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/iu.exec(value);
  if (!match) return null;
  const digits = match[1].length <= 4
    ? [...match[1]].map(character => character.repeat(2)).join('')
    : match[1];
  const hasAlpha = digits.length === 8;
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
    a: hasAlpha ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1
  };
}

function rgbChannel(token) {
  const value = token.trim();
  if (value.endsWith('%')) {
    const number = Number(value.slice(0, -1));
    return Number.isFinite(number) && number >= 0 && number <= 100 ? number * 2.55 : null;
  }
  return finiteChannel(Number(value));
}

function alphaChannel(token) {
  const value = token.trim();
  if (value.endsWith('%')) {
    const number = Number(value.slice(0, -1));
    return Number.isFinite(number) && number >= 0 && number <= 100 ? number / 100 : null;
  }
  return finiteAlpha(Number(value));
}

function fromRgb(value) {
  const match = /^rgba?\((.*)\)$/iu.exec(value);
  if (!match) return null;
  const body = match[1].trim();
  const slashParts = body.split('/');
  if (slashParts.length > 2) return null;
  let channels = slashParts[0].includes(',')
    ? slashParts[0].split(',')
    : slashParts[0].split(/\s+/u);
  let alphaToken = slashParts[1];
  if (channels.length === 4 && alphaToken === undefined) alphaToken = channels.pop();
  if (channels.length !== 3) return null;
  const [r, g, b] = channels.map(rgbChannel);
  const a = alphaToken === undefined ? 1 : alphaChannel(alphaToken);
  return [r, g, b, a].includes(null) ? null : { r, g, b, a };
}

/**
 * Accepted colors are #rgb[a], #rrggbb[aa], CSS rgb()/rgba(), or
 * `{ r, g, b, a? }` with finite sRGB channels from 0..255 and alpha 0..1.
 * Named colors and unresolved CSS expressions are deliberately unsupported.
 */
export function parseColor(value) {
  if (typeof value === 'object') return fromObject(value);
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.toLowerCase() === 'transparent') return null;
  return fromHex(normalized) ?? fromRgb(normalized);
}

function flatten(foreground, background) {
  if (background.a !== 1 || foreground.a === 0) return null;
  if (foreground.a === 1) return foreground;
  return {
    r: foreground.r * foreground.a + background.r * (1 - foreground.a),
    g: foreground.g * foreground.a + background.g * (1 - foreground.a),
    b: foreground.b * foreground.a + background.b * (1 - foreground.a),
    a: 1
  };
}

function linearChannel(value) {
  const channel = value / 255;
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance(color) {
  return 0.2126 * linearChannel(color.r) +
    0.7152 * linearChannel(color.g) +
    0.0722 * linearChannel(color.b);
}

/**
 * Calculates WCAG relative-luminance contrast in sRGB. A translucent
 * foreground is composited over the supplied opaque background. A translucent
 * or unresolved background returns NaN because no page backdrop was supplied;
 * this function never assumes white implicitly.
 */
export function contrastRatio(foreground, background) {
  const parsedForeground = parseColor(foreground);
  const parsedBackground = parseColor(background);
  if (!parsedForeground || !parsedBackground) return Number.NaN;
  const flattened = flatten(parsedForeground, parsedBackground);
  if (!flattened) return Number.NaN;
  const foregroundLuminance = luminance(flattened);
  const backgroundLuminance = luminance(parsedBackground);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}
