# Horário de recebimento de cada PNG — checkpoint local

Base: `e9085e9` (beta 1.1.4 entregue). A alteração deste checkpoint **não está no ZIP 1.1.4**.

## Semântica implementada

Cada resposta bem-sucedida de `Page.captureScreenshot` recebe `metadata.captureReceivedAt`, em ISO UTC, amostrado imediatamente após o `await` e antes do hash assíncrono. É o horário local em que a extensão recebeu a resposta; não afirma o instante interno da rasterização nem certificação externa de tempo. O campo acompanha capturas integrais e miniaturas.

O modelo preserva o campo na projeção V1→V2, valida ISO canônico e exige pixels ou omissão de pixels por orçamento já validada. Dados antigos não adquirem valores. Mapas derivados não recebem uma data de raster inventada. O período de observação da página permanece separado.

O relatório vivo e o HTML/fluxo de impressão completo usam a apresentação compartilhada “Captura recebida pela extensão (UTC)”, com o aviso “relógio local; não certificado”. JSON conserva o metadado canônico. Quando ausente, permanece “Instante individual da captura: não registrado”.

## TDD e testes

- RED inicial: **6 falhas / 8 passes**, incluindo ausência do campo na captura, descarte na projeção e recusa pelo modelo. Log `/tmp/audita-capture-time-red.log`.
- GREEN final: **170/170** em capture-evidence, capture-receipt-presentation, evidence-provenance, audit-model-v2, integrity, report-view, HTML e batch-evidence-budget. Log `/tmp/audita-capture-time-green.log`.
- Regressões diretamente relacionadas: **315/315**, run-audit, chrome-adapter, observed-tab-runner, audit-pipeline e audit-input. Log `/tmp/audita-capture-time-callers.log`.
- `git diff --check` aprovado.

O teste de orçamento inicialmente montava um agregado inválido: hashes de fixture não selados, ausência do inventário de omissões e término global anterior à geração do filho. A fixture passou a usar os componentes reais de enriquecimento, remapeamento, orçamento e agregação, com ordem temporal válida. Nenhuma fronteira de orçamento foi alterada para acomodar o teste.

Provas: duas respostas recebem horários próprios; retângulo não capturável não recebe metadado; datas inválidas/objetos/acessores são recusados sem executar getter; modelo antigo preserva evidências; omissão por orçamento preserva a data; alterar/remover a data invalida a integridade canônica. O hash do PNG integral continua bytes-only; o hash de elemento e o de artefato omitido incluem os metadados, conforme algoritmo existente.

## Revisões independentes

- `capture_time_review`: matriz prévia e revisão final do diff congelado, **C=0/I=0**, 18 testes focados aprovados independentemente. Confirmou a impressão completa usando o mesmo HTML. Minors de cobertura: rejeição explícita de Promise CDP, campo inserido em mapa derivado e adulteração específica em elemento; guardas existentes atendem esses casos, sem falha funcional reproduzida.
- `capture_time_integrity_review`: revisão independente da migração e integridade, **C=0/I=0**, 6 testes integrados aprovados. Sem achados adicionais.

Não foram modificados consentimento, prova de documento, runner, armazenamento, regras normativas, permissões, estilos/CSP ou dependências.

## Ainda necessário antes da próxima entrega

Prova nativa de captura→persistência→exportação HTML/JSON/PDF com o metadado novo. A integração local não é apresentada como observação de carimbo em raster real. Sem Chrome, suíte ampla, `verify`, atualização de versão ou geração de ZIP neste incremento. O pacote 1.1.4 permanece intacto.
