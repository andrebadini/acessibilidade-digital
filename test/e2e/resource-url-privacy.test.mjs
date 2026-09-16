import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { collectPage } from '../../src/browser/collect-page.js';
import { normalizeSnapshot } from '../../src/core/normalize-snapshot.js';
import { launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer, evaluate } from './support/real-chrome.mjs';

// A page can reflect typed input into a resource URL, and the collector used to keep every query
// parameter whose name did not look like an English credential word. Measured before the fix:
// ?q=<a CPF> and ?nome=Maria&email=<address> both reached the model intact and were rendered in the
// exported report as "URL da mídia". The evidence URL already dropped the query structurally; the
// resource URL now does the same, so the guarantee no longer depends on a vocabulary list.
const DOCUMENT = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>URL de recurso</title></head>
<body><main><h1>URL de recurso</h1>
<img id="plain" src="/foto.png" alt="Foto">
<img id="reflected" src="/foto.png?q=MEU-CPF-123.456.789-00" alt="Foto com consulta">
<img id="personal" src="/foto.png?nome=Maria&email=maria@exemplo.test" alt="Foto com dados">
<img id="fragment" src="/foto.png#secao-privada" alt="Foto com fragmento">
<img id="credential" src="/foto.png?token=NAO-PODE-VAZAR" alt="Foto com credencial">
</main></body></html>`;

test('a resource URL keeps its origin and path and never its query or fragment', { timeout: 60_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([
    ['/recursos', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: DOCUMENT }],
  ]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/recursos`, chromeBinary: resolveRealChromeTestBinary(),
    viewport: { width: 1280, height: 900 }, expectedMajor: 152,
  });
  try {
    const page = extension.startPage.page;
    const state = `({html:document.documentElement.outerHTML,focus:document.activeElement.id,scroll:[scrollX,scrollY]})`;
    const before = await evaluate(page, state);
    const { frameTree } = await page.command('Page.getFrameTree', {});
    const collected = await collectPage(page, 1, { executeScript: async ({ func }) => [{
      frameId: frameTree.frame.id, result: await evaluate(page, `(${func.toString()})()`),
    }] });
    const snapshot = normalizeSnapshot(collected);
    const sourceOf = id => snapshot.nodes.find(node => node.attributes?.id === id)?.media?.currentSrc ?? null;

    // The path survives, because it is what identifies the resource.
    for (const id of ['plain', 'reflected', 'personal', 'fragment', 'credential']) {
      assert.equal(sourceOf(id), `${fixture.origin}/foto.png`, `resource URL for ${id}`);
    }
    // The media record, which is what the report renders as "URL da mídia", is clean.
    assert.equal(JSON.stringify(snapshot.nodes.map(node => node.media ?? null)).includes('MEU-CPF'), false);

    // The credential-shaped parameter was already removed by the name filter, and it still is.
    assert.equal(JSON.stringify(snapshot.nodes.map(node => node.media ?? null)).includes('NAO-PODE-VAZAR'), false);

    // Remaining gap, recorded in docs/qa/2026-09-13-continuity-and-e2e-triage.md and asserted here
    // so it cannot be forgotten: the raw URL attributes keep non-sensitive query parameters,
    // because sanitizeResourceUrl preserves them for navigation links. The collector's cleanUrl
    // drops the query for the media record, so the leak is bounded to the attribute value in the
    // snapshot; closing it means changing the URL contract for href as well, which is a decision
    // with its own blast radius and has not been taken.
    const rawAttribute = snapshot.nodes.find(node => node.attributes?.id === 'reflected')?.attributes?.src ?? '';
    assert.equal(rawAttribute.includes('?q='), true,
      'documented open gap: the raw src attribute still carries a non-sensitive query parameter');
    // Collecting must not touch the page.
    assert.deepEqual(await evaluate(page, state), before);
    assert.deepEqual(await evaluate(page, `location.search`), '', 'the audit must not navigate the page');
    t.diagnostic(`resource URLs reduced to origin and path; query, fragment and credentials absent`);
  } finally {
    await extension.close();
  }
});
