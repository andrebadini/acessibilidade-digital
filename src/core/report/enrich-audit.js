import { sanitizeResourceUrl } from '../normalize-snapshot.js';
import { hashEvidenceArtifact } from '../evidence/artifact-hash.js';
import { NBR17225_EDITORIAL_NOTES } from '../normative/nbr17225.js';
import { NORMATIVE_SOURCE_LEDGER } from '../normative/source-ledger.js';
import {
  createAuditModel,
  sanitizeEvidenceArtifactUrls,
} from './audit-model.js';
import { auditModelInputError, captureAuditInput } from './audit-input.js';
import { canonicalStringify } from './canonical-json.js';
import { sha256Hex } from './hash.js';
import {
  projectEvidenceManifest,
  REPORT_HASH_BASE,
  verifyAuditIntegritySnapshot,
} from './integrity.js';
import { verifyIntegrityLinks } from './integrity-chain.js';

export { REPORT_HASH_BASE } from './integrity.js';

export async function enrichAuditForReport(input, options = {}) {
  try {
    return await enrichCapturedAudit(captureAuditInput(input), options);
  } catch {
    throw auditModelInputError();
  }
}

async function enrichCapturedAudit(captured, options) {
  let raw = captured.schemaVersion === 1 ? structuredClone(captured) : captured;
  if (raw.schemaVersion === 2) {
    const canonical = createAuditModel(raw);
    if (declaresCompleteIntegrity(canonical.integrity)) await verifyIntegrityLinks(canonical);
    raw = structuredClone(canonical);
  }
  const generatedAt = canonicalNow(options.now);
  const timezone = validTimezone(options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const limitations = deriveLimitations(raw);
  const viewport = normalizedViewport(raw.environment?.viewport);
  if (viewport.width === null) limitations.push('Não foi possível registrar o viewport; dimensões e escala permanecem não disponíveis, sem valores estimados.');
  const endedAt = raw.timestamps?.endedAt ?? generatedAt;
  if (!raw.timestamps?.endedAt) limitations.push('O instante de término da auditoria não estava disponível; o instante de geração foi usado somente para fechar o registro temporal do relatório.');
  const rulesVersion = cleanVersion(options.rulesVersion ?? raw.methodology?.version, 'rulesVersion');
  const browserVersion = cleanVersion(options.browserVersion || raw.environment?.chromeVersion || 'não disponível', 'browserVersion');
  const sourceEvidence = Array.isArray(raw.evidence) ? raw.evidence : raw.evidence?.artifacts ?? [];
  const evidenceStateCount = Array.isArray(raw.evidence)
    ? raw.evidenceStateCount ?? raw.reproducibility?.capturedStateCount ?? 0
    : raw.evidence?.stateCount ?? 0;
  const sanitizedArtifacts = [];
  for (const artifact of sourceEvidence) {
    const sanitized = sanitizeEvidenceArtifactUrls(artifact);
    sanitizedArtifacts.push({
      ...sanitized,
      ...(raw.schemaVersion === 1 && sanitized.pageId === undefined ? { pageId: 'page-1' } : {}),
    });
  }
  const sanitizedArtifactById = new Map(sanitizedArtifacts.map(artifact => [artifact.evidenceId, artifact]));
  const evidenceArtifacts = [];
  for (const artifact of sanitizedArtifacts) {
    evidenceArtifacts.push({
      ...artifact,
      hash: await hashEvidenceArtifact(artifact, {
        sourceArtifact: artifact.kind === 'announcement-map'
          ? sanitizedArtifactById.get(artifact.fullPageEvidenceId)
          : undefined,
      }),
    });
  }
  raw.evidence = Array.isArray(raw.evidence)
    ? evidenceArtifacts
    : { ...(raw.evidence ?? {}), artifacts: evidenceArtifacts };
  const pages = Array.isArray(raw.pages)
    ? raw.pages.map(page => ({
      ...page,
      timestamps: { ...page.timestamps, generatedAt },
    }))
    : undefined;
  const isBatch = raw.schemaVersion === 2 && raw.requestedScope?.mode === 'batch';
  const handoffReviewUrl = ownDataOption(options, 'handoffReviewUrl');
  const base = {
    ...raw,
    ...(pages ? { pages } : {}),
    requestedUrl: sanitizeResourceUrl(raw.requestedUrl),
    finalUrl: sanitizeResourceUrl(raw.finalUrl),
    timestamps: { startedAt: raw.timestamps?.startedAt, endedAt, generatedAt },
    timezone,
    versions: {
      extension: cleanVersion(options.manifestVersion ?? '0.1.0', 'manifestVersion'),
      rules: rulesVersion,
      browser: browserVersion,
    },
    environment: { chromeVersion: browserVersion, viewport },
    scope: isBatch
      ? {
        kind: 'explicit-url-batch',
        description: `${raw.pages.length} páginas correspondentes à lista explícita de ${raw.requestedScope.urls.length} URLs; páginas e estados não solicitados não foram inferidos.`,
      }
      : {
        kind: 'single-page-observed-state',
        description: 'Página única e estado observado no instante da coleta; outras páginas, etapas e estados não foram inferidos.',
      },
    limitations: [...new Set(limitations)],
    ...(handoffReviewUrl.present ? {
      report: {
        status: 'review-ready', reviewUrl: canonicalHandoffReviewUrl(handoffReviewUrl.value),
        artifact: { status: 'pending', formats: [] },
      },
    } : {}),
    normative: raw.schemaVersion === 2 ? structuredClone(raw.normative) : {
      edition: 'ABNT NBR 17225:2025', wcag: 'WCAG 2.2',
      editorialNotes: NBR17225_EDITORIAL_NOTES.map(note => ({ ...note })),
      sources: structuredClone(NORMATIVE_SOURCE_LEDGER),
    },
    reproducibility: {
      ...(raw.reproducibility ?? {}),
      methodologyVersion: rulesVersion,
      capturedStateCount: raw.reproducibility?.capturedStateCount ?? evidenceStateCount,
    },
    integrity: { algorithm: 'SHA-256', evidenceManifestHash: 'pending', hashBase: REPORT_HASH_BASE },
  };
  const migratedOrNormalized = createAuditModel({
    ...base,
    integrity: { ...base.integrity, canonicalModelHash: 'pending' },
  });
  const normalized = raw.schemaVersion === 1
    ? createAuditModel({
      ...migratedOrNormalized,
      integrity: {
        algorithm: 'SHA-256', evidenceManifestHash: 'pending',
        canonicalModelHash: 'pending', hashBase: REPORT_HASH_BASE,
      },
    })
    : migratedOrNormalized;
  const normalizedArtifactById = new Map(normalized.evidence.map(artifact => [artifact.evidenceId, artifact]));
  const evidence = [];
  for (const artifact of normalized.evidence) {
    evidence.push({
      ...artifact,
      hash: await hashEvidenceArtifact(artifact, {
        sourceArtifact: artifact.kind === 'announcement-map'
          ? normalizedArtifactById.get(artifact.fullPageEvidenceId)
          : undefined,
      }),
    });
  }
  const withEvidenceHashes = createAuditModel({ ...normalized, evidence });
  const evidenceManifest = projectEvidenceManifest(withEvidenceHashes.evidence);
  const evidenceManifestHash = await sha256Hex(canonicalStringify(evidenceManifest));
  const withManifest = createAuditModel({
    ...withEvidenceHashes,
    integrity: { ...withEvidenceHashes.integrity, evidenceManifestHash, canonicalModelHash: 'pending' },
  });
  const hashInput = structuredClone(withManifest);
  delete hashInput.integrity.canonicalModelHash;
  const canonicalModelHash = await sha256Hex(canonicalStringify(hashInput));
  const finalModel = createAuditModel({
    ...withManifest,
    integrity: { ...withManifest.integrity, canonicalModelHash },
  });
  return verifyAuditIntegritySnapshot(finalModel);
}

function ownDataOption(options, key) {
  if (!options || (typeof options !== 'object' && typeof options !== 'function')) return { present: false };
  const descriptor = Object.getOwnPropertyDescriptor(options, key);
  if (!descriptor) return { present: false };
  if (!Object.hasOwn(descriptor, 'value')) throw new TypeError();
  return { present: true, value: descriptor.value };
}

function canonicalHandoffReviewUrl(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_048) throw new TypeError();
  const parsed = new URL(value);
  if (!['chrome-extension:', 'blob:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new TypeError();
  return parsed.href;
}

function declaresCompleteIntegrity(integrity) {
  return integrity?.algorithm === 'SHA-256' &&
    /^[a-f0-9]{64}$/u.test(integrity.canonicalModelHash ?? '') &&
    /^[a-f0-9]{64}$/u.test(integrity.evidenceManifestHash ?? '');
}

function canonicalNow(now) {
  const value = typeof now === 'function' ? now() : new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Instante de geração inválido.');
  return date.toISOString();
}

function validTimezone(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value) throw new TypeError('Fuso IANA inválido.');
  try { new Intl.DateTimeFormat('pt-BR', { timeZone: value }).format(new Date(0)); } catch { throw new TypeError('Fuso IANA inválido.'); }
  return value;
}

function cleanVersion(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} inválida.`);
  return value.trim();
}

function normalizedViewport(value) {
  const entries = ['width', 'height', 'deviceScaleFactor'].map(key => value?.[key]);
  if (entries.every(entry => Number.isFinite(entry) && entry > 0)) {
    return { width: entries[0], height: entries[1], deviceScaleFactor: entries[2] };
  }
  return { width: null, height: null, deviceScaleFactor: null };
}

function deriveLimitations(raw) {
  const limitations = Array.isArray(raw.limitations) ? raw.limitations.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()) : [];
  limitations.push(raw.schemaVersion === 2 && raw.requestedScope?.mode === 'batch'
    ? 'O relatório cobre somente a lista explícita de URLs e os estados observados; não constitui declaração de conformidade do site inteiro.'
    : 'O relatório cobre somente uma página e o estado observado; não constitui declaração de conformidade do site inteiro.');
  if (raw.session?.status === 'partial') limitations.push('A auditoria foi concluída parcialmente e contém limitações técnicas registradas nos diagnósticos.');
  if (raw.session?.status === 'failed') limitations.push('A auditoria falhou antes de ser concluída; resultados disponíveis devem ser interpretados como parciais.');
  if (raw.session?.status === 'cancelled') limitations.push('A auditoria foi cancelada; resultados disponíveis permanecem incompletos.');
  if (raw.snapshot?.coverage?.frames === 'partial' || (raw.snapshot?.warnings?.length ?? 0) > 0) {
    limitations.push('A cobertura estrutural contém avisos ou frames que não puderam ser observados integralmente.');
  }
  return limitations;
}
