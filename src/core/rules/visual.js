import { contrastRatio } from '../color.js';
import { NBR17225_ITEMS } from '../normative/nbr17225.js';
import { createRuleRegistry } from './registry.js';
import {
  documentTarget,
  hasOwn,
  isComponent,
  isHidden,
  missingSnapshotResult,
  nodeIndex,
  normalizeText,
  orderTargets,
  probeCoverageCantTell,
  result,
  snapshotParts,
  target
} from './snapshot.js';

function definition(id, evaluate) {
  const items = NBR17225_ITEMS.filter(item => item.ruleIds.includes(id));
  if (items.length === 0) throw new TypeError(`Regra ausente do catálogo NBR: ${id}`);
  return {
    id,
    mode: items[0].evaluation,
    nbrItems: items.map(item => item.id),
    wcag: [...new Set(items.flatMap(item => item.wcag.map(reference => reference.id)))],
    evaluate
  };
}

function visualResult(snapshot, evaluate) {
  const parts = snapshotParts(snapshot);
  if (!parts) return missingSnapshotResult();
  const value = evaluate(parts);
  return { ...value, targets: orderTargets(value.targets, parts.nodes) };
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function fontWeight(value) {
  if (value === 'normal') return 400;
  if (value === 'bold') return 700;
  const normalized = typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value.trim())
    ? Number(value.trim())
    : value;
  return finite(normalized) && normalized >= 1 && normalized <= 1000 ? normalized : null;
}

function uncertainComposition(observation) {
  return !observation || observation.reliable === false ||
    (typeof observation.backgroundImage === 'string' &&
      normalizeText(observation.backgroundImage).toLowerCase() !== 'none') ||
    ['canvas', 'webgl'].includes(normalizeText(observation.renderingContext).toLowerCase());
}

function isLargeText(observation) {
  const weight = fontWeight(observation.fontWeight);
  if (!finite(observation.fontSizePx) || observation.fontSizePx <= 0 || weight === null) return null;
  return observation.fontSizePx >= 24 ||
    (observation.fontSizePx >= (14 * 96 / 72) && weight >= 700);
}

function textContrast(snapshot, enhanced) {
  return visualResult(snapshot, ({ nodes }) => {
    const candidates = nodes.filter(node => !isHidden(node) && normalizeText(node?.text));
    if (candidates.length === 0) return result('inapplicable', 'Não há texto visível aplicável.');
    const failures = [];
    let incomplete = false;
    for (const node of candidates) {
      const observation = node?.contrast;
      if (uncertainComposition(observation)) {
        incomplete = true;
        continue;
      }
      const large = isLargeText(observation);
      const ratio = contrastRatio(observation.foreground, observation.background);
      if (large === null || !Number.isFinite(ratio)) {
        incomplete = true;
        continue;
      }
      const threshold = enhanced ? (large ? 4.5 : 7) : (large ? 3 : 4.5);
      if (ratio < threshold) {
        failures.push(target(node, `Aumente o contraste deste texto para pelo menos ${threshold}:1.`, {
          reason: 'insufficient-text-contrast', ratio, threshold, largeText: large
        }));
      }
    }
    if (failures.length > 0) return result('failed', 'Há texto com contraste abaixo do limite.', failures);
    if (incomplete) return result('cantTell', 'A composição de pixels ou a tipografia não foi determinada para todo o texto.', [], [
      'Colete cores finais opacas, tamanho e peso; gradientes, imagens e canvas exigem medição de pixels.'
    ]);
    return result('passed', 'Todo o texto aplicável atende ao limite de contraste observado.');
  });
}

function nonTextContrast(snapshot, field, kind) {
  return visualResult(snapshot, ({ nodes }) => {
    const candidates = field === 'graphicContrast'
      ? nodes.filter(node => !isHidden(node) && (node?.graphicObject === true || hasOwn(node, field)))
      : field === 'focusContrast'
        ? nodes.filter(node => !isHidden(node) && (node?.focusable === true || hasOwn(node, field)))
        : nodes.filter(isComponent);
    if (candidates.length === 0) return result('inapplicable', `Não há ${kind} aplicáveis.`);
    const failures = [];
    let incomplete = false;
    for (const node of candidates) {
      const observation = node?.[field];
      if (uncertainComposition(observation)) {
        incomplete = true;
        continue;
      }
      const ratio = contrastRatio(observation.foreground, observation.background);
      if (!Number.isFinite(ratio)) incomplete = true;
      else if (ratio < 3) failures.push(target(node, `Aumente o contraste deste ${kind} para pelo menos 3:1.`, {
        reason: 'insufficient-non-text-contrast', ratio, threshold: 3
      }));
    }
    if (failures.length > 0) return result('failed', `Há ${kind} com contraste abaixo de 3:1.`, failures);
    if (incomplete) return result('cantTell', `Os pixels de ${kind} não foram observados com confiabilidade.`, [], [
      'Colete as cores finais dos pixels relevantes e sua composição de fundo.'
    ]);
    return result('passed', `Todos os ${kind} aplicáveis atendem ao contraste observado.`);
  });
}

const MINIMUM_TARGET_EXCEPTIONS = new Set(['equivalent', 'inline', 'user-agent', 'essential', 'spacing']);
const ENHANCED_TARGET_EXCEPTIONS = new Set(['equivalent', 'inline', 'user-agent', 'essential']);
const KNOWN_TARGET_EXCEPTIONS = new Set([...MINIMUM_TARGET_EXCEPTIONS, ...ENHANCED_TARGET_EXCEPTIONS]);

function targetSize(snapshot, threshold) {
  return visualResult(snapshot, ({ document, nodes }) => {
    if (probeCoverageCantTell(document, 'targetSizes')) return result('cantTell', 'A cobertura da medição de alvos está incompleta.');
    const exceptions = threshold === 44 ? ENHANCED_TARGET_EXCEPTIONS : MINIMUM_TARGET_EXCEPTIONS;
    const candidates = nodes.filter(isComponent);
    if (candidates.length === 0) return result('inapplicable', 'Não há alvos de acionamento aplicáveis.');
    const failures = [];
    let incomplete = false;
    for (const node of candidates) {
      const observation = node?.targetSize;
      if (!observation || !finite(observation.width) || !finite(observation.height) || observation.width < 0 || observation.height < 0) {
        incomplete = true;
        continue;
      }
      if (observation.width >= threshold && observation.height >= threshold) continue;
      if (exceptions.has(observation.exception)) continue;
      if (observation.exception !== 'none' && !KNOWN_TARGET_EXCEPTIONS.has(observation.exception)) {
        incomplete = true;
        continue;
      }
      failures.push(target(node, `Aumente a área de acionamento para pelo menos ${threshold} por ${threshold} CSS px.`, {
        reason: 'target-too-small', width: observation.width, height: observation.height, threshold
      }));
    }
    if (failures.length > 0) return result('failed', 'Há alvos abaixo do tamanho mínimo aplicável.', failures);
    if (incomplete) return result('cantTell', 'O tamanho ou uma possível exceção não foi determinado para todos os alvos.', [], [
      'Colete a caixa em CSS px e registre explicitamente a exceção aplicável ou "none".'
    ]);
    return result('passed', 'Todos os alvos observados atendem ao tamanho ou a uma exceção explícita.');
  });
}

function focusProperty(snapshot, property, label) {
  return visualResult(snapshot, ({ document, nodes }) => {
    const coverageKey = ['fullyVisible', 'partiallyVisible'].includes(property) ? 'obscuredTargets' : 'focusAppearance';
    if (probeCoverageCantTell(document, coverageKey)) return result('cantTell', 'A cobertura da observação de foco está incompleta.');
    const candidates = nodes.filter(node => !isHidden(node) && node?.focusable === true);
    if (candidates.length === 0) return result('inapplicable', 'Não há elementos focáveis aplicáveis.');
    const failures = [];
    let incomplete = false;
    for (const node of candidates) {
      if (!node.focusObservation || typeof node.focusObservation[property] !== 'boolean') {
        incomplete = true;
      } else if (!node.focusObservation[property]) {
        failures.push(target(node, label.message, { reason: label.reason }));
      }
    }
    if (failures.length > 0) return result('failed', label.failedSummary, failures);
    if (incomplete) return result('cantTell', 'A observação de foco não foi coletada para todos os alvos.', [], [
      'Percorra os elementos focáveis e registre o indicador e sua obstrução no estado focado.'
    ]);
    return result('passed', label.passedSummary);
  });
}

function zoomNotBlocked(snapshot) {
  return visualResult(snapshot, ({ document }) => {
    if (!hasOwn(document, 'metaViewport')) return result('cantTell', 'A diretiva meta viewport não foi coletada.', [], [
      'Colete a presença e os valores efetivos da diretiva meta viewport.'
    ]);
    if (document.metaViewport === null) return result('cantTell', 'Não foi encontrada diretiva de viewport; o funcionamento do zoom ainda precisa ser verificado.', [], [
      'Amplie a página pelo navegador e, no celular, pelo gesto de pinça. A ausência dessa diretiva não exclui outros bloqueios.'
    ]);
    const viewport = document.metaViewport;
    if (!viewport || typeof viewport !== 'object') return result('cantTell', 'A diretiva meta viewport é inválida ou incompleta.', [], [
      'Colete user-scalable e maximum-scale em forma normalizada.'
    ]);
    const hasUserScalable = hasOwn(viewport, 'userScalable');
    const hasMaximumScale = hasOwn(viewport, 'maximumScale');
    if (
      (!hasUserScalable && !hasMaximumScale) ||
      (hasUserScalable && typeof viewport.userScalable !== 'boolean') ||
      (hasMaximumScale && (!finite(viewport.maximumScale) || viewport.maximumScale <= 0))
    ) {
      return result('cantTell', 'A diretiva meta viewport é inválida ou incompleta.', [], [
        'Colete propriedades próprias normalizadas para userScalable e maximumScale.'
      ]);
    }
    const blocked = (hasUserScalable && viewport.userScalable === false) ||
      (hasMaximumScale && viewport.maximumScale < 2);
    return blocked
      ? result('cantTell', 'Foi encontrada uma diretiva que solicita restringir o zoom; é necessário confirmar seu efeito.', [documentTarget(document, 'Verifique se a página permite ampliar o conteúdo no navegador e pelo gesto de pinça no celular.', { reason: 'zoom-restricted' })], [
        'Alguns navegadores ignoram a diretiva restritiva. Registre o navegador usado e se a ampliação foi realmente impedida; o código sozinho não comprova o bloqueio.'
      ])
      : result('cantTell', 'A diretiva observada não solicita bloquear o zoom mínimo, mas o comportamento não foi testado.', [], [
        'Confirme que a ampliação funciona pelo navegador e pelo gesto de pinça no celular; essa diretiva não comprova o requisito inteiro.'
      ]);
  });
}

function exceptionObservation(snapshot, field, failureProperty, label) {
  return visualResult(snapshot, ({ document }) => {
    if (label.coverageKey && probeCoverageCantTell(document, label.coverageKey)) return result('cantTell', `${label.observation} possui cobertura incompleta.`, [], [label.request]);
    if (!hasOwn(document, field) || !document[field] || typeof document[field] !== 'object') {
      return result('cantTell', `${label.observation} não foi observada.`, [], [label.request]);
    }
    const observation = document[field];
    if (label.complete && !label.complete(observation)) return result('cantTell', `${label.observation} está incompleta.`, [], [label.request]);
    if (typeof observation[failureProperty] !== 'boolean') return result('cantTell', `${label.observation} está incompleta.`, [], [label.request]);
    if (!observation[failureProperty]) return result('passed', label.passed);
    if (observation.exception === 'essential') return result('passed', `${label.observation} possui exceção essencial explicitamente observada.`);
    if (observation.exception !== 'none') return result('cantTell', `A exceção para ${label.observation.toLowerCase()} não foi determinada.`, [], [label.request]);
    return result('failed', label.failed, [documentTarget(document, label.message, { reason: label.reason })]);
  });
}

function textSpacing(snapshot) {
  return visualResult(snapshot, ({ document, nodes }) => {
    const observation = document.textSpacingObservation;
    if (!hasOwn(document, 'textSpacingObservation') || !observation || typeof observation !== 'object' || observation.applied !== true || typeof observation.lossOfContent !== 'boolean') {
      return result('cantTell', 'A página não foi observada com as substituições de espaçamento aplicadas.', [], [
        'Aplique os valores de teste de linha, parágrafo, letras e palavras e observe perda ou sobreposição.'
      ]);
    }
    if (!observation.lossOfContent) return result('passed', 'Não houve perda de conteúdo com os espaçamentos de teste.');
    const index = nodeIndex(nodes);
    const ids = Array.isArray(observation.affectedNodeIds) ? observation.affectedNodeIds : [];
    const targets = ids.map(id => index.get(String(id))).filter(Boolean).map(node =>
      target(node, 'Corrija a perda ou sobreposição causada pelos espaçamentos de teste.', { reason: 'text-spacing-content-loss' })
    );
    if (targets.length === 0) targets.push(documentTarget(document, 'Corrija a perda de conteúdo causada pelos espaçamentos de teste.', { reason: 'text-spacing-content-loss' }));
    return result('failed', 'A substituição de espaçamento causou perda ou sobreposição de conteúdo.', targets);
  });
}

function textResize(snapshot) {
  return visualResult(snapshot, ({ document }) => {
    if (probeCoverageCantTell(document, 'textResize')) {
      return result('cantTell', 'A medição automática de largura não cobre recorte vertical, sobreposição ou perda funcional; é necessária revisão humana.');
    }
    const observation = document.textResizeObservation;
    if (!observation || !finite(observation.scalePercent) || observation.scalePercent < 200 || typeof observation.lossOfContent !== 'boolean') {
      return result('cantTell', 'O redimensionamento de texto a 200% não foi observado completamente.', [], [
        'Amplie apenas o texto a 200% e registre perda de conteúdo ou funcionalidade.'
      ]);
    }
    return result('cantTell', 'A medição automática de largura não determina perda de conteúdo ou funcionalidade com texto a 200%.', [], [
      'Revise a página com apenas o texto ampliado a 200%, incluindo recorte vertical, sobreposição e perda de controles.'
    ]);
  });
}

function textBlock(snapshot, property, invalid, label) {
  return visualResult(snapshot, ({ nodes }) => {
    const candidates = nodes.filter(node => !isHidden(node) && node?.textBlock === true);
    if (candidates.length === 0) return result('inapplicable', 'Não há blocos de texto identificados.');
    const failures = [];
    let incomplete = false;
    for (const node of candidates) {
      if (!hasOwn(node, property) || (label.valid && !label.valid(node[property]))) incomplete = true;
      else if (invalid(node[property])) failures.push(target(node, label.message, { reason: label.reason }));
    }
    if (failures.length > 0) return result('failed', label.failed, failures);
    if (incomplete) return result('cantTell', `A observação de ${label.subject} não foi coletada para todos os blocos.`, [], [label.request]);
    return result('passed', label.passed);
  });
}

function specialTextSemantics(snapshot) {
  return visualResult(snapshot, ({ nodes }) => {
    const candidates = nodes.filter(node => !isHidden(node) && normalizeText(node?.specialTextKind));
    if (candidates.length === 0) return result('inapplicable', 'Não há texto especial identificado.');
    const failures = [];
    let incomplete = false;
    for (const node of candidates) {
      if (typeof node.specialTextSemantic !== 'boolean') incomplete = true;
      else if (!node.specialTextSemantic) failures.push(target(node, 'Exponha programaticamente o significado deste texto especial.', { reason: 'missing-special-text-semantics' }));
    }
    if (failures.length > 0) return result('failed', 'Há texto especial sem semântica correspondente.', failures);
    if (incomplete) return result('cantTell', 'A semântica calculada do texto especial não foi coletada.', [], ['Colete a semântica do texto especial identificado.']);
    return result('passed', 'Todo texto especial identificado possui semântica observável.');
  });
}

const FOCUS_LABELS = {
  visible: { message: 'Forneça um indicador de foco visível.', reason: 'focus-indicator-not-visible', failedSummary: 'Há elemento focado sem indicador visível.', passedSummary: 'Todos os elementos focados exibiram indicador visível.' },
  fully: { message: 'Evite que outros conteúdos ocultem o elemento focado.', reason: 'focus-not-fully-visible', failedSummary: 'Há elemento focado não totalmente visível.', passedSummary: 'Todos os elementos focados ficaram totalmente visíveis.' },
  partially: { message: 'Mantenha ao menos parte do elemento focado visível.', reason: 'focus-not-partially-visible', failedSummary: 'Há elemento focado totalmente oculto.', passedSummary: 'Todos os elementos focados ficaram ao menos parcialmente visíveis.' },
  area: { message: 'Aumente a área observável do indicador de foco.', reason: 'focus-indicator-area-insufficient', failedSummary: 'Há indicador de foco com área insuficiente.', passedSummary: 'Todos os indicadores observados possuem área suficiente.' }
};

export const VISUAL_RULES = createRuleRegistry([
  definition('focus-visible', snapshot => focusProperty(snapshot, 'indicatorVisible', FOCUS_LABELS.visible)),
  definition('focus-fully-visible', snapshot => focusProperty(snapshot, 'fullyVisible', FOCUS_LABELS.fully)),
  definition('focus-partially-visible', snapshot => focusProperty(snapshot, 'partiallyVisible', FOCUS_LABELS.partially)),
  definition('target-size-enhanced', snapshot => targetSize(snapshot, 44)),
  definition('target-size-minimum', snapshot => targetSize(snapshot, 24)),
  definition('display-orientation', snapshot => exceptionObservation(snapshot, 'orientationObservation', 'restricted', {
    observation: 'A orientação de exibição', request: 'Teste ambas as orientações e registre se a restrição é essencial ou inexistente.', passed: 'A página não restringe a orientação.', failed: 'A página restringe a orientação sem exceção.', message: 'Permita o uso em ambas as orientações.', reason: 'orientation-restricted'
  })),
  definition('responsive-reflow', snapshot => exceptionObservation(snapshot, 'reflowObservation', 'twoDimensionalScroll', {
    observation: 'O reflow a 320 CSS px', request: 'Teste a largura equivalente a 320 CSS px e registre rolagem bidimensional e exceção.', passed: 'Não houve rolagem bidimensional no teste de reflow.', failed: 'O conteúdo exige rolagem bidimensional sem exceção.', message: 'Faça o conteúdo refluir sem rolagem em duas dimensões.', reason: 'two-dimensional-scroll', coverageKey: 'reflow', complete: observation => finite(observation.testedWidthCssPx) && observation.testedWidthCssPx > 0 && observation.testedWidthCssPx <= 320
  })),
  definition('focus-indicator-area', snapshot => focusProperty(snapshot, 'areaSufficient', FOCUS_LABELS.area)),
  definition('text-contrast-enhanced', snapshot => textContrast(snapshot, true)),
  definition('text-contrast-minimum', snapshot => textContrast(snapshot, false)),
  definition('component-contrast', snapshot => nonTextContrast(snapshot, 'componentContrast', 'componente')),
  definition('graphic-object-contrast', snapshot => nonTextContrast(snapshot, 'graphicContrast', 'objeto gráfico')),
  definition('focus-indicator-contrast', snapshot => nonTextContrast(snapshot, 'focusContrast', 'indicador de foco')),
  definition('line-spacing', textSpacing),
  definition('paragraph-spacing', textSpacing),
  definition('letter-spacing', textSpacing),
  definition('word-spacing', textSpacing),
  definition('text-block-alignment', snapshot => textBlock(snapshot, 'textAlign', value => normalizeText(value).toLowerCase() === 'justify', {
    subject: 'alinhamento', message: 'Evite justificar este bloco de texto.', reason: 'justified-text-block', failed: 'Há bloco de texto justificado.', passed: 'Os blocos observados não estão justificados.', request: 'Colete o alinhamento calculado de cada bloco.'
  })),
  definition('text-block-width', snapshot => textBlock(snapshot, 'charactersPerLine', value => value > 80, {
    subject: 'largura', message: 'Limite a largura deste bloco a 80 caracteres por linha.', reason: 'text-block-too-wide', failed: 'Há bloco com mais de 80 caracteres por linha.', passed: 'Os blocos observados respeitam a largura máxima.', request: 'Meça os caracteres por linha de cada bloco.', valid: value => finite(value) && value >= 0
  })),
  definition('text-resizing', textResize),
  definition('special-text-semantics', specialTextSemantics),
  definition('zoom-not-blocked', zoomNotBlocked)
]);
