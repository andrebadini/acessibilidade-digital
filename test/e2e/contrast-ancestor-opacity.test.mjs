import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { collectPage } from '../../src/browser/collect-page.js';
import { normalizeSnapshot } from '../../src/core/normalize-snapshot.js';
import { runRules } from '../../src/core/rules/run-rules.js';
import { VISUAL_RULES } from '../../src/core/rules/visual.js';
import { launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer } from './support/real-chrome.mjs';

test('opaque local backgrounds cannot hide ancestor compositing from contrast reliability', { timeout: 60_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([['/', {
    status: 200, headers: { 'content-type': 'text/html' }, body: `<!doctype html><html lang="pt-BR"><title>Composição</title>
    <style>body{background:white}#wrapper{opacity:.1}p{color:black;background:white;font:20px Arial}</style><body>
    <div id="wrapper"><p id="message">Informação importante</p></div></body></html>`,
  }]]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/`, chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
  });
  const page = extension.startPage.page;
  const { frameTree } = await page.command('Page.getFrameTree', {});
  const rules = VISUAL_RULES.filter(item => ['text-contrast-minimum', 'text-contrast-enhanced'].includes(item.id));
  const state = '({html:document.documentElement.outerHTML,focus:document.activeElement.id,scroll:[scrollX,scrollY],viewport:[innerWidth,innerHeight]})';
  for (const [opacity, filter, ownFilter, expected, reliable] of [
    ['.1', 'none', 'none', 'cantTell', false], ['1', 'none', 'none', 'passed', true],
    ['1', 'brightness(0)', 'none', 'cantTell', false], ['1', 'none', 'brightness(0)', 'cantTell', false],
    ['1', 'none', 'none', 'passed', true],
  ]) {
    await extension.evaluate(page, `document.getElementById('wrapper').style.opacity=${JSON.stringify(opacity)}`);
    await extension.evaluate(page, `document.getElementById('wrapper').style.filter=${JSON.stringify(filter)}`);
    await extension.evaluate(page, `document.getElementById('message').style.filter=${JSON.stringify(ownFilter)}`);
    const before = await extension.evaluate(page, state);
    const raw = await collectPage(page, 1, { executeScript: async ({ func }) => [{
      frameId: frameTree.frame.id, result: await extension.evaluate(page, `(${func.toString()})()`),
    }] });
    const snapshot = normalizeSnapshot(raw);
    const message = snapshot.nodes.find(node => node.attributes?.id === 'message');
    assert.equal(message.contrast.reliable, reliable, `${opacity}/${filter}`);
    for (const result of await runRules(snapshot, {}, rules)) {
      assert.equal(result.outcome, expected);
      assert.deepEqual(result.targets, []);
    }
    assert.deepEqual(await extension.evaluate(page, state), before);
  }
});
