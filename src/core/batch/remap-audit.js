import { hashEvidenceArtifact } from '../evidence/artifact-hash.js';
import { hashAnnotationMapGeometry } from '../evidence/annotation-map-artifact.js';
import { createAuditModel } from '../report/audit-model.js';
import { canonicalStringify } from '../report/canonical-json.js';
import { sha256Hex } from '../report/hash.js';
import { derivePageLimitations } from '../report/text-policy.js';
import { projectAuditResourceOrigin } from '../privacy.js';

const ID = /^[A-Za-z0-9._:-]{1,200}$/u;

/** Validates and atomically remaps a transient single-page V2 graph into one batch page. */
export async function remapAuditPage(input, { batchAuditId, pageId }) {
  assertId(batchAuditId, 'batchAuditId');
  assertId(pageId, 'pageId');
  let model;
  try { model = createAuditModel(input); } catch (error) {
    if (/proxy that has been revoked/iu.test(error instanceof Error ? error.message : '')) {
      throw new TypeError('Modelo de auditoria filho inválido ou ilegível.');
    }
    throw error;
  }
  if (model.requestedScope.mode !== 'single' || model.pages.length !== 1) {
    throw new TypeError('O remapeamento aceita somente uma auditoria de página única validada.');
  }

  const occurrenceIds = new Map();
  for (const [index, occurrence] of model.occurrences.entries()) {
    occurrenceIds.set(occurrence.occurrenceId, `occurrence-${pageId}-${String(index + 1).padStart(6, '0')}`);
  }
  assertUnique([...occurrenceIds.values()], 'ocorrência');

  const evidenceIds = new Map();
  for (const artifact of model.evidence) {
    const digest = await scopedDigest(batchAuditId, pageId, 'evidence', artifact.evidenceId);
    evidenceIds.set(artifact.evidenceId, `evidence-${digest.slice(0, 32)}`);
  }
  assertUnique([...evidenceIds.values()], 'evidência');

  const nodeIds = new Map();
  for (const localId of collectNodeIds(model)) {
    const digest = await scopedDigest(batchAuditId, pageId, 'node', localId);
    nodeIds.set(localId, `node-${digest.slice(0, 32)}`);
  }
  assertUnique([...nodeIds.values()], 'nó');

  const remapNode = value => value === null || value === undefined || value === 'document'
    ? value
    : requiredMapped(nodeIds, value, 'nó');
  const remapEvidence = value => requiredMapped(evidenceIds, value, 'evidência');
  const remapOccurrence = value => requiredMapped(occurrenceIds, value, 'ocorrência');
  const ruleResults = model.ruleResults.map(rule => remapRule(rule, remapNode));
  const evidenceDrafts = model.evidence.map(artifact => remapEvidenceArtifact(
    artifact, pageId, remapEvidence, remapNode,
  ));
  const evidenceById = new Map(evidenceDrafts.map(artifact => [artifact.evidenceId, artifact]));
  const evidence = [];
  for (const artifact of evidenceDrafts) {
    if (artifact.kind === 'announcement-map') {
      artifact.derivation.geometrySnapshotHash = await hashAnnotationMapGeometry(artifact.derivation.geometry);
    }
    artifact.hash = await hashEvidenceArtifact(artifact, {
      sourceArtifact: artifact.kind === 'announcement-map'
        ? evidenceById.get(artifact.fullPageEvidenceId)
        : undefined,
    });
    evidence.push(artifact);
  }

  const occurrences = model.occurrences.map(occurrence => {
    const remappedNodeId = remapNode(occurrence.nodeId);
    return {
      ...structuredClone(occurrence),
      occurrenceId: remapOccurrence(occurrence.occurrenceId),
      pageId,
      nodeId: remappedNodeId,
      target: occurrence.target && Object.hasOwn(occurrence.target, 'nodeId')
        ? { ...structuredClone(occurrence.target), nodeId: remapNode(occurrence.target.nodeId) }
        : structuredClone(occurrence.target),
      ...(Object.hasOwn(occurrence, 'presentationTargetKey') ? {
        presentationTargetKey: remapPresentationTargetKey(
          occurrence.presentationTargetKey, occurrence.nodeId, remappedNodeId,
        ),
      } : {}),
      evidenceRefs: occurrence.evidenceRefs.map(remapEvidence),
      evidenceIds: occurrence.evidenceIds.map(remapEvidence),
      ...(occurrence.applicabilityEvidence ? {
        applicabilityEvidence: remapApplicabilityEvidence(
          occurrence.applicabilityEvidence, pageId, remapNode,
        ),
      } : {}),
    };
  });
  const manualReview = model.manualReview.map(entry => ({
    ...structuredClone(entry),
    occurrenceId: remapOccurrence(entry.occurrenceId),
    ...(entry.auditId === undefined ? {} : { auditId: batchAuditId }),
    ...(entry.decisionId === undefined ? {} : {
      decisionId: remapOccurrence(entry.occurrenceId),
    }),
  }));
  const reviewDecisions = model.reviewDecisions.map(decision => ({
    ...structuredClone(decision),
    decisionId: remapOccurrence(decision.occurrenceId),
    auditId: batchAuditId,
    occurrenceId: remapOccurrence(decision.occurrenceId),
  }));
  const itemResults = model.itemResults.map(item => ({
    ...structuredClone(item),
    ...(item.review?.decisionIds ? {
      review: {
        ...structuredClone(item.review),
        decisionIds: item.review.decisionIds.map(id => remapOccurrence(id)),
      },
    } : {}),
  }));
  const sourcePage = model.pages[0];
  const diagnostics = (sourcePage.diagnostics ?? model.session.diagnostics).map(diagnostic => ({
    ...structuredClone(diagnostic),
    ...(diagnostic.details?.occurrenceId ? {
      details: { occurrenceId: remapOccurrence(diagnostic.details.occurrenceId) },
    } : {}),
  }));
  const axe = sourcePage.finalUrlObserved && model.axe
    ? remapAxe(model.axe, pageId, occurrenceIds, remapNode)
    : null;
  const page = {
    ...structuredClone(sourcePage),
    pageId,
    requestedUrl: projectAuditResourceOrigin(sourcePage.requestedUrl),
    finalUrl: projectAuditResourceOrigin(sourcePage.finalUrl),
    diagnostics,
    limitations: [],
    coverage: structuredClone(sourcePage.coverage ?? model.snapshot?.coverage ?? {}),
    warnings: structuredClone(sourcePage.warnings ?? model.snapshot?.warnings ?? []),
    accessibilityWidgets: structuredClone(model.accessibilityWidgets),
    axeStatus: sourcePage.axeStatus ?? model.axe?.status ?? 'not-run',
  };
  page.limitations = derivePageLimitations({
    requestedScope: { mode: 'batch' },
    axePages: axe ? [{ pageId, result: axe }] : [],
  }, page);
  const result = {
    page,
    ruleResults,
    itemResults,
    occurrences,
    evidence,
    manualReview,
    reviewDecisions,
    axe,
    template: {
      timezone: model.timezone,
      versions: structuredClone(model.versions),
      methodology: structuredClone(model.methodology),
      environment: structuredClone(model.environment),
      normative: structuredClone(model.normative),
    },
  };
  assertSamePageGraph(result);
  return deepFreeze(result);
}

function remapRule(rule, remapNode) {
  const output = structuredClone(rule);
  output.targets = output.targets.map(target => {
    if (typeof target === 'string') return remapNode(target);
    if (!target || typeof target !== 'object' || Array.isArray(target)) return target;
    return Object.hasOwn(target, 'nodeId') ? { ...target, nodeId: remapNode(target.nodeId) } : target;
  });
  return output;
}

function remapEvidenceArtifact(artifact, pageId, remapEvidence, remapNode) {
  const output = structuredClone(artifact);
  output.evidenceId = remapEvidence(artifact.evidenceId);
  output.pageId = pageId;
  if (Object.hasOwn(output, 'nodeId')) output.nodeId = remapNode(output.nodeId);
  if (Object.hasOwn(output, 'fullPageEvidenceId')) {
    output.fullPageEvidenceId = remapEvidence(output.fullPageEvidenceId);
  }
  if (output.kind === 'announcement-map') {
    output.derivation.sourceEvidenceId = remapEvidence(output.derivation.sourceEvidenceId);
    output.derivation.geometry.annotations = output.derivation.geometry.annotations.map(annotation => ({
      ...annotation, nodeId: remapNode(annotation.nodeId),
    }));
    output.legend = output.legend.map(entry => ({ ...entry, nodeId: remapNode(entry.nodeId) }));
    output.segments = output.segments.map(segment => ({
      ...segment, segmentId: `${output.evidenceId}-segment-${segment.index}`,
    }));
  }
  return output;
}

function remapAxe(axe, pageId, occurrenceIds, remapNode) {
  const output = structuredClone(axe);
  output.ruleResults = output.ruleResults.map(rule => remapRule(rule, remapNode));
  output.occurrences = output.occurrences.map(occurrence => {
    const remappedNodeId = remapNode(occurrence.nodeId);
    return {
      ...occurrence,
      occurrenceId: requiredMapped(occurrenceIds, occurrence.occurrenceId, 'ocorrência axe'),
      pageId,
      nodeId: remappedNodeId,
      target: occurrence.target && Object.hasOwn(occurrence.target, 'nodeId')
        ? { ...occurrence.target, nodeId: remapNode(occurrence.target.nodeId) }
        : occurrence.target,
      presentationTargetKey: remapPresentationTargetKey(
        occurrence.presentationTargetKey, occurrence.nodeId, remappedNodeId,
      ),
      ...(occurrence.applicabilityEvidence ? {
        applicabilityEvidence: remapApplicabilityEvidence(
          occurrence.applicabilityEvidence, pageId, remapNode,
        ),
      } : {}),
    };
  });
  return output;
}

function remapApplicabilityEvidence(proof, pageId, remapNode) {
  const output = { ...structuredClone(proof), pageId };
  if (Object.hasOwn(output, 'nodeId')) output.nodeId = remapNode(output.nodeId);
  return output;
}

function remapPresentationTargetKey(value, localNodeId, remappedNodeId) {
  return localNodeId !== null && localNodeId !== undefined && value === `node:${localNodeId}`
    ? `node:${remappedNodeId}`
    : value;
}

function collectNodeIds(model) {
  const ids = new Set();
  const add = value => { if (typeof value === 'string' && value) ids.add(value); };
  for (const rule of model.ruleResults) for (const target of rule.targets) {
    if (typeof target === 'string') add(target);
    else add(target?.nodeId);
  }
  for (const occurrence of model.occurrences) {
    add(occurrence.nodeId);
    add(occurrence.target?.nodeId);
    add(occurrence.applicabilityEvidence?.nodeId);
  }
  for (const occurrence of model.axe?.occurrences ?? []) {
    add(occurrence.nodeId);
    add(occurrence.target?.nodeId);
    add(occurrence.applicabilityEvidence?.nodeId);
  }
  for (const artifact of model.evidence) {
    add(artifact.nodeId);
    for (const annotation of artifact.derivation?.geometry?.annotations ?? []) add(annotation.nodeId);
    for (const legend of artifact.legend ?? []) add(legend.nodeId);
  }
  return ids;
}

function assertSamePageGraph(result) {
  const pageId = result.page.pageId;
  const evidenceIds = new Set(result.evidence.map(artifact => artifact.evidenceId));
  const occurrenceIds = new Set(result.occurrences.map(occurrence => occurrence.occurrenceId));
  assertUnique([...evidenceIds], 'evidência');
  assertUnique([...occurrenceIds], 'ocorrência');
  for (const artifact of result.evidence) {
    if (artifact.pageId !== pageId) throw new TypeError('Evidência remapeada cruza páginas.');
    if (artifact.fullPageEvidenceId && !evidenceIds.has(artifact.fullPageEvidenceId)) {
      throw new TypeError('Evidência remapeada referencia origem desconhecida.');
    }
  }
  for (const occurrence of result.occurrences) {
    if (occurrence.pageId !== pageId || occurrence.evidenceRefs.some(id => !evidenceIds.has(id))) {
      throw new TypeError('Ocorrência remapeada cruza páginas ou evidências.');
    }
  }
  for (const entry of result.manualReview) if (!occurrenceIds.has(entry.occurrenceId)) {
    throw new TypeError('Fila de revisão remapeada referencia ocorrência desconhecida.');
  }
}

async function scopedDigest(batchAuditId, pageId, namespace, localId) {
  assertId(localId, `${namespace} localId`);
  return sha256Hex(`${batchAuditId}\u0000${pageId}\u0000${namespace}\u0000${localId}`);
}

function requiredMapped(map, value, label) {
  const mapped = map.get(value);
  if (!mapped) throw new TypeError(`Referência de ${label} desconhecida durante o remapeamento.`);
  return mapped;
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) throw new TypeError(`Colisão de ${label} durante o remapeamento.`);
}

function assertId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) throw new TypeError(`${label} inválido.`);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value) || Object.isFrozen(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
