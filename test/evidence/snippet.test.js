import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeHtmlSnippet, sanitizeHtmlSnippetSource } from '../../src/core/evidence/snippet.js';

test('exposes sanitized readable source while preserving the encoded compatibility API', () => {
  const html = '<iframe title="Mapa" src="javascript:bad()" onload="bad()"></iframe><button aria-label="Abrir">Abrir</button>';
  const source = sanitizeHtmlSnippetSource(html);

  assert.equal(source, '<iframe title="Mapa"></iframe><button aria-label="Abrir">Abrir</button>');
  assert.equal(
    sanitizeHtmlSnippet(html),
    '&lt;iframe title=&quot;Mapa&quot;&gt;&lt;/iframe&gt;&lt;button aria-label=&quot;Abrir&quot;&gt;Abrir&lt;/button&gt;',
  );
});

test('keeps adversarial source inert and free of executable surfaces and secrets', () => {
  const source = sanitizeHtmlSnippetSource(
    '<button onclick="steal()" formaction="javascript:TOPSECRET">Abrir</button></code><script>TOPSECRET</script><style>TOPSECRET</style>',
  );

  assert.equal(source, '<button>Abrir</button></code>');
  assert.doesNotMatch(source, /script|style|onclick|formaction|javascript:|TOPSECRET/iu);
});

test('omits current editable values while preserving static select option labels', () => {
  const secret = 'TOPSECRET-editable';
  const source = sanitizeHtmlSnippetSource([
    `<input type=text name=api_key value="${secret}" aria-valuenow="${secret}" aria-valuetext="${secret}">`,
    `<textarea>${secret}</textarea>`,
    `<select value="${secret}"><option value="${secret}" selected>Rótulo público</option><option value=other>Outro</option></select>`,
    `<div contenteditable=true>${secret}<div title="${secret}"><span>${secret}</span></div></div>`,
  ].join(''));

  assert.equal(source, '<input type="text"><textarea></textarea><select><option>Rótulo público</option><option>Outro</option></select><div contenteditable="true"></div>');
  assert.doesNotMatch(source, /TOPSECRET|\bvalue=|\bselected\b|aria-value|\btitle=/iu);
});

test('suppresses a same-tag editable subtree until the structurally matching close tag', () => {
  const secret = 'TOPSECRET-nested-editor';
  const source = sanitizeHtmlSnippetSource(
    `<div contenteditable=true><div title="${secret}"><div>${secret}</div></div></div><button>Depois</button>`,
  );

  assert.equal(source, '<div contenteditable="true"></div><button>Depois</button>');
  assert.doesNotMatch(source, /TOPSECRET|title=|<div><div>/iu);
});

test('keeps only structural attributes on a contenteditable root but retains ordinary textarea labeling', () => {
  const secret = 'TOPSECRET-editor-attributes';
  const editor = sanitizeHtmlSnippetSource(
    `<div id="${secret}" name="${secret}" contenteditable="true" role="textbox" tabindex="0" aria-labelledby="safe-label" aria-describedby="safe-description" aria-label="${secret}" aria-description="${secret}" title="${secret}" data-private="${secret}" href="https://example.test/?view=${secret}"><span title="${secret}">${secret}</span></div>`,
  );
  const textarea = sanitizeHtmlSnippetSource(
    `<textarea id="message" name="message" aria-labelledby="message-label" placeholder="Comentário">${secret}</textarea>`,
  );

  assert.equal(editor, '<div contenteditable="true" role="textbox" tabindex="0" aria-labelledby="safe-label" aria-describedby="safe-description"></div>');
  assert.equal(textarea, '<textarea id="message" name="message" aria-labelledby="message-label" placeholder="Comentário"></textarea>');
  assert.doesNotMatch(`${editor}${textarea}`, /TOPSECRET|title=|data-private=|href=|aria-label=/iu);
});

test('removes executable elements and inline execution attributes while preserving structure and ARIA', () => {
  const html = '<DIV aria-label="Abrir" OnClick="steal()" style="background:url(data:text/plain,STYLE_MARKER)"><script>bad()</script><style>body{display:none}</style><template><img onerror=bad()></template><span role="img">Ícone</span></DIV>';
  const snippet = sanitizeHtmlSnippet(html);
  assert.equal(snippet, '&lt;div aria-label=&quot;Abrir&quot;&gt;&lt;span role=&quot;img&quot;&gt;Ícone&lt;/span&gt;&lt;/div&gt;');
  assert.doesNotMatch(snippet, /script|style|template|onclick|onerror|bad\(\)|STYLE_MARKER/i);
});

test('redacts password, token and authorization values across quote styles and case', () => {
  const html = "<INPUT TYPE=PASSWORD VALUE=fixture-pass autocomplete='current-password' data-token=fixture-token AUTHORIZATION=Bearer-fixture><input type=hidden name=csrf_token value=fixture-hidden><p data-safe='ok'>Texto</p>";
  const snippet = sanitizeHtmlSnippet(html);
  assert.match(snippet, /&lt;input type=&quot;password&quot; autocomplete=&quot;current-password&quot;&gt;/);
  assert.match(snippet, /&lt;input type=&quot;hidden&quot;&gt;/);
  assert.match(snippet, /&lt;p data-safe=&quot;ok&quot;&gt;Texto&lt;\/p&gt;/);
  assert.doesNotMatch(snippet, /fixture-pass|fixture-token|fixture-hidden|Bearer-fixture|authorization|data-token/i);
});

test('sanitizes URL userinfo, sensitive query/hash fields and unsafe protocols', () => {
  const html = '<a href="https://user:pass@example.test/path?token=bad&lang=pt#authorization=bad">Abrir</a><img SRC=https://example.test/a.png?ok=1&api_key=bad onload=bad()><a href=javascript:bad()>Ruim</a>';
  const snippet = sanitizeHtmlSnippet(html);
  assert.match(snippet, /href=&quot;https:\/\/example\.test\/path\?lang=pt&quot;/);
  assert.match(snippet, /src=&quot;https:\/\/example\.test\/a\.png\?ok=1&quot;/);
  assert.match(snippet, /&lt;a&gt;Ruim&lt;\/a&gt;/);
  assert.doesNotMatch(snippet, /user:pass|token=|api_key|authorization=|javascript:|onload/i);
});

test('drops srcdoc and produces deterministic displayable text', () => {
  const html = '<iframe title="Local" SRCDOC="<script>bad()</script><p>inside</p>"></iframe>';
  const first = sanitizeHtmlSnippet(html);
  assert.equal(first, '&lt;iframe title=&quot;Local&quot;&gt;&lt;/iframe&gt;');
  assert.equal(sanitizeHtmlSnippet(html), first);
});

test('redacts credential-like values that appear in snippet text nodes', () => {
  const snippet = sanitizeHtmlSnippet('<p>authorization=fixture-auth token: fixture-token conteúdo público</p>');
  // O valor vai até o fim do FRAGMENTO de texto. Era `[^\s<]+` (um token só), que deixava a cauda de
  // `cartão: 4111 1111 1111 1111` no trecho; a 1.1.26 tentou um teto de 120 caracteres e devolveu a
  // cauda de valores longos. O preço do consumo até o fim é que o resto do MESMO fragmento depois de
  // uma credencial também sai tarjado — fail-closed —, e este teste fixa o preço para que ele seja uma
  // decisão visível. Texto em outro elemento continua preservado: o tarjamento não atravessa marcação.
  assert.equal(snippet, '&lt;p&gt;authorization=[redacted]&lt;/p&gt;');
  assert.doesNotMatch(snippet, /fixture-auth|fixture-token|conteúdo público/);
  // O preço declarado da marcação por conteúdo: o parágrafo seguinte ao sinal também é tarjado.
  assert.equal(sanitizeHtmlSnippet('<p>authorization=fixture-auth</p><p>conteúdo público</p>'),
    '&lt;p&gt;authorization=[redacted]&lt;/p&gt;&lt;p&gt;[redacted]&lt;/p&gt;');
  assert.equal(sanitizeHtmlSnippet('<p>Orientação geral</p><p>conteúdo público</p>'),
    '&lt;p&gt;Orientação geral&lt;/p&gt;&lt;p&gt;conteúdo público&lt;/p&gt;');
});

test('drops private marker attributes and credential-like values from otherwise structural attributes', () => {
  const marker = 'AXE-MAP-PRIVATE-TOKEN-847261';
  const privateMarker = 'AXE-MAP-PRIVATE-HTML-592314';
  const source = sanitizeHtmlSnippetSource(
    `<button id="token-${marker}" name="session-${marker}" aria-label="Abrir" data-audita-private="${privateMarker}">Abrir</button>`,
  );

  assert.equal(source, '<button aria-label="Abrir">Abrir</button>');
  assert.equal(source.includes(marker), false);
  assert.equal(source.includes(privateMarker), false);
});

test('nenhum valor de credencial sobrevive ao trecho, nem em texto nem em atributo (Critical da revisão da 1.1.27)', () => {
  // O sanitizador de trecho tinha o TERCEIRO vocabulário do produto: uma lista só em inglês
  // (`authorization|password|passwd|token|...`) e o consumo de um único token, separada do
  // `SENSITIVE_KEY` e do tarjador de valores. Medido numa auditoria real de Chrome: o parágrafo
  // `senha: S3GR3D0XYZQ` chegava intacto ao modelo, ao relatório e aos artefatos HTML/JSON, e o
  // atributo `data-note="cartão: 4111 1111 1111 1111"` era copiado literalmente porque a regra só
  // olhava a palavra sensível no nome, nunca o valor. A métrica é a da classe: nenhum caractere que
  // só exista no valor pode sobreviver, em nenhuma dessas formas.
  // O sentinela não pode colidir com o que o próprio sanitizador emite: `&quot;` contém `q`, e uma
  // métrica por letra acusava vazamento onde o valor já tinha sido tarjado.
  const sentinela = /[Ww]/gu;
  const marca = valor => `Ww${valor}`;
  const casos = [
    ['texto com rótulo em português', `<p>senha: ${marca('abc')}</p>`],
    ['texto com cartão', `<p>cartão: ${marca('')} 1111 1111 1111</p>`],
    ['texto com chave', `<p>chave: ${marca('abc')}</p>`],
    ['texto com valor multi-token', `<p>senha: ${marca('')} R3D0 ${marca('')}</p>`],
    ['texto com valor longo', `<p>token: ${marca('').repeat(40)}</p>`],
    ['texto com aspas', `<p>senha: "${marca('abc')}"</p>`],
    ['atributo de dado', `<div data-note="senha: ${marca('abc')}">x</div>`],
    ['atributo de dado com cartão', `<div data-note="cartão: ${marca('')} 1111 1111 1111">x</div>`],
    ['atributo de título', `<span title="mot de passe: ${marca('abc')}">x</span>`],
    ['atributo com Bearer', `<div data-x="Bearer ${marca('abc')}">x</div>`],
    ['URL com rótulo em português', `<a href="/p?senha=${marca('abc')}&formato=html">Abrir</a>`],
    // Rótulo e valor em NÓS DIFERENTES: era aqui que a classe continuava aberta depois do primeiro
    // conserto, medido ponta a ponta pela revisão da 1.1.27 — o valor do nó seguinte era entregue
    // inteiro, com um `[redacted]` ao lado que ainda fazia um instrumento ingênuo ler "limpo".
    ['valor no elemento seguinte', `<p>senha: <code>${marca('abc')}</code></p>`],
    ['valor no irmão de tabela', `<table><tr><th>chave:</th><td>${marca('abc')}</td></tr></table>`],
    ['JSON dentro de pre', `<pre>{"senha": "${marca('abc')}"}</pre>`],
    ['subárvore aninhada depois do rótulo', `<div>token: <span><b>${marca('abc')}</b></span></div>`],
    ['valor longo no nó seguinte', `<p>senha: <code>${marca('').repeat(40)}</code></p>`],
    ['aspa antes dos dois pontos', `<pre>{"senha": ${marca('abc')}}</pre>`],
    ['atributo do elemento seguinte', `<p>senha: <img alt="${marca('abc')}"></p>`],
    ['atributo em subárvore', `<p>senha: <span data-x="${marca('abc')}">texto</span></p>`],
    ['atributo aninhado fundo', `<div>token: <span><b title="${marca('abc')}">x</b></span></div>`],
    // Formas que a revisão da 1.1.28 mediu sobrevivendo: o vazio consumia a espera, a marcação cortava
    // o valor e as entidades e aspas escapadas escondiam o separador.
    ['vazio sem atributo no meio', `<p>senha:<br>${marca('abc')}</p>`],
    ['vazio sem atributo entre blocos', `<p>senha:</p><hr><p>${marca('abc')}</p>`],
    ['vazio com atributo antes do valor', `<table><tr><th>chave:</th><br><td>${marca('abc')}</td></tr></table>`],
    ['rótulo e separador em nós', `<pre><span>senha</span>: <span>${marca('abc')}</span></pre>`],
    ['separador em outro nó', `<th>chave<span>:</span></th><td>${marca('abc')}</td></tr>`],
    ['valor parcial e resto em nó', `<p>senha: p4<span>${marca('abc')}</span></p>`],
    ['entidade aspa', `<pre>{&quot;senha&quot;: &quot;${marca('abc')}&quot;}</pre>`],
    ['entidade numérica', `<pre>{&#34;senha&#34;: &#34;${marca('abc')}&#34;}</pre>`],
    ['aspa escapada', `<pre>{\\"senha\\": \\"${marca('abc')}\\"}</pre>`],
    ['lista de descrição', `<dl><dt>senha:</dt><dd>${marca('abc')}</dd></dl>`],
    // Cauda do valor dividida por vazio ou por quebra de linha: o valor era tarjado até a quebra e o
    // resto continuava no trecho.
    ['cauda depois de vazio', `<p>senha: ${marca('a')}<br>${marca('b')}</p>`],
    ['cauda depois de quebra de linha', `<p>token: ${marca('a')}\n${marca('b')}</p>`],
    // Rótulo com sufixo curto (Minor M1 da revisão da 1.1.28).
    ['rótulo com sufixo', `<p>senhaAtual: ${marca('abc')}</p>`],
    ['rótulo plural em inglês', `<p>tokens: ${marca('abc')}</p>`],
  ];
  for (const [nome, html] of casos) {
    const trecho = sanitizeHtmlSnippetSource(html);
    const sobreviventes = trecho.match(sentinela) ?? [];
    assert.equal(sobreviventes.length, 0,
      `"${nome}" não pode devolver o valor (sobreviveu ${JSON.stringify(trecho)})`);
  }
  // PREÇO DECLARADO da marcação por conteúdo: depois do primeiro sinal de credencial, o RESTO do trecho
  // perde o texto — inclusive parágrafos seguintes. Foi a única forma de fechar a classe que quatro
  // revisões mediram vazando por caminhos diferentes (valor no irmão seguinte, depois de `<hr>`, depois
  // de um `<td>` vazio). O que o trecho perde em texto, o relatório preserva em seletor, nome acessível e
  // captura; e o sinal só acende com rótulo de credencial, o que não acontece em página sem credencial
  // (medido: zero `[redacted]` nos artefatos da auditoria real do Google).
  for (const html of [`<p>senha: <img alt="${marca('abc')}"></p><p>texto público</p>`,
    `<p>senha: <code>${marca('abc')}</code></p><p>texto público</p>`,
    `<table><tr><th>chave:</th><td>${marca('abc')}</td></tr></table><p>texto público</p>`]) {
    const trecho = sanitizeHtmlSnippetSource(html);
    assert.equal((trecho.match(sentinela) ?? []).length, 0, `"${html}" não pode devolver o valor`);
    assert.doesNotMatch(trecho, /texto público/u,
      `"${html}": depois do sinal, o resto do trecho é tarjado — é o preço declarado`);
  }
  // E sem sinal de credencial nada é perdido: o texto público continua inteiro.
  assert.equal(sanitizeHtmlSnippetSource('<p>chave de acesso</p><p>texto público</p>'),
    '<p>chave de acesso</p><p>texto público</p>');
  // Controle negativo: o rótulo sem valor continua sendo evidência útil, e prosa comum passa intacta.
  assert.match(sanitizeHtmlSnippetSource('<input aria-label="Senha" type="password">'), /aria-label="Senha"/u);
  const prosa = '<p>A sessão discutiu o cartão de crédito como tema e a chave do problema.</p>';
  assert.equal(sanitizeHtmlSnippetSource(prosa), prosa);
  // Atributo de rótulo: o valor que é SÓ o rótulo da credencial continua sendo evidência, mas qualquer
  // conteúdo depois da palavra volta à regra conservadora de descartar o atributo inteiro — a primeira
  // versão do conserto dispensava a regra para rótulos e com isso `title="token abc123"` passou a
  // sobreviver, quando na 1.1.26 ele era descartado.
  for (const rotulo of ['<div title="token abc123">x</div>', '<div aria-label="senha abc123">x</div>',
    '<img alt="token abc123">', '<div aria-label="session abc">x</div>', '<div title="senha: abc123">x</div>']) {
    assert.doesNotMatch(sanitizeHtmlSnippetSource(rotulo), /aria-label|title=|alt=/u,
      `"${rotulo}" menciona credencial e não pode manter o atributo`);
  }
  for (const rotulo of ['<input aria-label="Senha" type="password">', '<input aria-label="Password" type="password">']) {
    assert.match(sanitizeHtmlSnippetSource(rotulo), /aria-label="(?:Senha|Password)"/u,
      `"${rotulo}" é o rótulo puro e continua sendo evidência`);
  }
  // Fragmento de URL com credencial de fluxo OAuth: a 1.1.26 apagava o fragmento por acidente (o `auth`
  // nu casava `authorize`) e o A7 tirou o acidente; a regra passa a ser explícita.
  for (const url of ['<a href="https://h/cb#/authorize?code=SEGREDO">Abrir</a>',
    '<a href="https://exemplo.test/p#secao?token=SEGREDO">Abrir</a>']) {
    assert.doesNotMatch(sanitizeHtmlSnippetSource(url), /#/u, `"${url}" não pode manter o fragmento`);
  }
  assert.match(sanitizeHtmlSnippetSource('<a href="https://exemplo.test/p?lang=pt#secao">Abrir</a>'),
    /#secao/u, 'fragmento sem credencial continua sendo evidência');
});

test('is inert under innerHTML and removes duplicate-password and active URL surfaces', () => {
  const marker = 'SNIPPET_PRIVACY_MARKER';
  const html = [
    `<input value="${marker}" type=text TYPE=PASSWORD value=${marker} aria-label="Senha">`,
    `<meta http-equiv=refresh content="0; url=javascript:${marker}">`,
    `<object data="data:text/html,${marker}"></object><embed src="vbscript:${marker}">`,
    `<a xlink:href="javascript:${marker}" ping="https://example.test/?token=${marker}" href="https://user:pass@example.test/path?token=${marker}&ok=1#authorization=${marker}">Seguro</a>`,
    `<img src="data:image/png;base64,${marker}" srcset="javascript:${marker} 1x, https://example.test/a.png?secret=${marker} 2x">`
  ].join('');
  const snippet = sanitizeHtmlSnippet(html);
  assert.doesNotMatch(snippet, /<|>/);
  assert.doesNotMatch(snippet, new RegExp(marker));
  assert.doesNotMatch(snippet, /javascript:|vbscript:|data:|xlink:href|ping=|srcset=|content=/i);
  assert.match(snippet, /aria-label=&quot;Senha&quot;/);
  assert.match(snippet, /href=&quot;https:\/\/example\.test\/path\?ok=1&quot;/);
  assert.doesNotMatch(snippet, /value=/i);
});
