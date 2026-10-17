export const EXPORT_FORMATS_V1 = Object.freeze(['html', 'pdf', 'csv', 'json']);

const FORMAT_INDEX_V1 = new Map(EXPORT_FORMATS_V1.map((format, index) => [format, index]));
const SHA256 = /^[a-f0-9]{64}$/u;
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const ATTEMPT = /^(?:[1-9][0-9]*)$/u;

/**
 * A canonical subset is an ordered, duplicate-free, non-empty selection from EXPORT_FORMATS_V1.
 * It may arrive as the comma-separated string used in worker envelopes or as an array.
 */
export function isCanonicalExportFormatsV1(value) {
  try {
    if (typeof value !== 'string' && !Array.isArray(value)) return false;
    // Só arrays comuns entram: subclasses podem esconder acessores ou herdar entradas.
    if (typeof value !== 'string' && Object.getPrototypeOf(value) !== Array.prototype) return false;
    const values = typeof value === 'string' ? (value === '' ? [] : value.split(',')) : value;
    if (values.length < 1 || values.length > EXPORT_FORMATS_V1.length) return false;
    let previous = -1;
    for (let index = 0; index < values.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') return false;
      const position = FORMAT_INDEX_V1.get(descriptor.value);
      if (position === undefined || position <= previous) return false;
      previous = position;
    }
    return true;
  } catch {
    return false;
  }
}

/** Returns a frozen canonical subset, copied from validated own data properties. */
export function canonicalExportFormatsV1(value) {
  if (!isCanonicalExportFormatsV1(value)) throw new TypeError('Formatos de exportação inválidos.');
  const source = typeof value === 'string' ? value.split(',') : value;
  const formats = [];
  for (let index = 0; index < source.length; index += 1) {
    formats.push(Object.getOwnPropertyDescriptor(source, String(index)).value);
  }
  return Object.freeze(formats);
}

/** The comma-separated worker-envelope form of a canonical subset. */
export function exportFormatsEnvelopeV1(value) {
  return canonicalExportFormatsV1(value).join(',');
}

/** The non-secret identity repeated in every delivered artifact. */
export function createExportDeliveryIdentityV1(value = {}) {
  let descriptors;
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new TypeError();
    }
    descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== 4 || keys.some(key => typeof key !== 'string' ||
      !['auditId', 'modelRevision', 'modelHash', 'attemptId'].includes(key)) ||
      Object.values(descriptors).some(descriptor => !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))) throw new TypeError();
  } catch {
    throw new TypeError('ExportDeliveryIdentityV1 inválida.');
  }
  const identity = {
    auditId: descriptors.auditId.value,
    modelRevision: descriptors.modelRevision.value,
    modelHash: descriptors.modelHash.value,
    attemptId: descriptors.attemptId.value,
  };
  if (!AUDIT_ID.test(identity.auditId) || !Number.isSafeInteger(identity.modelRevision) || identity.modelRevision < 1 ||
    !SHA256.test(identity.modelHash) || !ATTEMPT.test(identity.attemptId)) {
    throw new TypeError('ExportDeliveryIdentityV1 inválida.');
  }
  return Object.freeze({
    ...identity,
  });
}
