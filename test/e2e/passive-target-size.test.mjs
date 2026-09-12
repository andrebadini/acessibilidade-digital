import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { collectRuntimePageData } from '../../src/collector/page-collector.js';
import { launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer } from './support/real-chrome.mjs';

test('passive target measurement excludes clipped, fragmented, transformed and overlapping controls without interaction', { timeout: 60_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([['/targets', {
    status: 200, headers: { 'content-type': 'text/html' }, body: `<!doctype html><html lang="pt-BR"><style>
      body{margin:0} button{position:absolute;width:30px;height:30px;padding:0;border:0;top:20px}
      #plain{left:20px} #clip{left:100px;clip-path:inset(0 20px 0 0)}
      #transform{left:180px;transform:rotate(45deg)}
      #under{left:260px} #cover{position:absolute;left:270px;top:20px;width:20px;height:30px;background:red}
      #overflow{position:absolute;left:340px;top:20px;width:10px;height:30px;overflow:hidden}
      #overflow button{left:0;top:0}
      #wrap{position:absolute;left:400px;top:20px;width:40px;line-height:16px}
    </style><body><button id="plain">A</button><button id="clip">B</button>
      <button id="transform">C</button><button id="under">D</button><div id="cover"></div>
      <div id="overflow"><button id="cropped">E</button></div>
      <div id="wrap"><a id="wrapped" href="#">one two three</a></div>
    </body></html>`
  }]]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/targets`, chromeBinary: resolveRealChromeTestBinary(),
    viewport: { width: 1280, height: 900 }, expectedMajor: 152,
  });
  const page = extension.startPage.page;
  const state = `({html:document.documentElement.outerHTML,focus:document.activeElement.id,scroll:[scrollX,scrollY],viewport:[innerWidth,innerHeight]})`;
  const before = await extension.evaluate(page, state);
  const observed = await extension.evaluate(page, `(${collectRuntimePageData.toString()})()`);
  const byId = id => observed.nodes.find(node => node.selectorHint === '#' + id);
  assert.deepEqual(byId('plain').targetSizeRect, { x: 20, y: 20, width: 30, height: 30 });
  for (const id of ['clip', 'transform', 'under', 'cropped', 'wrapped']) {
    assert.equal(byId(id).targetSizeRect, undefined, id);
  }
  assert.deepEqual(await extension.evaluate(page, state), before);
  await extension.evaluate(page, `(() => {
    document.body.innerHTML='<div id="ancestor"><button id="pseudo-target">X</button></div>';
    const style=document.createElement('style');
    style.textContent='#ancestor{position:absolute;left:20px;top:20px;width:30px;height:30px}#pseudo-target{left:0;top:0}#ancestor::after{content:"";position:absolute;left:3px;top:0;width:3px;height:30px;background:red;z-index:2}';
    document.head.append(style);return true;
  })()`);
  const pseudoState = await extension.evaluate(page, state);
  const pseudoObserved = await extension.evaluate(page, `(${collectRuntimePageData.toString()})()`);
  assert.equal(pseudoObserved.nodes.find(node => node.selectorHint === '#pseudo-target').targetSizeRect, undefined,
    'ancestor pseudo-element between hit-test samples must not produce approval');
  assert.deepEqual(await extension.evaluate(page, state), pseudoState);
  await extension.evaluate(page, `new Promise(resolve => {
    document.body.innerHTML='';
    const frame=document.createElement('iframe');
    frame.style.cssText='width:100px;height:100px;transform:scale(.25)';
    frame.onload=()=>resolve(true);
    frame.srcdoc='<button style="position:absolute;left:10px;top:10px;width:44px;height:44px;border:0;padding:0;border-radius:0">A</button>';
    document.body.append(frame);
  })`, { awaitPromise: true });
  const embedded = await extension.evaluate(page,
    `document.querySelector('iframe').contentWindow.eval(${JSON.stringify(`(${collectRuntimePageData.toString()})()`)})`);
  assert.equal(embedded.nodes.find(node => node.tagName === 'button').targetSizeRect, undefined,
    'local iframe pixels cannot certify an 11×11 target rendered by its embedding transform');
});
