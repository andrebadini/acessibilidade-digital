import test from 'node:test';
import assert from 'node:assert/strict';

import { computeAccessibleText } from '../../src/core/accessibility/accessible-name.js';

function indexFor(...nodes) {
  return new Map(nodes.map(node => [node.attributes?.id ?? node.id, node]).filter(([id]) => id));
}

test('AX name and description win and record the accessibility tree source', () => {
  const node = {
    tagName: 'button',
    attributes: { 'aria-label': 'Rascunho' },
    text: 'Salvar'
  };

  assert.deepEqual(computeAccessibleText(node, indexFor(node), {
    name: 'Salvar',
    description: 'Grava o formulário'
  }), {
    name: 'Salvar',
    nameSource: 'accessibility-tree',
    description: 'Grava o formulário',
    descriptionSource: 'accessibility-tree'
  });
});

test('accepts CDP AXValue text without coercing unsupported AX data into a name', () => {
  const node = { tagName: 'button', attributes: { 'aria-label': 'Cancelar' } };

  assert.deepEqual(computeAccessibleText(node, indexFor(node), {
    name: { value: '  Confirmar  ' },
    description: { value: ' Fecha a janela ' }
  }), {
    name: 'Confirmar',
    nameSource: 'accessibility-tree',
    description: 'Fecha a janela',
    descriptionSource: 'accessibility-tree'
  });

  assert.equal(computeAccessibleText(node, indexFor(node), {
    name: { unexpected: 'inventado' }
  }).name, 'Cancelar');
});

test('falls back from aria-labelledby to aria-label and never reorders references', () => {
  const first = { tagName: 'span', attributes: { id: 'first' }, text: '  Nome ' };
  const second = { tagName: 'span', attributes: { id: 'second' }, text: 'referenciado  ' };
  const node = {
    tagName: 'button',
    attributes: {
      'aria-labelledby': 'first missing second',
      'aria-label': 'Nome alternativo'
    },
    text: 'Conteúdo'
  };

  const value = computeAccessibleText(node, indexFor(first, second, node), null);

  assert.equal(value.name, 'Nome referenciado');
  assert.equal(value.nameSource, 'aria-labelledby');
});

test('uses native labels, applicable alt, allowed contents, then title in deterministic order', () => {
  const label = { tagName: 'label', attributes: { id: 'email-label', for: 'email' }, text: ' E-mail de contato ' };
  const input = { tagName: 'input', attributes: { id: 'email', title: 'Campo principal' } };
  const image = { tagName: 'img', attributes: { alt: 'Brasão estadual', title: 'Logomarca' } };
  const button = { tagName: 'button', attributes: { title: 'Enviar o formulário' }, text: ' Enviar ' };
  const titled = { tagName: 'div', attributes: { title: 'Ajuda contextual' } };
  const index = indexFor(label, input, image, button, titled);

  assert.deepEqual(computeAccessibleText(input, index), {
    name: 'E-mail de contato', nameSource: 'label',
    description: 'Campo principal', descriptionSource: 'title'
  });
  assert.deepEqual(computeAccessibleText(image, index), {
    name: 'Brasão estadual', nameSource: 'alt',
    description: 'Logomarca', descriptionSource: 'title'
  });
  assert.equal(computeAccessibleText(button, index).name, 'Enviar');
  assert.equal(computeAccessibleText(button, index).nameSource, 'contents');
  assert.deepEqual(computeAccessibleText(titled, index), {
    name: 'Ajuda contextual', nameSource: 'title',
    description: '', descriptionSource: 'none'
  });
});

test('builds description from describedby before title and permits hidden referenced content', () => {
  const description = {
    tagName: 'p', attributes: { id: 'hint' }, hidden: true,
    text: ' Obrigatório para retorno '
  };
  const label = {
    tagName: 'span', attributes: { id: 'label' }, hidden: true,
    text: ' Telefone '
  };
  const node = {
    tagName: 'input',
    attributes: {
      'aria-labelledby': 'label',
      'aria-describedby': 'hint',
      title: 'Não deve substituir a descrição referenciada'
    }
  };

  assert.deepEqual(computeAccessibleText(node, indexFor(description, label, node)), {
    name: 'Telefone', nameSource: 'aria-labelledby',
    description: 'Obrigatório para retorno', descriptionSource: 'aria-describedby'
  });
});

test('excludes ordinary hidden contents, terminates reference cycles, and reports empty results explicitly', () => {
  const cycleA = { tagName: 'span', attributes: { id: 'a', 'aria-labelledby': 'b' }, text: 'A' };
  const cycleB = { tagName: 'span', attributes: { id: 'b', 'aria-labelledby': 'a' }, text: 'B' };
  const hidden = { tagName: 'span', hidden: true, text: 'Oculto' };
  const node = {
    tagName: 'button',
    attributes: { 'aria-labelledby': 'a missing' },
    text: 'Visível',
    children: [hidden]
  };

  assert.deepEqual(computeAccessibleText(node, indexFor(cycleA, cycleB, node)), {
    name: 'B', nameSource: 'aria-labelledby',
    description: '', descriptionSource: 'none'
  });
  assert.deepEqual(computeAccessibleText({ tagName: 'img', attributes: {} }, new Map()), {
    name: '', nameSource: 'none', description: '', descriptionSource: 'none'
  });
});

test('does not include a hidden descendant of a visible referenced root', () => {
  const label = {
    tagName: 'span', attributes: { id: 'visible-label' }, text: 'Visível',
    children: [{ tagName: 'span', hidden: true, text: 'SEGREDO' }]
  };
  const node = { tagName: 'button', attributes: { 'aria-labelledby': 'visible-label' } };

  assert.equal(computeAccessibleText(node, indexFor(label, node)).name, 'Visível');
});

test('allows the whole subtree of a directly referenced hidden root', () => {
  const label = {
    tagName: 'span', attributes: { id: 'hidden-label' }, hidden: true, text: 'Rótulo oculto',
    children: [{ tagName: 'span', hidden: true, text: 'Subtexto oculto' }]
  };
  const node = { tagName: 'button', attributes: { 'aria-labelledby': 'hidden-label' } };

  assert.equal(computeAccessibleText(node, indexFor(label, node)).name, 'Rótulo oculto Subtexto oculto');
});

test('uses only conservative name-from-content and native-label applicability', () => {
  const divLabel = { tagName: 'label', attributes: { id: 'div-label', for: 'target' }, text: 'Rótulo inválido' };
  const hiddenInputLabel = { tagName: 'label', attributes: { id: 'hidden-label', for: 'secret' }, text: 'Segredo' };
  const textInputLabel = { tagName: 'label', attributes: { id: 'text-label', for: 'email' }, text: 'E-mail' };
  const target = { tagName: 'div', attributes: { id: 'target' } };
  const hiddenInput = { tagName: 'input', attributes: { id: 'secret', type: 'hidden' } };
  const textInput = { tagName: 'input', attributes: { id: 'email', type: 'email' } };
  const textarea = { tagName: 'textarea', text: 'Nome falso' };
  const list = { tagName: 'ul', text: 'Nome falso' };
  const combo = { tagName: 'div', attributes: { role: 'combobox' }, text: 'Nome falso' };
  const button = { tagName: 'button', text: 'Nome permitido' };
  const imageInput = { tagName: 'input', attributes: { type: 'image', alt: 'Pesquisar' } };
  const textInputWithAlt = { tagName: 'input', attributes: { type: 'text', alt: 'Não aplicável' } };
  const index = indexFor(divLabel, hiddenInputLabel, textInputLabel, target, hiddenInput, textInput);

  assert.equal(computeAccessibleText(target, index).nameSource, 'none');
  assert.equal(computeAccessibleText(hiddenInput, index).nameSource, 'none');
  assert.equal(computeAccessibleText(textInput, index).name, 'E-mail');
  assert.equal(computeAccessibleText(textarea, index).nameSource, 'none');
  assert.equal(computeAccessibleText(list, index).nameSource, 'none');
  assert.equal(computeAccessibleText(combo, index).nameSource, 'none');
  assert.deepEqual(computeAccessibleText(button, index), {
    name: 'Nome permitido', nameSource: 'contents', description: '', descriptionSource: 'none'
  });
  assert.equal(computeAccessibleText(imageInput, index).name, 'Pesquisar');
  assert.equal(computeAccessibleText(imageInput, index).nameSource, 'alt');
  assert.equal(computeAccessibleText(textInputWithAlt, index).nameSource, 'none');
});

test('does not repeat title as a description when the AX name already equals it', () => {
  const node = {
    tagName: 'button',
    attributes: { 'aria-label': 'Rótulo DOM', title: 'Salvar' }
  };

  assert.deepEqual(computeAccessibleText(node, indexFor(node), { name: 'Salvar' }), {
    name: 'Salvar', nameSource: 'accessibility-tree',
    description: '', descriptionSource: 'none'
  });
});
