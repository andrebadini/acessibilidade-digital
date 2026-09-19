# Publicação na Chrome Web Store — passo a passo do envio (1.1.49)

Este documento é o roteiro de envio. **O envio em si depende do usuário**: o console exige a conta de
desenvolvedor autenticada (com verificação em duas etapas), e nada aqui é feito automaticamente.

## Pré-requisitos (só o dono da conta pode providenciar)

1. **Conta de desenvolvedor** registrada em <https://chrome.google.com/webstore/devconsole> (taxa única de
   registro) com a verificação de identidade concluída.
2. **Política de privacidade em endereço HTTPS público.** O console recusa a publicação de extensões que tratam
   dados do site sem esse endereço. **Já está publicado:**
   <https://andrebadini.github.io/audita-acessibilidade-privacidade/> (repositório público
   `andrebadini/audita-acessibilidade-privacidade`, GitHub Pages). Basta colar essa URL no campo do formulário.
3. **Capturas de tela** já prontas em `store-assets/` (as três em 1280×800, formato aceito pela loja):
   `screenshot-panel.png`, `screenshot-evidence-failed.png`, `screenshot-evidence-review.png`.

## Arquivo a enviar

`release/audita-acessibilidade-1.1.48.zip` — 199 arquivos, digest
`7da8b3f02288c58776fbb3b8ecf6681aa5041662fd6cd7fd8bdd4e9d7b281689`, versão `1.1.48` no manifesto. O console
aceita o ZIP diretamente; **não** envie a pasta, nem um ZIP que contenha a pasta do repositório.

## Campos do formulário (copiar de `store-assets/STORE-LISTING.md`)

| Campo do console | Onde está o texto |
| --- | --- |
| Nome | seção **Nome** |
| Resumo (até 132 caracteres) | seção **Resumo** |
| Descrição detalhada | seção **Descrição detalhada** |
| Categoria | seção **Categoria** (Acessibilidade) |
| Idioma | seção **Idioma principal** (Português do Brasil) |
| Finalidade única | seção **Finalidade única** |
| Justificativa de cada permissão | seção **Justificativas das permissões** (uma por permissão) |
| Uso de código remoto | seção **Código remoto** (resposta: **não**) |
| Declaração de dados / categorias | seção **Declaração de dados** (Histórico da Web e Conteúdo do site; uso local, sem venda, sem publicidade) |
| Visibilidade e regiões | seção **Público e regiões** (pública; Brasil na primeira publicação) |
| Política de privacidade (URL) | preencher com o endereço HTTPS do item 2 acima |
| Instruções de teste para o revisor da loja | `store-assets/TEST-INSTRUCTIONS.md` |

## Depois do envio

1. O console faz uma análise automática do pacote; se ela apontar algo, o item volta como rascunho.
2. Marque a distribuição como pública quando o item for aprovado (a primeira análise costuma levar alguns dias).
3. Guarde o número da versão publicada: o próximo envio precisa de uma versão **maior** que a publicada.
4. Nenhum dado do produto muda com o envio; a extensão continua local e sem login.

## O que este roteiro **não** faz

Não automatiza o console. Entrar na conta Google do usuário, responder a verificação em duas etapas ou clicar em
"enviar para revisão" são ações do dono da conta — e é o que mantém a publicação sob controle de quem responde
por ela.
