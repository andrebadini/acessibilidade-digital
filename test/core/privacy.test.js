import test from 'node:test';
import assert from 'node:assert/strict';

import { redactNormalizedNode, sanitizeEvidenceUrl, sanitizeJsonData, sanitizeWarning, sanitizeWarnings } from '../../src/core/privacy.js';

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
