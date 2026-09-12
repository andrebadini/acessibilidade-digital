import assert from 'node:assert/strict';
import test from 'node:test';
import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import { accessibilityGuidance as guidance } from '../../src/core/report/plain-language-guidance.js';

test('explains recommendation versus requirement without changing the original observation', () => {
  const observed = 'Amostra registrada: contraste 6,39:1.';
  const recommended = guidance({ itemId: '5.11.2', outcome: 'failed', observed });
  const required = guidance({ itemId: '5.11.3', outcome: 'cantTell', observed });
  assert.ok(recommended.observed.includes(observed));
  assert.match(recommended.reviewSteps.join(' '), /recomendação.*conformidade regular/is);
  assert.match(required.reviewSteps.join(' '), /requisito.*conformidade regular/is);
  assert.match(required.observed, /não confirma atendimento nem falha/);
  assert.match(recommended.reviewSteps.join(' '), /5\.11\.3.*4,5:1.*3:1/);
  assert.match(recommended.reviewSteps.join(' '), /5\.11\.2.*7:1.*4,5:1/);
  assert.match(recommended.example, /hipotético.*6,39:1/);
  assert.doesNotMatch(recommended.observed, /mínimo atendido|site acessível/i);
  assert.match(recommended.reviewSteps.join(' '), /justificativa razoável/);
});

test('alignment review covers reading direction and essential presentation instead of only justification', () => {
  const result = guidance({ itemId: '5.12.5', outcome: 'cantTell', observed: 'Parágrafo centralizado.' });
  const instructions = result.reviewSteps.join(' ');
  assert.match(instructions, /português.*esquerda/is);
  assert.match(instructions, /(?:árabe|hebraico).*direita/is);
  assert.match(instructions, /essencial.*compreen/is);
  assert.match(instructions, /recomendação/);
  assert.ok(result.observed.includes('Parágrafo centralizado.'));
});

test('graphic contrast guidance explains relevant parts, adjacent colors and essential presentation', () => {
  const result = guidance({ itemId: '5.11.5', outcome: 'cantTell' });
  const instructions = result.reviewSteps.join(' ');
  assert.match(instructions, /partes.*necessárias/is);
  assert.match(instructions, /3:1/);
  assert.match(instructions, /adjacentes|entre si/);
  assert.match(instructions, /essencial/);
  assert.match(result.example, /gráfico|mapa/);
  assert.match(result.observed, /não confirma/);
});

// Catches evidence being replaced by a topic's hypothetical failure.
test('preserves supplied evidence verbatim when explaining a failure', () => {
  const observed = 'Botão #buscar: razão medida 2.1:1; amostra parcial.\nEstado: aberto.';
  const result = guidance({ itemId: '5.11.4', outcome: 'failed', observed, correction: 'Rever a borda de #buscar.' });
  assert.ok(result.observed.includes(observed));
  assert.ok(result.correction.includes('Rever a borda de #buscar.'));
});

// Catches pending results receiving the same definitive repair as a failure.
for (const outcome of ['cantTell', 'untested']) {
  test(`${outcome} keeps the conclusion open and makes correction conditional`, () => {
    const result = guidance({ itemId: '5.2.1', outcome, correction: 'Descreva a imagem.' });
    assert.match(result.observed, /não (?:confirma|foi avaliado)/i);
    assert.match(result.correction, /se .*confirm/i);
    assert.doesNotMatch(result.observed, /imagem (?:está|sem)|falha confirmada/i);
  });
}

// Catches imposing the supplied repair even when this result passed or does not apply.
for (const outcome of ['passed', 'inapplicable']) {
  test(`${outcome} does not mandate a correction`, () => {
    const result = guidance({ itemId: '5.1.1', outcome, correction: 'Adicione um contorno.' });
    assert.doesNotMatch(result.correction, /Adicione um contorno/);
    assert.match(result.correction, /nenhuma correção/i);
  });
}

// Catches routing all findings to a generic keyboard/image instruction or using the untrusted title to route.
test('routes verified items to relevant review actions and hypothetical examples', () => {
  const focus = guidance({ itemId: '5.1.1', title: 'Imagem', outcome: 'cantTell' });
  const image = guidance({ itemId: '5.2.1', outcome: 'cantTell' });
  const link = guidance({ itemId: '5.7.4', outcome: 'cantTell' });
  const contrast = guidance({ itemId: '5.11.3', outcome: 'cantTell' });
  assert.match(focus.reviewSteps.join(' '), /Tab/);
  assert.match(image.reviewSteps.join(' '), /imagem/);
  assert.match(link.reviewSteps.join(' '), /destino/);
  assert.match(contrast.reviewSteps.join(' '), /contraste/);
  for (const result of [focus, image, link, contrast]) {
    assert.match(result.example, /hipotético/i);
    assert.ok(result.impact.length > 30);
  }
});

// Catches treating a decorative image as missing a mandatory description.
test('decorative image guidance distinguishes decoration from meaningful content', () => {
  const result = guidance({ itemId: '5.2.3', outcome: 'failed' });
  assert.match(result.reviewSteps.join(' '), /decorativ/);
  assert.match(result.correction, /ignora|vazio/);
});

// Catches family fallbacks silently dropping the actual item under review.
test('every catalogue item retains its own topic in actionable family guidance', () => {
  for (const item of NBR17225_ITEMS) {
    const result = guidance({ itemId: item.id, outcome: 'cantTell' });
    assert.ok(result.reviewSteps.join(' ').includes(item.title), item.id);
    assert.ok(result.reviewSteps.length >= 2, item.id);
    assert.match(result.example, /hipotético/i, item.id);
  }
});

// Catches inventing a normative topic from an unknown numeric prefix or claiming unobserved facts.
test('unknown items use a safe generic review and do not invent observations', () => {
  const result = guidance({ itemId: '5.2.999', title: 'Verificação local', outcome: 'failed' });
  assert.match(result.observed, /sem descrição|não foi fornecida/i);
  assert.doesNotMatch(result.correction, /alt=|imagem/);
  assert.ok(result.reviewSteps.join(' ').includes('Verificação local'));
});

test('page and passage languages explain declaration, pronunciation and review limits', () => {
  const page = guidance({ itemId: '5.13.2', outcome: 'cantTell' });
  const passage = guidance({ itemId: '5.13.3', outcome: 'cantTell' });
  assert.match(page.impact, /pronúncia/);
  assert.match(page.reviewSteps.join(' '), /idioma declarado/);
  assert.match(page.example, /pt-BR/);
  assert.match(passage.reviewSteps.join(' '), /nomes próprios/);
  assert.match(passage.example, /inglês/);
  assert.doesNotMatch(page.correction, /Revise “/);
  assert.match(passage.correction, /trecho/);
});

test('abbreviations offer a concrete expansion and preserve recommendation status', () => {
  const result = guidance({ itemId: '5.12.11', outcome: 'cantTell' });
  assert.match(result.reviewSteps.join(' '), /significado por extenso/);
  assert.match(result.example, /CPF.*Cadastro de Pessoas Físicas/);
  assert.match(result.correction, /recomenda|considere/i);
  assert.doesNotMatch(result.correction, /obrigat|sempre/i);
});

test('generic link review distinguishes context from a recommended standalone name', () => {
  const contextual = guidance({ itemId: '5.7.4', outcome: 'cantTell' });
  const standalone = guidance({ itemId: '5.7.3', outcome: 'cantTell' });
  assert.match(contextual.reviewSteps.join(' '), /parágrafo|frase/);
  assert.match(contextual.reviewSteps.join(' '), /não basta/i);
  assert.match(contextual.example, /clique aqui/i);
  assert.match(standalone.correction, /recomenda|considere/i);
  assert.match(standalone.reviewSteps.join(' '), /isolad/);
});

test('new-window review explains tabs and asks for a safe test without requiring them', () => {
  const result = guidance({ itemId: '5.7.6', outcome: 'cantTell' });
  assert.match(result.reviewSteps.join(' '), /nova (guia|aba)/);
  assert.match(result.reviewSteps.join(' '), /segur/);
  assert.match(result.correction, /recomenda|considere/i);
  assert.match(result.example, /abre em nova aba/i);
});

test('form labels separate visible instructions, position, association and description', () => {
  const label = guidance({ itemId: '5.9.1', outcome: 'cantTell' });
  const position = guidance({ itemId: '5.9.2', outcome: 'cantTell' });
  const association = guidance({ itemId: '5.9.3', outcome: 'cantTell' });
  const descriptive = guidance({ itemId: '5.9.4', outcome: 'cantTell' });
  assert.match(label.reviewSteps.join(' '), /desaparece|digitar/);
  assert.match(position.reviewSteps.join(' '), /posição|antes/);
  assert.match(association.reviewSteps.join(' '), /leitor de tela/);
  assert.match(association.correction, /associ/i);
  assert.match(descriptive.example, /Nome completo/);
});

test('button and accessible-name guidance explains icon-only controls without triggering actions', () => {
  for (const itemId of ['5.8.3', '5.13.10']) {
    const result = guidance({ itemId, outcome: 'cantTell' });
    assert.match(result.reviewSteps.join(' '), /nome acessível/);
    assert.match(result.reviewSteps.join(' '), /sem acionar/);
    assert.match(result.example, /lupa.*Buscar/);
  }
});

test('page titles and content headings receive different concrete procedures', () => {
  const page = guidance({ itemId: '5.13.1', outcome: 'cantTell' });
  assert.match(page.reviewSteps.join(' '), /aba do navegador/);
  assert.match(page.example, /Agendar atendimento/);
  const semantics = guidance({ itemId: '5.3.1', outcome: 'cantTell' });
  assert.match(semantics.reviewSteps.join(' '), /lista de (títulos|cabeçalhos)/);
  const purpose = guidance({ itemId: '5.3.2', outcome: 'cantTell' });
  assert.match(purpose.reviewSteps.join(' '), /assunto/);
  const structure = guidance({ itemId: '5.3.5', outcome: 'cantTell' });
  assert.match(structure.example, /Documentos.*Identificação/);
});

test('justified text explains visual spacing and a recommended alternative', () => {
  const result = guidance({ itemId: '5.12.5', outcome: 'cantTell' });
  assert.match(result.impact, /espaços/);
  assert.match(result.reviewSteps.join(' '), /duas margens/);
  assert.match(result.correction, /recomenda|considere/i);
  assert.match(result.example, /esquerda/);
});

test('additional-content recommendation checks another way to obtain the information, not a ban on all tips', () => {
  const result = guidance({ itemId: '5.1.7', outcome: 'cantTell' });
  assert.match(result.correction, /recomenda/u);
  assert.match(result.reviewSteps.join(' '), /Tab/u);
  assert.match(result.reviewSteps.join(' '), /mouse/u);
  assert.match(result.reviewSteps.join(' '), /outra forma/u);
  assert.match(result.reviewSteps.join(' '), /5\.1\.8.*5\.1\.9/u);
  assert.match(result.example, /ajuda/iu);
});

test('persistent-content review distinguishes a timer from allowed dismissal and obsolete information', () => {
  const result = guidance({ itemId: '5.1.8', outcome: 'cantTell' });
  const steps = result.reviewSteps.join(' ');
  assert.match(result.impact, /tempo.*ler/u);
  assert.match(steps, /sem mover.*mouse.*foco/u);
  assert.match(steps, /tempo observado/u);
  assert.match(steps, /deixou de ser válida/u);
  assert.match(steps, /dispens/u);
  assert.match(result.example, /some sozinha/u);
});

test('dismissible-content review includes a practical nonmoving test and both ABNT exceptions', () => {
  const result = guidance({ itemId: '5.1.9', outcome: 'cantTell' });
  const steps = result.reviewSteps.join(' ');
  assert.match(steps, /Esc/u);
  assert.match(steps, /sem mover.*mouse.*foco/u);
  assert.match(steps, /não é a única/u);
  assert.match(steps, /erro de (?:entrada|preenchimento)/u);
  assert.match(steps, /não oculta nem substitui/u);
  assert.match(result.example, /cobrindo/u);
});

for (const [itemId, topic, ratio, exampleValue] of [
  ['5.12.1', /linhas/u, /1,5/u, /24 pixels/u],
  ['5.12.2', /parágrafos/u, /2 vezes/u, /32 pixels/u],
  ['5.12.3', /letras/u, /0,12/u, /1,92 pixels/u],
  ['5.12.4', /palavras/u, /0,16/u, /2,56 pixels/u],
]) {
  test(`${itemId} explains its own spacing measurement, configuration alternative and limits`, () => {
    const result = guidance({ itemId, outcome: 'cantTell' });
    const steps = result.reviewSteps.join(' ');
    assert.match(result.impact, topic);
    assert.match(result.correction, ratio);
    assert.match(result.correction, /ou.*(?:configur|ajust)/u);
    assert.match(result.correction, /sem perda/u);
    assert.match(steps, /não.*(?:fotografia|captura)/u);
    assert.match(steps, /apoio técnico/u);
    assert.match(steps, /quatro.*juntos/u);
    assert.match(steps, /não exige um botão/u);
    assert.match(result.example, /16 pixels/u);
    assert.match(result.example, exampleValue);
    assert.doesNotMatch(result.example, /sigla/u);
  });
}

// Catch the generic assistive-technology fallback hiding each item's actual review task.
test('label-in-name guides a comparison of visible words and the recorded accessible name, not action activation', () => {
  const result = guidance({ itemId: '5.13.7', outcome: 'failed' });
  assert.match(result.impact, /comandos de voz/u);
  assert.match(result.reviewSteps.join(' '), /texto visível/u);
  assert.match(result.reviewSteps.join(' '), /nome acessível/u);
  assert.match(result.reviewSteps.join(' '), /sem acionar/u);
  assert.match(result.correction, /contenha.*texto visível/u);
  assert.match(result.example, /Buscar.*Pesquisar.*Buscar produtos/u);
  assert.doesNotMatch(result.correction, /Revise “/u);
});

test('reading sequence review includes ordinary text and does not equate Tab order with reading order', () => {
  const result = guidance({ itemId: '5.13.6', outcome: 'cantTell' });
  assert.match(result.reviewSteps.join(' '), /parágrafos/u);
  assert.match(result.reviewSteps.join(' '), /Tab.*não/u);
  assert.match(result.reviewSteps.join(' '), /sentido/u);
  assert.match(result.example, /colunas/u);
  assert.doesNotMatch(result.correction, /Revise “/u);
});

test('status-message review tests a safe dynamic update without requiring focus on the message', () => {
  const result = guidance({ itemId: '5.13.8', outcome: 'cantTell' });
  assert.match(result.reviewSteps.join(' '), /segur/u);
  assert.match(result.reviewSteps.join(' '), /sem mover.*foco/u);
  assert.match(result.reviewSteps.join(' '), /estimad.*não comprova/u);
  assert.match(result.example, /resultados encontrados/u);
  assert.doesNotMatch(result.correction, /Revise “/u);
});

test('specific instructions never convert hypothetical examples into evidence or pending into failure', () => {
  for (const itemId of ['5.1.7', '5.1.8', '5.1.9', '5.12.1', '5.12.2', '5.12.3', '5.12.4', '5.13.6', '5.13.7', '5.13.8', '5.13.2', '5.13.3', '5.12.11', '5.7.3', '5.7.4', '5.7.6', '5.9.1', '5.9.2', '5.9.3', '5.9.4', '5.8.3', '5.13.10', '5.13.1', '5.3.1', '5.3.2', '5.3.5', '5.12.5']) {
    const result = guidance({ itemId, outcome: 'cantTell', observed: 'Amostra registrada; revisão pendente.' });
    assert.equal(result.observed, 'O resultado disponível não confirma atendimento nem falha; é necessária revisão humana. Registro original: Amostra registrada; revisão pendente.', itemId);
    assert.match(result.correction, /^Se a revisão confirmar/, itemId);
    assert.match(result.example, /^Exemplo hipotético:/, itemId);
    assert.match(guidance({ itemId, outcome: 'passed' }).correction, /^Nenhuma correção/, itemId);
  }
});
