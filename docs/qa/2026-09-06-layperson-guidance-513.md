# Explicações práticas — ABNT 5.13.6, 5.13.7 e 5.13.8

Base: `4493ffb`. Incremento de apresentação; não altera regras, correspondências normativas, conclusões, modelo, evidências ou permissões.

## Necessidade observada

O PDF real registrado em `2026-09-06-capture-receipt-native.md`, página 4, mostrou uma ficha 5.13.7 com correção genérica (“Revise…”). O usuário pede explicações compreensíveis também para leigos e uma conferência contextual semelhante às imagens do WAVE, mas organizada principalmente pela ABNT.

Os sinais clicáveis e grupos ABNT já entregues não foram reabertos. O incremento melhora o texto compartilhado pelo detalhe do painel e pelo relatório:

- **5.13.6 — Ordem de leitura:** conferir texto contínuo, não apenas Tab; distinguir diferença visual de perda de sentido; exemplo de colunas independentes.
- **5.13.7 — Texto visível no nome acessível:** comparar o texto do controle com seu nome registrado, sem executar a ação; explicar o uso por voz, complementos permitidos e limites da comparação; exemplo hipotético Buscar/Pesquisar/Buscar produtos.
- **5.13.8 — Mensagens de status:** reproduzir somente uma tarefa segura e conferir a atualização sem deslocar o foco; não confundir anúncio estimado com prova de um aviso dinâmico.

Exemplos permanecem identificados como hipotéticos. Observações originais são preservadas; resultados pendentes continuam condicionais e resultados positivos não recebem uma obrigação de correção. O texto não promete dispensar ajuda técnica onde faltam condições para concluir.

## Referências de apoio à redação

Mapeamento ABNT/WCAG mantido do catálogo local `src/core/normative/nbr17225.js`, sem novas correspondências inferidas. Documentação explicativa oficial consultada em 06/09/2026:

- [W3C — Meaningful Sequence, 1.3.2](https://www.w3.org/WAI/WCAG22/Understanding/meaningful-sequence.html).
- [W3C — Label in Name, 2.5.3](https://www.w3.org/WAI/WCAG22/Understanding/label-in-name.html).
- [W3C — Status Messages, 4.1.3](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html).

Essas explicações informativas não substituem o texto normativo ABNT nem geram novos resultados.

## Verificação local

RED observado antes da implementação: `node --test test/report/plain-language-guidance.test.js` — 21 testes, 18 aprovados, 3 falhas nas orientações ainda genéricas.

GREEN focado:

```sh
node --test test/report/plain-language-guidance.test.js test/panel/panel-detail.test.js test/report/html.test.js test/review/report-view.test.js
```

113/113 aprovados, zero falhas ou skips. Log local: `/tmp/audita-guidance-513-green.log`. `git diff --check` aprovado. As alterações de produção são apenas três perfis textuais; a lógica de resultado e observação permanece intacta.

Não foi executada suíte ampla, Chrome real ou novo empacotamento neste incremento textual. Isso não constitui prova visual de um PDF novo: o gate nativo e a entrega atualizada pertencem ao próximo candidato de versão. O ZIP 1.1.4 não foi sobrescrito.

Revisão independente do diff congelado: aprovada, C=0/I=0/M=0. Revisor executou os 21 testes de orientação, todos aprovados, e conferiu os três perfis contra o catálogo local e as explicações oficiais W3C. Não houve rodada de correção. Essa conferência não é uma nova validação independente do texto integral da ABNT.
