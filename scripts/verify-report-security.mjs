import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { REPORT_SCRIPT, REPORT_SCRIPT_CSP_HASH } from '../src/core/report/report.js.js';

const BLOCKED_DIRECTIVES = Object.freeze([
  'default-src', 'connect-src', 'object-src', 'frame-src', 'font-src', 'media-src', 'worker-src',
]);
const FORBIDDEN_SCRIPT_APIS = /\b(?:eval|Function|fetch|XMLHttpRequest|WebSocket|Worker|innerHTML|insertAdjacentHTML|document\.write)\b/u;

export function verifyStaticReportSecurity(html) {
  assert.equal(typeof html, 'string', 'relatório HTML precisa ser texto');

  const scriptOpenings = html.match(/<script\b/giu) ?? [];
  const scriptClosings = html.match(/<\/script\s*>/giu) ?? [];
  const scripts = [...html.matchAll(/<script\b([^>]*)>([^]*?)<\/script\s*>/giu)];
  assert.equal(scriptOpenings.length, 1, 'relatório precisa conter exatamente um script estático');
  assert.equal(scriptClosings.length, 1, 'relatório precisa encerrar exatamente um script estático');
  assert.equal(scripts.length, 1, 'relatório precisa conter um script estático bem formado');
  assert.equal(scripts[0][1], '', 'script estático incorporado não pode ter atributos nem src');
  assert.equal(scripts[0][2], REPORT_SCRIPT, 'script do relatório precisa ser estático e independente dos dados auditados');

  const computedHash = `sha256-${createHash('sha256').update(REPORT_SCRIPT).digest('base64')}`;
  assert.equal(REPORT_SCRIPT_CSP_HASH, computedHash, 'hash CSP declarado do script precisa corresponder ao runtime estático');
  const cspMatches = [...html.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/giu)];
  assert.equal(cspMatches.length, 1, 'relatório precisa declarar exatamente uma CSP');
  const directives = parseDirectives(cspMatches[0][1]);
  assert.equal(directives.get('script-src'), `'${computedHash}'`, 'CSP precisa autorizar exclusivamente o hash exato do script estático');
  for (const name of BLOCKED_DIRECTIVES) {
    assert.equal(directives.get(name), "'none'", `CSP do relatório precisa bloquear ${name}`);
  }
  assert.doesNotMatch(cspMatches[0][1], /unsafe-inline|unsafe-eval|https?:/iu, 'CSP do relatório não pode autorizar código inseguro ou remoto');

  assert.doesNotMatch(html, /<script[^>]+src=|<link\b|@import|url\(\s*["']?https?:|<(?:img|source)[^>]+src=["']https?:/iu, 'relatório não pode carregar executáveis ou recursos remotos');
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']https?:/iu, 'relatório não pode referenciar src ou href remoto');
  assert.doesNotMatch(html, /<[^>]+\son[a-z]+\s*=/iu, 'relatório não pode conter manipuladores inline');
  assert.doesNotMatch(REPORT_SCRIPT, FORBIDDEN_SCRIPT_APIS, 'script estático não pode avaliar, buscar ou construir marcação dinâmica');

  const controls = [...html.matchAll(/<(?:select|button)\b[^>]*>/giu)].map(match => match[0]);
  assert.ok(controls.length > 0, 'relatório precisa expor controles de filtro reconhecíveis');
  for (const control of controls) {
    assert.match(control, /\sdisabled(?:\s|>)/iu, 'cada controle precisa permanecer desabilitado no fallback sem JavaScript');
  }
  const details = [...html.matchAll(/<details\b[^>]*>/giu)].map(match => match[0]);
  assert.ok(details.length > 0, 'relatório precisa expor detalhes técnicos no HTML de origem');
  for (const detail of details) {
    assert.match(detail, /\sopen(?:\s|>)/iu, 'cada detalhe precisa permanecer aberto no fallback sem JavaScript');
  }
  assert.match(html, /class="filters-noscript"[^>]*>[^<]*Sem JavaScript,[^<]*abertos e legíveis/iu, 'fallback sem JavaScript precisa ser explicado no relatório');
}

function parseDirectives(value) {
  const entries = value.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const separator = part.indexOf(' ');
    return separator < 0 ? [part, ''] : [part.slice(0, separator), part.slice(separator + 1).trim()];
  });
  assert.equal(new Set(entries.map(([name]) => name)).size, entries.length, 'CSP do relatório não pode repetir diretivas');
  return new Map(entries);
}
