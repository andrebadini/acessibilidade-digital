import { NBR17225_ITEMS } from '../normative/nbr17225.js';
import { registeredOccurrenceSource } from '../provenance.js';
import { auditModelInputError } from './audit-input.js';
import { isAuditIntegrityVerified } from './integrity.js';
import { createExportDeliveryIdentityV1 } from '../../export/export-formats.js';

export const OCCURRENCE_CSV_VERSION = 'audita-occurrences-v2';
export const OCCURRENCE_CSV_COLUMNS = Object.freeze([
  'csv_schema_version', 'audit_id', 'occurrence_id', 'page_id', 'page_url',
  'observed_at', 'outcome', 'classification', 'impact', 'confidence',
  'source_engine', 'source_version', 'source_rule_id', 'nbr_item_ref',
  'item_wcag_refs', 'source_wcag_refs', 'tested_wcag_refs', 'wcag_refs',
  'section_508_refs', 'title', 'description', 'selector',
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
const SAFE_TOKEN = /^[A-Za-z0-9._:-]{1,200}$/u;
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

/** Pure, fixed-column projection of an integrity-verified canonical V2 snapshot. */
export function renderOccurrenceCsv(input, options = {}) {
  if (!isAuditIntegrityVerified(input)) {
    throw auditModelInputError();
  }
  const model = input;
  const pageById = new Map(model.pages.map(page => [page.pageId, page]));
  const evidenceById = new Map(model.evidence.map(evidence => [evidence.evidenceId, evidence]));
  const deliveryIdentity = options?.deliveryIdentity === undefined ? null : createExportDeliveryIdentityV1(options.deliveryIdentity);
  const columns = deliveryIdentity === null ? OCCURRENCE_CSV_COLUMNS : [
    ...OCCURRENCE_CSV_COLUMNS,
    'export_delivery_identity_type', 'export_delivery_audit_id', 'export_delivery_model_revision',
    'export_delivery_model_hash', 'export_delivery_attempt_id',
  ];
  const records = [serializeRecord(columns)];
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
    const locatorEvidence = referencedEvidence.find(evidence =>
      evidence.nodeId === occurrence.target.nodeId && evidence.selector)
      ?? referencedEvidence.find(evidence => evidence.selector);
    const source = trustedOccurrenceSource(occurrence, model.versions.rules);
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
      source.engine,
      source.version,
      strictToken(source.ruleId),
      strictToken(occurrence.nbrItemRef),
      strictTokenList(occurrence.itemWcagRefs, ';'),
      strictTokenList(occurrence.sourceWcagRefs, ';'),
      strictTokenList(occurrence.testedWcagRefs, ';'),
      strictTokenList(occurrence.wcagRefs, ';'),
      foreignReferenceList(occurrence.foreignBenchmarkRefs),
      localCatalogTitle(occurrence.nbrItemRef),
      fixedOccurrenceDescription(occurrence),
      projectedDetail(occurrence.target.selector ?? locatorEvidence?.selector?.css),
      projectedDetail(occurrence.target.framePath.length > 0
        ? occurrence.target.framePath
        : locatorEvidence?.selector?.framePath ?? []),
      projectedDetail(occurrence.accessiblePreview),
      projectedDetail(previewEvidence?.accessibility?.nameSource),
      strictTokenList(occurrence.evidenceRefs, ';'),
      strictToken(occurrence.legalAnalysis?.basisRef),
      verifiedEvidenceHashList(occurrence.evidenceRefs, referencedEvidence),
      strictSha256(model.integrity?.canonicalModelHash),
      strictSha256(model.integrity?.evidenceManifestHash),
    ];
    const record = serializeRecord(deliveryIdentity === null ? values : [...values,
      'ExportDeliveryIdentityV1', deliveryIdentity.auditId, String(deliveryIdentity.modelRevision),
      deliveryIdentity.modelHash, deliveryIdentity.attemptId,
    ]);
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
  assertProjectableList(values);
  const projected = values.map(strictToken);
  if (projected.some((value, index) => value === '' && values[index] !== '')) {
    throw new TypeError('Uma lista do CSV contém referência fora da gramática permitida.');
  }
  return completeListCell(projected, separator);
}

function foreignReferenceList(references) {
  assertProjectableList(references);
  const projected = references.map(reference => {
    const benchmarkId = strictToken(reference?.benchmarkId);
    const criterionId = strictToken(reference?.criterionId);
    const level = strictToken(reference?.level);
    return benchmarkId && criterionId && level ? `${benchmarkId}:${criterionId}:${level}` : '';
  });
  if (projected.some(value => value === '')) {
    throw new TypeError('Uma lista do CSV contém referência estrangeira fora da gramática permitida.');
  }
  return completeListCell(projected, ';');
}

function assertProjectableList(values) {
  if (!Array.isArray(values)) throw new TypeError('Uma lista obrigatória do CSV é inválida.');
  if (values.length > MAX_LIST_ITEMS) {
    throw new RangeError(`O CSV não representa listas acima de ${MAX_LIST_ITEMS} referências sem perda.`);
  }
}

function completeListCell(values, separator) {
  const projected = values.join(separator);
  const neutralizationLength = DANGEROUS_FIRST_CHARACTER.test(projected) ? 1 : 0;
  if ([...projected].length + neutralizationLength > MAX_CELL_CODE_POINTS) {
    throw new RangeError('O CSV não representa uma lista que exceda a célula sem perda ou truncamento.');
  }
  return projected;
}

function trustedOccurrenceSource(occurrence, rulesVersion) {
  const source = registeredOccurrenceSource(occurrence, rulesVersion);
  if (!source) throw new TypeError('Ocorrência sem proveniência registrada para o CSV.');
  return { engine: source.engine, version: source.version, ruleId: source.ruleId };
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
  assertProjectableList(evidenceRefs);
  if (!Array.isArray(evidence) || evidenceRefs.length !== evidence.length) {
    throw new TypeError('Evidências do CSV não correspondem às referências projetadas.');
  }
  const pairs = [];
  for (let index = 0; index < evidenceRefs.length; index += 1) {
    const evidenceId = strictToken(evidenceRefs[index]);
    const hash = strictSha256(evidence[index]?.hash);
    if (!evidenceId || !hash) {
      throw new TypeError('Um par de evidência do CSV não possui identificador e hash íntegros.');
    }
    pairs.push(`${evidenceId}=${hash}`);
  }
  return completeListCell(pairs, ';');
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
