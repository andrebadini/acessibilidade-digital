import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, launchUnpackedExtension, resolveRealChromeTestBinary, evaluate } from './support/real-chrome.mjs';

// O PRODUTO SOB O PRÓPRIO INSTRUMENTO. O Audita audita páginas com o axe-core vendorizado, mas ninguém
// tinha rodado o axe nas SUPERFÍCIES DO PRÓPRIO PRODUTO — e a primeira medição (rodada 83) achou um
// atributo proibido no relatório em aba: `aria-label` em `div` genérico do agrupador de filtros. Este
// arquivo é a guarda permanente: painel (tela inicial e tela de resultado) e relatório em aba própria,
// medidos no Chrome real com a MESMA versão do axe que o produto usa (4.13.0).
//
// Política de asserção, declarada: ZERO violações em qualquer superfície; `incomplete` só é aceito para
// `color-contrast` no `<text>` do gráfico de rosca — o axe não consegue determinar o fundo de um texto SVG
// sobreposto pelo anel. O contraste do texto do gráfico foi medido por fora (fórmula WCAG): `#003b71`
// contra as três superfícies possíveis do cartão dá 11,27:1 (branco), 10,16:1 (`#eef4f8`) e 10,07:1
// (`#edf3f7`) — acima de 4,5:1 e de 3:1 para texto grande, então a pendência é do instrumento, não do
// artefato. Qualquer OUTRO id em `incomplete` reprova.

const axeSource = await readFile(new URL('../../vendor/axe/axe.js', import.meta.url), 'utf8');

const DOCUMENTO = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Fixture</title></head>
<body><main><h1>Página com defeitos conhecidos</h1>
<img id="sem-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
<button id="sem-nome"></button>
<input id="sem-rotulo" type="text">
</main></body></html>`;

const ROTULOS = { 'PAINEL-INICIAL': 'painel, tela inicial', 'PAINEL-RESULTADO': 'painel, tela de resultado', 'RELATORIO-ABA': 'relatório em aba própria' };

async function medir(target, rotulo, t) {
  // O script do axe termina numa expressão sem valor; `evaluate` exige um valor serializável de volta.
  assert.equal(await evaluate(target, `${axeSource}\n;true`), true);
  const resultado = await evaluate(target, `(async () => {
    const r = await window.axe.run(document, {
      resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice'] },
    });
    return {
      versao: window.axe.version,
      violacoes: r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, alvo: v.nodes.slice(0, 3).map(n => n.target.join(' ')) })),
      incompletos: r.incomplete.map(v => ({ id: v.id, nodes: v.nodes.length, alvo: v.nodes.slice(0, 2).map(n => n.target.join(' ')) })),
      aprovados: r.passes.length,
    };
  })()`, { awaitPromise: true });
  t.diagnostic(`${rotulo}: axe=${resultado.versao} violações=${resultado.violacoes.length} incompletos=${resultado.incompletos.length} aprovados=${resultado.aprovados}`);
  assert.deepEqual(resultado.violacoes, [], `violações de acessibilidade em ${ROTULOS[rotulo] ?? rotulo}`);
  const inesperados = resultado.incompletos.filter(item => item.id !== 'color-contrast');
  assert.deepEqual(inesperados, [], `pendências de instrumento não declaradas em ${ROTULOS[rotulo] ?? rotulo}`);
  for (const item of resultado.incompletos) {
    assert.deepEqual(item.alvo, ['text'], 'a única pendência de contraste aceita é o texto do gráfico de rosca');
  }
  return resultado;
}

test('painel e relatório do próprio produto passam o axe vendorizado sem violação', { timeout: 600_000 }, async t => {
  assert.match(axeSource, /axe/iu, 'o axe vendorizado precisa estar disponível para a medição');
  const fixture = await startFixtureServer(t, new Map([
    ['/pagina', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: DOCUMENTO }],
  ]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/pagina`,
    chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
    viewport: { width: 1280, height: 900 }, downloadMode: 'profile',
  });
  const panel = await extension.openSidePanelFromAction();
  await panel.command('Page.bringToFront');
  await evaluate(panel, `new Promise(resolve => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') { clearInterval(timer); resolve(true); }
    }, 100);
  })`, { awaitPromise: true });
  await evaluate(panel, `new Promise(resolve => {
    const timer = setInterval(() => {
      const input = document.querySelector('input[data-capture-mode="no-pixels"]');
      const botao = document.querySelector('button[data-intent="START_ATTACHED"]');
      if (input && !input.disabled && botao && !botao.disabled) { clearInterval(timer); resolve(true); }
    }, 100);
  })`, { awaitPromise: true });
  await medir(panel, 'PAINEL-INICIAL', t);

  await extension.click(panel, 'input[data-capture-mode="no-pixels"]');
  await extension.click(panel, 'button[data-intent="START_ATTACHED"]');
  let tela = null;
  for (let attempt = 0; attempt < 120 && tela !== 'result'; attempt += 1) {
    tela = await evaluate(panel, `document.querySelector('[data-screen]')?.dataset.screen ?? null`).catch(() => null);
    if (tela !== 'result') await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(tela, 'result', 'a auditoria precisa concluir para medir a tela de resultado');
  // A tela de resultado precisa estar ASSENTADA: a medição anterior pegou o painel no meio da troca de
  // tela e o axe devolveu `heading-order` por não ver o `h1` ainda. Aqui espera-se o `h1` visível.
  await evaluate(panel, `new Promise(resolve => {
    const timer = setInterval(() => {
      const h1 = [...document.querySelectorAll('h1')].find(node => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      });
      if (h1) { clearInterval(timer); resolve(true); }
    }, 100);
  })`, { awaitPromise: true });
  await medir(panel, 'PAINEL-RESULTADO', t);

  const auditId = await extension.readAttribute(panel, '[data-screen="result"]', 'data-audit-id');
  assert.match(auditId ?? '', /^[A-Za-z0-9._:-]{1,160}$/u);
  await extension.click(panel, 'button[data-intent="OPEN_REPORT"]');
  const report = await extension.waitForReport({ auditId });
  await evaluate(report, `new Promise(resolve => {
    const timer = setInterval(() => {
      if (document.querySelector('[data-report-navigation]')) { clearInterval(timer); resolve(true); }
    }, 100);
  })`, { awaitPromise: true });
  const medicaoRelatorio = await medir(report, 'RELATORIO-ABA', t);
  // Não vacuidade: a medição precisa ter examinado regras de verdade.
  assert.ok(medicaoRelatorio.aprovados > 20, `o axe aprovou poucas regras: ${medicaoRelatorio.aprovados}`);
  await extension.close();
});
