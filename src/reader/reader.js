import { consumeReadingLaunch, createReadingController } from './controller.js';
import { READING_CATEGORIES, READING_EXPLANATION, READING_PRIVACY, renderReadingHtml, renderReadingCsv } from './report-model.js';

const $ = selector => document.querySelector(selector);
let controller = null;
let report = null;
let working = false;
let ended = false;
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
  for (const button of allButtons()) button.disabled = value || !report;
  $('#refresh').disabled = value || !controller || ended;
  if (ended && report) {
    for (const button of document.querySelectorAll('#observe,#clear,#refresh,[data-highlight]')) button.disabled = true;
  }
}

async function run(action, message) {
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
    const wrapper = document.createElement('div'); wrapper.className = 'table-scroll'; wrapper.tabIndex = 0; wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', label);
    const table = document.createElement('table');
    const thead = document.createElement('thead'); const headers = document.createElement('tr');
    for (const name of ['Imagem do elemento', 'Ordem / elemento', 'Nome e função', 'Anúncio estimado', 'O que conferir']) { const th = text('th', name); th.scope = 'col'; headers.append(th); }
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
      const review = document.createElement('td'); review.append(text('p', entry.reasons.join('; ') || 'Confira se o anúncio representa o elemento.', 'entry-reasons'));
      if (category !== 'hidden') {
        const button = text('button', 'Destacar'); button.type = 'button'; button.dataset.highlight = entry.id;
        button.setAttribute('aria-label', `Destacar ${entry.name || entry.role || entry.tag}${entry.tabOrder ? `, posição ${entry.tabOrder}` : ''}`);
        button.addEventListener('click', () => run(() => controller.highlight(entry.id), 'Elemento destacado na página. Escape remove o destaque.'));
        const actions = document.createElement('div'); actions.className = 'entry-actions'; actions.append(button); review.append(actions);
      }
      tr.append(shot, element, name, preview, review); tbody.append(tr);
    }
    table.append(tbody); wrapper.append(table); section.append(wrapper); return section;
  }));
  renderPageMap();
  filter();
}

function renderPageMap() {
  const host = $('#page-map');
  if (!host) return;
  host.replaceChildren();
  if (!report?.pageMap) {
    host.append(text('p', 'Captura da página inteira não disponível nesta inspeção.', 'image-missing'));
    return;
  }
  host.append(text('h2', 'Mapa de leitura da página'));
  host.append(text('p', 'Cada caixa indica o trecho da página e o texto que seria lido, precedido do número de ordem de leitura (Tab) ou da marca de leitura estrutural (L). Serve para localizar o elemento sem ler o código.'));
  const frame = document.createElement('div'); frame.className = 'map-frame';
  const base = document.createElement('img'); base.className = 'map-base'; base.src = report.pageMap;
  base.alt = 'Captura da página inspecionada com caixas de anúncio';
  frame.append(base);
  const mapped = report.entries.filter(entry => ['tab', 'reading'].includes(entry.category) && entry.bounds);
  const width = Math.max(...mapped.map(entry => entry.bounds.x + entry.bounds.width), 800);
  const height = Math.max(...mapped.map(entry => entry.bounds.y + entry.bounds.height), 600);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'map-overlay');
  svg.setAttribute('viewBox', `0 0 ${Math.round(width)} ${Math.round(height)}`);
  svg.setAttribute('width', String(Math.round(width)));
  svg.setAttribute('height', String(Math.round(height)));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Mapa de leitura com ${mapped.length} elementos anotados`);
  for (const entry of mapped) {
    const order = entry.tabOrder ?? `L${mapped.indexOf(entry) + 1}`;
    const label = (entry.preview || entry.name || 'Sem texto acessível').replace(/\s+/gu, ' ').slice(0, 180);
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const box = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    box.setAttribute('class', 'map-box');
    for (const [key, value] of [['x', entry.bounds.x], ['y', entry.bounds.y], ['width', entry.bounds.width], ['height', entry.bounds.height]]) box.setAttribute(key, String(value));
    const boxWidth = Math.min(360, Math.max(120, label.length * 6.4 + 36));
    const boxHeight = 34;
    const x = Math.max(0, Math.min(entry.bounds.x, width - boxWidth));
    const y = Math.max(0, entry.bounds.y - boxHeight - 4);
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('class', 'map-label-bg');
    for (const [key, value] of [['x', x], ['y', y], ['width', boxWidth], ['height', boxHeight]]) bg.setAttribute(key, String(value));
    bg.setAttribute('rx', '4');
    const num = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    num.setAttribute('class', 'map-label-num'); num.setAttribute('x', String(x + 8)); num.setAttribute('y', String(y + 21));
    num.textContent = `${order}.`;
    const body = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    body.setAttribute('class', 'map-label'); body.setAttribute('x', String(x + 8 + String(order).length * 8 + 10)); body.setAttribute('y', String(y + 21));
    body.textContent = label;
    group.append(box, bg, num, body); svg.append(group);
  }
  frame.append(svg); host.append(frame);
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
window.addEventListener('pagehide', () => { if (controller) void controller.clear().catch(() => {}); });

async function initialize() {
  try {
    const source = await consumeReadingLaunch(chrome, location.href);
    history.replaceState(null, '', chrome.runtime.getURL('src/reader/index.html'));
    controller = createReadingController(chrome, source);
    await run(async () => { report = await controller.collect(); render(); }, 'Inspeção concluída. Confira a sequência e os controles fora do Tab.');
    setTimeout(() => {
      ended = true;
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
