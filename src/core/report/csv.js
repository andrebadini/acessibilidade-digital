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
const MARKUP_NAME_ONLY_ATTRIBUTE_LIST = /^(?:[a-z_:][a-z0-9_.:-]*)(?:\s+[a-z_:][a-z0-9_.:-]*)*$/iu;
const INLINE_ALPHANUMERIC = /[\p{L}\p{M}\p{N}_]/u;
const BASE64_TOKEN = /(?:^|[^A-Za-z0-9+\/_-])([A-Za-z0-9+\/_-]{8,512}={0,2})(?=$|[^A-Za-z0-9+\/_=-])/gu;
const SEGMENTED_BASE64_SEQUENCE = /[A-Za-z0-9+\/_-]+={0,2}(?: +[A-Za-z0-9+\/_-]+={0,2})+/gu;
const MAX_BASE64_SCAN_LAYERS = 3;
const MAX_SEGMENTED_BASE64_WINDOW = 512;
const MAX_SEGMENTED_DECODE_SOURCE_CHARACTERS = 2 * 1024 * 1024;
const MAX_SEGMENTED_BASE64_DEPTH = 3;
const DEFAULT_IGNORABLE_FORMAT = /\p{Default_Ignorable_Code_Point}/gu;
const PRIVATE_SENTINEL = /(?:^|[^\p{L}\p{N}])[A-Z0-9_-]*(?:PRIVATE|SECRET|SENTINEL)[A-Z0-9_-]*(?=$|[^\p{L}\p{N}])/u;
const ALIAS_CREDENTIAL = /\b(auth|pass)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s<]+)/giu;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8');
const STRICT_DECODER = new TextDecoder('utf-8', { fatal: true });

/** Pure, allowlisted projection of an already canonicalizable V2 audit model. */
export function renderOccurrenceCsv(input) {
  const model = createAuditModel(input);
  const privacyBudget = { remainingDecodeSourceCharacters: MAX_SEGMENTED_DECODE_SOURCE_CHARACTERS };
  const pageById = new Map(model.pages.map(page => [page.pageId, page]));
  const itemById = new Map(model.itemResults.map(item => [item.id, item]));
  const evidenceById = new Map(model.evidence.map(evidence => [evidence.evidenceId, evidence]));
  const records = [serializeRecord(OCCURRENCE_CSV_COLUMNS, privacyBudget)];
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
    const record = serializeRecord(values, privacyBudget);
    byteLength += ENCODER.encode(`${record}\r\n`).byteLength;
    if (byteLength > MAX_CSV_BYTES) throw new RangeError('O CSV excede o limite seguro de tamanho.');
    records.push(record);
  }
  return `\uFEFF${records.join('\r\n')}\r\n`;
}

function serializeRecord(values, privacyBudget) {
  return values.map((value, index) => {
    const column = OCCURRENCE_CSV_COLUMNS[index];
    return quoteCell(neutralizeFormula(safeCsvScalar(value, column, privacyBudget)));
  }).join(',');
}

function safeCsvScalar(value, column, privacyBudget) {
  const bounded = boundedScalar(value);
  if (!PRIVACY_PROJECTED_COLUMNS.has(column)) return bounded.text;
  const scanSources = bounded.scan === bounded.spacedScan ? [bounded.scan] : [bounded.scan, bounded.spacedScan];
  if (column === 'page_url') {
    const formQuery = formDecodedQueryView(bounded.scan);
    if (formQuery !== null) scanSources.push(formQuery);
  }
  const scanViews = scanSources.flatMap(normalizedScanViews);
  const segmented = { resource: false, markup: false, sensitive: false };
  const segmentedBudget = {
    privacyBudget,
  };
  for (const source of scanSources) {
    mergeClassification(segmented, classifySegmentedBase64(source, segmentedBudget, 0));
  }
  if (segmented.resource || scanViews.some(text => RESOURCE_SCHEME.test(text) || LONG_BASE64.test(text) ||
    hasWhitespaceWrappedBase64(text) || PIXEL_BASE64_MAGIC.test(text))) {
    return RESOURCE_OMISSION_MARKER;
  }
  if (segmented.markup || scanViews.some(text => SCRIPT_SCHEME.test(text) || hasTagLikeMarkup(text))) {
    return MARKUP_OMISSION_MARKER;
  }
  const redactedText = redactCsvCredentials(bounded.text);
  if (redactedText !== bounded.text) return boundedScalar(redactedText).text;
  if (segmented.sensitive || scanViews.some(text =>
    redactCsvCredentials(text) !== text || PRIVATE_SENTINEL.test(text))) {
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
  const spacedScan = retained.map(character => scanControl(character) ? ' ' : character).join('');
  return { text, scan, spacedScan };
}

function normalizedScanViews(value) {
  const views = [];
  const seen = new Set();
  const collectViews = (raw, target) => {
    for (const normalized of normalizedEncodedTextViews(raw)) {
      if (!seen.has(normalized)) {
        seen.add(normalized);
        views.push(normalized);
        target.push(normalized);
      }
    }
  };
  let frontier = [];
  collectViews(value, frontier);
  for (let layer = 0; layer < MAX_BASE64_SCAN_LAYERS && frontier.length > 0; layer += 1) {
    const next = [];
    for (const view of frontier) {
      for (const match of view.matchAll(BASE64_TOKEN)) {
        const bytes = decodeCanonicalBase64(match[1]);
        if (!bytes) continue;
        if (hasImageSignature(bytes)) return [...views, 'data:image/binary'];
        let decoded;
        try {
          decoded = STRICT_DECODER.decode(bytes);
        } catch {
          continue;
        }
        collectViews(decoded, next);
      }
    }
    frontier = next;
  }
  if (frontier.some(hasCanonicalBase64Candidate)) return [...views, 'data:bounded-layer-scan'];
  return views;
}

function classifySegmentedBase64(value, budget, depth) {
  const classification = { resource: false, markup: false, sensitive: false };
  const blocks = segmentedBlocks(value);
  for (const block of blocks) {
    classifySegmentedBlock(block, classification, budget, depth);
    if (classification.resource) return classification;
  }
  return classification;
}

function segmentedBlocks(value) {
  const blocks = [];
  for (const encodedView of normalizedEncodedTextViews(value)) {
    const normalized = encodedView.replace(DEFAULT_IGNORABLE_FORMAT, '').replace(/\p{White_Space}+/gu, ' ');
    for (const match of normalized.matchAll(SEGMENTED_BASE64_SEQUENCE)) {
      const tokens = match[0].split(/ +/u);
      let blockStart = 0;
      for (let index = 0; index < tokens.length; index += 1) {
        if (!tokens[index].includes('=')) continue;
        addSegmentedBlock(blocks, tokens.slice(blockStart, index + 1));
        blockStart = index + 1;
      }
      addSegmentedBlock(blocks, tokens.slice(blockStart));
    }
  }
  return blocks;
}

function addSegmentedBlock(blocks, tokens) {
  if (tokens.length < 2) return;
  const compact = tokens.join('').replace(/=+$/u, '');
  const tokenOffsets = [];
  let offset = 0;
  for (const token of tokens) {
    tokenOffsets.push(offset);
    offset += token.replace(/=+$/u, '').length;
  }
  blocks.push({ compact, tokenOffsets });
}

function classifySegmentedBlock(block, classification, budget, depth) {
  const { compact } = block;
  const decodedPhases = [];
  const bytesByPhase = [];
  for (let phase = 0; phase < 4; phase += 1) {
    const bytes = decodeBoundedBase64Stream(compact.slice(phase), budget);
    if (!bytes) continue;
    bytesByPhase[phase] = bytes;
    if (hasImageSignatureAnywhere(bytes)) {
      classification.resource = true;
      return;
    }
    const decoded = strictDecodedText(bytes);
    if (decoded === null) {
      decodedPhases.push(asciiByteView(bytes));
      continue;
    }
    mergeClassification(classification, classifyTextViews(normalizedScanViews(decoded)));
    if (classification.resource) return;
    decodedPhases.push(decoded);
  }
  classifyEverySegmentedStart(block, bytesByPhase, classification, budget);
  if (classification.resource) return;
  if (depth + 1 < MAX_SEGMENTED_BASE64_DEPTH) {
    for (const decoded of decodedPhases) {
      mergeClassification(classification, classifySegmentedBase64(decoded, budget, depth + 1));
      if (classification.resource) return;
    }
  }
}

function classifyEverySegmentedStart(block, bytesByPhase, classification, budget) {
  if (/^([A-Za-z0-9+\/_-])\1*$/u.test(block.compact)) return;
  for (let index = 0; index < block.tokenOffsets.length - 1; index += 1) {
    const start = block.tokenOffsets[index];
    const sourceLength = Math.min(MAX_SEGMENTED_BASE64_WINDOW, block.compact.length - start);
    if (sourceLength < 8) continue;
    const phase = start % 4;
    const phaseBytes = bytesByPhase[phase];
    if (!phaseBytes) continue;
    const byteStart = (start - phase) * 3 / 4;
    const byteLength = Math.floor(sourceLength * 6 / 8);
    const bytes = phaseBytes.subarray(byteStart, byteStart + byteLength);
    consumePrivacyWork(bytes.length, budget);
    const decoded = decodeValidUtf8View(bytes);
    if (decoded !== null) {
      mergeClassification(classification, classifyTextViews(normalizedScanViews(decoded)));
      if (classification.resource) return;
    }
  }
}

function formDecodedQueryView(value) {
  const queryStart = value.indexOf('?');
  if (queryStart === -1) return null;
  const fragmentStart = value.indexOf('#', queryStart + 1);
  const queryEnd = fragmentStart === -1 ? value.length : fragmentStart;
  const query = value.slice(queryStart + 1, queryEnd);
  return query.includes('+') ? query.replace(/\+/gu, ' ') : null;
}

function strictDecodedText(bytes) {
  if (hasImageSignatureAnywhere(bytes)) return 'data:image/binary';
  try {
    return STRICT_DECODER.decode(bytes);
  } catch {
    return null;
  }
}

function decodeValidUtf8View(bytes) {
  const spans = [];
  let index = 0;
  let spanStart = null;
  while (index < bytes.length) {
    const width = validUtf8SequenceWidth(bytes, index);
    if (width > 0) {
      spanStart ??= index;
      index += width;
      continue;
    }
    if (spanStart !== null) spans.push(STRICT_DECODER.decode(bytes.subarray(spanStart, index)));
    spanStart = null;
    index += 1;
  }
  if (spanStart !== null) spans.push(STRICT_DECODER.decode(bytes.subarray(spanStart)));
  return spans.length === 0 ? null : spans.join('�');
}

function validUtf8SequenceWidth(bytes, index) {
  const first = bytes[index];
  if (first <= 0x7f) return 1;
  let width;
  if (first >= 0xc2 && first <= 0xdf) width = 2;
  else if (first >= 0xe0 && first <= 0xef) width = 3;
  else if (first >= 0xf0 && first <= 0xf4) width = 4;
  else return 0;
  if (index + width > bytes.length) return 0;
  const second = bytes[index + 1];
  if (second < 0x80 || second > 0xbf ||
    (first === 0xe0 && second < 0xa0) || (first === 0xed && second > 0x9f) ||
    (first === 0xf0 && second < 0x90) || (first === 0xf4 && second > 0x8f)) return 0;
  for (let offset = 2; offset < width; offset += 1) {
    if (bytes[index + offset] < 0x80 || bytes[index + offset] > 0xbf) return 0;
  }
  return width;
}

function asciiByteView(bytes) {
  const characters = new Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    characters[index] = bytes[index] < 128 ? String.fromCharCode(bytes[index]) : '�';
  }
  return characters.join('');
}

function classifyTextViews(views) {
  return {
    resource: views.some(text => RESOURCE_SCHEME.test(text) || LONG_BASE64.test(text) ||
      hasWhitespaceWrappedBase64(text) || PIXEL_BASE64_MAGIC.test(text)),
    markup: views.some(text => SCRIPT_SCHEME.test(text) || hasTagLikeMarkup(text)),
    sensitive: views.some(text => redactCsvCredentials(text) !== text || PRIVATE_SENTINEL.test(text)),
  };
}

function decodeBase64Stream(value) {
  let unpadded = value.replace(/=+$/u, '');
  if (unpadded.length % 4 === 1) unpadded = unpadded.slice(0, -1);
  if (unpadded.length < 8) return null;
  const bytes = new Uint8Array(Math.floor(unpadded.length * 6 / 8));
  let accumulator = 0;
  let bitCount = 0;
  let byteIndex = 0;
  for (let index = 0; index < unpadded.length; index += 1) {
    const digit = base64Digit(unpadded.charCodeAt(index));
    if (digit < 0) return null;
    accumulator = (accumulator << 6) | digit;
    bitCount += 6;
    if (bitCount < 8) continue;
    bitCount -= 8;
    bytes[byteIndex] = (accumulator >> bitCount) & 0xff;
    byteIndex += 1;
    accumulator &= (1 << bitCount) - 1;
  }
  return bytes.subarray(0, byteIndex);
}

function base64Digit(code) {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43 || code === 45) return 62;
  if (code === 47 || code === 95) return 63;
  return -1;
}

function decodeBoundedBase64Stream(value, budget) {
  consumePrivacyWork(value.length, budget);
  return decodeBase64Stream(value);
}

function consumePrivacyWork(sourceCharacters, budget) {
  if (sourceCharacters > budget.privacyBudget.remainingDecodeSourceCharacters) {
    throw new RangeError('O CSV excede o limite seguro de processamento.');
  }
  budget.privacyBudget.remainingDecodeSourceCharacters -= sourceCharacters;
}

function mergeClassification(target, source) {
  target.resource ||= source.resource;
  target.markup ||= source.markup;
  target.sensitive ||= source.sensitive;
}

function hasCanonicalBase64Candidate(value) {
  for (const match of value.matchAll(BASE64_TOKEN)) {
    if (decodeCanonicalBase64(match[1])) return true;
  }
  return false;
}

function normalizedEncodedTextViews(value) {
  const normalized = value.normalize('NFKC');
  const withoutIgnorables = normalized.replace(DEFAULT_IGNORABLE_FORMAT, '');
  const collapsedEscapes = withoutIgnorables.replace(/%(?:25)+(?=[0-9a-f]{2})/giu, '%');
  const decoded = collapsedEscapes.replace(/(?:%[0-9a-f]{2})+/giu, run => {
    const bytes = Uint8Array.from(run.match(/[0-9a-f]{2}/giu), pair => Number.parseInt(pair, 16));
    return DECODER.decode(bytes);
  });
  const compactDecoded = [...decoded].filter(character => !scanControl(character)).join('').normalize('NFKC');
  return [...new Set([normalized, withoutIgnorables, compactDecoded])];
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

function hasImageSignatureAnywhere(bytes) {
  for (let index = 0; index < bytes.length; index += 1) {
    if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], index) ||
      startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38], index) ||
      startsWithBytes(bytes, [0xff, 0xd8, 0xff], index) ||
      (startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46], index) &&
        startsWithBytes(bytes, [0x57, 0x45, 0x42, 0x50], index + 8))) return true;
  }
  return false;
}

function startsWithBytes(bytes, prefix, offset = 0) {
  return bytes.length - offset >= prefix.length && prefix.every((byte, index) => bytes[offset + index] === byte);
}

function hasWhitespaceWrappedBase64(value) {
  const segments = value.trim().split(/\s+/u);
  if (segments.length < 3 || segments.join('').length < 128) return false;
  if (segments.some(segment => !/^[A-Za-z0-9+/_-]+={0,2}$/u.test(segment))) return false;
  if (segments.every(segment => /^[a-z]{2,}$/u.test(segment))) return false;
  if (segments.slice(0, -1).some(segment => segment.includes('=') || segment.length % 4 !== 0)) return false;
  const lastLength = segments.at(-1).replace(/=+$/u, '').length;
  if (lastLength % 4 === 1) return false;
  const compact = segments.join('');
  const bytes = decodeCanonicalBase64(compact);
  if (!bytes) return false;
  if (hasImageSignature(bytes)) return true;
  try {
    const decoded = STRICT_DECODER.decode(bytes);
    const views = normalizedEncodedTextViews(decoded);
    if (views.some(text => RESOURCE_SCHEME.test(text) || SCRIPT_SCHEME.test(text) ||
      hasTagLikeMarkup(text) || redactCsvCredentials(text) !== text || PRIVATE_SENTINEL.test(text))) return true;
  } catch {
    return true;
  }
  const uniqueSegments = new Set(segments).size;
  return uniqueSegments * 2 <= segments.length ||
    (/[A-Z]/u.test(compact) && /[a-z0-9+/_-]/u.test(compact));
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
    const nameOnlyAttributes = MARKUP_NAME_ONLY_ATTRIBUTE_LIST.test(details.trim());
    const attributeCount = markupAttributeCount(details);
    const attributeList = attributeCount !== null && attributeCount > 0 &&
      (complete || (attributeCount === 1 && (name.length > 1 || AMBIGUOUS_STANDARD_TAGS.has(name))));
    const inlineRight = complete && detailsEnd + 1 < value.length && INLINE_ALPHANUMERIC.test(value[detailsEnd + 1]);
    const selfClosing = complete && details.trimEnd().endsWith('/');

    if (selfClosing || (complete && HTML_VOID_TAGS.has(name))) return true;
    if (ALWAYS_RISKY_TAGS.has(name)) return true;
    if (STRONG_STANDARD_TAGS.has(name)) {
      if (leftBoundary || assignedAttribute || booleanAttribute || (complete && !inlineRight)) return true;
      continue;
    }
    if (AMBIGUOUS_STANDARD_TAGS.has(name)) {
      if (leftBoundary || attributeList || (complete && (assignedAttribute || booleanAttribute || nameOnlyAttributes))) return true;
      continue;
    }
    if (name.includes('-') || name.includes(':')) {
      if (leftBoundary || complete || assignedAttribute) return true;
      continue;
    }
    if (attributeList || (complete && (assignedAttribute || nameOnlyAttributes)) ||
      (leftBoundary && (complete || assignedAttribute || booleanAttribute))) return true;
  }
  return false;
}

function markupAttributeCount(details) {
  let index = 0;
  let count = 0;
  while (index < details.length) {
    const whitespaceStart = index;
    while (index < details.length && /\s/u.test(details[index])) index += 1;
    if (index === whitespaceStart) return null;
    if (index === details.length) return count;
    if (!/[a-z_:]/iu.test(details[index])) return null;
    index += 1;
    while (index < details.length && /[a-z0-9_.:-]/iu.test(details[index])) index += 1;
    count += 1;
    const afterName = index;
    while (index < details.length && /\s/u.test(details[index])) index += 1;
    if (details[index] !== '=') {
      if (index === details.length) return count;
      index = afterName;
      continue;
    }
    index += 1;
    while (index < details.length && /\s/u.test(details[index])) index += 1;
    if (index === details.length) return count;
    const quote = details[index] === '"' || details[index] === "'" ? details[index] : null;
    if (quote !== null) {
      const closing = details.indexOf(quote, index + 1);
      if (closing === -1) return count;
      index = closing + 1;
      continue;
    }
    const valueStart = index;
    while (index < details.length && !/[\s"'=<>`]/u.test(details[index])) index += 1;
    if (index === valueStart) return count;
  }
  return count;
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
  if (!DANGEROUS_FIRST_CHARACTER.test(value)) return value;
  const codePoints = [...value];
  if (codePoints.length < MAX_CELL_CODE_POINTS) return `'${value}`;
  const marker = [...TRUNCATION_MARKER];
  return `'${codePoints.slice(0, MAX_CELL_CODE_POINTS - marker.length - 1).join('')}${TRUNCATION_MARKER}`;
}

function quoteCell(value) {
  return `"${value.replace(/"/gu, '""')}"`;
}
