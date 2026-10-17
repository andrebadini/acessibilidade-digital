import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  click, evaluate, launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer, waitForValue,
} from './support/real-chrome.mjs';

/**
 * O mapa da conferência por Tab desenha as caixas sobre a captura integral. A captura usa
 * `captureBeyondViewport`, que tira a barra de rolagem clássica e deixa o leiaute ~15 px mais largo
 * durante a imagem. Se a inspeção medir os retângulos no leiaute com barra, tudo o que é ancorado à
 * direita/centro cai deslocado no mapa — este teste mede o leiaute que a imagem mostra e compara.
 *
 * A fixture usa posições ancoradas à esquerda, à direita e ao centro: as duas últimas mudam de x quando
 * a largura do leiaute muda, então uma caixa desenhada no leiaute errado não passa.
 */

const HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Fixture do mapa de leitura</title>
<style>
html,body{margin:0;padding:0;background:#fff}
body{font:16px sans-serif}
#tall{position:relative;height:3000px}
button{position:absolute;border:0;padding:0;margin:0;width:80px;height:80px;color:#fff;font-size:12px}
#alvo-esquerda{left:0;top:20px;background:#1a7f37}
#alvo-direita{right:0;top:120px;background:#b42318}
#alvo-centro{left:50%;top:220px;margin-left:-40px;background:#175cd3}
#alvo-largo{left:40px;top:340px;width:600px;height:60px;background:#b54708}
</style></head><body><div id="tall">
<button id="alvo-esquerda" data-alvo="esquerda" type="button">Alvo esquerda</button>
<button id="alvo-direita" data-alvo="direita" type="button">Alvo direita</button>
<button id="alvo-centro" data-alvo="centro" type="button">Alvo centro</button>
<button id="alvo-largo" data-alvo="largo" type="button">Alvo largo</button>
</div></body></html>`;

// Amostra o leiaute da página durante a conferência. A amostra que interessa é a de maior
// `clientWidth`: é a que a captura integral pinta. `innerWidth` fica junto para reconhecer o estado
// alargado (sem a barra clássica, `clientWidth === innerWidth`).
const SAMPLER = `(() => {
  if (window.__auditaCaixasSampler) return true;
  window.__auditaCaixasSampler = [];
  window.__auditaCaixasTimer = setInterval(() => {
    const boxes = {};
    for (const button of document.querySelectorAll('button[data-alvo]')) {
      const rect = button.getBoundingClientRect();
      boxes[button.dataset.alvo] = {
        x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height,
      };
    }
    window.__auditaCaixasSampler.push({
      ts: Date.now(), innerWidth, clientWidth: document.documentElement.clientWidth, boxes,
    });
  }, 50);
  return true;
})()`;

// A conferência é medida com o zoom REAL do navegador (125 %), e não com uma emulação do CDP: o
// produto lê o zoom das métricas de leiaute e o usa para converter as caixas e recortar a imagem.
// Este é o caso em que a versão anterior desenhava o mapa fora do elemento.
const BROWSER_ZOOM = 1.25;

async function setBrowserZoom(extension, zoom) {
  return evaluate(extension.harnessPage, `(async () => {
    const tabId = ${Number(extension.startPage.tabId)};
    await chrome.tabs.setZoom(tabId, ${zoom});
    return chrome.tabs.getZoom(tabId);
  })()`, { awaitPromise: true });
}

async function waitForReaderPage(extension) {
  const deadline = Date.now() + 15_000;
  do {
    const { targetInfos = [] } = await extension.browser.command('Target.getTargets');
    const targets = targetInfos.filter(target => {
      try {
        const url = new URL(target.url);
        return url.protocol === 'chrome-extension:' && url.hostname === extension.extensionId &&
          url.pathname === '/src/reader/index.html' && target.type === 'page';
      } catch { return false; }
    });
    assert.ok(targets.length < 2, 'o painel deve abrir exatamente uma conferência');
    if (targets.length === 1) return extension.attachPage(targets[0].targetId);
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail('o painel não abriu a conferência');
}

test('as caixas do mapa de leitura caem no leiaute que a captura mostra', { timeout: 180_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([
    ['/mapa', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: HTML }],
  ]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
    startUrl: `${fixture.origin}/mapa`, viewport: { width: 1280, height: 900 }, downloadMode: 'profile',
  });
  const page = extension.startPage.page;
  await waitForValue(page, `document.querySelectorAll('button[data-alvo]').length`, value => value === 4);
  // O zoom entra ANTES da auditoria: todas as leituras e a captura da conferência acontecem em 125 %.
  const appliedZoom = await setBrowserZoom(extension, BROWSER_ZOOM);
  assert.ok(Math.abs(appliedZoom - BROWSER_ZOOM) < 0.02,
    `o navegador precisa estar em ${BROWSER_ZOOM * 100} %: zoom aplicado ${appliedZoom}`);

  const panel = await extension.openSidePanelFromAction();
  await waitForValue(panel, `Boolean(document.querySelector('button[data-intent="OPEN_TAB_READING"]:not(:disabled)'))`, Boolean,
    { timeoutMs: 30_000, intervalMs: 100 });
  // A amostragem começa depois de o painel ocupar o espaço dele: assim a maior largura observada é a
  // do leiaute da captura, e não a da janela antes do painel abrir.
  await evaluate(page, SAMPLER);
  await click(panel, 'button[data-intent="OPEN_TAB_READING"]');
  const reader = await waitForReaderPage(extension);
  await waitForValue(reader, `document.querySelector('#status')?.textContent ?? ''`,
    value => String(value).includes('Inspeção concluída'), { timeoutMs: 120_000, intervalMs: 100 });
  await waitForValue(reader, `document.querySelectorAll('svg.map-overlay rect.map-box').length`,
    value => Number(value) === 4, { timeoutMs: 30_000, intervalMs: 100 });

  const map = await evaluate(reader, `(() => {
    const svg = document.querySelector('svg.map-overlay');
    const box = svg?.getAttribute('viewBox') ?? '';
    const [, , width, height] = box.split(/\\s+/u).map(Number);
    return {
      width, height,
      boxes: [...svg.querySelectorAll('rect.map-box')].map(rect => ({
        x: Number(rect.getAttribute('x')), y: Number(rect.getAttribute('y')),
        width: Number(rect.getAttribute('width')), height: Number(rect.getAttribute('height')),
      })),
      legend: [...document.querySelectorAll('.reader-map-list li')].map(item => item.textContent.trim()),
    };
  })()`);
  const samples = await evaluate(page, `window.__auditaCaixasSampler ?? []`);
  await evaluate(page, `(() => { clearInterval(window.__auditaCaixasTimer); return true; })()`);
  t.diagnostic(`zoom ${appliedZoom}; mapa ${map.width}x${map.height}; amostras ${samples.length}; larguras ${[...new Set(samples.map(sample => sample.clientWidth))].join(', ')}`);

  assert.ok(map.width > 0 && map.boxes.length === 4, 'o mapa precisa desenhar as quatro caixas');
  // A imagem foi recortada na maior largura de leiaute observada durante a conferência. Se a captura
  // alargou a página, essa é a largura sem a barra de rolagem — a mesma que os pixels mostram.
  const painted = samples.reduce((widest, sample) => sample.clientWidth > widest.clientWidth ? sample : widest, samples[0]);
  assert.ok(painted, 'a página precisa ter sido amostrada durante a conferência');
  // O `viewBox` do mapa é o tamanho em PIXEL da imagem, e a imagem em 125 % mede 1,25× o leiaute em
  // px CSS. Comparar o mapa com a medida em CSS daria um falso erro de 25 %; a referência correta é a
  // medida do leiaute multiplicada pela escala real da captura. Que essa escala seja o zoom é o que
  // prova que o mapa e a imagem concordam no mesmo sistema de coordenadas.
  const scaleX = map.width / painted.clientWidth;
  assert.ok(Math.abs(scaleX - appliedZoom) < 0.02,
    `a imagem precisa ter a escala do zoom: mapa ${map.width} px para ${painted.clientWidth} px CSS em ${appliedZoom}× (escala ${scaleX})`);

  const expectedByAlvo = Object.fromEntries(Object.entries(painted.boxes).map(([alvo, box]) => [alvo, {
    x: box.x * scaleX, y: box.y * scaleX, width: box.width * scaleX, height: box.height * scaleX,
  }]));
  const alvos = ['esquerda', 'direita', 'centro', 'largo'];
  const labelByAlvo = { esquerda: 'Alvo esquerda', direita: 'Alvo direita', centro: 'Alvo centro', largo: 'Alvo largo' };
  for (const alvo of alvos) {
    const legendItem = map.legend.find(text => text.includes(labelByAlvo[alvo]));
    assert.ok(legendItem, `a legenda precisa citar ${labelByAlvo[alvo]}: ${JSON.stringify(map.legend)}`);
    const number = Number(/^L(\d+)/u.exec(legendItem)?.[1]);
    assert.ok(Number.isSafeInteger(number) && number >= 1 && number <= map.boxes.length, `código inválido para ${alvo}`);
    const drawn = map.boxes[number - 1];
    const expected = expectedByAlvo[alvo];
    const delta = Math.max(
      Math.abs(drawn.x - expected.x), Math.abs(drawn.y - expected.y),
      Math.abs(drawn.width - expected.width), Math.abs(drawn.height - expected.height),
    );
    assert.ok(delta <= 1.5,
      `a caixa de ${alvo} precisa cair sobre o elemento: desenho ${JSON.stringify(drawn)}, medida ${JSON.stringify(expected)}, desvio ${delta} px`);
  }

  // Se a barra clássica existia, a captura alargou o leiaute: a posição ancorada à direita no leiaute
  // da imagem precisa ser diferente da posição com barra. É essa diferença que a versão anterior perdia.
  const narrow = samples.find(sample => sample.innerWidth - sample.clientWidth > 0);
  if (narrow && painted.clientWidth !== narrow.clientWidth) {
    assert.notEqual(painted.boxes.direita.x, narrow.boxes.direita.x,
      'o leiaute da imagem precisa ser o alargado, não o que tem barra de rolagem');
  }
});
