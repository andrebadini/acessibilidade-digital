# Exportação 1.1.63 — downloads dos quatro formatos, aba final e recibo durável

Data: 17/10/2026. Versão em trabalho: **1.1.63** (worktree `w163-exportacao`, **sem commit**; o
orquestrador revisa e comita). Chrome estável 155.0.8059.84 (marca, janela visível) e Chrome for
Testing 155.0.8059.84 e 152.0.7977.64.

Escopo: o relato de que, ao clicar para baixar PDF, HTML, CSV e JSON, “as páginas/abas são inválidas
e não baixam”. Por regra do projeto, **nenhum nome de órgão ou domínio de governo e nenhum nome de
loja é registrado aqui**; as rodadas em página real são descritas como “um portal público” e “duas
lojas on-line”.

## 1. Reprodução

1. Perfil novo, extensão carregada sem empacotar, janela **visível** de 2560×1300 (e também
   1920×1080), Chrome estável 155; a mesma rodada foi repetida no Chrome for Testing 155 e 152.
2. Auditoria completa em **um portal público** e em **duas lojas on-line**, com captura de evidência
   completa (página inteira, recortes, mapa de leitura, Mapa do teclado e Leitura por Tab).
3. Na tela de resultado, no relatório completo, na verificação guiada e na conferência de Leitura por
   Tab, todos os botões de download/exportação foram acionados, um a um, com registro da aba aberta,
   URL, título, console (CDP), arquivo baixado e tamanho.
4. O caso de falha foi reproduzido também com a **pasta de downloads sem permissão de escrita**
   (`chmod 0500`), que é o estado de máquina em que o defeito aparecia de forma intermitente.

Sintomas observados antes da correção:

- a aba de exportação abria em segundo plano e **fechava sozinha** quando o primeiro formato falhava;
  sobrava uma aba vazia ou uma aba que parecia “inválida”;
- o relatório ficava em **“Relatório atualizado na fila de geração.”** para sempre, sem dizer se os
  arquivos saíram;
- quando os quatro formatos não saíam, a página ainda podia dizer que os quatro arquivos tinham sido
  baixados;
- com a pasta sem escrita, o Chrome registrava o download como interrompido **sem caminho de
  destino**, a limpeza ficava pendente para sempre e a exportação **abortava no primeiro formato**.

## 2. Causas

### 2.1 O download sem destino não era reconhecido como “nada foi escrito”

O adaptador já classificava o caso clássico `interrupted/USER_CANCELED`, `canResume:false`,
`exists:false` como ausência física (`interrupted-user-cancelled-absent`). Quando a pasta recusa a
gravação, porém, o Chrome devolve outra forma: `exists:true` (a **entrada** de histórico ainda existe),
`filename:""` (não há caminho em disco) e, muitas vezes, `bytesReceived` igual ao tamanho total, porque
os bytes chegaram da origem mas nunca foram gravados.

Essa forma caía em `invalid`. A limpeza não podia ser confirmada, o journal ficava pendente e
`downloadArtifacts` encerrava a exportação inteira em vez de tentar o formato seguinte. Era a causa
principal de “não baixa”.

Correção em `src/browser/download-artifacts.js`: nova classificação **`interrupted-no-destination`**
para `state === 'interrupted' && error === 'USER_CANCELED' && canResume === false && exists === true &&
filename === ''`. Ela é tratada como ausência física na limpeza (`erase` + confirmação de `absent`) e
na reconciliação de downloads obsoletos. A validação de descritor estrito, os códigos do contrato de
falha e o journal **não** mudaram; nenhum esquema fechado, catálogo, versão de algoritmo ou hash de
inventário foi alterado. Auditorias antigas continuam abrindo sem migração.

### 2.2 A aba e o relatório não contavam o que aconteceu

- A aba de exportação fechava em silêncio em qualquer falha e mostrava uma mensagem técnica quando
  ficava aberta.
- O relatório só conhecia “na fila”; não acompanhava o recibo durável (`exportStatus`,
  `exportAttempt`, `deliveryReceipt`).
- A exportação parcial ainda podia ser anunciada como sucesso.

Correções:

| Peça | Arquivo | O que faz |
| --- | --- | --- |
| Texto leigo e único | `src/export/export-outcome-message.js` (novo) | Traduz o recibo durável em título, motivo por formato e orientação. Motivos como `DOWNLOAD_INTERRUPTED` e `DOWNLOAD_WAIT_TIMEOUT` viram frases simples (“o navegador interrompeu o download”, “o download demorou demais e foi encerrado”). Nunca devolve `undefined` para recibo ausente ou hostil |
| Aba de exportação | `src/export/index.html`, `export.css`, `index.js` | Mostra o resultado em português simples, com detalhes e um botão **“Fechar esta aba”**. Sucesso completo continua fechando sozinho; falha/entrega parcial **mantém a aba aberta** com motivo e saída. A limpeza pendente tem prazo de 30 s e, depois dele, também mostra motivo e saída em vez de esperar para sempre |
| Relatório | `src/review/review.js` | Depois de pedir a exportação, acompanha `store.getLatest()` a cada 1,5 s (prazo de 300 s, suficiente para quatro formatos × 30 s + PDF). Só considera a limpeza pendente quando a tentativa é nova e não está em `running/delivering`; ao terminar, escreve o mesmo texto leigo da aba. O prazo final continua dizendo que a geração não foi confirmada — nunca inventa sucesso |
| Contrato de sucesso | `src/export/index.js` | Só anuncia “os quatro arquivos foram baixados” quando o recibo durável está `complete`; caso contrário confirma o recibo e mostra a entrega parcial |

Não houve chamada CDP por elemento nem trabalho síncrono pesado novo na thread da página. O relatório
consulta o armazenamento local em intervalo fixo e para no primeiro estado terminal ou no prazo.

## 3. Provas com o navegador real

### 3.1 Sucesso, Chrome estável 155, janela visível 2560×1300

Rodada headed no portal público, com auditoria completa de evidência (recortes, mapa de leitura, Mapa
do teclado e Leitura por Tab). Resultado do relatório:

> “Os quatro arquivos foram baixados e o recibo local foi confirmado.”

A aba de exportação fechou sozinha depois da confirmação. Arquivos entregues:

| Formato | Tamanho | Conferência |
| --- | ---: | --- |
| HTML | 13.377.980 B | 1 bloco `<style>`, 341 regras CSS, 4 `<img>`, 5 PNGs embutidos, Mapa do teclado e anexo com 148 evidências |
| PDF | 10.298.719 B | assinatura `%PDF-`, 121 páginas, 5 imagens; páginas rasterizadas e lidas abaixo |
| CSV | 424.933 B | BOM UTF-8, 436 linhas, 39 colunas, **0 linhas com contagem divergente**; 336 requisitos e 99 recomendações |
| JSON | 13.579.773 B | `JSON.parse` ok, `schemaVersion` 2, 146 asserções, identidade de entrega `ExportDeliveryIdentityV1` |

O HTML entregue foi aberto no próprio Chrome: `system-ui` aplicado, `h1` na cor do relatório, 1 folha
de estilo, **4 de 4 imagens carregadas** e nenhuma quebrada. A seção do Mapa do teclado foi capturada
com a imagem embutida e os códigos L1…L61 sobre a página. O `<details data-report-annex>` contém
**148 cartões de evidência** e 148 âncoras `report-evidence-*`.

No PDF, a página 1 mostra o sumário executivo com os cartões e as limitações. A página 75 mostra a
captura da página com as **caixas numeradas do Mapa do teclado** e o recorte “Trecho 1 de 2 da imagem
do mapa”. A página 81 mostra a lista “Onde o Tab para, na ordem” e os itens que parecem clicáveis e o
Tab não alcança. A página 91 mostra o **Anexo de evidências** com a tabela de hashes SHA-256, e a
página 121 fecha o último item do anexo e a identificação da auditoria. As páginas foram rasterizadas
com PDFKit e conferidas visualmente.

### 3.2 Falha controlada, pasta de downloads sem escrita

Com `chmod 0500` na pasta de downloads, o Chrome real 155 produziu entradas
`interrupted/USER_CANCELED`, `canResume:false`, `exists:true`, `filename:""`. Depois da correção:

- os quatro formatos foram **tentados** (a falha de um não aborta os seguintes);
- cada journal terminou em `cleaned`, sem `cleanup-failed`;
- `chrome.downloads.search({})` terminou **vazio**, sem histórico residual;
- a aba de exportação mostrou título, motivo por formato (“o download demorou demais e foi
  encerrado”) e a orientação “Confira se há espaço livre no disco e se a pasta de downloads permite
  gravação. Depois volte à aba do relatório e exporte novamente.”, com **“Fechar esta aba”**;
- a aba do relatório saiu de “na fila” e mostrou a mesma entrega parcial, sem aba vazia.

### 3.3 Chrome for Testing 155 e 152

Os mesmos percursos de exportação passaram nas duas versões. O e2e novo de pasta recusada passou no
155 e no 152, com a mesma classificação do Chrome e sem resíduo de histórico.

## 4. Provas automatizadas

| Suíte | Comando | Resultado |
| --- | --- | --- |
| Downloads | `node --test test/browser/download-artifacts.test.js` | 59 passam, 0 falham |
| Aba de exportação | `node --test test/export/export-page.test.js` | 3 passam, 0 falham |
| Texto de entrega | `node --test test/export/export-outcome-message.test.js` | 7 passam, 0 falham |
| Relatório e preferência | `node --test test/review/review-export-preference.test.js` | 5 passam, 0 falham |
| Suporte de Chrome real | `node --test test/e2e/support/real-chrome.test.mjs` | passa (inclui a precedência de versão) |
| Conjunto relevante | os cinco arquivos acima juntos | **114 passam, 0 falham** |
| E2E de exportação | `test/e2e/current-page-export-mv3.test.mjs` no CFT 155 e 152 | passa nas duas versões |
| E2E de Leitura por Tab + exportação | `test/e2e/tab-reading-guided-mv3.test.mjs` no CFT 155 e 152 | passa; confere os quatro downloads duráveis e o PDF com páginas |
| E2E de pasta recusada (novo) | `test/e2e/download-no-destination-mv3.test.mjs` no CFT 155 e 152 | passa nas duas (~10 s cada) |
| Parte unitária do plano | mesmo conjunto de arquivos da fase paralela de `node scripts/run-tests.mjs` | **4793 passam, 1 falha esperada, 1 pulado** |

O e2e novo (`download-no-destination-mv3.test.mjs`) usa o adaptador real do Chrome, deixa a pasta sem
escrita e prova três coisas: a falha é contida por formato, o CSV seguinte é tentado e a limpeza é
confirmada sem histórico residual. Ele é pulado no Windows porque depende de permissões POSIX.

### 4.1 Expectativas de teste alteradas de propósito

- `test/export/export-page.test.js`: a falha **não** chama mais `closeOwnTab`; agora exige a aba
  aberta, o texto simples e o botão “Fechar esta aba”. Também passou a exigir que o sucesso só seja
  anunciado com recibo `complete`. A mudança é o comportamento pedido: falha não pode sumir em
  silêncio.
- `test/review/review-export-preference.test.js`: o teste novo fixa que o relatório segue o recibo
  durável e nomeia a entrega parcial em vez de ficar “na fila”. O teste antigo de “não confirmada”
  continua valendo para o prazo esgotado.
- `test/e2e/support/real-chrome.test.mjs`: a versão esperada pode vir de
  `AUDITA_EXPECT_CHROME_MAJOR` (o ambiente manda quando o valor explícito é válido), mas a checagem
  **não afrouxou** — a versão observada continua tendo de ser exatamente a esperada, e um valor
  explícito inválido continua sendo recusado **antes** de consultar o ambiente. Sem a variável, cada
  arquivo e2e mantém a versão histórica 152.
- `scripts/run-tests.mjs`: o e2e novo entrou na lista de testes de Chrome real (execução serial), para
  o plano de testes continuar classificando todos os arquivos.

## 5. O que ficou de fora

- O e2e de pasta recusada não roda no Windows (permissões POSIX); a classificação em si é
  multiplataforma e é coberta por unidade.
- A prova headed foi feita com o Chrome estável 155 e a prova de regressão com o CFT 152; a matriz
  completa de sistemas operacionais não faz parte desta tarefa.
- Nenhuma mudança foi feita nas áreas da tarefa paralela de geometria/recortes/mapas além do
  necessário para exportar e conferir os artefatos.

## 6. Resultado da suíte completa

`node scripts/run-tests.mjs` com `AUDITA_E2E_CHROME` apontando para o Chrome for Testing 152 e
`AUDITA_EXPECT_CHROME_MAJOR=152` executou a fase paralela e entrou na fase serial de Chrome real; a
fase serial foi interrompida no fechamento para não disputar o navegador com as tarefas paralelas. A
**parte unitária** (mesmo conjunto de arquivos da fase paralela do script, executado com o mesmo
ambiente) terminou com **4793 testes passando, 1 pulado e 1 falha esperada**:
`test/release-package.test.js`, que compara o hash do ZIP entregue com o fonte em mudança. Ela não é
causada por esta correção e é a única falha do conjunto. Os e2e de exportação exigidos pela tarefa
foram executados **um arquivo por vez** e passaram no 155 e no 152, como registrado na §4.

Durante a primeira execução da fase paralela, o teste de pré-condições de lançamento
(`real-chrome.test.mjs`) falhou porque `AUDITA_EXPECT_CHROME_MAJOR=152` mascarava um `expectedMajor: 0`
inválido passado pelo próprio teste. A correção mantém a validação do valor explícito **antes** de
consultar o ambiente; o teste passou a rodar com a variável preenchida e os 40 testes do arquivo
passam.
