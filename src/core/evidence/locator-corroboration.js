// Corroboração semântica do elemento localizado, usada SÓ quando os sinais são recolocados numa
// página recarregada (mesmo endereço, documento novo). No caminho normal a prova é o próprio
// documentId auditado, e nada disto é enviado à página.
//
// O dado sai da evidência já guardada (`accessibility.name` e `accessibility.visibleText`), que é
// texto que a pessoa já vê na página. Nada de URL bruta nem de conteúdo de formulário: os dois
// campos passam por um corte de tamanho e por uma recusa de valores com caracteres de controle, e o
// que não sobrar simplesmente não vira corroboração — aí o locator estrito continua sendo o critério
// único, exatamente como antes.
//
// A leitura viva do outro lado (dentro da página) repete estas mesmas regras em
// `matchesCorroboration`, no overlay: o overlay é serializado e injetado como função, então não pode
// importar nada.
const MAX_TEXT = 200;
const MAX_SOURCE = 4_000;
const CONTROL = /[\u0000-\u001f\u007f]/u;

function readOwn(value, key) {
  try {
    const descriptor = value && typeof value === 'object' ? Reflect.getOwnPropertyDescriptor(value, key) : null;
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

/** Colapsa espaços e recusa o que não serve como texto comparável. */
export function normalizeLocatorText(value) {
  if (typeof value !== 'string' || value.length > MAX_SOURCE) return '';
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length === 0 || normalized.length > MAX_TEXT || CONTROL.test(normalized) ? '' : normalized;
}

/**
 * Monta a corroboração de uma evidência de elemento. Devolve `null` quando a auditoria não guardou
 * nome acessível nem texto visível utilizáveis.
 */
export function locatorCorroboration(accessibility) {
  const name = normalizeLocatorText(readOwn(accessibility, 'name'));
  const text = normalizeLocatorText(readOwn(accessibility, 'visibleText'));
  if (!name && !text) return null;
  const record = {};
  if (name) record.name = name;
  if (text) record.text = text;
  return Object.freeze(record);
}
