// Gera vendor/axe/axe.js a partir do pacote oficial axe-core 4.13.0 (node_modules/axe-core/axe.js).
//
// Por que existe: a Chrome Web Store rejeitou a 1.1.50 (violação "Red Titanium", código ofuscado)
// apontando este trecho do core-js embutido no axe:
//
//     return LT + SCRIPT + GT + content + LT + '/' + SCRIPT + GT;
//
// É o polyfill de Object.create do core-js ("object-create") para Internet Explorer 8 e anteriores:
// ele monta por concatenação uma tag <script> e uma URL "javascript:" e as escreve num documento
// ActiveX ou num iframe oculto. A extensão exige Chrome 116+ (manifest.minimum_chrome_version), onde
// Object.create é nativo, então esse caminho nunca executa. O script substitui somente esse módulo
// por Object.create nativo, sem mudar o comportamento, e grava o arquivo com um aviso de modificação
// (MPL-2.0). Todo o resto do axe permanece byte a byte igual ao pacote oficial.
//
// Uso: node scripts/vendor-axe.mjs           (regrava vendor/axe/axe.js)
//      node scripts/vendor-axe.mjs --check   (só confere se vendor/axe/axe.js é reproduzível)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

export const AXE_UPSTREAM_SHA256 = '138a93a4ce7b7c6c08ed84144e45dcd8cc36d2d4ff8ed673619faf0406906d88';

const root = new URL('../', import.meta.url);
const upstreamUrl = new URL('node_modules/axe-core/axe.js', root);
const vendorUrl = new URL('vendor/axe/axe.js', root);

const LICENSE_HEADER_END = ' * code.\n */\n';
const MODIFICATION_NOTICE = [
  '/*',
  ' * Modificado pelo Audita Acessibilidade (scripts/vendor-axe.mjs) a partir do axe-core 4.13.0 oficial',
  ` * (SHA-256 ${AXE_UPSTREAM_SHA256}).`,
  ' * Única alteração: o módulo "object-create" do core-js passa a usar Object.create nativo; o caminho',
  ' * alternativo para Internet Explorer 8 (documento ActiveX ou iframe) nunca executa no Chrome e foi removido.',
  ' */',
  '',
].join('\n');

const OBJECT_CREATE_START = '    var require_object_create = __commonJS(function(exports, module) {\n';
const OBJECT_CREATE_END = '\n    var require_define_built_in = __commonJS(';
const OBJECT_CREATE_REPLACEMENT = [
  '    var require_object_create = __commonJS(function(exports, module) {',
  "      'use strict';",
  '      // Audita Acessibilidade: o core-js original trazia aqui um polyfill de Object.create para',
  '      // Internet Explorer 8 e anteriores. O Chrome 116+ exigido pela extensão tem Object.create nativo.',
  '      module.exports = Object.create;',
  '    });',
].join('\n');

// Padrões que a revisão da loja trata como ofuscação e que não podem voltar ao pacote.
export const FORBIDDEN_RUNTIME_PATTERNS = Object.freeze([
  /LT \+ SCRIPT \+ GT/u,
  /['"]java['"]\s*\+/u,
  /ActiveXObject/u,
]);

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function patchAxeSource(upstream) {
  assert.equal(sha256(upstream), AXE_UPSTREAM_SHA256, 'node_modules/axe-core/axe.js não é o axe-core 4.13.0 oficial');
  const source = upstream.toString('utf8');
  const headerEnd = source.indexOf(LICENSE_HEADER_END);
  assert.ok(headerEnd > 0 && source.startsWith('/*! axe v4.13.0'), 'cabeçalho de licença do axe não encontrado');
  const start = source.indexOf(OBJECT_CREATE_START);
  assert.ok(start > 0 && source.indexOf(OBJECT_CREATE_START, start + 1) === -1, 'módulo object-create não encontrado uma única vez');
  const end = source.indexOf(OBJECT_CREATE_END, start);
  assert.ok(end > start, 'fim do módulo object-create não encontrado');
  const original = source.slice(start, end);
  assert.match(original, /LT \+ SCRIPT \+ GT/u, 'o módulo object-create mudou; revise o patch');
  const headerSplit = headerEnd + LICENSE_HEADER_END.length;
  const patched = source.slice(0, headerSplit) + MODIFICATION_NOTICE + source.slice(headerSplit, start)
    + OBJECT_CREATE_REPLACEMENT + source.slice(end);
  for (const pattern of FORBIDDEN_RUNTIME_PATTERNS) {
    assert.ok(!pattern.test(patched), `padrão proibido restante no axe: ${pattern}`);
  }
  return Buffer.from(patched, 'utf8');
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  const patched = patchAxeSource(await readFile(upstreamUrl));
  if (process.argv.includes('--check')) {
    assert.equal(sha256(await readFile(vendorUrl)), sha256(patched), 'vendor/axe/axe.js não corresponde ao patch reproduzível');
    console.log(`vendor/axe/axe.js reproduzível\nSHA-256 ${sha256(patched)}`);
  } else {
    await writeFile(vendorUrl, patched);
    console.log(`vendor/axe/axe.js gerado\nSHA-256 ${sha256(patched)}`);
  }
}
