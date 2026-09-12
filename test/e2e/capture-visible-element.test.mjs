import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { captureElement } from '../../src/browser/capture-evidence.js';
import { launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer } from './support/real-chrome.mjs';

test('a fully visible element capture preserves viewport and captures real pixels at both scroll positions', { timeout: 60_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([['/', {
    status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: `<!doctype html><title>Captura</title>
    <style>body{margin:0;height:2400px}#sample{position:absolute;top:200px;left:calc(50% - 50px);width:100px;height:100px;background:rgb(255,0,0)}</style><div id="sample"></div>`,
  }]]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/`, chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
    viewport: { width: 1280, height: 900 },
  });
  const page = extension.startPage.page;
  const state = `({html:document.documentElement.outerHTML,scroll:[scrollX,scrollY],focus:document.activeElement.id,
    viewport:[innerWidth,innerHeight,visualViewport.width,visualViewport.height,document.documentElement.clientWidth],
    rect:(()=>{const r=document.getElementById('sample').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()})`;
  for (const scroll of [0, 150]) {
    await extension.evaluate(page, `(() => {scrollTo(0,${scroll});return true})()`);
    await extension.evaluate(page, 'new Promise(resolve=>requestAnimationFrame(()=>resolve(true)))', { awaitPromise: true });
    const before = await extension.evaluate(page, state);
    const metrics = await page.command('Page.getLayoutMetrics', {});
    const result = await captureElement(page, { x: before.rect[0], y: before.rect[1] + scroll, width: 100, height: 100 }, metrics);
    assert.equal(result.status, 'captured');
    const pixel = await extension.evaluate(page, `(async()=>{
      const image=await createImageBitmap(await(await fetch(${JSON.stringify(result.dataUrl)})).blob());
      const canvas=new OffscreenCanvas(image.width,image.height);const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
      return [...ctx.getImageData(Math.floor(image.width/2),Math.floor(image.height/2),1,1).data];
    })()`, { awaitPromise: true });
    assert.ok(pixel[0] >= 240 && pixel[1] <= 15 && pixel[2] <= 15 && pixel[3] === 255, 'actual red element, not blank pixels');
    assert.deepEqual(await extension.evaluate(page, state), before);
  }
});
