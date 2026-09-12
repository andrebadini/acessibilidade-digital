import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer } from './support/real-chrome.mjs';

test('Chrome distinguishes anchors from links and preserves roles inside editable content', { timeout: 60_000 }, async t => {
  const chromeBinary = resolveRealChromeTestBinary();
  assert.ok(chromeBinary, 'Chrome for Testing must be configured');
  const fixture = await startFixtureServer(t, new Map([['/', {
    status: 200, headers: { 'content-type': 'text/html' }, body: `<!doctype html><html lang="pt-BR"><title>Links</title><body>
      <a id="anchor">Seção</a><a id="native" href="/help">Ajuda</a>
      <a id="editable" href="/help" contenteditable="true">Ajuda editável</a>
      <div contenteditable="true"><a id="descendant" href="/help">Ajuda interna</a></div>
    </body></html>`,
  }]]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/`, chromeBinary, expectedMajor: 152,
  });
  const page = extension.startPage.page;
  const { root } = await page.command('DOM.getDocument', {});
  const ax = await page.command('Accessibility.getFullAXTree', {});
  const roles = {};
  for (const id of ['anchor', 'native', 'editable', 'descendant']) {
    const { nodeId } = await page.command('DOM.querySelector', { nodeId: root.nodeId, selector: `#${id}` });
    const { node } = await page.command('DOM.describeNode', { nodeId });
    roles[id] = ax.nodes.find(row=>row.backendDOMNodeId===node.backendNodeId)?.role?.value;
  }
  assert.ok(roles.anchor, 'the anchor must have an observed AX entry');
  assert.notEqual(roles.anchor, 'link');
  assert.equal(roles.native, 'link');
  assert.equal(roles.editable, 'link');
  assert.equal(roles.descendant, 'link');
});
