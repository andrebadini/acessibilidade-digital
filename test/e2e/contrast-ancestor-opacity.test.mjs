import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { collectPage } from '../../src/browser/collect-page.js';
import { normalizeSnapshot } from '../../src/core/normalize-snapshot.js';
import { runRules } from '../../src/core/rules/run-rules.js';
import { VISUAL_RULES } from '../../src/core/rules/visual.js';
import { launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer } from './support/real-chrome.mjs';

test('opaque local backgrounds cannot hide ancestor opacity from contrast reliability', { timeout: 60_000 }, async t => {
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
  const rule = VISUAL_RULES.find(item => item.id === 'text-contrast-minimum');
  for (const [opacity, expected, reliable] of [['.1', 'cantTell', false], ['1', 'passed', true]]) {
    await extension.evaluate(page, `document.getElementById('wrapper').style.opacity=${JSON.stringify(opacity)}`);
    const before = await extension.evaluate(page, 'document.documentElement.outerHTML');
    const raw = await collectPage(page, 1, { executeScript: async ({ func }) => [{
      frameId: frameTree.frame.id, result: await extension.evaluate(page, `(${func.toString()})()`),
    }] });
    const snapshot = normalizeSnapshot(raw);
    const message = snapshot.nodes.find(node => node.attributes?.id === 'message');
    assert.equal(message.contrast.reliable, reliable, opacity);
    assert.equal((await runRules(snapshot, {}, [rule]))[0].outcome, expected);
    assert.equal(await extension.evaluate(page, 'document.documentElement.outerHTML'), before);
  }
});
