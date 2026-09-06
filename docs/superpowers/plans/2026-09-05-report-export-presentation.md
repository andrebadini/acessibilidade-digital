# Relatório baixado e impressão — recorte de apresentação

Complementa a etapa 3 de public-friendly-results; não reabre modelo, evidências ou permissões. Decisão autônoma conforme pedido A–H.

## Contrato

- HTML baixado usa quatro cartões filtrantes e expansores nativos. Script fixo, local, sem rede, DOM por textContent, CSP por hash exato. Nenhum texto auditado é código.
- Identidade `(check,item)` é somente apresentação. Filtros contam checks únicos e não alteram os totais nem o modelo.
- Links internos abrem ancestrais recolhidos; impressão pelo navegador revela todos os registros e restaura a navegação depois.
- PDF automático não depende de script inline: versão de impressão do mesmo ReportView/identidade, com details abertos e sem script. A CSP de extensão MV3 não será relaxada.
- Uma captura é impressa uma vez por evidenceId e marcação necessária; tons distintos (falha/revisão) não são confundidos. Reutilizações e anexo apontam para essa captura, preservando marcações, provenance e registros textuais. Mapas anotados e legendas permanecem completos.
- Matriz completa e anexo recolhidos na tela, completos na impressão. Referência curta também no renderer legado.

## Passos e testes focados

1. RED/GREEN de runtime HTML: filtros, contagem única, link e restauração de impressão (`test/report/report-view-interactions.test.js`).
2. Integração em html.js após congelar o recorte de agrupamento. Testar CSP exata, dados escapados, evidenceId deduplicado, marcação mantida, versão print sem script e com conteúdo aberto.
3. report-export usa a projeção print da mesma revisão; testes export focados verificam os quatro formatos sem tocar protocolo/cleanup.
4. Revisão independente do diff congelado. Chrome/PDF visual somente no candidato integrado.

## Referência técnica consultada

[Chrome: CSP de extensões](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy) — política mínima MV3 impede usar relaxamento de script inline como solução para impressão. O HTML baixado não executa no contexto privilegiado da extensão; a variante print permanece sem script.
