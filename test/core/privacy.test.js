import test from 'node:test';
import assert from 'node:assert/strict';

import { redactCredentialLabelTail, redactNormalizedNode, redactSensitiveText, sanitizeEvidenceUrl, sanitizeJsonData, sanitizeWarning, sanitizeWarnings } from '../../src/core/privacy.js';

const FALLBACK_WARNING = {
  code: 'PROBE_FAILED',
  message: 'Uma medição dinâmica não pôde ser concluída.',
};
const UNAVAILABLE_WARNINGS = [{
  code: 'WARNINGS_UNAVAILABLE',
  message: 'Os avisos de coleta não puderam ser normalizados com segurança.',
}];

test('legacy resource URL sanitization remains total for relative, data and blob resources', () => {
  assert.equal(sanitizeEvidenceUrl('../imagem.png', 'https://example.test/app/'), 'https://example.test/imagem.png');
  assert.equal(sanitizeEvidenceUrl('data:image/png;base64,PRIVATE'), 'data:[redacted]');
  assert.equal(sanitizeEvidenceUrl('blob:https://example.test/PRIVATE'), 'blob:[redacted]');
  assert.equal(sanitizeEvidenceUrl('about:blank'), '');
  assert.equal(sanitizeEvidenceUrl({ private: true }), '');
});

test('sanitizes warning leaves through own data descriptors without invoking accessors', () => {
  for (const field of ['code', 'frameId', 'message']) {
    const marker = `PRIVATE_WARNING_${field.toUpperCase()}_MESSAGE`;
    let getterReads = 0;
    const warning = { code: 'TIMEOUT', frameId: 'main', message: 'ignored' };
    Object.defineProperty(warning, field, {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error(marker);
      },
    });

    let sanitized;
    assert.doesNotThrow(() => { sanitized = sanitizeWarning(warning); }, field);
    assert.equal(getterReads, 0, field);
    assert.deepEqual(sanitized, FALLBACK_WARNING, field);
    assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(marker), field);
  }
});

test('rejects inherited, revoked, trapped, partial and ambiguous warning records', () => {
  const inherited = Object.create({ code: 'TIMEOUT', frameId: 'main' });
  const revoked = Proxy.revocable({ code: 'TIMEOUT', frameId: 'main' }, {});
  revoked.revoke();
  const marker = 'PRIVATE_WARNING_TRAP_MESSAGE';
  const trapped = new Proxy({ code: 'TIMEOUT' }, {
    getOwnPropertyDescriptor() { throw new Error(marker); },
  });

  for (const warning of [
    inherited,
    revoked.proxy,
    trapped,
    {},
    { frameId: 'main' },
    { code: 'TIMEOUT', unexpected: 'ambiguous' },
  ]) {
    let sanitized;
    assert.doesNotThrow(() => { sanitized = sanitizeWarning(warning); });
    assert.deepEqual(sanitized, FALLBACK_WARNING);
    assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(marker));
  }
});

test('contains hostile warning leaves when sanitizing a collection', () => {
  const marker = 'PRIVATE_WARNING_COLLECTION_MESSAGE';
  let getterReads = 0;
  const warning = {};
  Object.defineProperty(warning, 'code', {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error(marker);
    },
  });
  const revoked = Proxy.revocable({ code: 'TIMEOUT' }, {});
  revoked.revoke();

  const sanitized = sanitizeWarnings([warning, revoked.proxy]);

  assert.equal(getterReads, 0);
  assert.deepEqual(sanitized, UNAVAILABLE_WARNINGS);
  assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(marker));
});

test('snapshots warning collections by own index descriptors without reading hostile slots', () => {
  const marker = 'PRIVATE_WARNING_SLOT_MESSAGE';
  let getterReads = 0;
  const warnings = new Array(1);
  Object.defineProperty(warnings, '0', {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error(marker);
    },
  });

  let sanitized;
  assert.doesNotThrow(() => { sanitized = sanitizeWarnings(warnings); });
  assert.equal(getterReads, 0);
  assert.deepEqual(sanitized, UNAVAILABLE_WARNINGS);
  assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(marker));
});

test('contains revoked, sparse, oversized and ambiguous warning collections as one fixed limitation', () => {
  const revoked = Proxy.revocable([{ code: 'TIMEOUT' }], {});
  revoked.revoke();
  const marker = 'PRIVATE_AMBIGUOUS_WARNING_MESSAGE';
  const sparse = new Array(1);
  const oversized = new Array(1_025).fill({ code: 'TIMEOUT' });
  const ambiguous = [{ code: 'TIMEOUT' }, { code: 'ABORTED', unexpected: marker }];

  for (const warnings of [revoked.proxy, sparse, oversized, ambiguous]) {
    let sanitized;
    assert.doesNotThrow(() => { sanitized = sanitizeWarnings(warnings); });
    assert.deepEqual(sanitized, UNAVAILABLE_WARNINGS);
    assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(marker));
  }
});

test('preserves supported warning codes and bounded frame identifiers', () => {
  assert.deepEqual(sanitizeWarning({ code: ' timeout ', frameId: 'main' }), {
    code: 'TIMEOUT',
    message: 'Uma medição excedeu o tempo limite.',
    frameId: 'main',
  });
  assert.deepEqual(sanitizeWarning({ code: 'ABORTED', frameId: 7 }), {
    code: 'ABORTED',
    message: 'A medição foi cancelada.',
    frameId: 7,
  });
});

test('bounds warning leaf strings and never coerces hostile values', () => {
  const marker = 'PRIVATE_WARNING_COERCION_MESSAGE';
  let coercions = 0;
  const hostileValue = {
    [Symbol.toPrimitive]() {
      coercions += 1;
      throw new Error(marker);
    },
  };

  for (const warning of [
    { code: hostileValue },
    { code: 'x'.repeat(129) },
    { code: 'TIMEOUT', message: 'x'.repeat(1_025) },
    { code: 'TIMEOUT', frameId: hostileValue },
  ]) {
    const sanitized = sanitizeWarning(warning);
    assert.deepEqual(sanitized, FALLBACK_WARNING);
    assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(marker));
  }
  assert.equal(coercions, 0);
});

// A custom editable widget keeps the identity its author declared and loses what the user
// typed. Before this, the field arrived with no id, no label and no reference, so no rule
// could judge it: an anonymous field is a false negative, not privacy. The declarations that
// survive are exactly the author's, and a credential-shaped one still does not.
function editableField(attributes) {
  return {
    tagName: 'div', nodeId: 'n1', attributes: { ...attributes, contenteditable: 'true', role: 'textbox' },
    text: 'texto que o usuário digitou', visibleText: 'texto que o usuário digitou',
    accessibleName: 'texto que o usuário digitou', axValue: 'texto que o usuário digitou',
  };
}

test('a custom editable field keeps its author-declared identity and never the typed content', () => {
  const redacted = redactNormalizedNode(editableField({
    id: 'campo-a', 'aria-labelledby': 'rotulo-a', 'aria-label': 'Rótulo direto do campo A',
  }), { privateText: true, privateTextRoot: true });
  assert.equal(redacted.attributes.id, 'campo-a');
  assert.equal(redacted.attributes['aria-labelledby'], 'rotulo-a');
  assert.equal(redacted.attributes['aria-label'], 'Rótulo direto do campo A');
  assert.equal(redacted.attributes.role, 'textbox');
  assert.equal(redacted.text, '');
  assert.equal(redacted.visibleText, '');
  assert.equal(redacted.valueStatus, 'omitted-privacy');
  assert.equal(Object.hasOwn(redacted, 'accessibleName'), false,
    'the accessibility-tree name may derive from contents, so it must stay redacted');
  assert.doesNotMatch(JSON.stringify(redacted), /texto que o usuário digitou/u);
});

test('a credential-shaped author declaration is dropped instead of preserved', () => {
  const redacted = redactNormalizedNode(editableField({
    id: 'campo-token', 'aria-label': 'token de acesso do usuário',
  }), { privateText: true, privateTextRoot: true });
  assert.equal(Object.hasOwn(redacted.attributes, 'id'), false);
  assert.equal(Object.hasOwn(redacted.attributes, 'aria-label'), false);
  assert.doesNotMatch(JSON.stringify(redacted), /token de acesso/u);
});

test('an author-declared id is dropped when it cannot be an identifier or looks sensitive', () => {
  // The gate is the identifier rule plus the sensitive-word rejection, not a semantic parser:
  // a value that is not shaped like an identifier, or that names a credential, does not survive.
  // The sensitive-word list is English-centric, so 'sessao-do-usuario' survives: the identifier
  // shape gate accepts it and no sensitive word matches. That gap is real and is recorded in the
  // QA log rather than hidden here, because widening the list changes redaction for every field.
  for (const id of ['1campo', 'campo;senha', 'api_key_do_servico', 'token-do-campo']) {
    const redacted = redactNormalizedNode(editableField({ id }), { privateText: true, privateTextRoot: true });
    assert.equal(Object.hasOwn(redacted.attributes, 'id'), false, `id ${id} should be dropped`);
    assert.doesNotMatch(JSON.stringify(redacted), new RegExp(id, 'u'));
  }
  // A whitespace-separated value is accepted as an id because the identifier gate normalizes
  // the spacing; recording it makes the actual behaviour explicit rather than assumed.
  const spaced = redactNormalizedNode(editableField({ id: 'campo a' }), { privateText: true, privateTextRoot: true });
  assert.equal(spaced.attributes.id, 'campo a');
});

test('credenciais e identificadores em português também são removidos da URL e tarjados no JSON', () => {
  const url = sanitizeEvidenceUrl('https://exemplo.test/p?senha=s3gredo&cpf=12345678900&chaveAcesso=k&id=7&contato=ok');
  for (const vazamento of ['s3gredo', '12345678900', 'chaveAcesso']) {
    assert.ok(!url.includes(vazamento), `a URL sanitizada não pode carregar ${vazamento}`);
  }
  assert.ok(url.includes('id=7') && url.includes('contato=ok'), 'parâmetros legítimos permanecem na URL');
  const json = sanitizeJsonData({
    senha: 's3gredo', cpf: '12345678900', chaveAcesso: 'k', cnpj: 'x', sessao: 'y',
    autenticacao: 'z', autorizacao: 'w', cartao: 'c', token: 't',
    id: 1, contato: 'ok', pixelRatio: 2, cargo: 'ok',
  });
  for (const sensivel of ['senha', 'cpf', 'chaveAcesso', 'cnpj', 'sessao', 'autenticacao', 'autorizacao', 'cartao', 'token']) {
    assert.equal(json[sensivel], '[redacted]', `${sensivel} precisa ser tarjado`);
  }
  // Fronteira deliberada: nada de radicais curtos que pegam palavra legítima ("conta" pegaria
  // "contato", "pix" pegaria "pixelRatio", "rg" pegaria "cargo").
  for (const legitimo of ['id', 'contato', 'pixelRatio', 'cargo']) {
    assert.notEqual(json[legitimo], '[redacted]', `${legitimo} não é sensível e não pode ser perdido`);
  }
});

test('o radical de senha não engole palavras legítimas do próprio produto', () => {
  // Medido antes da correção: `pass(?:word|wd)?` casava "passed", "passes", "bypass" e "passive" —
  // vocabulário do próprio produto (resultado `passed`, contagem `passes` em technicalSummary,
  // 2.4.1 Bypass Blocks, observação passiva). Um dado cru com essas chaves era tarjado e sumia.
  const json = sanitizeJsonData({
    passed: 3, passes: { groups: 16 }, bypass: true, passive: 'observação',
    password: 'x', passwd: 'x', pass: 'x', userPassword: 'x', passcode: 'x',
  });
  for (const legitimo of ['passed', 'passes', 'bypass', 'passive']) {
    assert.notEqual(json[legitimo], '[redacted]', `${legitimo} não é credencial e não pode ser perdido`);
  }
  for (const credencial of ['password', 'passwd', 'pass', 'userPassword', 'passcode']) {
    assert.equal(json[credencial], '[redacted]', `${credencial} continua sendo tarjado`);
  }
});

test('a fronteira de senha não pode deixar credencial escapar (achado A2 da revisão da 1.1.24)', () => {
  // A revisão mediu que o lookbehind `(?<!by)` da 1.1.23 deixou passar bypasscode, bypass_code,
  // bypasswd, bypass_key e bypassword — e `bypasscode` ERA tarjado antes daquela mudança. O radical
  // agora exige cauda de credencial (word/wd/code/phrase/key, com separador opcional) ou a palavra
  // inteira `pass`, e só a palavra inteira `pass` é que não pode vir precedida de "by".
  const json = sanitizeJsonData({
    password: 'x', passwd: 'x', pass: 'x', userPassword: 'x', passcode: 'x', passphrase: 'x',
    bypasscode: 'x', bypass_code: 'x', bypasswd: 'x', bypass_key: 'x', bypassword: 'x',
    'pass-word': 'x', 'pass word': 'x', pwdField: 'x',
    passed: 3, passes: 1, bypass: true, passive: 'p', passing: 'ok', passo: 'ok',
    contato: 'ok', pixelRatio: 2, cargo: 'ok',
  });
  for (const credencial of ['password', 'passwd', 'pass', 'userPassword', 'passcode', 'passphrase',
    'bypasscode', 'bypass_code', 'bypasswd', 'bypass_key', 'bypassword', 'pass-word', 'pass word', 'pwdField']) {
    assert.equal(json[credencial], '[redacted]', `${credencial} precisa ser tarjado`);
  }
  for (const legitimo of ['passed', 'passes', 'bypass', 'passive', 'passing', 'passo', 'contato', 'pixelRatio', 'cargo']) {
    assert.notEqual(json[legitimo], '[redacted]', `${legitimo} não é credencial e não pode ser perdido`);
  }
});

test('valores com rótulo em português também são tarjados no texto (achado A1 da revisão da 1.1.24)', () => {
  // A revisão mediu que o tarjador de VALORES continuava só em inglês: `senha: S3GR3D0` passava
  // intacto enquanto `password: S3GR3D0` era tarjado. O rigor de privacidade não pode depender do
  // idioma do rótulo.
  const casos = [
    ['senha: S3GR3D0', 'S3GR3D0'], ['Senha = S3GR3D0', 'S3GR3D0'],
    ['segredo: ABC-123', 'ABC-123'], ['credencial: XYZ', 'XYZ'],
    ['sessão: 9f3a', '9f3a'], ['autenticação: token-vivo', 'token-vivo'],
    ['autorização: permitido-9', 'permitido-9'], ['chave: CHAVE-SECRETA', 'CHAVE-SECRETA'],
    ['cpf: 123.456.789-00', '123.456.789-00'], ['cartão: 4111 1111 1111 1111', '4111 1111 1111 1111'],
  ];
  for (const [texto, vazamento] of casos) {
    const saida = sanitizeJsonData({ texto });
    assert.ok(!saida.texto.includes(vazamento), `"${texto}" não pode sair com ${vazamento}`);
    assert.match(saida.texto, /\[redacted\]/u, `"${texto}" precisa registrar o tarjamento`);
  }
  // Controle negativo: prosa sem rótulo de credencial continua intacta.
  const prosa = 'A sessão de perguntas discutiu o cartão de crédito como tema e a chave do problema.';
  assert.equal(sanitizeJsonData({ texto: prosa }).texto, prosa);
});

test('o radical de senha não pode PERDER grafias que a versão anterior tarjava (achados N1 da 1.1.25 e A4 da 1.1.26)', () => {
  // A revisão da 1.1.25 mediu que a minha troca de radical (A2) ganhou 13 formas e perdeu 8 que a
  // 1.1.24 tarjava. A lição é de método: cada troca de vocabulário tem de ser medida contra o
  // vocabulário ANTERIOR, não só contra o alvo novo. Estas oito são as perdidas. A revisão da 1.1.26
  // mediu a mesma classe de novo: o radical da 1.1.26 ainda perdia, contra a 1.1.24, caudas de
  // credencial reais — `passkod`/`passkode`, `passfrase`, `passsatz` e `passpasse` — e o `compass`
  // tarjado "de propósito" não era trade-off forçado, porque `(?<!com)pass` o preserva sem devolver
  // `myPass`/`userPass`. As listas abaixo fixam os quatro grupos.
  const perdidasNa125 = ['motdepasse', 'passwrd', 'passw0rd', 'palavra-passe', 'palavrapasse',
    'frase-passe', 'frasepasse', 'passwort'];
  const recuperadasNa127 = ['passkod', 'passkode', 'pass-kode', 'pass_kode', 'passfrase', 'pass-frase',
    'pass_satz', 'passsatz', 'passpasse', 'pass-passe', 'passwörter', 'passworter'];
  const ganhasNoA2 = ['bypasscode', 'bypass_code', 'bypasswd', 'bypass_key', 'bypassword'];
  const plurais = ['passwords', 'passwds', 'passcodes', 'passphrases', 'passkeys'];
  const originais = ['password', 'passwd', 'pass', 'userPassword', 'passcode', 'passphrase',
    'pass-word', 'pass word', 'pwdField', 'senha', 'cpf', 'chaveAcesso'];
  for (const chave of [...perdidasNa125, ...recuperadasNa127, ...ganhasNoA2, ...plurais, ...originais]) {
    assert.equal(sanitizeJsonData({ [chave]: 'x' })[chave], '[redacted]', `${chave} precisa ser tarjado`);
  }
  // E o outro lado continua preservado — inclusive palavras que contêm "pass" sem serem credencial, e
  // agora também `compass`, que era o falso positivo declarado como inevitável.
  const inocentes = ['passed', 'passes', 'bypass', 'passive', 'passing', 'passo', 'passage',
    'passport', 'bypasses', 'passer', 'passable', 'passepartout', 'passim', 'contato', 'pixelRatio', 'cargo',
    'compass', 'compassed', 'compassion', 'encompass'];
  for (const chave of inocentes) {
    assert.notEqual(sanitizeJsonData({ [chave]: 'x' })[chave], '[redacted]', `${chave} não pode ser perdido`);
  }
});

test('o valor tarjado é consumido por inteiro, não só o primeiro token (achados N2 e O2 da 1.1.25)', () => {
  // A revisão mediu que o meu teste do A1 passava TRIVIALMENTE: em `cartão: 4111 1111 1111 1111` só o
  // primeiro token era substituído e 12 dos 16 dígitos sobreviviam. A asserção agora é sobre
  // QUALQUER dígito remanescente, não sobre o primeiro token.
  const casos = [
    'cartão: 4111 1111 1111 1111',
    'CPF: 123.456.789-00',
    'senha: S3G R3D0',
    'senha: "S3G R3D0"',
    'chave: ABC 123 DEF 456',
    'pwd: 99887766',
    'passcode: 4455 6677',
    'passphrase: uma frase secreta longa',
    'pass: 1234',
    'auth: token-abc-123',
  ];
  for (const texto of casos) {
    const saida = sanitizeJsonData({ texto }).texto;
    assert.match(saida, /\[redacted\]/u, `"${texto}" precisa registrar o tarjamento`);
    const rotulo = texto.slice(0, texto.indexOf(":"));
    const depois = saida.slice(saida.indexOf(':') + 1);
    assert.ok(!/[0-9]/.test(depois), `"${texto}" não pode deixar dígito depois do rótulo (sobrou ${JSON.stringify(depois)})`);
    assert.ok(!depois.includes(rotulo), `"${texto}" não pode reexpor o rótulo`);
  }
  // Controle negativo: prosa sem rótulo sensível continua intacta.
  const prosa = 'A sessão de perguntas discutiu o cartão de crédito como tema e a chave do problema.';
  assert.equal(sanitizeJsonData({ texto: prosa }).texto, prosa);
});

test('credencial em parâmetro, fragmento ou rota de URL é tarjada no texto (Important da revisão da 1.1.28)', () => {
  // A revisão mediu `?code=`, `#code=`, `#assertion=` e a rota `#/authorize/code/X` chegando a cinco
  // superfícies entregues. `code` e `assertion` não são palavras do vocabulário de chave (tarjariam
  // qualquer campo de código), então a regra é de URL: chave de credencial em parâmetro, fragmento ou
  // segmento de rota.
  const segredo = 'S3GR3D0XYZQ';
  const casos = [
    `https://exemplo.test/p?code=${segredo}`, `https://exemplo.test/p?assertion=${segredo}`,
    `https://exemplo.test/p#code=${segredo}`, `https://exemplo.test/p#assertion=${segredo}`,
    `https://exemplo.test/p#/authorize?code=${segredo}`,
    `https://exemplo.test/p#/authorize/code/${segredo}`,
    `https://exemplo.test/p#access_token=${segredo}`,
  ];
  for (const url of casos) {
    assert.doesNotMatch(redactSensitiveText(url), /S3GR3D0XYZQ/u, `${url} não pode manter o valor`);
    assert.match(redactSensitiveText(url), /\[redacted\]/u, `${url} precisa registrar o tarjamento`);
  }
  // Controle negativo: consulta e fragmento sem credencial continuam sendo endereço útil.
  const inocente = 'https://exemplo.test/p?lang=pt#secao';
  assert.equal(redactSensitiveText(inocente), inocente);
});

test('rótulo com sufixo curto é a mesma credencial (Minor M1 da revisão da 1.1.28)', () => {
  // `tokens:`, `secrets:`, `sessions:`, `cookies:`, `apiKeys:`, `senhaAtual:`, `credenciaisDeAcesso:`,
  // `chaveDeApi:`, `bearer:` e `authentication:` são a mesma credencial que a forma simples, e passavam
  // porque o separador tinha de vir colado na palavra.
  const segredo = 'S3GR3D0XYZQ';
  const rotulos = ['tokens:', 'secrets:', 'sessions:', 'cookies:', 'senhaAtual:', 'credenciaisDeAcesso:',
    'chaveDeApi:', 'bearer:', 'authentication:', 'apiKeys:', 'autenticacaoDoUsuario:'];
  for (const rotulo of rotulos) {
    const texto = `${rotulo} ${segredo}`;
    assert.doesNotMatch(redactSensitiveText(texto), /S3GR3D0XYZQ/u, `${rotulo} precisa tarjar o valor`);
    assert.doesNotMatch(sanitizeJsonData({ texto }).texto, /S3GR3D0XYZQ/u, `${rotulo} precisa tarjar no JSON`);
  }
  // O outro lado: prosa e rótulos legítimos continuam intactos.
  for (const prosa of ['A senha do teste é forte.', 'Senha da conta', 'Chave da API', 'O passeio de barco passou pelo cais.']) {
    assert.equal(redactSensitiveText(prosa), prosa);
  }
});

test('string que carrega marcação usa a regra estrita de cauda (Important da revisão da 1.1.28)', () => {
  // `placeholder="senha abc"` vira texto no nome acessível, e ali a regra de separador não age. Numa
  // string que CONTÉM marcação vale a regra estrita; em prosa comum, não — foi essa distinção que
  // preservou o controle negativo do A1 ("A sessão discutiu o cartão…") e os rótulos de verdade
  // ("Senha da conta"), que o normalizador fixa em teste próprio.
  const contaminado = sanitizeJsonData({ texto: '<b>senha abc123</b>' }).texto;
  assert.doesNotMatch(contaminado, /abc123/u);
  for (const prosa of ['A senha do teste é forte.', 'A sessão de perguntas discutiu o cartão de crédito como tema.']) {
    assert.equal(sanitizeJsonData({ texto: prosa }).texto, prosa);
  }
  // A cauda exige CARA DE VALOR: dígito, símbolo ou comprimento de segredo.
  for (const rotulo of ['Senha da conta', 'Chave da API', 'Digite sua senha', 'Informe a senha']) {
    assert.equal(redactCredentialLabelTail(rotulo), rotulo, `${rotulo} é rótulo, não valor`);
  }
  for (const comValor of ['senha abc123', 'chave ABC-123', 'token eyJhbGciOiJIUzI1NiJ9']) {
    assert.match(redactCredentialLabelTail(comValor), /\[redacted\]/u, `${comValor} carrega valor`);
  }
});

test('os plurais em português são a mesma credencial (Minor da revisão da 1.1.27)', () => {
  // `credenciais`, `sessões`, `cartões`, `autorizações` e `autenticações` passavam intactos enquanto o
  // singular era tarjado, em chave, em rótulo de valor e em URL — o plural não muda o que a palavra é.
  const plurais = ['credenciais', 'sessões', 'cartões', 'autorizações', 'autenticações',
    'senhas', 'chaves', 'segredos', 'sessoes', 'cartoes', 'autorizacoes', 'autenticacoes'];
  for (const chave of plurais) {
    assert.equal(sanitizeJsonData({ [chave]: 'x' })[chave], '[redacted]', `${chave} precisa ser tarjado na chave`);
    const texto = `${chave}: S3GR3D0`;
    assert.doesNotMatch(sanitizeJsonData({ texto }).texto, /S3GR3D0/u, `${chave} precisa tarjar o valor`);
  }
});

test('a família `auth` tarja a credencial e preserva `author*` (achado A7 da revisão da 1.1.26)', () => {
  // O `auth` nu do vocabulário casava `author`, `authority` e `authorized*`: 314 tokens do próprio
  // produto, entre eles `authorityExpiresAt` e `firstAuthorization`. Toda expansão de vocabulário tem
  // de ser medida nas DUAS direções — nenhuma forma de credencial pode sair e as inocentes entram.
  const credenciais = ['auth', 'authorization', 'authorizations', 'authorisation', 'authentication',
    'authToken', 'authKey', 'authHeader', 'authCode', 'authSecret', 'oauth', 'authorizationHeader'];
  for (const chave of credenciais) {
    assert.equal(sanitizeJsonData({ [chave]: 'x' })[chave], '[redacted]', `${chave} precisa ser tarjado`);
  }
  const inocentes = ['author', 'authors', 'authority', 'authorities', 'authorized', 'authorizedAt',
    'authorizedDecision', 'authorityExpiresAt', 'authorize', 'authoring', 'authored', 'authorship',
    'authoritative', 'coauthor', 'authoredBy'];
  for (const chave of inocentes) {
    assert.notEqual(sanitizeJsonData({ [chave]: 'x' })[chave], '[redacted]', `${chave} não pode ser perdido`);
  }
  // No texto, o rótulo inocente também não consome o valor.
  const prosa = 'author: Maria Silva';
  assert.equal(sanitizeJsonData({ texto: prosa }).texto, prosa);
  assert.match(sanitizeJsonData({ texto: 'authorization: Bearer abc' }).texto, /\[redacted\]/u);
});

test('o valor tarjado é consumido até o fim, sem teto nem terminador que devolvam a cauda (Important da revisão da 1.1.26)', () => {
  // O conserto do N2 trocou "primeiro token" por `[^\n<;]{1,120}`. Isso fechou o caso do cartão com
  // espaços e ABRIU uma classe nova: o teto de 120 caracteres e o terminador `;` devolviam a CAUDA do
  // valor, então um JWT de 300 caracteres saía com 180 intactos, uma chave de 200 saía com 120, e
  // `senha: p4ss;word-secreto` saía com `;word-secreto`. A métrica tem de ser tão larga quanto a
  // classe: nenhum caractere que só exista no valor pode sobreviver, em forma alguma.
  const sentinela = /[Zq]/gu;
  const marca = valor => `Zq${valor}`;
  const formas = [
    ['token curto', `token: ${marca('abc')}`],
    ['JWT 300 caracteres', `token: ${'eyJ'.concat(marca('')).repeat(75)}`],
    ['chave de API 200 caracteres', `api_key: ${'K'.concat(marca('')).repeat(100)}`],
    ['authorization 200 caracteres', `authorization: ${marca('').repeat(100)}`],
    ['senha com ponto e vírgula', `senha: p4ss;word-${marca('abc')}`],
    ['senha com dois ponto e vírgula', `senha: abc;def;${marca('ab')}`],
    ['chave longa', `chave: ${marca('').repeat(40)}`],
    ['valor entre aspas duplas', `senha: "${marca('segredo')}"`],
    ['valor entre aspas simples', `senha: '${marca('segredo')}'`],
    ['separador =', `senha=${marca('').repeat(20)}`],
    ['sem espaço depois dos dois pontos', `senha:${marca('').repeat(20)}`],
    ['com tabulação', `senha:\t${marca('').repeat(20)}`],
    ['com barra vertical', `senha: ${marca('').repeat(10)}|${marca('').repeat(10)}`],
    ['com vírgula', `senha: ${marca('').repeat(10)},${marca('').repeat(10)}`],
    // Formas que a revisão da 1.1.27 mediu sobrevivendo: o `[^\n<]+` obrigatório não podia começar em
    // `<`, então o motor fazia backtracking do separador e escrevia `[redacted]` AO LADO do valor; a
    // alternativa entre aspas consumia só até a aspa de fechamento e devolvia a cauda; e a aspa de
    // fechamento da chave JSON ficava entre o rótulo e o separador.
    ['valor entre sinais de menor e maior', `senha: <${marca('')}>`],
    ['valor longo entre sinais de menor e maior', `token: <${'Zq'.repeat(150)}>`],
    ['chave JSON na mesma linha', `{"senha": "${marca('segredo')}"}`],
    ['aspas vazias antes do valor', `senha: ""${marca('')}`],
    ['aspas com cauda depois', `senha: "${marca('a')}" cauda-${marca('b')}`],
    ['menor-que colado ao valor', `senha: p4<${marca('')}`],
    ['seta', `senha -> ${marca('')}`],
    ['seta dupla', `senha => ${marca('')}`],
    ['seta unicode', `senha → ${marca('')}`],
    ['aspa antes dos dois pontos', `senha": ${marca('')}`],
  ];
  for (const [nome, texto] of formas) {
    const saida = sanitizeJsonData({ texto }).texto;
    assert.match(saida, /\[redacted\]/u, `"${nome}" precisa registrar o tarjamento`);
    const sobreviventes = saida.match(sentinela) ?? [];
    assert.equal(sobreviventes.length, 0,
      `"${nome}" não pode devolver a cauda do valor (sobreviveu ${JSON.stringify(saida)})`);
  }
  // Os rótulos compostos que o radical de chave já conhece também precisam tarjar o VALOR: as duas
  // listas divergiam, e um texto com `palavra-passe: …` não era tarjado por nenhuma das duas.
  for (const rotulo of ['palavra-passe', 'palavrapasse', 'frase-passe', 'mot de passe', 'motdepasse',
    'passkod', 'passkode', 'passfrase', 'passsatz', 'passpasse']) {
    const texto = `${rotulo}: ${marca('segredo')}`;
    const saida = sanitizeJsonData({ texto }).texto;
    assert.match(saida, /\[redacted\]/u, `"${rotulo}" precisa ser reconhecido como rótulo de valor`);
    assert.equal((saida.match(sentinela) ?? []).length, 0,
      `"${rotulo}" não pode devolver o valor (sobreviveu ${JSON.stringify(saida)})`);
  }
});
