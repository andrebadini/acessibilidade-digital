import { redactSensitiveText } from '../core/privacy.js';
import { TAB_READING_QUESTION, TAB_READING_READER_NOTICE } from '../core/report/tab-reading-text.js';
import { READING_REASON_TEXT } from './reading-reasons.js';
import { entryTone, entryFix, laySummary, buildVerdict, topIssues, TONE_LABELS } from './plain-language.js';
import {
  READING_MAP_INTRO, READING_MAP_TITLE, READING_MAP_UNAVAILABLE, readingMapPlan, validPageMapGeometry,
} from './reading-map-plan.js';

export const READING_CATEGORIES = Object.freeze({
  tab: 'Sequência estimada de Tab',
  'outside-tab': 'Fora da sequência de Tab',
  reading: 'Conteúdo estrutural',
  hidden: 'Elementos ocultos',
});
export const READING_EXPLANATION = 'Esta é uma estimativa do anúncio, não uma transcrição de NVDA, JAWS ou VoiceOver. Tab percorre controles; títulos, parágrafos e imagens normalmente são lidos com outros comandos do leitor de tela. Estar fora do Tab não significa, por si só, estar inacessível.';
export const READING_PRIVACY = 'Valores digitados e conteúdo marcado como privado são omitidos. As capturas de tela dos elementos e da página inteira podem conter dados pessoais visíveis no desenho; revise antes de compartilhar. Outros textos da página podem conter dados pessoais; revise antes de compartilhar. O relatório fica apenas nesta aba até você exportá-lo. A inspeção é complementar e não altera as conclusões da auditoria ABNT/WCAG.';
const ENTRY_KEYS = ['id', 'selector', 'tag', 'role', 'name', 'description', 'states', 'preview', 'tabIndex', 'tabOrder', 'category', 'reasons', 'bounds'];
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
function explained(value) { return Object.hasOwn(READING_REASON_TEXT, value) ? READING_REASON_TEXT[value] : safeText(value); }

function fail() { throw new TypeError('Inventário de leitura inválido. Refaça a inspeção.'); }
function safeBounds(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key])) ||
    value.width <= 0 || value.height <= 0 || Math.abs(value.x) > 2_000_000 || Math.abs(value.y) > 2_000_000 ||
    value.width > 2_000_000 || value.height > 2_000_000) fail();
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}
function safeText(value, maximum = 2048) {
  if (typeof value !== 'string' || value.length > maximum * 2) fail();
  return redactSensitiveText(value).replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu,
    char => `⟦U+${char.codePointAt(0).toString(16).toUpperCase()}⟧`).slice(0, maximum);
}
function strings(value, maximum = 32) {
  if (!Array.isArray(value) || value.length > maximum) fail();
  return value.map(item => safeText(item));
}

export function createReadingReport(raw, { origin = '', generatedAt = new Date().toISOString() } = {}) {
  if (!raw || raw.version !== 1 || !ID.test(raw.sessionId ?? '') || !Array.isArray(raw.entries) || raw.entries.length > 1000 ||
    !Number.isFinite(Date.parse(generatedAt))) fail();
  if (origin && (!/^https?:\/\//u.test(origin) || new URL(origin).origin !== origin)) fail();
  const ids = new Set();
  const orders = [];
  const entries = raw.entries.map(entry => {
    if (!entry || Object.keys(entry).length !== ENTRY_KEYS.length || Object.keys(entry).some(key => !ENTRY_KEYS.includes(key)) ||
      !ID.test(entry.id ?? '') || ids.has(entry.id) || !Object.hasOwn(READING_CATEGORIES, entry.category) ||
      entry.tabIndex !== null && (!Number.isSafeInteger(entry.tabIndex) || Math.abs(entry.tabIndex) > 2147483648) ||
      entry.tabOrder !== null && (!Number.isSafeInteger(entry.tabOrder) || entry.tabOrder < 1 || entry.tabOrder > 1000) ||
      (entry.category === 'tab') !== (entry.tabOrder !== null)) fail();
    ids.add(entry.id);
    if (entry.tabOrder !== null) orders.push(entry.tabOrder);
    return { id: entry.id, selector: safeText(entry.selector), tag: safeText(entry.tag, 64), role: safeText(entry.role, 128),
      name: safeText(entry.name), description: safeText(entry.description), states: strings(entry.states), preview: safeText(entry.preview),
      tabIndex: entry.tabIndex, tabOrder: entry.tabOrder, category: entry.category, reasons: strings(entry.reasons).map(explained),
      bounds: safeBounds(entry.bounds) };
  });
  orders.sort((a, b) => a - b);
  if (orders.some((order, index) => order !== index + 1)) fail();
  const categories = Object.keys(READING_CATEGORIES);
  entries.sort((a, b) => categories.indexOf(a.category) - categories.indexOf(b.category) || (a.tabOrder ?? 0) - (b.tabOrder ?? 0));
  return {
    version: 1, origin, generatedAt, entries,
    counts: { total: entries.length, tab: orders.length,
      outsideTab: entries.filter(entry => entry.category === 'outside-tab').length,
      reading: entries.filter(entry => entry.category === 'reading').length,
      hidden: entries.filter(entry => entry.category === 'hidden').length,
      scanned: Number.isSafeInteger(raw.counts?.scanned) ? Math.max(0, Math.min(5000, raw.counts.scanned)) : 0,
      omittedPrivate: Number.isSafeInteger(raw.counts?.omittedPrivate) ? Math.max(0, Math.min(5000, raw.counts.omittedPrivate)) : 0,
      truncated: raw.counts?.truncated === true },
    limitations: strings(raw.limitations, 64).map(explained),
  };
}

const escapeHtml = value => String(value).replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const TONE_CLASS = Object.freeze({ problem: 'tone-problem', review: 'tone-review', ok: 'tone-ok', info: 'tone-info' });
// CSS do HTML exportado, uma regra por linha para leitura humana.
const EXPORT_CSS = [
  'body{font:16px system-ui,sans-serif;color:#172b3a;max-width:1100px;margin:2rem auto;padding:0 1rem}',
  'h1,h2{color:#163f67}',
  'p{line-height:1.6}',
  'table{border-collapse:collapse;width:100%;table-layout:fixed}',
  'th,td{border:1px solid #8195a8;padding:.7rem;vertical-align:top;overflow-wrap:anywhere;text-align:left}',
  'th{background:#eaf0f6}',
  'small{display:block}',
  'thead{display:table-header-group}',
  'tr{break-inside:avoid}',
  'section{margin:2rem 0}',
  'code{font-size:.85em}',
  '.entry-image{display:block;max-width:280px;max-height:180px;width:auto;height:auto;border:1px solid #8195a8;border-radius:4px;background:#f4f7fa}',
  '.image-missing{color:#5a6b7a;font-size:.9em}',
  '.map-frame{position:relative;display:block;width:100%;margin:0;overflow:auto;border:1px solid #8195a8;background:#f4f7fa}',
  '.map-frame img.map-base{display:block;width:100%;height:auto}',
  '.map-overlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}',
  // Só contorno: sem preenchimento a página auditada continua legível e caixas encaixadas não somam
  // opacidade. O tom do semáforo fica no traço e na etiqueta.
  '.map-box{fill:none;stroke:#b86b00}',
  '.map-box.tone-problem{fill:none;stroke:#c62828}',
  '.map-box.tone-review{fill:none;stroke:#b07900}',
  '.map-box.tone-ok{fill:none;stroke:#2e7d32}',
  '.map-box.tone-info{fill:none;stroke:#607080}',
  '.map-outline-halo{fill:none;stroke:#fff}',
  '.map-leader{stroke:#8b1e1e}',
  '.map-badge{fill:#8b1e1e;stroke:#fff}',
  '.map-badge-overlapped{fill:#6b4e00}',
  '.map-badge-text{fill:#fff;font:700 12px system-ui,sans-serif;text-anchor:middle;dominant-baseline:auto}',
  '.reader-map-columns{display:flex;gap:1rem;align-items:flex-start;flex-wrap:wrap}',
  '.reader-map-columns .map-frame{flex:1 1 58%;min-width:min(100%,320px)}',
  '.reader-map-legend{flex:1 1 34%;min-width:min(100%,260px)}',
  '.reader-map-legend h3{margin-top:0}',
  '.reader-map-list{list-style:none;margin:0;padding:0}',
  '.reader-map-list li{border-top:1px solid #d5dee6;padding:.45rem 0;line-height:1.45}',
  '.reader-map-list li:first-child{border-top:0}',
  '.reader-map-code{display:inline-block;min-width:2.4em;font-weight:700;color:#8b1e1e}',
  '.reader-map-tab{color:#40596d;font-weight:700;white-space:nowrap}',
  '.reader-map-empty,.map-note{color:#40596d;font-size:.94em}',
  '.verdict{border-radius:.65rem;padding:1.1rem 1.25rem;margin:1.2rem 0;border:1px solid}',
  '.verdict.tone-ok{background:#e8f5e9;border-color:#2e7d32}',
  '.verdict.tone-review{background:#fff8e1;border-color:#f9a825}',
  '.verdict.tone-problem{background:#fdecea;border-color:#c62828}',
  '.verdict h2{margin-top:0}',
  '.issue-card{border:1px solid #8195a8;border-left-width:6px;border-radius:.5rem;padding:.9rem 1rem;margin:.8rem 0;background:#fff}',
  '.issue-card.tone-problem{border-left-color:#c62828}',
  '.issue-card.tone-review{border-left-color:#f9a825}',
  '.issue-card.tone-ok{border-left-color:#2e7d32}',
  '.issue-card img{max-width:220px;max-height:140px;border:1px solid #ccc;border-radius:4px}',
  '.before-after{background:#f7f9fb;border-left:3px solid #163f67;padding:.5rem .75rem;margin:.35rem 0}',
  '.tech-details{margin:1rem 0;padding:.6rem;border:1px dashed #8195a8;border-radius:.4rem}',
  '.mode-note{font-size:.92em;color:#40596d}',
  '.map-box.tone-info{fill:none;stroke:#607080}',
  '.verdict.tone-info{background:#f4f7fa;border-color:#607080}',
  '.issue-card.tone-info{border-left-color:#607080}',
  '.tone-chip{display:inline-block;font-weight:700;border-radius:.3rem;padding:.05rem .45rem;margin-bottom:.3rem}',
  '.tone-chip.tone-problem{background:#fdecea;color:#8e1c1c}',
  '.tone-chip.tone-review{background:#fff3cd;color:#6b4a00}',
  '.tone-chip.tone-ok{background:#e8f5e9;color:#1b5e20}',
  '.tone-chip.tone-info{background:#eef1f4;color:#3c4a57}',
  '@media print{',
  '  body{margin:0;font-size:10pt}',
  '  h2{break-after:avoid}',
  '  th,td{padding:.4rem}',
  // Na folha a imagem fica à esquerda e a legenda à direita, como na tela. A imagem é flutuante para a
  // lista de códigos poder continuar na página seguinte quando o mapa tem muitos elementos, e cada item
  // da lista evita a quebra no meio.
  '  .reader-map-columns{display:block}',
  '  .reader-map-columns .map-frame{float:left;width:58%;margin:0 2% .4rem 0;overflow:visible}',
  '  .reader-map-columns::after{content:"";display:block;clear:both}',
  '  .map-frame{overflow:visible}',
  '  .reader-map-list li{break-inside:avoid}',
  '  .map-note{font-size:.9em}',
  '}',
].join('\n');

function safePngDataUrl(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.startsWith('data:image/png;base64,') || value.length > 12_000_000) fail();
  return value;
}

function mapRect(rect, className, strokeWidth, radius) {
  return `<rect class="${className}" x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}"${radius ? ` rx="${radius}"` : ''} stroke-width="${strokeWidth}"></rect>`;
}

/**
 * Um elemento do mapa: linha-guia, contorno na cor do semáforo e a caixa com o código. O tamanho da
 * caixa sai do plano, na escala da captura — a etiqueta cresce junto com a imagem e continua legível na
 * folha impressa.
 */
function mapMarkerHtml(marker) {
  const leader = marker.leader
    ? `<line class="map-leader" x1="${marker.leader.x1}" y1="${marker.leader.y1}" x2="${marker.leader.x2}" y2="${marker.leader.y2}" stroke-width="${marker.strokeWidth}"></line>`
    : '';
  return `${leader}<rect class="map-box ${TONE_CLASS[marker.tone]}" x="${marker.outline.x}" y="${marker.outline.y}" width="${marker.outline.width}" height="${marker.outline.height}" stroke-width="${marker.strokeWidth}"></rect>`
    + mapRect(marker.badge, `map-badge${marker.overlapped ? ' map-badge-overlapped' : ''}`, marker.strokeWidth, marker.badge.radius)
    + `<text class="map-badge-text" x="${marker.badge.x + marker.badge.width / 2}" y="${marker.label.y}" font-size="${marker.label.size}">${escapeHtml(marker.code)}</text>`;
}

function legendHtml(legend) {
  if (!legend.length) return '<p class="reader-map-empty">Nenhum elemento da ordem de leitura foi marcado neste mapa.</p>';
  return `<ul class="reader-map-list">${legend.map(item => `<li><span class="reader-map-code">${escapeHtml(item.code)}</span> `
    + `<bdi>${escapeHtml(item.text)}</bdi>${item.tabOrder ? ` <span class="reader-map-tab">(Tab ${item.tabOrder})</span>` : ''}</li>`).join('')}</ul>`;
}

/**
 * Mapa de leitura do relatório da conferência: a imagem à esquerda com as caixas e os códigos, e a
 * coluna da direita com o texto que um leitor de tela falaria em cada código. O `viewBox` é o tamanho em
 * pixel da própria captura, então cada caixa cai exatamente sobre o elemento.
 */
function renderPageMap(report) {
  const plan = readingMapPlan(report);
  if (!plan) return `<section class="page-map-section"><h2>${escapeHtml(READING_MAP_TITLE)}</h2><p>${escapeHtml(READING_MAP_UNAVAILABLE)}</p></section>`;
  const notes = plan.notes.map(note => `<p class="map-note">${escapeHtml(note)}</p>`).join('');
  // Sem a medida da captura a imagem continua no relatório (é a evidência), mas sem nenhuma caixa por
  // cima: aí não existe escala para converter a medida do documento em pixel, e marcar seria chutar.
  const overlay = plan.width > 0
    ? `<svg class="map-overlay" viewBox="0 0 ${plan.width} ${plan.height}" width="${plan.width}" height="${plan.height}" role="img" aria-label="Caixas do mapa de leitura sobre a captura da página. Os códigos estão listados ao lado.">`
      + `${plan.markers.map(marker => mapRect(marker.outline, 'map-outline-halo', marker.strokeWidth + 4)).join('')}`
      + `${plan.markers.map(mapMarkerHtml).join('')}</svg>`
    : '';
  const size = plan.width > 0 ? ` width="${plan.width}" height="${plan.height}"` : '';
  const frame = `<figure class="map-frame"><img class="map-base" src="${escapeHtml(report.pageMap)}" alt="Captura da página inspecionada com as caixas do mapa de leitura, ${plan.markers.length} elemento(s) marcado(s)"${size}>${overlay}</figure>`;
  return `<section class="page-map-section"><h2>${escapeHtml(READING_MAP_TITLE)}</h2><p>${escapeHtml(READING_MAP_INTRO)}</p>${notes}`
    + `<div class="reader-map-columns">${frame}<div class="reader-map-legend"><h3>Códigos e textos deste mapa</h3>${legendHtml(plan.legend)}</div></div></section>`;
}

export function attachReadingVisuals(report, visuals = {}) {
  if (!report || !Array.isArray(report.entries)) fail();
  const elementImages = visuals.elementImages && typeof visuals.elementImages === 'object' ? visuals.elementImages : {};
  const pageMap = safePngDataUrl(visuals.fullPage ?? visuals.pageMap ?? null);
  // A medida da captura acompanha a imagem: sem ela o mapa não tem como converter a caixa medida no
  // documento para o pixel da imagem, e aí não desenha nada em vez de apontar o lugar errado.
  const rawGeometry = visuals.pageMapGeometry ?? null;
  const measured = rawGeometry === null ? null : validPageMapGeometry(rawGeometry);
  if (rawGeometry !== null && !measured) fail();
  const pageMapGeometry = measured
    ? { pixelWidth: measured.pixelWidth, pixelHeight: measured.pixelHeight, cssWidth: measured.cssWidth, cssHeight: measured.cssHeight }
    : null;
  const extra = Array.isArray(visuals.limitations) ? visuals.limitations.map(explained).slice(0, 16) : [];
  const entries = report.entries.map(entry => ({
    ...entry,
    image: safePngDataUrl(elementImages[entry.id] ?? null),
  }));
  return {
    ...report,
    entries,
    pageMap,
    pageMapGeometry: pageMap ? pageMapGeometry : null,
    limitations: [...report.limitations, ...extra].slice(0, 80),
  };
}

function toneChip(entry) {
  const tone = entryTone(entry);
  return `<span class="tone-chip ${TONE_CLASS[tone]}">${escapeHtml(TONE_LABELS[tone])}</span>`;
}

function issueLabel(entry) {
  if (entry.tabOrder) return `Tab ${entry.tabOrder}`;
  return READING_CATEGORIES[entry.category];
}

/** Bloco "Em uma frase" e cards "O que corrigir primeiro" do modo leigo. */
export function renderVerdictAndCards(report) {
  const verdict = buildVerdict(report.entries);
  const cards = topIssues(report.entries, 5).map(entry => {
    const tone = entryTone(entry);
    const fix = entryFix(entry);
    const image = entry.image ? `<img src="${escapeHtml(entry.image)}" alt="Captura do elemento ${escapeHtml(entry.tag)}">` : '';
    const fixHtml = fix
      ? `<p><strong>O que está errado:</strong> ${escapeHtml(fix.problem)}</p>`
        + `<p><strong>O que fazer:</strong> ${escapeHtml(fix.action)}</p>`
        + `<div class="before-after"><div>${escapeHtml(fix.before)}</div><div>${escapeHtml(fix.after)}</div></div>`
      : '';
    return `<article class="issue-card ${TONE_CLASS[tone]}">`
      + `<h3>${escapeHtml(issueLabel(entry))} · ${escapeHtml(TONE_LABELS[tone])}</h3>`
      + `<p>${escapeHtml(laySummary(entry))}</p>${image}${fixHtml}</article>`;
  }).join('');
  const cardsSection = cards
    ? `<section id="correcoes"><h2>O que corrigir primeiro</h2><p class="mode-note">Os pontos mais graves primeiro, na ordem de Tab. Cada card diz o que um leitor de tela anunciaria, o que corrigir e um exemplo.</p>${cards}</section>`
    : '';
  const { counts } = verdict;
  return `<section class="verdict ${TONE_CLASS[verdict.tone]}" id="veredito"><h2>Em uma frase</h2>`
    + `<p><strong>${escapeHtml(verdict.phrase)}</strong></p>`
    + `<p>${counts.problem} problema(s), ${counts.review} ponto(s) a revisar e ${counts.ok} sem ponto crítico. `
    + `${counts.info} elemento(s) oculto(s) ficam fora da conta.</p>`
    + '<p class="mode-note">Semáforo: vermelho indica o que confunde ou bloqueia a leitura; âmbar, o que merece conferência; verde, o que parece bem. É uma estimativa para orientar a revisão humana.</p>'
    + `</section>${cardsSection}`;
}

function renderEntryRow(entry) {
  const image = entry.image
    ? `<img class="entry-image" src="${escapeHtml(entry.image)}" alt="Captura do elemento ${escapeHtml(entry.tag)}${entry.tabOrder ? `, ordem ${entry.tabOrder}` : ''}">`
    : '<span class="image-missing">Captura não disponível</span>';
  const element = `${entry.tabOrder ?? '—'} · ${escapeHtml(entry.tag)}<small><code>${escapeHtml(entry.selector)}</code></small>`;
  const name = `${escapeHtml(entry.name || 'Sem nome acessível')}<small>${escapeHtml(entry.role || 'Sem função identificada')}</small>`;
  const preview = `${escapeHtml(entry.preview || 'Prévia não disponível')}<small>${escapeHtml(entry.description)}</small>`
    + `<small>${escapeHtml(entry.states.join(', '))}</small>`;
  const review = `${toneChip(entry)}<small>${escapeHtml(laySummary(entry))}</small>`
    + `<small class="entry-question">${escapeHtml(TAB_READING_QUESTION)}</small>`
    + (entry.reasons.length ? `<small>${escapeHtml(entry.reasons.join('; '))}</small>` : '');
  return `<tr><td>${image}</td><td>${element}</td><td>${name}</td><td>${preview}</td><td>${review}</td></tr>`;
}

/**
 * Largura máxima do mapa na folha: sai da proporção real da captura, para a imagem caber numa página A4
 * em pé já com a legenda ao lado. Sem isso uma página longa empurraria a legenda para a folha seguinte.
 */
function printAspectRule(plan) {
  if (!plan || plan.width <= 0 || plan.height <= 0) return '';
  return `@media print{.reader-map-columns .map-frame{max-width:calc(210mm * ${plan.width} / ${plan.height})}}`;
}

export function renderReadingHtml(report) {
  const sections = Object.entries(READING_CATEGORIES).map(([category, label]) => {
    const rows = report.entries.filter(entry => entry.category === category);
    const table = rows.length
      // O aviso vai uma vez por tabela, não em cada linha: repetido 40 vezes só atrapalharia a leitura.
      ? `<p class="reading-notice">${escapeHtml(TAB_READING_READER_NOTICE)}</p>`
        + '<table><thead><tr><th scope="col">Imagem do elemento</th><th scope="col">Ordem / elemento</th>'
        + '<th scope="col">Nome e função</th><th scope="col">Anúncio estimado</th><th scope="col">Pergunta</th></tr></thead>'
        + `<tbody>${rows.map(renderEntryRow).join('')}</tbody></table>`
      : '<p>Nenhum elemento registrado nesta categoria.</p>';
    return `<section><h2>${label} (${rows.length})</h2>${table}</section>`;
  }).join('');
  const head = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">`
    + `<title>Conferência de leitura por Tab — Audita Acessibilidade</title><style>${EXPORT_CSS}</style>`
    + `<style>${printAspectRule(readingMapPlan(report))}</style></head>`;
  const intro = '<h1>Conferência de leitura por Tab</h1>'
    + `<p>Audita Acessibilidade · ${escapeHtml(report.origin)} · ${escapeHtml(report.generatedAt)}</p>`
    + `<p>${READING_EXPLANATION}</p><p>${READING_PRIVACY}</p>`
    + `<p>${report.counts.total} elementos registrados; ${report.counts.tab} na sequência estimada; ${report.counts.outsideTab} controles fora do Tab.</p>`;
  const limits = `<h2>Limites da inspeção</h2><ul>${report.limitations.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul>`;
  const footer = '<p>Relatório complementar do estado observado. A ordem pode mudar com interações, scripts e configurações do navegador. Use a opção de impressão do navegador para salvar em PDF.</p>';
  return `${head}<body>${intro}${renderVerdictAndCards(report)}${limits}${sections}${renderPageMap(report)}${footer}</body></html>`;
}

export function renderReadingCsv(report) {
  const cell = value => {
    const string = String(value ?? '');
    return `"${(/^[\s]*[=+\-@\t\r]/u.test(string) ? "'" + string : string).replaceAll('"', '""')}"`;
  };
  const rows = [['Categoria', 'Ordem Tab', 'Elemento', 'Seletor', 'Nome acessível', 'Função', 'Descrição', 'Estados', 'Anúncio estimado', 'Observações', 'Semáforo', 'Em linguagem simples'],
    ...report.entries.map(entry => [READING_CATEGORIES[entry.category], entry.tabOrder, entry.tag, entry.selector, entry.name, entry.role, entry.description, entry.states.join('; '), entry.preview, entry.reasons.join('; '),
      TONE_LABELS[entryTone(entry)], laySummary(entry)])];
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n');
}
