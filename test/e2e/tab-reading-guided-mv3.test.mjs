/**
 * A seção "Leitura por Tab" da verificação guiada, num Chrome de verdade.
 *
 * O teste percorre o caminho completo: audita a fixture com captura integral (é a captura integral que
 * produz o mapa do teclado e, com ele, o recorte de cada parada), abre o relatório, responde três pontos
 * (Sim pelo teclado, Não com o que deveria dizer, Não sei) e exporta o documento entregue para conferir
 * a constatação única com os dois pontos nomeados.
 *
 * A pergunta é a mesma em todas as paradas: o que se prova aqui é que a seção mostra, lado a lado, o
 * recorte do elemento, o anúncio estimado e a resposta — e que a constatação sai uma vez só.
 */
import assert from 'node:assert/strict';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  command, evaluate, launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer, waitForValue,
} from './support/real-chrome.mjs';

/**
 * Enter de verdade num elemento com o foco: o Chrome só dispara a ativação do botão quando o evento
 * chega com o texto da tecla (`text: '\r'`), como o próprio Puppeteer faz. Sem isso o evento não sai do
 * `rawKeyDown` e o botão não é acionado.
 */
async function pressEnter(target) {
  const params = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await command(target, 'Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...params });
  await command(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}

const documentSource = await readFile(new URL('./fixtures/tab-reading-guided.html', import.meta.url), 'utf8');
const NOTA_LINK = 'Saiba mais, link';
const NOTA_BOTAO = 'Botão Enviar';

/** O documento entregue (HTML) é lido do diretório real de downloads, sem atalho pelo armazenamento. */
async function waitForDeliveredHtml(extension) {
  const deadline = Date.now() + 180_000;
  do {
    const names = await readdir(extension.downloadDirectory).catch(() => []);
    if (!names.some(name => name.endsWith('.crdownload'))) {
      const html = names.find(name => name.endsWith('.html'));
      if (html) {
        const bytes = await readFile(join(extension.downloadDirectory, html));
        if (bytes.length > 0) return bytes.toString('utf8');
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  assert.fail('a exportação precisa entregar o documento HTML no diretório de downloads');
}

test('a leitura por Tab na verificação guiada grava cada resposta e fecha uma constatação só', { timeout: 420_000 }, async t => {
  const chromeBinary = resolveRealChromeTestBinary();
  assert.ok(chromeBinary, 'AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório para o E2E real da leitura por Tab.');
  const fixture = await startFixtureServer(t, new Map([
    ['/tab-reading-guided', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: documentSource }],
  ]));
  const fixtureUrl = `${fixture.origin}/tab-reading-guided`;
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: fixtureUrl, chromeBinary, expectedMajor: 152,
    downloadMode: 'profile',
    ...(process.env.AUDITA_E2E_ARTIFACT_ROOT ? {
      qaDirectory: join(process.env.AUDITA_E2E_ARTIFACT_ROOT, 'qa'),
      downloadDirectory: join(process.env.AUDITA_E2E_ARTIFACT_ROOT, 'downloads'),
    } : {}),
    viewport: { width: 1280, height: 900 },
  });

  const panel = await extension.openSidePanelFromAction();
  await waitForValue(panel, `document.querySelector('[data-screen]')?.dataset.screen`, value => value === 'initial');
  await extension.click(panel, 'button[data-focus-id="open-url-form"][data-intent="OPEN_URL_FORM"]');
  await extension.click(panel, '[name="capture-mode"][value="full-evidence"]');
  await extension.evaluate(panel, `(() => {
    const input=document.querySelector('#audit-url, input[name="audit-url"]');
    input.value=${JSON.stringify(fixtureUrl)};
    input.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()`);
  await extension.click(panel, '[data-action="start-url-audit"]');
  const terminal = await waitForValue(panel, `(() => ({
    screen:document.querySelector('[data-screen]')?.dataset.screen??null,
    confirm:Boolean(document.querySelector('[data-action="confirm-pixel-capture"]')),
    auditId:document.querySelector('[data-screen="result"]')?.dataset.auditId??null,
  }))()`, value => ['result', 'unavailable'].includes(value?.screen) || value?.confirm === true, {
    timeoutMs: 180_000, intervalMs: 50,
  });
  t.diagnostic(`painel: ${JSON.stringify(terminal)}`);
  assert.equal(terminal.confirm, false, 'a auditoria por URL não pede confirmação de pixels');
  assert.equal(terminal.screen, 'result', 'a auditoria precisa concluir');
  const auditId = terminal.auditId;
  assert.match(auditId ?? '', /^[A-Za-z0-9._:-]{1,160}$/u);

  await extension.click(panel, '[data-action="open-report"], button[data-focus-id="open-report"]');
  const report = await extension.waitForReport({ auditId });
  await waitForValue(report, `document.querySelectorAll('[data-tab-reading-row]').length`, value => value === 4,
    { timeoutMs: 90_000, intervalMs: 50 });

  // A seção: título, uma frase de explicação, progresso em números e as cinco colunas.
  const head = await evaluate(report, `(() => {
    const section=document.querySelector('#lay-tab-reading');
    const cell=(row,column) => row.querySelector('[data-tab-cell="'+column+'"]')?.innerText.replace(/\\s+/gu,' ').trim() ?? '';
    const rows=[...section.querySelectorAll('[data-tab-reading-row]')];
    return {
      ids: rows.map(row => row.getAttribute('data-tab-reading-row')),
      title: section.querySelector('h3')?.textContent ?? '',
      intro: section.querySelector('.lay-meta')?.textContent ?? '',
      labelledby: section.getAttribute('aria-labelledby'),
      headers: [...section.querySelectorAll('thead th')].map(header => header.textContent),
      progress: section.querySelector('[data-tab-reading-progress]')?.textContent ?? '',
      cells: rows.map(row => ({
        order: row.querySelector('.lay-tab-order')?.textContent ?? '',
        selector: row.querySelector('.lay-tab-selector')?.textContent ?? '',
        name: row.querySelector('[data-tab-cell="Nome e função"] p')?.textContent ?? '',
        announcement: row.querySelector('[data-tab-cell="Anúncio estimado"] > p')?.textContent ?? '',
        question: cell(row,'Pergunta'),
      })),
      bulkDisabled: section.querySelector('.lay-tab-bulk')?.disabled ?? null,
    };
  })()`);
  assert.equal(head.title, 'Leitura por Tab — o que o leitor de tela fala');
  assert.match(head.intro, /O leitor de tela fala o nome e a função de cada item onde a tecla Tab para/u);
  assert.equal(head.labelledby, 'lay-tab-reading-title');
  assert.deepEqual(head.headers, ['Imagem do elemento', 'Ordem / elemento', 'Nome e função', 'Anúncio estimado', 'Pergunta']);
  assert.equal(head.progress, '0 de 4 conferidos');
  assert.equal(head.ids.length, 4, 'uma linha por parada de Tab da fixture');
  const [linkRow, namedRow, namelessRow, fieldRow] = head.ids;
  assert.deepEqual(head.cells.map(entry => entry.order),
    ['Tab 1 · link', 'Tab 2 · botão', 'Tab 3 · botão', 'Tab 4 · campo de texto'],
    'a ordem da sequência e o tipo de cada elemento');
  assert.deepEqual(head.cells.map(entry => entry.selector), ['a#tab-link', 'button#tab-named', 'button#tab-nameless', 'input#tab-field']);
  assert.deepEqual(head.cells.map(entry => entry.name),
    ['“Pesquisar”', '“Buscar”', 'Sem nome acessível', '“Número do protocolo”']);
  assert.match(head.cells[0].announcement, /Pesquisar, link/u);
  assert.match(head.cells[2].announcement, /botão/u, 'sem nome, o anúncio fica só na função');
  assert.ok(head.cells.every(entry => entry.question.includes('O que o leitor de tela fala corresponde a este elemento')), 'a mesma pergunta em todos os pontos');
  assert.equal(head.bulkDisabled, false, 'há pontos pendentes no bloco');
  // O rótulo que nomeia a parada é o do elemento, e é ele que os botões e a constatação usam.
  const labels = ['link “Pesquisar”', 'botão “Buscar”', 'botão sem nome', 'campo de texto “Número do protocolo”']
    .map((label, index) => `Tab ${index + 1}, ${label}`);

  // O recorte de cada ponto sai da captura integral, contornado, e o botão de ouvir nomeia o elemento.
  const crops = await evaluate(report, `(() => {
    const section=document.querySelector('#lay-tab-reading');
    const cells=[...section.querySelectorAll('[data-tab-cell="Imagem do elemento"]')];
    return {
      images: cells.map(cell => Boolean(cell.querySelector('svg'))),
      // Cada PNG entra uma vez no documento (o bloco de definições do corpo) e os recortes o referenciam
      // por <use>: é essa referência que prova que a imagem guardada está sendo desenhada.
      loaded: [...section.querySelectorAll('svg use')].map(use => {
        const href=use.getAttribute('href') ?? '';
        const id=href.startsWith('#') ? href.slice(1) : '';
        const image=id ? document.querySelector('.evidence-definitions image[id="'+id+'"]') : null;
        return Boolean(image && (image.getAttribute('href') ?? '').startsWith('data:image/png'));
      }),
      definitions: document.querySelectorAll('.evidence-definitions svg, svg.evidence-definitions').length,
      marked: cells.map(cell => Boolean(cell.querySelector('.evidence-highlight--target'))),
      aria: cells.map(cell => cell.querySelector('svg')?.getAttribute('aria-label') ?? ''),
      captions: cells.map(cell => cell.querySelector('figcaption')?.textContent ?? ''),
      listen: [...section.querySelectorAll('.lay-tab-listen')].map(button => button.getAttribute('aria-label')),
      answerLabels: [...section.querySelectorAll('[data-tab-reading-row]')].map(row =>
        [...row.querySelectorAll('[data-tab-reading-answer]')].map(button => button.getAttribute('aria-label'))),
    };
  })()`);
  assert.deepEqual(crops.images, [true, true, true, true], 'os quatro pontos mostram o recorte do elemento');
  assert.deepEqual(crops.loaded, [true, true, true, true], 'cada recorte aponta para a imagem PNG guardada');
  assert.equal(crops.definitions, 1, 'a captura entra uma vez no documento, e não uma vez por linha');
  assert.deepEqual(crops.marked, [true, true, true, true], 'o contorno vermelho marca o elemento na imagem');
  for (const [index, aria] of crops.aria.entries()) {
    assert.match(aria, /^Recorte da captura (?:da página inteira, na região do elemento|do elemento) desta pergunta\. Contorno vermelho: o elemento desta pergunta\./u, `ponto ${index + 1}`);
  }
  for (const caption of crops.captions) assert.match(caption, /Contorno vermelho: o elemento desta pergunta\./u);
  assert.deepEqual(crops.listen, labels.map(label => `Ouvir o anúncio estimado de ${label}`),
    'o botão de ouvir nomeia o ponto e o elemento');
  // Cada botão de resposta nomeia o elemento: quem usa leitor de tela não ouve três "Sim" soltos.
  assert.deepEqual(crops.answerLabels,
    labels.map(label => ['Sim', 'Não', 'Não sei'].map(choice => `${choice} — ${label}`)));

  await extension.evaluate(report, `document.querySelector('#lay-tab-reading').scrollIntoView({ behavior:'instant', block:'start' })`);
  await extension.captureJourney('report-tab-reading-start', report, { captureBeyondViewport: false });

  // Sem o nome de quem avalia, a revisão não grava: é o mesmo campo usado por todos os cartões.
  await evaluate(report, `(() => {
    const field=document.querySelector('#review-evaluator');
    field.value='Fiscal de teste';
    field.dispatchEvent(new Event('input',{bubbles:true}));
    return field.value;
  })()`);

  // Ponto 1 (link cujo anúncio não é o texto visível): "Não" abre o campo do que deveria dizer.
  await extension.click(report, `[data-tab-reading-row="${linkRow}"] [data-tab-reading-answer="não conforme"]`);
  const field = await waitForValue(report, `(() => {
    const row=document.querySelector('[data-tab-reading-row="${linkRow}"]');
    const textarea=row?.querySelector('textarea');
    return textarea ? { label: textarea.getAttribute('aria-label'), hidden: Boolean(textarea.closest('[hidden]')) } : null;
  })()`, value => Boolean(value), { timeoutMs: 10_000, intervalMs: 25 });
  assert.match(field.label, /^O que deveria dizer no lugar do anúncio atual — Tab 1, /u);
  assert.equal(field.hidden, false);
  await extension.evaluate(report, `(() => {
    const textarea=document.querySelector('[data-tab-reading-row="${linkRow}"] textarea');
    textarea.value=${JSON.stringify(NOTA_LINK)};
    textarea.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()`);
  await extension.click(report, `[data-tab-reading-row="${linkRow}"] .lay-confirm-fail`);
  const answeredLink = await waitForValue(report, `(() => {
    const row=document.querySelector('[data-tab-reading-row="${linkRow}"]');
    return row ? { state: row.getAttribute('data-tab-reading-state'), text: row.innerText.replace(/\\s+/gu,' ').trim() } : null;
  })()`, value => value?.state === 'nao', { timeoutMs: 30_000, intervalMs: 50 });
  assert.match(answeredLink.text, /Resposta registrada: Não conforme/u);
  assert.match(answeredLink.text, new RegExp(`O que deveria dizer: ${NOTA_LINK}`, 'u'));
  assert.equal(await evaluate(report, `document.querySelector('[data-tab-reading-progress]')?.textContent ?? ''`), '1 de 4 conferidos');

  // Ponto 2 (botão "Buscar"): o caminho de teclado — foco no botão e Enter gravam a resposta.
  const focused = await evaluate(report, `(() => {
    const button=document.querySelector('[data-tab-reading-row="${namedRow}"] [data-tab-reading-answer="conforme"]');
    button.focus();
    return document.activeElement === button;
  })()`);
  assert.equal(focused, true, 'o botão de resposta recebe foco pelo teclado');
  await pressEnter(report);
  await waitForValue(report, `document.querySelector('[data-tab-reading-progress]')?.textContent ?? ''`, value => value === '2 de 4 conferidos', { timeoutMs: 30_000, intervalMs: 50 })
    .catch(async error => {
      t.diagnostic(`estado depois do Enter: ${JSON.stringify(await evaluate(report, `({
        progress: document.querySelector('[data-tab-reading-progress]')?.textContent ?? '',
        status: document.querySelector('#status, [role="status"]')?.textContent ?? '',
        active: document.activeElement?.getAttribute?.('data-tab-reading-answer') ?? document.activeElement?.tagName ?? '',
      })`))}`);
      throw error;
    });
  // Depois de responder, o foco vai para o primeiro botão do próximo ponto pendente.
  const focusAfter = await evaluate(report, `(() => {
    const active=document.activeElement;
    return { answer: active?.getAttribute?.('data-tab-reading-answer') ?? null,
      row: active?.closest?.('[data-tab-reading-row]')?.getAttribute('data-tab-reading-row') ?? null };
  })()`);
  assert.deepEqual(focusAfter, { answer: 'conforme', row: namelessRow },
    'depois de responder, o foco abre no primeiro botão do próximo ponto pendente');

  // Ponto 3 (botão sem nome nenhum): a pista automática do nome aparece, e "Não" grava o que deveria dizer.
  const hint = await evaluate(report, `document.querySelector('[data-tab-reading-row="${namelessRow}"] [data-tab-cell="Pergunta"]')?.innerText.replace(/\\s+/gu,' ').trim() ?? ''`);
  assert.match(hint, /Pista da extensão: O elemento não tem nome que o leitor de tela possa anunciar\./u);
  await extension.click(report, `[data-tab-reading-row="${namelessRow}"] [data-tab-reading-answer="não conforme"]`);
  await waitForValue(report, `Boolean(document.querySelector('[data-tab-reading-row="${namelessRow}"] textarea'))`, Boolean, { timeoutMs: 10_000, intervalMs: 25 });
  await extension.evaluate(report, `(() => {
    const textarea=document.querySelector('[data-tab-reading-row="${namelessRow}"] textarea');
    textarea.value=${JSON.stringify(NOTA_BOTAO)};
    textarea.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()`);
  await extension.click(report, `[data-tab-reading-row="${namelessRow}"] .lay-confirm-fail`);
  await waitForValue(report, `document.querySelector('[data-tab-reading-row="${namelessRow}"]')?.getAttribute('data-tab-reading-state') ?? null`, value => value === 'nao', { timeoutMs: 30_000, intervalMs: 50 });

  // Ponto 4 (caixa de texto): "Não sei" também é resposta registrada, com estado próprio na linha.
  await extension.click(report, `[data-tab-reading-row="${fieldRow}"] [data-tab-reading-answer="não foi possível determinar"]`);
  await waitForValue(report, `document.querySelector('[data-tab-reading-row="${fieldRow}"]')?.getAttribute('data-tab-reading-state') ?? null`, value => value === 'nao-sei', { timeoutMs: 30_000, intervalMs: 50 });
  await waitForValue(report, `document.querySelector('[data-tab-reading-progress]')?.textContent ?? ''`, value => value === '4 de 4 conferidos', { timeoutMs: 30_000, intervalMs: 50 });
  const answered = await evaluate(report, `(() => {
    const section=document.querySelector('#lay-tab-reading');
    return {
      states: [...section.querySelectorAll('[data-tab-reading-row]')].map(row => row.getAttribute('data-tab-reading-state')),
      bulkDisabled: section.querySelector('.lay-tab-bulk')?.disabled ?? null,
      bulkTitle: section.querySelector('.lay-tab-bulk')?.title ?? null,
      notes: section.innerText.includes('O que deveria dizer: ${NOTA_LINK}') && section.innerText.includes('O que deveria dizer: ${NOTA_BOTAO}'),
      dialogOpen: document.querySelector('#lay-tab-bulk-dialog')?.open ?? false,
    };
  })()`);
  assert.deepEqual(answered.states, ['nao', 'sim', 'nao', 'nao-sei'],
    'cada linha respondida carrega o próprio estado de cor');
  assert.equal(answered.notes, true, 'as duas respostas "Não" guardam o que deveria ser dito');
  assert.equal(answered.bulkDisabled, true, 'sem pendentes no bloco, o atalho de bloco fica desabilitado');
  assert.equal(answered.bulkTitle, 'Nenhum ponto pendente nas linhas mostradas.');
  assert.equal(answered.dialogOpen, false, 'a caixa de confirmação não abre sozinha');
  await extension.evaluate(report, `document.querySelector('#lay-tab-reading').scrollIntoView({ behavior:'instant', block:'start' })`);
  await extension.captureJourney('report-tab-reading-answered', report, { captureBeyondViewport: false });

  // Exportação: o documento entregue traz a MESMA tabela de respostas e a constatação única no fim.
  await extension.click(report, 'button[data-report-export]');
  const delivered = await waitForDeliveredHtml(extension);
  assert.match(delivered, /Leitura por Tab — o que o leitor de tela fala/u);
  assert.match(delivered, /4 de 4 conferidos/u);
  assert.equal((delivered.match(/data-tab-reading-row=/gu) ?? []).length, 4, 'as quatro linhas respondidas aparecem no documento entregue');
  // No documento entregue o que a pessoa escreveu sai entre aspas, como citação.
  assert.match(delivered, new RegExp(`O que deveria dizer: “${NOTA_LINK}”`, 'u'));
  assert.match(delivered, new RegExp(`O que deveria dizer: “${NOTA_BOTAO}”`, 'u'));
  assert.equal((delivered.match(/data-report-tab-reading-finding/gu) ?? []).length, 1, 'uma constatação única');
  const start = delivered.indexOf('<p data-report-tab-reading-finding>');
  assert.notEqual(start, -1, 'a constatação do tema precisa existir no documento entregue');
  const finding = delivered.slice(start, delivered.indexOf('</p>', start));
  assert.match(finding, /Em 2 pontos da sequência de Tab/u);
  assert.match(finding, /Tab 1, /u);
  assert.match(finding, /Tab 3, /u);
  assert.doesNotMatch(finding, /Tab 2, |Tab 4, /u, 'os pontos que não são problema ficam fora da constatação');
  assert.doesNotMatch(finding, /ABNT NBR 17225:2025|Evidência:/u,
    'o item normativo e a evidência são citados uma vez, no quadro de constatações');
  assert.match(delivered, /data-report-tab-reading/u, 'a seção existe no documento entregue');
  assert.equal(await evaluate(extension.startPage.page, 'location.href'), fixtureUrl, 'a página auditada não foi navegada');
});
