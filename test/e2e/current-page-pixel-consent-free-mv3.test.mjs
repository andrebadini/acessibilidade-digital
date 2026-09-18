import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, launchUnpackedExtension, resolveRealChromeTestBinary, evaluate, waitForValue, click } from './support/real-chrome.mjs';

// O PERCURSO DE PIXEL NUMA PÁGINA **SEM** SINAL SENSÍVEL TEM DE CONCLUIR. Numeração do defeito: o portão de
// privacidade arma sem pausa (`preflight`, `consentId` nulo e sem sinal detectado) e a captura de pixel
// acontece; no commit terminal a guarda D2 (`commitTerminal` em `src/background/service-worker.js`) recusava
// o modelo que carrega raster quando não havia companheiro durável de tentativa — companheiro que só era
// criado no caminho de retomada pós-consentimento. Sem ele, o erro subia mascarado
// (`TERMINAL_COMMIT_DENIED` → `OBSERVED_RUNNER_DENIED` → `ATTACHED_AUDIT_EXECUTION_DENIED`) e a recuperação
// revogava a auditoria inteira: o painel voltava ao neutro (em silêncio antes da 1.1.47, com mensagem depois).
// O conserto dá à captura sem consentimento o seu próprio companheiro durável (tentativa direta).
//
// Não vacuidade MEDIDA: contra os bytes empacotados da 1.1.47 (sem o conserto), os dois modos terminam em
// `unavailable` e este caso REPROVA; contra esta árvore, os dois chegam a `result`.
const RAIZ = process.env.AUDITA_EXT_PATH ?? await realpath(fileURLToPath(new URL('../../', import.meta.url)));

// Fixture SEM sinal sensível: nenhum campo de senha, nenhum marcador privado — a página comum em que o
// modo padrão do painel (`full-evidence`) precisa funcionar.
const DOCUMENTO = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Comum</title>
<style>body{margin:0;font:16px system-ui;height:600px}</style></head>
<body><main><h1>Página comum</h1><p>Conteúdo acima da dobra.</p>
<img id="sem-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
<button id="sem-nome"></button></main></body></html>`;

for (const modo of ['full-evidence', 'element-only']) {
  test(`página atual sem sinal sensível em ${modo}: a auditoria de pixel conclui`, { timeout: 300_000 }, async t => {
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
        const input = document.querySelector('input[data-capture-mode="${modo}"]');
        const button = document.querySelector('button[data-intent="START_ATTACHED"]');
        return Boolean(input && !input.disabled && button && !button.disabled);
      })()`, Boolean, { timeoutMs: 30_000, intervalMs: 100 });
      await click(panel, `input[data-capture-mode="${modo}"]`);
      await new Promise(resolve => setTimeout(resolve, 400));
      await click(panel, 'button[data-intent="START_ATTACHED"]');
      // Sem sinal sensível NÃO deve haver pausa de consentimento: o desfecho esperado é `result`. A espera é
      // escrita à mão (e não com `waitForValue`) para que a falha NOMEIE as telas observadas.
      const leitura = `(() => ({
        tela: document.querySelector('[data-screen]')?.dataset.screen ?? null,
        confirma: Boolean(document.querySelector('[data-action="confirm-pixel-capture"]')),
        texto: (document.body.innerText || '').replace(/\\s+/gu, ' ').slice(0, 160),
      }))()`;
      const limite = Date.now() + 90_000;
      let visto = null;
      const telas = [];
      do {
        visto = await evaluate(panel, leitura);
        if (visto?.tela === 'result') break;
        if (telas.at(-1)?.tela !== visto?.tela) telas.push(visto);
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (Date.now() < limite);
      assert.equal(visto?.tela, 'result',
        `a auditoria de ${modo} numa página sem sinal sensível tem de concluir; telas observadas: ${JSON.stringify(telas)}`);
      assert.equal(visto.confirma, false, 'sem sinal sensível não há pausa de consentimento a confirmar');
      t.diagnostic(`modo=${modo} desfecho=result`);
    } finally {
      await extension.close();
    }
  });
}
