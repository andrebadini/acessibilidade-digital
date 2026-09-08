# Dimensões observadas independentes da versão do navegador

## Escopo e causa

Incremento posterior à beta 1.1.11, sobre `97e4e5c`. A consulta de ambiente usava `Promise.all`: a recusa de `Browser.getVersion` descartava uma leitura bem-sucedida de dimensões por `Runtime.evaluate`. O runner também exigia versão não vazia para preservar o ambiente. A documentação oficial lista Runtime entre os domínios permitidos por chrome.debugger, mas não Browser: https://developer.chrome.com/docs/extensions/reference/api/debugger#restricted-domains.

A correção mantém as leituras independentes. Dimensões positivas e finitas são preservadas; versão desconhecida permanece indisponível, sem estimativa. O diagnóstico parcial `BROWSER_VERSION_UNAVAILABLE` explica a ausência da versão sem afirmar que as dimensões também faltam. Valores inválidos continuam produzindo viewport nulo e `ENVIRONMENT_UNAVAILABLE`. O modelo rejeita a alegação de dimensões preservadas quando algum valor está ausente.

Não foram alteradas autorização, identidade do documento, capturas, limpeza, conclusão normativa, permissões ou evidências históricas. O adapter ainda tenta a leitura de versão por compatibilidade; sua indisponibilidade não interrompe a medição. A preservação isolada de versão quando as dimensões falham não é uma nova promessa do runner.

## RED e GREEN

- RED inicial válido: três falhas e um teste de dimensões inválidas já aprovado; `/tmp/audita-viewport-red.log`.
- RED adicional válido: um relatório sem viewport aceitava o diagnóstico de dimensões preservadas; `Missing expected rejection` em `/tmp/audita-viewport-contradiction-red2.log`.
- A primeira preparação desse teste tentou modificar um draft congelado e falhou por fixture inválida. Esse resultado, em `/tmp/audita-viewport-contradiction-red.log`, não é prova do defeito. A fixture foi corrigida com cópia antes de reproduzir a aceitação indevida.
- GREEN final: `node --test test/background/chrome-adapter.test.js test/background/run-audit.test.js test/report/audit-model-v2.test.js test/report/diagnostic-policy.test.js`, 324/324, sem falhas ou skips; `/tmp/audita-viewport-review-focus.log`.
- `git diff --check` aprovado. Busca dirigida no delta sem nova exposição de URLs, credenciais ou identificadores; testes verificam que mensagens privadas das exceções não são retornadas no ambiente.

## Revisões e limite da entrega

Duas revisões independentes, somente leitura, sobre o mesmo diff congelado de seis arquivos: ambas C=0/I=0/M=0. A revisão de integridade também verificou enriquecimento, JSON técnico, leitura de ReportV2 e HTML com dimensões preservadas e versão indisponível.

Este incremento tem verificação local, não novo aceite nativo. Não foram executados suíte ampla, Chrome ou empacotamento. Os bytes da beta 1.1.11 não mudaram; o próximo candidato deve verificar as dimensões exportadas no percurso real, junto ao gate e pacote do marco de entrega.
