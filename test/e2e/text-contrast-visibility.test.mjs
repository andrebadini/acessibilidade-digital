import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { collectPage } from '../../src/browser/collect-page.js';
import { normalizeSnapshot } from '../../src/core/normalize-snapshot.js';
import { runRules } from '../../src/core/rules/run-rules.js';
import { VISUAL_RULES } from '../../src/core/rules/visual.js';
import { launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer } from './support/real-chrome.mjs';

test('visible low-contrast text remains measurable when excluded from AX, but private editable content stays redacted', { timeout: 60_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([['/', {
    status: 200, headers: { 'content-type': 'text/html' }, body: `<!doctype html><html lang="pt-BR"><title>Contraste</title>
    <style>p{color:#bbb;background:#fff;font:20px Arial}</style><body>
    <p id="instructions" aria-hidden="true">Instruções importantes para preencher o formulário.</p>
    </body></html>`,
  }]]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/`, chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
  });
  const page = extension.startPage.page;
  const { frameTree } = await page.command('Page.getFrameTree', {});
  const collect = async () => normalizeSnapshot(await collectPage(page, 1, { executeScript: async ({ func }) => [{
    frameId: frameTree.frame.id, result: await extension.evaluate(page, `(${func.toString()})()`),
  }] }));
  const rule = VISUAL_RULES.find(item => item.id === 'text-contrast-minimum');
  const before = await extension.evaluate(page, 'document.documentElement.outerHTML');
  let snapshot = await collect();
  const paragraph = snapshot.nodes.find(node => node.attributes?.id === 'instructions');
  assert.equal(paragraph.hidden, true, 'semantic exclusion must remain intact');
  const value = (await runRules(snapshot, {}, [rule]))[0];
  assert.equal(value.outcome, 'failed');
  assert.deepEqual(value.targets.map(target => target.nodeId), [paragraph.nodeId]);
  assert.ok(value.targets[0].data.ratio < 4.5);
  assert.equal(await extension.evaluate(page, 'document.documentElement.outerHTML'), before);

  await extension.evaluate(page, `(() => {const p=document.getElementById('instructions');p.contentEditable='true';p.textContent='PRIVATE-EDITABLE-SENTINEL';return true;})()`);
  snapshot = await collect();
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE-EDITABLE-SENTINEL/u);
  assert.notEqual((await runRules(snapshot, {}, [rule]))[0].outcome, 'failed');
});
