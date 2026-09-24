/**
 * Camada de linguagem simples (modo leigo) da conferência de leitura por Tab.
 *
 * Classifica cada elemento num semáforo, resume em uma frase o que um leitor de tela anunciaria e sugere
 * a correção. As regras são heurísticas e conservadoras: o resultado orienta a revisão humana e não
 * substitui a auditoria ABNT/WCAG nem o teste com tecnologia assistiva real.
 */
import { hasReason } from './reading-reasons.js';

/** Tons do semáforo. `info` é neutro e não entra no veredito (ex.: elementos ocultos). */
export const TONES = Object.freeze(['problem', 'review', 'ok', 'info']);

export const TONE_LABELS = Object.freeze({
  problem: 'Problema',
  review: 'Revisar',
  ok: 'Ok',
  info: 'Informativo',
});

// Textos de link que não dizem o destino fora do contexto (WCAG 2.4.4 pede conferir o contexto).
const GENERIC_LINK_TEXT = /^(?:clique aqui|clique|click here|aqui|here|saiba mais|leia mais|veja mais|ver mais|mais|learn more|read more|more|link)$/iu;

const CONTROL_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);
const CONTROL_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'slider', 'switch', 'tab',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'searchbox', 'spinbutton', 'treeitem',
]);
const IMAGE_TAGS = new Set(['img', 'image', 'picture', 'svg']);

const ROLE_NAMES = Object.freeze({
  button: 'botão',
  link: 'link',
  heading: 'título',
  img: 'imagem',
  image: 'imagem',
  textbox: 'campo de texto',
  searchbox: 'campo de busca',
  checkbox: 'caixa de seleção',
  radio: 'botão de opção',
  combobox: 'caixa de combinação',
  listbox: 'lista de opções',
  option: 'opção',
  slider: 'controle deslizante',
  spinbutton: 'campo numérico',
  switch: 'interruptor',
  tab: 'aba',
  menuitem: 'item de menu',
  navigation: 'navegação',
  main: 'conteúdo principal',
  banner: 'cabeçalho',
  contentinfo: 'rodapé',
  list: 'lista',
  listitem: 'item de lista',
  paragraph: 'parágrafo',
  table: 'tabela',
  dialog: 'diálogo',
  region: 'região',
  form: 'formulário',
});

function trimmedName(entry) {
  return typeof entry?.name === 'string' ? entry.name.trim() : '';
}

export function isControl(entry) {
  return CONTROL_TAGS.has(entry?.tag) || CONTROL_ROLES.has(entry?.role);
}

export function isImage(entry) {
  return IMAGE_TAGS.has(entry?.tag) || entry?.role === 'img' || entry?.role === 'image';
}

function isLink(entry) {
  return entry?.tag === 'a' || entry?.role === 'link';
}

/** Nome da função em português para o resumo em linguagem simples. */
export function roleName(entry) {
  const role = typeof entry?.role === 'string' ? entry.role : '';
  if (Object.hasOwn(ROLE_NAMES, role)) return ROLE_NAMES[role];
  if (role) return role;
  return entry?.tag || 'elemento';
}

/** Classifica uma entrada: 'problem' | 'review' | 'ok' | 'info'. */
export function entryTone(entry) {
  const named = trimmedName(entry);
  if (entry.category === 'hidden') return 'info';
  if (entry.category === 'tab' && hasReason(entry, 'aria-hidden')) return 'problem';
  if (isControl(entry) && !named && entry.category !== 'reading') {
    if (hasReason(entry, 'native-disabled') || hasReason(entry, 'radio-group-arrow-navigation')) return 'review';
    return 'problem';
  }
  if (isImage(entry) && !named) return 'problem';
  if (isLink(entry) && GENERIC_LINK_TEXT.test(named)) return 'review';
  if (entry.category === 'outside-tab' && isControl(entry) &&
    !hasReason(entry, 'radio-group-arrow-navigation') && !hasReason(entry, 'native-disabled')) return 'review';
  if (hasReason(entry, 'aria-disabled-remains-focusable')) return 'review';
  if (entry.category === 'reading' && !named) return 'review';
  return 'ok';
}

/** Uma frase simples com o que um leitor de tela anunciaria. */
export function laySummary(entry) {
  const named = trimmedName(entry);
  const role = roleName(entry);
  if (entry.category === 'hidden') return `Este ${role} está oculto neste estado da página e não é anunciado.`;
  if (entry.category === 'tab' && hasReason(entry, 'aria-hidden')) {
    return 'O foco chega aqui, mas quem usa leitor de tela pode não ouvir nada útil: o item está escondido com aria-hidden.';
  }
  if (named) return `Quem usa leitor de tela ouviria “${named}” (${role}).`;
  if (isImage(entry)) return 'Quem usa leitor de tela não saberia o que esta imagem mostra.';
  if (isControl(entry)) return `Quem usa leitor de tela ouviria só “${role}”, sem saber o que o controle faz.`;
  return 'Este trecho pode não ter um anúncio útil para quem usa leitor de tela.';
}

/** O que está errado, o que fazer e um exemplo de antes e depois. Retorna null para 'ok' e 'info'. */
export function entryFix(entry) {
  const tone = entryTone(entry);
  if (tone === 'ok' || tone === 'info') return null;
  const named = trimmedName(entry);
  if (entry.category === 'tab' && hasReason(entry, 'aria-hidden')) {
    return {
      problem: 'O item recebe Tab, mas está escondido do leitor de tela (aria-hidden).',
      action: 'Retire o aria-hidden ou impeça o Tab neste elemento. Hoje o foco chega aqui sem anúncio.',
      before: 'Hoje: o foco chega aqui em silêncio.',
      after: 'Depois: remover aria-hidden, ou usar tabindex="-1" se o elemento for só decorativo.',
    };
  }
  if (isControl(entry) && !named && entry.category !== 'reading') {
    const label = isLink(entry) ? 'link' : roleName(entry);
    return {
      problem: `Este ${label} não tem nome acessível.`,
      action: 'Coloque um texto visível ou um aria-label curto que diga a ação.',
      before: `Hoje: “${label}”, sem nome.`,
      after: isLink(entry) ? 'Exemplo: “Baixar o relatório em PDF”.' : 'Exemplo: “Fechar menu”.',
    };
  }
  if (isImage(entry) && !named) {
    return {
      problem: 'A imagem não tem texto alternativo.',
      action: 'Escreva uma frase curta que diga o que a imagem mostra ou para que serve. Se for só decorativa, use alt="".',
      before: 'Hoje: a imagem é pulada ou lida pelo nome do arquivo.',
      after: 'Exemplo: “Gráfico de vendas do 1º semestre”.',
    };
  }
  if (isLink(entry) && GENERIC_LINK_TEXT.test(named)) {
    return {
      problem: `O texto “${named}” não diz para onde o link leva quando é ouvido fora do contexto.`,
      action: 'Troque por um texto que diga o destino ou a ação.',
      before: `Hoje: “${named}”.`,
      after: 'Exemplo: “Saiba mais sobre os planos de internet”.',
    };
  }
  if (entry.category === 'outside-tab' && isControl(entry)) {
    return {
      problem: 'Este controle fica fora da sequência de Tab.',
      action: 'Confira se o teclado chega nele por setas ou atalho. Se não chegar, quem não usa mouse fica bloqueado.',
      before: 'Hoje: o Tab pula este controle.',
      after: 'Depois: permitir o Tab ou oferecer um atalho de teclado documentado.',
    };
  }
  if (hasReason(entry, 'aria-disabled-remains-focusable')) {
    return {
      problem: 'O controle está marcado como indisponível, mas continua recebendo Tab.',
      action: 'Confira se o anúncio deixa claro que está indisponível e por quê.',
      before: 'Hoje: o foco para num controle que não funciona.',
      after: 'Depois: anunciar “indisponível” e explicar o motivo, ou tirar do Tab.',
    };
  }
  return {
    problem: 'Este ponto merece conferência humana.',
    action: 'Percorra a página com o teclado e um leitor de tela e confira se o anúncio faz sentido.',
    before: `Hoje: ${entry.preview || 'sem prévia do anúncio'}.`,
    after: 'Depois: anotar o que falta e o texto ideal.',
  };
}

/** Veredito geral em linguagem simples. Elementos 'info' não entram na conta. */
export function buildVerdict(entries) {
  const counts = { problem: 0, review: 0, ok: 0, info: 0 };
  for (const entry of entries) counts[entryTone(entry)] += 1;
  const tab = entries.filter(entry => entry.category === 'tab').length;
  let phrase;
  let tone;
  if (counts.problem === 0 && counts.review === 0) {
    phrase = 'Boa leitura por teclado: nenhum ponto crítico encontrado nesta inspeção.';
    tone = 'ok';
  } else if (counts.problem === 0) {
    phrase = `Leitura razoável: ${counts.review} ponto(s) para revisar com calma.`;
    tone = 'review';
  } else if (counts.problem <= 3) {
    phrase = `Leitura com atrito: ${counts.problem} ponto(s) que confundem ou bloqueiam quem usa leitor de tela.`;
    tone = 'problem';
  } else {
    phrase = `Leitura difícil: ${counts.problem} pontos que confundem ou bloqueiam quem usa leitor de tela.`;
    tone = 'problem';
  }
  return { phrase, tone, counts: { ...counts, total: entries.length, tab } };
}

/** Os piores itens primeiro (problemas, depois revisões), na ordem de Tab. */
export function topIssues(entries, limit = 5) {
  const weight = { problem: 0, review: 1 };
  return entries
    .map(entry => ({ entry, tone: entryTone(entry) }))
    .filter(item => Object.hasOwn(weight, item.tone))
    .sort((a, b) => weight[a.tone] - weight[b.tone] || (a.entry.tabOrder ?? 1001) - (b.entry.tabOrder ?? 1001))
    .slice(0, limit)
    .map(item => item.entry);
}

/** Texto a ser falado ou legendado no percurso de Tab. */
export function spokenAnnouncement(entry) {
  const text = entry.preview || trimmedName(entry) || roleName(entry);
  return entry.tabOrder ? `Tab ${entry.tabOrder}. ${text}` : text;
}
