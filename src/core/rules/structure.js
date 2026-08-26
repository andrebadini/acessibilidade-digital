import { createRuleRegistry } from './registry.js';
import {
  ancestorNodes,
  attribute,
  descendantsOf,
  documentTarget,
  domIdIndex,
  hasAttribute,
  hasOwn,
  invalidReferences,
  isHidden,
  missingSnapshotResult,
  nodeIndex,
  normalizeText,
  normalizedComparableText,
  result,
  roleOf,
  snapshotParts,
  tagOf,
  target
} from './snapshot.js';

function structuralResult(snapshot, evaluate) {
  const parts = snapshotParts(snapshot);
  return parts ? evaluate(parts) : missingSnapshotResult();
}

const GRANDFATHERED_LANGUAGE_TAGS = new Set([
  'art-lojban', 'cel-gaulish', 'en-gb-oed', 'i-ami', 'i-bnn', 'i-default',
  'i-enochian', 'i-hak', 'i-klingon', 'i-lux', 'i-mingo', 'i-navajo', 'i-pwn',
  'i-tao', 'i-tay', 'i-tsu', 'no-bok', 'no-nyn', 'sgn-be-fr', 'sgn-be-nl',
  'sgn-ch-de', 'zh-guoyu', 'zh-hakka', 'zh-min', 'zh-min-nan', 'zh-xiang'
]);
const PRIVATE_LANGUAGE_TAG = /^x(?:-[a-z0-9]{1,8})+$/iu;

function validLanguageTag(value) {
  const language = normalizeText(value);
  if (!language || language.includes('_')) return false;
  const lower = language.toLowerCase();
  if (GRANDFATHERED_LANGUAGE_TAGS.has(lower) || PRIVATE_LANGUAGE_TAG.test(lower)) return true;
  try {
    Intl.getCanonicalLocales(language);
    return true;
  } catch {
    return false;
  }
}

function pageTitle(snapshot) {
  return structuralResult(snapshot, ({ document }) => {
    if (!hasOwn(document, 'title')) {
      return result('cantTell', 'O título da página não foi coletado.', [], [
        'Colete o título do documento para concluir a verificação.'
      ]);
    }
    if (!normalizeText(document.title)) {
      return result('failed', 'A página não possui título não vazio.', [
        documentTarget(document, 'Informe um título para a página.', { reason: 'missing-page-title' })
      ]);
    }
    return result(
      'cantTell',
      'A página possui título; é necessário confirmar se ele descreve seu assunto ou finalidade.',
      [],
      ['A qualidade e a finalidade do título exigem revisão humana.']
    );
  });
}

function pageLanguage(snapshot) {
  return structuralResult(snapshot, ({ document }) => {
    if (!hasOwn(document, 'language')) {
      return result('cantTell', 'O idioma principal não foi coletado.', [], [
        'Colete o idioma programático do documento para concluir a verificação.'
      ]);
    }
    if (!validLanguageTag(document.language)) {
      return result('failed', 'O idioma principal está ausente ou usa uma tag inválida.', [
        documentTarget(document, 'Declare uma tag de idioma válida no documento.', {
          reason: 'invalid-page-language'
        })
      ]);
    }
    return result(
      'cantTell',
      'A página declara uma tag de idioma válida; confirme se ela corresponde ao conteúdo.',
      [],
      ['A correspondência entre idioma declarado e conteúdo exige revisão humana.']
    );
  });
}

function partLanguage(snapshot) {
  return structuralResult(snapshot, ({ nodes }) => {
    const parts = nodes.filter(node => !isHidden(node) && hasAttribute(node, 'lang'));
    if (parts.length === 0) {
      return result('inapplicable', 'Nenhuma parte com idioma próprio foi declarada.');
    }
    const failures = parts.filter(node => !validLanguageTag(attribute(node, 'lang'))).map(node =>
      target(node, 'Use uma tag de idioma válida nesta parte da página.', {
        reason: 'invalid-part-language'
      })
    );
    if (failures.length > 0) {
      return result('failed', 'Há partes da página com tag de idioma inválida.', failures);
    }
    return result(
      'cantTell',
      'As tags de idioma das partes são válidas; confirme se correspondem ao conteúdo.',
      [],
      ['A mudança real de idioma e sua correspondência exigem revisão humana.']
    );
  });
}

function frameTitle(snapshot) {
  return structuralResult(snapshot, ({ nodes }) => {
    const frames = nodes.filter(node => !isHidden(node) && ['frame', 'iframe'].includes(tagOf(node)));
    if (frames.length === 0) return result('inapplicable', 'Não há frames na página observada.');
    const failures = frames.filter(node => !normalizeText(attribute(node, 'title'))).map(node =>
      target(node, 'Informe um título não vazio para este frame.', { reason: 'missing-frame-title' })
    );
    if (failures.length > 0) return result('failed', 'Há frames sem título.', failures);
    return result(
      'cantTell',
      'Todos os frames possuem título; confirme se cada título identifica sua finalidade.',
      [],
      ['A qualidade do título do frame exige revisão humana.']
    );
  });
}

function headingCandidates(nodes) {
  return nodes.filter(node => !isHidden(node) && (/^h[1-6]$/u.test(tagOf(node)) || roleOf(node) === 'heading'));
}

function observedHeadingLevel(node) {
  return Number.isInteger(node?.headingLevel) ? node.headingLevel : null;
}

function headingSemantics(snapshot) {
  return structuralResult(snapshot, ({ nodes }) => {
    const headings = headingCandidates(nodes);
    if (headings.length === 0) return result('inapplicable', 'Não há cabeçalhos observáveis.');
    const failures = [];
    let incomplete = false;
    for (const node of headings) {
      const native = /^h[1-6]$/u.test(tagOf(node));
      const role = roleOf(node);
      const level = observedHeadingLevel(node);
      if (native && !role) {
        incomplete = true;
      } else if ((native && role !== 'heading') || (!native && (role !== 'heading' || level === null))) {
        failures.push(target(node, 'Exponha este cabeçalho com função e nível de cabeçalho.', {
          reason: 'invalid-heading-semantics'
        }));
      } else if (level === null) {
        incomplete = true;
      } else if (level < 1 || level > 6) {
        failures.push(target(node, 'Use um nível de cabeçalho entre 1 e 6.', {
          reason: 'invalid-heading-level'
        }));
      }
    }
    if (failures.length > 0) return result('failed', 'Há cabeçalhos sem semântica válida.', failures);
    if (incomplete) return result('cantTell', 'Faltam dados de função ou nível de cabeçalho.', [], [
      'Colete a função e o nível calculados para todos os cabeçalhos.'
    ]);
    return result('passed', 'Todos os cabeçalhos observados possuem função e nível válidos.');
  });
}

function headingOrder(snapshot) {
  return structuralResult(snapshot, ({ nodes }) => {
    const headings = headingCandidates(nodes);
    if (headings.length < 2) {
      return result('inapplicable', 'Não há cabeçalhos suficientes para avaliar a ordem.');
    }
    if (headings.some(node => observedHeadingLevel(node) === null)) {
      return result('cantTell', 'Nem todos os níveis de cabeçalho foram coletados.', [], [
        'Colete o nível calculado de cada cabeçalho para avaliar saltos.'
      ]);
    }
    const failures = [];
    let prior = observedHeadingLevel(headings[0]);
    for (const node of headings.slice(1)) {
      const level = observedHeadingLevel(node);
      if (level > prior + 1) {
        failures.push(target(node, 'Evite saltar níveis ao aprofundar a estrutura de cabeçalhos.', {
          reason: 'heading-level-skip', previousLevel: prior, level
        }));
      }
      prior = level;
    }
    if (failures.length > 0) {
      return result('failed', 'A estrutura contém saltos ascendentes de nível de cabeçalho.', failures);
    }
    return result(
      'cantTell',
      'Não foram observados saltos de nível; a adequação da estrutura exige revisão.',
      [],
      ['A hierarquia e a finalidade dos cabeçalhos dependem do conteúdo.']
    );
  });
}

function containerHeadings(snapshot, kind) {
  return structuralResult(snapshot, ({ nodes }) => {
    const containers = nodes.filter(node => !isHidden(node) && tagOf(node) === kind);
    if (containers.length === 0) {
      return result('inapplicable', `Não há elementos ${kind} observáveis.`);
    }
    const index = nodeIndex(nodes);
    const failures = [];
    let incomplete = false;
    for (const container of containers) {
      const descendants = descendantsOf(container, index);
      if (descendants === null) {
        incomplete = true;
        continue;
      }
      const hasHeading = descendants.some(node => headingCandidates([node]).length === 1);
      if (!hasHeading) {
        failures.push(target(container, `Forneça um cabeçalho para este elemento ${kind}.`, {
          reason: kind === 'main' ? 'missing-main-heading' : 'missing-section-heading'
        }));
      }
    }
    if (failures.length > 0) return result('failed', `Há elementos ${kind} sem cabeçalho observável.`, failures);
    if (incomplete) return result('cantTell', `A descendência de um elemento ${kind} não foi coletada.`, [], [
      'Colete a árvore completa do elemento para verificar seus cabeçalhos.'
    ]);
    return result(
      'cantTell',
      `Os elementos ${kind} possuem cabeçalhos; confirme se identificam adequadamente o conteúdo.`,
      [],
      ['A adequação do cabeçalho exige revisão humana.']
    );
  });
}

const NATIVE_LANDMARKS = Object.freeze({ main: 'main', nav: 'navigation', aside: 'complementary' });
const LANDMARK_ROLES = new Set([
  'banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region', 'search'
]);

function landmarks(nodes) {
  return nodes.filter(node => !isHidden(node) &&
    (Object.hasOwn(NATIVE_LANDMARKS, tagOf(node)) || LANDMARK_ROLES.has(roleOf(node))));
}

function landmarkSemantics(snapshot) {
  return structuralResult(snapshot, ({ nodes }) => {
    const candidates = landmarks(nodes);
    if (candidates.length === 0) return result('inapplicable', 'Não há regiões observáveis.');
    const failures = [];
    let incomplete = false;
    for (const node of candidates) {
      const expected = NATIVE_LANDMARKS[tagOf(node)];
      const role = roleOf(node);
      if (!role) incomplete = true;
      else if ((expected && role !== expected) || !LANDMARK_ROLES.has(role)) {
        failures.push(target(node, 'Exponha esta região com a função semântica correspondente.', {
          reason: 'invalid-landmark-semantics'
        }));
      }
    }
    if (failures.length > 0) return result('failed', 'Há regiões sem semântica válida.', failures);
    if (incomplete) return result('cantTell', 'A função calculada de uma região não foi coletada.', [], [
      'Colete a função de acessibilidade das regiões.'
    ]);
    return result('passed', 'Todas as regiões observadas possuem semântica válida.');
  });
}

function uniqueLandmarks(snapshot) {
  return structuralResult(snapshot, ({ nodes }) => {
    const candidates = landmarks(nodes);
    if (candidates.length === 0) return result('inapplicable', 'Não há regiões únicas observáveis.');
    if (candidates.some(node => !roleOf(node))) {
      return result('cantTell', 'A função calculada de uma região não foi coletada.', [], [
        'Colete a função de acessibilidade das regiões antes de avaliar unicidade.'
      ]);
    }
    const singletonRoles = new Set(['banner', 'contentinfo', 'main']);
    const counts = new Map();
    for (const node of candidates) {
      const role = roleOf(node);
      if (singletonRoles.has(role)) counts.set(role, (counts.get(role) ?? 0) + 1);
    }
    const failures = candidates.filter(node => (counts.get(roleOf(node)) ?? 0) > 1).map(node =>
      target(node, 'Mantenha apenas uma região deste tipo na página.', {
        reason: 'duplicate-unique-landmark', role: roleOf(node)
      })
    );
    return failures.length > 0
      ? result('failed', 'Há regiões que deveriam ser únicas repetidas na página.', failures)
      : result('passed', 'As regiões de ocorrência única não estão duplicadas.');
  });
}

function landmarkUniqueNames(snapshot) {
  return structuralResult(snapshot, ({ nodes }) => {
    const candidates = landmarks(nodes);
    if (candidates.length === 0) return result('inapplicable', 'Não há regiões para comparar nomes.');
    if (candidates.some(node => !roleOf(node))) {
      return result('cantTell', 'A função calculada de uma região não foi coletada.', [], [
        'Colete a função de acessibilidade das regiões antes de comparar nomes.'
      ]);
    }
    const groups = new Map();
    for (const node of candidates) {
      const role = roleOf(node);
      const group = groups.get(role) ?? [];
      group.push(node);
      groups.set(role, group);
    }
    const failing = new Set();
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const names = new Map();
      for (const node of group) {
        const name = normalizedComparableText(node?.accessibleName);
        if (!name) {
          failing.add(node);
          continue;
        }
        const same = names.get(name) ?? [];
        same.push(node);
        names.set(name, same);
      }
      for (const same of names.values()) if (same.length > 1) same.forEach(node => failing.add(node));
    }
    const failures = candidates.filter(node => failing.has(node)).map(node =>
      target(node, 'Dê nomes acessíveis distintos às regiões repetidas do mesmo tipo.', {
        reason: 'duplicate-or-missing-landmark-name', role: roleOf(node)
      })
    );
    return failures.length > 0
      ? result('failed', 'Há regiões repetidas sem identificação única.', failures)
      : result('passed', 'As regiões repetidas possuem nomes acessíveis distintos.');
  });
}

function listSemantics(snapshot) {
  return structuralResult(snapshot, ({ nodes }) => {
    const candidates = nodes.filter(node => !isHidden(node) && (
      ['li', 'ol', 'ul'].includes(tagOf(node)) || ['list', 'listitem'].includes(roleOf(node))
    ));
    if (candidates.length === 0) return result('inapplicable', 'Não há listas observáveis.');
    const index = nodeIndex(nodes);
    const failures = [];
    let incomplete = false;
    for (const node of candidates) {
      const tag = tagOf(node);
      const role = roleOf(node);
      if (['ol', 'ul'].includes(tag) && role && role !== 'list') {
        failures.push(target(node, 'Preserve a semântica de lista deste elemento.', { reason: 'invalid-list-role' }));
      }
      if (tag === 'li' || role === 'listitem') {
        const chain = ancestorNodes(node, index);
        if (!chain.complete) incomplete = true;
        else if (!chain.ancestors.some(parent => ['ol', 'ul'].includes(tagOf(parent)) || roleOf(parent) === 'list')) {
          failures.push(target(node, 'Associe este item a uma lista semântica.', {
            reason: 'listitem-outside-list'
          }));
        }
      }
    }
    if (failures.length > 0) return result('failed', 'Há elementos de lista com estrutura inválida.', failures);
    if (incomplete) return result('cantTell', 'A ancestralidade de um item de lista não foi coletada.', [], [
      'Colete a árvore ancestral completa do item.'
    ]);
    return result('passed', 'A estrutura observável das listas é semântica.');
  });
}

function isTable(node) {
  return tagOf(node) === 'table' || ['grid', 'table'].includes(roleOf(node));
}

function isCell(node) {
  return ['td', 'th'].includes(tagOf(node)) ||
    ['cell', 'columnheader', 'rowheader'].includes(roleOf(node));
}

function tableSemantics(snapshot) {
  return structuralResult(snapshot, ({ nodes }) => {
    const candidates = nodes.filter(node => !isHidden(node) && (isTable(node) || isCell(node)));
    if (candidates.length === 0) return result('inapplicable', 'Não há tabelas observáveis.');
    const index = nodeIndex(nodes);
    const failures = [];
    let incomplete = false;
    for (const node of candidates) {
      if (tagOf(node) === 'table' && roleOf(node) && !['grid', 'table'].includes(roleOf(node))) {
        failures.push(target(node, 'Preserve a semântica de tabela deste elemento.', {
          reason: 'invalid-table-role'
        }));
      }
      if (isCell(node)) {
        const chain = ancestorNodes(node, index);
        if (!chain.complete) incomplete = true;
        else if (!chain.ancestors.some(isTable)) {
          failures.push(target(node, 'Associe esta célula a uma tabela semântica.', {
            reason: 'cell-outside-table'
          }));
        }
      }
    }
    if (failures.length > 0) return result('failed', 'Há tabelas ou células com estrutura inválida.', failures);
    if (incomplete) return result('cantTell', 'A ancestralidade de uma célula não foi coletada.', [], [
      'Colete a árvore ancestral completa da célula.'
    ]);
    return result('passed', 'A estrutura observável das tabelas é semântica.');
  });
}

function tableHeaders(snapshot) {
  return structuralResult(snapshot, ({ nodes }) => {
    const cells = nodes.filter(node => !isHidden(node) &&
      (tagOf(node) === 'td' || roleOf(node) === 'cell'));
    if (cells.length === 0) return result('inapplicable', 'Não há células de dados para associar a cabeçalhos.');
    const ids = domIdIndex(nodes);
    const failures = [];
    let incomplete = false;
    for (const cell of cells) {
      if (!hasAttribute(cell, 'headers')) {
        incomplete = true;
        continue;
      }
      const invalid = invalidReferences(cell, ['headers'], ids);
      if (invalid) {
        failures.push(target(cell, 'Corrija a referência aos cabeçalhos desta célula.', {
          ...invalid, attribute: 'headers'
        }));
        continue;
      }
      const references = normalizeText(attribute(cell, 'headers')).split(' ').filter(Boolean);
      if (references.length === 0 || references.some(id => {
        const header = ids.get(id)?.[0];
        return !header || (tagOf(header) !== 'th' && !['columnheader', 'rowheader'].includes(roleOf(header)));
      })) {
        failures.push(target(cell, 'Associe esta célula a cabeçalhos semânticos válidos.', {
          reason: 'invalid-header-reference', attribute: 'headers'
        }));
      }
    }
    if (failures.length > 0) return result('failed', 'Há células com associação de cabeçalho inválida ou ambígua.', failures);
    if (incomplete) return result('cantTell', 'Nem todas as associações de cabeçalho puderam ser determinadas.', [], [
      'Forneça associação objetiva por headers ou dados normalizados equivalentes.'
    ]);
    return result('passed', 'Todas as células de dados possuem associação objetiva com cabeçalhos.');
  });
}

export const STRUCTURE_RULES = createRuleRegistry([
  { id: 'page-title', mode: 'assisted', nbrItems: ['5.13.1'], wcag: ['2.4.2'], evaluate: pageTitle },
  { id: 'page-language', mode: 'assisted', nbrItems: ['5.13.2'], wcag: ['3.1.1'], evaluate: pageLanguage },
  { id: 'part-language', mode: 'assisted', nbrItems: ['5.13.3'], wcag: ['3.1.2'], evaluate: partLanguage },
  { id: 'frame-title', mode: 'assisted', nbrItems: ['5.13.4'], wcag: ['1.3.1', '4.1.2'], evaluate: frameTitle },
  { id: 'heading-semantics', mode: 'automated', nbrItems: ['5.3.1'], wcag: ['1.3.1'], evaluate: headingSemantics },
  { id: 'main-heading', mode: 'assisted', nbrItems: ['5.3.3'], wcag: ['2.4.6', '2.4.10'], evaluate: snapshot => containerHeadings(snapshot, 'main') },
  { id: 'section-headings', mode: 'assisted', nbrItems: ['5.3.4'], wcag: ['2.4.10'], evaluate: snapshot => containerHeadings(snapshot, 'section') },
  { id: 'heading-order', mode: 'assisted', nbrItems: ['5.3.5'], wcag: ['1.3.1', '2.4.6', '2.4.10'], evaluate: headingOrder },
  { id: 'landmark-semantics', mode: 'automated', nbrItems: ['5.4.1'], wcag: ['1.3.1', '1.3.6'], evaluate: landmarkSemantics },
  { id: 'unique-landmarks', mode: 'automated', nbrItems: ['5.4.4'], wcag: ['1.3.1', '1.3.6'], evaluate: uniqueLandmarks },
  { id: 'landmark-unique-names', mode: 'automated', nbrItems: ['5.4.5'], wcag: ['1.3.1', '4.1.2'], evaluate: landmarkUniqueNames },
  { id: 'list-semantics', mode: 'automated', nbrItems: ['5.5.1'], wcag: ['1.3.1'], evaluate: listSemantics },
  { id: 'table-semantics', mode: 'automated', nbrItems: ['5.6.1'], wcag: ['1.3.1'], evaluate: tableSemantics },
  { id: 'table-headers', mode: 'assisted', nbrItems: ['5.6.3'], wcag: ['1.3.1'], evaluate: tableHeaders }
]);
