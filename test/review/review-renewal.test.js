import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// A revisão guiada leva mais que os 30 minutos da autorização do relatório. Vencido o prazo, toda
// resposta, exportação e destaque era recusada ("o relatório perdeu a autorização"). O relatório
// renova a autorização e repete a ação uma vez.
const source = await readFile(new URL('../../src/review/review.js', import.meta.url), 'utf8');
const renewalSource = source.slice(source.indexOf('const REPORT_RENEW_INTERVAL_MS'), source.indexOf('\nsetInterval('));
const CAPABILITY = 'C'.repeat(22);

function environment({ responses, connect = { ok: true, auditId: 'audit-a', sessionCapabilityId: CAPABILITY, state: 'result' } }) {
  const sent = [];
  const queue = [...responses];
  const lay = [{ hidden: false }];
  const context = {
    Date: { now: () => 10 * 60_000 },
    auditModel: { auditId: 'audit-a' }, reportSessionCapabilityId: CAPABILITY, reportSessionState: 'result',
    activeHighlightOccurrenceId: null, reportReconnectTimer: null, reportReconnectAttempts: 3, reportHighlightPort: null,
    highlightAvailability: new Map(), reportHighlightPolicy: { invalidateKnown() {} },
    list: { querySelectorAll: () => lay }, returnToPage: { disabled: false }, reportSourceExplanation: {},
    applyReportSourceControls({ reportSessionState, returnControl }) { returnControl.disabled = reportSessionState !== 'result'; },
    connectReportHighlightState() {}, clearTimeout() {}, safeAuditId: () => 'audit-a',
    exactRecord(value, keys) {
      return value && typeof value === 'object' && Object.keys(value).length === keys.length &&
        keys.every(key => Object.hasOwn(value, key)) ? { ...value } : null;
    },
    async sendWorkerRequest(message) {
      sent.push(message);
      if (message.type === 'REPORT_CONNECT') return typeof connect === 'function' ? connect() : connect;
      return queue.shift();
    },
  };
  runInNewContext(renewalSource, context);
  return { context, sent, lay };
}

test('uma ação recusada por autorização renova o relatório e é repetida uma vez', async () => {
  const env = environment({ responses: [{ ok: false, code: 'REPORT_OPERATION_DENIED' }, { ok: true, saved: true }] });
  const build = capability => ({ type: 'REPORT_COMMIT_REVIEW_DECISION', sessionCapabilityId: capability, auditId: 'audit-a' });
  assert.deepEqual(await env.context.sendAuthorizedRequest(build), { ok: true, saved: true });
  // Sem renovação recente, a primeira coisa é renovar; depois da recusa, renova de novo e repete.
  assert.deepEqual(env.sent.map(message => message.type),
    ['REPORT_CONNECT', 'REPORT_COMMIT_REVIEW_DECISION', 'REPORT_CONNECT', 'REPORT_COMMIT_REVIEW_DECISION']);
  assert.equal(env.sent.at(-1).sessionCapabilityId, CAPABILITY);
});

test('uma falha que não é de autorização não é repetida', async () => {
  const env = environment({ responses: [{ ok: false, code: 'REPORT_OPERATION_FAILED' }] });
  const result = await env.context.sendAuthorizedRequest(capability => ({ type: 'REPORT_REQUEST_EXPORT', sessionCapabilityId: capability }));
  assert.deepEqual(result, { ok: false, code: 'REPORT_OPERATION_FAILED' });
  assert.deepEqual(env.sent.map(message => message.type), ['REPORT_CONNECT', 'REPORT_REQUEST_EXPORT']);
});

test('quando a página auditada some, a renovação mantém revisão e exportação e esconde o destaque', async () => {
  const env = environment({
    responses: [{ ok: true }],
    connect: { ok: true, auditId: 'audit-a', sessionCapabilityId: CAPABILITY, state: 'view-only' },
  });
  assert.equal(await env.context.renewReportSession(), true);
  assert.equal(env.context.reportSessionState, 'view-only');
  assert.equal(env.lay[0].hidden, true, '"Mostrar na página" deixa de ser oferecido');
  assert.equal(env.context.returnToPage.disabled, true);
});

test('uma renovação recusada deixa a ação com a resposta original', async () => {
  const env = environment({ responses: [{ ok: false, code: 'REPORT_EXPORT_DENIED' }], connect: { ok: false, code: 'REPORT_CONNECT_DENIED' } });
  const result = await env.context.sendAuthorizedRequest(capability => ({ type: 'REPORT_REQUEST_EXPORT', sessionCapabilityId: capability }));
  assert.deepEqual(result, { ok: false, code: 'REPORT_EXPORT_DENIED' });
});
