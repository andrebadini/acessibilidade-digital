import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer } from './support/real-chrome.mjs';

// Congelamento de navegação (1.1.58): uma página que se recarrega sozinha NÃO pode mais derrubar a auditoria
// da página atual nem fazer os sinais parecerem perdidos no fim (o documento auditado deixava de existir).
// O contrato provado aqui, em página real do Chrome:
//   1. a auditoria da página atual conclui com resultado mesmo com a página pedindo recarga sem parar;
//   2. o diagnóstico PAGE_NAVIGATION_HELD aparece no modelo do relatório;
//   3. depois da auditoria a recarga volta a funcionar, ou seja, a interceptação foi mesmo removida.
const RAIZ = process.env.AUDITA_EXT_PATH ?? await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const ORCAMENTO_MS = Number(process.env.AUDITA_FREEZE_BUDGET_MS ?? 150_000);

// Os dois gatilhos que a sonda da Fase 1 mediu como troca de documento: `meta http-equiv="refresh"` e
// `location.reload()` por temporizador. Os dois geram requisição de documento no frame principal.
const GATILHOS = Object.freeze({
  'meta-refresh': '<meta http-equiv="refresh" content="3">',
  'timer-reload': '',
});

// A geração vive em sessionStorage porque ele sobrevive à recarga: é a prova de que o documento foi mesmo
// trocado (e não apenas "parece" recarregado). O script fica no fim do corpo para poder pintar o marcador.
function documento(gatilho) {
  // O portal de notícias de verdade não tenta recarregar uma vez só: ele rearma o temporizador a cada
  // ciclo. Sem a insistência a fixture teria um único pedido, que pode cair antes de a auditoria começar.
  const agendamento = gatilho === 'timer-reload'
    ? 'const agendar = () => setTimeout(() => { location.reload(); agendar(); }, 2500); agendar();'
    : '';
  const cards = Array.from({ length: 240 }, (_, index) =>
    `<article class="card"><a href="/p/${index}"><img src="/img.png" alt="" width="120" height="120">` +
    `<h3>Produto ${index}</h3></a><span class="preco">R$ ${index},99</span><button type="button">Comprar</button></article>`).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Vitrine viva</title>
${GATILHOS[gatilho]}
<style>body{margin:0;font:16px system-ui}.grade{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}</style></head>
<body><main><h1>Vitrine de exemplo</h1>
<p id="geracao">geração 0</p>
<label for="busca">Buscar</label><input id="busca" type="search" autocomplete="off">
<button id="sem-nome"></button><a href="/outra">Outra página</a>
<section class="grade">${cards}</section></main>
<script>
let geracao = 0;
try { geracao = Number(sessionStorage.getItem('audita-geracao') || '0') + 1;
  sessionStorage.setItem('audita-geracao', String(geracao)); } catch {}
window.__auditaGeracao = geracao;
document.getElementById('geracao').textContent = 'geração ' + geracao;
${agendamento}
</script></body></html>`;
}

const LEITURA_PAINEL = `(() => ({
  tela: document.querySelector('[data-screen]')?.dataset.screen ?? null,
  sessao: document.querySelector('[data-screen]')?.dataset.sessionStatus ?? null,
  status: document.querySelector('[role="status"]')?.textContent ?? null,
}))()`;

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const LEITURA_MODELO = `(async () => {
  const store = (await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
  const latest = await store.getLatest();
  const revision = latest?.auditId ? await store.getReportRevision(latest.auditId) : null;
  const model = revision?.model ?? null;
  const session = (model?.session?.diagnostics ?? []).map(item => ({ code: item.code, message: item.message }));
  const pagina = (model?.pages ?? []).flatMap(page => (page.diagnostics ?? []).map(item => ({ code: item.code, message: item.message })));
  return { status: latest?.status ?? null, failureCode: latest?.failureCode ?? null, message: latest?.message ?? null, session, pagina };
})()`;

for (const gatilho of Object.keys(GATILHOS)) {
  test(`página atual que se recarrega por ${gatilho} conclui com resultado e sem perder os sinais`, { timeout: ORCAMENTO_MS * 2 }, async t => {
    const chromeBinary = resolveRealChromeTestBinary();
    assert.ok(chromeBinary, 'AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório para este E2E real.');
    const fixture = await startFixtureServer(t, new Map([
      ['/viva', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: documento(gatilho) }],
      ['/img.png', { status: 200, headers: { 'content-type': 'image/png' }, body: PNG_1PX }],
      ['/outra', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Outra</title></head><body><h1>Outra</h1></body></html>' }],
    ]));
    const extension = await launchUnpackedExtension(t, {
      extensionPath: RAIZ, startUrl: `${fixture.origin}/viva`, chromeBinary, expectedMajor: 152,
      viewport: { width: 1280, height: 900 }, downloadMode: 'profile',
    });
    try {
      const panel = await extension.openSidePanelFromAction();
      await panel.command('Page.bringToFront');
      await extension.waitForValue(panel, `(() => {
        const botao = document.querySelector('button[data-intent="START_ATTACHED"]');
        return { botao: Boolean(botao), desabilitado: botao?.disabled ?? null,
          nota: document.querySelector('.availability-note')?.textContent ?? '' };
      })()`, value => value?.botao === true, { timeoutMs: 30_000, intervalMs: 100 });
      const startavel = await extension.evaluate(panel, `(() => {
        const botao = document.querySelector('button[data-intent="START_ATTACHED"]');
        return { desabilitado: botao?.disabled ?? null, nota: document.querySelector('.availability-note')?.textContent ?? '' };
      })()`);
      assert.equal(startavel?.desabilitado, false, `a auditoria nem pôde começar: ${JSON.stringify(startavel)}`);
      await extension.click(panel, `input[data-capture-mode="full-evidence"]`);
      await new Promise(resolve => setTimeout(resolve, 400));
      await extension.click(panel, 'button[data-intent="START_ATTACHED"]');

      const inicio = Date.now();
      let desfecho = null;
      const telas = [];
      while (Date.now() - inicio < ORCAMENTO_MS) {
        desfecho = await extension.evaluate(panel, LEITURA_PAINEL).catch(() => null);
        if (desfecho && desfecho.tela !== telas.at(-1)?.tela) telas.push(desfecho);
        if (desfecho?.tela === 'result' || desfecho?.tela === 'unavailable' || desfecho?.tela === 'initial') break;
        if (desfecho?.sessao === 'privacy-paused') await extension.click(panel, '[data-action="confirm-pixel-capture"]');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      const decorridoMs = Date.now() - inicio;
      const geracaoNoFim = await extension.evaluate(extension.startPage.page, 'window.__auditaGeracao ?? null').catch(() => null);
      const modelo = await extension.evaluate(extension.harnessPage, LEITURA_MODELO, { awaitPromise: true })
        .catch(error => ({ erro: String(error?.code ?? error) }));
      t.diagnostic(`gatilho=${gatilho} ${JSON.stringify({ decorridoMs, geracaoNoFim, desfecho, telas, modelo })}`);

      // 1. A auditoria da página que se recarrega sozinha termina com resultado — não como interrompida.
      assert.equal(desfecho?.tela, 'result', `sem resultado em ${decorridoMs} ms: ${JSON.stringify({ desfecho, telas, modelo })}`);
      assert.ok(['complete', 'partial'].includes(modelo?.status), JSON.stringify(modelo));
      assert.equal(modelo?.failureCode, null, JSON.stringify(modelo));
      // 2. O diagnóstico informa, em linguagem simples, que a navegação da própria página foi segurada.
      const diagnosticos = [...(modelo?.session ?? []), ...(modelo?.pagina ?? [])];
      const segurado = diagnosticos.filter(item => item.code === 'PAGE_NAVIGATION_HELD');
      assert.ok(segurado.length >= 1, `o congelamento não foi registrado: ${JSON.stringify(modelo)}`);
      assert.equal(segurado[0].message,
        'A página tentou recarregar ou navegar sozinha durante a auditoria; a navegação foi segurada até o fim para que o resultado corresponda à página analisada.');

      // 3. Depois da auditoria a recarga volta a funcionar: é a prova de que o Fetch foi desabilitado no fim.
      // A página do temporizador se recarrega sozinha assim que o congelamento solta; a do meta refresh
      // dispara uma vez só por documento, então a recarga é pedida explicitamente.
      assert.ok(Number.isSafeInteger(geracaoNoFim), `não foi possível ler a geração da página: ${JSON.stringify(geracaoNoFim)}`);
      const lerGeracao = () => extension.evaluate(extension.startPage.page, 'window.__auditaGeracao ?? null')
        .then(value => (Number.isSafeInteger(value) ? value : null)).catch(() => null);
      const esperarRecarga = async (limiteMs, { forcar = false } = {}) => {
        if (forcar) await extension.evaluate(extension.startPage.page, 'location.reload(), true').catch(() => null);
        let atual = await lerGeracao();
        for (const limite = Date.now() + limiteMs; Date.now() < limite && !(atual > geracaoNoFim);) {
          await new Promise(resolve => setTimeout(resolve, 250));
          const lido = await lerGeracao();
          if (lido !== null) atual = lido;
        }
        return atual;
      };
      let depois = await esperarRecarga(10_000);
      if (!(depois > geracaoNoFim)) depois = await esperarRecarga(20_000, { forcar: true });
      t.diagnostic(`gatilho=${gatilho} recargaDepoisDaAuditoria geracao=${geracaoNoFim}->${depois}`);
      assert.ok(depois > geracaoNoFim,
        `a página não conseguiu recarregar depois da auditoria (geração ${geracaoNoFim} -> ${depois}): a interceptação sobrou`);
    } finally {
      await extension.close();
    }
  });
}
