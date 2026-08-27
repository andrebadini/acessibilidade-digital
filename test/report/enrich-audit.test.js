import assert from 'node:assert/strict';
import test from 'node:test';

import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { reportInput } from './helpers.js';

function rawAudit(overrides = {}) {
  const source = reportInput();
  const raw = {
    schemaVersion: source.schemaVersion,
    auditId: source.auditId,
    requestedUrl: 'https://example.test/path?token=TOPSECRET&view=public',
    finalUrl: source.finalUrl,
    timestamps: { startedAt: source.timestamps.startedAt, endedAt: source.timestamps.endedAt },
    environment: { chromeVersion: '', viewport: { width: null, height: null, deviceScaleFactor: null } },
    methodology: source.methodology,
    session: { status: 'partial', diagnostics: source.session.diagnostics, partial: true },
    snapshot: { coverage: { frames: 'partial' }, warnings: [{ code: 'FRAME_LIMITED' }] },
    ruleResults: source.ruleResults,
    itemResults: source.itemResults,
    occurrences: source.occurrences,
    evidence: source.evidence,
    manualReview: source.manualReview,
    reviewDecisions: source.reviewDecisions,
    progress: source.progress,
    report: source.report,
    reproducibility: source.reproducibility,
    ...overrides,
  };
  return raw;
}

test('enriches a raw partial audit without inventing unavailable viewport data', async () => {
  const input = rawAudit();
  const original = structuredClone(input);
  const model = await enrichAuditForReport(input, {
    now: () => '2026-08-26T15:00:00.000Z',
    timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0',
    rulesVersion: '1.0.0',
    browserVersion: 'Chrome/147.0.0.0',
  });
  assert.deepEqual(input, original);
  assert.equal(Object.isFrozen(input), false);
  assert.deepEqual(model.environment.viewport, { width: null, height: null, deviceScaleFactor: null });
  assert.equal(model.timestamps.generatedAt, '2026-08-26T15:00:00.000Z');
  assert.equal(model.timezone, 'America/Cuiaba');
  assert.deepEqual(model.versions, { extension: '0.1.0', rules: '1.0.0', browser: 'Chrome/147.0.0.0' });
  assert.equal(model.scope.kind, 'single-page-observed-state');
  assert.match(model.limitations.join(' '), /viewport[^.]*não disponível|não foi possível registrar o viewport/iu);
  assert.match(model.limitations.join(' '), /parcial|limitaç/iu);
  assert.equal(model.itemResults[0].outcome, input.itemResults[0].outcome);
  assert.deepEqual(
    model.evidence.artifacts.map(({ hash: _hash, ...artifact }) => artifact),
    input.evidence.artifacts.map(({ hash: _hash, ...artifact }) => artifact),
  );
  assert.ok(model.evidence.artifacts.every(artifact => /^[a-f0-9]{64}$/u.test(artifact.hash)));
  assert.deepEqual(model.reviewDecisions, input.reviewDecisions);
  assert.match(model.integrity.canonicalModelHash, /^[a-f0-9]{64}$/u);
  assert.match(model.integrity.evidenceManifestHash, /^[a-f0-9]{64}$/u);
  assert.match(model.integrity.hashBase, /sem|exclu|omit/iu);
  assert.doesNotMatch(JSON.stringify(model), /TOPSECRET|token=/u);
  assert.match(renderHtmlReport(model), /Viewport<\/dt><dd>não disponível/iu);
});

test('preserves failed and cancelled outcomes while deriving explicit limitations', async () => {
  for (const status of ['failed', 'cancelled']) {
    const input = rawAudit({ session: { status, diagnostics: [], partial: false } });
    const model = await enrichAuditForReport(input, {
      now: () => '2026-08-26T15:00:00.000Z', timezone: 'America/Cuiaba',
      manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'não disponível',
    });
    assert.equal(model.session.status, status);
    assert.match(model.limitations.join(' '), status === 'failed' ? /falhou|não concluída/iu : /cancelad/iu);
  }
});

test('recomputes evidence hashes from real PNG content and ignores forged input hashes', async () => {
  const png = lastByte => `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, lastByte]).toString('base64')}`;
  const input = rawAudit();
  const withPng = dataUrl => ({
    ...input,
    evidence: {
      ...input.evidence,
      artifacts: input.evidence.artifacts.map(artifact => ({ ...artifact, dataUrl, hash: 'forged-same-hash' })),
    },
  });
  const options = {
    now: () => '2026-08-26T15:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  };
  const first = await enrichAuditForReport(withPng(png(1)), options);
  const second = await enrichAuditForReport(withPng(png(2)), options);
  assert.match(first.evidence.artifacts[0].hash, /^[a-f0-9]{64}$/u);
  assert.match(second.evidence.artifacts[0].hash, /^[a-f0-9]{64}$/u);
  assert.notEqual(first.evidence.artifacts[0].hash, second.evidence.artifacts[0].hash);
  assert.notEqual(first.integrity.evidenceManifestHash, second.integrity.evidenceManifestHash);
  assert.notEqual(first.integrity.canonicalModelHash, second.integrity.canonicalModelHash);
});
