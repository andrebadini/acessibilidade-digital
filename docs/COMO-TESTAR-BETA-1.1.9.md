# Audita Acessibilidade — beta 1.1.9

## Atualizar sem perder auditorias

Exporte os relatórios que deseja guardar. Descompacte `audita-acessibilidade-1.1.9.zip` e substitua os arquivos na mesma pasta usada pela extensão anterior. Não remova a extensão do Chrome: isso pode apagar seus dados locais.

Abra `chrome://extensions`, clique em **Recarregar** no cartão Audita Acessibilidade e confira a versão **1.1.9**. Recarregue também a página a avaliar. Não precisa fazer login, instalar bibliotecas nem obter o código do axe-core; o motor já está incluído no pacote.

## Percurso principal

1. Abra uma página HTTP/HTTPS e o painel lateral da Audita Acessibilidade.
2. Escolha o modo e clique em **Auditar a página atual**. A auditoria usa uma cópia temporária; não reproduz necessariamente dados não salvos da página original.
3. Se houver pausa de privacidade no modo com imagens, leia o aviso e confirme ou cancele.
4. No resultado, clique num cartão de resumo para filtrar. Expanda o item ABNT e a ocorrência.
5. Clique em **Destacar elemento na página**. Não é necessário ativar antes “Mostrar sinais”. O destaque é uma ação solicitada por você, posterior à análise. Falhas têm sinal vermelho; recomendações/alertas, âmbar. Se não houver correspondência segura, a ferramenta informa a limitação em vez de apontar outro elemento.
6. Abra o relatório completo para consultar orientação, ABNT/WCAG, anúncio estimado e evidências. Exporte HTML, PDF, CSV e JSON.
7. Use **Refazer auditoria** para uma nova avaliação. Relatórios antigos não são reescritos.

## O que mudou na leitura

| Parte | Significado |
| --- | --- |
| Falhas confirmadas | Requisito não atendido no teste realizado ou barreira confirmada por revisão humana. Não é certificação jurídica. |
| Recomendações e alertas | Recomendações ABNT não atendidas e alertas complementares. Não são misturados a falhas de requisitos obrigatórios. |
| Suspeitas a confirmar | Há indício concreto correlacionado a um elemento, mas é necessário confirmar a barreira. |
| Checklist separado | Perguntas gerais, testes sem conclusão ou com aplicabilidade ainda pendente. Não entram na contagem nem no gráfico de achados. |
| Resultados positivos | Verificações atendidas somente no escopo observado. |

O checklist e seus guias continuam no painel e no HTML. O PDF apresenta sua quantidade e a referência ao HTML/JSON, sem imprimir uma ficha para cada pergunta geral. Os registros originais, decisões e evidências são preservados, não convertidos em aprovação ou “não aplicável”. Os formulários de revisão humana continuam disponíveis no relatório.

No contraste ampliado, o critério testado é **WCAG 1.4.6, nível AAA**. Sua reprovação não prova falha no contraste mínimo **1.4.3, AA**, que possui teste independente. O mapeamento contextual completo do item ABNT permanece na matriz e nos dados técnicos. Relatórios antigos mantêm os dados e hashes originais; a apresentação corrige a abrangência do teste ampliado.

## Nota e cobertura: duas medidas diferentes

O **índice técnico automático** é `10 × verificações aprovadas / verificações com conclusão passou ou falhou`, contando uma vez cada teste do motor próprio em cada página. Não inclui perguntas inconclusivas, revisões humanas, resultados suplementares ou itens não aplicáveis. Inclui requisitos e recomendações dos níveis testados, inclusive AAA; não equivale a uma nota de conformidade AA. Sem conclusão automática aplicável, não há nota.

A **cobertura automática** informa a fração de testes do inventário próprio que chegou a uma conclusão automática — passou, falhou ou não se aplica — nas páginas tentadas. Não mede a porcentagem acessível do site e não afirma que o restante da página tenha sido examinado manualmente.

O gráfico usa verificações agrupadas, não o número de elementos. Seus totais podem diferir dos registros individuais e do denominador da nota. Mesmo nota 10 não dispensa revisar as suspeitas, o checklist e as limitações da coleta.
