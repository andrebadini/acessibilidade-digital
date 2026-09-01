import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { computeAccessibleText } from '../../src/core/accessibility/accessible-name.js';
import { buildAnnouncementPreview } from '../../src/core/accessibility/announcement.js';

const runtimeUrl = new URL('../../src/core/accessibility/accessible-preview-runtime.classic.js', import.meta.url);
const namespaceExpression = 'globalThis[Symbol.for("audita.accessible-preview.runtime.v1")]';

async function loadClassicRuntime() {
  let source = '';
  try {
    source = await readFile(runtimeUrl, 'utf8');
  } catch {
    // The first RED is an assertion failure for the missing shipped runtime.
  }
  assert.notEqual(source, '', 'o runtime clássico compartilhado precisa existir no pacote');
  const context = vm.createContext({});
  new vm.Script(source, { filename: 'accessible-preview-runtime.classic.js' }).runInContext(context);
  const namespace = vm.runInContext(namespaceExpression, context);
  return { context, namespace, source };
}

test('classic preview runtime is frozen, idempotent and rejects a conflicting namespace', async () => {
  const { context, namespace, source } = await loadClassicRuntime();
  assert.equal(Object.isFrozen(namespace), true);
  assert.equal(namespace.version, 1);
  assert.equal(typeof namespace.createRuntime, 'function');

  new vm.Script(source).runInContext(context);
  assert.strictEqual(vm.runInContext(namespaceExpression, context), namespace);

  const hostile = vm.createContext({});
  vm.runInContext(`${namespaceExpression} = Object.freeze({ version: 999 })`, hostile);
  assert.throws(
    () => new vm.Script(source).runInContext(hostile),
    /runtime|namespace|versão|conflito/iu,
  );
});

test('classic and ESM facades produce byte-identical accessible previews', async () => {
  const { context } = await loadClassicRuntime();
  const classic = vm.runInContext(`${namespaceExpression}.createRuntime()`, context);
  const label = {
    nodeId: 'label', tagName: 'span', attributes: { id: 'label' }, hidden: true,
    text: 'Enviar formulário', children: [],
  };
  const description = {
    nodeId: 'description', tagName: 'p', attributes: { id: 'description' },
    text: 'A operação é permanente.', children: [],
  };
  const button = {
    nodeId: 'button', tagName: 'button',
    attributes: { 'aria-labelledby': 'label', 'aria-describedby': 'description' },
    text: 'Texto visual', children: [],
  };
  const indexes = { label, description, button };
  const properties = {
    ...computeAccessibleText(button, indexes),
    role: 'button', disabled: false, valueDisclosure: 'safe', value: '',
  };

  assert.equal(
    JSON.stringify(classic.computeAccessibleText(button, indexes)),
    JSON.stringify(computeAccessibleText(button, indexes)),
  );
  assert.equal(
    JSON.stringify(classic.buildAnnouncementPreview(properties)),
    JSON.stringify(buildAnnouncementPreview(properties)),
  );
  assert.equal(
    JSON.stringify(classic.buildAnnouncementPreview({ name: '', role: 'image' })),
    JSON.stringify(buildAnnouncementPreview({ name: '', role: 'image' })),
  );
});

test('normative ESM exports remain byte-identical to the 78ba813 baseline', async () => {
  const loadBaseline = async path => {
    const source = execFileSync('git', ['show', `78ba813:${path}`], { encoding: 'utf8' });
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  };
  const baselineAnnouncement = await loadBaseline('src/core/accessibility/announcement.js');
  const baselineName = await loadBaseline('src/core/accessibility/accessible-name.js');
  const announcements = [
    { name: 'Volume', role: 'slider' },
    { name: 'Enviar', role: 'button', disabled: true },
    { name: 'Senha', role: 'textbox', valueDisclosure: 'safe', value: 'segredo', inputType: 'password' },
    { name: 'Plano', role: 'checkbox', checked: 'mixed', description: 'Escolha um plano.' },
  ];
  for (const properties of announcements) {
    assert.equal(
      JSON.stringify(buildAnnouncementPreview(properties)),
      JSON.stringify(baselineAnnouncement.buildAnnouncementPreview(properties)),
    );
  }
  const label = { id: 'label', tagName: 'label', attributes: { id: 'label' }, text: 'Nome completo', children: [] };
  const input = { id: 'field', tagName: 'input', attributes: { id: 'field' }, labels: ['Nome textual'], text: '', children: [] };
  const button = { id: 'button', tagName: 'button', attributes: { 'aria-labelledby': 'label' }, text: 'Enviar', children: [] };
  const indexes = { label, input, button };
  for (const [node, index, ax] of [
    [input, indexes, null],
    [button, indexes, null],
    [button, indexes, { name: { value: 'Nome AX' }, description: { value: 'Descrição AX' } }],
  ]) {
    assert.equal(
      JSON.stringify(computeAccessibleText(node, index, ax)),
      JSON.stringify(baselineName.computeAccessibleText(node, index, ax)),
    );
  }
});

test('persona-only vocabulary is isolated from the normative announcement facade', async () => {
  const { context } = await loadClassicRuntime();
  const classic = vm.runInContext(`${namespaceExpression}.createRuntime()`, context);
  assert.equal(buildAnnouncementPreview({ name: 'Volume', role: 'slider' }).text, 'Volume');
  assert.equal(classic.buildAnnouncementPreview({ name: 'Volume', role: 'slider' }).text, 'Volume, controle deslizante');
});

test('private referenced roots are rejected before their text can enter either facade', async () => {
  const { context } = await loadClassicRuntime();
  const classic = vm.runInContext(`${namespaceExpression}.createRuntime()`, context);
  const secret = 'SEGREDO-PERSONA-8472';
  const privateLabel = {
    nodeId: 'private-label', tagName: 'span', attributes: { id: 'private-label' },
    private: true, text: secret, children: [],
  };
  const button = {
    nodeId: 'button', tagName: 'button', attributes: { 'aria-labelledby': 'private-label' },
    text: 'Continuar', children: [],
  };
  const indexes = {
    byNodeId: new Map([['private-label', privateLabel], ['button', button]]),
    byDomId: new Map([['private-label', [privateLabel]]]),
  };

  const result = classic.computeAccessibleText(button, indexes);
  assert.equal(result.name, 'Continuar');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, 'u'));
});
