import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, launchUnpackedExtension, resolveRealChromeTestBinary, evaluate, waitForValue } from './support/real-chrome.mjs';

// O QUE A REVISÃO FINAL DA 1.1.45 EXIGIU: no modo de imagem da página atual, quando a auditoria NÃO pode
// prosseguir, o painel tem de dizer o que aconteceu — nunca voltar ao neutro em silêncio. A revisão mediu,
// numa página SEM sinal sensível, a sessão revogada (`revoked`) e o painel de volta a `initial` sem
// mensagem; o modo padrão do painel é justamente `full-evidence`.
//
// Não vacuidade MEDIDA: com `AUDITA_EXT_PATH` apontando para os bytes empacotados da 1.1.46 (sem este
// conserto), os dois modos REPROVAM e a falha imprime a trajetória observada — `running` → `reconnecting`
// → `initial`, exatamente a revogação silenciosa que a revisão descreveu; contra esta árvore, os dois
// modos passam em ~2 s com a tela `unavailable` e o motivo escrito.
const RAIZ = process.env.AUDITA_EXT_PATH ?? await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const MOTIVO = 'A auditoria foi encerrada antes de concluir';

// Fixture SEM sinal sensível: nenhum campo de senha, nenhum marcador privado — é a página comum que a
// revisão usou para medir a revogação silenciosa.
const DOCUMENTO = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Comum</title>
<style>body{margin:0;font:16px system-ui;height:2600px}</style></head>
<body><main><h1>Página comum</h1><p>Conteúdo acima da dobra.</p>
<img id="sem-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
<button id="sem-nome"></button></main></body></html>`;

for (const modo of ['full-evidence', 'element-only']) {
  test(`página atual em ${modo}: quando a auditoria não pode prosseguir, o painel diz por quê`, { timeout: 300_000 }, async t => {
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
      await extension.click(panel, `input[data-capture-mode="${modo}"]`);
      await new Promise(resolve => setTimeout(resolve, 400));
      await extension.click(panel, 'button[data-intent="START_ATTACHED"]');
      // Ou o percurso segue (confirmação de captura ou resultado), ou o painel EXPLICA a indisponibilidade.
      // O texto vem de `document.body.innerText` (o `innerText` do elemento da tela volta vazio quando o
      // painel não está em primeiro plano — medido nesta sonda durante o desenvolvimento). A espera é
      // escrita à mão, e não com `waitForValue`, por dois motivos medidos: (1) aquele auxiliar engole a
      // exceção de cada leitura e, quando o desfecho não chega, reporta só `WAIT_TIMEOUT` — foi assim que
      // um predicado que procurava o texto literal `${MOTIVO}` (o predicado é código comum, não um
      // template) custou 90 s de espera por modo sem dizer nada; (2) aqui a falha precisa NOMEAR as telas
      // observadas. Cuidado ao mexer: só a EXPRESSÃO é um template literal; o predicado não é.
      const leitura = `(() => ({
        tela: document.querySelector('[data-screen]')?.dataset.screen ?? null,
        texto: (document.body.innerText || '').replace(/\\s+/gu, ' '),
        confirma: Boolean(document.querySelector('[data-action="confirm-pixel-capture"]')),
      }))()`;
      const aceito = value => value?.confirma === true || value?.tela === 'result' ||
        (value?.tela === 'unavailable' && String(value.texto ?? '').includes(MOTIVO));
      const limite = Date.now() + 90_000;
      let desfecho = null;
      const visto = [];
      do {
        desfecho = await evaluate(panel, leitura);
        if (aceito(desfecho)) break;
        if (visto.at(-1)?.tela !== desfecho?.tela) visto.push(desfecho);
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (Date.now() < limite);
      assert.ok(aceito(desfecho), `o painel não explicou a indisponibilidade em 90s; telas observadas: ${JSON.stringify(visto)}; última leitura: ${JSON.stringify(desfecho)}`);
      t.diagnostic(`modo=${modo} desfecho=${desfecho.tela}${desfecho.confirma ? ' (confirmação)' : ''}`);
      if (desfecho.tela === 'unavailable') {
        assert.match(desfecho.texto, /Refaça a auditoria/u);
      } else {
        assert.ok(desfecho.confirma || desfecho.tela === 'result');
      }
    } finally {
      await extension.close();
    }
  });
}
