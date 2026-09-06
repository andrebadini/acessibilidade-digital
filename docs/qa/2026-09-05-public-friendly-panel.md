# Painel e guia para público não técnico — checkpoint aprovado

Base 5ab0678. Escopo: painel (view/state/controller/detail/CSS), novo guia didático e testes correspondentes. Não inclui o relatório nem o worker em implementação concorrente.

Requisitos A/B/C/D/G da especificação `docs/superpowers/specs/2026-09-05-public-friendly-results-design.md`: agrupar ABNT com ocorrências; filtros pelos quatro cartões; referência curta para falhas; texto contextual/didático; rótulo de cobertura fiel à fórmula; refazer sem apagar ou reutilizar autorização.

RED observado: 4 comportamentos novos de interação, 1 projeção de orientação didática, 1 caso de verificação que reúne dois itens ABNT. O guia isolado teve RED9 e GREEN9, preparado por agente em dois arquivos exclusivos.

GREEN integrado: `node --test test/panel/panel-view.test.js test/panel/panel-state.test.js test/panel/panel-detail.test.js test/panel/panel-runtime.test.js test/panel/panel-result-bundle.test.js test/panel/panel-ui.test.js test/report/plain-language-guidance.test.js` = 125/125. Log `/private/tmp/audita-friendly-panel-focused.log`. `git diff --check` verde.

Filtro result é interação local. Os totais do sumário não são recalculados por seleção. O render recebe as referências normativas dos detalhes já autorizados para colocar cada ocorrência no item correto; se não houver correlação para um check multi-item, usa grupo explicitamente não resolvido em vez de atribuir item arbitrário. As projeções do painel continuam limitadas pelo orçamento existente e agora mostram suas limitações.

Refazer retorna à escolha de origem/modo, mantém o resultado persistido e não inicia captura sozinho. Se houver destaque ativo, o controlador tenta removê-lo e só retorna à entrada após confirmação. O caminho seguinte usa PREPARE_PANEL_CAPABILITY ou PREPARE_PANEL_NAVIGATION_CAPABILITY existentes, com nova autorização.

Orientação didática mantém a observação original dentro de observed; exemplo rotulado hipotético; correção em pendências é condicional. Não mudam mapeamentos, outcome canônico, modelos assinados, evidências, armazenamento ou consentimento. A compatibilidade legalReference mantém a identidade interna anterior; texto exibido muda para a referência normativa curta pedida, sem parágrafo jurídico repetido.

As três expectativas de watchdog em panel-runtime foram alinhadas a60000; estavam obsoletas desde o hotfix 1.0.10, não houve nova mudança de timeout neste incremento.

Revisão independente `public_panel_review`: um Important reproduzido (duplo clique em Refazer durante remoção de destaque). Dois REDs adicionais; botão não emite enquanto ocupado, controlador rejeita a repetição e reducer mantém o resultado até o destaque ficar idle. A mesma revisão reexecutou o controlador real: remoção negada conserva controles e retry bem-sucedido abre nova entrada. Parecer final C=0/I=0, sem Minor reproduzível.

Pendente: percurso Chrome real no candidato integrado. Sem build, pacote, publicação ou alteração da instalação pessoal nesta etapa.
