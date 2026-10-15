/**
 * Leitura dos ouvintes de mouse e de teclado de um bloco (ABNT 5.1.13 / WCAG 2.1.1).
 *
 * Há menu que não abre por regra `:hover` de CSS: quem reage é um ouvinte de `mouseenter`/`mouseover`
 * registrado pelo site, que troca uma classe ou um `display`. Nesse caso a sondagem por
 * `CSS.forcePseudoState` não vê nada, porque nenhuma pseudo-classe é o gatilho, e o bloco passaria
 * como conforme mesmo sem nenhum caminho de teclado. Este módulo pergunta ao navegador **quais
 * ouvintes existem** no bloco e nos ancestrais próximos, por `DOMDebugger.getEventListeners`.
 *
 * É leitura pura. O ouvinte não é chamado, nenhum evento é disparado, nenhum atributo, texto ou
 * classe muda, e o site não executa nada por causa desta chamada — por isso ela também vale no modo
 * da página atual, onde a promessa publicada é de inspeção somente leitura. Os objetos remotos
 * criados aqui ficam no grupo de objetos que o cliente informa, e quem os libera é a sondagem que
 * chamou este módulo (`Runtime.releaseObjectGroup`).
 *
 * Presença de ouvinte não conclui falha: a dúvida para revisão humana só nasce quando há indício de
 * abertura por mouse **e** nenhum caminho de teclado — nem bloco focável, nem controle focável e
 * visível dentro dele, nem ouvinte de foco/teclado no bloco ou nos ancestrais. Quem decide isso é
 * `scriptHoverWithoutKeyboardPath`, longe do navegador.
 */

export const HOVER_SCRIPT_EVENTS = Object.freeze(['mouseenter', 'mouseover', 'pointerenter', 'pointerover']);
export const KEYBOARD_PATH_EVENTS = Object.freeze(['focus', 'focusin', 'keydown', 'click']);

export const HOVER_SCRIPT_LIMITS = Object.freeze({
  // Quantos níveis acima do bloco ainda contam. O gatilho do menu costuma ficar num contêiner
  // próximo; subir mais que isso alcançaria ouvintes delegados da página inteira, que não dizem
  // nada sobre este bloco e só serviriam para esconder defeito real.
  ancestorLevels: 3,
  maxGroups: 60,
  maxListeners: 200,
  deadlineMs: 6_000,
  timeoutMs: 15_000,
});

const HOVER_SCRIPT_OBJECT_GROUP = 'audita-mt-hover-script-probe';

function limitsOf(overrides) {
  const limits = { ...HOVER_SCRIPT_LIMITS };
  if (!overrides || typeof overrides !== 'object') return limits;
  for (const key of Object.keys(limits)) {
    const value = Object.getOwnPropertyDescriptor(overrides, key)?.value;
    if (Number.isSafeInteger(value) && value > 0) limits[key] = value;
  }
  return limits;
}

/**
 * Classifica uma lista de ouvintes do CDP (`[{ type }]`) nos dois grupos que interessam. Função pura:
 * nenhum objeto do navegador entra aqui, só os tipos já serializados, o que a torna testável sem
 * sessão de depuração.
 */
export function categorizeListeners(listeners, maxListeners = HOVER_SCRIPT_LIMITS.maxListeners) {
  const evidence = { hoverScript: false, keyboardPath: false };
  if (!Array.isArray(listeners)) return evidence;
  const hover = new Set(HOVER_SCRIPT_EVENTS);
  const keyboard = new Set(KEYBOARD_PATH_EVENTS);
  const limit = Number.isSafeInteger(maxListeners) && maxListeners > 0 ? maxListeners : HOVER_SCRIPT_LIMITS.maxListeners;
  let inspected = 0;
  for (const listener of listeners) {
    if (inspected >= limit) break;
    const type = listener && typeof listener === 'object' ? listener.type : null;
    if (typeof type !== 'string') continue;
    inspected += 1;
    if (hover.has(type)) evidence.hoverScript = true;
    else if (keyboard.has(type)) evidence.keyboardPath = true;
    if (evidence.hoverScript && evidence.keyboardPath) break;
  }
  return evidence;
}

/**
 * O indício que autoriza a dúvida: o bloco reage ao mouse por script e nenhum caminho de teclado foi
 * encontrado. Sem os dois lados, o bloco não vira nada no relatório.
 */
export function scriptHoverWithoutKeyboardPath(evidence) {
  return evidence?.hoverScript === true && evidence?.keyboardPath !== true;
}

/**
 * Primeiro passo, enviado por `Runtime.evaluate`: precisa ser autocontida. Devolve, para cada caminho
 * pedido, o bloco e seus ancestrais até `levels` níveis, **com posições fixas** — um ancestral que
 * não existe entra como `null` na posição dele. É o que permite ler os identificadores de objeto de
 * todos os blocos numa única chamada, sem depender de o DOM ter profundidade previsível.
 */
function collectHoverScriptChains(payload) {
  const levels = payload.levels;
  const root = document.documentElement;
  const resolve = path => {
    let node = root;
    for (const index of path) {
      if (!node || !node.children || !node.children[index]) return null;
      node = node.children[index];
    }
    return node;
  };
  const chains = [];
  for (const path of payload.paths) {
    let node = resolve(path);
    for (let depth = 0; depth <= levels; depth += 1) {
      chains.push(node ?? null);
      node = node && node.parentElement ? node.parentElement : null;
    }
  }
  return chains;
}

/** Lê os `objectId` das posições do arranjo devolvido pelo passo anterior, na ordem. */
async function readChainObjectIds(cdp, arrayObjectId, expected, timeoutMs) {
  if (typeof arrayObjectId !== 'string' || !arrayObjectId || expected <= 0) return null;
  try {
    const response = await cdp.command('Runtime.getProperties', {
      objectId: arrayObjectId, ownProperties: true, accessorPropertiesOnly: false, generatePreview: false,
    }, { timeoutMs });
    const descriptors = Array.isArray(response?.result) ? response.result : [];
    const objectIds = new Array(expected).fill(null);
    for (const descriptor of descriptors) {
      const index = Number(descriptor?.name);
      if (!Number.isSafeInteger(index) || index < 0 || index >= expected) continue;
      const objectId = descriptor?.value?.objectId;
      objectIds[index] = typeof objectId === 'string' && objectId ? objectId : null;
    }
    return objectIds;
  } catch {
    return null;
  }
}

/** Ouvintes de um nó, ou `null` quando a leitura falhou — falha de nó não vira "sem ouvinte". */
async function listenersOf(cdp, objectId, limits) {
  try {
    const response = await cdp.command('DOMDebugger.getEventListeners', {
      objectId, depth: 0, pierce: false,
    }, { timeoutMs: limits.timeoutMs });
    return Array.isArray(response?.listeners) ? response.listeners : [];
  } catch {
    return null;
  }
}

/**
 * Lê os ouvintes dos blocos pedidos. Nunca lança: devolve `inspected: false` quando não conseguiu
 * cobrir todos os pedidos, e a sondagem que chamou transforma isso em observação incompleta — nunca
 * num "passou" silencioso. `entries` é um `Map` de chave → `{ hoverScript, keyboardPath }`.
 */
export async function inspectHoverScriptPaths(cdp, requests, options = {}) {
  if (!cdp || typeof cdp.command !== 'function') throw new TypeError('O cliente CDP é inválido.');
  const limits = limitsOf(options.limits);
  const objectGroup = typeof options.objectGroup === 'string' && options.objectGroup
    ? options.objectGroup
    : HOVER_SCRIPT_OBJECT_GROUP;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : limits.timeoutMs;
  const entries = new Map();
  const uninspected = [];
  const list = (Array.isArray(requests) ? requests : []).filter(request =>
    request && typeof request.key === 'string' && request.key && Array.isArray(request.anchorPath));
  const sliced = list.slice(0, limits.maxGroups);
  // O que não coube no teto também é pedido não coberto: quem chama precisa saber para não dar o
  // bloco como conforme sem ter olhado.
  for (const request of list.slice(sliced.length)) uninspected.push(request.key);
  if (sliced.length === 0) return { inspected: true, entries, uninspected, attempted: 0 };

  const perChain = limits.ancestorLevels + 1;
  const startedAt = Date.now();
  let chains = null;
  try {
    const remote = await cdp.command('Runtime.evaluate', {
      expression: `(${collectHoverScriptChains.toString()})(${JSON.stringify({
        paths: sliced.map(request => request.anchorPath), levels: limits.ancestorLevels,
      })})`,
      awaitPromise: false, returnByValue: false, objectGroup,
    }, { timeoutMs });
    chains = await readChainObjectIds(cdp, remote?.result?.objectId, sliced.length * perChain, timeoutMs);
  } catch {
    chains = null;
  }
  if (!chains) {
    for (const request of sliced) uninspected.push(request.key);
    return { inspected: false, entries, uninspected, attempted: sliced.length };
  }

  const cache = new Map();
  for (const [index, request] of sliced.entries()) {
    if (Date.now() - startedAt > limits.deadlineMs) {
      uninspected.push(request.key);
      continue;
    }
    const chain = chains.slice(index * perChain, (index + 1) * perChain);
    // Bloco sem objeto remoto é bloco que sumiu entre a descoberta e esta leitura: não há o que ler.
    if (!chain[0]) {
      uninspected.push(request.key);
      continue;
    }
    const evidence = { hoverScript: false, keyboardPath: false };
    let read = 0;
    for (const objectId of chain) {
      if (!objectId) continue;
      let listeners = cache.get(objectId);
      if (listeners === undefined) {
        listeners = await listenersOf(cdp, objectId, limits);
        cache.set(objectId, listeners);
      }
      // Um nó que falhou não afirma nada; só a cadeia inteira sem leitura nenhuma é que deixa o
      // bloco sem veredito.
      if (listeners === null) continue;
      read += 1;
      const categorized = categorizeListeners(listeners, limits.maxListeners);
      evidence.hoverScript = evidence.hoverScript || categorized.hoverScript;
      evidence.keyboardPath = evidence.keyboardPath || categorized.keyboardPath;
    }
    if (read === 0) {
      uninspected.push(request.key);
      continue;
    }
    entries.set(request.key, evidence);
  }
  return { inspected: uninspected.length === 0, entries, uninspected, attempted: sliced.length };
}
