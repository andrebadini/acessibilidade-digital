import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../../src/review/review.js', import.meta.url), 'utf8');
const dialogSource = source.slice(source.indexOf('const deleteAuditController = createDestructiveDialog('),
  source.indexOf('\ndeleteAudit.addEventListener'));

test('pending deletion clears the local report and explains remaining cleanup without losing the download notice', async () => {
  let config; const messages = []; let cleared = 0;
  runInNewContext(dialogSource, {
    deleteAuditDialog: {}, deleteAuditCancel: {}, deleteAuditConfirm: {}, status: {}, deleteAuditDialogStatus: {},
    auditModel: { auditId: 'audit-a' }, reportSessionCapabilityId: 'S'.repeat(22),
    createDestructiveDialog(value) { config = value; return { completeSuccess(message) { messages.push(message); } }; },
    async sendAuthorizedRequest(build) {
      assert.equal(build('S'.repeat(22)).type, 'REPORT_DELETE_AUDIT');
      return { ok: true, auditId: 'audit-a', deleted: true, status: 'pending' };
    },
    renderDeletedAudit() { cleared++; },
  });
  await config.onConfirm();
  assert.equal(cleared, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /já não estão disponíveis/iu);
  assert.match(messages[0], /limpeza.*pendente|pendente.*limpeza/iu);
  assert.match(messages[0], /retomada/iu);
  assert.match(messages[0], /arquivos.*baixados.*preservados/iu);
});
