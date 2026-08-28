# Metodologia acelerada por risco

Adotada em 27 de agosto de 2026 para o restante do plano `2026-08-27-audita-acessibilidade-2.md`.

## Matriz de verificacao

### Risco critico

Abrange privacidade, integridade, evidencias, juridico, armazenamento, permissoes e qualquer fluxo que possa causar vazamento, perda de dados, resultado normativo incorreto ou falha operacional material.

- TDD obrigatorio por comportamento.
- Duas revisoes independentes no fechamento da fronteira.
- Durante correcoes: somente testes afetados e contratos adjacentes.
- `npm test`, `verify` e E2E real uma vez no fechamento da tarefa/marco, conforme aplicavel.
- Zero Critical ou Important para aprovacao.
- Achado semelhante apos duas rodadas interrompe remendos e exige redesenho da fronteira.

### Risco medio

Abrange relatorio, filtros, mapas, personas, modulo de leitura simulada e menu de contexto, salvo quando uma mudanca tocar uma fronteira critica acima.

- Testes focados durante o desenvolvimento.
- Uma revisao independente ao concluir a funcionalidade.
- Suite completa somente no fechamento do marco.
- QA visual e de acessibilidade nos viewports/estados previstos.

### Risco baixo

Abrange textos, documentacao e ajustes puramente visuais sem efeito de estado, seguranca, privacidade ou resultado normativo.

- Testes diretamente relacionados.
- Revisao visual e de acessibilidade.
- Suite completa apenas no marco seguinte.

## Regras operacionais

1. Nao repetir `npm test`, `verify`, build ou SHA apos cada ajuste pequeno.
2. Gerar/conferir ZIP somente no marco de release, exceto preservacao imediata se um teste legado modificar o ZIP 1.0.1; a preservacao final e comprovada uma vez no fechamento.
3. Trabalhos paralelos sao permitidos para documentacao, QA/preflight e testes quando nao houver sobreposicao de arquivos ou estado compartilhado mutavel.
4. Achados Minor podem ser registrados e encaminhados ao marco adequado se nao causarem vazamento, perda de dados, resultado normativo incorreto ou falha operacional.
5. Um achado inicialmente Minor sobe para risco critico se atingir uma das consequencias acima.
6. Toda verificacao final registra comandos, contagens e resultado; nao repetir a mesma prova sem mudanca material posterior.

## Marcos

1. Relatorio interativo + mapa de anuncios.
2. Personas + modulo leitor de tela + menu de contexto.
3. Lote multipaginas + retencao local.
4. Documentacao + E2E real + pacote final 2.0.0.

O ponto critico de exportacao (Task 7) termina sob o rigor ja iniciado. A metodologia acima rege as Tasks 8–15 e qualquer correcao posterior, com reclassificacao automatica quando uma alteracao cruzar uma fronteira critica.
