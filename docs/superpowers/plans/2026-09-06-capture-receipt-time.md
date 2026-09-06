# Horário individual de recebimento da captura — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Execução local, revisão independente somente sobre diff congelado. A autorização de decisões autônomas e o método incremental do usuário substituem novas rodadas de aprovação.

**Goal:** Registrar e apresentar o horário local de recebimento de cada PNG, sem inventar o instante interno do raster nem datas de evidências antigas.

**Architecture:** Campo opcional `metadata.captureReceivedAt`, ISO UTC canônico, atribuído imediatamente depois da resposta bem-sucedida de `Page.captureScreenshot`, antes do hash assíncrono. V1→V2 preserva o campo; modelo fechado valida-o e a cadeia canônica já o protege. Apresentação compartilhada entre relatório vivo, HTML e impressão distingue recebimento da captura e período de observação.

**Tech Stack:** JavaScript ESM local, Node test runner, Chrome MV3/CDP existentes; nenhuma dependência nova.

**Spec:** Contrato reduzido abaixo; requisito original de carimbo de data/hora por evidência e limite documentado em `docs/BETA-BACKLOG.md`.

## Contrato e limites globais

- Base `e9085e9`; pacote entregue 1.1.4 não será alterado.
- O valor é `new Date(Date.now()).toISOString()` após o `await cdp.command(...)`; não é data da exportação, início da auditoria nem timestamp certificado do navegador.
- Sem novo relógio injetável no produto, chamada de rede ou efeito na página. O teste controla `Date.now` no processo isolado do arquivo.
- PNG recusado/falha de comando não gera evidência com carimbo. Registro técnico sem raster não recebe o campo.
- Campo ausente continua ausente em modelos antigos: sem migração que fabrique data ou altere hashes de registros legados.
- Campo presente aceita somente ISO UTC canônico e exige PNG ou estado já validado de pixels omitidos por orçamento. Mapas derivados não ganham um timestamp de raster próprio.
- O hash de pixels da captura integral permanece o hash dos bytes. A data integra o hash do modelo canônico; miniaturas também têm metadados no hash do artefato, conforme contrato existente.
- Não alterar consentimento, prova de documento, runner, storage, permissões, ABNT, regras, PDF engine nem política de retenção.
- Testes focados, `git diff --check`, revisão independente C=0/I=0 antes de checkpoint. Sem suíte ampla, Chrome ou ZIP neste subincremento; integração nativa no próximo candidato.

## Task 1 — Coleta e modelo canônico

**Files:** `src/browser/capture-evidence.js`, `src/core/report/audit-model.js`, `src/core/report/closed-schema.js`; testes novos em `test/evidence/capture-evidence.test.js` e `test/report/capture-receipt-presentation.test.js`. `test/report/audit-model-v2.test.js` e `test/report/integrity.test.js` são regressões executadas sem edição.

**Interfaces:** assinaturas públicas permanecem iguais. `captureFullPage`/`captureElement` retornam `metadata.captureReceivedAt`; `projectV1Evidence` preserva esse campo opcional; `createAuditModel` valida data e presença de raster. Nenhuma extensão de callback/autoridade.

- [x] RED: relógio literal antes e depois da resposta; `assert.equal(result.metadata.captureReceivedAt, '2026-09-06T12:00:02.000Z')`. Repetir para captura integral e elemento; resultado não capturado não contém metadado.
- [x] RED: adicionar data válida à fixture, migrar/validar e exigir valor exato; datas inválidas, valores não textuais e timestamp em evidência sem pixels são recusados sem eco do conteúdo. Modelo antigo não adquire a propriedade.
- [x] GREEN: adicionar a atribuição após a resposta e a chave na projeção/allowlist. Validar via `canonicalInstant` existente e exigir `dataUrl` ou `pixelState === 'omitted-budget'` validado.
- [x] Provar integridade: selar fixture com a data; alterar somente a data e exigir rejeição de `verifyAuditIntegritySnapshot`, preservando o hash dos bytes da imagem.
- [x] Executar `node --test test/evidence/capture-evidence.test.js test/report/audit-model-v2.test.js test/report/integrity.test.js`.

## Task 2 — Apresentação transparente

**Files:** `src/core/report/evidence-provenance.js`, `test/report/evidence-provenance.test.js`, `test/report/capture-receipt-presentation.test.js`, `test/review/report-view.test.js` (DOM existente reutilizado para a prova da apresentação viva).

**Interfaces:** projeção acrescenta a chave apenas quando registrada no artefato. `evidenceProvenanceRows` usa “Captura recebida pela extensão (UTC)” e identifica “relógio local; não certificado”. A alternativa antiga continua “Instante individual da captura: não registrado”. Não emprestar data da página, de outra evidência ou da fonte de um mapa.

- [x] RED: integração HTML/projeção não aceita nem mostra o campo. Após GREEN, testes complementares conferem duas páginas, datas diferentes, mapa sem data emprestada e DOM vivo; captura antiga permanece sem data.
- [x] GREEN: `...(evidence.metadata?.captureReceivedAt ? { captureReceivedAt: evidence.metadata.captureReceivedAt } : {})` na projeção e linha condicional na função compartilhada. Nenhuma alteração de estilos/CSP ou duplicação da data na ficha.
- [x] Executar testes de proveniência e apresentação relacionados, depois os oito arquivos de testes focados/regressão juntos e `git diff --check`.
- [x] Congelar diff, solicitar revisão única do fluxo e segunda revisão da fronteira crítica de integridade. Ambas C=0/I=0, sem correção produtiva necessária. QA e limites registrados; checkpoint por lista exata, sem ZIP/node_modules.

## Prova seguinte (fora deste checkpoint)

No próximo gate nativo de entrega: usar duas capturas reais e verificar datas distintas ou individualmente registradas, persistência/JSON/HTML/PDF da mesma revisão, inexistência de carimbo em no-pixels e integridade após retenção por orçamento. Não apresentar coleta real como verificada apenas pelos testes locais deste incremento.

**Checkpoint nativo concluído em 06/09:** cenários completos e sem imagens 1/1 cada; 12 datas reais idênticas no armazenamento, JSON, fichas vivas, HTML e PDF extraído/inspecionado. O orçamento mantém a prova local com componentes reais do checkpoint anterior, sem alegação de omissão por orçamento reproduzida no Chrome nesta rodada. Ver `docs/qa/2026-09-06-capture-receipt-native.md`. Pacote 1.1.4 preservado; sem nova entrega neste checkpoint.
