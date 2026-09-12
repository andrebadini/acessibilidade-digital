import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { collectPage } from '../../src/browser/collect-page.js';
import { normalizeSnapshot } from '../../src/core/normalize-snapshot.js';
import { runRules } from '../../src/core/rules/run-rules.js';
import { FORM_RULES } from '../../src/core/rules/forms.js';
import { launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer } from './support/real-chrome.mjs';

test('native form ownership and label control agree with passive normalized audit', { timeout: 60_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([['/', {
    status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: `<!doctype html><html lang="pt-BR"><title>Formulários</title>
    <label id="explicit" for="other">Outro<input id="nested"></label><input id="other">
    <label id="implicit">Nome<input id="first"><input id="second"></label>
    <form id="f1"><label><input id="a" type="checkbox" name="terms">Aceito os termos deste serviço</label></form>
    <form id="f2"><label><input id="b" type="checkbox" name="terms">Aceito os termos de outro serviço</label></form></html>`,
  }]]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/`, chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
  });
  const page = extension.startPage.page;
  const state = '({html:document.documentElement.outerHTML,focus:document.activeElement.id,scroll:[scrollX,scrollY]})';
  const before = await extension.evaluate(page, state);
  assert.deepEqual(await extension.evaluate(page, `[document.getElementById('explicit').control.id,document.getElementById('implicit').control.id,document.getElementById('a').form.id,document.getElementById('b').form.id]`), ['other', 'first', 'f1', 'f2']);
  const { frameTree } = await page.command('Page.getFrameTree', {});
  const raw = await collectPage(page, 1, { executeScript: async ({ func }) => [{
    frameId: frameTree.frame.id, result: await extension.evaluate(page, `(${func.toString()})()`),
  }] });
  const snapshot = normalizeSnapshot(raw);
  const results = await runRules(snapshot, {}, FORM_RULES.filter(rule => ['form-label-association', 'related-fields-grouping'].includes(rule.id)));
  const association = results.find(result => result.ruleId === 'form-label-association');
  assert.equal(association.outcome, 'failed');
  assert.deepEqual(association.targets.map(target => snapshot.nodes.find(node => node.nodeId === target.nodeId).attributes.id), ['nested', 'second']);
  assert.equal(results.find(result => result.ruleId === 'related-fields-grouping').outcome, 'inapplicable');
  assert.deepEqual(await extension.evaluate(page, state), before);
});
