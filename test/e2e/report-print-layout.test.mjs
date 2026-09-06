import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { REPORT_CSS } from '../../src/core/report/report.css.js';
import { createCdpPipeTransport, resolveRealChromeTestBinary, terminateChromeProcess } from './support/real-chrome.mjs';

test('printed issue groups flow across pages without a near-empty heading page', { timeout: 60_000 }, async t => {
  const binary = resolveRealChromeTestBinary();
  assert.ok(binary, 'Configure AUDITA_E2E_CHROME for the real print layout test.');
  const directory = await mkdtemp(join(tmpdir(), 'audita-print-layout-'));
  // The same nested group/header/details structure used by the exported report.
  // Twelve explanatory blocks fit in two A4 pages at a readable 10–11 pt size.
  const blocks = Array.from({ length: 12 }, (_, index) => `<section class="issue-plain-block"><h4>Explicação ${index}</h4><p>Uma descrição objetiva com informação importante da ocorrência. Preserve todo o texto nesta impressão.</p></section>`).join('');
  const html = `<!doctype html><html class="report-view-document" lang="pt-BR"><head><meta charset="utf-8"><style>${REPORT_CSS}</style></head><body><main><h1>Avaliação</h1><details data-report-item-group open><summary>Item ABNT</summary><article data-report-issue><header data-report-issue-heading><h3>Idioma da página</h3><p>Resultado neste item: falha</p><p>Classificação requisito</p></header><details data-report-issue-details open><summary>Entender o resultado</summary>${blocks}</details></article></details></main></body></html>`;
  const child = spawn(binary, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--password-store=basic', '--use-mock-keychain', `--user-data-dir=${join(directory, 'profile')}`,
    '--no-proxy-server', '--remote-debugging-pipe', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const browser = createCdpPipeTransport({ readable: child.stdio[4], writable: child.stdio[3] });
  t.after(async () => {
    browser.close();
    await terminateChromeProcess(child);
    await rm(directory, { recursive: true, force: true });
  });
  const { targetId } = await browser.command('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.command('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params = {}) => browser.command(method, params, { sessionId });
  const { frameTree } = await command('Page.getFrameTree');
  await command('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
  await command('Runtime.evaluate', { expression: 'document.fonts.ready.then(()=>true)', awaitPromise: true });
  const result = await command('Page.printToPDF', { preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
  const pdf = Buffer.from(result.data, 'base64');
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const pages = [...pdf.toString('latin1').matchAll(/\/Type\s*\/Page\b/gu)].length;
  assert.ok(pages >= 1 && pages <= 2, `Explanatory fixture occupies ${pages} pages; expected at most two without artificial gaps.`);
  t.diagnostic(`print-layout=A4; explanatory-blocks=12; pages=${pages}`);
});
