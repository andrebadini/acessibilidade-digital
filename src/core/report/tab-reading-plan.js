import { TAB_READING_NBR_ITEM, TAB_READING_RULE_ID } from '../rules/tab-reading.js';
import { describeEvidenceElement, formatLocalInstant, layHint } from './lay-review.js';

// Leitura por Tab: as linhas da seção própria da verificação guiada e o texto único de constatação.
//
// A regra `tab-reading-announcement` marca cada parada da sequência estimada de Tab como ponto a
// conferir; aqui essas ocorrências viram linhas na ordem do Tab, com o elemento, o anúncio estimado e a
// resposta já registrada. Nada aqui altera regra, resultado ou modelo: este módulo só apresenta o que o
// modelo canônico já afirma.
//
// A ordem do Tab vem do mapa do teclado (o número da caixa que a pessoa vê na imagem). Sem o mapa, a
// ordem das ocorrências já é a ordem do Tab — a regra as emite nessa ordem —, e a linha continua
// numerada pela posição, porque a sequência é justamente o que está sendo conferido.

// Os textos ficam em `tab-reading-text.js` (sem dependências) porque a página de conferência por Tab,
// que não carrega o motor de regras, diz a mesma pergunta e o mesmo aviso.
import {
  TAB_READING_ANSWER_TEXT, TAB_READING_ANSWERS, TAB_READING_HINT_LABEL, TAB_READING_INTRO,
  TAB_READING_LISTEN_LABEL, TAB_READING_NO_VOICE_MESSAGE, TAB_READING_QUESTION, TAB_READING_READER_NOTICE,
  TAB_READING_SECTION_TITLE,
} from './tab-reading-text.js';

export {
  TAB_READING_ANSWER_TEXT, TAB_READING_ANSWERS, TAB_READING_HINT_LABEL, TAB_READING_INTRO,
  TAB_READING_LISTEN_LABEL, TAB_READING_NO_VOICE_MESSAGE, TAB_READING_QUESTION, TAB_READING_READER_NOTICE,
  TAB_READING_SECTION_TITLE,
};

/**
 * Motivos automáticos que explicam, em parte, por que o anúncio pode não corresponder ao elemento. São
 * os que falam do nome que o leitor de tela anuncia — os outros (contraste, tamanho de área) não dizem
 * nada sobre o anúncio e virariam ruído na pergunta.
 */
const HINT_REASONS = Object.freeze(new Set([
  'missing-accessible-name', 'visible-label-not-in-name', 'placeholder-text', 'missing-frame-title',
]));

const DOCUMENT_TAGS = new Set(['meta', 'html', 'head', 'title', 'body']);

function keyOf(pageId, nodeId) {
  return `${pageId ?? ''}\u0000${nodeId ?? ''}`;
}

function statementText(value) {
  const text = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  return text;
}

/** Elemento de cada `pageId + nodeId`, na primeira ocorrência que o registra. */
function elementEvidenceIndex(evidence) {
  const index = new Map();
  for (const artifact of evidence) {
    if (artifact?.kind !== 'element' || typeof artifact.nodeId !== 'string' || !artifact.nodeId) continue;
    const key = keyOf(artifact.pageId, artifact.nodeId);
    if (!index.has(key)) index.set(key, artifact);
  }
  return index;
}

/** Número da parada de Tab de cada `pageId + nodeId`, lido do mapa do teclado da página. */
function tabStopNumberIndex(evidence) {
  const index = new Map();
  for (const artifact of evidence) {
    if (artifact?.kind !== 'keyboard-map') continue;
    for (const stop of Array.isArray(artifact.stops) ? artifact.stops : []) {
      if (typeof stop?.nodeId !== 'string' || !Number.isSafeInteger(stop.number)) continue;
      const key = keyOf(artifact.pageId, stop.nodeId);
      if (!index.has(key)) index.set(key, stop.number);
    }
  }
  return index;
}

function targetFor(occurrence, ruleById) {
  const rule = ruleById.get(occurrence?.source?.ruleId ?? occurrence?.ruleId);
  const nodeId = occurrence?.target?.nodeId;
  if (!rule || !Array.isArray(rule.targets)) return null;
  return rule.targets.find(target => target?.nodeId === nodeId) ?? (rule.targets.length === 1 ? rule.targets[0] : null);
}

/** Pistas automáticas por elemento: só as falhas medidas cujo motivo fala do nome anunciado. */
function automaticHints(model, ruleById) {
  const index = new Map();
  for (const occurrence of model?.occurrences ?? []) {
    const ruleId = occurrence?.source?.ruleId ?? occurrence?.ruleId;
    if (ruleId === TAB_READING_RULE_ID || occurrence?.outcome !== 'failed') continue;
    const nodeId = occurrence?.target?.nodeId;
    if (typeof nodeId !== 'string' || !nodeId) continue;
    const target = targetFor(occurrence, ruleById);
    const reason = target?.data?.reason ?? occurrence?.reason;
    if (!HINT_REASONS.has(reason)) continue;
    const hint = layHint({ data: { reason } });
    if (!hint) continue;
    const key = keyOf(occurrence.pageId, nodeId);
    const hints = index.get(key) ?? [];
    if (!hints.includes(hint)) hints.push(hint);
    index.set(key, hints);
  }
  return index;
}

/** Rótulo do ponto na sequência: é ele que nomeia o elemento nas constatações. */
export function tabReadingRowLabel(row) {
  const where = Number.isSafeInteger(row?.number) ? `Tab ${row.number}` : 'ponto da sequência de Tab';
  return row?.element?.label ? `${where}, ${row.element.label}` : where;
}

/** O que o leitor de tela falaria neste ponto, em uma frase. */
export function tabReadingAnnouncementSentence(row) {
  const announcement = statementText(row?.announcement);
  if (announcement) return `o leitor de tela diria “${announcement}”`;
  if (row?.element && !row.element.name) return 'o leitor de tela não teria nome para anunciar';
  return 'o leitor de tela não teria o que anunciar além do próprio tipo do elemento';
}

/**
 * Linhas da seção, na ordem do Tab. Cada linha carrega o elemento (para o recorte e para o rótulo), o
 * anúncio estimado, as pistas automáticas e a resposta já registrada. Nenhum valor digitado entra aqui:
 * o registro de acessibilidade já omite o valor de campos editáveis.
 */
export function buildTabReadingPlan(model) {
  const evidence = Array.isArray(model?.evidence) ? model.evidence : [];
  const decisionByOccurrence = new Map((model?.reviewDecisions ?? []).map(decision => [decision.occurrenceId, decision]));
  const ruleById = new Map((model?.ruleResults ?? []).map(rule => [rule.ruleId, rule]));
  const elements = elementEvidenceIndex(evidence);
  const stopNumbers = tabStopNumberIndex(evidence);
  const hints = automaticHints(model, ruleById);
  const pageOrder = new Map((model?.pages ?? []).map((page, index) => [page?.pageId, index]));
  const rows = [];
  for (const [position, occurrence] of (Array.isArray(model?.occurrences) ? model.occurrences : []).entries()) {
    const ruleId = occurrence?.source?.ruleId ?? occurrence?.ruleId;
    if (ruleId !== TAB_READING_RULE_ID) continue;
    const nodeId = typeof occurrence?.target?.nodeId === 'string' ? occurrence.target.nodeId : null;
    const key = keyOf(occurrence.pageId, nodeId);
    const artifact = elements.get(key) ?? null;
    const element = describeEvidenceElement(artifact);
    const decision = decisionByOccurrence.get(occurrence.occurrenceId) ?? null;
    rows.push({
      occurrenceId: occurrence.occurrenceId,
      pageId: occurrence.pageId,
      nodeId,
      // O número da parada vem do mapa; sem mapa, a posição na própria sequência (a regra a emite na
      // ordem do Tab), menos as paradas de páginas que vieram antes.
      number: stopNumbers.get(key) ?? null,
      position,
      pageOrder: pageOrder.get(occurrence.pageId) ?? Number.MAX_SAFE_INTEGER,
      // Campos consumidos pelo recorte da revisão guiada (`cardMedia`) e pela ficha do HTML: o mesmo
      // formato dos cartões, para que a imagem deste ponto seja a mesma do resto do produto.
      pageKey: key,
      elementLevel: Boolean(nodeId) && !DOCUMENT_TAGS.has(element?.tag ?? ''),
      evidence: artifact,
      element,
      label: element?.label ?? null,
      announcement: statementText(artifact?.accessibility?.announcementPreview) || null,
      hints: Object.freeze([...(hints.get(key) ?? [])]),
      decision,
      answered: decision !== null,
    });
  }
  const perPage = new Map();
  for (const row of rows) {
    const next = (perPage.get(row.pageId) ?? 0) + 1;
    perPage.set(row.pageId, next);
    if (!Number.isSafeInteger(row.number)) row.number = next;
  }
  rows.sort((left, right) => left.pageOrder - right.pageOrder || left.number - right.number || left.position - right.position);
  return Object.freeze(rows.map(row => Object.freeze(row)));
}

export function tabReadingProgress(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return { total: list.length, answered: list.filter(row => row.answered).length };
}

/**
 * Texto ÚNICO das constatações de leitura por Tab: todos os pontos que a pessoa marcou como “Não”
 * aparecem nomeados numa só frase, com o que ela escreveu em “O que deveria dizer?”. É a exceção
 * deliberada à regra de uma citação por elemento, só para este tema: a pergunta é a mesma em todos os
 * pontos e quem contesta não deve repetir o mesmo item da norma a cada parada de Tab.
 */
export function tabReadingFindingText(rows, { pageLabel = null } = {}) {
  const failing = (Array.isArray(rows) ? rows : []).filter(row => row?.decision?.answer === 'não conforme');
  if (failing.length === 0) return '';
  const parts = failing.map((row, index) => {
    const suggestion = statementText(row.decision?.note);
    const shouldSay = suggestion ? ` O que deveria dizer: “${suggestion}”.` : '';
    // Numa auditoria de várias páginas o ponto precisa dizer de qual página se fala; numa página só,
    // repetir o nome da página em cada ponto seria ruído.
    const where = typeof pageLabel === 'function' ? statementText(pageLabel(row)) : '';
    const prefix = where ? `${where}, ` : '';
    return `(${index + 1}) ${prefix}${tabReadingRowLabel(row)}: ${tabReadingAnnouncementSentence(row)}.${shouldSay}`;
  });
  const head = failing.length === 1
    ? 'Em um ponto da sequência de Tab, o que o leitor de tela fala não corresponde ao elemento'
    : `Em ${failing.length} pontos da sequência de Tab, o que o leitor de tela fala não corresponde ao elemento`;
  return `${head}: ${parts.join(' ')}`;
}

/** Avaliadores e instante da última resposta, para a citação do quadro de constatações. */
export function tabReadingDecisionSummary(rows, timezone) {
  const decisions = (Array.isArray(rows) ? rows : []).map(row => row?.decision).filter(Boolean);
  if (decisions.length === 0) return { evaluators: [], decidedAt: null, decidedAtLabel: null };
  const latest = [...decisions].sort((left, right) => String(left.decidedAt).localeCompare(String(right.decidedAt))).at(-1);
  return {
    evaluators: [...new Set(decisions.map(decision => decision.evaluator))],
    decidedAt: latest.decidedAt,
    decidedAtLabel: formatLocalInstant(latest.decidedAt, timezone),
  };
}

/**
 * Seção "Leitura por Tab" para a tela do relatório, o HTML e o PDF: as linhas na ordem do Tab com o
 * elemento, o anúncio estimado e a resposta registrada. O recorte de cada linha sai da evidência do
 * elemento, o mesmo artefato que as fichas usam — a imagem não é recalculada nem recortada de novo.
 *
 * Fica aqui, e não em `report-view.js`, porque o relatório completo exportado (o documento HTML/PDF
 * gerado sem `reportView`) também precisa da mesma seção: as duas superfícies têm de mostrar a mesma
 * tabela e a mesma constatação.
 */
export function projectTabReading(model) {
  const rows = buildTabReadingPlan(model);
  const timezone = model?.timezone;
  return Object.freeze({
    question: TAB_READING_QUESTION,
    intro: TAB_READING_INTRO,
    title: TAB_READING_SECTION_TITLE,
    notice: TAB_READING_READER_NOTICE,
    progress: tabReadingProgress(rows),
    findingText: tabReadingFindingText(rows),
    rows: Object.freeze(rows.map(row => Object.freeze({
      occurrenceId: row.occurrenceId,
      pageId: row.pageId,
      // O `nodeId` fica na projeção porque é ele que o HTML/PDF usa para recortar a imagem guardada na
      // região do elemento, exatamente como a tela da revisão faz.
      nodeId: row.nodeId,
      number: row.number,
      tag: row.element?.tag ?? null,
      kind: row.element?.roleWord ?? null,
      name: row.element?.name ?? null,
      label: row.label,
      announcement: row.announcement,
      hints: [...row.hints],
      elementEvidenceId: row.evidence?.evidenceId ?? null,
      answer: row.decision?.answer ?? null,
      // A frase da resposta, não o rótulo técnico: é a mesma que a verificação guiada mostra na caixa
      // colorida (ver `TAB_READING_ANSWER_TEXT`).
      answerLabel: row.decision
        ? TAB_READING_ANSWER_TEXT[row.decision.answer] ?? row.decision.answer : null,
      note: row.decision?.note ?? null,
      evaluator: row.decision?.evaluator ?? null,
      decidedAtLabel: row.decision ? formatLocalInstant(row.decision.decidedAt, timezone) : null,
    }))),
  });
}

export { TAB_READING_NBR_ITEM, TAB_READING_RULE_ID };
