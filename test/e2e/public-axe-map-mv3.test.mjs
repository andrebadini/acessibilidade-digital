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
    const group = [...document.querySelectorAll('[data-report-item-group]')].find(group => group.querySelector('[data-result="failed"]'));
    group.open = true;
    const card = group.querySelector('[data-result="failed"]');
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
  const installedManifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  assert.equal(technical.audit.versions.extension, installedManifest.version,
    'exported producer version must match the installed extension');
  const audit = technical.audit;

  for (const page of audit.pages) {
    assert.ok(Object.values(page.viewport).every(value => Number.isFinite(value) && value > 0),
      'the actual exported page must retain its observed dimensions despite unavailable browser version');
  }
  assert.doesNotMatch(html, /Não foi possível registrar o viewport/);
  const itemById = new Map(audit.itemResults.map(item => [item.id, item]));
  const recommendedRules = audit.ruleResults.filter(rule => rule.source.engine === 'audita-core' &&
    itemById.get(rule.nbrItems[0])?.classification === 'recommendation');
  assert.ok(recommendedRules.length > 0);
  assert.ok(recommendedRules.every(rule => rule.summary.startsWith('Recomendação ')),
    'new exported recommendation summaries must not call them requirements');

  const supplementalImage = audit.occurrences.find(occurrence => occurrence.engineRuleId === 'image-alt' &&
    occurrence.framePath.length === 0);
  assert.ok(supplementalImage?.nodeId, 'supplemental image must correlate with the collected element');
  assert.equal(supplementalImage.outcome, 'cantTell');
  assert.equal(supplementalImage.legalAnalysis, null);
  const supplementalEvidence = audit.evidence.find(artifact => artifact.kind === 'element' &&
    artifact.nodeId === supplementalImage.nodeId && supplementalImage.evidenceRefs.includes(artifact.evidenceId));
  assert.match(supplementalEvidence?.dataUrl ?? '', /^data:image\/png;base64,/);
  assert.ok(supplementalEvidence.accessibility.announcementPreview.length > 0);
  // Public-URL reports are view-only; the live owned-page action belongs to the panel.
  await extension.startPage.page.command('Page.bringToFront');
  const imageControl = `button[data-focus-id="occurrence-${supplementalImage.occurrenceId}"]`;
  await extension.evaluate(panel, `(() => {
    const button = document.querySelector(${JSON.stringify(imageControl)});
    const group=button?.closest('details[data-abnt-group]');
    if(group&&!group.open)group.querySelector('summary').click();
    return Boolean(button);
  })()`);
  await extension.click(panel, imageControl);
  await extension.waitForValue(panel,
    `document.querySelector('[data-result-detail] .detail-actions [data-action]')?.dataset.action`,
    value => ['highlight-occurrence', 'consult-evidence'].includes(value));
  t.diagnostic(`supplemental-binding=${JSON.stringify(await extension.evaluate(extension.harnessPage, `(async()=>{
    const stored=await chrome.storage.session.get(null);
    const bindings=Object.values(stored['audita:highlight-bindings:v1']?.bindingsByAuditPage??{});
    const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
    const authority=(await import(chrome.runtime.getURL('/src/background/highlight-model-authority.js'))).createHighlightModelAuthority({auditStore:store});
    let modelProof='loading', revisions=[];
    try {
      const snapshot=await authority.loadValidated({auditId:${JSON.stringify(auditId)}});
      modelProof='binding';
      revisions=bindings.map(row=>({revision:row.modelRevision===snapshot.modelRevision,hash:row.modelHash===snapshot.modelHash}));
      const {assertBindingMatchesModel}=await import(chrome.runtime.getURL('/src/background/highlight-binding.js'));
      for(const binding of bindings)assertBindingMatchesModel({binding,snapshot});
      modelProof='valid';
    } catch {modelProof+='-invalid';}
    return {modelProof,revisions,bound:bindings.some(row=>Object.hasOwn(row.targets??{},${JSON.stringify(supplementalImage.occurrenceId)})),
      bindings:bindings.length,targets:bindings.map(row=>Object.keys(row.targets??{}).length),
      pages:(await chrome.tabs.query({})).filter(tab=>tab.url===${JSON.stringify(fixtureUrl)}).length};
  })()`, {awaitPromise:true}))}`);
  await extension.waitForValue(panel,
    `Boolean(document.querySelector('[data-action="highlight-occurrence"]'))`, Boolean);
  await extension.click(panel, '[data-action="highlight-occurrence"]');
  await extension.waitForValue(panel,
    `Boolean(document.querySelector('[data-action="clear-highlight"]'))`, Boolean);
  const overlayCount = () => extension.evaluate(extension.harnessPage, `(async()=>{
    const tabs=(await chrome.tabs.query({})).filter(tab=>tab.url===${JSON.stringify(fixtureUrl)});
    const counts=await Promise.all(tabs.map(tab=>chrome.scripting.executeScript({target:{tabId:tab.id},world:'ISOLATED',
      func:()=>document.querySelectorAll('[data-audita-highlight-root="v1"]').length})));
    return counts.flat().reduce((sum,entry)=>sum+entry.result,0);
  })()`, { awaitPromise: true });
  assert.equal(await overlayCount(), 1, 'the panel action must draw one overlay on the actual audited page');
  await extension.click(panel, '[data-action="clear-highlight"]');
  await extension.waitForValue(panel,
    `Boolean(document.querySelector('[data-action="highlight-occurrence"]'))`, Boolean);
  assert.equal(await overlayCount(), 0, 'clearing the supplemental finding must remove the overlay');
  await report.command('Page.bringToFront');

  // Read the actual retained occurrence, not an independently reconstructed label.
  const labelOccurrence = audit.occurrences.find(occurrence => occurrence.itemId === '5.13.7');
  assert.ok(labelOccurrence, 'the fixture must exercise the label-in-name finding');
  const labelEvidence = audit.evidence.find(artifact => artifact.kind === 'element' &&
    artifact.nodeId === labelOccurrence.nodeId && labelOccurrence.evidenceRefs.includes(artifact.evidenceId));
  assert.ok(labelEvidence);
  assert.equal(labelEvidence.accessibility.visibleText, 'B');
  assert.equal(labelEvidence.accessibility.name, 'Alvo pequeno vizinho');
  const recordedComparison = 'Texto visível registrado: “B” · Nome acessível registrado: “Alvo pequeno vizinho”.';
  const liveComparisons = await extension.evaluate(report,
    `[...document.querySelectorAll('[data-report-label-comparison]')].map(row=>({id:row.dataset.reportLabelComparison,text:row.textContent}))`);
  assert.deepEqual(liveComparisons, [{ id: labelEvidence.evidenceId, text: recordedComparison }]);
  assert.ok(html.includes(`data-report-label-comparison="${labelEvidence.evidenceId}"`));
  assert.ok(html.includes(recordedComparison));
  await extension.evaluate(report, `(() => {
    const row=document.querySelector('[data-report-label-comparison]');
    for(let parent=row.parentElement;parent;parent=parent.parentElement) {
      if(parent.tagName==='DETAILS') parent.open=true;
    }
    row.closest('[data-report-issue], [data-checklist-question]').scrollIntoView({behavior:'instant',block:'start'});
    return true;
  })()`);
  await extension.captureJourney('recorded-label-comparison', report, { captureBeyondViewport: false });
  t.diagnostic('recorded-label-comparison=retained-element=JSON=live=HTML; visible=B; accessible=Alvo pequeno vizinho');

  // Generic questions retain their guides in the separate ABNT checklist.
  for (const [itemId, phrase] of [
    ['5.1.7', 'Procure outra forma de obter a mesma informação'],
    ['5.1.8', 'tempo observado'],
    ['5.1.9', 'Essa tecla não é a única solução possível'],
    ['5.12.1', '24 pixels (16 × 1,5)'],
    ['5.12.2', '32 pixels (16 × 2)'],
    ['5.12.3', '1,92 pixels (16 × 0,12)'],
    ['5.12.4', '2,56 pixels (16 × 0,16)'],
  ]) {
    assert.ok(audit.occurrences.some(occurrence => occurrence.itemId === itemId));
    const guide = await extension.evaluate(report,
      `([...document.querySelectorAll('[data-checklist-question]')].find(row=>row.querySelector('summary')?.textContent.startsWith('ABNT ${itemId} —')) ?? document.querySelector('[data-report-item-group="${itemId}"]'))?.textContent ?? ''`);
    assert.ok(guide.includes(phrase), `live guide missing for ${itemId}`);
    assert.ok(html.includes(phrase), `exported guide missing for ${itemId}`);
  }
  for (const itemId of ['5.1.9', '5.12.2']) {
    await extension.evaluate(report, `(() => {
      const group=[...document.querySelectorAll('[data-checklist-question]')].find(row=>row.querySelector('summary')?.textContent.startsWith('ABNT ${itemId} —')) ?? document.querySelector('[data-report-item-group="${itemId}"]');
      for(let parent=group;parent;parent=parent.parentElement) if(parent.tagName==='DETAILS') parent.open=true;
      const card=group.querySelector('[data-report-issue]') ?? group;
      for(const detail of card.querySelectorAll('details')) detail.open=true;
      card.scrollIntoView({behavior:'instant',block:'start'});
      return true;
    })()`);
    await extension.captureJourney(`practical-guide-${itemId}`, report, { captureBeyondViewport: false });
  }
  t.diagnostic('practical-guides=7; separate-ABNT-checklist=live=HTML; pending-results-preserved');

  const rasters = audit.evidence.filter(artifact =>
    ['full-page', 'element'].includes(artifact.kind) && typeof artifact.dataUrl === 'string');
  assert.ok(rasters.some(artifact => artifact.kind === 'full-page'));
  assert.ok(rasters.some(artifact => artifact.kind === 'element'));
  const liveCards = await extension.evaluate(report,
    `[...document.querySelectorAll('[data-report-annex] [data-report-evidence]')].map(card=>({id:card.dataset.reportEvidence,text:card.textContent}))`);
  for (const artifact of rasters) {
    const receivedAt = artifact.metadata?.captureReceivedAt;
    assert.equal(typeof receivedAt, 'string', 'each retained raster must carry its actual receipt time');
    assert.equal(new Date(receivedAt).toISOString(), receivedAt);
    const page = audit.pages.find(candidate => candidate.pageId === artifact.pageId);
    assert.ok(page && receivedAt >= page.timestamps.startedAt && receivedAt <= page.timestamps.endedAt,
      'receipt must fall inside its own observed page period in this real-clock fixture');
    assert.ok(html.includes(receivedAt));
    const card = liveCards.find(candidate => candidate.id === artifact.evidenceId);
    assert.ok(card?.text.includes(receivedAt), 'each live card must show its own recorded timestamp');
    assert.match(card.text, /Captura recebida pela extensão \(UTC\).*relógio local; não certificado/u);
  }
  assert.match(html, /relógio local; não certificado/u);
  const storedReceipts = await extension.evaluate(extension.harnessPage, `(async()=>{
    const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
    const revision=await store.getReportRevision(${JSON.stringify(auditId)});
    return {auditId:revision.model.auditId,modelHash:revision.modelHash,
      receipts:revision.model.evidence.filter(artifact=>['full-page','element'].includes(artifact.kind)&&typeof artifact.dataUrl==='string')
        .map(artifact=>[artifact.evidenceId,artifact.metadata?.captureReceivedAt])};
  })()`, { awaitPromise: true });
  assert.equal(storedReceipts.auditId, auditId);
  assert.equal(storedReceipts.modelHash, technical.exportDeliveryIdentity.modelHash);
  assert.deepEqual(storedReceipts.receipts, rasters.map(artifact => [artifact.evidenceId, artifact.metadata.captureReceivedAt]));
  t.diagnostic(`capture-receipts=${rasters.length}; persisted=JSON=live=HTML; local-clock-not-certified`);
  await extension.evaluate(report, `(() => {
    document.querySelector('[data-report-annex]').open=true;
    document.querySelector('[data-report-annex] [data-evidence-kind="full-page"]').scrollIntoView({behavior:'instant',block:'start'});
    return true;
  })()`);
  await extension.captureJourney('capture-receipt-full-page', report, { captureBeyondViewport: false });

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
  assert.equal(Object.hasOwn(map.metadata ?? {}, 'captureReceivedAt'), false, 'a derived map is not a new browser raster');
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
