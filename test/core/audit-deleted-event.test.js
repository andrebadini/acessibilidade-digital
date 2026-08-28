import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAuditDeletedEvent,
  parseAuditDeletedEvent,
} from '../../src/core/audit-deleted-event.js';

const runtime = {
  id: 'extension-id',
  workerUrl: 'chrome-extension://extension-id/src/background/service-worker.js',
};

test('accepts only exact deletion notices issued by the extension worker', () => {
  const sender = { id: runtime.id, url: runtime.workerUrl };
  assert.deepEqual(
    parseAuditDeletedEvent(createAuditDeletedEvent({ auditId: 'audit-1', reason: 'delete-one' }), sender, runtime),
    { type: 'AUDIT_DELETED', auditId: 'audit-1', reason: 'delete-one' },
  );
  assert.deepEqual(
    parseAuditDeletedEvent(createAuditDeletedEvent({ auditId: 'audit-2', reason: 'complete-export' }), {
      id: runtime.id,
    }, runtime),
    { type: 'AUDIT_DELETED', auditId: 'audit-2', reason: 'complete-export' },
  );
  assert.deepEqual(
    parseAuditDeletedEvent(createAuditDeletedEvent({ scope: 'all', reason: 'delete-all' }), sender, runtime),
    { type: 'AUDIT_DELETED', scope: 'all', reason: 'delete-all' },
  );

  for (const [message, untrustedSender] of [
    [{ type: 'AUDIT_DELETED', auditId: 'audit-1', reason: 'delete-one' }, {
      id: runtime.id, url: 'chrome-extension://extension-id/src/export/index.html',
    }],
    [{ type: 'AUDIT_DELETED', auditId: 'audit-1', reason: 'delete-one' }, {
      id: runtime.id, url: runtime.workerUrl, tab: { id: 7 },
    }],
    [{ type: 'AUDIT_DELETED', auditId: 'audit-1', reason: 'delete-one', extra: true }, sender],
    [{ type: 'AUDIT_DELETED', auditId: 'audit-1', reason: 'delete-all' }, sender],
    [{ type: 'AUDIT_DELETED', scope: 'all', reason: 'complete-export' }, sender],
    [{ type: 'AUDIT_DELETED', auditId: '../audit', reason: 'delete-one' }, sender],
  ]) assert.equal(parseAuditDeletedEvent(message, untrustedSender, runtime), null);
});

test('refuses to create a notice whose subject and reason do not match', () => {
  for (const value of [
    { auditId: 'audit-1', reason: 'delete-all' },
    { scope: 'all', reason: 'delete-one' },
    { auditId: 'audit-1', scope: 'all', reason: 'delete-one' },
    { auditId: 'audit-1', reason: 'unknown' },
  ]) assert.throws(() => createAuditDeletedEvent(value), TypeError);
});
