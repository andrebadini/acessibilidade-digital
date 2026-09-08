# Recomendação não é denominada requisito

Incremento sobre `aba4870`, posterior à beta 1.1.11. O catálogo e as classificações estavam corretos, mas a geração de resumo e pergunta de revisão usava sempre “Requisito”. Agora registros novos usam “Recomendação” quando essa é a classificação do item, inclusive nos resultados não aplicáveis. A redação dos requisitos permanece igual.

## Compatibilidade e escopo

Os três pontos de validação de texto aceitam somente a redação atual ou a redação histórica exata, vinculada ao mesmo item e resultado. Não se trata de aceitar texto livre. Modelos V2 salvos não são reescritos; seus hashes e evidências permanecem iguais. Alterar um texto histórico para outra redação aceita não dispensa verificar novamente a integridade original: o teste de adulteração continua rejeitando essa mudança.

Sem alteração de resultado, mapeamento WCAG/ABNT, fundamentação, permissões, captura ou armazenamento. As explicações didáticas já existentes são preservadas.

## Verificação

- RED inicial: 2 falhas / 2 passes, com requisito indevidamente usado em resumo e ocorrência recomendados; `/tmp/audita-normative-wording-red.log`.
- A primeira rodada após implementação revelou falta da entrada de revisão no insumo do novo teste. A fixture foi completada; a falha de fixture não é atribuída ao produto.
- GREEN: 201/201 testes em normative-wording, audit-model-v2, html, csv, report-view, panel-detail e batch-aggregation; `/tmp/audita-normative-wording-focus.log`.
- Cinco casos específicos abrangem classificação por resultado, relatório/pergunta, preservação do modelo antigo na exportação, negação de texto arbitrário ou incompatível com resultado e integridade após alteração textual.
- O JSON real do Google da beta 1.1.11 foi lido, teve a cadeia de integridade verificada e foi reexportado em memória: o modelo serializado canonicamente permaneceu idêntico. Nenhum arquivo de entrega foi alterado.
- Duas revisões independentes, somente leitura, no mesmo diff congelado: C=0/I=0/M=0 em ambas; cada revisor executou os cinco testes específicos. `git diff --check` aprovado.

Ainda fora do pacote 1.1.11. Sem suíte ampla, Chrome ou novo ZIP neste incremento; essas verificações pertencem ao candidato integrado de entrega.
