import assert from 'node:assert/strict';
import test from 'node:test';

import { migrateAuditV1ToV2 } from '../../src/core/report/audit-model.js';
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

test('does not invent an extension version when a new draft has no installed version', async () => {
  const model = await enrichAuditForReport(rawAudit(), { now: () => '2026-08-26T15:00:00.000Z' });
  assert.equal(model.versions.extension, 'não disponível');
});

test('preserves the producer version of a stored report when enriched by a newer installation', async () => {
  const options = { now: () => '2026-08-26T15:00:00.000Z', manifestVersion: '1.1.11' };
  const stored = await enrichAuditForReport(rawAudit(), options);
  const previous = structuredClone(stored);
  const revised = await enrichAuditForReport(stored, { ...options, manifestVersion: '1.1.12' });
  assert.equal(revised.versions.extension, '1.1.11');
  assert.deepEqual(stored, previous);
});

test('derives one factual environment diagnostic when an observed V1 viewport is wholly unavailable', async () => {
  const expectedDerived = {
    code: 'ENVIRONMENT_UNAVAILABLE',
    message: 'Os metadados públicos do ambiente não puderam ser lidos.',
    at: '2026-08-26T14:01:00.000Z',
    recoverable: true,
  };
  const withoutDiagnostic = rawAudit({
    timezone: 'America/Cuiaba',
    versions: { extension: '0.1.0', rules: '1.0.0', browser: 'Chrome/147.0.0.0' },
  });
  const migrated = migrateAuditV1ToV2(withoutDiagnostic);

  assert.deepEqual(
    migrated.pages[0].diagnostics.filter(entry => entry.code === 'ENVIRONMENT_UNAVAILABLE'),
    [expectedDerived],
  );
  assert.deepEqual(
    migrated.session.diagnostics.filter(entry => entry.code === 'ENVIRONMENT_UNAVAILABLE'),
    [expectedDerived],
  );

  const recordedAt = '2026-08-26T14:00:20.000Z';
  const withDiagnostic = structuredClone(withoutDiagnostic);
  withDiagnostic.session.diagnostics.push({ ...expectedDerived, at: recordedAt });
  const preserved = migrateAuditV1ToV2(withDiagnostic);
  assert.deepEqual(
    preserved.pages[0].diagnostics.filter(entry => entry.code === 'ENVIRONMENT_UNAVAILABLE'),
    [{ ...expectedDerived, at: recordedAt }],
  );

  const enriched = await enrichAuditForReport(withoutDiagnostic, {
    now: () => '2026-08-26T15:00:00.000Z',
    timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0',
    rulesVersion: '1.0.0',
    browserVersion: 'Chrome/147.0.0.0',
  });
  assert.deepEqual(
    enriched.pages[0].diagnostics.filter(entry => entry.code === 'ENVIRONMENT_UNAVAILABLE'),
    [expectedDerived],
  );
  assert.match(renderHtmlReport(enriched), /ENVIRONMENT_UNAVAILABLE/u);
});

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
    input.evidence.artifacts.map(({ hash: _hash, ...artifact }) => ({
      ...artifact,
      ...(artifact.selector ? { selector: { ...artifact.selector, framePath: artifact.selector.framePath ?? [] } } : {}),
    })),
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

test('recomputes reproducibility hashes only from the canonical migrated report sources', async () => {
  const input = rawAudit({
    reproducibility: {
      methodologyVersion: '1.0.0', snapshotHash: 'a'.repeat(64),
      ruleResultsHash: 'b'.repeat(64), evidenceHash: 'c'.repeat(64), capturedStateCount: 1,
    },
  });
  const model = await enrichAuditForReport(input, {
    now: () => '2026-08-26T15:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  const evidenceManifest = model.evidence.map(artifact => ({
    evidenceId: artifact.evidenceId,
    pageId: artifact.pageId,
    kind: artifact.kind,
    nodeId: artifact.nodeId ?? null,
    hash: artifact.hash ?? null,
    fullPageEvidenceId: artifact.fullPageEvidenceId ?? null,
  }));

  assert.equal(model.reproducibility.snapshotHash, await sha256Hex(canonicalStringify(model.snapshot)));
  assert.equal(model.reproducibility.ruleResultsHash, await sha256Hex(canonicalStringify(model.ruleResults)));
  assert.equal(model.reproducibility.evidenceHash, await sha256Hex(canonicalStringify(evidenceManifest)));
  assert.equal(model.reproducibility.evidenceHash, model.integrity.evidenceManifestHash);
  assert.equal(model.reproducibility.capturedStateCount, model.evidenceStateCount);
  assert.doesNotMatch(JSON.stringify(model), new RegExp(`${'a'.repeat(64)}|${'b'.repeat(64)}|${'c'.repeat(64)}`, 'u'));
});

test('preserves failed and cancelled outcomes while deriving explicit limitations', async () => {
  for (const status of ['failed', 'cancelled']) {
    const base = rawAudit();
    const input = rawAudit({
      finalUrl: status === 'cancelled' ? base.requestedUrl : base.finalUrl,
      session: {
        status, partial: false,
        diagnostics: [{
          code: status === 'failed' ? 'CORE_AUDIT_FAILED' : 'NAVIGATION_FAILED',
          message: status === 'failed'
            ? 'O núcleo de regras não pôde concluir a auditoria.'
            : 'A auditoria foi cancelada.',
          at: '2026-08-26T14:00:30.000Z', recoverable: false,
        }],
      },
      ruleResults: [],
      itemResults: base.itemResults.map(item => ({ ...item, outcome: 'cantTell', ruleResults: [] })),
      occurrences: [],
      evidence: status === 'failed'
        ? { stateCount: 1, artifacts: base.evidence.artifacts.filter(artifact => artifact.kind === 'full-page') }
        : { stateCount: 0, artifacts: [] },
      manualReview: [],
      reviewDecisions: [],
      ...(status === 'failed' ? {} : { snapshot: null }),
    });
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

test('rejects mutation of a finalized V2 batch scope before enrichment', async () => {
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

  await assert.rejects(enrichAuditForReport(input, options), /integridade|hash/iu);
});
