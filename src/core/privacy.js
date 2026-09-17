// Radical de senha: LISTA de caudas de credencial (word/wd/wrd/w0rd/wort/code/phrase/key e as
// estrangeiras kod/kode/frase/satz/passe, com ou sem separador), a palavra inteira `pass` (desde que
// não venha de "by", nem de "com", nem seja sufixo de palavra inocente) e as formas compostas de
// outros idiomas (`palavra-passe`, `frase-passe`, `mot de passe`).
//
// Três lições medidas, nesta ordem. (1) O lookbehind de dois caracteres da 1.1.23 deixava escapar
// `bypasscode` e companhia (A2, 1.1.24). (2) O radical fechado que corrigiu o A2 PERDEU oito grafias
// que a versão anterior tarjava — `motdepasse`, `passwrd`, `passw0rd`, `palavra-passe`,
// `palavrapasse`, `frase-passe`, `frasepasse`, `passwort` (N1, 1.1.25). (3) A revisão da 1.1.26
// mediu que o radical fechado ainda perdia caudas de credencial reais contra a 1.1.24 — `passkod` e
// `passkode` (dinamarquês/norueguês), `passfrase`, `passsatz` (alemão) e `passpasse` — e que o
// `compass` tarjado "de propósito" não era um trade-off forçado: `(?<!com)pass` o preserva e mantém
// `myPass`/`userPass`/`newPassword` tarjados, a custo zero.
//
// Por isso as DUAS listas que decidem tarjamento — a de chaves (SENSITIVE_KEY) e a de rótulos de
// valor (VALUE_LABEL_SOURCE) — passam a ser construídas do MESMO radical. Elas divergiram na 1.1.26:
// o radical de chave conhecia `palavra-passe` e a lista de rótulos não, então `palavra-passe: X` num
// texto visível não era tarjado por nenhuma das duas. O teste fixa os três conjuntos: o que precisa
// ser tarjado, o que precisa ser preservado e o que a versão anterior já tarjava. `passed`, `passes`,
// `passive`, `passing`, `passo`, `passage`, `passport`, `passer`, `passable`, `passepartout`,
// `passim`, `compass`, `compassion` e `encompass` ficam preservados.
//
// Vocabulário sensível, em inglês e em português: uma página brasileira pode expor a credencial em
// `?senha=` ou `?cpf=`, e o produto afirma que a URL entregue é sanitizada. A expansão é sempre para
// o lado seguro (tarjar a mais), mas os radicais curtos ficam de fora de propósito: "conta" pegaria
// "contato", "pix" pegaria "pixelRatio" e "rg" pegaria "cargo" — perder esses campos seria corromper
// o relatório, não protegê-lo.
// --- Vocabulário: LISTA ÚNICA, com fronteira de palavra ---------------------------------------------
// A classe "credencial da página chegando ao entregável" tem duas falhas simétricas, e as duas foram
// medidas por revisões: deixar passar (falso negativo) e destruir evidência (falso positivo). Casar
// SUBSTRING dentro de palavra produzia a segunda — `Chaveiro: R$ 30,00`, `Secretaria de Saúde: 12
// unidades`, `tokenizador` e `chaveamento` viravam tarja, e o campo chegava ao relatório sem o nome
// acessível (Important da revisão da 1.1.33). A correção é estrutural, não uma lista de exceções: o
// radical precisa TERMINAR uma palavra. `chave` casa em `chave`, `chave:`, `chaveDeApi` e `userPin`, e
// NÃO casa em `chaveiro` nem em `chaveamento`, porque ali o radical é seguido de letra.
//
// CamelCase vira fronteira com uma marca interna (`\u0001`), inserida antes de cada transição
// minúscula→maiúscula (`senha|Atual`, `user|Pin`) e depois de uma sequência de maiúsculas (`PIN|pad`).
// A marca não é letra, então satisfaz a fronteira, e é removida de TODA saída.
const CAMEL_MARK = '\u0001';
const CAMEL_MARK_GLOBAL = /\u0001/gu;
// O prefixo tem de ter DUAS letras ou mais: é o que separa `userpin`/`cardpin` (concatenções reais de
// chave) de `spin`, palavra da língua que termina no mesmo radical. Palavra inteira (`pin`) continua
// valendo pelo lookbehind.
const WORD_HEAD = String.raw`(?:[A-Za-z]{2,12}|(?<![\p{L}\p{N}]))`;
const WORD_TAIL = String.raw`(?!\p{L})`;
const WORD_SEP = String.raw`(?:\u0001|[\s\-_–—])`;

// Caracteres invisíveis (hífen suave, larguras zero, controles de direção, BOM) quebram o radical no
// meio: `sen\u200bha:` é o mesmo rótulo que `senha:` para quem lê, e o tarjador não o via. Eles saem da
// cópia de trabalho (e do texto entregue, que é derivado dela) — são invisíveis por definição.
const INVISIBLE_MARKS = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/gu;
export function withCamelMarks(value) {
  const text = String(value ?? '').replace(INVISIBLE_MARKS, '');
  if (text.length === 0 || text.includes(CAMEL_MARK)) return text;
  return text
    .replace(/(?<=[\p{Ll}\p{N}])(?=\p{Lu})/gu, CAMEL_MARK)
    .replace(/(?<=\p{Lu}{2})(?=\p{Ll})/gu, CAMEL_MARK);
}
export function stripCamelMarks(value) {
  return String(value ?? '').replace(CAMEL_MARK_GLOBAL, '');
}
function escapeLiteral(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
// Radicais de UMA palavra. Esta lista é a fonte de tudo o que este arquivo tarja: chave, rótulo de valor,
// segmento de URL e atributo de rótulo derivam dela.
const WORD_STEMS = Object.freeze([
  'pwd', 'bearer', 'token', 'tokens', 'secret', 'secrets', 'session', 'sessions', 'cookie', 'cookies',
  'csrf', 'xsrf', 'otp', 'auth', 'oauth', 'authentication', 'authentications', 'authorization',
  'authorizations', 'authorisation', 'authorisations', 'credential', 'credentials', 'password', 'passwords', 'passwd',
  'passphrase', 'passcode', 'passkey', 'passwort', 'passwörter', 'passworter', 'passw0rd', 'passkod',
  'passkode', 'passfrase', 'passsatz',
  'senha', 'senhas', 'segredo', 'segredos', 'credencial', 'credenciais',
  'autenticação', 'autenticações', 'autenticacao', 'autenticacoes', 'autorização',
  'autorizações', 'autorizacao', 'autorizacoes', 'chave', 'chaves', 'cpf', 'cnpj', 'cartão', 'cartões',
  'cartao', 'cartoes', 'pin', 'pins', 'cvv', 'cvc', 'puk', 'seed',
]);
// Radicais de VÁRIAS palavras: cada parte aceita separador (espaço, hífen, sublinhado) ou a marca camel.
const PHRASE_STEMS = Object.freeze([
  [['linha'], ['digitável', 'digitavel']],
  [['número', 'numero'], ['de'], ['segurança', 'seguranca']],
  [['código', 'codigo'], ['de'], ['barras']],
  [['código', 'codigo'], ['de'], ['verificação', 'verificacao', 'acesso', 'segurança', 'seguranca',
    'recuperação', 'recuperacao', 'autenticação', 'autenticacao', 'confirmação', 'confirmacao']],
  [['frase'], ['de'], ['recuperação', 'recuperacao']],
  [['dígito', 'digito'], ['verificador', 'verificadora']],
  [['conta'], ['corrente']],
  [['certificado'], ['digital']],
  [['assinatura'], ['eletrônica', 'eletronica']],
  [['palavra'], ['passe']],
  [['frase'], ['passe']],
  [['mot'], ['de'], ['passe']],
  [['one'], ['time']],
  [['api'], ['key', 'keys']],
  [['pin'], ['code', 'código', 'codigo', 'pad', 'number', 'número', 'numero', 'block']],
  // A família de `pass` com cauda: `pass_code`, `passwrd`, `bypass_code`, `passpasse`. O `by` da frente
  // não é exceção aqui (`bypass_code` É rótulo de credencial, achado A2 da revisão da 1.1.24); a guarda
  // `(?<!by)` vale só para o `pass` SOZINHO, onde `bypass` é palavra.
  [['pass'], ['word', 'words', 'wd', 'wds', 'wrd', 'w0rd', 'wort', 'wörter', 'worter', 'code', 'codes', 'phrase',
    'phrases', 'key', 'keys', 'kod', 'kode', 'frase', 'satz', 'passe', 'pwd']],
]);
// Radicais que só valem como PALAVRA INTEIRA: `sessão` é sufixo de palavra comum em português
// ("obsessão", "possessão", "obsessões") e a regra de fim de palavra os tarjaria — falso positivo medido
// pela revisão da 1.1.33. Os demais radicais aceitam prefixo curto porque é assim que a página escreve a
// chave (`userPin`, `data-userpin`, `minhasenha`) e porque nenhuma palavra da língua termina neles.
const WHOLE_WORD_STEMS = Object.freeze(['sessão', 'sessões', 'sessao', 'sessoes']);
// O prefixo é HOISTADO para fora da alternação dos radicais, e não repetido em cada um: com o prefixo em
// cada alternativa o motor tentava 65 padrões por posição e o tarjador do modelo ficava 46× mais lento
// (medido: 19,7 s contra 0,42 s num modelo de 4.000 nós) — e a lentidão aparecia como falha de prazo em
// teste de agenda sob carga. Uma estrutura só, com a lista de radicais dentro, mantém a semântica e o custo.
const WORD_RADICAL_SOURCE = String.raw`${WORD_HEAD}(?:${WORD_STEMS.map(escapeLiteral).join('|')})${WORD_TAIL}|(?<![\p{L}\p{N}])(?:${WHOLE_WORD_STEMS.map(escapeLiteral).join('|')})${WORD_TAIL}`;
const PHRASE_RADICAL_SOURCE = String.raw`${WORD_HEAD}(?:${PHRASE_STEMS.map(parts => parts
  .map(part => `(?:${part.map(escapeLiteral).join('|')})`)
  .join(`${WORD_SEP}?`)).join('|')})${WORD_TAIL}`;
// `pass` sozinho: `bypass` e `compass` ficam preservados (lookbehind) e `passed`/`passive`/`passo`
// também, porque a fronteira exige que a palavra TERMINE no radical.
const BARE_PASS_SOURCE = String.raw`${WORD_HEAD}(?<!by)(?<!com)pass${WORD_TAIL}`;
const CREDENTIAL_RADICAL_SOURCE = WORD_RADICAL_SOURCE;
const COMPOUND_CREDENTIAL_SOURCE = PHRASE_RADICAL_SOURCE;
// `auth` nu casava a família inteira `author*`/`authority*` — 314 tokens do próprio produto, entre
// eles `authorityExpiresAt`, `authorizedAt` e `firstAuthorization` (A7 da revisão da 1.1.26). As
// formas de credencial continuam tarjadas (`auth`, `authorization`, `authentication`, `authToken`,
// `oauth`) e as inocentes passam a ser preservadas: medido nas duas direções, zero credencial perdida
// e dezesseis palavras legítimas recuperadas.
// Chaves que carregam credencial como PARÂMETRO de URL ou SEGMENTO de rota sem serem, por si,
// palavra do vocabulário sensível — o `code` de um fluxo OAuth, a `assertion` de um SAML. Entram nas
// regras de URL (texto e sanitizador de evidência) e NÃO no vocabulário de chave, para `code` não
// tarjar qualquer campo de código do produto. Medido na revisão da 1.1.28: `?code=`, `#code=`,
// `#assertion=` e a rota `#/authorize/code/X` chegavam a cinco superfícies entregues.
const URL_CREDENTIAL_KEY_SOURCE = String.raw`code|access[-_]?token|refresh[-_]?token|id[-_]?token|assertion|saml[-_]?response`;
// A chave pode vir percent-encoded (`?co%64e=`, `?%43ODE=`), e é isso que decide se o valor sai: a
// decodificação acontece ANTES do teste, com `decodeURIComponent` protegido (entrada hostil não pode
// derrubar o tarjador).
function decodeKeySafely(key) {
  try { return decodeURIComponent(String(key ?? '')); } catch { return String(key ?? ''); }
}
function credentialKey(key) {
  const decoded = decodeKeySafely(key);
  return isSensitiveKey(decoded) || URL_CREDENTIAL_KEY.test(decoded);
}
export const URL_CREDENTIAL_KEY = new RegExp(String.raw`^(?:${URL_CREDENTIAL_KEY_SOURCE})$`, 'iu');
// O que segue o rótulo precisa TER CARA DE VALOR para a cauda ser tarjada: dígito, símbolo,
// maiúscula e minúscula misturadas ou comprimento de segredo. Sem isso, rótulos legítimos como
// `Senha da conta` e `Chave da API` — que são nomes acessíveis de verdade, medidos nos testes do
// normalizador — viravam `Senha [redacted]`, e o relatório perdia a evidência do rótulo.
// "Cara de valor" é decidida por TOKEN, não por classe de caractere: `Segredo.Forte` e `Segredo!Forte`
// são valores (símbolo no MEIO do token), enquanto `atual.` é prosa (o ponto é a pontual final da
// frase). Comprimento de segredo (12+) e dígito continuam valendo, e é isso que restaura
// `senha ZQXJKVBWPMTLRNHS`, que a 1.1.29 tarjava e a 1.1.30 havia perdido.
// Rótulo de VÁRIAS palavras (`cartão de crédito`, `senha do usuário do sistema`) exige token FORTE:
// comprimento de segredo, ou 6+ caracteres com dígito/símbolo. Com o critério largo, prosa como
// `A senha deve ter 8 caracteres` voltaria a acender (o token `8`).
// Para a cauda de rótulo MULTI-PALAVRA o critério é mais estreito: uma palavra comprida de prosa
// (`complexidade`, `intransferível`, `fiscalização`) ou uma data curta (`12/03`) não são valor. Exige
// 6+ caracteres COM dígito ou símbolo — foi o falso positivo destrutivo medido na revisão da 1.1.32.
// Data e hora NÃO são valor de credencial no scanner largo: `A senha foi alterada em 12/03/2026 pelo
// administrador.` era tarjada inteira (falso positivo medido na revisão da 1.1.33), porque o token com
// dígito e barra tem cara de valor. O ano de quatro dígitos é o que dispara — `12/03` já passava.
const DATE_LIKE = /^\d{1,4}(?:[\/\-.]\d{1,4}){1,2}$|^\d{1,2}:\d{2}(?::\d{2})?$|^\d{1,4}-\d{1,2}-\d{1,2}T/u;
/**
 * Tira, ANTES de decidir "cara de valor": a marca interna do camelCase, a marcação colada na cauda
 * (`</p>`, que fazia `comprimento` virar sinal de valor e destruía prosa no caminho JSON — medido pela
 * revisão da 1.1.33) e a pontuação final de frase.
 */
function valueCore(token) {
  return stripCamelMarks(token)
    .replace(/<\/?[a-z][^>]*>/giu, '')
    .replace(/[<>]/gu, '')
    .replace(/[.!?,;:\u2026"')\]}]+$/u, '');
}
function credentialLikeToken(token) {
  const core = valueCore(token);
  if ([...core].length < 6 || DATE_LIKE.test(core)) return false;
  return /\d|[^\p{L}\p{N}\s]/u.test(core);
}

function strongValueToken(token) {
  const core = valueCore(token);
  if ([...core].length >= 12) return true;
  // Número de cartão: o primeiro token é curto, mas é claramente valor (`4111 2222 …`).
  if ((core.match(/\d/gu) ?? []).length >= 4) return true;
  return [...core].length >= 6 && /\d|[^\p{L}\p{N}\s]/u.test(core);
}

function valueLikeToken(token) {
  const text = String(token ?? '');
  if (text.length === 0) return false;
  const core = valueCore(text);
  if (/\d/u.test(core)) return true;
  if ([...core].length >= 12) return true;
  return /[^\p{L}\p{N}\s]/u.test(core);
}
const SENSITIVE_WORD_SOURCE = String.raw`${WORD_RADICAL_SOURCE}|${PHRASE_RADICAL_SOURCE}`;
export const SENSITIVE_KEY = new RegExp(
  `(?:${CREDENTIAL_RADICAL_SOURCE}|${BARE_PASS_SOURCE}|${COMPOUND_CREDENTIAL_SOURCE}|${SENSITIVE_WORD_SOURCE})`, 'iu');
/**
 * Testa CHAVE ou nome de atributo — não prosa. A marca de camelCase é aplicada aqui porque uma chave
 * camelCase é uma palavra só (`senhaAtual`, `data-userpin`, `apiKeys`): sem a marca, a fronteira de
 * palavra que protege a prosa (`Chaveiro:`) recusaria a chave legítima.
 */
export function isSensitiveKey(value) {
  return SENSITIVE_KEY.test(withCamelMarks(String(value ?? '')));
}
// Pré-filtro barato: se a string não contém NENHUM radical (nem as chaves de URL), nenhuma regra de
// rótulo pode morder, e as regexes caras de fronteira não precisam varrer o texto. Sem ele o tarjador do
// modelo ficava 3× mais lento que a geração anterior; com ele o custo volta ao da 1.1.33 e a semântica
// não muda, porque a lista é a mesma fonte do vocabulário.
// As chaves de URL entram nas TRÊS grafias que o padrão aceita (colada, com `_` e com `-`): gerar só a
// forma colada deixava `?saml_response=` fora do pré-filtro — e o pré-filtro é a porta: sem ele a
// varredura cara nem roda. Falso negativo medido na rodada 74.
const URL_KEY_HINTS = URL_CREDENTIAL_KEY_SOURCE.split('|').flatMap(part => [
  part.replace(/\[-_\]\?/gu, ''), part.replace(/\[-_\]\?/gu, '_'), part.replace(/\[-_\]\?/gu, '-'), part,
]);
const STEM_HINT = new RegExp([
  ...WORD_STEMS, ...WHOLE_WORD_STEMS, 'pass',
  // A PRIMEIRA parte de cada radical de várias palavras, em TODAS as variantes (com e sem acento):
  // `api` cobre `api_key`, `linha` cobre `linha digitável`, `código`/`codigo` cobrem `código de barras`.
  // As partes seguintes não entram porque `de` apareceria em quase toda frase e o pré-filtro perderia a
  // função.
  ...PHRASE_STEMS.flatMap(parts => parts[0]),
  ...URL_KEY_HINTS,
].map(escapeLiteral).join('|'), 'iu');
// Codificação também conta como candidato: `sen&#104;a`, `sen\u0068a` e `sen%68a` escondem o rótulo do
// pré-filtro literal, e são justamente as formas que as revisões da 1.1.28 e da 1.1.29 mediram.
const ENCODED_HINT = /&#|\\u[0-9a-f]{4}|\\x[0-9a-f]{2}|%[0-9a-f]{2}/iu;
function mayCarryCredential(value) {
  const text = String(value ?? '');
  // O pré-filtro olha o texto SEM os caracteres invisíveis: `sen\u200bha` esconde o radical de uma
  // comparação literal e era justamente por onde a evasão passava.
  return STEM_HINT.test(text) || ENCODED_HINT.test(text) || STEM_HINT.test(text.replace(INVISIBLE_MARKS, ''));
}

// Um rótulo de valor não exige fronteira de palavra de nenhum lado — nem `\b` à esquerda, nem `\b` à
// direita: `myPass: 1234` e `userPassword: 1234` são a mesma credencial que `pass: 1234`, e o `\b`
// deixava as duas passarem. Quem faz a fronteira é o próprio separador, que precisa vir logo depois do
// rótulo; o preço são falsos positivos estreitos como `surpass:` e `obsessão:`, que precisam do
// separador para morder — e esse preço é aceito na direção segura.
// O rótulo aceita um sufixo curto de letras e dígitos: `tokens:`, `secrets:`, `sessions:`,
// `cookies:`, `apiKeys:`, `senhaAtual:`, `credenciaisDeAcesso:`, `chaveDeApi:` e `authentication:` são a
// MESMA credencial que a forma simples, e passavam intactos porque o separador tinha de vir colado na
// palavra (Minor M1 da revisão da 1.1.28). O sufixo não afeta a exceção ancorada dos atributos de
// rótulo, que usa o vocabulário de chave sem sufixo.
// Segmento de rota com credencial (`#/authorize/code/X`): a chave entra no PRÓPRIO padrão para o
// motor não consumir um segmento inocente e pular o seguinte, que era o que deixava a rota passar.
const URL_CREDENTIAL_SEGMENT = new RegExp(
  String.raw`([#/])((?:${URL_CREDENTIAL_KEY_SOURCE}|${SENSITIVE_WORD_SOURCE})/)([^/?#\s]*)`, 'giu');
// Rota com a chave percent-encoded (`#/authorize/co%64e/X`): uma segunda passada decodifica o segmento.
const URL_CREDENTIAL_SEGMENT_ENCODED = /([#/])([^/?#\s]*%[0-9a-f]{2}[^/?#\s]*)\/([^/?#\s]*)/giu;
// O rótulo casa a PALAVRA inteira (a fronteira está no vocabulário); o sufixo `[\p{L}\p{N}]{0,24}` que
// existia aqui era o que transformava `Chaveiro` em rótulo e é o que a 1.1.34 remove. O camelCase
// continua coberto pela marca (`senha\u0001Atual`).
const VALUE_LABEL_ADJACENT_SOURCE = String.raw`(?:${CREDENTIAL_RADICAL_SOURCE}|${BARE_PASS_SOURCE}|${COMPOUND_CREDENTIAL_SOURCE}|${URL_CREDENTIAL_KEY_SOURCE}|${SENSITIVE_WORD_SOURCE})`;
// A janela do rótulo descritivo vai até OITO palavras: a revisão da 1.1.33 mediu sete palavras entre o
// rótulo e o valor chegando às quatro superfícies (`chave de acesso ao sistema principal da conta X`).
const VALUE_LABEL_SOURCE = String.raw`${VALUE_LABEL_ADJACENT_SOURCE}(?:[\s\-–—\u0001]+[(\[]?[\p{L}\p{N}]{1,24}[)\]]?){0,6}?`;
// O valor vai até o fim da linha, sem teto, sem terminador e sem alternativa entre aspas. Duas
// revisões seguidas mediram a mesma classe por caminhos diferentes: a 1.1.26 tinha o teto de 120
// caracteres e o `;` devolvendo a cauda; a 1.1.27 tirou o teto mas manteve `<` como parada e a
// alternativa entre aspas, e as duas coisas devolviam o valor — `senha: <SEGREDO>` casava só o espaço
// (o `[^\n<]+` é obrigatório e não pode começar em `<`, então o motor fazia backtracking do separador
// e escrevia `[redacted]` AO LADO do valor intacto), `senha: ""SEGREDO` casava a string vazia, e
// `{"senha": "SEGREDO"}` nem casava, porque a aspa de fechamento da chave ficava entre o rótulo e o
// separador. Agora o valor é qualquer coisa até a quebra de linha, e o separador aceita a aspa e as
// setas de quem escreve credencial em código.
const VALUE_SOURCE = String.raw`\S[^\n]*`;
// O separador aceita a aspa — literal, escapada de JSON (`\"`) ou codificada em entidade
// (`&quot;`, `&#34;`, `&#x22;`) — porque `{"senha": "X"}` e `{&quot;senha&quot;: &quot;X&quot;}` são a
// mesma credencial, e era exatamente a aspa entre o rótulo e o `:` que fazia essas formas passarem
// depois do primeiro conserto (medido na revisão da 1.1.28).
const VALUE_SEPARATOR_SOURCE = String.raw`(\s*(?:(?:<[^<>]{0,200}>)|&(?:amp;)?(?:quot|#0*34|#x0*22);|&(?:amp;)?(?:nbsp|#0*160|#x0*a0);|\\*['"]|\\[tnrfv]|\s){0,20}(?:&(?:amp;)?(?:#0*58|#x0*3a|colon);|%3a|%3d|[:=]|->|=>|→)\s*)`;
// Um fragmento de texto que TERMINA no rótulo com o separador está esperando o valor no nó
// seguinte (`<p>senha: <code>…</code></p>`, `<th>chave:</th><td>…</td>`). O sanitizador de trecho
// usa este predicado para tratar o que vem depois como valor, em vez de confiar que rótulo e valor
// moram no mesmo nó de texto — que era a forma exata que continuava vazando na 1.1.27.
// O valor capturado é o PRIMEIRO token depois do separador; a decisão é do predicado.
const ANY_CREDENTIAL_LABEL_VALUE = new RegExp(
  `(?:${VALUE_LABEL_SOURCE})${VALUE_SEPARATOR_SOURCE}(\\S+)`, 'iu');
const DANGLING_CREDENTIAL_LABEL = new RegExp(
  `(?:${VALUE_LABEL_SOURCE})${VALUE_SEPARATOR_SOURCE}$`, 'iu');
const ANY_CREDENTIAL_LABEL_TAIL = new RegExp(
  `(?:${VALUE_LABEL_ADJACENT_SOURCE})[\\s]*[-\u2013\u2014:]*[\\s]*(\\S+)`, 'iu');
const DANGLING_VALUE_LABEL = new RegExp(`(?:${VALUE_LABEL_SOURCE})${VALUE_SEPARATOR_SOURCE}$`, 'iu');
export { canonicalNavigationUrl, isEvidenceUrlV1, sanitizeEvidenceUrlV1 } from './privacy/evidence-url.js';

// Public storage failures stay independent from browser/IndexedDB error details,
// which may disclose URLs, database names or implementation-specific values.
export const AUDIT_STORAGE_UNAVAILABLE_MESSAGE = 'Não foi possível salvar a auditoria no armazenamento local. Libere espaço ou verifique as permissões e tente novamente.';

/** Marco 1 durable projection: resource identity is limited to its canonical origin. */
export function projectAuditResourceOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.href !== value) return '';
    return `${parsed.origin}/`;
  } catch {
    return '';
  }
}

const URL_ATTRIBUTE_KEYS = new Set(['action', 'cite', 'formaction', 'href', 'poster', 'src', 'currentSrc']);

const FIXED_WARNING_MESSAGES = Object.freeze({
  FRAME_RUNTIME_BLOCKED: 'A coleta runtime de um frame foi bloqueada.',
  RUNTIME_FRAME_MISSING: 'Um frame esperado não retornou dados runtime.',
  AX_FRAME_UNAVAILABLE: 'A árvore de acessibilidade de um frame não ficou disponível.',
  RUNTIME_MATCH_AMBIGUOUS: 'Dados runtime ambíguos não foram associados.',
  WARNINGS_UNAVAILABLE: 'Os avisos de coleta não puderam ser normalizados com segurança.',
  TIMEOUT: 'Uma medição excedeu o tempo limite.',
  ABORTED: 'A medição foi cancelada.',
  PROBE_FAILED: 'Uma medição dinâmica não pôde ser concluída.'
});

const WARNING_FIELDS = new Set(['code', 'frameId', 'message']);
const MAX_WARNING_CODE_LENGTH = 128;
const MAX_WARNING_MESSAGE_LENGTH = 1_024;
const MAX_WARNING_ITEMS = 1_024;

function projectWarning(input) {
  try {
    if (input === null || typeof input !== 'object') return null;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(input);
    if (keys.length > WARNING_FIELDS.size ||
      keys.some(key => typeof key !== 'string' || !WARNING_FIELDS.has(key))) return null;
    const projected = {};
    const present = new Set();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      projected[key] = descriptor.value;
      present.add(key);
    }
    if (!present.has('code') || typeof projected.code !== 'string' ||
      projected.code.length > MAX_WARNING_CODE_LENGTH ||
      (present.has('message') && (typeof projected.message !== 'string' ||
        projected.message.length > MAX_WARNING_MESSAGE_LENGTH)) ||
      (present.has('frameId') && projected.frameId !== null &&
        typeof projected.frameId !== 'string' && !Number.isSafeInteger(projected.frameId))) return null;
    return { projected, present };
  } catch {
    return null;
  }
}

function sanitizeProjectedWarning(observation) {
  const requested = observation ? observation.projected.code.trim().toUpperCase() : '';
  const code = Object.hasOwn(FIXED_WARNING_MESSAGES, requested) ? requested : 'PROBE_FAILED';
  const warning = { code, message: FIXED_WARNING_MESSAGES[code] };
  if (!observation) return warning;
  const { frameId } = observation.projected;
  if (typeof frameId === 'string' && /^[a-z0-9_-]{1,128}$/iu.test(frameId) && !isSensitiveKey(frameId)) warning.frameId = frameId;
  else if (Number.isSafeInteger(frameId)) warning.frameId = frameId;
  else if (observation.present.has('frameId')) warning.frameId = null;
  return warning;
}

function snapshotWarningCollection(input) {
  if (input === undefined || input === null) return { available: true, values: [] };
  try {
    if (!Array.isArray(input)) return { available: false, values: [] };
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
      lengthDescriptor.value > MAX_WARNING_ITEMS) return { available: false, values: [] };
    const values = new Array(lengthDescriptor.value);
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return { available: false, values: [] };
      values[index] = descriptor.value;
    }
    return { available: true, values };
  } catch {
    return { available: false, values: [] };
  }
}

function unavailableWarnings() {
  return [sanitizeProjectedWarning(projectWarning({ code: 'WARNINGS_UNAVAILABLE' }))];
}

export function sanitizeWarning(input) {
  return sanitizeProjectedWarning(projectWarning(input));
}

export function sanitizeWarnings(input) {
  const collection = snapshotWarningCollection(input);
  if (!collection.available) return unavailableWarnings();
  const warnings = [];
  for (const inputWarning of collection.values) {
    const projected = projectWarning(inputWarning);
    if (!projected) return unavailableWarnings();
    warnings.push(sanitizeProjectedWarning(projected));
  }
  return warnings;
}

// Dentro do fragmento pode haver consulta e rota (`#/authorize?code=X`, `#/callback/co%64e/X`): a
// varredura testa cada chave contra o mesmo predicado.
function hasCredentialInHash(hash) {
  const raw = String(hash ?? '');
  return raw.split(/[?&;/=]/u).some(part => part.length > 0 && credentialKey(part));
}

export function sanitizeEvidenceUrl(value, base = undefined) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  if (/^data:/iu.test(value)) return 'data:[redacted]';
  if (/^blob:/iu.test(value)) return 'blob:[redacted]';
  try {
    const url = base ? new URL(value, base) : new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.username = '';
    url.password = '';
    // A chave pode vir percent-encoded (`?co%64e=`): quem decide é o mesmo predicado do tarjador de
    // texto, que decodifica antes de testar e conhece as chaves de credencial de URL (`code`,
    // `assertion`, `saml_response`).
    for (const key of [...url.searchParams.keys()]) if (credentialKey(key)) url.searchParams.delete(key);
    if (credentialKey(url.hash.replace(/^#/u, '').split(/[?&=]/u)[0]) || hasCredentialInHash(url.hash)) url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

export function backgroundImageKind(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized || normalized === 'none') return 'none';
  const hasUrl = /url\s*\(/u.test(normalized);
  const hasGradient = /(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/u.test(normalized);
  if (hasUrl && hasGradient) return 'mixed';
  if (hasUrl) return 'url';
  if (hasGradient) return 'gradient';
  return 'mixed';
}

// O valor é consumido por INTEIRO (até 120 caracteres, parando em quebra de linha, `<` ou `;`), não
// só o primeiro token: `cartão: 4111 1111 1111 1111` deixava 12 dos 16 dígitos no texto (achado N2 da
// revisão da 1.1.25). O limite evita engolir uma linha inteira de prosa legítima.
/**
 * Tarja texto do autor que carrega credencial SEM separador — `senha abc`, `token abc`. É a forma que
 * o navegador entrega no nome acessível calculado a partir de `placeholder`/`alt`/`title`: o sanitizador
 * de trecho descarta o ATRIBUTO, mas o texto já calculado seguia para o relatório como nome acessível e
 * prévia de anúncio (I1 da revisão da 1.1.28). A regra exige conteúdo DEPOIS da palavra, então
 * `Digite sua senha` continua intacto — o rótulo puro não é segredo.
 */
// Candidato a cauda: rótulo seguido de ruído de separador e um token. A decisão é do tarjador.
const TAIL_CANDIDATE = new RegExp(
  String.raw`(?:${VALUE_LABEL_ADJACENT_SOURCE})[\s]*[-–—:]*[\s]*(?:<[^<>]{0,200}>[\s]*)*\S+`, 'giu');

// A SEGUNDA LEITURA, sem as marcas de camelCase. A marca resolve `senhaAtual` (o radical termina onde a
// maiúscula começa), mas ela quebra a palavra no meio quando a página mistura a caixa DENTRO do radical:
// `SeNhA:` era tarjado antes das marcas e deixou de ser. A leitura sem marcas roda só quando a primeira
// não achou nada e as marcas existem — o custo fica onde o caso existe.
function tailPasses(text) {
  return text
    // A marcação entre o rótulo e o valor é PULADA, não tratada como fim: era a guarda `[<>]` que fazia
    // `<p><b>senha</b> X</p>` e `<div title="senha X">` desistirem e entregarem a credencial (regressão
    // medida na revisão da 1.1.32).
    .replace(new RegExp(String.raw`(${VALUE_LABEL_ADJACENT_SOURCE})([\s]*[-–—:]*[\s]*(?:<[^<>]{0,200}>[\s]*)*)(\S+)`, 'giu'),
      (match, label, space, token) =>
        (valueLikeToken(token) && !match.includes('[redacted]') ? `${label}${space}[redacted]` : match))
    .replace(new RegExp(String.raw`(${VALUE_LABEL_SOURCE})([\s]*[-–—:]*[\s]*(?:<[^<>]{0,200}>[\s]*)*)(\S+)`, 'giu'),
      (match, label, space, token) =>
        (strongValueToken(token) && !match.includes('[redacted]') ? `${label}${space}[redacted]` : match));
}
export function redactCredentialLabelTail(value) {
  if (!mayCarryCredential(value)) return String(value ?? '');
  const marked = withCamelMarks(value);
  let text = tailPasses(marked);
  if (marked.includes(CAMEL_MARK)) text = tailPasses(stripCamelMarks(text));
  return stripCamelMarks(text);
}



// Rótulo de VÁRIAS palavras seguido de valor: o regex não consegue expressar "token com cara de valor"
// com a janela preguiçosa (o motor se compromete com a primeira segmentação), então a decisão é feita
// por um scanner de tokens — para cada palavra de credencial, tenta janelas de 0 a 8 palavras e testa o
// token seguinte com o predicado. É isso que fecha `cartão de crédito S3GR…` sem reabrir
// `A senha deve ter 8 caracteres`, e o teto de oito fecha a janela de sete palavras que a revisão da
// 1.1.33 mediu vazando (M1).
const LABEL_WORD = new RegExp(String.raw`^[(\[]?[\p{L}\p{N}\u0001]{1,24}[)\]]?$`, 'u');
const SEPARATOR_NOISE = /^[-–—:]+$/u;
function spacedLabelTailIndex(text) {
  const tokens = [...String(text ?? '').matchAll(/\S+/gu)].map(match => ({ value: match[0], index: match.index }));
  const firstWord = new RegExp(`^(?:${VALUE_LABEL_ADJACENT_SOURCE})$`, 'iu');
  for (let index = 0; index < tokens.length; index += 1) {
    if (!firstWord.test(tokens[index].value)) continue;
    for (let end = index; end < tokens.length && end - index <= 8; end += 1) {
      let next = end + 1;
      if (next < tokens.length && SEPARATOR_NOISE.test(tokens[next].value)) next += 1;
      if (next < tokens.length && credentialLikeToken(tokens[next].value)) return tokens[index].index;
      if (end + 1 >= tokens.length || !LABEL_WORD.test(tokens[end + 1].value)) break;
    }
  }
  return -1;
}
function spacedLabelTailSignal(text) {
  return spacedLabelTailIndex(text) >= 0;
}
// Depois do rótulo de várias palavras, a linha inteira sai tarjada — mesma decisão do rótulo com
// separador, e é o que impede `cartão de crédito S3GR…` de chegar ao entregável pelo caminho JSON.
function redactSpacedLabelTail(text) {
  const position = spacedLabelTailIndex(text);
  if (position < 0) return text;
  const endOfLine = text.indexOf('\n', position);
  return `${text.slice(0, position)}[redacted]${endOfLine < 0 ? '' : text.slice(endOfLine)}`;
}

/**
 * Sinal de credencial em TEXTO: rótulo com separador (`senha:`, `{"senha":`, `chave =`) ou rótulo com
 * cauda com cara de valor (`senha abc123`). É o gatilho da marcação por conteúdo do sanitizador de
 * trecho: uma vez aceso, nada depois volta a ser texto no trecho. Prosa legítima (`cartão de crédito`,
 * `chave do problema`, `Senha da conta`) não acende, porque a cauda exige dígito ou símbolo forte.
 */
function signalPasses(text) {
  // (1) rótulo + separador + valor com cara de valor; (2) rótulo + separador PENDENTE no fim do
  // acumulado (o valor está no nó seguinte); (3) rótulo ADJACENTE + valor com cara de valor.
  //
  // A exigência de "cara de valor" no ramo (1) é o que separa credencial de prosa: `Senha da conta:
  // alterada em 12/03` e `Chave da API: gere uma nova` são frases, e o primeiro token depois dos dois
  // pontos (`alterada`, `gere`) não tem dígito, símbolo nem comprimento de segredo. Já
  // `Senha atual: S3GR3D0XYZQ` e `senha: correcthorsebattery` continuam acendendo.
  const withSeparator = ANY_CREDENTIAL_LABEL_VALUE.exec(text);
  if (withSeparator) {
    // O primeiro token é o valor quando tem cara de valor, OU quando nada mais vem depois dele no
    // acumulado — porque aí o valor pode continuar no nó seguinte (`senha: Wwa<br>Wwb`). É essa segunda
    // condição que separa `senha: abc` de `Chave da API: consulte o manual.`: na frase, o token não é o
    // último e não tem cara de valor.
    if (valueLikeToken(withSeparator[2])) return true;
    const rest = text.slice(withSeparator.index + withSeparator[0].length);
    // O valor pode continuar depois de uma quebra de linha dentro do MESMO nó de texto
    // (`token: A\nB`): aí o resto começa com quebra, e o primeiro token não é o valor inteiro.
    if (rest.trim() === '' || /^[\r\n\u2028\u2029]/u.test(rest)) return true;
  }
  if (DANGLING_CREDENTIAL_LABEL.test(text)) return true;
  // Percorre TODAS as ocorrências: com a janela preguiçosa, a primeira pode ser `senha deve` e só uma
  // posterior (`cartão de crédito` + valor) ser a credencial.
  for (const match of text.matchAll(new RegExp(ANY_CREDENTIAL_LABEL_TAIL.source, 'giu'))) {
    if (valueLikeToken(match[1])) return true;
  }
  return spacedLabelTailSignal(text);
}

export function hasCredentialValueSignal(value) {
  if (!mayCarryCredential(value)) return false;
  const marked = withCamelMarks(value);
  if (signalPasses(marked)) return true;
  return marked === String(value ?? '') ? false : signalPasses(String(value ?? ''));
}

/** Verdadeiro quando o texto termina em rótulo de credencial com o separador, sem o valor. */
export function endsWithCredentialLabel(value) {
  return DANGLING_VALUE_LABEL.test(withCamelMarks(value));
}

// Portões baratos: cada regra de URL só roda quando o caractere que ela exige existe no texto, e a regra
// de rótulo com separador só roda quando há separador. Sem isso, cada string do modelo pagava a varredura
// completa das regexes de rótulo (o custo medido era 2,9× o da geração anterior em texto denso de radicais).
const HAS_SEPARATOR_SHAPE = /[:=]|->|=>|\u2192|%3a|%3d|&#0*(?:58|3a|61);|#x0*(?:3a|3d);/iu;
const HAS_URL_SHAPE = /[?&;#]/u;
const HAS_USERINFO_SHAPE = /@/u;
function sensitivePasses(marked) {
  let text = marked
    .replace(/\b(Bearer)(\s+)([^\s<]+)/giu, '$1$2[redacted]')
    // Tarja com DUAS condições, e é isso que separa credencial de prosa: o primeiro token depois do
    // separador tem cara de valor, OU o resto depois do separador é um token só (o valor inteiro, sem
    // frase). `senha: abc` cai na segunda; `Segredo de justiça: o processo tramita em sigilo.` não cai em
    // nenhuma, e por isso sobrevive — antes, o alargamento do rótulo para aceitar acento passou a tarjar
    // sete frases realistas (Important da revisão da 1.1.31).
    ;
  if (HAS_SEPARATOR_SHAPE.test(text)) text = text.replace(new RegExp(`(${VALUE_LABEL_SOURCE})${VALUE_SEPARATOR_SOURCE}(${VALUE_SOURCE})`, 'giu'),
      (match, label, separator, value) => {
        const tokens = value.trim().split(/\s+/u).filter(Boolean);
        const first = tokens[0] ?? '';
        const singleToken = tokens.length === 1;
        // `chave: ABC 123 DEF 456` é valor com o primeiro token sem dígito: dois tokens com cara de valor
        // já bastam. Prosa com um número solto (`mínimo de 8 caracteres`) tem só um.
        const valueLikeTokens = tokens.filter(token => valueLikeToken(token)).length;
        // Rótulo de UMA palavra (`passphrase: uma frase secreta longa`, `senha: p4ss;word`) é atribuição:
        // o valor inteiro sai. Rótulo DESCRITIVO de várias palavras (`Senha do usuário: mínimo de 8
        // caracteres.`) costuma ser prosa SOBRE a credencial, e aí só sai com valor com cara de valor —
        // foi essa a diferença medida pela revisão da 1.1.31 entre `passphrase:` e `Senha do usuário:`.
        const descriptiveLabel = !new RegExp(`^(?:${VALUE_LABEL_ADJACENT_SOURCE})$`, 'iu').test(label);
        if (!descriptiveLabel) return `${label}${separator}[redacted]`;
        return valueLikeToken(first) || singleToken || valueLikeTokens >= 2
          ? `${label}${separator}[redacted]`
          : match;
      });
  if (HAS_USERINFO_SHAPE.test(text)) {
    text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+:[^/@\s]+@/giu, '$1[redacted]@');
  }
  if (HAS_URL_SHAPE.test(text)) {
    text = text
      .replace(/([?&;#])([^=&\s#]+)=([^&#\s]*)/gu, (match, separator, key) =>
        (credentialKey(key) ? `${separator}${key}=[redacted]` : match))
      .replace(URL_CREDENTIAL_SEGMENT, '$1$2[redacted]')
      .replace(URL_CREDENTIAL_SEGMENT_ENCODED, (match, separator, key, value) =>
        (credentialKey(key) ? `${separator}${key}/[redacted]` : match));
  }
  // Rótulo SEM separador (`senha abc123`, `cartão de crédito S3GR…`, `senha - S3GR…`): a mesma regra
  // de cauda do nome acessível, para o caminho JSON não ficar mais frouxo que o do trecho.
  return text
    .replace(TAIL_CANDIDATE, match => (match.includes('[redacted]') ? match : redactCredentialLabelTail(match)))
    .replace(/[\s\S]+/u, match => redactSpacedLabelTail(match));
}
export function redactSensitiveText(value) {
  if (!mayCarryCredential(value)) return String(value ?? '');
  const marked = withCamelMarks(value);
  let text = sensitivePasses(marked);
  // Segunda leitura, sem marcas: `SeNhA:` é o mesmo rótulo que `senha:` para quem lê, e a marca que
  // resolve `senhaAtual` quebra a palavra no meio dele. Roda só quando houve marca a inserir.
  if (marked.includes(CAMEL_MARK)) text = sensitivePasses(stripCamelMarks(text));
  return stripCamelMarks(text);
}

// Uma string que CONTÉM marcação é fonte de HTML, não prosa: nela vale a regra estrita de cauda
// (`senha abc` vira `senha [redacted]`), porque foi assim que `data-note="<b>senha abc</b>"`
// atravessava o tarjador de valores, que exige separador. Prosa comum não tem marcação e continua
// intacta — foi a decisão que preservou o controle negativo do A1 ("A sessão discutiu o cartão…").
const NAMED_ENTITIES = [
  [/&(?:quot|#0*34|#x0*22);/giu, '"'], [/&(?:apos|#0*39|#x0*27);/giu, "'"],
  [/&(?:amp|#0*38|#x0*26);/giu, '&'], [/&(?:nbsp|#0*160|#x0*a0);/giu, ' '],
  [/&(?:lt|#0*60|#x0*3c);/giu, '<'], [/&(?:gt|#0*62|#x0*3e);/giu, '>'],
];
/**
 * Decodifica entidades e escapes para PODER OLHAR o texto, nunca para reescrevê-lo: `sen&#104;a`,
 * `sen\u0068a` e `&amp;quot;` são formas de esconder o rótulo, e um padrão que só olha a forma crua não
 * as enxerga. Três passagens cobrem a dupla codificação medida pelas revisões.
 */
export function decodeForMatching(value) {
  let text = String(value ?? '');
  for (let pass = 0; pass < 3; pass += 1) {
    const next = NAMED_ENTITIES
      .reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text)
      .replace(/&#x0*([0-9a-f]{1,6});/giu, (match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/&#0*([0-9]{1,7});/gu, (match, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
      .replace(/\\u([0-9a-f]{4})/giu, (match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/\\x([0-9a-f]{2})/giu, (match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      // Octal no estilo antigo de JavaScript (`\150` = 'h') e escapes literais de espaço (`senha\t:`)
      // são a mesma forma de esconder o rótulo que a entidade e o `\uXXXX`.
      .replace(/\\([0-7]{2,3})/gu, (match, oct) => String.fromCodePoint(Number.parseInt(oct, 8)))
      .replace(/\\t/gu, '\t').replace(/\\r/gu, '\r').replace(/\\f/gu, '\f').replace(/\\v/gu, '\v');
    if (next === text) break;
    text = next;
  }
  return text;
}

const MARKUP_BEARING = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?>/iu;
function redactStringValue(value) {
  // Mesmo pré-filtro na porta do modelo: a maior parte das strings (URL, id, classe, rótulo curto) não
  // contém radical nenhum e não precisa pagar a varredura.
  if (!mayCarryCredential(value)) return String(value ?? '');
  const redacted = redactSensitiveText(value);
  if (!MARKUP_BEARING.test(redacted)) return redacted;
  if (redacted.includes('[redacted]')) return redacted;
  // Rótulo e valor separados por MARCAÇÃO (`<b>senha</b> X`) não são vistos pelo tarjador de valores: a
  // decisão vem da PROJEÇÃO sem tags e sem entidades, e nesse caso a string inteira cai — é string do
  // autor que carrega credencial, não prosa do relatório.
  //
  // A decisão é tomada NA PROJEÇÃO, nunca na string com marcação: aplicar a regra de cauda no texto cru
  // fazia o token final carregar `</p>`, e aí `comprimento ou símbolo` virava "cara de valor" e
  // `<p>A senha deve ser forte</p>` saía como `<p>A [redacted]` — 11 de 13 frases realistas destruídas no
  // caminho JSON/MODELO, medido pela revisão da 1.1.33.
  const projection = decodeForMatching(redacted.replace(/<[^<>]*>/gu, ' '));
  if (redactCredentialLabelTail(projection).includes('[redacted]')) return '[redacted]';
  return hasCredentialValueSignal(projection) ? '[redacted]' : redacted;
}

export function sanitizeJsonData(value, ancestors = new WeakSet()) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactStringValue(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'object' || ancestors.has(value)) return null;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => sanitizeJsonData(item, ancestors));
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveKey(key)) output[key] = '[redacted]';
      else if (URL_ATTRIBUTE_KEYS.has(key) && typeof item === 'string') output[key] = sanitizeEvidenceUrl(item);
      else output[key] = sanitizeJsonData(item, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function editableControl(node) {
  const tagName = String(node?.tagName || '').toLowerCase();
  const attributes = node?.attributes && typeof node.attributes === 'object' ? node.attributes : {};
  const contenteditable = String(attributes.contenteditable ?? '').trim().toLowerCase();
  return ['input', 'select', 'textarea'].includes(tagName) || (
    Object.hasOwn(attributes, 'contenteditable') && !['false', 'inherit'].includes(contenteditable)
  );
}

function contentEditableControl(node) {
  const tagName = String(node?.tagName || '').toLowerCase();
  if (['input', 'select', 'textarea'].includes(tagName)) return false;
  const attributes = node?.attributes && typeof node.attributes === 'object' ? node.attributes : {};
  const value = String(attributes.contenteditable ?? '').trim().toLowerCase();
  return Object.hasOwn(attributes, 'contenteditable') && !['false', 'inherit'].includes(value);
}

function safeIdRefs(value) {
  const tokens = String(value ?? '').trim().split(/\s+/u).filter(Boolean);
  return tokens.length > 0 && tokens.every(token => /^[a-z_][a-z0-9_.:-]*$/iu.test(token) && !isSensitiveKey(token))
    ? tokens.join(' ')
    : '';
}

// An aria-label is prose, not an identifier: it may contain spaces and punctuation, so the
// identifier gate above cannot judge it. What it must never carry is a credential or an
// unbounded blob of page content, hence the length bound and the sensitive-word rejection.
const MAX_AUTHORED_LABEL = 512;
function safeAuthoredLabel(value) {
  const label = String(value ?? '').trim().replace(/\s+/gu, ' ');
  return label.length > 0 && label.length <= MAX_AUTHORED_LABEL &&
    !/[\u0000-\u001F\u007F]/u.test(label) && !isSensitiveKey(label)
    ? label
    : '';
}

function contentEditableRootAttributes(attributes) {
  const output = {};
  for (const [name, rawValue] of Object.entries(attributes || {})) {
    const value = String(rawValue ?? '').trim();
    if (name === 'contenteditable') {
      const normalized = value.toLowerCase();
      if (['', 'true', 'plaintext-only'].includes(normalized)) output[name] = normalized;
    } else if (name === 'role') {
      const normalized = value.toLowerCase();
      if (/^[a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)*$/u.test(normalized) && !isSensitiveKey(normalized)) output[name] = normalized;
    } else if (name === 'tabindex') {
      if (/^-?\d+$/u.test(value)) output[name] = String(Number(value));
    } else if (name === 'aria-labelledby' || name === 'aria-describedby') {
      const references = safeIdRefs(value);
      if (references) output[name] = references;
    } else if (name === 'aria-label') {
      // The name a custom editable widget exposes to assistive technology is declared by the
      // page author, not typed by the user; what the user typed is the element's contents and
      // stays redacted. Without this declaration the field arrives anonymous and no rule can
      // judge it, which is a false negative, not privacy. The same gate that rejects
      // sensitive-looking identifiers applies here.
      const label = safeAuthoredLabel(value);
      if (label) output[name] = label;
    } else if (name === 'id') {
      // Only the author sets an id, and it is what lets a label, a description or a group
      // point at this field. safeIdRefs already rejects whitespace, so a value with spaces
      // never becomes an identifier, and a sensitive-looking value is dropped.
      const identifier = safeIdRefs(value);
      if (identifier) output[name] = identifier;
    }
  }
  return output;
}

function removeRuntimeValues(value, ancestors = new WeakSet()) {
  if (!value || typeof value !== 'object' || ancestors.has(value)) return;
  ancestors.add(value);
  try {
    for (const key of Object.keys(value)) {
      if (/^(?:value|currentValue|rawValue|inputValue)$/iu.test(key)) delete value[key];
      else removeRuntimeValues(value[key], ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

/** Final privacy boundary for a fully merged normalized node. */
export function redactNormalizedNode(input, {
  executable = false,
  privateText = false,
  privateTextRoot = false,
  privateTextDescendant = false,
  privateTextAncestor = false,
  preserveAccessibleText = false,
} = {}) {
  const node = sanitizeJsonData(input);
  node.attributes = node.attributes && typeof node.attributes === 'object' ? node.attributes : {};
  for (const name of Object.keys(node.attributes)) {
    if (name === 'style' || name === 'srcdoc' || /^on/iu.test(name)) delete node.attributes[name];
  }
  const editable = editableControl(node);
  if (editable || privateText || privateTextAncestor || executable) delete node.charactersPerLine;
  if (editable) {
    delete node.attributes.value;
    delete node.attributes['aria-valuenow'];
    delete node.attributes['aria-valuetext'];
    delete node.axValue;
    node.text = '';
    node.visibleText = '';
    removeRuntimeValues(node);
    delete node.form?.selectedIndex;
    delete node.form?.selectionStart;
    delete node.form?.selectionEnd;
    node.valueStatus = 'omitted-privacy';
  }
  if (node.tagName === 'option') {
    delete node.attributes.value;
    delete node.attributes.selected;
    delete node.attributes['aria-selected'];
    delete node.selected;
    delete node.form?.selected;
  }
  if (privateText) {
    node.text = '';
    node.visibleText = '';
    removeRuntimeValues(node);
    if (!preserveAccessibleText) {
      delete node.axValue;
      delete node.accessibleName;
      delete node.accessibleDescription;
    }
  }
  if (privateTextAncestor) node.visibleText = '';
  if (privateTextRoot && contentEditableControl(node)) {
    node.attributes = contentEditableRootAttributes(node.attributes);
    node.selectorHint = '';
    delete node.media;
  }
  if (privateTextDescendant) {
    node.attributes = {};
    node.selectorHint = '';
    delete node.media;
    delete node.form;
    delete node.styles;
    delete node.animations;
    delete node.backgroundImageKind;
    delete node.axValue;
    if (!preserveAccessibleText) {
      delete node.accessibleName;
      delete node.accessibleDescription;
    }
  }
  if (executable) {
    node.text = '';
    node.visibleText = '';
    delete node.axValue;
    delete node.accessibleName;
    delete node.accessibleDescription;
  }
  if (node.styles && typeof node.styles === 'object') {
    const rawBackground = node.styles['background-image'] ?? node.styles.backgroundImage;
    if (rawBackground !== undefined && node.backgroundImageKind === undefined) node.backgroundImageKind = backgroundImageKind(rawBackground);
    delete node.styles['background-image'];
    delete node.styles.backgroundImage;
  }
  return node;
}
