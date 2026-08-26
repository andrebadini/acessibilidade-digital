import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAnnouncementPreview } from '../../src/core/accessibility/announcement.js';

test('labels the Portuguese output explicitly as a preview', () => {
  assert.deepEqual(buildAnnouncementPreview({
    name: 'Enviar', role: 'button', disabled: true
  }), {
    text: 'Enviar, botão, indisponível',
    kind: 'preview',
    locale: 'pt-BR'
  });
});

test('formats mapped roles, values and observed states in a stable order', () => {
  assert.deepEqual(buildAnnouncementPreview({
    name: 'Aceito os termos',
    role: 'checkbox',
    description: 'Leia antes de continuar',
    value: 'sim',
    checked: 'mixed',
    selected: true,
    expanded: false,
    disabled: true,
    required: true,
    invalid: true,
    level: 2
  }), {
    text: 'Aceito os termos, caixa de seleção, Leia antes de continuar, valor sim, nível 2, parcialmente marcado, selecionado, recolhido, indisponível, obrigatório, inválido',
    kind: 'preview',
    locale: 'pt-BR'
  });
});

test('supports every minimum role and avoids unknown claims or duplicate punctuation', () => {
  const expectedRoles = {
    button: 'botão', link: 'link', checkbox: 'caixa de seleção', radio: 'botão de opção',
    textbox: 'campo de texto', combobox: 'caixa de combinação', heading: 'cabeçalho',
    img: 'imagem', region: 'região', table: 'tabela', list: 'lista', listitem: 'item da lista'
  };

  for (const [role, label] of Object.entries(expectedRoles)) {
    assert.equal(buildAnnouncementPreview({ name: 'Item', role }).text, `Item, ${label}`);
  }

  assert.deepEqual(buildAnnouncementPreview({
    name: '  Rótulo, ', description: 'Rótulo', role: 'made-up', checked: 'perhaps', expanded: 'later'
  }), {
    text: 'Rótulo', kind: 'preview', locale: 'pt-BR'
  });
});

test('formats every checked state deterministically in Portuguese', () => {
  const expected = new Map([
    [true, 'Aceito, caixa de seleção, marcado'],
    [false, 'Aceito, caixa de seleção, desmarcado'],
    ['mixed', 'Aceito, caixa de seleção, parcialmente marcado']
  ]);

  for (const [checked, text] of expected) {
    assert.equal(buildAnnouncementPreview({ name: 'Aceito', role: 'checkbox', checked }).text, text);
  }
});

test('accepts null and non-object properties without inherited role assertions', () => {
  for (const properties of [null, undefined, 1, 'texto', true, Symbol('estado')]) {
    assert.deepEqual(buildAnnouncementPreview(properties), {
      text: '', kind: 'preview', locale: 'pt-BR'
    });
  }

  for (const role of ['toString', 'constructor', '__proto__']) {
    assert.deepEqual(buildAnnouncementPreview({ name: 'Ação', role }), {
      text: 'Ação', kind: 'preview', locale: 'pt-BR'
    });
  }
});
