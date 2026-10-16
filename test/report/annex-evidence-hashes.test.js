import assert from 'node:assert/strict';
import test from 'node:test';

import { decodePngDataUrl } from '../../src/core/evidence/png.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { sha256Hex } from '../../src/core/report/hash.js';
import { buildPanelSummary } from '../../src/panel/panel-summary.js';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { buildReportView } from '../../src/review/report-view.js';

// O anexo do relatório entregue é o lugar único de cada evidência: imagem, ID e os DOIS SHA-256 inteiros
// (o do registro e o do arquivo PNG). As ocorrências apontam para o item do anexo ("ver Anexo de
// evidências, item N"), e cada evidência aparece uma vez — nada de procurar a ficha de olho no arquivo.

const ELEMENT_PNG_SHA256 = await sha256Hex(
  decodePngDataUrl(SAMPLE_AUDIT.evidence.find(evidence => evidence.kind === 'element').dataUrl).bytes);

async function fixture() {
  const inventory = await createInstalledCoreRuleInventory();
  const draft = structuredClone(SAMPLE_AUDIT);
  const element = draft.evidence.find(evidence => evidence.kind === 'element');
  element.binarySha256 = ELEMENT_PNG_SHA256;
  element.metadata = { width: 128, height: 88, highlightBox: { x: 24, y: 12, width: 80, height: 40, coordinateSpace: 'capture-css-px' } };
  draft.integrity.canonicalModelHash = 'pending';
  draft.integrity.evidenceManifestHash = 'pending';
  const model = await enrichAuditForReport(draft, {
    now: () => '2026-08-29T12:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '1.0.1', rulesVersion: inventory.rulesVersion, browserVersion: 'Chrome/151.0.0.0',
  });
  const checkpoint = {
    version: 1, auditId: model.auditId,
    pages: model.pages.map(page => ({
      pageId: page.pageId, attempted: page.attempted,
      startedAt: page.attempted ? page.timestamps.startedAt : null,
      rulesVersion: inventory.rulesVersion, inventoryVersion: inventory.inventoryVersion,
      inventoryHash: inventory.sha256, outcomes: [
        { ruleId: 'focus-fully-visible', outcome: 'passed' },
        { ruleId: 'keyboard-focus-trap', outcome: 'untested' },
      ],
    })),
  };
  const summary = await buildPanelSummary({ model, executionCheckpoint: checkpoint, inventory });
  const view = buildReportView({ model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash });
  return { model, view };
}

test('o anexo entregue mostra cada evidência uma vez, com ID e os dois SHA-256 inteiros', async () => {
  const { model, view } = await fixture();
  const html = renderHtmlReport(model, { reportView: view });
  const element = model.evidence.find(evidence => evidence.kind === 'element');
  // Uma ficha por evidência, identificada pelo item do anexo e pela âncora numerada.
  for (const [index, evidence] of view.technicalEvidence.entries()) {
    assert.equal((html.match(new RegExp(`data-report-evidence="${evidence.evidenceId}"`, 'gu')) ?? []).length, 1,
      `a evidência ${evidence.evidenceId} aparece uma única vez no anexo`);
    assert.equal((html.match(new RegExp(`id="report-evidence-${index + 1}"`, 'gu')) ?? []).length, 1);
    assert.match(html, new RegExp(`Item ${index + 1} — ${evidence.evidenceId}`, 'u'));
  }
  const card = html.slice(html.indexOf(`data-report-evidence="${element.evidenceId}"`)).split('</article>')[0];
  assert.match(card, /ID da evidência/u);
  assert.match(card, /Impressão digital \(SHA-256\) do registro/u);
  assert.match(card, /SHA-256 do arquivo de imagem \(PNG\)/u);
  assert.match(card, new RegExp(element.hash, 'u'));
  assert.match(card, new RegExp(element.binarySha256, 'u'));
  // A imagem é o arquivo que o segundo hash identifica: a ficha mostra o PNG ou — quando ele já foi
  // apresentado na seção da ocorrência, que é a regra de 1.1.61 de apresentar cada captura uma vez —
  // aponta para o lugar onde ele está. Uma das duas tem de existir, e o PNG está no arquivo.
  assert.ok(/<svg class="evidence-media[^"]*"[^>]*><use href="#evidence-image-\d+"/u.test(card) ||
    /A imagem não se repete aqui: <a href="#[\w-]+">/u.test(card),
    'a ficha do anexo mostra a imagem da própria evidência ou aponta para onde ela foi apresentada');
  assert.equal((html.match(/data:image\/png;base64,/gu) ?? []).length >= 1, true,
    'o PNG guardado vai dentro do próprio arquivo entregue');
  // A explicação em linguagem simples acompanha o anexo, uma vez.
  assert.equal((html.match(/impressão digital do arquivo/gu) ?? []).length >= 1, true);
});

test('as ocorrências apontam para o item do anexo, com o mesmo número do título da ficha', async () => {
  const { model, view } = await fixture();
  const html = renderHtmlReport(model, { reportView: view });
  const numbers = [...html.matchAll(/Ver Anexo de evidências, item (\d+)<\/a>/gu)].map(match => Number(match[1]));
  assert.ok(numbers.length > 0, 'a ocorrência cita o item do anexo');
  for (const number of new Set(numbers)) {
    assert.equal((html.match(new RegExp(`id="report-evidence-${number}"`, 'gu')) ?? []).length, 1);
    const annexed = view.technicalEvidence[number - 1];
    assert.match(html, new RegExp(`Item ${number} — ${annexed.evidenceId}`, 'u'));
  }
  // O link é um link de verdade no HTML entregue, não só um texto.
  assert.match(html, /<a data-report-consult-evidence href="#report-evidence-\d+">Ver Anexo de evidências, item \d+<\/a>/u);
});

test('o PDF de leitura preserva os dois hashes de cada evidência na tabela do anexo', async () => {
  const { model, view } = await fixture();
  const print = renderHtmlReport(model, { reportView: view, forPrint: true });
  const element = model.evidence.find(evidence => evidence.kind === 'element');
  const annexIndex = view.technicalEvidence.findIndex(evidence => evidence.evidenceId === element.evidenceId) + 1;
  const row = print.slice(print.indexOf(`<tr id="report-evidence-${annexIndex}"`)).split('</tr>')[0];
  assert.ok(row.includes(element.binarySha256), 'a linha do anexo é a da evidência do elemento');
  assert.match(row, /Impressão digital \(SHA-256\) do registro/u);
  assert.match(row, /SHA-256 do arquivo de imagem \(PNG\)/u);
  assert.match(row, new RegExp(element.hash, 'u'));
  assert.match(row, new RegExp(element.binarySha256, 'u'));
  assert.match(print, /Item \d+ — ev-/u);
});

test('o relatório autônomo nomeia o Anexo de evidências e leva o número do item na legenda', async () => {
  const { model } = await fixture();
  const html = renderHtmlReport(model);
  const element = model.evidence.find(evidence => evidence.kind === 'element');
  const annexNumber = model.evidence.indexOf(element) + 1;
  assert.match(html, /<h2 id="anexos-titulo">Anexo de evidências<\/h2>/u);
  assert.match(html, new RegExp(`<a href="#evidencia-${annexNumber}">ver Anexo de evidências, item ${annexNumber}</a>`, 'u'));
  const card = html.slice(html.indexOf(`id="evidencia-${annexNumber}"`)).split('</article>')[0];
  assert.match(card, new RegExp(`Item ${annexNumber} — ${element.evidenceId}`, 'u'));
  assert.match(card, new RegExp(element.binarySha256, 'u'));
  assert.match(card, /SHA-256 do arquivo de imagem \(PNG\)/u);
  // Nenhuma legenda manda procurar "o anexo" sem dizer o item.
  assert.doesNotMatch(html, /Consultar o arquivo original no anexo/u);
});
