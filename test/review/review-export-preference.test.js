import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../../src/review/review.js', import.meta.url), 'utf8');
const requestSource = source.slice(source.indexOf('async function requestExport('), source.indexOf('\nasync function returnToAuditedPage'));

test('review forwards explicit export choice; a default request never inherits deletion', async () => {
  const sent = [];
  const request = runInNewContext(`${requestSource}; requestExport`, {
    auditModel: { auditId: 'audit-a' }, reportSessionCapabilityId: 'S'.repeat(22),
    regenerate: {}, status: {}, async sendWorkerRequest(value) { sent.push(value); return { ok: true }; },
  });
  await request({ deleteAfterCompleteExport: true });
  await request();
  assert.deepEqual(sent.map(value => value.deleteAfterCompleteExport), [true, false]);
  assert.match(source, /onExport:\s*options\s*=>\s*\{\s*void requestExport\(options\)/u);
});
