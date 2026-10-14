import { decodePngDataUrl } from '../evidence/png.js';

export const KEYBOARD_MAP_INTRO = 'Cada caixa azul numerada é um lugar onde a tecla Tab para, na ordem dos números. Caixas laranja tracejadas: itens que parecem clicáveis, mas o Tab não chega até eles.';

export const KEYBOARD_MAP_TAB_HELP = 'Para conferir na própria página: clique numa área vazia e use a tecla Tab. A ordem da lista é uma estimativa tirada do código da página, não uma observação da tecla Tab.';

const KIND_LABELS = Object.freeze({
  link: 'link',
  button: 'botão',
  field: 'campo',
  summary: 'resumo de seção que abre e fecha',
  media: 'vídeo ou áudio com controles',
  frame: 'área de conteúdo incorporada',
  contenteditable: 'área de texto editável',
  tabindex: 'item marcado para receber o Tab',
});

const REASON_LABELS = Object.freeze({
  'keyboard-rule': 'verificação automática de teclado apontou este item',
  'interactive-role': 'declara função interativa e mesmo assim não recebe o Tab',
  'cursor-pointer': 'mostra a seta de clique e mesmo assim não recebe o Tab',
});

// O achado de conteúdo só com mouse diz exatamente o que a pessoa vai ver ao passar o mouse no cartão.
const HOVER_ONLY_REASON = 'abre opções só quando o mouse passa por cima; o Tab não chega até elas';

const LIMITATIONS = Object.freeze({
  'tab-order-estimated-not-observed': 'A ordem da lista é estimada pelo código da página; não foi observada pressionando Tab.',
  'top-document-open-shadow-only': 'A lista cobre o documento principal e o Shadow DOM aberto.',
  'closed-shadow-root-omitted': 'Conteúdo dentro de Shadow DOM fechado não entra na lista.',
  'frame-content-omitted': 'O conteúdo de frames internos não entra na lista.',
  'non-uniform-pixel-scale': 'As escalas horizontal e vertical da captura não são uniformes.',
  'stops-outside-source-clamped': 'Itens fora da área capturada foram encaixados na borda da imagem.',
  'ancestor-clipped-stops-omitted': 'Itens escondidos por uma área com rolagem própria ficaram fora da lista.',
  'cursor-style-not-collected': 'O estilo que revela itens clicáveis não foi coletado nesta auditoria; a lista de caixas laranja pode estar incompleta.',
  'privacy-content-omitted': 'O nome de itens com conteúdo possivelmente pessoal foi omitido; as posições continuam na imagem.',
  'stop-limit-reached': 'O limite de posições de Tab foi atingido.',
  'suspect-limit-reached': 'O limite de itens suspeitos foi atingido.',
  'badge-overlap-unresolved': 'Algumas etiquetas numéricas permaneceram sobrepostas.',
});

/** Frase única para as duas rotas de relatório: leigos leem "1 lugar", não "1 lugares". */
export function keyboardMapCountsText(counts) {
  const stops = `${counts.stops} ${counts.stops === 1 ? 'lugar onde o Tab para' : 'lugares onde o Tab para'}`;
  const suspects = `${counts.suspects} ${counts.suspects === 1
    ? 'item que parece clicável e o Tab não alcança'
    : 'itens que parecem clicáveis e o Tab não alcança'}`;
  return `${stops}; ${suspects}.`;
}

function localSegmentImage(segment) {
  try {
    const png = decodePngDataUrl(segment.dataUrl);
    return png.width === segment.width && png.height === segment.height ? segment.dataUrl : null;
  } catch { return null; }
}

function visibleAuditedText(value) {
  return String(value ?? '').replace(/[؜‎‏‪-‮⁦-⁩]/gu,
    character => `⟦U+${character.codePointAt(0).toString(16).toUpperCase()}⟧`);
}

function entryName(entry) {
  const name = visibleAuditedText(entry.name).trim();
  if (name !== '') return name;
  return entry.nameStatus === 'omitted-privacy' ? 'Nome omitido por privacidade' : 'Sem nome visível';
}

function entryLocation(entry) {
  return entry.segmentIndex > 0
    ? `Trecho ${entry.segmentIndex} da imagem.`
    : 'Sem imagem nesta auditoria; posição estimada no documento.';
}

/** Presentation only: callers supply maps from the validated, immutable ReportView. */
export function keyboardMapPresentation(pages, maps) {
  const byPage = new Map(maps.map(map => [map.pageId, map]));
  return pages.map((page, index) => {
    const map = byPage.get(page.pageId);
    const identity = { pageId: page.pageId, title: `Página ${index + 1}` };
    if (!map) return {
      ...identity, status: 'absent', summary: 'Mapa do teclado não coletado nesta auditoria. Consulte as limitações do modo escolhido.',
      counts: null, stops: [], suspects: [], limitations: [], segments: [], provenance: [],
    };
    const counts = map.counts;
    const stops = map.stops.map(entry => ({
      number: entry.number, name: entryName(entry),
      kind: KIND_LABELS[entry.kind] ?? entry.kind,
      location: entryLocation(entry), nodeId: entry.nodeId,
    }));
    const suspects = map.suspects.map(entry => ({
      number: entry.number, name: entryName(entry),
      reason: (entry.ruleId === 'hover-only-interactive-content' ? HOVER_ONLY_REASON : null) ??
        REASON_LABELS[entry.reason] ?? entry.reason,
      location: entryLocation(entry), nodeId: entry.nodeId,
    }));
    return {
      ...identity, status: map.status,
      summary: map.status === 'empty'
        ? 'Nada alcançável pelo Tab foi encontrado nesta página. Isso não significa conformidade: confira na própria página.'
        : map.status === 'partial'
          ? 'Mapa gerado com cobertura parcial. Leia as limitações antes de concluir.'
          : 'Mapa gerado. Procure cada número na imagem e leia o item correspondente na lista.',
      counts: { eligible: counts.eligible, stops: counts.stops, suspects: counts.suspects },
      coverage: `${counts.stops} de ${counts.eligible} itens que o Tab alcança foram marcados; ${counts.suspects} itens parecem clicáveis sem receber o Tab; ${counts.omittedNotVisible} ficaram fora por não estarem visíveis; ${counts.omittedNoRect} por não terem posição medida; ${counts.omittedClipped} por estarem escondidos por rolagem interna; ${counts.omittedFrame} por estarem em frames; ${counts.omittedLimit} pelo limite da lista.`,
      limitations: map.limitations.map(code => LIMITATIONS[code] ?? code),
      segments: map.segments.map(segment => ({
        id: segment.segmentId, index: segment.index, width: segment.width, height: segment.height,
        dataUrl: localSegmentImage(segment),
        caption: `Trecho ${segment.index} de ${segment.count} da imagem do mapa.`,
      })),
      stops,
      suspects,
      provenance: [
        ['Artefato derivado', map.evidenceId], ['Captura original preservada', map.fullPageEvidenceId],
        ['Hash da captura original', map.derivation.sourceHash], ['Hash derivado', map.hash],
        ['Algoritmo', `${map.derivation.algorithm} ${map.derivation.version}`],
        ['Limites', `${map.limits.maxStops} posições de Tab; ${map.limits.maxSuspects} itens suspeitos; ${map.limits.maxSegments} trechos.`],
        ...map.segments.map(segment => [`Hash do trecho ${segment.index}`, segment.contentHash]),
      ],
    };
  });
}
