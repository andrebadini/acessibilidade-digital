import assert from 'node:assert/strict';
import test from 'node:test';
import { buildVerdict, entryFix, entryTone, laySummary, roleName, spokenAnnouncement, topIssues } from '../../src/reader/plain-language.js';
import { createReadingReport } from '../../src/reader/report-model.js';
import { READING_REASON_TEXT, hasReason } from '../../src/reader/reading-reasons.js';

const entry = (fields = {}) => ({ id: 'e', selector: 'x', tag: 'button', role: 'button', name: 'Enviar', description: '', states: [],
  preview: 'Enviar, botão', tabIndex: 0, tabOrder: 1, category: 'tab', reasons: [], bounds: null, ...fields });

test('recognizes reasons both as codes and as the explained text stored in the report', () => {
  assert.equal(hasReason(entry({ reasons: ['aria-hidden'] }), 'aria-hidden'), true);
  assert.equal(hasReason(entry({ reasons: [READING_REASON_TEXT['aria-hidden']] }), 'aria-hidden'), true);
  assert.equal(hasReason(entry({ reasons: ['outra coisa'] }), 'aria-hidden'), false);
  assert.equal(hasReason(entry({ reasons: ['x'] }), 'constructor'), false);
  const report = createReadingReport({ version: 1, sessionId: 's', limitations: [], counts: {},
    entries: [entry({ reasons: ['aria-hidden'] })] });
  assert.equal(report.entries[0].reasons[0], READING_REASON_TEXT['aria-hidden'], 'the report keeps the text');
  assert.equal(entryTone(report.entries[0]), 'problem', 'the tone still sees the reason');
});

test('traffic light: problems, reviews, ok and neutral hidden elements', () => {
  assert.equal(entryTone(entry()), 'ok');
  assert.equal(entryTone(entry({ name: '' })), 'problem', 'nameless control in Tab');
  assert.equal(entryTone(entry({ category: 'outside-tab', tabOrder: null, name: '' })), 'problem', 'nameless control outside Tab');
  assert.equal(entryTone(entry({ reasons: ['aria-hidden'] })), 'problem', 'focusable but hidden from AT');
  assert.equal(entryTone(entry({ tag: 'img', role: 'img', name: '', category: 'reading', tabOrder: null })), 'problem');
  assert.equal(entryTone(entry({ tag: 'a', role: 'link', name: 'Saiba mais' })), 'review', 'generic link text needs context');
  assert.equal(entryTone(entry({ name: 'Menu' })), 'ok', 'short button names are not flagged');
  assert.equal(entryTone(entry({ category: 'outside-tab', tabOrder: null })), 'review');
  assert.equal(entryTone(entry({ category: 'outside-tab', tabOrder: null, reasons: ['radio-group-arrow-navigation'] })), 'ok');
  assert.equal(entryTone(entry({ category: 'outside-tab', tabOrder: null, reasons: ['native-disabled'] })), 'ok');
  assert.equal(entryTone(entry({ reasons: ['aria-disabled-remains-focusable'] })), 'review');
  assert.equal(entryTone(entry({ tag: 'h2', role: 'heading', name: '', category: 'reading', tabOrder: null })), 'review');
  assert.equal(entryTone(entry({ category: 'hidden', tabOrder: null, name: '' })), 'info');
});

test('fixes exist only for problems and reviews and speak plain Portuguese', () => {
  assert.equal(entryFix(entry()), null);
  assert.equal(entryFix(entry({ category: 'hidden', tabOrder: null })), null);
  assert.match(entryFix(entry({ name: '' })).problem, /botão não tem nome acessível/u);
  assert.match(entryFix(entry({ tag: 'a', role: 'link', name: '' })).after, /Baixar/u);
  assert.match(entryFix(entry({ tag: 'img', role: 'img', name: '', category: 'reading', tabOrder: null })).action, /alt=""/u);
  assert.match(entryFix(entry({ tag: 'a', role: 'link', name: 'clique aqui' })).problem, /não diz para onde/u);
  assert.match(entryFix(entry({ reasons: ['aria-hidden'] })).action, /aria-hidden/u);
  for (const value of [entry({ name: '' }), entry({ category: 'outside-tab', tabOrder: null })]) {
    const fix = entryFix(value);
    assert.deepEqual(Object.keys(fix), ['problem', 'action', 'before', 'after']);
  }
});

test('lay summary and spoken announcement', () => {
  assert.equal(laySummary(entry()), 'Quem usa leitor de tela ouviria “Enviar” (botão).');
  assert.match(laySummary(entry({ name: '' })), /ouviria só “botão”/u);
  assert.match(laySummary(entry({ tag: 'img', role: 'img', name: '' })), /não saberia o que esta imagem mostra/u);
  assert.match(laySummary(entry({ category: 'hidden', tabOrder: null })), /oculto/u);
  assert.match(laySummary(entry({ reasons: ['aria-hidden'] })), /pode não ouvir nada útil/u, 'aria-hidden is not presented as announced');
  assert.equal(roleName(entry({ role: 'heading' })), 'título');
  assert.equal(roleName(entry({ role: '', tag: 'div' })), 'div');
  assert.equal(spokenAnnouncement(entry()), 'Tab 1. Enviar, botão');
  assert.equal(spokenAnnouncement(entry({ tabOrder: null, preview: '' })), 'Enviar');
});

test('verdict counts ignore hidden elements and any problem turns the light red', () => {
  assert.equal(buildVerdict([entry()]).tone, 'ok');
  assert.equal(buildVerdict([entry(), entry({ category: 'hidden', tabOrder: null })]).tone, 'ok');
  const review = buildVerdict([entry({ category: 'outside-tab', tabOrder: null })]);
  assert.equal(review.tone, 'review');
  assert.match(review.phrase, /1 ponto\(s\) para revisar/u);
  const few = buildVerdict([entry({ name: '' }), entry()]);
  assert.equal(few.tone, 'problem');
  assert.match(few.phrase, /^Leitura com atrito/u);
  const many = buildVerdict(Array.from({ length: 4 }, (_, index) => entry({ id: `e${index}`, name: '' })));
  assert.match(many.phrase, /^Leitura difícil: 4 pontos/u);
  assert.deepEqual(many.counts, { problem: 4, review: 0, ok: 0, info: 0, total: 4, tab: 4 });
});

test('top issues put problems first, then reviews, in Tab order, without ok or hidden items', () => {
  const list = [
    entry({ id: 'r3', tabOrder: 3, reasons: ['aria-disabled-remains-focusable'] }),
    entry({ id: 'p2', tabOrder: 2, name: '' }),
    entry({ id: 'ok', tabOrder: 1 }),
    entry({ id: 'h', category: 'hidden', tabOrder: null, name: '' }),
    entry({ id: 'p-reading', tag: 'img', role: 'img', name: '', category: 'reading', tabOrder: null }),
  ];
  assert.deepEqual(topIssues(list).map(item => item.id), ['p2', 'p-reading', 'r3']);
  assert.deepEqual(topIssues(list, 1).map(item => item.id), ['p2']);
});
