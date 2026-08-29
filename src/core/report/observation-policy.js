import { SNAPSHOT_SCHEMA_VERSION } from '../snapshot-schema.js';
import { canonicalStringify } from './canonical-json.js';

const MAX_FRAME_COUNT = 10_000;
const MAX_NODE_COUNT = 2_000_000;
const MAX_WARNINGS = 1_024;

export const SNAPSHOT_WARNING_CODES = Object.freeze([
  'FRAME_RUNTIME_BLOCKED',
  'RUNTIME_FRAME_MISSING',
  'AX_FRAME_UNAVAILABLE',
  'RUNTIME_MATCH_AMBIGUOUS',
  'WARNINGS_UNAVAILABLE',
  'TIMEOUT',
  'ABORTED',
  'PROBE_FAILED',
]);

const WARNING_CODE_SET = new Set(SNAPSHOT_WARNING_CODES);
const COVERAGE_KEYS = Object.freeze(['runtime', 'accessibility']);

export function validateSnapshotSummary(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
    canonicalStringify(Object.keys(snapshot).sort()) !==
      canonicalStringify(['coverage', 'nodeCount', 'retention', 'schemaVersion', 'warnings'].sort()) ||
    snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || snapshot.retention !== 'summary-only' ||
    !Number.isSafeInteger(snapshot.nodeCount) || snapshot.nodeCount < 0 || snapshot.nodeCount > MAX_NODE_COUNT ||
    !Array.isArray(snapshot.warnings) || snapshot.warnings.length > MAX_WARNINGS) {
    throw new TypeError('Resumo estrutural inválido.');
  }
  validateCoverageSummary(snapshot.coverage, { allowEmpty: true });
  validateStructuralWarnings(snapshot.warnings);
  return snapshot;
}

export function validateStructuralWarnings(warnings) {
  if (!Array.isArray(warnings) || warnings.length > MAX_WARNINGS) {
    throw new TypeError('Lista de avisos estruturais inválida.');
  }
  const seen = new Set();
  for (const warning of warnings) {
    if (!warning || typeof warning !== 'object' || Array.isArray(warning) ||
      canonicalStringify(Object.keys(warning).sort()) !== canonicalStringify(['code']) ||
      !WARNING_CODE_SET.has(warning.code) || seen.has(warning.code)) {
      throw new TypeError('Aviso estrutural inválido ou duplicado.');
    }
    seen.add(warning.code);
  }
  return warnings;
}

export function validateCoverageSummary(coverage, { allowEmpty = false } = {}) {
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) {
    throw new TypeError('Cobertura estrutural inválida.');
  }
  const keys = Object.keys(coverage);
  if (keys.some(key => !COVERAGE_KEYS.includes(key)) ||
    (!allowEmpty && keys.length === 0)) {
    throw new TypeError('Cobertura estrutural possui modalidade ou ordem inválida.');
  }
  for (const key of keys) validateCoverageChannel(coverage[key], key);
  return coverage;
}

export function canonicalizeLegacyCoverage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  for (const key of COVERAGE_KEYS) {
    const channel = value[key];
    try {
      validateCoverageChannel(channel, key);
      output[key] = {
        outcome: channel.outcome,
        expectedFrameCount: channel.expectedFrameCount,
        observedFrameCount: channel.observedFrameCount,
      };
    } catch {}
  }
  return output;
}

export function canonicalizeLegacyWarnings(values) {
  if (!Array.isArray(values)) return [];
  const output = [];
  const seen = new Set();
  for (const value of values) {
    const code = value && typeof value === 'object' && !Array.isArray(value) ? value.code : null;
    if (!WARNING_CODE_SET.has(code) || seen.has(code)) continue;
    seen.add(code);
    output.push({ code });
    if (output.length === MAX_WARNINGS) break;
  }
  return output;
}

export function coverageIsPartial(coverage) {
  return Object.values(coverage ?? {}).some(channel => channel?.outcome === 'partial');
}

function validateCoverageChannel(channel, key) {
  if (!channel || typeof channel !== 'object' || Array.isArray(channel) ||
    canonicalStringify(Object.keys(channel).sort()) !==
      canonicalStringify(['outcome', 'expectedFrameCount', 'observedFrameCount'].sort()) ||
    !['complete', 'partial'].includes(channel.outcome) ||
    !Number.isSafeInteger(channel.expectedFrameCount) || channel.expectedFrameCount < 0 ||
    channel.expectedFrameCount > MAX_FRAME_COUNT ||
    !Number.isSafeInteger(channel.observedFrameCount) || channel.observedFrameCount < 0 ||
    channel.observedFrameCount > channel.expectedFrameCount) {
    throw new TypeError('Canal de cobertura estrutural inválido.');
  }
  const complete = key === 'runtime'
    ? channel.expectedFrameCount > 0 && channel.observedFrameCount === channel.expectedFrameCount
    : channel.observedFrameCount === channel.expectedFrameCount;
  if ((channel.outcome === 'complete') !== complete) {
    throw new TypeError('Resultado de cobertura estrutural contradiz suas contagens.');
  }
}
