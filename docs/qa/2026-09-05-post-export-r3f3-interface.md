# R3-F3 interface — escolha explícita e recuperação após exportação

Base aca0786. Implementação sobre contratos congelados no plano `2026-09-05-post-export-deletion.md`.

- Checkbox inicialmente desmarcado no sumário do relatório, junto ao botão dos quatro formatos. Renderizar novamente não herda opt-in.
- Callback repassa booleano; pedido padrão ou botão de regenerar sem escolha implica false.
- Protocolo aceita somente booleano opcional, sem executar getters; nenhum campo de início/consentimento mudou.
- Launch autoriza sender, serializa por auditoria, rejeita exportação ativa e adquire lease antes de alterar preferência; falha compensa a lease sem criar aba.
- Completion entrega ao callback o recibo durável já validado. Worker pede staging ao coordenador; não chama cleaner dentro da fila de exportação.
- Depois de complete resolver, wrapper agenda run sem await; falha reagenda recovery. Prova terminal é aplicada/notificada antes de qualquer limpeza do launch.

REDs: quatro testes de interface; três de encaminhamento; integração default worker mostrava modelo indevidamente preservado. GREEN local: 323/323 nos arquivos afetados; novo teste integrado isolado 1/1 com store, coordenador, autoridade de exportação e scheduler reais. Scheduler bloqueado não bloqueia resposta; ao liberar, desaparecem tombstone e aba própria. Fixture Chrome atualizada para responder consulta por tabIds como a API real.

Logs: `/private/tmp/audita-f3-interface-focused.log`, `/private/tmp/audita-f3-runtime-green.log`.

Sem Chrome real ou pacote nesta etapa. Revisão independente e candidato integrado pendentes.
