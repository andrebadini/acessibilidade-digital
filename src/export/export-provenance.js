import { canonicalStringify } from '../core/report/canonical-json.js';
import { sha256Hex } from '../core/report/hash.js';

const PROVENANCE_BY_MODEL = new WeakMap();

/** Internal generation capability: binds the downloaded artifact set to its final model object. */
export async function attestReportExportResult(result) {
  try {
    if (!result?.model || typeof result.model !== 'object') throw new TypeError();
    const provenance = Object.freeze(await projectResult(result));
    PROVENANCE_BY_MODEL.set(result.model, provenance);
    return result;
  } catch {
    throw new TypeError('Resultado final de exportação não pôde ser atestado.');
  }
}

/** Captures the opaque generation record before caller-owned state can change across an await. */
export function captureReportExportProvenance(model) {
  return model && typeof model === 'object' ? PROVENANCE_BY_MODEL.get(model) ?? null : null;
}

/** Verifies owned persistence snapshots against the exact artifact set issued by report generation. */
export async function verifyReportExportProvenance(provenance, snapshot) {
  try {
    if (!provenance || canonicalStringify(await projectResult(snapshot)) !== canonicalStringify(provenance)) {
      throw new TypeError();
    }
  } catch {
    throw new TypeError('Proveniência dos artefatos HTML/JSON/CSV/PDF inválida ou ausente.');
  }
}

async function projectResult(value) {
  return {
    model: await sha256Hex(canonicalStringify(value.model)),
    html: await textHash(value.html, false),
    json: await textHash(value.json, false),
    csv: await textHash(value.csv, true),
    pdf: await binaryHash(value.pdf, true),
    formats: await sha256Hex(canonicalStringify(value.formats)),
    deliveryReceipt: await sha256Hex(canonicalStringify(value.deliveryReceipt)),
    limitations: await sha256Hex(canonicalStringify(value.limitations)),
    pdfFallback: value.pdfFallback === true ? true : value.pdfFallback === false ? false : invalid(),
  };
}

async function textHash(value, nullable) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') throw new TypeError();
  return sha256Hex(value);
}

async function binaryHash(value, nullable) {
  if (nullable && value === null) return null;
  if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) throw new TypeError();
  return sha256Hex(value);
}

function invalid() {
  throw new TypeError();
}
