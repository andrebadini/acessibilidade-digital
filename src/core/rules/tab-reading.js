/**
 * Leitura por Tab: uma pergunta de revisão humana por parada da sequência estimada de Tab.
 *
 * A regra não julga nada: ela marca cada parada de Tab como ponto a conferir pela pessoa, porque só
 * quem ouve (ou lê) o anúncio do leitor de tela sabe se o que ele fala corresponde ao elemento — o
 * que ele é e o que ele faz. Por isso o resultado é sempre `cantTell` com um alvo por parada, cada
 * um com o `nodeId` da parada, para que a verificação guiada possa mostrar o recorte do elemento.
 *
 * A lista de paradas vem de `selectKeyboardMapStops`, a mesma função que desenha o mapa do teclado:
 * as duas leituras do produto falam da mesma sequência, no mesmo limite de paradas.
 *
 * O item normativo é o 5.13.10 (Componentes com nome acessível, WCAG 4.1.2 — Nome, Função, Valor):
 * é o item do catálogo que trata do nome e da função que o leitor de tela anuncia para um componente.
 */
import { selectKeyboardMapStops } from '../keyboard/keyboard-map-model.js';
import { createRuleRegistry } from './registry.js';
import { result } from './snapshot.js';

export const TAB_READING_RULE_ID = 'tab-reading-announcement';
/** Motivo fechado desta regra: é ele que liga cada alvo ao texto de remediação registrado. */
export const TAB_READING_REASON = 'tab-reading-announcement';
export const TAB_READING_NBR_ITEM = '5.13.10';

/**
 * Texto único do alvo. É a mensagem que a pessoa lê na ocorrência e, ao mesmo tempo, o texto
 * registrado no catálogo fechado de remediação — por isso mora aqui, e o catálogo o importa: os dois
 * não podem divergir, sob pena de invalidar o modelo no fim da auditoria.
 */
export const TAB_READING_MESSAGE =
  'Confira, neste ponto da sequência de Tab, se o que o leitor de tela fala corresponde ao elemento.';

const SUMMARY = 'O que o leitor de tela anuncia em cada parada de Tab depende de conferência humana.';
const NO_STOPS = 'Não há paradas de Tab observáveis para conferir a leitura por Tab nesta página.';

function tabReadingAnnouncement(snapshot) {
  let stops;
  try {
    stops = selectKeyboardMapStops(snapshot, {}).stops;
  } catch {
    stops = null;
  }
  if (!Array.isArray(stops)) {
    return result('cantTell', 'A sequência estimada de Tab não pôde ser calculada nesta auditoria.', []);
  }
  if (stops.length === 0) return result('cantTell', NO_STOPS, []);
  // Os alvos saem na ordem do Tab, e não na ordem do documento: é essa a ordem em que a pessoa
  // percorre a página, e é ela que a verificação guiada apresenta. Por isso a lista é montada aqui,
  // sem passar por `orderTargets`.
  const targets = stops.map(stop => ({
    nodeId: stop.nodeId,
    // O alvo carrega exatamente `nodeId`, `data` e `message`: o motivo fecha o par com o catálogo de
    // remediação e a mensagem é o texto que a pessoa lê na ocorrência.
    data: { reason: TAB_READING_REASON },
    message: TAB_READING_MESSAGE,
  }));
  return result('cantTell', SUMMARY, targets);
}

export const TAB_READING_RULES = createRuleRegistry([
  {
    id: TAB_READING_RULE_ID,
    mode: 'automated',
    nbrItems: [TAB_READING_NBR_ITEM],
    wcag: ['4.1.2'],
    evaluate: tabReadingAnnouncement,
  },
]);
