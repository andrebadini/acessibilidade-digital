import { decodePngDataUrl } from '../evidence/png.js';

export const READER_MAP_INTRO = 'Mapa visual da prévia de anúncios: os números ligam cada elemento à legenda. As prévias são estimativas, não transcrições literais de tecnologia assistiva; a ordem DOM/AX observada não é a ordem de foco.';

const LIMITATIONS = Object.freeze({
  'observed-dom-ax-order-not-literal-assistive-technology': 'A ordem e os anúncios são estimativas do estado observado, não uma reprodução de um leitor de tela.',
  'non-atomic-source-geometry': 'A captura e a geometria foram coletadas em instantes distintos.',
  'top-document-open-shadow-only': 'O mapa cobre o documento principal e Shadow DOM aberto.',
  'rasterization-browser-dependent': 'A aparência pode variar conforme o navegador e o sistema operacional.',
  'source-capture-may-contain-personal-data': 'A captura original pode conter dados pessoais visíveis.',
  'frame-content-omitted': 'O conteúdo interno de frames não foi anotado.',
  'closed-shadow-root-omitted': 'O conteúdo de Shadow DOM fechado não foi anotado.',
  'container-replaced-by-annotated-descendant': 'Contêineres com elementos internos anotados aparecem representados por esses elementos internos.',
  'node-limit-reached': 'O limite de elementos anotados foi atingido.',
  'legend-limit-reached': 'O limite de legenda ou segmentos foi atingido.',
  'unresolved-marker-overlap': 'Alguns marcadores permaneceram sobrepostos.',
  'non-uniform-pixel-scale': 'As escalas horizontal e vertical da captura não são uniformes.',
});

function localSegmentImage(segment) {
  try {
    const png = decodePngDataUrl(segment.dataUrl);
    return png.width === segment.width && png.height === segment.height ? segment.dataUrl : null;
  } catch { return null; }
}

function visibleAuditedText(value) {
  return String(value ?? '').replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu,
    character => `⟦U+${character.codePointAt(0).toString(16).toUpperCase()}⟧`);
}

/** Presentation only: callers supply maps from the validated, immutable ReportView. */
export function readerMapPresentation(pages, maps) {
  const byPage = new Map(maps.map(map => [map.pageId, map]));
  return pages.map((page, index) => {
    const map = byPage.get(page.pageId);
    const identity = { pageId: page.pageId, title: `Página ${index + 1} — ${page.pageId}` };
    if (!map) return {
      ...identity, status: 'absent', summary: 'Mapa não coletado nesta auditoria. Consulte as evidências e as limitações do modo escolhido.',
      coverage: null, limitations: [], segments: [], legend: [], provenance: [],
    };
    const counts = map.counts;
    return {
      ...identity, status: map.status,
      summary: map.status === 'empty'
        ? 'Nenhum elemento elegível foi encontrado. Isso não significa conformidade da página.'
        : map.status === 'partial' ? 'Mapa gerado com cobertura parcial. Consulte as omissões registradas.'
          : 'Mapa gerado. Localize o número na imagem e leia o anúncio correspondente na legenda.',
      coverage: `${counts.annotated} de ${counts.eligible} elementos elegíveis anotados; ${counts.omittedFrame} contextos de frame omitidos; ${counts.omittedNoRect} elementos sem geometria; ${counts.omittedLimit} omitidos por limite; ${counts.unresolvedOverlap} sobreposições não resolvidas.`,
      limitations: map.limitations.map(code => LIMITATIONS[code] ?? code),
      segments: map.segments.map(segment => {
        const markers = map.legend.filter(entry => entry.segmentIndex === segment.index).map(entry => entry.number);
        const scope = segment.role === 'legend-continuation' ? 'continuação da legenda'
          : markers.length === 1 ? `marcador ${markers[0]}` : `marcadores ${markers.join(', ') || 'ausentes neste recorte'}`;
        return {
          id: segment.segmentId, index: segment.index, width: segment.width, height: segment.height,
          dataUrl: localSegmentImage(segment), caption: `Segmento ${segment.index} de ${segment.count}: ${scope}.`,
        };
      }),
      legend: map.legend.map(entry => ({
        number: entry.number, preview: visibleAuditedText(entry.announcementPreview),
        location: visibleAuditedText(`Elemento ${entry.selectorSummary}; origem do nome: ${entry.nameSource}; marcador no segmento ${entry.segmentIndex}.`),
      })),
      provenance: [
        ['Artefato derivado', map.evidenceId], ['Captura original preservada', map.fullPageEvidenceId],
        ['Hash da captura original', map.derivation.sourceHash], ['Hash derivado', map.hash],
        ['Hash da geometria', map.derivation.geometrySnapshotHash],
        ['Algoritmo', `${map.derivation.algorithm} ${map.derivation.version}`],
        ['Limites', `${map.limits.maxNodes} elementos; ${map.limits.maxSegments} segmentos; ${map.limits.maxDerivedBytes} bytes derivados; ${map.limits.maxLegendCodePoints} pontos de código da legenda.`],
        ...map.segments.map(segment => [`Hash do segmento ${segment.index}`, segment.contentHash]),
      ],
    };
  });
}
