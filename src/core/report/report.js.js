export function matchesReportFilters(tokens, filters) {
  const tokenMatch = (value, expected) => !expected || String(value ?? '').split(' ').includes(expected);
  return tokenMatch(tokens.impact, filters.impact)
    && tokenMatch(tokens.wcagLevels, filters.wcagLevel)
    && tokenMatch(tokens.outcome, filters.outcome)
    && tokenMatch(tokens.classification, filters.classification)
    && tokenMatch(tokens.page, filters.page)
    && tokenMatch(tokens.engine, filters.engine)
    && tokenMatch(tokens.abntItem, filters.abntItem);
}

function enhanceReport() {
  'use strict';
  const root = document.documentElement;
  const form = document.getElementById('report-filters');
  if (!form) return;

  const cards = Array.from(document.querySelectorAll('[data-occurrence-card]'));
  const details = Array.from(document.querySelectorAll('details[data-collapsible]'));
  const controls = Array.from(form.elements);
  const status = document.getElementById('filter-status');
  const empty = document.getElementById('filter-empty');
  const clearButtons = Array.from(document.querySelectorAll('[data-clear-filters]'));
  const expandButton = document.getElementById('expand-details');
  const collapseButton = document.getElementById('collapse-details');
  const firstFilter = document.getElementById('filter-impact');
  let scheduled = false;
  let printState = null;

  const readFilters = () => ({
    impact: document.getElementById('filter-impact').value,
    wcagLevel: document.getElementById('filter-wcag').value,
    outcome: document.getElementById('filter-outcome').value,
    classification: document.getElementById('filter-classification').value,
    page: document.getElementById('filter-page').value,
    engine: document.getElementById('filter-engine').value,
    abntItem: document.getElementById('filter-abnt').value,
  });

  const cardTokens = card => ({
    impact: card.dataset.impact,
    wcagLevels: card.dataset.wcagLevels,
    outcome: card.dataset.outcome,
    classification: card.dataset.classification,
    page: card.dataset.page,
    engine: card.dataset.engine,
    abntItem: card.dataset.abntItem,
  });

  const update = () => {
    scheduled = false;
    const filters = readFilters();
    let visible = 0;
    for (const card of cards) {
      const shown = matchesReportFilters(cardTokens(card), filters);
      card.hidden = !shown;
      if (shown) visible += 1;
    }
    status.textContent = `${visible} de ${cards.length} ocorrências exibidas.`;
    empty.hidden = visible !== 0;
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(update);
  };

  const clearFilters = moveFocus => {
    form.reset();
    schedule();
    if (moveFocus) firstFilter.focus();
  };

  root.classList.add('report-enhanced');
  for (const control of controls) control.disabled = false;
  for (const button of [...clearButtons, expandButton, collapseButton]) {
    if (button) button.disabled = false;
  }
  for (const detail of details) detail.open = false;

  form.addEventListener('change', schedule);
  for (const button of clearButtons) button.addEventListener('click', () => clearFilters(true));
  expandButton.addEventListener('click', () => {
    for (const detail of details) detail.open = true;
  });
  collapseButton.addEventListener('click', () => {
    for (const detail of details) detail.open = false;
  });

  window.addEventListener('beforeprint', () => {
    if (printState) return;
    printState = {
      filters: controls.filter(control => typeof control.value === 'string').map(control => [control, control.value]),
      hidden: cards.map(card => card.hidden),
      open: details.map(detail => detail.open),
    };
    root.classList.add('report-printing');
    for (const card of cards) card.hidden = false;
    for (const detail of details) detail.open = true;
    empty.hidden = true;
  });

  window.addEventListener('afterprint', () => {
    if (!printState) return;
    for (const [control, value] of printState.filters) control.value = value;
    cards.forEach((card, index) => { card.hidden = printState.hidden[index]; });
    details.forEach((detail, index) => { detail.open = printState.open[index]; });
    root.classList.remove('report-printing');
    printState = null;
    schedule();
  });

  update();
}

export const REPORT_SCRIPT = `'use strict';\n${matchesReportFilters.toString()}\n(${enhanceReport.toString()})();`;

// Updated by the CSP integrity test whenever the static runtime changes.
export const REPORT_SCRIPT_CSP_HASH = 'sha256-0/CdriAjkuvBJf/aHoT7TJ6T5Urd2/K4I2KMoGDermk=';
