import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  launchUnpackedExtension,
  resolveRealChromeTestBinary,
  startFixtureServer,
} from './support/real-chrome.mjs';

// Regressão de um portal institucional real (1.1.52): a página tem um mapa em <iframe loading="lazy"> no rodapé, fora da
// área visível. Esse quadro existe (about:blank) mas nunca chega a `document_idle`, e toda injeção
// `allFrames` sem `injectImmediately` ficava pendente para sempre: a auditoria da página atual parava em
// "Preparando a auditoria" (0%) e terminava como falha. O quadro é de outra origem (localhost x 127.0.0.1),
// como o Google Maps no site real, e há também um selo fixo em iframe e um iframe oculto sem src.
const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));

function lazyMapDocument(frameOrigin) {
  const paragraphs = Array.from({ length: 40 }, (_, index) =>
    `<p>Parágrafo institucional ${index + 1}.</p>`).join('');
  return `<!doctype html>
    <html lang="pt-BR">
      <head><meta charset="utf-8"><title>Página com mapa lazy</title></head>
      <body>
        <main>
          <h1>Atendimento ao consumidor</h1>
          ${paragraphs}
          <div style="height:4000px"></div>
          <p><iframe id="mapa" loading="lazy" title="Mapa da localização" width="600" height="450" style="border:0"
            src="${frameOrigin}/mapa"></iframe></p>
        </main>
        <div><div style="position:fixed;bottom:14px;right:-186px;width:256px;height:60px">
          <iframe title="Selo" width="256" height="60" src="${frameOrigin}/selo"></iframe>
        </div><iframe style="display:none"></iframe></div>
      </body>
    </html>`;
}

test('audits the current page when an off-screen lazy iframe never loads', { timeout: 180_000 }, async t => {
  const chromeBinary = resolveRealChromeTestBinary();
  assert.ok(chromeBinary, 'AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório para este E2E real.');
  const frameBody = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Quadro</title></head><body><p>Quadro</p></body></html>';
  const frames = await startFixtureServer(t, new Map([
    ['/mapa', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: frameBody }],
    ['/selo', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: frameBody }],
  ]));
  const frameOrigin = frames.origin.replace('127.0.0.1', 'localhost');
  const fixture = await startFixtureServer(t, new Map([
    ['/pagina', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: lazyMapDocument(frameOrigin) }],
  ]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(workspaceRoot), startUrl: `${fixture.origin}/pagina`,
    downloadMode: 'profile', viewport: { width: 1280, height: 900 }, chromeBinary, expectedMajor: 152,
  });
  // Pré-condição do defeito: o mapa lazy ainda não carregou quando a auditoria começa.
  assert.equal(await extension.evaluate(extension.startPage.page,
    `(() => { try { return document.querySelector('#mapa').contentWindow.location.href; } catch { return 'cross-origin'; } })()`),
  'about:blank');

  const panel = await extension.openSidePanelFromAction();
  await panel.command('Page.bringToFront');
  await extension.waitForValue(panel, `document.querySelector('[data-screen]')?.dataset.screen`,
    value => value === 'initial', { timeoutMs: 30_000, intervalMs: 50 });
  await extension.waitForValue(panel, `(() => {
    const input=document.querySelector('input[data-capture-mode="full-evidence"]');
    const button=document.querySelector('button[data-intent="START_ATTACHED"]');
    return Boolean(input&&!input.disabled&&button&&!button.disabled);
  })()`, Boolean, { timeoutMs: 10_000, intervalMs: 25 });
  await extension.click(panel, 'input[data-capture-mode="full-evidence"]');
  await extension.click(panel, 'button[data-intent="START_ATTACHED"]');

  // Antes da correção a tela ficava em "running" a 0% indefinidamente; 90 s é folga de sobra.
  const terminal = await extension.waitForValue(panel, `(() => ({
    screen:document.querySelector('[data-screen]')?.dataset.screen??null,
    status:document.querySelector('[role="status"]')?.textContent??null
  }))()`, value => ['result', 'initial', 'unavailable'].includes(value?.screen), { timeoutMs: 90_000, intervalMs: 100 });
  assert.equal(terminal.screen, 'result', JSON.stringify(terminal));

  const latest = await extension.evaluate(extension.harnessPage, `(async()=>{
    const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
    const latest=await store.getLatest();
    const revision=latest?.auditId?await store.getReportRevision(latest.auditId):null;
    return {status:latest?.status??null,failureCode:latest?.failureCode??null,
      diagnostics:(revision?.model?.session?.diagnostics??[]).map(item=>item.code)};
  })()`, { awaitPromise: true });
  assert.ok(['complete', 'partial'].includes(latest.status), JSON.stringify(latest));
  assert.equal(latest.failureCode, null);
  for (const code of ['AXE_TIMEOUT', 'COLLECTION_FAILED', 'CORE_AUDIT_FAILED']) {
    assert.equal(latest.diagnostics.includes(code), false, `${code} em ${JSON.stringify(latest.diagnostics)}`);
  }
});
