import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeProbes } from '../../src/core/normalize-probes.js';
import { launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer } from './support/real-chrome.mjs';

test('native focus traversal does not certify indicator area or occlusion from component bounds and static styles', { timeout: 60_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([['/focus', {
    status: 200, headers: { 'content-type': 'text/html' },
    body: '<!doctype html><html lang="pt-BR"><style>button,button:focus{position:absolute;left:20px;top:20px;width:80px;height:40px;outline:2px solid blue;box-shadow:0 0 2px blue}aside{position:absolute;left:0;top:0;width:200px;height:100px;background:white;z-index:2}</style><body><button>A</button><aside></aside></body></html>'
  }]]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/focus`, chromeBinary: resolveRealChromeTestBinary(),
    viewport: { width: 1280, height: 900 }, expectedMajor: 152,
  });
  await extension.startPage.page.command('Page.bringToFront');
  await extension.browser.command('Target.detachFromTarget', { sessionId: extension.startPage.page.sessionId });
  const raw = await extension.evaluate(extension.harnessPage, `(async()=>{
    const module=await import(chrome.runtime.getURL('/src/background/chrome-adapter.js'));
    const adapter=module.createChromeAdapter(module.createChromeAuditAuthority(chrome));
    const cdp=await adapter.connectCdp(${extension.startPage.tabId});
    try{return await adapter.runDynamicProbes(${extension.startPage.tabId},cdp)}
    finally{await cdp.disconnect()}
  })()`, { awaitPromise: true });
  assert.equal(raw.focus.completed, true);
  assert.ok(raw.focus.events.some(event => event.nodeId && event.rect?.width === 80 && event.rect?.height === 40));
  const normalized = normalizeProbes(raw);
  assert.ok(normalized.focusOrder.targets.length > 0, 'retain actually visited node identities');
  assert.equal(normalized.focusAppearance.outcome, 'cantTell');
  assert.equal(normalized.obscuredTargets.outcome, 'cantTell');
  for (const event of raw.focus.events) {
    for (const field of ['beforeCss', 'afterCss', 'indicatorVisible', 'areaSufficient', 'intersectionRatio']) {
      assert.equal(Object.hasOwn(event, field), false, field);
    }
  }
});
