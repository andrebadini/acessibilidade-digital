import { CONSUMER_ACCESSIBILITY_FIXED_BASIS } from '../legal/consumer-basis.js';
import {
  ANSWER_LABELS, compareItemIds, describeEvidenceElement, formatLocalInstant, layHint, withArticle,
} from './lay-review.js';
import { marksText } from './review-marks-presentation.js';

// Quadro de constatações: a situação de cada REQUISITO da ABNT NBR 17225:2025 depois da revisão humana,
// com frases prontas para citação. Só apresenta o que o modelo canônico já afirma: o resultado de cada
// item vem de itemResults (que já incorpora as decisões humanas validadas) e cada constatação aponta
// a ocorrência, a evidência e quem concluiu. Recomendações aparecem apenas em contagem, porque o seu
// não atendimento, isoladamente, não demonstra descumprimento do mínimo (seção 4 da norma).

export const FINDINGS_BOARD_TITLE = 'Quadro de constatações (requisitos da ABNT NBR 17225:2025)';
export const FINDINGS_BOARD_INTRO = 'Este quadro reúne, item a item, os requisitos da ABNT NBR 17225:2025 na situação observada nesta página: não atendidos, atendidos, não aplicáveis e sem conclusão. Cada constatação indica como foi obtida (medição automática ou revisão humana), onde está o elemento e qual evidência a sustenta. As frases podem ser copiadas para relatórios, sempre conferidas por quem as usa.';
export const FINDINGS_BOARD_LIMIT = 'Atendido significa “atendido no que foi observado nesta página, neste momento”. Itens sem conclusão não são aprovação nem reprovação. O quadro não é laudo, certificação nem decisão jurídica.';

const OUTCOME_GROUP = Object.freeze({ failed: 'notMet', passed: 'met', inapplicable: 'notApplicable', cantTell: 'pending', untested: 'pending' });

function evidenceIndex(model) {
  return new Map((model.evidence ?? []).map(value => [value.evidenceId, value]));
}

/** Mapa do teclado de cada página: é ele que dá nome aos itens apontados na revisão guiada. */
function keyboardMapIndex(model) {
  const maps = new Map();
  for (const artifact of model.evidence ?? []) {
    if (artifact?.kind === 'keyboard-map' && !maps.has(artifact.pageId)) maps.set(artifact.pageId, artifact);
  }
  return maps;
}

function elementEvidence(occurrence, evidenceById) {
  const refs = Array.isArray(occurrence.evidenceRefs) ? occurrence.evidenceRefs : [];
  const all = refs.map(id => evidenceById.get(id)).filter(Boolean);
  const nodeId = occurrence.target?.nodeId;
  return all.find(value => value.kind === 'element' && value.nodeId === nodeId) ?? all.find(value => value.kind === 'element') ?? null;
}

function ruleTarget(occurrence, ruleById) {
  const rule = ruleById.get(occurrence.source?.ruleId ?? occurrence.ruleId);
  const nodeId = occurrence.target?.nodeId;
  if (!rule || !Array.isArray(rule.targets)) return null;
  return rule.targets.find(target => target?.nodeId === nodeId) ?? (rule.targets.length === 1 ? rule.targets[0] : null);
}

function sentence(value) {
  const text = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  if (!text) return '';
  return /[.!?…]$/u.test(text) ? text : `${text}.`;
}

function automaticText(target) {
  return sentence(layHint(target)) || 'A verificação automática registrou falha neste requisito.';
}

function lowerFirst(value) {
  return value ? `${value.charAt(0).toLocaleLowerCase('pt-BR')}${value.slice(1)}` : value;
}

function evidenceSummary(occurrence, evidenceById) {
  return (occurrence.evidenceRefs ?? []).map(id => {
    const evidence = evidenceById.get(id);
    return evidence?.hash ? `${id} (SHA-256 ${evidence.hash.slice(0, 16)}…)` : id;
  });
}

/** Constrói o quadro a partir do modelo canônico já validado. */
export function buildFindingsBoard(model) {
  const timezone = model.timezone;
  const pageById = new Map((model.pages ?? []).map(page => [page.pageId, page]));
  const evidenceById = evidenceIndex(model);
  const keyboardMapByPage = keyboardMapIndex(model);
  const ruleById = new Map((model.ruleResults ?? []).map(rule => [rule.ruleId, rule]));
  const decisionByOccurrence = new Map((model.reviewDecisions ?? []).map(decision => [decision.occurrenceId, decision]));
  const occurrencesByItem = new Map();
  for (const occurrence of model.occurrences ?? []) {
    const list = occurrencesByItem.get(occurrence.itemId) ?? [];
    list.push(occurrence);
    occurrencesByItem.set(occurrence.itemId, list);
  }
  const groups = { notMet: [], met: [], notApplicable: [], pending: [] };
  const recommendations = { failed: 0, passed: 0, inapplicable: 0, pending: 0 };
  const items = [...(model.itemResults ?? [])].sort((a, b) => compareItemIds(a.id, b.id));
  for (const item of items) {
    const group = OUTCOME_GROUP[item.outcome] ?? 'pending';
    if (item.classification !== 'requirement') {
      recommendations[group === 'notMet' ? 'failed' : group === 'met' ? 'passed' : group === 'notApplicable' ? 'inapplicable' : 'pending'] += 1;
      continue;
    }
    const occurrences = occurrencesByItem.get(item.id) ?? [];
    const decisions = occurrences.map(value => decisionByOccurrence.get(value.occurrenceId)).filter(Boolean);
    const method = decisions.length === 0 ? 'automática' : occurrences.every(value => decisionByOccurrence.has(value.occurrenceId)) ? 'revisão humana' : 'automática e revisão humana';
    const entry = {
      itemId: item.id, title: item.title, classification: 'requisito', outcome: item.outcome, method,
      evaluators: [...new Set(decisions.map(value => value.evaluator))],
      decidedAt: decisions.length ? [...decisions].map(value => value.decidedAt).sort().at(-1) : null,
      decidedAtLabel: null, findings: [],
    };
    if (entry.decidedAt) entry.decidedAtLabel = formatLocalInstant(entry.decidedAt, timezone);
    if (group === 'notMet') {
      for (const occurrence of occurrences) {
        const decision = decisionByOccurrence.get(occurrence.occurrenceId);
        const human = occurrence.outcome === 'cantTell' && decision?.answer === 'não conforme';
        if (occurrence.outcome !== 'failed' && !human) continue;
        const page = pageById.get(occurrence.pageId);
        const elementArtifact = elementEvidence(occurrence, evidenceById);
        const element = describeEvidenceElement(elementArtifact);
        const observedAt = page?.timestamps?.endedAt ?? model.timestamps?.endedAt;
        // O apontamento no mapa do teclado entra na própria constatação: "Itens apontados: …" nomeia
        // os itens sem caixa e "Áreas marcadas no mapa do teclado: N" conta os retângulos desenhados.
        const marks = human ? decision.marks ?? null : null;
        const marksLine = marks ? marksText(marks, keyboardMapByPage.get(occurrence.pageId) ?? null) : '';
        const text = human
          ? [sentence(decision.note) || `A pessoa avaliadora registrou “${ANSWER_LABELS[decision.answer]}”.`, marksLine]
            .filter(Boolean).join(' ')
          : automaticText(ruleTarget(occurrence, ruleById));
        const finding = {
          occurrenceId: occurrence.occurrenceId,
          source: human ? 'human' : 'automatic',
          pageUrl: page?.finalUrl ?? model.finalUrl,
          // Referências estruturáveis, além das frases de `evidence`: a tela do relatório precisa do
          // ID para ligar cada citação à ficha da evidência e da evidência do ELEMENTO para mostrar a
          // miniatura com contorno. `evidence` continua sendo o texto pronto, sem alteração.
          pageId: occurrence.pageId,
          evidenceIds: [...(occurrence.evidenceRefs ?? [])],
          elementEvidenceId: elementArtifact?.evidenceId ?? null,
          element: element?.label ?? null,
          subject: element ? withArticle(element) : 'à página',
          text,
          observedAtLabel: formatLocalInstant(observedAt, timezone),
          evaluator: human ? decision.evaluator : null,
          decidedAtLabel: human ? formatLocalInstant(decision.decidedAt, timezone) : null,
          evidence: evidenceSummary(occurrence, evidenceById),
          marks,
          marksText: marksLine,
          legalBasis: human ? Boolean(decision.note) : occurrence.legalAnalysis?.basisRef === CONSUMER_ACCESSIBILITY_FIXED_BASIS.id,
        };
        // O mesmo elemento pode ter duas ocorrências do mesmo item (motor próprio e axe) com a mesma
        // constatação: o quadro mostra uma só, somando as evidências.
        const duplicate = entry.findings.find(value => value.pageUrl === finding.pageUrl &&
          value.nodeKey === `${occurrence.pageId}|${occurrence.target?.nodeId ?? ''}` && value.text === finding.text &&
          value.source === finding.source);
        if (duplicate) {
          for (const reference of finding.evidence) if (!duplicate.evidence.includes(reference)) duplicate.evidence.push(reference);
          for (const evidenceId of finding.evidenceIds) if (!duplicate.evidenceIds.includes(evidenceId)) duplicate.evidenceIds.push(evidenceId);
          duplicate.elementEvidenceId ??= finding.elementEvidenceId;
          duplicate.occurrenceIds.push(occurrence.occurrenceId);
          duplicate.citation = citationParagraph({ item, finding: duplicate });
          continue;
        }
        finding.nodeKey = `${occurrence.pageId}|${occurrence.target?.nodeId ?? ''}`;
        finding.occurrenceIds = [occurrence.occurrenceId];
        finding.citation = citationParagraph({ item, finding });
        entry.findings.push(finding);
      }
    }
    groups[group].push(entry);
  }
  const requirementCount = groups.notMet.length + groups.met.length + groups.notApplicable.length + groups.pending.length;
  return {
    scoreboard: {
      requirements: requirementCount,
      notMet: groups.notMet.length, met: groups.met.length,
      notApplicable: groups.notApplicable.length, pending: groups.pending.length,
    },
    groups, recommendations,
    legalParagraph: `${CONSUMER_ACCESSIBILITY_FIXED_BASIS.sentencePrefix}. ${CONSUMER_ACCESSIBILITY_FIXED_BASIS.qualification}`,
  };
}

/** Parágrafo pronto para citação; quem usa confere e adapta. */
export function citationParagraph({ item, finding }) {
  const evidence = finding.evidence.length ? ` Evidência: ${finding.evidence.join('; ')}.` : '';
  const norm = `Situação em desacordo com o item ${item.id} (${item.title}, requisito) da ABNT NBR 17225:2025.`;
  if (finding.source === 'human') {
    const where = finding.element ? ` Elemento: ${finding.element}.` : '';
    return `Em ${finding.observedAtLabel}, foi auditada a página ${finding.pageUrl}. Em revisão humana registrada por ${finding.evaluator} em ${finding.decidedAtLabel}, ` +
      `consta a seguinte constatação: “${finding.text}”${where} ${norm}${evidence}`;
  }
  return `Em ${finding.observedAtLabel}, na página ${finding.pageUrl}, constatou-se, em relação ${finding.subject}, que ` +
    `${lowerFirst(finding.text).replace(/\.$/u, '')} (verificação automática da ferramenta Audita Acessibilidade). ${norm}${evidence}`;
}

// Texto único para citação: um requisito não atendido pode ter sido constatado em vários elementos.
// Copiar um parágrafo por elemento obriga quem reclama a repetir o mesmo item da norma em cada um;
// aqui as constatações do MESMO item viram um parágrafo só, com todos os elementos nomeados. Vale
// apenas para a tela do relatório (botão “Abrir relatório completo”): as exportações HTML, PDF, CSV e
// JSON continuam com uma citação por elemento.

const AUTOMATIC_NOTE = 'verificação automática da ferramenta Audita Acessibilidade';

function contextOf(finding) {
  return `${finding?.pageUrl ?? ''}\u0000${finding?.observedAtLabel ?? ''}`;
}

/**
 * Enumera as constatações; automáticas com o mesmo texto no mesmo instante viram uma entrada só.
 * Elementos com o MESMO nome (por exemplo, vários botões sem nome) não somem do texto: a expressão
 * aparece uma vez com a quantidade (“ao botão sem nome (3 elementos)”), para que todos os elementos
 * constatados continuem mencionados sem repetir a mesma expressão dezenas de vezes.
 */
function citationEntries(findings) {
  const entries = [];
  const automaticByKey = new Map();
  for (const finding of findings) {
    if (finding.source !== 'automatic') {
      entries.push({ kind: 'human', finding });
      continue;
    }
    const key = `${contextOf(finding)}\u0000${finding.text ?? ''}`;
    const known = automaticByKey.get(key);
    if (known) {
      known.subjects.set(finding.subject, (known.subjects.get(finding.subject) ?? 0) + 1);
      continue;
    }
    const entry = { kind: 'automatic', text: finding.text ?? '', subjects: new Map([[finding.subject, 1]]), pageUrl: finding.pageUrl, observedAtLabel: finding.observedAtLabel };
    automaticByKey.set(key, entry);
    entries.push(entry);
  }
  return entries;
}

function joinSubjects(subjects) {
  const names = [...subjects].map(([subject, count]) => (count > 1 ? `${subject} (${count} elementos)` : subject));
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} e ${names.at(-1)}`;
}

function occurrenceClause(entry, sharedContext) {
  const where = sharedContext ? '' : `na página ${entry.pageUrl}, em ${entry.observedAtLabel}, `;
  if (entry.kind === 'human') {
    const { finding } = entry;
    const element = finding.element ? `, no elemento ${finding.element}` : '';
    return `${where}em revisão humana registrada por ${finding.evaluator} em ${finding.decidedAtLabel}, a constatação “${finding.text}”${element}`;
  }
  const text = lowerFirst(String(entry.text ?? '').replace(/\s+/gu, ' ').trim()).replace(/\.$/u, '');
  return `${where}em relação ${joinSubjects(entry.subjects)}, ${text} (${AUTOMATIC_NOTE})`;
}

/** Evidências citadas uma única vez, sem repetir referências iguais e preservando a ordem. */
function consolidatedEvidence(findings) {
  const references = [];
  for (const finding of findings) {
    for (const reference of Array.isArray(finding.evidence) ? finding.evidence : []) {
      if (!references.includes(reference)) references.push(reference);
    }
  }
  if (!references.length) return '';
  return `${references.length === 1 ? 'Evidência' : 'Evidências'}: ${references.join('; ')}.`;
}

/**
 * Parágrafo pronto para citação que reúne TODAS as constatações de um mesmo item da norma — usado só
 * quando há mais de uma. Com uma constatação só, o texto continua sendo o de citationParagraph.
 */
export function consolidatedCitationParagraph({ item, findings }) {
  const list = (Array.isArray(findings) ? findings : []).filter(finding => finding && typeof finding === 'object');
  if (!list.length) return '';
  const sharedContext = new Set(list.map(contextOf)).size === 1;
  const norm = `o item ${item.id} (${item.title}, requisito) da ABNT NBR 17225:2025`;
  const counted = list.length === 1 ? 'foi constatada 1 ocorrência' : `foram constatadas ${list.length} ocorrências`;
  const head = sharedContext
    ? `Em ${list[0].observedAtLabel}, na página ${list[0].pageUrl}, ${counted} em desacordo com ${norm}:`
    : `${counted.charAt(0).toLocaleUpperCase('pt-BR')}${counted.slice(1)} em desacordo com ${norm}:`;
  // Uma entrada só (todos os elementos com a mesma constatação) dispensa a numeração “(1)”.
  const entries = citationEntries(list);
  const occurrences = entries.length === 1
    ? occurrenceClause(entries[0], sharedContext)
    : entries.map((entry, index) => `(${index + 1}) ${occurrenceClause(entry, sharedContext)}`).join('; ');
  return [head, `${occurrences}.`, consolidatedEvidence(list)].filter(Boolean).join(' ');
}

export function scoreboardSentence(scoreboard) {
  return `Dos ${scoreboard.requirements} requisitos da norma: ${scoreboard.notMet} não atendidos, ${scoreboard.met} atendidos, ` +
    `${scoreboard.notApplicable} não aplicáveis e ${scoreboard.pending} sem conclusão.`;
}
