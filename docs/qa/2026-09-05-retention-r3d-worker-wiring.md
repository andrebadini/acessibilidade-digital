# R3-D3 — ligação do canal Blob ao worker

Data: 2026-09-05. Escopo: `service-worker.js`, seu teste e esta nota. O exportador é uma fatia paralela com contrato já congelado em 75cc81b.

## Implementação

A bridge é construída depois do export-launch, com o mesmo `chromeApi`, armazenamento de sessão, autoridade de exportação, store original e relógio epoch. Fica somente no grafo privado: não amplia `copyReadyRuntime`, mensagens, modelo ou painel.

O único listener onConnect reconhece o nome Blob após readiness. Attach falso/throw, inicialização recusada e Port aguardando uma registration já descartada desconectam o Port. Dispose remove listeners próprios e descarta a bridge; se a construção terminar depois do encerramento, a nova bridge também é descartada. As superfícies panel/report permanecem como antes.

O adaptador de indisponibilidade de launch só ganha duas leituras negativas (`getLaunch/getSession → null`), nunca autoridade fictícia. A fixture antiga de store ganha a leitura de lease inativa, sem alterar o store real.

## Provas focadas

RED observado antes da produção: **2 pass / 7 fail**, em `/private/tmp/audita-retention-r3d-worker-wiring-red.log`. Composição real falhava por ausência da bridge/READY; tabelas e descartes falhavam pelas ligações inexistentes.

GREEN do recorte: **9/9**, em `/private/tmp/audita-retention-r3d-worker-wiring-green.log`.
Regressão de todo o arquivo do worker: **59/59**, em `/private/tmp/audita-retention-r3d-worker-regression.log`.

```sh
node --test --test-name-pattern='Blob wiring' test/background/service-worker.test.js
node --test test/background/service-worker.test.js
git diff --check
```

A composição usa o store em memória real (acquire/claim/begin delivery) e a bridge/registry/export-launch reais. Records connected/active são semeados como fixture privada; o teste separado de composição em 75cc81b cobre criação/conexão reais da autoridade. O cenário comprova registro na sessão do mesmo worker e não expõe a bridge no runtime público.

Sem mudança em scheduler, exclusão manual/pós-exportação, permissões, captura, consentimento, normas ou arquivos baixados. Sem Chrome, suíte ampla, ZIP ou alteração da beta pública neste recorte.

## Fechamento

Duas revisões independentes do mesmo source congelado (`6d1b3ab0922e3e7f3abbf9b3c4ddb815f42ea55f3a0023261d79db921bb4ad53`) concluíram C=0/I=0, sem rodada de correção. O candidato local composto com exportador, produtores e módulos Blob passou **202/202** testes focados, com syntax-check e diff-check verdes: `/private/tmp/audita-retention-r3d-wiring-frozen-focused.log`. Isso não substitui o Chrome real do candidato de entrega.
