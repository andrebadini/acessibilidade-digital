import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, launchUnpackedExtension, resolveRealChromeTestBinary, evaluate, waitForValue, click } from './support/real-chrome.mjs';

// TRAVA REMOVIDA: a página pode revelar sinal sensível DEPOIS de o portão armar (SPA que renderiza o
// formulário tarde). Antes isso pausava e aposentava a tentativa direta; agora a captura segue e a
// auditoria conclui sem autorização. Guarda de que a trava não volta nem no caso tardio.
const RAIZ = process.env.AUDITA_EXT_PATH ?? await realpath(fileURLToPath(new URL('../../', import.meta.url)));

const CONTROLES = Array.from({ length: 240 }, (_, indice) =>
  `<button class="controle-sem-nome" data-sequencia="${indice}"></button>`).join('');
const DOCUMENTO = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Comum</title>
<style>body{margin:0;font:16px system-ui;min-height:2600px}main{max-width:700px;margin:24px auto}
.controle-sem-nome{display:inline-block;width:10px;height:10px;margin:1px}</style></head>
<body><main><h1>Página comum</h1><p>Conteúdo acima da dobra.</p>
<img id="sem-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
<button id="sem-nome"></button>${CONTROLES}</main></body></html>`;

const CAMPO_SENSIVEL = `(() => {
  const campo = document.createElement('input');
  campo.id = 'senha-tardia'; campo.type = 'password'; campo.name = 'senha';
  campo.value = 'SEGREDO-SENTINELA-1234';
  document.querySelector('main').append(campo);
  return true;
})()`;

const marcadores = harness => evaluate(harness, `(async () => Object.keys(await chrome.storage.session.get(null))
  .filter(chave => chave.startsWith('audita:pixel-attempt:v1:')).length)()`, { awaitPromise: true });

test('página que revela sinal sensível depois de armar: a auditoria conclui sem pausa e sem marcador residual', { timeout: 300_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([
    ['/comum', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: DOCUMENTO }],
  ]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: RAIZ,
    startUrl: `${fixture.origin}/comum`,
    chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
    viewport: { width: 1280, height: 900 }, downloadMode: 'profile',
  });
  try {
    const panel = await extension.openSidePanelFromAction();
    await panel.command('Page.bringToFront');
    await waitForValue(panel, `(() => {
      const input = document.querySelector('input[data-capture-mode="element-only"]');
      const button = document.querySelector('button[data-intent="START_ATTACHED"]');
      return Boolean(input && !input.disabled && button && !button.disabled);
    })()`, Boolean, { timeoutMs: 30_000, intervalMs: 100 });
    await click(panel, 'input[data-capture-mode="element-only"]');
    await new Promise(resolve => setTimeout(resolve, 400));
    await click(panel, 'button[data-intent="START_ATTACHED"]');
    // A página revela o campo de senha DEPOIS de a auditoria começar.
    await waitForValue(extension.startPage.page, 'document.readyState', value => value === 'complete',
      { timeoutMs: 30_000, intervalMs: 100 });
    await evaluate(extension.startPage.page, CAMPO_SENSIVEL);
    const leitura = `(() => ({
      tela: document.querySelector('[data-screen]')?.dataset.screen ?? null,
      confirma: Boolean(document.querySelector('[data-action="confirm-pixel-capture"]')),
    }))()`;
    const limite = Date.now() + 90_000;
    let desfecho = null;
    const telas = [];
    do {
      desfecho = await evaluate(panel, leitura);
      if (desfecho?.tela === 'result' || desfecho?.tela === 'unavailable') break;
      assert.notEqual(desfecho?.confirma, true, 'sinal sensível tardio não deve abrir diálogo de autorização');
      if (telas.at(-1)?.tela !== desfecho?.tela) telas.push(desfecho);
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < limite);
    assert.equal(desfecho?.tela, 'result',
      `sinal sensível tardio não barra a auditoria; telas: ${JSON.stringify(telas)}`);
    assert.equal(desfecho.confirma, false);
    const restantes = await marcadores(extension.harnessPage ?? extension.startPage.page);
    t.diagnostic(`modo=element-only desfecho=result tentativas_restantes=${restantes}`);
    assert.equal(restantes, 0, 'nenhuma tentativa de captura residual');
  } finally {
    await extension.close();
  }
});
