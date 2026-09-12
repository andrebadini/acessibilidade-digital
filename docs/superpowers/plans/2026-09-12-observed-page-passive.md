# Página atual sem interação visível

Objetivo aprovado pelo usuário: avaliar o estado realmente aberto no navegador, sem navegar, recarregar, mudar foco, rolagem, zoom ou estilos na aba original. Preservar autorização de capturas, identidade do documento e correlação do relatório. Não trocar a meta por mera remoção de avisos de cópia.

## Evidência do estado inicial

Em 5284fb3, `beginAuthorizedAudit` usa `prepareAttachedCopyPlan` quando há suporte de URL. A função conserva somente a URL, não o estado do DOM. A fachada `runAttachedAuditExecution` já existe, com fronteiras de identidade, persistência e pixels. Entretanto seu adaptador legado ainda permite `runDynamicProbes`, que envia Tab e altera viewport, texto e preferência de movimento. `captureFullPage` usa Page.captureScreenshot com captureBeyondViewport, não navegação por scroll explícito.

## Contrato e incrementos congeláveis

1. Execução passiva: em run-audit.js, alvos attached não executam probes dinâmicos. A ausência é explicitamente registrada como escolha de observação passiva, não timeout, erro, aprovação nem inaplicabilidade inventada. Preservar coleta DOM/AX, regras estáticas, captura autorizada e identidade antes de cada raster. Arquivos previstos: run-audit.js, diagnóstico canônico e testes diretamente relacionados. Antes de código, revisão read-only define casos adversariais; depois TDD e uma revisão agrupada.
2. Roteamento: beginAuthorizedAudit usa a fachada attached existente para página atual; beginAuthorizedUrlAudit mantém cópia descartável para URL fornecida. Não acrescentar autorização implícita, não criar abas para o primeiro fluxo, não mudar contratos de nonce ou journaling sem RED. Testes do starter provam isolamento dos dois fluxos, cancelamento e retomada. Remover apenas o desvio comprovadamente responsável pela recarga, preservando rotas de URL.
3. Apresentação e integração: página atual informa observação do estado presente e verificações interativas não executadas; URL avisa carregamento independente. Relatório não atribui evidência de cópia à origem. Percurso real em Chrome confirma menu aberto preservado, foco/scroll/viewport/estilos idênticos, relatório e destaque no elemento do documento observado. Revisões finais paralelas no candidato congelado.

## Critérios de saída

- Zero invocação de navegação/teclas/probes de alteração na página atual.
- Capturas somente após autorização e prova documental válida; navegação durante auditoria não produz evidência atribuída ao documento anterior.
- Falhas reais estáticas continuam detectadas; testes omitidos ficam com cobertura incompleta e orientação humana.
- Abrir painel → avaliar estado atual → sumário → ocorrência → destaque → evidência → exportação funciona em Chrome real.
- URL fornecida e lote não perdem a avaliação em ambiente descartável.
- Nenhum Critical/Important conhecido no incremento integrado. Não aprovar produção só por unit tests.

## Incremento 1 — execução passiva

RED confirmado: dois testes attached (no-pixels e full-evidence) chamavam probes; teste de política não publicava limitação de omissão. Implementação usa identidade privada de adapter attached, normalização vazia conservadora e diagnóstico não parcial publicado nas limitações do relatório. URL/owned permanecem ativos. Testes adicionais cobrem fallback, throw/timeout que não podem executar nem contaminar resultados; cobertura de captura e identidade preexistente preservada.

GREEN focado: `node --test test/background/run-audit.test.js test/report/diagnostic-policy.test.js`, 164/164, em 12/09. `git diff --check` verde. Ajustado teste de snippet cujo oráculo dependia de ser o primeiro bloco do relatório; agora exige o snippet correspondente, mantendo hash, remoção de conteúdo perigoso e codificação única. Revisão independente solicitada sobre os cinco arquivos congelados. Não houve Chrome, suíte ampla, empacotamento nem alteração de starter/UI nesta etapa.

Revisão concluída C=0/I=0/M=0, 17 verificações adicionais verdes do revisor. Integrado em `742ca45`, cinco arquivos exatos, node_modules excluído. Incremento 1 congelado. Próximo: roteamento da página atual (incremento 2), mantendo recovery histórico de cópias e rota explícita de URL.
