import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, launchUnpackedExtension, resolveRealChromeTestBinary, evaluate, waitForValue, click } from './support/real-chrome.mjs';

// CRUZA A FIAÇÃO REAL do conserto da tentativa direta (achado A-2 da revisão da 1.1.48): o gancho do portão
// precisa aposentar a tentativa direta com a MESMA assinatura que o ciclo de vida aceita. Os testes de unidade
// não pegavam esse defeito porque cada um dubla um lado da fronteira (o portão usa espiões; o starter dubla o
// ciclo de vida). Aqui a sequência é determinística e ponta a ponta:
//
//   1. a auditoria arma SEM pausa numa página sem sinal sensível (modo `element-only`: o primeiro raster de
//      ELEMENTO só vem depois da seleção, e é essa janela que dá tempo de a página revelar o campo) -> nasce o marcador `audita:pixel-attempt:v1:*`
//      (observado de fora, na página de harness, por `chrome.storage.session`);
//   2. SÓ ENTÃO a página ganha um campo de senha (o caso "SPA que renderiza o formulário tarde");
//   3. o primeiro raster re-sonda os sinais, o portão vai pausar — e tem de aposentar a direta ANTES;
//   4. a pausa aparece, a pessoa autoriza, a auditoria conclui em `result`;
//   5. no fim NÃO pode sobrar marcador de tentativa nenhum.
//
// Não vacuidade: contra os bytes da 1.1.47 (sem tentativa direta) o passo 1 nunca acontece; contra os bytes da
// 1.1.48 anteriores ao conserto do A-2, o passo 3 lança (assinatura trocada), a pausa é negada e a auditoria
// termina em `unavailable` com marcador residual.
const RAIZ = process.env.AUDITA_EXT_PATH ?? await realpath(fileURLToPath(new URL('../../', import.meta.url)));

// Página GRANDE de propósito: a injeção do campo sensível tem de caber entre o armar (preflight) e o primeiro
// raster (que re-sonda os sinais). Com meia dúzia de elementos a auditoria chega ao raster antes de a sonda
// conseguir injetar, e o caso vira "sem pausa" — medido nesta sonda durante o desenvolvimento.
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

test('página que revela sinal sensível depois de armar: a direta é aposentada, o consentimento é pedido e nada sobra', { timeout: 300_000 }, async t => {
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
    assert.equal(await marcadores(extension.harnessPage), 0, 'nenhuma tentativa pode existir antes da auditoria');
    await click(panel, 'input[data-capture-mode="element-only"]');
    await new Promise(resolve => setTimeout(resolve, 400));
    await click(panel, 'button[data-intent="START_ATTACHED"]');
    // 1. o portão arma sem pausa e a tentativa DIRETA nasce (é o companheiro durável da captura sem consentimento)
    const nasceu = await waitForValue(extension.harnessPage, `(async () => Object.keys(await chrome.storage.session.get(null))
      .filter(chave => chave.startsWith('audita:pixel-attempt:v1:')).length)()`, value => value >= 1,
      { timeoutMs: 60_000, intervalMs: 100, awaitPromise: true }).catch(() => 0);
    assert.ok(nasceu >= 1, 'a captura autorizada sem pausa tem de ter companheiro durável antes de qualquer raster');
    t.diagnostic('tentativa direta criada (portão armou)');
    // 2. a página revela sinal sensível DEPOIS do armar
    assert.equal(await evaluate(extension.startPage.page, CAMPO_SENSIVEL), true);
    // 3./4. o portão tem de PAUSAR (aposentando a direta antes) e, autorizado, concluir
    const leitura = `(() => ({
      tela: document.querySelector('[data-screen]')?.dataset.screen ?? null,
      confirma: Boolean(document.querySelector('[data-action="confirm-pixel-capture"]')),
    }))()`;
    const pausa = await waitForValue(panel, leitura, value => value?.confirma === true || value?.tela === 'unavailable',
      { timeoutMs: 120_000, intervalMs: 250 });
    assert.equal(pausa.confirma, true,
      `com sinal revelado depois do armar, o painel tem de pedir autorização (não revogar); leitura: ${JSON.stringify(pausa)}`);
    await click(panel, '[data-action="confirm-pixel-capture"]');
    const desfecho = await waitForValue(panel, leitura, value => value?.tela === 'result' || value?.tela === 'unavailable',
      { timeoutMs: 150_000, intervalMs: 250 });
    assert.equal(desfecho.tela, 'result', 'depois de autorizar, a auditoria tem de concluir');
    // 5. higiene: nem a direta aposentada nem a consentida podem sobrar
    const restantes = await waitForValue(extension.harnessPage, `(async () => Object.keys(await chrome.storage.session.get(null))
      .filter(chave => chave.startsWith('audita:pixel-attempt:v1:')).length)()`, value => value === 0,
      { timeoutMs: 30_000, intervalMs: 200, awaitPromise: true }).catch(async () => marcadores(extension.harnessPage));
    assert.equal(restantes, 0, 'não pode sobrar marcador de tentativa depois da auditoria');
    t.diagnostic('pausa, autorização, resultado e zero marcadores');
  } finally {
    await extension.close();
  }
});
