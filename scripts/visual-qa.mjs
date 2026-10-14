#!/usr/bin/env node
// Roteiro de QA VISUAL reutilizável da extensão "Audita Acessibilidade".
//
// Ele carrega a extensão DE VERDADE no Chrome for Testing, audita páginas com captura de pixels,
// liga os sinais numerados na página e salva capturas de tela para revisão humana. O que se
// revisa aqui são as duas coisas que nenhum teste de unidade enxerga: se o número desenhado na
// página aponta para o elemento certo, e se a caixa/anel cobre exatamente o que o achado descreve.
//
// Uso:
//   node scripts/visual-qa.mjs [--out qa-out/<nome>] [--url https://... ...] [--no-fixture]
//
// Para cada página (a fixture local, salvo --no-fixture, e cada --url):
//   01-painel.png          painel no resultado da auditoria
//   01b-painel-sinais.png  painel com o resumo dos sinais
//   02-sinais-topo.png     página no topo com os sinais desenhados
//   03-sinais-rolagem-N.png página nas posições de rolagem
//   04-selecionado-N.png   página com o anel do N-ésimo achado selecionado
//   05-persistencia.png    página 6 s depois, com o ponteiro mexido e rolagem
//   06-relatorio-N.png     seções do relatório com as miniaturas de evidência
//   07-evidencia-N.png     cada miniatura marcada isolada (o <figure> com o svg)
//   08-mapa.png            mapa de anúncios, quando existe
//   09-mapa-teclado.png    mapa do teclado, quando existe (caixas azuis numeradas e tracejadas)
//   summary.json           o que foi medido: localizados, não localizados com motivo,
//                          retângulo do alvo vs. retângulo do anel/botão, persistência
//
// Um erro numa página é registrado no summary.json e não aborta as outras.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

import {
  click,
  command,
  evaluate,
  launchUnpackedExtension,
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

const USAGE = `Uso: node scripts/visual-qa.mjs [--out qa-out/<nome>] [--url https://... ...] [--no-fixture]

  --out <dir>     diretório de saída (padrão: qa-out/visual-qa-<data-hora>)
  --url <url>     audita também esta página (pode repetir)
  --no-fixture    não audita a fixture local test/e2e/fixtures/visual-qa/marcacao.html
  --help          mostra esta ajuda
`;

function parseArguments(argv) {
  const options = { out: null, urls: [], fixture: true, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') { options.help = true; continue; }
    if (argument === '--no-fixture') { options.fixture = false; continue; }
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
const SETTLED_HIGHLIGHT_ACTIONS = ['highlight-occurrence', 'consult-evidence', 'clear-highlight'];

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
  const groups = [...shadow.querySelectorAll('.audita-group')].map(group => {
    const ring = group.querySelector('.audita-ring');
    const button = group.querySelector('.audita-marker');
    const label = button?.getAttribute('aria-label') ?? '';
    const match = /^Sinal (\\d+)/u.exec(label);
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
    const overlapWidth = located ? Math.max(0, Math.min(ringBox.x + ringBox.width, buttonBox.x + buttonBox.width) - Math.max(ringBox.x, buttonBox.x)) : 0;
    const overlapHeight = located ? Math.max(0, Math.min(ringBox.y + ringBox.height, buttonBox.y + buttonBox.height) - Math.max(ringBox.y, buttonBox.y)) : 0;
    // O anel só é exibido na ocorrência selecionada; fora disso o produto o deixa em display:none
    // e o retângulo medido abaixo passa a ser zero. A caixa em ringBox continua sendo o alvo que
    // o overlay resolveu (ela vem dos estilos em linha), e é com ela que se mede a precisão.
    const ringRect = ring.getBoundingClientRect();
    const drawn = element => element.style.display !== 'none' &&
      element.getBoundingClientRect().width > 0;
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

// ---------------------------------------------------------------------------------------------
// Uma página
// ---------------------------------------------------------------------------------------------

async function auditPage({ target, outRoot, cleanups, chromeBinary }) {
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

async function captureReport({ launch, panel, page, directory, attempt, shot }) {
  const report = { opened: false, screenshots: [], evidenceFigures: 0, evidenceCaptured: 0 };
  const opened = await attempt('abrir-relatorio', async () => {
    await click(panel, 'button[data-intent="OPEN_REPORT"]');
    return launch.waitForReport({ auditId: await readAuditId(panel) });
  });
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
  return report;
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
      const summary = await auditPage({ target, outRoot, cleanups, chromeBinary });
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
  if (summary.report?.opened) {
    lines.push(`  relatório: aberto, ${summary.report.evidenceFigures} miniatura(s) ` +
      `(${summary.report.evidenceVisibleBefore ?? 0} visíveis antes de abrir as seções), ` +
      `${summary.report.evidenceCaptured} capturada(s)` +
      (summary.report.map?.present ? `, mapa: ${(summary.report.map.statuses ?? []).join('/')}` : ', mapa: ausente'));
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
