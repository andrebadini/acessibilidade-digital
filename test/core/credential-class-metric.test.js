import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeForMatching, hasCredentialValueSignal, redactCredentialLabelTail, redactSensitiveText, sanitizeJsonData } from '../../src/core/privacy.js';
import { sanitizeHtmlSnippetSource } from '../../src/core/evidence/snippet.js';
import { computeAccessibleText } from '../../src/core/accessibility/accessible-name.js';

// A MÉTRICA DA CLASSE, num arquivo só e com comando reproduzível:
//   node --test test/core/credential-class-metric.test.js
//
// A classe é "credencial da página chegando às superfícies entregues". Quatro revisões adversariais
// independentes (1.1.27, 1.1.28, 1.1.29, 1.1.30) mediram formas que sobreviviam; cada forma que elas
// mediram está aqui, mais variações próprias, nos quatro caminhos por onde o texto da página sai:
// trecho, JSON, nome acessível e URL. O teste é a resposta ao achado de que a métrica citada nos
// documentos não tinha comando nem artefato.
const S = (n) => `ADVSEN${n}X`;

const FORMAS = [
  ['A1 rótulo em nó + ": valor" no mesmo texto', `<p><b>senha</b>: ${S('01')}</p>`],
  ['A2 comentário entre rótulo e separador', `<p>senha<!-- c -->: ${S('02')}</p>`],
  ['A3 img com atributos entre separador e valor', `<p>senha:<img alt="i">${S('03')}</p>`],
  ['A4 span vazio entre separador e valor', `<p>senha:<span></span>${S('04')}</p>`],
  ['A5 nbsp entre rótulo e separador', `<p>senha&nbsp;: ${S('05')}</p>`],
  ['A6 rótulo com sufixo por espaço', `<p>Senha atual: ${S('06')}</p>`],
  ['A7 entidade aninhada', `<pre>{&amp;quot;senha&amp;quot;: &amp;quot;${S('07')}&amp;quot;}</pre>`],
  ['A9 rótulo em nó + espaço + valor', `<p><b>senha</b> ${S('09')}</p>`],
  ['A10 th/td vazio/td valor', `<table><tr><th>senha:</th><td></td><td>${S('10')}</td></tr></table>`],
  ['A11 JSON code', `<pre>{"code": "${S('11')}"}</pre>`],
  ['A12 JSON assertion', `<pre>{"assertion": "${S('12')}"}</pre>`],
  ['A13 svg vazio entre separador e valor', `<p>senha:<svg></svg>${S('13')}</p>`],
  // formas das revisões anteriores
  ['V27 angle', `<p>senha: <${S('20')}></p>`],
  ['V27 JWT angle', `<p>token: <${'ADVSEN14X'.repeat(20)}></p>`],
  ['V27 JSON mesma linha', `<pre>{"senha": "${S('21')}"}</pre>`],
  ['V27 aspas vazias', `<p>senha: ""${S('22')}</p>`],
  ['V27 aspas com cauda', `<p>senha: "${S('23')}" tail</p>`],
  ['V27 menor-que colado', `<p>senha: p4<${S('24')}</p>`],
  ['V27 seta', `<p>senha -> ${S('25')}</p>`],
  ['V28 br no meio', `<p>senha:<br>${S('26')}</p>`],
  ['V28 hr depois do rótulo', `<p>senha:</p><hr><p>${S('27')}</p>`],
  ['V28 rótulo/separador em nós', `<pre><span>senha</span>: <span>${S('28')}</span></pre>`],
  ['V28 separador em outro nó', `<th>chave<span>:</span></th><td>${S('29')}</td></tr>`],
  ['V28 valor parcial e resto em nó', `<p>senha: p4<span>${S('30')}</span></p>`],
  ['V28 entidade aspa', `<pre>{&quot;senha&quot;: &quot;${S('31')}&quot;}</pre>`],
  ['V28 entidade numérica', `<pre>{&#34;senha&#34;: &#34;${S('32')}&#34;}</pre>`],
  ['V28 aspa escapada', `<pre>{\\"senha\\": \\"${S('33')}\\"}</pre>`],
  ['V28 dl dt/dd', `<dl><dt>senha:</dt><dd>${S('34')}</dd></dl>`],
  ['V28 atributo do nó seguinte', `<p>senha: <img alt="${S('35')}"></p>`],
  ['V28 subárvore', `<div>token: <span><b>${S('36')}</b></span></div>`],
  ['V29 sufixo colado', `<p>senhaAtual: ${S('37')}</p>`],
  ['V29 cauda por quebra de linha', `<p>token: ADVSEN38X</p>`],
  ['V29 escape duplo', `<pre>{\\\\"senha\\\\": \\\\"${S('39')}\\\\"}</pre>`],
  ['V29 entidade de letra', `<p>sen&#104;a: ${S('40')}</p>`],
  ['V29 escape unicode', `<p>sen\\u0068a: ${S('41')}</p>`],
];
const ROTULOS = ['tokens:', 'secrets:', 'sessions:', 'cookies:', 'senhaAtual:', 'credenciaisDeAcesso:', 'chaveDeApi:', 'bearer:', 'authentication:', 'apiKeys:', 'Senha atual:', 'chave de api:', 'credenciais de acesso:'];
const CAUDAS = [
  ['cauda depois de vazio', `<p>senha: ${S('40')}<br>${S('41')}</p>`],
  ['cauda depois de quebra de linha', `<p>token: ${S('42')}\n${S('43')}</p>`],
  ['vazio sem atributo no meio', `<p>senha:<br>${S('44')}</p>`],
  ['vazio sem atributo entre blocos', `<p>senha:</p><hr><p>${S('45')}</p>`],
];
const ATRIBUTOS = [
  ['placeholder com valor', `<input placeholder="senha ${S('50')}">`],
  ['alt com valor', `<img alt="token ${S('51')}">`],
  ['title com valor', `<div title="chave ${S('52')}">x</div>`],
  ['aria-label com valor', `<div aria-label="senha ${S('53')}">x</div>`],
  ['aria-description com valor', `<div aria-description="senha ${S('54')}">x</div>`],
];
const URLS = [
  ['consulta ?code=', `/p?code=${S('60')}`], ['consulta ?assertion=', `/p?assertion=${S('61')}`],
  ['hash #code=', `/p#code=${S('62')}`], ['hash #assertion=', `/p#assertion=${S('63')}`],
  ['hash #/authorize?code=', `/p#/authorize?code=${S('64')}`], ['rota #/authorize/code/', `/p#/authorize/code/${S('65')}`],
  ['hash #access_token=', `/p#access_token=${S('66')}`], ['scope #code=', `https://exemplo.test/p#code=${S('67')}`],
];

// Prosa legítima: o sinal de credencial NÃO pode acender, e o texto tem de sair intacto.
const PROSA = [
  'A sessão de perguntas discutiu o cartão de crédito como tema e a chave do problema.',
  'A senha do teste é forte.', 'Senha da conta', 'Chave da API', 'Digite sua senha',
  'O passeio de barco passou pelo cais e o passageiro embarcou.',
];

test('nenhuma forma de credencial sobrevive em nenhum dos quatro caminhos', () => {
  // Não vacuidade: a lista precisa ser larga o bastante para valer como métrica da classe.
  assert.ok(FORMAS.length >= 30, `a lista de formas encolheu: ${FORMAS.length}`);
  assert.ok(ROTULOS.length >= 12 && ATRIBUTOS.length >= 5 && URLS.length >= 8);
  const vazamentos = [];
  for (const [nome, html] of FORMAS) {
    const sentinela = html.match(/ADVSEN\d+X/u)?.[0] ?? '';
    assert.ok(sentinela, `a forma "${nome}" precisa de sentinela própria`);
    const trecho = sanitizeHtmlSnippetSource(html);
    const json = sanitizeJsonData({ texto: html }).texto;
    const json2 = sanitizeJsonData({ texto: json }).texto;
    for (const [caminho, saida] of [['trecho', trecho], ['json', json], ['json2', json2]]) {
      if (saida.includes(sentinela)) vazamentos.push(`${nome} (${caminho})`);
    }
  }
  for (const [nome, html] of [...ATRIBUTOS, ...CAUDAS]) {
    const sentinela = html.match(/ADVSEN\d+X/u)[0];
    if (sanitizeHtmlSnippetSource(html).includes(sentinela)) vazamentos.push(`${nome} (trecho)`);
  }
  for (const rotulo of ROTULOS) {
    const sentinela = S('70');
    if (sanitizeHtmlSnippetSource(`<p>${rotulo} ${sentinela}</p>`).includes(sentinela)) vazamentos.push(`${rotulo} (trecho)`);
    if (sanitizeJsonData({ texto: `${rotulo} ${sentinela}` }).texto.includes(sentinela)) vazamentos.push(`${rotulo} (json)`);
  }
  for (const [nome, url] of URLS) {
    const sentinela = url.match(/ADVSEN\d+X/u)[0];
    if (redactSensitiveText(`https://exemplo.test${url}`).includes(sentinela)) vazamentos.push(`${nome} (url-texto)`);
    if (sanitizeJsonData({ texto: `https://exemplo.test${url}` }).texto.includes(sentinela)) vazamentos.push(`${nome} (url-json)`);
  }
  assert.deepEqual(vazamentos, [], `a credencial sobreviveu em: ${vazamentos.join(', ')}`);
});

test('o nome acessível do fallback de DOM não devolve a credencial', () => {
  const sentinela = S('80');
  const node = { tagName: 'DIV', attributes: { title: `chave ${sentinela}` }, children: [], text: '' };
  const fallback = computeAccessibleText(node, new Map(), null);
  assert.doesNotMatch(`${fallback.name}|${fallback.description}`, new RegExp(sentinela, 'u'));
  const comAx = computeAccessibleText(node, new Map(), {
    name: { value: `chave ${sentinela}` }, description: { value: `chave ${sentinela}` },
  });
  assert.doesNotMatch(`${comAx.name}|${comAx.description}`, new RegExp(sentinela, 'u'));
});

test('o sinal de credencial não acende em prosa legítima e o texto sai intacto', () => {
  for (const texto of PROSA) {
    assert.doesNotMatch(sanitizeHtmlSnippetSource(`<p>${texto}</p>`), /\[redacted\]/u, `"${texto}" é prosa, não credencial`);
    assert.equal(hasCredentialValueSignal(texto), false, `"${texto}" não pode acender o sinal`);
  }
  // E o outro lado: as formas que PRECISAM acender continuam acendendo, com a largura da 1.1.29.
  for (const texto of ['senha ZQXJKVBWPMTLRNHS', 'senha Segredo.Forte', 'chave Segredo!Forte',
    'Cartão de crédito: 4111 2222 3333 4444', 'senha do usuário: ZQXJKVBWPMTLRNHS', 'Senha atual: ZQXJKVBWPMTLRNHS',
    '{"senha": "ZQXJKVBWPMTLRNHS"}', 'senha:', 'chave =', 'token -> ZQXJKVBWPMTLRNHS']) {
    assert.equal(hasCredentialValueSignal(texto), true, `"${texto}" precisa acender o sinal`);
  }
  assert.equal(redactCredentialLabelTail('senha ZQXJKVBWPMTLRNHS'), 'senha [redacted]');
  assert.equal(redactCredentialLabelTail('Digite sua senha atual.'), 'Digite sua senha atual.');
  assert.equal(decodeForMatching('sen&#104;a'), 'senha');
  assert.equal(decodeForMatching('sen\\u0068a'), 'senha');
  assert.equal(decodeForMatching('sen\\150a'), 'senha');
});
