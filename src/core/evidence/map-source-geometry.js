/**
 * Acordo de leiaute entre a captura integral e a leitura estrutural.
 *
 * Os mapas desenham retângulos lidos do instantâneo sobre a captura integral. A captura e a leitura
 * não são o mesmo instante: a leitura (DOMSnapshot + árvore de acessibilidade) leva segundos numa
 * página grande, e a página continua montando o leiaute enquanto isso — cabeçalho que encolhe,
 * carrossel que cresce, imagem com carga preguiçosa. Se o documento muda de altura entre uma coisa e
 * outra, converter o retângulo pela escala da captura põe a caixa no lugar errado, e para quem lê o
 * relatório uma caixa errada é pior que caixa nenhuma.
 *
 * Aqui mora só a pergunta "a captura e a leitura descrevem o mesmo leiaute?" e a montagem das
 * métricas que os mapas usam para converter retângulo em pixel de imagem. Quem decide o que fazer com
 * um "não" é o compositor de cada mapa.
 */

/**
 * Diferença de altura tolerada entre a captura e a leitura, em CSS px.
 *
 * Oito pixels é menor que a menor caixa desenhada e some sob o traço com halo; o desalinhamento que
 * motivou esta checagem media milhares de pixels (a página tinha 757 px de altura na captura e
 * 3.121 px na leitura).
 */
export const SOURCE_LAYOUT_HEIGHT_TOLERANCE_PX = 8;

/** A largura muda em dezenas de px quando uma barra de rolagem aparece: tolerância de 1 px. */
export const SOURCE_LAYOUT_WIDTH_TOLERANCE_PX = 1;

/** Tamanho da área de conteúdo declarado por `Page.getLayoutMetrics`, quando utilizável. */
export function contentSizeOf(metrics) {
  const size = metrics?.cssContentSize || metrics?.contentSize;
  if (!size) return null;
  // Sem coerção, como em `captureContentSize`: as métricas vêm do CDP e um valor de outro tipo é ausência
  // de medida, não uma medida a ser adivinhada.
  const width = size.width;
  const height = size.height;
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 ? { width, height } : null;
}

/**
 * A captura e a leitura descrevem o mesmo leiaute?
 *
 * `aligned: false` também cobre o caso em que um dos lados não informou tamanho: sem os dois números
 * não há como provar que a caixa cairia no lugar certo.
 */
export function sourceLayoutAgreement(sourceMetrics, observedMetrics) {
  const source = contentSizeOf(sourceMetrics);
  const observed = contentSizeOf(observedMetrics);
  if (!source || !observed) return { aligned: false, widthDrift: null, heightDrift: null, reason: 'size-unavailable' };
  const widthDrift = Math.abs(source.width - observed.width);
  const heightDrift = Math.abs(source.height - observed.height);
  return {
    aligned: widthDrift <= SOURCE_LAYOUT_WIDTH_TOLERANCE_PX && heightDrift <= SOURCE_LAYOUT_HEIGHT_TOLERANCE_PX,
    widthDrift,
    heightDrift,
    reason: 'measured',
  };
}

/**
 * Métricas de leiaute da captura, prontas para os mapas, e o veredito de alinhamento.
 *
 * `captureMetrics` é o estado cujo recorte a captura pediu; `captureMetricsAfter` prova que a própria
 * captura não mexeu no leiaute (`captureBeyondViewport` redimensiona a área de captura, e uma página
 * que reage a isso deixa a imagem sem correspondência com nenhum estado observável). `observedMetrics`
 * é o estado da leitura estrutural, de onde vêm os retângulos.
 *
 * A altura capturada entra no lugar da altura observada quando a captura foi truncada pelo teto de
 * segurança: o mapa passa a cobrir a área que existe na imagem, e a truncagem é declarada à parte.
 */
export function mapSourceGeometry({
  captureMetrics = {}, captureMetricsAfter = null, observedMetrics = {}, capturedHeight = null, deviceScaleFactor = null,
} = {}) {
  const before = contentSizeOf(captureMetrics);
  const after = contentSizeOf(captureMetricsAfter);
  const agreement = sourceLayoutAgreement(captureMetrics, observedMetrics);
  const comparable = Boolean(before && after);
  const captureStable = comparable && Math.abs(after.width - before.width) <= SOURCE_LAYOUT_WIDTH_TOLERANCE_PX &&
    Math.abs(after.height - before.height) <= SOURCE_LAYOUT_HEIGHT_TOLERANCE_PX;
  const truncated = Number.isFinite(capturedHeight) && capturedHeight > 0;
  const cssSize = before && truncated ? { ...before, height: capturedHeight } : before;
  const reason = !agreement.aligned ? agreement.reason
    : captureStable ? 'aligned'
      : comparable ? 'capture-moved-layout' : 'capture-size-unavailable';
  return {
    // O recorte da captura saiu destas métricas; a altura capturada substitui a observada quando houve
    // truncagem, para a escala do mapa descrever a imagem que existe.
    layoutMetrics: {
      ...captureMetrics,
      ...(cssSize ? { cssContentSize: { ...cssSize } } : {}),
      ...(Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0 ? { deviceScaleFactor } : {}),
    },
    aligned: agreement.aligned && captureStable,
    truncated,
    widthDrift: agreement.widthDrift,
    heightDrift: agreement.heightDrift,
    reason,
  };
}
