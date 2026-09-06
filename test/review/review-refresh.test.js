import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../../src/review/review.js', import.meta.url), 'utf8');
const saveSource = source.slice(source.indexOf('async function saveDecision('), source.indexOf('\nfunction renderCard('));
const refreshStart = source.indexOf('async function refreshCommittedReport(');
const refreshSource = refreshStart < 0 ? '' : source.slice(refreshStart, source.indexOf('\nasync function saveDecision('));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  const original = { auditId: 'audit-a' };
  const renders = [], builds = [], next = [], commits = [];
  const status = { textContent: '' };
  const context = {
    auditModel: original, reportSessionCapabilityId: 'S'.repeat(22), reportModelRevision: 1,
    reportBasis: { auditId: 'audit-a', inventory: { inventory: true }, checkpoint: { checkpoint: true } },
    evaluator: { value: 'Pessoa avaliadora' }, status,
    createReviewDecision: value => value,
    commitDecision: async () => commits.shift(),
    buildCompleteReportSummary: async args => { builds.push(args); return { summary: true }; },
    buildReportView: args => args,
    mountReportView: view => renders.push(view),
    nextUnanswered: card => next.push(card),
    sendWorkerRequest() {}, store: {},
  };
  const api = runInNewContext(`${refreshSource}\n${saveSource}\n({saveDecision, deleteModel(){auditModel=null;reportBasis=null;reportSessionCapabilityId=null},getModel(){return auditModel}})`, context);
  const card = () => ({ answered: false, querySelectorAll: () => [], removeAttribute() {},
    classList: { add() {} } });
  return { context, api, original, renders, builds, next, commits, status, card,
    save: (node = card()) => api.saveDecision({ itemId: '5.1.1', occurrenceId: 'occ-a', mode: 'manual' }, 'conforme', 'nota', node, {}) };
}

test('verified decision refreshes the canonical report with its exact revision and hash', async () => {
  const f = fixture();
  const model = { auditId: 'audit-a', reviewDecisions: ['confirmed'] };
  f.commits.push({ status: 'committed', model, modelRevision: 2, modelHash: 'a'.repeat(64) });
  await f.save();
  assert.equal(f.renders.length, 1);
  assert.equal(f.renders[0].model, model);
  assert.equal(f.renders[0].modelRevision, 2);
  assert.equal(f.renders[0].modelHash, 'a'.repeat(64));
  assert.equal(f.builds[0].executionCheckpoint, f.context.reportBasis.checkpoint);
  assert.equal(f.builds[0].inventory, f.context.reportBasis.inventory);
  assert.equal(f.next.length, 1);
  assert.match(f.status.textContent, /salva.*atualizad/iu);
});

test('refresh failure never turns a confirmed decision into a reported save failure', async () => {
  const f = fixture(), card = f.card(); let answered = false;
  card.classList.add = name => { answered = name === 'answered'; };
  const model = { auditId: 'audit-a' };
  f.commits.push({ status: 'committed', model, modelRevision: 2, modelHash: 'a'.repeat(64) });
  f.context.buildCompleteReportSummary = async () => { throw Error('PRIVATE_ERROR'); };
  await f.save(card);
  assert.equal(answered, true);
  assert.equal(f.api.getModel(), model);
  assert.equal(f.next[0], card);
  assert.equal(f.renders.length, 0);
  assert.match(f.status.textContent, /salva.*não foi possível atualizar/iu);
  assert.doesNotMatch(f.status.textContent, /PRIVATE_ERROR/u);
});

test('an older refresh cannot replace a newer completed decision or its status', async () => {
  const f = fixture(), pending = deferred();
  const older = { auditId: 'audit-a', revision: 2 }, newer = { auditId: 'audit-a', revision: 3 };
  f.commits.push({ status: 'committed', model: older, modelRevision: 2, modelHash: 'a'.repeat(64) },
    { status: 'committed', model: newer, modelRevision: 3, modelHash: 'b'.repeat(64) });
  f.context.buildCompleteReportSummary = ({ model }) => model === older ? pending.promise : Promise.resolve({});
  const first = f.save(); await Promise.resolve(); await Promise.resolve();
  await f.save(); const message = f.status.textContent;
  pending.resolve({}); await first;
  assert.equal(f.renders.length, 1);
  assert.equal(f.renders[0].model, newer);
  assert.equal(f.api.getModel(), newer);
  assert.equal(f.status.textContent, message);
});

test('deletion wins during a commit and during a pending display refresh', async () => {
  for (const phase of ['commit', 'refresh']) {
    const f = fixture(), pending = deferred();
    const committed = { status: 'committed', model: { auditId: 'audit-a' }, modelRevision: 2, modelHash: 'a'.repeat(64) };
    if (phase === 'commit') f.context.commitDecision = () => pending.promise;
    else { f.commits.push(committed); f.context.buildCompleteReportSummary = () => pending.promise; }
    const saving = f.save(); await Promise.resolve(); await Promise.resolve();
    f.api.deleteModel(); f.status.textContent = 'Auditoria excluída';
    pending.resolve(phase === 'commit' ? committed : {}); await saving;
    assert.equal(f.api.getModel(), null, phase);
    assert.equal(f.renders.length, 0, phase);
    assert.equal(f.status.textContent, 'Auditoria excluída', phase);
  }
});

test('duplicate and rejected commits never refresh or mark the card answered', async () => {
  const f = fixture(); f.commits.push({ status: 'duplicate', model: f.original });
  await f.save();
  f.context.commitDecision = async () => { throw Error('COMMIT_DENIED'); };
  await assert.rejects(f.save(), /COMMIT_DENIED/);
  assert.equal(f.renders.length, 0);
  assert.equal(f.next.length, 0);
  assert.equal(f.api.getModel(), f.original);
});
