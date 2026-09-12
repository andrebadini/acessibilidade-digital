import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { collectPage } from '../../src/browser/collect-page.js';
import { normalizeSnapshot } from '../../src/core/normalize-snapshot.js';
import { runRules } from '../../src/core/rules/run-rules.js';
import { VISUAL_RULES } from '../../src/core/rules/visual.js';
import { launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer } from './support/real-chrome.mjs';

test('Chrome alignment observations preserve inherited language and identify only the misaligned paragraph', { timeout: 60_000 }, async t => {
  const chromeBinary = resolveRealChromeTestBinary();
  assert.ok(chromeBinary, 'Chrome for Testing must be configured');
  const fixture = await startFixtureServer(t, new Map([['/', {
    status: 200, headers: { 'content-type': 'text/html' }, body: `<!doctype html><html lang="pt-BR"><title>Alinhamento</title>
    <style>body{margin:20px}p{max-width:400px}</style><body>
    <p id="portuguese">Texto alinhado ao início da leitura em português.</p>
    <section lang="ar" dir="rtl"><p id="arabic">هذا نص باللغة العربية</p></section>
    <div style="text-align:center"><p id="centered" aria-hidden="true">Este parágrafo está centralizado.</p></div>
    </body></html>`,
  }]]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/`, chromeBinary, expectedMajor: 152,
  });
  const page = extension.startPage.page;
  const state = '({html:document.documentElement.outerHTML,focus:document.activeElement.id,scroll:[scrollX,scrollY],viewport:[innerWidth,innerHeight]})';
  const before = await extension.evaluate(page, state);
  const { frameTree } = await page.command('Page.getFrameTree', {});
  const raw = await collectPage(page, 1, { executeScript: async ({ func }) => [{
    frameId: frameTree.frame.id, result: await extension.evaluate(page, `(${func.toString()})()`),
  }] });
  const snapshot = normalizeSnapshot(raw);
  const paragraph = id => snapshot.nodes.find(node => node.attributes?.id === id);
  assert.equal(paragraph('arabic').styles.direction, 'rtl');
  assert.equal(paragraph('portuguese').styles.direction, 'ltr');
  const rule = VISUAL_RULES.find(item => item.id === 'text-block-alignment');
  const result = (await runRules(snapshot, {}, [rule]))[0];
  assert.equal(result.outcome, 'cantTell');
  assert.deepEqual(result.targets.map(target => target.nodeId), [paragraph('centered').nodeId]);
  assert.deepEqual(await extension.evaluate(page, state), before);
});
