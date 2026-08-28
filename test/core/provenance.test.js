import assert from 'node:assert/strict';
import test from 'node:test';

import { AXE_PROVENANCE } from '../../src/browser/axe-adapter.js';
import {
  hasRegisteredSource,
  registeredOccurrenceSource,
  registeredRuleSource,
} from '../../src/core/provenance.js';

const RULES_VERSION = '1.0.0';

test('the canonical registry binds core, editorial, manual and axe identities to exact engines and versions', () => {
  const cases = [
    {
      input: { ruleId: 'focus-visible' },
      expected: { engine: 'audita-core', ruleId: 'focus-visible', version: RULES_VERSION },
    },
    {
      input: { ruleId: 'editorial.placeholder-text' },
      expected: { engine: 'audita-editorial', ruleId: 'editorial.placeholder-text', version: RULES_VERSION },
    },
    {
      input: { ruleId: 'axe.button-name', engineRuleId: 'button-name' },
      expected: {
        engine: AXE_PROVENANCE.engine,
        ruleId: 'axe.button-name',
        version: AXE_PROVENANCE.version,
        engineRuleId: 'button-name',
      },
    },
  ];
  for (const entry of cases) {
    const registered = registeredRuleSource(entry.input, RULES_VERSION);
    assert.deepEqual(registered, entry.expected);
    assert.equal(hasRegisteredSource(entry.expected, registered), true);
    for (const forged of [
      { ...entry.expected, engine: 'third-party' },
      { ...entry.expected, version: '9.9.9' },
      { ...entry.expected, privateField: 'forged' },
    ]) assert.equal(hasRegisteredSource(forged, registered), false);
  }

  const manual = {
    ruleId: null,
    nbrItemRef: '5.7.5',
    source: { engine: 'audita-manual-review', ruleId: 'manual:5.7.5', version: RULES_VERSION },
  };
  assert.deepEqual(registeredOccurrenceSource(manual, RULES_VERSION), manual.source);
  assert.equal(hasRegisteredSource(manual.source, registeredOccurrenceSource(manual, RULES_VERSION)), true);
  assert.equal(hasRegisteredSource(
    { ...manual.source, engine: 'audita-core' },
    registeredOccurrenceSource(manual, RULES_VERSION),
  ), false);
});

test('the registry rejects unknown or internally inconsistent rule identities', () => {
  for (const input of [
    { ruleId: 'focus-visible', engineRuleId: 'focus-visible' },
    { ruleId: 'supplemental.unknown' },
    { ruleId: 'axe.button-name', engineRuleId: 'image-alt' },
    { ruleId: 'axe.button-name' },
  ]) assert.equal(registeredRuleSource(input, RULES_VERSION), null);

  assert.equal(registeredOccurrenceSource({
    ruleId: null,
    nbrItemRef: '5.7.5',
    source: { engine: 'audita-manual-review', ruleId: 'manual:5.1.1', version: RULES_VERSION },
  }, RULES_VERSION), null);

  assert.equal(registeredRuleSource({ ruleId: 'focus-visible' }, '9.9.9'), null);
  assert.equal(registeredRuleSource({ ruleId: 'editorial.placeholder-text' }, '9.9.9'), null);
  assert.equal(registeredRuleSource({
    ruleId: 'axe.button-name', engineRuleId: 'button-name',
  }, '9.9.9'), null);
  assert.equal(registeredOccurrenceSource({
    ruleId: null,
    nbrItemRef: '5.7.5',
    source: { engine: 'audita-manual-review', ruleId: 'manual:5.7.5', version: '9.9.9' },
  }, '9.9.9'), null);
});
