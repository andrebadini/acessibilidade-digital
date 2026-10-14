/**
 * Protocolo de tempo, cancelamento e exportação dos compositores locais de imagem.
 *
 * Os dois mapas derivados (mapa de anúncios e mapa do teclado) desenham em `OffscreenCanvas` dentro
 * do service worker e precisam das mesmas garantias: nada de travar a auditoria, cancelamento
 * obedecido de ponta a ponta e PNG conferido antes de virar artefato. Duas cópias deste protocolo
 * divergiriam na primeira correção de tempo limite — por isso ele mora aqui, com os códigos de erro
 * de cada mapa passados de fora.
 */
import { validatePngRasterData } from '../core/evidence/png.js';

const COMPOSITOR_UNAVAILABLE_MESSAGE = 'O compositor local OffscreenCanvas não está disponível neste worker.';

/**
 * @param {object} options
 * @param {(code: string, message: string) => Error} options.createError Erro do mapa que está compondo.
 * @param {string} options.unavailableCode Código para compositor ausente.
 * @param {string} options.timeoutCode Código para tempo limite excedido.
 * @param {string} options.outputInvalidCode Código para PNG derivado inválido.
 */
export function compositionSupport({ createError, unavailableCode, timeoutCode, outputInvalidCode }) {
  const throwIfAborted = signal => {
    if (!signal?.aborted) return;
    throw signal.reason?.name === 'AbortError' ? signal.reason : new DOMException('Operação cancelada.', 'AbortError');
  };

  const operationWaiter = (signal, timeoutMs) => {
    const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(Math.floor(timeoutMs), 60_000) : 15_000;
    const deadline = Date.now() + duration;
    return (operation, { onLateValue, onCancel } = {}) => new Promise((resolve, reject) => {
      if (signal?.aborted) {
        try { onCancel?.(signal.reason); } catch { /* Cancellation remains best-effort. */ }
        throwIfAborted(signal);
      }
      let settled = false;
      const remaining = deadline - Date.now();
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      };
      const finish = (handler, value) => {
        if (settled) {
          if (handler === resolve) onLateValue?.(value);
          return;
        }
        settled = true;
        cleanup();
        handler(value);
      };
      const cancel = reason => {
        if (settled) return;
        try { onCancel?.(reason); } catch { /* Cancellation remains best-effort. */ }
        finish(reject, reason);
      };
      const onAbort = () => cancel(signal?.reason?.name === 'AbortError'
        ? signal.reason
        : new DOMException('Operação cancelada.', 'AbortError'));
      const timer = setTimeout(() => cancel(createError(
        timeoutCode, 'O compositor local excedeu o tempo limite do mapa.',
      )), Math.max(0, remaining));
      signal?.addEventListener?.('abort', onAbort, { once: true });
      Promise.resolve(operation).then(value => finish(resolve, value), error => finish(reject, error));
    });
  };

  const featureRuntime = runtime => {
    const selected = runtime || globalThis;
    if (typeof selected.OffscreenCanvas !== 'function' || typeof selected.createImageBitmap !== 'function') {
      throw createError(unavailableCode, COMPOSITOR_UNAVAILABLE_MESSAGE);
    }
    if (typeof globalThis.DecompressionStream !== 'function' || typeof globalThis.ReadableStream !== 'function') {
      throw createError(unavailableCode, 'A validação raster local não está disponível neste worker.');
    }
    return selected;
  };

  const waitForRasterValidation = (waitForOperation, bytes, limits) => {
    const controller = new AbortController();
    return waitForOperation(validatePngRasterData(bytes, { ...limits, signal: controller.signal }), {
      onCancel: reason => controller.abort(reason),
    });
  };

  const canvasPng = async (canvas, waitForOperation) => {
    if (typeof canvas.convertToBlob !== 'function') throw createError(unavailableCode, 'O compositor local não oferece exportação PNG.');
    const blob = await waitForOperation(canvas.convertToBlob({ type: 'image/png' }));
    if (!(blob instanceof Blob) || blob.type !== 'image/png') throw createError(outputInvalidCode, 'O compositor não retornou PNG local válido.');
    return new Uint8Array(await waitForOperation(blob.arrayBuffer()));
  };

  return { throwIfAborted, operationWaiter, featureRuntime, waitForRasterValidation, canvasPng };
}
