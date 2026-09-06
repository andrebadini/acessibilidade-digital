import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_CHROME_PRODUCT,
  launchUnpackedExtension,
  resolveRealChromeTestBinary,
  startFixtureServer,
} from './support/real-chrome.mjs';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
const chromeBinary = resolveRealChromeTestBinary();
const queryMarker = 'AUDITA4AS_QUERY_7F93C26D';
const fragmentMarker = 'AUDITA4AS_FRAGMENT_51B8EA04';
const privateFieldNames = Object.freeze([
  'navigationToken', 'sessionDigest', 'urlSessionDigest', 'ownershipId', 'capabilityId',
]);

function targetDocument(controlCount) {
  const unnamedButtons = Array.from({ length: controlCount }, (_, index) =>
    `<button class="unnamed-control" data-sequence="${index}"></button>`).join('');
  return `<!doctype html>
    <html lang="pt-BR">
      <head><meta charset="utf-8"><title>Alvo local de auditoria</title></head>
      <body>
        <main>
          <h1>Página local com barreiras reproduzíveis</h1>
          <input id="unlabelled-field" type="text">
          <a href="/url-audit-target">clique aqui</a>
          <p style="text-align: justify">Lorem ipsum temporário para a validação local.</p>
          ${unnamedButtons}
        </main>
      </body>
    </html>`;
}

function publicLeakExpression({ rawUrl, markers }) {
  return `(() => {
    const text=document.documentElement?.outerHTML??'';
    const forbidden=${JSON.stringify([rawUrl, ...markers, ...privateFieldNames, 'owner_', 'hmac-sha256'])};
    return {
      forbidden:forbidden.filter(value=>text.includes(value)),
      rasterDataUrls:(text.match(/data:image\\/(?:png|jpeg|webp);base64,/giu)||[]).length,
      evidenceImages:document.querySelectorAll('[data-evidence-preview-image]').length
    };
  })()`;
}

for (const [name, controlCount, checkHighlight] of [
  ['audits one tokenized URL in no-pixels mode and keeps reports and exports public-safe', 240, false],
  ['highlights a live URL occurrence, clears it and exports its public-safe report', 20, true],
]) {
test(name, { timeout: 300_000 }, async t => {
  assert.ok(chromeBinary, 'AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório para o E2E real de Outra URL.');
  await access(chromeBinary, fsConstants.X_OK);
  const fixture = await startFixtureServer(t, new Map([
    ['/', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Origem local</title></head><body><main><h1>Página inicial</h1></main></body></html>',
    }],
    ['/url-audit-target', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: targetDocument(controlCount),
    }],
  ]));
  const rawUrl = `${fixture.origin}/url-audit-target?private_marker=${queryMarker}#${fragmentMarker}`;

  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(workspaceRoot),
    startUrl: `${fixture.origin}/`,
    downloadMode: 'profile',
    viewport: { width: 1280, height: 900 },
    chromeBinary,
    expectedMajor: 152,
  });
  assert.equal(extension.chromeProduct, CANONICAL_CHROME_PRODUCT);

  const panel = await extension.openSidePanelFromAction();
  await extension.waitForValue(panel,
    `document.querySelector('[data-screen]')?.dataset.screen`, value => value === 'initial');
  await extension.click(panel, 'button[data-intent="OPEN_URL_FORM"]');

  const entry = await extension.waitForValue(panel, `(() => ({
    screen:document.querySelector('[data-screen]')?.dataset.screen??null,
    form:Boolean(document.querySelector('#audit-form')),
    input:{
      name:document.querySelector('#audit-url')?.getAttribute('name')??null,
      type:document.querySelector('#audit-url')?.getAttribute('type')??null,
      required:document.querySelector('#audit-url')?.required??false,
      maxLength:document.querySelector('#audit-url')?.maxLength??null
    },
    selected:document.querySelector('input[name="capture-mode"]:checked')?.value??null,
    disabled:document.querySelector('[data-action="start-url-audit"]')?.disabled??null,
    note:document.querySelector('.availability-note')?.textContent??'',
    status:document.querySelector('[role="status"]')?.textContent??''
  }))()`, value => value?.form === true, { timeoutMs: 10_000, intervalMs: 25 });
  assert.deepEqual(entry.input, { name: 'audit-url', type: 'url', required: true, maxLength: 2048 });
  assert.equal(entry.screen, 'initial');
  assert.equal(entry.selected, 'full-evidence');
  assert.equal(entry.disabled, false, 'all three explicit capture modes remain available for another URL');
  assert.equal(entry.note, '');
  assert.equal(entry.status, 'Informe a URL e escolha como coletar as evidências.');

  await extension.click(panel, 'input[data-capture-mode="no-pixels"]');
  const explicitNoPixels = await extension.waitForValue(panel, `(() => ({
    selected:document.querySelector('input[name="capture-mode"]:checked')?.value??null,
    disabled:document.querySelector('[data-action="start-url-audit"]')?.disabled??null,
    notice:document.querySelector('[data-capture-option="no-pixels"]')?.textContent??''
  }))()`, value => value?.selected === 'no-pixels' && value?.disabled === false,
  { timeoutMs: 5_000, intervalMs: 25 });
  assert.equal(explicitNoPixels.selected, 'no-pixels');
  assert.equal(explicitNoPixels.disabled, false);
  assert.match(explicitNoPixels.notice, /sem capturar pixels/iu);

  assert.equal(await extension.evaluate(panel, `(() => {
    const input=document.querySelector('#audit-url');
    input.value=${JSON.stringify(rawUrl)};
    input.dispatchEvent(new Event('input',{bubbles:true}));
    return input.value===${JSON.stringify(rawUrl)};
  })()`), true);
  await extension.click(panel, '[data-action="start-url-audit"]');

  const progress = await extension.waitForValue(panel, `(() => {
    const root=document.querySelector('[data-screen="running"]');
    const progress=root?.querySelector('progress[data-audit-progress]');
    return root&&progress?{
      present:true,
      label:progress.getAttribute('aria-label'),
      phases:root.querySelectorAll('[data-running-phases] li').length,
      status:root.querySelector('[role="status"]')?.textContent??''
    }:null;
  })()`, value => value?.present === true, { timeoutMs: 30_000, intervalMs: 10 });
  assert.match(progress.label, /Progresso da auditoria/u);
  assert.ok(progress.phases >= 4);
  assert.match(progress.status, /Auditoria em andamento|Etapa atual|Aguardando/u);

  let terminal;
  try {
    terminal = await extension.waitForValue(panel, `(() => ({
      screen:document.querySelector('[data-screen]')?.dataset.screen??null,
      status:document.querySelector('[role="status"]')?.textContent??null
    }))()`, value => ['result', 'unavailable', 'initial'].includes(value?.screen), {
      timeoutMs: 30_000, intervalMs: 50,
    });
  } catch {
    terminal = await extension.evaluate(panel, `(() => ({
      screen:document.querySelector('[data-screen]')?.dataset.screen??null,
      status:document.querySelector('[role="status"]')?.textContent??null
    }))()`);
  }
  if (terminal.screen !== 'result') {
    t.diagnostic(`terminal-screen=${terminal.screen}; status=${terminal.status}`);
    const diagnostic = await extension.evaluate(extension.harnessPage, `(async()=>{
      const [stored,contexts,storeModule]=await Promise.all([
        chrome.storage.session.get(null),
        chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']}),
        import(chrome.runtime.getURL('/src/storage/audit-store.js'))
      ]);
      const latest=await storeModule.createAuditStore().getLatest();
      const rows=Object.entries(stored).map(([key,value])=>({
        family:key.replace(/:[^:]+$/u,':*'),
        state:value&&typeof value==='object'&&typeof value.state==='string'?value.state:null,
        mode:value&&typeof value==='object'&&typeof value.mode==='string'?value.mode:null,
        commitState:value&&typeof value==='object'&&typeof value.commitState==='string'?value.commitState:null
      })).sort((left,right)=>left.family.localeCompare(right.family));
      return {
        latest:latest?{auditId:latest.auditId,status:latest.status,failureCode:latest.failureCode,modelRevision:latest.modelRevision}:null,
        session:rows,
        sidePanels:contexts.map(context=>({
          contextType:context.contextType,
          path:new URL(context.documentUrl).pathname,
          hasLaunch:new URL(context.documentUrl).searchParams.has('launch')
        }))
      };
    })()`, { awaitPromise: true });
    t.diagnostic(`sanitized-terminal=${JSON.stringify(diagnostic)}`);
  }
  assert.equal(terminal.screen, 'result', `single URL terminal=${terminal.screen}; status=${terminal.status}`);
  const auditId = await extension.readAttribute(panel, '[data-screen="result"]', 'data-audit-id');
  assert.match(auditId ?? '', /^[A-Za-z0-9._:-]{1,160}$/u);

  const summary = await extension.evaluate(panel, `(() => ({
    coverage:Number(document.querySelector('progress.coverage-progress')?.max??0),
    failures:document.querySelectorAll('[data-result-card][data-classification="failed"]').length,
    occurrences:document.querySelectorAll('button[data-intent="SELECT_OCCURRENCE"]').length,
    url:document.querySelector('.result-url')?.textContent??''
  }))()`);
  assert.ok(summary.coverage > 0);
  assert.ok(summary.failures > 0);
  assert.ok(summary.occurrences > 0);
  assert.equal(summary.url.includes('?'), false);
  assert.equal(summary.url.includes('#'), false);
  assert.equal(summary.url.includes(queryMarker), false);
  assert.equal(summary.url.includes(fragmentMarker), false);

  if (checkHighlight) {
    const controls = await extension.evaluate(panel,
      `Array.from(document.querySelectorAll('[data-result-card][data-classification="failed"] button[data-intent="SELECT_OCCURRENCE"]'), element=>element.dataset.focusId)`);
    let highlightable = false;
    for (const focusId of controls) {
      await extension.evaluate(panel, `(() => {
        const button=[...document.querySelectorAll('button[data-focus-id]')].find(node=>node.dataset.focusId===${JSON.stringify(focusId)});
        const group=button?.closest('details[data-abnt-group]');
        if(group&&!group.open)group.querySelector('summary').click();
        return Boolean(button);
      })()`);
      await extension.click(panel, `button[data-focus-id="${focusId}"]`);
      const action = await extension.waitForValue(panel,
        `document.querySelector('[data-result-detail] .detail-actions [data-action]')?.dataset.action??null`,
        value => ['highlight-occurrence', 'consult-evidence'].includes(value), {timeoutMs:5_000,intervalMs:25});
      if (action === 'highlight-occurrence') { highlightable = true; break; }
    }
    assert.equal(highlightable, true, 'at least one confirmed element-level finding must offer live highlighting');
  } else {
    await extension.evaluate(panel, `(() => {
      const button=document.querySelector('[data-result-card][data-classification="failed"] button[data-intent="SELECT_OCCURRENCE"]');
      const group=button?.closest('details[data-abnt-group]');
      if(group&&!group.open)group.querySelector('summary').click();
      return Boolean(button);
    })()`);
    await extension.click(panel, '[data-result-card][data-classification="failed"] button[data-intent="SELECT_OCCURRENCE"]');
  }
  await extension.evaluate(panel, `(() => {
    for(const block of document.querySelectorAll('[data-detail-block="normative"], [data-detail-block="accessibility"]')) {
      if(block.matches('details')&&!block.open)block.querySelector('summary').click();
    }
    return true;
  })()`);
  const detail = await extension.waitForValue(panel, `(() => ({
    visible:Boolean(document.querySelector('[data-result-detail]')),
    normative:document.querySelector('[data-detail-block="normative"]')?.textContent??'',
    accessibility:document.querySelector('[data-detail-block="accessibility"]')?.textContent??'',
    evidenceImages:document.querySelectorAll('[data-detail-block="previews"] [data-evidence-preview-image]').length,
    evidenceCopy:document.querySelector('[data-detail-block="previews"]')?.textContent??''
  }))()`, value => value?.visible === true, { timeoutMs: 10_000, intervalMs: 25 });
  assert.match(detail.normative, /WCAG\s+\d/u);
  assert.match(detail.normative, /ABNT NBR 17225:\s*\S/u);
  assert.match(detail.accessibility, /Anúncio esperado:/u);
  assert.equal(detail.evidenceImages, 0);
  assert.match(detail.evidenceCopy, /Nenhuma captura raster foi coletada|modo sem imagens/iu);

  if (checkHighlight) {
  try {
    await extension.waitForValue(panel,
      `Boolean(document.querySelector('[data-action="highlight-occurrence"]'))`, Boolean);
  } catch (error) {
    const selectedOccurrence = await extension.evaluate(panel,
      `document.querySelector('button[data-intent="SELECT_OCCURRENCE"][aria-pressed="true"]')?.dataset.focusId?.replace(/^occurrence-/, '')??null`);
    t.diagnostic(`highlight-ui=${JSON.stringify(await extension.evaluate(panel, `({
      heading:document.querySelector('[data-detail-block="heading"]')?.textContent,
      actions:Array.from(document.querySelectorAll('[data-result-detail] [data-action]'),e=>e.dataset.action),
      status:document.querySelector('[role="status"]')?.textContent
    })`))}`);
    t.diagnostic(`highlight-private-counts=${JSON.stringify(await extension.evaluate(extension.harnessPage, `(async()=>{
      const stored=await chrome.storage.session.get(null);
      const registry=stored['audita:highlight-bindings:v1'];
      const bindings=Object.values(registry?.bindingsByAuditPage??{});
      const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
      const revision=await store.getReportRevision(${JSON.stringify(auditId)});
      const selectedOccurrence=${JSON.stringify(selectedOccurrence)};
      let modelProof='not-loaded';
      try {
        const authority=(await import(chrome.runtime.getURL('/src/background/highlight-model-authority.js'))).createHighlightModelAuthority({auditStore:store});
        const snapshot=await authority.loadValidated({auditId:${JSON.stringify(auditId)}});
        const {assertBindingMatchesModel}=await import(chrome.runtime.getURL('/src/background/highlight-binding.js'));
        for(const binding of bindings)assertBindingMatchesModel({binding,snapshot});
        modelProof='valid';
      } catch {modelProof='invalid';}
      return {
        bindingCount:bindings.length,
        targetCounts:bindings.map(binding=>Object.keys(binding.targets??{}).length),
        occurrences:revision?.model?.occurrences?.length,
        evidence:revision?.model?.evidence?.length,
        hasSelectedOccurrence:Boolean(selectedOccurrence),
        selectedIsBound:bindings.some(binding=>Object.hasOwn(binding.targets??{},selectedOccurrence)),
        modelProof,
        sessions:Object.values(stored).filter(value=>value?.auditId===${JSON.stringify(auditId)}).map(value=>({state:value.state,mode:value.mode,kind:value.targetBinding?.kind}))
      };
    })()`, {awaitPromise:true}))}`);
    throw error;
  }
  await extension.click(panel, '[data-action="highlight-occurrence"]');
  await extension.waitForValue(panel,
    `Boolean(document.querySelector('[data-action="clear-highlight"]'))`, Boolean);
  const liveOverlayCount = () => extension.evaluate(extension.harnessPage, `(async()=>{
    const targets=(await chrome.tabs.query({})).filter(tab=>tab.url===${JSON.stringify(rawUrl)});
    if(targets.length!==1)return null;
    const [observed]=await chrome.scripting.executeScript({target:{tabId:targets[0].id},func:()=>
      document.querySelectorAll('[data-audita-highlight-root="v1"]').length});
    return observed?.result??null;
  })()`, { awaitPromise: true });
  assert.equal(await liveOverlayCount(), 1, 'the explicit highlight action must reach the audited document');
  await extension.click(panel, '[data-action="clear-highlight"]');
  await extension.waitForValue(panel,
    `Boolean(document.querySelector('[data-action="highlight-occurrence"]'))`, Boolean);
  assert.equal(await liveOverlayCount(), 0, 'clearing the explicit highlight must remove its page overlay');
  }

  const panelLeak = await extension.evaluate(panel, publicLeakExpression({
    rawUrl, markers: [queryMarker, fragmentMarker],
  }));
  assert.deepEqual(panelLeak, { forbidden: [], rasterDataUrls: 0, evidenceImages: 0 });

  const durableProof = await extension.evaluate(extension.harnessPage, `(async()=>{
    const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
    const [revision,latest]=await Promise.all([
      store.getReportRevision(${JSON.stringify(auditId)}),
      store.getLatest()
    ]);
    const text=JSON.stringify({revision,latest});
    const forbidden=${JSON.stringify([rawUrl, queryMarker, fragmentMarker, ...privateFieldNames, 'owner_', 'hmac-sha256'])};
    return {
      revision:Boolean(revision),
      terminal:revision?.model?.session?.status??null,
      forbidden:forbidden.filter(value=>text.includes(value)),
      rasterDataUrls:(text.match(/data:image\\/(?:png|jpeg|webp);base64,/giu)||[]).length,
      rasterEvidence:(text.match(/full-page-screenshot|element-screenshot|announcement-map/gu)||[]).length,
      limitation:text.includes('PIXEL_CAPTURE_OMITTED')
    };
  })()`, { awaitPromise: true });
  assert.equal(durableProof.revision, true);
  assert.ok(['complete', 'partial'].includes(durableProof.terminal));
  assert.deepEqual(durableProof.forbidden, []);
  assert.equal(durableProof.rasterDataUrls, 0);
  assert.equal(durableProof.rasterEvidence, 0);
  assert.equal(durableProof.limitation, true);

  await extension.click(panel, 'button[data-intent="OPEN_REPORT"]');
  const report = await extension.waitForReport({ auditId });
  const reportState = await extension.waitForValue(report, `(() => ({
    navigation:Boolean(document.querySelector('[data-report-navigation]')),
    exportReady:Boolean(document.querySelector('button[data-report-export]')),
    occurrences:document.querySelectorAll('[data-report-issue]').length,
    normative:document.body?.textContent.includes('WCAG 2.2:')&&document.body?.textContent.includes('ABNT NBR 17225:'),
    announcement:document.body?.textContent.includes('Anúncio estimado:'),
    limitation:document.body?.textContent.includes('PIXEL_CAPTURE_OMITTED')||/sem imagens|captura raster/iu.test(document.body?.textContent??'')
  }))()`, value => value?.navigation === true && value?.exportReady === true && value?.occurrences > 0,
  { timeoutMs: 30_000, intervalMs: 50 });
  assert.equal(reportState.normative, true);
  assert.equal(reportState.announcement, true);
  assert.equal(reportState.limitation, true);

  const reportLeak = await extension.evaluate(report, publicLeakExpression({
    rawUrl, markers: [queryMarker, fragmentMarker],
  }));
  assert.deepEqual(reportLeak, { forbidden: [], rasterDataUrls: 0, evidenceImages: 0 });

  await extension.click(report, 'button[data-report-export]');
  let downloads;
  try {
    downloads = await extension.waitForFourDownloads({ auditId, timeoutMs: 90_000, intervalMs: 50 });
  } catch (error) {
    const exportDiagnostic = await extension.evaluate(extension.harnessPage, `(async()=>{
      const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
      const [receipt,journal,latest,contexts]=await Promise.all([
        store.getExportReceipt(${JSON.stringify(auditId)}),
        store.getExportDeliveryJournal(${JSON.stringify(auditId)}),
        store.getLatest(),
        chrome.runtime.getContexts({contextTypes:['TAB']})
      ]);
      return {
        receipt:receipt?{status:receipt.status,formats:receipt.formats.map(row=>({
          format:row.format,state:row.state,byteSize:row.byteSize,sha256:row.sha256,downloadId:row.downloadId
        }))}:null,
        journal:Array.isArray(journal)?journal.map(row=>({format:row.format,state:row.state,hasDownloadId:Number.isSafeInteger(row.downloadId)})):null,
        latest:latest?.auditId===${JSON.stringify(auditId)}?{status:latest.status,exportStatus:latest.exportStatus??null,message:latest.message??null}:null,
        exportTabs:contexts.filter(context=>new URL(context.documentUrl).pathname==='/src/export/index.html').length
      };
    })()`, { awaitPromise: true });
    const files = await Promise.all((await readdir(extension.downloadDirectory)).map(async name => {
      const info = await stat(join(extension.downloadDirectory, name));
      const bytes = await readFile(join(extension.downloadDirectory, name));
      return {
        name,
        extension: name.split('.').at(-1),
        bytes: info.size,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }));
    t.diagnostic(`sanitized-export=${JSON.stringify({ exportDiagnostic, files })}`);
    throw error;
  }
  assert.deepEqual(downloads.map(row => row.format), ['html', 'pdf', 'csv', 'json']);
  assert.equal(downloads.every(row => row.state === 'complete' && row.byteLength > 0 && /^[a-f0-9]{64}$/u.test(row.sha256)), true);

  const forbiddenExportValues = [rawUrl, queryMarker, fragmentMarker, ...privateFieldNames, 'owner_', 'hmac-sha256'];
  const exportProofs = await Promise.all(downloads.map(async row => {
    const bytes = await readFile(join(extension.downloadDirectory, row.filename));
    const text = bytes.toString('utf8');
    if (row.format === 'json') {
      const technical = JSON.parse(text.replace(/^\uFEFF/u, ''));
      assert.ok(technical.audit.evidence.length > 0, 'no-pixels still retains technical evidence');
      assert.equal(technical.audit.evidence.some(artifact =>
        Object.hasOwn(artifact.metadata ?? {}, 'captureReceivedAt')), false,
      'no-pixels must never invent a raster receipt from the page observation period');
    }
    return {
      format: row.format,
      forbidden: forbiddenExportValues.filter(value => text.includes(value)),
      rasterDataUrls: (text.match(/data:image\/(?:png|jpeg|webp);base64,/giu) ?? []).length,
      filenameLeak: [queryMarker, fragmentMarker].some(value => row.filename.includes(value)),
    };
  }));
  assert.equal(exportProofs.every(row => row.forbidden.length === 0 && row.rasterDataUrls === 0 && row.filenameLeak === false), true,
    JSON.stringify(exportProofs));
  t.diagnostic(`Chrome=${extension.chromeProduct}; source=single-url; mode=no-pixels; progress=visible; auditId=${auditId}; exports=html,pdf,csv,json; publicLeaks=0; rasterEvidence=0`);
});
}
