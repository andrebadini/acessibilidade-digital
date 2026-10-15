/**
 * Esquema fechado e versionado das marcas de revisão (`marks`) da decisão humana.
 *
 * A revisão guiada do item 5.1.13 deixa a pessoa apontar o que ficou sem caixa azul no mapa do
 * teclado: itens suspeitos (pelo número da lista) e até cinco áreas retangulares desenhadas sobre a
 * imagem. As coordenadas são pixels CSS do DOCUMENTO auditado — nunca pixels da captura —, para que
 * continuem fazendo sentido se a imagem for reamostrada. Decisões gravadas antes deste recurso não
 * têm `marks` e continuam válidas: o campo é opcional e só existe quando há o que apontar.
 */

export const REVIEW_MARKS_VERSION = 1;

/**
 * As marcas só existem no cartão do mapa do teclado (item 5.1.13, ajuda "keyboard-map"): são um
 * apontamento *sobre aquele mapa*. Amarrar o item aqui impede que uma decisão de outro item carregue
 * números e áreas que não têm mapa a que corresponder.
 */
export const REVIEW_MARKS_ITEM_ID = '5.1.13';

export const REVIEW_MARKS_LIMITS = Object.freeze({
  version: REVIEW_MARKS_VERSION,
  maxSuspects: 60,
  maxAreas: 5,
  // Teto genérico de sanidade para uma coordenada de documento. O limite que vale é o tamanho do
  // documento observado (`geometry.sourceCssSize` do mapa), conferido na validação do modelo, onde
  // a geometria está disponível.
  maxCoordinate: 1_000_000,
});

const MARKS_KEYS = Object.freeze(['version', 'suspects', 'areas']);
const AREA_KEYS = Object.freeze(['x', 'y', 'width', 'height']);

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownValue(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function coordinate(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || value > REVIEW_MARKS_LIMITS.maxCoordinate) {
    throw new TypeError(`${label} deve ser um número inteiro de pixels do documento.`);
  }
  if (positive && value < 1) throw new TypeError(`${label} deve ser maior que zero.`);
  return value;
}

/**
 * Normaliza as marcas para a forma canônica — a mesma que o hash do modelo cobre — ou devolve
 * `null` quando não há nada apontado (nem item, nem área).
 */
export function canonicalReviewMarks(value) {
  if (value === null || value === undefined) return null;
  if (!isPlainRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('Marcas da revisão devem ser um objeto de dados simples.');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== MARKS_KEYS.length || keys.some(key => typeof key !== 'string' || !MARKS_KEYS.includes(key))) {
    throw new TypeError('Marcas da revisão possuem campos não reconhecidos.');
  }
  if (ownValue(value, 'version') !== REVIEW_MARKS_VERSION) {
    throw new TypeError(`Versão de marcas da revisão não reconhecida: ${String(ownValue(value, 'version'))}.`);
  }
  const rawSuspects = ownValue(value, 'suspects');
  if (!Array.isArray(rawSuspects) || rawSuspects.length > REVIEW_MARKS_LIMITS.maxSuspects) {
    throw new TypeError(`A lista de itens apontados aceita no máximo ${REVIEW_MARKS_LIMITS.maxSuspects} números.`);
  }
  const suspects = [];
  for (const candidate of rawSuspects) {
    if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > REVIEW_MARKS_LIMITS.maxSuspects) {
      throw new TypeError('Cada item apontado deve ser o número de um item suspeito do mapa do teclado.');
    }
    if (!suspects.includes(candidate)) suspects.push(candidate);
  }
  suspects.sort((left, right) => left - right);
  const rawAreas = ownValue(value, 'areas');
  if (!Array.isArray(rawAreas) || rawAreas.length > REVIEW_MARKS_LIMITS.maxAreas) {
    throw new TypeError(`A marcação por área aceita no máximo ${REVIEW_MARKS_LIMITS.maxAreas} áreas.`);
  }
  const areas = rawAreas.map((area, index) => {
    const label = `Área ${index + 1}`;
    if (!isPlainRecord(area) || Object.getPrototypeOf(area) !== Object.prototype) {
      throw new TypeError(`${label} deve ser um objeto de dados simples.`);
    }
    const areaKeys = Reflect.ownKeys(area);
    if (areaKeys.length !== AREA_KEYS.length || areaKeys.some(key => typeof key !== 'string' || !AREA_KEYS.includes(key))) {
      throw new TypeError(`${label} possui campos não reconhecidos.`);
    }
    const x = coordinate(ownValue(area, 'x'), `${label}: x`);
    const y = coordinate(ownValue(area, 'y'), `${label}: y`);
    const width = coordinate(ownValue(area, 'width'), `${label}: largura`, { positive: true });
    const height = coordinate(ownValue(area, 'height'), `${label}: altura`, { positive: true });
    if (x + width > REVIEW_MARKS_LIMITS.maxCoordinate || y + height > REVIEW_MARKS_LIMITS.maxCoordinate) {
      throw new TypeError(`${label} ultrapassa o limite de coordenadas do documento.`);
    }
    return { x, y, width, height };
  });
  if (suspects.length === 0 && areas.length === 0) return null;
  return Object.freeze({
    version: REVIEW_MARKS_VERSION,
    suspects: Object.freeze(suspects),
    areas: Object.freeze(areas.map(area => Object.freeze(area))),
  });
}

/** Marcas vazias: o que a interface usa antes de a pessoa apontar qualquer coisa. */
export function emptyReviewMarks() {
  return Object.freeze({ version: REVIEW_MARKS_VERSION, suspects: Object.freeze([]), areas: Object.freeze([]) });
}

/**
 * Onde fica a área, em palavras: "no alto da página, à esquerda". É o que a pessoa leiga entende e
 * reconhece ao olhar a página; as coordenadas em pixels ficam só nos detalhes técnicos.
 */
export function describeReviewAreaPosition(area, size) {
  const width = Number(size?.width);
  const height = Number(size?.height);
  if (!area || !(width > 0) || !(height > 0)) return '';
  const cx = (area.x + area.width / 2) / width;
  const cy = (area.y + area.height / 2) / height;
  const vertical = cy < 1 / 3 ? 'no alto da página' : cy < 2 / 3 ? 'no meio da página' : 'na parte de baixo da página';
  const horizontal = cx < 1 / 3 ? 'à esquerda' : cx < 2 / 3 ? 'no centro' : 'à direita';
  return `${vertical}, ${horizontal}`;
}
