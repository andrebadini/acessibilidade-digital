import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { collectPage } from '../../src/browser/collect-page.js';
import { normalizeSnapshot } from '../../src/core/normalize-snapshot.js';
import { runRules } from '../../src/core/rules/run-rules.js';
import { VISUAL_RULES } from '../../src/core/rules/visual.js';
import { launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer } from './support/real-chrome.mjs';

test('passive text width counts complete rendered lines but never private or unsupported blocks', { timeout: 60_000 }, async t => {
  const chromeBinary = resolveRealChromeTestBinary();
  assert.ok(chromeBinary, 'Chrome for Testing must be configured');
  const fixture = await startFixtureServer(t, new Map([['/', {
    status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: `<!doctype html><html lang="pt-BR"><title>Largura</title>
    <style>p{font:16px monospace;white-space:pre;overflow:visible}#wrap{width:10ch;white-space:normal;word-break:break-all}</style><body>
    <p id="short">12345</p><p id="lines">1234567890\n1234</p>
    <p id="wrap">12345678901234567890123</p>
    <p id="collapsedLf" style="white-space:normal;width:200ch">${'a'.repeat(40)}\n${'b'.repeat(40)}</p>
    <p id="collapsedCrlf" style="white-space:normal;width:200ch">${'a'.repeat(40)}\r\n${'b'.repeat(40)}</p>
    <p id="accent">áb́ć</p><p id="hiddenAx" aria-hidden="true">${'a'.repeat(81)}</p>
    <p id="complex">Uma <strong>palavra</strong></p>
    <p id="private" contenteditable>PRIVATE-WIDTH-SENTINEL</p>
    <div contenteditable><p id="privateChild">PRIVATE-CHILD-SENTINEL</p></div>
    <p id="long">${'a'.repeat(2049)}</p>
    <p id="transformed" style="transform:rotate(5deg)">12345</p>
    <p id="invisible" style="display:none">12345</p>
    </body></html>`,
  }]]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/`, chromeBinary, expectedMajor: 152,
  });
  const page = extension.startPage.page;
  // HTML parsing normalizes CRLF to LF; restore a literal CRLF before taking the baseline.
  await extension.evaluate(page, `(() => { document.getElementById('collapsedCrlf').firstChild.data = 'a'.repeat(40) + '\\r\\n' + 'b'.repeat(40); return true; })()`);
  const state = '({html:document.documentElement.outerHTML,focus:document.activeElement.id,selection:getSelection().toString(),scroll:[scrollX,scrollY],viewport:[innerWidth,innerHeight]})';
  const before = await extension.evaluate(page, state);
  const { frameTree } = await page.command('Page.getFrameTree', {});
  const raw = await collectPage(page, 1, { executeScript: async ({ func }) => [{
    frameId: frameTree.frame.id, result: await extension.evaluate(page, `(${func.toString()})()`),
  }] });
  const snapshot = normalizeSnapshot(raw);
  const paragraph = id => snapshot.nodes.find(node => node.attributes?.id === id);
  for (const [id, count] of [['short', 5], ['lines', 10], ['wrap', 10], ['accent', 3], ['hiddenAx', 81], ['collapsedLf', 81], ['collapsedCrlf', 81]]) {
    assert.equal(paragraph(id).charactersPerLine, count, id);
  }
  for (const id of ['complex', 'long', 'transformed', 'invisible']) {
    assert.equal(paragraph(id).charactersPerLine, undefined, id);
  }
  for (const node of snapshot.nodes.filter(node => !node.text && !node.visibleText)) {
    assert.equal(node.charactersPerLine, undefined, 'empty or redacted text');
  }
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE-WIDTH-SENTINEL'));
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE-CHILD-SENTINEL'));
  const rule = VISUAL_RULES.find(item => item.id === 'text-block-width');
  const result = (await runRules(snapshot, {}, [rule]))[0];
  assert.equal(result.outcome, 'cantTell');
  assert.deepEqual(result.targets.map(target => target.nodeId), ['collapsedLf', 'collapsedCrlf', 'hiddenAx'].map(id => paragraph(id).nodeId));
  assert.deepEqual(await extension.evaluate(page, state), before);
});
