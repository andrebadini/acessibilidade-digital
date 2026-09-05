# Retenção R2-C — encerramento das conexões do painel

## Escopo e contrato

Base: `e243f38`. `panelCoordinator.clearAudit(auditId) -> Promise<boolean>` passa a localizar tanto os bootstraps duráveis quanto os bindings vivos da auditoria. Não exige modelo disponível. Reutiliza `liveByWindow`, `withWindowLock`, `readBootstrap` e `disconnectSession`; não cria registry duplicado.

Arquivos de produção alterados: `src/background/panel-port.js` e uma projeção restrita em `src/background/service-worker.js`. Testes em `test/background/panel-port.test.js`; a simulação de `storage.session.get` passou a suportar inventário `get(null)`.

## Invariantes comprovadas

- Uma conexão em `proving-hello` é registrada antes de aguardar o bootstrap; recebe sua associação audit/session antes da leitura da sessão. A limpeza aguarda a identidade de uma conexão ainda desconhecida, mas não encerra essa conexão se ela pertencer a outra auditoria.
- A limpeza aguarda o lock da janela; não conclui enquanto uma leitura inicial/resultado ainda mantém um binding próprio em processamento.
- Dentro do lock, lê a correlação atual. Se o hello rotacionar a sessão para view-only durante a espera, a limpeza alcança essa nova correlação.
- O bootstrap próprio é processado antes de um binding próprio remanescente, inclusive quando os dois usam capabilities diferentes da mesma auditoria.
- Uma publicação que termina antes de a limpeza resolver não é descrita como bloqueada. Depois de `true`, o Port próprio está desconectado e não há publicação tardia.
- Bootstrap sem Port e Port sem bootstrap são tratados; repetição é idempotente. Outra auditoria, outra janela e registros independentes são preservados.
- Inventário ilegível, malformed atribuível, falha de remoção ou replacement não confirmado retorna `false`; não expõe a mensagem recebida do armazenamento nem apaga um replacement estrangeiro.

Desconectar a auditoria não significa apagar todo estado de lançamento da janela. Mantém-se `disconnect`/`retirePort` existentes; não há limpeza global de janela ou persona nesta fatia.

## RED e GREEN

- Pré-análise independente definiu casos de hello pendente em leitura de sessão e em carga de resultado, com destaque para `single`/`retained-for-review`, que pode publicar sem regravar bootstrap.
- RED inicial: **15 falhas**, API ausente, em `/private/tmp/audita-retention-r2c-panel-red.log`.
- GREEN local: **15/15** testes novos do painel.
- A regressão de painel + worker encontrou **20 falhas de inicialização**, todas no grafo real: o roteador exige um objeto fechado de três operações do painel, e a API nova acrescentou uma quarta. Log dessa execução: `/private/tmp/audita-retention-r2c-panel-green.log` (apesar do nome do arquivo, essa execução falhou; não foi usada como aprovação).
- Reprodutor isolado da falha operacional: **1 falha** em `/private/tmp/audita-retention-r2c-worker-contract-red.log`.
- Correção mínima: o worker projeta explicitamente os três métodos do contrato original ao roteador, assim como já fazia para o starter. `clearAudit` não é exposto ao roteador; seu validador não foi ampliado nem enfraquecido.
- GREEN integrado focado: **248/248**, sem falhas ou skips, em 1,93 s, com `panel-port.test.js`, `service-worker.test.js` e `side-panel-intent-router.test.js`. Log: `/private/tmp/audita-retention-r2c-panel-final-green.log`.
- `git diff --check` aprovado. Sem Chrome, suíte ampla ou ZIP.

## Correção da revisão independente

A revisão encontrou um achado Important reproduzível: o segundo `get` do bootstrap podia capturar o registro e ficar pendente antes de `liveByWindow` conhecer a conexão. Removido o bootstrap nesse intervalo, `clearAudit` devolvia `true`; um resultado `single`/`retained-for-review` era publicado depois.

- RED confirmado com leitura controlada: **3 falhas** (dois casos e seu agrupamento), em `/private/tmp/audita-retention-r2c-early-bootstrap-red.log`; reproduzido novamente antes da correção.
- Correção mínima: registrar o hello provisório antes da leitura e incluir sua janela na espera da limpeza. O mapa local distingue propriedade já conhecida de identidade ainda pendente; uma identidade estrangeira resolvida durante essa espera é preservada. Não foi criado registry global adicional.
- GREEN do reprodutor: **3/3**, incluindo espera da própria auditoria e preservação do resultado estrangeiro. Após a limpeza resolver, o Port próprio está desconectado e não publica novamente.
- Regressão integrada focada corrigida: **251/251**, zero falhas/skips, em 1,99 s. Log: `/private/tmp/audita-retention-r2c-panel-corrected-green.log`. `git diff --check` aprovado.
- Validação independente da correção: **C=0/I=0**, com reexecução **251/251** e `git diff --check` aprovado. Verificações controladas adicionais, sem arquivos, cobriram hello ocioso, bootstrap próprio removido e bootstrap estrangeiro removido: espera, preservação das conexões estrangeira/ociosa, idempotência e ausência de publicação após `true` confirmadas.

## Integração pendente

O worker continua usando o caminho público de exclusão anterior até a composição do coordenador durável. Esta API ainda não torna a retenção automática pública. R1, authority e report Port permanecem congelados; a próxima composição deve usar seus contratos atuais, normalizar retornos e confirmar a limpeza dos recursos dependentes antes de apagar o tombstone. Beta 1.0.7 preservada.
