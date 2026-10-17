# Botões de download por formato — 1.1.63

Data: 2026-10-17 · Branch: `wip163/botoes` · Base: `a4af916` (1.1.63)

## 1. Problema

O relatório tinha **um único botão** — “Exportar HTML, PDF, CSV e JSON” — que sempre gerava e
baixava os quatro arquivos. Quem só queria o PDF para imprimir, ou só a planilha para abrir no
Excel, era obrigado a esperar e guardar os quatro. O pedido do dono do produto foi literal:
“em vez de um botão fazer o download de todos os formatos, faça um botão para cada formato”.

Havia ainda um segundo problema, provavelmente não tratado: o dono do produto pode manter ligada
a opção do Chrome **“Perguntar onde salvar cada arquivo”** (`prompt_for_download=true`). Com a
janela nativa de salvamento aberta, o item de download fica `in_progress` e sem nome de arquivo.
O prazo de 30 s da exportação vencia enquanto a pessoa decidia, o formato era classificado como
`DOWNLOAD_WAIT_TIMEOUT` e a tela dizia que o download “demorou demais”, embora ninguém tivesse
falhado. Cancelar a janela de um formato também não era explicado: virava interrupção genérica.

## 2. Causa

1. O protocolo do worker só conhecia a exportação dos quatro formatos. O lançamento da aba de
   exportação, o gerador e o recibo durável assumiam a lista completa; qualquer recorte exigia
   mudanças nos três pontos.
2. O recibo v1 só aceitava `status: 'complete'`, e “complete” era sinônimo de quatro formatos.
   Um recorte honesto (por exemplo, só PDF) não tinha representação: ou virava “falha”, ou era
   proibido.
3. O adaptador de download usava um único `setTimeout` para o prazo. O evento `onChanged` só
   renovava a espera em `complete`/`interrupted`; o estado “diálogo de salvamento aberto”
   (`state: 'in_progress'`, `filename: ''`) não era reconhecido, então o temporizador vencia.
4. O erro `USER_CANCELED` do Chrome não tinha código próprio: caía em `DOWNLOAD_INTERRUPTED`, e a
   mensagem não dizia que fora a pessoa quem cancelou.

## 3. Solução

### 3.1 Tela do relatório

O antigo botão único virou o grupo **“Baixar relatório”** (`role="group"`, `aria-label`) com
quatro cartões, nesta ordem visual:

| botão | texto de apoio |
| --- | --- |
| Baixar PDF | Para imprimir ou anexar a um ofício. |
| Baixar HTML | Para abrir no navegador, com imagens e links. |
| Baixar planilha (CSV) | Para abrir no Excel ou no Google Sheets. |
| Baixar dados (JSON) | Arquivo técnico, com todos os dados. |

- Cada cartão pede **apenas o seu formato** (`{ formats: [formato] }`).
- Cada cartão tem sua própria região viva (`aria-live="polite"`, sem `role="status"` para não
  duplicar o status geral): “PDF baixado.”, “CSV não foi baixado: você cancelou o salvamento.”.
  O resultado de um cartão não apaga o dos outros.
- Formato que a política do relatório não conseguiu preparar (CSV ou PDF) continua **visível, mas
  desabilitado**, com o motivo em texto simples (`aria-describedby` e `disabled`).
- O botão discreto **“Baixar todos os formatos”** preserva o comportamento anterior. A caixa
  “Apagar os dados locais desta auditoria após baixar os quatro arquivos” só fica habilitada
  quando os quatro formatos estão disponíveis.

### 3.2 Protocolo e autorização

- `src/export/export-formats.js` ganhou `isCanonicalExportFormatsV1`, `canonicalExportFormatsV1`
  e `exportFormatsEnvelopeV1`: subconjunto **não vazio, sem repetição, na ordem canônica**
  (`html,pdf,csv,json`). A string é a forma do envelope; o array é a forma interna.
- `REPORT_REQUEST_EXPORT` aceita o campo opcional `formats` (string separada por vírgulas).
  Ausente continua significando os quatro — é o caminho dos registros antigos.
- O pedido de exclusão (`deleteAfterCompleteExport: true`) só é aceito junto dos quatro formatos.
  Subconjunto + exclusão é recusado no protocolo do worker e novamente na autoridade de
  lançamento (defesa em profundidade): **nenhum botão individual apaga a auditoria local**.
- O registro de lançamento em `session` grava `formats` quando presente. A leitura aceita
  registros com `formats`, sem `formats`, com ou sem `terminalProof`, mantendo auditorias e
  lançamentos antigos funcionando.

### 3.3 Geração e recibo

- A aba de exportação recebe do worker os formatos autorizados e repassa ao gerador. CSV, JSON e
  HTML **não abrem a aba de impressão**; só o PDF usa o caminho de impressão. O status da aba
  diz “Gerando os arquivos pedidos (PDF)”.
- O gerador só produz os artefatos pedidos. Diagnósticos de CSV/PDF não pedidos não são
  inventados: um botão de PDF não declara falha de CSV, e vice-versa.
- O recibo durável continua na **versão 1**. A diferença é que um recorte limpo pode ser
  `status: 'partial'` com 1–3 formatos completos e **zero limitações**; `complete` continua
  exigindo exatamente os quatro. O invariante do armazenamento (`exportReceiptFromLatest`) aceita
  o recorte, exige ordem canônica, sem repetição, e rejeita recibo que declare formato ausente do
  journal. Um recorte nunca acumula formatos de pedidos anteriores: cada exportação tem seu
  próprio journal e seu próprio recibo.
- Recibos antigos (`complete`, quatro formatos) e auditorias guardadas da 1.1.56 continuam
  abrindo sem migração.

### 3.4 Diálogo de salvamento e cancelamento

- Enquanto o Chrome estiver com o item `in_progress` e `filename === ''`, o adaptador considera
  que a **pessoa está decidindo** e renova o prazo, em vez de vencer. A espera termina quando o
  arquivo completa ou é interrompido.
- A renovação tem teto de **3 minutos** por formato (`SAVE_DIALOG_TIMEOUT_MS` na exportação).
  O Chrome expõe exatamente o mesmo estado quando não consegue gravar na pasta de destino
  (`in_progress`, `filename` vazio, bytes completos) e a API de downloads não distingue os dois
  casos. Sem teto, uma pasta recusada deixaria a exportação presa para sempre; com teto, o
  formato é encerrado, limpo e o próximo continua. Chamadas diretas ao adaptador que não pedem
  a espera do diálogo (`dialogTimeoutMs` ausente) mantêm o prazo curto de antes.
- `USER_CANCELED` ganhou o código de falha `DOWNLOAD_CANCELLED`; a limitação é
  “O download do artefato PDF foi cancelado por você.” e a orientação é “Se quiser o arquivo,
  exporte novamente e confirme o salvamento na janela do navegador.”
- Cancelar um formato não afeta os outros: cada formato tem seu próprio item, seu próprio prazo
  e seu próprio resultado. O botão “Baixar todos” continua baixando os quatro,
  independentemente de um pedido anterior ter sido cancelado.

## 4. Testes

### 4.1 Unitários (686 verificações nos arquivos alterados, todas verdes)

| arquivo | foco |
| --- | --- |
| `test/export/export-formats.test.js` (novo) | subconjunto canônico, duplicado, fora de ordem, vazio, array/string |
| `test/background/worker-protocol.test.js` | aceita recortes canônicos; recusa vazio, repetido, fora de ordem, desconhecido; exclusão só com os quatro |
| `test/background/side-panel-intent-router.test.js` | repassa `formats` sem perder a decisão de exclusão |
| `test/background/export-launch.test.js` | registro grava o recorte; registro antigo sem `formats` continua valendo; subconjunto + exclusão negado sem abrir aba |
| `test/export/report-export.test.js` | gera só os formatos pedidos; não inventa diagnóstico de formato não pedido |
| `test/export/export-controller.test.js` | recorte limpo vira recibo `partial`; correlação artigo/recibo por formato |
| `test/export/export-outcome-message.test.js` | texto por cartão, “Baixar todos”, cancelamento, recorte sem falha |
| `test/export/export-page.test.js` | a aba usa os formatos autorizados; ausência do campo = quatro (legado) |
| `test/storage/audit-store.test.js` | recibo `partial` exato; recibo que cita formato fora do journal é rejeitado sem mutação |
| `test/review/report-view.test.js` | quatro botões, descrições, regiões vivas; desabilitado com motivo; “Baixar todos” pede só o que existe |
| `test/review/review-export-preference.test.js` | cada botão envia só o seu formato; resultado durável preenche só o cartão pedido |
| `test/browser/download-artifacts.test.js` | diálogo aberto renova o prazo; teto de espera contém o estado indistinguível de pasta recusada; `USER_CANCELED` vira `DOWNLOAD_CANCELLED`; cancelar um formato não cancela os demais |

### 4.2 E2E em Chrome real (um arquivo por vez)

Ambiente: `AUDITA_E2E_CHROME` apontando para o Chrome for Testing e
`AUDITA_EXPECT_CHROME_MAJOR` correspondente. As execuções foram **headed** (o harness não usa
`--headless` por padrão).

| arquivo | Chrome 155 | Chrome 152 |
| --- | --- | --- |
| `test/e2e/export-format-buttons-mv3.test.mjs` — cada botão baixa só o seu arquivo, quatro pedidos em sequência, depois “Baixar todos” com quatro arquivos | passa em 1920×1080 e em 2560×1300 | passa em 1920×1080 |
| `test/e2e/export-download-prompt-mv3.test.mjs` — janela “Perguntar onde salvar” aberta por 36 s (além do prazo de 30 s), depois cancelamento | passa em 2560×1300 | passa em 2560×1300 |

O E2E de formatos confere, para cada clique: exatamente **um** arquivo novo na pasta, extensão
correta, `downloadId` do recibo resolvido por `chrome.downloads.search` para um caminho real
dentro da pasta de downloads, bytes e SHA-256 iguais aos do recibo, recibo durável com exatamente
aquele formato, texto “X baixado.” no cartão, e nenhuma aba de exportação residual.

O E2E do diálogo confere: item `in_progress` com `filename === ''` (janela aberta), ainda
`in_progress` após 36 s, nenhum `failed`/`DOWNLOAD_WAIT_TIMEOUT`, e após `chrome.downloads.cancel`
um recibo `partial` com PDF `interrupted` + `DOWNLOAD_CANCELLED`, a limitação controlada, o texto
“PDF não foi baixado: você cancelou o salvamento.” e nenhum PDF deixado na pasta.

### 4.3 Suíte completa

`node scripts/run-tests.mjs` com o Chrome 152 (ambiente canônico da suíte): fase paralela
**4.827 de 4.828** e fase serial **145 de 146**. A única falha determinística é
`test/release-package.test.js`, que compara o hash do ZIP entregue e já falhava antes desta
rodada. A outra falha foi a etapa de teclado do teste de marcadores em `sidepanel-flow-mv3`
(`PANEL_TO_PAGE_AND_KEYBOARD`, `WAIT_TIMEOUT`), que passou na repetição imediata do arquivo
inteiro (`EXIT:0`) e também falha na árvore do commit-base `a4af916` neste ambiente — é
oscilação do harness de teclado, não regressão da exportação.

Com o Chrome 155, a suíte roda os testes novos e os de download, mas **15 testes antigos que
comparam `chromeProduct` com a constante `Chrome/152`** falham por construção; não têm relação
com esta mudança. Por isso a validação canônica da suíte é a de 152, e as duas provas novas de
exportação foram executadas nas duas versões (tabela acima).

## 5. Validação em páginas reais (antes e depois)

Forma da chamada (as URLs não são registradas aqui por regra do projeto):

```
node scripts/visual-qa.mjs --no-fixture --out qa-out/botoes-formatos-1.1.63 \
  --url <portal público> --url <portal de notícias> --url <loja on-line>
```

Chrome for Testing 155.0.8059.84, janela 1920×1080.

| medida | portal público | loja on-line | portal de notícias |
| --- | --- | --- | --- |
| auditoria | concluída, 30 achados com elemento | concluída, 70 achados com elemento | auditoria concluída; painel não informou o estado dos sinais (`WAIT_TIMEOUT`) |
| relatório | abriu, 11 capturas, 0 erros | abriu, 11 capturas, 0 erros | não abriu o relatório nesta corrida |
| grupo “Baixar relatório” | 4 botões habilitados, rótulos e descrições corretos | 4 botões habilitados, rótulos e descrições corretos | não validado (corrida anterior ao relatório) |
| entrega do anexo | HTML 4,8 MB + PDF 4,2 MB (93 páginas) | HTML 13,3 MB + PDF 11,1 MB (150 páginas) | — |

O portal de notícias foi registrado como indisponível nesta rodada e a corrida seguiu com as
outras duas páginas, conforme o combinado. As capturas do grupo são
`qa-out/botoes-formatos-1.1.63/<slug>/06b-botoes-formato.png`; o recorte mostra os quatro botões
em uma linha, cada um com o texto de apoio, sem corte ou sobreposição, inclusive na página longa
da loja on-line.

**Antes:** um único botão “Exportar HTML, PDF, CSV e JSON”, sem escolha de formato.
**Depois:** o grupo de quatro botões, cada um baixando só o seu arquivo, com resultado próprio.

## 6. Limitações e decisões

- **Exclusão:** só “Baixar todos os formatos” pode pedir a exclusão da auditoria, e só quando os
  quatro formatos estão disponíveis e foram pedidos juntos. Qualquer subconjunto + exclusão é
  recusado no worker. Não há acúmulo de formatos entre exportações nem mudança de esquema do
  recibo: a versão continua 1, com `partial` para recortes.
- **Janela nativa:** o teste automatizado não clica no diálogo do sistema; ele prova a espera e
  cancela pelo `chrome.downloads.cancel`, que produz o mesmo `USER_CANCELED` do botão “Cancelar”
  da janela. O comportamento visual da janela em si depende do Chrome e do sistema operacional.
  A renovação do prazo tem teto de 3 minutos por formato: depois disso o download é encerrado e
  o motivo aparece como tempo esgotado. O teto é necessário porque a API de downloads expõe o
  mesmo estado quando a pasta de destino recusa a gravação.
- **Formatos indisponíveis:** quando a política do relatório não prepara CSV ou PDF, o botão
  correspondente fica desabilitado com o motivo. “Baixar todos” pede apenas os formatos que
  existem e a exclusão fica indisponível, porque exige os quatro.
- **Desempenho:** a mudança não introduz chamadas CDP por elemento nem trabalho síncrono pesado
  na página auditada. O acompanhamento do diálogo é um `setInterval` curto no service worker da
  exportação, encerrado no primeiro estado terminal.
