# Protocolo de teste com pessoa leiga — critério 8

**Para que serve.** O critério 8 ("interface e relatório são completos, claros e utilizáveis por
leigos") não se fecha por leitura de código nem por teste automatizado: precisa de alguém de fora,
não técnico em acessibilidade, tentando usar o produto. Este documento é o roteiro dessa sessão —
cerca de 20 minutos — e o registro do que conta como falha. **Enquanto ninguém executar isto, o
critério 8 continua Parcial**, e é assim que ele está registrado.

**Quem convidar.** Uma pessoa sem envolvimento com o projeto, idealmente sem formação em
acessibilidade ou desenvolvimento. Se possível, duas sessões: uma com usuário comum e uma com
usuário de leitor de tela ou de teclado. Não explique o produto antes: o objetivo é ver o que a
interface ensina sozinha.

**Preparo (5 min).** Descompacte `release/audita-acessibilidade-1.1.22.zip` (ou a versão corrente)
em uma pasta própria, carregue em `chrome://extensions` com o modo de desenvolvedor, fixe o ícone e
abra uma página pública simples — a página inicial do Google serve. Não abra o painel antes de
começar, e não diga onde ficam as coisas.

## Tarefas, na ordem, com a frase exata a ser dita

1. "Abra o Audita e avalie esta página. Me diga em voz alta o que está acontecendo enquanto
   espera."
2. "Sem clicar em nada, me diga: quantos problemas confirmados a página tem? E quantas coisas
   ainda precisam de conferência humana?"
3. "Abra um dos problemas e me conte: quem é afetado, o que foi observado e como corrigir."
4. "Mostre esse problema na própria página."
5. "Encontre o anúncio estimado desse elemento e me diga para que ele serve."
6. "Exporte o relatório. Nele, encontre a lista de limitações da auditoria e a explicação de
   alguma nota de integridade normativa."

## O que registrar (por tarefa)

- concluiu sozinho / concluiu com hesitação / não concluiu;
- tempo aproximado;
- **frases literais** do que a pessoa disse ao procurar;
- onde clicou primeiro, e o que esperava encontrar ali.

## Sinais de falha que importam (cada um vira achado, com a frase que o sustenta)

| Sinal | Por que é falha |
|---|---|
| Chama uma **suspeita** de "violação confirmada" ou "infração" | Quebra a separação que a meta exige entre detectado, suspeito e não avaliado |
| Acha que o índice (ex.: 9,0/10) é **nota de acessibilidade** ou certificação | A meta proíbe chamar nota automática de porcentagem de acessibilidade |
| Não encontra o **checklist separado** do que já foi concluído | Mistura categorias na cabeça de quem lê |
| Não acha **como corrigir** ou **como verificar manualmente** | Os blocos didáticos são diferencial declarado do produto |
| Não consegue **destacar o elemento** na página | É o percurso obrigatório |
| Confunde o **PDF de leitura** com o relatório completo | O PDF é resumo; o HTML/JSON é o dossiê |
| Não percebe que o **anúncio é estimativa** | O produto promete dizer isso com honestidade |
| Acha que a auditoria vale para o **site inteiro** | O escopo é a página e o estado observado |

## Como fechar

1. Preencha a tabela acima com o que foi observado; falha em sinal da tabela vira achado
   **Important** e entra no registro de achados com a frase da pessoa como evidência.
2. Ajustes de texto que não mudem contrato testado entram como incremento de apresentação.
3. Só então o critério 8 pode sair de **Parcial**, e o registro deve citar: quem participou (sem
   nome próprio, se preferir), data, versão exata do pacote, tarefas concluídas e frases literais.
4. Se ninguém puder executar a sessão, o critério continua **Parcial** — o produto pode ser usado,
   mas essa é uma lacuna declarada, não um item fechado por suposição.
