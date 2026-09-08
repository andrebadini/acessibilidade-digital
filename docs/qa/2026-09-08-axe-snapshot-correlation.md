# Correlação de sinais axe com elementos e evidências

Base: `17337e4`. Incremento posterior ao ZIP 1.1.10; não altera o pacote distribuído.

## Implementação

- Sinais suplementares top-frame com seletor estrutural único recebem o nodeId do snapshot, incluindo caminhos anônimos abaixo de componentes personalizados e sufixos profundos.
- Localização não é conclusão normativa: resultados genéricos permanecem cantTell, sem applicabilityEvidence, testedWcagRefs ou legalAnalysis inventados. Regras conclusivas existentes conservam seus gates.
- O coletor existente passa a ligar trecho, anúncio estimado e miniatura autorizada ao mesmo elemento. O modo no-pixels conserva trecho/anúncio sem produzir raster.
- Match sem posição é semântico, não comparação de strings. A árvore deve provar reciprocidade pai/filhos e unicidade. Candidato top-document com ancestralidade incompleta invalida a correlação; não é descartado para fabricar unicidade. Frames e shadow scopes explicitamente distintos não participam da busca top-document.

## Evidência

- RED original: imagem abaixo de componente personalizado perdia nodeId.
- REDs de revisão: seletor img com três imagens; irmão ausente da lista children; combinação de ramo incompleto com outro candidato válido retornava i3 indevidamente.
- Correção substitui exclusão silenciosa de candidatos inválidos por recusa da correlação. Novo RED/GREEN preserva imagem top-frame quando há imagens em escopos frame/shadow diferentes.
- Foco aprovado: 203/203 em normalizer, validator, run-audit e audit-model; log `/tmp/audita-axe-correlation-approved.log`.
- Revisão independente do núcleo: C=0/I=0; 48/48 normalizer/validator, integração no-pixels e repro independente. Diff-check aprovado.

## RED nativo seguinte — destaque após exportação

O E2E ampliado `test/e2e/public-axe-map-mv3.test.mjs` usa Chrome for Testing 152 isolado, URL local com CSP estrita, confirmação de pixels, relatório e quatro downloads reais. O modelo exportado confirma nodeId da imagem suplementar, evidência PNG referenciada e anúncio estimado. Não promove o sinal a falha ABNT.

Ao selecionar esse achado no painel **depois de exportar**, o destaque é recusado. Diagnóstico somente de metadados: existe binding para a ocorrência; a assinatura do modelo é igual, mas a revisão do binding diverge da revisão carregada pela autoridade. `assertBindingMatchesModel` recusa a relação. Não é falta de seletor nem falha de captura. O relatório por URL é view-only por contrato; o teste usa o painel para a ação ao vivo.

Estado: E2E vermelho, não candidato de release. Log reproduzível `/tmp/audita-native-correlation-diagnostic3.log`: `binding-invalid`, revisão diferente, hash igual, alvo presente. Próxima correção deve distinguir avanço de metadados de exportação de mudança no modelo, sem remover prova viva do documento, correspondência de evidência, autorização da sessão ou proteção contra modelo alterado. Os dois arquivos de fixture/E2E ficam fora do checkpoint do núcleo até essa correção passar.

Não executada suíte ampla, não gerado ZIP, não alterado Chrome pessoal. A meta integral permanece aberta.
