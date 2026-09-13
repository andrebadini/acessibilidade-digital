import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { collectPage } from '../../src/browser/collect-page.js';
import { normalizeSnapshot } from '../../src/core/normalize-snapshot.js';
import { runRules } from '../../src/core/rules/run-rules.js';
import { FORM_RULES } from '../../src/core/rules/forms.js';
import { launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer } from './support/real-chrome.mjs';

test('visual field identification stays separate from names and includes a custom editable field', { timeout: 60_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([['/', {
    status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: `<!doctype html><html lang="pt-BR"><title>Rótulos</title>
    <label id="clipped" for="name" style="position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden">Nome</label><input id="name">
    <input aria-label="Pesquisar"><label for="ordinary">Nome completo</label><input id="ordinary"></html>`,
  }]]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/`, chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
  });
  const page = extension.startPage.page;
  const { frameTree } = await page.command('Page.getFrameTree', {});
  const rule = FORM_RULES.find(item => item.id === 'form-field-label');
  const state = '({html:document.documentElement.outerHTML,focus:document.activeElement.id,scroll:[scrollX,scrollY]})';
  for (const custom of [false, true]) {
    if (custom) await extension.evaluate(page, `(() => {document.body.innerHTML='<div role="textbox" contenteditable="true" style="width:200px;height:40px;border:1px solid"></div>';return true})()`);
    const before = await extension.evaluate(page, state);
    const raw = await collectPage(page, 1, { executeScript: async ({ func }) => [{
      frameId: frameTree.frame.id, result: await extension.evaluate(page, `(${func.toString()})()`),
    }] });
    const snapshot = normalizeSnapshot(raw);
    if (!custom) {
      const label = snapshot.nodes.find(node => node.attributes?.id === 'clipped');
      assert.equal(label.hasRenderedBox, true, 'a box does not prove unclipped text');
      assert.equal(label.visibleText, 'Nome');
    }
    const result = (await runRules(snapshot, {}, [rule]))[0];
    assert.equal(result.outcome, 'cantTell');
    assert.deepEqual(result.targets, []);
    assert.deepEqual(await extension.evaluate(page, state), before);
  }
});
