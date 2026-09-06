import test from 'node:test';
import assert from 'node:assert/strict';
import { resultsOverview } from '../../src/core/report/results-overview.js';

test('score counts concluded core checks once, excludes human decisions, supplemental engines and inapplicable checks', () => {
  const check = (checkKey, originalOutcome, engine='audita-core') => ({checkKey,originalOutcome,engine});
  const view = {executive:{counts:{errors:{checkKeys:1},alerts:{checkKeys:1},humanReview:{checkKeys:3},positive:{checkKeys:4}}},
    issues:{failed:[check('a','failed')],alerts:[check('axe','failed','axe-core')],humanReview:[check('b','cantTell'),check('c','inapplicable')],
      passed:[check('d','passed'),check('e','passed'),check('f','passed'),check('a','failed')]}};
  const before=JSON.stringify(view);
  const result=resultsOverview(view);
  assert.equal(result.score,7.5);
  assert.equal(result.concluded,4);
  assert.equal(result.passed,3);
  assert.equal(result.total,9);
  assert.deepEqual(result.segments.map(segment=>segment.count),[1,1,3,4]);
  assert.equal(JSON.stringify(view),before);
});

test('no concluded automatic check means no score, never a perfect ten', () => {
  const result=resultsOverview({executive:{counts:{}},issues:{humanReview:[{checkKey:'a',originalOutcome:'cantTell',engine:'audita-core'}]}});
  assert.equal(result.score,null);
  assert.equal(result.concluded,0);
  assert.equal(result.total,0);
});
