# Resultados compreensíveis — plano incremental

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. A autorização do usuário permite execução autônoma e paralelismo com arquivos separados.

**Goal:** cumprir A–H preservando a beta 1.0.10 e entregando navegação compreensível antes de retomar as pendências de infraestrutura.

**Architecture:** projeções de apresentação sobre o modelo imutável existente. Guia didático puro compartilhado; filtros locais não alteram modelo, hash ou exportações.

**Tech Stack:** HTML/CSS/JavaScript ES modules, Chrome MV3, node:test somente no desenvolvimento.

**Spec:** `docs/superpowers/specs/2026-09-05-public-friendly-results-design.md`.

## Global Constraints

- Sem login, serviço remoto novo ou bibliotecas instaladas pelo usuário.
- Não alterar consentimento, pixel gates, evidência assinada, mapeamentos normativos ou limpeza fora da etapa própria.
- Testes focados durante implementação; Chrome e ZIP apenas no candidato.
- Estágio/commit por lista exata; node_modules e pacotes fora do estágio.

## Etapa 1 — painel agrupado

Arquivos: src/panel/panel-view.js, panel-state.js, panel.js, panel.css; testes correspondentes em test/panel.

- [ ] RED de quatro cartões emitindo FILTER_SET/result; reducer conserva seleção válida e a projeção oculta os outros grupos.
- [ ] RED de dois checks para o mesmo item produzindo um details[data-abnt-group] com ambas as ocorrências, sem perda ao abrir detalhe.
- [ ] RED de Refazer auditoria voltando à escolha de origem sem disparar captura/apagar a avaliação anterior.
- [ ] Implementar grupo result nos filtros, expansores ABNT e intenção NEW_AUDIT pelo controlador.
- [ ] Corrigir rótulo do denominador e explicação da cobertura sem alterar sua fórmula.
- [ ] `node --test test/panel/panel-view.test.js test/panel/panel-state.test.js`; regressões diretas do controlador e diff-check antes do checkpoint.

## Etapa 2 — guia e referência curta

Arquivos exclusivos do guia: src/core/report/plain-language-guidance.js e test/report/plain-language-guidance.test.js. Integração: src/panel/panel-detail.js, src/review/report-view.js, src/core/report/html.js e testes relacionados.

Contrato congelado: `accessibilityGuidance({itemId,title,outcome,observed,correction})` retorna `{impact,observed,correction,reviewSteps,example}`. Strings de apresentação; reviewSteps array de strings. Nenhuma alteração de outcome. Fato observado preservado; exemplo hipotético.

- [ ] RED/GREEN do guia por famílias de requisitos e resultados incertos/positivos.
- [ ] RED para referência curta somente em falhas confirmadas; pendência e positivo sem acusação de inconformidade.
- [ ] Conectar guia à apresentação do detalhe e do relatório; manter texto técnico original consultável.
- [ ] Rodar somente testes de guia/detalhe/report-view/html envolvidos.

## Etapa 3 — relatório compacto

Arquivos: src/review/report-view.js, review.css, src/core/report/html.js, report.css.js e respectivos testes.

- [ ] RED de cartões métricos filtrantes e issues recolhidas, com evidências, mapa e formulários ainda acessíveis.
- [ ] Agrupar/verificar uma vez, usar referência curta por item, remover repetições de referência por ocorrência.
- [ ] Manter exportações completas, apresentação de impressão legível e todos os dados técnicos disponíveis.
- [ ] Validar foco/teclado, contagens, links de evidência e cores acompanhadas de texto.

## Etapa 4 — pendências originais

- [ ] Reconciliar o código e checklist dos planos originais com a beta entregue.
- [ ] Executar plano existente docs/superpowers/plans/2026-09-05-retention-r3e-runtime.md após ler seus contratos. Preparar separadamente origens manual/pós-exportação e UI sem ampliar o diff das etapas visuais.
- [ ] Resolver pendência nativa de captura do harness com reprodução antes de alterar produção.
- [ ] Atualizar matriz de aceite da meta; somente o que tem prova real recebe concluído.

## Fechamento

- [ ] Revisões independentes das fronteiras críticas com C=0/I=0.
- [ ] Confirmar Chrome for Testing antes da suíte ampla/E2E do candidato; nunca npm test para descobrir ambiente ausente.
- [ ] Verificar percurso painel → auditoria → grupo → ocorrência → evidência → relatório → quatro formatos → refazer; retenção e privacidade também no candidato.
- [ ] Gerar versão instalável e documentar limitações remanescentes sem declarar certificação normativa.
