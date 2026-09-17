import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, launchUnpackedExtension, resolveRealChromeTestBinary, evaluate, waitForValue, waitForFourDownloads } from './support/real-chrome.mjs';

// RÓTULO DE CREDENCIAL NO IDENTIFICADOR DO ELEMENTO (`id`/`class`), com o valor no TEXTO do mesmo
// elemento ou num atributo que carrega valor. É o Important I-1 da revisão independente da 1.1.40, que
// mediu `<div id="senhaassinatura">borboleta</div>` chegando ao modelo, ao HTML e ao JSON — idêntico na
// 1.1.39. O vocabulário de identificador era fechado de propósito (para não destruir `pintura.png`), e o
// preço era a cauda fora da lista invisível nessa posição. Aqui a prova é nos ARTEFATOS ENTREGUES, não
// na unidade: a mesma fixture, uma por página, com o valor conferido antes (não vacuidade) e depois.
const CASOS = [
  ['id com texto', 'id-text', (valor) => `<div id="senhaassinatura">${valor}</div>`, valor => valor],
  ['id com atributo de valor', 'id-attribute', () => '<div id="chavepix" title="girassol">Texto innocuo.</div>', () => 'girassol'],
  ['classe com texto', 'class-text', (valor) => `<div class="senhaassinatura">${valor}</div>`, valor => valor],
];

// CONTROLES NEGATIVOS: as famílias de palavra da língua medidas (morfologia PT) continuam evidência, na
// mesma posição de identificador e na prosa. Sem estes, o teste não distingue tarjar de destruir.
const CONTROLES = [
  ['id de palavra legítima', 'control-id', '<div id="chaveiro">R$ 30,00</div>', 'R$ 30,00'],
  ['classe de palavra legítima', 'control-class', '<div class="pinturas">látex acrílico</div>', 'látex acrílico'],
  ['prosa com morfologia', 'control-prose', '<p>A loja vende chaveiros personalizados.</p>', 'chaveiros personalizados'],
];

async function percurso(t, html, { exportar }) {
  const documento = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Identificador</title>
<style>body{margin:0;font:16px system-ui}</style></head><body><main><h1>Identificador</h1>${html}
<img id="missing-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
</main></body></html>`;
  const fixture = await startFixtureServer(t, new Map([
    ['/ident', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: documento }],
  ]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/ident`,
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
  if (exportar) {
    await waitForValue(report, `Boolean(document.querySelector('button[data-report-export]'))`, value => value === true, { timeoutMs: 30_000 });
    await extension.click(report, 'button[data-report-export]');
    const downloads = await waitForFourDownloads(extension, { auditId, timeoutMs: 120_000, intervalMs: 250 });
    assert.equal(downloads.every(record => record.state === 'complete'), true);
    for (const name of await readdir(extension.downloadDirectory)) {
      const extensao = name.split('.').at(-1);
      if (!['html', 'json', 'csv'].includes(extensao)) continue;
      superficies[`artefato ${extensao}`] = (await readFile(`${extension.downloadDirectory}/${name}`)).toString('utf8');
    }
  }
  return { extension, panel, superficies, cru };
}

for (const [nome, slug, montar, valorDe] of CASOS) {
  test(`rótulo no identificador não entrega o valor vizinho — ${nome}`, { timeout: 300_000 }, async t => {
    const valor = 'borboleta';
    const segredo = valorDe(valor);
    const { extension, superficies, cru } = await percurso(t, montar(valor), { exportar: true });
    try {
      // Não vacuidade: a fixture PRECISA conter o valor antes da varredura.
      assert.ok(cru.includes(segredo), `a fixture de "${slug}" precisa conter o valor`);
      const vazou = Object.entries(superficies).filter(([, texto]) => texto.includes(segredo)).map(([superficie]) => superficie);
      t.diagnostic(`caso="${slug}" superfícies=${Object.keys(superficies).length}`);
      assert.deepEqual(vazou, [], `o valor de "${nome}" chegou a: ${vazou.join(', ')}`);
    } finally { await extension.close(); }
  });
}

for (const [nome, slug, html, esperado] of CONTROLES) {
  test(`controle negativo: ${nome} continua na evidência`, { timeout: 300_000 }, async t => {
    const { extension, superficies, cru } = await percurso(t, html, { exportar: true });
    try {
      assert.ok(cru.includes(esperado), `a fixture de "${slug}" precisa conter a evidência`);
      const superficiesComEvidencia = Object.entries(superficies)
        .filter(([, texto]) => texto.includes(esperado)).map(([superficie]) => superficie);
      t.diagnostic(`controle="${slug}" com evidência em: ${superficiesComEvidencia.join(', ') || '(nenhuma)'}`);
      assert.ok(superficiesComEvidencia.length > 0, `a evidência de "${nome}" precisa sobreviver em alguma superfície entregue`);
    } finally { await extension.close(); }
  });
}
