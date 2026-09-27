import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readdir, realpath } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  launchUnpackedExtension,
  resolveRealChromeTestBinary,
  waitForFourDownloads,
} from './support/real-chrome.mjs';

// Bateria de páginas hostis: padrões que aparecem em lojas, marketplaces, portais e sites antigos. O contrato
// é um só: a auditoria da página atual SEMPRE termina com resultado (completo ou parcial, com limitações
// declaradas) dentro de um prazo razoável. Nunca trava e nunca falha só porque a página é grande, viva,
// estranha ou lenta. `AUDITA_HOSTILE_ONLY=nome1,nome2` roda um subconjunto.
const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
const TERMINAL_BUDGET_MS = Number(process.env.AUDITA_HOSTILE_BUDGET_MS ?? 150_000);
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

function html(body, { head = '', lang = 'pt-BR', doctype = true, title = 'Página hostil' } = {}) {
  return `${doctype ? '<!doctype html>' : ''}<html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;
}

function productGrid(count) {
  let cards = '';
  for (let index = 0; index < count; index += 1) {
    cards += `<article class="card"><a href="/p/${index}"><img src="/img.png" alt="" width="120" height="120">` +
      `<h3>Produto ${index}</h3></a><span class="price">R$ ${index},99</span><button type="button">Comprar</button>` +
      `<button type="button" aria-label=""><svg width="16" height="16"><path d="M0 0h16v16H0z"/></svg></button></article>`;
  }
  return `<main><h1>Ofertas</h1><section class="grid" style="display:grid;grid-template-columns:repeat(6,1fr);gap:8px">${cards}</section></main>`;
}

const SCENARIOS = {
  // 1.500 produtos (~18 mil nós) na suíte; AUDITA_HOSTILE_PRODUCTS=4000 reproduz a vitrine extrema medida na 1.1.53.
  'dom-enorme': () => ({ page: html(productGrid(Number(process.env.AUDITA_HOSTILE_PRODUCTS ?? 1500))) }),

  'muitos-iframes': frameOrigin => {
    const frames = [];
    for (let index = 0; index < 18; index += 1) frames.push(`<iframe title="Anúncio ${index}" width="300" height="250" src="${frameOrigin}/ad?${index}"></iframe>`);
    for (let index = 0; index < 8; index += 1) frames.push(`<iframe title="Lazy ${index}" loading="lazy" width="300" height="250" src="${frameOrigin}/ad?lazy${index}"></iframe>`);
    for (let index = 0; index < 4; index += 1) frames.push(`<iframe title="Sandbox ${index}" sandbox="" width="300" height="250" src="${frameOrigin}/ad?sandbox${index}"></iframe>`);
    frames.push('<iframe title="Srcdoc" srcdoc="<p>Conteúdo srcdoc</p><button></button>"></iframe>');
    frames.push('<iframe title="Data" src="data:text/html,%3Cp%3Edata%3C/p%3E"></iframe>');
    frames.push(`<iframe title="Aninhado" width="400" height="300" src="${frameOrigin}/nested"></iframe>`);
    frames.push(`<iframe title="Rotativo" width="300" height="250" src="${frameOrigin}/rotating"></iframe>`);
    frames.push('<iframe style="display:none"></iframe><iframe width="0" height="0" style="position:absolute;left:-9999px"></iframe>');
    return { page: html(`<main><h1>Portal com anúncios</h1>${frames.slice(0, 18).join('')}<div style="height:5000px"></div>${frames.slice(18).join('')}</main>`) };
  },

  'shadow-dom': () => ({
    page: html(`<main><h1>Componentes</h1><div id="host"></div></main><script>
      customElements.define('x-card', class extends HTMLElement { constructor() { super();
        const root = this.attachShadow({ mode: this.hasAttribute('closed') ? 'closed' : 'open' });
        root.innerHTML = '<style>:host{display:block;border:1px solid #ccc}</style><slot></slot><button></button><input><a href="#">Ver mais</a>'
          + (Number(this.dataset.depth) > 0 ? '<x-card data-depth="' + (Number(this.dataset.depth) - 1) + '">filho</x-card>' : '');
      } });
      const host = document.getElementById('host');
      for (let i = 0; i < 300; i++) { const c = document.createElement('x-card'); c.dataset.depth = String(i % 6);
        if (i % 7 === 0) c.setAttribute('closed', ''); c.textContent = 'Cartão ' + i; host.append(c); }
    </script>`),
  }),

  'nunca-termina-de-carregar': () => ({
    page: html('<main><h1>Carregando para sempre</h1><p>Um recurso de terceiros nunca responde.</p><img src="/hang" alt="Banner"></main>'),
    navigateAfterLoad: '/never',
  }),

  'pagina-viva': () => ({
    page: html(`<main><h1>Vitrine</h1><div id="carousel" aria-live="off"><img id="slide" src="/img.png" alt="Slide 0"></div>
      <p id="countdown">Oferta termina em 10:00:00</p><ul id="feed"></ul></main><script>
      let n = 0; setInterval(() => { n++; const s = document.getElementById('slide'); s.alt = 'Slide ' + (n % 5); s.className = 's' + (n % 5); }, 200);
      setInterval(() => { document.getElementById('countdown').textContent = 'Oferta termina em ' + new Date().toISOString(); }, 100);
      setInterval(() => { const li = document.createElement('li'); li.innerHTML = '<a href="/p/' + n + '">Item ' + n + '</a><button></button>';
        document.getElementById('feed').append(li); if (document.getElementById('feed').children.length > 400) document.getElementById('feed').firstChild.remove(); }, 250);
    </script>`),
  }),

  'fragmento-muda-sozinho': () => ({
    page: html(`<main><h1>Vitrine</h1><div id="slides"><p>Slide</p></div></main><script>
      let n = 0; setInterval(() => { n++; location.hash = 'slide-' + (n % 5); }, 400);
    </script>`),
  }),

  // A consulta (?...) continua fazendo parte da identidade do documento: aqui não se exige resultado, só que
  // a auditoria termine logo, com mensagem clara, em vez de travar.
  'consulta-muda-sozinha': () => ({
    expect: 'ends',
    page: html(`<main><h1>Busca</h1><p>Resultados</p></main><script>
      let n = 0; setInterval(() => { n++; history.replaceState(null, '', location.pathname + '?srsltid=' + n); }, 700);
    </script>`),
  }),

  'pagina-muito-alta': () => ({
    page: html(`<main><h1>Catálogo infinito</h1>${Array.from({ length: 400 }, (_, i) => `<section style="height:220px"><h2>Seção ${i}</h2><p>Texto ${i}</p><button type="button">Ação ${i}</button></section>`).join('')}</main>`),
  }),

  'prototipos-adulterados': () => ({
    page: html(`<main><h1>Site com bibliotecas antigas</h1><button>OK</button><input aria-label="Busca"></main><script>
      Array.prototype.map = function () { return 'adulterado'; };
      Array.prototype.forEach = function () {}; Array.prototype.filter = function () { return []; };
      Array.from = function () { return []; };
      JSON.stringify = function () { return '"adulterado"'; }; JSON.parse = function () { return null; };
      Object.keys = function () { return []; }; Object.assign = function (t) { return t; };
      const then = Promise.prototype.then; Promise.prototype.then = function (a, b) { return then.call(this, a, b); };
      Function.prototype.toString = function () { return 'function () { [adulterado] }'; };
      Element.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; };
      document.querySelectorAll = function () { return []; }; Element.prototype.querySelectorAll = function () { return []; };
      window.getComputedStyle = function () { return {}; };
      Object.defineProperty(window, 'innerWidth', { value: 0, configurable: true });
      window.Map = function () {}; window.Set = function () {}; window.WeakMap = function () {};
      Symbol.iterator; Array.prototype[Symbol.iterator] = function* () {};
    </script>`),
  }),

  'modal-de-cookies': () => ({
    page: html(`<main><h1>Loja</h1>${Array.from({ length: 60 }, (_, i) => `<p>Produto ${i}</p>`).join('')}</main>
      <div id="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2147483647">
        <div role="dialog" aria-modal="true" aria-labelledby="t" style="background:#fff;margin:20vh auto;width:420px;padding:16px">
          <h2 id="t">Cookies</h2><p>Usamos cookies.</p><button id="ok">Aceitar</button><button>Configurar</button></div></div>
      <script>document.documentElement.style.overflow='hidden';document.body.style.overflow='hidden';
        document.addEventListener('focusin', e => { if (!document.getElementById('overlay').contains(e.target)) document.getElementById('ok').focus(); });
        document.getElementById('ok').focus();</script>`),
  }),

  'conteudo-estranho': () => {
    let deep = '';
    for (let i = 0; i < 900; i += 1) deep += '<div>';
    deep += '<span>fundo</span>';
    for (let i = 0; i < 900; i += 1) deep += '</div>';
    const lone = '\uD800';
    return {
      page: html(`<main><h1 title="t${lone}">Título ${lone} com surrogate solto e \u0000nulo</h1>
        <p id="${'i'.repeat(5000)}" data-x="${'x'.repeat(200_000)}" class="${'c '.repeat(3000)}">Atributos enormes</p>
        <p>${'Texto longo '.repeat(120_000)}</p>
        <svg width="400" height="200">${Array.from({ length: 6000 }, (_, i) => `<path d="M${i % 400} 0l1 ${i % 200}"/>`).join('')}</svg>
        <math><mi>x</mi><mo>=</mo><mn>2</mn></math><template><button>no template</button></template>
        <noscript><p>sem script</p></noscript><button>🛒 Comprar agora ✓ ${lone}</button>
        <img alt="${lone}" src="/img.png"><a href="javascript:void(0)">​</a>${deep}</main>`, { title: `Título ${lone}` }),
    };
  },

  'modo-quirks': () => ({
    page: `<html><head><title>Prefeitura</title></head><body bgcolor="#ffffff"><center><font face="Verdana" size="2">
      <table width="760" border="0" cellpadding="0" cellspacing="0"><tr><td><img src="/img.png" width="760" height="90"></td></tr>
      <tr><td><a href="/a"><img src="/img.png" border="0"></a> | <a href="/b">Serviços</a></td></tr>
      <tr><td><marquee>Aviso importante</marquee><form><input type="text" name="q"><input type="submit" value="OK"></form></td></tr></table>
      </font></center></body></html>`,
  }),

  frameset: frameOrigin => ({
    page: `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Portal antigo</title></head>
      <frameset cols="25%,75%"><frame name="menu" src="/menu"><frame name="conteudo" src="${frameOrigin}/ad?frameset"></frameset></html>`,
  }),

  'thread-ocupada': () => ({
    page: html(`<main><h1>SPA pesada</h1><button>Carrinho</button></main><script>
      setInterval(() => { const end = Date.now() + 2500; while (Date.now() < end) {} }, 3000);
    </script>`),
  }),
};

function startHostileServer(t, scenario, frameOrigin) {
  const sockets = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (status, type, body) => { response.writeHead(status, { 'content-type': type }); response.end(body); };
    if (url.pathname === '/hang') return; // nunca responde
    if (url.pathname === '/img.png') return send(200, 'image/png', PNG_1PX);
    if (url.pathname === '/menu') return send(200, 'text/html; charset=utf-8', html('<nav><a href="/a">Início</a><a href="/b">Serviços</a></nav>'));
    if (url.pathname === '/never') return send(200, 'text/html; charset=utf-8', scenario.page);
    if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', scenario.navigateAfterLoad ? html('<h1>Início</h1>') : scenario.page);
    if (url.pathname.startsWith('/p/')) return send(200, 'text/html; charset=utf-8', html('<h1>Produto</h1>'));
    return send(404, 'text/plain; charset=utf-8', 'não encontrado');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
    resolve(`http://127.0.0.1:${server.address().port}`);
  }));
}

function startFrameServer(t) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (url.pathname === '/nested') {
      response.end(html(`<p>Quadro externo</p><iframe title="Interno" src="/ad?interno"></iframe>`));
    } else if (url.pathname === '/rotating') {
      response.end(html('<p>Rotativo</p><script>setTimeout(() => location.replace("/rotating?" + Date.now()), 500);</script>'));
    } else {
      response.end(html('<a href="/click"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="300" height="250"></a><button></button>'));
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.closeAllConnections?.(); server.close(); });
    resolve(`http://localhost:${server.address().port}`);
  }));
}

const EXPORT_SCENARIOS = new Set(['dom-enorme', 'muitos-iframes', 'shadow-dom', 'conteudo-estranho', 'frameset']);
const only = process.env.AUDITA_HOSTILE_ONLY?.split(',').map(value => value.trim()).filter(Boolean) ?? null;
const mode = process.env.AUDITA_HOSTILE_MODE ?? 'full-evidence';

for (const [name, build] of Object.entries(SCENARIOS)) {
  test(`página hostil: ${name} termina com resultado`, { timeout: TERMINAL_BUDGET_MS * 2 + 120_000, skip: Boolean(only && !only.includes(name)) }, async t => {
    const chromeBinary = resolveRealChromeTestBinary();
    assert.ok(chromeBinary, 'AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório para este E2E real.');
    const frameOrigin = await startFrameServer(t);
    const scenario = build(frameOrigin);
    const origin = await startHostileServer(t, scenario, frameOrigin);
    const extension = await launchUnpackedExtension(t, {
      extensionPath: await realpath(workspaceRoot), startUrl: `${origin}/`,
      downloadMode: 'profile', viewport: { width: 1280, height: 900 }, chromeBinary, expectedMajor: 152,
    });
    if (scenario.navigateAfterLoad) {
      await extension.evaluate(extension.startPage.page, `location.assign(${JSON.stringify(scenario.navigateAfterLoad)}), true`);
      await new Promise(resolve => setTimeout(resolve, 3_000));
    }
    const panel = await extension.openSidePanelFromAction();
    await panel.command('Page.bringToFront');
    await extension.waitForValue(panel, `document.querySelector('[data-screen]')?.dataset.screen`,
      value => value === 'initial', { timeoutMs: 30_000, intervalMs: 50 });
    const startable = await extension.waitForValue(panel, `(() => {
      const button=document.querySelector('button[data-intent="START_ATTACHED"]');
      return {button:Boolean(button),disabled:button?.disabled??null,
        note:document.querySelector('.availability-note')?.textContent??'',
        status:document.querySelector('[role="status"]')?.textContent??''};
    })()`, value => value?.button === true, { timeoutMs: 15_000, intervalMs: 50 }).catch(() => null);
    const started = Date.now();
    if (startable?.disabled === false) {
      await extension.click(panel, `input[data-capture-mode="${mode}"]`);
      await extension.click(panel, 'button[data-intent="START_ATTACHED"]');
    }
    let terminal = null;
    let confirmed = false;
    while (Date.now() - started < TERMINAL_BUDGET_MS) {
      terminal = await extension.evaluate(panel, `(() => ({
        screen:document.querySelector('[data-screen]')?.dataset.screen??null,
        session:document.querySelector('[data-screen]')?.dataset.sessionStatus??null,
        status:document.querySelector('[role="status"]')?.textContent??null
      }))()`).catch(() => null);
      if (terminal?.session === 'privacy-paused' && !confirmed) {
        confirmed = true;
        await extension.click(panel, '[data-action="confirm-pixel-capture"]');
      }
      if (terminal && ['result', 'initial', 'unavailable'].includes(terminal.screen) && Date.now() - started > 1_500) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const elapsedMs = Date.now() - started;
    const latest = await extension.evaluate(extension.harnessPage, `(async()=>{
      const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
      const latest=await store.getLatest();
      const revision=latest?.auditId?await store.getReportRevision(latest.auditId):null;
      const model=revision?.model??null;
      return {status:latest?.status??null,failureCode:latest?.failureCode??null,message:latest?.message??null,
        diagnostics:(model?.session?.diagnostics??[]).map(item=>item.code),
        occurrences:Array.isArray(model?.occurrences)?model.occurrences.length:null};
    })()`, { awaitPromise: true }).catch(error => ({ error: String(error?.code ?? error) }));
    t.diagnostic(`hostil=${name} ${JSON.stringify({ elapsedMs, startable, terminal, latest })}`);
    assert.equal(startable?.disabled, false, `a auditoria nem pôde começar: ${JSON.stringify(startable)}`);
    if (scenario.expect === 'ends') {
      assert.ok(['result', 'initial', 'unavailable'].includes(terminal?.screen), `sem desfecho em ${elapsedMs} ms: ${JSON.stringify(terminal)}`);
      return;
    }
    assert.equal(terminal?.screen, 'result', `sem resultado em ${elapsedMs} ms: ${JSON.stringify({ terminal, latest })}`);
    assert.ok(['complete', 'partial'].includes(latest.status), JSON.stringify(latest));
    assert.equal(latest.failureCode, null);
    // Páginas grandes também precisam abrir o relatório e exportar os quatro formatos: o resultado no painel
    // não basta se o relatório ou a exportação desistirem depois (1.1.53).
    if (EXPORT_SCENARIOS.has(name)) {
      const auditId = await extension.readAttribute(panel, '[data-screen="result"]', 'data-audit-id');
      await extension.click(panel, 'button[data-intent="OPEN_REPORT"]');
      // O relatório de uma página grande leva mais que o prazo padrão do harness para abrir.
      let report = null;
      for (const deadline = Date.now() + TERMINAL_BUDGET_MS; !report && Date.now() < deadline;) {
        report = await extension.waitForReport({ auditId }).catch(() => null);
      }
      assert.ok(report, `o relatório não abriu: ${await extension.evaluate(panel, `document.querySelector('[role="status"]')?.textContent ?? ''`).catch(() => '')}`);
      await extension.waitForValue(report, `Boolean(document.querySelector('button[data-report-export]'))`, Boolean,
        { timeoutMs: 120_000, intervalMs: 250 });
      await extension.click(report, 'button[data-report-export]');
      const downloads = await waitForFourDownloads(extension, { auditId, timeoutMs: TERMINAL_BUDGET_MS, intervalMs: 500 })
        .catch(async error => {
          const status = await extension.evaluate(report, `[...document.querySelectorAll('[role="status"],[role="alert"]')].map(node => node.textContent).join(' | ')`).catch(() => '');
          const files = await readdir(extension.downloadDirectory).catch(() => []);
          throw new Error(`${error?.code ?? error}: exportação sem os quatro arquivos; status=${JSON.stringify(status)}; arquivos=${JSON.stringify(files)}`);
        });
      t.diagnostic(`exportacao=${name} ${JSON.stringify(downloads.map(record => [record.format, record.state, record.byteLength]))}`);
      assert.deepEqual(downloads.map(record => record.format), ['html', 'pdf', 'csv', 'json']);
      for (const record of downloads) assert.ok(record.state === 'complete' && record.byteLength > 0, record.format);
    }
  });
}
