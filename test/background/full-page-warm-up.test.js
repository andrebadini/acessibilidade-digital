import assert from 'node:assert/strict';
import test from 'node:test';

import { FULL_PAGE_WARM_UP, establishWidenedLayout, restoreRenderedViewport, warmUpFullPageLayout } from '../../src/background/full-page-warm-up.js';

const METRICS = altura => ({
  cssContentSize: { width: 800, height: altura },
  cssLayoutViewport: { clientWidth: 800, clientHeight: 600 },
  cssVisualViewport: { clientWidth: 800, clientHeight: 600 },
});

/**
 * Relógio e espera falsos: o teste não pode depender de tempo real. Cada `delay(ms)` empurra o relógio,
 * e cada leitura de métricas também — é assim que o teto de 3 s termina sem esperar 3 s de verdade.
 */
function harness({ alturas, captureFailure = null, metricsFailure = null, signal = undefined } = {}) {
  const calls = [];
  const clock = { ms: 1_000 };
  const fila = [...alturas];
  let leituraAtual = fila.length > 0 ? fila[0] : 1_200;
  let indice = 0;
  const cdp = {
    async command(method, params = {}) {
      calls.push([method, params]);
      if (method === 'Page.getLayoutMetrics') {
        if (metricsFailure) throw metricsFailure;
        if (indice < fila.length) leituraAtual = fila[indice];
        indice += 1;
        clock.ms += 30;
        return METRICS(leituraAtual);
      }
      if (method === 'Page.captureScreenshot') {
        if (captureFailure) throw captureFailure;
        return { data: 'QUJDREVGR0g=' };
      }
      return {};
    },
  };
  const step = async operation => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Operação cancelada.', 'AbortError');
    const value = await operation();
    if (signal?.aborted) throw signal.reason ?? new DOMException('Operação cancelada.', 'AbortError');
    return value;
  };
  const delay = async ms => { clock.ms += ms; };
  return { cdp, step, delay, calls, clock, now: () => clock.ms };
}

test('aquece a página com uma captura descartável, em jpeg de escala pequena, e confirma o tamanho', async () => {
  const h = harness({ alturas: [1_200, 1_200] });
  const resultado = await warmUpFullPageLayout({ cdp: h.cdp, step: h.step, delay: h.delay, now: h.now });

  assert.deepEqual(h.calls.slice(0, 3).map(([method]) => method),
    ['Page.getLayoutMetrics', 'Page.captureScreenshot', 'Page.getLayoutMetrics']);
  const params = h.calls[1][1];
  assert.equal(params.format, 'jpeg', 'a captura de aquecimento não gera evidência: é jpeg');
  assert.equal(params.captureBeyondViewport, true, 'é o modo que acorda o conteúdo preguiçoso');
  assert.equal(params.fromSurface, true);
  assert.ok(params.quality >= 1 && params.quality <= 100);
  assert.deepEqual(params.clip, { x: 0, y: 0, width: 800, height: 1_200, scale: FULL_PAGE_WARM_UP.scale });
  assert.ok(params.clip.scale <= 0.1, 'a escala precisa ser pequena para o aquecimento custar pouco');

  assert.deepEqual({ ran: resultado.ran, settled: resultado.settled, reason: resultado.reason },
    { ran: true, settled: true, reason: 'settled' });
  assert.equal(resultado.heightBefore, 1_200);
  assert.equal(resultado.heightAfter, 1_200);
  assert.ok(resultado.elapsedMs > 0, 'o custo é medido');
});

test('os bytes do aquecimento são descartados: o resultado da captura nunca é lido', async () => {
  let lido = 0;
  const relogio = { ms: 1_000 };
  const cdp = {
    async command(method) {
      if (method === 'Page.getLayoutMetrics') return METRICS(1_200);
      return {
        get data() { lido += 1; return 'QUJDREVGR0g='; },
        get metadata() { lido += 1; return { width: 1_200 }; },
      };
    },
  };
  const resultado = await warmUpFullPageLayout({
    cdp, step: async operation => operation(), delay: async ms => { relogio.ms += ms; }, now: () => relogio.ms,
  });
  assert.equal(lido, 0, 'nem o campo data nem o resto do resultado da captura podem ser tocados');
  const serializado = JSON.stringify(resultado);
  assert.doesNotMatch(serializado, /QUJDREVGR0g|data|dataUrl|hash|evidenceId/u);
  assert.deepEqual(Object.keys(resultado).sort(),
    ['elapsedMs', 'heightAfter', 'heightBefore', 'ran', 'reads', 'reason', 'settled']);
});

test('espera a altura sustentar o mesmo valor pela janela inteira, com tolerância de 8 px', async () => {
  // 2.400 → 2.407 é diferença de 7 px: dentro da tolerância, o valor conta como o mesmo e o relógio da
  // estabilidade não recomeça.
  const h = harness({ alturas: [2_400, 2_407] });
  const resultado = await warmUpFullPageLayout({ cdp: h.cdp, step: h.step, delay: h.delay, now: h.now });
  assert.equal(resultado.settled, true);
  assert.equal(resultado.reason, 'settled');
  assert.equal(resultado.heightAfter, 2_407);
  assert.equal(h.calls.filter(([method]) => method === 'Page.captureScreenshot').length, 1);
});

test('uma pausa curta no crescimento não engana a espera', async () => {
  // A loja on-line cresce em degraus e faz pausas de até ~750 ms entre eles. Três leituras paradas em
  // 2.400 px e depois um degrau para 3.000 px: quem saísse na pausa devolveria 2.400 e o crescimento
  // seguinte cairia no meio da leitura estrutural — medido, era isso que deixava o mapa sem caixa nenhuma.
  const h = harness({ alturas: [2_400, 2_400, 2_400, 2_400, 3_000, 3_000, 3_000, 3_000, 3_000, 3_000, 3_000, 3_000, 3_000, 3_000] });
  const resultado = await warmUpFullPageLayout({ cdp: h.cdp, step: h.step, delay: h.delay, now: h.now });
  assert.equal(resultado.heightBefore, 2_400);
  assert.equal(resultado.heightAfter, 3_000, 'a espera precisa enxergar o degrau e não sair na pausa');
  assert.equal(resultado.settled, true);
  assert.equal(resultado.reason, 'settled');
  assert.ok(resultado.elapsedMs >= FULL_PAGE_WARM_UP.stableForMs,
    `a janela de confirmação precisa ser respeitada: ${resultado.elapsedMs} ms`);
});

test('uma página que não para de crescer esbarra no teto de 3 s sem travar a auditoria', async () => {
  const h = harness({ alturas: Array.from({ length: 200 }, (_, indice) => 1_000 + indice * 120) });
  const resultado = await warmUpFullPageLayout({ cdp: h.cdp, step: h.step, delay: h.delay, now: h.now });
  assert.equal(resultado.ran, true);
  assert.equal(resultado.settled, false);
  assert.equal(resultado.reason, 'ceiling');
  assert.ok(resultado.elapsedMs <= FULL_PAGE_WARM_UP.ceilingMs,
    `o teto precisa segurar o aquecimento: ${resultado.elapsedMs} ms`);
  // Uma leitura inicial mais uma por intervalo de 150 ms dentro de 3 s: nada de laço sem fim.
  assert.ok(resultado.reads <= Math.ceil(FULL_PAGE_WARM_UP.ceilingMs / FULL_PAGE_WARM_UP.intervalMs) + 1,
    `leituras demais: ${resultado.reads}`);
  assert.equal(h.calls.filter(([method]) => method === 'Page.captureScreenshot').length, 1,
    'a captura barata acontece uma vez só');
});

test('cancelamento no meio do aquecimento atravessa, em vez de virar falha silenciosa', async () => {
  const controlador = new AbortController();
  const h = harness({ alturas: [1_200, 1_400, 1_600], signal: controlador.signal });
  const execucao = warmUpFullPageLayout({ cdp: h.cdp, step: h.step, delay: h.delay, now: h.now, signal: controlador.signal });
  controlador.abort(new DOMException('Operação cancelada.', 'AbortError'));
  await assert.rejects(execucao, error => error?.name === 'AbortError');
});

test('sem tamanho de página o aquecimento nem dispara a captura', async () => {
  const calls = [];
  const cdp = { async command(method) { calls.push(method); return { cssContentSize: { width: 0, height: 0 } }; } };
  const resultado = await warmUpFullPageLayout({
    cdp, step: async operation => operation(), delay: async () => {}, now: () => 0,
  });
  assert.deepEqual({ ran: resultado.ran, reason: resultado.reason }, { ran: false, reason: 'size-unavailable' });
  assert.deepEqual(calls, ['Page.getLayoutMetrics']);
});

test('qualquer outra falha é silenciosa: a auditoria segue como antes do aquecimento', async () => {
  const erroDeCaptura = harness({ alturas: [1_200, 1_200], captureFailure: new Error('CDP_COMMAND_FAILED') });
  const semCaptura = await warmUpFullPageLayout({
    cdp: erroDeCaptura.cdp, step: erroDeCaptura.step, delay: erroDeCaptura.delay, now: erroDeCaptura.now,
  });
  assert.deepEqual({ ran: semCaptura.ran, settled: semCaptura.settled, reason: semCaptura.reason },
    { ran: false, settled: false, reason: 'failed' });

  const erroDeLeitura = harness({ alturas: [1_200, 1_200], metricsFailure: new Error('CDP_COMMAND_FAILED') });
  const semLeitura = await warmUpFullPageLayout({
    cdp: erroDeLeitura.cdp, step: erroDeLeitura.step, delay: erroDeLeitura.delay, now: erroDeLeitura.now,
  });
  assert.deepEqual({ ran: semLeitura.ran, settled: semLeitura.settled, reason: semLeitura.reason },
    { ran: false, settled: false, reason: 'failed' });
});

test('sem cliente CDP ou sem passo da auditoria o aquecimento é simplesmente pulado', async () => {
  for (const entrada of [{}, { cdp: {}, step: async operation => operation() }, { cdp: { async command() { return {}; } } }]) {
    const resultado = await warmUpFullPageLayout(entrada);
    assert.deepEqual({ ran: resultado.ran, reason: resultado.reason }, { ran: false, reason: 'size-unavailable' });
    assert.equal(resultado.reads, 0);
  }
});

test('fixa o leiaute alargado com a mesma captura descartável do aquecimento', async () => {
  const h = harness({ alturas: [1_200] });
  const resultado = await establishWidenedLayout({ cdp: h.cdp, step: h.step });

  assert.deepEqual({ ran: resultado.ran, reason: resultado.reason }, { ran: true, reason: 'widened' });
  assert.deepEqual(h.calls.map(([method]) => method), ['Page.getLayoutMetrics', 'Page.captureScreenshot']);
  const params = h.calls[1][1];
  assert.equal(params.format, 'jpeg', 'os bytes são descartados: não é captura de evidência');
  assert.equal(params.captureBeyondViewport, true, 'é este modo que tira a barra de rolagem e alarga o leiaute');
  assert.equal(params.fromSurface, true);
  assert.deepEqual(params.clip, { x: 0, y: 0, width: 800, height: 1_200, scale: FULL_PAGE_WARM_UP.scale });
  assert.ok(params.clip.scale <= 0.1, 'a captura descartável precisa custar pouco');
});

test('sem tamanho de página o alargamento nem dispara a captura', async () => {
  const calls = [];
  const cdp = { async command(method) { calls.push(method); return { cssContentSize: { width: 0, height: 0 } }; } };
  const resultado = await establishWidenedLayout({ cdp, step: async operation => operation() });
  assert.deepEqual({ ran: resultado.ran, reason: resultado.reason }, { ran: false, reason: 'size-unavailable' });
  assert.deepEqual(calls, ['Page.getLayoutMetrics']);
});

test('falha no alargamento é silenciosa: a auditoria segue com o comportamento anterior', async () => {
  const h = harness({ alturas: [1_200], captureFailure: new Error('CDP_COMMAND_FAILED') });
  const resultado = await establishWidenedLayout({ cdp: h.cdp, step: h.step });
  assert.deepEqual({ ran: resultado.ran, reason: resultado.reason }, { ran: false, reason: 'failed' });
});

test('cancelamento no alargamento atravessa, em vez de virar falha silenciosa', async () => {
  const controlador = new AbortController();
  const h = harness({ alturas: [1_200], signal: controlador.signal });
  const execucao = establishWidenedLayout({ cdp: h.cdp, step: h.step, signal: controlador.signal });
  controlador.abort(new DOMException('Operação cancelada.', 'AbortError'));
  await assert.rejects(execucao, error => error?.name === 'AbortError');
});

test('sem cliente CDP ou sem passo da auditoria o alargamento é simplesmente pulado', async () => {
  for (const entrada of [{}, { cdp: {}, step: async operation => operation() }, { cdp: { async command() { return {}; } } }]) {
    const resultado = await establishWidenedLayout(entrada);
    assert.deepEqual({ ran: resultado.ran, reason: resultado.reason }, { ran: false, reason: 'unavailable' });
  }
});

// ------------------------------------------------------------------ reposição da área de renderização
//
// A captura com `captureBeyondViewport` esconde a barra de rolagem e deixa a página ~15 px mais larga; no
// Chrome 152 o estado continua valendo depois dela. O que estes testes fixam: a reposição instala uma
// sobreposição DIFERENTE (medida: com a mesma, o navegador não recalcula nada) e a limpa em seguida, sem
// tocar na largura — e não mexe na página quando não há barra de rolagem para perder. A sobreposição usa a
// ÁREA VISÍVEL, não o conteúdo: medida no Chrome 152, a do tamanho do conteúdo tira a rolagem da página por
// um instante e ela perde e recupera a posição (dois eventos de `scroll`), coisa que o mapa do teclado não
// pode provocar.

test('repõe a área de renderização instalando uma sobreposição diferente e limpando-a', async () => {
  const calls = [];
  const cdp = { async command(method, params = {}) { calls.push([method, params]); return METRICS(2_400); } };
  const resultado = await restoreRenderedViewport({ cdp, step: async operation => operation() });

  assert.deepEqual({ ran: resultado.ran, reason: resultado.reason }, { ran: true, reason: 'restored' });
  assert.deepEqual(calls.map(([method]) => method),
    ['Page.getLayoutMetrics', 'Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride']);
  const params = calls[1][1];
  assert.equal(params.width, 800, 'a largura é preservada: é dela que dependem srcset e consultas de mídia');
  assert.equal(params.height, 599, 'a altura parte da área visível (600) e difere dela, senão não recalcula');
  assert.ok(params.height < 2_400,
    'a sobreposição não pode ter a altura do conteúdo: isso tira a rolagem da página por um instante');
  assert.equal(params.mobile, false);
  assert.equal(params.deviceScaleFactor, 1);
});

test('página que não rola não é tocada: sem barra de rolagem não havia o que perder', async () => {
  const calls = [];
  const cdp = { async command(method) { calls.push(method); return METRICS(600); } };
  const resultado = await restoreRenderedViewport({ cdp, step: async operation => operation() });
  assert.deepEqual({ ran: resultado.ran, reason: resultado.reason }, { ran: false, reason: 'no-scrollbar' });
  assert.deepEqual(calls, ['Page.getLayoutMetrics']);
});

test('sem tamanho de página a reposição não chega a instalar sobreposição', async () => {
  const calls = [];
  const cdp = { async command(method) { calls.push(method); return { cssContentSize: { width: 0, height: 0 } }; } };
  const resultado = await restoreRenderedViewport({ cdp, step: async operation => operation() });
  assert.deepEqual({ ran: resultado.ran, reason: resultado.reason }, { ran: false, reason: 'size-unavailable' });
  assert.deepEqual(calls, ['Page.getLayoutMetrics']);
});

test('sem a área visível a reposição não adivinha tamanho: pula em vez de instalar sobreposição', async () => {
  const calls = [];
  const cdp = {
    async command(method) {
      calls.push(method);
      return { cssContentSize: { width: 800, height: 2_400 } };
    },
  };
  const resultado = await restoreRenderedViewport({ cdp, step: async operation => operation() });
  assert.deepEqual({ ran: resultado.ran, reason: resultado.reason }, { ran: false, reason: 'size-unavailable' });
  assert.deepEqual(calls, ['Page.getLayoutMetrics']);
});

test('falha na reposição é silenciosa, e cancelamento atravessa', async () => {
  const falha = { async command() { throw new Error('CDP_COMMAND_FAILED'); } };
  const resultado = await restoreRenderedViewport({ cdp: falha, step: async operation => operation() });
  assert.deepEqual({ ran: resultado.ran, reason: resultado.reason }, { ran: false, reason: 'failed' });

  const controlador = new AbortController();
  controlador.abort(new DOMException('Operação cancelada.', 'AbortError'));
  const cdp = {
    async command() {
      throw new DOMException('Operação cancelada.', 'AbortError');
    },
  };
  await assert.rejects(
    restoreRenderedViewport({ cdp, step: async operation => operation(), signal: controlador.signal }),
    error => error?.name === 'AbortError');
});

test('sem cliente CDP ou sem passo da auditoria a reposição é simplesmente pulada', async () => {
  for (const entrada of [{}, { cdp: {}, step: async operation => operation() }, { cdp: { async command() { return {}; } } }]) {
    const resultado = await restoreRenderedViewport(entrada);
    assert.deepEqual({ ran: resultado.ran, reason: resultado.reason }, { ran: false, reason: 'unavailable' });
  }
});
