import { createAuditModel } from './audit-model.js';
import { redactSensitiveText } from '../privacy.js';

export const OCCURRENCE_CSV_VERSION = 'audita-occurrences-v1';
export const OCCURRENCE_CSV_COLUMNS = Object.freeze([
  'csv_schema_version', 'audit_id', 'occurrence_id', 'page_id', 'page_url',
  'observed_at', 'outcome', 'classification', 'impact', 'confidence',
  'source_engine', 'source_version', 'source_rule_id', 'nbr_item_ref',
  'wcag_refs', 'section_508_refs', 'title', 'description', 'selector',
  'frame_path', 'accessible_preview', 'accessible_preview_source',
  'evidence_refs', 'consumer_basis_ref', 'evidence_hashes',
  'canonical_model_hash', 'evidence_manifest_hash',
]);
const PRIVACY_PROJECTED_COLUMNS = new Set([
  'page_url', 'source_engine', 'source_version', 'title', 'description', 'selector',
  'frame_path', 'accessible_preview', 'accessible_preview_source', 'evidence_hashes',
  'canonical_model_hash', 'evidence_manifest_hash',
]);

const MAX_CELL_CODE_POINTS = 32_000;
const MAX_CSV_BYTES = 8 * 1024 * 1024;
const TRUNCATION_MARKER = '…[truncated]';
const RESOURCE_OMISSION_MARKER = '[recurso omitido]';
const MARKUP_OMISSION_MARKER = '[marcação omitida]';
const SENSITIVE_OMISSION_MARKER = '[conteúdo sensível omitido]';
const DANGEROUS_FIRST_CHARACTER = /^[=+\-@\t\r]/u;
const RESOURCE_SCHEME = /\b(?:data|blob|resource|filesystem|chrome-extension):/iu;
const SCRIPT_SCHEME = /\b(?:javascript|vbscript):/iu;
const LONG_BASE64 = /(?:^|[^A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{128,}={0,2}(?=$|[^A-Za-z0-9+/_=-])/u;
const PIXEL_BASE64_MAGIC = /(?:iVBORw0KGgo|R0lGOD|UklGR|\/9j\/)/u;
const STRONG_STANDARD_TAGS = new Set(('abbr address area article aside audio base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output picture pre progress rp rt ruby samp script search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track ul var video wbr ' +
  'svg path circle ellipse line polyline polygon rect g defs symbol use image text tspan clippath mask pattern lineargradient radialgradient stop filter foreignobject math mrow mi mn mo ms mtext mfrac msqrt mroot mstyle msub msup msubsup munderover semantics annotation annotation-xml').split(' '));
const AMBIGUOUS_STANDARD_TAGS = new Set(['a', 'b', 'i', 'p', 'q', 's', 'u']);
const ALWAYS_RISKY_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'img', 'input', 'form', 'link', 'meta']);
const HTML_VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const MARKUP_DECLARATION = /<(?:!--|!doctype\b|\?xml\b)/iu;
const MARKUP_CLOSING_TAG = /<\/[a-z][a-z0-9:-]*(?:\s*>|\s*$)/iu;
const TAG_NAME_AT_INDEX = /[a-z][a-z0-9:-]*/iuy;
const MARKUP_ATTRIBUTE_ASSIGNMENT = /\b[a-z_:][a-z0-9_.:-]*\s*=/iu;
const MARKUP_BOOLEAN_ATTRIBUTE = /\b(?:hidden|disabled|checked|selected|required|autofocus|multiple|readonly|open|controls|autoplay|loop|muted|novalidate|formnovalidate|inert|itemscope|allowfullscreen)\b/iu;
const INLINE_ALPHANUMERIC = /[\p{L}\p{M}\p{N}_]/u;
const BASE64_TOKEN = /(?:^|[^A-Za-z0-9+\/_-])([A-Za-z0-9+\/_-]{8,512}={0,2})(?=$|[^A-Za-z0-9+\/_=-])/gu;
const MAX_BASE64_SCAN_LAYERS = 3;
const MAX_BASE64_SCAN_VIEWS = 128;
const PRIVATE_SENTINEL = /(?:^|[^\p{L}\p{N}])[A-Z0-9_-]*(?:PRIVATE|SECRET|SENTINEL)[A-Z0-9_-]*(?=$|[^\p{L}\p{N}])/u;
const ALIAS_CREDENTIAL = /\b(auth|pass)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s<]+)/giu;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8');
const STRICT_DECODER = new TextDecoder('utf-8', { fatal: true });

/** Pure, allowlisted projection of an already canonicalizable V2 audit model. */
export function renderOccurrenceCsv(input) {
  const model = createAuditModel(input);
  const pageById = new Map(model.pages.map(page => [page.pageId, page]));
  const itemById = new Map(model.itemResults.map(item => [item.id, item]));
  const evidenceById = new Map(model.evidence.map(evidence => [evidence.evidenceId, evidence]));
  const records = [serializeRecord(OCCURRENCE_CSV_COLUMNS)];
  let byteLength = ENCODER.encode(`\uFEFF${records[0]}\r\n`).byteLength;

  for (const occurrence of model.occurrences) {
    const page = pageById.get(occurrence.pageId);
    if (!page) throw new TypeError(`Ocorrência ${occurrence.occurrenceId} referencia página desconhecida.`);
    const item = occurrence.nbrItemRef ? itemById.get(occurrence.nbrItemRef) : null;
    const referencedEvidence = occurrence.evidenceRefs.map(evidenceId => evidenceById.get(evidenceId));
    if (referencedEvidence.some(evidence => !evidence || evidence.pageId !== occurrence.pageId)) {
      throw new TypeError(`Ocorrência ${occurrence.occurrenceId} referencia evidência desconhecida ou de outra página.`);
    }
    const previewEvidence = referencedEvidence.find(evidence =>
      evidence.nodeId === occurrence.target.nodeId && typeof evidence.accessibility?.nameSource === 'string')
      ?? referencedEvidence.find(evidence => typeof evidence.accessibility?.nameSource === 'string');
    const values = [
      OCCURRENCE_CSV_VERSION,
      model.auditId,
      occurrence.occurrenceId,
      occurrence.pageId,
      page.finalUrl,
      page.timestamps.generatedAt,
      occurrence.outcome,
      occurrence.classification,
      occurrence.impact,
      occurrence.confidence,
      occurrence.source.engine,
      occurrence.source.version,
      occurrence.source.ruleId,
      occurrence.nbrItemRef,
      occurrence.wcagRefs.join(';'),
      occurrence.foreignBenchmarkRefs.map(reference =>
        `${reference.benchmarkId}:${reference.criterionId}:${reference.level}`).join(';'),
      item?.title ?? occurrence.source.ruleId,
      occurrence.justification ?? '',
      occurrence.target.selector,
      occurrence.target.framePath.join(' > '),
      occurrence.accessiblePreview,
      previewEvidence?.accessibility?.nameSource ?? '',
      occurrence.evidenceRefs.join(';'),
      occurrence.legalAnalysis?.basisRef ?? '',
      referencedEvidence.map((evidence, index) => `${occurrence.evidenceRefs[index]}=${evidence.hash ?? ''}`).join(';'),
      model.integrity?.canonicalModelHash ?? '',
      model.integrity?.evidenceManifestHash ?? '',
    ];
    const record = serializeRecord(values);
    byteLength += ENCODER.encode(`${record}\r\n`).byteLength;
    if (byteLength > MAX_CSV_BYTES) throw new RangeError('O CSV excede o limite seguro de tamanho.');
    records.push(record);
  }
  return `\uFEFF${records.join('\r\n')}\r\n`;
}

function serializeRecord(values) {
  return values.map((value, index) => quoteCell(neutralizeFormula(
    safeCsvScalar(value, PRIVACY_PROJECTED_COLUMNS.has(OCCURRENCE_CSV_COLUMNS[index])),
  ))).join(',');
}

function safeCsvScalar(value, inspectPrivacy) {
  const bounded = boundedScalar(value);
  if (!inspectPrivacy) return bounded.text;
  const scanViews = normalizedScanViews(bounded.scan);
  if (scanViews.some(text => RESOURCE_SCHEME.test(text) || LONG_BASE64.test(text) ||
    hasWhitespaceWrappedBase64(text) || PIXEL_BASE64_MAGIC.test(text))) {
    return RESOURCE_OMISSION_MARKER;
  }
  if (scanViews.some(text => SCRIPT_SCHEME.test(text) || hasTagLikeMarkup(text))) {
    return MARKUP_OMISSION_MARKER;
  }
  const redactedText = redactCsvCredentials(bounded.text);
  if (redactedText !== bounded.text) return boundedScalar(redactedText).text;
  if (scanViews.some(text => redactCsvCredentials(text) !== text || PRIVATE_SENTINEL.test(text))) {
    return SENSITIVE_OMISSION_MARKER;
  }
  return bounded.text;
}

function boundedScalar(value) {
  const raw = value === null || value === undefined ? '' : String(value);
  const codePoints = [];
  let truncated = false;
  for (const character of raw) {
    if (codePoints.length === MAX_CELL_CODE_POINTS) {
      truncated = true;
      break;
    }
    codePoints.push(character);
  }
  const markerLength = [...TRUNCATION_MARKER].length;
  const retained = truncated ? codePoints.slice(0, MAX_CELL_CODE_POINTS - markerLength) : codePoints;
  const text = retained.map(character => unsafeControl(character) ? '�' : character).join('') +
    (truncated ? TRUNCATION_MARKER : '');
  const scan = retained.filter(character => !scanControl(character)).join('');
  return { text, scan };
}

function normalizedScanViews(value) {
  const initial = normalizedEncodedTextViews(value);
  const views = [...initial];
  const seen = new Set(views);
  let frontier = initial;
  let decodedViews = 0;
  for (let layer = 0; layer < MAX_BASE64_SCAN_LAYERS && frontier.length > 0; layer += 1) {
    const next = [];
    for (const view of frontier) {
      for (const match of view.matchAll(BASE64_TOKEN)) {
        const bytes = decodeCanonicalBase64(match[1]);
        if (!bytes) continue;
        decodedViews += 1;
        if (decodedViews > MAX_BASE64_SCAN_VIEWS) return [...views, 'data:bounded-scan'];
        if (hasImageSignature(bytes)) return [...views, 'data:image/binary'];
        let decoded;
        try {
          decoded = STRICT_DECODER.decode(bytes);
        } catch {
          continue;
        }
        for (const decodedView of normalizedEncodedTextViews(decoded)) {
          if (seen.has(decodedView)) continue;
          seen.add(decodedView);
          views.push(decodedView);
          next.push(decodedView);
        }
      }
    }
    frontier = next;
  }
  if (frontier.some(hasCanonicalBase64Candidate)) return [...views, 'data:bounded-layer-scan'];
  return views;
}

function hasCanonicalBase64Candidate(value) {
  for (const match of value.matchAll(BASE64_TOKEN)) {
    if (decodeCanonicalBase64(match[1])) return true;
  }
  return false;
}

function normalizedEncodedTextViews(value) {
  const normalized = value.normalize('NFKC');
  const collapsedEscapes = normalized.replace(/%(?:25)+(?=[0-9a-f]{2})/giu, '%');
  const decoded = collapsedEscapes.replace(/(?:%[0-9a-f]{2})+/giu, run => {
    const bytes = Uint8Array.from(run.match(/[0-9a-f]{2}/giu), pair => Number.parseInt(pair, 16));
    return DECODER.decode(bytes);
  });
  const compactDecoded = [...decoded].filter(character => !scanControl(character)).join('').normalize('NFKC');
  return compactDecoded === normalized ? [normalized] : [normalized, compactDecoded];
}

function decodeCanonicalBase64(value) {
  const unpadded = value.replace(/=+$/u, '');
  if (unpadded.length % 4 === 1 || (/[-_]/u.test(unpadded) && /[+/]/u.test(unpadded))) return null;
  const standard = unpadded.replace(/-/gu, '+').replace(/_/gu, '/');
  const padded = standard.padEnd(standard.length + ((4 - standard.length % 4) % 4), '=');
  try {
    const binary = globalThis.atob(padded);
    const canonical = globalThis.btoa(binary).replace(/=+$/u, '');
    const expected = /[-_]/u.test(unpadded) ? canonical.replace(/\+/gu, '-').replace(/\//gu, '_') : canonical;
    if (expected !== unpadded) return null;
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function hasImageSignature(bytes) {
  return startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38]) ||
    startsWithBytes(bytes, [0xff, 0xd8, 0xff]) ||
    (startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWithBytes(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]));
}

function startsWithBytes(bytes, prefix) {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

function hasWhitespaceWrappedBase64(value) {
  const segments = value.trim().split(/\s+/u);
  if (segments.length < 3 || segments.join('').length < 128) return false;
  if (segments.some(segment => !/^[A-Za-z0-9+/_-]+={0,2}$/u.test(segment))) return false;
  if (segments.slice(0, -1).some(segment => segment.includes('=') || segment.length % 4 !== 0)) return false;
  const lastLength = segments.at(-1).replace(/=+$/u, '').length;
  return lastLength % 4 !== 1;
}

function hasTagLikeMarkup(value) {
  if (MARKUP_DECLARATION.test(value) || MARKUP_CLOSING_TAG.test(value)) return true;
  for (let index = value.indexOf('<'); index !== -1; index = value.indexOf('<', index + 1)) {
    TAG_NAME_AT_INDEX.lastIndex = index + 1;
    const match = TAG_NAME_AT_INDEX.exec(value);
    if (!match) continue;
    const name = match[0].toLowerCase();
    const detailsStart = TAG_NAME_AT_INDEX.lastIndex;
    let detailsEnd = detailsStart;
    while (detailsEnd < value.length && value[detailsEnd] !== '<' && value[detailsEnd] !== '>') detailsEnd += 1;
    const complete = value[detailsEnd] === '>';
    const details = value.slice(detailsStart, detailsEnd);
    const leftBoundary = index === 0 || !INLINE_ALPHANUMERIC.test(value[index - 1]);
    const assignedAttribute = MARKUP_ATTRIBUTE_ASSIGNMENT.test(details);
    const booleanAttribute = MARKUP_BOOLEAN_ATTRIBUTE.test(details);
    const inlineRight = complete && detailsEnd + 1 < value.length && INLINE_ALPHANUMERIC.test(value[detailsEnd + 1]);
    const selfClosing = complete && details.trimEnd().endsWith('/');

    if (selfClosing || (complete && HTML_VOID_TAGS.has(name))) return true;
    if (ALWAYS_RISKY_TAGS.has(name)) return true;
    if (STRONG_STANDARD_TAGS.has(name)) {
      if (leftBoundary || assignedAttribute || booleanAttribute || (complete && !inlineRight)) return true;
      continue;
    }
    if (AMBIGUOUS_STANDARD_TAGS.has(name)) {
      if (leftBoundary) return true;
      continue;
    }
    if (name.includes('-') || name.includes(':')) {
      if (leftBoundary || complete || assignedAttribute) return true;
      continue;
    }
    if (leftBoundary && (complete || assignedAttribute || booleanAttribute)) return true;
  }
  return false;
}

function redactCsvCredentials(value) {
  return redactSensitiveText(value).replace(ALIAS_CREDENTIAL, '$1$2[redacted]');
}

function unsafeControl(character) {
  const code = character.codePointAt(0);
  return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || (code >= 127 && code <= 159);
}

function scanControl(character) {
  const code = character.codePointAt(0);
  return code <= 31 || (code >= 127 && code <= 159);
}

function neutralizeFormula(value) {
  return DANGEROUS_FIRST_CHARACTER.test(value) ? `'${value}` : value;
}

function quoteCell(value) {
  return `"${value.replace(/"/gu, '""')}"`;
}
