import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { hashAnnotationMapArtifact } from '../../src/core/evidence/annotation-map-artifact.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { sha256Hex } from '../../src/core/report/hash.js';
import { isAuditIntegrityVerified, verifyAuditIntegritySnapshot } from '../../src/core/report/integrity.js';
import { createAnnotationMapFixture, createPristineMapSource } from './annotation-map-fixture.js';
import { reportInput } from './helpers.js';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inflateBombPng() {
  const chunk = (type, data) => {
    const typeBytes = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
    return Buffer.concat([length, typeBytes, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(new Uint8Array(10 * 1024 * 1024))), chunk('IEND', Buffer.alloc(0)),
  ]));
}

async function modelWithMap() {
  const model = structuredClone(SAMPLE_AUDIT);
  model.evidence[0] = createPristineMapSource();
  model.evidence.push(await createAnnotationMapFixture());
  return model;
}

test('accepts one exact same-page map and forbids binding the page-level map to occurrences', async () => {
  const input = await modelWithMap();
  const canonical = createAuditModel(input);
  assert.equal(canonical.evidence.find(artifact => artifact.kind === 'announcement-map').pageId, 'page-1');

  const linked = structuredClone(input);
  linked.occurrences[0].evidenceRefs.push('ev-map');
  linked.occurrences[0].evidenceIds.push('ev-map');
  assert.throws(() => createAuditModel(linked), /mapa|ocorrência|evidência derivada/iu);
});

test('rejects map extra fields, forged source metadata and duplicates per page', async () => {
  const base = await modelWithMap();
  for (const mutate of [
    value => { value.evidence.at(-1).privateValue = 'PRIVATE-SENTINEL'; },
    value => { value.evidence.at(-1).derivation.sourceHash = 'e'.repeat(64); },
    value => { value.evidence[0].state = 'derived'; },
    value => { value.evidence.push(structuredClone(value.evidence.at(-1))); value.evidence.at(-1).evidenceId = 'ev-map-2'; },
  ]) {
    const forged = structuredClone(base);
    mutate(forged);
    assert.throws(() => createAuditModel(forged), /mapa|origem|pristine|hash|duplicad|esquema/iu);
  }
});

test('migrates a V1 page map to page-1 without inventing another page or occurrence link', async () => {
  const input = reportInput();
  const source = createPristineMapSource();
  const map = await createAnnotationMapFixture();
  delete source.pageId;
  delete map.pageId;
  input.evidence.artifacts.push(source, map);

  const model = createAuditModel(input);
  const migrated = model.evidence.find(artifact => artifact.kind === 'announcement-map');
  assert.equal(migrated.pageId, 'page-1');
  assert.equal(model.pages.length, 1);
  assert.equal(model.occurrences.some(occurrence => occurrence.evidenceRefs.includes(migrated.evidenceId)), false);
});

test('recomputes and verifies nested map hashes during report enrichment and rejects forged geometry', async () => {
  const input = await modelWithMap();
  const enriched = await enrichAuditForReport(input, {
    now: () => '2026-08-28T12:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  const map = enriched.evidence.find(artifact => artifact.kind === 'announcement-map');
  assert.match(map.hash, /^[a-f0-9]{64}$/u);
  const verified = await verifyAuditIntegritySnapshot(enriched);
  assert.equal(isAuditIntegrityVerified(verified), true);
  assert.deepEqual(verified, enriched);

  const forged = await modelWithMap();
  forged.evidence.at(-1).derivation.geometry.annotations[0].marker.x = 0.25;
  await assert.rejects(enrichAuditForReport(forged, {
    now: () => '2026-08-28T12:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  }), /geometria|integridade|hash|mapa/iu);
});

test('rejects a persisted map whose matching pristine source has an invalid inflated raster', async () => {
  const input = await modelWithMap();
  const bytes = inflateBombPng();
  const sourceHash = await sha256Hex(bytes);
  input.evidence[0].dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
  input.evidence[0].hash = sourceHash;
  input.evidence.at(-1).derivation.sourceHash = sourceHash;
  input.evidence.at(-1).hash = await hashAnnotationMapArtifact(input.evidence.at(-1));

  await assert.rejects(enrichAuditForReport(input, {
    now: () => '2026-08-28T12:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  }), /PNG|raster|integridade|mapa|origem/iu);
});
