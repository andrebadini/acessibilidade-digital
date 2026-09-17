import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, launchUnpackedExtension, resolveRealChromeTestBinary, evaluate } from './support/real-chrome.mjs';

// COBERTURA DE NOME EM CAMPO CUSTOMIZADO, com a fronteira de privacidade medida no Chrome real. O nó de
// texto privado (`div[role=textbox][contenteditable=true]`) perdia o nome acessível INTEIRO na redação,
// inclusive quando ele vem de DECLARAÇÃO do autor — e o efeito era o item 5.13.10 ficar `cantTell` sem
// alvo para um componente SEM NOME NENHUM, indistinguível de "nome não coletado". A correção preserva:
// nome vazio (a vazio não carrega informação) e nome cujo valor vencedor vem de fonte declarada, e NUNCA
// nome vindo do CONTEÚDO do campo. Este arquivo fixa os cinco desfechos, incluindo o caso em que a
// privacidade RETÉM o nome — que precisa continuar sem afirmação.

const raiz = new URL('../../', import.meta.url);
const pagina = (corpo, titulo) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${titulo}</title></head>
<body><main><h1>${titulo}</h1>${corpo}</main></body></html>`;

const CASOS = [
  ['campo customizado sem nome', '<div role="textbox" contenteditable="true" aria-label=""></div>', 'failed', 1],
  ['campo customizado sem declaração de nome', '<div role="textbox" contenteditable="true"></div>', 'failed', 1],
  ['campo customizado nomeado por elemento declarado',
    '<span id="rot">Nome</span><div role="textbox" contenteditable="true" aria-labelledby="rot"></div>', 'passed', 0],
  ['campo customizado com nome retido por privacidade',
    '<div id="priv" contenteditable="true">rascunho</div><div role="textbox" contenteditable="true" aria-labelledby="priv"></div>', 'cantTell', 0],
  ['botão nativo sem nome', '<button id="b"></button>', 'failed', 1],
];

for (const [nome, corpo, esperado, alvos] of CASOS) {
  test(`nome acessível em ${nome}`, { timeout: 600_000 }, async t => {
    const fixture = await startFixtureServer(t, new Map([
      ['/p', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: pagina(corpo, nome) }],
    ]));
    const extension = await launchUnpackedExtension(t, {
      extensionPath: await realpath(fileURLToPath(raiz)),
      startUrl: `${fixture.origin}/p`,
      chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
      viewport: { width: 1280, height: 900 }, downloadMode: 'profile',
    });
    const panel = await extension.openSidePanelFromAction();
    await panel.command('Page.bringToFront');
    await evaluate(panel, `new Promise(resolve => {
      const timer = setInterval(() => {
        const input = document.querySelector('input[data-capture-mode="no-pixels"]');
        const start = document.querySelector('button[data-intent="START_ATTACHED"]');
        if (input && !input.disabled && start && !start.disabled) { clearInterval(timer); resolve(true); }
      }, 100);
    })`, { awaitPromise: true });
    await extension.click(panel, 'input[data-capture-mode="no-pixels"]');
    await extension.click(panel, 'button[data-intent="START_ATTACHED"]');
    let screen = null;
    for (let attempt = 0; attempt < 120 && screen !== 'result'; attempt += 1) {
      screen = await evaluate(panel, `document.querySelector('[data-screen]')?.dataset.screen ?? null`).catch(() => null);
      if (screen !== 'result') await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(screen, 'result');
    const auditId = await extension.readAttribute(panel, '[data-screen="result"]', 'data-audit-id');
    const bruto = await evaluate(extension.harnessPage, `import(chrome.runtime.getURL('/src/storage/audit-store.js')).then(async module => {
      const store = module.createAuditStore();
      const snapshot = await store.getAuditSnapshot(${JSON.stringify(auditId)});
      const model = snapshot.model ?? snapshot.snapshot ?? snapshot;
      const regra = (model.ruleResults ?? []).find(entry => entry.ruleId === 'accessible-component-name');
      const item = (model.itemResults ?? []).find(entry => entry.id === '5.13.10');
      return JSON.stringify({
        outcome: regra?.outcome ?? null, targets: (regra?.targets ?? []).length,
        motivos: [...new Set((regra?.targets ?? []).map(target => target.data?.reason ?? null))],
        item: item?.outcome ?? null,
      });
    })`, { awaitPromise: true });
    const resultado = JSON.parse(bruto);
    t.diagnostic(`${nome}: regra=${resultado.outcome} alvos=${resultado.targets} item=${resultado.item}`);
    assert.equal(resultado.outcome, esperado, `desfecho da regra em "${nome}"`);
    assert.equal(resultado.targets, alvos, `número de alvos em "${nome}"`);
    if (esperado === 'failed') assert.deepEqual(resultado.motivos, ['missing-accessible-name']);
    assert.equal(resultado.item, esperado === 'passed' ? 'passed' : esperado);
    await extension.close();
  });
}
