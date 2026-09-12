import { contrastRatio } from '../color.js';
import { NBR17225_ITEMS } from '../normative/nbr17225.js';
import { createRuleRegistry } from './registry.js';
import {
  ancestorNodes,
  attribute,
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
  tagOf,
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
    const index = nodeIndex(nodes);
    const candidates = nodes.filter(node => (node.hasRenderedBox === true || (node.hasRenderedBox !== false && !isHidden(node))) && normalizeText(node?.text) &&
      node.textContrastScope !== 'aggregate' && !inactiveText(node, index));
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

function inactiveText(node, index) {
  for (const current of [node, ...ancestorNodes(node, index).ancestors]) {
    if (isComponent({ ...current, role: current.axRole || current.role })) return nativeInactive(current);
  }
  return false;
}

function nonTextContrast(snapshot, field, kind) {
  return visualResult(snapshot, ({ nodes }) => {
    const index = nodeIndex(nodes);
    const candidates = field === 'graphicContrast'
      ? nodes.filter(node => (node.hasRenderedBox === true ||
        (node.hasRenderedBox !== false && !isHidden(node) && !ancestorNodes(node, index).ancestors.some(isHidden))) && (
        node?.graphicObject === true || hasOwn(node, field) ||
        ['img', 'svg', 'canvas'].includes(tagOf(node)) ||
        ['img', 'image', 'graphics-document', 'graphics-object', 'graphics-symbol'].includes(normalizeText(node.axRole || node.role || attribute(node, 'role')).toLowerCase()) ||
        (tagOf(node) === 'input' && normalizeText(attribute(node, 'type')).toLowerCase() === 'image') ||
        ['url', 'gradient', 'mixed'].includes(node.backgroundImageKind)
      ))
      : field === 'focusContrast'
        ? nodes.filter(node => !isHidden(node) && (node?.focusable === true || hasOwn(node, field)))
        : nodes.filter(node => isComponent(node) && !nativeInactive(node));
    if (candidates.length === 0) return result('inapplicable', `Não há ${kind} aplicáveis.`);
    const failures = [];
    const inactiveReview = [];
    let incomplete = false;
    for (const node of candidates) {
      if (field === 'componentContrast' && normalizeText(attribute(node, 'aria-disabled')).toLowerCase() === 'true') {
        incomplete = true;
        inactiveReview.push(target(node, 'O componente declara estar inativo. Confirme se realmente não pode ser acionado; apenas a declaração não comprova a exceção de contraste.', { reason: 'inactive-component-unconfirmed' }));
        continue;
      }
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
    if (incomplete && field === 'graphicContrast') return result('cantTell',
      'Há conteúdo gráfico cuja função ou contraste não foi determinado. Isso não comprova contraste insuficiente.', [], [
        'Identifique as partes necessárias para entender a informação: por exemplo, barras de um gráfico, linhas de um mapa ou um ícone informativo. Meça contraste de pelo menos 3:1 com o fundo e entre partes adjacentes necessárias. Não é preciso aplicar essa medida indiscriminadamente a todos os pixels de uma fotografia.',
        'Verifique se uma apresentação específica é essencial à informação, como as cores originais de uma obra analisada. Registre essa justificativa; estar em uma imagem ou ter texto alternativo não comprova, por si só, a exceção.'
      ]);
    if (incomplete) return result('cantTell', `A medição ou a aplicabilidade do contraste de ${kind} precisa de confirmação.`, inactiveReview, [
      'Colete as cores finais dos pixels relevantes e sua composição de fundo. Se o componente declarar estar inativo, confirme esse estado antes de aplicar a exceção.'
    ]);
    return result('passed', `Todos os ${kind} aplicáveis atendem ao contraste observado.`);
  });
}

function nativeInactive(node) {
  if (!['button', 'input', 'select', 'textarea'].includes(normalizeText(node?.tagName).toLowerCase())) return false;
  return typeof attribute(node, 'disabled') === 'string' || node.disabled === true || node.form?.disabled === true;
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
    if (!observation[failureProperty]) return label.passNeedsReview
      ? result('cantTell', label.passNeedsReview, [], [label.request])
      : result('passed', label.passed);
    if (observation.exception === 'essential') return result('passed', `${label.observation} possui exceção essencial explicitamente observada.`);
    if (observation.exception !== 'none') return result('cantTell', `A exceção para ${label.observation.toLowerCase()} não foi determinada.`, [], [label.request]);
    return result('failed', label.failed, [documentTarget(document, label.message, { reason: label.reason })]);
  });
}

function cssPixelLength(value) {
  const match = typeof value === 'string' && value.trim().match(/^(-?(?:\d+|\d*\.\d+))px$/u);
  return match && finite(Number(match[1])) ? Number(match[1]) : null;
}

function textSpacing(snapshot, dimension) {
  return visualResult(snapshot, ({ nodes }) => {
    if (!dimension) return result('cantTell', 'A distância entre os parágrafos e a alternativa de ajuste precisam de verificação.', [], [
      'Verifique se os parágrafos têm distância de pelo menos duas vezes o tamanho da fonte, ou se há mecanismo de ajuste que alcance esse valor sem perder conteúdo ou funções.'
    ]);
    const index = nodeIndex(nodes);
    const candidates = nodes.filter(node => normalizeText(node.text) && !isHidden(node) &&
      node.textContrastScope !== 'aggregate' && !ancestorNodes(node, index).ancestors.some(isHidden));
    const sufficient = candidates.length > 0 && candidates.every(node => {
      const fontSize = cssPixelLength(node.styles?.['font-size'] ?? node.styles?.fontSize);
      const spacing = cssPixelLength(node.styles?.[dimension.property]);
      return fontSize !== null && fontSize > 0 && spacing !== null && spacing >= dimension.ratio * fontSize;
    });
    if (sufficient) return result('passed', `O espaçamento ${dimension.label} nos textos observados já atende ao valor mínimo da ABNT, conforme os estilos calculados.`, [], [
      'Esta verificação examina o valor inicial observado; não simula ajustes nem comprova ausência de recorte ou sobreposição em outros estados.'
    ]);
    return result('cantTell', `O valor inicial de espaçamento ${dimension.label} não foi comprovado para todo o texto; a alternativa de ajuste precisa de revisão.`, [], [
      `Verifique se existe mecanismo para ajustar o espaçamento ${dimension.label} a pelo menos ${dimension.displayRatio} vez o tamanho da fonte, sem perder conteúdo ou funções.`,
      'Um valor inicial menor, sozinho, não comprova descumprimento: a norma também admite a alternativa de ajuste. Compare antes e depois e procure texto cortado, sobreposto ou controles inacessíveis.'
    ]);
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

function textBlockAlignment(snapshot) {
  return visualResult(snapshot, ({ nodes, document }) => {
    const index = nodeIndex(nodes);
    const candidates = nodes.filter(node => node?.textBlock === true &&
      (node.hasRenderedBox === true || (node.hasRenderedBox !== false && !isHidden(node) &&
      !ancestorNodes(node, index).ancestors.some(isHidden))));
    if (!candidates.length) return result('inapplicable', 'Não há blocos de texto identificados.');
    const blockSet = new Set(candidates);
    const nestedByBlock = new Map();
    for (const child of candidates) {
      const parent = ancestorNodes(child, index).ancestors.find(ancestor => blockSet.has(ancestor));
      if (parent) {
        if (!nestedByBlock.has(parent)) nestedByBlock.set(parent, []);
        nestedByBlock.get(parent).push(child);
      }
    }
    const targets = [];
    let incomplete = false;
    for (const node of candidates) {
      if (!normalizeText(node.text || node.visibleText)) { incomplete = true; continue; }
      if (node.textContrastScope === 'aggregate') {
        const nestedBlocks = nestedByBlock.get(node) || [];
        const nestedText = normalizeText(nestedBlocks.map(child => child.text || child.visibleText || '').join(' '));
        if (nestedText === normalizeText(node.text || node.visibleText)) continue;
      }
      const ancestry = ancestorNodes(node, index);
      const languageNode = [node, ...ancestry.ancestors].find(item => attribute(item, 'lang') !== undefined);
      const language = languageNode ? attribute(languageNode, 'lang') : ancestry.complete ? document.language : '';
      let readingDirection;
      try {
        const locale = new Intl.Locale(language);
        if (locale.language !== 'und' && locale.maximize().script) readingDirection = locale.getTextInfo().direction;
      } catch { /* Missing or unsupported language data is not proof of alignment. */ }
      let align = normalizeText(node.textAlign).toLowerCase();
      if (align === 'start' || align === 'end') {
        const direction = node.styles?.direction;
        if (direction === 'ltr' || direction === 'rtl') {
          align = (align === 'start') === (direction === 'ltr') ? 'left' : 'right';
        }
      }
      if (!['ltr', 'rtl'].includes(readingDirection) || !['left', 'right', 'center', 'justify'].includes(align)) {
        incomplete = true;
        continue;
      }
      if (align !== (readingDirection === 'ltr' ? 'left' : 'right')) {
        targets.push(target(node,
          'O alinhamento difere do recomendado para o idioma declarado. Confirme se ele é essencial para compreender o conteúdo; caso contrário, alinhe ao início da leitura.',
          { reason: 'alignment-essentiality-unconfirmed' }));
      }
    }
    if (targets.length || incomplete) return result('cantTell',
      'A recomendação de alinhamento precisa de revisão nos blocos indicados ou sem observação suficiente.', targets, [
        'Confira o idioma e o alinhamento: português à esquerda; árabe ou hebraico à direita. Se o alinhamento for diferente, verifique se a posição transmite significado essencial, como em um poema visual. Preferência estética, sozinha, não demonstra essa exceção.'
      ]);
    return result('passed', 'Os blocos observados estão alinhados conforme a direção de leitura dos idiomas declarados. A adequação das declarações de idioma é verificada separadamente.');
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
    // Inventory of markup in the redacted snapshot, not proof of complete semantic coverage.
    const tags = new Set(['em', 'strong', 'q', 'blockquote', 'abbr', 'cite', 'dfn', 'code', 'kbd', 'samp', 'var', 'sub', 'sup']);
    const index = nodeIndex(nodes);
    const count = nodes.filter(node => tags.has(tagOf(node)) &&
      normalizeText(node.visibleText || node.text) && !isHidden(node) &&
      !ancestorNodes(node, index).ancestors.some(isHidden)).length;
    return result('cantTell', count > 0
      ? `Foram observadas ${count} ${count === 1 ? 'marcação de texto especial' : 'marcações de texto especial'}. Isso não comprova que todos os trechos estejam identificados corretamente.`
      : 'Não foi possível determinar se há informação transmitida por destaques ou outros textos especiais sem marcação correspondente.', [], [
      'Compare os destaques com seu significado. Por exemplo, se uma palavra enfatizada muda o sentido da frase, verifique se essa ênfase também está identificada no código, e não apenas na aparência.',
      'Negrito ou itálico podem ser apenas decoração. A presença de marcações não comprova a cobertura de todos os trechos, nem sua exposição efetiva. O uso adequado à finalidade é revisado separadamente no item 5.12.9.'
    ]);
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
    observation: 'O reflow a 320 CSS px',
    request: 'Compare textos e funções a 320 CSS px de largura (fluxo vertical) ou 256 CSS px de altura (horizontal). Procure cortes e rolagem em duas direções; confirme se o leiaute bidimensional é essencial.',
    passNeedsReview: 'A ausência de rolagem horizontal não comprova preservação de conteúdo e funções. Essa parte do requisito ainda precisa ser verificada.',
    failed: 'O conteúdo exige rolagem bidimensional sem exceção.', message: 'Faça o conteúdo refluir sem rolagem em duas dimensões.', reason: 'two-dimensional-scroll', coverageKey: 'reflow', complete: observation => finite(observation.testedWidthCssPx) && observation.testedWidthCssPx > 0 && observation.testedWidthCssPx <= 320
  })),
  definition('focus-indicator-area', snapshot => focusProperty(snapshot, 'areaSufficient', FOCUS_LABELS.area)),
  definition('text-contrast-enhanced', snapshot => textContrast(snapshot, true)),
  definition('text-contrast-minimum', snapshot => textContrast(snapshot, false)),
  definition('component-contrast', snapshot => nonTextContrast(snapshot, 'componentContrast', 'componente')),
  definition('graphic-object-contrast', snapshot => nonTextContrast(snapshot, 'graphicContrast', 'objeto gráfico')),
  definition('focus-indicator-contrast', snapshot => nonTextContrast(snapshot, 'focusContrast', 'indicador de foco')),
  definition('line-spacing', snapshot => textSpacing(snapshot, { property: 'line-height', ratio: 1.5, displayRatio: '1,5', label: 'entre linhas' })),
  definition('paragraph-spacing', snapshot => textSpacing(snapshot, null)),
  definition('letter-spacing', snapshot => textSpacing(snapshot, { property: 'letter-spacing', ratio: 0.12, displayRatio: '0,12', label: 'entre letras' })),
  definition('word-spacing', snapshot => textSpacing(snapshot, { property: 'word-spacing', ratio: 0.16, displayRatio: '0,16', label: 'entre palavras' })),
  definition('text-block-alignment', textBlockAlignment),
  definition('text-block-width', snapshot => textBlock(snapshot, 'charactersPerLine', value => value > 80, {
    subject: 'largura', message: 'Limite a largura deste bloco a 80 caracteres por linha.', reason: 'text-block-too-wide', failed: 'Há bloco com mais de 80 caracteres por linha.', passed: 'Os blocos observados respeitam a largura máxima.', request: 'Meça os caracteres por linha de cada bloco.', valid: value => finite(value) && value >= 0
  })),
  definition('text-resizing', textResize),
  definition('special-text-semantics', specialTextSemantics),
  definition('zoom-not-blocked', zoomNotBlocked)
]);
