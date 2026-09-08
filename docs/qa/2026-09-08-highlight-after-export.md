# Destaque preservado após exportar conteúdo inalterado

Base: `59e5575`. Continuação do RED documentado em `2026-09-08-axe-snapshot-correlation.md`.

## Causa e contrato reduzido

`finalizeExportAndMaybeDelete` incrementa a revisão de armazenamento ao finalizar recibos e metadados, mesmo quando não altera o modelo. O vínculo de destaque conserva a revisão na qual foi provado. Igualdade obrigatória entre esses contadores recusava conteúdo idêntico.

O vínculo pode ser usado contra revisão atual maior ou igual à original **somente com o mesmo hash do modelo**. A autoridade continua verificando a cadeia de integridade do modelo atual e todas as relações ocorrência/página/evidência/backend/seletor. Revisão retrocedida, conteúdo diferente, vínculo vencido e documento vivo divergente permanecem negados. Não há regravação do vínculo, renovação de validade, captura de pixels adicional ou relaxamento de sessão/nonce/limpeza. O contador original permanece como proveniência da prova, não é apresentado como revisão atual.

## RED/GREEN

- Dois REDs novos reproduziram a recusa de revisão posterior com hash igual no registro e na validação relacional.
- A expectativa antiga de negar toda diferença de contador foi substituída por rollback; mantém recusa de hash diferente e acrescenta prova de que não houve escrita/renovação do vínculo.
- 53/53 testes focados em binding, binding-store, controller e live-verifier: `/tmp/audita-export-highlight-focused-final.log`. Inclui avanço de contador seguido de documento diferente, sem injeção.
- E2E real `public-axe-map-mv3`: PASS 1/1, Chrome for Testing 152 isolado, `/tmp/audita-export-highlight-native2.log`.
- Jornada: URL → confirmação de pixels → relatório → HTML/PDF/CSV/JSON → voltar à aba web → selecionar imagem suplementar no painel → destacar (uma moldura) → limpar (zero). Evidência PNG e anúncio estão referenciados no JSON e a ocorrência continua inconclusiva.
- Preparação correta: o painel precisa ser usado na aba web de origem, não enquanto a aba interna do relatório está em primeiro plano. Esta última tem contexto próprio; o relatório por URL permanece view-only. A recusa por contexto não foi removida.
- Tentativas anteriores de clicar em controles inexistentes no relatório view-only ou usar o painel em contexto de outra aba não são testes verdes nem prova de falha de identidade. Os REDs específicos de revisão e o diagnóstico de hash igual/revisão diferente são preservados separadamente.

## Revisão

Revisão independente do núcleo: C=0/I=0; 53 testes e diff-check verificados pelo revisor. Segunda revisão independente de integração: C=0/I=0, 43 testes, diff-check e sintaxe nativa aprovados. Minor não bloqueante registrado para cobertura futura: transformar o diagnóstico nativo de revisão posterior/hash igual em asserção explícita; os testes unitários já exigem essa condição e a jornada real verifica o destaque após quatro downloads. Este checkpoint não altera o ZIP 1.1.10 nem encerra a meta completa.
