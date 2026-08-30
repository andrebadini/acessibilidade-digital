import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import {
  canonicalPath,
  classifySelectorToken,
  createStructuralSignatureV1,
  parseCssSelectorV1,
  roleForStructuralSignature,
  selectorMatchesOne,
  structuralSignatureMatches,
} from '../../src/background/highlight-locator.js';

class FixtureElement {
  constructor(tag, attributes = {}) {
    this.tagName = String(tag).toUpperCase();
    this.attributes = { ...attributes };
    this.parentElement = null;
    this.parentNode = null;
    this.children = [];
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      child.parentNode = this;
      this.children.push(child);
    }
    return children.at(-1);
  }

  replace(oldChild, newChild) {
    const index = this.children.indexOf(oldChild);
    if (index < 0) throw new TypeError('fixture child');
    oldChild.parentElement = null;
    oldChild.parentNode = null;
    newChild.parentElement = this;
    newChild.parentNode = this;
    this.children[index] = newChild;
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? String(this.attributes[name]) : null;
  }

  getRootNode() {
    let current = this;
    const seen = new Set();
    while (current.parentNode) {
      if (seen.has(current)) return current;
      seen.add(current);
      current = current.parentNode;
    }
    return current;
  }

  matches(segment) {
    return fixtureSegmentMatches(this, segment);
  }

  querySelectorAll(selector) {
    return fixtureQuery(this, selector);
  }
}

class FixtureDocument {
  constructor() {
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = null;
      child.parentNode = this;
      this.children.push(child);
    }
    return children.at(-1);
  }

  getRootNode() {
    return this;
  }

  querySelectorAll(selector) {
    return fixtureQuery(this, selector);
  }
}

class FixtureShadowRoot extends FixtureDocument {
  constructor(mode = 'open') {
    super();
    this.mode = mode;
    this.host = new FixtureElement('section');
  }
}

function fixtureSegmentMatches(element, source) {
  let segment = source;
  let nth = null;
  const nthMatch = segment.match(/:nth-of-type\(([1-9]\d*)\)$/u);
  if (nthMatch) {
    nth = Number(nthMatch[1]);
    segment = segment.slice(0, -nthMatch[0].length);
  }

  let attribute = null;
  const attributeMatch = segment.match(/\[(role|type)="([a-z]+)"\]$/u);
  if (attributeMatch) {
    attribute = { name: attributeMatch[1], value: attributeMatch[2] };
    segment = segment.slice(0, -attributeMatch[0].length);
  }

  const tagMatch = segment.match(/^[a-z][a-z0-9-]*/u);
  if (!tagMatch || element.tagName.toLowerCase() !== tagMatch[0]) return false;
  segment = segment.slice(tagMatch[0].length);

  const idMatch = segment.match(/^#(-?[_A-Za-z][_A-Za-z0-9-]*)/u);
  if (idMatch) {
    if (element.getAttribute('id') !== idMatch[1]) return false;
    segment = segment.slice(idMatch[0].length);
  }

  while (segment.startsWith('.')) {
    const classMatch = segment.match(/^\.(-?[_A-Za-z][_A-Za-z0-9-]*)/u);
    if (!classMatch) return false;
    const classTokens = (element.getAttribute('class') ?? '').split(/[\t\n\f\r ]+/u).filter(Boolean);
    if (!classTokens.includes(classMatch[1])) return false;
    segment = segment.slice(classMatch[0].length);
  }
  if (segment !== '') return false;
  if (attribute && element.getAttribute(attribute.name) !== attribute.value) return false;

  if (nth !== null) {
    const parent = element.parentElement ?? element.parentNode;
    const sameTag = (parent?.children ?? []).filter(child => child.tagName === element.tagName);
    if (sameTag.indexOf(element) + 1 !== nth) return false;
  }
  return true;
}

function fixtureQuery(scopeRoot, selector) {
  const segments = selector.split(' > ');
  const descendants = [];
  const visit = node => {
    for (const child of node.children ?? []) {
      descendants.push(child);
      visit(child);
    }
  };
  visit(scopeRoot);
  return descendants.filter(candidate => {
    let current = candidate;
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      if (!current || !fixtureSegmentMatches(current, segments[index])) return false;
      if (index > 0) current = current.parentElement;
    }
    return true;
  });
}

function simpleTree(buttonAttributes = {}) {
  const document = new FixtureDocument();
  const html = document.append(new FixtureElement('html'));
  const body = html.append(new FixtureElement('body'));
  const main = body.append(new FixtureElement('main'));
  const button = main.append(new FixtureElement('button', buttonAttributes));
  return { document, html, body, main, button };
}

function linearTree(length) {
  const document = new FixtureDocument();
  let current = document;
  let target = null;
  for (let index = 0; index < length; index += 1) {
    target = new FixtureElement(index === length - 1 ? 'button' : 'div');
    current.append(target);
    current = target;
  }
  return { document, target };
}

function oversizedChildrenFixture() {
  let iteratorCalls = 0;
  let queryCalls = 0;
  const target = new FixtureElement('button');
  const scopeRoot = {
    children: {
      length: 1_000_000,
      [Symbol.iterator]() {
        iteratorCalls += 1;
        throw new Error('coleção superdimensionada foi iterada');
      },
    },
    parentElement: null,
    parentNode: null,
    querySelectorAll() {
      queryCalls += 1;
      return [target];
    },
  };
  target.parentElement = null;
  target.parentNode = scopeRoot;
  return {
    target,
    scopeRoot,
    counts: () => ({ iteratorCalls, queryCalls }),
  };
}

test('rejects embedded UUID, sensitive values and opaque selector tokens', () => {
  assert.equal(classifySelectorToken('primary-navigation'), true);
  assert.equal(classifySelectorToken('-_action-2'), true);
  assert.equal(classifySelectorToken('cliente-550e8400-e29b-41d4-a716-446655440000-final'), false);
  assert.equal(classifySelectorToken('session_Az19kLm28Qr74Ty92Bx50'), false);
  assert.equal(classifySelectorToken('customer-1234'), false);
  assert.equal(classifySelectorToken('deadbeef-item'), false);
  assert.equal(classifySelectorToken('www.example'), false);
  assert.equal(classifySelectorToken('a'.repeat(24)), false);
  assert.equal(classifySelectorToken(new String('primary')), false);
  assert.throws(
    () => parseCssSelectorV1('button.cliente-550e8400-e29b-41d4-a716-446655440000-final'),
    /token sensível/iu,
  );
});

test('parses the closed grammar, freezes it deeply and recomputes deterministic cost', () => {
  const parsed = parseCssSelectorV1('main > button.primary[type="button"]:nth-of-type(2)');
  assert.equal(parsed.syntax, 'CSSSelectorV1');
  assert.equal(parsed.value, 'main > button.primary[type="button"]:nth-of-type(2)');
  assert.equal(parsed.byteLength, 51);
  assert.equal(parsed.complexity, 9);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.segments), true);
  assert.equal(Object.isFrozen(parsed.segments[1]), true);
  assert.equal(Object.isFrozen(parsed.segments[1].classes), true);
  assert.equal(Object.isFrozen(parsed.segments[1].enumAttribute), true);
  assert.deepEqual(parsed.segments[1], {
    tag: 'button',
    id: null,
    classes: ['primary'],
    enumAttribute: { name: 'type', value: 'button' },
    nthOfType: 2,
  });
});

test('enforces segment, complexity and UTF-8 budgets at their exact boundaries', () => {
  const maximal = 'button#safe.primary.secondary[type="button"]:nth-of-type(1)';
  const modest = 'button:nth-of-type(1)';
  const atCostLimit = [maximal, maximal, maximal, maximal, maximal, modest, modest, modest].join(' > ');
  const aboveCostLimit = [maximal, maximal, maximal, maximal, maximal, 'button.primary:nth-of-type(1)', modest, modest].join(' > ');
  assert.equal(parseCssSelectorV1(atCostLimit).complexity, 64);
  assert.throws(() => parseCssSelectorV1(aboveCostLimit), /complexidade/iu);

  const sixteenSegments = Array.from({ length: 16 }, () => 'main').join(' > ');
  assert.equal(parseCssSelectorV1(sixteenSegments).segments.length, 16);
  assert.throws(() => parseCssSelectorV1(`${sixteenSegments} > main`), /segmentos/iu);
  assert.throws(() => parseCssSelectorV1('a'.repeat(2_049)), /2\.048 bytes/iu);
});

test('rejects an oversized code-unit input before constructing or invoking TextEncoder', () => {
  const NativeTextEncoder = globalThis.TextEncoder;
  let constructions = 0;
  let encodes = 0;
  globalThis.TextEncoder = class SentinelTextEncoder {
    constructor() { constructions += 1; }
    encode() { encodes += 1; throw new Error('TextEncoder não deveria ser chamado'); }
  };
  try {
    assert.throws(() => parseCssSelectorV1('a'.repeat(2_049)), /2\.048 bytes/iu);
    assert.equal(constructions, 0);
    assert.equal(encodes, 0);
  } finally {
    globalThis.TextEncoder = NativeTextEncoder;
  }
});

test('still applies the exact UTF-8 byte budget after the code-unit preflight', () => {
  assert.throws(() => parseCssSelectorV1('é'.repeat(1_025)), /2\.048 bytes/iu);
  assert.throws(() => parseCssSelectorV1('é'.repeat(1_024)), /gramática fechada/iu);
});

test('rejects every selector construct outside the closed grammar', () => {
  const invalid = [
    null,
    new String('button'),
    '',
    'Button',
    'main>button',
    'main  > button',
    'main >  button',
    ' main > button',
    'main > button ',
    'main > > button',
    'button, a',
    '*',
    'button[data-id="safe"]',
    "button[type='button']",
    'button[role="combobox"]',
    'input[type="hidden"]',
    'button::before',
    'button:hover',
    'button:has(span)',
    'button:is(.primary)',
    'button:not(.disabled)',
    'main /deep/ button',
    'main >>> button',
    'button.foo\\:bar',
    'button.one.two.three',
    'button.primary#late-id',
    'button:nth-of-type(0)',
    'button:nth-of-type(-1)',
    'button:nth-of-type(01)',
    'button#customer-1234',
    'button.auth-token',
  ];
  for (const selector of invalid) {
    assert.throws(() => parseCssSelectorV1(selector), { name: 'TypeError' }, String(selector));
  }
});

test('canonicalPath reaches the declared root or rejects instead of truncating', () => {
  const { document, button } = simpleTree();
  assert.equal(canonicalPath(button, { scopeRoot: document, maxSegments: 16 }).value, 'html > body > main > button');

  const deep = linearTree(17);
  assert.throws(
    () => canonicalPath(deep.target, { scopeRoot: deep.document, maxSegments: 16 }),
    /escopo não alcançado/iu,
  );

  const detachedButton = new FixtureElement('button');
  assert.throws(
    () => canonicalPath(detachedButton, { scopeRoot: document, maxSegments: 16 }),
    /escopo não alcançado/iu,
  );
});

test('canonicalPath uses deterministic safe discriminators and nth-of-type only when needed', () => {
  const tree = simpleTree();
  const first = tree.main.append(new FixtureElement('button', { class: 'primary', type: 'button' }));
  const second = tree.main.append(new FixtureElement('button', { class: 'primary', type: 'button' }));
  assert.deepEqual(
    tree.document.querySelectorAll('html > body > main > button.primary[type="button"]:nth-of-type(2)'),
    [first],
  );
  assert.match(canonicalPath(first, { scopeRoot: tree.document, maxSegments: 16 }).value, /button\.primary\[type="button"\]:nth-of-type\(2\)$/u);
  assert.match(canonicalPath(second, { scopeRoot: tree.document, maxSegments: 16 }).value, /button\.primary\[type="button"\]:nth-of-type\(3\)$/u);

  tree.button.attributes = { id: 'unique-action', class: 'primary large ignored', role: 'button' };
  assert.equal(
    canonicalPath(tree.button, { scopeRoot: tree.document, maxSegments: 16 }).value,
    'html > body > main > button#unique-action.primary.large[role="button"]',
  );
});

test('canonicalPath fails closed for forbidden tokens, cycles, closed roots and non-unique final queries', () => {
  const sensitive = simpleTree({ id: 'password-control' });
  assert.throws(
    () => canonicalPath(sensitive.button, { scopeRoot: sensitive.document, maxSegments: 16 }),
    /token sensível/iu,
  );

  const cycle = simpleTree();
  cycle.html.parentElement = cycle.button;
  cycle.html.parentNode = cycle.button;
  assert.throws(
    () => canonicalPath(cycle.button, { scopeRoot: cycle.document, maxSegments: 16 }),
    /ciclo|escopo não alcançado/iu,
  );

  const closedRoot = {
    mode: 'closed', host: {}, children: [],
    querySelectorAll() { return []; },
  };
  const shadowButton = new FixtureElement('button');
  shadowButton.parentNode = closedRoot;
  closedRoot.children.push(shadowButton);
  assert.throws(
    () => canonicalPath(shadowButton, { scopeRoot: closedRoot, maxSegments: 16 }),
    /shadow|escopo/iu,
  );

  const ambiguous = simpleTree();
  ambiguous.document.querySelectorAll = () => [ambiguous.button, new FixtureElement('button')];
  assert.throws(
    () => canonicalPath(ambiguous.button, { scopeRoot: ambiguous.document, maxSegments: 16 }),
    /seletor único/iu,
  );
  assert.throws(
    () => canonicalPath(ambiguous.button, { scopeRoot: ambiguous.document, maxSegments: 17 }),
    /limite de segmentos/iu,
  );
});

test('rejects an oversized raw class before splitting it or querying the DOM', () => {
  const tree = simpleTree({ class: 'safe '.repeat(5_000).trim() });
  let queryCalls = 0;
  const query = tree.document.querySelectorAll.bind(tree.document);
  tree.document.querySelectorAll = selector => { queryCalls += 1; return query(selector); };
  assert.throws(
    () => canonicalPath(tree.button, { scopeRoot: tree.document, maxSegments: 16 }),
    /orçamento.*class/iu,
  );
  assert.equal(queryCalls, 0);
});

test('rejects an oversized role before tokenizing the explicit role list', () => {
  const element = new FixtureElement('button', { role: 'button '.repeat(5_000).trim() });
  assert.throws(() => roleForStructuralSignature(element), /orçamento.*role/iu);
});

test('rejects an oversized input type before normalizing the attribute', () => {
  const element = new FixtureElement('input', { type: 'future-control'.repeat(5_000) });
  assert.throws(() => roleForStructuralSignature(element), /orçamento.*type/iu);
});

test('rejects an oversized tagName before invoking toLowerCase', () => {
  const nativeToLowerCase = String.prototype.toLowerCase;
  const oversizedTag = 'a'.repeat(1_000_000);
  let oversizedCalls = 0;
  let caught = null;
  String.prototype.toLowerCase = function sentinelToLowerCase() {
    if (this.length === oversizedTag.length) {
      oversizedCalls += 1;
      throw new Error('toLowerCase não deveria ser chamado');
    }
    return nativeToLowerCase.call(this);
  };
  try {
    roleForStructuralSignature({
      tagName: oversizedTag,
      getAttribute() { return null; },
    });
  } catch (error) {
    caught = error;
  } finally {
    String.prototype.toLowerCase = nativeToLowerCase;
  }
  assert.match(String(caught?.message), /tag inválida/iu);
  assert.equal(oversizedCalls, 0);
});

test('canonicalPath rejects an excessive sibling collection before iteration or DOM query', () => {
  const fixture = oversizedChildrenFixture();
  assert.throws(
    () => canonicalPath(fixture.target, { scopeRoot: fixture.scopeRoot, maxSegments: 16 }),
    /orçamento.*filhos/iu,
  );
  assert.deepEqual(fixture.counts(), { iteratorCalls: 0, queryCalls: 0 });
});

test('StructuralSignature rejects an excessive sibling collection before hashing or iteration', async () => {
  const fixture = oversizedChildrenFixture();
  let digestCalls = 0;
  const subtle = { async digest() { digestCalls += 1; return new Uint8Array(32).buffer; } };
  await assert.rejects(
    () => createStructuralSignatureV1({
      documentId: 'doc-budget', frameId: 0, element: fixture.target, scopeRoot: fixture.scopeRoot, subtle,
    }),
    /orçamento.*filhos/iu,
  );
  assert.deepEqual(fixture.counts(), { iteratorCalls: 0, queryCalls: 0 });
  assert.equal(digestCalls, 0);
});

test('fails closed when a live children collection changes while it is snapshotted', () => {
  const target = new FixtureElement('button');
  let lengthReads = 0;
  let queryCalls = 0;
  const children = {
    0: target,
    get length() {
      lengthReads += 1;
      return lengthReads === 1 ? 1 : 2;
    },
  };
  const scopeRoot = {
    children,
    querySelectorAll() { queryCalls += 1; return [target]; },
  };
  target.parentElement = null;
  target.parentNode = scopeRoot;
  assert.throws(
    () => canonicalPath(target, { scopeRoot, maxSegments: 16 }),
    /coleção.*filhos.*alterada/iu,
  );
  assert.equal(queryCalls, 0);
});

test('selectorMatchesOne authorizes exactly one result and the expected object identity', () => {
  const { document, main, button } = simpleTree({ id: 'unique', class: 'duplicate' });
  main.append(new FixtureElement('button', { id: 'other', class: 'duplicate' }));
  assert.equal(selectorMatchesOne(document, 'button#unique', button), true);
  assert.equal(selectorMatchesOne(document, 'button.duplicate', button), false);
  assert.equal(selectorMatchesOne(document, 'button#other', button), false);
  assert.equal(selectorMatchesOne({ querySelectorAll() { throw new DOMException('invalid'); } }, 'button', button), false);
});

test('computes a role only from the first allowed explicit token or the closed native map', () => {
  const cases = [
    [new FixtureElement('button', { role: 'presentation link button' }), 'link'],
    [new FixtureElement('a', { href: '' }), 'link'],
    [new FixtureElement('area', { href: '/map' }), 'link'],
    [new FixtureElement('button'), 'button'],
    [new FixtureElement('input', { type: 'checkbox' }), 'checkbox'],
    [new FixtureElement('input', { type: 'number' }), 'spinbutton'],
    [new FixtureElement('input', { type: 'radio' }), 'radio'],
    [new FixtureElement('input', { type: 'range' }), 'slider'],
    [new FixtureElement('input', { type: 'submit' }), 'button'],
    [new FixtureElement('input', { type: 'image' }), 'button'],
    [new FixtureElement('input', { type: 'email' }), 'textbox'],
    [new FixtureElement('textarea'), 'textbox'],
    [new FixtureElement('img'), 'img'],
    [new FixtureElement('nav'), 'navigation'],
    [new FixtureElement('main'), 'main'],
    [new FixtureElement('ol'), 'list'],
    [new FixtureElement('li'), 'listitem'],
    [new FixtureElement('h4'), 'heading'],
    [new FixtureElement('dialog'), 'dialog'],
    [new FixtureElement('select'), null],
    [new FixtureElement('div'), null],
  ];
  for (const [element, expected] of cases) assert.equal(roleForStructuralSignature(element), expected, element.tagName);
});

test('treats missing, empty and invalid input types as the HTML text default', () => {
  assert.equal(roleForStructuralSignature(new FixtureElement('input')), 'textbox');
  assert.equal(roleForStructuralSignature(new FixtureElement('input', { type: '' })), 'textbox');
  assert.equal(roleForStructuralSignature(new FixtureElement('input', { type: 'future-control' })), 'textbox');
  assert.equal(roleForStructuralSignature(new FixtureElement('input', { type: 'FUTURE-CONTROL' })), 'textbox');
  assert.equal(roleForStructuralSignature(new FixtureElement('input', { type: 'hidden' })), null);
  assert.equal(roleForStructuralSignature(new FixtureElement('input', { type: 'date' })), null);
});

test('hashes a non-sensitive explicit role even when it is outside the selector enum', async () => {
  const tree = simpleTree({ role: 'combobox' });
  const inputs = [];
  const subtle = {
    async digest(algorithm, bytes) {
      inputs.push(new TextDecoder().decode(bytes));
      return webcrypto.subtle.digest(algorithm, bytes);
    },
  };
  await createStructuralSignatureV1({
    documentId: 'doc-role-hash', frameId: 0, element: tree.button, scopeRoot: tree.document, subtle,
  });
  const canonicalInput = inputs.at(-1);
  assert.match(canonicalInput, /"computedRole":"button"/u);
  assert.match(canonicalInput, /"name":"role","valueSha256":"[0-9a-f]{64}"/u);
  assert.doesNotMatch(canonicalInput, /combobox/u);
});

test('hashes a non-sensitive input type outside the selector enum without inventing a role', async () => {
  const tree = simpleTree({ type: 'date' });
  tree.button.tagName = 'INPUT';
  const inputs = [];
  const subtle = {
    async digest(algorithm, bytes) {
      inputs.push(new TextDecoder().decode(bytes));
      return webcrypto.subtle.digest(algorithm, bytes);
    },
  };
  await createStructuralSignatureV1({
    documentId: 'doc-type-hash', frameId: 0, element: tree.button, scopeRoot: tree.document, subtle,
  });
  const canonicalInput = inputs.at(-1);
  assert.match(canonicalInput, /"computedRole":null/u);
  assert.match(canonicalInput, /"name":"type","valueSha256":"[0-9a-f]{64}"/u);
  assert.doesNotMatch(canonicalInput, /"value":"date"/u);
});

test('distinguishes safe out-of-enum role values through their hashes', async () => {
  const tree = simpleTree({ role: 'combobox' });
  const input = { documentId: 'doc-role-change', frameId: 0, element: tree.button, scopeRoot: tree.document, subtle: webcrypto.subtle };
  const before = await createStructuralSignatureV1(input);
  tree.button.attributes.role = 'searchbox';
  const after = await createStructuralSignatureV1(input);
  assert.notEqual(before.sha256, after.sha256);
  assert.equal(roleForStructuralSignature(tree.button), 'button');
});

test('supports a complete canonical path and structural signature inside an open ShadowRoot scope', async () => {
  const shadowRoot = new FixtureShadowRoot('open');
  const region = shadowRoot.append(new FixtureElement('section'));
  const button = region.append(new FixtureElement('button', { class: 'primary' }));
  assert.equal(
    canonicalPath(button, { scopeRoot: shadowRoot, maxSegments: 16 }).value,
    'section > button.primary',
  );
  const input = { documentId: 'doc-open-shadow', frameId: 2, element: button, scopeRoot: shadowRoot, subtle: webcrypto.subtle };
  const signature = await createStructuralSignatureV1(input);
  assert.equal(await structuralSignatureMatches(signature, input), true);
});

test('creates a deterministic, deeply frozen structural signature without raw private DOM data', async () => {
  const { document, main, button } = simpleTree({
    id: 'private-customer-name',
    class: 'account-summary',
    role: 'button',
  });
  main.attributes.type = 'email';
  button.textContent = 'Saldo bancário sigiloso';
  button.accessibleName = 'Conta de Maria';
  button.href = 'https://private.test/?token=secret';
  const digestedInputs = [];
  const subtle = {
    async digest(algorithm, bytes) {
      digestedInputs.push(new TextDecoder().decode(bytes));
      return webcrypto.subtle.digest(algorithm, bytes);
    },
  };
  const input = { documentId: 'document-1', frameId: 0, element: button, scopeRoot: document, subtle };
  const first = await createStructuralSignatureV1(input);
  const second = await createStructuralSignatureV1(input);
  assert.deepEqual(first, second);
  assert.match(first.sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(Object.keys(first).sort(), ['sha256', 'version']);
  assert.equal(Object.isFrozen(first), true);

  const canonicalInput = digestedInputs.at(-1);
  assert.match(canonicalInput, /StructuralSignatureInputV1/u);
  assert.match(canonicalInput, /"valueSha256":"[0-9a-f]{64}"/u);
  assert.doesNotMatch(canonicalInput, /private-customer|account-summary|Saldo bancário|Conta de Maria|private\.test|"value":"email"/u);
});

test('signature changes on document, frame, node or ancestry replacement and matches in constant-size form', async () => {
  const { document, body, main, button } = simpleTree();
  const input = { documentId: 'doc-current', frameId: 0, element: button, scopeRoot: document, subtle: webcrypto.subtle };
  const original = await createStructuralSignatureV1(input);
  assert.equal(await structuralSignatureMatches(original, input), true);
  assert.equal(await structuralSignatureMatches(original, { ...input, documentId: 'doc-reload' }), false);
  assert.equal(await structuralSignatureMatches(original, { ...input, frameId: 4 }), false);

  const changedLastByte = { ...original, sha256: `${original.sha256.slice(0, -2)}${original.sha256.endsWith('00') ? '01' : '00'}` };
  assert.equal(await structuralSignatureMatches(changedLastByte, input), false);

  const ancestorReplacement = new FixtureElement('section');
  body.replace(main, ancestorReplacement);
  ancestorReplacement.append(button);
  assert.equal(await structuralSignatureMatches(original, input), false);

  const replacement = new FixtureElement('a', { href: '/next' });
  ancestorReplacement.replace(button, replacement);
  assert.equal(await structuralSignatureMatches(original, { ...input, element: replacement }), false);
});

test('structural signatures reject caller-supplied structure, malformed expected hashes and incomplete ancestry', async () => {
  const tree = simpleTree();
  const input = { documentId: 'doc-1', frameId: 0, element: tree.button, scopeRoot: tree.document, subtle: webcrypto.subtle };
  await assert.rejects(
    () => createStructuralSignatureV1({ ...input, computedRole: 'button' }),
    /entrada.*assinatura|argumentos/iu,
  );
  await assert.rejects(
    () => createStructuralSignatureV1({ ...input, documentId: 'https://private.test/document' }),
    /entrada.*assinatura|argumentos/iu,
  );
  await assert.rejects(
    () => createStructuralSignatureV1({ ...input, documentId: 'a'.repeat(241) }),
    /entrada.*assinatura|argumentos/iu,
  );
  await assert.rejects(
    () => structuralSignatureMatches({ version: 'StructuralSignatureV1', sha256: 'a'.repeat(64), extra: true }, input),
    /assinatura/iu,
  );
  await assert.rejects(
    () => structuralSignatureMatches({ version: 'StructuralSignatureV1', sha256: 'A'.repeat(64) }, input),
    /assinatura/iu,
  );

  const deep = linearTree(17);
  await assert.rejects(
    () => createStructuralSignatureV1({ documentId: 'doc-1', frameId: 0, element: deep.target, scopeRoot: deep.document, subtle: webcrypto.subtle }),
    /escopo não alcançado/iu,
  );
});

test('snapshots signature arguments from data descriptors without invoking Proxy get traps', async () => {
  const tree = simpleTree();
  const input = { documentId: 'doc-proxy', frameId: 0, element: tree.button, scopeRoot: tree.document, subtle: webcrypto.subtle };
  const expected = await createStructuralSignatureV1(input);
  const reads = [];
  const proxy = new Proxy(input, {
    get(_target, key) { reads.push(key); throw new Error(`leitura proibida: ${String(key)}`); },
  });
  assert.deepEqual(await createStructuralSignatureV1(proxy), expected);
  assert.deepEqual(reads, []);
});

test('does not let a Proxy get trap replace an invalid descriptor value in signature arguments', async () => {
  const tree = simpleTree();
  const descriptorValues = {
    documentId: 'https://descriptor.invalid/document',
    frameId: 0,
    element: tree.button,
    scopeRoot: tree.document,
    subtle: webcrypto.subtle,
  };
  const proxy = new Proxy(descriptorValues, {
    get(target, key, receiver) {
      if (key === 'documentId') return 'doc-forged-by-get';
      return Reflect.get(target, key, receiver);
    },
  });
  await assert.rejects(() => createStructuralSignatureV1(proxy), /entrada.*assinatura|argumentos/iu);
});

test('snapshots the expected signature from descriptors without invoking Proxy get traps', async () => {
  const tree = simpleTree();
  const input = { documentId: 'doc-expected-proxy', frameId: 0, element: tree.button, scopeRoot: tree.document, subtle: webcrypto.subtle };
  const signature = await createStructuralSignatureV1(input);
  const reads = [];
  const expectedProxy = new Proxy(signature, {
    get(_target, key) { reads.push(key); throw new Error(`leitura proibida: ${String(key)}`); },
  });
  assert.equal(await structuralSignatureMatches(expectedProxy, input), true);
  assert.deepEqual(reads, []);
});

test('does not let a Proxy get trap mask an invalid expected-signature descriptor', async () => {
  const tree = simpleTree();
  const input = { documentId: 'doc-invalid-proxy', frameId: 0, element: tree.button, scopeRoot: tree.document, subtle: webcrypto.subtle };
  const signature = await createStructuralSignatureV1(input);
  const descriptorValues = { ...signature, sha256: signature.sha256.toUpperCase() };
  const expectedProxy = new Proxy(descriptorValues, {
    get(target, key, receiver) {
      if (key === 'sha256') return signature.sha256;
      return Reflect.get(target, key, receiver);
    },
  });
  await assert.rejects(() => structuralSignatureMatches(expectedProxy, input), /assinatura/iu);
});
