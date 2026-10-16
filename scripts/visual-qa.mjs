#!/usr/bin/env node
// Roteiro de QA VISUAL reutilizável da extensão "Audita Acessibilidade".
//
// Ele carrega a extensão DE VERDADE no Chrome for Testing, audita páginas com captura de pixels,
// liga os sinais numerados na página e salva capturas de tela para revisão humana. O que se
// revisa aqui são as duas coisas que nenhum teste de unidade enxerga: se o número desenhado na
// página aponta para o elemento certo, e se a caixa/anel cobre exatamente o que o achado descreve.
//
// Uso:
//   node scripts/visual-qa.mjs [--out qa-out/<nome>] [--url https://... ...] [--no-fixture] [--reload-check]
//
// Para cada página (a fixture local, salvo --no-fixture, e cada --url):
//   01-painel.png          painel no resultado da auditoria
//   01b-painel-sinais.png  painel com o resumo dos sinais
//   02-sinais-topo.png     página no topo com os sinais desenhados
//   03-sinais-rolagem-N.png página nas posições de rolagem
//   04-selecionado-N.png   página com o anel do N-ésimo achado selecionado
//   05-persistencia.png    página 6 s depois, com o ponteiro mexido e rolagem
//   05b-recarga-painel.png painel logo depois de a aba recarregar — o CONVITE, só com --reload-check
//   05c-recarga-sinais.png sinais reencontrados na versão recarregada, só com --reload-check
//   05d-recarga-destaque-convite.png convite do destaque na versão atual, só com --reload-check
//   05e-recarga-destaque.png caixa do destaque desenhada na versão recarregada, só com --reload-check
//   06-relatorio-N.png     seções do relatório com as miniaturas de evidência
//   07-evidencia-N.png     cada miniatura marcada isolada (o <figure> com o svg)
//   08-mapa.png            mapa de anúncios, quando existe
//   09-mapa-teclado.png    mapa do teclado, quando existe (caixas azuis numeradas e tracejadas)
//   10-revisao-cartao.png  cartão da revisão guiada com o recorte do elemento e o contorno
//   10b-recorte-ampliado.png o mesmo recorte ampliado na caixa de diálogo (clique na imagem)
//   11-ficha-evidencia.png ficha da evidência aberta no relatório: imagem com contorno, ID e os dois
//                          SHA-256 inteiros, com o botão de download do PNG
//   12-anexo-impresso.png  o anexo do HTML ENTREGUE (só ele visível, mídia de impressão) no quadro em
//                          que o PDF o imprime — a imagem, o ID e os dois SHA-256 de cada evidência
//   13-anexo-impresso.pdf  o mesmo anexo passado pelo `Page.printToPDF`, o mesmo caminho do PDF entregue
//   <auditId>.html/.pdf    os arquivos que a exportação realmente entregou (copiados do perfil do Chrome),
//                          com a contagem de imagens embutidas no PDF no summary.json
//   summary.json           o que foi medido: localizados, não localizados com motivo,
//                          retângulo do alvo vs. retângulo do anel/botão, persistência e, com
//                          --reload-check, o que o painel respondeu depois da recarga
//
// Um erro numa página é registrado no summary.json e não aborta as outras.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

import {
  click,
  command,
  createRealPage,
  evaluate,
  launchUnpackedExtension,
  removeRealTab,
  resolveRealChromeTestBinary,
  startFixtureServer,
  waitForValue,
} from '../test/e2e/support/real-chrome.mjs';

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIRECTORY = join(WORKSPACE_ROOT, 'test/e2e/fixtures/visual-qa');
const FIXTURE_PATH = '/marcacao.html';
const VIEWPORT = Object.freeze({ width: 1280, height: 900 });
// A auditoria de "Evidência completa" é a que produz as capturas de pixel que viram as
// miniaturas com bounding box no relatório; é o modo padrão do painel e o que a pessoa usa.
const CAPTURE_MODE = 'full-evidence';
const CHROME_MAJOR = Number(process.env.AUDITA_EXPECT_CHROME_MAJOR ?? 152);
const PERSISTENCE_WAIT_MS = 6_000;
const SELECTIONS_PER_PAGE = 3;
// Quantos sinais distintos o roteiro chega a reconhecer antes de escolher os 3 da captura.
const SELECTION_PROBES = 8;
const ROLLING_SHOTS = 3;

// ---------------------------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------------------------

function sleep(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

function describeError(error) {
  if (!error) return 'erro desconhecido';
  const parts = [];
  if (typeof error.code === 'string' && error.code) parts.push(error.code);
  if (typeof error.message === 'string' && error.message && error.message !== error.code) parts.push(error.message);
  if (error.detail) parts.push(`detalhe=${JSON.stringify(error.detail)}`);
  if (!parts.length) parts.push(String(error));
  return parts.join(' — ').slice(0, 600);
}

function slugify(rawUrl) {
  const url = new URL(rawUrl);
  const base = `${url.hostname}${url.pathname}`.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[.-]+|[.-]+$/gu, '');
  return (base || 'pagina').slice(0, 80);
}

function normalizeText(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

// ---------------------------------------------------------------------------------------------
// Argumentos
// ---------------------------------------------------------------------------------------------

const USAGE = `Uso: node scripts/visual-qa.mjs [--out qa-out/<nome>] [--url https://... ...] [--no-fixture] [--reload-check]

  --out <dir>     diretório de saída (padrão: qa-out/visual-qa-<data-hora>)
  --url <url>     audita também esta página (pode repetir)
  --no-fixture    não audita a fixture local test/e2e/fixtures/visual-qa/marcacao.html
  --reload-check  depois das capturas, recarrega a aba auditada e mostra os sinais na versão
                  recarregada (o convite e os sinais reencontrados ficam em 05b/05c-*.png)
  --help          mostra esta ajuda
`;

function parseArguments(argv) {
  const options = { out: null, urls: [], fixture: true, reloadCheck: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') { options.help = true; continue; }
    if (argument === '--no-fixture') { options.fixture = false; continue; }
    if (argument === '--reload-check') { options.reloadCheck = true; continue; }
    if (argument === '--out' || argument === '--url') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || !value || value.startsWith('--')) {
        throw new Error(`ARGUMENTO_SEM_VALOR: ${argument}`);
      }
      index += 1;
      if (argument === '--out') {
        if (options.out !== null) throw new Error('ARGUMENTO_REPETIDO: --out');
        options.out = value;
      } else {
        options.urls.push(value);
      }
      continue;
    }
    throw new Error(`ARGUMENTO_DESCONHECIDO: ${argument}`);
  }
  for (const url of options.urls) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error(`URL_INVALIDA: ${url}`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error(`URL_INVALIDA: ${url}`);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------------------------
// Servidor da fixture
// ---------------------------------------------------------------------------------------------

async function fixtureRoutes() {
  const routes = new Map();
  const text = async (routePath, name, contentType, directory = FIXTURE_DIRECTORY) => {
    routes.set(routePath, {
      status: 200,
      headers: { 'content-type': contentType, 'cache-control': 'no-store' },
      body: await readFile(join(directory, name), 'utf8'),
    });
  };
  await text(FIXTURE_PATH, 'marcacao.html', 'text/html; charset=utf-8');
  await text('/marcacao.css', 'marcacao.css', 'text/css; charset=utf-8');
  await text('/marcacao.js', 'marcacao.js', 'text/javascript; charset=utf-8');
  const images = join(FIXTURE_DIRECTORY, 'img');
  for (const name of await readdir(images)) {
    if (!/^[A-Za-z0-9._-]+\.svg$/u.test(name)) throw new Error(`IMAGEM_INVALIDA: ${name}`);
    await text(`/img/${name}`, name, 'image/svg+xml; charset=utf-8', images);
  }
  return routes;
}

// ---------------------------------------------------------------------------------------------
// Expressões executadas dentro do painel e da página
// ---------------------------------------------------------------------------------------------

const PANEL_READY = `(() => {
  const input = document.querySelector('input[data-capture-mode="${CAPTURE_MODE}"]');
  const button = document.querySelector('button[data-intent="START_ATTACHED"]');
  return Boolean(input && !input.disabled && button && !button.disabled);
})()`;

const PANEL_SCREEN = `(() => {
  const root = document.querySelector('[data-screen]');
  return { screen: root?.dataset.screen ?? null, auditId: root?.dataset.auditId ?? null,
    confirmation: Boolean(document.querySelector('[data-action="confirm-pixel-capture"]')),
    text: (document.body.innerText || '').replace(/\\s+/gu, ' ').slice(0, 240) };
})()`;

// O estado que o PAINEL diz sobre os sinais: situação, mensagem própria, o resumo em cinco
// linhas fixas (marcadores, localizadas, gerais, não localizadas, omitidas) e, por cartão, se
// ele recebeu um número de sinal. É a metade "painel" da medição dos não localizados.
const PANEL_MARKERS = `(() => {
  const review = document.querySelector('[data-page-marker-review]');
  const countRows = [...document.querySelectorAll('.page-marker-counts li')].map(node => node.textContent);
  return {
    status: review?.dataset.markerStatus ?? null,
    message: document.querySelector('.page-marker-status')?.textContent ?? null,
    countRows,
    omittedNotice: document.querySelector('.page-marker-limit')?.textContent ?? null,
    actions: [...document.querySelectorAll('[data-page-marker-review] [data-intent]')].map(node => node.dataset.intent),
    cards: [...document.querySelectorAll('[data-result-card]')].map(card => {
      const title = card.querySelector('h4')?.textContent
        ?? card.querySelector('button[data-intent="SELECT_OCCURRENCE"]')?.textContent ?? '';
      return { classification: card.dataset.classification, context: card.dataset.context,
        title: title.replace(/\\s+/gu, ' ').trim().slice(0, 200),
        occurrences: [...card.querySelectorAll('button[data-intent="SELECT_OCCURRENCE"]')].map(button => ({
          focusId: button.dataset.focusId,
          number: button.querySelector('[data-page-marker-number]')?.dataset.pageMarkerNumber ?? null,
          selected: button.getAttribute('aria-pressed') === 'true',
        })) };
    }),
  };
})()`;

// As ações que o painel oferece para a ocorrência aberta no detalhe. É uma LISTA porque a linha
// traz mais de um botão — quando o achado tem sinal na página, "Ir ao elemento do sinal N" vem
// antes, e ler só o primeiro botão escondia o destaque ao vivo que está ao lado dele.
const DETAIL_ACTIONS = `[...document.querySelectorAll('[data-result-detail] .detail-actions [data-action]')].map(node => node.dataset.action)`;
// "highlight-checking" é a espera enquanto o worker confere o vínculo, não uma oferta.
// "highlight-reloaded" é a oferta que só existe quando a página recarregou depois da auditoria:
// ela É uma resposta assentada (o destaque na versão de agora), e sem estar nesta lista a espera
// do detalhe terminaria antes de o convite aparecer.
const SETTLED_HIGHLIGHT_ACTIONS = ['highlight-occurrence', 'consult-evidence', 'clear-highlight', 'highlight-reloaded'];

// O que o painel ANUNCIA sobre o destaque (as regiões vivas que falam de destaque).
const PANEL_HIGHLIGHT_LIVE = `[...document.querySelectorAll('.panel-live')].map(node => node.textContent)
  .filter(text => /destaque/iu.test(text))`;

const PANEL_DETAIL = `(() => {
  const detail = document.querySelector('[data-result-detail]');
  if (!detail) return null;
  return {
    title: detail.querySelector('[data-detail-block="heading"]')?.textContent?.replace(/\\s+/gu, ' ').trim().slice(0, 200) ?? null,
    classification: detail.dataset.classification ?? null,
    context: detail.dataset.context ?? null,
    actions: [...detail.querySelectorAll('.detail-actions [data-action], .detail-actions [data-intent]')]
      .map(node => node.dataset.action ?? node.dataset.intent).filter((value, index, all) => all.indexOf(value) === index),
    // É esta a frase que explica um achado sem sinal: "Esta ocorrência não tem sinal localizado...".
    limitation: detail.querySelector('.page-marker-limit')?.textContent ?? null,
  };
})()`;

// O estado que a PÁGINA diz sobre os sinais. O anel e o botão vivem num shadow root aberto e a
// geometria só existe como estilo inline, então a leitura é por `style.left/top/width/height`.
// Para medir a precisão, procuramos na página os elementos cujo retângulo bate com o do anel
// (o anel é posicionado a partir de `element.getBoundingClientRect()`), e descrevemos o que está
// pintado debaixo do centro do anel e do centro do botão.
const OVERLAY_STATE = `(() => {
  const host = document.querySelector('[data-audita-page-markers-root="v1"]');
  if (!host || !host.shadowRoot) return { present: false, groups: [], viewport: { width: innerWidth, height: innerHeight } };
  const shadow = host.shadowRoot;
  const round = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  const number = value => { const parsed = Number.parseFloat(value); return Number.isFinite(parsed) ? round(parsed) : null; };
  const describe = element => ({
    tag: element.tagName.toLowerCase(),
    id: element.getAttribute('id'),
    classes: (element.getAttribute('class') || '').split(/\\s+/u).filter(Boolean).slice(0, 6),
    text: (element.textContent || '').replace(/\\s+/gu, ' ').trim().slice(0, 60),
  });
  const pageElements = [...document.querySelectorAll('body *')]
    .filter(element => !element.closest('[data-audita-page-markers-root="v1"]'));
  // O texto visível da página, uma linha por fragmento, medido com Range — a mesma conta que o
  // produto faz para não pousar a etiqueta em cima de palavras. Só a viewport é varrida, com teto de
  // elementos e de linhas, para o roteiro não pesar numa página longa.
  const textLines = (() => {
    const lines = [];
    const range = typeof document.createRange === 'function' ? document.createRange() : null;
    if (!range || !document.body) return lines;
    const stack = [document.body];
    let visited = 0;
    while (stack.length > 0 && lines.length < 1500) {
      const node = stack.pop();
      visited += 1;
      if (visited > 2000) break;
      if (node.closest?.('[data-audita-page-markers-root="v1"],[data-audita-highlight-root]')) continue;
      const box = node.getBoundingClientRect();
      if (box.width > 0 && box.height > 0 &&
        !(box.left < innerWidth && box.right > 0 && box.top < innerHeight && box.bottom > 0)) continue;
      for (const child of node.childNodes) {
        if (child.nodeType !== 3 || !/\\S/u.test(child.nodeValue ?? '')) continue;
        range.selectNodeContents(child);
        for (const rect of range.getClientRects()) {
          if (!(rect.width > 0) || !(rect.height > 0)) continue;
          if (!(rect.left < innerWidth && rect.right > 0 && rect.top < innerHeight && rect.bottom > 0)) continue;
          lines.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, node: child });
          if (lines.length >= 1500) break;
        }
      }
      for (const child of node.children) stack.push(child);
    }
    return lines;
  })();
  const groups = [...shadow.querySelectorAll('.audita-group')].map(group => {
    const ring = group.querySelector('.audita-ring');
    const button = group.querySelector('.audita-marker');
    const label = button?.getAttribute('aria-label') ?? '';
    const match = /^Sinal (\\d+)/u.exec(label);
    const drawn = element => element.style.display !== 'none' &&
      element.getBoundingClientRect().width > 0;
    const ringBox = { x: number(ring.style.left), y: number(ring.style.top),
      width: number(ring.style.width), height: number(ring.style.height) };
    const rect = button.getBoundingClientRect();
    const buttonBox = { x: Math.round(rect.left), y: Math.round(rect.top),
      width: Math.round(rect.width), height: Math.round(rect.height) };
    const located = ringBox.x !== null;
    // O contorno fica POR FORA do elemento: folga de 3 px mais a espessura da borda em cada lado.
    const inset = (number(ring.style.borderWidth) ?? 0) + 3;
    const matching = located && ring.style.display !== 'none' ? pageElements.filter(element => {
      const box = element.getBoundingClientRect();
      return Math.abs(box.left - (ringBox.x + inset)) <= 1.5 && Math.abs(box.top - (ringBox.y + inset)) <= 1.5 &&
        Math.abs(box.width - (ringBox.width - (2 * inset))) <= 1.5 &&
        Math.abs(box.height - (ringBox.height - (2 * inset))) <= 1.5;
    }) : [];
    const painted = (x, y) => (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight)
      ? document.elementsFromPoint(x, y)
        .filter(element => !element.closest('[data-audita-page-markers-root="v1"]')).slice(0, 3).map(describe)
      : [];
    // Quem é o dono do texto que a etiqueta pode cobrir: o elemento marcado. Ele é procurado pelo
    // retângulo do contorno e, quando a folga não casa exatamente, pelo elemento mais fundo sob o
    // centro do anel — assim o texto do próprio alvo não entra na conta.
    const owners = [...matching];
    const deep = located ? (document.elementsFromPoint(ringBox.x + ringBox.width / 2, ringBox.y + ringBox.height / 2)
      .filter(element => !element.closest('[data-audita-page-markers-root="v1"]'))[0] ?? null) : null;
    if (deep && !owners.includes(deep)) owners.push(deep);
    const labelOnText = drawn(button) ? textLines.filter(line =>
      !owners.some(owner => owner.contains?.(line.node) === true) &&
      Math.min(buttonBox.x + buttonBox.width, line.right) - Math.max(buttonBox.x, line.left) > 1 &&
      Math.min(buttonBox.y + buttonBox.height, line.bottom) - Math.max(buttonBox.y, line.top) > 1) : [];
    const overlapWidth = located ? Math.max(0, Math.min(ringBox.x + ringBox.width, buttonBox.x + buttonBox.width) - Math.max(ringBox.x, buttonBox.x)) : 0;
    const overlapHeight = located ? Math.max(0, Math.min(ringBox.y + ringBox.height, buttonBox.y + buttonBox.height) - Math.max(ringBox.y, buttonBox.y)) : 0;
    // O anel só é exibido na ocorrência selecionada; fora disso o produto o deixa em display:none
    // e o retângulo medido abaixo passa a ser zero. A caixa em ringBox continua sendo o alvo que
    // o overlay resolveu (ela vem dos estilos em linha), e é com ela que se mede a precisão.
    const ringRect = ring.getBoundingClientRect();
    return {
      number: match ? Number.parseInt(match[1], 10) : null,
      label,
      badge: button?.textContent ?? null,
      visible: drawn(button),
      onScreen: drawn(button) && buttonBox.y < innerHeight && buttonBox.y + buttonBox.height > 0 &&
        buttonBox.x < innerWidth && buttonBox.x + buttonBox.width > 0,
      ringVisible: drawn(ring),
      ringDrawnRect: { x: Math.round(ringRect.left), y: Math.round(ringRect.top),
        width: Math.round(ringRect.width), height: Math.round(ringRect.height) },
      colour: button?.style.background ?? null,
      ring: ringBox,
      button: buttonBox,
      buttonOverlapArea: Math.round(overlapWidth * overlapHeight),
      targetCandidates: matching.slice(0, 4).map(describe),
      targetCandidateCount: matching.length,
      labelOnTextCount: labelOnText.length,
      labelOnText: labelOnText.slice(0, 3).map(line => ({
        text: (line.node.nodeValue ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 60),
        owner: line.node.parentElement ? describe(line.node.parentElement) : null,
        coveredPx: Math.round((Math.min(buttonBox.x + buttonBox.width, line.right) - Math.max(buttonBox.x, line.left)) *
          (Math.min(buttonBox.y + buttonBox.height, line.bottom) - Math.max(buttonBox.y, line.top))),
      })),
      labelOnTextLines: textLines.length,
      paintedUnderRing: located ? painted(ringBox.x + ringBox.width / 2, ringBox.y + ringBox.height / 2) : [],
      paintedUnderButton: painted(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2),
    };
  });
  // Colisões: etiqueta sobre outra etiqueta, ou etiqueta sobre o contorno de outro elemento marcado.
  const intersects = (a, b) => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1;
  for (const group of groups) {
    group.labelOverLabel = group.visible ? groups.filter(other => other !== group && other.visible &&
      intersects(group.button, other.button)).map(other => other.number) : [];
    group.labelOverOtherRing = group.visible ? groups.filter(other => other !== group && other.ringVisible &&
      other.ring.width * other.ring.height <= 60000 && intersects(group.button, other.ring)).map(other => other.number) : [];
  }
  return { present: true, groups, viewport: { width: innerWidth, height: innerHeight },
    scroll: { x: Math.round(scrollX), y: Math.round(scrollY) } };
})()`;

function ringForNumber(number) {
  return `(() => {
    const host = document.querySelector('[data-audita-page-markers-root="v1"]');
    if (!host || !host.shadowRoot) return { present: false, ringVisible: false };
    const group = [...host.shadowRoot.querySelectorAll('.audita-group')].find(node =>
      (node.querySelector('.audita-marker')?.getAttribute('aria-label') ?? '').startsWith('Sinal ${number}:'));
    const ring = group?.querySelector('.audita-ring') ?? null;
    const rect = ring?.getBoundingClientRect() ?? null;
    return { present: true, ringVisible: Boolean(ring) && ring.style.display !== 'none' && rect.width > 0,
      ringRect: rect ? { x: Math.round(rect.left), y: Math.round(rect.top),
        width: Math.round(rect.width), height: Math.round(rect.height) } : null };
  })()`;
}

const HIGHLIGHT_STATE = `(() => {
  const roots = [...document.querySelectorAll('[data-audita-highlight-root]')];
  return roots.map(root => {
    const rect = root.getBoundingClientRect();
    return { text: (root.textContent || '').replace(/\\s+/gu, ' ').trim().slice(0, 80),
      zIndex: getComputedStyle(root).zIndex,
      box: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)] };
  });
})()`;

// ---------------------------------------------------------------------------------------------
// Capturas
// ---------------------------------------------------------------------------------------------

async function writeShot(directory, name, bytes) {
  const path = join(directory, name);
  await writeFile(path, bytes);
  return { name, byteLength: bytes.length };
}

async function captureBytes(target) {
  const result = await command(target, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (typeof result?.data !== 'string') throw new Error('CAPTURA_SEM_DADOS');
  return Buffer.from(result.data, 'base64');
}

async function captureViewport(target, directory, name) {
  return writeShot(directory, name, await captureBytes(target));
}

// O relatório (e o painel) declaram `scroll-behavior: smooth`. Sem desligar isso, um
// `scrollIntoView` continua animando quando a leitura seguinte acontece e o recorte sai do lugar
// errado — foi exatamente o que aconteceu na primeira versão deste roteiro.
const DISABLE_SMOOTH_SCROLL = `(() => {
  if (document.documentElement) document.documentElement.style.scrollBehavior = 'auto';
  return true;
})()`;

async function scrollTo(target, top) {
  return evaluate(target, `(() => { window.scrollTo({ top: ${Math.max(0, Math.round(top))}, left: 0, behavior: 'instant' }); return Math.round(scrollY); })()`);
}

// O painel rola dentro de #panel-root (a janela do painel não rola), então a rolagem da captura
// precisa ser feita no contêiner certo para a imagem mostrar o bloco que ela promete mostrar.
async function scrollPanelTo(panel, selector, margin = 12) {
  return evaluate(panel, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    const scroller = document.querySelector('#panel-root');
    if (!node || !scroller) return false;
    scroller.scrollTo({ top: Math.max(0, Math.round(node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - ${Math.round(margin)})), left: 0, behavior: 'instant' });
    return Math.round(scroller.scrollTop);
  })()`);
}

async function scrollBy(target, delta) {
  return evaluate(target, `(() => { window.scrollBy({ top: ${Math.round(delta)}, left: 0, behavior: 'instant' }); return Math.round(scrollY); })()`);
}

// --- recorte de PNG no próprio roteiro -------------------------------------------------------
//
// O `clip` do `Page.captureScreenshot` não serve para recortar um elemento do relatório: medido
// nesta versão do Chrome, qualquer `clip` faz o Chrome reexpandir a viewport para os ~34 000 px
// do documento, o layout se refaz e o mesmo y devolve outro trecho (a captura saía com o texto do
// "Quadro de constatações" no lugar da miniatura). As três variantes testadas devolveram o mesmo
// PNG de 54 418 bytes do layout reexpandido, com ou sem `captureBeyondViewport`, e a variante em
// coordenadas de viewport devolveu um PNG vazio de 2 149 bytes.
//
// A captura de viewport SEM clip é a única que sempre sai certa. Então é ela que o roteiro usa, e
// o recorte é feito aqui, em cima dos pixels. O PNG do Chrome é 8 bits por canal, sem entrelaçar,
// em RGB (tipo 2) ou RGBA (tipo 6) — o suficiente para decodificar, recortar e recodificar.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// Desfaz os filtros por linha do PNG (tipos 0 a 4, os únicos definidos pela especificação).
function unfilterRows(raw, width, height, bpp) {
  const stride = width * bpp;
  const pixels = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)];
    const source = raw.subarray(row * (stride + 1) + 1, row * (stride + 1) + 1 + stride);
    const target = pixels.subarray(row * stride, (row + 1) * stride);
    const previous = row === 0 ? null : pixels.subarray((row - 1) * stride, row * stride);
    for (let column = 0; column < stride; column += 1) {
      const left = column >= bpp ? target[column - bpp] : 0;
      const up = previous ? previous[column] : 0;
      const upLeft = previous && column >= bpp ? previous[column - bpp] : 0;
      let value = source[column];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const distanceLeft = Math.abs(estimate - left);
        const distanceUp = Math.abs(estimate - up);
        const distanceUpLeft = Math.abs(estimate - upLeft);
        value += distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft ? left
          : (distanceUp <= distanceUpLeft ? up : upLeft);
      } else if (filter !== 0) {
        throw new Error(`PNG_FILTRO_DESCONHECIDO_${filter}`);
      }
      target[column] = value & 0xff;
    }
  }
  return pixels;
}

function decodePng(bytes) {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('PNG_ASSINATURA_INVALIDA');
  let offset = 8;
  let header = null;
  const parts = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        depth: data[8], colourType: data[9], interlace: data[12],
      };
    } else if (type === 'IDAT') parts.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!header) throw new Error('PNG_SEM_IHDR');
  const { width, height, depth, colourType, interlace } = header;
  if (depth !== 8 || interlace !== 0 || (colourType !== 2 && colourType !== 6)) {
    throw new Error(`PNG_NAO_SUPORTADO_${depth}_${colourType}_${interlace}`);
  }
  const bpp = colourType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(parts));
  const pixels = unfilterRows(raw, width, height, bpp);
  return { width, height, bpp, colourType, pixels };
}

// Recorta um PNG já decodificado. A codificação usa filtro 0 em todas as linhas: perde compressão
// e ganha um reencode sem risco de erro de filtro.
function cropPng(image, box) {
  const left = Math.max(0, Math.min(image.width - 1, Math.round(box.x)));
  const top = Math.max(0, Math.min(image.height - 1, Math.round(box.y)));
  const width = Math.max(1, Math.min(Math.round(box.width), image.width - left));
  const height = Math.max(1, Math.min(Math.round(box.height), image.height - top));
  const stride = width * image.bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0;
    const start = ((top + row) * image.width + left) * image.bpp;
    image.pixels.copy(raw, row * (stride + 1) + 1, start, start + stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = image.colourType;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Um `<details>` fechado não pinta o que está dentro. As miniaturas de evidência do relatório
// vivem dentro de blocos recolhidos: `getBoundingClientRect()` devolve a geometria que o elemento
// tinha, `checkVisibility()` devolve falso e o pixel que está naquele lugar é de outro conteúdo —
// foi assim que as primeiras versões deste roteiro salvaram o "Quadro de constatações" no lugar da
// miniatura. Abrir os `<details>` acima do alvo é o que faz a captura mostrar o que a pessoa vê.
const CHECK_VISIBLE = `checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })`;

async function revealElement(target, selector, index) {
  const result = await evaluate(target, `(() => {
    const node = [...document.querySelectorAll(${JSON.stringify(selector)})][${index}];
    if (!node) return null;
    let abertos = 0;
    for (let atual = node.parentElement; atual; atual = atual.parentElement) {
      if (atual.tagName === 'DETAILS' && !atual.open) { atual.open = true; abertos += 1; }
    }
    return { abertos, visivel: node.${CHECK_VISIBLE} };
  })()`);
  if (!result) return null;
  if (result.abertos > 0) await sleep(600);
  return result;
}

// Captura de um elemento: revela o que estiver recolhido, rola até ele, tira a captura da viewport
// (sem `clip`) e recorta o PNG pelo retângulo medido. Devolve também o retângulo dentro da imagem,
// para o summary.json dizer onde o elemento está no enquadramento.
async function captureElementClip(target, directory, name, selector, index, options = {}) {
  const maxHeight = options.maxHeight ?? 1_400;
  await evaluate(target, DISABLE_SMOOTH_SCROLL);
  const revealed = await revealElement(target, selector, index);
  if (!revealed) return null;
  const box = await evaluate(target, `(() => {
    const node = [...document.querySelectorAll(${JSON.stringify(selector)})][${index}];
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    window.scrollTo({ top: Math.max(0, Math.round(rect.top + scrollY - 12)), left: 0, behavior: 'instant' });
    return true;
  })()`);
  if (box !== true) return null;
  await sleep(400);
  const measured = await evaluate(target, `(() => {
    const node = [...document.querySelectorAll(${JSON.stringify(selector)})][${index}];
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height,
      viewportHeight: innerHeight, visivel: node.${CHECK_VISIBLE} };
  })()`);
  if (!measured || !(measured.width >= 2) || !(measured.height >= 2)) return null;
  const image = decodePng(await captureBytes(target));
  const truncated = measured.height > Math.min(maxHeight, measured.viewportHeight);
  const height = Math.min(Math.round(measured.height), maxHeight, measured.viewportHeight - Math.round(measured.y));
  if (height < 2) return null;
  const written = await writeShot(directory, name, cropPng(image, {
    x: measured.x, y: measured.y, width: measured.width, height,
  }));
  return { ...written, visivel: measured.visivel, detailsAbertos: revealed.abertos, truncated,
    rect: { x: Math.round(measured.x), y: Math.round(measured.y),
      width: Math.round(measured.width), height } };
}

async function countOf(target, selector) {
  const value = await evaluate(target, `document.querySelectorAll(${JSON.stringify(selector)}).length`);
  return typeof value === 'number' ? value : 0;
}

// ---------------------------------------------------------------------------------------------
// Interações
// ---------------------------------------------------------------------------------------------

// Espera a ação do detalhe assentar e devolve todas as ações observadas mais a de destaque — que
// pode ser o estado de espera ("highlight-checking") ou nenhuma, e isso é a resposta honesta quando
// o destaque ao vivo não é oferecido para o achado.
async function settleDetailAction(panel, timeoutMs = 6_000) {
  await waitForValue(panel, DETAIL_ACTIONS,
    value => Array.isArray(value) && value.some(action => SETTLED_HIGHLIGHT_ACTIONS.includes(action)),
    { timeoutMs, intervalMs: 100 }).catch(() => null);
  const actions = await evaluate(panel, DETAIL_ACTIONS).catch(() => null);
  const listed = Array.isArray(actions) ? actions : [];
  const settled = listed.find(action => SETTLED_HIGHLIGHT_ACTIONS.includes(action));
  return { actions: listed,
    highlight: settled ?? (listed.includes('highlight-checking') ? 'highlight-checking' : null) };
}

async function clickByFocusId(target, focusId) {
  const clicked = await evaluate(target, `(() => {
    const button = [...document.querySelectorAll('button[data-focus-id]')]
      .find(node => node.dataset.focusId === ${JSON.stringify(focusId)});
    if (!button) return false;
    const group = button.closest('details[data-abnt-group]');
    if (group && !group.open) group.querySelector('summary').click();
    button.click();
    return true;
  })()`, { userGesture: true });
  if (clicked !== true) throw new Error(`FOCO_NAO_ENCONTRADO: ${focusId}`);
}

async function waitForPanelScreen(panel, accepted, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  for (;;) {
    let reading = null;
    try { reading = await evaluate(panel, PANEL_SCREEN); } catch { /* a tela pode estar sendo trocada */ }
    if (reading?.screen && seen.at(-1)?.screen !== reading.screen) seen.push({ screen: reading.screen, text: reading.text });
    if (reading?.screen && accepted.includes(reading.screen)) return { ...reading, seen };
    if (Date.now() >= deadline) return { ...(reading ?? { screen: null, auditId: null }), seen, timedOut: true };
    await sleep(500);
  }
}

// A recarga da aba recria o documento do painel: um clique pode cair em um documento que já não
// existe. Repetir o clique no MESMO botão do produto é o que a pessoa faz (tentar de novo), e não
// uma espera cega — a foto do estado continua sendo tirada uma única vez, depois do gesto.
async function clickWhenReady(target, selector, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await click(target, selector); return true; } catch { /* o documento do painel está sendo trocado */ }
    if (Date.now() >= deadline) throw new Error(`CLIQUE_NAO_CHEGOU: ${selector}`);
    await sleep(300);
  }
}

// ---------------------------------------------------------------------------------------------
// Recarga da aba auditada (passo opcional --reload-check)
// ---------------------------------------------------------------------------------------------

// A página recarregou: o endereço é o mesmo, o documento não. O painel não pode desenhar sozinho —
// ele CONVIDA, e o gesto seguinte aceita a versão de agora. Este passo percorre exatamente esses
// dois gestos (com os mesmos botões que a pessoa usa), mede o que foi reencontrado na página e
// repete o par no destaque individual. As capturas 05b–05e são o que a revisão humana olha.
async function captureReload({ panel, page, directory, located, attempt, shot }) {
  const reload = {
    reloaded: false,
    addressBefore: null,
    addressAfter: null,
    sameAddress: null,
    staleLayerAfterReload: null,
    offer: null,
    offerButtonText: null,
    drawnAfterOffer: null,
    relocated: null,
    highlight: { candidates: [], attempts: [], offered: false, drawn: null, boxes: null, buttonText: null },
  };

  reload.addressBefore = (await attempt('recarga-endereco-antes', () => evaluate(page, 'location.href'))).value ?? null;
  // A sentinela marca o documento velho: quando ela some, o documento NOVO assumiu. Sem isso o
  // primeiro gesto do roteiro cairia no painel que a recarga acabou de descartar.
  await attempt('recarga-sentinela', () => evaluate(panel, 'window.__auditaQaPanelBeforeReload = true'));
  await attempt('recarga-sentinela-pagina', () => evaluate(page, 'window.__auditaQaPageBeforeReload = true'));
  const reloaded = await attempt('recarga-pagina', async () => {
    await command(page, 'Page.reload', { ignoreCache: false });
    return waitForValue(page,
      `({ fresh: typeof window.__auditaQaPageBeforeReload === 'undefined', ready: document.readyState })`,
      value => value?.fresh === true && value?.ready === 'complete', { timeoutMs: 60_000, intervalMs: 100 });
  });
  reload.reloaded = reloaded.ok;
  if (!reload.reloaded) return reload;

  reload.addressAfter = (await attempt('recarga-endereco-depois', () => evaluate(page, 'location.href'))).value ?? null;
  reload.sameAddress = reload.addressBefore !== null && reload.addressBefore === reload.addressAfter;
  reload.staleLayerAfterReload = (await attempt('recarga-camada-antiga', () => evaluate(page,
    `document.querySelectorAll('[data-audita-page-markers-root="v1"]').length`))).value ?? null;
  await waitForValue(panel, 'typeof window.__auditaQaPanelBeforeReload', value => value === 'undefined',
    { timeoutMs: 30_000, intervalMs: 200 }).catch(() => null);

  // Pedir os sinais de novo, como a pessoa pede: se o painel ainda acha que eles estão na página,
  // retira primeiro. São os mesmos dois botões do produto, na ordem em que eles aparecem.
  await attempt('recarga-pedir-sinais', async () => {
    const card = await waitForValue(panel, PANEL_MARKERS, value => value?.status !== null,
      { timeoutMs: 30_000, intervalMs: 200 });
    if ((card.actions ?? []).includes('HIDE_PAGE_MARKERS')) {
      await clickWhenReady(panel, '[data-page-marker-review] [data-intent="HIDE_PAGE_MARKERS"]');
      await waitForValue(panel, PANEL_MARKERS, value => (value?.actions ?? []).includes('SHOW_PAGE_MARKERS'),
        { timeoutMs: 30_000, intervalMs: 200 });
    }
    await clickWhenReady(panel, '[data-page-marker-review] [data-intent="SHOW_PAGE_MARKERS"]');
    return true;
  });
  const offered = await attempt('recarga-convite', () => waitForValue(panel, PANEL_MARKERS,
    value => ['reload-offer', 'changed-address', 'active', 'unavailable'].includes(value?.status),
    { timeoutMs: 120_000, intervalMs: 200 }));
  reload.offer = offered.value
    ? { status: offered.value.status, message: offered.value.message, actions: offered.value.actions ?? [] }
    : null;
  await attempt('recarga-painel-visivel', async () => {
    await command(panel, 'Page.bringToFront');
    await scrollPanelTo(panel, '[data-page-marker-review]', 8);
    await sleep(300);
    return true;
  });
  await shot('05b-recarga-painel.png', () => captureViewport(panel, directory, '05b-recarga-painel.png'));
  if (reload.offer?.status !== 'reload-offer') return reload;

  reload.offerButtonText = (await attempt('recarga-texto-do-convite', () => evaluate(panel,
    `document.querySelector('[data-page-marker-review] [data-intent="SHOW_PAGE_MARKERS_RELOADED"]')?.textContent ?? null`))).value ?? null;
  // O convite sozinho não desenha nada: quem mostra a versão de agora é o gesto seguinte.
  reload.drawnAfterOffer = (await attempt('recarga-camada-apos-convite', () => evaluate(page,
    `document.querySelectorAll('[data-audita-page-markers-root="v1"]').length`))).value ?? null;

  await attempt('recarga-aceitar', () => clickWhenReady(panel, '[data-page-marker-review] [data-intent="SHOW_PAGE_MARKERS_RELOADED"]'));
  const accepted = await attempt('recarga-sinais', () => waitForValue(panel, PANEL_MARKERS,
    value => ['active', 'unavailable'].includes(value?.status), { timeoutMs: 120_000, intervalMs: 200 }));
  const drawn = await attempt('recarga-ler-sinais', () => evaluate(page, OVERLAY_STATE));
  const groups = drawn.value?.groups ?? [];
  reload.relocated = {
    status: accepted.value?.status ?? null,
    message: accepted.value?.message ?? null,
    noteInPanel: (await attempt('recarga-aviso', () => evaluate(panel,
      `document.querySelector('[data-page-marker-relocated]')?.textContent ?? null`))).value ?? null,
    drawn: groups.filter(group => group.visible).length,
    onScreen: groups.filter(group => group.onScreen).length,
    precise: groups.filter(group => group.targetCandidateCount >= 1).length,
    numbers: groups.map(group => group.number),
  };
  await attempt('recarga-focar-pagina', () => command(page, 'Page.bringToFront'));
  await attempt('recarga-topo', () => scrollTo(page, 0));
  await sleep(400);
  await shot('05c-recarga-sinais.png', () => captureViewport(page, directory, '05c-recarga-sinais.png'));

  // O destaque individual segue a mesma lógica no documento novo: a primeira tentativa convida, o
  // gesto seguinte desenha a caixa. Um alvo que a página não tem como mostrar (elemento de slide
  // oculto, por exemplo) é recusado pelo produto mesmo com o convite aceito — por isso o roteiro
  // percorre os sinais que a própria página acabou de desenhar, como a pessoa faria, e registra o
  // que o painel respondeu em cada um. Se a oferta já vier pronta (o convite já estava na tela), o
  // gesto de aceitar é o mesmo.
  const visibleNumbers = new Set(groups.filter(group => group.visible).map(group => group.number));
  const withHighlight = located.filter(occurrence => occurrence.action === 'highlight-occurrence');
  const candidates = [...withHighlight.filter(occurrence => visibleNumbers.has(Number(occurrence.number))),
    ...withHighlight.filter(occurrence => !visibleNumbers.has(Number(occurrence.number)))].slice(0, 3);
  reload.highlight.candidates = candidates.map(occurrence => Number(occurrence.number));
  for (const candidate of candidates) {
    const entry = { number: Number(candidate.number), firstAttempt: null, offered: false, buttonText: null,
      drawn: 0, boxes: null, announcements: null, afterInvite: null };
    reload.highlight.attempts.push(entry);
    const first = await attempt(`recarga-destaque-${entry.number}`, async () => {
      await clickByFocusId(panel, candidate.focusId);
      return settleDetailAction(panel, 10_000);
    });
    entry.firstAttempt = first.value?.highlight ?? null;
    let offeredHighlight = entry.firstAttempt === 'highlight-reloaded';
    if (entry.firstAttempt === 'highlight-occurrence') {
      const invited = await attempt(`recarga-destaque-convite-${entry.number}`, async () => {
        await click(panel, '[data-result-detail] .detail-actions [data-action="highlight-occurrence"]');
        return waitForValue(panel, DETAIL_ACTIONS,
          value => Array.isArray(value) && value.includes('highlight-reloaded'), { timeoutMs: 30_000, intervalMs: 100 });
      });
      offeredHighlight = invited.ok === true;
      entry.afterInvite = (await attempt(`recarga-destaque-sem-caixa-${entry.number}`, () => evaluate(page, HIGHLIGHT_STATE))).value?.length ?? null;
      if (offeredHighlight) {
        // A captura do convite é do painel: ele precisa estar à frente, e com o botão do convite à
        // vista, senão a imagem mostra uma parte da tela que não tem o que ela promete.
        await attempt('recarga-destaque-painel-visivel', async () => {
          await command(panel, 'Page.bringToFront');
          await scrollPanelTo(panel, '[data-result-detail] .detail-actions', 140);
          await sleep(300);
          return true;
        });
        await shot('05d-recarga-destaque-convite.png', () => captureViewport(panel, directory, '05d-recarga-destaque-convite.png'));
      }
    }
    entry.offered = offeredHighlight;
    if (!offeredHighlight) continue;
    entry.buttonText = (await attempt(`recarga-destaque-texto-${entry.number}`, () => evaluate(panel,
      `document.querySelector('[data-result-detail] .detail-actions [data-action="highlight-reloaded"]')?.textContent ?? null`))).value ?? null;
    await attempt(`recarga-destaque-aceitar-${entry.number}`, async () => {
      await click(panel, '[data-result-detail] .detail-actions [data-action="highlight-reloaded"]');
      return waitForValue(page, `document.querySelectorAll('[data-audita-highlight-root]').length`,
        value => value === 1, { timeoutMs: 20_000, intervalMs: 100 });
    });
    const boxes = await attempt(`recarga-destaque-caixa-${entry.number}`, () => evaluate(page, HIGHLIGHT_STATE));
    entry.boxes = boxes.value ?? null;
    entry.drawn = boxes.value?.length ?? 0;
    // O que o PAINEL diz e oferece depois do gesto: a resposta do produto quando a caixa não entra
    // fica na região viva, e o botão de limpar é a prova de que o painel assumiu o destaque.
    // A caixa entra na página antes de o painel receber a resposta, então a leitura espera o painel
    // decidir — senão a captura pega o convite que ainda estava na tela.
    entry.panelActions = (await attempt(`recarga-destaque-acoes-${entry.number}`, () => waitForValue(panel,
      `(() => ({ actions: ${DETAIL_ACTIONS}, live: ${PANEL_HIGHLIGHT_LIVE} }))()`,
      value => (value?.actions ?? []).includes('clear-highlight') || /Não foi possível destacar/u.test((value?.live ?? []).join(' ')),
      { timeoutMs: 15_000, intervalMs: 100 }))).value?.actions ?? null;
    entry.announcements = (await attempt(`recarga-destaque-aviso-${entry.number}`, () => evaluate(panel, PANEL_HIGHLIGHT_LIVE))).value ?? null;
    if (entry.drawn === 0) continue;
    reload.highlight.drawn = entry.drawn;
    reload.highlight.boxes = entry.boxes;
    reload.highlight.buttonText = entry.buttonText;
    await attempt('recarga-destaque-focar-pagina', () => command(page, 'Page.bringToFront'));
    await sleep(300);
    await shot('05e-recarga-destaque.png', () => captureViewport(page, directory, '05e-recarga-destaque.png'));
    // Uma caixa acesa sujaria as capturas seguintes: o roteiro limpa como a pessoa limparia, pelo
    // botão do detalhe ou pelo botão global de destaque ativo — o produto oferece os dois.
    await attempt('recarga-destaque-limpar', async () => {
      const cleared = await evaluate(panel, `(() => {
        const node = document.querySelector('[data-result-detail] .detail-actions [data-action="clear-highlight"]')
          ?? document.querySelector('[data-action="clear-highlight"]');
        if (!node || node.disabled) return false;
        node.click();
        return true;
      })()`, { userGesture: true });
      if (cleared !== true) throw new Error('SEM_BOTAO_DE_LIMPAR');
      return waitForValue(page, `document.querySelectorAll('[data-audita-highlight-root]').length`,
        value => value === 0, { timeoutMs: 15_000, intervalMs: 100 });
    });
    break;
  }
  reload.highlight.offered = reload.highlight.attempts.some(entry => entry.offered);
  if (reload.highlight.drawn === null) reload.highlight.drawn = 0;
  return reload;
}

// ---------------------------------------------------------------------------------------------
// Uma página
// ---------------------------------------------------------------------------------------------

async function auditPage({ target, outRoot, cleanups, chromeBinary, reloadCheck = false }) {
  const directory = join(outRoot, target.slug);
  await mkdir(directory, { recursive: true });
  const summary = {
    url: target.url,
    slug: target.slug,
    directory: relative(outRoot, directory) || '.',
    outcome: 'nao-concluido',
    auditId: null,
    screenshots: [],
    errors: [],
    panel: null,
    findings: null,
    signals: null,
    unlocated: [],
    selections: [],
    selectionProbe: [],
    highlight: null,
    persistence: null,
    reload: null,
    report: null,
  };
  const cleanupHost = { after: handler => cleanups.push(handler) };

  const record = (stage, error) => {
    summary.errors.push({ stage, detail: describeError(error) });
    process.stderr.write(`  ! ${target.slug} · ${stage}: ${describeError(error)}\n`);
  };
  const attempt = async (stage, operation) => {
    try { return { ok: true, value: await operation() }; }
    catch (error) { record(stage, error); return { ok: false, value: null }; }
  };
  const shot = async (name, operation) => {
    const result = await attempt(`captura:${name}`, operation);
    if (result.ok && result.value) summary.screenshots.push(result.value.name);
    return result.ok;
  };

  let launch = null;
  try {
    const launched = await attempt('abrir-chrome', () => launchUnpackedExtension(cleanupHost, {
      extensionPath: WORKSPACE_ROOT,
      startUrl: target.url,
      chromeBinary,
      expectedMajor: CHROME_MAJOR,
      viewport: { ...VIEWPORT },
      // Os quatro arquivos entregues são lidos do disco (bloco k). O modo `profile` grava a pasta de
      // download nas preferências do perfil, o mesmo caminho que a exportação real usa nas provas de
      // Entrega — sem isso o download iniciado pela extensão não chega a um arquivo para conferir.
      downloadMode: 'profile',
    }));
    if (!launched.ok) { summary.errors.push({ stage: 'abrir-chrome', detail: 'sem navegador' }); return summary; }
    launch = launched.value;
    const page = launch.startPage.page;
    summary.chrome = launch.chromeProduct;

    // (a) painel + auditoria da página atual COM capturas de pixel ---------------------------
    const opened = await attempt('abrir-painel', () => launch.openSidePanelFromAction());
    if (!opened.ok) return summary;
    const panel = opened.value;
    await attempt('focar-painel', () => command(panel, 'Page.bringToFront'));
    await attempt('painel-visivel', () => waitForValue(panel, 'document.visibilityState',
      value => value === 'visible', { timeoutMs: 15_000 }));

    const ready = await attempt('painel-pronto', () => waitForValue(panel, PANEL_READY, Boolean,
      { timeoutMs: 60_000, intervalMs: 100 }));
    if (!ready.ok) return summary;

    const started = await attempt('iniciar-auditoria', async () => {
      await click(panel, `input[data-capture-mode="${CAPTURE_MODE}"]`);
      await sleep(400);
      await click(panel, 'button[data-intent="START_ATTACHED"]');
      return true;
    });
    if (!started.ok) return summary;

    let outcome = await attempt('aguardar-resultado', () => waitForPanelScreen(panel, ['result', 'unavailable'], 180_000));
    // Páginas que se recarregam sozinhas quando o painel abre: o painel recriado explica e oferece "Tentar
    // novamente". O roteiro registra a recarga (é parte do que o usuário vê) e tenta de novo, como ele faria.
    summary.selfReloads = 0;
    if (outcome.value?.screen === 'unavailable' && !/recarregou/u.test(String(outcome.value?.text ?? ''))) {
      // O painel antigo pode mostrar a negação genérica por um instante antes de ser recriado pela recarga.
      await sleep(5000);
      outcome = await attempt('aguardar-resultado', () => waitForPanelScreen(panel, ['result', 'unavailable'], 180_000));
    }
    for (let retry = 0; retry < 2 && outcome.value?.screen === 'unavailable' &&
      /recarregou/u.test(String(outcome.value?.text ?? '')); retry += 1) {
      summary.selfReloads += 1;
      await shot(`00-recarga-${retry + 1}.png`, () => captureViewport(panel, directory, `00-recarga-${retry + 1}.png`));
      await sleep(3000);
      await attempt('tentar-novamente', () => click(panel, 'button[data-intent="RETRY"]'));
      await sleep(2000);
      outcome = await attempt('aguardar-resultado', () => waitForPanelScreen(panel, ['result', 'unavailable'], 180_000));
    }
    const finalScreen = outcome.value ?? { screen: null, auditId: null };
    summary.outcome = finalScreen.screen ?? 'desconhecido';
    summary.auditId = finalScreen.auditId ?? null;
    summary.panelScreens = finalScreen.seen ?? [];
    if (summary.outcome !== 'result') {
      record('auditoria-sem-resultado', Object.assign(new Error('TELA_FINAL'), { code: `tela=${summary.outcome}` }));
      await shot('01-painel.png', () => captureViewport(panel, directory, '01-painel.png'));
      return summary;
    }

    // A tela de resultado aparece antes dos cartões serem renderizados.
    await attempt('cartoes-do-resultado', () => waitForValue(panel,
      `document.querySelectorAll('[data-result-card]').length`, value => typeof value === 'number' && value > 0,
      { timeoutMs: 30_000, intervalMs: 100 }));

    // (b) painel no resultado -----------------------------------------------------------------
    await shot('01-painel.png', () => captureViewport(panel, directory, '01-painel.png'));

    // (c) sinais na página ---------------------------------------------------------------------
    const markers = await attempt('mostrar-sinais', async () => {
      await click(panel, '[data-intent="SHOW_PAGE_MARKERS"]');
      return waitForValue(panel, PANEL_MARKERS,
        value => ['active', 'unavailable'].includes(value?.status), { timeoutMs: 120_000, intervalMs: 200 });
    });
    summary.panel = markers.value ?? null;
    if (!markers.ok || !summary.panel) {
      record('sinais-indisponiveis', new Error('o painel não informou o estado dos sinais'));
      return summary;
    }
    summary.findings = describeFindings(summary.panel);
    summary.unlocated = (summary.panel.cards ?? []).flatMap(card => card.occurrences
      .filter(occurrence => occurrence.number === null)
      .map(occurrence => ({ title: card.title, classification: card.classification,
        context: card.context, focusId: occurrence.focusId, motivo: 'sem número de sinal atribuído pelo painel' })));

    // A explicação do produto para um achado sem sinal vem no detalhe; ler uma vez já nomeia o
    // motivo que vale para os outros, e a leitura é feita sobre um achado realmente sem sinal.
    if (summary.unlocated.length > 0) {
      const sample = summary.unlocated[0];
      const detail = await attempt('motivo-nao-localizado', async () => {
        await clickByFocusId(panel, sample.focusId);
        await sleep(400);
        return evaluate(panel, PANEL_DETAIL);
      });
      summary.unlocatedReason = detail.value?.limitation ?? null;
      // O bloco técnico do detalhe traz o seletor registrado: é o que explica por que não houve sinal.
      for (const entry of summary.unlocated.slice(0, 12)) {
        const technical = await attempt('tecnico-nao-localizado', async () => {
          await clickByFocusId(panel, entry.focusId);
          await sleep(250);
          return evaluate(panel, `(document.querySelector('[data-detail-block="technical"]')?.textContent ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 600)`);
        });
        entry.tecnico = technical.value ?? null;
      }
      summary.unlocatedPanelReasons = (await attempt('motivos-painel', () => evaluate(panel,
        `[...document.querySelectorAll('[data-page-marker-review] li')].map(node => node.textContent.trim()).slice(0, 20)`))).value ?? null;
    }

    await attempt('painel-sinais-visivel', () => evaluate(panel, `(() => {
      document.documentElement.style.scrollBehavior = 'auto';
      const node = document.querySelector('[data-page-marker-review]');
      if (!node) return false;
      window.scrollTo({ top: Math.max(0, Math.round(node.getBoundingClientRect().top + scrollY - 8)), behavior: 'instant' });
      return true;
    })()`));
    await sleep(300);
    await shot('01b-painel-sinais.png', () => captureViewport(panel, directory, '01b-painel-sinais.png'));

    await attempt('focar-pagina', () => command(page, 'Page.bringToFront'));
    await attempt('rolagem-instante', () => evaluate(page, DISABLE_SMOOTH_SCROLL));
    await attempt('topo-da-pagina', () => scrollTo(page, 0));
    await sleep(500);
    await shot('02-sinais-topo.png', () => captureViewport(page, directory, '02-sinais-topo.png'));

    const geometry = await attempt('medir-rolagem', () => evaluate(page,
      '({ scrollHeight: document.documentElement.scrollHeight, innerHeight: innerHeight })'));
    const scrollable = Math.max(0, (geometry.value?.scrollHeight ?? 0) - (geometry.value?.innerHeight ?? 0));
    for (let index = 0; index < ROLLING_SHOTS; index += 1) {
      const position = Math.round(scrollable * ((index + 1) / ROLLING_SHOTS));
      await attempt('rolar-pagina', () => scrollTo(page, position));
      await sleep(500);
      await shot(`03-sinais-rolagem-${index + 1}.png`,
        () => captureViewport(page, directory, `03-sinais-rolagem-${index + 1}.png`));
    }
    await attempt('voltar-ao-topo', () => scrollTo(page, 0));
    await sleep(400);

    // (d) o que foi desenhado e onde ------------------------------------------------------------
    const overlay = await attempt('ler-sinais', () => evaluate(page, OVERLAY_STATE));
    summary.signals = overlay.value ?? null;
    if (summary.signals?.groups) {
      summary.signals.drawn = summary.signals.groups.filter(group => group.visible).length;
      summary.signals.onScreen = summary.signals.groups.filter(group => group.onScreen).length;
      summary.signals.withRing = summary.signals.groups.filter(group => group.ringVisible).length;
      summary.signals.numbers = summary.signals.groups.map(group => group.number);
      // A métrica do rótulo: quantas etiquetas caem em cima de uma linha de texto de OUTRO elemento.
      summary.signals.labelsOverText = summary.signals.groups.filter(group => (group.labelOnTextCount ?? 0) > 0).length;
      summary.signals.textLinesCovered = summary.signals.groups.reduce((total, group) => total + (group.labelOnTextCount ?? 0), 0);
      summary.signals.textLinesInViewport = summary.signals.groups[0]?.labelOnTextLines ?? 0;
    }

    // (e) selecionar achados na página e medir persistência -------------------------------------
    const located = (summary.panel.cards ?? []).flatMap(card => card.occurrences
      .filter(occurrence => occurrence.number !== null)
      .map(occurrence => ({ ...occurrence, title: card.title, classification: card.classification })));
    // A varredura pergunta ao painel, para cada sinal distinto, qual ação de destaque ele oferece.
    // O destaque ao vivo ("Ver e destacar na página") só existe quando o worker confirma o vínculo
    // com o elemento — o tipo do achado não permite supor isso, e sem a varredura as capturas
    // sairiam sem a marcação mais forte justamente nos sinais que a oferecem.
    const probe = [];
    const probedNumbers = new Set();
    for (const occurrence of located) {
      if (probe.length >= SELECTION_PROBES) break;
      const number = Number(occurrence.number);
      if (probedNumbers.has(number)) continue;
      probedNumbers.add(number);
      const observed = await attempt(`reconhecer-sinal-${number}`, async () => {
        await clickByFocusId(panel, occurrence.focusId);
        return settleDetailAction(panel);
      });
      probe.push({ number, focusId: occurrence.focusId, classification: occurrence.classification,
        title: occurrence.title, action: observed.value?.highlight ?? null,
        actions: observed.value?.actions ?? [], reason: observed.ok ? null : 'a varredura falhou' });
    }
    summary.selectionProbe = probe;

    // Os que oferecem o destaque ao vivo vêm primeiro; a ordem original decide o resto.
    const chosen = [...probe]
      .sort((left, right) => Number(right.action === 'highlight-occurrence') - Number(left.action === 'highlight-occurrence'))
      .slice(0, SELECTIONS_PER_PAGE);
    for (const [index, occurrence] of chosen.entries()) {
      const number = Number(occurrence.number);
      const name = `04-selecionado-${index + 1}.png`;
      const entry = { number, title: occurrence.title, classification: occurrence.classification,
        focusId: occurrence.focusId, screenshot: null, ringVisible: false,
        highlightOffered: false, highlightAction: null, highlightBox: null };
      const selected = await attempt(`selecionar-${index + 1}`, async () => {
        await clickByFocusId(panel, occurrence.focusId);
        // Como o usuário faria: "Ir ao elemento do sinal N" rola a página até o elemento e o seleciona.
        await sleep(250);
        const go = await evaluate(panel, `Boolean(document.querySelector('[data-result-detail] .detail-actions [data-action="go-to-page-marker"]'))`);
        if (go) await click(panel, '[data-result-detail] .detail-actions [data-action="go-to-page-marker"]');
        await waitForValue(page, ringForNumber(number), value => value?.ringVisible === true,
          { timeoutMs: 15_000, intervalMs: 100 });
        await sleep(300);
        return true;
      });
      entry.ringVisible = selected.ok;
      if (!selected.ok) entry.erro = 'o anel do sinal selecionado não apareceu na página';

      // O anel marca o sinal escolhido; o "Destacar elemento na página" acrescenta a caixa com o
      // rótulo da falha, que é a marcação mais forte que a pessoa vê. Vale capturar as duas.
      //
      // A oferta do destaque não é imediata: o painel confere a disponibilidade depois de montar o
      // detalhe, e um achado sem elemento ao vivo oferece "consult-evidence" no lugar. Por isso a
      // espera, e não uma leitura só — ler de imediato devolvia `null` e nenhum destaque era feito.
      const highlight = await attempt(`destacar-${index + 1}`, async () => {
        const { highlight: action, actions } = await settleDetailAction(panel, 8_000);
        if (action !== 'highlight-occurrence') return { offered: false, action, actions };
        await click(panel, '[data-result-detail] .detail-actions [data-action="highlight-occurrence"]');
        await waitForValue(page, `document.querySelectorAll('[data-audita-highlight-root]').length`,
          value => value === 1, { timeoutMs: 15_000, intervalMs: 100 });
        await sleep(300);
        return { offered: true, action, actions };
      });
      entry.highlightOffered = highlight.value?.offered === true;
      entry.highlightAction = highlight.value?.action ?? null;
      if (entry.highlightOffered) {
        const boxes = await evaluate(page, HIGHLIGHT_STATE);
        entry.highlightBox = boxes?.[0]?.box ?? null;
      }

      entry.screenshot = (await shot(name, () => captureViewport(page, directory, name))) ? name : null;
      summary.selections.push(entry);

      // Cada captura mostra um único destaque: limpar antes da próxima seleção evita empilhar
      // caixas e deixa a imagem comparável com as outras.
      if (entry.highlightOffered) {
        await attempt(`limpar-destaque-${index + 1}`, async () => {
          await click(panel, '[data-result-detail] .detail-actions [data-action="clear-highlight"]');
          await waitForValue(page, `document.querySelectorAll('[data-audita-highlight-root]').length`,
            value => value === 0, { timeoutMs: 10_000, intervalMs: 100 });
        });
      }
    }

    const highlight = await attempt('ler-destaque', () => evaluate(page, HIGHLIGHT_STATE));
    summary.highlight = highlight.value ?? null;

    // Persistência: 6 s sem interação (o carrossel da fixture muda de slide duas vezes nesse
    // intervalo), depois ponteiro sobre a página e uma rolagem curta.
    const before = await attempt('ler-sinais-antes', () => evaluate(page, OVERLAY_STATE));
    await sleep(PERSISTENCE_WAIT_MS);
    for (const [x, y] of [[240, 260], [720, 520], [420, 700]]) {
      await attempt('mexer-ponteiro', () => command(page, 'Input.dispatchMouseEvent',
        { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }));
      await sleep(120);
    }
    await attempt('rolar-pouco', () => scrollBy(page, 180));
    await sleep(700);
    const after = await attempt('ler-sinais-depois', () => evaluate(page, OVERLAY_STATE));
    const afterPanel = await attempt('ler-painel-depois', () => evaluate(panel, PANEL_MARKERS));
    // Sinais fora da tela ou de slide oculto ficam escondidos de propósito: persistência é o overlay
    // continuar instalado com os mesmos grupos, não o mesmo conjunto visível.
    const numbersBefore = (before.value?.groups ?? []).map(group => group.number).sort((a, b) => a - b);
    const numbersAfter = (after.value?.groups ?? []).map(group => group.number).sort((a, b) => a - b);
    summary.persistence = {
      waitedMs: PERSISTENCE_WAIT_MS,
      movedPointer: true,
      scrolled: true,
      before: { present: before.value?.present === true, drawn: numbersBefore.length, numbers: numbersBefore },
      after: { present: after.value?.present === true, drawn: numbersAfter.length, numbers: numbersAfter,
        panelStatus: afterPanel.value?.status ?? null },
      survived: after.value?.present === true && numbersAfter.length > 0 &&
        numbersAfter.length >= numbersBefore.length &&
        numbersAfter.every((number, index) => number === numbersBefore[index]),
    };
    await shot('05-persistencia.png', () => captureViewport(page, directory, '05-persistencia.png'));

    // (e2) a aba recarrega e os sinais voltam para a versão de agora (opcional) --------------------
    if (reloadCheck) {
      summary.reload = await captureReload({ panel, page, directory, located: probe, attempt, shot });
    }

    // (f) relatório ------------------------------------------------------------------------------
    summary.report = await captureReport({ launch, panel, page, directory, attempt, shot });

    return summary;
  } catch (error) {
    record('inesperado', error);
    return summary;
  } finally {
    if (launch) await launch.close().catch(() => {});
  }
}

function describeFindings(panel) {
  const numbers = [...(panel.countRows ?? [])].map(row => {
    const match = /^(\d+)/u.exec(String(row).trim());
    return match ? Number.parseInt(match[1], 10) : null;
  });
  const [markers, located, general, unlocated, omitted] = numbers;
  return {
    elementosSinalizados: markers ?? null,
    ocorrenciasLocalizadas: located ?? null,
    questoesGerais: general ?? null,
    ocorrenciasNaoLocalizadas: unlocated ?? null,
    ocorrenciasOmitidas: omitted ?? null,
    achadosComElemento: located !== null && unlocated !== null ? located + unlocated : null,
    resumoDoPainel: panel.countRows ?? [],
  };
}

// A lista de suspeitos do mapa do teclado como o relatório a guardou, não como ela aparece na tela:
// nome, motivo e a tag do elemento são o que permite classificar à mão cada suspeito em verdadeiro ou
// falso positivo. A página do relatório é uma página da própria extensão, então ela mesma consegue
// abrir o armazenamento e devolver o artefato do mapa.
function keyboardSuspectsExpression(auditId) {
  return `import(chrome.runtime.getURL('/src/storage/audit-store.js')).then(module =>
    module.createAuditStore().getReportRevision(${JSON.stringify(auditId)})).then(revision => {
    const artifact = (revision?.model?.evidence ?? []).find(item => item.kind === 'keyboard-map');
    if (!artifact) return { present: false, suspects: [] };
    return { present: true, status: artifact.status ?? null,
      counts: artifact.counts ?? null, limitations: artifact.limitations ?? [],
      suspects: (artifact.suspects ?? []).map(entry => ({ number: entry.number,
        nodeId: entry.nodeId, tag: entry.tag, role: entry.role, reason: entry.reason,
        ruleId: entry.ruleId, name: entry.name, nameSource: entry.nameSource,
        nameStatus: entry.nameStatus, bounds: entry.bounds })) };
  })`;
}

/**
 * Cadeia de ancestrais de cada suspeito, medida na própria página auditada.
 *
 * O artefato do mapa guarda só o retângulo, a tag e o motivo de cada suspeito; para classificar à mão
 * um item em verdadeiro ou falso positivo falta saber o que está em volta dele — se está dentro de um
 * link, se um contêiner grande declara a seta de clique, se o Texto que o nomeia é do próprio item.
 * O retângulo do artefato está em coordenadas de documento (o mesmo espaço do DOMSnapshot), então o
 * elemento é encontrado comparando `getBoundingClientRect()` mais a rolagem.
 */
function suspectContextExpression(suspects) {
  const wanted = (Array.isArray(suspects) ? suspects : []).map(entry => ({
    number: entry.number, tag: entry.tag, bounds: entry.bounds,
  }));
  return `(() => {
    const wanted = ${JSON.stringify(wanted)};
    const TABBABLE = 'a[href],button,input:not([type="hidden"]),select,textarea,[tabindex],[contenteditable="true"]';
    const describe = element => {
      if (!element || element === document.documentElement) return null;
      const style = getComputedStyle(element);
      return {
        tag: element.tagName.toLowerCase(),
        href: element.getAttribute('href'),
        tabindex: element.getAttribute('tabindex'),
        role: element.getAttribute('role'),
        cursor: style.cursor,
        display: style.display,
        texto: (element.textContent || '').replace(/\\s+/gu, ' ').trim().slice(0, 60),
      };
    };
    const elements = [...document.querySelectorAll('body *')];
    const place = element => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height };
    };
    return wanted.map(entry => {
      const box = entry.bounds;
      if (!box) return { number: entry.number, encontrado: false };
      const sameBox = elements.filter(element => {
        const rect = place(element);
        return Math.abs(rect.x - box.x) <= 1.5 && Math.abs(rect.y - box.y) <= 1.5 &&
          Math.abs(rect.width - box.width) <= 1.5 && Math.abs(rect.height - box.height) <= 1.5;
      });
      // Vários elementos dividem o mesmo retângulo (o link e a imagem de dentro dele, por exemplo):
      // o suspeito é o que casa também a tag registrada pelo mapa.
      const node = sameBox.find(element => element.tagName.toLowerCase() === entry.tag) ?? sameBox[0] ?? null;
      const ancestors = [];
      for (let current = node?.parentElement; current && ancestors.length < 8; current = current.parentElement) {
        const described = describe(current);
        if (described) ancestors.push(described);
        if (described?.tag === 'body') break;
      }
      // Quem responde à pergunta do mapa: existe alguma parada do Tab acima do item?
      const ancestralParada = node?.parentElement
        ? node.parentElement.closest(TABBABLE) : null;
      return {
        number: entry.number,
        encontrado: Boolean(node),
        mesmaCaixa: sameBox.map(element => element.tagName.toLowerCase()),
        proprio: describe(node),
        ancestralParada: describe(ancestralParada),
        pais: ancestors,
      };
    });
  })()`;
}

async function captureReport({ launch, panel, page, directory, attempt, shot }) {
  const report = { opened: false, screenshots: [], evidenceFigures: 0, evidenceCaptured: 0, launchMessage: null };
  // A frase que o painel mostra depois do clique diz se a abertura foi feita: é ela que decide se
  // vale repetir o gesto, e não o tempo que a aba levou para aparecer.
  const launchMessage = async () => (await attempt('mensagem-do-relatorio', () => evaluate(panel,
    `document.querySelector('[data-report-launch-status]')?.textContent ?? null`))).value ?? null;
  const open = () => attempt('abrir-relatorio', async () => {
    await click(panel, 'button[data-intent="OPEN_REPORT"]');
    return launch.waitForReport({ auditId: await readAuditId(panel) });
  });
  let opened = await open();
  report.launchMessage = await launchMessage();
  // O painel avisa quando a abertura falhou; repetir o clique é o "Tente novamente" que ele oferece.
  // Com a aba já abrindo, um segundo clique criaria duas abas e embaraçaria a prova — por isso o
  // retry só acontece quando a frase do próprio painel diz que não abriu.
  if (!opened.ok && /Não foi possível abrir/u.test(report.launchMessage ?? '')) {
    opened = await open();
    report.launchMessage = await launchMessage();
  }
  if (!opened.ok || !opened.value) return report;
  const target = opened.value;
  report.opened = true;
  await attempt('focar-relatorio', () => command(target, 'Page.bringToFront'));
  const ready = await attempt('relatorio-pronto', () => waitForValue(target,
    `Boolean(document.querySelector('button[data-report-export]'))`, Boolean, { timeoutMs: 60_000, intervalMs: 100 }));
  if (!ready.ok) return report;
  // As imagens de evidência são data-URLs; esperar a decodificação evita capturar um quadro vazio.
  await sleep(1_200);

  await attempt('rolagem-instante', () => evaluate(target, DISABLE_SMOOTH_SCROLL));
  await attempt('topo-do-relatorio', () => scrollTo(target, 0));
  await sleep(400);
  await shot('06-relatorio-1.png', () => captureViewport(target, directory, '06-relatorio-1.png'));

  const visible = await attempt('contar-evidencias-visiveis', () => evaluate(target,
    `document.querySelectorAll('figure[data-evidence-kind]').length
      ? [...document.querySelectorAll('figure[data-evidence-kind]')].filter(node => node.${CHECK_VISIBLE}).length
      : 0`));
  report.evidenceVisibleBefore = visible.value ?? 0;

  const previewCount = await attempt('contar-evidencias', () => countOf(target, '[data-report-evidence-preview]'));
  for (let index = 0; index < Math.min(previewCount.value ?? 0, ROLLING_SHOTS); index += 1) {
    const name = `06-relatorio-${index + 2}.png`;
    const saved = await attempt(`captura:${name}`, () => captureElementClip(target, directory, name,
      '[data-report-evidence-preview]', index));
    if (saved.ok && saved.value) report.screenshots.push(saved.value.name);
  }

  const figures = await attempt('contar-figuras', () =>
    countOf(target, '[data-report-evidence-preview] figure[data-evidence-kind]'));
  report.evidenceFigures = figures.value ?? 0;
  for (let index = 0; index < Math.min(report.evidenceFigures, 6); index += 1) {
    const name = `07-evidencia-${index + 1}.png`;
    const saved = await attempt(`captura:${name}`, () => captureElementClip(target, directory, name,
      '[data-report-evidence-preview] figure[data-evidence-kind]', index, { maxHeight: 900 }));
    if (saved.ok && saved.value) { report.screenshots.push(saved.value.name); report.evidenceCaptured += 1; }
  }

  // (g) mapa anotado (mapa de anúncios) ---------------------------------------------------------
  // O cartão do mapa do teclado usa as mesmas classes de cartão e de estado: sem excluí-lo aqui,
  // `article.map-card` casaria com dois cartões e a captura do mapa de anúncios poderia sair errada.
  const mapCard = 'article.map-card:not(.keyboard-map-card)';
  const map = await attempt('ler-mapa', () => evaluate(target, `(() => {
    const cards = [...document.querySelectorAll('${mapCard}')];
    return { present: cards.length > 0,
      statuses: cards.map(card => card.dataset.mapStatus),
      segments: document.querySelectorAll('figure.announcement-map-segment').length };
  })()`));
  report.map = map.value ?? null;
  if (map.value?.present && (map.value.statuses ?? []).some(status => status !== 'absent')) {
    const saved = await attempt('captura:08-mapa.png', () => captureElementClip(target, directory, '08-mapa.png',
      mapCard, 0, { maxHeight: 1_400 }));
    if (saved.ok && saved.value) report.screenshots.push(saved.value.name);
  }

  // (h) mapa do teclado -------------------------------------------------------------------------
  // É a única prova visual do item 5.1.13: só aqui se vê se um item que a pessoa usaria ficou sem
  // caixa azul numerada. Sem esta captura, a revisão humana do item confere apenas o mapa de
  // anúncios — que responde outra pergunta.
  const keyboard = await attempt('ler-mapa-teclado', () => evaluate(target, `(() => {
    const card = document.querySelector('article.keyboard-map-card[data-keyboard-map-page]');
    return { present: Boolean(card), status: card?.dataset.mapStatus ?? null,
      stops: document.querySelectorAll('[data-keyboard-map-stop]').length,
      suspects: document.querySelectorAll('[data-keyboard-map-suspect]').length };
  })()`));
  report.keyboardMap = keyboard.value ?? null;
  if (keyboard.value?.present) {
    const saved = await attempt('captura:09-mapa-teclado.png', () => captureElementClip(target, directory, '09-mapa-teclado.png',
      'article.keyboard-map-card', 0, { maxHeight: 1_400 }));
    if (saved.ok && saved.value) report.screenshots.push(saved.value.name);
  }
  // A lista de suspeitos em JSON: é ela que a revisão humana classifica em verdadeiro ou falso
  // positivo, porque a captura sozinha não diz a tag nem o motivo de cada item laranja.
  if (keyboard.value?.present) {
    const auditId = await readAuditId(panel);
    const listed = await attempt('ler-suspeitos-teclado', () => evaluate(target,
      keyboardSuspectsExpression(auditId), { awaitPromise: true }));
    report.keyboardSuspects = listed.value ?? null;
    // A classificação manual de cada suspeito precisa do que está em volta dele na página.
    const suspects = listed.value?.suspects ?? [];
    if (suspects.length > 0) {
      const context = await attempt('contexto-dos-suspeitos', () => evaluate(page,
        suspectContextExpression(suspects)));
      report.keyboardSuspectContext = context.value ?? null;
    }
  }

  // (i) revisão guiada: o recorte do elemento DENTRO do cartão da pergunta ------------------------
  // É a prova visual do pedido do produto: quem responde vê o contorno sobre o elemento sem sair do
  // cartão. A captura isola o primeiro cartão que traz contorno e registra a legenda, o `viewBox` do
  // recorte e o retângulo desenhado, para conferir depois se a caixa caiu sobre o elemento.
  const guided = await attempt('revisao-cartao', () => evaluate(target, `(() => {
    const controls = document.querySelector('[data-review-controls-target]');
    if (controls) controls.open = true;
    const cards = [...document.querySelectorAll('#review-list details.lay-card')];
    // Cartões que declaram não ter imagem (a frase honesta do pedido) ou que só conseguem indicar texto e
    // tipo: a contagem vale nos dois caminhos, com ou sem recorte à vista.
    const withoutImage = document.querySelectorAll('#review-list .lay-locate-note').length;
    for (const [index, card] of cards.entries()) {
      card.open = true;
      const svg = card.querySelector('figure.lay-crop svg');
      const box = svg?.querySelector('rect[data-evidence-highlight]');
      if (!svg || !box) continue;
      card.scrollIntoView({ block: 'start' });
      const figure = card.querySelector('figure.lay-crop');
      return { present: true, index, cards: cards.length, withoutImage,
        caption: figure.querySelector('figcaption')?.textContent ?? '',
        viewBox: svg.getAttribute('viewBox'),
        box: ['x', 'y', 'width', 'height'].map(name => Number(box.getAttribute(name))),
        image: (svg.querySelector('image')?.getAttribute('href') ?? '').slice(0, 24) };
    }
    return { present: false, cards: cards.length, withoutImage };
  })()`));
  report.guidedCard = guided.value ?? null;
  if (guided.value?.present) {
    await sleep(300);
    const saved = await attempt('captura:10-revisao-cartao.png', () => captureElementClip(target, directory,
      '10-revisao-cartao.png', '#review-list details.lay-card', guided.value.index, { maxHeight: 1_200 }));
    if (saved.ok && saved.value) report.screenshots.push(saved.value.name);
    // O recorte ampliado (clique na imagem) é a segunda metade do pedido: mesma marcação, tamanho grande.
    const zoomed = await attempt('revisao-cartao-ampliado', () => evaluate(target, `(() => {
      const button = document.querySelectorAll('#review-list details.lay-card')[${guided.value.index}]
        ?.querySelector('figure.lay-crop button.lay-crop-zoom');
      if (!button) return { opened: false };
      button.click();
      const dialog = document.querySelector('#lay-zoom-dialog');
      const figure = dialog.querySelector('figure.lay-crop--zoom');
      return { opened: dialog.open === true, modal: dialog.matches(':modal'),
        outline: Boolean(figure?.querySelector('rect[data-evidence-highlight]')),
        viewBox: figure?.querySelector('svg')?.getAttribute('viewBox') ?? null };
    })()`, { userGesture: true }));
    report.guidedZoom = zoomed.value ?? null;
    if (zoomed.value?.opened) {
      await sleep(300);
      const savedZoom = await attempt('captura:10b-recorte-ampliado.png', () => captureElementClip(target, directory,
        '10b-recorte-ampliado.png', '#lay-zoom-dialog figure.lay-crop--zoom', 0, { maxHeight: 900 }));
      if (savedZoom.ok && savedZoom.value) report.screenshots.push(savedZoom.value.name);
      await attempt('fechar-recorte-ampliado', () => evaluate(target, `(() => {
        document.querySelector('#lay-zoom-close')?.click();
        return document.querySelector('#lay-zoom-dialog')?.open === false;
      })()`));
    }
  }

  // (j) ficha da evidência: imagem com contorno, ID, os dois SHA-256 inteiros e o download do PNG ---
  // Sem esta captura, a conferência do hash anunciado e da imagem que ele identifica dependeria de
  // abrir o HTML exportado à mão.
  const fiche = await attempt('ficha-de-evidencia', () => evaluate(target, `(() => {
    const annex = document.querySelector('details[data-report-annex]');
    if (annex) annex.open = true;
    const cards = [...document.querySelectorAll('[data-evidence-fiche]')];
    const index = cards.findIndex(card => card.querySelector('svg rect[data-evidence-highlight]'));
    const chosen = index < 0 ? 0 : index;
    const card = cards[chosen];
    if (!card) return { present: false, cards: cards.length };
    card.scrollIntoView({ block: 'start' });
    return { present: true, index: chosen, cards: cards.length,
      id: card.getAttribute('data-report-evidence'),
      hashes: [...card.querySelectorAll('code')].map(node => node.textContent)
        .filter(value => /^[a-f0-9]{64}$/u.test(value)).length,
      download: Boolean(card.querySelector('button[data-evidence-download]')),
      outlined: Boolean(card.querySelector('svg rect[data-evidence-highlight]')) };
  })()`));
  report.evidenceFiche = fiche.value ?? null;
  if (fiche.value?.present) {
    await sleep(300);
    const saved = await attempt('captura:11-ficha-evidencia.png', () => captureElementClip(target, directory,
      '11-ficha-evidencia.png', '[data-evidence-fiche]', fiche.value.index, { maxHeight: 1_400 }));
    if (saved.ok && saved.value) report.screenshots.push(saved.value.name);
  }

  // (k) os quatro arquivos entregues: o que a pessoa leva e assina -------------------------------
  // O pedido do produto é sobre o ARQUIVO, não sobre a tela: cada evidência citada aparece UMA vez no
  // anexo, com a imagem, o ID e os dois SHA-256. Os testes de unidade conferem o HTML; o que nenhum
  // deles enxerga é o PDF — se o navegador realmente imprimiu aquelas imagens. Aqui a exportação é
  // pedida pelo botão de verdade, os quatro arquivos são lidos do disco e cada fluxo `stream…endstream`
  // do PDF é descomprimido para contar as imagens embutidas.
  const exported = await attempt('exportar-quatro-formatos', async () => {
    const auditId = await readAuditId(panel);
    await click(target, 'button[data-report-export]');
    // Em página grande a exportação leva minutos: são quatro arquivos, um deles com todas as
    // miniaturas dentro e um PDF impresso numa aba à parte. O prazo acompanha o tamanho da página
    // (145 capturas na fixture) e a frase do próprio relatório diz o que está acontecendo.
    const deadline = Date.now() + 600_000;
    let names = [];
    let statusText = null;
    while (Date.now() < deadline) {
      names = (await readdir(launch.downloadDirectory)).filter(name => !name.endsWith('.crdownload'));
      statusText = (await evaluate(target, `document.querySelector('#review-status')?.textContent ?? null`).catch(() => null)) ?? statusText;
      if (['.html', '.pdf', '.csv', '.json'].every(extension => names.some(name => name.endsWith(extension)))) break;
      // Recusa declarada pelo próprio relatório: esperar o prazo inteiro só atrasaria o resumo. A frase
      // de "geração não confirmada" NÃO entra aqui — numa página grande a confirmação pode chegar depois
      // do aviso, e os arquivos ainda aparecem.
      if (/Não foi possível gerar o relatório atualizado/u.test(statusText ?? '')) break;
      await sleep(1_000);
    }
    const byExtension = extension => names.find(name => name.endsWith(extension)) ?? null;
    const base = { auditId, names, statusText, html: byExtension('.html'), pdf: byExtension('.pdf'),
      csv: byExtension('.csv'), json: byExtension('.json') };
    if (!base.pdf) return base;
    const bytes = await readFile(join(launch.downloadDirectory, base.pdf));
    return { ...base, pdfByteLength: bytes.length, ...countPdfImages(bytes) };
  });
  report.exportedFiles = exported.value ?? null;
  // Os dois arquivos grandes ficam junto das capturas: é o que permite reabrir o HTML entregue (e o PDF
  // do anexo) depois da corrida, sem depender do perfil temporário do Chrome.
  for (const name of [exported.value?.html, exported.value?.pdf].filter(Boolean)) {
    const copied = await attempt(`copiar:${name}`, async () => {
      await writeShot(directory, name, await readFile(join(launch.downloadDirectory, name)));
      return name;
    });
    if (copied.ok && copied.value) report.screenshots.push(copied.value);
  }

  // (l) o anexo impresso: o HTML entregue, só com o anexo visível, passa pelo mesmo `Page.printToPDF`
  // que a extensão usa. Assim o anexo cai na primeira página e dá para OLHAR o PDF renderizado —
  // a conferência que o pedido exige ("as imagens aparecem no PDF") deixa de ser uma dedução.
  if (exported.value?.html) {
    const annex = await attempt('anexo-impresso', async () => {
      const htmlPath = join(launch.downloadDirectory, exported.value.html);
      const html = await readFile(htmlPath, 'utf8');
      const server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(html);
      });
      await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
      const origin = `http://127.0.0.1:${server.address().port}/relatorio.html`;
      const annexPage = await createRealPage(launch, { url: origin, active: false, operationId: 'w162-anexo' });
      try {
        await command(annexPage.page, 'Emulation.setEmulatedMedia', { media: 'print' });
        const structure = await evaluate(annexPage.page, `(() => {
          const section = document.querySelector('section#anexos') ?? document.querySelector('[data-report-annex]') ??
            [...document.querySelectorAll('h2')].find(node => /Anexo de evidências/u.test(node.textContent))?.closest('section');
          if (!section) return { present: false, sections: document.querySelectorAll('section').length };
          // O relatório inteiro vive dentro de UM elemento (a raiz da visão), então esconder os filhos do
          // body não esconde nada. O que esconde é percorrer a cadeia até a raiz e apagar os IRMÃOS fora
          // dela: sobra a seção do anexo e os ancestrais que a contêm.
          const chain = new Set();
          for (let node = section; node; node = node.parentElement) chain.add(node);
          for (const node of chain) {
            for (const sibling of [...(node.parentElement?.children ?? [])]) {
              if (!chain.has(sibling) && sibling.style) sibling.style.display = 'none';
            }
          }
          if (section.tagName === 'DETAILS') section.open = true;
          for (const extra of section.querySelectorAll('details[data-report-annex], details[data-print-observation-scope]')) {
            extra.style.display = 'none';
          }
          const cards = [...section.querySelectorAll('[data-report-evidence]')];
          // A ficha mostra o PNG por um svg.evidence-media com use apontando para o defs (a imagem entra
          // UMA vez no arquivo) OU aponta para a captura já apresentada. Contar "svg image" devolvia zero
          // justamente porque o image fica no defs, fora da lista do anexo.
          const media = [...section.querySelectorAll('.evidence-media')];
          // Teto de imagens no PDF do anexo: o quadro do CDP aguenta 16 MB e um anexo de página real passa
          // disso, derrubando a conexão inteira (CDP_FRAME_TOO_LARGE é fatal no transporte). As primeiras
          // figuras bastam para responder à pergunta do pedido — "as imagens entram no PDF?" — e o resto da
          // seção continua impresso, com ID e os dois hashes. A seção inteira segue no HTML entregue.
          const MAX_PRINTED = 6;
          for (const [index, node] of media.entries()) if (index >= MAX_PRINTED) node.style.display = 'none';
          section.scrollIntoView({ block: 'start' });
          const outlined = [...section.querySelectorAll('svg[data-evidence-treatment], svg.evidence-media--marked')];
          return { present: true, title: section.querySelector('h2, h3')?.textContent ?? null,
            cards: cards.length, images: media.length, printedImages: Math.min(media.length, MAX_PRINTED),
            outlined: outlined.length,
            ids: cards.map(card => card.getAttribute('data-report-evidence')),
            recordHashes: section.textContent.includes('Impressão digital (SHA-256) do registro'),
            fileHashes: section.textContent.includes('SHA-256 do arquivo de imagem (PNG)'),
            pointers: [...section.querySelectorAll('a[href^="#report-preview-"]')].length };
        })()`, { awaitPromise: false }).catch(() => ({ present: false }));
        await sleep(400);
        const savedAnnex = await attempt('captura:12-anexo-impresso.png',
          () => captureViewport(annexPage.page, directory, '12-anexo-impresso.png'));
        if (savedAnnex.ok && savedAnnex.value) report.screenshots.push(savedAnnex.value.name);
        const printed = await attempt('pdf-do-anexo', async () => {
          const result = await command(annexPage.page, 'Page.printToPDF', {
            printBackground: true, preferCSSPageSize: true, generateTaggedPDF: true, generateDocumentOutline: true,
          });
          if (typeof result?.data !== 'string') throw new Error('PDF_SEM_DADOS');
          const bytes = Buffer.from(result.data, 'base64');
          await writeShot(directory, '13-anexo-impresso.pdf', bytes);
          return { byteLength: bytes.length, ...countPdfImages(bytes) };
        });
        if (printed.ok && printed.value) report.screenshots.push('13-anexo-impresso.pdf');
        return { ...structure, pdf: printed.value ?? null };
      } finally {
        await attempt('fechar-aba-do-anexo', () => removeRealTab(launch, annexPage, { operationId: 'w162-anexo-close' }));
        await new Promise(resolvePromise => server.close(resolvePromise));
      }
    });
    report.printedAnnex = annex.value ?? null;
  }
  return report;
}

/**
 * Conta as imagens embutidas num PDF.
 *
 * Cada imagem é um objeto de fluxo (`/Subtype /Image`) com FlateDecode. Os dicionários do Chrome saem
 * no corpo do arquivo, NÃO dentro de fluxos de objetos comprimidos (`/ObjStm` ausente) — por isso a
 * contagem lê o texto do arquivo inteiro e soma o que aparece nos fluxos descomprimidos, que é onde
 * objetos comprimidos apareceriam. Contar só dentro dos fluxos, como a primeira versão fazia, devolvia
 * `images: 0` para um PDF cheio de imagens. Um PDF de verdade sem imagens continua devolvendo 0.
 */
function countPdfImages(bytes) {
  const latin = bytes.toString('latin1');
  let streams = 0;
  let images = (latin.match(/\/Subtype\s*\/Image/gu) ?? []).length;
  const pattern = /stream\r?\n([\s\S]*?)endstream/gu;
  for (const match of latin.matchAll(pattern)) {
    streams += 1;
    const raw = Buffer.from(match[1], 'latin1');
    for (const candidate of [raw, raw.subarray(0, Math.max(0, raw.length - 2))]) {
      let inflated;
      try { inflated = inflateSync(candidate); } catch { continue; }
      images += (inflated.toString('latin1').match(/\/Subtype\s*\/Image/gu) ?? []).length;
      break;
    }
  }
  return { streams, images };
}

async function readAuditId(panel) {
  const value = await evaluate(panel, `document.querySelector('[data-screen="result"]')?.dataset.auditId ?? null`);
  if (typeof value !== 'string' || !value) throw new Error('AUDIT_ID_AUSENTE');
  return value;
}

// ---------------------------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------------------------

function timestampSlug() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { process.stdout.write(USAGE); return 0; }

  const outRoot = resolve(process.cwd(), options.out ?? join('qa-out', `visual-qa-${timestampSlug()}`));
  await mkdir(outRoot, { recursive: true });

  const chromeBinary = resolveRealChromeTestBinary();
  if (!chromeBinary) throw new Error('AUDITA_E2E_CHROME_NAO_DEFINIDO');

  const cleanups = [];
  const cleanupHost = { after: handler => cleanups.push(handler) };
  const routes = await fixtureRoutes();
  const fixture = await startFixtureServer(cleanupHost, routes);

  const targets = [];
  const used = new Set();
  const push = (url, label) => {
    let slug = slugify(url);
    let suffix = 2;
    while (used.has(slug)) { slug = `${slugify(url)}-${suffix}`; suffix += 1; }
    used.add(slug);
    targets.push({ url, slug, label });
  };
  if (options.fixture) push(`${fixture.origin}${FIXTURE_PATH}`, 'fixture local');
  for (const url of options.urls) push(url, 'url informada');

  if (targets.length === 0) {
    process.stderr.write('Nada a auditar: use a fixture local (padrão) ou informe --url.\n');
    return 1;
  }

  process.stdout.write(`Saída: ${outRoot}\n`);
  process.stdout.write(`Chrome: ${chromeBinary}\n`);
  process.stdout.write(`Páginas: ${targets.map(target => `${target.slug} (${target.label})`).join(', ')}\n\n`);

  const pages = [];
  try {
    for (const target of targets) {
      process.stdout.write(`→ ${target.url}\n`);
      const summary = await auditPage({ target, outRoot, cleanups, chromeBinary, reloadCheck: options.reloadCheck });
      pages.push(summary);
      printPageSummary(summary);
      await writeFile(join(outRoot, summary.slug, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    }
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch { /* a limpeza não pode esconder o resultado da auditoria */ }
    }
  }

  const document = {
    version: 1,
    generatedAt: new Date().toISOString(),
    extensionPath: WORKSPACE_ROOT,
    chromeBinary,
    chrome: pages.find(page => page.chrome)?.chrome ?? null,
    viewport: { ...VIEWPORT },
    captureMode: CAPTURE_MODE,
    reloadCheck: options.reloadCheck,
    outRoot: relative(process.cwd(), outRoot) || '.',
    pages,
  };
  const summaryPath = join(outRoot, 'summary.json');
  await writeFile(summaryPath, `${JSON.stringify(document, null, 2)}\n`);

  process.stdout.write(`\nResumo: ${summaryPath}\n`);
  const failed = pages.filter(page => page.errors.length > 0 || page.outcome !== 'result');
  if (failed.length === 0) {
    process.stdout.write('Todas as páginas concluíram a auditoria e geraram as capturas.\n');
    return 0;
  }
  process.stdout.write(`${failed.length} de ${pages.length} página(s) com problema: ${failed.map(page => page.slug).join(', ')}\n`);
  return 1;
}

function printPageSummary(summary) {
  const lines = [];
  lines.push(`  resultado: ${summary.outcome}${summary.auditId ? ` (auditId ${summary.auditId})` : ''}`);
  if (summary.findings) {
    const findings = summary.findings;
    lines.push(`  achados com elemento: ${findings.achadosComElemento ?? '?'} ` +
      `(localizados ${findings.ocorrenciasLocalizadas ?? '?'}, não localizados ${findings.ocorrenciasNaoLocalizadas ?? '?'}, ` +
      `questões gerais ${findings.questoesGerais ?? '?'})`);
  }
  if (summary.signals?.groups) {
    // O anel é a marcação da ocorrência selecionada: no estado "mostrando" ele fica escondido de
    // propósito, então zero anéis aqui não é falha — a captura 04-*.png é que mede o anel.
    lines.push(`  sinais desenhados: ${summary.signals.drawn ?? 0} de ${summary.signals.groups.length} grupo(s) ` +
      `(números ${(summary.signals.numbers ?? []).join(', ') || '—'}; ${summary.signals.onScreen ?? 0} no quadro visível)`);
    const visiveis = (summary.signals.groups ?? []).filter(group => group.ringVisible);
    const precisos = visiveis.filter(group => group.targetCandidateCount >= 1).length;
    lines.push(`  precisão: ${precisos} de ${visiveis.length} contorno(s) visível(is) colados ao elemento (folga 3 px + borda)`);
    const colisoes = (summary.signals.groups ?? []).filter(group => group.labelOverLabel?.length);
    const sobreOutros = (summary.signals.groups ?? []).filter(group => group.labelOverOtherRing?.length);
    lines.push(`  etiquetas sobrepostas: ${colisoes.length}; etiquetas sobre outro elemento marcado: ${sobreOutros.length}` +
      (colisoes.length ? ` (${colisoes.map(group => `${group.number}↔${group.labelOverLabel.join('/')}`).join(', ')})` : ''));
    const sobreTexto = (summary.signals.groups ?? []).filter(group => (group.labelOnTextCount ?? 0) > 0);
    lines.push(`  etiquetas sobre TEXTO de outro elemento: ${sobreTexto.length}` +
      ` (${summary.signals.textLinesCovered ?? 0} linha(s) de texto coberta(s) de ` +
      `${summary.signals.textLinesInViewport ?? 0} medidas na viewport)` +
      (sobreTexto.length ? ` — ${sobreTexto.slice(0, 4).map(group =>
        `Sinal ${group.number} cobre ${group.labelOnTextCount}× "${(group.labelOnText?.[0]?.text ?? '').slice(0, 28)}"`).join('; ')}` : ''));
  }
  if (summary.unlocated?.length) {
    lines.push(`  não localizados: ${summary.unlocated.length}` +
      (summary.unlocatedReason ? ` — motivo do painel: "${summary.unlocatedReason}"` : ''));
  }
  if (summary.selectionProbe?.length) {
    const oferecem = summary.selectionProbe.filter(item => item.action === 'highlight-occurrence');
    lines.push(`  destaque ao vivo oferecido em ${oferecem.length} de ${summary.selectionProbe.length} sinal(is): ` +
      summary.selectionProbe.map(item => `Sinal ${item.number}=${item.action}`).join(', '));
  }
  if (summary.selections?.length) {
    lines.push(`  selecionados: ${summary.selections.map(item => {
      const parts = [`Sinal ${item.number}`];
      if (!item.ringVisible) parts.push('sem anel');
      parts.push(item.highlightOffered ? 'com destaque' : 'sem destaque na página');
      if (!item.screenshot) parts.push('sem captura');
      return parts.join(' ');
    }).join('; ')}`);
  }
  if (summary.persistence) {
    lines.push(`  persistência após ${summary.persistence.waitedMs / 1000} s: ${summary.persistence.survived ? 'sinais mantidos' : 'SINAIS PERDIDOS'} ` +
      `(${summary.persistence.before.drawn} → ${summary.persistence.after.drawn})`);
  }
  if (summary.reload) {
    const reload = summary.reload;
    lines.push(`  recarga da aba: ${reload.reloaded ? 'sim' : 'NÃO ACONTECEU'}` +
      (reload.sameAddress === null ? '' : `; mesmo endereço: ${reload.sameAddress ? 'sim' : 'NÃO'}`) +
      `; painel: ${reload.offer?.status ?? 'sem leitura'}` +
      (reload.relocated ? `; sinais reencontrados: ${reload.relocated.drawn ?? 0}` +
        ` (precisos ${reload.relocated.precise ?? 0}, na moldura ${reload.relocated.onScreen ?? 0})` +
        `, aviso no painel: ${reload.relocated.noteInPanel ? 'sim' : 'não'}` : '') +
      `; destaque na versão atual: ${reload.highlight?.drawn
        ? `caixa desenhada (${reload.highlight.attempts.length} de ${reload.highlight.candidates.length} sinal(is) tentado(s))`
        : reload.highlight?.offered ? 'oferecido, sem caixa' : 'não oferecido'}`);
    if ((reload.highlight?.attempts ?? []).length > 1) {
      lines.push(`  destaque na versão atual, por sinal: ${reload.highlight.attempts.map(entry =>
        `Sinal ${entry.number}=${entry.offered ? (entry.drawn ? 'caixa desenhada' : 'sem caixa') : 'sem convite'}`).join('; ')}`);
    }
  }
  if (summary.report?.opened) {
    lines.push(`  relatório: aberto, ${summary.report.evidenceFigures} miniatura(s) ` +
      `(${summary.report.evidenceVisibleBefore ?? 0} visíveis antes de abrir as seções), ` +
      `${summary.report.evidenceCaptured} capturada(s)` +
      (summary.report.map?.present ? `, mapa: ${(summary.report.map.statuses ?? []).join('/')}` : ', mapa: ausente'));
  }
  if (summary.report?.keyboardSuspects?.present) {
    // A lista crua, uma linha por item: é o que a revisão humana classifica em verdadeiro ou falso.
    const suspects = summary.report.keyboardSuspects.suspects ?? [];
    lines.push(`  suspeitos do mapa do teclado: ${suspects.length}`);
    for (const suspect of suspects) {
      lines.push(`    ${suspect.number}. <${suspect.tag}> papel=${suspect.role || '—'} motivo=${suspect.reason}` +
        `${suspect.ruleId ? ` regra=${suspect.ruleId}` : ''} nome="${(suspect.name ?? '').slice(0, 80)}"` +
        `${suspect.nameStatus === 'omitted-privacy' ? ' (nome omitido)' : ''}`);
    }
  } else if (summary.report?.keyboardSuspects?.present === false) {
    lines.push('  suspeitos do mapa do teclado: mapa ausente no artefato');
  }
  if (Array.isArray(summary.highlight) && summary.highlight.length > 0) {
    lines.push(`  ATENÇÃO: ${summary.highlight.length} destaque(s) ficaram na página depois das capturas`);
  }
  lines.push(`  capturas: ${summary.screenshots.length}`);
  for (const error of summary.errors) lines.push(`  ERRO em ${error.stage}: ${error.detail}`);
  process.stdout.write(`${lines.join('\n')}\n\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
  }
}
