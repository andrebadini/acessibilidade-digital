import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, launchUnpackedExtension, resolveRealChromeTestBinary, evaluate } from './support/real-chrome.mjs';

// A LACUNA DE INTEGRAÇÃO DOS ITENS DE FORMULÁRIO, medida ponta a ponta. O briefing de retomada dizia que
// o coletor produzia `record.form.required` enquanto a regra esperava `field.required`/`requiredIndicator`,
// e que a regra 5.9.8 esperava um `inputPurpose` que não era produzido. Medido (rodada 83): o coletor já
// entrega `required` e `requiredIndicator` no registro do nó, e a regra 5.9.8 lê o atributo `autocomplete`
// do próprio campo — as duas coisas funcionam ponta a ponta. Este arquivo torna essa integração DURÁVEL:
// sem ele, uma mudança futura no coletor pode matar a 5.9.8 em silêncio (o item cairia no checklist como
// "não observado" e ninguém veria a diferença), que é exatamente o risco que o briefing apontava.

const raiz = new URL('../../', import.meta.url);
const pagina = (corpo, titulo) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${titulo}</title></head>
<body><main><h1>${titulo}</h1>${corpo}</main></body></html>`;

const FORMULARIO = `<form>
  <p><label for="nome">Nome completo</label><input id="nome" name="nome" autocomplete="name" required></p>
  <p><label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="email"></p>
  <p><label for="telefone">Telefone</label><input id="telefone" name="telefone" type="tel"></p>
  <p><button type="submit">Enviar</button></p>
</form>`;

async function auditar(t, html) {
  const fixture = await startFixtureServer(t, new Map([
    ['/form', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html }],
  ]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(raiz)),
    startUrl: `${fixture.origin}/form`,
    chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
    viewport: { width: 1280, height: 900 }, downloadMode: 'profile',
  });
  const panel = await extension.openSidePanelFromAction();
  await panel.command('Page.bringToFront');
  await evaluate(panel, `new Promise(resolve => {
    const timer = setInterval(() => {
      const input = document.querySelector('input[data-capture-mode="no-pixels"]');
      const start = document.querySelector('button[data-intent="START_ATTACHED"]');
      if (input && !input.disabled && start && !start.disabled) { clearInterval(timer); resolve(true); }
    }, 100);
  })`, { awaitPromise: true });
  await extension.click(panel, 'input[data-capture-mode="no-pixels"]');
  await extension.click(panel, 'button[data-intent="START_ATTACHED"]');
  let screen = null;
  for (let attempt = 0; attempt < 120 && screen !== 'result'; attempt += 1) {
    screen = await evaluate(panel, `document.querySelector('[data-screen]')?.dataset.screen ?? null`).catch(() => null);
    if (screen !== 'result') await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(screen, 'result');
  const auditId = await extension.readAttribute(panel, '[data-screen="result"]', 'data-audit-id');
  assert.match(auditId ?? '', /^[A-Za-z0-9._:-]{1,160}$/u);
  const bruto = await evaluate(extension.harnessPage, `import(chrome.runtime.getURL('/src/storage/audit-store.js')).then(async module => {
    const store = module.createAuditStore();
    const snapshot = await store.getAuditSnapshot(${JSON.stringify(auditId)});
    const model = snapshot.model ?? snapshot.snapshot ?? snapshot;
    const ler = ruleId => {
      const regra = (model.ruleResults ?? []).find(entry => entry.ruleId === ruleId);
      return regra ? { outcome: regra.outcome, targets: (regra.targets ?? []).length,
        motivos: [...new Set((regra.targets ?? []).map(target => target.data?.reason ?? null))] } : null;
    };
    const item = id => (model.itemResults ?? []).find(entry => entry.id === id)?.outcome ?? null;
    return JSON.stringify({
      tipo: ler('input-purpose'), tipoItem: item('5.9.8'),
      obrigatorios: ler('required-field-identification'), obrigatoriosItem: item('5.9.7'),
      triagem: (model.session?.status ?? null),
    });
  })`, { awaitPromise: true });
  await extension.close();
  return JSON.parse(bruto);
}

test('5.9.8 passa quando TODOS os campos declaram finalidade válida', { timeout: 600_000 }, async t => {
  const completo = FORMULARIO.replace('<p><label for="telefone">Telefone</label><input id="telefone" name="telefone" type="tel"></p>',
    '<p><label for="telefone">Telefone</label><input id="telefone" name="telefone" type="tel" autocomplete="tel"></p>');
  const resultado = await auditar(t, pagina(completo, 'Finalidades completas'));
  t.diagnostic(`5.9.8 completo: regra=${resultado.tipo?.outcome} item=${resultado.tipoItem}`);
  assert.equal(resultado.tipo.outcome, 'passed');
  assert.equal(resultado.tipo.targets, 0);
  assert.equal(resultado.tipoItem, 'passed');
});

test('5.9.8 mantém sob revisão o campo sem declaração, sem reprovar ninguém', { timeout: 600_000 }, async t => {
  const resultado = await auditar(t, pagina(FORMULARIO, 'Campo sem declaração'));
  t.diagnostic(`5.9.8 sem declaração: regra=${resultado.tipo?.outcome} alvos=${resultado.tipo?.targets} item=${resultado.tipoItem}`);
  // O telefone não declara finalidade: a regra não pode passar (não observou tudo) nem reprovar (não
  // sabe se o campo coleta dado pessoal) — mantém sob revisão humana, que é a semântica do produto.
  assert.equal(resultado.tipo.outcome, 'cantTell');
  assert.equal(resultado.tipo.targets, 0);
  assert.equal(resultado.tipoItem, 'cantTell');
});

test('5.9.8 reprova o campo com token inválido e mantém o resto sob revisão', { timeout: 600_000 }, async t => {
  const resultado = await auditar(t, pagina(FORMULARIO.replace('autocomplete="name"', 'autocomplete="nao-existe"'), 'Token inválido'));
  t.diagnostic(`5.9.8 inválido: regra=${resultado.tipo?.outcome} alvos=${resultado.tipo?.targets} motivos=${JSON.stringify(resultado.tipo?.motivos)}`);
  assert.equal(resultado.tipo.outcome, 'failed');
  assert.equal(resultado.tipo.targets, 1);
  assert.deepEqual(resultado.tipo.motivos, ['invalid-or-missing-autocomplete']);
  assert.equal(resultado.tipoItem, 'failed');
});

test('5.9.7 mantém sob revisão o campo obrigatório sem marcação observada e não inventa falha', { timeout: 600_000 }, async t => {
  const resultado = await auditar(t, pagina(FORMULARIO, 'Obrigatório sem marcação'));
  t.diagnostic(`5.9.7: regra=${resultado.obrigatorios?.outcome} alvos=${resultado.obrigatorios?.targets} motivos=${JSON.stringify(resultado.obrigatorios?.motivos)}`);
  // `required` sem marcação perceptível: suspeita por campo (a marcação pode estar fora das fontes
  // observadas), nunca "Inconformidade" confirmada.
  assert.equal(resultado.obrigatorios.outcome, 'cantTell');
  assert.equal(resultado.obrigatorios.targets, 1);
  assert.deepEqual(resultado.obrigatorios.motivos, ['missing-required-identification']);
  assert.equal(resultado.obrigatoriosItem, 'cantTell');
});
