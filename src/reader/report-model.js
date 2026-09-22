import { redactSensitiveText } from '../core/privacy.js';

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
const EXPLANATIONS = Object.freeze({
  'estimated-order-not-literal-screen-reader': 'A ordem de Tab e os anúncios são estimados a partir do HTML e de ARIA. Não são uma transcrição de leitor de tela.',
  'top-document-open-shadow-only': 'Inspeção do documento principal e dos componentes com Shadow DOM aberto.',
  'closed-shadow-not-inspected': 'Componentes com Shadow DOM fechado não podem ser inspecionados.',
  'editable-values-omitted': 'Valores de campos, seleções de texto e conteúdo editável foram omitidos por privacidade.',
  'observed-state-may-change': 'Scripts, interações e alterações da página podem mudar a ordem e os anúncios. Atualize a inspeção depois de mudar o estado.',
  'open-shadow-order-estimated': 'A ordem dentro de componentes Shadow DOM é aproximada; confirme com Tab na página.',
  'slot-content-unavailable': 'Parte do conteúdo distribuído em componentes não pôde ser inspecionada.',
  'node-limit-reached': 'O limite de 5.000 nós foi atingido; parte da página não foi inspecionada.',
  'entry-limit-reached': 'O limite de 1.000 elementos foi atingido; o inventário está parcial.',
  'text-limit-reached': 'Parte do texto excedeu o limite da prévia e foi resumida. Confira o conteúdo completo na página.',
  'private-content-omitted': 'Conteúdo marcado como privado foi omitido. Isso não significa que ele esteja invisível para leitores de tela.',
  'credential-content-omitted': 'Texto relacionado a credenciais foi omitido por privacidade; confira o rótulo diretamente na página.',
  'frame-content-not-inspected': 'O conteúdo interno deste frame não foi inspecionado. Ele pode conter outras paradas de Tab.',
  'visual-capture-unavailable': 'A captura de tela não ficou disponível nesta inspeção.',
  'full-page-capture-unavailable': 'A captura da página inteira não ficou disponível.',
  'element-crop-failed': 'Não foi possível recortar a imagem de alguns elementos.',
  'not-rendered': 'Não está visível neste estado da página.',
  inert: 'Elemento inerte: não participa da interação nem da leitura acessível neste estado.',
  'aria-hidden': 'Oculto da árvore de acessibilidade por aria-hidden. Se recebe Tab, o foco pode ficar sem anúncio adequado.',
  'native-disabled': 'Controle desabilitado pelo HTML; normalmente não recebe Tab neste estado.',
  'aria-disabled-remains-focusable': 'Marcado indisponível por ARIA; essa marcação sozinha não impede receber Tab.',
  'negative-tabindex': 'tabindex negativo: pode receber foco por script, mas está fora da sequência normal de Tab.',
  'control-outside-tab': 'Controle fora da sequência de Tab. Confira se há uma forma adequada de operá-lo por teclado.',
  'structural-reading-not-tab': 'Conteúdo de leitura estrutural: normalmente lido por outros comandos, sem parada de Tab.',
  'accessible-name-unavailable': 'Nome acessível não identificado. Confira se o propósito do controle pode ser entendido.',
  'radio-group-arrow-navigation': 'Outro botão de opção representa este grupo no Tab. As opções normalmente são percorridas com as setas.',
  'implicit-editing-host': 'Área editável: recebe Tab mesmo sem um atributo tabindex explícito. O conteúdo digitado foi omitido.',
});
function explained(value) { return EXPLANATIONS[value] ?? safeText(value); }

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
const EXPORT_CSS = 'body{font:16px system-ui,sans-serif;color:#172b3a;max-width:1100px;margin:2rem auto;padding:0 1rem}h1,h2{color:#163f67}p{line-height:1.6}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{border:1px solid #8195a8;padding:.7rem;vertical-align:top;overflow-wrap:anywhere;text-align:left}th{background:#eaf0f6}small{display:block}thead{display:table-header-group}tr{break-inside:avoid}section{margin:2rem 0}code{font-size:.85em}.entry-image{display:block;max-width:280px;max-height:180px;width:auto;height:auto;border:1px solid #8195a8;border-radius:4px;background:#f4f7fa}.image-missing{color:#5a6b7a;font-size:.9em}.map-frame{position:relative;display:block;width:100%;overflow:auto;border:1px solid #8195a8;background:#f4f7fa}.map-frame img.map-base{display:block;width:100%;height:auto}.map-overlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.map-box{fill:rgba(255,191,71,.22);stroke:#b86b00;stroke-width:1.5}.map-label-bg{fill:rgba(16,41,58,.92);stroke:#ffbf47;stroke-width:1}.map-label{fill:#fff;font:12px system-ui,sans-serif}.map-label-num{fill:#ffbf47;font:700 12px system-ui,sans-serif}@media print{body{margin:0;font-size:10pt}h2{break-after:avoid}th,td{padding:.4rem}.map-frame{overflow:visible}}';

function safePngDataUrl(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.startsWith('data:image/png;base64,') || value.length > 12_000_000) fail();
  return value;
}

function readingOrderNumber(entry, tabCount) {
  if (entry.category === 'tab' && entry.tabOrder !== null) return entry.tabOrder;
  return null;
}

function mapEntries(report) {
  return report.entries.filter(entry => ['tab', 'reading'].includes(entry.category) && entry.bounds);
}

function renderPageMap(report) {
  if (!report.pageMap) return '';
  const rows = mapEntries(report);
  const sample = report.entries.find(entry => entry.bounds) || { bounds: { x: 0, y: 0, width: 1, height: 1 } };
  void sample;
  let width = 0; let height = 0;
  try {
    // Prefer geometry implied by the raster when the report kept it; fall back to the furthest bound.
    width = Math.max(...rows.map(entry => entry.bounds.x + entry.bounds.width), 800);
    height = Math.max(...rows.map(entry => entry.bounds.y + entry.bounds.height), 600);
  } catch { width = 800; height = 600; }
  const labels = rows.map((entry, index) => {
    const order = entry.tabOrder ?? (entry.category === 'reading' ? `L${index + 1}` : `${index + 1}`);
    const textValue = entry.preview || entry.name || 'Sem texto acessível';
    const label = String(textValue).replace(/\s+/gu, ' ').slice(0, 180);
    const boxWidth = Math.min(360, Math.max(120, label.length * 6.4 + 36));
    const boxHeight = 34;
    const x = Math.max(0, Math.min(entry.bounds.x, width - boxWidth));
    const y = Math.max(0, entry.bounds.y - boxHeight - 4);
    return `<g><rect class="map-box" x="${entry.bounds.x}" y="${entry.bounds.y}" width="${entry.bounds.width}" height="${entry.bounds.height}"></rect><rect class="map-label-bg" x="${x}" y="${y}" width="${boxWidth}" height="${boxHeight}" rx="4"></rect><text class="map-label-num" x="${x + 8}" y="${y + 21}">${escapeHtml(String(order))}.</text><text class="map-label" x="${x + 8 + String(order).length * 8 + 10}" y="${y + 21}">${escapeHtml(label)}</text></g>`;
  }).join('');
  return `<section class="page-map-section"><h2>Mapa de leitura da página</h2><p>Cada caixa indica o trecho da página e o texto que seria lido, precedido do número de ordem de leitura (Tab) ou da marca de leitura estrutural (L). Serve para localizar o elemento sem ler o código.</p><div class="map-frame"><img class="map-base" src="${escapeHtml(report.pageMap)}" alt="Captura da página inspecionada com caixas de anúncio" width="${Math.round(width)}" height="${Math.round(height)}"><svg class="map-overlay" viewBox="0 0 ${Math.round(width)} ${Math.round(height)}" width="${Math.round(width)}" height="${Math.round(height)}" role="img" aria-label="Mapa de leitura com ${rows.length} elementos anotados">${labels}</svg></div></section>`;
}

export function attachReadingVisuals(report, visuals = {}) {
  if (!report || !Array.isArray(report.entries)) fail();
  const elementImages = visuals.elementImages && typeof visuals.elementImages === 'object' ? visuals.elementImages : {};
  const pageMap = safePngDataUrl(visuals.fullPage ?? visuals.pageMap ?? null);
  const extra = Array.isArray(visuals.limitations) ? visuals.limitations.map(explained).slice(0, 16) : [];
  const entries = report.entries.map(entry => ({
    ...entry,
    image: safePngDataUrl(elementImages[entry.id] ?? null),
  }));
  return {
    ...report,
    entries,
    pageMap,
    limitations: [...report.limitations, ...extra].slice(0, 80),
  };
}

export function renderReadingHtml(report) {
  const sections = Object.entries(READING_CATEGORIES).map(([category, label]) => {
    const rows = report.entries.filter(entry => entry.category === category);
    return `<section><h2>${label} (${rows.length})</h2>${rows.length ? `<table><thead><tr><th scope="col">Imagem do elemento</th><th scope="col">Ordem / elemento</th><th scope="col">Nome e função</th><th scope="col">Anúncio estimado</th><th scope="col">Conferir</th></tr></thead><tbody>${rows.map(entry => `<tr><td>${entry.image ? `<img class="entry-image" src="${escapeHtml(entry.image)}" alt="Captura do elemento ${escapeHtml(entry.tag)}${entry.tabOrder ? `, ordem ${entry.tabOrder}` : ''}">` : '<span class="image-missing">Captura não disponível</span>'}</td><td>${entry.tabOrder ?? '—'} · ${escapeHtml(entry.tag)}<small><code>${escapeHtml(entry.selector)}</code></small></td><td>${escapeHtml(entry.name || 'Sem nome acessível')}<small>${escapeHtml(entry.role || 'Sem função identificada')}</small></td><td>${escapeHtml(entry.preview || 'Prévia não disponível')}<small>${escapeHtml(entry.description)}</small><small>${escapeHtml(entry.states.join(', '))}</small></td><td>${escapeHtml(entry.reasons.join('; ') || 'Confira se o anúncio representa o elemento.')}</td></tr>`).join('')}</tbody></table>` : '<p>Nenhum elemento registrado nesta categoria.</p>'}</section>`;
  }).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>Conferência de leitura por Tab — Audita Acessibilidade</title><style>${EXPORT_CSS}</style></head><body><h1>Conferência de leitura por Tab</h1><p>Audita Acessibilidade · ${escapeHtml(report.origin)} · ${escapeHtml(report.generatedAt)}</p><p>${READING_EXPLANATION}</p><p>${READING_PRIVACY}</p><p>${report.counts.total} elementos registrados; ${report.counts.tab} na sequência estimada; ${report.counts.outsideTab} controles fora do Tab.</p><h2>Limites da inspeção</h2><ul>${report.limitations.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul>${sections}${renderPageMap(report)}<p>Relatório complementar do estado observado. A ordem pode mudar com interações, scripts e configurações do navegador. Use a opção de impressão do navegador para salvar em PDF.</p></body></html>`;
}

export function renderReadingCsv(report) {
  const cell = value => {
    const string = String(value ?? '');
    return `"${(/^[\s]*[=+\-@\t\r]/u.test(string) ? "'" + string : string).replaceAll('"', '""')}"`;
  };
  const rows = [['Categoria', 'Ordem Tab', 'Elemento', 'Seletor', 'Nome acessível', 'Função', 'Descrição', 'Estados', 'Anúncio estimado', 'Observações'],
    ...report.entries.map(entry => [READING_CATEGORIES[entry.category], entry.tabOrder, entry.tag, entry.selector, entry.name, entry.role, entry.description, entry.states.join('; '), entry.preview, entry.reasons.join('; ')])];
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n');
}
