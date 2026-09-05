# R3-D — composição local dos arquivos temporários

Data: 2026-09-05. Beta pública 1.0.8 preservada. Este checkpoint não ativa novos recursos no worker/exportador.

## Resultado

Protocolo, cliente e bridge foram implementados por TDD e congelados antes da revisão. O principal e um revisor independente verificaram os módulos. Um único Important foi agrupado e corrigido: a bridge esperava epoch em `retryAt`, enquanto o store real fornece ISO. Após a correção e sua revalidação, C=0/I=0 conhecidos no recorte.

O cliente espera confirmação de registro antes de permitir uso da URL. A revogação é atendida fora da fila do registro/release, inclusive após reinício do worker. Falha da API de contextos não é confundida com documento destruído. Os arquivos já baixados não são apagados.

## RED e GREEN

- Protocolo: 3 RED por factory ausente; 3/3 GREEN.
- Bridge: RED inicial 52; correção de contrato ISO com 23 pass/4 fail, seguida de 59/59 (inclui protocolo).
- Cliente: RED inicial 20 e RED de compatibilidade de métodos nativos herdados; 21/21 GREEN.
- Composição: 0/5 com o store real antes da correção ISO; 5/5 depois. Logs `audita-retention-r3d-integration-contract-{red,green}.log` em `/private/tmp`.
- Foco final: **101/101**, zero falhas/cancelamentos/skips, em `/private/tmp/audita-retention-r3d-frozen-focused.log`.

```sh
node --test test/export/blob-url-protocol.test.js test/export/blob-url-client.test.js test/background/blob-url-port.test.js test/background/blob-url-port-integration.test.js test/export/blob-lifecycle.test.js
git diff --check
```

O teste de composição usa store, export-launch, registry, bridge e cliente reais. Substitui somente APIs nativas e transporte por Ports pareados. Prova cinco URLs registradas antes do retorno, modelo inalterado, revogação durante ACK atrasado, reconexão após reinício sem REGISTER repetido, ausência comprovada do owner e isolamento entre auditorias. Não é um teste no Chrome nem prova do entrypoint ainda não conectado.

## Próximo recorte e limites

Conectar o bridge no roteamento do worker e o cliente aos hooks já existentes do exportador, com testes focados. O agendamento da retenção e as origens manual/pós-exportação serão integrados separadamente. Sem suíte ampla, Chrome ou novo ZIP neste checkpoint.

Minors documentados, não bloqueantes: IDs usados no Port e estados released no cliente duram até o respectivo encerramento, sem persistência ou exposição; marker de preferência ainda pertence ao marco seguinte. Não há alegação de que todo o objetivo está concluído.
