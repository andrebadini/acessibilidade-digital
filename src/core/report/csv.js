import { NBR17225_ITEMS } from '../normative/nbr17225.js';
import { createAuditModel } from './audit-model.js';
import { isAuditIntegrityVerified } from './integrity.js';

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

const MAX_CELL_CODE_POINTS = 32_000;
const MAX_CSV_BYTES = 8 * 1024 * 1024;
const MAX_TOKEN_CODE_POINTS = 240;
const MAX_LIST_ITEMS = 256;
const TRUNCATION_MARKER = '…[truncated]';
const DETAIL_MARKER = '[detalhe disponível somente no HTML/JSON]';
const DANGEROUS_FIRST_CHARACTER = /^[=+\-@\t\r]/u;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ENCODER = new TextEncoder();
const CATALOG_ITEM_BY_ID = new Map(NBR17225_ITEMS.map(item => [item.id, item]));
const CLASSIFICATION_LABEL = Object.freeze({
  requirement: 'Requisito',
  recommendation: 'Recomendação',
  'best-practice': 'Boa prática',
  editorial: 'Observação editorial',
});
const OUTCOME_LABEL = Object.freeze({
  passed: 'conformidade observada',
  failed: 'não conformidade observada',
  cantTell: 'resultado inconclusivo',
  inapplicable: 'não aplicável',
  untested: 'não testado',
});

/** Pure, fixed-column projection of a canonicalizable V2 audit model. */
export function renderOccurrenceCsv(input) {
  const integrityVerified = isAuditIntegrityVerified(input);
  let model;
  try {
    model = createAuditModel(input);
  } catch {
    throw new TypeError('Modelo CSV inválido ou contém propriedade insegura.');
  }
  const pageById = new Map(model.pages.map(page => [page.pageId, page]));
  const evidenceById = new Map(model.evidence.map(evidence => [evidence.evidenceId, evidence]));
  const records = [serializeRecord(OCCURRENCE_CSV_COLUMNS)];
  let byteLength = ENCODER.encode(`\uFEFF${records[0]}\r\n`).byteLength;

  for (const occurrence of model.occurrences) {
    const page = pageById.get(occurrence.pageId);
    if (!page) throw new TypeError(`Ocorrência ${occurrence.occurrenceId} referencia página desconhecida.`);
    const referencedEvidence = occurrence.evidenceRefs.map(evidenceId => evidenceById.get(evidenceId));
    if (referencedEvidence.some(evidence => !evidence || evidence.pageId !== occurrence.pageId)) {
      throw new TypeError(`Ocorrência ${occurrence.occurrenceId} referencia evidência desconhecida ou de outra página.`);
    }
    const previewEvidence = referencedEvidence.find(evidence =>
      evidence.nodeId === occurrence.target.nodeId && typeof evidence.accessibility?.nameSource === 'string')
      ?? referencedEvidence.find(evidence => typeof evidence.accessibility?.nameSource === 'string');
    const values = [
      OCCURRENCE_CSV_VERSION,
      strictToken(model.auditId),
      strictToken(occurrence.occurrenceId),
      strictToken(occurrence.pageId),
      httpOrigin(page.finalUrl),
      strictInstant(page.timestamps.generatedAt),
      strictToken(occurrence.outcome),
      strictToken(occurrence.classification),
      strictToken(occurrence.impact),
      strictToken(occurrence.confidence),
      strictToken(occurrence.source.engine),
      strictToken(occurrence.source.version),
      strictToken(occurrence.source.ruleId),
      strictToken(occurrence.nbrItemRef),
      strictTokenList(occurrence.wcagRefs, ';'),
      foreignReferenceList(occurrence.foreignBenchmarkRefs),
      localCatalogTitle(occurrence.nbrItemRef),
      fixedOccurrenceDescription(occurrence),
      projectedDetail(occurrence.target.selector),
      projectedDetail(occurrence.target.framePath),
      projectedDetail(occurrence.accessiblePreview),
      projectedDetail(previewEvidence?.accessibility?.nameSource),
      strictTokenList(occurrence.evidenceRefs, ';'),
      strictToken(occurrence.legalAnalysis?.basisRef),
      integrityVerified ? verifiedEvidenceHashList(occurrence.evidenceRefs, referencedEvidence) : '',
      integrityVerified ? strictSha256(model.integrity?.canonicalModelHash) : '',
      integrityVerified ? strictSha256(model.integrity?.evidenceManifestHash) : '',
    ];
    const record = serializeRecord(values);
    byteLength += ENCODER.encode(`${record}\r\n`).byteLength;
    if (byteLength > MAX_CSV_BYTES) throw new RangeError('O CSV excede o limite seguro de tamanho.');
    records.push(record);
  }
  return `\uFEFF${records.join('\r\n')}\r\n`;
}

function serializeRecord(values) {
  return values.map(value => quoteCell(neutralizeFormula(boundedScalar(value)))).join(',');
}

function strictToken(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > MAX_TOKEN_CODE_POINTS || !SAFE_TOKEN.test(value)) return '';
  return value;
}

function strictSha256(value) {
  return typeof value === 'string' && SHA256.test(value) ? value : '';
}

function strictTokenList(values, separator) {
  if (!Array.isArray(values) || values.length > MAX_LIST_ITEMS) return '';
  const projected = values.map(strictToken);
  return projected.some((value, index) => value === '' && values[index] !== '') ? '' : projected.join(separator);
}

function foreignReferenceList(references) {
  if (!Array.isArray(references) || references.length > MAX_LIST_ITEMS) return '';
  const projected = references.map(reference => {
    const benchmarkId = strictToken(reference?.benchmarkId);
    const criterionId = strictToken(reference?.criterionId);
    const level = strictToken(reference?.level);
    return benchmarkId && criterionId && level ? `${benchmarkId}:${criterionId}:${level}` : '';
  });
  return projected.some(value => value === '') ? '' : projected.join(';');
}

function httpOrigin(value) {
  if (typeof value !== 'string') return '';
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin !== 'null' ? parsed.origin : '';
  } catch {
    return '';
  }
}

function strictInstant(value) {
  if (typeof value !== 'string') return '';
  try { return new Date(value).toISOString() === value ? value : ''; } catch { return ''; }
}

function localCatalogTitle(itemId) {
  if (typeof itemId !== 'string' || !CATALOG_ITEM_BY_ID.has(itemId)) return 'Ocorrência suplementar';
  return CATALOG_ITEM_BY_ID.get(itemId).title;
}

function fixedOccurrenceDescription(occurrence) {
  const classification = CLASSIFICATION_LABEL[occurrence.classification] ?? 'Ocorrência';
  const outcome = OUTCOME_LABEL[occurrence.outcome] ?? 'resultado não disponível';
  return `${classification}: ${outcome}; detalhes disponíveis somente no HTML/JSON.`;
}

function projectedDetail(value) {
  if (Array.isArray(value)) return value.length === 0 ? '' : DETAIL_MARKER;
  return value === null || value === undefined || value === '' ? '' : DETAIL_MARKER;
}

function verifiedEvidenceHashList(evidenceRefs, evidence) {
  if (!Array.isArray(evidenceRefs) || !Array.isArray(evidence) || evidenceRefs.length !== evidence.length ||
    evidenceRefs.length > MAX_LIST_ITEMS) return '';
  const pairs = [];
  for (let index = 0; index < evidenceRefs.length; index += 1) {
    const evidenceId = strictToken(evidenceRefs[index]);
    const hash = strictSha256(evidence[index]?.hash);
    if (!evidenceId || !hash) return '';
    pairs.push(`${evidenceId}=${hash}`);
  }
  return pairs.join(';');
}

function boundedScalar(value) {
  const raw = typeof value === 'string' ? value : '';
  const codePoints = [];
  let truncated = false;
  for (const character of raw) {
    if (codePoints.length === MAX_CELL_CODE_POINTS) {
      truncated = true;
      break;
    }
    codePoints.push(unsafeControl(character) ? '�' : character);
  }
  if (!truncated) return codePoints.join('');
  const markerLength = [...TRUNCATION_MARKER].length;
  return `${codePoints.slice(0, MAX_CELL_CODE_POINTS - markerLength).join('')}${TRUNCATION_MARKER}`;
}

function unsafeControl(character) {
  const code = character.codePointAt(0);
  return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) ||
    (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
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
