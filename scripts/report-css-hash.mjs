import { createHash } from 'node:crypto';

/**
 * Hash do CSS do relatório, no formato que a meta de CSP exige.
 *
 * Existe separado do build para poder ser testado sem executar o build inteiro — e é usado pelo
 * próprio `build-release.mjs`, sobre o CSS **estagiado**, para que a garantia valha para os bytes que
 * entram no pacote, não para os da árvore.
 */
export function computeReportCssHash(css) {
  return `sha256-${createHash('sha256').update(css, 'utf8').digest('base64')}`;
}

/**
 * Recusa um par CSS/hash divergente.
 *
 * Sem isto, um pacote montado sem rodar a suíte pode sair com o hash obsoleto: o navegador bloqueia o
 * `<style>` embutido pela meta de CSP e o relatório entregue fica **sem estilo, em silêncio** — o
 * defeito que a suíte pega, mas o produto não (Minor 6 / V9 das revisões). O build falha alto em vez
 * de empacotar.
 */
export function assertReportCssHashConsistent(css, declared) {
  const computed = computeReportCssHash(css);
  if (computed !== declared) {
    throw new Error(`REPORT_CSS_CSP_HASH divergente do CSS empacotado: declarado ${declared}, `
      + `calculado ${computed}. Atualize a constante em src/core/report/report.css.js; sem isso o `
      + 'relatório entregue sairia sem estilo.');
  }
  return computed;
}
