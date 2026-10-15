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
  pressKey,
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

  // A gravação exige o nome da pessoa avaliadora; sem ele o cartão não é respondido.
  await extension.evaluate(report, `(() => {
    document.querySelector('#review-evaluator').value='Pessoa revisora';
    return true;
  })()`);

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

  // Apontamento no mapa: a lista traz os itens laranja do próprio mapa e a pessoa marca o que ficou
  // sem caixa azul. O bloco só existe depois de "Sim, falta caixa".
  const apontamento = await extension.evaluate(report, `(() => {
    const question=document.querySelector('[data-lay-question="5.1.13"]');
    const block=question.querySelector('[data-lay-marks]');
    if(!block) return null;
    block.scrollIntoView({behavior:'instant',block:'center'});
    const box=block.querySelector('[data-lay-marks-suspect]');
    box.checked=true; box.dispatchEvent(new Event('change',{bubbles:true}));
    return {
      subtitle: block.querySelector('.lay-map-subtitle')?.textContent ?? '',
      suspects: [...block.querySelectorAll('[data-lay-marks-suspect]')].map(caixa => ({
        value: caixa.value, label: caixa.closest('label').textContent.trim(), checked: caixa.checked })),
      status: block.querySelector('[data-lay-marks-status]')?.textContent ?? '',
      areas: block.querySelectorAll('[data-lay-marks-area-list]').length,
      surfaceLabel: block.querySelector('.lay-marks-surface')?.getAttribute('aria-label') ?? '',
      hasAdd: Boolean(block.querySelector('.lay-marks-add')),
      images: [...block.querySelectorAll('.lay-marks-image')].map(image => image.getAttribute('viewBox')),
    };
  })()`);
  assert.ok(apontamento, 'o apontamento no mapa precisa aparecer depois de "Sim, falta caixa"');
  assert.equal(apontamento.subtitle, 'Marque os itens que ficaram sem caixa azul (opcional).');
  assert.ok(apontamento.suspects.length >= 1, 'a lista precisa trazer os itens sem caixa do mapa');
  assert.match(apontamento.suspects[0].label, /^\S.* — \S/u, 'a lista repete o nome e o motivo vistos no mapa');
  assert.equal(apontamento.suspects[0].checked, true);
  assert.match(apontamento.status, /marcado como sem caixa azul/u);
  assert.equal(apontamento.areas, 0, 'nenhuma área marcada antes de desenhar');
  assert.match(apontamento.surfaceLabel, /setas para mover/u);
  assert.equal(apontamento.hasAdd, true, 'a alternativa por teclado precisa existir');
  assert.ok(apontamento.images.every(viewBox => /^0 0 \d+ \d+$/u.test(viewBox)));

  // Caminho de teclado: "Adicionar área" cria a área na parte visível, as setas movem, Delete remove.
  await extension.click(report, '[data-lay-question="5.1.13"] .lay-marks-add');
  const primeiraArea = await extension.waitForValue(report, `(() => {
    const block=document.querySelector('[data-lay-question="5.1.13"] [data-lay-marks]');
    const item=block.querySelector('[data-lay-marks-area-list="1"]');
    const rect=block.querySelector('rect[data-lay-marks-area="1"]');
    return item ? {
      describe: item.textContent.trim(), status: block.querySelector('[data-lay-marks-status]').textContent,
      rect: rect ? { x: Number(rect.getAttribute('x')), y: Number(rect.getAttribute('y')),
        width: Number(rect.getAttribute('width')), height: Number(rect.getAttribute('height')) } : null,
      remove: [...block.querySelectorAll('.lay-marks-remove-button')].map(button => button.textContent),
    } : null;
  })()`, value => value !== null, { timeoutMs: 30_000, intervalMs: 50 });
  assert.match(primeiraArea.describe, /^Área 1, (no alto|no meio|na parte de baixo) da página, (à esquerda|no centro|à direita)\./u,
    'a área é descrita em palavras, sem coordenadas');
  assert.match(primeiraArea.status, /Área marcada\. Use as setas/u);
  assert.ok(primeiraArea.rect && primeiraArea.rect.width > 0 && primeiraArea.rect.height > 0);
  assert.deepEqual(primeiraArea.remove, ['Remover área 1']);

  const rectOf = `(() => {
    const rect=document.querySelector('[data-lay-question="5.1.13"] rect[data-lay-marks-area="1"]');
    return rect ? [Number(rect.getAttribute('x')), Number(rect.getAttribute('y'))] : null;
  })()`;
  await extension.evaluate(report, `(() => {
    document.querySelector('[data-lay-question="5.1.13"] .lay-marks-surface').focus();
    return true;
  })()`);
  await pressKey(report, { key: 'ArrowRight', code: 'ArrowRight', virtualKeyCode: 39 });
  const movida = await extension.waitForValue(report, rectOf,
    value => Array.isArray(value) && value[0] === primeiraArea.rect.x + 8, { timeoutMs: 10_000, intervalMs: 50 });
  assert.deepEqual(movida[1], primeiraArea.rect.y, 'a seta move só no eixo pedido');
  await pressKey(report, { key: 'Delete', code: 'Delete', virtualKeyCode: 46 });
  await extension.waitForValue(report,
    `document.querySelector('[data-lay-question="5.1.13"] [data-lay-marks-area-list="1"]') === null`,
    Boolean, { timeoutMs: 10_000, intervalMs: 50 });
  await extension.click(report, '[data-lay-question="5.1.13"] .lay-marks-add');
  const areaFinal = await extension.waitForValue(report, `(() => {
    const block=document.querySelector('[data-lay-question="5.1.13"] [data-lay-marks]');
    return {
      describe: block.querySelector('[data-lay-marks-area-list="1"]')?.textContent.trim() ?? '',
      status: block.querySelector('[data-lay-marks-status]').textContent,
    };
  })()`, value => value.describe !== '', { timeoutMs: 30_000, intervalMs: 50 });
  assert.match(areaFinal.status, /Área marcada\./u);
  t.diagnostic(`apontamento: suspeitos=${apontamento.suspects.length}; área=${areaFinal.describe}`);
  // Captura com a lista de itens, a área marcada na lista e o botão da alternativa por teclado à vista.
  await extension.evaluate(report, `(() => {
    const question=document.querySelector('[data-lay-question="5.1.13"]');
    question.querySelector('.lay-marks-suspects')?.scrollIntoView({behavior:'instant',block:'start'});
    return true;
  })()`);
  await extension.captureJourney('review-keyboard-map-marks', report, { captureBeyondViewport: false });
  // Segunda captura, agora na lista de áreas: "Adicionar área", "Remover área 1", a descrição da área
  // e o anúncio ficam na mesma faixa da página.
  await extension.evaluate(report, `(() => {
    const question=document.querySelector('[data-lay-question="5.1.13"]');
    question.querySelector('.lay-marks-areas').scrollIntoView({behavior:'instant',block:'center'});
    return true;
  })()`);
  await extension.captureJourney('review-keyboard-map-marks-area', report, { captureBeyondViewport: false });

  // Só com a descrição obrigatória a resposta é registrada com o apontamento.
  await extension.evaluate(report, `(() => {
    const question=document.querySelector('[data-lay-question="5.1.13"]');
    const textarea=question.querySelector('.lay-finding textarea');
    textarea.value='Os cartões de serviço da seção Serviços abrem menus só com o mouse.';
    return true;
  })()`);
  await extension.click(report, '[data-lay-question="5.1.13"] .lay-confirm-fail');
  let salvo;
  try {
    salvo = await extension.waitForValue(report, `(() => ({
      status: document.querySelector('#review-status')?.textContent ?? '',
      marks: Boolean(document.querySelector('[data-review-marks]')),
    }))()`, value => value.marks === true, { timeoutMs: 120_000, intervalMs: 100 });
  } catch (error) {
    t.diagnostic(`a resposta com apontamento não chegou ao relatório: ${await extension.evaluate(report,
      `document.querySelector('#review-status')?.textContent ?? ''`)}`);
    throw error;
  }
  assert.match(salvo.status, /Resposta salva/u);
  const naTela = await extension.evaluate(report, `(() => {
    const block=document.querySelector('[data-review-marks]');
    return { text: block.closest('li').textContent,
      crop: block.querySelector('svg[data-marks-crop="1"]')?.getAttribute('viewBox') ?? '',
      outline: Boolean(block.querySelector('rect.marks-area-outline')),
      outlineStyle: (() => {
        const rect=block.querySelector('rect.marks-area-outline');
        if(!rect) return null;
        const style=getComputedStyle(rect);
        return { fill: style.fill, stroke: style.stroke };
      })(),
      image: block.querySelector('svg[data-marks-crop="1"] image')?.getAttribute('href')?.slice(0, 22) ?? '' };
  })()`);
  assert.match(naTela.text, /Itens apontados: /u);
  assert.match(naTela.text, /Áreas marcadas no mapa do teclado: 1\./u);
  assert.equal(naTela.outline, true, 'a área marcada precisa vir com contorno no recorte');
  // O retângulo do recorte é contorno vazio: sem `fill:none` ele viraria um retângulo preto por cima
  // da imagem — foi o que a validação visual pegou antes de a regra chegar à tela do relatório.
  assert.deepEqual(naTela.outlineStyle, { fill: 'none', stroke: 'rgb(176, 0, 32)' });
  assert.equal(naTela.image, 'data:image/png;base64,', 'o recorte usa a imagem guardada, sem gerar pixel novo');
  assert.match(naTela.crop, /^-?\d+ -?\d+ \d+ \d+$/u);
  // A ficha do apontamento vive dentro do expansor das conclusões humanas: sem abri-lo, o recorte não
  // ocupa espaço e a captura mostraria só o resumo.
  await extension.evaluate(report, `(() => {
    document.querySelector('[data-review-history]').open=true;
    document.querySelector('[data-review-marks]').scrollIntoView({behavior:'instant',block:'center'});
    return true;
  })()`);
  await extension.captureJourney('report-keyboard-map-marks', report, { captureBeyondViewport: false });

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

  // O apontamento da revisão guiada vai para o JSON e para o HTML entregue, com recorte da área.
  const apontada = audit.reviewDecisions.find(decision => decision.marks);
  assert.ok(apontada, 'a decisão apontada no mapa precisa chegar ao relatório técnico');
  assert.equal(apontada.itemId, '5.1.13');
  assert.equal(apontada.marks.version, 1);
  assert.equal(apontada.marks.areas.length, 1);
  assert.equal(apontada.marks.suspects.length, 1);
  assert.ok(map.suspects.some(suspect => suspect.number === apontada.marks.suspects[0]),
    'o número apontado precisa existir entre os itens sem caixa do mapa');
  const markedArea = apontada.marks.areas[0];
  assert.ok(markedArea.x + markedArea.width <= map.derivation.geometry.sourceCssSize.width + 1e-9);
  assert.ok(markedArea.y + markedArea.height <= map.derivation.geometry.sourceCssSize.height + 1e-9);
  const suposto = map.suspects.find(suspect => suspect.number === apontada.marks.suspects[0]);
  if (suposto.name) assert.ok(html.includes(`Itens apontados: ${suposto.name}`), 'o apontamento cita o nome visto na lista');

  assert.ok(html.includes('Áreas marcadas no mapa do teclado: 1.'));
  const crops = html.match(/<svg class="marks-crop"[^>]*>.*?<\/svg>/gsu) ?? [];
  assert.equal(crops.length, 1, 'o relatório entregue precisa mostrar o recorte da área marcada');
  assert.match(crops[0], /data-marks-crop="1"/u);
  assert.match(crops[0], /<rect class="marks-area-outline"/u);
  assert.equal(crops[0].includes(' style='), false, 'o recorte não usa estilo embutido (CSP do relatório)');
  assert.match(html, /\.marks-area-outline\{fill:none;stroke:#b00020/u, 'o HTML entregue precisa do contorno vazio');
  assert.match(html, /\.marks-area-outline\{stroke:#b00020;print-color-adjust:exact\}/u,
    'a impressão/PDF mantém o contorno da área marcada');
  const cropHref = crops[0].match(/href="([^"]+)"/u)?.[1];
  assert.ok(map.segments.some(segment => segment.dataUrl === cropHref),
    'o recorte reaproveita a imagem já guardada, sem gerar pixels novos');

  assert.ok(html.includes('data-keyboard-map-page="page-1"'));
  assert.ok(html.includes('data-keyboard-map-stop="1"'));
  assert.ok(html.includes('Cada caixa azul numerada é um lugar onde a tecla Tab para'));
  assert.ok(html.includes(map.hash));
  for (const label of CARD_LABELS) assert.ok(html.includes(label), `a lista de itens sem caixa precisa nomear "${label}"`);
  for (const output of [jsonBytes, html, ...loopback.cspReports]) {
    assert.equal(output.includes(privateMarker), false, 'uma saída pública textual contém o valor privado do campo');
  }
  assert.equal(loopback.cspReports.length, 0, `violações CSP: ${loopback.cspReports.join(' ')}`);
  assert.doesNotMatch(`${html}\n${loopback.cspReports.join('\n')}`, /unsafe-eval|EvalError/iu);
});

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
