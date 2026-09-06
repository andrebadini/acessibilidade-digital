# Revisão humana compacta e guiada

Base 0691c9d. Escopo de apresentação: review.js, report-view.js, review.css e testes da revisão. Nenhuma mudança no modelo, respostas, persistência ou regras normativas.

- Formulários agrupados num expansor e cada ocorrência em details fechado.
- Guia compartilhado explica impacto, observação, passos e exemplo hipotético antes da resposta.
- Incerteza explicitamente orientada para “não foi possível determinar”, sem autoaprovar.
- Código e imagens de revisão recolhidos; links para captura integral abrem o anexo e movem foco.
- Próxima revisão abre o formulário antes de focar seu summary.
- Controles gerais continuam fora do expansor. Regenerar lê a mesma escolha atual de exclusão que o botão principal.
- Impressão nativa não repete formulários de edição: achados, decisões persistidas e evidências continuam no relatório canônico. Para incorporar novas decisões, gerar relatório atualizado.

RED observado: formulário antigo article e callback de regenerar omitindo preferência. GREEN: **52/52**, log `/private/tmp/audita-review-guided-green.log`; revisão independente solicitada. QA visual e acessibilidade nativa pertencem ao candidato.
