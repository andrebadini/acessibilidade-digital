/**
 * Decisão "as caixas deste mapa podem ser desenhadas?" e as métricas que o mapa usa para converter
 * retângulo em pixel de imagem.
 *
 * Até a 1.1.61 a pergunta era "a captura e a LEITURA ESTRUTURAL descrevem o mesmo leiaute?" e um "não"
 * deixava o mapa inteiro sem caixa nenhuma. Só que a leitura estrutural acontece segundos antes da
 * captura, e em página que se monta aos poucos (carrossel, carga preguiçosa, banner de consentimento) a
 * resposta era "não" quase sempre: o resultado era a imagem sem marcação que o dono do produto viu.
 *
 * Desde a 1.1.62 os retângulos NÃO vêm mais da leitura estrutural: vêm de uma medição feita logo depois
 * da captura, no mesmo leiaute que a imagem mostra (ver `fresh-geometry.js`). A pergunta virou "a
 * geometria fresca existe e o leiaute ficou parado em volta dela?" — e quem responde não é mais a altura
 * da leitura antiga, e sim duas comparações curtas de `Page.getLayoutMetrics`:
 *
 * - em volta da CAPTURA: se a própria captura mexeu no documento (uma página que reage a `resize`, por
 *   exemplo), a imagem não corresponde a nenhum estado observável e desenhar seria adivinhar;
 * - em volta da MEDIÇÃO fresca: se a página cresceu enquanto os retângulos eram medidos, a própria
 *   medição é incoerente.
 *
 * Quando alguma dessas comparações falha, o mapa sai sem caixa nenhuma e com a limitação declarada —
 * comportamento raro agora, e o mesmo de antes: melhor sem caixa do que com caixa no lugar errado.
 *
 * Uma condição para que as duas comparações digam a verdade: a largura. `captureBeyondViewport` tira a
 * barra de rolagem clássica e o conteúdo fica ~15 px mais largo, o que muda a altura de tudo que depende da
 * largura (uma imagem `width:100%`, por exemplo) e faria as duas comparações acusarem a PÁGINA por um
 * rearranjo da própria captura. Quem resolve isso não é este módulo: é `establishWidenedLayout`, que fixa o
 * estado alargado ANTES de a auditoria ler as métricas do instante (`captureMetrics`). Chegando aqui, as
 * três leituras estão no mesmo estado e qualquer diferença é mesmo da página.
 *
 * A altura que o mapa usa é a da IMAGEM, não a do documento: a captura integral é truncada pelo teto de
 * segurança de 16.384 px de dispositivo, e o mapa tem de descrever a área que existe em pixels.
 */
import {
  SOURCE_LAYOUT_HEIGHT_TOLERANCE_PX,
  SOURCE_LAYOUT_WIDTH_TOLERANCE_PX,
  contentSizeOf,
  layoutAgreement,
} from './fresh-geometry.js';

export { SOURCE_LAYOUT_HEIGHT_TOLERANCE_PX, SOURCE_LAYOUT_WIDTH_TOLERANCE_PX, contentSizeOf };

/**
 * Métricas de leiaute do instante da captura, prontas para os mapas, e o veredito de alinhamento.
 *
 * Entradas:
 * - `captureMetrics`: o estado cujo recorte a captura pediu;
 * - `captureMetricsAfter`: o estado logo depois da captura, que prova que a captura não mexeu no leiaute;
 * - `measurementMetrics`: o estado logo depois da medição fresca, que prova que a página não cresceu
 *   enquanto os retângulos eram medidos;
 * - `imageSize`: tamanho em px CSS da imagem capturada (`metadata` da captura) — é ele que manda na
 *   escala do mapa, porque é ele que descreve a área que existe em pixels;
 * - `freshRectCount`: quantos nós a medição fresca devolveu; zero significa que não há o que desenhar.
 */
export function mapSourceGeometry({
  captureMetrics = {}, captureMetricsAfter = null, measurementMetrics = null, imageSize = null,
  freshRectCount = 0, capturedHeight = null, deviceScaleFactor = null,
} = {}) {
  const before = contentSizeOf(captureMetrics);
  const captureAgreement = layoutAgreement(captureMetrics, captureMetricsAfter);
  const measurementAgreement = layoutAgreement(captureMetricsAfter, measurementMetrics);
  const declared = imageSize ? contentSizeOf({ cssContentSize: imageSize }) : null;
  const truncated = Number.isFinite(capturedHeight) && capturedHeight > 0;
  // A imagem manda: quando o teto de captura cortou a página, é a altura da imagem que o mapa cobre.
  const cssSize = declared ?? (before && truncated ? { ...before, height: capturedHeight } : before);
  const fresh = Number.isSafeInteger(freshRectCount) && freshRectCount > 0;
  const reason = captureAgreement.reason === 'size-unavailable' ? 'capture-size-unavailable'
    : !fresh ? 'fresh-geometry-unavailable'
      : !captureAgreement.stable ? 'capture-moved-layout'
        : measurementAgreement.reason === 'size-unavailable' ? 'measurement-size-unavailable'
          : !measurementAgreement.stable ? 'measurement-moved-layout'
            : 'aligned';
  // As diferenças relatadas são as da comparação que decidiu o veredito: relatar as da captura quando quem
  // recusou foi a medição apontaria para o lado errado do intervalo.
  const deciding = reason.startsWith('measurement-') ? measurementAgreement : captureAgreement;
  return {
    // O recorte da captura saiu destas métricas; o tamanho declarado pela imagem substitui o do documento
    // quando ele é menor (teto de captura) e a escala do mapa descreve a imagem que existe.
    layoutMetrics: {
      ...captureMetrics,
      ...(cssSize ? { cssContentSize: { ...cssSize } } : {}),
      ...(Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0 ? { deviceScaleFactor } : {}),
    },
    aligned: reason === 'aligned',
    truncated,
    widthDrift: deciding.widthDrift,
    heightDrift: deciding.heightDrift,
    freshRectCount: fresh ? freshRectCount : 0,
    reason,
  };
}
