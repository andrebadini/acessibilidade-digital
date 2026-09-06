# Horário individual de captura — prova nativa

Base funcional `c479684`, posterior ao pacote 1.1.4. Este checkpoint altera somente dois testes E2E e documentação; nenhuma alteração no runtime, permissões, captura, normas ou armazenamento.

## Ambiente e preparação

Chrome for Testing **152.0.7977.64**, caminho confirmado antes da execução: `/private/tmp/audita-chrome152-fresh-jrXLDB/unpacked/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`.

Primeira preparação recusada antes do Chrome por subpastas `qa`/`downloads` ausentes. Preparadas sem alterar a validação do harness. O primeiro percurso real comprovou 12 datas, mas a instrução auxiliar de screenshot retornava `undefined` e o harness exigia resultado serializável; adicionado `return true` somente no teste. Tentativa com a pasta já usada foi recusada para não sobrescrever screenshots. A prova final foi feita em uma pasta gerenciada nova. Esses resultados não são apresentados como falhas do produto nem como passes do cenário inteiro.

## Resultados finais

- `node --test test/e2e/public-axe-map-mv3.test.mjs`: **1/1 PASS**, zero skips, cenário 8,24 s. Log `/tmp/audita-receipt-native-full-fresh.log`.
- `node --test --test-name-pattern='audits one tokenized URL in no-pixels mode' test/e2e/url-audit-mv3.test.mjs`: **1/1 PASS**, zero skips, cenário 45,17 s. Log `/tmp/audita-receipt-native-none.log`.
- `git diff --check` e `node --check` nos dois arquivos: PASS.

Nos dois comandos, `AUDITA_E2E_CHROME` foi configurado e cada teste usou perfil Chrome isolado. Não foram executados suíte ampla, `verify` ou ZIP nesta verificação focada.

O cenário completo percorreu ícone → painel → Outra URL → consentimento → resultado → relatório → quatro downloads. Foram exigidas capturas integrais e elementares reais antes das asserções, evitando um passe com lista vazia. As **12 capturas** têm datas ISO UTC dentro do período de sua própria página. A lista exata de IDs/datas no modelo persistido coincide com a do JSON; auditId e modelHash também coincidem. Cada ficha viva, localizada pelo ID da evidência, apresenta sua data e aviso de relógio local; o HTML contém os mesmos valores. O mapa derivado não recebe data de um raster que não ocorreu.

No modo sem imagens, a auditoria tem evidências técnicas e quatro exportações, mas nenhum PNG ou propriedade `captureReceivedAt`. As verificações anteriores de ausência de vazamentos permaneceram verdes.

## PDF e inspeção visual independentes

Artefatos completos: `/private/var/folders/3b/dv2ydqf51zq_qdv0gp1xmzzr0000gn/T/audita-marco-1-receipt-final-OYmAIg`.

Mesmo stem dos downloads JSON/PDF: `audita-139620d1-5e4d-4c06-9b11-d4b948b05865-20260906T101635909Z`.

- PDF: **253 páginas**, **6.189.218 bytes**.
- SHA-256: `0d334f96bbe211fbf66a314e9056a99a80700b1929b3ed9694dc336a966f5301`.
- Extração com pypdf comparada com o JSON do mesmo download: **12/12 datas exatas**, 12 distintas nesta fixture, aviso de relógio local não certificado presente. Somente espaços da extração foram normalizados.
- Página 4 contém o ID da captura integral e sua data, `2026-09-06T10:16:33.932Z`. Rasterizada com `pdftoppm` e inspecionada em `qa/pdf-receipt-page-4.png`: data e período separados, legíveis, sem recorte.
- Screenshot `qa/capture-receipt-full-page.png` inspecionada: data na ficha correta, período geral separado e imagem integral associada.

Artefatos sem imagens: `/private/var/folders/3b/dv2ydqf51zq_qdv0gp1xmzzr0000gn/T/audita-marco-1-receipt-none-yVQ7DU`.

## Revisão e encaminhamento

Revisor independente `capture_time_native_review`: matriz prévia e revisão do diff congelado, **C=0/I=0**. Confirmou asserções não vazias, data por página/artefato, identidade persistida/exportada, ausência em no-pixels/mapa e sintaxe/diff limpos; leu os logs finais. Não executou outro Chrome nem alterou arquivos.

A prova nativa dos horários está concluída. O campo ainda não integra o ZIP entregue 1.1.4 e será incluído em candidato posterior, com gate de release próprio. Datas antigas continuam sem reconstrução retrospectiva; o campo atesta somente recebimento no relógio local, não tempo certificado.

A inspeção também encontrou uma pendência de linguagem simples já abrangida pelo pedido original: na ficha ABNT 5.13.7, o texto de correção recai no fallback genérico “Revise ‘Texto visível no nome acessível’…”. A linguagem continua técnica e pouco acionável para uma pessoa leiga. Encaminhar a `plain-language-guidance.js`, preservando resultados normativos e evidências. Isso não invalida a prova temporal deste checkpoint.
