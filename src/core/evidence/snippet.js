import { decodeForMatching, hasCredentialValueSignal, isLanguageWordStrictForm, isPairedCredentialIdentity, isSensitiveKey, looksLikeFieldValue, isSensitiveKeyName, isSensitiveValue, redactCredentialLabelTail, redactSensitiveText, SENSITIVE_KEY, withCamelMarks } from '../privacy.js';

// Este arquivo tinha o TERCEIRO e o QUARTO vocabulário do produto: `SENSITIVE` e `PRIVATE_ATTRIBUTE`
// eram cópias próprias, só em inglês, e `sanitizeText` consumia um único token. Medido numa auditoria
// real: `senha: S3GR3D0XYZQ` chegava intacto ao modelo, ao relatório e aos artefatos, e
// `data-note="cartão: 4111 1111 1111 1111"` era copiado literalmente, porque a regra de valor só
// procurava a palavra sensível e nunca tarjava o que vinha depois do rótulo. As duas listas passam a
// vir do mesmo radical de `privacy.js` — a divergência entre cópias foi a causa das três regressões
// desta família (A1/N2 na 1.1.25, Important na 1.1.26, este vazamento) — e o texto usa o mesmo
// tarjador de valores do resto do produto.
const SENSITIVE = SENSITIVE_KEY;
const PRIVATE_ATTRIBUTE = new RegExp(
  String.raw`(?:^(?:data-(?:audita-)?private|data-nosnippet)$|${SENSITIVE_KEY.source})`, 'iu');
const EXECUTABLE = new Set(['script', 'style', 'template']);
// Atributos que carregam texto legível para pessoas: um valor como `aria-label="Senha"` é evidência
// útil e não é segredo, então não pode ser descartado só por MENCIONAR a palavra. O tarjador de
// valores continua agindo neles (`aria-label="senha: abc"` vira `senha: [redacted]`).
const LABEL_ATTRIBUTES = new Set(['aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription',
  'alt', 'placeholder', 'title']);
// Um atributo de rótulo sobrevive quando o valor é SÓ o rótulo da credencial (`aria-label="Senha"`),
// que é evidência útil e não segredo; qualquer conteúdo depois da palavra volta à regra conservadora de
// descartar o atributo inteiro. A primeira versão do conserto dispensava a regra para rótulos e com isso
// `title="token abc123"` passou a sobreviver, quando na 1.1.26 ele era descartado — enfraquecer uma
// proteção existente para preservar evidência não é conserto.
const SENSITIVE_LABEL_ONLY = new RegExp(`^(?:${SENSITIVE_KEY.source})$`, 'iu');
// Fragmento de URL pode carregar credencial de fluxo OAuth (`#/authorize?code=…`). A 1.1.26 apagava o
// fragmento por acidente — o `auth` nu casava `authorize` —, e o A7 (correto) tirou esse acidente e
// deixou o `code` passar. A regra passa a ser explícita: chave de credencial dentro do fragmento apaga o
// fragmento inteiro.
const FRAGMENT_CREDENTIAL_KEY = /(?:^|[?&;])(?:code|access[-_]?token|refresh[-_]?token|id[-_]?token|token|assertion|saml[-_]?response|password|senha|chave|secret)=/iu;
const URL_ATTRIBUTES = new Set(['action', 'cite', 'formaction', 'href', 'poster', 'src']);
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function scanTag(html, start) {
  let quote = '';
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return { text: html.slice(start, index + 1), end: index + 1 };
  }
  return null;
}

function parseTag(token) {
  const closing = /^<\s*\//u.test(token);
  const selfClosing = /\/\s*>$/u.test(token);
  const inner = token.slice(1, -1).replace(/^\s*\//u, '').replace(/\/\s*$/u, '');
  const nameMatch = /^\s*([^\s/>]+)/u.exec(inner);
  if (!nameMatch) return null;
  const name = nameMatch[1].toLowerCase();
  if (!/^[a-z][a-z0-9:-]*$/u.test(name)) return null;
  if (closing) return { name, closing, selfClosing, attributes: [] };
  const attributes = [];
  let position = nameMatch.index + nameMatch[0].length;
  while (position < inner.length) {
    while (/\s/u.test(inner[position] || '')) position += 1;
    if (position >= inner.length) break;
    const attrMatch = /^[^\s=/>]+/u.exec(inner.slice(position));
    if (!attrMatch) break;
    const attrName = attrMatch[0].toLowerCase();
    position += attrMatch[0].length;
    while (/\s/u.test(inner[position] || '')) position += 1;
    let value = null;
    if (inner[position] === '=') {
      position += 1;
      while (/\s/u.test(inner[position] || '')) position += 1;
      const quote = inner[position];
      if (quote === '"' || quote === "'") {
        position += 1;
        const end = inner.indexOf(quote, position);
        value = end < 0 ? inner.slice(position) : inner.slice(position, end);
        position = end < 0 ? inner.length : end + 1;
      } else {
        const unquoted = /^[^\s>]+/u.exec(inner.slice(position));
        value = unquoted?.[0] ?? '';
        position += value.length;
      }
    }
    attributes.push({ name: attrName, value });
  }
  return { name, closing, selfClosing, attributes };
}

function sanitizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const absolute = /^[a-z][a-z0-9+.-]*:/iu.test(value);
  try {
    const url = new URL(value, 'https://snippet.invalid/');
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) if (isSensitiveKeyName(key)) url.searchParams.delete(key);
    if (isSensitiveKeyName(url.hash) || FRAGMENT_CREDENTIAL_KEY.test(url.hash)) url.hash = '';
    if (absolute) return url.href;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function escapeAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function sanitizeText(value) {
  return redactSensitiveText(value);
}

function contentEditableTag(parsed) {
  if (parsed.closing || ['input', 'select', 'textarea'].includes(parsed.name)) return false;
  const values = Object.fromEntries(parsed.attributes.map(attribute => [attribute.name, attribute.value ?? '']));
  const value = String(values.contenteditable ?? '').trim().toLowerCase();
  return Object.hasOwn(values, 'contenteditable') && !['false', 'inherit'].includes(value);
}

// O RÓTULO PODE ESTAR NO IDENTIFICADOR, e não no texto: `<div id="senhaassinatura">borboleta</div>`,
// `<div id="chavepix" title="girassol">`, `<div class="senhaassinatura">borboleta</div>`. O valor está
// no conteúdo do elemento ou num atributo do MESMO elemento, e o sinal de conteúdo não o enxerga porque
// o rótulo não passa pelo fluxo de texto. A revisão da 1.1.40 mediu esse valor chegando ao modelo, ao
// HTML e ao JSON com o rótulo no `id`/`class` (Important I-1), idêntico na 1.1.39.
// O texto de um elemento que CARREGA NOME (controle, botão, link, rótulo) é o nome acessível, não o
// valor do campo: `<button id="token-…">Abrir</button>` continua entregando o rótulo, como as revisões
// anteriores fixaram em teste. O identificador de credencial nesses elementos não torna o conteúdo
// segredo.
const LABEL_BEARING_ELEMENTS = new Set(['a', 'area', 'button', 'input', 'label', 'legend', 'option',
  'select', 'summary', 'textarea']);
// Atributos que CARREGAM VALOR: o elemento está rotulado como credencial, então eles são o valor.
const CREDENTIAL_VALUE_ATTRIBUTES = new Set(['title', 'alt', 'placeholder', 'aria-description',
  'aria-placeholder', 'aria-valuenow', 'aria-valuetext']);
function credentialIdentity(parsed) {
  if (LABEL_BEARING_ELEMENTS.has(parsed.name)) return false;
  for (const attribute of parsed.attributes) {
    if (attribute.name !== 'id' && attribute.name !== 'class') continue;
    const value = String(attribute.value ?? '');
    if (attribute.name === 'class') {
      if (value.split(/\s+/u).some(token => token.length > 0 && isPairedCredentialIdentity(token))) return true;
      continue;
    }
    if (isPairedCredentialIdentity(value)) return true;
  }
  return false;
}

function safeIdRefs(value) {
  const tokens = String(value ?? '').trim().split(/\s+/u).filter(Boolean);
  return tokens.length > 0 && tokens.every(token => /^[a-z_][a-z0-9_.:-]*$/iu.test(token) && !isSensitiveKeyName(token))
    ? tokens.join(' ')
    : null;
}

function sanitizeTag(parsed, { contentEditableRoot = false, stripAttributes = false, credentialIdentityValue = false } = {}) {
  if (parsed.closing) return `</${parsed.name}>`;
  const values = Object.fromEntries(parsed.attributes.map(attribute => [attribute.name, attribute.value ?? '']));
  const contenteditable = String(values.contenteditable ?? '').trim().toLowerCase();
  const editable = ['input', 'select', 'textarea'].includes(parsed.name) || (
    Object.hasOwn(values, 'contenteditable') && !['false', 'inherit'].includes(contenteditable)
  );
  const output = [];
  for (const attribute of parsed.attributes) {
    const { name } = attribute;
    if (stripAttributes) continue;
    if (contentEditableRoot && !['contenteditable', 'role', 'tabindex', 'aria-labelledby', 'aria-describedby'].includes(name)) continue;
    if (/^on/iu.test(name) || name === 'srcdoc' || name === 'style') continue;
    if (name === 'xlink:href' || name === 'ping' || name === 'srcset') continue;
    // O nome do atributo é `data-<palavra>`: a família da língua continua sendo evidência
    // (`data-chaveiro`, `data-pintura` — Minor M-2 da revisão da 1.1.40), e a forma de credencial
    // (`data-senhaassinatura`) continua caindo.
    if (PRIVATE_ATTRIBUTE.test(withCamelMarks(name)) && !isLanguageWordStrictForm(name)) continue;
    if (credentialIdentityValue && CREDENTIAL_VALUE_ATTRIBUTES.has(name)) continue;
    if ((parsed.name === 'object' && name === 'data') || (parsed.name === 'embed' && name === 'src')) continue;
    if (parsed.name === 'meta' && String(values['http-equiv']).toLowerCase() === 'refresh' && name === 'content') continue;
    // O NOME do atributo é a chave da atribuição (`senhavelha="…"`); o vocabulário fechado continua
    // valendo para os atributos que o produto preserva de propósito (`id`, `name`, `autocomplete`).
    if (isSensitiveKeyName(name) && !['id', 'name', 'autocomplete'].includes(name)) continue;
    if (editable && ['value', 'aria-valuenow', 'aria-valuetext'].includes(name)) continue;
    if (name === 'value' && (parsed.name === 'option' || isSensitiveKeyName(`${values.id || ''} ${values.name || ''} ${values.autocomplete || ''}`))) continue;
    if (parsed.name === 'option' && (name === 'selected' || name === 'aria-selected')) continue;
    let value = attribute.value;
    if (value !== null && (name === 'type' || name === 'autocomplete')) value = value.toLowerCase();
    if (contentEditableRoot && name === 'contenteditable') {
      const normalized = String(value ?? '').trim().toLowerCase();
      if (!['', 'true', 'plaintext-only'].includes(normalized)) continue;
      value = normalized;
    }
    if (contentEditableRoot && name === 'role') {
      const normalized = String(value ?? '').trim().toLowerCase();
      if (!/^[a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)*$/u.test(normalized) || isSensitiveKey(normalized)) continue;
      value = normalized;
    }
    if (contentEditableRoot && name === 'tabindex') {
      const normalized = String(value ?? '').trim();
      if (!/^-?\d+$/u.test(normalized)) continue;
      value = String(Number(normalized));
    }
    if (contentEditableRoot && (name === 'aria-labelledby' || name === 'aria-describedby')) {
      value = safeIdRefs(value);
      if (value === null) continue;
    }
    if (URL_ATTRIBUTES.has(name)) {
      value = sanitizeUrl(value);
      if (value === null) continue;
    }
    if (value !== null && !['type', 'autocomplete'].includes(name) && isSensitiveValue(value) &&
      !(LABEL_ATTRIBUTES.has(name) && SENSITIVE_LABEL_ONLY.test(withCamelMarks(value.trim())))) continue;
    // O valor do atributo também passa pelo tarjador: a regra acima só descarta o atributo quando ele
    // MENCIONA uma palavra sensível, e um valor como `Bearer …` ou `senha: …` sem a palavra no nome
    // não era tarjado nem descartado.
    if (value !== null) value = redactSensitiveText(value);
    output.push(value === null ? name : `${name}="${escapeAttribute(value)}"`);
  }
  return `<${parsed.name}${output.length ? ` ${output.join(' ')}` : ''}${parsed.selfClosing ? ' /' : ''}>`;
}

function escapeHtmlText(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/**
 * Sanitizes untrusted HTML into readable source for a later text-encoding boundary.
 * The result must never be inserted as markup; report renderers must HTML-escape it.
 */
export function sanitizeHtmlSnippetSource(html, { privateTextDescendant = false } = {}) {
  if (typeof html !== 'string') return '';
  let output = '';
  let position = 0;
  const privateStructure = [];
  let pendingPrivateRoot = privateTextDescendant === true;
  const privateOnly = pendingPrivateRoot;
  // Rótulo e valor podem estar em nós diferentes: quando um fragmento de texto termina no rótulo com o
  // separador, o que vier depois é o valor — o próximo fragmento é tarjado e o próximo elemento vira
  // raiz privada, com os atributos removidos e o texto descartado, reaproveitando o maquinário que já
  // existia para campo editável. Sem isto, `<p>senha: <code>X</code></p>` e `<th>chave:</th><td>X</td>`
  // entregavam a credencial inteira (Critical medido na revisão da 1.1.27).
  // MARCAÇÃO POR CONTEÚDO, NÃO POR ESTRUTURA. Três revisões seguidas mediram a mesma classe vazando
  // por caminhos diferentes (comentário, elemento vazio, elemento vazio com atributos, entidade
  // aninhada, rótulo em outro nó), e a causa comum era a decisão depender da ESTRUTURA: a espera era
  // consumida por um comentário, por um `<img>` ou por um `<span></span>`, e o valor seguinte ficava
  // livre. Aqui a decisão é monotônica e vem do CONTEÚDO: assim que o texto acumulado (com entidades e
  // escapes decodificados) mostra um sinal de credencial — rótulo com separador, ou rótulo com cauda
  // com cara de valor —, tudo o que vier depois no trecho perde o texto e os atributos, sem nunca
  // destarjar. Prosa legítima (`cartão de crédito`, `chave do problema`, `Senha da conta`) não acende o
  // sinal, e é isso que impede o remédio de virar o novo defeito.
  let tainted = false;
  // Elementos com IDENTIFICADOR de credencial (`id="senhaassinatura"`, `class="chavepix"`): o conteúdo
  // deles é candidato a VALOR, e a forma do fragmento decide — valor de campo (`borboleta`) sai tarjado,
  // prosa da página (`Sessão das 19h no cinema do bairro.`) fica. Foi a precisão que a revisão da 1.1.42
  // mediu (p04): o par largo sozinho apagava o texto de 98 palavras do dicionário usadas como id.
  const credentialContext = [];
  let textStream = '';
  // O acumulado SEM espaço entre fragmentos: `<b>sen</b>ha: X` é o rótulo partido por marcação, e o
  // acumulado com espaço (`sen ha: X`) não o enxerga — Important da revisão da 1.1.34. O acumulado com
  // espaço continua sendo o principal (é ele que lê `senha` + `valor` em nós diferentes).
  let compactStream = '';
  const decodeEntities = decodeForMatching;
  const emitText = fragment => {
    if (privateStructure.length || pendingPrivateRoot) return;
    if (fragment.trim().length === 0) {
      output += fragment;
      return;
    }
    const decoded = decodeEntities(fragment);
    if (credentialContext.length > 0 && looksLikeFieldValue(decoded)) {
      output += '[redacted]';
      return;
    }
    textStream = `${textStream} ${decoded}`;
    compactStream = `${compactStream}${decoded}`;
    if (!tainted && (hasCredentialValueSignal(textStream) || hasCredentialValueSignal(compactStream))) tainted = true;
    if (tainted) {
      // O fragmento que trouxe o sinal preserva o rótulo e tarja o valor; quando o sinal veio de antes,
      // o fragmento inteiro É o valor. A tarja parte do texto DECODIFICADO: o rótulo pode estar
      // escondido em entidade (`sen&#104;a`) ou em escape (`sen\u0068a`), e tarjar a forma crua não
      // encontraria nada. O trecho entregue passa a mostrar a forma normalizada, que é o que a página
      // significa.
      if (hasCredentialValueSignal(decoded)) {
        const sanitized = sanitizeText(decoded);
        // O valor pode continuar depois de uma quebra de linha DENTRO do fragmento (`token: A\nB`): o
        // tarjador para na quebra, então o resto depois do marcador também cai.
        const marker = sanitized.lastIndexOf('[redacted]');
        const remainder = marker < 0 ? '' : sanitized.slice(marker + '[redacted]'.length);
        output += marker >= 0 && /\S/u.test(remainder) ? `${sanitized.slice(0, marker)}[redacted]` : sanitized;
      } else {
        output += '[redacted]';
      }
      return;
    }
    // A regra de cauda vale também quando o sinal não acendeu: um fragmento com rótulo e valor sem
    // separador (`<b>senha</b> …` no mesmo nó) é tarjado sem precisar contaminar o resto do trecho.
    output += sanitizeText(fragment);
  };
  while (position < html.length) {
    const opening = html.indexOf('<', position);
    if (opening < 0) {
      emitText(html.slice(position));
      break;
    }
    emitText(html.slice(position, opening));
    if (html.startsWith('<!--', opening)) {
      const end = html.indexOf('-->', opening + 4);
      position = end < 0 ? html.length : end + 3;
      continue;
    }
    const token = scanTag(html, opening);
    if (!token) {
      if (!privateStructure.length && !pendingPrivateRoot) output += '&lt;';
      position = opening + 1;
      continue;
    }
    const parsed = parseTag(token.text);
    if (!parsed) {
      if (!privateStructure.length && !pendingPrivateRoot) output += '&lt;';
      position = opening + 1;
      continue;
    }
    if (EXECUTABLE.has(parsed.name)) {
      if (!parsed.closing && !parsed.selfClosing) {
        const lower = html.toLowerCase();
        const closeStart = lower.indexOf(`</${parsed.name}`, token.end);
        if (closeStart >= 0) {
          const closeToken = scanTag(html, closeStart);
          position = closeToken?.end ?? html.length;
          continue;
        }
      }
      position = token.end;
      continue;
    }
    if (parsed.closing && credentialContext.length > 0 && credentialContext.at(-1) === parsed.name) {
      credentialContext.pop();
    }
    if (privateStructure.length) {
      if (parsed.closing) {
        if (privateStructure.at(-1) === parsed.name) {
          privateStructure.pop();
          if (!privateStructure.length) {
            output += sanitizeTag(parsed);
            if (privateOnly) break;
          }
        }
      } else if (!parsed.selfClosing && !VOID_ELEMENTS.has(parsed.name)) {
        privateStructure.push(parsed.name);
      }
      position = token.end;
      continue;
    }
    if (pendingPrivateRoot && parsed.closing) {
      position = token.end;
      continue;
    }
    // Depois do sinal, nenhum elemento entrega atributo: eles são candidatos a carregar o valor, e
    // quem decide é o conteúdo, não a forma do elemento.
    // Identificador de credencial no próprio elemento: ele vira raiz privada (atributos fora, conteúdo
    // descartado) e o trecho fica contaminado a partir dali — a MESMA decisão monotônica do sinal de
    // conteúdo, alimentada pelo identificador em vez do texto.
    const credentialIdentityValue = !parsed.closing && credentialIdentity(parsed);
    const forcedPrivateRoot = pendingPrivateRoot;
    output += sanitizeTag(parsed, {
      contentEditableRoot: contentEditableTag(parsed),
      stripAttributes: forcedPrivateRoot || tainted,
      credentialIdentityValue,
    });
    if (forcedPrivateRoot) pendingPrivateRoot = false;
    if (!parsed.closing && !parsed.selfClosing && !VOID_ELEMENTS.has(parsed.name)) {
      const values = Object.fromEntries(parsed.attributes.map(attribute => [attribute.name, attribute.value ?? '']));
      const contenteditable = String(values.contenteditable ?? '').trim().toLowerCase();
      if (credentialIdentityValue) credentialContext.push(parsed.name);
      if (parsed.name === 'textarea' || (
        Object.hasOwn(values, 'contenteditable') && !['false', 'inherit'].includes(contenteditable)
      ) || forcedPrivateRoot) privateStructure.push(parsed.name);
    }
    if (forcedPrivateRoot && (parsed.selfClosing || VOID_ELEMENTS.has(parsed.name))) break;
    position = token.end;
  }
  return output.replace(/\s+/gu, ' ').trim();
}

/** Sanitizes and HTML-encodes untrusted source for inert direct display. */
export function sanitizeHtmlSnippet(html) {
  return escapeHtmlText(sanitizeHtmlSnippetSource(html));
}
