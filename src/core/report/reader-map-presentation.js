import { annotationCode, annotationMapReadRules } from '../evidence/annotation-map-artifact.js';
import { decodePngDataUrl } from '../evidence/png.js';

/**
 * Título e explicação do mapa atual. O título vive num cabeçalho próprio (`h3`) para que ele seja o
 * nome da seção na navegação por cabeçalhos do leitor de tela; a explicação é a frase leiga que
 * acompanha o mapa no relatório inteiro — aberto no painel, no HTML entregue e no PDF.
 */
export const READER_MAP_TITLE = 'Mapa de leitura da página';

export const READER_MAP_INTRO = 'Cada caixa marca um elemento da página e o código (L1, L2…) leva ao texto que um leitor de tela falaria, na coluna da direita. As prévias são estimativas, não transcrições literais de tecnologia assistiva; a ordem DOM/AX observada não é a ordem de foco.';

/**
 * Apresentação do mapa anterior à 1.3.0: os números ficavam dentro da imagem, junto da legenda raster.
 * Auditorias guardadas naquela versão continuam abrindo exatamente como foram geradas.
 */
export const READER_MAP_LEGACY_INTRO = 'Mapa visual da prévia de anúncios: os números ligam cada elemento à legenda. As prévias são estimativas, não transcrições literais de tecnologia assistiva; a ordem DOM/AX observada não é a ordem de foco.';

const LIMITATIONS = Object.freeze({
  'observed-dom-ax-order-not-literal-assistive-technology': 'A ordem e os anúncios são estimativas do estado observado, não uma reprodução de leitor de tela.',
  'non-atomic-source-geometry': 'A captura e a geometria são lidas em passos separados. A diferença entre elas é medida, e o mapa não marca quando passa da tolerância.',
  'top-document-open-shadow-only': 'O mapa cobre o documento principal e Shadow DOM aberto.',
  'rasterization-browser-dependent': 'A aparência pode variar conforme o navegador e o sistema operacional.',
  'source-capture-may-contain-personal-data': 'A captura original pode conter dados pessoais visíveis.',
  'frame-content-omitted': 'O conteúdo interno de frames não foi anotado.',
  'closed-shadow-root-omitted': 'O conteúdo de Shadow DOM fechado não foi anotado.',
  'container-replaced-by-annotated-descendant': 'Contêineres com elementos internos anotados aparecem representados por esses elementos internos.',
  'node-limit-reached': 'O limite de elementos anotados foi atingido.',
  'legend-limit-reached': 'O limite de legenda ou segmentos foi atingido.',
  'unresolved-marker-overlap': 'Alguns marcadores permaneceram sobrepostos.',
  'ancestor-clipped-elements-omitted': 'Elementos escondidos por uma área com rolagem própria não foram anotados.',
  'non-uniform-pixel-scale': 'As escalas horizontal e vertical da captura não são uniformes.',
  'source-layout-changed': 'A página mudou de tamanho enquanto era verificada. Para não apontar o lugar errado, nenhum código foi desenhado na imagem.',
});

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

/** A versão declarada decide o formato: caixa com código (1.3.0) ou número dentro da imagem (até 1.2.0). */
function mapFormat(map) {
  try {
    return annotationMapReadRules(map?.derivation?.version).badge === true ? 'reading-codes' : 'numbered-preview';
  } catch {
    // Versão desconhecida nunca chega aqui: o artefato foi validado antes de virar ReportView. Um mapa
    // ilegível cai na apresentação antiga, que só desenha o que já está no PNG guardado.
    return 'numbered-preview';
  }
}

function segmentCaption(format, segment, count, codes) {
  if (format === 'reading-codes') {
    const scope = codes.length ? `códigos ${codes.join(', ')}` : 'sem elemento marcado neste recorte';
    return `Segmento ${segment.index} de ${count}: ${scope}.`;
  }
  const scope = segment.role === 'legend-continuation' ? 'continuação da legenda'
    : codes.length === 1 ? `marcador ${codes[0]}` : `marcadores ${codes.join(', ') || 'ausentes neste recorte'}`;
  return `Segmento ${segment.index} de ${count}: ${scope}.`;
}

function provenanceOf(map) {
  return [
    ['Artefato derivado', map.evidenceId], ['Captura original preservada', map.fullPageEvidenceId],
    ['Hash da captura original', map.derivation.sourceHash], ['Hash derivado', map.hash],
    ['Hash da geometria', map.derivation.geometrySnapshotHash],
    ['Algoritmo', `${map.derivation.algorithm} ${map.derivation.version}`],
    ['Limites', `${map.limits.maxNodes} elementos; ${map.limits.maxSegments} segmentos; ${map.limits.maxDerivedBytes} bytes derivados; ${map.limits.maxLegendCodePoints} pontos de código da legenda.`],
    ...map.segments.map(segment => [`Hash do segmento ${segment.index}`, segment.contentHash]),
  ];
}

function coverageText(imageAnnotated, counts) {
  if (!imageAnnotated) {
    return `${counts.eligible} ${counts.eligible === 1 ? 'elemento era elegível' : 'elementos eram elegíveis'}, mas nenhum foi marcado: a página mudou de tamanho durante a verificação.`;
  }
  return `${counts.annotated} de ${counts.eligible} elementos elegíveis anotados; ${counts.omittedFrame} contextos de frame omitidos; `
    + `${counts.omittedNoRect} elementos sem geometria; ${counts.omittedClipped ?? 0} escondidos por rolagem interna; `
    + `${counts.omittedLimit} omitidos por limite; ${counts.unresolvedOverlap} sobreposições não resolvidas.`;
}

function summaryText(map, imageAnnotated, format) {
  if (!imageAnnotated) {
    return format === 'reading-codes'
      ? 'A página mudou de tamanho enquanto era verificada. Para não apontar o lugar errado, nenhum elemento foi marcado nesta página.'
      : 'A página mudou de tamanho enquanto era verificada. Para não apontar o lugar errado, nenhum anúncio foi marcado nesta página.';
  }
  if (map.status === 'empty') return 'Nenhum elemento elegível foi encontrado. Isso não significa conformidade da página.';
  if (map.status === 'partial') return 'Mapa gerado com cobertura parcial. Consulte as omissões registradas.';
  return format === 'reading-codes'
    ? 'Mapa gerado. Localize o código na imagem e leia o texto correspondente na coluna ao lado.'
    : 'Mapa gerado. Localize o número na imagem e leia o anúncio correspondente na legenda.';
}

/** Presentation only: callers supply maps from the validated, immutable ReportView. */
export function readerMapPresentation(pages, maps) {
  const byPage = new Map(maps.map(map => [map.pageId, map]));
  return pages.map((page, index) => {
    const map = byPage.get(page.pageId);
    const identity = { pageId: page.pageId, title: `Página ${index + 1} — ${page.pageId}` };
    if (!map) return {
      ...identity, format: 'reading-codes', status: 'absent',
      summary: 'Mapa não coletado nesta auditoria. Consulte as evidências e as limitações do modo escolhido.',
      coverage: null, limitations: [], segments: [], legend: [], provenance: [],
    };
    const format = mapFormat(map);
    const counts = map.counts;
    // Sem geometria confiável este mapa não tem o que mostrar: o mapa é a própria marcação desenhada,
    // então não há código para ligar a um texto. O relatório diz exatamente isso, em vez de prometer uma
    // imagem marcada que não existe.
    const imageAnnotated = !map.limitations.includes('source-layout-changed');
    const codeOf = number => format === 'reading-codes' ? annotationCode(number) : String(number);
    const legend = map.legend.map(entry => ({
      number: entry.number, code: codeOf(entry.number), segmentIndex: entry.segmentIndex,
      preview: visibleAuditedText(entry.announcementPreview),
      location: visibleAuditedText(`Elemento ${entry.selectorSummary}; origem do nome: ${entry.nameSource}; marcador no segmento ${entry.segmentIndex}.`),
    }));
    return {
      ...identity, format, status: map.status,
      summary: summaryText(map, imageAnnotated, format),
      coverage: coverageText(imageAnnotated, counts),
      limitations: map.limitations.map(code => LIMITATIONS[code] ?? code),
      segments: map.segments.map(segment => {
        // A legenda de cada trecho sai da lista completa: o código do elemento é desenhado no segmento em
        // que o centro dele caiu, e a coluna ao lado acompanha esse trecho.
        const entries = legend.filter(entry => entry.segmentIndex === segment.index);
        return {
          id: segment.segmentId, index: segment.index, role: segment.role,
          width: segment.width, height: segment.height,
          dataUrl: localSegmentImage(segment),
          caption: segmentCaption(format, segment, segment.count, entries.map(entry => entry.code)),
          entries,
        };
      }),
      legend,
      provenance: provenanceOf(map),
    };
  });
}
