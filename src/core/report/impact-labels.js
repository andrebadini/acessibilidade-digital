/**
 * Rótulos únicos de impacto, usados pelo painel, pelo relatório HTML e pela revisão humana.
 * A gradação vem do motor (critical/serious/moderate/minor) e é sempre a mesma em toda a
 * interface: Crítico, Alto, Moderado e Baixo ('minor' deixou de ser exibido como "Menor").
 */
export const IMPACT_LABELS = Object.freeze({
  critical: 'Crítico',
  serious: 'Alto',
  moderate: 'Moderado',
  minor: 'Baixo',
});

export function impactLabel(value) {
  return IMPACT_LABELS[value] ?? value;
}

/**
 * Texto do impacto na interface (null quando não há impacto a exibir, inclusive em resultado
 * positivo): em resultado confirmado é "Impacto Alto"; em suspeita que depende
 * de revisão humana é "Impacto se confirmado: Alto", porque o motor ainda não confirmou a barreira.
 */
export function impactText(impact, pendingConfirmation = false, { positive = false } = {}) {
  // Resultado positivo não tem barreira: exibir "Impacto Moderado" ao lado dele confunde quem lê.
  if (!impact || positive) return null;
  const label = impactLabel(impact);
  return pendingConfirmation ? `Impacto se confirmado: ${label}` : `Impacto ${label}`;
}
