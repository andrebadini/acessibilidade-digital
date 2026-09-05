# Legendas vivas e acesso ao relatório — 05/09/2026

## Diagnóstico e escopo

A beta 1.0.7 não abria o relatório completo automaticamente: sua abertura dependia do botão ao final da lista de ocorrências. O fluxo público de abertura existia, mas não apresentava andamento visível e não impedia cliques duplicados. A falha de abertura após um clique relatada pelo usuário ainda não foi reproduzida nesta rodada; não foi atribuída sem prova ao temporizador de conexão.

A persona de leitura desenhava somente a camada escura e a moldura no documento. O anúncio estava no texto de estado do painel, sem área de legenda própria. Esse texto era atualizado por ações explícitas no painel, mas não acompanhava o foco alterado na página. A falha de voz substituía a mensagem inteira.

## Alterações delimitadas

- Botão principal de relatório antes dos filtros e das ocorrências, com mensagem de resultado pronto e indicação dos quatro formatos.
- Andamento de abertura visível, bloqueio de clique duplicado e tentativa posterior sem descartar o resultado.
- Legenda e posição em área própria no início do painel durante a leitura simulada.
- Consulta passiva pelo Port já autorizado, a cada 250 ms enquanto a legenda está visível. Não cria permissões, não inicia a voz e não persiste texto novo.
- Atualização pontual da legenda, preservando foco, rolagem e controles. Painel oculto ou encerrado não continua consultando.
- Respostas atrasadas não sobrescrevem ações mais recentes nem ressuscitam uma persona encerrada. Falta de voz não apaga legenda e posição.
- O DOM da página continua sem texto de legenda: isso evita incorporar os anúncios à própria página auditada. A legenda é da interface local da extensão. O mapa numerado no relatório é um recurso distinto.

## TDD observado

- Interface: três REDs de acesso ao relatório, feedback de abertura e legenda em destaque.
- Atualização passiva: RED de ausência da consulta que acompanharia o foco.
- Sessão e estado: oito REDs antes da implementação.
- Integração focada: 79 testes aprovados nos quatro arquivos de testes de sessão, estado, renderização e runtime do painel.
- `git diff --check`: aprovado.

Revisão independente: **C=0/I=0** no incremento de interface, com reexecução independente dos 79 testes focados. O refinamento de foco ao encerrar automaticamente uma persona ausente foi registrado no backlog como Minor.

## Verificação real e correção visual

- A primeira inicialização do Chrome dentro do sandbox encerrou em `CDP_CLOSED`, antes do percurso. O teste autorizado em perfil temporário isolado iniciou normalmente, sem modificar perfil ou chaveiro pessoal.
- O teste de Tab real passou, mas a inspeção da captura revelou a legenda fora da área visível. A restauração de foco ainda apontava para o formulário antigo. Um novo RED real exigiu o retângulo da legenda dentro da janela e reproduziu a falha.
- Correção mínima: ao selecionar uma persona, restaurar foco no botão dessa persona; na leitura, iniciar a rolagem no topo. GREEN real **1/1**, 27 testes diretamente afetados e validação independente **C=0/I=0**. Atualizações passivas continuam sem alterar foco.
- Captura final inspecionada: `/private/var/folders/3b/dv2ydqf51zq_qdv0gp1xmzzr0000gn/T/audita-marco-1-beta108-final-V0LniC/qa/persona-reader-tab-caption.png`.
- Relatórios de página atual sem imagens e somente elementos abriram no Chrome. O teste público do mapa também abriu relatório e exportou os quatro formatos.
- **Bloqueio identificado nesta rodada e posteriormente corrigido:** o cenário de estresse completo após reinício do worker concluía auditoria e sumário, mas podia negar a abertura do relatório antes de criar sua aba. A reprodução, a causa e a correção estão no [registro da resposta tardia do Port](2026-09-05-report-port-late-response.md). Esse registro também distingue a abertura corrigida do timeout de exportação ainda conhecido em relatórios com milhares de ocorrências. Logs históricos: `/private/tmp/audita-beta108-full-diagnostic.log` e `/private/tmp/audita-beta108-report-probe.log`.

## Limites mantidos

A legenda é uma estimativa, não uma emulação exata de todos os leitores de tela. O relatório completo continua aberto por ação explícita no botão; o sumário é apresentado automaticamente. Os mecanismos de retenção em desenvolvimento não são anunciados como prontos.
