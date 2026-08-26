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
  result,
  roleOf,
  snapshotParts,
  tagOf,
  target
} from './snapshot.js';

function interactiveResult(snapshot, evaluate) {
  const parts = snapshotParts(snapshot);
  return parts ? evaluate(parts) : missingSnapshotResult();
}

function isLink(node) {
  return !isHidden(node) && (
    (tagOf(node) === 'a' && hasAttribute(node, 'href')) ||
    roleOf(node) === 'link' || node?.interaction === 'link'
  );
}

function isButton(node) {
  const tag = tagOf(node);
  const type = normalizeText(attribute(node, 'type') ?? 'submit').toLowerCase();
  return !isHidden(node) && (
    tag === 'button' ||
    (tag === 'input' && ['button', 'image', 'reset', 'submit'].includes(type)) ||
    roleOf(node) === 'button' || node?.interaction === 'button'
  );
}

function hasLinkSemantics(node) {
  const native = tagOf(node) === 'a' && hasAttribute(node, 'href');
  const role = roleOf(node);
  return native ? !role || role === 'link' : role === 'link';
}

function hasButtonSemantics(node) {
  const tag = tagOf(node);
  const type = normalizeText(attribute(node, 'type') ?? 'submit').toLowerCase();
  const native = tag === 'button' ||
    (tag === 'input' && ['button', 'image', 'reset', 'submit'].includes(type));
  const role = roleOf(node);
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
    return result(
      'cantTell',
      `Os ${kind === 'link' ? 'links' : 'botões'} possuem identificação; confirme se a finalidade está clara.`,
      [],
      ['A finalidade do componente e sua adequação ao contexto exigem revisão humana.']
    );
  });
}

function accessibleComponentName(snapshot) {
  return interactiveResult(snapshot, ({ nodes }) => {
    const components = nodes.filter(isComponent);
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
    const candidates = nodes.filter(node => isComponent(node) && normalizedComparableText(node?.visibleText));
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
      const visible = normalizedComparableText(node.visibleText);
      const accessible = normalizedComparableText(node.accessibleName);
      if (!accessible.includes(visible)) {
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
    const components = nodes.filter(isComponent);
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

function customComponentSemantics(snapshot) {
  return interactiveResult(snapshot, ({ nodes }) => {
    const components = nodes.filter(node => isComponent(node) && !isNativeControl(node));
    if (components.length === 0) return result('inapplicable', 'Não há componentes customizados observáveis.');
    const ids = domIdIndex(nodes);
    const failures = [];
    for (const node of components) {
      if (!roleOf(node)) {
        failures.push(target(node, 'Informe uma função semântica para este componente customizado.', {
          reason: 'missing-custom-role'
        }));
        continue;
      }
      const invalid = invalidReferences(node, ARIA_IDREF_ATTRIBUTES, ids);
      if (invalid) {
        failures.push(target(node, 'Corrija a referência ARIA deste componente customizado.', invalid));
      }
    }
    return failures.length > 0
      ? result('failed', 'Há componentes customizados com semântica incompleta ou inválida.', failures)
      : result('passed', 'Os componentes customizados observados possuem função e referências válidas.');
  });
}

export const INTERACTIVE_RULES = createRuleRegistry([
  { id: 'link-semantics', mode: 'automated', nbrItems: ['5.7.1'], wcag: ['1.3.1'], evaluate: snapshot => semantics(snapshot, 'link') },
  { id: 'link-purpose-as-link', mode: 'assisted', nbrItems: ['5.7.2'], wcag: ['1.3.1'], evaluate: snapshot => assistedPurpose(snapshot, 'link') },
  { id: 'link-purpose-without-context', mode: 'assisted', nbrItems: ['5.7.3'], wcag: ['2.4.4', '2.4.9'], evaluate: snapshot => assistedPurpose(snapshot, 'link') },
  { id: 'link-purpose-in-context', mode: 'assisted', nbrItems: ['5.7.4'], wcag: ['2.4.4'], evaluate: snapshot => assistedPurpose(snapshot, 'link') },
  { id: 'button-semantics', mode: 'automated', nbrItems: ['5.8.1'], wcag: ['1.3.1'], evaluate: snapshot => semantics(snapshot, 'button') },
  { id: 'button-purpose-as-button', mode: 'assisted', nbrItems: ['5.8.2'], wcag: ['1.3.1'], evaluate: snapshot => assistedPurpose(snapshot, 'button') },
  { id: 'button-purpose', mode: 'assisted', nbrItems: ['5.8.3'], wcag: ['4.1.2', '2.4.6'], evaluate: snapshot => assistedPurpose(snapshot, 'button') },
  { id: 'visible-label-in-name', mode: 'automated', nbrItems: ['5.13.7'], wcag: ['2.5.3'], evaluate: visibleLabelInName },
  { id: 'accessible-component-name', mode: 'automated', nbrItems: ['5.13.10'], wcag: ['4.1.2'], evaluate: accessibleComponentName },
  { id: 'native-elements', mode: 'assisted', nbrItems: ['5.13.11'], wcag: ['1.3.1'], evaluate: nativeElements },
  { id: 'custom-component-semantics', mode: 'automated', nbrItems: ['5.13.12'], wcag: ['1.3.1', '4.1.2'], evaluate: customComponentSemantics }
]);
