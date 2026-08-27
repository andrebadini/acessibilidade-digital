import assert from 'node:assert/strict';
import test from 'node:test';

import { renderPdf } from '../../src/browser/render-pdf.js';

const validPdf = Buffer.from('%PDF-1.7\nlocal report').toString('base64');

test('prints the report with accessible PDF parameters and validates its signature', async () => {
  const calls = [];
  const result = await renderPdf({ async command(method, params) { calls.push([method, params]); return { data: validPdf }; } });
  assert.deepEqual(calls, [['Page.printToPDF', {
    printBackground: true,
    preferCSSPageSize: true,
    generateTaggedPDF: true,
    generateDocumentOutline: true,
  }]]);
  assert.equal(new TextDecoder().decode(result.bytes.subarray(0, 5)), '%PDF-');
  assert.equal(result.usedFallback, false);
  assert.deepEqual(result.limitations, []);
});

test('retries exactly once without only tagged PDF and outline when experimental parameters are unsupported', async () => {
  const calls = [];
  const cdp = { async command(_method, params) {
    calls.push(params);
    if (calls.length === 1) throw new Error('Invalid parameters: generateTaggedPDF');
    return { data: validPdf };
  } };
  const result = await renderPdf(cdp);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].printBackground, true);
  assert.equal(calls[1].preferCSSPageSize, true);
  assert.equal(Object.hasOwn(calls[1], 'generateTaggedPDF'), false);
  assert.equal(Object.hasOwn(calls[1], 'generateDocumentOutline'), false);
  assert.equal(result.usedFallback, true);
  assert.match(result.limitations.join(' '), /marcado|outline|estrutura/iu);
});

test('does not retry unrelated failures and rejects malformed PDF payloads', async () => {
  let calls = 0;
  await assert.rejects(renderPdf({ async command() { calls += 1; throw new Error('Target closed'); } }), /Target closed/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(renderPdf({ async command() { calls += 1; throw new Error('Target closed while generateTaggedPDF was active'); } }), /Target closed/);
  assert.equal(calls, 1);
  await assert.rejects(renderPdf({ async command() { return { data: Buffer.from('not pdf').toString('base64') }; } }), /PDF|assinatura/i);
  await assert.rejects(renderPdf({ async command() { return { data: '***' }; } }), /base64|PDF/i);
});
