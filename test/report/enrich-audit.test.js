import assert from 'node:assert/strict';
import test from 'node:test';

import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { canonicalStringify } from '../../src/core/report/canonical-json.js';
import { sha256Hex } from '../../src/core/report/hash.js';
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
  assert.equal(model.schemaVersion, 2);
  assert.deepEqual(model.pages[0].viewport, { width: null, height: null, deviceScaleFactor: null });
  assert.equal(model.pages[0].pageId, 'page-1');
  assert.equal(model.timestamps.generatedAt, '2026-08-26T15:00:00.000Z');
  assert.equal(model.timezone, 'America/Cuiaba');
  assert.deepEqual(model.versions, { extension: '0.1.0', rules: '1.0.0', browser: 'Chrome/147.0.0.0' });
  assert.equal(model.scope.kind, 'single-page-observed-state');
  assert.match(model.limitations.join(' '), /viewport[^.]*não disponível|não foi possível registrar o viewport/iu);
  assert.match(model.limitations.join(' '), /parcial|limitaç/iu);
  assert.equal(model.itemResults[0].outcome, input.itemResults[0].outcome);
  assert.deepEqual(
    model.evidence.map(({ hash: _hash, pageId: _pageId, ...artifact }) => artifact),
    input.evidence.artifacts.map(({ hash: _hash, ...artifact }) => artifact),
  );
  assert.ok(model.evidence.every(artifact => /^[a-f0-9]{64}$/u.test(artifact.hash)));
  assert.deepEqual(model.reviewDecisions, input.reviewDecisions);
  assert.match(model.integrity.canonicalModelHash, /^[a-f0-9]{64}$/u);
  assert.match(model.integrity.evidenceManifestHash, /^[a-f0-9]{64}$/u);
  assert.match(model.integrity.hashBase, /sem|exclu|omit/iu);
  assert.doesNotMatch(JSON.stringify(model), /TOPSECRET|token=/u);
  assert.match(renderHtmlReport(model), /Viewport<\/dt><dd>não disponível/iu);
});

test('hashes the evidence manifest after V1 migration assigns final page IDs', async () => {
  const model = await enrichAuditForReport(rawAudit(), {
    now: () => '2026-08-26T15:00:00.000Z',
    timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0',
    rulesVersion: '1.0.0',
    browserVersion: 'Chrome/147.0.0.0',
  });
  const finalManifest = model.evidence.map(artifact => ({
    evidenceId: artifact.evidenceId,
    pageId: artifact.pageId,
    kind: artifact.kind,
    nodeId: artifact.nodeId ?? null,
    hash: artifact.hash ?? null,
    fullPageEvidenceId: artifact.fullPageEvidenceId ?? null,
  }));
  const expected = await sha256Hex(canonicalStringify(finalManifest));

  assert.equal(model.evidence[0].pageId, 'page-1');
  assert.equal(model.integrity.evidenceManifestHash, expected);
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
  const strictPngFixtures = [
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  ];
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
  const first = await enrichAuditForReport(withPng(strictPngFixtures[0]), options);
  const second = await enrichAuditForReport(withPng(strictPngFixtures[1]), options);
  assert.match(first.evidence[0].hash, /^[a-f0-9]{64}$/u);
  assert.match(second.evidence[0].hash, /^[a-f0-9]{64}$/u);
  assert.notEqual(first.evidence[0].hash, second.evidence[0].hash);
  assert.notEqual(first.integrity.evidenceManifestHash, second.integrity.evidenceManifestHash);
  assert.notEqual(first.integrity.canonicalModelHash, second.integrity.canonicalModelHash);
});

test('rejects hostile raw audit accessors without invoking page-controlled values', async () => {
  const input = rawAudit();
  let accessed = false;
  Object.defineProperty(input.occurrences[0], 'privateValue', {
    enumerable: true,
    get() {
      accessed = true;
      return 'PRIVATE_ENRICH_SENTINEL';
    },
  });

  await assert.rejects(enrichAuditForReport(input, {
    now: () => '2026-08-26T15:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  }), /modelo|auditoria|propriedade|segur/iu);

  assert.equal(accessed, false);
});

test('re-enriches native V2 pages and evidence without letting compatibility projections stale the integrity input', async () => {
  const options = {
    now: () => '2026-08-26T15:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  };
  const first = await enrichAuditForReport(rawAudit(), options);
  const firstHashInput = structuredClone(first);
  delete firstHashInput.integrity.canonicalModelHash;
  assert.equal(first.integrity.canonicalModelHash, await sha256Hex(canonicalStringify(firstHashInput)));
  const second = await enrichAuditForReport(first, {
    ...options,
    now: () => '2026-08-26T16:00:00.000Z',
  });

  assert.equal(Array.isArray(second.evidence), true);
  assert.equal(second.timestamps.generatedAt, '2026-08-26T16:00:00.000Z');
  assert.equal(second.pages[0].timestamps.generatedAt, '2026-08-26T16:00:00.000Z');
  assert.notEqual(second.integrity.canonicalModelHash, first.integrity.canonicalModelHash);
  const hashInput = structuredClone(second);
  delete hashInput.integrity.canonicalModelHash;
  assert.equal(second.integrity.canonicalModelHash, await sha256Hex(canonicalStringify(hashInput)));
});

test('preserves an explicit V2 batch scope instead of relabeling it as one page', async () => {
  const options = {
    now: () => '2026-08-26T15:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  };
  const input = structuredClone(await enrichAuditForReport(rawAudit(), options));
  input.limitations = [];
  input.requestedScope = {
    mode: 'batch',
    urls: [...input.requestedScope.urls, 'https://second.example.test/'],
  };
  input.pages.push({
    pageId: 'page-2', requestedUrl: 'https://second.example.test/',
    finalUrl: 'https://second.example.test/final', status: 'failed',
    timestamps: {
      startedAt: '2026-08-26T14:02:00.000Z', endedAt: '2026-08-26T14:02:01.000Z',
      generatedAt: '2026-08-26T15:00:00.000Z',
    },
    viewport: { width: null, height: null, deviceScaleFactor: null },
  });

  const model = await enrichAuditForReport(input, options);
  assert.equal(model.scope.kind, 'explicit-url-batch');
  assert.match(model.scope.description, /2 páginas|2 URLs/iu);
  assert.doesNotMatch(model.limitations.join(' '), /somente uma página/iu);
});
