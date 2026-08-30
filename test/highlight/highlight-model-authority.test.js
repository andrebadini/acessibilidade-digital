import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { createHighlightModelAuthority } from '../../src/background/highlight-model-authority.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { isAuditIntegrityVerified } from '../../src/core/report/integrity.js';

const OPTIONS = Object.freeze({
  now: () => '2026-08-29T12:00:00.000Z',
  timezone: 'America/Cuiaba',
  manifestVersion: '0.1.0',
  rulesVersion: '1.0.0',
  browserVersion: 'Chrome/147.0.0.0',
});

async function modelFixture(auditId = 'audit-highlight-authority') {
  const draft = structuredClone(SAMPLE_AUDIT);
  draft.auditId = auditId;
  draft.integrity.canonicalModelHash = 'pending';
  draft.integrity.evidenceManifestHash = 'pending';
  return enrichAuditForReport(draft, OPTIONS);
}

test('reloads and independently verifies the exact persisted audit revision', async () => {
  const model = await modelFixture();
  const privateCapability = Object.freeze({ private: 'must-not-leave-store' });
  let reads = 0;
  const authority = createHighlightModelAuthority({
    auditStore: {
      async getAuditSnapshot(auditId) {
        reads += 1;
        assert.equal(auditId, model.auditId);
        return { model: structuredClone(model), revision: 7, capability: privateCapability };
      },
    },
  });

  const loaded = await authority.loadValidated({ auditId: model.auditId });

  assert.equal(reads, 1);
  assert.deepEqual(Reflect.ownKeys(loaded), ['model', 'modelRevision', 'modelHash']);
  assert.equal(loaded.modelRevision, 7);
  assert.equal(loaded.modelHash, model.integrity.canonicalModelHash);
  assert.equal(loaded.model.auditId, model.auditId);
  assert.equal(isAuditIntegrityVerified(loaded.model), true);
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.model), true);
  assert.equal(JSON.stringify(loaded).includes('must-not-leave-store'), false);
});

test('rejects missing, pending, forged, stale, cross-audit and extra-field snapshots closed', async () => {
  const complete = await modelFixture('audit-authority-denied');
  const pending = structuredClone(SAMPLE_AUDIT);
  pending.auditId = complete.auditId;
  const forged = structuredClone(complete);
  forged.integrity.canonicalModelHash = 'f'.repeat(64);

  const snapshots = [
    { model: undefined, revision: 0, capability: null },
    { model: complete, revision: 0, capability: null },
    { model: pending, revision: 1, capability: null },
    { model: forged, revision: 1, capability: null },
    { model: complete, revision: 1, capability: null, debugUrl: 'https://private.test/?token=x' },
  ];

  for (const snapshot of snapshots) {
    const authority = createHighlightModelAuthority({
      auditStore: { async getAuditSnapshot() { return snapshot; } },
    });
    await assert.rejects(
      authority.loadValidated({ auditId: complete.auditId }),
      error => error instanceof TypeError && error.message === 'AUDIT_MODEL_INVALID',
    );
  }

  const crossAudit = createHighlightModelAuthority({
    auditStore: { async getAuditSnapshot() { return { model: complete, revision: 1, capability: null }; } },
  });
  await assert.rejects(
    crossAudit.loadValidated({ auditId: 'audit-other' }),
    error => error instanceof TypeError && error.message === 'AUDIT_MODEL_INVALID',
  );
});

test('does not execute accessors and rejects hostile snapshot proxies', async () => {
  let getterCalls = 0;
  const accessorSnapshot = {};
  Object.defineProperties(accessorSnapshot, {
    model: { enumerable: true, get() { getterCalls += 1; return {}; } },
    revision: { enumerable: true, value: 1 },
    capability: { enumerable: true, value: null },
  });
  const accessorAuthority = createHighlightModelAuthority({
    auditStore: { async getAuditSnapshot() { return accessorSnapshot; } },
  });
  await assert.rejects(
    accessorAuthority.loadValidated({ auditId: 'audit-accessor' }),
    error => error instanceof TypeError && error.message === 'AUDIT_MODEL_INVALID',
  );
  assert.equal(getterCalls, 0);

  const hostile = new Proxy({}, {
    ownKeys() { throw new Error('private proxy detail'); },
  });
  const proxyAuthority = createHighlightModelAuthority({
    auditStore: { async getAuditSnapshot() { return hostile; } },
  });
  await assert.rejects(
    proxyAuthority.loadValidated({ auditId: 'audit-proxy' }),
    error => error instanceof TypeError && error.message === 'AUDIT_MODEL_INVALID' &&
      !error.message.includes('private proxy detail'),
  );
});

test('validates factory and request inputs without touching the store', async () => {
  assert.throws(
    () => createHighlightModelAuthority(),
    error => error instanceof TypeError && error.message === 'AUDIT_MODEL_INVALID',
  );
  let reads = 0;
  const authority = createHighlightModelAuthority({
    auditStore: { async getAuditSnapshot() { reads += 1; } },
  });
  for (const input of [null, {}, { auditId: '__proto__' }, { auditId: 'ok', extra: true }]) {
    await assert.rejects(
      authority.loadValidated(input),
      error => error instanceof TypeError && error.message === 'AUDIT_MODEL_INVALID',
    );
  }
  assert.equal(reads, 0);
});
