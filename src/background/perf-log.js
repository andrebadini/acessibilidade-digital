// Medição de desempenho da auditoria (1.1.62).
//
// Fica atrás de uma chave de depuração DESLIGADA por padrão: sem `globalThis.__auditaPerf === true`,
// cada ponto de medição custa uma comparação booleana e nada é guardado. Nenhum número daqui entra no
// modelo, no relatório ou no IndexedDB — é instrumentação de bancada, lida de fora enquanto o Chrome
// está aberto (ver scripts/perf-audit.mjs).
//
// O mesmo módulo serve aos três contextos medidos (worker de segundo plano, painel e páginas da
// extensão): o registro vive no `globalThis` de quem mede, então cada contexto tem o seu.

const FLAG = '__auditaPerf';
const LOG = '__auditaPerfLogV1';

function clock() {
  return typeof performance === 'object' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function store() {
  const existing = globalThis[LOG];
  if (Array.isArray(existing)) return existing;
  const created = [];
  globalThis[LOG] = created;
  return created;
}

/** A medição está ligada? Uma leitura de propriedade, nada mais. */
export function perfEnabled() {
  return globalThis[FLAG] === true;
}

/**
 * Marca o início de uma fase. Devolve `null` com a medição desligada, e esse `null` é justamente o
 * que `perfEnd` espera para não fazer nada.
 */
export function perfBegin() {
  return perfEnabled() ? clock() : null;
}

/** Fecha uma fase aberta por `perfBegin`. */
export function perfEnd(scope, phase, startedAt, detail) {
  if (startedAt === null) return;
  record(scope, phase, clock() - startedAt, detail);
}

/** Registra um número avulso (contagem, bytes, itens). */
export function perfCount(scope, phase, value, detail) {
  if (!perfEnabled()) return;
  record(scope, phase, value, detail);
}

function record(scope, phase, value, detail) {
  if (!perfEnabled()) return;
  const entry = { scope: String(scope), phase: String(phase), value: Math.round(value * 100) / 100, at: Date.now() };
  if (detail !== undefined) entry.detail = detail;
  store().push(entry);
}

/**
 * Perfil de chamadas CDP por método, para achar qual comando domina a fase. O invólucro só existe com
 * a medição ligada: desligada, o objeto devolvido é exatamente o recebido — nenhum teste existente vê
 * diferença.
 */
const FLUSHES = [];
export function perfWrapCdp(cdp, scope = 'cdp') {
  if (!perfEnabled() || !cdp || typeof cdp.command !== 'function') return cdp;
  const totals = new Map();
  const wrapped = {
    command(method, params) {
      const started = clock();
      let pending;
      try {
        pending = cdp.command(method, params);
      } finally {
        // `Map.set` devolve o mapa, não a entrada: incrementar o retorno de `set` somava a contagem
        // num campo do próprio mapa e a tabela saía sempre com zero chamadas.
        const entry = totals.get(method) ?? { count: 0, ms: 0 };
        entry.count += 1;
        totals.set(method, entry);
      }
      const settle = () => {
        const entry = totals.get(method) ?? { count: 0, ms: 0 };
        entry.ms += clock() - started;
        totals.set(method, entry);
      };
      return Promise.resolve(pending).finally(settle);
    },
  };
  // Qualquer outro membro do cliente (desanexo, eventos, sessão) é repassado sem toque.
  const proxy = new Proxy(wrapped, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver);
      const value = cdp[property];
      return typeof value === 'function' ? value.bind(cdp) : value;
    },
    has: (_target, property) => property in cdp,
  });
  FLUSHES.push(() => {
    for (const [method, entry] of [...totals.entries()].sort((left, right) => right[1].ms - left[1].ms)) {
      record(scope, `cdp:${method}`, entry.ms, { count: entry.count });
    }
  });
  // Quem mede de fora (scripts/perf-audit.mjs) lê só o `globalThis` do contexto: sem esta porta o
  // perfil CDP acumulado nunca seria despejado.
  globalThis.__auditaPerfFlushCdp = flushAll;
  return proxy;
}

function flushAll() {
  for (const flush of FLUSHES.splice(0)) {
    try { flush(); } catch { /* medição nunca derruba quem mede */ }
  }
}

/** Instantâneo do registro, com o perfil CDP acumulado despejado antes. */
export function readPerfLog() {
  flushAll();
  return Array.isArray(globalThis[LOG]) ? globalThis[LOG].slice() : [];
}

export function clearPerfLog() {
  globalThis[LOG] = [];
}
