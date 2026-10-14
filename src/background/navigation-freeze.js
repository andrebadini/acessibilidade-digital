// CONGELAMENTO DE NAVEGAÇÃO (1.1.58). Enquanto a auditoria da página corre com o depurador anexado, a
// própria página pode trocar o documento debaixo dela: `<meta http-equiv="refresh">`, um
// `setTimeout(() => location.reload())`, um redirecionamento por script depois do aviso de cookies. Quando
// isso acontece, o documento auditado deixa de existir: a auditoria termina interrompida (`TARGET_CHANGED`)
// ou, pior, o resultado sai completo e os sinais não podem mais ser instalados porque o `documentId` mudou.
//
// A defesa é interceptar, no domínio Fetch, apenas requisições de DOCUMENTO de frame principal e responder
// `Fetch.failRequest` com `Aborted`: a navegação não se completa, o documento atual permanece e nenhuma
// página de erro aparece. Só o frame de topo é segurado; iframes seguem com `continueRequest` e todos os
// demais pedidos (imagens, scripts, folhas, XHR) não são sequer vistos, porque o padrão do `Fetch.enable`
// declara `resourceType: 'Document'` e nada mais.
//
// O congelamento é BEST-EFFORT e nunca pode derrubar a auditoria: se `Fetch.enable` for recusado, o erro
// sobe para o chamador, que segue sem congelar; se uma resposta falhar, ela é engolida — o pior caso é a
// página navegar como navegaria hoje, jamais uma auditoria inválida ou um pedido pendurado.

const DOCUMENT_ONLY_PATTERNS = Object.freeze([
  Object.freeze({ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }),
]);
const REQUEST_PAUSED = 'Fetch.requestPaused';
// Teto do registro de pedidos já respondidos. Um evento repetido para o mesmo `requestId` não pode ser
// respondido duas vezes (o protocolo recusa) nem contado duas vezes no diagnóstico.
const ANSWERED_LIMIT = 512;

function ownValue(object, key) {
  try {
    const descriptor = object && typeof object === 'object' ? Reflect.getOwnPropertyDescriptor(object, key) : null;
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}
function ownCallable(object, key) {
  const value = ownValue(object, key);
  return typeof value === 'function' ? value : null;
}

/**
 * Cria o controlador do congelamento sobre uma sessão CDP já anexada a `tabId`.
 * O chamador é dono do ciclo de vida: `start()`, depois `blocked()` e, sempre, `stop()` no caminho de saída.
 */
export function createNavigationFreeze({ chromeApi, cdp, tabId } = {}) {
  const debuggerApi = ownValue(chromeApi, 'debugger');
  const onEvent = ownValue(debuggerApi, 'onEvent');
  const addListener = ownCallable(onEvent, 'addListener');
  const removeListener = ownCallable(onEvent, 'removeListener');
  const command = ownCallable(cdp, 'command');
  if (!addListener || !removeListener || !command ||
    !Number.isSafeInteger(tabId) || tabId < 0) throw new TypeError('NAVIGATION_FREEZE_INVALID');

  let listening = false;
  let intercepting = false;
  let topFrameId = null;
  let blocked = 0;
  let answered = new Set();

  const remember = requestId => {
    if (answered.size >= ANSWERED_LIMIT) answered = new Set();
    answered.add(requestId);
  };

  // Só o frame de topo é segurado. Um pedido de iframe (ou um que não se consiga atribuir ao topo) segue
  // adiante: o congelamento nunca troca o documento da página por uma tela de erro por engano.
  const respond = async (requestId, frameId) => {
    const isTopFrame = typeof frameId === 'string' && frameId !== '' && frameId === topFrameId;
    try {
      if (isTopFrame) {
        blocked += 1;
        await command('Fetch.failRequest', { requestId, errorReason: 'Aborted' });
      } else {
        await command('Fetch.continueRequest', { requestId });
      }
    } catch { /* A sessão pode ter caído; o desanexo desfaz qualquer interceptação remanescente. */ }
  };

  const listener = (source, method, params) => {
    if (!intercepting || method !== REQUEST_PAUSED) return;
    if (ownValue(source, 'tabId') !== tabId) return;
    const requestId = ownValue(params, 'requestId');
    if (typeof requestId !== 'string' || !requestId || answered.has(requestId)) return;
    remember(requestId);
    void respond(requestId, ownValue(params, 'frameId'));
  };

  return Object.freeze({
    async start() {
      if (listening) return;
      // O id do frame principal é estável entre navegações do mesmo topo; lido uma vez, antes de
      // interceptar, ele é a única referência de que "frame principal" depende aqui.
      const tree = await command('Page.getFrameTree', {});
      const mainFrame = ownValue(ownValue(tree, 'frameTree'), 'frame');
      const mainFrameId = ownValue(mainFrame, 'id');
      if (typeof mainFrameId !== 'string' || !mainFrameId) throw new Error('NAVIGATION_FREEZE_UNAVAILABLE');
      topFrameId = mainFrameId;
      addListener(listener);
      listening = true;
      try {
        await command('Fetch.enable', { patterns: DOCUMENT_ONLY_PATTERNS });
        intercepting = true;
      } catch (error) {
        listening = false;
        try { removeListener(listener); } catch { /* o erro de origem é o que importa */ }
        throw error;
      }
    },
    // Desliga SEMPRE nesta ordem: primeiro o Fetch (para de interceptar), depois o ouvinte de eventos. O
    // `Fetch.disable` é o que libera pedidos eventualmente pausados — nunca pode ficar para trás.
    async stop() {
      intercepting = false;
      let disabled = true;
      if (listening) {
        try { await command('Fetch.disable', {}); } catch { disabled = false; }
        listening = false;
        try { removeListener(listener); } catch { /* limpeza best-effort */ }
      }
      answered = new Set();
      return disabled;
    },
    blocked() { return blocked; },
    intercepted() { return intercepting; },
  });
}
