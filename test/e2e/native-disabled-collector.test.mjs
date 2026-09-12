import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { collectRuntimePageData } from '../../src/collector/page-collector.js';
import { launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer } from './support/real-chrome.mjs';

test('native disabled observation preserves fieldset and first legend semantics', { timeout: 60_000 }, async t => {
  const chromeBinary = resolveRealChromeTestBinary();
  assert.ok(chromeBinary, 'Chrome for Testing must be configured');
  const fixture = await startFixtureServer(t, new Map([['/', {
    status: 200, headers: { 'content-type': 'text/html' }, body: `<!doctype html><html lang="pt-BR"><title>Controles</title><body>
      <fieldset disabled><legend><button id="legend-active">Ajuda</button></legend>
        <button id="inherited">Salvar</button><input id="inherited-input">
      </fieldset><button id="own" disabled="false">Enviar</button>
      <button id="active">Continuar</button><div id="custom" role="button" tabindex="0" aria-disabled="true">Customizado</div>
    </body></html>`,
  }]]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))), startUrl: `${fixture.origin}/`,
    chromeBinary, expectedMajor: 152,
  });
  const states = await extension.evaluate(extension.startPage.page, `(() => {
    const observed=(${collectRuntimePageData.toString()})();
    return Object.fromEntries(observed.nodes.filter(node=>node.selectorHint.startsWith('#')).map(node=>
      [node.selectorHint,{disabled:node.disabled??null,focusable:node.focusable}]));
  })()`);
  assert.deepEqual(states['#legend-active'], { disabled: false, focusable: true });
  assert.deepEqual(states['#inherited'], { disabled: true, focusable: false });
  assert.deepEqual(states['#inherited-input'], { disabled: true, focusable: false });
  assert.deepEqual(states['#own'], { disabled: true, focusable: false });
  assert.deepEqual(states['#active'], { disabled: false, focusable: true });
  assert.deepEqual(states['#custom'], { disabled: null, focusable: true });
});
