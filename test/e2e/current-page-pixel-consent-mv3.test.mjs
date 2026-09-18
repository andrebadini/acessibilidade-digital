import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, launchUnpackedExtension, resolveRealChromeTestBinary, evaluate, waitForValue, click } from './support/real-chrome.mjs';

// GUARDA DO CAMINHO CONSENTIDO na página atual, nos DOIS modos com foto: numa página COM sinal sensível a
// auditoria tem de PAUSAR e pedir autorização antes de qualquer raster, e só depois da confirmação chegar a
// `result`. Este arquivo não é oráculo de um defeito (o caminho consentido já funcionava na 1.1.47): ele é a
// rede que impede o conserto da tentativa direta (1.1.48) de afrouxar o consentimento — a captura autorizada
// SEM pausa ganhou companheiro próprio, e o caminho COM pausa continua tendo de pausar.
const RAIZ = process.env.AUDITA_EXT_PATH ?? await realpath(fileURLToPath(new URL('../../', import.meta.url)));

// Fixture COM sinal sensível: campo de senha e área marcada como privada pelo produto.
const DOCUMENTO = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Sensível</title>
<style>body{margin:0;font:16px system-ui;height:900px}</style></head>
<body><main><h1>Cadastro</h1><p>Conteúdo acima da dobra.</p>
<label for="senha">Senha</label><input id="senha" name="senha" type="password" value="SEGREDO-SENTINELA-1234">
<section data-audita-private><p>Área marcada como privada.</p></section>
<img id="sem-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
<button id="sem-nome"></button></main></body></html>`;

for (const modo of ['full-evidence', 'element-only']) {
  test(`página atual com sinal sensível em ${modo}: pausa, autorização e só então o resultado`, { timeout: 300_000 }, async t => {
    const fixture = await startFixtureServer(t, new Map([
      ['/sensivel', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: DOCUMENTO }],
    ]));
    const extension = await launchUnpackedExtension(t, {
      extensionPath: RAIZ,
      startUrl: `${fixture.origin}/sensivel`,
      chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
      viewport: { width: 1280, height: 900 }, downloadMode: 'profile',
    });
    try {
      const panel = await extension.openSidePanelFromAction();
      await panel.command('Page.bringToFront');
      await waitForValue(panel, `(() => {
        const input = document.querySelector('input[data-capture-mode="${modo}"]');
        const button = document.querySelector('button[data-intent="START_ATTACHED"]');
        return Boolean(input && !input.disabled && button && !button.disabled);
      })()`, Boolean, { timeoutMs: 30_000, intervalMs: 100 });
      await click(panel, `input[data-capture-mode="${modo}"]`);
      await new Promise(resolve => setTimeout(resolve, 400));
      await click(panel, 'button[data-intent="START_ATTACHED"]');
      const leitura = `(() => ({
        tela: document.querySelector('[data-screen]')?.dataset.screen ?? null,
        confirma: Boolean(document.querySelector('[data-action="confirm-pixel-capture"]')),
      }))()`;
      // A pausa tem de aparecer; antes dela NÃO pode existir resultado.
      const pausa = await waitForValue(panel, leitura, value => value?.confirma === true,
        { timeoutMs: 60_000, intervalMs: 100 });
      assert.equal(pausa.confirma, true, 'a auditoria com sinal sensível tem de pedir autorização');
      assert.notEqual(pausa.tela, 'result', 'nenhum resultado pode existir antes da autorização');
      t.diagnostic(`modo=${modo} pausa=confirmada`);
      await click(panel, '[data-action="confirm-pixel-capture"]');
      const limite = Date.now() + 90_000;
      let desfecho = null;
      const telas = [];
      do {
        desfecho = await evaluate(panel, leitura);
        if (desfecho?.tela === 'result') break;
        if (telas.at(-1)?.tela !== desfecho?.tela) telas.push(desfecho);
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (Date.now() < limite);
      assert.equal(desfecho?.tela, 'result',
        `depois de autorizar, a auditoria de ${modo} tem de concluir; telas observadas: ${JSON.stringify(telas)}`);
      t.diagnostic(`modo=${modo} desfecho=result`);
    } finally {
      await extension.close();
    }
  });
}
