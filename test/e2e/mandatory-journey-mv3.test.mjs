import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, launchUnpackedExtension, resolveRealChromeTestBinary, evaluate, waitForValue } from './support/real-chrome.mjs';

// The mandatory journey, in one session and in order: open the side panel, evaluate the
// current page, watch comprehensible progress, read the summary, open an occurrence, mark the
// element on the page, consult the ABNT/WCAG references with the estimated announcement, and
// export the report. Each step already has a focused test; what no test covered is the journey
// itself, which is where a surface can be individually correct and still not connect to the
// next one. The assertions also pin the two promises the panel makes about the page: it must
// not open a popup, and inspecting or marking must not move, focus or edit the page.
const DOCUMENT = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Percurso obrigatório</title></head>
<body><main><h1>Página avaliada</h1>
<img id="missing-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
<button id="missing-name">Botão sem nome</button><input id="missing-label" type="text">
<a href="/current">clique aqui</a></main></body></html>`;

// The audited page is compared on its content, not on its raw outerHTML length: the marking
// itself is an overlay the extension adds to the document, so a length comparison would fail
// on the feature working. What must not change is the author's markup, the runtime state, the
// focus and the scroll position.
const pageState = `(() => ({
  x: scrollX, y: scrollY,
  focus: document.activeElement?.id || document.activeElement?.tagName || null,
  authorMarkup: document.querySelector('main').outerHTML,
}))()`;

const summaryState = `(() => {
  const root = document.querySelector('[data-screen="result"]');
  return { screen: document.querySelector('[data-screen]')?.dataset.screen ?? null,
    auditId: root?.dataset.auditId ?? null,
    text: (root?.textContent ?? '').replace(/\\s+/gu, ' '),
    cards: [...document.querySelectorAll('[data-result-card]')].map(node => ({
      classification: node.dataset.classification,
      count: node.querySelector('[data-result-count]')?.textContent ?? null,
    })) };
})()`;

const detailState = `(() => {
  const root = document.querySelector('[data-result-detail]');
  if (!root) return null;
  const block = name => root.querySelector('[data-detail-block="' + name + '"]')?.textContent?.replace(/\\s+/gu, ' ').trim() ?? null;
  const action = root.querySelector('.detail-actions [data-action]');
  return { heading: block('heading'), affected: block('affected'), observed: block('observed'),
    correction: block('correction'), accessibility: block('accessibility'),
    normative: block('normative'), legal: block('legal'),
    action: action?.dataset.action ?? null, actionLabel: action?.textContent?.trim() ?? null };
})()`;

test('the mandatory journey runs end to end in one session', { timeout: 420_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([
    ['/current', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: DOCUMENT }],
  ]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/current`, chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
    viewport: { width: 1280, height: 900 }, downloadMode: 'profile',
  });

  // 1. Open the side panel. The panel must be the only surface: no popup may open.
  const panel = await extension.openSidePanelFromAction();
  await panel.command('Page.bringToFront');
  await waitForValue(panel, 'document.visibilityState', value => value === 'visible', { timeoutMs: 10_000 });
  assert.equal((await extension.runtimeContexts({ contextTypes: ['POPUP'] })).length, 0,
    'the journey must never depend on a popup');
  const panelSize = await evaluate(panel, `({ w: innerWidth, h: innerHeight })`);

  // 2. Evaluate the current page, and 3. watch progress in plain language.
  const before = await evaluate(extension.startPage.page, pageState);
  await waitForValue(panel, `(() => {
    const input = document.querySelector('input[data-capture-mode="no-pixels"]');
    const button = document.querySelector('button[data-intent="START_ATTACHED"]');
    return Boolean(input && !input.disabled && button && !button.disabled);
  })()`, value => value === true, { timeoutMs: 30_000, intervalMs: 50 });
  await extension.click(panel, 'input[data-capture-mode="no-pixels"]');
  await extension.click(panel, 'button[data-intent="START_ATTACHED"]');
  const progress = await waitForValue(panel, `(() => ({
    screen: document.querySelector('[data-screen]')?.dataset.screen ?? null,
    status: document.querySelector('[role="status"]')?.textContent ?? null,
    hasProgress: Boolean(document.querySelector('[data-progress], progress, [role="progressbar"]')),
    text: (document.querySelector('[data-screen="running"]')?.textContent ?? '').replace(/\\s+/gu, ' ').slice(0, 200),
  }))()`, value => value?.screen === 'result' || (value?.screen === 'running' && Boolean(value?.status)),
    { timeoutMs: 60_000, intervalMs: 50 });
  assert.ok(progress.status || progress.hasProgress || progress.screen === 'result',
    `progress must be understandable: ${JSON.stringify(progress)}`);

  // 4. The summary. Counts must be named and separated by classification, with the source URL.
  const summary = await waitForValue(panel, summaryState, value => value?.screen === 'result',
    { timeoutMs: 90_000, intervalMs: 100 });
  assert.match(summary.auditId ?? '', /^[A-Za-z0-9._:-]{1,160}$/u, 'the result carries its audit id');
  assert.ok(summary.text.includes(fixture.origin), `the summary must name the audited page: ${summary.text.slice(0, 200)}`);
  assert.match(summary.text, /Falhas confirmadas/u, 'the summary must separate confirmed failures');
  assert.ok(summary.cards.length > 0, `the summary must offer clickable classifications: ${JSON.stringify(summary.cards)}`);
  assert.ok(summary.cards.every(card => typeof card.classification === 'string' && card.classification.length > 0),
    `every card names its classification: ${JSON.stringify(summary.cards)}`);

  // 5. Open an occurrence: a confirmed element-level finding, opened the way the panel offers it.
  const candidates = await evaluate(panel,
    `Array.from(document.querySelectorAll('[data-result-card][data-classification="failed"] button[data-intent="SELECT_OCCURRENCE"]'), element => element.dataset.focusId)`);
  assert.ok(candidates.length > 0, 'the fixture must produce a confirmed element-level finding');
  let detail = null;
  for (const focusId of candidates) {
    await evaluate(panel, `(() => {
      const button = [...document.querySelectorAll('button[data-focus-id]')].find(node => node.dataset.focusId === ${JSON.stringify(focusId)});
      const group = button?.closest('details[data-abnt-group]');
      if (group && !group.open) group.querySelector('summary').click();
      return Boolean(button);
    })()`);
    await extension.click(panel, `button[data-focus-id="${focusId}"]`);
    detail = await waitForValue(panel, detailState,
      value => value !== null && value.action !== 'highlight-checking',
      { timeoutMs: 5_000, intervalMs: 25 }).catch(() => null);
    if (detail?.action === 'highlight-occurrence') break;
  }
  assert.ok(detail, 'opening an occurrence must render its detail');

  // 6. The didactic guidance must survive: who is affected, what was observed, how to fix it,
  // and the evidence that concludes or is still missing.
  for (const field of ['heading', 'affected', 'observed', 'correction']) {
    assert.ok((detail[field] ?? '').length > 0, `the detail must keep its guidance block "${field}": ${JSON.stringify(detail)}`);
  }
  // 7. Consult ABNT/WCAG, the estimated announcement and the evidence.
  assert.match(detail.normative ?? '', /WCAG/u, `the detail must map the WCAG criteria: ${detail.normative}`);
  assert.match(detail.normative ?? '', /ABNT NBR 17225/u, `the detail must map the ABNT item: ${detail.normative}`);
  assert.ok((detail.accessibility ?? '').length > 0, `the detail must show the accessibility evidence: ${detail.accessibility}`);
  assert.ok((detail.legal ?? '').length > 0, `the detail must carry the short normative reference: ${detail.legal}`);

  // 8. Mark the element on the page. Each occurrence offers its own marking, and it must appear
  // next to the element it names, above the page content.
  assert.equal(detail.action, 'highlight-occurrence', `a confirmed finding must offer live highlighting: ${JSON.stringify(detail)}`);
  assert.equal(await evaluate(extension.startPage.page,
    `document.querySelectorAll('[data-audita-highlight-root]').length`), 0,
  'reading the report alone must not draw anything on the page');
  await extension.click(panel, '[data-result-detail] .detail-actions [data-action="highlight-occurrence"]');
  const marked = await waitForValue(extension.startPage.page, `(() => {
    const root = document.querySelector('[data-audita-highlight-root]');
    if (!root) return null;
    const box = root.getBoundingClientRect();
    const covered = [...document.querySelectorAll('main *')].filter(element => {
      const other = element.getBoundingClientRect();
      return other.width > 0 && other.height > 0 && other.x < box.x + box.width && box.x < other.x + other.width &&
        other.y < box.y + box.height && box.y < other.y + other.height;
    }).map(element => element.id || element.tagName.toLowerCase());
    return { z: getComputedStyle(root).zIndex, text: (root.textContent ?? '').slice(0, 60),
      box: [Math.round(box.width), Math.round(box.height)],
      covered: covered.filter((tag, index, all) => all.indexOf(tag) === index) };
  })()`, value => value !== null, { timeoutMs: 20_000, intervalMs: 100 });
  assert.equal(marked.z, '2147483647', `the marking must sit above the page content: ${JSON.stringify(marked)}`);
  assert.match(marked.text, /Falha confirmada/u, `the marking must name what it marks: ${JSON.stringify(marked)}`);
  assert.ok(marked.box[0] > 0 && marked.box[1] > 0, `the marking must have a visible area: ${JSON.stringify(marked)}`);
  assert.ok(marked.covered.length > 0, `the marking must cover the element it names: ${JSON.stringify(marked)}`);

  // 9. Export the report from its own tab, and confirm the durable receipt.
  await extension.click(panel, 'button[data-intent="OPEN_REPORT"]');
  const report = await extension.waitForReport({ auditId: summary.auditId });
  await waitForValue(report, `Boolean(document.querySelector('button[data-report-export]'))`, value => value === true,
    { timeoutMs: 30_000 });
  await extension.click(report, 'button[data-report-export]');
  const downloads = await extension.waitForFourDownloads({ auditId: summary.auditId, timeoutMs: 300_000, intervalMs: 250 });
  assert.deepEqual(downloads.map(record => record.format), ['html', 'pdf', 'csv', 'json'],
    'the export must deliver all four formats');
  for (const record of downloads) {
    assert.equal(record.state, 'complete', record.format);
    assert.ok(record.byteLength > 0, record.format);
    assert.match(record.sha256, /^[a-f0-9]{64}$/u, record.format);
  }

  // The two promises about the page, checked at the end of the whole journey.
  assert.deepEqual(await evaluate(extension.startPage.page, pageState), before,
    'the journey must not move, focus or edit the audited page');
  assert.equal(await evaluate(extension.startPage.page, 'location.href'), `${fixture.origin}/current`,
    'the journey must not navigate the audited page');
  assert.deepEqual(await evaluate(panel, `({ w: innerWidth, h: innerHeight })`), panelSize,
    'the side panel must not resize itself during the journey');
  t.diagnostic(`journey ok; audit=${summary.auditId}; formats=${downloads.map(record => record.format).join(',')}`);
});
