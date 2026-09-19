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
  // Formas do Critical da 1.1.33: a fronteira de palavra que fechou o falso positivo de "shipping"
  // devolveu à página as compostas em que `pin` é o SEGUNDO componente colado (`userPin`, `cardPin`,
  // `userpin`) ou o primeiro de um composto (`PINpad`), inclusive em nome de atributo (`data-userpin`).
  // Sem estas quatro, a suíte de formas passava 8/8 dos DOIS lados da mutação — prova sem dentes.
  ['PIN prefixado em camelCase', 'user-pin', (secret) => `<p>userPin: ${secret}</p>`],
  ['PIN prefixado no cartão', 'card-pin', (secret) => `<p>cardPin: ${secret}</p>`],
  ['PIN prefixado minúsculo', 'userpin-lower', (secret) => `<p>userpin: ${secret}</p>`],
  ['PIN em composto maiúsculo', 'pin-pad', (secret) => `<p>PINpad: ${secret}</p>`],
  ['PIN em nome de atributo', 'data-userpin', (secret) => `<div data-userpin="${secret}">x</div>`],
  // Formas que a revisão da 1.1.36 mediu SEM prova: o portão de valor só era exercitado por sentinela
  // COM dígito, e nenhuma forma tinha separador `_`/`.`/`/`. Com o `src` da 1.1.35 estes cinco casos
  // reprovam (é o que dá dentes ao portão de valor e à continuação de identificador).
  ['valor só de letras em rótulo colado', 'letters-only', (secret) => `<p>novaSenha: ${secret}</p>`, 'letters'],
  ['frase-senha longa em rótulo colado', 'passphrase', (secret) => `<p>novaSenha: ${secret}</p>`, 'phrase'],
  ['radical no meio do token', 'middle-stem', (secret) => `<p>minhasenhaforte: ${secret}</p>`],
  ['composto de três partes', 'three-parts', (secret) => `<p>novasenhaadmin: ${secret}</p>`],
  ['separador sublinhado', 'underscore', (secret) => `<p>senha_forte: ${secret}</p>`],
  ['separador ponto', 'dot-separator', (secret) => `<p>senha.mestra: ${secret}</p>`],
  // Formas do Critical C1 e do Critical C2 da revisão da 1.1.37, medidas nos artefatos entregues: caixa
  // misturada DENTRO do radical (regressão da geração, que as 1.1.33/1.1.35/1.1.36 tarjavam) e PREFIXO
  // ARBITRÁRIO antes do radical (o eixo que a lista fechada não cobria). O valor é FRACO de propósito —
  // o sentinela com dígito de doze caracteres passava pelo portão de valor e por isso não provava nada.
  ['caixa misturada no radical', 'mixed-case', (secret) => `<p>SeNhA: ${secret}</p>`, 'weak'],
  ['caixa misturada com frase', 'mixed-case-phrase', (secret) => `<p>SeNhA do usuário: ${secret}</p>`, 'weak-letters'],
  ['prefixo arbitrário sem dígito', 'arbitrary-prefix', (secret) => `<p>xsenha: ${secret}</p>`, 'weak-letters'],
  ['prefixo arbitrário com cauda', 'arbitrary-prefix-tail', (secret) => `<p>xsenhaforte: ${secret}</p>`, 'weak'],
];

for (const [nome, slug, montar, tipo = 'digit'] of SHAPES) {
  test(`credencial em ${nome} não chega ao entregável`, { timeout: 480_000 }, async t => {
    // O sentinela padrão tem CARA DE CREDENCIAL (dígito) — é o formato que a regra de cauda de rótulo
    // multi-palavra exige. Os tipos `letters`, `phrase` e `weak` existem porque a revisão da 1.1.36 mediu
    // que SÓ o sentinela com dígito deixava o portão de valor sem prova: uma frase-senha de 25 letras
    // (`correcthorsebatterystaple`), um identificador só de letras e a senha fraca mais comum de um
    // formulário real (`abc123`, medida vazando pela revisão da 1.1.37) precisam ser medidos.
    const marca = slug.replace(/[^a-z]/gu, '').toUpperCase();
    const secret = {
      // `abc123` e `passarinho` são as duas senhas fracas que a revisão da 1.1.37 mediu vazando: valor
      // curto com dígito e senha de 5 a 11 letras SEM dígito. Com o `src` da geração anterior elas
      // chegam ao entregável — é o que dá dentes a estas formas.
      weak: 'abc123',
      'weak-letters': 'passarinho',
      letters: `Zqwkvbrtnmx${marca.slice(0, 6).toLowerCase()}`,
      phrase: 'correcthorsebatterystaple',
    }[tipo] ?? `ADVSHAPE${marca.slice(0, 8)}7X`;
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
    // O orçamento era 120 s e a medição de 18/09 mostrou que ele é curto para a carga BASAL desta máquina
    // (não para dois Chromes: 6 de 23 formas estouraram numa janela exclusiva, ~22 %, enquanto outras
    // passagens fechavam 23/23 em 77 s). Os outros arquivos de exportação já usam 300 s pelo mesmo motivo
    // (`public-axe-map`, `url-audit`, `batch-pixel-consent`, `mandatory-journey`). A asserção não mudou:
    // continua exigindo os quatro downloads completos e conferidos.
    let downloads;
    try {
      downloads = await waitForFourDownloads(extension, { auditId, timeoutMs: 300_000, intervalMs: 250 });
    } catch (cause) {
      // Diagnóstico sem conteúdo (nem modelo, nem URL, nem IDs privados): separa "a exportação travou" de
      // "o download demorou mais que o orçamento", que era impossível distinguir com o erro fixo.
      const snapshot = await evaluate(extension.harnessPage, `(async () => {
        const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
        const receipt=await store.getExportReceipt(${JSON.stringify(auditId)});
        const latest=await store.getLatest();
        const statuses=['running','preparing','delivering','complete','partial','failed'];
        const launchStates=['allocated','awaiting-connection','connected','terminal','revoked'];
        const rows=Object.values(await chrome.storage.session.get(null)).filter(row=>row?.auditId===${JSON.stringify(auditId)});
        return {
          receipt:statuses.includes(receipt?.status)?receipt.status:null,
          completed:['html','pdf','csv','json'].filter(format=>
            receipt?.formats?.some(item=>item.format===format&&item.state==='complete')),
          exportState:latest?.auditId===${JSON.stringify(auditId)}&&statuses.includes(latest?.exportStatus)?latest.exportStatus:null,
          exportLaunchStates:rows.filter(row=>row?.path==='/src/export/index.html')
            .map(row=>launchStates.includes(row.state)?row.state:'other'),
        };
      })()`, { awaitPromise: true }).catch(() => null);
      throw new Error(`EXPORT_DELIVERY_SNAPSHOT:${JSON.stringify(snapshot)}`, { cause });
    }
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
