import assert from 'node:assert/strict';
import test from 'node:test';

import { createDestructiveDialog } from '../../src/ui/destructive-dialog.js';

function element() {
  const target = new EventTarget();
  const attributes = new Map();
  return Object.assign(target, {
    disabled: false,
    focusCalls: 0,
    focus() { this.focusCalls += 1; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    hasAttribute(name) { return attributes.has(name); },
  });
}

function click(target) {
  target.dispatchEvent(new Event('click', { cancelable: true }));
}

test('dialog focuses Cancel, Escape cancels, and focus returns to its invoker', async () => {
  const dialog = element();
  dialog.showModal = function showModal() { this.setAttribute('open', ''); };
  dialog.close = function close() { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
  const cancelButton = element();
  const confirmButton = element();
  const status = { textContent: '' };
  const dialogStatus = { textContent: '' };
  const invoker = element();
  const controller = createDestructiveDialog({
    dialog, cancelButton, confirmButton, status, dialogStatus,
    async onConfirm() { throw new Error('must not run'); },
    successMessage: 'Excluído.', failureMessage: 'Falhou.',
  });

  controller.open(invoker);
  await Promise.resolve();
  assert.equal(dialog.hasAttribute('open'), true);
  assert.equal(cancelButton.focusCalls, 1);
  const cancelEvent = new Event('cancel', { cancelable: true });
  dialog.dispatchEvent(cancelEvent);
  assert.equal(cancelEvent.defaultPrevented, true);
  assert.equal(dialog.hasAttribute('open'), false);
  assert.equal(invoker.focusCalls, 1);
  assert.equal(status.textContent, 'Exclusão cancelada.');
  assert.equal(dialog.getAttribute('aria-hidden'), 'true');
  assert.equal(dialog.inert, true);
});

test('confirmation is single-flight and disables both actions until completion', async () => {
  const dialog = element();
  dialog.showModal = function showModal() { this.setAttribute('open', ''); };
  dialog.close = function close() { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
  const cancelButton = element();
  const confirmButton = element();
  const status = { textContent: '' };
  const dialogStatus = { textContent: '' };
  const invoker = element();
  let resolve;
  let calls = 0;
  const controller = createDestructiveDialog({
    dialog, cancelButton, confirmButton, status, dialogStatus,
    onConfirm() { calls += 1; return new Promise(done => { resolve = done; }); },
    successMessage: 'Auditoria local excluída; downloads preservados.',
    failureMessage: 'Não foi possível excluir.',
  });

  controller.open(invoker);
  click(confirmButton);
  click(confirmButton);
  assert.equal(calls, 1);
  assert.equal(cancelButton.disabled, true);
  assert.equal(confirmButton.disabled, true);
  resolve({ ok: true });
  await new Promise(done => setImmediate(done));
  assert.equal(dialog.hasAttribute('open'), false);
  assert.equal(cancelButton.disabled, false);
  assert.equal(confirmButton.disabled, false);
  assert.equal(status.textContent, 'Auditoria local excluída; downloads preservados.');
  assert.equal(dialogStatus.textContent, '');
  assert.equal(invoker.focusCalls, 1);
});

test('external success closes a pending dialog once and focuses a stable destination', async () => {
  const dialog = element();
  dialog.showModal = function showModal() { this.setAttribute('open', ''); };
  dialog.close = function close() { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
  const cancelButton = element();
  const confirmButton = element();
  let announcements = 0;
  let announcedText = '';
  const status = {
    focusCalls: 0,
    focus() {
      assert.equal(announcedText, 'Auditoria local excluída.');
      this.focusCalls += 1;
    },
    get textContent() { return announcedText; },
    set textContent(value) { announcements += 1; announcedText = value; },
  };
  const dialogStatus = { textContent: '' };
  const invoker = element();
  let resolve;
  const controller = createDestructiveDialog({
    dialog, cancelButton, confirmButton, status, dialogStatus, stableFocus: status,
    onConfirm() { return new Promise(done => { resolve = done; }); },
    successMessage: 'Auditoria local excluída.', failureMessage: 'Não foi possível excluir.',
  });

  controller.open(invoker);
  click(confirmButton);
  invoker.disabled = true;
  assert.equal(controller.completeSuccess(), true);
  assert.equal(dialog.hasAttribute('open'), false);
  assert.equal(controller.pending, false);
  assert.equal(cancelButton.disabled, false);
  assert.equal(confirmButton.disabled, false);
  assert.equal(status.textContent, 'Auditoria local excluída.');
  assert.equal(announcements, 1);
  assert.equal(status.focusCalls, 1);
  assert.equal(invoker.focusCalls, 0);

  resolve({ ok: true });
  await new Promise(done => setImmediate(done));
  assert.equal(announcements, 1);
  assert.equal(status.focusCalls, 1);
});

test('fallback dialog remains modal-labelled and keeps Tab within the two actions', async () => {
  const dialog = element();
  const cancelButton = element();
  const confirmButton = element();
  const status = { textContent: '' };
  const dialogStatus = { textContent: '' };
  const controller = createDestructiveDialog({
    dialog, cancelButton, confirmButton, status, dialogStatus,
    async onConfirm() { return { ok: false }; },
    successMessage: 'Excluído.', failureMessage: 'Não foi possível excluir.',
  });

  assert.equal(dialog.getAttribute('aria-hidden'), 'true');
  assert.equal(dialog.inert, true);
  controller.open(element());
  await Promise.resolve();
  assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  const previousDocument = globalThis.document;
  globalThis.document = { activeElement: confirmButton };
  const tabFromConfirm = new Event('keydown', { cancelable: true });
  Object.defineProperties(tabFromConfirm, {
    key: { value: 'Tab' },
    shiftKey: { value: false },
  });
  try {
    dialog.dispatchEvent(tabFromConfirm);
    assert.equal(tabFromConfirm.defaultPrevented, true);
    assert.equal(cancelButton.focusCalls, 2);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
  click(confirmButton);
  await new Promise(done => setImmediate(done));
  assert.equal(status.textContent, '');
  assert.equal(dialogStatus.textContent, 'Não foi possível excluir.');
  assert.equal(dialog.hasAttribute('open'), true);
  assert.equal(dialog.getAttribute('aria-hidden'), null);
  assert.equal(dialog.inert, false);
});

test('fallback dialog inerts its background and contains outside clicks until close', async () => {
  const ownerDocument = element();
  const body = element();
  const main = element();
  const outsideBody = element();
  const outsideMain = element();
  const dialog = element();
  const cancelButton = element();
  const confirmButton = element();
  ownerDocument.children = [body];
  body.children = [outsideBody, main];
  main.children = [outsideMain, dialog];
  outsideBody.parentElement = body;
  main.parentElement = body;
  outsideMain.parentElement = main;
  dialog.parentElement = main;
  dialog.ownerDocument = ownerDocument;
  dialog.contains = target => [dialog, cancelButton, confirmButton].includes(target);
  const controller = createDestructiveDialog({
    dialog, cancelButton, confirmButton,
    status: { textContent: '' }, dialogStatus: { textContent: '' },
    async onConfirm() { return { ok: false }; },
    successMessage: 'Excluído.', failureMessage: 'Não foi possível excluir.',
  });

  controller.open(element());
  await Promise.resolve();
  assert.equal(outsideMain.inert, true);
  assert.equal(outsideBody.inert, true);
  const outsideClick = new Event('click', { cancelable: true });
  ownerDocument.dispatchEvent(outsideClick);
  assert.equal(outsideClick.defaultPrevented, true);
  controller.close({ cancelled: true });
  assert.equal(outsideMain.inert, false);
  assert.equal(outsideBody.inert, false);
  const afterClose = new Event('click', { cancelable: true });
  ownerDocument.dispatchEvent(afterClose);
  assert.equal(afterClose.defaultPrevented, false);
});
