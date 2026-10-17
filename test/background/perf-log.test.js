import assert from 'node:assert/strict';
import test from 'node:test';

import { clearPerfLog, perfBegin, perfCount, perfEnd, perfEnabled, perfWrapCdp, readPerfLog } from '../../src/background/perf-log.js';

/**
 * A instrumentação de desempenho existe para medir, não para custar. Estes testes fixam as duas
 * metades do contrato: com a chave desligada (o padrão de produção) nada é guardado e o cliente CDP
 * entregue é o próprio objeto recebido; com a chave ligada, as fases, contagens e o perfil por método
 * CDP aparecem no registro — e nenhum número sai daqui para o modelo, o relatório ou o IndexedDB.
 */

// `await run()` e não `return run()`: com a segunda forma o `finally` limparia a chave antes de a
// promessa resolver, e a medição do corpo assíncrono cairia em "desligada".
async function withPerf(enabled, run) {
  const previous = globalThis.__auditaPerf;
  clearPerfLog();
  if (enabled) globalThis.__auditaPerf = true;
  else delete globalThis.__auditaPerf;
  try {
    return await run();
  } finally {
    delete globalThis.__auditaPerf;
    clearPerfLog();
    if (previous !== undefined) globalThis.__auditaPerf = previous;
  }
}

function fakeCdp() {
  const calls = [];
  return {
    calls,
    async command(method) {
      calls.push(method);
      return { ok: method };
    },
    on() { return () => {}; },
    detached: false,
  };
}

test('a chave desligada não guarda nada e não envolve o cliente CDP', async () => {
  await withPerf(false, () => {
    assert.equal(perfEnabled(), false);
    assert.equal(perfBegin(), null);
    perfEnd('worker', 'fase', null);
    perfCount('worker', 'itens', 10);
    assert.deepEqual(readPerfLog(), []);

    const cdp = fakeCdp();
    const wrapped = perfWrapCdp(cdp, 'worker');
    assert.equal(wrapped, cdp, 'sem medição o objeto devolvido tem de ser o próprio cliente recebido');
    assert.equal(typeof globalThis.__auditaPerfFlushCdp, 'undefined', 'a porta de despejo só existe quando há o que despejar');
  });
});

test('a chave ligada registra a fase, a contagem e o detalhe', async () => {
  await withPerf(true, () => {
    const started = perfBegin();
    perfEnd('worker', 'evidencias', started, { occorrencias: 3 });
    perfCount('worker', 'bytes', 1_500.456, { tamanho: 10 });
    const log = readPerfLog();
    const fase = log.find(entry => entry.phase === 'evidencias');
    const contagem = log.find(entry => entry.phase === 'bytes');
    assert.equal(fase.scope, 'worker');
    assert.equal(typeof fase.value, 'number');
    assert.equal(fase.value >= 0, true);
    assert.deepEqual(fase.detail, { occorrencias: 3 });
    assert.equal(contagem.value, 1_500.46, 'o registro arredonda a duas casas');
    assert.equal(contagem.detail.tamanho, 10);
  });
});

test('o perfil CDP conta todas as chamadas de cada método', async () => {
  await withPerf(true, async () => {
    const wrapped = perfWrapCdp(fakeCdp(), 'auditoria');
    await wrapped.command('Page.captureScreenshot');
    await wrapped.command('Page.captureScreenshot');
    await wrapped.command('DOM.getOuterHTML');
    const log = readPerfLog();
    const captura = log.find(entry => entry.phase === 'cdp:Page.captureScreenshot');
    const trecho = log.find(entry => entry.phase === 'cdp:DOM.getOuterHTML');
    // `Map.set` devolve o mapa, não a entrada: incrementar o retorno de `set` somava no próprio mapa e a
    // tabela saía com zero chamadas.
    assert.equal(captura.detail.count, 2);
    assert.equal(trecho.detail.count, 1);
    assert.equal(captura.value >= 0, true);
  });
});

test('membros do cliente CDP que não são `command` atravessam sem toque', async () => {
  await withPerf(true, () => {
    const cdp = fakeCdp();
    const wrapped = perfWrapCdp(cdp, 'auditoria');
    assert.equal(wrapped.detached, false);
    const off = wrapped.on('Page.frameNavigated', () => {});
    assert.equal(typeof off, 'function');
    assert.equal(cdp.calls.length, 0);
  });
});

test('a segunda leitura do registro devolve o mesmo conteúdo e o perfil não conta duas vezes', async () => {
  await withPerf(true, async () => {
    const wrapped = perfWrapCdp(fakeCdp(), 'auditoria');
    await wrapped.command('Runtime.evaluate');
    assert.equal(readPerfLog().filter(entry => entry.phase === 'cdp:Runtime.evaluate').length, 1);
    assert.equal(readPerfLog().filter(entry => entry.phase === 'cdp:Runtime.evaluate').length, 1,
      'o despejo é idempotente: o perfil acumulado não pode ser somado de novo a cada leitura');
  });
});
