# Atualização do relatório após revisão humana

Base: `3563c82` (beta 1.1.2). Incremento limitado à atualização do relatório aberto e à integridade da gravação da decisão. As evidências, regras, capturas, permissões e interpretação normativa não mudam.

## Falha reproduzida e correção

O relatório aberto mantinha a apresentação anterior depois de salvar uma decisão. Os REDs de interface reproduziram quatro falhas em cinco testes. A atualização agora usa o modelo verificado e a revisão/hash retornados pelo salvamento; preserva os próprios nós dos formulários, nome da pessoa avaliadora, notas ainda não salvas, expansor e foco no próximo formulário. Filtros de visualização voltam a todos os resultados, com aviso explícito. Respostas antigas e exclusão da auditoria não podem ressuscitar a apresentação.

O teste real revelou uma falha adicional importante na beta 1.1.2: a decisão era persistida, mas o hash canônico ficava `pending`. A leitura pública seguinte recusava o relatório. Um RED em memória e IndexedDB simulado reproduziu a falha (zero de três resultados aprovados, incluindo o teste pai). A transição autorizada agora calcula e verifica o novo hash **antes** da gravação atômica existente. O modelo-base precisa passar pela verificação completa; a comparação exata continua permitindo apenas a nova decisão. Evidências, manifesto, reprodutibilidade e checkpoint permanecem idênticos.

## Verificação

- Interface e armazenamento relacionados: 319/319 passaram; zero falhas, cancelamentos ou skips.
- Revisão independente da interface/transição: C=0/I=0/M=1; 252 testes executados pelo revisor. Minor: acrescentar no futuro uma asserção nativa direta sobre a contagem/célula alterada, além da nova identidade, modelo e matriz preservada.
- Segunda revisão independente, armazenamento/integridade: C=0/I=0/M=0; 20 testes focados executados pelo revisor.
- Chrome for Testing 152.0.7977.64, cenário `original-page ABNT markers visual review and verified exports`: 1/1 passou em 11,89 segundos. Verificou auditoria silenciosa, sinais bidirecionais, teclado, limpeza após navegação, abertura do relatório, salvamento real, atualização sem recarga, preservação dos formulários e identidade visual igual à persistida.
- Exportações reais **antes e depois** da decisão: quatro arquivos em cada revisão. A segunda prova exige recibo com hash/revisão novos, confirma a decisão e a nota no JSON e verifica bytes, hashes e identidade dos quatro formatos. Um recibo antigo não satisfaz essa prova.
- `git diff --check`: passou. Não foram executados suíte ampla ou empacotamento durante a implementação deste incremento.

Artefatos: `/private/var/folders/3b/dv2ydqf51zq_qdv0gp1xmzzr0000gn/T/audita-marco-1-review-final-cWO7bg`. Inspecionada `qa/report-after-live-review.png`; `downloads/` contém os oito arquivos reais. Nenhuma instalação pessoal do Chrome foi alterada.

## Limitação de compatibilidade

Esta correção previne novas gravações defeituosas em auditorias íntegras. **Não repara relatórios antigos já gravados com hash pendente.** Não se deve simplesmente assinar novamente esses registros e declarar integridade retroativa sem uma base verificável. Preserve os arquivos anteriormente exportados e os dados locais; refazer a auditoria cria uma nova avaliação, não recupera decisões anteriores. Uma recuperação explícita, com proveniência demonstrável, permanece separada. Não tratar essa limitação como resolvida nem recomendar salvar decisões na beta 1.1.2.
