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
const CREDENTIAL_RADICAL_SOURCE = String.raw`pass[-_ ]?(?:word|wd|wrd|w0rd|wort|w[öo]rter|code|phrase|key|kod(?:e)?|frase|satz|passe)(?:s|es|er|en)?`;
const COMPOUND_CREDENTIAL_SOURCE = String.raw`palavra[-_ ]?passe|frase[-_ ]?passe|mot[-_ ]?de[-_ ]?passe`;
const BARE_PASS_SOURCE = String.raw`(?<!by)(?<!com)pass(?!ed|es|ive|ing|o|age|port|[-_a-z])`;
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
  return SENSITIVE_KEY.test(decoded) || URL_CREDENTIAL_KEY.test(decoded);
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
function valueLikeToken(token) {
  const text = String(token ?? '');
  if (text.length === 0) return false;
  const core = text.replace(/[.!?,;:…"')\]}]+$/u, '');
  if (/\d/u.test(text)) return true;
  if ([...core].length >= 12) return true;
  return /[^\p{L}\p{N}\s]/u.test(core);
}
const SENSITIVE_WORD_SOURCE = String.raw`pwd|bearer|token|secret|authoriz(?:ations?)|authoris(?:ations?)|auth(?!or)|session|cookie|csrf|xsrf|otp|one[-_ ]?time|api[-_ ]?key|senhas?|segredos?|credenci(?:al|ais)|sess(?:[ãa]o|[õo]es|ao|oes)|autentica(?:[çc][ãa]o|[çc][õo]es|cao|coes)|autoriza(?:[çc][ãa]o|[çc][õo]es|cao|coes)|chaves?|cpf|cnpj|cart(?:[ãa]o|[õo]es|ao|oes)`;
export const SENSITIVE_KEY = new RegExp(
  `(?:${CREDENTIAL_RADICAL_SOURCE}|${BARE_PASS_SOURCE}|${COMPOUND_CREDENTIAL_SOURCE}|${SENSITIVE_WORD_SOURCE})`, 'iu');

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
const VALUE_LABEL_ADJACENT_SOURCE = String.raw`(?:${CREDENTIAL_RADICAL_SOURCE}|${BARE_PASS_SOURCE}|${COMPOUND_CREDENTIAL_SOURCE}|password|authorization|${URL_CREDENTIAL_KEY_SOURCE}|${SENSITIVE_WORD_SOURCE})[\p{L}\p{N}]{0,24}`;
const VALUE_LABEL_SOURCE = String.raw`${VALUE_LABEL_ADJACENT_SOURCE}(?:[\s]+[\p{L}\p{N}]{1,24}){0,2}`;
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
const VALUE_SEPARATOR_SOURCE = String.raw`(\s*(?:(?:<[^<>]{0,200}>)|&(?:amp;)?(?:quot|#0*34|#x0*22);|&(?:amp;)?(?:nbsp|#0*160|#x0*a0);|\\*['"]|\s){0,20}(?:&(?:amp;)?(?:#0*58|#x0*3a|colon);|%3a|%3d|[:=]|->|=>|→)\s*)`;
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
  `(?:${VALUE_LABEL_ADJACENT_SOURCE})[\\s]+(\\S+)`, 'iu');
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
  if (typeof frameId === 'string' && /^[a-z0-9_-]{1,128}$/iu.test(frameId) && !SENSITIVE_KEY.test(frameId)) warning.frameId = frameId;
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
export function redactCredentialLabelTail(value) {
  return String(value ?? '').replace(
    new RegExp(`(${VALUE_LABEL_ADJACENT_SOURCE})(\\s+)(\\S+)`, 'giu'),
    (match, label, space, token) => (valueLikeToken(token) ? `${label}${space}[redacted]` : match));
}

/**
 * Sinal de credencial em TEXTO: rótulo com separador (`senha:`, `{"senha":`, `chave =`) ou rótulo com
 * cauda com cara de valor (`senha abc123`). É o gatilho da marcação por conteúdo do sanitizador de
 * trecho: uma vez aceso, nada depois volta a ser texto no trecho. Prosa legítima (`cartão de crédito`,
 * `chave do problema`, `Senha da conta`) não acende, porque a cauda exige dígito ou símbolo forte.
 */
export function hasCredentialValueSignal(value) {
  const text = String(value ?? '');
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
  const withTail = ANY_CREDENTIAL_LABEL_TAIL.exec(text);
  return Boolean(withTail) && valueLikeToken(withTail[1]);
}

/** Verdadeiro quando o texto termina em rótulo de credencial com o separador, sem o valor. */
export function endsWithCredentialLabel(value) {
  return DANGLING_VALUE_LABEL.test(String(value ?? ''));
}

export function redactSensitiveText(value) {
  return String(value ?? '')
    .replace(/\b(Bearer)(\s+)([^\s<]+)/giu, '$1$2[redacted]')
    .replace(new RegExp(`(${VALUE_LABEL_SOURCE})${VALUE_SEPARATOR_SOURCE}${VALUE_SOURCE}`, 'giu'), '$1$2[redacted]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+:[^/@\s]+@/giu, '$1[redacted]@')
    .replace(/([?&;#])([^=&\s#]+)=([^&#\s]*)/gu, (match, separator, key, value) =>
      (credentialKey(key) ? `${separator}${key}=[redacted]` : match))
    .replace(URL_CREDENTIAL_SEGMENT, '$1$2[redacted]')
    .replace(URL_CREDENTIAL_SEGMENT_ENCODED, (match, separator, key, value) =>
      (credentialKey(key) ? `${separator}${key}/[redacted]` : match));
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
  const redacted = redactSensitiveText(value);
  if (!MARKUP_BEARING.test(redacted)) return redacted;
  const withTailRule = redactCredentialLabelTail(redacted);
  // Rótulo e valor separados por MARCAÇÃO (`<b>senha</b> X`) não são vistos pelo tarjador de valores,
  // que exige o separador colado: a projeção sem tags (e sem entidades) é quem decide, e nesse caso a
  // string inteira cai — é string do autor que carrega credencial, não prosa do relatório.
  if (withTailRule.includes('[redacted]')) return withTailRule;
  const projection = decodeForMatching(redacted.replace(/<[^<>]*>/gu, ' '));
  return hasCredentialValueSignal(projection) ? '[redacted]' : withTailRule;
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
      if (SENSITIVE_KEY.test(key)) output[key] = '[redacted]';
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
  return tokens.length > 0 && tokens.every(token => /^[a-z_][a-z0-9_.:-]*$/iu.test(token) && !SENSITIVE_KEY.test(token))
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
    !/[\u0000-\u001F\u007F]/u.test(label) && !SENSITIVE_KEY.test(label)
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
      if (/^[a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)*$/u.test(normalized) && !SENSITIVE_KEY.test(normalized)) output[name] = normalized;
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
