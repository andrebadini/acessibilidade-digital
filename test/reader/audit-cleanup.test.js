import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

const module = await import('../../src/reader/audit-cleanup.js').catch(() => ({}));
const KEY = 'audita.reading-active.7';
const INSPECTOR = Symbol.for('audita.tab-reading.inspector.v1');
const target = { tabId: 7, documentId: 'document-a' };

function fixture({ active = true, documentId = 'document-a', sessionId = 'session-a', liveSession = sessionId } = {}) {
  const records = active ? { [KEY]: { documentId, sessionId, expiresAt: 1 } } : {};
  const world = {}; const refs = new Map([['element', {}]]); const scripts = []; let removed = 0;
  world[INSPECTOR] = { sessionId: liveSession, dispose() { refs.clear(); delete world[INSPECTOR]; } };
  const api = {
    storage: { session: {
      async get(key) { return Object.hasOwn(records, key) ? { [key]: structuredClone(records[key]) } : {}; },
      async remove(key) { removed++; delete records[key]; },
    } },
    scripting: { async executeScript(input) {
      scripts.push(input);
      assert.deepEqual(input.target, { tabId: 7, documentIds: ['document-a'] });
      assert.equal(input.world, 'ISOLATED');
      const context = vm.createContext(world);
      context.args = input.args;
      const result = vm.runInContext(`(${input.func.toString()})(...args)`, context);
      return [{ frameId: 0, documentId: 'document-a', result }];
    } },
  };
  assert.equal(typeof module.createReadingAuditCleaner, 'function');
  return { records, world, refs, scripts, api, cleaner: module.createReadingAuditCleaner({ chromeApi: api }), get removed() { return removed; } };
}

test('audit cleanup disposes live element references and revokes even an expired matching session', async () => {
  const env = fixture();
  assert.deepEqual(await env.cleaner.clearForTarget(target), { ok: true, state: 'revoked' });
  assert.equal(env.refs.size, 0);
  assert.equal(env.world[INSPECTOR], undefined);
  assert.equal(env.records[KEY], undefined);
  assert.equal(env.scripts.length, 1);
});

test('absence and another document never inject or delete an unrelated session', async () => {
  for (const options of [{ active: false }, { documentId: 'other-document' }]) {
    const env = fixture(options);
    const before = structuredClone(env.records);
    assert.deepEqual(await env.cleaner.clearForTarget(target), { ok: true, state: 'absent' });
    assert.deepEqual(env.records, before);
    assert.equal(env.scripts.length, 0);
    assert.equal(env.removed, 0);
  }
});

test('wrong live session, unconfirmed disposal and failed registry removal block audit admission', async t => {
  const cases = [
    ['wrong live session', env => { env.world[INSPECTOR].sessionId = 'other-session'; }],
    ['dispose does not clear', env => { env.world[INSPECTOR].dispose = () => {}; }],
    ['script fails', env => { env.api.scripting.executeScript = async () => { throw new Error('unavailable'); }; }],
    ['different document response', env => { env.api.scripting.executeScript = async () => [{ documentId: 'other', result: { ok: true, state: 'clear' } }]; }],
    ['remove is not durable', env => { env.api.storage.session.remove = async () => {}; }],
  ];
  for (const [name, alter] of cases) await t.test(name, async () => {
    const env = fixture(); alter(env);
    assert.equal((await env.cleaner.clearForTarget(target)).ok, false);
    assert.ok(env.records[KEY], 'a record whose revocation is unconfirmed must remain for retry');
  });
});

test('missing in-page state is still revoked and malformed registries fail closed', async () => {
  const absent = fixture(); delete absent.world[INSPECTOR];
  assert.deepEqual(await absent.cleaner.clearForTarget(target), { ok: true, state: 'revoked' });
  const malformed = fixture(); malformed.records[KEY].documentId = '';
  assert.equal((await malformed.cleaner.clearForTarget(target)).ok, false);
  assert.equal(malformed.scripts.length, 0);
});

test('another document replacing the tab slot is preserved instead of deleted after script cleanup', async () => {
  const env = fixture();
  const execute = env.api.scripting.executeScript;
  env.api.scripting.executeScript = async input => {
    const result = await execute(input);
    env.records[KEY] = { documentId: 'document-b', sessionId: 'session-b', expiresAt: 1000 };
    return result;
  };
  assert.equal((await env.cleaner.clearForTarget(target)).ok, false);
  assert.equal(env.records[KEY].sessionId, 'session-b');
  assert.equal(env.removed, 0);
});
