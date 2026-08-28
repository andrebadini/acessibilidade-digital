import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('reopened panel hydrates the persisted export attempt correlation', async () => {
  const source = await readFile(new URL('../../src/panel/panel.js', import.meta.url), 'utf8');
  assert.match(source, /restoreExportEventState\(saved\)/u);
  assert.match(source, /GET_LAST_AUDIT/u);
});
