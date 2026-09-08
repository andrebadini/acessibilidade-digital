import { accessibilityGuidance, recordedLabelComparisons } from './plain-language-guidance.js';

export const CHECKLIST_EXPLANATION = 'Estas perguntas não são problemas detectados nem suspeitas comprovadas. A avaliação ou a aplicabilidade ainda precisa ser estabelecida. Elas não entram na contagem nem no gráfico de achados.';

function tree(checklist, evidence) {
  const node = (tag, text = '', attrs = {}, children = []) => ({ tag, text, attrs, children });
  return node('details', '', { 'data-report-checklist': '', class: 'report-checklist' }, [
    node('summary', `Checklist separado — ${checklist.length} verificações ainda sem conclusão`),
    node('p', CHECKLIST_EXPLANATION),
    ...checklist.map(question => {
      const itemId = question.abntItemIds[0];
      const guide = accessibilityGuidance({ itemId, title: question.title, outcome: 'cantTell' });
      const refs = new Set(question.occurrences?.flatMap(row=>row.evidenceRefs) ?? []);
      return node('details', '', { 'data-checklist-question': question.checkKey }, [
        node('summary', `${itemId ? `ABNT ${itemId} — ` : ''}${question.title} · ${question.pageId}`),
        node('p', 'Por que está aqui: este teste não forneceu conclusão suficiente. A presença de um elemento, por si só, não demonstra uma barreira.'),
        node('p', `Quem pode ser afetado, se houver uma barreira: ${guide.impact}`),
        node('p', `O que verificar: ${guide.observed}`),
        ...(itemId ? [node('p', `Verificar o item ${itemId} da ABNT NBR 17225:2025`)] : []),
        ...recordedLabelComparisons(itemId, evidence.filter(row=>refs.has(row.evidenceId)))
          .map(pair=>node('p', pair.text, { 'data-report-label-comparison': pair.evidenceId })),
        node('p', guide.example),
        node('ol', '', {}, guide.reviewSteps.map(step => node('li', step))),
        node('p', `Registros originais: ${question.occurrenceIds.join(', ')}. Dados e evidências integrais permanecem no JSON e no anexo técnico.`),
      ]);
    }),
  ]);
}

export function checklistElement(document, checklist = [], evidence = []) {
  const render = value => {
    const element = document.createElement(value.tag);
    for (const [key, content] of Object.entries(value.attrs)) element.setAttribute(key, content);
    if (value.text) element.textContent = value.text;
    for (const child of value.children) element.append(render(child));
    return element;
  };
  return render(tree(checklist, evidence));
}

export function checklistHtml(checklist = [], forPrint = false, evidence = []) {
  if (forPrint) return `<p data-print-checklist-note><strong>Checklist separado:</strong> ${checklist.length} verificações ainda sem conclusão, fora da contagem de achados. Consulte as perguntas e os guias completos no HTML desta revisão; o JSON preserva os registros originais.</p>`;
  const escape = value => String(value).replace(/[&<>"']/gu, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const render = value => `<${value.tag}${Object.entries(value.attrs).map(([key, content]) => ` ${key}="${escape(content)}"`).join('')}>${escape(value.text)}${value.children.map(render).join('')}</${value.tag}>`;
  return render(tree(checklist, evidence));
}
