import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { collectPage } from '../../src/browser/collect-page.js';
import { normalizeSnapshot } from '../../src/core/normalize-snapshot.js';
import { runRules } from '../../src/core/rules/run-rules.js';
import { FORM_RULES } from '../../src/core/rules/forms.js';
import { launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer } from './support/real-chrome.mjs';

test('observed required state reaches the ABNT 5.9.7 consumer without inventing visual identification', { timeout: 60_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([['/', {
    status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: `<!doctype html><html lang="pt-BR"><title>Obrigatoriedade</title>
    <label for="native-required">Nome completo *</label>
    <input id="native-required" required>
    <label for="native-optional">Apelido</label>
    <input id="native-optional">
    <input id="aria-required" aria-required="true">
    <div id="custom-required" role="textbox" contenteditable="true" aria-required="true" style="width:200px;height:40px;border:1px solid"></div></html>`,
  }]]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/`, chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
  });
  const page = extension.startPage.page;
  const { frameTree } = await page.command('Page.getFrameTree', {});
  const state = '({html:document.documentElement.outerHTML,focus:document.activeElement?.id??null,scroll:[scrollX,scrollY]})';
  const before = await extension.evaluate(page, state);
  const raw = await collectPage(page, 1, { executeScript: async ({ func }) => [{
    frameId: frameTree.frame.id, result: await extension.evaluate(page, `(${func.toString()})()`),
  }] });
  const snapshot = normalizeSnapshot(raw);
  const byId = id => snapshot.nodes.find(node => node.attributes?.id === id);

  // The collector observes native requiredness; the normalizer must not drop it.
  assert.equal(byId('native-required').required, true, 'native required state must survive normalization');
  assert.equal(byId('native-optional').required, false, 'native optional state must be observed as false');
  assert.equal(byId('aria-required').required, true, 'aria-required=true must be observed as required');
  assert.equal(byId('custom-required')?.required, undefined,
    'the native observation must not claim the ARIA declaration of a custom field');
  assert.equal(byId('native-required').form?.required, true, 'the nested form record stays consistent');

  // The declared marker is now observed, and observation is not perception: the collector reports
  // what the page declares next to the field, and the rule stays in review rather than converting a
  // declaration into proof that everyone can perceive it.
  assert.equal(byId('native-required').requiredIndicator, '*',
    'the declared marker next to the field must be observed');
  assert.equal(byId('native-optional').requiredIndicator, undefined,
    'an optional field declares no marker, and required=false already says so');
  assert.equal(byId('native-required').form?.requiredIndicator, undefined,
    'the marker belongs to the record, not to the nested native observation');
  assert.equal(byId('aria-required').requiredIndicator, '',
    'a required field with no associated label declares no marker');

  // With the declaration observed the rule decides instead of reporting missing data: the field
  // that declares a marker is not a finding, and the required field with no declared marker is a
  // confirmed failure — nothing declared means nothing anyone could perceive. The message still
  // speaks of identification rather than of a legal infraction.
  const result = (await runRules(snapshot, {}, FORM_RULES.filter(rule => rule.id === 'required-field-identification')))[0];
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(result.targets.map(target => target.selectorHint), ['#aria-required']);
  assert.equal(result.targets[0].data.reason, 'missing-required-identification');
  assert.doesNotMatch(result.summary, /infração|inconformidade ao item/iu);
  assert.deepEqual(await extension.evaluate(page, state), before);
});
