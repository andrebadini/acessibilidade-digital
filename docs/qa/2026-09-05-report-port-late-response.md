# Abertura do relatório após uma resposta tardia

## Reprodução e causa

O E2E de evidência completa, com reinício do worker durante a pausa de privacidade, concluiu a auditoria, preservou a aba original e exibiu o sumário. O clique em abrir o relatório não chegou ao router: nenhuma aba ou registro de lançamento foi criado.

Um observador transitório no teste registrou somente tipos de eventos, códigos fixos, tempos relativos e igualdade booleana da correlação; não registrou URLs, capacidades, conteúdo ou identificadores. Confirmou que `GET_HIGHLIGHT_AVAILABILITY` respondeu depois de **5127 ms**, após o timeout de **5000 ms** do cliente. O cliente já havia removido o pedido pendente e classificou sua resposta legítima como desconhecida, desconectando o Port. O clique seguinte ocorreu durante a reconexão e foi recusado localmente. O observador foi removido após a reprodução.

Logs locais: `/private/tmp/audita-beta108-port-timing.log` e `/private/tmp/audita-report-port-red.log`.

## Correção mínima

O cliente mantém apenas os identificadores das consultas de destaque (`GET_HIGHLIGHT_STATE` e `GET_HIGHLIGHT_AVAILABILITY`) encerradas por timeout, em memória privada e limitada a 1024 entradas — o limite de pedidos do próprio coordenador por Port. A primeira resposta exata e válida de uma dessas consultas é descartada, sem aplicar seu conteúdo nem resolver qualquer pedido novo. Sua repetição continua desconhecida e encerra a conexão. Pacotes malformados também continuam recusados. Comandos que alteram estado preservam a recuperação anterior por reconexão.

As entradas são eliminadas ao desconectar ou parar o cliente e não atravessam a conexão seguinte. Um identificador ainda pendente ou aposentado não pode ser reutilizado. Não há alteração de autoridade, sessão, consentimento, coleta, armazenamento ou URLs. A rotação de bootstrap não foi ampliada nesta correção, pois não foi a causa reproduzida.

## Testes focados

- RED novo: 54 passaram / 1 falhou. A resposta tardia derrubava o Port antes que um pedido novo pudesse abrir o relatório.
- GREEN: **117/117** em `test/panel/panel-session-port.test.js`, `test/panel/panel-view.test.js` e `test/panel/panel-state.test.js`.
- Novas regressões cobrem descarte único, pedido novo preservado, replay recusado, pacote malformado com identificador aposentado, colisão de identificador e isolamento entre Ports.
- `git diff --check` passou.

## Revisão e correção agrupada

Duas revisões independentes verificaram o recorte congelado. Uma encontrou que o descarte genérico também poderia engolir uma confirmação terminal tardia de cancelamento, deixando a interface ligada a uma sessão revogada. Novo RED reproduziu o problema (57 passaram / 1 falhou). A correção restringiu o descarte às duas consultas somente leitura, preservando a reconexão para cancelamento e outros comandos. Não foi ampliada a autoridade nem criado novo tratamento de estado terminal.

O primeiro E2E corrigido de evidência completa passou: **2/2**, reinício, sumário, abertura do relatório, quatro exportações e limpeza, em 108,4 s. O PDF de estresse válido tem 1421 páginas; URL de página e período foram conferidos visualmente no anexo. Log: `/private/tmp/audita-beta108-report-port-native-green.log`.

Fechamento das duas revisões: **C=0/I=0**. A regressão foi parametrizada para ambas as consultas, incluindo a disponibilidade com `occurrenceId`, que causou o problema no Chrome. GREEN final: **119/119**, log `/private/tmp/audita-report-port-final-focused.log`. O cancelamento tardio volta a reidratar via reconexão.

A execução única de `npm test` confirmou **3246/3246** testes lógicos. Nos testes nativos, **31/34** passaram: houve uma falha de contrato público da retenção ainda adiada e um timeout de captura de QA no cenário de estresse (mais seu teste pai). Não se declara a suíte completa aprovada. O cenário de estresse isolado já havia passado; a versão final é revalidada pelos testes diretamente afetados e pelo E2E focado após restringir o descarte.

## Candidato final

O E2E final de cancelamento seguido de retomada confirmou os controles iniciais, cancelamento, reinício, confirmação one-shot, sumário, isolamento da origem, abertura e captura do relatório. O cenário de 5.686 ocorrências excedeu o prazo de download ao exportar; não foi contado como GREEN. Log: `/private/tmp/audita-beta108-final-focused-native.log`. Uma precondição de teste que exigia somente a mensagem inicial foi ajustada para também admitir o aviso legítimo “Cancelamento solicitado.” após cancelar, mantendo todas as provas dos controles e documentos.

No candidato final, mapa público/consentimento/relatório/quatro downloads e persona com legenda real passaram **2/2**, em 7,9 s, no Chrome 152. Log: `/private/tmp/audita-beta108-final-map-reader.log`. O caso de estresse e o E2E da retenção futura permanecem documentados; nenhum deles foi apagado ou apresentado como aprovado.

Pacote 1.0.8: 179 arquivos, paridade binária com o código-fonte e integridade ZIP confirmadas. SHA-256 `37867a8ae818875540c4e800cfcacfd90697141ae88842c870323150277a03e2`.
