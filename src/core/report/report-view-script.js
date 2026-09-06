// This fixed, CSP-hashed enhancement changes presentation only. Audit data is not executed.
function enhanceReportView() {
  'use strict';
  const cards = [...document.querySelectorAll('[data-report-issue]')];
  const groups = [...document.querySelectorAll('[data-report-item-group]')];
  const metrics = [...document.querySelectorAll('[data-report-metric]')];
  const details = [...document.querySelectorAll('details')];
  const status = document.querySelector('[data-report-filter-status]');
  let selected = null;
  let printState = null;

  function update() {
    const checks = new Set();
    for (const card of cards) {
      card.hidden = selected !== null && card.dataset.result !== selected;
      if (!card.hidden) checks.add(card.dataset.reportCheckKey);
    }
    for (const group of groups) {
      group.hidden = ![...group.querySelectorAll('[data-report-issue]')].some(card => !card.hidden);
    }
    for (const metric of metrics) {
      metric.setAttribute('aria-pressed', String(metric.dataset.reportMetric === selected));
    }
    if (status) status.textContent = `${checks.size} ${checks.size === 1 ? 'verificação visível' : 'verificações visíveis'}. Os totais do sumário e os dados originais não mudam com os filtros.`;
  }

  for (const metric of metrics) {
    metric.addEventListener('click', () => {
      selected = selected === metric.dataset.reportMetric ? null : metric.dataset.reportMetric;
      update();
    });
  }
  for (const clear of document.querySelectorAll('[data-report-clear-filters]')) {
    clear.addEventListener('click', () => { selected = null; update(); });
  }
  for (const link of document.querySelectorAll('a[href^="#"]')) {
    link.addEventListener('click', event => {
      const target = document.getElementById(link.getAttribute('href').slice(1));
      if (!target) return;
      event.preventDefault();
      selected = null;
      update();
      for (let node = target; node; node = node.parentElement) {
        if (node.tagName === 'DETAILS') node.open = true;
      }
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'start' });
    });
  }
  function beforePrint() {
    if (printState) return;
    printState = { selected, open: details.map(detail => detail.open) };
    selected = null;
    update();
    for (const detail of details) detail.open = true;
  }
  function afterPrint() {
    if (!printState) return;
    selected = printState.selected;
    details.forEach((detail, index) => { detail.open = printState.open[index]; });
    printState = null;
    update();
  }
  window.addEventListener('beforeprint', beforePrint);
  window.addEventListener('afterprint', afterPrint);
  for (const button of document.querySelectorAll('[data-report-print-summary]')) {
    button.addEventListener('click', () => {
      if (printState) return;
      const previousLayout = document.body.getAttribute('data-print-layout');
      const previousTitle = document.title;
      try {
        beforePrint();
        document.body.setAttribute('data-print-layout', 'summary');
        document.title = 'Resumo executivo — Audita Acessibilidade';
        window.print();
      } catch {
        const printStatus = document.querySelector('[data-report-print-status]');
        if (printStatus) printStatus.textContent = 'Não foi possível abrir a impressão. Use a exportação completa ou tente novamente.';
      } finally {
        afterPrint();
        document.title = previousTitle;
        if (previousLayout === null) document.body.removeAttribute('data-print-layout');
        else document.body.setAttribute('data-print-layout', previousLayout);
      }
    });
  }
  update();
}

export const REPORT_VIEW_SCRIPT = `'use strict';\n(${enhanceReportView.toString()})();`;
export const REPORT_VIEW_SCRIPT_CSP_HASH = 'sha256-MbRep5FCh62Pl6yINMSGQlr6Kuyl629dRlYacsMCgYc=';
