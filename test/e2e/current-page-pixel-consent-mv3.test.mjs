import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, launchUnpackedExtension, resolveRealChromeTestBinary, evaluate, waitForValue, click } from './support/real-chrome.mjs';

// TRAVA REMOVIDA (decisão de produto): página COM sinal sensível (senha / área privada) NÃO pausa a
// auditoria. Quem audita não usa senha nem dados sensíveis; os modos com foto concluem direto em `result`,
// sem diálogo de autorização. Este arquivo é a guarda de que a trava não volta.
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
  test(`página atual com sinal sensível em ${modo}: conclui sem pedir autorização`, { timeout: 300_000 }, async t => {
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
      const limite = Date.now() + 90_000;
      let desfecho = null;
      const telas = [];
      do {
        desfecho = await evaluate(panel, leitura);
        if (desfecho?.tela === 'result' || desfecho?.tela === 'unavailable') break;
        assert.notEqual(desfecho?.confirma, true, 'a trava de consentimento não deve aparecer');
        if (telas.at(-1)?.tela !== desfecho?.tela) telas.push(desfecho);
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (Date.now() < limite);
      assert.equal(desfecho?.tela, 'result',
        `sinal sensível não barra a auditoria de ${modo}; telas observadas: ${JSON.stringify(telas)}`);
      assert.equal(desfecho.confirma, false, 'nenhum diálogo de autorização');
      t.diagnostic(`modo=${modo} desfecho=result sem confirmação`);
    } finally {
      await extension.close();
    }
  });
}
