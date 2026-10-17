/**
 * Registro único das imagens de recorte, por documento.
 *
 * Desde a 1.1.62 um mesmo PNG serve a muitos desenhos: a captura integral é recortada na prévia da
 * ocorrência, no cartão da verificação guiada e na ficha de evidência. Cada imagem entra **uma vez** no
 * documento, com um `id`, e cada desenho a referencia por `<use>`; sem isso o mesmo base64 seria copiado
 * no atributo de cada recorte — numa auditoria com centenas de elementos, megabytes repetidos na memória
 * da aba e no arquivo entregue.
 *
 * O registro é **por documento**, e não por superfície: a página do relatório desenha, no mesmo
 * documento, os recortes da revisão guiada e as fichas do anexo. Dois registros no mesmo documento fariam
 * o mesmo PNG entrar duas vezes — foi o que o teste da leitura por Tab flagrou. Quem desenha primeiro cria
 * o registro e o pendura no documento; quem desenha depois usa o mesmo nó, onde ele estiver.
 */
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const REGISTRIES = new WeakMap();

export function cropImageRegistry(document) {
  const known = REGISTRIES.get(document);
  if (known) return known;
  const node = document.createElementNS(SVG_NAMESPACE, 'svg');
  node.setAttribute('class', 'evidence-definitions');
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('width', '0');
  node.setAttribute('height', '0');
  node.setAttribute('focusable', 'false');
  const defs = document.createElementNS(SVG_NAMESPACE, 'defs');
  node.append(defs);
  const byKey = new Map();
  let count = 0;
  const registry = {
    node,
    count: () => count,
    /** Referência da imagem guardada: o `id` de um `<image>` que já está no documento, ou de um novo. */
    reference(dataUrl, size) {
      const key = `${size.width}x${size.height}\u0000${dataUrl}`;
      const holder = byKey.get(key);
      if (holder) return holder;
      const image = document.createElementNS(SVG_NAMESPACE, 'image');
      const id = `crop-image-${count += 1}`;
      image.setAttribute('id', id);
      image.setAttribute('href', dataUrl);
      image.setAttribute('width', String(size.width));
      image.setAttribute('height', String(size.height));
      image.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      defs.append(image);
      byKey.set(key, id);
      return id;
    },
    /**
     * Pendura o registro em `parent` — o corpo da página quando quem desenha primeiro é a verificação
     * guiada, a raiz do relatório quando é o relatório. Um registro já pendurado em outro lugar do mesmo
     * documento continua servindo a todos os `<use>`, e por isso só é movido quando o `parent` pedido é o
     * dono atual do relatório: assim uma re-renderização não deixa o registro preso numa raiz descartada.
     */
    attach(parent) {
      if (parent && node.parentNode !== parent) parent.append(node);
      return node;
    },
  };
  REGISTRIES.set(document, registry);
  return registry;
}
