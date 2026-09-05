# Retenção R2-G — temporários de downloads e impressão

Base: `e7efe8b`, sobre o registro R2-F ainda congelado e aguardando revisão independente. Escopo: `src/browser/download-artifacts.js`, `src/export/report-export.js`, `test/export/blob-lifecycle.test.js`, extensão do teste de revisão imutável em `test/export/report-export.test.js` e este registro. Nenhum arquivo R2-F foi alterado nesta etapa; pacote beta, UI, captura, mapeamento normativo e recibo persistente continuam intactos.

## Contrato dos produtores

`blobLifecycle` é uma dependência interna opcional, com exatamente dois métodos: `register(blobUrl)` e `release(blobUrl)`, ambos `Promise<void>`. A opção é validada/capturada antes de criar temporários; resposta negativa ou objeto de resposta não tratado não equivale a conclusão do contrato `void`. A futura ponte para o worker deve converter a confirmação autenticada em resolução sem valor e rejeitar respostas negativas.

`downloadArtifacts` recebe o objeto em suas opções. `runReportExport` o recebe nas dependências, captura uma vez e o encaminha à impressão e aos downloads, tanto na revisão persistida imutável quanto no caminho de geração/finalização. A ausência da dependência conserva a compatibilidade atual; não significa que o fluxo público já esteja registrado no worker.

Sequência aplicada:

1. Criar a URL temporária no documento proprietário.
2. Aguardar o registro com limite de tempo antes de chamar download ou criar aba de impressão.
3. Se o registro falhar, não expor a URL; apresentar falha controlada e executar a limpeza local.
4. Depois do uso, revogar nativamente; somente em caso de sucesso chamar `release`.
5. Se a liberação do registro falhar, conservar a pendência recuperável e incluir a limitação no resultado. Não apagar arquivo entregue nem histórico.
6. Registro que se conclui depois do timeout recebe compensação de liberação, após a revogação local. Nunca inicia download ou impressão tardios.

O endereço de impressão pertence ao documento de exportação que o criou, não à aba de impressão. São cinco URLs no percurso completo sem fallback: uma impressão e quatro artefatos. Fallbacks de impressão podem criar mais de uma, todas tratadas pelo mesmo fluxo.

## TDD e regressões

- RED inicial corrigido para evitar uma expectativa falsa positiva: **14/14 falhando**, `/private/tmp/audita-retention-r2g-lifecycle-red.log`. A primeira expectativa da impressão tardia só verificava um resultado parcial; passou a exigir três downloads realmente registrados e posterior liberação do registro atrasado.
- GREEN inicial da integração: **14/14**, `/private/tmp/audita-retention-r2g-lifecycle-first.log`.
- Revisão persistida: o teste existente passou a exigir registro no momento real de criar a aba de impressão e iniciar cada download, e a liberação das cinco URLs. Sem o encaminhamento do novo contrato nesse ramo, **1/1 RED**, `/private/tmp/audita-retention-r2g-immutable-red.log`. Encaminhamento restaurado e confirmado no GREEN conjunto.
- Primeiro GREEN conjunto dos quatro módulos afetados: **151/151**, `/private/tmp/audita-retention-r2g-focused.log`.
- RED adicional de resposta negativa não tratada: **2/2 falhando**, `/private/tmp/audita-retention-r2g-ack-red.log`; registro devolvia objeto negativo e liberação devolvia `false` sem produzir a falha/limitação correta.
- Correção mínima no contrato capturado; integração focada **16/16**, `/private/tmp/audita-retention-r2g-lifecycle-green.log`.
- GREEN final dos quatro módulos afetados: **153/153**, zero falhas/cancelamentos/skips, `/private/tmp/audita-retention-r2g-final.log`.
- `git diff --check` aprovado para os arquivos rastreados. Nenhuma suíte ampla, execução do Chrome ou alteração de ZIP.

Os testes de integração usam o registro R2-F real, mapas de Blob URLs/armazenamento e consumidores que recusam URLs sem registro prévio. Verificam ausência de temporários remanescentes após sucesso e preservação do journal quando a limpeza não foi confirmada. Não usam código-fonte como substituto de comportamento.

## Estado e próximos passos

Código revisado independentemente após autorização explícita para reutilizar um agente como revisor do trabalho novo. O revisor executou os quatro módulos (**153/153**) e não encontrou C/I nos produtores. Seu único Important foi o limite do identificador no registry R2-F; a correção e os novos limites passaram em validação independente (**67/67**, registry + lifecycle). Resultado do conjunto: **C=0/I=0**, restrito ao escopo descrito, sem antecipar aprovação da ponte nativa ou do coordenador público.

Ainda falta a ponte autenticada entre `export/index.js` e worker: identidade nativa do documento, confirmação de registro antes de expor a URL, chamada de revogação no proprietário com prazo definido e respostas fechadas. Depois entram a composição do coordenador de exclusão, alarmes/retomada, confirmação manual, pós-exportação e E2E real. O novo hook ainda não é fornecido pelo entrypoint público; esta etapa não afirma que a retenção já está ativa para o usuário.

Para as semânticas nativas e os limites da prova do proprietário, ver [R2-F](2026-09-05-retention-r2f-blob-registry.md#referências-verificadas).
