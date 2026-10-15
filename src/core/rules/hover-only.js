import { NBR17225_ITEMS } from '../normative/nbr17225.js';
import { createRuleRegistry } from './registry.js';
import { documentTarget, orderTargets, result, snapshotParts, target } from './snapshot.js';

/**
 * Regra do motor próprio para conteúdo interativo que só aparece com o mouse (ABNT 5.1.13 / WCAG 2.1.1).
 *
 * A conclusão vem de uma observação já coletada por `src/browser/hover-only-probe.js` e anexada ao
 * snapshot (`document.hoverOnlyObservation`). O avaliador não fala com o navegador: ele só lê a
 * observação, de modo que a regra continua determinística e testável sem CDP.
 */

export const HOVER_ONLY_ITEM_ID = '5.1.13';
export const HOVER_ONLY_RULE_ID = 'hover-only-interactive-content';
export const HOVER_ONLY_OBSERVATION_KEY = 'hoverOnlyObservation';

const FAILED_OUTCOMES = new Set(['failed']);
const REVIEW_OUTCOMES = new Set(['cantTell', 'untested']);

const OBSERVATION_ABSENT_SUMMARY =
  'A sondagem de conteúdo revelado apenas por hover não acompanha este snapshot.';
const OBSERVATION_INCOMPLETE_SUMMARY =
  'A sondagem de conteúdo revelado apenas por hover não foi concluída para toda a página.';
const SCRIPT_HOVER_SUMMARY =
  'Há bloco cujo conteúdo interativo parece abrir por script quando o mouse passa por cima.';
// Texto único deste motivo: o mesmo que o catálogo fechado de remediação registra para
// `hover-script-no-keyboard-path`, para que o cartão do relatório diga exatamente o que a regra diz.
const SCRIPT_HOVER_MESSAGE =
  'Os links deste bloco parecem abrir por um script quando o mouse passa por cima, e não encontramos jeito de abri-los pelo teclado. Use a tecla Tab para conferir.';

function unavailableTarget(document) {
  return documentTarget(
    document,
    'Execute a coleta com a sondagem de hover e confirme com o teclado se o conteúdo oculto aparece.',
    { reason: 'hover-only-observation-unavailable' },
  );
}

function groupsOf(observation) {
  return Array.isArray(observation?.groups) ? observation.groups : [];
}

function resolveNodes(nodes, groups, unresolvedPrefix = null) {
  const byNodeId = new Map();
  for (const node of nodes) {
    const id = node?.nodeId;
    if (typeof id === 'string' || Number.isSafeInteger(id)) {
      if (!byNodeId.has(String(id))) byNodeId.set(String(id), node);
    }
  }
  const resolved = [];
  for (const group of groups) {
    const node = byNodeId.get(String(group?.nodeId));
    if (node) resolved.push({ node, group });
    else if (unresolvedPrefix) unresolvedPrefix.push(group);
  }
  return resolved;
}

function hoverOnlyInteractiveContent(snapshot) {
  const parts = snapshotParts(snapshot);
  if (!parts) {
    return result('cantTell', OBSERVATION_ABSENT_SUMMARY, [], [
      'O snapshot deve conter document e nodes em formato serializável.',
    ]);
  }
  const { document, nodes } = parts;
  const observation = document?.[HOVER_ONLY_OBSERVATION_KEY];
  const groups = groupsOf(observation);
  const unresolved = [];
  const failures = resolveNodes(nodes, groups.filter(group => FAILED_OUTCOMES.has(group?.outcome)), unresolved);
  // Duas dúvidas diferentes: o bloco tem controle focável e o foco não revelou o conteúdo, ou a
  // medição não terminou (a abertura é animada e a transição passou do tempo de espera da sondagem).
  // A segunda não fala de controle nenhum, e o texto do relatório precisa dizer isso.
  // Terceira dúvida: o bloco não revelou nada ao `:hover` forçado, mas tem ouvinte de mouse no
  // próprio bloco ou nos ancestrais e nenhum caminho de teclado. O conteúdo pode abrir por script, e
  // o que a sonda viu não decide isso sozinho — quem decide é a revisão humana, com o teclado na mão.
  const scriptReviews = resolveNodes(nodes, groups.filter(group =>
    REVIEW_OUTCOMES.has(group?.outcome) && group.unsettled !== true &&
    group.hoverScript === true && group.keyboardPath !== true), unresolved);
  const scriptReviewNodeIds = new Set(scriptReviews.map(({ node }) => String(node?.nodeId)));
  const reviews = resolveNodes(nodes, groups.filter(group =>
    REVIEW_OUTCOMES.has(group?.outcome) && group.unsettled !== true &&
    !scriptReviewNodeIds.has(String(group?.nodeId))), unresolved);
  const unsampled = resolveNodes(nodes, groups.filter(group =>
    REVIEW_OUTCOMES.has(group?.outcome) && group.unsettled === true), unresolved);
  // Um grupo apontado pela sondagem que não existe no snapshot não vira conclusão nenhuma: sem o
  // nó, não há alvo para marcar na página nem como afirmar que o conteúdo é alcançável.
  const unavailable = !observation || observation.status === 'omitted' || unresolved.length > 0;

  if (failures.length > 0) {
    return {
      outcome: 'failed',
      targets: orderTargets(failures.map(({ node, group }) => target(
        node,
        `Este bloco revela ${group.targetCount} elemento(s) interativo(s) somente quando o mouse passa por cima: quem navega pelo teclado (TAB) não chega até eles. Transforme o bloco num botão ou link focável que abre o conteúdo, ou revele-o também com :focus-within, garantindo que os destinos sejam alcançáveis pelo teclado.`,
        { reason: 'hover-only-content-not-keyboard-reachable' },
      )), nodes),
      summary: 'Há bloco cujo conteúdo interativo só aparece com o mouse.',
      limitations: [],
    };
  }
  if (reviews.length > 0 || unsampled.length > 0 || scriptReviews.length > 0) {
    return {
      outcome: 'cantTell',
      targets: orderTargets([
        ...unsampled.map(({ node }) => target(
          node,
          'Este bloco abre com uma animação e a medição não terminou dentro do tempo da sondagem. Confirme com o teclado (TAB) se o conteúdo oculto aparece.',
          { reason: 'hover-only-observation-unavailable' },
        )),
        ...reviews.map(({ node }) => target(
          node,
          'Há um controle focável neste bloco, mas o conteúdo oculto não apareceu ao forçar o foco. Use TAB e Enter sem tocar no mouse para confirmar se o conteúdo é alcançável.',
          { reason: 'hover-only-keyboard-path-unconfirmed' },
        )),
        ...scriptReviews.map(({ node }) => target(node, SCRIPT_HOVER_MESSAGE, {
          reason: 'hover-script-no-keyboard-path',
        })),
      ], nodes),
      // O resumo do bloco que abre por script não é "a sondagem não terminou": a dúvida tem outro
      // motivo, e o relatório precisa dizer qual é.
      summary: reviews.length + unsampled.length === 0 && scriptReviews.length > 0
        ? SCRIPT_HOVER_SUMMARY
        : OBSERVATION_INCOMPLETE_SUMMARY,
      limitations: [],
    };
  }
  if (unavailable) {
    return {
      outcome: 'cantTell',
      targets: [unavailableTarget(document)],
      summary: OBSERVATION_ABSENT_SUMMARY,
      limitations: [],
    };
  }
  if (observation.status !== 'complete' || observation.truncated === true) {
    return {
      outcome: 'cantTell',
      targets: [unavailableTarget(document)],
      summary: OBSERVATION_INCOMPLETE_SUMMARY,
      limitations: [],
    };
  }
  if (groups.length === 0) {
    return {
      outcome: 'inapplicable',
      targets: [],
      summary: 'Nenhum conteúdo interativo escondido atrás de hover foi observado nesta página.',
      limitations: [],
    };
  }
  return {
    outcome: 'passed',
    targets: [],
    summary: 'O conteúdo interativo oculto observado também é alcançável pelo teclado.',
    limitations: [],
  };
}

const HOVER_ONLY_ITEM = NBR17225_ITEMS.find(item => item.id === HOVER_ONLY_ITEM_ID);

export const HOVER_ONLY_RULES = createRuleRegistry([{
  id: HOVER_ONLY_RULE_ID,
  mode: HOVER_ONLY_ITEM.evaluation,
  nbrItems: [HOVER_ONLY_ITEM_ID],
  wcag: [...new Set(HOVER_ONLY_ITEM.wcag.map(reference => reference.id))],
  evaluate: hoverOnlyInteractiveContent,
}]);
