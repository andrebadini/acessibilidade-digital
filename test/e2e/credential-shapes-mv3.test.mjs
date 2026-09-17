import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, launchUnpackedExtension, resolveRealChromeTestBinary, evaluate, waitForValue, waitForFourDownloads } from './support/real-chrome.mjs';

// UMA FORMA POR PÁGINA, e o motivo é de método: no teste de exportação todas as formas convivem no mesmo
// contêiner, e a marcação por conteúdo é monotônica — a primeira credencial reconhecida tarja o resto do
// trecho e **mascara** as formas seguintes. Com uma forma por página não há crédito anterior para
// mascará-la, e a mutação que restaura os sanitizadores de uma geração anterior volta a reprovar (foi
// assim que a revisão da 1.1.31 mostrou que a não vacuidade daquele teste era falsa para o incremento).
const SHAPES = [
  ['rótulo acentuado de duas palavras', 'accented-label', (secret) => `<p>Cartão de crédito: ${secret}</p>`],
  ['janela de quatro palavras', 'four-word-window', (secret) => `<p>Número do cartão de crédito do titular: ${secret}</p>`],
  ['rótulo com parênteses', 'parenthetical', (secret) => `<p>Senha (provisória): ${secret}</p>`],
  ['forma qualificada em português', 'qualified-pt', (secret) => `<p>Código de verificação: ${secret}</p>`],
  ['cauda sem separador', 'tail', (secret) => `<p>cartão de crédito ${secret}</p>`],
  ['atributo no seletor', 'selector-attribute', (secret) => `<input id="alvo" title="senha ${secret}">`],
  // Formas do Critical da 1.1.32 (vocabulário de cartão e boleto), medidas aqui para terem prova nos
  // artefatos entregues e não só na unidade: são as duas que a revisão viu chegando inteiras.
  ['CVV do cartão', 'card-cvv', (secret) => `<p>CVV: ${secret}</p>`],
  ['linha digitável do boleto', 'boleto-linha', (secret) => `<p>Linha digitável: ${secret}</p>`],
];

for (const [nome, slug, montar] of SHAPES) {
  test(`credencial em ${nome} não chega ao entregável`, { timeout: 300_000 }, async t => {
    // O sentinela precisa ter CARA DE CREDENCIAL (dígito), e não só ser comprido: a regra de cauda de
    // rótulo multi-palavra exige 6+ caracteres COM dígito ou símbolo, justamente para não tarjar palavra
    // comprida de prosa. Um sentinela só de letras não é uma credencial plausível e mediria a regra errada.
    const secret = `ADVSHAPE${slug.replace(/[^a-z]/gu, '').toUpperCase().slice(0, 8)}7X`;
    const documento = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${nome}</title></head>
<body><main><h1>Forma isolada</h1>${montar(secret)}
<img id="missing-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
</main></body></html>`;
    const fixture = await startFixtureServer(t, new Map([
      ['/shapes', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: documento }],
    ]));
    const extension = await launchUnpackedExtension(t, {
      extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
      startUrl: `${fixture.origin}/shapes`,
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
    // Não vacuidade: a página precisa CONTER a credencial antes de a varredura valer.
    const cru = await evaluate(extension.startPage.page, 'document.documentElement.outerHTML');
    assert.ok(cru.includes(secret), `a fixture de "${nome}" precisa conter o sentinela`);
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
    const vazou = Object.entries(superficies).filter(([, texto]) => texto.includes(secret)).map(([superficie]) => superficie);
    t.diagnostic(`forma="${slug}" superfícies=${Object.keys(superficies).length}`);
    assert.deepEqual(vazou, [], `a credencial de "${nome}" chegou a: ${vazou.join(', ')}`);
    await extension.close();
  });
}
