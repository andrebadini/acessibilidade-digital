import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { buildCompleteReportSummary } from '../../src/panel/panel-summary.js';
import { buildReportView } from '../../src/review/report-view.js';
import { createCdpPipeTransport, resolveRealChromeTestBinary, startFixtureServer, terminateChromeProcess } from './support/real-chrome.mjs';

test('executive print keeps the complete ABNT matrix and reduces actual PDFs in live and downloaded reports', { timeout: 90_000 }, async t => {
  const binary = resolveRealChromeTestBinary();
  assert.ok(binary, 'Configure AUDITA_E2E_CHROME for native PDF verification.');
  const inventory = await createInstalledCoreRuleInventory();
  const model = await enrichAuditForReport(SAMPLE_AUDIT, {
    now: () => '2026-09-06T12:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '1.1.1', rulesVersion: inventory.rulesVersion, browserVersion: 'Chrome/152.0.7977.64',
  });
  const checkpoint = { version: 1, auditId: model.auditId, pages: model.pages.map(page => ({
    pageId: page.pageId, attempted: page.attempted, startedAt: page.attempted ? page.timestamps.startedAt : null,
    rulesVersion: inventory.rulesVersion, inventoryVersion: inventory.inventoryVersion, inventoryHash: inventory.sha256,
    outcomes: [{ ruleId: 'focus-fully-visible', outcome: 'passed' }, { ruleId: 'keyboard-focus-trap', outcome: 'untested' }],
  })) };
  const summary = await buildCompleteReportSummary({ model, executionCheckpoint: checkpoint, inventory });
  const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
  const routes = new Map([['/downloaded', { status: 200, headers: { 'content-type': 'text/html;charset=utf-8' }, body: renderHtmlReport(model, { reportView: view }) }]]);
  for (const path of await readdir(new URL('../../src/', import.meta.url), { recursive: true })) {
    if (!/\.(?:js|css)$/u.test(path)) continue;
    routes.set(`/src/${path}`, { status: 200, headers: { 'content-type': path.endsWith('.js') ? 'text/javascript' : 'text/css' },
      body: await readFile(new URL(`../../src/${path}`, import.meta.url), 'utf8') });
  }
  routes.set('/live', { status: 200, headers: { 'content-type': 'text/html;charset=utf-8' }, body: `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><link rel="stylesheet" href="/src/review/review.css"></head><body><main><h1>Relatório de auditoria de acessibilidade</h1><div id="report-root"></div></main><script type="module">import {renderReportView} from '/src/review/report-view.js';document.querySelector('#report-root').append(renderReportView({view:${JSON.stringify(view).replace(/</gu, '\\u003c')},document,onExport(){throw Error('EXPORT_NOT_ALLOWED')}}));</script></body></html>` });
  const server = await startFixtureServer(t, routes);
  const directory = await mkdtemp(join(tmpdir(), 'audita-executive-print-'));
  const child = spawn(binary, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--password-store=basic', '--use-mock-keychain', `--user-data-dir=${join(directory, 'profile')}`,
    '--no-proxy-server', '--remote-debugging-pipe', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const browser = createCdpPipeTransport({ readable: child.stdio[4], writable: child.stdio[3] });
  t.after(async () => { browser.close(); await terminateChromeProcess(child); await rm(directory, { recursive: true, force: true }); });
  const { targetId } = await browser.command('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.command('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params = {}) => browser.command(method, params, { sessionId });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitReady = () => evaluate(`new Promise((resolve,reject)=>{let tries=0;const check=()=>{if(document.querySelector('[data-report-print-summary]'))resolve(true);else if(++tries>200)reject(Error('REPORT_NOT_READY'));else setTimeout(check,25)};check()})`);
  const print = async name => {
    const result = await command('Page.printToPDF', { preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false, generateTaggedPDF: true });
    const pdf = Buffer.from(result.data, 'base64');
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    if (process.env.AUDITA_PRINT_QA_DIR) await writeFile(join(process.env.AUDITA_PRINT_QA_DIR, `${name}.pdf`), pdf, { flag: 'wx' });
    return [...pdf.toString('latin1').matchAll(/\/Type\s*\/Page\b/gu)].length;
  };
  for (const mode of ['downloaded', 'live']) {
    await command('Page.navigate', { url: `${server.origin}/${mode}` });
    await waitReady();
    await evaluate('document.fonts.ready.then(()=>true)');
    const fullPages = await print(`${mode}-full`);
    // Intercept only the OS print dialog. Capture the real renderer's document
    // at the exact window.print boundary, then rasterize it with native Chrome.
    const snapshot = await evaluate(`(() => {
      window.print=()=>{const snapshot=document.documentElement.cloneNode(true);snapshot.querySelectorAll('script').forEach(node=>node.remove());window.__printSnapshot=snapshot.outerHTML};
      document.querySelector('[data-report-print-summary]').click();
      return {html:window.__printSnapshot,restored:!document.querySelector('[data-print-layout="summary"]')};
    })()`);
    assert.equal(snapshot.restored, true);
    assert.ok(snapshot.html?.includes('data-print-layout="summary"'));
    const { frameTree } = await command('Page.getFrameTree');
    await command('Page.setDocumentContent', { frameId: frameTree.frame.id, html: snapshot.html });
    await command('Emulation.setEmulatedMedia', { media: 'print' });
    const retained = await evaluate(`(() => {
      const visible=node=>{for(let p=node;p;p=p.parentElement)if(getComputedStyle(p).display==='none')return false;return true};
      return {items:[...document.querySelectorAll('[data-report-matrix] tbody tr')].filter(visible).map(row=>row.querySelector('th').textContent),
        annexHidden:!visible(document.querySelector('[data-report-annex]')),
        detailsHidden:[...document.querySelectorAll('[data-report-issue]')].every(node=>!visible(node)),
        note:visible(document.querySelector('[data-report-summary-note]')),
        essentials:[1,6,7].every(index=>visible(document.getElementById('report-section-'+index))),
        identity:document.body.innerText.includes(${JSON.stringify(view.modelHash)})&&document.body.innerText.includes(${JSON.stringify(view.auditId)})};
    })()`);
    assert.deepEqual(retained.items, view.matrix.map(row => row.id));
    for (const key of ['annexHidden', 'detailsHidden', 'note', 'essentials', 'identity']) assert.equal(retained[key], true, `${mode}: ${key}`);
    const summaryPages = await print(`${mode}-summary`);
    assert.ok(summaryPages > 1 && summaryPages < fullPages, `${mode}: full=${fullPages}, summary=${summaryPages}`);
    t.diagnostic(`${mode}: full=${fullPages} pages; summary=${summaryPages} pages; all146ABNTitems; noindividualevidence`);
    await command('Emulation.setEmulatedMedia', { media: '' });
  }
});
