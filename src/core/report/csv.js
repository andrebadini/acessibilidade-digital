import { createAuditModel } from './audit-model.js';

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
const TRUNCATION_MARKER = '…[truncated]';
const DANGEROUS_FIRST_CHARACTER = /^[=+\-@\t\r]/u;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const ENCODER = new TextEncoder();

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
  return values.map(value => quoteCell(neutralizeFormula(boundedText(value)))).join(',');
}

function boundedText(value) {
  const text = (value === null || value === undefined ? '' : String(value)).replace(UNSAFE_CONTROL, '�');
  const codePoints = [...text];
  if (codePoints.length <= MAX_CELL_CODE_POINTS) return text;
  const markerLength = [...TRUNCATION_MARKER].length;
  return `${codePoints.slice(0, MAX_CELL_CODE_POINTS - markerLength).join('')}${TRUNCATION_MARKER}`;
}

function neutralizeFormula(value) {
  return DANGEROUS_FIRST_CHARACTER.test(value) ? `'${value}` : value;
}

function quoteCell(value) {
  return `"${value.replace(/"/gu, '""')}"`;
}
