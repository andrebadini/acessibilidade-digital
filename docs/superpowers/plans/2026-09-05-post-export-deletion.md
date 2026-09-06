# Exclusão opcional após exportar — contrato reduzido

Continuação da meta A–H, sem modificar início de auditoria, gates, captura ou consentimento. A autorização autônoma do usuário permite o opt-in junto ao relatório, evitando expandir o formulário inicial.

## F3-core (arquivos exclusivos)

Store, audit-retention, deletion-coordinator e seus testes. Recibo terminal por auditoria no mesmo banco, gravado atomicamente na finalização R+1, referente ao modelo exportado R. Finalizar nunca apaga diretamente. Staging pós-exportação exige quatro formatos completos, recibo idêntico ao persistido, opt-in atual, revisão R+1 e nenhum trabalho de entrega pendente. Apaga grafo durável e cria tombstone na mesma transação. Coordenador retorna pending sem cleaners para evitar deadlock com a fila de exportação. Limpeza pelo recovery já existente.

## F3-interface (arquivos exclusivos)

Report-view/review, protocolo, router, export-launch, export-completion-store, worker e testes correspondentes. Checkbox desmarcado junto a exportar; booleano opcional no protocolo com ausência=false. Autorização existente, fila do audit, recusa de launch ativa, snapshot/lease correlacionados e somente então setRetentionIntent; falha libera lease antes de criar aba. Complete delega staging ao coordenador; scheduler.run dispara sem await depois de complete sair da fila. Nenhum nonce novo.

## Critérios de saída

- TDD nas fronteiras e regressões focadas; diff-check.
- Opt-out/ausência/parcial/recibo divergente/revisão alterada/sender estrangeiro preservam dados.
- Segundo clique recusado não altera a preferência de exportação ativa.
- Recibo de A sobrevive a latest=B; rollback preserva modelo; tombstone sobrevive a reinício.
- Cleaners nunca sob a fila de complete. Downloads não são apagados.
- Duas revisões independentes no recorte congelado, C=0/I=0.
- Chrome nativo e suíte ampla apenas no candidato integrado.

## Backlog não bloqueante

Personalizar prazo de retenção; escolha de opt-in no início da auditoria. Prazo padrão absoluto de 30 dias continua vigente.
