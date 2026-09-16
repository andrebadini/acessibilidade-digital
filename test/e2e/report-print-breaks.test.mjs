import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { REPORT_CSS } from '../../src/core/report/report.css.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { buildCompleteReportSummary } from '../../src/panel/panel-summary.js';
import { buildReportView } from '../../src/review/report-view.js';
import { createCdpPipeTransport, resolveRealChromeTestBinary, startFixtureServer, terminateChromeProcess } from './support/real-chrome.mjs';

// A folha de impressão dá 8.5 pt à matriz; em px de CSS, 8.5 pt = 11,3333 px.
const PRINT_MATRIX_FONT_PX = 11.3333;
const MATRIX_RULE = '.matrix-scroll td,.matrix-scroll th{overflow-wrap:normal}';
const HEAD_RULE = 'thead th{overflow-wrap:normal}';

// A largura útil NÃO é constante do teste: ela vem do `@page` da própria folha entregue. Fixá-la em
// 680 px fazia o portão medir a emulação, não a caixa de impressão — uma mudança de margem que
// jogasse o conteúdo para fora do papel passaria despercebida (achado N3 da revisão da 1.1.22).
function printContentWidthPx(css) {
  const page = /@page\{([^}]*)\}/u.exec(css);
  assert.ok(page, 'a folha entregue precisa declarar @page');
  const declarations = Object.fromEntries(page[1].split(';').filter(Boolean).map(part => {
    const separator = part.indexOf(':');
    return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }));
  assert.match(declarations.size ?? '', /^A4 portrait$/u, 'o oráculo só sabe medir A4 retrato');
  const parts = String(declarations.margin ?? '').split(/\s+/u).filter(Boolean);
  const sides = parts.length === 1 ? parts[0] : parts[1];
  assert.ok(/^[\d.]+mm$/u.test(sides ?? ''), `margem lateral precisa estar em mm, veio ${sides}`);
  return Math.round((210 - 2 * Number.parseFloat(sides)) / 25.4 * 96);
}
// Compressão determinística: fixa o layout e estreita a coluna da classificação (3ª) para menos que
// a palavra "Recomendação", como o conteúdo real de uma auditoria faz na tabela automática.
// A largura precisa valer também para a primeira linha da tabela: em table-layout:fixed é ela que
// define as colunas (a primeira linha da matriz é o cabeçalho).
const SQUEEZE_MATRIX = '.matrix-scroll table{table-layout:fixed;width:678px}'
  + '.matrix-scroll tr>*:nth-child(3){width:70px}';
// Estreita a coluna do cabeçalho do anexo abaixo da palavra "Evidência".
const SQUEEZE_HEADER = '[data-report-annex] table{table-layout:fixed;width:520px}'
  + '[data-report-annex] thead th:first-child{width:40px}';

/**
 * Mede o comportamento de impressão que a 1.1.21 corrigiu e que nenhum portão cobria: a revisão da
 * 1.1.21 mostrou que remover a regra da matriz e recalcular o hash passava 84/85 testes unitários e
 * 3/3 E2E de impressão/exportação. Aqui a folha entregue é medida na largura real da página e palavra
 * por palavra: uma palavra que ocupa mais de uma caixa de linha foi partida no meio.
 *
 * Os controles positivos rodam no próprio teste (folha sem a regra da matriz, folha sem a regra dos
 * cabeçalhos), com o hash de CSP recalculado como faria um pacote honesto. Sem eles, um detector
 * quebrado passaria para sempre — foi o que aconteceu com o primeiro detector da revisão.
 */
const MEASURE = `(() => {
  const visible = node => {
    for (let current = node; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  const brokenWords = root => {
    if (!root) return [];
    const found = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue;
      const parent = node.parentElement;
      if (!text || !text.trim() || !parent || !visible(parent)) continue;
      const pattern = /\\S+/gu;
      let match;
      while ((match = pattern.exec(text))) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
        if (rects.length > 1) found.push({ word: match[0], tag: parent.tagName });
      }
    }
    return found;
  };
  const matrix = document.querySelector('.matrix-scroll');
  const table = matrix ? matrix.querySelector('table') : null;
  const firstCell = matrix ? matrix.querySelector('tbody td') : null;
  return {
    rows: matrix ? matrix.querySelectorAll('tbody tr').length : 0,
    matrixBroken: brokenWords(matrix),
    headBroken: [...document.querySelectorAll('thead')].flatMap(head => brokenWords(head)),
    annexBroken: brokenWords(document.querySelector('[data-report-annex]')).length,
    documentBroken: brokenWords(document.body).length,
    tableWidth: table ? Math.round(table.getBoundingClientRect().width) : -1,
    contentWidth: document.documentElement.clientWidth,
    matrixFont: firstCell ? getComputedStyle(firstCell).fontSize : 'sem célula',
    printMedia: matchMedia('print').matches,
  };
})()`;

// Muta o CSS entregue mantendo o CSP coerente com o próprio estilo.
const withCss = (html, transform) => {
  const style = /<style>([\s\S]*?)<\/style>/u.exec(html);
  assert.ok(style, 'a folha entregue precisa do bloco de estilo');
  const changed = transform(style[1]);
  assert.notEqual(changed, style[1], 'a mutação precisa alterar o CSS entregue');
  const hash = `sha256-${createHash('sha256').update(changed, 'utf8').digest('base64')}`;
  return html.replace(style[0], `<style>${changed}</style>`).replace(/style-src 'sha256-[^']+'/u, `style-src '${hash}'`);
};

test('printed matrix keeps item labels and words whole at the real page width', { timeout: 90_000 }, async t => {
  const binary = resolveRealChromeTestBinary();
  assert.ok(binary, 'Configure AUDITA_E2E_CHROME for the printed-matrix break test.');
  const inventory = await createInstalledCoreRuleInventory();
  const model = await enrichAuditForReport(structuredClone(SAMPLE_AUDIT), {
    now: () => '2026-09-16T12:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '1.1.22', rulesVersion: inventory.rulesVersion, browserVersion: 'Chrome/152.0.7977.64',
  });
  const checkpoint = { version: 1, auditId: model.auditId, pages: model.pages.map(page => ({
    pageId: page.pageId, attempted: page.attempted, startedAt: page.attempted ? page.timestamps.startedAt : null,
    rulesVersion: inventory.rulesVersion, inventoryVersion: inventory.inventoryVersion, inventoryHash: inventory.sha256,
    outcomes: [{ ruleId: 'focus-fully-visible', outcome: 'passed' }, { ruleId: 'keyboard-focus-trap', outcome: 'untested' }],
  })) };
  const summary = await buildCompleteReportSummary({ model, executionCheckpoint: checkpoint, inventory });
  const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
  const shipped = renderHtmlReport(model, { reportView: view, forPrint: true });
  assert.equal(view.matrix.length, 146);
  assert.ok(shipped.includes(MATRIX_RULE) && shipped.includes(HEAD_RULE),
    'as duas regras de impressão precisam existir na folha entregue');
  const htmlHeaders = { 'content-type': 'text/html;charset=utf-8' };
  // A aba interativa imprime pela PRÓPRIA folha (review.css), não pela do relatório entregue. Ela é
  // medida aqui, na mesma largura de papel e na mesma mídia, porque só este harness discrimina: um
  // E2E de viewport largo passa com e sem a regra — a primeira versão desta guarda era vacuosa
  // (mutação removendo a regra e o teste continuou verde). Achado N2 da revisão da 1.1.22.
  const tabHtml = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">`
    + `<link rel="stylesheet" href="/src/review/review.css"></head><body><main><h1>Relatório de auditoria de acessibilidade</h1>`
    + `<div id="report-root"></div></main><script type="module">import {renderReportView} from '/src/review/report-view.js';`
    + `document.querySelector('#report-root').append(renderReportView({view:${JSON.stringify(view).replace(/</gu, '\\u003c')},document,onExport(){throw Error('EXPORT_NOT_ALLOWED')}}));`
    + `</script></body></html>`;
  const routes = new Map([
    ['/aba', { status: 200, headers: htmlHeaders, body: tabHtml }],
    ['/entregue', { status: 200, headers: htmlHeaders, body: shipped }],
    ['/forcado-com-regra', { status: 200, headers: htmlHeaders, body: withCss(shipped, css => css + SQUEEZE_MATRIX) }],
    ['/forcado-sem-regra', { status: 200, headers: htmlHeaders, body: withCss(shipped, css => css.replace(MATRIX_RULE, '') + SQUEEZE_MATRIX) }],
    ['/cabecalho-comprimido', { status: 200, headers: htmlHeaders,
      body: withCss(shipped, css => css.replace(HEAD_RULE, '') + SQUEEZE_HEADER) }],
  ]);
  for (const path of await readdir(new URL('../../src/', import.meta.url), { recursive: true })) {
    if (!/\.(?:js|css)$/u.test(path)) continue;
    routes.set(`/src/${path}`, { status: 200,
      headers: { 'content-type': path.endsWith('.js') ? 'text/javascript' : 'text/css' },
      body: await readFile(new URL(`../../src/${path}`, import.meta.url), 'utf8') });
  }
  const server = await startFixtureServer(t, routes);

  const directory = await mkdtemp(join(tmpdir(), 'audita-print-breaks-'));
  const child = spawn(binary, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--password-store=basic', '--use-mock-keychain', `--user-data-dir=${join(directory, 'profile')}`,
    '--no-proxy-server', '--remote-debugging-pipe', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const browser = createCdpPipeTransport({ readable: child.stdio[4], writable: child.stdio[3] });
  t.after(async () => { browser.close(); await terminateChromeProcess(child); await rm(directory, { recursive: true, force: true }); });
  const { targetId } = await browser.command('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.command('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params = {}) => browser.command(method, params, { sessionId });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const printContentWidth = printContentWidthPx(REPORT_CSS);
  await command('Emulation.setDeviceMetricsOverride', {
    width: printContentWidth, height: 1200, deviceScaleFactor: 1, mobile: false,
  });
  // `expectedMatrixFont` só existe na folha entregue (8,5 pt); a aba usa a fonte da própria folha,
  // então lá o discriminante de mídia é `printMedia`, não o tamanho da fonte.
  const measure = async (path, { expectedMatrixFont = PRINT_MATRIX_FONT_PX } = {}) => {
    await command('Page.navigate', { url: `${server.origin}${path}` });
    await evaluate(`new Promise((resolve, reject) => { let tries = 0; const check = () => {
      if (document.querySelectorAll('.matrix-scroll tbody tr').length === 146) resolve(true);
      else if (++tries > 1200) reject(Error('MATRIX_NOT_READY')); else setTimeout(check, 25); }; check(); })`);
    // A emulação de mídia não sobrevive à navegação: reaplicar e conferir, senão a medição lê o
    // layout de tela e o "0" vira falso verde.
    await command('Emulation.setEmulatedMedia', { media: 'print' });
    await evaluate('document.fonts.ready.then(() => true)');
    const result = await evaluate(MEASURE);
    assert.equal(result.printMedia, true, `${path}: a folha precisa estar em mídia de impressão`);
    if (expectedMatrixFont !== null) {
      assert.ok(Math.abs(parseFloat(result.matrixFont) - expectedMatrixFont) < 0.1,
        `${path}: as regras de impressão precisam estar ativas (matriz em 8.5 pt), veio ${result.matrixFont}`);
    }
    assert.equal(result.rows, 146, `${path}: matriz com as 146 linhas`);
    return result;
  };

  const shippedResult = await measure('/entregue');
  assert.deepEqual(shippedResult.matrixBroken, [], 'nenhuma palavra pode ser partida no meio dentro da matriz');
  assert.deepEqual(shippedResult.headBroken, [], 'nenhuma palavra pode ser partida no meio em cabeçalho de tabela');
  assert.ok(shippedResult.tableWidth <= shippedResult.contentWidth + 1,
    `a matriz precisa caber na área imprimível: tabela ${shippedResult.tableWidth}px em ${shippedResult.contentWidth}px`);

  // A aba interativa: mesma largura de papel, mesma mídia, mesma asserção.
  const tabResult = await measure('/aba', { expectedMatrixFont: null });
  assert.equal(tabResult.rows, 146, 'a matriz da aba precisa das 146 linhas');
  assert.deepEqual(tabResult.matrixBroken, [], 'a aba impressa não pode partir palavra na matriz');
  assert.deepEqual(tabResult.headBroken, [], 'a aba impressa não pode partir palavra em cabeçalho');

  // Controles positivos. A fixture não reproduz sozinha a pressão de largura de uma auditoria real
  // (nela 126 dos 146 itens são "Não aplicável", curto, enquanto no relatório real 109 são "Requer
  // revisão humana"), então o controle força a mesma compressão de coluna que o conteúdo real produz.
  // Sem isso o "0" acima não distingue a 1.1.21 da 1.1.20 — foi o buraco que a revisão apontou.
  const squeezed = await measure('/forcado-com-regra');
  assert.deepEqual(squeezed.matrixBroken, [],
    'sob compressão, a regra da matriz precisa continuar mantendo a palavra inteira');
  const squeezedWithoutRule = await measure('/forcado-sem-regra');
  assert.ok(squeezedWithoutRule.matrixBroken.length > 0,
    'sob compressão e sem a regra da matriz o detector precisa encontrar palavras partidas');

  // Cabeçalho do anexo: mesma lógica, com a coluna do cabeçalho comprimida.
  const headControl = await measure('/cabecalho-comprimido');
  assert.ok(headControl.headBroken.length > 0,
    'sem a regra dos cabeçalhos o detector precisa encontrar a palavra partida no cabeçalho');

  t.diagnostic(`print-breaks: matriz=${shippedResult.matrixBroken.length} quebras, cabeçalhos=${shippedResult.headBroken.length}, `
    + `anexo=${shippedResult.annexBroken} (tokens longos quebram de propósito), documento=${shippedResult.documentBroken}; `
    + `tabela=${shippedResult.tableWidth}px em ${shippedResult.contentWidth}px (@page=${printContentWidth}px); `
    + `forçado com regra=${squeezed.matrixBroken.length}; forçado sem regra=${squeezedWithoutRule.matrixBroken.length}; `
    + `cabeçalho comprimido=${headControl.headBroken.length}; aba=${tabResult.matrixBroken.length}/${tabResult.headBroken.length}`);
});
