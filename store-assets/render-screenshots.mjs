// Capturas da Chrome Web Store (1280 × 800, PNG RGB sem alfa) a partir da extensão real.
//
// Página auditada: store-assets/demo/vila-aurora.html — portal FICTÍCIO, servido localmente e exibido
// como http://www.vila-aurora.example/ (domínio reservado). Uso:
//   AUDITA_E2E_CHROME=<Chrome for Testing> node store-assets/render-screenshots.mjs [--raw-only]
// Saída bruta em qa-out/store-raw/ e capturas finais em store-assets/screenshot-*.png.
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { click, command, evaluate, launchUnpackedExtension, waitForValue } from '../test/e2e/support/real-chrome.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'qa-out', 'store-raw');
const HOST = 'www.vila-aurora.example';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const files = new Map();
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  try {
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(await readFile(join(ROOT, 'store-assets/demo/vila-aurora.html')));
      return;
    }
    if (files.has(path)) {
      const [type, body] = files.get(path);
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); return;
    }
    if (path.startsWith('/raw/')) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      res.end(await readFile(join(RAW, path.slice(5)))); return;
    }
  } catch { /* 404 */ }
  res.writeHead(404); res.end('not found');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
process.env.AUDITA_E2E_HOST_RULE = `MAP ${HOST} 127.0.0.1:${port}`;
await mkdir(RAW, { recursive: true });

const cleanups = [];
const host = { after(fn) { cleanups.push(fn); } };
async function finish(code = 0) {
  for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* */ } }
  server.close(); process.exit(code);
}

async function shot(target, name, clip) {
  const result = await command(target, 'Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  await writeFile(join(RAW, name), Buffer.from(result.data, 'base64'));
  log('raw', name);
}

// Composição final: faixa de título + capturas reais 1:1, sem redimensionar a interface.
const CAPTIONS = [
  ['screenshot-1-sinais.png', 'Audite a página aberta e veja cada problema marcado no próprio site', 'split', 'page-markers.png', 'panel-markers.png'],
  ['screenshot-2-explicacao.png', 'Clique num achado: o elemento é destacado e a explicação vem em linguagem simples', 'split', 'page-selected.png', 'panel-detail.png'],
  ['screenshot-3-mapa-teclado.png', 'Mapa do teclado: veja, sem saber programar, o que a tecla Tab não alcança', 'full', 'report-keyboard.png'],
  ['screenshot-4-constatacoes.png', 'Constatações prontas para citar, com o item da ABNT NBR 17225 e a evidência', 'full', 'report-board.png'],
  ['screenshot-5-relatorio.png', 'Relatório completo em HTML, PDF, CSV e JSON, gerado no seu computador', 'full', 'report-summary.png'],
];
function composeHtml([, caption, layout, first, second]) {
  const body = layout === 'split'
    ? `<div class="split"><div class="page"><img src="/raw/${first}"></div><div class="panel"><img src="/raw/${second}"></div></div>`
    : `<div class="full"><img src="/raw/${first}"></div>`;
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><style>
  *{box-sizing:border-box}html,body{margin:0;width:1280px;height:800px;overflow:hidden;background:#fff}
  header{height:76px;background:#12305a;color:#fff;display:flex;align-items:center;gap:16px;padding:0 28px;
    font:600 25px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:-.01em}
  header img{width:44px;height:44px;border-radius:10px;background:#fff;padding:3px}
  .split{display:flex;height:724px}.page{width:920px;height:724px;overflow:hidden}
  .panel{width:360px;height:724px;overflow:hidden;box-shadow:-1px 0 0 #c7ced6,-6px 0 14px rgba(18,48,90,.12);position:relative}
  .split img,.full img{display:block}.full{height:724px;overflow:hidden}
  </style><header><img src="/icon.png" alt="">${caption}</header>${body}</html>`;
}
async function compose(target) {
  files.set('/icon.png', ['image/png', await readFile(join(ROOT, 'assets/icons/icon-128.png'))]);
  await command(target, 'Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  for (const entry of CAPTIONS) {
    files.set('/compose.html', ['text/html; charset=utf-8', Buffer.from(composeHtml(entry))]);
    await command(target, 'Page.navigate', { url: `http://${HOST}/compose.html?${Date.now()}` });
    await sleep(1200);
    const result = await command(target, 'Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1280, height: 800, scale: 1 } });
    await writeFile(join(ROOT, 'store-assets', entry[0]), Buffer.from(result.data, 'base64'));
    log('final', entry[0]);
  }
}

try {
  const launch = await launchUnpackedExtension(host, {
    extensionPath: ROOT, startUrl: `http://${HOST}/`, chromeBinary: process.env.AUDITA_E2E_CHROME,
    expectedMajor: 152, viewport: { width: 1306, height: 880 },
  });
  const page = launch.startPage.page;
  const panel = await launch.openSidePanelFromAction();
  await waitForValue(panel, `Boolean(document.querySelector('button[data-intent="START_ATTACHED"]:not(:disabled)'))`, Boolean, { timeoutMs: 60000 });
  await sleep(2500); // deixa a página estabilizar com a nova largura antes de auditar
  await click(panel, 'input[data-capture-mode="full-evidence"]');
  await sleep(300);
  await shot(panel, 'panel-initial.png');
  await click(panel, 'button[data-intent="START_ATTACHED"]');
  await waitForValue(panel, `document.querySelector('[data-screen]')?.dataset.screen`, v => v === 'result', { timeoutMs: 180000, intervalMs: 300 });
  await waitForValue(panel, `document.querySelectorAll('[data-result-card]').length`, v => v > 0, { timeoutMs: 30000 });
  await sleep(800);
  await shot(panel, 'panel-result.png');
  await click(panel, '[data-intent="SHOW_PAGE_MARKERS"]');
  await waitForValue(panel, `document.querySelector('[data-page-marker-review]')?.dataset.status ?? (document.querySelector('[data-page-marker-review]') ? 'x' : null)`, Boolean, { timeoutMs: 60000 });
  await sleep(1500);
  await evaluate(panel, `(document.activeElement?.blur?.(), document.documentElement.style.scrollBehavior = 'auto', window.scrollTo(0, 0), true)`);
  await sleep(300);
  await shot(page, 'page-markers.png');
  await shot(panel, 'panel-markers.png');
  const metrics = await command(page, 'Page.getLayoutMetrics');
  log('page viewport', JSON.stringify(metrics.cssVisualViewport));
  const panelMetrics = await command(panel, 'Page.getLayoutMetrics');
  log('panel viewport', JSON.stringify(panelMetrics.cssVisualViewport));
  const cards = await evaluate(panel, `[...document.querySelectorAll('[data-result-card]')].map(c => c.querySelector('h3,h4,strong')?.textContent?.trim()).slice(0,40)`);
  log('cards', JSON.stringify(cards));
  // S2: o achado dos cartões que só abrem com o mouse, selecionado.
  const focusId = await evaluate(panel, `(() => {
    const card = [...document.querySelectorAll('[data-result-card]')].find(c => /teclado parcial/u.test(c.textContent));
    return card?.querySelector('button[data-intent="SELECT_OCCURRENCE"]')?.dataset.focusId ?? null; })()`);
  log('focus', focusId);
  await evaluate(panel, `(() => { const b = [...document.querySelectorAll('button[data-focus-id]')].find(n => n.dataset.focusId === ${JSON.stringify(focusId)});
    const g = b?.closest('details[data-abnt-group]'); if (g && !g.open) g.querySelector('summary').click(); b?.click(); return Boolean(b); })()`, { userGesture: true });
  await sleep(800);
  const go = await evaluate(panel, `Boolean(document.querySelector('[data-result-detail] .detail-actions [data-action="go-to-page-marker"]'))`);
  if (go) await click(panel, '[data-result-detail] .detail-actions [data-action="go-to-page-marker"]');
  await sleep(1500);
  await evaluate(panel, `(document.activeElement?.blur?.(), true)`);
  await shot(page, 'page-selected.png');
  await evaluate(panel, `(() => { document.documentElement.style.scrollBehavior = 'auto';
    const d = document.querySelector('[data-result-detail]'); if (d) d.scrollIntoView({ block: 'start' }); return Math.round(scrollY); })()`);
  await sleep(500);
  await shot(panel, 'panel-detail.png');
  await evaluate(panel, `window.scrollBy(0, 500)`); await sleep(300);
  await shot(panel, 'panel-detail-2.png');

  // Relatório completo: recortes por região, sempre na área visível (1280 × 728).
  const auditId = await evaluate(panel, `document.querySelector('[data-screen="result"]')?.dataset.auditId`);
  await click(panel, 'button[data-intent="OPEN_REPORT"]');
  const report = await launch.waitForReport({ auditId });
  await command(report, 'Page.bringToFront');
  await waitForValue(report, `Boolean(document.querySelector('button[data-report-export]'))`, Boolean, { timeoutMs: 60000 });
  await command(report, 'Emulation.setDeviceMetricsOverride', { width: 1280, height: 724, deviceScaleFactor: 1, mobile: false });
  await evaluate(report, `(document.documentElement.style.scrollBehavior = 'auto', true)`);
  await sleep(1500);
  const at = async (name, expr, extra = 0) => {
    const y = await evaluate(report, `(() => { const n = ${expr}; if (!n) return null; const top = n.getBoundingClientRect().top + scrollY; window.scrollTo(0, Math.max(0, top - 12 + ${extra})); return Math.round(scrollY); })()`);
    if (y === null) { log('sem alvo', name); return; }
    await sleep(500); await shot(report, name);
  };
  if (process.env.STORE_DEBUG) {
    await evaluate(report, `([...document.querySelectorAll('details')].forEach(d => d.open = true), true)`);
    await writeFile(join(RAW, 'report.txt'), await evaluate(report, `document.body.innerText`));
    await finish(0);
  }
  await at('report-summary.png', `document.getElementById('report-section-1')`, -46);
  await at('report-board.png', `document.getElementById('report-section-3')`, -46);
  // Mapa do teclado na revisão guiada: abre o cartão do 5.1.13 e rola a imagem até os cartões de serviço.
  await evaluate(report, `(() => { const card = [...document.querySelectorAll('details.lay-card')].find(c => /5\\.1\\.13/u.test(c.textContent));
    if (card) card.open = true; return Boolean(card); })()`);
  await sleep(1200);
  await at('report-keyboard.png', `document.querySelector('.lay-keyboard-map')`, -46);
  await evaluate(report, `(() => { const f = document.querySelector('.lay-keyboard-map figure'); if (f) f.scrollTop = 190; return true; })()`);
  await sleep(400);
  await shot(report, 'report-keyboard.png');
  if (process.argv.includes('--raw-only')) await finish(0);
  await compose(page);
  await writeFile(join(RAW, 'state.json'), JSON.stringify({ auditId: await evaluate(panel, `document.querySelector('[data-screen="result"]')?.dataset.auditId`), cards }, null, 2));
  await finish(0);
} catch (error) {
  console.error('FALHA', error?.code ?? '', error?.stack ?? error);
  await finish(1);
}
