import assert from 'node:assert/strict';
import test from 'node:test';

import { isSensitiveKeyName, isSensitiveValue, SENSITIVE_KEY, decodeForMatching, hasCredentialValueSignal, redactCredentialLabelTail, redactSensitiveText, sanitizeJsonData } from '../../src/core/privacy.js';
import { sanitizeHtmlSnippetSource } from '../../src/core/evidence/snippet.js';
import { computeAccessibleText } from '../../src/core/accessibility/accessible-name.js';
import { buildStableSelector } from '../../src/core/evidence/selector.js';

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
// Formas de IDIOMA e de JANELA DE RÓTULO medidas pela revisão da 1.1.31: acento nos tokens do sufixo,
// rótulo com parênteses, rótulo de quatro palavras e as formas qualificadas em português.
const IDIOMA = [
  ['cartão de crédito com valor', `<p>Cartão de crédito: ${S('90')}</p>`],
  ['número do cartão do titular', `<p>Número do cartão de crédito do titular: ${'4111 1111 1111 1111'.replace(/1111 /gu, 'ADVSEN91X ')}</p>`],
  ['dados do cartão', `<p>Dados do cartão de crédito ${S('91')}</p>`],
  ['senha do usuário do sistema', `<p>senha do usuário do sistema: ${S('92')}</p>`],
  ['código de verificação', `<p>Código de verificação: ${S('93')}</p>`],
  ['frase de recuperação', `<p>frase de recuperação: ${S('94')}</p>`],
  ['senha entre parênteses', `<p>Senha (provisória): ${S('95')}</p>`],
  ['chave entre parênteses', `<p>Chave (API): ${S('96')}</p>`],
  ['senha com traço', `<p>senha - ${S('97')}</p>`],
  ['cartão pela cauda', `<p>cartão de crédito ${S('98')}</p>`],
];
// Formas de CARTÃO e BOLETO medidas pela revisão da 1.1.32: o vocabulário compartilhado não conhecia
// PIN, CVV/CVC, PUK, seed de 2FA, número de segurança, linha digitável nem código de barras, e esses
// rótulos entregavam o valor em quatro superfícies. Cada rótulo entra com valor com cara de valor, e a
// não vacuidade é por mutação: com o `privacy.js` da geração anterior esta lista REPROVA.
const CARTAO = [
  ['PIN', `<p>PIN: ${S('100')}</p>`],
  ['PIN do cartão', `<p>PIN do cartão: ${S('101')}</p>`],
  ['CVV', `<p>CVV ${S('102')}</p>`],
  ['CVC', `<p>CVC: ${S('103')}</p>`],
  ['PUK', `<p>PUK: ${S('104')}</p>`],
  ['seed de 2FA', `<p>seed: ${S('105')}</p>`],
  ['número de segurança', `<p>Número de segurança: ${S('106')}</p>`],
  ['linha digitável', `<p>Linha digitável: ${S('107')}</p>`],
  ['código de barras', `<p>Código de barras: ${S('108')}</p>`],
  // Formas de rótulo de PIN, porque a fronteira da palavra é parte da correção: `pins?` sem fronteira
  // casava o "pin" DENTRO de "shipping" e tarjava `autocomplete="shipping street-address"` (achado pelo
  // E2E do 5.9.8, não por esta métrica — o corpus de prosa não tinha palavra com o radical embutido).
  ['PIN com hífen', `<p>pin-code: ${S('109')}</p>`],
  ['PIN em camelCase', `<p>pinCode: ${S('110')}</p>`],
  ['PIN em maiúsculas com espaço', `<p>PIN CODE: ${S('111')}</p>`],
  // Compostas de PIN medidas pela revisão da 1.1.33 (C1): a fronteira de palavra que fechou "shipping"
  // devolveu à página estas formas, em que `pin` é o SEGUNDO componente colado (`userPin`, `cardPin`) ou
  // o primeiro de um composto (`PINpad`). Uma forma que passa nos dois lados de uma mutação não tem
  // dentes: por isso as quatro estão aqui e no E2E de forma isolada.
  ['PIN prefixado em camelCase', `<p>userPin: ${S('112')}</p>`],
  ['PIN prefixado com cartão', `<p>cardPin: ${S('113')}</p>`],
  ['PIN em composto maiúsculo', `<p>PINpad: ${S('114')}</p>`],
  ['PIN prefixado minúsculo', `<p>userpin: ${S('115')}</p>`],
  ['PIN prefixado em atributo', `<div data-userpin="${S('116')}">x</div>`],
  ['dígito verificador', `<p>Dígito verificador: ${S('117')}</p>`],
  // Evasões medidas na rodada da 1.1.34: caixa misturada dentro do radical (`SeNhA:` era tarjado antes
  // das marcas de camelCase e deixou de ser — regressão que a segunda leitura sem marcas fecha) e
  // caractere invisível no meio do radical (`sen\u200bha:`), que nenhuma geração anterior tarjava.
  ['caixa misturada no radical', `<p>SeNhA: ${S('120')}</p>`],
  ['caixa misturada com prefixo', `<p>ChAvE de API: ${S('121')}</p>`],
  ['largura zero no radical', `<p>sen\u200bha: ${S('122')}</p>`],
  ['hífen suave no radical', `<p>car\u00adtão de crédito: ${S('123')}</p>`],
  ['BOM no meio do radical', `<p>to\ufeffken: ${S('124')}</p>`],
  ['conta corrente', `<p>Conta corrente: ${S('118')}</p>`],
  // CONCATENAÇÕES com o radical no INÍCIO da palavra, medidas pela revisão da 1.1.34 (Critical): a
  // fronteira de fim de palavra não cobria esse lado e estas formas eram tarjadas na 1.1.33.
  ['senha + forte', `<p>senhaforte: ${S('140')}</p>`],
  ['token + acesso', `<p>tokenacesso: ${S('141')}</p>`],
  ['session + id', `<p>sessionid: ${S('142')}</p>`],
  ['senha + temporaria', `<p>senhatemporaria: ${S('143')}</p>`],
  ['chave + d + api', `<p>chavedapi: ${S('144')}</p>`],
  ['senha + do + usuario', `<p>senhadousuario: ${S('145')}</p>`],
  ['chave + secreta', `<p>chavesecreta: ${S('146')}</p>`],
  ['cookie + consent', `<p>cookieconsent: ${S('147')}</p>`],
  ['secret + key', `<p>secretkey: ${S('148')}</p>`],
  ['password + key', `<p>passwordkey: ${S('149')}</p>`],
  ['atributo data-senhaforte', `<div data-senhaforte="${S('150')}">x</div>`],
  ['atributo data-sessionid', `<div data-sessionid="${S('151')}">x</div>`],
  ['chave JSON sessionid', `<pre>{"sessionid": "${S('152')}"}</pre>`],
  // Rótulo partido por MARCAÇÃO dentro da palavra (Important da revisão da 1.1.34: a 1.1.33 também
  // vazava) e rótulo escondido em percent-encoding ou escape octal (Minor M1 da mesma revisão).
  ['rótulo partido por marcação', `<p><b>sen</b>ha: ${S('156')}</p>`],
  ['rótulo partido em três', `<p><b>se</b>n<i>ha</i>: ${S('157')}</p>`],
  ['rótulo em percent-encoding', `<p>sen%68a: ${S('158')}</p>`],
  ['rótulo em escape octal', `<p>sen\\150a: ${S('159')}</p>`],
  ['certificado digital', `<p>Certificado digital: ${S('119')}</p>`],
];
// CONCATENAÇÕES de radical + qualificador, a forma que a revisão da 1.1.34 mediu vazando e que a 1.1.35
// cobre com listas fechadas. O corpus existe para a lista ser medida nas duas direções: uma cauda nova
// fora da lista precisa aparecer aqui como vazamento.
const CONCATENACOES = [
  'senhasegura', 'senhafacil', 'senhaforte', 'senhafortes', 'senhaprivada', 'senhasecreta',
  'senhamestra', 'senhadaconta', 'senhadocliente', 'senhatemporaria', 'senhaexpirada', 'senhabloqueada',
  'tokenprivado', 'tokensessao', 'tokenapi', 'chaveprivada', 'chavepublica', 'chavemestra',
  'cookiesessao', 'banhopin', 'loginpin',
  // Composto de TRÊS partes, com o radical no meio do token: a regra de borda sozinha não cobre e a
  // minha sonda mediu o vazamento antes de congelar a 1.1.36.
  'novasenhaadmin', 'chaveacessouser', 'senhadobanco',
];
const ROTULOS = ['mfa:', '2fa:', 'tokens:', 'secrets:', 'sessions:', 'cookies:', 'senhaAtual:', 'credenciaisDeAcesso:', 'chaveDeApi:', 'bearer:', 'authentication:', 'apiKeys:', 'Senha atual:', 'chave de api:', 'credenciais de acesso:'];
// A OUTRA METADE DO PORTÃO, medida pela revisão da 1.1.37 (Critical C2 e Important I2). O sentinela
// `ADVSEN<n>X` tem DÍGITO e doze caracteres, então o portão de valor — que exigia dígito, símbolo ou
// comprimento — passava em toda forma sem provar nada sobre senha fraca. Os valores abaixo são os que a
// revisão mediu chegando ao entregável: `abc123` e senhas de 5 a 11 letras sem dígito (`passarinho`,
// `flamingo`) e uma de 11 letras do próprio revisor. Cada RÓTULO abaixo vazou em alguma geração.
const VALORES_FRACOS = ['abc123', 'passarinho', 'flamingo', 'Zqwkvbrtnmx'];
const ROTULOS_FRACOS = [
  // palavras e frases do vocabulário
  'senha', 'senha_forte', 'senhaAtual', 'sessionId', 'apiKey',
  // concatenações com prefixo/cauda de credencial (fechadas na 1.1.38)
  'novasenha', 'minhasenhaforte', 'novasenhaadmin', 'redefinirsenha', 'trocarsenha', 'senhaforte',
  // PREFIXO ARBITRÁRIO antes do radical: o eixo que a lista fechada não cobre (`xsenha`, `xsenhaforte`)
  'xsenha', 'xsenhaforte', 'absenha',
  // CAIXA MISTURADA dentro do radical (Critical C1 da revisão da 1.1.37: regressão da geração)
  'SeNhA', 'SeNhAfOrTe', 'SeNhA do usuário', 'ChAvE de API',
];
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
// Chaves de credencial de URL em TODAS as grafias do padrão: o pré-filtro da 1.1.34 gerava só a forma
// colada e deixava `?saml_response=` fora da varredura — falso negativo medido na rodada 74.
const URLS_CHAVE = [
  ['consulta ?sessionid=', `/p?sessionid=${S('153')}`],
  ['consulta ?cookieconsent=', `/p?cookieconsent=${S('154')}`],
  ['consulta ?secretkey=', `/p?secretkey=${S('155')}`],
  ['rota #/auth/senha/', `/p#/auth/senha/${S('160')}`],
  ['rota #/auth/senha/ com consulta', `/p#/auth/senha/${S('161')}`],
  ['consulta ?saml_response=', `/p?saml_response=${S('130')}`],
  ['consulta ?samlresponse=', `/p?samlresponse=${S('131')}`],
  ['consulta ?saml-response=', `/p?saml-response=${S('132')}`],
  ['consulta ?refresh_token=', `/p?refresh_token=${S('133')}`],
  ['consulta ?id-token=', `/p?id-token=${S('134')}`],
];
// Rótulos de várias palavras SEM acento: a lista de pré-filtro pegava só a primeira variante da primeira
// parte (`número` sem `numero`), e a página que escreve sem acento ficava fora da varredura.
const SEM_ACENTO = [
  ['numero de seguranca', `<p>numero de seguranca: ${S('135')}</p>`],
  ['codigo de barras', `<p>codigo de barras: ${S('136')}</p>`],
  ['digito verificador', `<p>digito verificador: ${S('137')}</p>`],
  ['linha digitavel', `<p>linha digitavel: ${S('138')}</p>`],
  ['codigo de verificacao', `<p>codigo de verificacao: ${S('139')}</p>`],
];
// CHAVE COM CONECTOR `de/da/do` EM camelCase (I-1 da revisão da 1.1.38). O vocabulário de PROSA conhece o
// conector; o de CHAVE, não. Como a decisão de marca por token usa o vocabulário de prosa, a marca era
// removida e o identificador `chaveDeApi` deixava de ser reconhecido como chave — 30.550 formas perdidas e
// 23/28 nomes realistas vazando em URL, JSON e seletor. Estas formas existem para a próxima mutação reprovar.
const CHAVES_CONECTOR = [
  ['consulta ?chaveDeApi=', `/p?chaveDeApi=${S('180')}`],
  ['consulta ?chaveDaApi=', `/p?chaveDaApi=${S('181')}`],
  ['consulta ?chaveDoBanco=', `/p?chaveDoBanco=${S('182')}`],
  ['consulta ?senhaDeApi=', `/p?senhaDeApi=${S('183')}`],
  ['consulta ?tokenDeAcesso=', `/p?tokenDeAcesso=${S('184')}`],
  ['consulta ?chaveDeAcesso=', `/p?chaveDeAcesso=${S('185')}`],
  ['consulta ?cpfDoTitular=', `/p?cpfDoTitular=${S('186')}`],
  ['hash #chaveDeApi=', `/p#chaveDeApi=${S('187')}`],
];
const URLS = [
  ['consulta ?code=', `/p?code=${S('60')}`], ['consulta ?assertion=', `/p?assertion=${S('61')}`],
  ['hash #code=', `/p#code=${S('62')}`], ['hash #assertion=', `/p#assertion=${S('63')}`],
  ['hash #/authorize?code=', `/p#/authorize?code=${S('64')}`], ['rota #/authorize/code/', `/p#/authorize/code/${S('65')}`],
  ['hash #access_token=', `/p#access_token=${S('66')}`], ['scope #code=', `https://exemplo.test/p#code=${S('67')}`],
];

// Palavras da língua que CONTÊM um radical curto do vocabulário e não são rótulo de credencial. O caso
// medido: `pins?` casava o "pin" dentro de "shipping" e a declaração `autocomplete="shipping
// street-address"` era tarjada — o E2E do 5.9.8 reprovou, e a causa era esta. A lista é o controle de
// não vacuidade da fronteira: sem ela, estreitar o radical para tirar o falso positivo não tem prova.
const NAO_ROTULO = [
  'shipping', 'pintura', 'pincel', 'pintor', 'pintinho', 'pintado', 'opinião', 'espinha',
  'pingente', 'pinguim', 'pino', 'spin', 'pinky', 'pinta', 'papiro', 'passeio', 'passageiro',
];
const PROSA_NAO_ROTULO = [
  'shipping street-address', 'Pintura: látex acrílico', 'Opinião do cliente: ótima',
  'Pincel: cerda sintética', 'Espinha de peixe: 12', 'Pingente: prata', 'O pinguim nada no gelo.',
  // Falsos positivos que a revisão da 1.1.33 mediu destruindo EVIDÊNCIA nas quatro superfícies: a palavra
  // da língua contém o radical (`chave` em "Chaveiro", `secret` em "Secretaria") e o valor vira tarja.
  'Chaveiro: R$ 30,00', 'Secretaria de Saúde: 12 unidades', 'Chaveta: aço temperado',
  'Secretário de educação: nomeado', 'Tokenizador: componente interno',
  'A senha foi alterada em 12/03/2026 pelo administrador.',
  'A chave foi alterada em 12/03/2026 pelo administrador.',
  // A janela de rótulo (M1): seis palavras entre o rótulo e o valor ainda precisam ser cobertas.
  'chave de acesso ao sistema principal da conta ZQXJKVBWPMTLRNHS',
];
// PREÇO DECLARADO, e ele mudou de lado na 1.1.35: palavra que TERMINA num radical curto é rótulo no
// caminho de CHAVE (identificador colado: `data-hairpin`, `hairpin`) e é PRESERVADA em prosa — a revisão
// da 1.1.34 mediu que a regra genérica de prefixo destruía `The hairpin: 12 units` sem cobrir o que
// importava (`sessionid`, `senhaforte`), que agora têm prefixo/cauda de credencial próprios.
// O preço mudou de lado outra vez na 1.1.37: `hairpin`/`pushpin`/`backspin` são PALAVRA da língua e ficam
// preservadas nos DOIS caminhos (a revisão da 1.1.36 mediu `pintura.png` e `secretaria-saude` destruídos
// e `hairpin` era o preço declarado antigo). O caminho de chave passou a exigir lista fechada
// (`userpin` = prefixo `user` + radical, `sessionid` = radical + cauda `id`).
const PRECO_DECLARADO = ['userpin', 'sessionid', 'senha_forte', 'data-senhaforte'];
// Palavras medidas uma a uma pela revisão da 1.1.33: contêm radical e NÃO podem ser rótulo.
const PALAVRAS_FALSAS = [
  'chaveiro', 'chaveta', 'chaveamento', 'secretaria', 'secretário', 'secretariado', 'secreto',
  'obsessão', 'obsessões', 'possessão', 'possessões', 'passível', 'passíveis', 'passé',
];
// Prosa realista no caminho JSON/MODELO **com marcação**, que é onde a revisão da 1.1.33 mediu 14 de 16
// frases destruídas: o token da cauda carregava `</p>` e a pontuação final não descartava a marcação.
const PROSA_JSON = [
  'A senha deve ser forte', 'A senha deve ter pelo menos oito caracteres',
  'Sua senha é pessoal e intransferível', 'Informe o token no cabeçalho Authorization',
  'O segredo de justiça requer credenciamento no sistema', 'Digite sua senha atual',
  'A senha expira em 30 minutos', 'Esqueci minha senha', 'Crie uma senha com letras e números',
  'A chave do problema é a educação', 'O passeio de barco passou pelo cais',
  'Sua sessão expira em 30 minutos', 'A matrícula foi alterada em 12/03/2026 pelo administrador.',
];

// Prosa legítima: o sinal de credencial NÃO pode acender, e o texto tem de sair intacto.
// As frases que a revisão da 1.1.31 mediu como falso positivo depois do alargamento do rótulo: elas
// precisam estar neste corpus, senão o controle de prosa não cobre o que os documentos declaram.
const PROSA_IDIOMA = [
  'Senha do usuário: mínimo de 8 caracteres.', 'Segredo de justiça: o processo tramita em sigilo.',
  'Segredo de justiça: processo 1234.', 'Chave de proteção: aciona o disjuntor.',
  'Token de verificação: enviado por SMS.', 'Palavra-passe provisória: entregue no balcão.',
  'Senha do usuário: redefinida ontem.', 'Chave da API: consulte o manual.',
  'Senha da conta: alterada em 12/03', 'A senha deve ter 8 caracteres',
  'Sua sessão expira em 30 minutos', 'Digite sua senha atual.', 'Sessão expirada.',
  // Controles das formas de cartão/boleto acrescentadas na 1.1.33: o vocabulário novo não pode tarjar
  // a frase que FALA do dado sem trazer valor.
  'O PIN do cartão chega por carta.', 'Sua seed de recuperação é mostrada uma vez.',
  'A linha digitável do boleto tem 47 dígitos.', 'O código de barras fica no rodapé do boleto.',
];
const PROSA = [
  'A sessão de perguntas discutiu o cartão de crédito como tema e a chave do problema.',
  'A senha do teste é forte.', 'Senha da conta', 'Chave da API', 'Digite sua senha',
  'O passeio de barco passou pelo cais e o passageiro embarcou.',
];

test('valor fraco com rótulo reconhecido não sobrevive em nenhum caminho', t => {
  // Esta é a asserção que a revisão da 1.1.37 mostrou faltar (I2): com o sentinela de doze caracteres COM
  // dígito, o portão de valor podia estar fechado para o sentinela e aberto para a senha real. Aqui o
  // valor é fraco de propósito (`abc123`, `passarinho`, `flamingo`) e o rótulo é reconhecido de propósito
  // (palavra, concatenação com lista fechada, PREFIXO ARBITRÁRIO e caixa misturada). Nenhum rótulo pode
  // transformar valor fraco em prosa.
  const vazamentos = [];
  for (const rotulo of ROTULOS_FRACOS) {
    for (const valor of VALORES_FRACOS) {
      const texto = `${rotulo}: ${valor}`;
      const trecho = sanitizeHtmlSnippetSource(`<p>${texto}</p>`);
      const json = sanitizeJsonData({ texto }).texto;
      for (const [caminho, saida] of [['trecho', trecho], ['json', json]]) {
        if (saida.includes(valor)) vazamentos.push(`${texto} (${caminho})`);
      }
    }
  }
  t.diagnostic(`combinações=${ROTULOS_FRACOS.length * VALORES_FRACOS.length} vazamentos=${vazamentos.length}`);
  assert.deepEqual(vazamentos, [], `valor fraco chegou ao entregável em ${vazamentos.length} combinações`);
});

test('o preço do prefixo arbitrário é declarado e medido', () => {
  // O outro lado da correção do C2: reconhecer radical com prefixo arbitrário (`xsenha`) custa palavra da
  // língua que TERMINA no radical. O corte é o comprimento do radical (>= 5): `pin`, `seed`, `pwd`,
  // `cvv`, `otp`, `cpf`, `auth` e os de duas letras ficam FORA, e é isso que preserva `spin`, `hairpin`,
  // `pushpin`, `linseed`, `chauth` e `obsessão`. A lista abaixo é o preço, medido: se algum virar tarja, a
  // fronteira escorregou.
  for (const frase of ['spin: 12', 'The hairpin: 12 units', 'Pushpin: 8 unidades', 'O seed do banco é 12',
    'O tokenizador é interno', 'Chaveiro: R$ 30,00', 'Pingente: prata', 'Espinha de peixe: 12',
    'Pintura: látex acrílico', 'Secretaria de Saúde: 12 unidades', 'A obsessão do time é o produto']) {
    assert.equal(redactSensitiveText(frase), frase, `"${frase}" é palavra da língua e não pode ser tarjada`);
  }
  // E o lado oposto: o prefixo arbitrário com radical LONGO é rótulo, com valor fraco ou forte.
  for (const frase of ['xsenha: abc123', 'xsenhaforte: passarinho', 'absenha: flamingo']) {
    assert.match(redactSensitiveText(frase), /\[redacted\]/u, `"${frase}" é rótulo de credencial`);
  }
});

test('nenhuma forma de credencial sobrevive em nenhum dos quatro caminhos', t => {
  // Não vacuidade: a lista precisa ser larga o bastante para valer como métrica da classe.
  assert.ok(FORMAS.length >= 30, `a lista de formas encolheu: ${FORMAS.length}`);
  assert.ok(ROTULOS.length >= 12 && ATRIBUTOS.length >= 5 && URLS.length >= 8);
  assert.ok(CARTAO.length >= 9, `a lista de cartão/boleto encolheu: ${CARTAO.length}`);
  // O total de COMBINAÇÕES (forma x caminho) é o número que os documentos citam, e por isso ele é
  // calculado aqui em vez de escrito à mão: uma lista que encolher derruba esta asserção.
  const combinacoes = (FORMAS.length + IDIOMA.length + CARTAO.length + SEM_ACENTO.length) * 3 + CONCATENACOES.length * 2
    + (ATRIBUTOS.length + CAUDAS.length) + ROTULOS.length * 2 + (URLS.length + URLS_CHAVE.length) * 2
    + ROTULOS_FRACOS.length * VALORES_FRACOS.length * 2 + CHAVES_CONECTOR.length;
  t.diagnostic(`formas=${FORMAS.length + IDIOMA.length + CARTAO.length + SEM_ACENTO.length} fracos=${ROTULOS_FRACOS.length * VALORES_FRACOS.length} combinações=${combinacoes}`);
  assert.ok(combinacoes >= 210, `a métrica encolheu: ${combinacoes} combinações`);
  const vazamentos = [];
  for (const [nome, html] of [...FORMAS, ...IDIOMA, ...CARTAO, ...SEM_ACENTO]) {
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
  for (const rotulo of CONCATENACOES) {
    const sentinela = S('170');
    for (const [caminho, saida] of [
      ['trecho', sanitizeHtmlSnippetSource(`<p>${rotulo}: ${sentinela}</p>`)],
      ['json', sanitizeJsonData({ texto: `<p>${rotulo}: ${sentinela}</p>` }).texto],
    ]) {
      if (saida.includes(sentinela)) vazamentos.push(`${rotulo} (${caminho})`);
    }
  }
  for (const [nome, url] of [...URLS, ...URLS_CHAVE, ...CHAVES_CONECTOR]) {
    const sentinela = url.match(/ADVSEN\d+X/u)[0];
    if (redactSensitiveText(`https://exemplo.test${url}`).includes(sentinela)) vazamentos.push(`${nome} (url-texto)`);
    if (sanitizeJsonData({ texto: `https://exemplo.test${url}` }).texto.includes(sentinela)) vazamentos.push(`${nome} (url-json)`);
  }
  assert.deepEqual(vazamentos, [], `a credencial sobreviveu em: ${vazamentos.join(', ')}`);
});

test('o seletor CSS não carrega o valor do atributo de rótulo (quinto vocabulário, fechado na 1.1.32)', () => {
  // O gerador de seletor tinha o QUINTO vocabulário do produto, só em inglês: com `title="senha X"` o
  // seletor saía `input[title="senha X"]` e o valor ia inteiro para o relatório, o modelo e os artefatos.
  const sentinela = S('85');
  for (const atributo of ['title', 'alt', 'aria-label', 'data-testid', 'placeholder']) {
    const seletor = JSON.stringify(buildStableSelector({ tagName: 'INPUT', attributes: { [atributo]: `senha ${sentinela}` } }));
    assert.doesNotMatch(seletor, new RegExp(sentinela, 'u'), `o seletor não pode carregar ${atributo}`);
  }
  // E a evidência legítima continua: um atributo sem credencial permanece no seletor.
  assert.match(JSON.stringify(buildStableSelector({ tagName: 'INPUT', attributes: { title: 'Endereço' } })), /Endereço/u);
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

test('palavra da língua com radical curto embutido não vira rótulo de credencial', () => {
  // A fronteira do radical é uma decisão de cobertura com dois lados, e este é o lado que o E2E do 5.9.8
  // mediu: `pins?` sem fronteira casava o "pin" de "shipping". Sem esta asserção, a correção da fronteira
  // fica sem controle — e foi exatamente assim que o defeito passou pela métrica na primeira medição.
  // O predicado que decide VALOR de atributo e palavra da língua é o ESTRITO: o vocabulário de rótulo de
  // prosa é permissivo de propósito (radical em qualquer posição que toque uma borda do token), e quem
  // impede a destruição da evidência é o par (token inteiro + valor com cara de credencial).
  for (const palavra of [...NAO_ROTULO, ...PALAVRAS_FALSAS]) {
    assert.equal(isSensitiveValue(palavra), false, `"${palavra}" contém radical curto e não é rótulo de valor`);
  }
  // O conector em camelCase é identificador de CHAVE em todos os caminhos que o usam (JSON, nome de
  // atributo, chave de URL, seletor) — não só em prosa.
  for (const chave of ['chaveDeApi', 'chaveDaApi', 'senhaDeApi', 'tokenDeAcesso', 'chaveDeAcesso', 'cpfDoTitular']) {
    assert.equal(isSensitiveKeyName(chave), true, `"${chave}" é identificador de credencial com conector`);
    assert.equal(isSensitiveKeyName(`data-${chave}`), true, `"data-${chave}" é nome de atributo de credencial`);
    assert.equal(sanitizeJsonData({ [chave]: S('188') })[chave] ?? '', '[redacted]', `chave JSON "${chave}" precisa tarjar o valor`);
  }
  for (const palavra of PRECO_DECLARADO) {
    assert.equal(isSensitiveKeyName(palavra), true, `"${palavra}" é identificador de credencial e precisa ser tarjado como chave`);
  }
  // E o outro lado, medido pela revisão da 1.1.36: palavra da língua que contém o radical não pode ser
  // destruída no caminho de chave.
  for (const palavra of ['pintura.png', 'pintura', 'pincel', 'secretaria-saude', 'hairpin', 'pushpin', 'backspin']) {
    assert.equal(isSensitiveKeyName(palavra), false, `"${palavra}" é palavra/identificador inocente e não pode ser tarjada como chave`);
  }
  // E o outro lado do preço: em PROSA a palavra terminada em radical curto é preservada, com o caso que a
  // revisão da 1.1.34 mediu.
  for (const palavra of ['hairpin', 'spin', 'chaveiro', 'tokenizador']) {
    assert.equal(isSensitiveValue(palavra), false, `"${palavra}" é palavra da língua e não pode ser rótulo de valor`);
  }
  for (const frase of ['The hairpin: 12 units', 'O tokenizador é interno', 'Chaveiro: R$ 30,00']) {
    assert.doesNotMatch(redactSensitiveText(frase), /\[redacted\]/u, `"${frase}" é prosa e não pode ser tarjada`);
  }
  for (const frase of PROSA_NAO_ROTULO) {
    assert.equal(redactSensitiveText(frase), frase, `"${frase}" é prosa e não pode ser tarjada`);
    assert.doesNotMatch(sanitizeHtmlSnippetSource(`<p>${frase}</p>`), /\[redacted\]/u, `"${frase}" é prosa`);
  }
  // E o outro lado do mesmo radical: as formas de rótulo de PIN continuam acendendo.
  for (const rotulo of ['PIN: 4712', 'Pins: 12', 'pin-code: 4712', 'pinCode: 4712', 'PIN CODE: 4712']) {
    assert.equal(isSensitiveValue(rotulo), true, `"${rotulo}" é rótulo de credencial`);
    assert.match(redactSensitiveText(rotulo), /\[redacted\]/u, `"${rotulo}" precisa ser tarjado`);
  }
});

test('valor de atributo legítimo é preservado e valor de credencial não', () => {
  // A revisão da 1.1.33 mediu o oposto: `placeholder="Chaveiro"`, `aria-label="Secretaria"` e
  // `alt="Chaveiro"` eram DESCARTADOS do trecho porque o vocabulário casava substring — o campo chegava à
  // evidência sem nome acessível. A fronteira vale para os dois lados.
  for (const atributo of ['placeholder', 'aria-label', 'alt', 'title']) {
    const legitimo = sanitizeHtmlSnippetSource(`<input ${atributo}="Chaveiro de latão">`);
    assert.match(legitimo, /Chaveiro de latão/u, `${atributo} legítimo não pode ser descartado`);
    const credencial = sanitizeHtmlSnippetSource(`<input ${atributo}="senha ${S('150')}">`);
    assert.doesNotMatch(credencial, new RegExp(S('150'), 'u'), `${atributo} com credencial precisa ser tarjado`);
  }
  // E nenhuma superfície pode devolver o sentinela interno da marcação camelCase.
  assert.doesNotMatch(sanitizeHtmlSnippetSource(`<p>senhaAtual: ${S('151')}</p>`), /\u0001/u);
  assert.doesNotMatch(sanitizeJsonData({ snippet: `<p>senhaAtual: ${S('152')}</p>` }).snippet, /\u0001/u);
});

test('o sinal de credencial não acende em prosa legítima e o texto sai intacto', () => {
  for (const texto of [...PROSA, ...PROSA_IDIOMA, ...PROSA_NAO_ROTULO]) {
    assert.doesNotMatch(sanitizeHtmlSnippetSource(`<p>${texto}</p>`), /\[redacted\]/u, `"${texto}" é prosa, não credencial`);
    assert.equal(hasCredentialValueSignal(texto), false, `"${texto}" não pode acender o sinal`);
    // O caminho JSON/MODELO é o que a revisão da 1.1.33 mediu destruindo 14 de 16 frases: a string do
    // modelo carrega marcação, e é ela que decide a tarja.
    assert.doesNotMatch(sanitizeJsonData({ snippet: `<p>${texto}</p>` }).snippet, /\[redacted\]/u,
      `"${texto}" não pode ser tarjada no caminho JSON com marcação`);
    assert.doesNotMatch(sanitizeJsonData({ texto }).texto, /\[redacted\]/u, `"${texto}" é prosa no JSON puro`);
  }
  for (const texto of PROSA_JSON) {
    assert.doesNotMatch(sanitizeJsonData({ snippet: `<p>${texto}</p>` }).snippet, /\[redacted\]/u,
      `"${texto}" é prosa e não pode ser tarjada no caminho JSON`);
  }
  // E o outro lado: as formas que PRECISAM acender continuam acendendo, com a largura da 1.1.29.
  for (const texto of PROSA_IDIOMA) {
    assert.equal(hasCredentialValueSignal(texto), false, `"${texto}" é prosa, não credencial`);
  }
  for (const texto of ['senha ZQXJKVBWPMTLRNHS', 'senha Segredo.Forte', 'chave Segredo!Forte',
    'Cartão de crédito: 4111 2222 3333 4444', 'senha do usuário: ZQXJKVBWPMTLRNHS', 'Senha atual: ZQXJKVBWPMTLRNHS',
    '{"senha": "ZQXJKVBWPMTLRNHS"}', 'senha:', 'chave =', 'token -> ZQXJKVBWPMTLRNHS',
    'CVV: 123', 'PUK: 12345678', 'PIN: 4712', 'Número de segurança: 123',
    'Linha digitável: 00190.00009 03309.224285 00000.000008 1 1234']) {
    assert.equal(hasCredentialValueSignal(texto), true, `"${texto}" precisa acender o sinal`);
  }
  assert.equal(redactCredentialLabelTail('senha ZQXJKVBWPMTLRNHS'), 'senha [redacted]');
  assert.equal(redactCredentialLabelTail('Digite sua senha atual.'), 'Digite sua senha atual.');
  assert.equal(decodeForMatching('sen&#104;a'), 'senha');
  assert.equal(decodeForMatching('sen\\u0068a'), 'senha');
  assert.equal(decodeForMatching('sen\\150a'), 'senha');
});
