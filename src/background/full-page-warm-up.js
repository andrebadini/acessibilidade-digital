/**
 * Aquecimento de página inteira (1.1.60).
 *
 * Por que existe: em páginas que montam conteúdo sob demanda (vitrines de loja, listas que se completam),
 * é a própria captura integral que "acorda" o resto da página — a captura amplia a área de renderização e o
 * site então carrega os blocos que faltavam. Medido na versão 1.1.59: a página da loja on-line crescia
 * +131 px DURANTE a captura e 254 de 479 âncoras mudavam de lugar. Como a captura passou a sair colada na
 * leitura da estrutura, esse crescimento cai justamente no intervalo comparado por `mapSourceGeometry`: a
 * imagem é de um estado e os retângulos de outro, o acordo falha e o mapa sai sem nenhuma caixa.
 *
 * O que faz: dispara a montagem preguiçosa ANTES da coleta, com uma captura descartável e barata, e espera
 * a altura da página parar de mudar. Quando a coleta e a captura de verdade acontecem em seguida, a página
 * já está no estado final e as duas concordam — o mapa volta a marcar, alinhado.
 *
 * Limites deliberados:
 * - Os bytes da captura de aquecimento são DESCARTADOS: nada é lido do resultado, nada é guardado,
 *   hasheado, exportado ou transformado em artefato/evidência. É por isso que este módulo não passa pelo
 *   limite de raster privado: ele não é uma captura de evidência, é um estímulo à página.
 * - Nenhuma falha aqui aparece para quem usa: qualquer erro que não seja cancelamento é engolido e o fluxo
 *   normal continua (a auditoria segue com o comportamento de 1.1.59, caixa só quando houver acordo).
 * - Cancelamento (abort) atravessa: quem interrompeu a auditoria precisa parar de verdade.
 */

/**
 * Parâmetros medidos na loja on-line: ver docs/qa/mapa-alinhado-1.1.60.md, seção do aquecimento.
 *
 * `stableForMs` não é enfeite. A loja cresce em degraus e faz pausas de até ~750 ms entre eles: com a
 * regra de "duas leituras seguidas" (150 ms entre elas), a espera saía na primeira pausa — medido, saía
 * com 385 ms e a página em 2.350 px — e o crescimento continuava depois, durante a leitura estrutural, o
 * que deixava o instantâneo e a captura em estados diferentes e o mapa sem caixa nenhuma. Exigir que o
 * MESMO valor se sustente por uma janela maior que a pausa mede a mesma coisa que a regra pedia (a altura
 * parou) sem ser enganado pelo degrau seguinte.
 */
export const FULL_PAGE_WARM_UP = Object.freeze({
  scale: 0.05,
  quality: 40,
  intervalMs: 150,
  ceilingMs: 3_000,
  heightTolerancePx: 8,
  stableForMs: 1_000,
});

/** Só a medida em pixels CSS interessa aqui: largura e altura têm de ser números positivos. */
function contentOf(metrics) {
  const size = metrics?.cssContentSize || metrics?.contentSize || {};
  const width = size.width;
  const height = size.height;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return null;
  return { width, height };
}

function isCancellation(error, signal) {
  return signal?.aborted === true || error?.name === 'AbortError';
}

/**
 * Executa o aquecimento e devolve o que foi medido para os testes e para a QA.
 * Nada do retorno entra no modelo da auditoria (o catálogo de diagnósticos é fechado e não aceita números
 * internos): é medida de bastidor, não conteúdo de relatório.
 *
 * @returns {Promise<{ran: boolean, settled: boolean, elapsedMs: number, reads: number, reason: string,
 *   heightBefore: number|null, heightAfter: number|null}>}
 *   `reason`: 'settled' (altura estável em duas leituras seguidas) | 'ceiling' (teto de tempo) |
 *   'size-unavailable' (a página não informou tamanho) | 'failed' (erro no meio, engolido).
 */
export async function warmUpFullPageLayout({
  cdp, step, signal, now = () => Date.now(), delay,
} = {}) {
  const empty = {
    ran: false, settled: false, elapsedMs: 0, reads: 0,
    reason: 'size-unavailable', heightBefore: null, heightAfter: null,
  };
  if (!cdp || typeof cdp.command !== 'function' || typeof step !== 'function') return empty;
  const wait = typeof delay === 'function'
    ? delay
    : milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const startedAt = now();
  const elapsed = () => Math.max(0, now() - startedAt);
  let before = null;
  let after = null;
  let reads = 0;
  let captured = false;
  try {
    const metrics = await step(() => cdp.command('Page.getLayoutMetrics', {}));
    reads += 1;
    const initial = contentOf(metrics);
    if (!initial) return { ...empty, elapsedMs: elapsed(), reads };
    before = initial.height;
    after = initial.height;
    // Captura descartável: jpeg de qualidade baixa cobrindo o conteúdo inteiro numa escala pequena.
    // O resultado NÃO é atribuído a nada — os bytes morrem aqui.
    await step(() => cdp.command('Page.captureScreenshot', {
      format: 'jpeg', quality: FULL_PAGE_WARM_UP.quality, captureBeyondViewport: true, fromSurface: true,
      clip: { x: 0, y: 0, width: initial.width, height: initial.height, scale: FULL_PAGE_WARM_UP.scale },
    }));
    captured = true;
    const deadline = startedAt + FULL_PAGE_WARM_UP.ceilingMs;
    let previous = initial.height;
    let changedAt = startedAt;
    let settled = false;
    let reason = 'ceiling';
    // Teto de tempo próprio: páginas que crescem sem parar não podem segurar a auditoria. A condição exige
    // que a próxima espera caiba inteira dentro do teto — assim o total não passa do teto por causa da
    // última rodada, e sim, no máximo, do tempo de uma leitura de métricas.
    while (now() + FULL_PAGE_WARM_UP.intervalMs <= deadline) {
      await step(() => wait(FULL_PAGE_WARM_UP.intervalMs));
      const reading = contentOf(await step(() => cdp.command('Page.getLayoutMetrics', {})));
      reads += 1;
      if (!reading) { reason = 'size-unavailable'; break; }
      after = reading.height;
      // Mudou de altura: o relógio da estabilidade recomeça. Parada é o mesmo valor sustentado pela janela
      // inteira (por isso `changedAt` e não só a leitura anterior; ver `stableForMs`).
      if (Math.abs(after - previous) > FULL_PAGE_WARM_UP.heightTolerancePx) { previous = after; changedAt = now(); continue; }
      previous = after;
      if (now() - changedAt >= FULL_PAGE_WARM_UP.stableForMs) { settled = true; reason = 'settled'; break; }
    }
    return { ran: true, settled, elapsedMs: elapsed(), reads, reason, heightBefore: before, heightAfter: after };
  } catch (error) {
    if (isCancellation(error, signal)) throw error;
    return {
      ran: captured, settled: false, elapsedMs: elapsed(), reads,
      reason: 'failed', heightBefore: before, heightAfter: after,
    };
  }
}
