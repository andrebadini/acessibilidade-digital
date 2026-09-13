import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { collectPage } from '../../src/browser/collect-page.js';
import { normalizeSnapshot } from '../../src/core/normalize-snapshot.js';
import { runRules } from '../../src/core/rules/run-rules.js';
import { FORM_RULES } from '../../src/core/rules/forms.js';
import { launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer } from './support/real-chrome.mjs';

test('observed autocomplete purpose reaches the ABNT 5.9.8 consumer without inferring personal data', { timeout: 60_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([['/', {
    status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: `<!doctype html><html lang="pt-BR"><title>Finalidade</title>
    <input id="declared" type="email" autocomplete="email">
    <input id="sectioned" type="text" autocomplete="shipping street-address">
    <input id="bare" type="text" autocomplete="name">
    <input id="missing" type="email">
    <input id="garbage" type="text" autocomplete="not-a-token">
    <input id="settled" type="text" name="nick" autocomplete="nickname"></html>`,
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

  // The only evidence of a purpose is the declaration the page itself exposes. It is
  // never derived from the field name, the input type or a guess about personal data,
  // and a password declaration never becomes observed purpose data.
  assert.deepEqual(byId('declared').attributes.autocomplete, 'email');
  assert.equal(snapshot.nodes.some(node => Object.hasOwn(node, 'inputPurpose')), false,
    'no purpose may be inventoried as observed runtime data');

  const result = (await runRules(snapshot, {}, FORM_RULES.filter(rule => rule.id === 'input-purpose')))[0];
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(
    result.targets.map(target => snapshot.nodes.find(node => node.nodeId === target.nodeId).attributes.id),
    ['garbage'],
    'only the field whose observed declaration contradicts its purpose may fail');
  assert.deepEqual(result.targets.map(target => target.data.reason), ['invalid-or-missing-autocomplete']);
  assert.deepEqual(await extension.evaluate(page, state), before);
});
