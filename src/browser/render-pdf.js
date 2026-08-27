const ACCESSIBLE_PRINT_PARAMS = Object.freeze({
  printBackground: true,
  preferCSSPageSize: true,
  generateTaggedPDF: true,
  generateDocumentOutline: true,
});

const COMPATIBLE_PRINT_PARAMS = Object.freeze({
  printBackground: true,
  preferCSSPageSize: true,
});
const FALLBACK_LIMITATION = 'O navegador não aceitou os parâmetros experimentais de PDF marcado e outline; o PDF foi gerado sem essa estrutura adicional.';

export async function renderPdf(cdp, options = {}) {
  if (!cdp || typeof cdp.command !== 'function') throw new TypeError('Cliente CDP inválido para impressão.');
  const forceCompatible = options?.forceCompatible === true;
  let response;
  let usedFallback = forceCompatible;
  if (forceCompatible) {
    response = await cdp.command('Page.printToPDF', { ...COMPATIBLE_PRINT_PARAMS });
  } else {
    try {
      response = await cdp.command('Page.printToPDF', { ...ACCESSIBLE_PRINT_PARAMS });
    } catch (error) {
      if (!isUnsupportedAccessibilityParameter(error)) throw error;
      usedFallback = true;
      response = await cdp.command('Page.printToPDF', { ...COMPATIBLE_PRINT_PARAMS });
    }
  }
  return {
    bytes: decodePdf(response?.data),
    usedFallback,
    limitations: usedFallback ? [FALLBACK_LIMITATION] : [],
  };
}

function isUnsupportedAccessibilityParameter(error) {
  const message = String(error?.message ?? error);
  return /(?:invalid|unknown|unexpected|unsupported)[^\n]*(?:parameter|generateTaggedPDF|generateDocumentOutline)|(?:generateTaggedPDF|generateDocumentOutline)[^\n]*(?:invalid|unknown|unexpected|unsupported)/iu.test(message);
}

function decodePdf(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new TypeError('Resposta PDF não contém base64 válido.');
  }
  let binary;
  try {
    binary = typeof globalThis.atob === 'function'
      ? globalThis.atob(value)
      : Buffer.from(value, 'base64').toString('binary');
  } catch {
    throw new TypeError('Resposta PDF não contém base64 válido.');
  }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (bytes.length < 5 || new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') {
    throw new TypeError('Resposta não possui assinatura PDF válida.');
  }
  return bytes;
}
