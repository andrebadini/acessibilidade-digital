# Estado dos 12 critérios de conclusão — 1.1.19

Registro de 16/09/2026, na revisão `dad1cda` (manifest 1.1.19, artefato `audita-acessibilidade-1.1.19.zip`,
SHA-256 `0e429e226e07e5de365e1fed6542398f1d2acb8e80eada4babb78e0e0af14ec9`). Cada linha diz **o que foi
medido**, **como** e **o que falta**. Onde não há medição, está escrito que não há — este documento não
transforma leitura de código em teste de comportamento.

| # | Critério | Estado | Evidência e limite |
|---|---|---|---|
| 1 | Percurso principal sem instabilidade | **Parcial** | O percurso completo roda numa sessão a partir dos **bytes empacotados** (`mandatory-journey-mv3`, 1/1, com o diagnóstico `journey ok; formats=html,pdf,csv,json`). Mas uma execução da fase serial falhou em *"the side panel must not resize itself during the journey"* e as duas seguintes passaram: é **intermitente**, e a triagem em curso é que decide se a causa é do produto ou do tempo do teste. Enquanto isso, o critério não fecha. |
| 2 | Relatório abre e exportações funcionam | **Atendido** | Quatro formatos com recibo `complete` e sha256, medidos duas vezes a partir do pacote extraído: fixture (HTML 321 KB, PDF 1,03 MB, CSV 81 KB, JSON 347 KB) e Google (HTML 325 KB, PDF 958 KB, CSV 83 KB, JSON 359 KB). Inspeção visual do relatório renderizado feita por captura. |
| 3 | Destaque corresponde ao elemento e documento corretos | **Atendido** | `highlight-marking-mv3` 1/1 e `page-markers-signals-mv3` 1/1 a partir do pacote, com a caixa marcada sobre o elemento auditado; o percurso exige `z-index 2147483647`, área visível e cobertura do elemento. |
| 4 | Inspeção automática não altera visivelmente a página | **Atendido** | O percurso compara rolagem, foco e a marcação do autor antes e depois e passa; `capture-visible-element` 1/1 exige que a captura **preserve a viewport** — o ponto exato onde o Chrome 152 já havia mostrado `clientWidth 1265 → 1280`. Limite conhecido: captura de regiões fora da viewport. |
| 5 | Evidências autorizadas, corretas e correlacionadas | **Atendido** | `url-pixel-consent-mv3` 1/1 (pausa, one-shot, reinício do trabalhador, limpeza só das abas próprias) e `capture-visible-element` 1/1, executados a partir do pacote. `batch-pixel-consent-mv3` falhou por orçamento de 90 s e **passa em 15 s** com 420 s: exportação de lote em evidência completa funciona. |
| 6 | Contagens distinguem falhas, suspeitas e checklist | **Atendido** | Medido no produto entregue: painel e relatório dizem o mesmo — 2 falhas/4 ocorrências, 6 suspeitas/8 ocorrências, 99 pendências de checklist (fixture); 0/1/3(4)/9 e 109 (Google). Checklist por **item**, não por elemento. |
| 7 | Conclusões ABNT respeitam obrigatoriedade, alternativas e limites | **Atendido** | Texto de 5.9.1 e 5.9.7 lido no PDF do usuário (impressas 22–23). Zero "Inconformidade ao item …" no Google (0 falhas) e no relatório de fixture apenas para as duas falhas reais (5.13.10, 5.9.3); 5.9.7 sai como "Verificar o item 5.9.7". Três revisões independentes mediram a retirada das condenações indevidas. |
| 8 | Interface e relatório completos, claros, usáveis por leigos | **Parcial** | Inspeção do relatório entregue confirma sumário executivo, rosca com "não é uma nota de acessibilidade", fórmula e denominador explícitos, cobertura à parte, quatro grupos nomeados com texto além da cor, prioridades, registro de decisão, mapas de anúncios, matriz dos 146 itens, metodologia com versão e hashes. Não fiz teste de usabilidade com pessoa leiga. |
| 9 | Recursos obrigatórios implementados | **Parcial** | Verificados por execução: percurso, exportações, destaques, personas sob CSP, auditoria de várias URLs (`audits exactly two explicit URLs invisibly in one sanitized no-pixels batch report`, medido pelo revisor). Verificados por leitura (existe e é alcançável, não código morto): menu de contexto (`contextMenus` + `service-worker.js:2129/2137`) e o caminho de lote (`PANEL_START_BATCH_AUDIT` → `startBatch`). Não verificado por mim: módulo de leitor de tela com legendas. |
| 10 | Sem falha Critical/Important conhecida | **Pendente** | As revisões da 1.1.16, 1.1.17 e 1.1.18 acharam 1 Critical e 6 Important, **todos corrigidos** e verificados por medição. A revisão da 1.1.19 (com a triagem das 11 falhas da fase serial) está em curso: é ela que fecha ou reabre este critério. |
| 11 | Achados menores documentados | **Atendido** | Trilha `docs/qa/2026-09-13-continuity-and-e2e-triage.md` e `docs/qa/2026-09-12-form-family-review.md`: M2 (corrigido), remediação por ocorrência no cartão (analisado), vocabulário português do `SENSITIVE_KEY` (decisão pendente do usuário), técnicas restantes de ocultação em 5.9.1, `inputPurpose` de 5.9.8, alvo de `aria-labelledby` em shadow root, rótulo em contêiner com rolagem, limitação de captura, e as 8 falhas obsoletas do `service-worker` com causa estabelecida. |
| 12 | Versão empacotada testada em Chrome real | **Atendido** | Os 199 arquivos do zip são byte a byte idênticos à árvore (conferido por mim em 1.1.17, 1.1.18 e 1.1.19, e por dois revisores de forma independente), **e** o pacote extraído foi executado em Chrome real: percurso completo, exportações, destaques, sinais, privacidade de URL e persona sob CSP. A única etapa não exercitada é o ato de descompactar em si, que é o que o `unzip` faz. |

## O que impede declarar produção agora

1. **Critério 10** — a revisão da 1.1.19 e a triagem das 11 falhas da fase serial não terminaram. Nenhuma versão desta sessão foi declarada candidata com falha Critical/Important aberta, e não será agora.
2. **Critério 1** — a intermitência do painel redimensionando, medida uma vez em três execuções, precisa de causa estabelecida.
3. **Critério 9** — falta a verificação do módulo de leitor de tela com legendas.

## Decisões que dependem do usuário, não de mim

- **Vocabulário do portão de privacidade** (`SENSITIVE_KEY`): ampliar para "senha", "sessão", "chave" e afins muda a redação de campos legítimos que contenham esses termos. O efeito é sempre fail-closed, mas a lista é uma decisão de produto, e está registrada como tal desde a rodada em que a allowlist de `contenteditable` foi definida.
- **Publicação**: nenhuma ação externa de distribuição foi executada, e nenhuma será sem autorização específica.
