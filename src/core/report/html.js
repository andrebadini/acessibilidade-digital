import { sanitizeResourceUrl } from '../normalize-snapshot.js';
import { createAuditModel } from './audit-model.js';
import { sha256Hex } from './hash.js';
import { REPORT_CSS } from './report.css.js';

const BRAND_SOURCE_URL = 'https://www.secom.mt.gov.br/documents/21013/0/_govmt_manual_de_identidade_oficial_expandido_abril_2026.pdf/7921f56c-66a0-15a1-37d7-3f04c37fadfc';
const BRAND_SHA256 = '1736ccf3c3783a42e9ebc7649a3fa473774b4c5f413ba1a09616cbd2e76cac7d';
const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_BYTES = 64 * 1024 * 1024;
const MAX_PNG_DIMENSION = 100_000;
const MAX_PNG_PIXELS = 268_435_456;
const CRC_TABLE = makeCrcTable();

const STATUS = Object.freeze({
  passed: { label: 'Aprovado', icon: '✓' },
  failed: { label: 'Reprovado', icon: '✕' },
  cantTell: { label: 'Revisar', icon: '?' },
  inapplicable: { label: 'Não aplicável', icon: '—' },
  untested: { label: 'Não testado', icon: '!' },
});

export async function createBrandAsset(value) {
  const bytes = toBytes(value);
  const { width, height } = pngDimensions(bytes);
  const sha256 = await sha256Hex(bytes);
  if (width !== 1120 || height !== 440 || sha256 !== BRAND_SHA256) throw new TypeError('O ativo de marca não corresponde ao PNG oficial renderizado e verificado.');
  return Object.freeze({
    dataUrl: `data:image/png;base64,${base64(bytes)}`,
    sha256,
    sourceUrl: BRAND_SOURCE_URL,
    alt: 'Governo de Mato Grosso',
    width,
    height,
  });
}

export function renderHtmlReport(input, assets = {}) {
  const model = createAuditModel(input);
  const counts = Object.fromEntries(Object.keys(STATUS).map(outcome => [outcome, model.itemResults.filter(item => item.outcome === outcome).length]));
  const itemById = new Map(model.itemResults.map(item => [item.id, item]));
  const artifactById = new Map(model.evidence.artifacts.map(artifact => [artifact.evidenceId, artifact]));
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Relatório de auditoria — Audita MT</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<a class="skip-link" href="#conteudo">Ir para o conteúdo principal</a>
${header(assets)}
<main id="conteudo">
<h1>Relatório de auditoria de acessibilidade</h1>
<p class="lead">Auditoria automatizada e assistida da página e do estado observados. Este relatório não é, isoladamente, uma declaração de conformidade do site inteiro.</p>
<p class="notice"><strong>Integridade temporal:</strong> os horários usam o relógio local do dispositivo e não constituem carimbo de tempo certificado. Os hashes demonstram integridade entre artefatos, não autoria ou assinatura digital.</p>
${summary(model, counts)}
${scope(model)}
${methodology(model)}
${items(model)}
${occurrences(model, itemById, artifactById)}
${evidence(model)}
${review(model, itemById)}
${limitations(model)}
${editorial(model)}
${foundation(model)}
${integrity(model)}
</main>
<footer class="report-footer"><p>Audita MT — relatório local da auditoria ${escapeHtml(model.auditId)}.</p><p>Gerado em ${escapeHtml(model.timestamps.generatedAt)} (${escapeHtml(model.timezone)}).</p></footer>
</body>
</html>`;
}

function header(assets) {
  const brand = assets?.brand;
  const logo = brand && isPngDataUrl(brand.dataUrl)
    ? `<img class="brand-logo" src="${escapeHtml(brand.dataUrl)}" alt="Governo de Mato Grosso" width="1120" height="440">`
    : '';
  const agency = brand ? '<p class="agency">PROCON-MT — Secretaria Adjunta de Proteção e Defesa dos Direitos do Consumidor</p>' : '<p class="agency">Audita MT</p>';
  return `<header class="report-header"><div class="report-header__inner">${logo}${agency}</div></header>`;
}

function summary(model, counts) {
  return `<section aria-labelledby="sumario"><h2 id="sumario">Sumário executivo</h2>
<dl class="meta"><dt>Auditoria</dt><dd>${escapeHtml(model.auditId)}</dd><dt>Status da sessão</dt><dd>${escapeHtml(model.session.status)}</dd><dt>URL final</dt><dd><code>${escapeHtml(model.finalUrl)}</code></dd><dt>Itens avaliados</dt><dd>${escapeHtml(model.itemResults.length)}</dd></dl>
<ul class="summary-grid">${Object.entries(STATUS).map(([outcome, status]) => `<li class="summary-card">${statusMarkup(outcome)}<strong>${escapeHtml(counts[outcome])}</strong><span>itens</span></li>`).join('')}</ul></section>`;
}

function scope(model) {
  return `<section aria-labelledby="escopo"><h2 id="escopo">Escopo</h2><dl class="meta"><dt>Tipo</dt><dd>${escapeHtml(model.scope.kind)}</dd><dt>Descrição</dt><dd>${escapeHtml(model.scope.description)}</dd><dt>URL solicitada</dt><dd><code>${escapeHtml(model.requestedUrl)}</code></dd><dt>URL final</dt><dd><code>${escapeHtml(model.finalUrl)}</code></dd><dt>Início</dt><dd>${escapeHtml(model.timestamps.startedAt)}</dd><dt>Fim</dt><dd>${escapeHtml(model.timestamps.endedAt)}</dd><dt>Fuso</dt><dd>${escapeHtml(model.timezone)}</dd></dl></section>`;
}

function methodology(model) {
  const viewport = model.environment.viewport;
  return `<section class="major-section" aria-labelledby="metodologia"><h2 id="metodologia">Metodologia</h2><p>${escapeHtml(model.methodology.name)}. As verificações automáticas só aprovam quando aplicabilidade e expectativas foram observadas integralmente; itens contextuais permanecem para revisão.</p><dl class="meta"><dt>Extensão</dt><dd>${escapeHtml(model.versions.extension)}</dd><dt>Regras</dt><dd>${escapeHtml(model.versions.rules)}</dd><dt>Navegador</dt><dd>${escapeHtml(model.versions.browser)}</dd><dt>Viewport</dt><dd>${escapeHtml(viewport.width)} × ${escapeHtml(viewport.height)} CSS px; escala ${escapeHtml(viewport.deviceScaleFactor)}</dd><dt>Regras executadas</dt><dd>${escapeHtml(model.methodology.ruleCount)}</dd><dt>Itens normativos</dt><dd>${escapeHtml(model.methodology.itemCount)}</dd></dl></section>`;
}

function items(model) {
  return `<section class="major-section" aria-labelledby="itens"><h2 id="itens">Resultados por item</h2><div class="item-list">${model.itemResults.map((item, index) => `<article class="item-card" data-report-item="${escapeHtml(item.id)}" aria-labelledby="item-${index}"><div class="item-card__heading"><h3 id="item-${index}">${escapeHtml(item.id)} — ${escapeHtml(item.title)}</h3>${statusMarkup(item.outcome)}</div><dl class="meta"><dt>Classificação</dt><dd>${item.classification === 'requirement' ? 'Requisito' : 'Recomendação'}</dd><dt>Modo interno</dt><dd>${modeLabel(item.evaluation)}</dd><dt>WCAG 2.2</dt><dd>${item.wcag.length ? item.wcag.map(reference => `${escapeHtml(reference.id)} (${escapeHtml(reference.level)})`).join(', ') : 'Sem critério vinculado'}</dd><dt>Justificativa humana</dt><dd>${escapeHtml(item.humanReason || 'Não se aplica a este resultado.')}</dd></dl></article>`).join('')}</div></section>`;
}

function occurrences(model, itemById, artifactById) {
  return `<section class="major-section" aria-labelledby="ocorrencias"><h2 id="ocorrencias">Ocorrências e evidências</h2><div class="occurrence-list">${model.occurrences.map((occurrence, index) => {
    const item = itemById.get(occurrence.itemId);
    const selectors = occurrence.evidenceIds.map(id => artifactById.get(id)?.selector?.css).filter(Boolean);
    return `<article class="occurrence-card" aria-labelledby="ocorrencia-${index}"><h3 id="ocorrencia-${index}">${escapeHtml(occurrence.occurrenceId)}</h3>${statusMarkup(occurrence.outcome)}<dl class="meta"><dt>Item ABNT</dt><dd>${escapeHtml(occurrence.itemId)} — ${escapeHtml(item?.title || '')}</dd><dt>Regra</dt><dd>${escapeHtml(occurrence.ruleId || 'revisão no nível da página')}</dd><dt>Modo</dt><dd>${modeLabel(occurrence.mode)}</dd><dt>Razão</dt><dd>${escapeHtml(occurrence.justification)}</dd><dt>Seletor</dt><dd>${selectors.length ? selectors.map(selector => `<code>${escapeHtml(selector)}</code>`).join(' ') : 'Página inteira ou seletor indisponível'}</dd><dt>Evidências</dt><dd>${occurrence.evidenceIds.map(id => `<code>${escapeHtml(id)}</code>`).join(' ') || 'Sem arquivo; consulte a limitação registrada.'}</dd></dl></article>`;
  }).join('')}</div></section>`;
}

function evidence(model) {
  return `<section class="major-section" aria-labelledby="evidencias"><h2 id="evidencias">Evidências</h2><div class="evidence-list">${model.evidence.artifacts.map((artifact, index) => `<article class="evidence-card" aria-labelledby="evidencia-${index}"><h3 id="evidencia-${index}">${escapeHtml(artifact.evidenceId)}</h3><dl class="meta"><dt>Tipo</dt><dd>${escapeHtml(artifact.kind)}</dd><dt>Hash</dt><dd><code>${escapeHtml(artifact.hash || 'não disponível')}</code></dd>${artifact.backendNodeId ? `<dt>Backend node</dt><dd>${escapeHtml(artifact.backendNodeId)}</dd>` : ''}${artifact.mediaUrl ? `<dt>URL da mídia</dt><dd>${safeMediaText(artifact.mediaUrl)}</dd>` : ''}</dl>${artifact.snippet ? `<details open><summary>Trecho HTML sanitizado</summary><pre><code>${escapeHtml(artifact.snippet)}</code></pre></details>` : ''}${accessibility(artifact.accessibility)}${isPngDataUrl(artifact.dataUrl) ? `<figure><img class="evidence-media" src="${escapeHtml(artifact.dataUrl)}" alt="${evidenceAlt(artifact)}"><figcaption>${artifact.kind === 'full-page' ? 'Captura integral do estado original observado.' : `Captura do elemento ${escapeHtml(artifact.nodeId || '')}.`}</figcaption></figure>` : '<p>Imagem não incluída: formato ausente ou não permitido.</p>'}</article>`).join('')}</div></section>`;
}

function accessibility(value) {
  if (!value || typeof value !== 'object') return '';
  return `<section aria-label="Propriedades de acessibilidade"><h4>Nome, função e prévia</h4><dl class="meta"><dt>Nome acessível</dt><dd>${escapeHtml(value.name || 'não disponível')}</dd><dt>Origem do nome</dt><dd>${escapeHtml(value.nameSource || 'não disponível')}</dd><dt>Descrição acessível</dt><dd>${escapeHtml(value.description || 'não disponível')}</dd><dt>Origem da descrição</dt><dd>${escapeHtml(value.descriptionSource || 'não disponível')}</dd><dt>Função</dt><dd>${escapeHtml(value.role || 'não disponível')}</dd><dt>Valor</dt><dd>${escapeHtml(value.value || 'não disponível')}</dd><dt>Estados</dt><dd>${escapeHtml((value.states || []).join(', ') || 'não disponíveis')}</dd><dt>Texto visível</dt><dd>${escapeHtml(value.visibleText || 'não disponível')}</dd><dt>Prévia de anúncio</dt><dd>${escapeHtml(value.announcementPreview || 'não disponível')}</dd></dl><p><strong>Variação esperada:</strong> esta prévia não é transcrição literal de tecnologia assistiva e pode variar conforme o navegador, a API da plataforma, o leitor, o modo e as preferências.</p></section>`;
}

function review(model, itemById) {
  return `<section class="major-section" aria-labelledby="revisao"><h2 id="revisao">Revisão humana</h2><p>Respostas pendentes não são tratadas como conformidade.</p><div class="review-list">${model.manualReview.map((entry, index) => `<article class="review-card" aria-labelledby="revisao-${index}"><h3 id="revisao-${index}">${escapeHtml(entry.itemId)} — ${escapeHtml(itemById.get(entry.itemId)?.title || '')}</h3><p><strong>Pergunta:</strong> ${escapeHtml(entry.question)}</p><p><strong>Razão:</strong> ${escapeHtml(entry.reason)}</p><p><strong>Status:</strong> ${escapeHtml(entry.status === 'answered' ? 'Respondida' : 'Não respondida')}</p></article>`).join('')}</div></section>`;
}

function limitations(model) {
  const diagnostics = model.session.diagnostics.map(entry => `${entry.code}: ${entry.message}`);
  return `<section class="major-section" aria-labelledby="limitacoes"><h2 id="limitacoes">Limitações</h2><ul>${[...model.limitations, ...diagnostics].map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul><p>A ausência de falha automática não comprova conformidade integral. Processos completos, páginas não visitadas, tecnologias suportadas e não interferência permanecem fora da alegação desta auditoria de página.</p></section>`;
}

function editorial(model) {
  const notes = model.normative?.editorialNotes || [];
  return `<section class="major-section" aria-labelledby="editorial"><h2 id="editorial">Notas de integridade normativa</h2><p>A informação impressa é preservada separadamente da normalização adotada; este relatório não atribui à ABNT uma errata não localizada.</p><table><thead><tr><th>Item</th><th>Impresso</th><th>Normalização adotada</th><th>Fundamento</th></tr></thead><tbody>${notes.map(note => `<tr><td>${escapeHtml(note.itemId)}</td><td>${escapeHtml(note.printed)}</td><td>${escapeHtml(note.normalized)}</td><td>${escapeHtml(note.rationale)}</td></tr>`).join('')}</tbody></table></section>`;
}

function foundation(model) {
  return `<section class="major-section" aria-labelledby="fundamentacao"><h2 id="fundamentacao">Fundamentação normativa</h2><ul><li>${escapeHtml(model.normative?.edition || 'ABNT NBR 17225:2025')} — códigos, títulos, classificação e referências usadas sem reprodução extensa do texto protegido.</li><li>${escapeHtml(model.normative?.wcag || 'WCAG 2.2')} — critérios e níveis oficiais.</li><li>WCAG-EM — referência metodológica para escopo, amostragem e limites de alegação.</li><li>Lei Brasileira de Inclusão, Lei nº 13.146/2015, art. 63 — contexto legal; este relatório não substitui análise jurídica.</li></ul></section>`;
}

function integrity(model) {
  const entries = {
    'Algoritmo': model.integrity?.algorithm || 'SHA-256',
    'Modelo canônico': model.integrity?.canonicalModelHash || 'pendente da etapa de exportação',
    'Manifesto de evidências': model.integrity?.evidenceManifestHash || model.reproducibility?.evidenceHash || 'não disponível',
    'Snapshot': model.reproducibility?.snapshotHash || 'não disponível',
    'Resultados de regras': model.reproducibility?.ruleResultsHash || 'não disponível',
  };
  return `<section class="major-section" aria-labelledby="integridade"><h2 id="integridade">Manifesto de integridade</h2><dl class="meta">${Object.entries(entries).map(([key, value]) => `<dt>${key}</dt><dd><code>${escapeHtml(value)}</code></dd>`).join('')}</dl><p>SHA-256 permite verificar igualdade dos artefatos, mas não substitui assinatura digital, carimbo certificado ou ata notarial.</p></section>`;
}

function statusMarkup(outcome) {
  const status = STATUS[outcome] || STATUS.untested;
  return `<span class="status status--${outcome}"><span aria-hidden="true">${status.icon}</span><span>${status.label}</span></span>`;
}

function modeLabel(mode) {
  return ({ automated: 'Automatizado', assisted: 'Assistido', manual: 'Manual' })[mode] || 'Não informado';
}

function evidenceAlt(artifact) {
  return escapeHtml(artifact.kind === 'full-page' ? 'Captura integral da página auditada' : `Captura do elemento auditado ${artifact.nodeId || ''}`);
}

function safeMediaText(value) {
  const sanitized = sanitizeResourceUrl(value);
  return /^https?:\/\//u.test(sanitized) ? `<code>${escapeHtml(sanitized)}</code>` : 'URL omitida por segurança.';
}

function isPngDataUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('data:image/png;base64,')) return false;
  const encoded = value.slice('data:image/png;base64,'.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return false;
  try {
    const binary = atob(encoded);
    if (binary.length > MAX_PNG_BYTES) return false;
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    parsePng(bytes);
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function toBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('O ativo de marca deve ser fornecido como bytes PNG.');
}

function pngDimensions(bytes) {
  return parsePng(bytes);
}

function base64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function parsePng(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 57 || bytes.length > MAX_PNG_BYTES
    || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new TypeError('Estrutura PNG inválida ou fora dos limites.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  let chunkIndex = 0;
  let width = 0;
  let height = 0;
  let sawIdat = false;
  let endedIdat = false;
  let idatBytes = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) throw new TypeError('Chunk PNG truncado.');
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) throw new TypeError('Comprimento de chunk PNG excede o buffer.');
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const crcOffset = dataStart + length;
    const typeBytes = bytes.subarray(typeStart, dataStart);
    if (![...typeBytes].every(byte => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122))) throw new TypeError('Tipo de chunk PNG inválido.');
    const type = String.fromCharCode(...typeBytes);
    if (crc32(bytes.subarray(typeStart, crcOffset)) !== view.getUint32(crcOffset)) throw new TypeError(`CRC PNG inválido no chunk ${type}.`);

    if (chunkIndex === 0) {
      if (type !== 'IHDR' || length !== 13) throw new TypeError('IHDR deve ser o primeiro chunk PNG e conter 13 bytes.');
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      const bitDepth = bytes[dataStart + 8];
      const colorType = bytes[dataStart + 9];
      const allowedDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION || width * height > MAX_PNG_PIXELS
        || !allowedDepths[colorType]?.includes(bitDepth) || bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0
        || ![0, 1].includes(bytes[dataStart + 12])) {
        throw new TypeError('IHDR PNG contém dimensões ou parâmetros inválidos.');
      }
    } else if (type === 'IHDR') {
      throw new TypeError('PNG contém mais de um IHDR.');
    }

    if (type === 'IDAT') {
      if (endedIdat) throw new TypeError('Chunks IDAT PNG devem ser consecutivos.');
      sawIdat = true;
      idatBytes += length;
    } else if (sawIdat && type !== 'IEND') {
      endedIdat = true;
    }
    offset = crcOffset + 4;
    chunkIndex += 1;
    if (type === 'IEND') {
      if (length !== 0 || !sawIdat || idatBytes === 0 || offset !== bytes.length) throw new TypeError('IEND PNG inválido, prematuro ou seguido por dados.');
      return { width, height };
    }
  }
  throw new TypeError('PNG sem IEND final.');
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
