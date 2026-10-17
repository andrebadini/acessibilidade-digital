import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

import {
  CANONICAL_CHROME_PRODUCT,
  command,
  createRealPage,
  launchUnpackedExtension,
  removeRealTab,
  resolveRealChromeTestBinary,
  waitForValue,
} from './support/real-chrome.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = join(root, 'test/e2e/fixtures');
const chromeBinary = resolveRealChromeTestBinary();

// O atraso do aviso ilustrado, em ms, contado a partir do pedido — e o pedido sai no `resize` da captura de
// aquecimento. O aquecimento só assenta depois de 1.000 ms de altura parada (contados desse mesmo `resize`,
// `src/background/full-page-warm-up.js`), e a leitura da estrutura acontece logo em seguida: 1.400 ms põe a
// chegada da imagem claramente depois da leitura e antes da captura de verdade. Medido: ver o relatório
// docs/qa/mapa-teclado-caixas-1.1.62.md, que registra os marcos observados nesta fixture.
const ATRASO_DA_IMAGEM_MS = 2_500;
// Largura e altura da imagem servida: é ela que empurra os controles para baixo quando chega.
const IMAGEM = { largura: 1_200, altura: 600, cor: [207, 228, 200] };

const CONTROLES = Object.freeze([
  { id: 'alvo-protocolo', nome: 'Protocolo' },
  { id: 'alvo-segunda-via', nome: 'Segunda via' },
  { id: 'alvo-agendamento', nome: 'Agendamento' },
  { id: 'alvo-busca', nome: 'Buscar' },
  { id: 'alvo-contato', nome: 'Contato' },
]);

test('numa página que cresce depois da leitura, o mapa desenha caixa alinhada em cada controle', { timeout: 300_000 }, async t => {
  assert.ok(chromeBinary, 'AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório para o E2E real do mapa do teclado.');
  await access(chromeBinary, fsConstants.X_OK);
  const loopback = await startGrowingLoopback();
  t.after(() => loopback.close());

  // O endereço diz à fixture o que ela deve fazer: quantos elementos tem o catálogo (para a leitura da
  // estrutura demorar) e quanto o servidor segura a imagem. Assim os dois números ficam num lugar só.
  const fixtureUrl = `${loopback.origin}/keyboard-map-cresce.html?atraso=${ATRASO_DA_IMAGEM_MS}&etiquetas=12000`;
  const response = await fetch(fixtureUrl);
  assert.equal(response.status, 200);
  await response.arrayBuffer();

  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(root), startUrl: fixtureUrl, chromeBinary, expectedMajor: 152,
    downloadMode: 'profile',
    ...(process.env.AUDITA_E2E_ARTIFACT_ROOT ? {
      qaDirectory: join(process.env.AUDITA_E2E_ARTIFACT_ROOT, 'qa'),
      downloadDirectory: join(process.env.AUDITA_E2E_ARTIFACT_ROOT, 'downloads'),
    } : {}),
    viewport: { width: 1280, height: 800 },
  });
  assert.equal(extension.chromeProduct, CANONICAL_CHROME_PRODUCT);

  const panel = await extension.openSidePanelFromAction();
  await extension.waitForValue(panel, `document.querySelector('[data-screen]')?.dataset.screen`, value => value === 'initial');
  await extension.click(panel, 'button[data-focus-id="open-url-form"][data-intent="OPEN_URL_FORM"]');
  await extension.click(panel, '[name="capture-mode"][value="full-evidence"]');
  await extension.evaluate(panel, `(() => {
    const input=document.querySelector('#audit-url, input[name="audit-url"]');
    input.value=${JSON.stringify(fixtureUrl)};
    input.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()`);
  await extension.click(panel, '[data-action="start-url-audit"]');
  const terminal = await extension.waitForValue(panel, `(() => ({
    screen:document.querySelector('[data-screen]')?.dataset.screen??null,
    confirm:Boolean(document.querySelector('[data-action="confirm-pixel-capture"]')),
    status:document.querySelector('[role="status"]')?.textContent??null,
  }))()`, value => ['result', 'unavailable'].includes(value?.screen) || value?.confirm === true, {
    timeoutMs: 180_000, intervalMs: 50,
  });
  assert.equal(terminal.confirm, false, `a auditoria por URL não pode pedir confirmação: ${JSON.stringify(terminal)}`);
  assert.equal(terminal.screen, 'result', `a auditoria por URL precisa concluir: ${JSON.stringify(terminal)}`);
  const auditId = await extension.evaluate(panel, `document.querySelector('[data-screen="result"]')?.dataset.auditId`);

  {
    // Marcos de tempo desta fixture, em milissegundos contados do pedido da imagem — é este número que
    // sustenta a escolha do atraso e vai para o relatório da tarefa.
    const marcos = loopback.timeline();
    t.diagnostic(`resizes (ms desde o pedido da imagem): ${JSON.stringify(marcos.resizes.map(registro => registro.quando - (marcos.pedido ?? 0)))}; altura de carga=${marcos.alturaDeCarga}`);
  }

  await extension.click(panel, '[data-action="open-report"], button[data-focus-id="open-report"]');
  const report = await extension.waitForReport({ auditId });
  await command(report, 'Page.bringToFront');
  await extension.waitForValue(report, `Boolean(document.querySelector('[data-keyboard-map-page="page-1"]'))`, Boolean, {
    timeoutMs: 30_000, intervalMs: 50,
  });

  const live = await extension.evaluate(report, `(() => {
    const card=document.querySelector('[data-keyboard-map-page="page-1"]');
    return {
      status: card.dataset.mapStatus,
      sectionText: card.closest('section')?.textContent ?? '',
      counts: card.querySelector('.keyboard-map-counts')?.textContent ?? '',
      images: [...card.querySelectorAll('img[data-map-segment-image]')].map(image => ({
        loaded: image.complete && image.naturalWidth > 0, alt: image.alt })),
      stops: [...card.querySelectorAll('[data-keyboard-map-stop]')].map(entry => entry.textContent),
      horizontalOverflow: card.scrollWidth > card.clientWidth + 1,
    };
  })()`);
  // A imagem continua no relatório e a explicação de leiaute mudado NÃO pode aparecer: os retângulos foram
  // medidos no mesmo leiaute da imagem, então há caixa em cada controle.
  assert.ok(live.images.length > 0 && live.images.every(image => image.loaded && /Trecho \d+ de \d+/u.test(image.alt)),
    `a imagem da página precisa continuar no relatório: ${JSON.stringify(live.images)}`);
  assert.doesNotMatch(live.sectionText, /A página mudou de tamanho enquanto era verificada/iu,
    `a mudança de leiaute não pode aparecer aqui: ${live.sectionText.slice(0, 600)}`);
  assert.ok(live.sectionText.includes('Cada caixa azul numerada é um lugar onde a tecla Tab para, na ordem dos números.'),
    'a legenda do mapa precisa continuar na tela');
  assert.match(live.counts, /^5 lugares onde o Tab para;/u,
    `os cinco controles precisam estar contados: ${live.counts}`);
  assert.equal(live.horizontalOverflow, false);
  for (const controle of CONTROLES) {
    assert.ok(live.stops.some(entrada => entrada.includes(controle.nome)),
      `a parada "${controle.nome}" precisa estar na lista: ${JSON.stringify(live.stops)}`);
  }
  const pixels = await countBoxPixels(extension, report);
  assert.ok(pixels.blue > 0, `as caixas azuis precisam estar pintadas na imagem: ${JSON.stringify(pixels)}`);
  t.diagnostic(`mapa na tela: stops=${live.stops.length}; pixels=${JSON.stringify(pixels)}; counts=${live.counts}`);

  await extension.click(report, 'button[data-report-export]');
  const downloads = await extension.waitForFourDownloads({ auditId, timeoutMs: 300_000, intervalMs: 50 });
  const [jsonBytes, html] = await Promise.all([
    readFile(join(extension.downloadDirectory, downloads.find(value => value.format === 'json').filename), 'utf8'),
    readFile(join(extension.downloadDirectory, downloads.find(value => value.format === 'html').filename), 'utf8'),
  ]);
  const audit = JSON.parse(jsonBytes.replace(/^﻿/u, '')).audit;
  const mapa = audit.evidence.find(artifact => artifact.kind === 'keyboard-map');
  const captura = audit.evidence.find(artifact => artifact.kind === 'full-page' && artifact.state === 'pristine');
  assert.ok(mapa, 'o mapa do teclado precisa chegar ao relatório técnico');
  assert.ok(captura, 'a captura pristine precisa chegar ao relatório técnico');

  // A FOLHA DE IMPRESSÃO, que é o que o PDF entrega. Medir a tela não bastava: o PDF não sai do relatório
  // aberto no painel, e sim do HTML exportado impresso numa aba própria (`src/export/report-export.js`), com
  // a folha de `src/core/report/report.css.js`. Aqui o documento exportado é publicado no servidor da
  // fixture, aberto numa aba de verdade, medido com a mídia trocada para `print` e impresso pelo próprio
  // navegador — a mesma chamada da exportação. Três coisas precisam valer no papel: o cartão do mapa
  // continua visível, trechos e paradas da lista não podem ser partidos entre páginas (`break-inside:
  // avoid`) e nenhuma imagem pode passar da largura do cartão (`max-width: 100%`). Sem isso o PDF sairia sem
  // o mapa, com o mapa cortado ao meio ou fora do papel.
  loopback.servirImpressao(html);
  const impressa = await createRealPage(extension, {
    url: `${loopback.origin}/relatorio-impressao`, operationId: 'relatorio-impressao',
  });
  t.after(() => removeRealTab(extension, impressa, { operationId: 'relatorio-impressao-fim' }).catch(() => undefined));
  await command(impressa.page, 'Emulation.setEmulatedMedia', { media: 'print' });
  const papel = await waitForValue(impressa.page, `(() => {
    const card=document.querySelector('[data-keyboard-map-page="page-1"]');
    if(!card) return null;
    const texto=card.closest('section')?.textContent ?? '';
    const largura=node=>node.getBoundingClientRect().width;
    return {
      larguraDoCartao: Math.round(largura(card)),
      trechos: [...card.querySelectorAll('figure[data-keyboard-map-segment]')]
        .map(figure => ({ regra: getComputedStyle(figure).breakInside, visivel: largura(figure) > 0 })),
      imagens: [...card.querySelectorAll('img[data-map-segment-image]')].map(image => ({
        carregada: image.complete && image.naturalWidth > 0, largura: Math.round(largura(image)),
        limite: getComputedStyle(image).maxWidth })),
      paradas: [...card.querySelectorAll('[data-keyboard-map-stop]')].map(entry => ({
        numero: entry.getAttribute('data-keyboard-map-stop'), valor: entry.getAttribute('value'),
        regra: getComputedStyle(entry).breakInside, visivel: largura(entry) > 0 })),
      legenda: texto.includes('Cada caixa azul numerada é um lugar onde a tecla Tab para, na ordem dos números.'),
      lista: texto.includes('Onde o Tab para, na ordem'),
      contagens: /5 lugares onde o Tab para;/u.test(texto),
    };
  })()`, value => value !== null, { timeoutMs: 30_000, intervalMs: 100 });
  assert.ok(papel.larguraDoCartao > 0, 'o cartão do mapa precisa sair no papel');
  assert.equal(papel.legenda, true, 'a legenda do mapa precisa sair no papel');
  assert.equal(papel.lista, true, 'a lista "Onde o Tab para, na ordem" precisa sair no papel');
  assert.equal(papel.contagens, true, 'as contagens precisam sair no papel');
  assert.equal(papel.trechos.length, live.images.length, 'cada trecho da imagem precisa continuar no papel');
  for (const trecho of papel.trechos) {
    assert.equal(trecho.regra, 'avoid', 'o trecho não pode ser partido entre páginas');
    assert.equal(trecho.visivel, true, 'o trecho precisa estar visível no papel');
  }
  assert.equal(papel.paradas.length, live.stops.length, 'a lista do papel precisa ser a mesma da tela');
  for (const parada of papel.paradas) {
    assert.equal(parada.numero, parada.valor,
      `o número do papel precisa ser o mesmo da tela: ${JSON.stringify(parada)}`);
    assert.equal(parada.regra, 'avoid', 'a parada da lista não pode ser partida entre páginas');
    assert.equal(parada.visivel, true, 'a parada da lista precisa estar visível no papel');
  }
  for (const imagem of papel.imagens) {
    assert.equal(imagem.carregada, true, 'a imagem do mapa precisa estar carregada no papel');
    assert.equal(imagem.limite, '100%', 'a imagem precisa ser limitada à largura do cartão');
    assert.ok(imagem.largura > 0 && imagem.largura <= papel.larguraDoCartao,
      `a imagem precisa caber no cartão: ${JSON.stringify(imagem)}`);
  }
  // O PDF da aba de impressão, com a mesma chamada da exportação: o documento é a origem do arquivo que a
  // pessoa recebe, então é aqui que se prova que os trechos do mapa entram no arquivo — não apenas que eles
  // aparecem numa tela.
  const pdf = await command(impressa.page, 'Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
  const bytes = Buffer.from(pdf.data, 'base64');
  assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'a aba de impressão precisa gerar PDF');
  const dimensoesDoMapa = new Set(mapa.segments.map(segment => `${segment.width}x${segment.height}`));
  const noPdf = new Set([...bytes.toString('latin1').matchAll(/\/Subtype\s*\/Image[\s\S]{0,400}?\/Width\s+(\d+)[\s\S]{0,200}?\/Height\s+(\d+)/gu)]
    .map(encontrado => `${encontrado[1]}x${encontrado[2]}`));
  for (const dimensao of dimensoesDoMapa) {
    assert.ok(noPdf.has(dimensao), `o trecho ${dimensao} precisa estar dentro do PDF; imagens no PDF: ${[...noPdf].join(', ')}`);
  }
  t.diagnostic(`papel: cartão=${papel.larguraDoCartao}px; trechos=${papel.trechos.length}; paradas=${papel.paradas.map(parada => parada.numero).join(',')}; imagens no PDF=${[...noPdf].join(' ')}`);

  // O QUE ESTA FIXTURE PRECISA TER FEITO, para a prova valer alguma coisa: o aviso ilustrado chegou DEPOIS
  // de a captura de aquecimento ter pedido a imagem (o primeiro `resize`) e ANTES de a captura de verdade
  // começar. Se isso não aconteceu, o teste avisa em vez de passar por acidente.
  //
  // Os últimos marcos são `fetch` da página e podem chegar alguns milissegundos depois de a auditoria
  // terminar: esperar por eles aqui é o que impede o teste de falhar por uma corrida de relógio.
  for (let tentativa = 0; tentativa < 50 && loopback.timeline().grupos.length < 2; tentativa += 1) {
    await new Promise(resolver => setTimeout(resolver, 100));
  }
  const marcos = loopback.timeline();
  const recebidaEm = Date.parse(captura.metadata.captureReceivedAt);
  // Qual grupo de `resize` é o da captura de verdade? A auditoria faz OUTRAS capturas depois desta (as do
  // destaque de cada achado), então "o último grupo" não serve. O que identifica o grupo certo é o instante
  // em que a captura integral foi recebida, carimbado pela própria auditoria (`captureReceivedAt`): o grupo
  // cujos marcos estão mais perto dele é o dela.
  const grupoDaCaptura = marcos.grupos.reduce((melhor, grupo) => {
    const distancia = Math.min(...grupo.map(registro => Math.abs(registro.quando - recebidaEm)));
    return melhor === null || distancia < melhor.distancia ? { distancia, grupo } : melhor;
  }, null);
  const inicioDaCaptura = grupoDaCaptura?.grupo?.[0]?.quando ?? null;
  assert.ok(marcos.pedido !== null && marcos.chegada !== null && Number.isFinite(recebidaEm),
    `a fixture precisa registrar o pedido, a chegada da imagem e a captura: ${JSON.stringify(marcos)}`);
  assert.ok(inicioDaCaptura !== null,
    `a captura de verdade precisa aparecer entre os marcos: ${JSON.stringify(marcos)}`);
  assert.ok(marcos.chegada > marcos.pedido, `a imagem só pode chegar depois do pedido: ${JSON.stringify(marcos)}`);
  assert.ok(marcos.chegada < inicioDaCaptura,
    `a imagem precisa chegar ANTES de a captura de verdade começar: ${JSON.stringify({ ...marcos, inicioDaCaptura })}`);
  assert.ok(marcos.chegada < recebidaEm,
    `a imagem precisa chegar antes de a captura ser recebida: ${JSON.stringify({ ...marcos, recebidaEm })}`);
  t.diagnostic(`marcos: pedido+${marcos.chegada - marcos.pedido}ms; captura em ${inicioDaCaptura - marcos.pedido}ms; recebida em ${recebidaEm - marcos.pedido}ms`);

  // O crescimento medido pela própria geometria do mapa: a altura que a imagem tem menos a altura da carga.
  const alturaNoMapa = mapa.derivation.geometry.sourceCssSize.height;
  const crescimento = alturaNoMapa - marcos.alturaDeCarga;
  t.diagnostic(`alturas: carga=${marcos.alturaDeCarga}; mapa(M0)=${alturaNoMapa}; captura.height=${captura.metadata.height}; captura.width=${captura.metadata.width}; crescimento=${crescimento}; limitacoes=${JSON.stringify(mapa.limitations)}; status=${mapa.status}; counts=${JSON.stringify(mapa.counts)}; pixels=${JSON.stringify(mapa.pixelState ?? null)}`);
  assert.ok(crescimento > 300, `os controles precisam ter descido de verdade: crescimento=${crescimento}`);

  // E o centro da tarefa: cada caixa exatamente sobre o elemento, na posição de DEPOIS do crescimento — a
  // posição em que os retângulos da leitura estrutural (de antes) apontariam 600 px acima.
  const desvios = [];
  for (const controle of CONTROLES) {
    const parada = mapa.stops.find(entrada => (entrada.name ?? '').includes(controle.nome));
    assert.ok(parada, `a parada "${controle.nome}" precisa estar no mapa: ${JSON.stringify(mapa.stops.map(entrada => entrada.name))}`);
    const antes = marcos.controlesDeCarga[controle.id];
    assert.ok(antes, `a fixture precisa ter medido o controle ${controle.id} na carga`);
    const desvioY = parada.bounds.y - (antes.y + crescimento);
    const desvioX = parada.bounds.x - antes.x;
    desvios.push({ id: controle.id, numero: parada.number, desvioX, desvioY, altura: parada.bounds.height,
      alturaDeCarga: antes.altura });
    assert.ok(Math.abs(desvioY) <= 2,
      `a caixa de ${controle.id} precisa cair sobre o elemento depois do crescimento (desvio vertical ${desvioY} px)`);
    assert.ok(Math.abs(desvioX) <= 2,
      `a caixa de ${controle.id} precisa cair sobre o elemento (desvio horizontal ${desvioX} px)`);
    assert.ok(Math.abs(parada.bounds.height - antes.altura) <= 2,
      `a caixa de ${controle.id} precisa ter a altura do elemento (${parada.bounds.height} x ${antes.altura})`);
    assert.ok(parada.bounds.y + parada.bounds.height <= alturaNoMapa + 1e-9,
      `a caixa de ${controle.id} precisa caber na imagem`);
  }
  t.diagnostic(`caixas: ${JSON.stringify(desvios)}`);

  assert.equal(mapa.limitations.includes('source-layout-changed'), false,
    `o leiaute não mudou em volta da medição: ${JSON.stringify(mapa.limitations)}`);
  assert.equal(mapa.limitations.includes('non-uniform-pixel-scale'), false, 'a escala é uniforme');
  assert.equal(mapa.limitations.includes('stops-outside-source-clamped'), false,
    'nenhuma parada pode ter sido jogada para dentro do recorte');
  assert.equal(mapa.limitations.includes('stops-outside-source-omitted'), false,
    'todas as paradas desta fixture estão dentro do recorte');
  // Fechado a lista do que pode sobrar, e por quê: as duas primeiras são de uma auditoria por URL (ninguém
  // apertou Tab de verdade, e o documento não tem raiz de sombra aberta); a terceira vem do catálogo da
  // própria fixture — 12.000 elementos dentro de um contêiner que rola entram na conta de "recortados", que
  // é o que a contagem em linguagem simples relata. Nenhuma delas é de geometria: se o leiaute tivesse
  // atrapalhado, `source-layout-changed` apareceria aqui e as caixas não existiriam.
  assert.deepEqual([...mapa.limitations].sort(), [
    'ancestor-clipped-stops-omitted', 'tab-order-estimated-not-observed', 'top-document-open-shadow-only',
  ], `limitações inesperadas: ${JSON.stringify(mapa.limitations)}`);
  assert.equal(mapa.derivation.version, '1.2.0', 'a geometria fresca e a omissão sem encaixe são do algoritmo 1.2.0');
  assert.equal(mapa.counts.stops, mapa.stops.length);
  // `omittedNoRect` conta o que não tem caixa nenhuma — nesta página, os elementos sem tamanho (o
  // contêiner do aviso antes de o aviso chegar, `script`, `title`): a contagem é honesta e não é defeito. O
  // que importa é que nenhum CONTROLE tenha ficado de fora, e isso o laço acima já confere um a um; a
  // frase em linguagem simples confirma que nada clicável foi omitido.
  assert.equal(live.counts, '5 lugares onde o Tab para; 0 itens que parecem clicáveis e o Tab não alcança.');
  assert.ok(Math.abs(mapa.derivation.geometry.scaleX - mapa.derivation.geometry.scaleY) <= 0.01,
    `escalas divergentes: ${JSON.stringify(mapa.derivation.geometry)}`);
  assert.ok(mapa.segments.length > 0);
  assert.ok(html.includes('data-keyboard-map-page="page-1"') && html.includes(mapa.hash));
  for (const controle of CONTROLES) {
    assert.ok(html.includes(controle.nome), `o relatório entregue precisa nomear "${controle.nome}"`);
  }
  assert.equal(loopback.violacoes.length, 0, `violações CSP: ${loopback.violacoes.join(' ')}`);
  t.diagnostic(`mapa: stops=${mapa.stops.length}; suspects=${mapa.suspects.length}; altura=${alturaNoMapa}; crescimento=${crescimento}`);
});

/** Pixels de caixa azul (parada do Tab) pintados nas imagens do mapa, como nos outros casos do teclado. */
async function countBoxPixels(extension, report) {
  return extension.evaluate(report, `(async () => {
    const images=[...document.querySelectorAll('[data-keyboard-map-page="page-1"] img[data-map-segment-image]')];
    let blue=0;
    for (const image of images) {
      const canvas=new OffscreenCanvas(image.naturalWidth,image.naturalHeight);
      const context=canvas.getContext('2d');
      context.drawImage(image,0,0);
      const {data}=context.getImageData(0,0,canvas.width,canvas.height);
      for (let index=0;index<data.length;index+=4) {
        if (data[index]<60 && data[index+1]>50 && data[index+1]<120 && data[index+2]>120) blue+=1;
      }
    }
    return { blue, images: images.length };
  })()`, { awaitPromise: true });
}

/**
 * PNG de cor sólida, montado aqui para a imagem não depender de arquivo binário no repositório. A cor é
 * verde-clara de propósito: nada nela se parece com o azul nem com o laranja das caixas do mapa, então a
 * contagem de pixels continua medindo caixa desenhada.
 */
function png(altura, largura, cor) {
  const linhas = Buffer.alloc((largura * 3 + 1) * altura);
  for (let linha = 0; linha < altura; linha += 1) {
    const inicio = linha * (largura * 3 + 1);
    for (let coluna = 0; coluna < largura; coluna += 1) {
      linhas[inicio + 1 + coluna * 3] = cor[0];
      linhas[inicio + 2 + coluna * 3] = cor[1];
      linhas[inicio + 3 + coluna * 3] = cor[2];
    }
  }
  const bloco = (tipo, dados) => {
    const cabecalho = Buffer.alloc(8);
    cabecalho.writeUInt32BE(dados.length, 0);
    cabecalho.write(tipo, 4, 'ascii');
    const verificacao = Buffer.alloc(4);
    verificacao.writeUInt32BE(crc32(Buffer.concat([cabecalho.subarray(4), dados])) >>> 0, 0);
    return Buffer.concat([cabecalho, dados, verificacao]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0);
  ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    bloco('IHDR', ihdr),
    bloco('IDAT', deflateSync(linhas)),
    bloco('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Servidor da fixture: entrega a página e segura a resposta da imagem pelo atraso pedido.
 *
 * O atraso no servidor é o coração da prova: numa aba escondida o Chrome adia o JavaScript da página, então
 * quem cronometra o crescimento não pode ser a própria página. Segurar a RESPOSTA funciona porque rede não é
 * adiada, e a imagem sem tamanho declarado empurra o conteúdo assim que chega — sem rodar uma linha de
 * JavaScript nesse instante.
 */
async function startGrowingLoopback() {
  const arquivos = new Map([
    ['/keyboard-map-cresce.html', ['keyboard-map-cresce.html', 'text/html; charset=utf-8']],
    ['/keyboard-map-cresce.css', ['keyboard-map-cresce.css', 'text/css; charset=utf-8']],
    ['/keyboard-map-cresce.js', ['keyboard-map-cresce.js', 'text/javascript; charset=utf-8']],
  ]);
  // A fixture é servida com CSP restritiva: só o que ela mesma precisa (o próprio script, o próprio estilo,
  // a própria imagem e o próprio `fetch`). Violação de CSP é falha do teste, como nas outras fixtures.
  const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; report-uri /csp-report";
  const registros = [];
  const violacoes = [];
  const imagens = new Map();
  let imagem = null;
  // O documento exportado, entregue aqui depois da exportação: é ele — e não o relatório da tela — que o
  // PDF imprime (`src/export/report-export.js` prepara o Blob do HTML gerado e o imprime numa aba própria).
  // Sem publicá-lo num endereço não há como medir a folha de impressão de verdade.
  let impressao = '';

  const servidor = createServer(async (requisicao, resposta) => {
    const url = new URL(requisicao.url, 'http://127.0.0.1');
    if (url.pathname === '/relatorio-impressao') {
      resposta.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-length': Buffer.byteLength(impressao),
      });
      resposta.end(impressao);
      return;
    }
    if (url.pathname === '/csp-report' && requisicao.method === 'POST') {
      let corpo = '';
      requisicao.setEncoding('utf8');
      requisicao.on('data', parte => { if (corpo.length < 16_384) corpo += parte; });
      requisicao.on('end', () => { violacoes.push(corpo.slice(0, 16_384)); resposta.writeHead(204); resposta.end(); });
      return;
    }
    if (url.pathname === '/cresce' && requisicao.method === 'POST') {
      let corpo = '';
      requisicao.setEncoding('utf8');
      requisicao.on('data', parte => { corpo += parte; });
      requisicao.on('end', () => {
        let dados = null;
        try { dados = JSON.parse(corpo); } catch { dados = null; }
        if (dados) registros.push({ quando: Date.now(), ...dados });
        resposta.writeHead(204); resposta.end();
      });
      return;
    }
    if (url.pathname === '/banner-lento.png') {
      const atraso = Number(url.searchParams.get('atraso') ?? ATRASO_DA_IMAGEM_MS);
      const marcador = url.searchParams.get('marcador') ?? 'sem-marcador';
      imagens.set(marcador, { pedido: Date.now(), chegada: null });
      imagem ??= png(IMAGEM.altura, IMAGEM.largura, IMAGEM.cor);
      // A resposta sai depois do atraso: é ela que muda o leiaute da página.
      setTimeout(() => {
        const registro = imagens.get(marcador);
        if (registro) registro.chegada = Date.now();
        resposta.writeHead(200, {
          'content-type': 'image/png', 'content-length': imagem.length, 'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        resposta.end(imagem);
      }, Number.isFinite(atraso) && atraso >= 0 ? atraso : ATRASO_DA_IMAGEM_MS);
      return;
    }
    const arquivo = arquivos.get(url.pathname);
    if (!arquivo) { resposta.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); resposta.end('not found'); return; }
    const [nome, tipo] = arquivo;
    resposta.writeHead(200, {
      'content-type': tipo, 'content-security-policy': csp, 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    resposta.end(await readFile(join(fixtureRoot, nome)));
  });
  await new Promise((resolver, rejeitar) => servidor.listen(0, '127.0.0.1', erro =>
    erro ? rejeitar(erro) : resolver()));
  return {
    origin: `http://127.0.0.1:${servidor.address().port}`,
    violacoes,
    /** Publica o documento exportado para a medição da folha de impressão. */
    servirImpressao: documento => { impressao = typeof documento === 'string' ? documento : ''; },
    /**
     * Os marcos do CARREGAMENTO DA AUDITORIA, em milissegundos do mesmo relógio do servidor: quando o pedido
     * da imagem saiu (`resize` da captura de aquecimento), quando a resposta chegou (o instante em que o
     * leiaute cresce) e quando a página viu o `resize` da captura de verdade. `controlesDeCarga` é a posição
     * medida pela própria página antes de tudo.
     *
     * A página pode ser carregada duas vezes no teste — a aba inicial do Chrome e a aba da auditoria —, e o
     * carregamento da auditoria é o ÚLTIMO a registrar a carga. Misturar os dois foi o erro da primeira
     * versão desta fixture: o marco de uma aba era comparado com o marco da outra.
     */
    timeline: () => {
      const porMarcador = new Map();
      for (const registro of registros) {
        const grupo = porMarcador.get(registro.marcador) ?? [];
        grupo.push(registro);
        porMarcador.set(registro.marcador, grupo);
      }
      const daAuditoria = [...porMarcador.values()]
        .filter(grupo => grupo.some(registro => registro.motivo === 'carga'))
        .at(-1) ?? [];
      const marcador = daAuditoria[0]?.marcador ?? null;
      const carga = daAuditoria.find(registro => registro.motivo === 'carga');
      const aquecimento = daAuditoria.find(registro => registro.motivo === 'aviso-inserido');
      // Os `resize` chegam em grupos, um grupo por captura integral (medido: dois por captura, com ~84 ms
      // entre eles). O ÚLTIMO grupo é o da captura de verdade: o primeiro `resize` dele é o instante em que
      // a captura começou a mexer na área de renderização, logo depois de o mapa ler as métricas do
      // instante (M0) e antes de os pixels saírem. É por isso que ele serve de marco do fim: se o
      // crescimento chegou antes dele, chegou antes de a imagem ser tirada.
      const resizes = daAuditoria.filter(registro => registro.motivo === 'resize');
      const grupos = [];
      for (const registro of resizes) {
        const anterior = grupos.at(-1);
        if (!anterior || registro.quando - anterior.at(-1).quando > 200) grupos.push([registro]);
        else anterior.push(registro);
      }
      return {
        marcador,
        pedido: imagens.get(marcador)?.pedido ?? null,
        chegada: imagens.get(marcador)?.chegada ?? null,
        inseriu: aquecimento?.quando ?? null,
        grupos,
        resizes: resizes.map(registro => ({ indice: registro.indice, quando: registro.quando })),
        imagem: daAuditoria.some(registro => registro.motivo === 'imagem-chegou') ? 'carregou' : null,
        falhaDaImagem: daAuditoria.some(registro => registro.motivo === 'imagem-falhou'),
        alturaDeCarga: carga?.altura ?? null,
        controlesDeCarga: carga?.controles ?? {},
        registros: daAuditoria.map(registro => registro.motivo),
        carregamentos: [...porMarcador.values()].map(grupo => grupo.map(registro => registro.motivo).join('>')),
      };
    },
    close: () => new Promise(resolver => { servidor.closeAllConnections?.(); servidor.close(() => resolver()); }),
  };
}
