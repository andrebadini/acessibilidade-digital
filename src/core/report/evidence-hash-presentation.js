// Os dois códigos que a ficha de evidência mostra, iguais na tela e no arquivo entregue: o hash do
// REGISTRO (o que o modelo canônico e o manifesto de integridade afirmam) e o hash do ARQUIVO PNG (o que
// qualquer pessoa recalcula depois de baixar a imagem). Um hash cortado não serve para conferência, então
// os dois são apresentados inteiros. O texto é derivado do artefato — nunca inventado: quando a captura
// não guardou o código do arquivo, a ficha diz isso em vez de mostrar o do registro no lugar dele.

export const EVIDENCE_RECORD_HASH_LABEL = 'Impressão digital (SHA-256) do registro';
export const EVIDENCE_FILE_HASH_LABEL = 'SHA-256 do arquivo de imagem (PNG)';
export const EVIDENCE_SHA256_HELP =
  'O SHA-256 é a impressão digital do arquivo: qualquer alteração na imagem muda esse código. Para conferir, ' +
  'baixe a imagem e calcule o SHA-256 dela com uma ferramenta comum; o resultado tem de ser igual ao que está escrito aqui.';

const EVIDENCE_HASH_UNAVAILABLE = 'não disponível';
const DERIVED_EVIDENCE_KINDS = Object.freeze(['announcement-map', 'keyboard-map']);
const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/u;

/** Hash do arquivo PNG guardado, com a ressalva própria de cada tipo de artefato. */
export function evidenceFileHashPresentation(evidence) {
  const hasPixels = typeof evidence?.dataUrl === 'string' && PNG_DATA_URL.test(evidence.dataUrl);
  if (evidence?.kind === 'full-page' && hasPixels) {
    return { value: evidence.hash ?? EVIDENCE_HASH_UNAVAILABLE,
      note: 'a captura integral é o próprio arquivo: o registro e o arquivo têm o mesmo código.' };
  }
  if (typeof evidence?.binarySha256 === 'string') {
    return { value: evidence.binarySha256,
      note: 'é o código do arquivo PNG guardado; baixe a imagem e recalcule o SHA-256 dela para conferir.' };
  }
  if (DERIVED_EVIDENCE_KINDS.includes(evidence?.kind)) {
    return { value: 'não se aplica',
      note: 'artefato derivado: cada segmento tem o próprio hash, apresentado na seção de mapas.' };
  }
  if (!hasPixels) {
    return { value: 'não registrado',
      note: 'os pixels desta evidência não estão nesta auditoria (limite de tamanho ou omissão registrada).' };
  }
  return { value: 'não registrado',
    note: 'captura registrada por versão anterior da extensão; baixe a imagem e calcule o SHA-256 dela para conferir o arquivo.' };
}

/** `[rótulo, valor, observação]` — a mesma ordem na tela do painel e no HTML entregue. */
export function evidenceHashRows(evidence) {
  const file = evidenceFileHashPresentation(evidence);
  return [
    [EVIDENCE_RECORD_HASH_LABEL, evidence?.hash ?? EVIDENCE_HASH_UNAVAILABLE,
      'identifica o registro da evidência no modelo e no manifesto de integridade da auditoria.'],
    [EVIDENCE_FILE_HASH_LABEL, file.value, file.note],
  ];
}
