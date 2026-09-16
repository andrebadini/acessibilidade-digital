# Relatórios das revisões independentes

Cópias integrais dos relatórios produzidos pelos revisores independentes desta sessão. Elas estão aqui, e não em diretório temporário, porque são a evidência dos achados: a trilha de QA cita cada um, e uma citação sem o documento original não é conferível.

| Arquivo | Revisão | Veredito | Artefato revisado |
|---|---|---|---|
| `REVIEW-1.1.16.md` | diff `2d205c1..3cacadd` e o zip da 1.1.16 | 1 Critical, 2 Important, 3 Minor | `audita-acessibilidade-1.1.16.zip` (`c175a224…`) |
| `REVIEW-1.1.17.md` | diff `3cacadd..c64221d` e o zip da 1.1.17 | 0 Critical, 3 Important, 5 Minor | `audita-acessibilidade-1.1.17.zip` (`c0cc4118…`) |
| `REVIEW-1.1.18.md` | diff `c64221d..75e2717` e o zip da 1.1.18 | 0 Critical, 1 Important, 3 Minor | `audita-acessibilidade-1.1.18.zip` (`c76d49ce…`) |
| `REVIEW-1.1.19.md` | diff `75e2717..dad1cda`, o zip da 1.1.19 **e** a triagem das 9 falhas da fase serial de Chrome real | 0 Critical, 2 Important — **ambos de documentação/afirmação, nenhum de produto** —, 0 Minor | `audita-acessibilidade-1.1.19.zip` (`0e429e22…`) |

**Os textos estão em inglês porque os revisores os escreveram assim**; não foram traduzidos para não alterar a evidência. O desfecho de cada achado, em português e com a medição que o sustenta, está em `docs/qa/2026-09-16-registro-de-achados-das-revisoes.md`.

**Conferência de privacidade nestes arquivos.** Antes de publicá-los aqui, procurei conteúdo sensível: não há e-mail, caminho pessoal (`/Users/...`), token real nem qualquer linha do CSV privado de sessão. As duas únicas cadeias que *parecem* credenciais — `Senha SEGREDO-DO-USUARIO-1234` e `VALOR-SECRETO-9F3A` — são marcadores **fictícios que o próprio revisor inventou** para provar que valores sensíveis **não** aparecem no instantâneo normalizado; elas são a evidência do teste negativo, não dado real.

**A revisão da 1.1.19 concluiu e o relatório é o `REVIEW-1.1.19.md`.** Ela é a primeira que julga duas coisas ao mesmo tempo: a correção da 1.1.19 (o campo obrigatório sem estado observado deixou de ser descartado) e a triagem das nove falhas da fase serial de Chrome real, que até então ninguém havia classificado. O veredito é 0 Critical e 2 Important, e **nenhum dos dois Important está no produto**: um é a limitação declarada que não chega aos artefatos entregues (a frase é canonizada antes da entrega) e o outro é uma afirmação de cópia temporária que cinco documentos de usuário faziam e o código não cumpre mais desde `1c9b296`. O desfecho dos dois, com a medição que os sustenta, está em `docs/qa/2026-09-16-registro-de-achados-das-revisoes.md`.
