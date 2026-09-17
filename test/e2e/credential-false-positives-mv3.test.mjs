import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, launchUnpackedExtension, resolveRealChromeTestBinary, evaluate, waitForValue, waitForFourDownloads } from './support/real-chrome.mjs';

// CONTROLE DE FALSO POSITIVO, uma frase por página, com CONTROLE NEGATIVO NA MESMA PÁGINA.
//
// A revisão da 1.1.33 mediu que o vocabulário que casa substring destruía EVIDÊNCIA nas superfícies
// entregues: `Chaveiro: R$ 30,00` e `Secretaria de Saúde: 12 unidades` viravam tarja (a palavra contém o
// radical `chave`/`secret`), a prosa com data longa era tarjada inteira, e um `placeholder="Chaveiro"`
// legítimo era descartado — o campo chegava ao relatório sem o nome acessível.
//
// O teste é o portão do outro lado da fronteira, e é deliberadamente assimétrico ao teste de formas: lá o
// alvo NÃO pode aparecer nas superfícies, aqui ele PRECISA aparecer. Cada página carrega também uma frase
// de controle sem radical: se o controle não chegar a nenhuma superfície, o teste reprova como vacuoso —
// sem isso, "o alvo não apareceu" poderia significar apenas que a página não foi medida.
const CONTROLE = 'Fatura: R$ 30,00';
const CASOS = [
  ['palavra da língua com o radical "chave"', 'chaveiro', 'Chaveiro: R$ 30,00'],
  ['palavra da língua com o radical "secret"', 'secretaria', 'Secretaria de Saúde: 12 unidades'],
  ['prosa com data de quatro dígitos', 'data-longa', 'A senha foi alterada em 12/03/2026 pelo administrador.'],
  ['palavra terminada em "pin" composta', 'hairpin', 'Hairpin: curva fechada'],
];

for (const [nome, slug, alvo] of CASOS) {
  test(`falso positivo em ${nome} não destrói a evidência entregue`, { timeout: 300_000 }, async t => {
    const documento = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${nome}</title></head>
<body><main><h1>Controle de falso positivo</h1><p id="controle">${CONTROLE}</p><p id="alvo">${alvo}</p>
<input id="rotulo" placeholder="Chaveiro de latão" aria-label="Fatura">
<img id="missing-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
</main></body></html>`;
    const fixture = await startFixtureServer(t, new Map([
      ['/controle', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: documento }],
    ]));
    const extension = await launchUnpackedExtension(t, {
      extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
      startUrl: `${fixture.origin}/controle`,
      chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
      viewport: { width: 1280, height: 900 }, downloadMode: 'profile',
    });
    const panel = await extension.openSidePanelFromAction();
    await panel.command('Page.bringToFront');
    await waitForValue(panel, 'document.visibilityState', value => value === 'visible', { timeoutMs: 10_000 });
    await waitForValue(panel, `(() => {
      const input=document.querySelector('input[data-capture-mode="no-pixels"]');
      const button=document.querySelector('button[data-intent="START_ATTACHED"]');
      return Boolean(input&&!input.disabled&&button&&!button.disabled);
    })()`, value => value === true, { timeoutMs: 30_000, intervalMs: 50 });
    const cru = await evaluate(extension.startPage.page, 'document.documentElement.outerHTML');
    assert.ok(cru.includes(alvo) && cru.includes(CONTROLE), `a fixture de "${nome}" precisa conter alvo e controle`);
    await extension.click(panel, 'input[data-capture-mode="no-pixels"]');
    await extension.click(panel, 'button[data-intent="START_ATTACHED"]');
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const screen = await evaluate(panel, `document.querySelector('[data-screen]')?.dataset.screen ?? null`).catch(() => null);
      if (screen === 'result') break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const auditId = await extension.readAttribute(panel, '[data-screen="result"]', 'data-audit-id');
    assert.match(auditId ?? '', /^[A-Za-z0-9._:-]{1,160}$/u);
    await extension.click(panel, 'button[data-intent="OPEN_REPORT"]');
    const report = await extension.waitForReport({ auditId });
    await waitForValue(report, `Boolean(document.querySelector('button[data-report-export]'))`, value => value === true, { timeoutMs: 30_000 });
    await extension.click(report, 'button[data-report-export]');
    const downloads = await waitForFourDownloads(extension, { auditId, timeoutMs: 120_000, intervalMs: 250 });
    assert.equal(downloads.every(record => record.state === 'complete'), true);
    const superficies = {
      painel: await evaluate(panel, 'document.documentElement.outerHTML'),
      relatório: await evaluate(report, 'document.documentElement.outerHTML'),
      'modelo e revisão guardados': await evaluate(extension.harnessPage, `import(chrome.runtime.getURL('/src/storage/audit-store.js'))
        .then(async module => {
          const store = module.createAuditStore();
          const [snapshot, revision] = await Promise.all([
            store.getAuditSnapshot(${JSON.stringify(auditId)}), store.getReportRevision(${JSON.stringify(auditId)}),
          ]);
          return JSON.stringify({ snapshot, revision });
        })`, { awaitPromise: true }),
    };
    const directory = extension.downloadDirectory;
    for (const name of await readdir(directory)) {
      const extensao = name.split('.').at(-1);
      if (!['html', 'json', 'csv'].includes(extensao)) continue;
      superficies[`artefato ${extensao}`] = (await readFile(`${directory}/${name}`)).toString('utf8');
    }
    const comControle = Object.entries(superficies).filter(([, texto]) => texto.includes(CONTROLE)).map(([superficie]) => superficie);
    const comAlvo = Object.entries(superficies).filter(([, texto]) => texto.includes(alvo)).map(([superficie]) => superficie);
    t.diagnostic(`caso="${slug}" superficies=${Object.keys(superficies).length} controle=${comControle.length} alvo=${comAlvo.length}`);
    assert.ok(comControle.length > 0, `o CONTROLE "${CONTROLE}" precisa aparecer em alguma superfície, senão a medição é vacuosa`);
    assert.ok(comAlvo.length > 0,
      `a evidência legítima "${alvo}" foi destruída: aparece no controle (${comControle.join(', ')}) e em nenhuma superfície entregue`);
    await extension.close();
  });
}

test('atributo de rótulo legítimo sobrevive ao lado do rótulo de credencial', { timeout: 300_000 }, async t => {
  // O caso medido pela revisão da 1.1.33: `placeholder="Chaveiro"` era DESCARTADO do trecho (o campo
  // chegava à evidência sem nome acessível), enquanto `placeholder="Fatura"` sobrevivia.
  const documento = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Atributos</title></head>
<body><main><h1>Atributos de rótulo</h1>
<input id="legitimo" placeholder="Chaveiro de latão" aria-label="Fatura do cartão">
<input id="credencial" placeholder="senha ADVFPATTR7X">
<img id="missing-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
</main></body></html>`;
  const fixture = await startFixtureServer(t, new Map([
    ['/atributos', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: documento }],
  ]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/atributos`,
    chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
    viewport: { width: 1280, height: 900 }, downloadMode: 'profile',
  });
  const panel = await extension.openSidePanelFromAction();
  await panel.command('Page.bringToFront');
  await waitForValue(panel, 'document.visibilityState', value => value === 'visible', { timeoutMs: 10_000 });
  await waitForValue(panel, `(() => {
    const input=document.querySelector('input[data-capture-mode="no-pixels"]');
    const button=document.querySelector('button[data-intent="START_ATTACHED"]');
    return Boolean(input&&!input.disabled&&button&&!button.disabled);
  })()`, value => value === true, { timeoutMs: 30_000, intervalMs: 50 });
  await extension.click(panel, 'input[data-capture-mode="no-pixels"]');
  await extension.click(panel, 'button[data-intent="START_ATTACHED"]');
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const screen = await evaluate(panel, `document.querySelector('[data-screen]')?.dataset.screen ?? null`).catch(() => null);
    if (screen === 'result') break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const auditId = await extension.readAttribute(panel, '[data-screen="result"]', 'data-audit-id');
  const modelo = await evaluate(extension.harnessPage, `import(chrome.runtime.getURL('/src/storage/audit-store.js'))
    .then(async module => {
      const store = module.createAuditStore();
      const snapshot = await store.getAuditSnapshot(${JSON.stringify(auditId)});
      return JSON.stringify(snapshot);
    })`, { awaitPromise: true });
  assert.ok(modelo.includes('ADVFPATTR7X') === false, 'a credencial do atributo não pode chegar ao modelo');
  assert.ok(modelo.includes('Chaveiro de latão'), 'o rótulo legítimo precisa sobreviver no modelo');
  assert.ok(modelo.includes('Fatura do cartão'), 'o nome acessível legítimo precisa sobreviver no modelo');
  t.diagnostic('atributos: credencial ausente, rótulo legítimo presente');
  await extension.close();
});
