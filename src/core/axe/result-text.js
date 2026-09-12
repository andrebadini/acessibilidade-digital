// Only curated normative items are passed here, never page-supplied messages.
export function inconclusiveAxeText(item) {
  return `Verificação inconclusiva${item ? ` de “${item.title}”` : ''}: o motor não conseguiu concluir este teste. Revise o elemento e suas condições antes de afirmar que há uma desconformidade.`;
}
