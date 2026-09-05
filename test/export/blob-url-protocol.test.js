import assert from 'node:assert/strict';
import test from 'node:test';

const moduleUrl = new URL('../../src/export/blob-url-protocol.js', import.meta.url);
const protocol = await import(moduleUrl.href).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === moduleUrl.href) return {};
  throw error;
});
const extensionId = 'a'.repeat(32);
const blobUrl = `blob:chrome-extension://${extensionId}/11111111-1111-4111-8111-111111111111`;
const packets = [
  ['client', { type: 'hello', auditId: 'audit-one', sessionCapabilityId: 'A'.repeat(22) }],
  ['client', { type: 'register', requestId: 1, blobUrl }],
  ['client', { type: 'release', requestId: 2, blobUrl }],
  ['client', { type: 'revoked', requestId: 3, ok: true }],
  ['worker', { type: 'ready' }],
  ['worker', { type: 'result', requestId: 4, ok: false }],
  ['worker', { type: 'revoke', requestId: 5, blobUrl }],
];
function parse(value, source) {
  assert.equal(typeof protocol.parseBlobPortMessageV1, 'function');
  return protocol.parseBlobPortMessageV1(value, source);
}

test('Blob Port protocol accepts only the directional closed packets and freezes independent copies', () => {
  assert.equal(protocol.BLOB_URL_PORT_NAME, 'audita-export-blobs-v1');
  for (const [source, packet] of packets) {
    const result = parse(packet, source);
    assert.deepEqual(result, packet); assert.notEqual(result, packet); assert.ok(Object.isFrozen(result));
    assert.equal(parse(packet, source === 'client' ? 'worker' : 'client'), null);
    assert.equal(parse(packet, 'unknown'), null);
  }
});

test('Blob Port protocol rejects untrusted additions and invalid scalar fields without executing accessors', () => {
  for (const [source, packet] of packets) {
    for (const value of [null, undefined, [], Object.create(packet), { ...packet, extra: true },
      { ...packet, [Symbol('extra')]: true }, ...Object.keys(packet).map(key => {
        const copy = { ...packet }; delete copy[key]; return copy;
      })]) assert.equal(parse(value, source), null);
    let reads = 0;
    const accessor = { ...packet };
    Object.defineProperty(accessor, 'type', { enumerable: true, get() { reads++; throw new Error('PRIVATE_SENTINEL'); } });
    assert.equal(parse(accessor, source), null); assert.equal(reads, 0);
  }
  for (const requestId of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.equal(parse({ type: 'register', requestId, blobUrl }, 'client'), null);
  }
  for (const ok of [0, 1, 'true', undefined]) assert.equal(parse({ type: 'result', requestId: 1, ok }, 'worker'), null);
  for (const auditId of ['', 'a'.repeat(161), 'audit.private', 'https://example.test/']) {
    assert.equal(parse({ ...packets[0][1], auditId }, 'client'), null);
  }
  assert.equal(parse({ ...packets[0][1], sessionCapabilityId: 'A'.repeat(23) }, 'client'), null);
});

test('Blob URLs must belong to the native local extension origin and exact registry format', () => {
  assert.equal(typeof protocol.isExportBlobUrlV1, 'function');
  assert.equal(protocol.isExportBlobUrlV1(blobUrl, extensionId), true);
  assert.equal(protocol.isExportBlobUrlV1(blobUrl, 'b'.repeat(32)), false);
  for (const invalid of [null, {}, '', 'https://example.test/', `${blobUrl}?private=1`, `${blobUrl}#fragment`,
    blobUrl.replace(extensionId, 'z'.repeat(32)), blobUrl.replace('11111111-', 'x1111111-')]) {
    assert.equal(protocol.isExportBlobUrlV1(invalid, extensionId), false);
    assert.equal(parse({ type: 'register', requestId: 1, blobUrl: invalid }, 'client'), null);
  }
  assert.equal(protocol.isExportBlobUrlV1(blobUrl, null), false);
});
