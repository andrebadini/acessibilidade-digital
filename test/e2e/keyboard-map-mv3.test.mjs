import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_CHROME_PRODUCT,
  command,
  launchUnpackedExtension,
  resolveRealChromeTestBinary,
} from './support/real-chrome.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = join(root, 'test/e2e/fixtures');
const chromeBinary = resolveRealChromeTestBinary();
const privateMarker = 'KEYBOARD-MAP-PRIVATE-731905';
const strictCsp = "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self' data:; frame-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; report-uri /csp-report";
const CARD_LABELS = ['Consultar processo', 'Emitir segunda via', 'Agendar atendimento', 'Registrar pedido'];

test('prova o mapa do teclado: cartões que só abrem com o mouse ficam sem caixa numerada', { timeout: 300_000 }, async t => {
  assert.ok(chromeBinary, 'AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório para o E2E real do mapa do teclado.');
  await access(chromeBinary, fsConstants.X_OK);
  const loopback = await startLoopback();
  t.after(() => loopback.close());

  const fixtureUrl = `${loopback.origin}/keyboard-map.html`;
  const response = await fetch(fixtureUrl);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-security-policy'), strictCsp);
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
    body:document.body.innerText.slice(0,1200),
  }))()`, value => ['result', 'unavailable'].includes(value?.screen) || value?.confirm === true, {
    timeoutMs: 120_000, intervalMs: 50,
  });
  t.diagnostic(`panel terminal: ${JSON.stringify({ screen: terminal.screen, status: terminal.status })}`);
  assert.equal(terminal.confirm, false, `a auditoria por URL não pode pedir confirmação: ${JSON.stringify(terminal)}`);
  assert.equal(terminal.screen, 'result', `a auditoria por URL precisa concluir: ${JSON.stringify(terminal)}`);
  const auditId = await extension.evaluate(panel, `document.querySelector('[data-screen="result"]')?.dataset.auditId`);
  assert.match(auditId ?? '', /^[A-Za-z0-9._:-]{1,160}$/u);

  await extension.click(panel, '[data-action="open-report"], button[data-focus-id="open-report"]');
  const report = await extension.waitForReport({ auditId });
  // O relatório abre em segundo plano enquanto o painel lateral está à frente: sem trazer a aba para
  // a frente, `document.activeElement` de um documento sem foco devolve o `body` e a conferência de
  // que a caixa obrigatória recebeu o foco não teria como passar. Aqui o caminho é o CDP direto
  // porque a página do relatório não tem `tabId` do `chrome.tabs` para o harness de abas.
  await command(report, 'Page.bringToFront');
  await extension.waitForValue(report, 'document.hasFocus()', Boolean, { timeoutMs: 10_000, intervalMs: 50 });
  await extension.waitForValue(report, `Boolean(document.querySelector('[data-keyboard-map-page="page-1"]'))`, Boolean, {
    timeoutMs: 30_000, intervalMs: 50,
  });

  const live = await extension.evaluate(report, `(() => {
    const card=document.querySelector('[data-keyboard-map-page="page-1"]');
    return {
      status: card.dataset.mapStatus,
      text: card.textContent,
      sectionText: card.closest('section')?.textContent ?? '',
      images: [...card.querySelectorAll('img[data-map-segment-image]')].map(image => ({
        loaded: image.complete && image.naturalWidth > 0, alt: image.alt })),
      stops: [...card.querySelectorAll('[data-keyboard-map-stop]')].map(entry => entry.textContent),
      suspects: [...card.querySelectorAll('[data-keyboard-map-suspect]')].map(entry => entry.textContent),
      counts: card.querySelector('.keyboard-map-counts')?.textContent ?? '',
      horizontalOverflow: card.scrollWidth > card.clientWidth + 1,
    };
  })()`);
  assert.equal(live.images.length > 0, true, 'o mapa precisa trazer ao menos um trecho em pixels');
  assert.ok(live.images.every(image => image.loaded && /Trecho \d+ de \d+/u.test(image.alt)));
  assert.ok(live.sectionText.includes('Cada caixa azul numerada é um lugar onde a tecla Tab para, na ordem dos números. Caixas laranja tracejadas: itens que parecem clicáveis, mas o Tab não chega até eles.'));
  assert.ok(live.sectionText.includes('Para conferir na própria página: clique numa área vazia e use a tecla Tab.'));
  assert.match(live.counts, /^\d+ lugares? onde o Tab para; \d+ (?:item que parece clicável|itens que parecem clicáveis) e o Tab não alcança\.$/u);
  assert.equal(live.horizontalOverflow, false);

  // O ponto central do caso real: os quatro cartões que só abrem com o mouse não podem ter caixa azul.
  for (const label of CARD_LABELS) {
    assert.equal(live.stops.some(entry => entry.includes(label)), false,
      `o cartão "${label}" não pode aparecer entre as paradas do Tab: ${JSON.stringify(live.stops)}`);
    assert.equal(live.suspects.filter(entry => entry.includes(label)).length, 1,
      `o cartão "${label}" precisa aparecer uma vez entre os itens sem caixa: ${JSON.stringify(live.suspects)}`);
  }
  // Com a regra de conteúdo só com mouse (1.1.58), os cartões chegam como achado dela; sem ela, pelo cursor.
  assert.ok(live.suspects.every(entry =>
    /mostra a seta de clique e mesmo assim não recebe o Tab|abre opções só quando o mouse passa por cima/u.test(entry)),
  JSON.stringify(live.suspects));
  t.diagnostic(`keyboard-map live: stops=${live.stops.length}; suspects=${live.suspects.length}; counts=${live.counts}`);

  await extension.evaluate(report, `document.querySelector('[data-keyboard-map-page="page-1"]').scrollIntoView({ behavior: 'instant', block: 'start' })`);
  await extension.captureJourney('report-keyboard-map', report, { captureBeyondViewport: false });

  // A revisão guiada do item 5.1.13 usa o mapa: três respostas e descrição obrigatória ao reprovar.
  const review = await extension.waitForValue(report, `(() => {
    const question=document.querySelector('[data-lay-question="5.1.13"]');
    if(!question) return null;
    // O cartão da revisão abre fechado e o conteúdo de um details fechado não recebe foco: sem
    // abrir o cartão, a caixa obrigatória não teria como ficar com o foco depois do clique.
    question.closest('details.lay-card').open=true;
    [...question.querySelectorAll('details')].forEach(detail => { detail.open=true; });
    question.scrollIntoView({behavior:'instant',block:'start'});
    const map=question.querySelector('.lay-keyboard-map');
    return {
      question: question.querySelector('.lay-q')?.textContent ?? '',
      asksMap: question.textContent.includes('Olhe o mapa. Algum menu, botão, link ou campo que você usaria está SEM caixa azul numerada?'),
      hasMap: Boolean(map),
      mapImages: map ? map.querySelectorAll('img.lay-keyboard-map-thumb').length : 0,
      answers: [...question.querySelectorAll('.lay-keyboard-map-answers [data-lay-answer]')].map(button => button.textContent),
      genericAnswers: [...question.querySelectorAll('.lay-answers:not(.lay-keyboard-map-answers) [data-lay-answer]')].map(button => button.textContent),
    };
  })()`, value => value !== null, { timeoutMs: 30_000, intervalMs: 100 });
  assert.equal(review.asksMap, true, 'o cartão do 5.1.13 precisa perguntar pelo mapa');
  assert.equal(review.hasMap, true, 'o cartão precisa mostrar o mapa (ou a lista) junto da pergunta');
  assert.equal(review.mapImages > 0, true);
  assert.deepEqual(review.answers, ['Sim, falta caixa em algum item', 'Não, todos os itens que uso têm caixa', 'Não consegui verificar']);
  assert.deepEqual(review.genericAnswers, [], 'sem fileira genérica duplicando o caminho de "não conforme"');

  const mandatory = await extension.evaluate(report, `(() => {
    const question=document.querySelector('[data-lay-question="5.1.13"]');
    const fail=[...question.querySelectorAll('.lay-keyboard-map-answers [data-lay-answer]')]
      .find(button => button.dataset.layAnswer === 'não conforme');
    fail.click();
    const finding=question.querySelector('.lay-finding');
    return {
      visible: finding.hidden === false,
      focused: document.activeElement?.tagName === 'TEXTAREA' && Boolean(document.activeElement.closest('.lay-finding')),
      draft: finding.querySelector('textarea').value,
      label: finding.querySelector('label').textContent,
    };
  })()`);
  assert.equal(mandatory.visible, true, 'escolher "Sim" precisa abrir a caixa de descrição na hora');
  assert.equal(mandatory.focused, true, 'a caixa obrigatória recebe o foco');
  assert.match(mandatory.draft, /mapa do teclado/u, 'o rascunho já cita o mapa do teclado');
  assert.match(mandatory.label, /^Descreva qual item ficou sem caixa/u);
  await extension.captureJourney('review-keyboard-map-question', report, { captureBeyondViewport: false });

  // Exportação: o artefato do mapa chega ao JSON e o texto entregue mantém legenda, listas e hash.
  await extension.click(report, 'button[data-report-export]');
  const downloads = await extension.waitForFourDownloads({ auditId, timeoutMs: 300_000, intervalMs: 50 });
  const [jsonBytes, html] = await Promise.all([
    readFile(join(extension.downloadDirectory, downloads.find(value => value.format === 'json').filename), 'utf8'),
    readFile(join(extension.downloadDirectory, downloads.find(value => value.format === 'html').filename), 'utf8'),
  ]);
  const technical = JSON.parse(jsonBytes.replace(/^﻿/u, ''));
  const audit = technical.audit;
  const original = audit.evidence.find(artifact => artifact.kind === 'full-page' && artifact.state === 'pristine');
  const map = audit.evidence.find(artifact => artifact.kind === 'keyboard-map');
  assert.ok(original, 'a captura pristine não chegou ao relatório técnico');
  assert.ok(map, 'o wrapper produtivo não publicou o mapa do teclado');
  assert.equal(map.pageId, 'page-1');
  assert.equal(map.fullPageEvidenceId, original.evidenceId);
  assert.equal(map.derivation.sourceEvidenceId, original.evidenceId);
  assert.equal(map.derivation.sourceHash, original.hash);
  assert.match(map.hash, /^[a-f0-9]{64}$/u);
  assert.equal(map.derivation.algorithm, 'audita.keyboard-map');
  assert.equal(map.segments.length > 0, true);
  assert.ok(map.segments.every(segment => /^[a-f0-9]{64}$/u.test(segment.contentHash) && segment.dataUrl.startsWith('data:image/png;base64,')));
  assert.ok(map.derivation.geometry.sourceCssSize.width > 0 && map.derivation.geometry.sourceCssSize.height > 0);
  assert.ok(map.limitations.includes('tab-order-estimated-not-observed'), 'a estimativa da ordem precisa ser declarada');
  assert.equal(map.counts.stops, map.stops.length);
  assert.equal(map.counts.suspects, map.suspects.length);
  assert.equal(map.stops.some(stop => CARD_LABELS.some(label => (stop.name ?? '').includes(label))), false);
  const cardSuspects = map.suspects.filter(suspect => CARD_LABELS.some(label => (suspect.name ?? '').includes(label)));
  // A regra de conteúdo só com mouse acha os quatro cartões; o mapa os recebe como achado dela.
  assert.deepEqual(cardSuspects.map(suspect => [suspect.reason, suspect.ruleId]),
    Array(4).fill(['keyboard-rule', 'hover-only-interactive-content']));
  assert.equal(cardSuspects.every(suspect => suspect.nameSource !== 'attribute'), true);
  assert.ok(map.stops.some(stop => stop.kind === 'summary'), 'o resumo que abre e fecha é uma parada do Tab');
  assert.ok(map.stops.some(stop => stop.kind === 'tabindex'), 'o elemento que só entra na ordem do Tab por tabindex precisa aparecer');
  assert.equal(map.stops[0].tabIndex, 3, 'a parada com tabindex positivo vem antes das demais, como o navegador faz');
  assert.match(map.stops[0].name, /ordem de foco declarada/u, 'e ela mantém o próprio rótulo');
  assert.equal(map.stops.some(stop => stop.tabIndex < 0), false, 'tabindex negativo não é parada do Tab');
  assert.equal(map.stops.some(stop => /Campo desativado/u.test(stop.name ?? '')), false, 'campo desativado não é parada do Tab');
  assert.equal(JSON.stringify(map).includes('Botão fora da ordem do Tab'), false);
  assert.equal(JSON.stringify(map).includes('Link em bloco escondido'), false);
  assert.equal(JSON.stringify(map).includes('Link decorativo'), false);
  t.diagnostic(`keyboard-map artifact: stops=${map.stops.length}; suspects=${map.suspects.length}; limitations=${map.limitations.join(',')}`);

  assert.ok(html.includes('data-keyboard-map-page="page-1"'));
  assert.ok(html.includes('data-keyboard-map-stop="1"'));
  assert.ok(html.includes('Cada caixa azul numerada é um lugar onde a tecla Tab para'));
  assert.ok(html.includes(map.hash));

  // Alinhamento (1.1.60): nesta página estável a captura e a leitura da estrutura descrevem o mesmo
  // leiaute, então a escala é uniforme, nenhuma caixa foi omitida por mudança de leiaute, e as caixas
  // estão de fato pintadas na imagem.
  assert.ok(Math.abs(map.derivation.geometry.scaleX - map.derivation.geometry.scaleY) <= 0.01,
    `escalas divergentes: ${JSON.stringify(map.derivation.geometry)}`);
  assert.equal(map.limitations.includes('non-uniform-pixel-scale'), false);
  assert.equal(map.limitations.includes('source-layout-changed'), false);
  assert.equal(map.counts.stops, map.stops.length);
  const drawn = await countBoxPixels(extension, report);
  assert.ok(drawn.blue > 0, `as caixas azuis precisam estar pintadas na imagem: ${JSON.stringify(drawn)}`);
  t.diagnostic(`keyboard-map pixels: ${JSON.stringify(drawn)}`);
  for (const label of CARD_LABELS) assert.ok(html.includes(label), `a lista de itens sem caixa precisa nomear "${label}"`);
  for (const output of [jsonBytes, html, ...loopback.cspReports]) {
    assert.equal(output.includes(privateMarker), false, 'uma saída pública textual contém o valor privado do campo');
  }
  assert.equal(loopback.cspReports.length, 0, `violações CSP: ${loopback.cspReports.join(' ')}`);
  assert.doesNotMatch(`${html}\n${loopback.cspReports.join('\n')}`, /unsafe-eval|EvalError/iu);
});

test('uma página que cresce sem parar sai sem caixa nenhuma, com a lista inteira e a explicação', { timeout: 300_000 }, async t => {
  assert.ok(chromeBinary, 'AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório para o E2E real do mapa do teclado.');
  await access(chromeBinary, fsConstants.X_OK);
  const loopback = await startLazyLoopback();
  t.after(() => loopback.close());

  // A lista cresce por carga sob demanda em TODO resize provocado por captura (a captura integral encolhe a
  // janela para 1×1 e devolve o tamanho depois — medido). Cada captura, inclusive a de aquecimento e a de
  // verdade, acrescenta um bloco de 300 px: a altura no instante em que os retângulos são medidos e a altura
  // no instante da captura nunca coincidem. Sem acordo de leiaute o mapa não desenha caixa (e diz isso no
  // relatório), em vez de espalhar caixas no lugar errado.
  const fixtureUrl = `${loopback.origin}/keyboard-map-lazy.html`;
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
  }))()`, value => ['result', 'unavailable'].includes(value?.screen) || value?.confirm === true, {
    timeoutMs: 180_000, intervalMs: 50,
  });
  assert.equal(terminal.confirm, false, `a auditoria por URL não pode pedir confirmação: ${JSON.stringify(terminal)}`);
  assert.equal(terminal.screen, 'result', `a auditoria por URL precisa concluir: ${JSON.stringify(terminal)}`);
  const auditId = await extension.evaluate(panel, `document.querySelector('[data-screen="result"]')?.dataset.auditId`);

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
      images: [...card.querySelectorAll('img[data-map-segment-image]')].length,
      stops: [...card.querySelectorAll('[data-keyboard-map-stop]')].map(entry => entry.textContent),
      suspects: [...card.querySelectorAll('[data-keyboard-map-suspect]')].map(entry => entry.textContent),
      horizontalOverflow: card.scrollWidth > card.clientWidth + 1,
    };
  })()`);
  // A imagem continua no relatório; o que não existe é caixa desenhada nela.
  assert.ok(live.images > 0, 'a imagem da página precisa continuar no relatório');
  assert.match(live.sectionText, /A página mudou de tamanho enquanto era verificada/iu);
  assert.match(live.sectionText, /nenhuma caixa foi desenhada na imagem; a lista abaixo continua completa/iu);
  assert.ok(live.stops.length > 0, 'a lista do que o Tab alcança precisa continuar completa');
  assert.ok(live.stops.some(entry => /Buscar/u.test(entry)), `faltou uma parada conhecida: ${JSON.stringify(live.stops)}`);
  assert.ok(live.suspects.some(entry => /Abre as opções só com o mouse/u.test(entry)),
    `faltou o item que só o mouse alcança: ${JSON.stringify(live.suspects)}`);
  assert.equal(live.horizontalOverflow, false);
  const pixels = await countBoxPixels(extension, report);
  // Uma caixa de verdade pinta muito mais do que isto: no teste da página estável, 7 paradas deram 9.669
  // pixels azuis (cerca de 1.380 por caixa). O teto tolera alguns pixels azulados isolados de qualquer
  // detalhe da própria página, e continua muito abaixo de uma única caixa desenhada.
  assert.ok(pixels.blue < 200, `nenhuma caixa azul pode ser pintada: ${JSON.stringify(pixels)}`);
  assert.ok(pixels.orange < 200, `nenhuma caixa laranja pode ser pintada: ${JSON.stringify(pixels)}`);
  t.diagnostic(`keyboard-map página que cresce: stops=${live.stops.length}; pixels=${JSON.stringify(pixels)}`);

  await extension.click(report, 'button[data-report-export]');
  const downloads = await extension.waitForFourDownloads({ auditId, timeoutMs: 300_000, intervalMs: 50 });
  const jsonBytes = await readFile(join(extension.downloadDirectory, downloads.find(value => value.format === 'json').filename), 'utf8');
  const map = JSON.parse(jsonBytes.replace(/^﻿/u, '')).audit.evidence.find(artifact => artifact.kind === 'keyboard-map');
  assert.ok(map, 'o mapa do teclado precisa chegar ao relatório técnico mesmo sem caixas');
  assert.equal(map.status, 'partial');
  assert.ok(map.limitations.includes('source-layout-changed'), `limitações: ${JSON.stringify(map.limitations)}`);
  assert.equal(map.limitations.includes('non-uniform-pixel-scale'), false, 'a escala é uniforme: o que muda é o leiaute');
  assert.ok(map.stops.length > 0 && map.suspects.length > 0, 'as duas listas continuam preenchidas');
  assert.equal(map.counts.stops, map.stops.length);
  assert.equal(map.counts.suspects, map.suspects.length);
  assert.ok(map.segments.length > 0);
  assert.ok(Math.abs(map.derivation.geometry.scaleX - map.derivation.geometry.scaleY) <= 0.01,
    `escalas divergentes: ${JSON.stringify(map.derivation.geometry)}`);
});

test('uma página que cresce por causa da própria captura volta a ter caixas alinhadas', { timeout: 300_000 }, async t => {
  assert.ok(chromeBinary, 'AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório para o E2E real do mapa do teclado.');
  await access(chromeBinary, fsConstants.X_OK);
  const loopback = await startLazyLoopback();
  t.after(() => loopback.close());

  // Esta página só cresce quando a auditoria captura: o primeiro `resize` que a captura provoca monta três
  // blocos de 300 px e depois a lista fica parada (medido: 1.315 px → 2.325 px logo depois do aquecimento, e
  // deriva zero nas capturas seguintes). É o caso que o mapa perdia: sem aquecimento, a estrutura é lida
  // antes da carga e a captura acontece depois dela, então os retângulos e os pixels são de estados
  // diferentes e nenhuma caixa é desenhada. Com o aquecimento da 1.1.60 a carga acontece ANTES da leitura, a
  // página assenta, e as caixas voltam alinhadas.
  const fixtureUrl = `${loopback.origin}/keyboard-map-lazy.html?modo=captura`;
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
  }))()`, value => ['result', 'unavailable'].includes(value?.screen) || value?.confirm === true, {
    timeoutMs: 180_000, intervalMs: 50,
  });
  assert.equal(terminal.confirm, false, `a auditoria por URL não pode pedir confirmação: ${JSON.stringify(terminal)}`);
  assert.equal(terminal.screen, 'result', `a auditoria por URL precisa concluir: ${JSON.stringify(terminal)}`);
  const auditId = await extension.evaluate(panel, `document.querySelector('[data-screen="result"]')?.dataset.auditId`);

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
      images: [...card.querySelectorAll('img[data-map-segment-image]')].length,
      stops: [...card.querySelectorAll('[data-keyboard-map-stop]')].map(entry => entry.textContent),
      suspects: [...card.querySelectorAll('[data-keyboard-map-suspect]')].map(entry => entry.textContent),
      horizontalOverflow: card.scrollWidth > card.clientWidth + 1,
    };
  })()`);
  assert.ok(live.images > 0, 'a imagem da página precisa continuar no relatório');
  // A explicação de leiaute mudado não pode aparecer: aqui a página assentou antes da leitura.
  assert.doesNotMatch(live.sectionText, /A página mudou de tamanho enquanto era verificada/iu);
  // As três paradas que só existem depois da carga disparada pela captura. Se o aquecimento não tivesse
  // montado os blocos antes da leitura, elas não estariam na lista — é o que prova que o aquecimento agiu.
  for (const numero of [1, 2, 3]) {
    assert.ok(live.stops.some(entry => entry.includes(`Protocolo ${numero}`)),
      `a parada "Protocolo ${numero}" precisa estar na lista: ${JSON.stringify(live.stops)}`);
  }
  assert.ok(live.suspects.some(entry => /Abre as opções só com o mouse/u.test(entry)),
    `faltou o item que só o mouse alcança: ${JSON.stringify(live.suspects)}`);
  assert.equal(live.horizontalOverflow, false);
  const pixels = await countBoxPixels(extension, report);
  // Uma caixa de verdade pinta centenas de pixels de contorno; "nenhuma caixa" fica abaixo dos 200 usados
  // pelo teste da página que cresce sem parar. As duas listas deste caso são grandes de propósito.
  assert.ok(pixels.blue > 400, `as caixas azuis precisam estar pintadas na imagem: ${JSON.stringify(pixels)}`);
  assert.ok(pixels.orange > 400, `a caixa laranja precisa estar pintada na imagem: ${JSON.stringify(pixels)}`);
  t.diagnostic(`keyboard-map aquecimento: stops=${live.stops.length}; pixels=${JSON.stringify(pixels)}`);

  await extension.click(report, 'button[data-report-export]');
  const downloads = await extension.waitForFourDownloads({ auditId, timeoutMs: 300_000, intervalMs: 50 });
  const jsonBytes = await readFile(join(extension.downloadDirectory, downloads.find(value => value.format === 'json').filename), 'utf8');
  const map = JSON.parse(jsonBytes.replace(/^﻿/u, '')).audit.evidence.find(artifact => artifact.kind === 'keyboard-map');
  assert.ok(map, 'o mapa do teclado precisa chegar ao relatório técnico');
  assert.equal(map.limitations.includes('source-layout-changed'), false,
    `o leiaute não mudou depois do aquecimento: ${JSON.stringify(map.limitations)}`);
  assert.equal(map.limitations.includes('non-uniform-pixel-scale'), false, 'a escala é uniforme');
  assert.equal(map.status, 'complete', `status do mapa: ${map.status}`);
  assert.equal(map.counts.stops, map.stops.length);
  assert.equal(map.counts.suspects, map.suspects.length);
  assert.ok(map.stops.some(stop => /Protocolo 3/u.test(stop.name ?? '')), 'a carga disparada pela captura entra no mapa');
  assert.ok(map.segments.length > 0);
  assert.ok(Math.abs(map.derivation.geometry.scaleX - map.derivation.geometry.scaleY) <= 0.01,
    `escalas divergentes: ${JSON.stringify(map.derivation.geometry)}`);
});

/**
 * Quantos pixels de caixa azul (parada do Tab) e laranja (item que só o mouse alcança) existem nas
 * imagens do mapa do teclado do relatório. É a verificação que separa "o relatório promete caixas" de
 * "as caixas estão pintadas na imagem" — e, no caso da página que cresce, de "nenhuma caixa pintada".
 */
async function countBoxPixels(extension, report) {
  // `awaitPromise`: sem isso o CDP devolve o objeto vazio da promessa, e a contagem nunca chega.
  return extension.evaluate(report, `(async () => {
    const images=[...document.querySelectorAll('[data-keyboard-map-page="page-1"] img[data-map-segment-image]')];
    let blue=0, orange=0;
    for (const image of images) {
      const canvas=new OffscreenCanvas(image.naturalWidth,image.naturalHeight);
      const context=canvas.getContext('2d');
      context.drawImage(image,0,0);
      const {data}=context.getImageData(0,0,canvas.width,canvas.height);
      for (let index=0;index<data.length;index+=4) {
        const red=data[index], green=data[index+1], channel=data[index+2];
        if (red<60 && green>50 && green<120 && channel>120) blue+=1;
        if (red>140 && red<210 && green>50 && green<120 && channel<60) orange+=1;
      }
    }
    return { blue, orange, images: images.length };
  })()`, { awaitPromise: true });
}

async function startLazyLoopback() {
  const files = new Map([
    ['/keyboard-map-lazy.html', ['keyboard-map-lazy.html', 'text/html; charset=utf-8']],
    ['/keyboard-map-lazy.js', ['keyboard-map-lazy.js', 'text/javascript; charset=utf-8']],
  ]);
  const server = createServer(async (request, response) => {
    const fixture = files.get(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!fixture) { response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); response.end('not found'); return; }
    const [name, contentType] = fixture;
    response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(await readFile(join(fixtureRoot, name)));
  });
  await new Promise((resolveListen, rejectListen) => server.listen(0, '127.0.0.1', error =>
    error ? rejectListen(error) : resolveListen()));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolveClose => server.close(resolveClose)),
  };
}

async function startLoopback() {
  const cspReports = [];
  const files = new Map([
    ['/keyboard-map.html', ['keyboard-map.html', 'text/html; charset=utf-8', true]],
    ['/keyboard-map.css', ['keyboard-map.css', 'text/css; charset=utf-8', false]],
  ]);
  const server = createServer(async (request, response) => {
    if (request.url === '/csp-report' && request.method === 'POST') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { if (body.length < 16_384) body += chunk; });
      request.on('end', () => { cspReports.push(body.slice(0, 16_384)); response.writeHead(204); response.end(); });
      return;
    }
    const fixture = files.get(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!fixture) { response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); response.end('not found'); return; }
    const [name, contentType, html] = fixture;
    response.writeHead(200, {
      'content-type': contentType,
      ...(html ? { 'content-security-policy': strictCsp } : {}),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(await readFile(join(fixtureRoot, name)));
  });
  await new Promise((resolveListen, rejectListen) => server.listen(0, '127.0.0.1', error =>
    error ? rejectListen(error) : resolveListen()));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    cspReports,
    close: () => new Promise(resolveClose => server.close(resolveClose)),
  };
}
