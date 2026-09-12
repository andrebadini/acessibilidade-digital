import { createRuleRegistry } from './registry.js';
import {
  attribute,
  domIdIndex,
  hasAttribute,
  hasOwn,
  invalidReferences,
  isComponent,
  isHidden,
  isNativeControl,
  missingSnapshotResult,
  normalizeText,
  normalizedComparableText,
  normalizedLabelText,
  orderTargets,
  result,
  roleOf,
  snapshotParts,
  tagOf,
  target
} from './snapshot.js';

function interactiveResult(snapshot, evaluate) {
  const parts = snapshotParts(snapshot);
  if (!parts) return missingSnapshotResult();
  const value = evaluate(parts);
  return { ...value, targets: orderTargets(value.targets, parts.nodes) };
}

// ARIA in HTML permits these native controls to expose a different widget role.
// Those widgets still require the component checks; they are not failed links/buttons.
const LINK_REPLACEMENTS = new Set(['button', 'checkbox', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'radio', 'switch', 'tab', 'treeitem']);
const BUTTON_REPLACEMENTS = new Set(['checkbox', 'combobox', 'gridcell', 'link', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'separator', 'slider', 'switch', 'tab', 'treeitem']);
const LINK_ROLES = new Set(['link', 'doc-backlink', 'doc-biblioref', 'doc-glossref', 'doc-noteref']);
const controlRole = node => normalizeText(node?.axRole).toLowerCase() || roleOf(node);
const isObservedComponent = node => isComponent({ ...node, role: controlRole(node) });

function isLink(node) {
  if (tagOf(node) === 'a' && LINK_REPLACEMENTS.has(controlRole(node)) && node?.interaction !== 'link') return false;
  return !isHidden(node) && (
    (tagOf(node) === 'a' && hasAttribute(node, 'href')) ||
    LINK_ROLES.has(controlRole(node)) || node?.interaction === 'link'
  );
}

function isButton(node) {
  const tag = tagOf(node);
  const type = normalizeText(attribute(node, 'type') ?? 'text').toLowerCase();
  if ((tag === 'button' || (tag === 'input' && ['button', 'image', 'reset', 'submit'].includes(type))) &&
    BUTTON_REPLACEMENTS.has(controlRole(node)) &&
    !(tag === 'input' && type === 'image' && controlRole(node) === 'combobox') &&
    node?.interaction !== 'button') return false;
  return !isHidden(node) && (
    tag === 'button' ||
    (tag === 'input' && ['button', 'image', 'reset', 'submit'].includes(type)) ||
    controlRole(node) === 'button' || node?.interaction === 'button'
  );
}

function hasLinkSemantics(node) {
  const native = tagOf(node) === 'a' && hasAttribute(node, 'href');
  const role = controlRole(node);
  return native ? !role || LINK_ROLES.has(role) : LINK_ROLES.has(role);
}

function hasButtonSemantics(node) {
  const tag = tagOf(node);
  const type = normalizeText(attribute(node, 'type') ?? 'text').toLowerCase();
  const native = tag === 'button' ||
    (tag === 'input' && ['button', 'image', 'reset', 'submit'].includes(type));
  const role = controlRole(node);
  return native ? !role || role === 'button' : role === 'button';
}

function semantics(snapshot, kind) {
  return interactiveResult(snapshot, ({ nodes }) => {
    const candidates = nodes.filter(kind === 'link' ? isLink : isButton);
    if (candidates.length === 0) {
      return result('inapplicable', `Não há ${kind === 'link' ? 'links' : 'botões'} observáveis.`);
    }
    const valid = kind === 'link' ? hasLinkSemantics : hasButtonSemantics;
    const failures = candidates.filter(node => !valid(node)).map(node =>
      target(node, `Exponha esta interação com semântica de ${kind === 'link' ? 'link' : 'botão'}.`, {
        reason: `missing-${kind}-semantics`
      })
    );
    return failures.length > 0
      ? result('failed', `Há interações sem semântica de ${kind === 'link' ? 'link' : 'botão'}.`, failures)
      : result('passed', `Todas as interações observadas possuem semântica de ${kind === 'link' ? 'link' : 'botão'}.`);
  });
}

function assistedPurpose(snapshot, kind) {
  return interactiveResult(snapshot, ({ nodes }) => {
    const candidates = nodes.filter(kind === 'link' ? isLink : isButton);
    if (candidates.length === 0) {
      return result('inapplicable', `Não há ${kind === 'link' ? 'links' : 'botões'} para avaliar.`);
    }
    const semantic = kind === 'link' ? hasLinkSemantics : hasButtonSemantics;
    const failures = [];
    const reviewTargets = [];
    let incomplete = false;
    for (const node of candidates) {
      if (!semantic(node)) {
        failures.push(target(node, `Exponha a finalidade com semântica de ${kind === 'link' ? 'link' : 'botão'}.`, {
          reason: `missing-${kind}-semantics`
        }));
      } else if (!hasOwn(node, 'accessibleName')) {
        incomplete = true;
      } else if (!normalizeText(node.accessibleName)) {
        failures.push(target(node, `Forneça um nome acessível para este ${kind === 'link' ? 'link' : 'botão'}.`, {
          reason: 'missing-accessible-name'
        }));
      } else if (kind === 'link' && genericLinkName(node.accessibleName)) {
        const observed = normalizeText(node?.linkPurposeContext);
        const contextObservation = LINK_CONTEXT_STATES.has(observed) ? observed : 'unknown-context';
        reviewTargets.push(target(node, 'Confirme a finalidade deste link genérico no contexto observado.', {
          reason: 'generic-link-purpose', contextObservation
        }));
      }
    }
    if (failures.length > 0) {
      return result('failed', `Há ${kind === 'link' ? 'links' : 'botões'} sem identificação objetiva.`, failures);
    }
    if (incomplete) {
      return result('cantTell', 'O nome acessível de um componente não foi coletado.', [], [
        'Colete o nome acessível calculado de todos os componentes.'
      ]);
    }
    if (reviewTargets.length > 0) {
      return result(
        'cantTell',
        'Há links genéricos cuja finalidade exige revisão contextual.',
        reviewTargets,
        ['A qualidade da finalidade permanece sob revisão humana, inclusive quando há contexto estrutural potencial.']
      );
    }
    return result(
      'cantTell',
      `Os ${kind === 'link' ? 'links' : 'botões'} possuem identificação; confirme se a finalidade está clara.`,
      [],
      ['A finalidade do componente e sua adequação ao contexto exigem revisão humana.']
    );
  });
}

const GENERIC_LINK_NAMES = new Set([
  'clique aqui', 'saiba mais', 'veja mais', 'leia mais', 'conheca mais'
]);
const LINK_CONTEXT_STATES = new Set(['potential-context', 'missing-context', 'unknown-context']);
const NEW_WINDOW_BEHAVIORS = new Set(['new-window', 'same-window', 'unknown']);
const UNAVAILABLE_TEXT = new Set(['[unavailable]', '[error]', '[circular]']);

function genericLinkName(value) {
  return GENERIC_LINK_NAMES.has(normalizedLabelText(value));
}

function hasNewWindowWarning(value) {
  const name = normalizedLabelText(value);
  if (!name || UNAVAILABLE_TEXT.has(name)) return false;
  return ['nova aba', 'nova guia', 'nova janela', 'abre em nova aba', 'abre em nova guia',
    'abre em nova janela', 'abrira em nova aba', 'abrira em nova guia', 'abrira em nova janela']
    .some(phrase => name.includes(phrase));
}

function newWindowWarning(snapshot) {
  return interactiveResult(snapshot, ({ nodes }) => {
    const links = nodes.filter(isLink);
    const candidates = [];
    let unknownBehavior = false;
    for (const node of links) {
      const targetValue = normalizedComparableText(attribute(node, 'target'));
      const observedBehavior = normalizeText(node?.newWindowBehavior);
      if (targetValue === '_blank') candidates.push({ node, behavior: 'target-blank' });
      else if (observedBehavior === 'new-window') candidates.push({ node, behavior: 'observed-new-window' });
      else if (observedBehavior === 'unknown') unknownBehavior = true;
      else if (observedBehavior && !NEW_WINDOW_BEHAVIORS.has(observedBehavior)) unknownBehavior = true;
    }
    if (candidates.length === 0) {
      return unknownBehavior
        ? result('cantTell', 'O comportamento programático de abertura não foi observado conclusivamente.', [], [
          'Somente uma sondagem explícita e não atuante pode confirmar abertura programática em nova janela ou guia.'
        ])
        : result('inapplicable', 'Não há links observados que abram em nova janela ou guia.');
    }

    const failures = [];
    const incomplete = [];
    for (const candidate of candidates) {
      const { node, behavior } = candidate;
      const nameKnown = hasOwn(node, 'accessibleName') && typeof node.accessibleName === 'string' &&
        !UNAVAILABLE_TEXT.has(normalizeText(node.accessibleName));
      const adjacentKnown = hasOwn(node, 'adjacentNewWindowWarning') &&
        typeof node.adjacentNewWindowWarning === 'boolean';
      if ((nameKnown && hasNewWindowWarning(node.accessibleName)) || node.adjacentNewWindowWarning === true) continue;
      if (!nameKnown || !adjacentKnown) {
        incomplete.push(target(node, 'Complete a observação do aviso acessível de nova janela ou guia.', {
          reason: 'new-window-warning-observation-incomplete', behavior,
        }));
      } else {
        failures.push(target(node, 'Avise acessivelmente que este link abre em nova janela ou guia.', {
          reason: 'missing-new-window-warning', behavior,
        }));
      }
    }
    if (failures.length > 0) return result('failed', 'Há link que abre em nova janela ou guia sem aviso acessível observado.', failures);
    if (incomplete.length > 0 || unknownBehavior) return result(
      'cantTell',
      'A observação do aviso de nova janela ou guia está incompleta.',
      incomplete,
      ['Colete o nome acessível e a observação booleana de aviso adjacente sem persistir o texto da página.']
    );
    return result('passed', 'Todos os links observados que abrem em nova janela ou guia possuem aviso acessível.');
  });
}

function accessibleComponentName(snapshot) {
  return interactiveResult(snapshot, ({ nodes }) => {
    const components = nodes.filter(isObservedComponent);
    if (components.length === 0) return result('inapplicable', 'Não há componentes aplicáveis.');
    const ids = domIdIndex(nodes);
    const failures = [];
    let incomplete = false;
    for (const node of components) {
      const invalid = invalidReferences(node, ['aria-labelledby'], ids);
      if (invalid) {
        failures.push(target(node, 'Corrija a referência usada para nomear este componente.', {
          ...invalid,
          attribute: 'aria-labelledby'
        }));
      } else if (!hasOwn(node, 'accessibleName')) {
        incomplete = true;
      } else if (!normalizeText(node.accessibleName)) {
        failures.push(target(node, 'Forneça um nome acessível para este componente.', {
          reason: 'missing-accessible-name'
        }));
      }
    }
    if (failures.length > 0) return result('failed', 'Há componentes sem nome acessível válido.', failures);
    if (incomplete) return result('cantTell', 'O nome acessível de um componente não foi coletado.', [], [
      'Colete o nome acessível calculado de todos os componentes.'
    ]);
    return result('passed', 'Todos os componentes aplicáveis possuem nome acessível.');
  });
}

function visibleLabelInName(snapshot) {
  return interactiveResult(snapshot, ({ nodes }) => {
    const candidates = nodes.filter(node => isObservedComponent(node) && normalizeText(node?.visibleText));
    if (candidates.length === 0) {
      return result('inapplicable', 'Não há componentes com rótulo visível aplicável.');
    }
    const failures = [];
    let incomplete = false;
    for (const node of candidates) {
      if (!hasOwn(node, 'accessibleName')) {
        incomplete = true;
        continue;
      }
      const visible = normalizedLabelText(node.visibleText);
      const accessible = normalizedLabelText(node.accessibleName);
      if (!visible) {
        incomplete = true;
      } else if (!accessible.includes(visible)) {
        failures.push(target(node, 'Inclua o rótulo visível no nome acessível do componente.', {
          reason: 'visible-label-not-in-name'
        }));
      }
    }
    if (failures.length > 0) {
      return result('failed', 'Há rótulos visíveis ausentes do nome acessível.', failures);
    }
    if (incomplete) return result('cantTell', 'O nome acessível de um alvo não foi coletado.', [], [
      'Colete o nome acessível calculado para comparar com o rótulo visível.'
    ]);
    return result('passed', 'Os rótulos visíveis estão contidos nos nomes acessíveis.');
  });
}

function nativeElements(snapshot) {
  return interactiveResult(snapshot, ({ nodes }) => {
    const components = nodes.filter(isObservedComponent);
    if (components.length === 0) return result('inapplicable', 'Não há componentes aplicáveis.');
    const custom = components.filter(node => !isNativeControl(node));
    if (custom.length === 0) return result('passed', 'Todos os componentes observados usam elementos nativos.');
    return result(
      'cantTell',
      'Há componentes customizados; confirme se um elemento nativo atenderia à finalidade.',
      custom.map(node => target(node, 'Revise a necessidade deste componente customizado.', {
        reason: 'custom-component-candidate'
      })),
      ['A equivalência funcional com um elemento nativo exige revisão humana.']
    );
  });
}

const ARIA_IDREF_ATTRIBUTES = Object.freeze([
  'aria-activedescendant', 'aria-controls', 'aria-describedby', 'aria-details',
  'aria-errormessage', 'aria-flowto', 'aria-labelledby', 'aria-owns'
]);

const ABSTRACT_ARIA_ROLES = new Set([
  'command', 'composite', 'input', 'landmark', 'range', 'roletype', 'section',
  'sectionhead', 'select', 'structure', 'widget', 'window'
]);
const PRESENTATIONAL_ARIA_ROLES = new Set(['none', 'presentation']);
const CONCRETE_ARIA_ROLES = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button',
  'caption', 'cell', 'checkbox', 'code', 'columnheader', 'combobox', 'comment',
  'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'directory',
  'document', 'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell',
  'group', 'heading', 'img', 'insertion', 'link', 'list', 'listbox', 'listitem',
  'log', 'main', 'marquee', 'math', 'menu', 'menubar', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation', 'note', 'option',
  'paragraph', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup',
  'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider',
  'spinbutton', 'status', 'strong', 'subscript', 'suggestion', 'superscript',
  'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox', 'timer',
  'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem'
]);
const WIDGET_ARIA_ROLES = new Set([
  'button', 'cell', 'checkbox', 'columnheader', 'combobox', 'grid', 'gridcell',
  'link', 'listbox', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'progressbar', 'radio', 'radiogroup', 'row',
  'rowheader', 'scrollbar', 'searchbox', 'separator', 'slider', 'spinbutton',
  'switch', 'tab', 'tablist', 'textbox', 'toolbar', 'tree', 'treegrid', 'treeitem'
]);

function compatibilityOf(node, role) {
  if (ABSTRACT_ARIA_ROLES.has(role)) return 'abstract-role';
  const interaction = normalizeText(node?.interaction).toLowerCase();
  const axRole = normalizeText(node?.axRole).toLowerCase();
  const explicitlyInteractive = node?.interactive === true || interaction !== '';
  if (PRESENTATIONAL_ARIA_ROLES.has(role)) {
    return explicitlyInteractive ? 'presentational-interactive-role' : null;
  }
  if (!CONCRETE_ARIA_ROLES.has(role)) return 'unknown-role';
  if (interaction === 'link' && role !== 'link') return 'role-interaction-mismatch';
  if (interaction === 'button' && role !== 'button') return 'role-interaction-mismatch';
  if (axRole && axRole !== role) return 'role-ax-mismatch';
  if (node?.interactive === false) {
    return WIDGET_ARIA_ROLES.has(role) ? 'role-interactivity-mismatch' : 'compatible';
  }

  const compatibilityKnown = node?.interactive === true || interaction !== '' || axRole !== '';
  if (!compatibilityKnown) return null;
  if (!WIDGET_ARIA_ROLES.has(role)) return 'non-widget-interactive-role';
  return 'compatible';
}

function customComponentSemantics(snapshot) {
  return interactiveResult(snapshot, ({ nodes }) => {
    const components = nodes.filter(node => !isNativeControl(node) && (
      isObservedComponent(node) || node?.customElement === true || node?.interactive === true
    ));
    if (components.length === 0) return result('inapplicable', 'Não há componentes customizados observáveis.');
    const ids = domIdIndex(nodes);
    const failures = [];
    let incomplete = false;
    for (const node of components) {
      const role = roleOf(node) || controlRole(node);
      if (!role) {
        failures.push(target(node, 'Informe uma função semântica para este componente customizado.', {
          reason: 'missing-custom-role'
        }));
        continue;
      }
      const compatibility = compatibilityOf(node, role);
      if (compatibility !== 'compatible' && compatibility !== null) {
        failures.push(target(node, 'Use uma função ARIA concreta e compatível com a interação.', {
          reason: compatibility
        }));
        continue;
      }
      const invalid = invalidReferences(node, ARIA_IDREF_ATTRIBUTES, ids);
      if (invalid) {
        failures.push(target(node, 'Corrija a referência ARIA deste componente customizado.', invalid));
      } else if (compatibility === null) {
        incomplete = true;
      }
    }
    return failures.length > 0
      ? result('failed', 'Há componentes customizados com semântica incompleta ou inválida.', failures)
      : incomplete
        ? result('cantTell', 'A compatibilidade entre função e interação não pôde ser determinada.', [], [
          'Colete o estado interativo ou a função calculada na árvore de acessibilidade.'
        ])
        : result('passed', 'Os componentes customizados observados possuem função e referências válidas.');
  });
}

export const INTERACTIVE_RULES = createRuleRegistry([
  { id: 'link-semantics', mode: 'automated', nbrItems: ['5.7.1'], wcag: ['1.3.1'], evaluate: snapshot => semantics(snapshot, 'link') },
  { id: 'link-purpose-as-link', mode: 'assisted', nbrItems: ['5.7.2'], wcag: ['1.3.1'], evaluate: snapshot => assistedPurpose(snapshot, 'link') },
  { id: 'link-purpose-without-context', mode: 'assisted', nbrItems: ['5.7.3'], wcag: ['2.4.4', '2.4.9'], evaluate: snapshot => assistedPurpose(snapshot, 'link') },
  { id: 'link-purpose-in-context', mode: 'assisted', nbrItems: ['5.7.4'], wcag: ['2.4.4'], evaluate: snapshot => assistedPurpose(snapshot, 'link') },
  { id: 'new-window-link-warning', mode: 'assisted', nbrItems: ['5.7.6'], wcag: ['2.4.4', '2.4.9', '3.2.5'], evaluate: newWindowWarning },
  { id: 'button-semantics', mode: 'automated', nbrItems: ['5.8.1'], wcag: ['1.3.1'], evaluate: snapshot => semantics(snapshot, 'button') },
  { id: 'button-purpose-as-button', mode: 'assisted', nbrItems: ['5.8.2'], wcag: ['1.3.1'], evaluate: snapshot => assistedPurpose(snapshot, 'button') },
  { id: 'button-purpose', mode: 'assisted', nbrItems: ['5.8.3'], wcag: ['4.1.2', '2.4.6'], evaluate: snapshot => assistedPurpose(snapshot, 'button') },
  { id: 'visible-label-in-name', mode: 'automated', nbrItems: ['5.13.7'], wcag: ['2.5.3'], evaluate: visibleLabelInName },
  { id: 'accessible-component-name', mode: 'automated', nbrItems: ['5.13.10'], wcag: ['4.1.2'], evaluate: accessibleComponentName },
  { id: 'native-elements', mode: 'assisted', nbrItems: ['5.13.11'], wcag: ['1.3.1'], evaluate: nativeElements },
  { id: 'custom-component-semantics', mode: 'automated', nbrItems: ['5.13.12'], wcag: ['1.3.1', '4.1.2'], evaluate: customComponentSemantics }
]);
