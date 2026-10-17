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

/**
 * O artefato de onde saem os pixels desta evidência, quando ela não tem arquivo próprio.
 *
 * Desde a 1.1.62 o elemento pode não ter miniatura: o que existe é a POSIÇÃO dele na captura integral
 * (`fullPageRect` + `fullPageEvidenceId`), e a imagem que a ficha mostra é um recorte daquela captura. O
 * código do arquivo, então, é o da captura integral — e é isso que a ficha afirma, em vez de dizer que
 * não há arquivo.
 */
export function cropSourceEvidence(evidence, allEvidence) {
  if (evidence?.fullPageRect === undefined || typeof evidence?.fullPageEvidenceId !== 'string') return null;
  if (!Array.isArray(allEvidence)) return null;
  return allEvidence.find(artifact => artifact?.evidenceId === evidence.fullPageEvidenceId &&
    artifact?.kind === 'full-page' && typeof artifact?.dataUrl === 'string') ?? null;
}

/** Hash do arquivo PNG guardado, com a ressalva própria de cada tipo de artefato. */
export function evidenceFileHashPresentation(evidence, sourceEvidence = null) {
  const hasPixels = typeof evidence?.dataUrl === 'string' && PNG_DATA_URL.test(evidence.dataUrl);
  if (evidence?.kind === 'full-page' && hasPixels) {
    return { value: evidence.hash ?? EVIDENCE_HASH_UNAVAILABLE,
      note: 'a captura integral é o próprio arquivo: o registro e o arquivo têm o mesmo código.' };
  }
  if (typeof evidence?.binarySha256 === 'string') {
    return { value: evidence.binarySha256,
      note: 'é o código do arquivo PNG guardado; baixe a imagem e recalcule o SHA-256 dela para conferir.' };
  }
  // Recorte da captura integral: o arquivo que a pessoa pode baixar e recalcular é o da captura, e é o
  // código dele que a ficha tem de mostrar — dizer "não registrado" ao lado de uma imagem visível seria
  // esconder justamente o código que confere o arquivo mostrado.
  if (evidence?.fullPageRect !== undefined) {
    const sourceId = typeof evidence.fullPageEvidenceId === 'string' ? evidence.fullPageEvidenceId : null;
    if (sourceEvidence && typeof sourceEvidence.hash === 'string') {
      return { value: sourceEvidence.hash,
        note: `recorte da captura integral ${sourceId}: este é o código do arquivo PNG dessa captura.` };
    }
    return { value: 'não disponível',
      note: `o recorte vem da captura integral ${sourceId ?? 'não registrada'}, que não está com o arquivo nesta auditoria (limite de tamanho ou omissão registrada).` };
  }
  if (DERIVED_EVIDENCE_KINDS.includes(evidence?.kind)) {
    // Artefato derivado (mapa): as imagens estão nas figuras do próprio mapa, cada uma com o seu código.
    // Antes esta linha dizia "não se aplica", ao lado de "PNG local não disponível" — duas negativas
    // seguidas que não diziam à pessoa onde ver a imagem que o mapa usa.
    return { value: 'no mapa',
      note: 'as imagens deste mapa estão na seção do mapa, com o SHA-256 de cada trecho.' };
  }
  if (!hasPixels) {
    return { value: 'não registrado',
      note: 'os pixels desta evidência não estão nesta auditoria (limite de tamanho ou omissão registrada).' };
  }
  return { value: 'não registrado',
    note: 'captura registrada por versão anterior da extensão; baixe a imagem e calcule o SHA-256 dela para conferir o arquivo.' };
}

/**
 * `[rótulo, valor, observação]` — a mesma ordem na tela do painel e no HTML entregue.
 *
 * `allEvidence` é a lista de evidências da auditoria, quando quem chama a tem: sem ela, o recorte da
 * captura integral não acha o arquivo de origem e a linha do arquivo fica sem o código.
 */
export function evidenceHashRows(evidence, allEvidence = null) {
  const file = evidenceFileHashPresentation(evidence, cropSourceEvidence(evidence, allEvidence));
  return [
    [EVIDENCE_RECORD_HASH_LABEL, evidence?.hash ?? EVIDENCE_HASH_UNAVAILABLE,
      'identifica o registro da evidência no modelo e no manifesto de integridade da auditoria.'],
    [EVIDENCE_FILE_HASH_LABEL, file.value, file.note],
  ];
}
