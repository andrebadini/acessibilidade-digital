import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { projectReaderMaps, projectTechnicalEvidence } from '../../src/review/report-view.js';

// Modelo gerado pelo código publicado na 1.1.56 (f9ef99d), no percurso "full-evidence" com miniaturas
// de elemento e mapa anotado 1.0.0. Auditorias assim já estão guardadas no navegador de quem usa a
// extensão: a 1.1.57 precisa abri-las, gerar o relatório e desenhar a caixa a partir de highlightBox.
const legacy = () => JSON.parse(readFileSync(new URL('../../fixtures/audits/legacy-1.1.56-full-evidence.json', import.meta.url), 'utf8'));

test('a 1.1.56 full-evidence audit (map 1.0.0, thumbnails without highlightParts) still opens and renders', () => {
  const stored = legacy();
  const map = stored.evidence.find(artifact => artifact.kind === 'announcement-map');
  assert.equal(map.derivation.version, '1.0.0');
  const elements = stored.evidence.filter(artifact => artifact.kind === 'element');
  assert.ok(elements.length > 0);
  assert.ok(elements.every(artifact => artifact.metadata.highlightParts === undefined && artifact.metadata.pixelScale === undefined));

  const model = createAuditModel(stored);
  assert.equal(model.evidence.find(artifact => artifact.kind === 'announcement-map').derivation.version, '1.0.0');

  const html = renderHtmlReport(model);
  assert.match(html, /class="evidence-highlight /u);
  assert.match(html, /data-evidence-kind="announcement-map"|annotation|mapa/iu);

  // A revisão da extensão projeta as mesmas evidências (miniaturas e mapa) a partir do modelo guardado.
  assert.ok(projectTechnicalEvidence(model));
  assert.ok(projectReaderMaps(model));
});
