import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AXE_PROVENANCE } from '../src/browser/axe-adapter.js';
import { AXE_UPSTREAM_SHA256, FORBIDDEN_RUNTIME_PATTERNS, patchAxeSource } from '../scripts/vendor-axe.mjs';

const root = new URL('../', import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function runtimeFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await runtimeFiles(path));
    else if (entry.isFile() && /\.(?:m?js|html)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

test('vendor axe is the official 4.13.0 build plus only the reproducible readability patch', async () => {
  const upstream = await readFile(new URL('node_modules/axe-core/axe.js', root));
  assert.equal(sha256(upstream), AXE_UPSTREAM_SHA256);
  const vendored = await readFile(new URL('vendor/axe/axe.js', root));
  assert.equal(sha256(patchAxeSource(upstream)), sha256(vendored));
  assert.equal(AXE_PROVENANCE.runtimeSha256, sha256(vendored));
  const source = vendored.toString('utf8');
  assert.ok(source.startsWith('/*! axe v4.13.0\n * Copyright (c) 2015 - 2026 Deque Systems, Inc.'), 'aviso MPL preservado');
  assert.match(source, /Modificado pelo Audita Acessibilidade/u);
  assert.match(source, /var require_object_create = __commonJS\(function\(exports, module\) \{\n {6}'use strict';\n(?: {6}\/\/.*\n)+ {6}module\.exports = Object\.create;\n {4}\}\);/u);
});

test('packaged runtime has none of the string-splitting patterns the Chrome Web Store flagged as obfuscation', async () => {
  const files = [
    ...await runtimeFiles(fileURLToPath(new URL('src/', root))),
    ...await runtimeFiles(fileURLToPath(new URL('vendor/', root))),
  ];
  assert.ok(files.some(file => file.endsWith('vendor/axe/axe.js')));
  for (const file of files) {
    const value = await readFile(file, 'utf8');
    for (const pattern of FORBIDDEN_RUNTIME_PATTERNS) assert.ok(!pattern.test(value), `${pattern} em ${file}`);
  }
});
