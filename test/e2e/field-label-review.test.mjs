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
    if (custom) await extension.evaluate(page, `(() => {document.body.innerHTML='<label id="ce-label" for="ce-field">Anotações do atendimento</label><div id="ce-field" role="textbox" contenteditable="true" aria-labelledby="ce-label" style="width:200px;height:40px;border:1px solid">texto que o usuário digitou</div>';return true})()`);
    const before = await extension.evaluate(page, state);
    const raw = await collectPage(page, 1, { executeScript: async ({ func }) => [{
      frameId: frameTree.frame.id, result: await extension.evaluate(page, `(${func.toString()})()`),
    }] });
    const snapshot = normalizeSnapshot(raw);
    if (!custom) {
      const label = snapshot.nodes.find(node => node.attributes?.id === 'clipped');
      assert.equal(label.hasRenderedBox, true, 'a box does not prove unclipped text');
      assert.equal(label.visibleText, 'Nome');
    } else {
      // The custom field used to arrive anonymous, so nothing could judge it. It now carries the
      // identity its author declared and still carries none of what the user typed.
      const field = snapshot.nodes.find(node => node.attributes?.id === 'ce-field');
      assert.ok(field, `the custom field must keep its author-declared id: ${JSON.stringify(snapshot.nodes.map(node => node.attributes?.id ?? null))}`);
      assert.equal(field.attributes.role, 'textbox');
      assert.equal(field.attributes['aria-labelledby'], 'ce-label');
      assert.equal(field.valueStatus, 'omitted-privacy');
      assert.equal(field.text, '');
      assert.equal(field.visibleText, '');
      assert.equal(Object.hasOwn(field, 'accessibleName'), false,
        'a name that may come from contents must stay redacted');
      assert.equal(snapshot.nodes.some(node => node.attributes?.id === 'ce-label'), true,
        'the label the field points at must be present for the reference to resolve');
      assert.doesNotMatch(JSON.stringify(snapshot), /texto que o usuário digitou/u);
    }
    const result = (await runRules(snapshot, {}, [rule]))[0];
    // O recorte do rótulo é observável, então vira alvo por campo; a conclusão continua em
    // revisão, porque a norma admite propósito visualmente evidente e recorte não prova
    // ausência de percepção.
    assert.equal(result.outcome, 'cantTell');
    if (!custom) {
      assert.equal(result.targets.length, 1, JSON.stringify(result.targets));
      assert.equal(result.targets[0].data.reason, 'clipped-label');
      assert.equal(result.targets[0].selectorHint, '#name');
    } else {
      assert.deepEqual(result.targets, [], 'a custom field with a visible label reference is not clipped');
    }
    assert.deepEqual(await extension.evaluate(page, state), before);
  }
});
