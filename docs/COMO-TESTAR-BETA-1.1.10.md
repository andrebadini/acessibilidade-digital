# Audita Acessibilidade — beta 1.1.10

## Atualização

Exporte os relatórios que deseja guardar. Descompacte o ZIP e substitua os arquivos **na mesma pasta** usada pela extensão anterior. Em `chrome://extensions`, clique em **Recarregar** e confira a versão 1.1.10. Não remova a extensão: isso pode apagar suas auditorias locais. Não é necessário login, instalar bibliotecas ou obter o código-fonte do axe-core.

## Teste de nova auditoria

1. Abra uma página HTTP/HTTPS e o painel lateral da extensão.
2. Escolha o modo e clique em **Auditar a página atual**. Para imagens, confirme a captura se aparecer o aviso de privacidade.
3. Aguarde o sumário e abra o relatório.
4. Volte à aba de origem e navegue, pela barra de endereço, para outra página.
5. No painel, use **Refazer auditoria**, se o resultado anterior ainda estiver visível, e depois **Auditar a página atual**.
6. Confira que o novo relatório corresponde à nova página. A avaliação anterior não deve ser apagada.

A auditoria usa uma cópia temporária inativa da URL, sem percorrer visualmente a aba de origem. Dados não salvos e estado existente somente em memória não são necessariamente reproduzidos nessa cópia. O destaque posterior é uma ação explícita da pessoa usuária, não parte da varredura silenciosa.

## Leitura dos resultados

- **Falhas confirmadas:** requisito não atendido no teste ou conclusão humana de não conformidade; não é aplicação automática de sanção.
- **Recomendações e alertas:** melhorias normativas recomendadas ou alertas complementares, separados das falhas de requisitos.
- **Revisão humana:** indícios e sinais inconclusivos dos motores. Alguns podem estar sem elemento correlacionado; é preciso localizar e reproduzir a situação antes de concluir. Um sinal não equivale a uma barreira comprovada.
- **Checklist separado:** perguntas gerais cuja avaliação ou aplicabilidade continua pendente. Não entra no gráfico de achados.
- **Resultados positivos:** verificações atendidas no escopo observado, não certificação do site.

Os registros são agrupados por página, motor e regra. Vários registros podem integrar uma verificação; não presumir que cada registro corresponda a um elemento diferente.

## Explicações acrescentadas

Os roteiros preservam as orientações, correções e observações já existentes e explicam a diferença entre requisito e recomendação. Para contraste aprimorado, comparam ABNT 5.11.2 e 5.11.3, os limites para texto comum/grande e as exceções. O exemplo de 6,39:1 é explicitamente hipotético quando incluído no roteiro: não representa uma medição de todas as páginas.

Pela seção 4 da NBR, a conformidade regular exige os requisitos. A plena abrange também as recomendações, exigindo justificativa razoável para recomendações não atendidas. A referência técnica não decide infração ou multa.

## Conferir elemento e exportar

Expanda o item ABNT e a ocorrência. Use **Destacar elemento na página** para solicitar a moldura no elemento correspondente. Sem correspondência segura, consulte a evidência registrada; a ferramenta não deve destacar outro elemento por aproximação. A indisponibilidade de alvo ou evidência deve permanecer explícita.

Abra o relatório completo e exporte HTML, PDF, CSV ou JSON. As imagens somente estarão disponíveis quando permitidas pelo modo e pelas condições da coleta. O PDF resume o checklist; o HTML conserva os guias expansíveis e o JSON, os registros técnicos.

O índice técnico considera resultados aplicáveis concluídos do motor próprio, incluindo requisitos e recomendações; não inclui axe-core inconclusivo nem representa nota de conformidade AA. O gráfico usa verificações agrupadas, incluindo sinais suplementares. Cobertura automática é a proporção concluída do inventário próprio, não a porcentagem acessível da página. Notas não são diretamente comparáveis às do AMAWeb.
