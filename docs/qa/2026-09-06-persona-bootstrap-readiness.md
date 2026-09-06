# Disponibilidade dos controles durante a sincronização de personas

## Evidência e causa reproduzível

Gate da candidata `2774ab3`: 3.981 testes lógicos aprovados; 37/38 testes nativos aprovados. A falha foi `WAIT_TIMEOUT` em `personas-mv3-csp.test.mjs:122`, esperando `aria-pressed=true` após selecionar leitor. Log: `/tmp/audita-beta116-gate.LzLXU6/npm-test.log`. O teste não registrava o retorno da seleção; portanto, não é possível atribuir retrospectivamente esse timeout à causa abaixo com certeza.

Duas repetições isoladas passaram sem mudança de produção. Isso não foi considerado correção: a revisão somente leitura demonstrou uma condição concreta em que o painel já mostra os controles, `synchronize()` ainda mantém a sessão ocupada e `select()` devolve BUSY sem publicar seleção. O controlador ignorava esse retorno. Não houve evidência de vazamento ou alteração de auditoria nesse recorte.

## Correção mínima

Somente `src/panel/panel.js`: estado visual local de sincronização, mensagem fixa de preparação, `disabled` e `aria-disabled` nos controles de persona até a conclusão. A projeção é reaplicada quando outro evento redesenha o painel; os estados anteriores de cada botão são preservados. Finalizar a sincronização não redesenha o formulário nem desloca foco. Auditoria/entrada de URL permanecem utilizáveis.

Sem fila de cliques, nova mensagem, nova autoridade, mudança de esquema/reducer ou alterações na sessão de personas. Uma falha na sincronização também libera os controles, mantendo a mensagem de falha existente.

## Verificação

- RED de integração com módulo do painel real e resposta de reidratação retida: botão habilitado quando deveria anunciar preparação, `null !== 'true'`. `/tmp/audita-beta116-gate.LzLXU6/persona-busy-red.log`.
- GREEN **119/119**, quatro arquivos: `panel-runtime`, `persona-session`, `panel-view`, `panel-state`. Inclui nenhuma persona encontrada e falha de reidratação, preservação do acesso ao formulário e acionamento posterior enviado ao worker. Log `persona-busy-green.log` no mesmo diretório.
- Revisão independente somente leitura: C=0/I=0, sem novo Minor. `git diff --check` aprovado.
- Teste nativo corrigido aguarda o estado real de botão disponível, sem pular ativação, legenda, teclado, troca de modo ou reabertura. **1/1 passou**, 2,35 s; log `persona-corrected.log`.

A execução ampla original continua registrada como **37/38**, não foi apagada nem reclassificada como verde. Não foi repetida a suíte completa. A prova posterior é da correção mínima e do percurso afetado, não uma nova execução de todos os testes.
