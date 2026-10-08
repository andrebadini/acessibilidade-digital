import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Duas mensagens medidas na revisão de páginas grandes (1.1.56): o segundo pedido de relatório durante uma
// exportação longa era recusado como se a geração tivesse falhado, e "Mostrar na página" era oferecido
// para elementos sem localização registrada, que só eram recusados depois do clique.
const source = await readFile(new URL('../../src/review/review.js', import.meta.url), 'utf8');

function functionSource(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`, 'u'));
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end + 2);
}

test('um pedido de relatório durante outra geração diz que há uma em andamento', () => {
  const context = {};
  runInNewContext(`${functionSource('describeExportFailure')}\nthis.describeExportFailure = describeExportFailure;`, context);
  assert.match(context.describeExportFailure('EXPORT_ALREADY_ACTIVE'), /Já há uma geração do relatório em andamento/u);
  assert.match(context.describeExportFailure('EXPORT_LEASE_DENIED'), /ainda está terminando/u);
  assert.equal(context.describeExportFailure('REPORT_OPERATION_FAILED'), 'Não foi possível gerar o relatório atualizado.');
  assert.equal(context.describeExportFailure(undefined), 'Não foi possível gerar o relatório atualizado.');
});

class Node {
  constructor(className = '') { this.className = className; this.hidden = false; this.isConnected = true; this.next = null; this.text = ''; }
  get classList() { return { contains: name => this.className.split(' ').includes(name) }; }
  after(node) { this.next = node; }
}

function environment(availability) {
  const show = new Node('lay-show');
  const card = new Node('lay-card');
  card.querySelector = selector => {
    if (selector === 'button.lay-show') return show;
    if (selector === '.lay-show-note') return show.next;
    return null;
  };
  const requests = [];
  const context = {
    reportSessionState: 'result',
    highlightAvailability: new Map(),
    highlightableOccurrence: () => 'occ-1',
    el: (tag, text, className) => Object.assign(new Node(className), { tag, text }),
    async handleReportHighlightIntent(intent, options) {
      requests.push({ intent, options });
      context.highlightAvailability.set('occ-1', availability);
      return true;
    },
  };
  runInNewContext(`${functionSource('checkShowOnPage')}\nthis.checkShowOnPage = checkShowOnPage;`, context);
  return { context, show, card, requests };
}

test('ao abrir o cartão, um elemento sem localização troca o botão por uma explicação', async () => {
  const env = environment({ state: 'unavailable', reason: 'no-binding' });
  await env.context.checkShowOnPage({}, env.card);
  assert.deepEqual(env.requests.map(request => request.intent.type), ['GET_HIGHLIGHT_AVAILABILITY']);
  assert.equal(env.requests[0].options.announce, false);
  assert.equal(env.show.hidden, true);
  assert.match(env.show.next.text, /não tem localização registrada para destaque/u);
  await env.context.checkShowOnPage({}, env.card);
  assert.equal(env.requests.length, 1, 'com o botão já trocado, não consulta de novo');
});

test('um elemento com destaque disponível, ou indisponível por outro motivo, mantém o botão', async () => {
  for (const availability of [
    { state: 'available' },
    { state: 'unavailable', reason: 'expired' },
    { state: 'unavailable', reason: 'live-proof-failed' },
  ]) {
    const env = environment(availability);
    await env.context.checkShowOnPage({}, env.card);
    assert.equal(env.show.hidden, false, JSON.stringify(availability));
    assert.equal(env.show.next, null);
  }
  const viewOnly = environment({ state: 'unavailable', reason: 'no-binding' });
  viewOnly.context.reportSessionState = 'view-only';
  await viewOnly.context.checkShowOnPage({}, viewOnly.card);
  assert.equal(viewOnly.requests.length, 0, 'sem a página auditada, não há consulta');
});
