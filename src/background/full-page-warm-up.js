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
 * Captura descartável que deixa a área de renderização alargada — a mesma do aquecimento, e ao mesmo preço.
 * `captureBeyondViewport` amplia a área de renderização (a barra de rolagem clássica deixa de existir) e os
 * bytes não são lidos por ninguém: quem chama só quer o EFEITO na página, que é deixar o leiaute no estado
 * em que a captura de verdade vai acontecer.
 */
async function discardableWideCapture(cdp, step, size) {
  await step(() => cdp.command('Page.captureScreenshot', {
    format: 'jpeg', quality: FULL_PAGE_WARM_UP.quality, captureBeyondViewport: true, fromSurface: true,
    clip: { x: 0, y: 0, width: size.width, height: size.height, scale: FULL_PAGE_WARM_UP.scale },
  }));
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
    await discardableWideCapture(cdp, step, initial);
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

/**
 * Deixa o leiaute no estado alargado ANTES de a auditoria medir o instante da captura (1.1.62).
 *
 * Por que existe: `captureBeyondViewport` não só tira a imagem, ele muda a área de renderização — a barra de
 * rolagem clássica desaparece e o conteúdo fica ~15 px mais largo. Medido (ver docs/qa/
 * mapa-teclado-caixas-1.1.62.md): o estado alargado CONTINUA valendo depois da captura até que alguma coisa
 * obrigue a página a se rearranjar. Quem se rearranja é justamente a página que se monta sozinha — é o
 * conteúdo novo chegando que traz a barra de volta e devolve a largura original.
 *
 * O resultado, sem esta etapa: a auditoria mede o leiaute com barra (antes da captura), a captura acontece
 * sem barra, e a medida fresca dos retângulos (depois) vê o estado sem barra. As duas leituras discordam por
 * 15 px de largura — e por tudo que depende da largura, como a altura de uma imagem `width:100%`. A
 * discordância não é da página: é da própria captura. Antes da 1.1.62 ela bastava para o mapa sair sem
 * caixa nenhuma, e é exatamente o caso da página que cresceu entre a leitura e a captura.
 *
 * Fixar o estado antes da medida resolve na raiz: recorte, imagem e retângulos frescos passam a descrever o
 * MESMO leiaute, e as comparações de altura e largura em volta da captura voltam a medir o que prometem —
 * a página se mexeu, não a área de renderização.
 *
 * Falha aqui é silenciosa (a auditoria segue com o comportamento anterior), mas cancelamento atravessa.
 * Nada do retorno entra no modelo: o catálogo de diagnósticos é fechado e não carrega números internos.
 *
 * @returns {Promise<{ran: boolean, reason: string}>}
 */
export async function establishWidenedLayout({ cdp, step, signal } = {}) {
  if (!cdp || typeof cdp.command !== 'function' || typeof step !== 'function') {
    return { ran: false, reason: 'unavailable' };
  }
  try {
    const size = contentOf(await step(() => cdp.command('Page.getLayoutMetrics', {})));
    if (!size) return { ran: false, reason: 'size-unavailable' };
    await discardableWideCapture(cdp, step, size);
    return { ran: true, reason: 'widened' };
  } catch (error) {
    if (isCancellation(error, signal)) throw error;
    return { ran: false, reason: 'failed' };
  }
}

/**
 * Devolve a área de renderização ao estado em que a pessoa a deixou (1.1.62).
 *
 * Por que existe: `captureBeyondViewport` não só tira a imagem — ele esconde a barra de rolagem clássica e
 * deixa a página ~15 px mais larga, e no Chrome 152 esse estado CONTINUA valendo depois da captura (é a
 * mesma medição que motivou `establishWidenedLayout`). O saldo para quem audita a própria página é a página
 * terminar mais larga e sem barra de rolagem — exatamente o que o produto promete que NÃO acontece
 * (`DYNAMIC_PROBES_OMITTED_PASSIVE_MESSAGE`: "sem alterar foco, rolagem ou o layout final") e o que o
 * oráculo de fonte intocada do próprio projeto reprova. A oscilação da captura é declarada; a largura
 * final, não.
 *
 * Como repõe: `Emulation.clearDeviceMetricsOverride` sozinho NÃO desfaz a sobreposição que a captura
 * deixou — medido no Chrome 152, a página continua sem barra. O que repõe é instalar uma sobreposição
 * diferente da que está valendo e limpá-la em seguida: aí o navegador recalcula a área de renderização de
 * verdade.
 *
 * A sobreposição instalada aqui tem o tamanho da ÁREA VISÍVEL, com 1 px a menos de altura. Esse "1 px a
 * menos" é o que a torna diferente da que está valendo; e tomar a área visível — em vez do tamanho do
 * conteúdo, que é o que a captura usa — é o que evita um segundo efeito: com a área do tamanho do conteúdo
 * a página deixa de rolar por um instante, e uma página rolada perde e recupera a posição, com dois eventos
 * de `scroll`. A largura fica intacta: é dela que dependem `srcset`, consultas de mídia e o próprio recorte.
 *
 * Quando não faz nada: página que não rola (sem barra de rolagem não havia o que perder) e página que não
 * informou tamanho. Falha aqui é silenciosa — a auditoria já terminou —, mas cancelamento atravessa.
 *
 * @returns {Promise<{ran: boolean, reason: string}>}
 *   `reason`: 'restored' | 'no-scrollbar' | 'size-unavailable' | 'unavailable' | 'failed'.
 */
export async function restoreRenderedViewport({ cdp, step, signal } = {}) {
  if (!cdp || typeof cdp.command !== 'function' || typeof step !== 'function') {
    return { ran: false, reason: 'unavailable' };
  }
  try {
    const metrics = await step(() => cdp.command('Page.getLayoutMetrics', {}));
    const size = contentOf(metrics);
    if (!size) return { ran: false, reason: 'size-unavailable' };
    const visible = metrics?.cssVisualViewport ?? metrics?.visualViewport ?? {};
    const width = Number(visible.clientWidth ?? visible.width);
    const height = Number(visible.clientHeight ?? visible.height);
    if (!(width > 0) || !(height > 0)) return { ran: false, reason: 'size-unavailable' };
    // Sem conteúdo mais alto que a área visível não havia barra de rolagem para perder: mexer aqui seria
    // uma oscilação a mais por nada.
    if (size.height <= height + 1) return { ran: false, reason: 'no-scrollbar' };
    await step(() => cdp.command('Emulation.setDeviceMetricsOverride', {
      width: Math.round(width), height: Math.max(1, Math.round(height) - 1), deviceScaleFactor: 1, mobile: false,
    }));
    await step(() => cdp.command('Emulation.clearDeviceMetricsOverride', {}));
    return { ran: true, reason: 'restored' };
  } catch (error) {
    if (isCancellation(error, signal)) throw error;
    return { ran: false, reason: 'failed' };
  }
}
