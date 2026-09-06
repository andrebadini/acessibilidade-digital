# Preparação do E2E nativo de retenção

Arquivo: `test/e2e/retention-indexeddb-mv3.test.mjs`.

## Percurso atualizado

- Dois lotes de duas páginas iniciados pelo painel lateral real, sem popup e sem formulário legado.
- Seleção de `full-evidence`, confirmação de privacidade por página e resultado antes da abertura do relatório.
- Primeiro relatório com checkbox `delete-after-export` desmarcado: quatro downloads, modelo preservado e expiração absoluta inalterada. Diálogo manual usa teclado, prova cancelamento e confirma a exclusão.
- Segundo relatório com opt-in explícito: quatro downloads antes da comprovação de exclusão e limpeza do tombstone.
- A exclusão fecha a aba do relatório. A prova usa o harness independente e a ausência da aba; não aguarda mensagens no DOM já encerrado.
- Oito arquivos físicos permanecem com tamanho e SHA-256 inalterados. A coleta dos downloads usa novos IDs do histórico Chrome, MIME, arquivo não vazio e correlação do JSON com a auditoria; não depende de reler um receipt já apagado pelo cleanup.
- Verificações de sanitização, lista explícita sem seguir o link-armadilha e apresentação utilizável a 320 px permanecem. Não se atribui a esse teste uma prova de zoom de 200%.

## IndexedDB

A prova de armazenamento usa o mesmo store produtivo com uma factory que direciona apenas o nome do banco para `audita-retention-storage-proof`. Isso mantém IndexedDB real e evita apagar o banco do worker para simular migração. A versão esperada é 3.

Mantidos migração, metadados limitados, expiração absoluta, duas conexões em CAS, lease ocupada, rollback e persistência após reabertura. A finalização parcial preserva dados e recusa staging. A finalização completa também preserva o modelo; somente `stageAuditDeletionV1` com receipt canônico e revisão `receipt.modelRevision + 1` remove o grafo durável e grava tombstone. A prova pública verifica a limpeza posterior pelo coordenador real.

Os controles antigos de exclusão coletiva no painel não existem no percurso atual. Seu antigo E2E de DOM foi retirado, sem simular sua presença; a cobertura de bulk/manual busy permanece nos testes focados R3-F2 e a lease ocupada continua exercitada em IndexedDB real neste candidato.

## Estado da validação

Preparação somente: `node --check` e `git diff --check` passaram. As expressões de navegador geradas por `runRealStorageProof` e `nativeAuditProofExpression` também foram compiladas sem erro de sintaxe, sem executar o navegador.

Nenhum E2E, Chrome, pacote ou publicação foi executado nesta tarefa. O teste requer o candidato F3 integrado e deve ser executado pelo agente principal no marco nativo; este registro não declara GREEN funcional.
