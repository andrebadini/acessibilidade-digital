# Retenção R2-B — revogação das autorizações da auditoria

## Escopo e contrato

Base: `c3a8e90`. Alterações somente em `src/background/target-capabilities.js` e `test/background/target-capabilities.test.js`.

`authority.clearAudit(auditId)` retorna `Promise<{ok:true,invalidated:number}|{ok:false,code:'CAPABILITY_UNAVAILABLE'}>`. O número conta registros efetivamente alterados. A operação reutiliza a fila compartilhada por `sessionArea`, revoga sessões da auditoria exata e invalida target/navigation correlacionados pelo `sessionCapabilityId` e pela janela. Os IDs internos precisam corresponder às respectivas chaves de armazenamento.

Não há novo caller público, acesso ao modelo, remoção de aba ou mudança de UI nesta fatia. O coordenador de exclusão deverá chamar esta operação depois do staging durável R1 e antes da limpeza dos Ports e demais recursos.

## Comportamentos comprovados

- Sessões attached, single, batch e view-only são revogadas. Capabilities associadas ficam inválidas; nova autorização da sessão é recusada.
- Outra auditoria na mesma janela/aba, personas independentes, capabilities ainda não associadas e outros prefixos são preservados.
- O planejamento completo ocorre antes da primeira escrita. Malformed atribuível ou IDs transplantados impedem a operação sem modificar os demais registros; malformed de outra auditoria não é normalizado nem apagado.
- Uma chamada `set` contém o lote; só a releitura exata de todos os registros planejados confirma sucesso. Escrita parcial, sem efeito, leitura indisponível ou erro operacional produzem resposta fixa e permitem retry. Gravação confirmada seguida de erro é reconhecida por readback.
- Sessões já revogadas continuam na correlação, permitindo terminar uma capability remanescente após falha parcial. Uma repetição bem-sucedida retorna zero e não escreve novamente.
- Claim iniciado antes da limpeza em outra instância da authority, compartilhando `sessionArea`, termina antes do scan e é revogado. Isso não cria uma proibição global de reutilização arbitrária futura de auditId; a admissão de novas auditorias permanece a cargo dos callers.

## Evidências

- Pré-análise independente definiu as invariantes antes da implementação; confirmou que `invalidateBy` não poderia ser chamado diretamente porque não faz readback e trata inventário ilegível como vazio.
- RED: **15 falhas** por API ausente em `/private/tmp/audita-retention-r2b-authority-red.log`.
- GREEN inicial: 15/15; depois acrescentadas regressões de batch e falha na releitura, mantendo a mesma implementação.
- Arquivo completo: **108/108**, sem falhas ou skips, em `/private/tmp/audita-retention-r2b-authority-green.log`.
- Revisão independente do diff congelado: **C=0/I=0**, com repetição dos 108 testes e `git diff --check` aprovado. Nenhuma rodada corretiva adicional.
- Sem suíte ampla, Chrome, empacotamento ou alterações em `node_modules`.

## Limite importante para a integração

Revogar não é apagar todos os registros. Os journals conservam vínculos necessários à recuperação e limpeza dos documentos. Antes de concluir o tombstone e declarar a retenção pública entregue, o coordenador deve comprovar o encerramento dos recursos dependentes e remover os registros transitórios próprios que ainda contêm esses vínculos. Não tratar esta API isolada como purga final.

R1 e R2-A permanecem congelados. Seguem pendentes a limpeza audit-scoped do painel, launches e Blob URLs, a composição do coordenador, os gatilhos de expiração, a confirmação manual prevista no plano e o percurso público em Chrome real. A beta 1.0.7 permanece intacta.
