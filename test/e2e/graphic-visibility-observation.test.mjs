import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { collectPage } from '../../src/browser/collect-page.js';
import { normalizeSnapshot } from '../../src/core/normalize-snapshot.js';
import { runRules } from '../../src/core/rules/run-rules.js';
import { VISUAL_RULES } from '../../src/core/rules/visual.js';
import { launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer } from './support/real-chrome.mjs';

test('visual graphic applicability does not confuse aria-hidden with absent rendered content', { timeout: 60_000 }, async t => {
  const chromeBinary = resolveRealChromeTestBinary();
  assert.ok(chromeBinary);
  const fixture = await startFixtureServer(t, new Map([['/', {
    status: 200, headers: { 'content-type': 'text/html' }, body: `<!doctype html><html lang="pt-BR"><title>Gráfico</title><body>
    <div id="wrapper" aria-hidden="true"><svg id="chart" width="100" height="100"><rect width="90" height="90" fill="gray"/></svg></div>
    </body></html>`,
  }]]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/`, chromeBinary, expectedMajor: 152,
  });
  const page = extension.startPage.page;
  const { frameTree } = await page.command('Page.getFrameTree', {});
  const rule = VISUAL_RULES.find(item => item.id === 'graphic-object-contrast');
  const state = '({html:document.documentElement.outerHTML,focus:document.activeElement.id,scroll:[scrollX,scrollY]})';
  for (const [style, expected] of [['', 'cantTell'], ['display:none', 'inapplicable'], ['opacity:0', 'inapplicable']]) {
    await extension.evaluate(page, `document.getElementById('wrapper').style.cssText=${JSON.stringify(style)}`);
    const before = await extension.evaluate(page, state);
    const raw = await collectPage(page, 1, { executeScript: async ({ func }) => [{
      frameId: frameTree.frame.id, result: await extension.evaluate(page, `(${func.toString()})()`),
    }] });
    const snapshot = normalizeSnapshot(raw);
    const result = (await runRules(snapshot, {}, [rule]))[0];
    assert.equal(result.outcome, expected, style || 'visible but aria-hidden');
    assert.deepEqual(result.targets, []);
    assert.deepEqual(await extension.evaluate(page, state), before);
  }
});
