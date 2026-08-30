export const EXPORT_FORMATS_V1 = Object.freeze(['html', 'pdf', 'csv', 'json']);

const SHA256 = /^[a-f0-9]{64}$/u;
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const ATTEMPT = /^(?:[1-9][0-9]*)$/u;

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
