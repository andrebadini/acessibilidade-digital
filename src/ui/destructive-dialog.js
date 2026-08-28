function requiredControl(value, label) {
  if (!value || typeof value.addEventListener !== 'function') {
    throw new TypeError(`${label} do diálogo destrutivo inválido.`);
  }
  return value;
}

export function createDestructiveDialog(options) {
  const dialog = requiredControl(options?.dialog, 'Contêiner');
  const cancelButton = requiredControl(options?.cancelButton, 'Botão Cancelar');
  const confirmButton = requiredControl(options?.confirmButton, 'Botão de confirmação');
  const status = options?.status;
  const dialogStatus = options?.dialogStatus;
  const stableFocus = options?.stableFocus ?? null;
  if (!status || !dialogStatus || typeof options?.onConfirm !== 'function' ||
    typeof options?.successMessage !== 'string' || typeof options?.failureMessage !== 'string' ||
    (stableFocus !== null && typeof stableFocus.focus !== 'function')) {
    throw new TypeError('Configuração do diálogo destrutivo inválida.');
  }

  let invoker = null;
  let pending = false;
  let successCompleted = false;
  let epoch = 0;
  let focusOverride = null;
  let fallbackBackground = [];
  let fallbackDocument = null;

  const markClosed = () => {
    dialog.setAttribute('aria-hidden', 'true');
    dialog.inert = true;
  };

  if (!dialog.hasAttribute('open')) markClosed();

  const canReceiveFocus = target => Boolean(target && typeof target.focus === 'function' &&
    target.disabled !== true && target.inert !== true && target.isConnected !== false);

  const returnFocus = () => {
    const target = canReceiveFocus(focusOverride)
      ? focusOverride
      : canReceiveFocus(invoker) ? invoker : canReceiveFocus(stableFocus) ? stableFocus : null;
    focusOverride = null;
    invoker = null;
    try { target?.focus?.(); } catch {}
  };

  const containFallbackEvent = event => {
    if (!dialog.hasAttribute('open') || dialog.contains?.(event.target)) return;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    event.stopPropagation?.();
    queueMicrotask(() => {
      if (dialog.hasAttribute('open')) {
        try { cancelButton.focus(); } catch {}
      }
    });
  };

  const restoreFallbackBackground = () => {
    for (const record of fallbackBackground.splice(0)) record.element.inert = record.wasInert;
    if (fallbackDocument) {
      for (const type of ['pointerdown', 'click', 'focusin']) {
        fallbackDocument.removeEventListener?.(type, containFallbackEvent, true);
      }
      fallbackDocument = null;
    }
  };

  const containFallbackBackground = () => {
    const seen = new Set();
    let current = dialog;
    while (current?.parentElement) {
      const parent = current.parentElement;
      for (const sibling of Array.from(parent.children ?? [])) {
        if (sibling === current || seen.has(sibling)) continue;
        seen.add(sibling);
        fallbackBackground.push({ element: sibling, wasInert: sibling.inert === true });
        sibling.inert = true;
      }
      current = parent;
    }
    fallbackDocument = dialog.ownerDocument ?? globalThis.document ?? null;
    for (const type of ['pointerdown', 'click', 'focusin']) {
      fallbackDocument?.addEventListener?.(type, containFallbackEvent, true);
    }
  };

  const finishClose = () => {
    markClosed();
    restoreFallbackBackground();
    returnFocus();
  };

  const closeDialog = ({ cancelled = false, stable = false } = {}) => {
    if (pending) return false;
    if (stable) focusOverride = stableFocus;
    if (typeof dialog.close === 'function') {
      try { dialog.close(); } catch {
        dialog.removeAttribute('open');
        finishClose();
      }
    } else {
      dialog.removeAttribute('open');
      finishClose();
    }
    if (cancelled) status.textContent = 'Exclusão cancelada.';
    return true;
  };

  const completeSuccess = (message = options.successMessage) => {
    if (successCompleted) return false;
    successCompleted = true;
    const interacted = pending || invoker !== null || dialog.hasAttribute('open');
    pending = false;
    cancelButton.disabled = false;
    confirmButton.disabled = false;
    dialogStatus.textContent = '';
    status.textContent = typeof message === 'string' && message ? message : options.successMessage;
    if (dialog.hasAttribute('open')) closeDialog({ stable: interacted });
    else if (interacted) {
      focusOverride = stableFocus;
      returnFocus();
    }
    return true;
  };

  const close = optionsValue => closeDialog(optionsValue);

  cancelButton.addEventListener('click', () => close({ cancelled: true }));
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    close({ cancelled: true });
  });
  dialog.addEventListener('close', () => {
    finishClose();
  });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close({ cancelled: true });
      return;
    }
    if (event.key !== 'Tab' || typeof dialog.showModal === 'function') return;
    const active = globalThis.document?.activeElement;
    if (!event.shiftKey && active === confirmButton) {
      event.preventDefault();
      cancelButton.focus();
    } else if (event.shiftKey && active === cancelButton) {
      event.preventDefault();
      confirmButton.focus();
    }
  });
  confirmButton.addEventListener('click', async () => {
    if (pending || successCompleted) return;
    const confirmationEpoch = epoch;
    pending = true;
    cancelButton.disabled = true;
    confirmButton.disabled = true;
    try {
      const result = await options.onConfirm();
      if (confirmationEpoch !== epoch || successCompleted) return;
      if (!result || result.ok !== true) {
        dialogStatus.textContent = typeof result?.error === 'string' ? result.error : options.failureMessage;
        return;
      }
      completeSuccess();
      return;
    } catch {
      if (confirmationEpoch === epoch && !successCompleted) dialogStatus.textContent = options.failureMessage;
    } finally {
      if (confirmationEpoch === epoch && pending) {
        pending = false;
        cancelButton.disabled = false;
        confirmButton.disabled = false;
      }
    }
  });

  return Object.freeze({
    open(trigger) {
      if (pending || dialog.hasAttribute('open')) return false;
      epoch += 1;
      successCompleted = false;
      invoker = trigger ?? null;
      focusOverride = null;
      dialogStatus.textContent = '';
      dialog.removeAttribute('aria-hidden');
      dialog.inert = false;
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else {
        dialog.setAttribute('open', '');
        containFallbackBackground();
      }
      queueMicrotask(() => cancelButton.focus());
      return true;
    },
    close,
    completeSuccess,
    get pending() { return pending; },
  });
}
