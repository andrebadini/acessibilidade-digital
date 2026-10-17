import { consumeReadingLaunch, createReadingController } from './controller.js';
import { READING_CATEGORIES, READING_EXPLANATION, READING_PRIVACY, renderReadingHtml, renderReadingCsv } from './report-model.js';
import { READING_MAP_INTRO, READING_MAP_TITLE, READING_MAP_UNAVAILABLE, readingMapPlan } from './reading-map-plan.js';
import { TONE_LABELS, buildVerdict, entryFix, entryTone, laySummary, spokenAnnouncement, topIssues } from './plain-language.js';
import { TAB_READING_QUESTION, TAB_READING_READER_NOTICE } from '../core/report/tab-reading-text.js';
import { createSpeaker } from './speech.js';
import { createTabWalk } from './tab-walk.js';

const $ = selector => document.querySelector(selector);
let controller = null;
let report = null;
let working = false;
let ended = false;
let walk = null;
const speaker = createSpeaker();
const allButtons = () => document.querySelectorAll('button');
function status(message, error = false) { $('#status').textContent = message; $('#status').classList.toggle('error', error); }
function text(tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}
function setBusy(value) {
  working = value;
  updateControls();
}
function updateControls() {
  const walking = Boolean(walk?.running());
  for (const button of allButtons()) button.disabled = working || !report;
  $('#refresh').disabled = working || !controller || ended;
  if (ended && report) {
    for (const button of document.querySelectorAll('#observe,#clear,#refresh,[data-highlight],#walk-tab')) button.disabled = true;
  }
  if (walking || !report?.counts.tab) $('#walk-tab').disabled = true;
  $('#walk-stop').disabled = !walking;
  for (const button of document.querySelectorAll('[data-speak]')) button.disabled = working || !speaker.enabled();
}

async function run(action, message) {
  if (walk?.running()) await stopWalk();
  if (working) return;
  setBusy(true);
  try { await action(); status(message); }
  catch (error) {
    status(error?.code === 'PAGE_CHANGED'
      ? 'A página foi alterada. Use Atualizar inspeção para conferir o novo estado. Os dados anteriores permanecem no relatório até a atualização.'
      : error?.code === 'AUDIT_BUSY' ? 'Há uma auditoria ou outra operação em andamento. Aguarde a conclusão e tente novamente.'
        : 'Não foi possível concluir. A página pode ter mudado ou a sessão expirado. Volte ao painel da página desejada e abra uma nova conferência. O relatório já coletado continua disponível para exportação.', true);
  }
  finally { setBusy(false); }
}

function render() {
  $('#identity').textContent = `${report.origin} · Inspeção em ${new Date(report.generatedAt).toLocaleString('pt-BR')}`;
  $('#summary').replaceChildren(...[
    [report.counts.tab, 'na sequência estimada de Tab'], [report.counts.outsideTab, 'controles fora do Tab'],
    [report.counts.reading, 'elementos de leitura estrutural'], [report.counts.hidden, 'elementos ocultos'],
  ].map(([count, label]) => { const p = text('p', ''); p.append(text('strong', count), text('span', label)); return p; }));
  renderVerdict();
  $('#limitation-list').replaceChildren(...report.limitations.map(value => text('li', value)));
  if (report.counts.truncated) $('#limitation-list').append(text('li', 'O limite de inspeção foi atingido. O inventário não cobre todos os elementos.'));
  $('#results').replaceChildren(...Object.entries(READING_CATEGORIES).map(([category, label]) => {
    const section = document.createElement('section');
    section.className = 'reading-section'; section.dataset.category = category;
    const rows = report.entries.filter(entry => entry.category === category);
    const heading = text('h2', `${label} (${rows.length})`); heading.id = `heading-${category}`;
    section.setAttribute('aria-labelledby', heading.id); section.append(heading);
    if (category === 'outside-tab') section.append(text('p', 'Confira se estes controles podem ser usados por teclado. Alguns componentes usam setas ou recebem foco por script; a ausência no Tab precisa de análise do contexto.'));
    if (category === 'reading') section.append(text('p', 'Títulos, textos e imagens podem ser lidos no modo de navegação de um leitor de tela sem receber foco por Tab.'));
    if (category === 'hidden') section.append(text('p', 'Itens ocultos podem estar intencionalmente indisponíveis neste estado. Confira se algo que deveria estar disponível foi escondido.'));
    if (!rows.length) { section.append(text('p', 'Nenhum elemento registrado nesta categoria.')); return section; }
    // O aviso aparece uma vez por tabela, não em cada linha: repetir a mesma frase 40 vezes atrapalharia
    // quem lê a lista com leitor de tela.
    section.append(text('p', TAB_READING_READER_NOTICE, 'reading-notice'));
    const wrapper = document.createElement('div'); wrapper.className = 'table-scroll'; wrapper.tabIndex = 0; wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', label);
    const table = document.createElement('table');
    const thead = document.createElement('thead'); const headers = document.createElement('tr');
    for (const name of ['Imagem do elemento', 'Ordem / elemento', 'Nome e função', 'Anúncio estimado', 'Pergunta']) { const th = text('th', name); th.scope = 'col'; headers.append(th); }
    thead.append(headers); table.append(thead);
    const tbody = document.createElement('tbody');
    for (const entry of rows) {
      const tr = document.createElement('tr'); tr.dataset.entryId = entry.id;
      const shot = document.createElement('td');
      if (entry.image) {
        const img = document.createElement('img');
        img.className = 'entry-image'; img.src = entry.image;
        img.alt = `Captura do elemento ${entry.tag}${entry.tabOrder ? `, ordem ${entry.tabOrder}` : ''}`;
        shot.append(img);
      } else shot.append(text('p', 'Captura não disponível', 'image-missing'));
      const element = document.createElement('td'); element.append(text('p', `${entry.tabOrder ?? '—'} · ${entry.tag}`, 'entry-order'), text('code', entry.selector));
      if (entry.tabIndex !== null) element.append(text('p', `tabindex: ${entry.tabIndex}`, 'muted'));
      const name = document.createElement('td'); name.append(text('p', entry.name || 'Sem nome acessível', entry.name ? '' : 'no-name'), text('p', entry.role || 'Sem função identificada', 'muted'));
      const preview = document.createElement('td'); preview.append(text('p', entry.preview || 'Prévia não disponível'));
      if (entry.description) preview.append(text('p', `Descrição: ${entry.description}`, 'muted'));
      if (entry.states.length) preview.append(text('p', `Estados: ${entry.states.join(', ')}`, 'muted'));
      const tone = entryTone(entry);
      const review = document.createElement('td');
      review.append(text('p', TONE_LABELS[tone], `tone-chip tone-${tone}`), text('p', laySummary(entry), 'lay-summary'));
      // A pergunta desta página é a mesma da seção própria da verificação guiada; aqui ela aparece sem
      // botões, porque nesta página nada é registrado: quem responde faz isso na verificação guiada.
      review.append(text('p', TAB_READING_QUESTION, 'entry-question'));
      if (entry.reasons.length) review.append(text('p', entry.reasons.join('; '), 'entry-reasons'));
      const actions = document.createElement('div'); actions.className = 'entry-actions';
      const who = `${entry.name || entry.role || entry.tag}${entry.tabOrder ? `, posição ${entry.tabOrder}` : ''}`;
      if (category !== 'hidden') {
        const button = text('button', 'Destacar'); button.type = 'button'; button.dataset.highlight = entry.id;
        button.setAttribute('aria-label', `Destacar ${who}`);
        button.addEventListener('click', () => run(() => controller.highlight(entry.id), 'Elemento destacado na página. Escape remove o destaque.'));
        actions.append(button);
      }
      const listen = text('button', 'Ouvir', 'speak-button'); listen.type = 'button'; listen.dataset.speak = entry.id;
      listen.setAttribute('aria-label', `Ouvir o anúncio estimado de ${who}`);
      listen.addEventListener('click', () => { void speaker.speak(spokenAnnouncement(entry)); status(`Lendo em voz alta: ${spokenAnnouncement(entry)}`); });
      actions.append(listen);
      review.append(actions);
      tr.append(shot, element, name, preview, review); tbody.append(tr);
    }
    table.append(tbody); wrapper.append(table); section.append(wrapper); return section;
  }));
  renderPageMap();
  filter();
}


function renderVerdict() {
  const host = $('#verdict');
  const verdict = buildVerdict(report.entries);
  const box = document.createElement('div'); box.className = `verdict tone-${verdict.tone}`;
  const { counts } = verdict;
  box.append(text('p', verdict.phrase, 'verdict-phrase'),
    text('p', `${counts.problem} problema(s), ${counts.review} ponto(s) a revisar e ${counts.ok} sem ponto crítico. ${counts.info} elemento(s) oculto(s) ficam fora da conta.`),
    text('p', 'Semáforo: vermelho indica o que confunde ou bloqueia a leitura; âmbar, o que merece conferência; verde, o que parece bem. É uma estimativa para orientar a revisão humana.', 'muted'));
  const cards = topIssues(report.entries, 5).map(entry => {
    const tone = entryTone(entry);
    const fix = entryFix(entry);
    const card = document.createElement('article'); card.className = `issue-card tone-${tone}`;
    card.append(text('h3', `${entry.tabOrder ? `Tab ${entry.tabOrder}` : READING_CATEGORIES[entry.category]} · ${TONE_LABELS[tone]}`), text('p', laySummary(entry)));
    if (fix) {
      card.append(text('p', `O que está errado: ${fix.problem}`), text('p', `O que fazer: ${fix.action}`));
      const example = document.createElement('div'); example.className = 'before-after';
      example.append(text('p', fix.before), text('p', fix.after));
      card.append(example);
    }
    return card;
  });
  const children = [box];
  if (cards.length) {
    const heading = text('h3', 'O que corrigir primeiro'); heading.className = 'cards-title';
    children.push(heading, ...cards);
  }
  host.replaceChildren(...children);
}

function speechNote(message) { $('#speech-note').textContent = message; }

async function setSpeechMode(value) {
  if (value === 'on') {
    const voice = await speaker.prepare();
    if (speaker.setEnabled(Boolean(voice))) {
      speechNote(`Com áudio: voz “${voice.name}”, instalada neste computador. O texto não é enviado a serviços externos. Escape ou Parar interrompem a fala.`);
    } else {
      $('#speech-off').checked = true;
      speechNote('Nenhuma voz em português instalada neste computador foi encontrada. A conferência continua sem áudio: vozes on-line não são usadas porque enviariam o texto da página a um serviço externo.');
    }
  } else {
    speaker.setEnabled(false);
    speechNote('Sem áudio: o percurso mostra destaque e legenda na página, sem fala.');
  }
  document.body.classList.toggle('speech-on', speaker.enabled());
  updateControls();
}

const WALK_END_MESSAGES = Object.freeze({
  done: 'Percurso concluído. Todas as paradas de Tab foram mostradas.',
  stopped: 'Percurso interrompido.',
  escape: 'Percurso encerrado com Escape na página.',
  empty: 'Não há paradas de Tab nesta inspeção.',
});

function startWalk() {
  if (!report || !controller || ended || walk?.running() || working) return;
  let baseline = null;
  walk = createTabWalk({
    entries: report.entries,
    async highlight(entry) {
      const result = await controller.highlight(entry.id, baseline === null ? {} : { walkEscapes: baseline });
      if (baseline === null && Number.isSafeInteger(result?.escapes)) baseline = result.escapes;
    },
    speak: value => speaker.speak(value),
    cancelSpeech: () => speaker.cancel(),
    onStep(entry, index, total) { status(`Percurso ${index + 1} de ${total}: ${spokenAnnouncement(entry)}`); },
    onEnd(outcome, error) {
      updateControls();
      if (Object.hasOwn(WALK_END_MESSAGES, outcome)) { status(WALK_END_MESSAGES[outcome]); return; }
      status(outcome === 'page-changed' || error?.code === 'PAGE_CHANGED'
        ? 'A página foi alterada. Use Atualizar inspeção para conferir o novo estado.'
        : 'O percurso foi interrompido porque a página mudou ou a sessão expirou. O relatório continua disponível para exportação.', true);
    },
  });
  status(speaker.enabled() ? 'Percurso iniciado com áudio. Escape na página ou Parar percurso interrompem.' : 'Percurso iniciado sem áudio. Escape na página ou Parar percurso interrompem.');
  const done = walk.start();
  updateControls();
  return done;
}

async function stopWalk() {
  if (!walk) return;
  await walk.stop();
  updateControls();
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgElement(tag, attributes, content) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  if (content !== undefined) element.textContent = content;
  return element;
}

/** Mesmo desenho do mapa do relatório: contorno no elemento, etiqueta encostada e linha-guia. */
function pageMapOverlay(plan) {
  const svg = svgElement('svg', {
    class: 'map-overlay', viewBox: `0 0 ${plan.width} ${plan.height}`,
    width: plan.width, height: plan.height, role: 'img',
    'aria-label': `Mapa de leitura com ${plan.markers.length} elementos marcados. Os códigos estão listados ao lado.`,
  });
  // Como no relatório, os halos brancos de todos os contornos entram antes dos traços coloridos.
  for (const marker of plan.markers) {
    svg.append(svgElement('rect', {
      class: 'map-outline-halo', x: marker.outline.x, y: marker.outline.y,
      width: marker.outline.width, height: marker.outline.height, 'stroke-width': marker.strokeWidth + 4,
    }));
  }
  for (const marker of plan.markers) {
    if (marker.leader) {
      svg.append(svgElement('line', {
        class: 'map-leader', x1: marker.leader.x1, y1: marker.leader.y1,
        x2: marker.leader.x2, y2: marker.leader.y2, 'stroke-width': marker.strokeWidth,
      }));
    }
    svg.append(svgElement('rect', {
      class: `map-box tone-${marker.tone}`, x: marker.outline.x, y: marker.outline.y,
      width: marker.outline.width, height: marker.outline.height, 'stroke-width': marker.strokeWidth,
    }), svgElement('rect', {
      class: `map-badge${marker.overlapped ? ' map-badge-overlapped' : ''}`,
      x: marker.badge.x, y: marker.badge.y, width: marker.badge.width, height: marker.badge.height,
      rx: marker.badge.radius, 'stroke-width': marker.strokeWidth,
    }), svgElement('text', {
      class: 'map-badge-text', x: marker.badge.x + marker.badge.width / 2, y: marker.label.y,
      'font-size': marker.label.size,
    }, marker.code));
  }
  return svg;
}

function pageMapLegend(plan) {
  const box = document.createElement('div'); box.className = 'reader-map-legend';
  box.append(text('h3', 'Códigos e textos deste mapa'));
  if (!plan.legend.length) {
    box.append(text('p', 'Nenhum elemento da ordem de leitura foi marcado neste mapa.', 'reader-map-empty'));
    return box;
  }
  const list = document.createElement('ul'); list.className = 'reader-map-list';
  for (const item of plan.legend) {
    const line = document.createElement('li');
    line.id = `map-code-${item.code}`;
    const code = text('span', item.code, 'reader-map-code');
    const body = document.createElement('bdi'); body.textContent = item.text;
    line.append(code, document.createTextNode(' '), body);
    if (item.tabOrder) line.append(document.createTextNode(' '), text('span', `(Tab ${item.tabOrder})`, 'reader-map-tab'));
    list.append(line);
  }
  box.append(list);
  return box;
}

function renderPageMap() {
  const host = $('#page-map');
  if (!host) return;
  host.replaceChildren();
  const plan = readingMapPlan(report ?? {});
  if (!plan) { host.append(text('p', READING_MAP_UNAVAILABLE, 'image-missing')); return; }
  host.append(text('h2', READING_MAP_TITLE), text('p', READING_MAP_INTRO));
  for (const note of plan.notes) host.append(text('p', note, 'map-note'));
  const columns = document.createElement('div'); columns.className = 'reader-map-columns';
  const frame = document.createElement('figure'); frame.className = 'map-frame';
  const base = document.createElement('img'); base.className = 'map-base'; base.src = report.pageMap;
  base.alt = `Captura da página inspecionada com as caixas do mapa de leitura, ${plan.markers.length} elemento(s) marcado(s)`;
  // Sem a medida da captura não há escala para converter a caixa: a imagem fica, o desenho não.
  if (plan.width > 0) { base.width = plan.width; base.height = plan.height; }
  frame.append(base);
  if (plan.width > 0) frame.append(pageMapOverlay(plan));
  columns.append(frame);
  columns.append(pageMapLegend(plan));
  host.append(columns);
}

function filter() {
  const value = $('#category').value;
  for (const section of document.querySelectorAll('[data-category]')) section.hidden = value !== 'all' && value !== section.dataset.category;
}
function download(format) {
  if (!report) return;
  const content = format === 'html' ? renderReadingHtml(report) : format === 'csv' ? renderReadingCsv(report) : JSON.stringify(report, null, 2);
  const types = { html: 'text/html;charset=utf-8', csv: 'text/csv;charset=utf-8', json: 'application/json;charset=utf-8' };
  const url = URL.createObjectURL(new Blob([content], { type: types[format] }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `audita-leitura-tab-${report.generatedAt.replace(/[:.]/gu, '-')}.${format}`;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
  status('Download solicitado. O arquivo inclui todos os elementos registrados.');
}

$('#explanation').textContent = READING_EXPLANATION;
$('#privacy').textContent = READING_PRIVACY;
$('#category').addEventListener('change', filter);
$('#observe').addEventListener('click', () => run(() => controller.observe(), 'Acompanhamento ativado. Use Tab na página; Escape encerra os destaques.'));
$('#clear').addEventListener('click', () => run(() => controller.clear(), 'Destaques encerrados. O relatório permanece disponível.'));
$('#refresh').addEventListener('click', () => run(async () => { report = await controller.collect(); render(); }, 'Inspeção atualizada. Confira os elementos registrados.'));
for (const format of ['html', 'csv', 'json']) $(`#export-${format}`).addEventListener('click', () => download(format));
$('#print').addEventListener('click', () => window.print());
$('#walk-tab').addEventListener('click', () => { void startWalk(); });
$('#walk-stop').addEventListener('click', () => { void stopWalk(); });
for (const input of document.querySelectorAll('input[name="speech"]')) input.addEventListener('change', () => { if (input.checked) void setSpeechMode(input.value); });
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (walk?.running()) void stopWalk();
  speaker.cancel();
});
window.addEventListener('pagehide', () => {
  void walk?.stop();
  speaker.cancel();
  if (controller) void controller.clear().catch(() => {});
});
void setSpeechMode('off');

async function initialize() {
  try {
    const source = await consumeReadingLaunch(chrome, location.href);
    history.replaceState(null, '', chrome.runtime.getURL('src/reader/index.html'));
    controller = createReadingController(chrome, source);
    await run(async () => { report = await controller.collect(); render(); }, 'Inspeção concluída. Confira a sequência e os controles fora do Tab.');
    setTimeout(() => {
      ended = true;
      void walk?.stop();
      void controller.clear().catch(() => {});
      setBusy(false);
      status('A sessão de destaque expirou. O relatório coletado continua disponível para exportação. Abra nova conferência para interagir com a página.');
    }, 10 * 60 * 1000);
  } catch {
    status('Abra a extensão na página que deseja conferir e escolha “Conferir leitura por Tab”. Esta página precisa ser aberta pelo painel.', true);
    $('#identity').textContent = 'Nenhuma página associada.';
  }
}
void initialize();
