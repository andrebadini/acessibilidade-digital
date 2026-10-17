import assert from 'node:assert/strict';
import test from 'node:test';

import { describeExportDelivery, exportDeliveryText } from '../../src/export/export-outcome-message.js';

const completeReceipt = {
  status: 'complete',
  limitations: [],
  formats: ['html', 'pdf', 'csv', 'json'].map(format => ({ format, status: 'complete' })),
};

test('complete delivery confirms all four files without alarming the reader', () => {
  const outcome = describeExportDelivery({ exportStatus: 'complete', deliveryReceipt: completeReceipt });
  assert.equal(outcome.tone, 'info');
  assert.match(outcome.headline, /quatro arquivos foram baixados/u);
  assert.deepEqual(outcome.lines, []);
  assert.equal(outcome.guidance, null);
});

test('a download failure names the format, the simple reason and what to do', () => {
  const receipt = {
    status: 'partial',
    limitations: [
      'O artefato PDF não concluiu o download (interrompido).',
      'O artefato CSV não concluiu o download (interrompido).',
      'O artefato JSON não concluiu o download (interrompido).',
    ],
    formats: [
      { format: 'html', status: 'complete' },
      { format: 'pdf', status: 'interrupted', failureCode: 'DOWNLOAD_INTERRUPTED' },
      { format: 'csv', status: 'interrupted', failureCode: 'DOWNLOAD_INTERRUPTED' },
      { format: 'json', status: 'interrupted', failureCode: 'DOWNLOAD_INTERRUPTED' },
    ],
  };
  const outcome = describeExportDelivery({ exportStatus: 'partial', deliveryReceipt: receipt });
  assert.equal(outcome.tone, 'error');
  assert.match(outcome.headline, /Alguns arquivos/u);
  assert.match(outcome.lines.join(' '), /Baixados: HTML\./u);
  assert.match(outcome.lines.join(' '), /PDF: o navegador interrompeu o download\./u);
  assert.match(outcome.lines.join(' '), /CSV: o navegador interrompeu o download\./u);
  assert.match(outcome.lines.join(' '), /JSON: o navegador interrompeu o download\./u);
  assert.match(outcome.guidance, /espaço livre/u);
  assert.match(outcome.guidance, /pasta de downloads/u);
  assert.match(outcome.guidance, /exporte novamente/u);
  assert.doesNotMatch(exportDeliveryText(outcome), /undefined|NaN/u);
});

test('an empty download says plainly that nothing was downloaded and never claims success', () => {
  const receipt = {
    status: 'partial',
    limitations: ['O artefato HTML não pôde iniciar o download.'],
    formats: [{ format: 'html', status: 'interrupted', failureCode: 'DOWNLOAD_START_FAILED' }],
  };
  const outcome = describeExportDelivery({ exportStatus: 'partial', deliveryReceipt: receipt });
  assert.equal(outcome.tone, 'error');
  assert.equal(outcome.headline, 'Nenhum arquivo do relatório foi baixado.');
  assert.match(outcome.lines.join(' '), /HTML: o navegador não conseguiu iniciar o download\./u);
  assert.match(exportDeliveryText(outcome), /exporte novamente/u);
});

test('a preparation failure keeps the controlled report message and adds a way forward', () => {
  const outcome = describeExportDelivery({
    exportStatus: 'failed',
    message: 'Não foi possível preparar os artefatos do relatório.',
    deliveryReceipt: { status: 'failed', formats: [], limitations: ['Não foi possível preparar os artefatos do relatório.'] },
  });
  assert.equal(outcome.tone, 'error');
  assert.match(outcome.headline, /Não foi possível preparar/u);
  assert.deepEqual(outcome.lines, ['Não foi possível preparar os artefatos do relatório.']);
  assert.match(outcome.guidance, /Tente novamente|exporte novamente|pasta de downloads/u);
});

test('partial delivery with all files complete but controlled ressalvas is a warning, not a failure', () => {
  const receipt = {
    status: 'partial',
    limitations: ['A liberação do endereço temporário do artefato PDF não pôde ser confirmada.'],
    formats: completeReceipt.formats,
  };
  const outcome = describeExportDelivery({ exportStatus: 'partial', deliveryReceipt: receipt });
  assert.equal(outcome.tone, 'warning');
  assert.match(outcome.headline, /ressalvas/u);
  assert.deepEqual(outcome.lines, receipt.limitations);
  assert.match(outcome.guidance, /podem ser usados normalmente/u);
});

test('a truncated, duplicated or unknown-format receipt never claims all four files were downloaded', () => {
  const cases = [
    [{ format: 'html', status: 'complete' }, { format: 'csv', status: 'complete' }],
    [...completeReceipt.formats, { format: 'html', status: 'complete' }],
    [...completeReceipt.formats, { format: 'xml', status: 'complete' }],
  ];
  for (const formats of cases) {
    const outcome = describeExportDelivery({
      exportStatus: 'complete',
      deliveryReceipt: { status: 'complete', limitations: [], formats },
    });
    assert.notEqual(outcome.tone, 'info');
    assert.doesNotMatch(outcome.headline, /quatro arquivos foram baixados/u);
    assert.ok(exportDeliveryText(outcome).length > 0);
    assert.doesNotMatch(exportDeliveryText(outcome), /undefined|NaN/u);
  }
});

test('missing or hostile receipt data degrades to a readable failure, never to undefined', () => {
  for (const value of [undefined, null, {}, { exportStatus: 'partial' },
    { exportStatus: 'complete', deliveryReceipt: { status: 'complete', formats: [] } }]) {
    const text = exportDeliveryText(describeExportDelivery(value));
    assert.ok(text.length > 0);
    assert.doesNotMatch(text, /undefined|NaN/u);
  }
});
