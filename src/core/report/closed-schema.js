import { validateKeyboardMapArtifact } from '../keyboard/keyboard-map-artifact.js';
import { NBR17225_EDITORIAL_NOTES } from '../normative/nbr17225.js';
import { NORMATIVE_SOURCE_LEDGER } from '../normative/source-ledger.js';
import { canonicalStringify } from './canonical-json.js';

const ROOT_KEYS = set(
  'accessibilityWidgets auditId axe axePages environment evidence evidenceStateCount finalUrl integrity itemResults limitations manualReview methodology normative occurrences pages presentation progress report reproducibility requestedScope requestedUrl reviewDecisions ruleResults schemaVersion scope session snapshot timestamps timezone versions',
);
const BASE_OCCURRENCE_KEYS = words(
  'accessiblePreview classification confidence evidenceIds evidenceRefs foreignBenchmarkRefs impact itemId itemWcagRefs justification legalAnalysis mode nbrItemRef nodeId occurrenceId outcome pageId ruleId source sourceWcagRefs target testedWcagRefs wcagRefs',
);
const CORE_OCCURRENCE_KEYS = new Set([...BASE_OCCURRENCE_KEYS, 'equivalenceKey', 'presentationTargetKey', 'reason']);
const MANUAL_OCCURRENCE_KEYS = new Set([...BASE_OCCURRENCE_KEYS, 'equivalenceKey', 'presentationTargetKey']);
const EDITORIAL_OCCURRENCE_KEYS = new Set(BASE_OCCURRENCE_KEYS);
const V1_OCCURRENCE_KEYS = new Set([...CORE_OCCURRENCE_KEYS, 'applicabilityEvidence', 'engineResultType', 'engineRuleId', 'framePath', 'selector']);
const AXE_OCCURRENCE_KEYS = set(
  'accessiblePreview applicabilityEvidence classification confidence engineResultType engineRuleId equivalenceKey evidenceIds evidenceRefs foreignBenchmarkRefs framePath impact itemId itemWcagRefs justification legalAnalysis mode nbrItemRef nodeId occurrenceId outcome pageId presentationTargetKey ruleId selector source sourceWcagRefs target testedWcagRefs wcagRefs',
);
const RULE_KEYS = set('classification confidence engineRuleId impact limitations mode nbrItems outcome ruleId source summary targets wcag');
const CORE_TARGET_DATA_KEYS = set(
  'attribute behavior contextObservation coverageKey declaredPurpose durationSeconds flashesPerSecond height itemId iterationCount largeText level previousLevel ratio reason role states threshold totalDurationSeconds width',
);
const EVIDENCE_BASE_KEYS = words('evidenceId pageId kind hash pixelState pixelContentHash');
const FULL_PAGE_EVIDENCE_KEYS = new Set([...EVIDENCE_BASE_KEYS, 'state', 'dataUrl', 'metadata']);
const ELEMENT_EVIDENCE_KEYS = new Set([
  ...EVIDENCE_BASE_KEYS, 'nodeId', 'backendNodeId', 'selector', 'snippet', 'accessibility',
  'dataUrl', 'fullPageEvidenceId', 'metadata', 'mediaUrl',
  // Opcional desde a 1.1.62: o SHA-256 do arquivo PNG guardado, que a ficha de evidência e o anexo do
  // relatório entregue mostram sem recalcular nada. O campo **não** entra no hash do artefato (o
  // recálculo o sobrescreve a partir dos próprios pixels, `artifact-hash.js`), então auditorias
  // anteriores continuam válidas sem ele e nenhum hash guardado muda por causa dele.
  'binarySha256',
]);
const ACCESSIBILITY_EVIDENCE_KEYS = set(
  'announcementPreview description descriptionSource name nameSource role states valueStatus visibleText',
);
const MAP_EVIDENCE_KEYS = set(
  'evidenceId pageId kind state fullPageEvidenceId derivation status segments legend counts limits limitations hash pixelState pixelContentHash',
);
const MAP_DERIVATION_KEYS = set('type algorithm version sourceEvidenceId sourceHash geometrySnapshotHash geometry');
const MAP_GEOMETRY_KEYS = set('coordinateSpace sourceCssSize sourcePixelSize scaleX scaleY deviceScaleFactor annotations');
const MAP_ANNOTATION_KEYS = set('number nodeId sourceRect marker segmentIndex');
const MAP_MARKER_KEYS = set('x y size leaderX leaderY');
const MAP_SEGMENT_KEYS = set('segmentId index count role sourceCssClip width height dataUrl contentHash');
const MAP_LEGEND_KEYS = set('number nodeId selectorSummary announcementPreview nameSource segmentIndex');
const MAP_COUNT_KEYS = set('eligible annotated omittedNoRect omittedFrame omittedLimit unresolvedOverlap');
/** Contagem opcional acrescentada depois da 1.1.0: mapas guardados antes dela continuam aceitos. */
const MAP_OPTIONAL_COUNT_KEYS = set('omittedClipped');
const MAP_LIMIT_KEYS = set('maxNodes maxSourcePixels maxDimension maxCanvasPixels maxSegments maxDerivedBytes maxLegendCodePoints');
const EVIDENCE_KINDS = Object.freeze(['full-page', 'element', 'announcement-map', 'keyboard-map']);
const SHA256 = /^[a-f0-9]{64}$/u;

/** Validates every retained V2 field. Unknown data is rejected, never stripped. */
export function assertClosedAuditShape(model) {
  assertRecord(model);
  assertAllowed(model, ROOT_KEYS);
  if (model.schemaVersion === 1) {
    assertV1OccurrenceBoundary(model);
    return model;
  }
  if (model.schemaVersion !== 2) throw new TypeError();
  assertCurrentV2(model);
  return model;
}

/** Returns a fresh canonical projection after the complete closed-schema check. */
export function projectClosedAuditShape(model) {
  assertClosedAuditShape(model);
  const projected = copyData(model);
  if (projected.schemaVersion === 2) {
    delete projected.presentation;
    delete projected.progress;
  }
  return projected;
}

function assertCurrentV2(model) {
  for (const key of [
    'auditId', 'requestedScope', 'pages', 'requestedUrl', 'finalUrl', 'timestamps', 'timezone',
    'versions', 'environment', 'scope', 'methodology', 'session', 'limitations', 'ruleResults',
    'itemResults', 'occurrences', 'evidence', 'manualReview', 'reviewDecisions', 'report',
    'reproducibility', 'integrity', 'normative', 'accessibilityWidgets', 'evidenceStateCount',
  ]) requireOwn(model, key);

  assertExact(model.requestedScope, set('mode urls'));
  assertArray(model.requestedScope.urls);
  assertString(model.requestedScope.mode);
  assertStringArray(model.requestedScope.urls);
  for (const key of ['auditId', 'requestedUrl', 'finalUrl', 'timezone']) assertString(model[key]);
  if (!Number.isSafeInteger(model.evidenceStateCount) || model.evidenceStateCount < 0) throw new TypeError();
  assertArray(model.pages);
  for (const page of model.pages) assertPage(page);
  assertTimestamps(model.timestamps);
  assertExact(model.versions, set('extension rules browser'));
  for (const value of Object.values(model.versions)) assertString(value);
  assertExact(model.environment, set('chromeVersion viewport'));
  assertString(model.environment.chromeVersion);
  assertViewport(model.environment.viewport);
  assertExact(model.scope, set('kind description'));
  assertString(model.scope.kind);
  assertString(model.scope.description);
  assertExact(model.methodology, set('name version coreRuleCount supplementalRuleCount ruleCount itemCount'));
  assertString(model.methodology.name);
  assertString(model.methodology.version);
  for (const key of ['coreRuleCount', 'supplementalRuleCount', 'ruleCount', 'itemCount']) {
    if (!Number.isSafeInteger(model.methodology[key]) || model.methodology[key] < 0) throw new TypeError();
  }
  assertSession(model.session);
  assertStringArray(model.limitations);

  assertArray(model.ruleResults);
  for (const rule of model.ruleResults) assertRule(rule);
  assertArray(model.itemResults);
  for (const item of model.itemResults) assertItem(item);
  assertArray(model.occurrences);
  for (const occurrence of model.occurrences) assertOccurrence(occurrence, 2);
  assertArray(model.evidence);
  for (const artifact of model.evidence) assertEvidence(artifact);
  assertArray(model.manualReview);
  for (const entry of model.manualReview) assertManualReview(entry);
  assertArray(model.reviewDecisions);
  for (const decision of model.reviewDecisions) assertDecision(decision);
  assertReport(model.report);
  assertReproducibility(model.reproducibility);
  assertIntegrity(model.integrity);
  assertNormative(model.normative);

  if (model.accessibilityWidgets !== undefined) assertWidgets(model.accessibilityWidgets);
  if (model.snapshot !== undefined && model.snapshot !== null) assertSnapshotSummary(model.snapshot);
  if (model.presentation !== undefined) throw new TypeError();
  if (model.progress !== undefined) {
    assertProgress(model.progress);
    if (model.progress.length > 0) throw new TypeError();
  }
  if (model.axe !== undefined) assertAxe(model.axe);
  if (model.axePages !== undefined) {
    assertArray(model.axePages);
    for (const entry of model.axePages) {
      assertExact(entry, set('pageId result'));
      assertAxe(entry.result);
    }
  }
}

function assertV1OccurrenceBoundary(model) {
  if (!Array.isArray(model.occurrences)) return;
  for (const occurrence of model.occurrences) {
    assertRecord(occurrence);
    assertAllowed(occurrence, V1_OCCURRENCE_KEYS);
    if (occurrence.source !== undefined) assertSource(occurrence.source, occurrence.source?.engine === 'axe-core');
    if (occurrence.target !== undefined) assertAllowedRecord(occurrence.target, set('framePath message nodeId selector'));
    if (occurrence.reason !== undefined) assertReason(occurrence.reason);
  }
}

function assertPage(page) {
  const allowed = set(
    'accessibilityWidgets attempted axeStatus coverage diagnostics finalUrl finalUrlObserved limitations omittedEvidence pageId requestedUrl status timestamps viewport warnings',
  );
  assertAllowedRecord(page, allowed);
  for (const key of [
    'pageId', 'requestedUrl', 'finalUrl', 'status', 'attempted', 'finalUrlObserved', 'axeStatus', 'timestamps', 'viewport', 'warnings',
  ]) requireOwn(page, key);
  for (const key of ['pageId', 'requestedUrl', 'finalUrl', 'status']) assertString(page[key]);
  assertTimestamps(page.timestamps);
  assertViewport(page.viewport);
  if (page.diagnostics !== undefined) {
    assertArray(page.diagnostics);
    for (const diagnostic of page.diagnostics) assertDiagnostic(diagnostic);
  }
  if (page.limitations !== undefined) assertStringArray(page.limitations);
  if (typeof page.attempted !== 'boolean') throw new TypeError();
  if (typeof page.finalUrlObserved !== 'boolean') throw new TypeError();
  assertString(page.axeStatus);
  assertArray(page.warnings);
  for (const warning of page.warnings) {
    assertExact(warning, set('code'));
    assertString(warning.code);
  }
  if (page.coverage !== undefined) assertCoverage(page.coverage);
  if (page.accessibilityWidgets !== undefined) assertWidgets(page.accessibilityWidgets);
  if (page.omittedEvidence !== undefined) {
    assertArray(page.omittedEvidence);
    for (const omitted of page.omittedEvidence) {
      assertExact(omitted, set('evidenceId kind contentHash reason'));
      assertString(omitted.evidenceId);
      if (!EVIDENCE_KINDS.includes(omitted.kind) ||
        !SHA256.test(omitted.contentHash ?? '') || omitted.reason !== 'budget') throw new TypeError();
    }
  }
}

function assertTimestamps(value) {
  assertExact(value, set('startedAt endedAt generatedAt'));
  for (const entry of Object.values(value)) assertString(entry);
}

function assertViewport(value) {
  assertExact(value, set('width height deviceScaleFactor'));
  for (const entry of Object.values(value)) {
    if (entry !== null && (!Number.isFinite(entry) || entry <= 0)) throw new TypeError();
  }
}

function assertSession(value) {
  assertExact(value, set('status diagnostics partial'));
  assertString(value.status);
  if (typeof value.partial !== 'boolean') throw new TypeError();
  assertArray(value.diagnostics);
  for (const diagnostic of value.diagnostics) assertDiagnostic(diagnostic);
}

function assertDiagnostic(value) {
  assertAllowedRecord(value, set('at code details message recoverable'));
  for (const key of ['at', 'code', 'message', 'recoverable']) requireOwn(value, key);
  assertString(value.at);
  assertString(value.code);
  assertString(value.message);
  if (typeof value.recoverable !== 'boolean') throw new TypeError();
  if (value.details !== undefined) {
    assertExact(value.details, set('occurrenceId'));
    assertString(value.details.occurrenceId);
  }
}

function assertRule(rule) {
  assertAllowedRecord(rule, RULE_KEYS);
  for (const key of ['ruleId', 'outcome', 'mode', 'nbrItems', 'wcag', 'targets', 'summary', 'limitations', 'source']) requireOwn(rule, key);
  const axe = rule.source?.engine === 'axe-core';
  assertSource(rule.source, axe);
  for (const key of ['ruleId', 'outcome', 'mode', 'summary']) assertString(rule[key]);
  for (const key of ['classification', 'confidence', 'engineRuleId', 'impact']) {
    if (rule[key] !== undefined) assertString(rule[key]);
  }
  assertArray(rule.nbrItems);
  assertStringArray(rule.nbrItems);
  assertArray(rule.wcag);
  assertStringArray(rule.wcag);
  assertArray(rule.targets);
  for (const target of rule.targets) assertRuleTarget(target, rule);
  assertArray(rule.limitations);
  for (const limitation of rule.limitations) {
    if (typeof limitation === 'string') continue;
    assertAllowedRecord(limitation, set('code retainedNodeCount retainedResultCount'));
    assertString(limitation.code);
    for (const key of ['retainedNodeCount', 'retainedResultCount']) {
      if (limitation[key] !== undefined && (!Number.isSafeInteger(limitation[key]) || limitation[key] < 0)) throw new TypeError();
    }
  }
}

function assertRuleTarget(target, rule) {
  if (typeof target === 'string' || Number.isSafeInteger(target) || target === null) return;
  assertRecord(target);
  if (rule.source?.engine === 'axe-core') {
    assertExact(target, set('framePath message nodeId selector'));
    if (target.nodeId !== null) assertTargetIdentity(target.nodeId);
    assertString(target.message);
    assertString(target.selector);
    assertStringArray(target.framePath);
    return;
  }
  if (rule.source?.engine === 'audita-editorial') {
    assertExact(target, set('nodeId selectorHint message data'));
    assertExact(target.data, set('reason'));
    assertTargetIdentity(target.nodeId);
    assertString(target.selectorHint);
    assertString(target.message);
    assertString(target.data.reason);
    return;
  }
  const keys = Object.keys(target).sort();
  const original = canonicalStringify(keys) === canonicalStringify(['data', 'message', 'nodeId', 'selectorHint']);
  const minimal = canonicalStringify(keys) === canonicalStringify(['nodeId']);
  const contextual = canonicalStringify(keys) === canonicalStringify(['data', 'nodeId']);
  const canonical = canonicalStringify(keys) === canonicalStringify(['data', 'message', 'nodeId']);
  if (!original && !minimal && !contextual && !canonical) throw new TypeError();
  assertTargetIdentity(target.nodeId);
  if (target.selectorHint !== undefined) assertString(target.selectorHint);
  if (target.message !== undefined) assertString(target.message);
  if (target.data !== undefined) assertCoreTargetData(target.data);
}

function assertTargetIdentity(value) {
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) throw new TypeError();
}

function assertCoreTargetData(data) {
  assertAllowedRecord(data, CORE_TARGET_DATA_KEYS);
  if (Object.keys(data).length > 0 && typeof data.reason !== 'string') throw new TypeError();
  for (const value of Object.values(data)) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) continue;
    if (Array.isArray(value) && value.length <= 64 && value.every(entry => typeof entry === 'string')) continue;
    throw new TypeError();
  }
}

function assertItem(item) {
  const allowed = set(
    'classification evaluation humanReason id originalOutcome outcome printedId review reviewedOutcome ruleIds ruleResults title wcag',
  );
  assertAllowedRecord(item, allowed);
  for (const key of ['id', 'printedId', 'title', 'classification', 'evaluation', 'humanReason', 'wcag', 'ruleIds', 'outcome', 'ruleResults']) requireOwn(item, key);
  assertArray(item.ruleIds);
  assertArray(item.ruleResults);
  if (item.ruleResults.some(value => typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/u.test(value))) throw new TypeError();
  assertArray(item.wcag);
  for (const reference of item.wcag) assertExact(reference, set('id level printedLevel'));
  if (item.review !== undefined) {
    assertExact(item.review, set('mode evaluator decidedAt decisionIds'));
    assertString(item.review.mode);
    assertString(item.review.evaluator);
    assertString(item.review.decidedAt);
    assertStringArray(item.review.decisionIds);
  }
}

function assertOccurrence(occurrence, schemaVersion) {
  assertRecord(occurrence);
  const engine = occurrence.source?.engine;
  const allowed = engine === 'axe-core' ? AXE_OCCURRENCE_KEYS
    : engine === 'audita-editorial' ? EDITORIAL_OCCURRENCE_KEYS
      : engine === 'audita-manual-review' ? MANUAL_OCCURRENCE_KEYS : CORE_OCCURRENCE_KEYS;
  assertAllowed(occurrence, schemaVersion === 1 ? V1_OCCURRENCE_KEYS : allowed);
  for (const key of BASE_OCCURRENCE_KEYS) requireOwn(occurrence, key);
  if (engine === 'axe-core') for (const key of AXE_OCCURRENCE_KEYS) requireOwn(occurrence, key);
  assertSource(occurrence.source, engine === 'axe-core');
  assertExact(occurrence.target, set('nodeId selector framePath'));
  assertStringArray(occurrence.target.framePath);
  for (const key of ['itemWcagRefs', 'sourceWcagRefs', 'testedWcagRefs', 'wcagRefs', 'foreignBenchmarkRefs', 'evidenceRefs', 'evidenceIds']) {
    assertArray(occurrence[key]);
  }
  for (const reference of occurrence.foreignBenchmarkRefs) assertExact(reference, set('benchmarkId criterionId level'));
  if (occurrence.legalAnalysis !== null) assertExact(occurrence.legalAnalysis, set('basisRef'));
  if (occurrence.reason !== undefined) assertReason(occurrence.reason);
  for (const key of ['equivalenceKey', 'presentationTargetKey']) {
    const value = occurrence[key];
    if (value !== undefined && value !== null && (typeof value !== 'string' || value.length < 1 || value.length > 512)) throw new TypeError();
  }
  if (occurrence.applicabilityEvidence !== undefined && occurrence.applicabilityEvidence !== null) {
    const proofKeys = occurrence.nodeId === null
      ? set('confirmed pageId frameId target nbrItemRef source')
      : set('confirmed pageId frameId target nodeId nbrItemRef source');
    assertExact(occurrence.applicabilityEvidence, proofKeys);
    if (occurrence.applicabilityEvidence.nodeId !== undefined) {
      assertTargetIdentity(occurrence.applicabilityEvidence.nodeId);
    }
    assertSource(occurrence.applicabilityEvidence.source, false);
  }
}

function assertReason(reason) {
  assertExact(reason, set('code context'));
  assertExact(reason.context, set('behavior warning'));
  assertString(reason.code);
  assertString(reason.context.behavior);
  assertString(reason.context.warning);
}

function assertSource(source, axe) {
  assertExact(source, axe ? set('engine ruleId version engineRuleId') : set('engine ruleId version'));
  for (const value of Object.values(source)) assertString(value);
}

function assertEvidence(artifact) {
  assertRecord(artifact);
  if (artifact.kind === 'full-page') assertAllowed(artifact, FULL_PAGE_EVIDENCE_KEYS);
  else if (artifact.kind === 'element') assertAllowed(artifact, ELEMENT_EVIDENCE_KEYS);
  else if (artifact.kind === 'announcement-map') return assertAnnotationMap(artifact);
  else if (artifact.kind === 'keyboard-map') return assertKeyboardMap(artifact);
  else throw new TypeError();
  for (const key of ['evidenceId', 'pageId', 'kind']) requireOwn(artifact, key);
  for (const key of ['evidenceId', 'pageId', 'kind']) assertString(artifact[key]);
  for (const key of ['hash', 'pixelState', 'pixelContentHash', 'state', 'nodeId', 'snippet', 'fullPageEvidenceId', 'mediaUrl']) {
    if (artifact[key] !== undefined && artifact[key] !== null) assertString(artifact[key]);
  }
  const hasPixelState = Object.hasOwn(artifact, 'pixelState');
  const hasPixelHash = Object.hasOwn(artifact, 'pixelContentHash');
  if (hasPixelState !== hasPixelHash || (hasPixelState &&
    (artifact.pixelState !== 'omitted-budget' || !SHA256.test(artifact.pixelContentHash) ||
      !SHA256.test(artifact.hash ?? '') || Object.hasOwn(artifact, 'dataUrl')))) {
    throw new TypeError();
  }
  if (artifact.backendNodeId !== undefined && artifact.backendNodeId !== null &&
    (!Number.isSafeInteger(artifact.backendNodeId) || artifact.backendNodeId < 0)) throw new TypeError();
  if (artifact.dataUrl !== undefined &&
    (typeof artifact.dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(artifact.dataUrl))) {
    throw new TypeError();
  }
  // O hash do arquivo só existe junto dos pixels que ele descreve: sem `dataUrl` não há arquivo a que
  // se referir, e o valor precisa ter a forma de um SHA-256. Que ele corresponda aos bytes guardados é
  // conferido na verificação de integridade, que já decodifica cada PNG.
  if (artifact.binarySha256 !== undefined &&
    (!SHA256.test(artifact.binarySha256) || typeof artifact.dataUrl !== 'string')) {
    throw new TypeError();
  }
  if (artifact.selector !== undefined) {
    assertExact(artifact.selector, set('css framePath'));
    if (artifact.selector.css !== null) assertString(artifact.selector.css);
    assertStringArray(artifact.selector.framePath);
  }
  if (artifact.accessibility !== undefined) {
    assertAllowedRecord(artifact.accessibility, ACCESSIBILITY_EVIDENCE_KEYS);
    for (const key of ['announcementPreview', 'description', 'descriptionSource', 'name', 'nameSource', 'role', 'states', 'visibleText']) {
      requireOwn(artifact.accessibility, key);
    }
    if (artifact.accessibility.valueStatus !== undefined && artifact.accessibility.valueStatus !== 'omitted-privacy') throw new TypeError();
    for (const key of ['announcementPreview', 'description', 'descriptionSource', 'name', 'nameSource', 'role', 'visibleText']) {
      if (artifact.accessibility[key] !== null) assertString(artifact.accessibility[key]);
    }
    assertStringArray(artifact.accessibility.states);
  }
  if (artifact.metadata !== undefined) assertEvidenceMetadata(artifact.metadata);
}

// Teto da escala de pixels da miniatura de elemento. Acompanha `ELEMENT_CAPTURE_PIXEL_LIMITS.maxScale`
// (src/browser/capture-evidence.js): a captura nunca pede mais que isto e a auditoria que declara mais
// está fora do contrato. O limite é repetido aqui porque o esquema fechado não importa o navegador.
const ELEMENT_PIXEL_SCALE_MAX = 3;

function assertEvidenceMetadata(metadata) {
  assertAllowedRecord(metadata, set('annotationMargin captureReceivedAt clip height highlightBox highlightClipped highlightParts kind mimeType pixelScale width'));
  for (const key of ['annotationMargin', 'height', 'width']) {
    if (metadata[key] !== undefined && !Number.isFinite(metadata[key])) throw new TypeError();
  }
  // Escala de pixels do raster da miniatura, quando maior que 1. `width`/`height` continuam em CSS px:
  // o PNG mede `width × pixelScale`. Inteiro de propósito — a imagem de dispositivo é um múltiplo
  // exato do quadro, e é isso que permite conferir o raster contra os metadados.
  if (metadata.pixelScale !== undefined &&
    (!Number.isSafeInteger(metadata.pixelScale) || metadata.pixelScale < 1 || metadata.pixelScale > ELEMENT_PIXEL_SCALE_MAX)) {
    throw new TypeError();
  }
  // A auditoria declara a escala uma vez só: o `clip.scale` é o mesmo número que foi enviado ao Chrome.
  if (metadata.pixelScale !== undefined && metadata.clip !== undefined &&
    metadata.clip?.scale !== metadata.pixelScale) throw new TypeError();
  for (const key of ['kind', 'mimeType']) if (metadata[key] !== undefined) assertString(metadata[key]);
  if (metadata.clip !== undefined) {
    assertExact(metadata.clip, set('x y width height scale'));
    for (const value of Object.values(metadata.clip)) if (!Number.isFinite(value)) throw new TypeError();
  }
  if (metadata.highlightBox !== undefined) {
    assertExact(metadata.highlightBox, set('x y width height coordinateSpace'));
    for (const key of ['x', 'y', 'width', 'height']) if (!Number.isFinite(metadata.highlightBox[key])) throw new TypeError();
    assertString(metadata.highlightBox.coordinateSpace);
  }
  // Fragmentos de linha do alvo, em `capture-css-px`, no mesmo sistema do `highlightBox`. Auditorias
  // anteriores à 1.1.57 não têm o campo: quem lê cai na união de `highlightBox`.
  if (metadata.highlightParts !== undefined) {
    assertArray(metadata.highlightParts);
    if (metadata.highlightParts.length === 0 || metadata.highlightParts.length > 8) throw new TypeError();
    for (const part of metadata.highlightParts) {
      assertExact(part, set('x y width height'));
      for (const key of ['x', 'y', 'width', 'height']) if (!Number.isFinite(part[key])) throw new TypeError();
    }
  }
  // O alvo não cabe inteiro na captura (recorte nos limites da página). Só o valor `true` é aceito:
  // o campo é declarativo e um `false` explícito significaria "afirmo que não houve recorte".
  if (metadata.highlightClipped !== undefined && metadata.highlightClipped !== true) throw new TypeError();
}

// O mapa do teclado tem um validador próprio, fechado por chave em todos os níveis e ligado à versão
// que o artefato declara. Repetir aqui as listas de chaves criaria uma segunda verdade que pode
// divergir da primeira; a conferência estrutural é delegada e continua rejeitando campo inventado.
function assertKeyboardMap(artifact) {
  validateKeyboardMapArtifact(artifact);
}

function assertAnnotationMap(artifact) {
  const expectedMapKeys = artifact.pixelState === 'omitted-budget'
    ? MAP_EVIDENCE_KEYS
    : new Set([...MAP_EVIDENCE_KEYS].filter(key => !['pixelState', 'pixelContentHash'].includes(key)));
  assertExact(artifact, expectedMapKeys);
  assertExact(artifact.derivation, MAP_DERIVATION_KEYS);
  assertExact(artifact.derivation.geometry, MAP_GEOMETRY_KEYS);
  assertExact(artifact.derivation.geometry.sourceCssSize, set('width height'));
  assertExact(artifact.derivation.geometry.sourcePixelSize, set('width height'));
  assertArray(artifact.derivation.geometry.annotations);
  for (const annotation of artifact.derivation.geometry.annotations) {
    assertExact(annotation, MAP_ANNOTATION_KEYS);
    assertExact(annotation.sourceRect, set('x y width height'));
    assertExact(annotation.marker, MAP_MARKER_KEYS);
  }
  assertArray(artifact.segments);
  for (const segment of artifact.segments) {
    assertExact(segment, artifact.pixelState === 'omitted-budget'
      ? new Set([...MAP_SEGMENT_KEYS].filter(key => key !== 'dataUrl'))
      : MAP_SEGMENT_KEYS);
    if (segment.sourceCssClip !== null) assertExact(segment.sourceCssClip, set('x y width height'));
  }
  assertArray(artifact.legend);
  for (const legend of artifact.legend) assertExact(legend, MAP_LEGEND_KEYS);
  assertExact(artifact.counts, new Set([...MAP_COUNT_KEYS,
    ...[...MAP_OPTIONAL_COUNT_KEYS].filter(key => artifact.counts?.[key] !== undefined)]));
  assertExact(artifact.limits, MAP_LIMIT_KEYS);
  assertArray(artifact.limitations);
}

function assertManualReview(entry) {
  assertAllowedRecord(entry, set('auditId decisionId itemId mode occurrenceId question reason ruleId status'));
  for (const key of ['occurrenceId', 'itemId', 'ruleId', 'mode', 'status', 'question', 'reason']) requireOwn(entry, key);
}

function assertMarks(marks) {
  assertExact(marks, set('areas suspects version'));
  assertArray(marks.suspects);
  assertArray(marks.areas);
  for (const area of marks.areas) assertExact(area, set('height width x y'));
}

function assertDecision(decision) {
  assertAllowedRecord(decision, set('answer auditId decidedAt decisionId evaluator itemId marks mode note occurrenceId revisions'));
  for (const key of ['decisionId', 'auditId', 'itemId', 'occurrenceId', 'answer', 'evaluator', 'decidedAt', 'mode']) requireOwn(decision, key);
  if (decision.marks !== undefined && decision.marks !== null) assertMarks(decision.marks);
  if (decision.revisions !== undefined) {
    assertArray(decision.revisions);
    for (const revision of decision.revisions) {
      assertAllowedRecord(revision, set('answer decidedAt evaluator marks note'));
      for (const key of ['answer', 'evaluator', 'decidedAt']) requireOwn(revision, key);
      if (revision.marks !== undefined && revision.marks !== null) assertMarks(revision.marks);
    }
  }
}

function assertReport(report) {
  assertExact(report, set('status reviewUrl artifact'));
  assertString(report.status);
  if (report.reviewUrl !== null) assertString(report.reviewUrl);
  if (!['pending', 'review-ready', 'complete', 'partial'].includes(report.status)) throw new TypeError();
  assertAllowedRecord(report.artifact, set('formats limitations pdfFallback status'));
  requireOwn(report.artifact, 'status');
  requireOwn(report.artifact, 'formats');
  assertArray(report.artifact.formats);
  for (const format of report.artifact.formats) {
    if (typeof format === 'string') continue;
    assertExact(format, set('format status'));
    assertString(format.format);
    assertString(format.status);
  }
  assertString(report.artifact.status);
  if (report.artifact.pdfFallback !== undefined && typeof report.artifact.pdfFallback !== 'boolean') throw new TypeError();
  if (report.artifact.limitations !== undefined) assertStringArray(report.artifact.limitations);
}

function assertReproducibility(value) {
  assertExact(value, set('capturedStateCount evidenceHash methodologyVersion ruleResultsHash snapshotHash'));
  for (const key of ['evidenceHash', 'methodologyVersion', 'ruleResultsHash', 'snapshotHash']) {
    if (value[key] !== undefined) assertString(value[key]);
  }
  if (value.capturedStateCount !== undefined && (!Number.isSafeInteger(value.capturedStateCount) || value.capturedStateCount < 0)) throw new TypeError();
}

function assertIntegrity(value) {
  assertRecord(value);
  if (value.algorithm === 'unavailable') return assertExact(value, set('algorithm status'));
  assertExact(value, set('algorithm canonicalModelHash evidenceManifestHash hashBase'));
}

function assertNormative(normative) {
  assertExact(normative, set('edition editorialNotes sources wcag'));
  assertArray(normative.editorialNotes);
  for (const note of normative.editorialNotes) assertExact(note, set('field itemId normalized printed rationale'));
  assertArray(normative.sources);
  for (const source of normative.sources) {
    assertAllowedRecord(source, set('id localCopy title url version'));
    if (source.localCopy !== undefined) assertExact(source.localCopy, set('fileName sha256'));
  }
  if (canonicalStringify(normative.editorialNotes) !== canonicalStringify(NBR17225_EDITORIAL_NOTES) ||
    canonicalStringify(normative.sources) !== canonicalStringify(NORMATIVE_SOURCE_LEDGER)) throw new TypeError();
}

function assertWidgets(inventory) {
  assertExact(inventory, set('coverage detector version widgets'));
  assertString(inventory.coverage);
  assertString(inventory.detector);
  assertString(inventory.version);
  assertArray(inventory.widgets);
  for (const widget of inventory.widgets) {
    assertExact(widget, set('id signals status'));
    assertString(widget.id);
    assertString(widget.status);
    assertStringArray(widget.signals);
  }
}

function assertSnapshotSummary(snapshot) {
  assertExact(snapshot, set('coverage nodeCount retention schemaVersion warnings'));
  if (!Number.isSafeInteger(snapshot.schemaVersion) || snapshot.schemaVersion < 1 ||
    snapshot.retention !== 'summary-only' || !Number.isSafeInteger(snapshot.nodeCount) || snapshot.nodeCount < 0) {
    throw new TypeError();
  }
  assertCoverage(snapshot.coverage);
  assertArray(snapshot.warnings);
  for (const warning of snapshot.warnings) {
    assertExact(warning, set('code'));
    assertString(warning.code);
  }
}

function assertCoverage(coverage) {
  assertAllowedRecord(coverage, set('accessibility frames runtime'));
  if (coverage.frames !== undefined) assertString(coverage.frames);
  for (const key of ['runtime', 'accessibility']) if (coverage[key] !== undefined) {
    assertAllowedRecord(coverage[key], set('expectedFrameCount observedFrameCount outcome'));
    if (coverage[key].outcome !== undefined) assertString(coverage[key].outcome);
    for (const countKey of ['expectedFrameCount', 'observedFrameCount']) {
      if (coverage[key][countKey] !== undefined &&
        (!Number.isSafeInteger(coverage[key][countKey]) || coverage[key][countKey] < 0)) throw new TypeError();
    }
  }
}

function assertProgress(progress) {
  assertArray(progress);
  for (const entry of progress) assertExact(entry, set('at auditId message percent phase sessionId type'));
}

function assertPresentation(value) {
  assertExact(value, set('groups hiddenOccurrenceCount occurrenceCount'));
  assertArray(value.groups);
  for (const group of value.groups) {
    assertExact(group, set('equivalenceKey groupId nbrItemRef occurrenceIds outcome pageId presentationTargetKey sources target'));
    assertExact(group.target, set('framePath nodeId selector'));
    assertArray(group.target.framePath);
    assertArray(group.occurrenceIds);
    assertArray(group.sources);
    for (const source of group.sources) assertSource(source, source.engine === 'axe-core');
  }
}

function assertAxe(axe) {
  assertExact(axe, set('diagnostics limitations occurrences provenance ruleResults status technicalSummary'));
  assertExact(axe.provenance, set('config engine gate packageTarballSha256 runtimePath runtimeSha256 version'));
  assertExact(axe.provenance.config, set('iframes preload resultTypes rules runOnly'));
  if (axe.provenance.config.preload !== false || axe.provenance.config.iframes !== false) throw new TypeError();
  assertExact(axe.provenance.config.runOnly, set('type values'));
  assertArray(axe.provenance.config.runOnly.values);
  assertArray(axe.provenance.config.resultTypes);
  assertExact(axe.provenance.config.rules, set('target-size'));
  assertExact(axe.provenance.config.rules['target-size'], set('enabled'));
  assertExact(axe.provenance.gate, set('code enabled targetSizeEnabled testedBrowser'));
  assertArray(axe.diagnostics);
  for (const diagnostic of axe.diagnostics) assertExact(diagnostic, set('code frameId'));
  assertArray(axe.limitations);
  assertArray(axe.ruleResults);
  for (const rule of axe.ruleResults) assertRule(rule);
  assertArray(axe.occurrences);
  for (const occurrence of axe.occurrences) assertOccurrence(occurrence, 2);
  assertExact(axe.technicalSummary, set('inapplicable incomplete passes violations'));
  for (const value of Object.values(axe.technicalSummary)) assertExact(value, set('groups nodes'));
}

function requireOwn(value, key) {
  if (!Object.hasOwn(value, key)) throw new TypeError();
}

function assertArray(value) {
  if (!Array.isArray(value)) throw new TypeError();
}

function assertString(value) {
  if (typeof value !== 'string') throw new TypeError();
}

function assertStringArray(value) {
  assertArray(value);
  for (const entry of value) assertString(entry);
}

function assertRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
}

function assertAllowedRecord(value, allowed) {
  assertRecord(value);
  assertAllowed(value, allowed);
}

function assertAllowed(value, allowed) {
  if (Object.keys(value).some(key => !allowed.has(key))) throw new TypeError();
}

function assertExact(value, expected) {
  assertRecord(value);
  if (canonicalStringify(Object.keys(value).sort()) !== canonicalStringify([...expected].sort())) throw new TypeError();
}

function words(value) {
  return value.split(/\s+/u).filter(Boolean);
}

function set(value) {
  return new Set(words(value));
}

function copyData(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(copyData);
  const output = {};
  for (const key of Object.keys(value)) output[key] = copyData(value[key]);
  return output;
}
