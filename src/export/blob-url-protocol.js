export const BLOB_URL_PORT_NAME = 'audita-export-blobs-v1';

const BLOB = /^blob:chrome-extension:\/\/([a-p]{32})\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const SHAPES = Object.freeze({
  hello: ['type', 'auditId', 'sessionCapabilityId'],
  register: ['type', 'requestId', 'blobUrl'], release: ['type', 'requestId', 'blobUrl'],
  revoked: ['type', 'requestId', 'ok'], ready: ['type'],
  result: ['type', 'requestId', 'ok'], revoke: ['type', 'requestId', 'blobUrl'],
});
const DIRECTIONS = Object.freeze({ client: ['hello', 'register', 'release', 'revoked'], worker: ['ready', 'result', 'revoke'] });

export function isExportBlobUrlV1(value, extensionId) {
  return typeof value === 'string' && typeof extensionId === 'string' && BLOB.exec(value)?.[1] === extensionId;
}

export function parseBlobPortMessageV1(value, source) {
  try {
    if (!Object.hasOwn(DIRECTIONS, source) || !value || typeof value !== 'object' ||
      Object.getPrototypeOf(value) !== Object.prototype) return null;
    const type = Object.getOwnPropertyDescriptor(value, 'type')?.value;
    if (!DIRECTIONS[source].includes(type)) return null;
    const shape = SHAPES[type];
    const keys = Reflect.ownKeys(value);
    if (keys.length !== shape.length || keys.some(key => !shape.includes(key))) return null;
    const copy = {};
    for (const key of shape) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    if (type === 'hello' && (typeof copy.auditId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/u.test(copy.auditId) ||
      typeof copy.sessionCapabilityId !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(copy.sessionCapabilityId))) return null;
    if ('requestId' in copy && (!Number.isSafeInteger(copy.requestId) || copy.requestId < 1)) return null;
    if ('blobUrl' in copy && (typeof copy.blobUrl !== 'string' || !BLOB.test(copy.blobUrl))) return null;
    if ('ok' in copy && typeof copy.ok !== 'boolean') return null;
    return Object.freeze(copy);
  } catch { return null; }
}
