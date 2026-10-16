/**
 * Geometria fresca: o retângulo de cada elemento medido no MESMO estado da imagem.
 *
 * O problema que este módulo resolve é o do mapa sem caixa nenhuma. A leitura estrutural (árvore DOM +
 * acessibilidade) leva segundos: quando a captura integral saía depois dela, os retângulos lidos podiam
 * ser de um leiaute que a imagem não mostra mais — carrossel que trocou de slide, lista que se completou,
 * banner de consentimento que apareceu. Comparar a altura do documento nos dois instantes e desistir do
 * mapa inteiro (regra da 1.1.60) trocava "caixa no lugar errado" por "nenhuma caixa", e em página que se
 * monta sozinha isso acontece quase sempre.
 *
 * A saída é não desistir: logo depois da captura integral — no leiaute que a imagem acabou de mostrar —
 * medir DE NOVO os retângulos, numa única chamada em lote ao navegador (o `DOMSnapshot.captureSnapshot`
 * sem estilos computados; nunca uma ida por elemento). Os retângulos frescos entram no lugar dos lidos
 * segundos antes, e quem sumiu simplesmente não é desenhado.
 *
 * Duas decisões que valem registro, as duas medidas no Chrome 152 contra a imagem de verdade:
 *
 * 1. A medição é feita DEPOIS da captura, não antes. `captureBeyondViewport` amplia a área de renderização
 *    e a página se reacomoda (a barra de rolagem clássica deixa de existir durante a captura): medido, um
 *    elemento ancorado à direita ficava em x=1165 antes e em x=1180 depois, e a imagem mostra 1180. O
 *    estado que a imagem mostra é o de depois — e é por isso que o estado alargado é fixado ANTES de a
 *    auditoria medir o instante da captura (`establishWidenedLayout`): se a página se reacomodar no meio do
 *    caminho (conteúdo que chega depois da leitura, que é o caso desta tarefa), a barra volta, o leiaute
 *    alarga de novo na hora da captura e as leituras antes e depois da imagem discordariam por causa da
 *    própria captura, não da página.
 * 2. `position: fixed` e `sticky` não precisam de tratamento especial: o retângulo do instantâneo já vem
 *    em px de documento (posição de viewport + rolagem) e é exatamente onde a captura integral os pinta.
 *    Medido com a página rolada a 800 px: a barra fixa aparece na imagem em y=800, e o instantâneo diz 800.
 *
 * Nada aqui decide o que desenhar: este módulo só mede, casa por `backendNodeId` e devolve o instantâneo
 * com os retângulos trocados. Quem decide o que fazer com um nó que sumiu é o compositor de cada mapa.
 */

/**
 * Diferença de altura tolerada entre duas leituras de leiaute, em px CSS.
 *
 * Oito pixels é menor que a menor caixa desenhada e some sob o traço com halo; o desalinhamento que
 * motivou esta checagem media milhares de pixels (a página tinha 757 px de altura na captura e
 * 3.121 px na leitura).
 */
export const SOURCE_LAYOUT_HEIGHT_TOLERANCE_PX = 8;

/** A largura muda em dezenas de px quando uma barra de rolagem aparece: tolerância de 1 px. */
export const SOURCE_LAYOUT_WIDTH_TOLERANCE_PX = 1;

function finitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

/** Tamanho da área de conteúdo declarado pelas métricas do CDP, quando utilizável. */
export function contentSizeOf(metrics) {
  const size = metrics?.cssContentSize || metrics?.contentSize;
  if (!size) return null;
  // Sem coerção: as métricas vêm do CDP e um valor de outro tipo é ausência de medida, não uma medida a
  // ser adivinhada.
  const width = size.width;
  const height = size.height;
  return finitePositive(width) && finitePositive(height) ? { width, height } : null;
}

/** Retângulo utilizável em px CSS de documento, ou `null`. */
function usableRect(bounds) {
  if (!Array.isArray(bounds) || bounds.length < 4) return null;
  const [x, y, width, height] = bounds;
  if (![x, y, width, height].every(Number.isFinite) || !finitePositive(width) || !finitePositive(height)) return null;
  return { x, y, width, height };
}

function stringAt(strings, value) {
  return Number.isInteger(value) && value >= 0 && value < strings.length ? strings[value] : '';
}

/** Id do frame do documento principal, quando o instantâneo estrutural o informou. */
export function snapshotFrameId(snapshot) {
  for (const node of Array.isArray(snapshot?.nodes) ? snapshot.nodes : []) {
    if (typeof node?.frameId === 'string' && node.frameId !== '') return node.frameId;
  }
  return null;
}

/**
 * Retângulos em px CSS de documento dos nós do documento principal, indexados por `backendNodeId`.
 *
 * Devolve `null` quando a captura não traz nada utilizável (sem documentos, sem árvore de leiaute ou sem
 * nenhum `backendNodeId`): quem chama trata isso como "não há geometria fresca" e não desenha caixa
 * nenhuma — o comportamento honesto de sempre.
 *
 * O documento principal é o que casa com `frameId`; sem ele, o primeiro documento da captura, que é a
 * convenção já usada pela normalização do instantâneo. Retângulos de dentro de frames ficam de fora: eles
 * estão no sistema de coordenadas do próprio frame, e os mapas não desenham conteúdo de frame.
 */
export function domSnapshotRects(capture, { frameId = null } = {}) {
  const documents = Array.isArray(capture?.documents) ? capture.documents : null;
  const strings = Array.isArray(capture?.strings) ? capture.strings : null;
  if (!documents || !strings || documents.length === 0) return null;
  const main = (typeof frameId === 'string' && frameId !== ''
    ? documents.find(document => stringAt(strings, document?.frameId) === frameId)
    : null) ?? documents[0];
  const nodes = main?.nodes;
  const layout = main?.layout;
  if (!nodes || !Array.isArray(nodes.nodeType) || !Array.isArray(layout?.nodeIndex) || !Array.isArray(layout?.bounds)) return null;
  const rectByLayoutIndex = new Map();
  layout.nodeIndex.forEach((nodeIndex, offset) => {
    if (Number.isInteger(nodeIndex)) rectByLayoutIndex.set(nodeIndex, layout.bounds[offset]);
  });
  const rects = new Map();
  for (let index = 0; index < nodes.nodeType.length; index += 1) {
    const backendNodeId = nodes.backendNodeId?.[index];
    if (!Number.isInteger(backendNodeId)) continue;
    const rect = usableRect(rectByLayoutIndex.get(index));
    if (rect) rects.set(backendNodeId, rect);
  }
  return rects.size > 0 ? rects : null;
}

/**
 * Cópia rasa do instantâneo com os retângulos trocados pelos frescos.
 *
 * Regras, na ordem:
 * - Nó de frame interno: fica como está (os mapas não o desenham).
 * - Nó com retângulo e `backendNodeId` medido agora: recebe o retângulo fresco.
 * - Nó com retângulo e `backendNodeId` ausente da medição — sumiu, ficou escondido ou perdeu a caixa:
 *   fica SEM retângulo. É assim que a caixa dele deixa de ser desenhada sem levar as outras junto; quem
 *   conta a omissão é a seleção de cada mapa.
 * - Nó sem `backendNodeId` na leitura estrutural: fica como está. Isso só acontece em instantâneo
 *   sintético (fixture), onde não há o que casar; num instantâneo de navegador o `backendNodeId` sempre
 *   existe.
 *
 * O instantâneo de entrada não é alterado: a auditoria guarda o original como evidência estrutural, e só
 * os mapas usam esta cópia.
 *
 * @returns {{snapshot: object, applied: boolean, replaced: number, dropped: Set<string>}}
 *   `dropped` traz os `nodeId` que perderam o retângulo, para quem quiser declarar a omissão em texto.
 */
export function withFreshRects(snapshot, rects) {
  const applied = rects instanceof Map && rects.size > 0;
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  if (!applied) return { snapshot, applied: false, replaced: 0, dropped: new Set() };
  const dropped = new Set();
  let replaced = 0;
  const next = nodes.map(node => {
    if (!node || typeof node !== 'object' || !node.rect) return node;
    if (Array.isArray(node.framePath) && node.framePath.length > 0) return node;
    if (!Number.isInteger(node.backendNodeId)) return node;
    const fresh = rects.get(node.backendNodeId);
    if (fresh) {
      replaced += 1;
      return { ...node, rect: { ...fresh } };
    }
    dropped.add(String(node.nodeId));
    const { rect, ...rest } = node;
    return rest;
  });
  if (replaced === 0 && dropped.size === 0) return { snapshot, applied: false, replaced: 0, dropped };
  return { snapshot: { ...snapshot, nodes: next }, applied: true, replaced, dropped };
}

/**
 * O leiaute ficou parado entre duas leituras de métricas de leiaute?
 *
 * Usada em dois pontos do mesmo intervalo: em volta da captura (a captura em si não pode ter mexido na
 * página) e em volta da medição fresca (a página não pode ter crescido enquanto era medida).
 */
export function layoutAgreement(left, right) {
  const before = contentSizeOf(left);
  const after = contentSizeOf(right);
  if (!before || !after) return { stable: false, widthDrift: null, heightDrift: null, reason: 'size-unavailable' };
  const widthDrift = Math.abs(before.width - after.width);
  const heightDrift = Math.abs(before.height - after.height);
  return {
    stable: widthDrift <= SOURCE_LAYOUT_WIDTH_TOLERANCE_PX && heightDrift <= SOURCE_LAYOUT_HEIGHT_TOLERANCE_PX,
    widthDrift,
    heightDrift,
    reason: 'measured',
  };
}
