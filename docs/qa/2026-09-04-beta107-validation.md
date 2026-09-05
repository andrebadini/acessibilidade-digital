# Validação da beta 1.0.7 — 04/09/2026

## Estado do candidato

**APROVADO PARA TESTE MANUAL DA BETA.** Os recursos adiados não estão concluídos e a meta permanece ativa.

- Manifesto: `1.0.7`; nome: `1.0.7 beta 6`.
- Base Git: `ef1ef12`; alterações desta rodada identificadas pelo commit que contém este registro e pelo hash do pacote abaixo.
- Não há achado Critical ou Important conhecido pendente no escopo entregue. Correções relevantes passaram por revisão independente; melhorias não bloqueantes constam em `docs/BETA-BACKLOG.md`.
- Este registro consolida execuções efetivamente observadas, inclusive falhas e limitações. Não declara que todos os testes dos recursos futuros passaram.

## Ambiente de Chrome for Testing

A instalação anterior em `/private/tmp/audita-chrome152.PxxnKd` estava incompleta: faltavam arquivos `Info.plist`, o executável de GPU e recursos do aplicativo. As tentativas encerravam a conexão com `CDP_CLOSED` e não foram usadas como aprovação funcional.

Uma cópia íntegra da mesma versão oficial, **152.0.7977.64**, foi obtida em `https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip` e extraída em `/private/tmp/audita-chrome152-fresh-jrXLDB`. A sondagem de página vazia e os E2E abaixo passaram nessa instalação, em perfis temporários isolados.

Não foi usado `--no-sandbox`, nenhum perfil pessoal foi modificado e o usuário final não precisa instalar Chrome for Testing ou Node.js.

## Correções verificadas

| Falha reproduzida | Correção e evidência |
| --- | --- |
| Recuperação de lote e limpeza de suspensão revogada | Correções de ciclo de vida revisadas com C=0/I=0; confirmação individual e limpeza testadas em Chrome real. |
| A primeira ficha ocupava todo o orçamento de 64 ocorrências | Reserva inicial por ficha antes de distribuir o restante; modelo e relatório completos preservados. RED confirmado, 35 testes focados aprovados. |
| Captura integral repetida milhares de vezes nos formulários de revisão | Referência interna ao anexo único; capturas de elementos e decisões preservadas. RED confirmado, 31 testes focados aprovados, revisão C=0/I=0 e relatório real aprovado. |
| Segunda confirmação do lote não respondia | Reinicialização do progresso local ao mudar a página da pausa, preservando o progresso agregado. RED confirmado, 130 testes focados aprovados, revisão C=0/I=0/M=0 e duas confirmações reais aprovadas. |
| Destaque indisponível para auditoria por URL | Projeção da URL sanitizada do `EvidenceUrlV1` para a string exigida pelo registrador. RED de contrato confirmado, 154 testes focados aprovados, revisão C=0/I=0 e destaque/limpeza reais aprovados. |

Os E2E também foram atualizados para a interface de lote com três modos e para aguardar o encerramento nativo do painel antes de reabri-lo no teste de personas. Esses ajustes não alteraram a implementação das personas.

## Verificações lógicas e estáticas

- Suíte lógica ampla: **3.018/3.018 aprovados**, sem skips, em 38,49 s (`final-logical.log`). A única alteração de produção posterior foi a projeção `.urlEvidence.href` do destaque, coberta pela regressão focada de **154/154** e pelo E2E real.
- `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify`: aprovado, inclusive após essa última correção (`post-highlight-verify.log`).
- `git diff --check`: aprovado.
- A execução lógica anterior com fixture de bootstrap desatualizada foi substituída pela execução ampla verde; não foi omitida uma falha de produção para obter aprovação.

A suíte ampla foi selecionada por `createTestPlan(files).parallel` de `scripts/run-tests.mjs`, executada com `node --test --test-concurrency=4`. Não foi declarado `npm test` integralmente verde, pois ele inclui E2E de funcionalidades adiadas.

## E2E reais aprovados no escopo da beta

| Percurso | Resultado observado |
| --- | --- |
| axe-core local em MV3/CSP e downloads com nomes distintos | Aprovados. |
| Página atual, sem imagens | Progresso, sumário, ficha normativa, anúncio estimado, relatório e página original preservada. |
| Página atual, somente elementos | Confirmação antes de pixels, evidências, relatório e página original preservada. |
| Página atual, evidência completa | Reinício do worker, confirmação, relatório e quatro exportações; página original preservada. O caso completo corrigido passou em 79,7 s. |
| Cancelamento da pausa | Captura impedida e limpeza da cópia confirmada. |
| Outra URL, três modos | Relatórios e evidências coerentes com o modo; confirmação, reinício, cancelamento e navegação A→B cobertos. |
| Outra URL, destaque explícito | Seleção por controles públicos de uma ocorrência individual, inserção de uma moldura no documento auditado, remoção da moldura e quatro exportações; aprovado em 7,2 s. Ocorrências sem alvo individual mantêm a consulta às evidências. |
| Lote sem imagens | Duas páginas, progresso, abas inativas, sumário consolidado e exportações aprovados. |
| Lote com pixels | Duas páginas sensíveis, confirmação individual one-shot, reinício na primeira página, remoção das duas abas próprias e quatro exportações consolidadas; aprovado em 13,2 s. |
| Personas | Leitor, cores e teclado em CSP estrita; reversibilidade e fechamento/reabertura do painel aprovados. |

As aprovações provêm das execuções focadas e integradas da rodada, não de uma alegada reexecução única de todos os cenários após cada ajuste.

## Inspeção visual e arquivos exportados

Foram inspecionados o sumário no painel, o relatório completo e páginas renderizadas do PDF, incluindo sumário executivo e ocorrências. A apresentação permaneceu neutra, legível, sem recorte material identificado, com filtros grandes e quatro formatos de exportação.

Na fixture de estresse com 240 botões sem nome, foram gerados HTML (~27 MB), PDF (~12 MB), CSV (~5,5 MB) e JSON (~10 MB), com verificações de identidade, formato e ausência dos marcadores privados. O PDF é A4, marcado, sem JavaScript ou criptografia, com **1.091 páginas**. Esse volume é uma limitação de apresentação registrada no backlog; a beta não promete PDFs curtos para milhares de ocorrências.

Artefatos e logs locais desta execução: `/private/var/folders/3b/dv2ydqf51zq_qdv0gp1xmzzr0000gn/T/audita-marco-1-beta107-fixed-FyDWay`.

## Escopo explicitamente não aprovado

- Mapa numerado consolidado dos anúncios: gate ainda desativado; seu E2E não foi declarado aprovado.
- Retenção automática: o teste de armazenamento real passou no preflight, mas o percurso público permanece RED (`MARCO3_PUBLIC_BATCH_RETENTION_MISSING`). Não foi removida nem enfraquecida essa exigência para declarar a beta pronta.
- Para a página atual e o lote, cópias são apagadas após a coleta; o relatório permanece consultável, mas não há destaque ao vivo em um documento já encerrado.
- O destaque possui limites de volume e exige prova de alvo individual. A fixture de estresse ultrapassa o limite atual de 5.000 relações e conserva apenas a consulta às evidências.

## Pacote de entrega

- ZIP: `release/audita-acessibilidade-1.0.7.zip`.
- SHA-256: `b59f96cf01e68e3d81fda1b6834675e4c5816c59106bea5e323828e92a1b7c7b`.
- 176 arquivos de execução, sem `node_modules`, testes ou ferramentas de desenvolvimento; motor axe-core 4.13.0 empacotado.
- Arquivo ZIP testado e conteúdo descompactado comparado byte a byte com os arquivos de execução validados.
- Instalação e limitações: [guia da beta](../releases/1.0.7-beta.md).

A aprovação é para distribuição local de uma beta testável, não certificação de acessibilidade nem conclusão dos recursos adiados.
