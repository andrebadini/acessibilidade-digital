import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer } from './support/real-chrome.mjs';

test('characterize whether native MHTML preserves runtime state for passive evidence', { timeout: 60_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([['/state', {
    status: 200, headers: { 'content-type': 'text/html' },
    body: '<!doctype html><html lang="pt-BR"><body style="min-height:2000px"><input id="field" value="INITIALVALUE"><input id="check" type="checkbox"><textarea id="notes">INITIALNOTES</textarea><canvas width="40" height="40"></canvas></body></html>'
  }]]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/state`, chromeBinary: resolveRealChromeTestBinary(),
    viewport: { width: 1280, height: 900 }, expectedMajor: 152,
  });
  const page = extension.startPage.page;
  await extension.evaluate(page, `(() => {
    const button=document.createElement('button');button.textContent='MEMORYONLYBUTTON';document.body.append(button);
    document.querySelector('#field').value='RUNTIMEINPUTVALUE';
    document.querySelector('#check').checked=true;
    document.querySelector('#notes').value='RUNTIMETEXTAREA';
    const context=document.querySelector('canvas').getContext('2d');context.fillStyle='red';context.fillRect(0,0,40,40);
    document.querySelector('#field').focus();scrollTo(0,200);return true;
  })()`);
  const expression = `({html:document.documentElement.outerHTML,focus:document.activeElement.id,
    input:document.querySelector('#field').value,checked:document.querySelector('#check').checked,
    notes:document.querySelector('#notes').value,canvas:document.querySelector('canvas').toDataURL(),
    scroll:[scrollX,scrollY],viewport:[innerWidth,innerHeight,document.documentElement.clientWidth]})`;
  const before = await extension.evaluate(page, expression);
  const snapshot = await page.command('Page.captureSnapshot', { format: 'mhtml' });
  // The fixture is ASCII. Unfold quoted-printable soft breaks before looking
  // for its independent runtime markers; never log the archive's contents.
  const decoded = snapshot.data.replace(/=\r?\n/gu, '').replace(/=([0-9A-F]{2})/gu, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  const observations = {
    memoryButton: decoded.includes('MEMORYONLYBUTTON'),
    currentInput: decoded.includes('RUNTIMEINPUTVALUE'),
    currentTextarea: decoded.includes('RUNTIMETEXTAREA'),
    checkedAttribute: /id="check"[^>]*\bchecked\b/u.test(decoded),
    embeddedPng: /Content-Type: image\/png/iu.test(decoded),
  };
  t.diagnostic(JSON.stringify(observations));
  assert.equal(observations.memoryButton, true);
  assert.deepEqual(await extension.evaluate(page, expression), before);
});
