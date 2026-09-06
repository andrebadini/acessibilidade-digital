import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_CHROME_PRODUCT,
  launchUnpackedExtension,
  resolveRealChromeTestBinary,
} from './support/real-chrome.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = join(root, 'test/e2e/fixtures');
const chromeBinary = resolveRealChromeTestBinary();
const expectedBrowser = 'Google Chrome for Testing 152.0.7977.64';
const privateMarkers = Object.freeze([
  'AXE-MAP-PRIVATE-TOKEN-847261',
  'AXE-MAP-PRIVATE-HTML-592314',
  'AXE-MAP-PRIVATE-FRAME-318405',
]);
const strictCsp = "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self' data:; frame-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; report-uri /csp-report";

test('proves axe/map only through action → Side Panel → public URL consent → worker → report → four downloads', { timeout: 300_000 }, async t => {
  assert.ok(chromeBinary, 'AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório para o E2E público real.');
  await access(chromeBinary, fsConstants.X_OK);
  const loopback = await startLoopback();
  t.after(() => loopback.close());

  const fixtureUrl = `${loopback.origin}/public-axe-map.html`;
  const response = await fetch(fixtureUrl);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-security-policy'), strictCsp);
  await response.arrayBuffer();

  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(root), startUrl: fixtureUrl, chromeBinary, expectedMajor: 152,
    downloadMode: 'profile',
    ...(process.env.AUDITA_E2E_ARTIFACT_ROOT ? {
      qaDirectory: join(process.env.AUDITA_E2E_ARTIFACT_ROOT, 'qa'),
      downloadDirectory: join(process.env.AUDITA_E2E_ARTIFACT_ROOT, 'downloads'),
    } : {}),
    viewport: { width: 1280, height: 800 },
  });
  assert.equal(extension.chromeProduct, CANONICAL_CHROME_PRODUCT);
  const panel = await extension.openSidePanelFromAction();
  const contexts = await extension.runtimeContexts({ contextTypes: ['SIDE_PANEL', 'POPUP'] });
  assert.equal(contexts.filter(value => value.contextType === 'SIDE_PANEL').length, 1);
  assert.equal(contexts.filter(value => value.contextType === 'POPUP').length, 0);
  await extension.waitForValue(panel,
    `document.querySelector('[data-screen]')?.dataset.screen`, value => value === 'initial');
  await extension.click(panel, 'button[data-focus-id="open-url-form"][data-intent="OPEN_URL_FORM"]');
  const publicUrlEntry = await extension.evaluate(panel, `(() => ({
    urlInput: Boolean(document.querySelector('#audit-url, input[name="audit-url"]')),
    fullEvidence: Boolean(document.querySelector('[name="capture-mode"][value="full-evidence"]')),
    submit: Boolean(document.querySelector('#audit-form button[type="submit"], [data-action="start-url-audit"]')),
    status: document.querySelector('[role="status"]')?.textContent ?? ''
  }))()`);
  assert.deepEqual(publicUrlEntry, {
    urlInput: true, fullEvidence: true, submit: true, status: 'Informe a URL e escolha como coletar as evidências.',
  }, 'MARCO3_PUBLIC_URL_CONSENT_MISSING');
  await extension.click(panel, '[name="capture-mode"][value="full-evidence"]');
  const entered = await extension.evaluate(panel, `(() => {
    const input=document.querySelector('#audit-url, input[name="audit-url"]');
    input.value=${JSON.stringify(fixtureUrl)};
    input.dispatchEvent(new Event('input',{bubbles:true}));
    return { mode: document.querySelector('[name="capture-mode"]:checked').value, value: input.value };
  })()`);
  assert.deepEqual(entered, { mode: 'full-evidence', value: fixtureUrl });
  await extension.click(panel, '[data-action="start-url-audit"]');
  await extension.waitForValue(panel,
    `Boolean(document.querySelector('[data-screen="running"][data-session-status="privacy-paused"] [data-action="confirm-pixel-capture"]'))`, Boolean, {
    timeoutMs: 60_000, intervalMs: 50,
  });
  assert.doesNotMatch(await extension.evaluate(panel, 'document.body.innerText'), new RegExp(privateMarkers.join('|'), 'u'));
  await extension.click(panel, '[data-action="confirm-pixel-capture"]');
  await extension.waitForValue(panel, `document.querySelector('[data-screen]')?.dataset.screen`, value => value === 'result', {
    timeoutMs: 120_000, intervalMs: 50,
  });
  const auditId = await extension.evaluate(panel,
    `document.querySelector('[data-screen="result"]')?.dataset.auditId`);
  assert.match(auditId ?? '', /^[A-Za-z0-9._:-]{1,160}$/u);
  const summaryMetrics = await extension.evaluate(panel,
    `[...document.querySelectorAll('.metric-grid button.metric')].map(button => button.textContent)`);
  assert.equal(summaryMetrics.length, 4);
  const groupedItems = await extension.evaluate(panel,
    `[...document.querySelectorAll('details[data-abnt-group]')].map(group => group.dataset.abntGroup)`);
  assert.ok(groupedItems.length > 0);
  assert.equal(new Set(groupedItems).size, groupedItems.length);
  await extension.click(panel, 'button[data-focus-id="metric-humanReview"]');
  assert.equal(await extension.evaluate(panel,
    `document.querySelector('button[data-focus-id="metric-humanReview"]').getAttribute('aria-pressed')`), 'true');
  assert.deepEqual(await extension.evaluate(panel,
    `[...document.querySelectorAll('.metric-grid button.metric')].map(button => button.textContent)`), summaryMetrics);
  await extension.click(panel, 'button[data-focus-id="metric-humanReview"]');
  await extension.captureJourney('friendly-panel-summary', panel, { captureBeyondViewport: false });
  await extension.click(panel, '[data-action="open-report"], button[data-focus-id="open-report"]');
  const report = await extension.waitForReport({ auditId });
  await extension.waitForValue(report, `Boolean(document.querySelector('button[data-report-export]'))`, Boolean, {
    timeoutMs: 30_000, intervalMs: 50,
  });
  await extension.captureJourney('friendly-report-summary', report, { captureBeyondViewport: false });
  const reportItems = await extension.evaluate(report,
    `[...document.querySelectorAll('[data-report-item-group]')].map(group => group.dataset.reportItemGroup)`);
  assert.ok(reportItems.length > 0);
  assert.equal(new Set(reportItems).size, reportItems.length);
  await extension.click(report, 'button[data-report-metric="humanReview"]');
  assert.equal(await extension.evaluate(report,
    `document.querySelector('button[data-report-metric="humanReview"]').getAttribute('aria-pressed')`), 'true');
  assert.equal(await extension.evaluate(report,
    `[...document.querySelectorAll('[data-report-issue]')].filter(issue => !issue.hidden).every(issue => issue.dataset.result === 'humanReview')`), true);
  await extension.click(report, 'button[data-report-metric="humanReview"]');
  await extension.evaluate(report, `(() => {
    const group = [...document.querySelectorAll('[data-report-item-group]')].find(group => group.querySelector('[data-result="humanReview"]'));
    group.open = true;
    const card = group.querySelector('[data-result="humanReview"]');
    card.querySelector('[data-report-issue-details]').open = true;
    card.scrollIntoView({ block: 'start', behavior: 'instant' });
    return true;
  })()`);
  await extension.captureJourney('friendly-report-occurrence', report, { captureBeyondViewport: false });
  await extension.click(report, 'button[data-report-export]');
  const downloads = await extension.waitForFourDownloads({ auditId, timeoutMs: 60_000, intervalMs: 50 });
  assert.deepEqual(downloads.map(value => value.format), ['html', 'pdf', 'csv', 'json']);
  const jsonRecord = downloads.find(value => value.format === 'json');
  const htmlRecord = downloads.find(value => value.format === 'html');
  const [jsonBytes, html] = await Promise.all([
    readFile(join(extension.downloadDirectory, jsonRecord.filename), 'utf8'),
    readFile(join(extension.downloadDirectory, htmlRecord.filename), 'utf8'),
  ]);
  const technical = JSON.parse(jsonBytes.replace(/^\uFEFF/u, ''));
  const audit = technical.audit;

  assert.equal(technical.schemaVersion, 2);
  assert.equal(technical.assertions.length, 146);
  assert.equal(audit.schemaVersion, 2);
  assert.equal(audit.requestedScope.mode, 'single');
  assert.equal(audit.pages.length, 1);
  assert.equal(audit.axe.status, 'complete', JSON.stringify({
    diagnostics: audit.axe.diagnostics,
    limitations: audit.axe.limitations,
  }));
  assert.deepEqual(audit.axe.diagnostics, []);
  assert.deepEqual(audit.axe.limitations, []);
  assert.equal(JSON.stringify(audit.axe).includes('AXE_RESULTS_TRUNCATED'), false);
  assert.equal(audit.axe.provenance.version, '4.13.0');
  assert.equal(audit.axe.provenance.config.preload, false);
  assert.equal(audit.axe.provenance.config.iframes, false);
  assert.deepEqual(audit.axe.provenance.config.rules['target-size'], { enabled: true });
  assert.deepEqual(audit.axe.provenance.gate, {
    enabled: true,
    targetSizeEnabled: true,
    code: 'AXE_MV3_CSP_E2E_PASSED',
    testedBrowser: expectedBrowser,
  });

  const targetSize = audit.occurrences.filter(occurrence => occurrence.source?.engine === 'axe-core' &&
    occurrence.source.engineRuleId === 'target-size');
  const topAxe = targetSize.find(occurrence => occurrence.target.framePath.length === 0);
  const frameAxe = targetSize.find(occurrence => occurrence.target.framePath.length > 0);
  const coreRule = audit.ruleResults.find(rule => rule.source?.engine === 'audita-core' &&
    rule.ruleId === 'target-size-minimum');
  assert.ok(topAxe, 'o axe não publicou target-size no documento principal');
  assert.equal(coreRule?.outcome, 'cantTell', 'exceções equivalente/essencial não podem ser descartadas automaticamente');
  assert.equal(topAxe.outcome, 'cantTell');
  assert.match(topAxe.nodeId || '', /^n-/u);
  assert.equal(topAxe.target.nodeId, topAxe.nodeId);
  assert.equal(topAxe.presentationTargetKey, `node:${topAxe.nodeId}`);
  assert.equal(topAxe.applicabilityEvidence, null);
  assert.deepEqual(topAxe.testedWcagRefs, []);
  assert.deepEqual(topAxe.foreignBenchmarkRefs, []);
  assert.equal(topAxe.legalAnalysis, null);
  assert.ok(audit.manualReview.some(entry => entry.occurrenceId === topAxe.occurrenceId));
  assert.ok(audit.axe.ruleResults.find(rule => rule.ruleId === 'axe.target-size')?.limitations
    .includes('A aplicabilidade ABNT não foi confirmada; o resultado permanece cantTell.'));
  assert.equal(frameAxe?.outcome, 'cantTell');
  assert.equal(frameAxe?.nodeId, null);
  assert.deepEqual(frameAxe?.testedWcagRefs, []);
  assert.equal(frameAxe?.legalAnalysis, null);

  const original = audit.evidence.find(artifact => artifact.kind === 'full-page' && artifact.state === 'pristine');
  const map = audit.evidence.find(artifact => artifact.kind === 'announcement-map' && artifact.state === 'derived');
  assert.ok(original, 'a captura pristine não chegou ao relatório técnico');
  assert.ok(map, 'o wrapper produtivo não publicou o mapa derivado');
  assert.equal(map.fullPageEvidenceId, original.evidenceId);
  assert.equal(map.derivation.sourceEvidenceId, original.evidenceId);
  assert.equal(map.derivation.sourceHash, original.hash);
  assert.match(original.hash, /^[a-f0-9]{64}$/u);
  assert.match(map.hash, /^[a-f0-9]{64}$/u);
  assert.match(map.derivation.geometrySnapshotHash, /^[a-f0-9]{64}$/u);
  assert.ok(map.segments.length > 0);
  assert.ok(map.legend.length > 0);
  assert.ok(map.segments.every(segment => /^[a-f0-9]{64}$/u.test(segment.contentHash)));
  const rendered = await extension.evaluate(report, `(() => {
    const card = document.querySelector('[data-announcement-map-page="page-1"]');
    return {
      images: [...card.querySelectorAll('img[data-map-segment-image]')].map(image => ({
        loaded: image.complete && image.naturalWidth > 0, alt: image.alt,
      })),
      legend: [...card.querySelectorAll('[data-map-marker]')].map(entry => ({
        number: Number(entry.dataset.mapMarker), text: entry.querySelector('bdi').textContent,
      })),
      sourceHash: card.querySelector('[data-map-provenance]').textContent,
      horizontalOverflow: card.scrollWidth > card.clientWidth + 1,
    };
  })()`);
  assert.equal(rendered.images.length, map.segments.length);
  assert.ok(rendered.images.every(image => image.loaded && image.alt.includes('Segmento')));
  assert.deepEqual(rendered.legend, map.legend.map(entry => ({ number: entry.number, text: entry.announcementPreview })));
  assert.ok(rendered.sourceHash.includes(original.hash));
  assert.equal(rendered.horizontalOverflow, false);
  await extension.evaluate(report, `document.querySelector('[data-announcement-map-page="page-1"]').scrollIntoView({ behavior: 'instant', block: 'start' })`);
  await extension.waitForValue(report,
    `Math.abs(document.querySelector('[data-announcement-map-page="page-1"]').getBoundingClientRect().top) < 2`, Boolean);
  await extension.captureJourney('report-reader-map', report, { captureBeyondViewport: false });
  assert.match(html, /data-announcement-map-page="page-1"/u);
  assert.match(html, new RegExp(map.hash, 'u'));
  assert.match(html, new RegExp(original.hash, 'u'));

  const publicTextOutputs = [html, ...loopback.cspReports];
  for (const marker of privateMarkers) {
    assert.deepEqual(pathsContaining(technical, marker), [], 'o JSON técnico contém marcador privado');
    for (const output of publicTextOutputs) {
      assert.equal(output.includes(marker), false, 'uma saída pública textual contém marcador privado');
    }
  }
  assert.equal(loopback.cspReports.length, 0, `violações CSP: ${loopback.cspReports.join(' ')}`);
  assert.doesNotMatch(`${html}\n${loopback.cspReports.join('\n')}`, /unsafe-eval|EvalError/iu);
  await extension.click(panel, 'button[data-intent="NEW_AUDIT"]');
  await extension.waitForValue(panel, `document.querySelector('[data-screen]')?.dataset.screen`, value => value === 'initial');
  assert.equal(await extension.evaluate(report,
    `Boolean(document.querySelector('[data-announcement-map-page="page-1"]'))`), true,
  'refazer must preserve the previous report and its evidence');
});

function pathsContaining(value, marker, path = '$', output = [], seen = new WeakSet()) {
  if (typeof value === 'string') {
    if (value.includes(marker)) output.push(path);
    return output;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) value.forEach((entry, index) => pathsContaining(entry, marker, `${path}[${index}]`, output, seen));
  else for (const [key, entry] of Object.entries(value)) pathsContaining(entry, marker, `${path}.${key}`, output, seen);
  return output;
}

async function startLoopback() {
  const cspReports = [];
  const files = new Map([
    ['/public-axe-map.html', ['public-axe-map.html', 'text/html; charset=utf-8', true]],
    ['/public-axe-map-frame.html', ['public-axe-map-frame.html', 'text/html; charset=utf-8', true]],
    ['/public-axe-map.css', ['public-axe-map.css', 'text/css; charset=utf-8', false]],
  ]);
  const server = createServer(async (request, response) => {
    if (request.url === '/csp-report' && request.method === 'POST') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { if (body.length < 16_384) body += chunk; });
      request.on('end', () => { cspReports.push(body.slice(0, 16_384)); response.writeHead(204); response.end(); });
      return;
    }
    const fixture = files.get(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!fixture) { response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); response.end('not found'); return; }
    const [name, contentType, html] = fixture;
    response.writeHead(200, {
      'content-type': contentType,
      ...(html ? { 'content-security-policy': strictCsp } : {}),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(await readFile(join(fixtureRoot, name)));
  });
  await new Promise((resolveListen, rejectListen) => server.listen(0, '127.0.0.1', error =>
    error ? rejectListen(error) : resolveListen()));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    cspReports,
    close: () => new Promise(resolveClose => server.close(resolveClose)),
  };
}
