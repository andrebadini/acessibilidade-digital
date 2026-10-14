import { sanitizeWarning } from '../core/privacy.js';
import { assertSnapshotV1 } from '../core/snapshot-schema.js';
import { HOVER_ONLY_OBSERVATION_KEY } from '../core/rules/hover-only.js';

/**
 * Sonda de conteúdo interativo que só aparece com o mouse (ABNT 5.1.13 / WCAG 2.1.1).
 *
 * O navegador só aplica `:hover` de verdade com o ponteiro. `CSS.forcePseudoState` faz a regra CSS
 * correspondente valer para a renderização sem disparar eventos de ponteiro (nenhum `mouseover`,
 * `focus` ou `click`), sem executar JavaScript do site e sem tocar no documento: nenhuma mutação de
 * DOM, atributo ou texto acontece, e o valor forçado sempre volta a vazio no comando seguinte, dentro
 * de `finally`. É por isso que a sondagem também é permitida no modo da página atual, onde a promessa
 * publicada é de inspeção somente leitura — a página permanece como estava, sem foco, rolagem ou
 * mutação. O que a sondagem mede é só o resultado de renderização que a pseudo-classe provoca.
 *
 * O estado forçado não vale no mesmo instante em que é forçado. Páginas reais animam a abertura
 * (`transition` em `opacity`/`visibility`/`padding`), e o navegador só publica o novo valor de
 * `visibility` depois de parte da duração. Ler o alvo imediatamente devolveria "nada apareceu" para
 * cartões que aparecem — um falso negativo exatamente no defeito que a regra existe para encontrar.
 * Por isso a sondagem espera o tempo das transições que ela mesma disparou, com teto; quando a
 * animação é mais longa que o teto, o grupo fica como dúvida (`cantTell`) em vez de "passou", porque
 * a medição não terminou.
 *
 * O módulo isola toda a lógica desta verificação; o pipeline da auditoria chama apenas
 * `applyHoverOnlyProbe`, que anexa a observação ao snapshot e nunca lança.
 */

export const HOVER_ONLY_PROBE_LIMITS = Object.freeze({
  maxAncestorLevels: 6,
  maxGroups: 60,
  maxTargetsPerGroup: 20,
  maxCandidates: 20_000,
  // Quanto a sondagem espera, no máximo, pela transição declarada que ela disparou.
  maxSettleMs: 600,
  deadlineMs: 20_000,
});

const OBJECT_GROUP = 'audita-mt-hover-probe';
const COMMAND_OPTIONS = Object.freeze({ timeoutMs: 20_000 });
const TIMEOUT_WARNING = Object.freeze({ code: 'TIMEOUT' });
const FAILED_WARNING = Object.freeze({ code: 'PROBE_FAILED' });

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function bounds(overrides) {
  const limits = { ...HOVER_ONLY_PROBE_LIMITS };
  if (!overrides || typeof overrides !== 'object') return limits;
  for (const key of Object.keys(limits)) {
    const value = Object.getOwnPropertyDescriptor(overrides, key)?.value;
    if (Number.isSafeInteger(value) && value > 0) limits[key] = value;
  }
  return limits;
}

/**
 * Primeiro passo, enviado por `Runtime.evaluate`: precisa ser autocontida (nenhum fechamento do módulo
 * sobrevive à serialização). Lista elementos interativos ocultos e o ancestral visível mais próximo,
 * usando caminhos de índice em vez de seletores para não depender de unicidade nem de escape.
 */
function discoverHoverOnlyCandidates(limits) {
  const INTERACTIVE = 'a[href],button,input,select,textarea,[tabindex],[contenteditable="true"],[role="link"],[role="button"],[role="menuitem"],[role="tab"]';
  const FOCUSABLE = 'a[href],button,input,select,textarea,[tabindex],[contenteditable="true"]';
  const maxLevels = limits.maxAncestorLevels;
  const styleCache = new WeakMap();
  const boxCache = new WeakMap();
  const chainCache = new WeakMap();
  const styleOf = element => {
    if (styleCache.has(element)) return styleCache.get(element);
    let style = null;
    try { style = getComputedStyle(element); } catch (error) { style = null; }
    styleCache.set(element, style);
    return style;
  };
  const ownHidden = element => {
    const style = styleOf(element);
    return !!style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse');
  };
  const boxed = element => {
    if (boxCache.has(element)) return boxCache.get(element);
    let value = false;
    try { const rect = element.getBoundingClientRect(); value = rect.width > 0 && rect.height > 0; } catch (error) { value = false; }
    boxCache.set(element, value);
    return value;
  };
  const chainOf = element => {
    if (chainCache.has(element)) return chainCache.get(element);
    const chain = [];
    let node = element;
    for (let depth = 0; node && depth <= maxLevels; depth += 1) { chain.push(node); node = node.parentElement; }
    chainCache.set(element, chain);
    return chain;
  };
  const chainHidden = element => chainOf(element).some(ownHidden);
  const isVisible = element => !chainHidden(element) && boxed(element);
  const pathFrom = (root, element) => {
    const path = [];
    let node = element;
    while (node && node !== root && node.parentElement) {
      const index = Array.prototype.indexOf.call(node.parentElement.children, node);
      if (index < 0) return null;
      path.unshift(index);
      node = node.parentElement;
      if (path.length > 64) return null;
    }
    return node === root ? path : null;
  };
  const resolvePath = (root, path) => {
    let node = root;
    for (const index of path) {
      if (!node || !node.children || !node.children[index]) return null;
      node = node.children[index];
    }
    return node;
  };
  const tabReachable = element => {
    if (element.disabled === true) return false;
    if (element.localName === 'input' && String(element.getAttribute('type') || 'text').toLowerCase() === 'hidden') return false;
    const raw = element.getAttribute('tabindex');
    if (raw === null) return true;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value >= 0;
  };
  const focusableAt = (root, element) => {
    if (!isVisible(element) || !tabReachable(element)) return false;
    try { return element.matches(FOCUSABLE); } catch (error) { return false; }
  };
  let candidates;
  try { candidates = document.querySelectorAll(INTERACTIVE); } catch (error) { return { ok: false }; }
  const root = document.documentElement;
  if (!root) return { ok: false };
  const groups = new Map();
  let scanned = 0;
  let discovered = 0;
  let truncated = false;
  for (const element of candidates) {
    if (scanned >= limits.maxCandidates) { truncated = true; break; }
    scanned += 1;
    if (!element || element.nodeType !== 1 || !chainHidden(element)) continue;
    let anchor = null;
    let node = element.parentElement;
    for (let depth = 0; node && depth < maxLevels; depth += 1) {
      if (isVisible(node)) { anchor = node; break; }
      node = node.parentElement;
    }
    if (!anchor) continue;
    const anchorPath = pathFrom(root, anchor);
    if (!anchorPath) continue;
    discovered += 1;
    const key = anchorPath.join('.');
    let group = groups.get(key);
    if (!group) {
      group = { key, anchorPath, targetCount: 0, targets: [], selfFocusable: false, focusPath: null };
      groups.set(key, group);
    }
    group.targetCount += 1;
    if (group.targets.length < limits.maxTargetsPerGroup) {
      const path = pathFrom(anchor, element);
      if (path) group.targets.push(path);
    }
  }
  const output = [];
  for (const group of groups.values()) {
    if (output.length >= limits.maxGroups) { truncated = true; break; }
    const anchor = resolvePath(root, group.anchorPath);
    if (!anchor || group.targets.length === 0) continue;
    group.selfFocusable = focusableAt(root, anchor);
    if (!group.selfFocusable) {
      let focusables;
      try { focusables = anchor.querySelectorAll(FOCUSABLE); } catch (error) { focusables = []; }
      for (const focusable of focusables) {
        if (!focusableAt(anchor, focusable)) continue;
        const path = pathFrom(anchor, focusable);
        if (path) { group.focusPath = path; break; }
      }
    }
    output.push(group);
  }
  return { ok: true, scanned, discovered, truncated, groups: output };
}

/**
 * Segundo passo: mede quais alvos ficaram visíveis para o estado forçado no momento da chamada e
 * quanto falta para as transições que ele disparou terminarem. Não decide nada sobre pseudo-classes —
 * quem as força é o cliente, pelo CDP, e sempre as desfaz.
 */
function measureHoverOnlyReveal(payload) {
  const maxLevels = payload.maxAncestorLevels;
  const resolvePath = (root, path) => {
    let node = root;
    for (const index of path) {
      if (!node || !node.children || !node.children[index]) return null;
      node = node.children[index];
    }
    return node;
  };
  const boxed = element => {
    try {
      for (const rect of element.getClientRects()) {
        if (rect.width > 0 || rect.height > 0) return true;
      }
      return false;
    } catch (error) { return false; }
  };
  const visible = (element, anchor) => {
    if (!element || element.nodeType !== 1 || !boxed(element)) return false;
    let node = element;
    for (let depth = 0; node && depth <= maxLevels + 2; depth += 1) {
      let style = null;
      try { style = getComputedStyle(node); } catch (error) { style = null; }
      if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (node === anchor) break;
      node = node.parentElement;
    }
    return true;
  };
  // Quanto ainda corre a animação que a pseudo-classe forçada disparou no caminho do alvo. É o que
  // diz ao cliente se vale esperar: sem animação em curso o valor lido agora é o valor final. A
  // leitura do estilo computado acima já provocou a recoleta de estilo, de modo que as transições
  // recém-criadas aparecem aqui no mesmo instante em que são criadas.
  const pendingMs = element => {
    let animations = null;
    try { animations = element.getAnimations(); } catch (error) { animations = null; }
    if (!animations) return 0;
    let longest = 0;
    for (const animation of animations) {
      let timing = null;
      try { timing = animation?.effect?.getComputedTiming?.() ?? null; } catch (error) { timing = null; }
      if (!timing) continue;
      const duration = Number(timing.duration);
      const delay = Number(timing.delay);
      if (!Number.isFinite(duration) || !Number.isFinite(delay)) continue;
      const total = Math.max(0, duration) + Math.max(0, delay);
      if (total > longest) longest = total;
    }
    return Math.ceil(longest);
  };
  const root = document.documentElement;
  const anchor = resolvePath(root, payload.anchorPath);
  if (!anchor) return { anchorMissing: true, revealed: 0, total: 0, settleMs: 0 };
  let settleMs = pendingMs(anchor);
  const flags = payload.targetPaths.map(path => {
    const target = resolvePath(anchor, path);
    // A transição pode estar em qualquer ponto entre o alvo e o ancestral sondado.
    let node = target;
    for (let depth = 0; node && depth <= maxLevels + 2; depth += 1) {
      settleMs = Math.max(settleMs, pendingMs(node));
      if (node === anchor) break;
      node = node.parentElement;
    }
    return visible(target, anchor);
  });
  return { anchorMissing: false, revealed: flags.filter(Boolean).length, total: flags.length, settleMs };
}

async function forcePseudoState(cdp, nodeId, forcedPseudoClasses) {
  await cdp.command('CSS.forcePseudoState', { nodeId, forcedPseudoClasses }, COMMAND_OPTIONS);
}

/** Resolve um elemento por caminho de índices e devolve `nodeId` (frontend) e `backendNodeId`. */
async function describeAtPath(cdp, path) {
  const source = `(() => { const path = ${JSON.stringify(path)}; let node = document.documentElement;
    for (const index of path) { if (!node || !node.children || !node.children[index]) return null; node = node.children[index]; }
    return node; })()`;
  const remote = await cdp.command('Runtime.evaluate', {
    expression: source, awaitPromise: false, returnByValue: false, objectGroup: OBJECT_GROUP,
  }, COMMAND_OPTIONS);
  const objectId = remote?.result?.objectId;
  if (typeof objectId !== 'string' || !objectId) return null;
  try {
    const described = await cdp.command('DOM.describeNode', { objectId, depth: 0, pierce: false }, COMMAND_OPTIONS);
    const node = described?.node;
    if (!node || !Number.isSafeInteger(node.backendNodeId) || node.backendNodeId < 0) return null;
    let nodeId = Number.isSafeInteger(node.nodeId) && node.nodeId > 0 ? node.nodeId : 0;
    if (nodeId === 0) {
      // Alguns documentos devolvem nodeId 0 em describeNode mesmo com o agente DOM ativo; o pedido
      // explícito registra o elemento e devolve o identificador usado por CSS.forcePseudoState.
      try {
        const requested = await cdp.command('DOM.requestNode', { objectId }, COMMAND_OPTIONS);
        nodeId = Number.isSafeInteger(requested?.nodeId) && requested.nodeId > 0 ? requested.nodeId : 0;
      } catch { nodeId = 0; }
    }
    if (nodeId === 0) {
      // Último recurso, e o que funciona quando a árvore do documento ainda não foi registrada nesta
      // sessão: o agente DOM promove o `backendNodeId` (que sempre vem preenchido) a id de frontend.
      try {
        const pushed = await cdp.command('DOM.pushNodesByBackendIdsToFrontend', {
          backendNodeIds: [node.backendNodeId],
        }, COMMAND_OPTIONS);
        const candidate = pushed?.nodeIds?.[0];
        nodeId = Number.isSafeInteger(candidate) && candidate > 0 ? candidate : 0;
      } catch { nodeId = 0; }
    }
    if (nodeId === 0) return null;
    return { nodeId, backendNodeId: node.backendNodeId };
  } finally {
    try { await cdp.command('Runtime.releaseObject', { objectId }, COMMAND_OPTIONS); } catch { /* handle remoto: melhor esforço */ }
  }
}

async function releaseProbeObjects(cdp) {
  try { await cdp.command('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }, COMMAND_OPTIONS); } catch { /* idem */ }
}

/**
 * Executa a sondagem não destrutiva. Nunca lança: uma falha vira observação incompleta, para que a
 * auditoria continue e o item siga para revisão humana em vez de perder o resultado.
 */
export async function runHoverOnlyProbe(cdp, options = {}) {
  if (!cdp || typeof cdp.command !== 'function') throw new TypeError('O cliente CDP é inválido.');
  const limits = bounds(options.limits);
  const warnings = [];
  const warn = code => {
    if (warnings.some(warning => warning.code === code)) return;
    warnings.push(sanitizeWarning({ code }));
  };
  const startedAt = Date.now();
  const expired = () => Date.now() - startedAt > limits.deadlineMs;
  const groups = [];
  let scanned = 0;
  let discovered = 0;
  let truncated = false;
  let incomplete = false;
  const forced = new Map();

  const maintain = async (nodeId, classes) => {
    if (!Number.isSafeInteger(nodeId) || nodeId <= 0) return;
    forced.set(nodeId, classes);
    await forcePseudoState(cdp, nodeId, classes);
  };
  const release = async nodeId => {
    if (!Number.isSafeInteger(nodeId) || nodeId <= 0) return;
    forced.set(nodeId, []);
    try { await forcePseudoState(cdp, nodeId, []); } finally { forced.delete(nodeId); }
  };

  try {
    await cdp.command('DOM.enable', {}, COMMAND_OPTIONS);
    await cdp.command('CSS.enable', {}, COMMAND_OPTIONS);
    // Uma leitura rasa do documento registra a árvore nesta sessão. Sem ela, `DOM.describeNode`
    // devolve `nodeId` 0 para nós que o agente DOM ainda não viu — e `CSS.forcePseudoState` só aceita
    // o id de frontend, de modo que toda a sondagem terminaria sem medir nada.
    try {
      await cdp.command('DOM.getDocument', { depth: 0 }, COMMAND_OPTIONS);
    } catch { /* os fallbacks por backendNodeId continuam valendo */ }
    const source = `(${discoverHoverOnlyCandidates.toString()})(${JSON.stringify(limits)})`;
    const remote = await cdp.command('Runtime.evaluate', {
      expression: source, awaitPromise: false, returnByValue: true, objectGroup: OBJECT_GROUP,
    }, COMMAND_OPTIONS);
    const discovery = remote?.result?.value;
    if (!discovery || discovery.ok !== true || !Array.isArray(discovery.groups)) {
      return {
        status: 'incomplete', truncated: false, candidates: 0, scanned: 0,
        examinedGroups: 0, withheldGroups: 0, groups: [], warnings: [sanitizeWarning(FAILED_WARNING)],
      };
    }
    scanned = Number.isSafeInteger(discovery.scanned) ? discovery.scanned : 0;
    discovered = Number.isSafeInteger(discovery.discovered) ? discovery.discovered : 0;
    truncated = discovery.truncated === true;
    for (const group of discovery.groups) {
      if (expired()) { incomplete = true; warn(TIMEOUT_WARNING.code); break; }
      const examined = await examineGroup(cdp, group, limits, maintain, release);
      if (!examined) { incomplete = true; continue; }
      groups.push(examined);
    }
  } catch {
    incomplete = true;
    warn(FAILED_WARNING.code);
  } finally {
    for (const [nodeId, classes] of forced) {
      if (classes.length === 0) continue;
      try { await forcePseudoState(cdp, nodeId, []); } catch { /* a sessão CDP é descartada ao final da auditoria */ }
    }
    forced.clear();
    await releaseProbeObjects(cdp);
  }

  // Prova de restauração: nenhum alvo pode continuar visível sem pseudo-classe forçada. Sem isso, a
  // página ficaria alterada depois da auditoria — exatamente o que a promessa de leitura proíbe.
  const restored = await verifyRestored(cdp, groups, limits);
  const withheld = groups.filter(group => group.restored !== true).length;
  // Grupo retido é uma medição que não terminou: a página pode ter ficado como estava, mas a
  // conclusão daquele bloco não vale e a limitação precisa aparecer no relatório.
  if (!restored || withheld > 0) warn(FAILED_WARNING.code);
  return {
    status: incomplete || withheld > 0 ? 'incomplete' : 'complete',
    truncated,
    candidates: discovered,
    scanned,
    examinedGroups: groups.length - withheld,
    withheldGroups: withheld,
    groups,
    warnings,
  };
}

async function examineGroup(cdp, group, limits, maintain, release) {
  const anchor = await describeAtPath(cdp, group.anchorPath);
  const targetPaths = Array.isArray(group.targets) ? group.targets : [];
  if (!anchor || targetPaths.length === 0) return null;
  const payload = { anchorPath: group.anchorPath, targetPaths, maxAncestorLevels: limits.maxAncestorLevels };
  const measure = async () => {
    const remote = await cdp.command('Runtime.evaluate', {
      expression: `(${measureHoverOnlyReveal.toString()})(${JSON.stringify(payload)})`,
      awaitPromise: false, returnByValue: true, objectGroup: OBJECT_GROUP,
    }, COMMAND_OPTIONS);
    const value = remote?.result?.value;
    return value && typeof value === 'object' ? value : null;
  };
  /**
   * Lê o estado forçado e, se algo ainda está animando, espera a animação declarada antes de concluir.
   * `settled` diz se a última leitura já é o estado final: quando a animação dura mais que o teto, o
   * bloco não pode ser dado como conforme — a medição não terminou.
   */
  const measureSettled = async () => {
    const first = await measure();
    if (!first || first.anchorMissing) return { reading: first, settled: false, budgetMs: 0 };
    const pending = Number.isSafeInteger(first.settleMs) && first.settleMs > 0 ? first.settleMs : 0;
    if (pending === 0 || first.revealed >= first.total) return { reading: first, settled: true, budgetMs: 0 };
    const budgetMs = Math.min(pending, limits.maxSettleMs);
    await sleep(budgetMs);
    const second = await measure();
    if (!second || second.anchorMissing) return { reading: first, settled: false, budgetMs };
    const stillPending = Number.isSafeInteger(second.settleMs) && second.settleMs > 0;
    return {
      reading: { ...second, revealed: Math.max(first.revealed, second.revealed) },
      settled: !stillPending,
      budgetMs,
    };
  };
  const base = {
    backendNodeId: anchor.backendNodeId,
    anchorPath: group.anchorPath,
    targetPaths,
    targetCount: Number.isSafeInteger(group.targetCount) && group.targetCount > 0 ? group.targetCount : targetPaths.length,
    sampledTargets: targetPaths.length,
    revealedOnHover: 0,
    focusableInside: group.selfFocusable === true || Array.isArray(group.focusPath),
    selfFocusable: group.selfFocusable === true,
    revealedByFocus: false,
    restored: true,
    outcome: 'passed',
  };
  try {
    await maintain(anchor.nodeId, ['hover']);
    const hovered = await measureSettled();
    if (!hovered.reading || hovered.reading.anchorMissing) return null;
    base.revealedOnHover = Number.isSafeInteger(hovered.reading.revealed) ? hovered.reading.revealed : 0;
    await release(anchor.nodeId);
    // Fechar também passa pela transição declarada. Medir o foco no meio da animação de fechamento
    // diria que o teclado revelou o conteúdo quando o que ainda está aberto é o mouse.
    if (hovered.budgetMs > 0) await sleep(hovered.budgetMs);
    if (base.revealedOnHover === 0) {
      return { ...base, unsettled: !hovered.settled, outcome: hovered.settled ? 'passed' : 'cantTell' };
    }
    if (!base.focusableInside) return { ...base, outcome: 'failed' };
    const focusNode = base.selfFocusable === true
      ? anchor
      : await describeAtPath(cdp, [...group.anchorPath, ...group.focusPath]);
    if (!focusNode) return { ...base, outcome: 'cantTell' };
    try {
      await maintain(anchor.nodeId, ['focus-within']);
      await maintain(focusNode.nodeId, ['focus', 'focus-visible']);
      const focused = await measureSettled();
      const reveal = focused?.reading;
      base.revealedByFocus = !!reveal && Number.isSafeInteger(reveal.revealed) && reveal.revealed > 0;
      // Caminho de teclado que não termina de aparecer não confirma conformidade: o bloco fica como
      // dúvida, do mesmo modo que quando o conteúdo aparece só com o mouse.
      return {
        ...base,
        unsettled: !focused.settled,
        outcome: base.revealedByFocus && focused.settled ? 'passed' : 'cantTell',
      };
    } finally {
      await release(focusNode.nodeId);
      await release(anchor.nodeId);
    }
  } catch {
    try { await release(anchor.nodeId); } catch { /* idem */ }
    return { ...base, restored: false, outcome: 'cantTell' };
  }
}

/** Reprojeta cada grupo sem nenhuma pseudo-classe forçada para provar que a página voltou ao estado. */
async function verifyRestored(cdp, groups, limits) {
  let restored = true;
  const read = async group => {
    const remote = await cdp.command('Runtime.evaluate', {
      expression: `(${measureHoverOnlyReveal.toString()})(${JSON.stringify({
        anchorPath: group.anchorPath, targetPaths: group.targetPaths, maxAncestorLevels: limits.maxAncestorLevels,
      })})`,
      awaitPromise: false, returnByValue: true, objectGroup: OBJECT_GROUP,
    }, COMMAND_OPTIONS);
    const value = remote?.result?.value;
    if (!value || typeof value !== 'object') throw new TypeError('leitura ausente');
    return value;
  };
  for (const group of groups) {
    if (!Array.isArray(group.targetPaths)) { group.restored = false; restored = false; continue; }
    try {
      let value = await read(group);
      // Desfazer a pseudo-classe também passa pela transição: ler no mesmo instante diria "continuou
      // aberto" para todo cartão que anima a abertura, e a página já voltou ao estado original. Se a
      // animação durar mais que o teto, o grupo é retido — a restauração não ficou provada.
      if (value.revealed !== 0) {
        const pending = Number.isSafeInteger(value.settleMs) && value.settleMs > 0 ? value.settleMs : 0;
        if (pending > 0) { await sleep(Math.min(pending, limits.maxSettleMs)); value = await read(group); }
      }
      if (value.revealed !== 0) { group.restored = false; restored = false; }
    } catch {
      group.restored = false;
      restored = false;
    }
  }
  return restored;
}

/** Projeção conservadora e JSON-safe da observação bruta. */
export function normalizeHoverOnlyProbe(raw) {
  const omitted = {
    status: 'omitted', outcome: 'cantTell', truncated: false, candidates: 0,
    examinedGroups: 0, withheldGroups: 0, groups: [], warnings: [],
  };
  if (!raw || typeof raw !== 'object' || raw.status === 'omitted') return omitted;
  const status = raw.status === 'complete' ? 'complete' : 'incomplete';
  const truncated = raw.truncated === true;
  const groups = [];
  for (const group of Array.isArray(raw.groups) ? raw.groups : []) {
    const backendNodeId = group?.backendNodeId;
    if (!Number.isSafeInteger(backendNodeId) || backendNodeId < 0) continue;
    if (!['failed', 'cantTell', 'passed'].includes(group.outcome)) continue;
    groups.push({
      nodeId: `n-${backendNodeId}`,
      targetCount: Number.isSafeInteger(group.targetCount) && group.targetCount > 0 ? group.targetCount : 1,
      revealedOnHover: Number.isSafeInteger(group.revealedOnHover) ? group.revealedOnHover : 0,
      focusableInside: group.focusableInside === true,
      // A medição que não terminou não pode virar "passou": quem lê a observação precisa saber que a
      // dúvida vem da animação, e não de um controle focável que não revelou o conteúdo.
      unsettled: group.unsettled === true,
      outcome: group.outcome,
    });
  }
  const failed = groups.filter(group => group.outcome === 'failed').length;
  const cantTell = groups.filter(group => group.outcome === 'cantTell').length;
  // Um achado confirmado vale mesmo com cobertura truncada; só a conclusão de conformidade é que fica
  // retida (cantTell) quando a observação não terminou ou não cobriu toda a página.
  const outcome = failed > 0 ? 'failed'
    : status !== 'complete' || truncated || cantTell > 0 ? 'cantTell' : 'passed';
  return {
    status,
    outcome,
    truncated,
    candidates: Number.isSafeInteger(raw.candidates) && raw.candidates >= 0 ? raw.candidates : 0,
    examinedGroups: Number.isSafeInteger(raw.examinedGroups) && raw.examinedGroups >= 0 ? raw.examinedGroups : 0,
    withheldGroups: Number.isSafeInteger(raw.withheldGroups) && raw.withheldGroups >= 0 ? raw.withheldGroups : 0,
    groups,
    warnings: Array.isArray(raw.warnings) ? raw.warnings.map(warning => sanitizeWarning(warning)) : [],
  };
}

/** Anexa a observação ao snapshot sem mutar o objeto recebido. */
export function mergeHoverOnlyIntoSnapshot(snapshot, observation) {
  assertSnapshotV1(snapshot);
  const normalized = observation && typeof observation.status === 'string'
    ? observation
    : normalizeHoverOnlyProbe(observation);
  const byNodeId = new Map(normalized.groups.map(group => [group.nodeId, group]));
  const nodes = snapshot.nodes.map(node => {
    const group = byNodeId.get(String(node.nodeId));
    if (!group || group.outcome === 'passed') return node;
    return {
      ...node,
      attributes: { ...node.attributes },
      children: [...node.children],
      [HOVER_ONLY_OBSERVATION_KEY]: {
        outcome: group.outcome,
        targetCount: group.targetCount,
        revealedOnHover: group.revealedOnHover,
      },
    };
  });
  return assertSnapshotV1({
    schemaVersion: 1,
    document: { ...snapshot.document, [HOVER_ONLY_OBSERVATION_KEY]: normalized },
    nodes,
  });
}

/**
 * Gancho único do pipeline: roda a sondagem e devolve o snapshot enriquecido. Nunca lança — uma falha
 * vira observação incompleta, e o item segue para revisão humana com o motivo declarado.
 */
export async function applyHoverOnlyProbe(snapshot, cdp, options = {}) {
  let raw;
  try {
    raw = await runHoverOnlyProbe(cdp, { limits: options.limits });
  } catch {
    raw = { status: 'incomplete', warnings: [FAILED_WARNING] };
  }
  return mergeHoverOnlyIntoSnapshot(snapshot, normalizeHoverOnlyProbe(raw));
}

export { HOVER_ONLY_OBSERVATION_KEY };
