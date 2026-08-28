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
  if (!status || typeof options?.onConfirm !== 'function' ||
    typeof options?.successMessage !== 'string' || typeof options?.failureMessage !== 'string') {
    throw new TypeError('Configuração do diálogo destrutivo inválida.');
  }

  let invoker = null;
  let pending = false;

  const returnFocus = () => {
    const target = invoker;
    invoker = null;
    try { target?.focus?.(); } catch {}
  };

  const close = ({ cancelled = false } = {}) => {
    if (pending) return false;
    if (cancelled) status.textContent = 'Exclusão cancelada.';
    if (typeof dialog.close === 'function') dialog.close();
    else {
      dialog.removeAttribute('open');
      dialog.setAttribute('aria-hidden', 'true');
      returnFocus();
    }
    return true;
  };

  cancelButton.addEventListener('click', () => close({ cancelled: true }));
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    close({ cancelled: true });
  });
  dialog.addEventListener('close', returnFocus);
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
    if (pending) return;
    pending = true;
    cancelButton.disabled = true;
    confirmButton.disabled = true;
    try {
      const result = await options.onConfirm();
      if (!result || result.ok !== true) {
        status.textContent = typeof result?.error === 'string' ? result.error : options.failureMessage;
        return;
      }
      status.textContent = options.successMessage;
      pending = false;
      cancelButton.disabled = false;
      confirmButton.disabled = false;
      close();
      return;
    } catch {
      status.textContent = options.failureMessage;
    } finally {
      if (pending) {
        pending = false;
        cancelButton.disabled = false;
        confirmButton.disabled = false;
      }
    }
  });

  return Object.freeze({
    open(trigger) {
      if (pending || dialog.hasAttribute('open')) return false;
      invoker = trigger ?? null;
      dialog.removeAttribute('aria-hidden');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      queueMicrotask(() => cancelButton.focus());
      return true;
    },
    close,
    get pending() { return pending; },
  });
}
