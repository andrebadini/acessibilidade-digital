# Proveniência de página nas fichas de evidência

## Achado observado

Na entrega real `audita-6c537ac1-a8c9-4470-b2e5-26dbd5e7f037-20260905T124138744Z`, o anexo HTML/PDF mostrava “URL: não registrada” e “Horário: não registrado”. O JSON continha 14 evidências, incluindo PNGs em 11 elementos e na captura integral; portanto a ausência não era explicada somente por evidências estruturais sem imagem.

Todas as evidências estavam correlacionadas a `page-1`, que registrava URL final e período de observação. `mediaUrl` representa a URL de uma mídia do elemento, não a URL da página. O campo `observedAt` consultado pelo relatório não existe no contrato fechado atual de evidência. A projeção copiava as evidências sem correlacionar os dados da página.

## Correção limitada à apresentação

- `projectEvidenceProvenance` correlaciona exclusivamente `evidence.pageId` a uma única página. Ausência ou duplicação da identidade produz valores indisponíveis; não há fallback para página zero ou campos globais.
- A URL é apresentada como “URL da página observada”, somente quando `finalUrlObserved` é verdadeiro. A URL solicitada não é tratada como observada.
- `startedAt`–`endedAt` são apresentados como “Período observado da página”, nunca como instante individual da captura.
- “Instante individual da captura: não registrado” declara a limitação existente. A URL da mídia permanece separada.
- A proveniência é acrescentada apenas à ReportView e ao HTML. Coleta, schema fechado, armazenamento, modelo canônico e hashes não foram alterados.
- O mesmo texto é aplicado ao relatório vivo, detalhes técnicos e anexos do HTML utilizado pelo PDF, além do anexo do HTML independente. Valores são texto literal no DOM e escapados no HTML.

## RED e GREEN

- RED antes da implementação: **5/5 falharam**, cobrindo correlação entre duas páginas, ausência/duplicação, URL solicitada versus observada e saída das fichas. Log: `/private/tmp/audita-evidence-provenance-red.log`.
- A primeira rodada completa passou **59/60**; o seletor do novo teste do anexo também alcançava fichas posteriores de metodologia. A delimitação foi corrigida para fichas `evidencia-N`; um erro de escape da expressão regular nessa correção foi identificado e corrigido antes do GREEN final.
- GREEN final: **60/60**, zero falhas/cancelamentos/skips, em `/private/tmp/audita-evidence-provenance-confirmed.log`.
- Comando focado: `node --test test/report/evidence-provenance.test.js test/review/report-view.test.js test/report/html.test.js`.
- `git diff --check` aprovado para os arquivos rastreados alterados. Nenhum Chrome, suíte ampla, commit ou ZIP executado nesta fatia.

Os testes verificam URLs/períodos distintos em duas páginas, preservação da URL da mídia, ausência de mutação do modelo, projeção congelada, proveniência indisponível para página ausente/ambígua e escape HTML.

## Limite remanescente

O instante exato de cada captura não foi coletado no modelo atual e não pode ser reconstruído a partir do período da página ou do horário de geração. Atender a um requisito de carimbo individual exato exige uma alteração futura explícita de coleta e contrato, fora desta correção.
