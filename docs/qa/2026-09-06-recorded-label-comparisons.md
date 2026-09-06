# Comparação dos valores registrados — ABNT 5.13.7

Base: `3eea890`, depois da entrega 1.1.5. Motivação: no PDF real daquela beta, páginas 4–5, o procedimento ensinava a comparar texto visível e nome acessível, mas a observação principal ainda apresentava somente a justificativa genérica.

## Incremento

Na ficha 5.13.7, acrescentar o par **Texto visível registrado / Nome acessível registrado** em “O que foi observado”, sem substituir a justificativa original.

- Painel: somente evidências do elemento da ocorrência selecionada, pelo vínculo já validado.
- Relatório vivo, HTML interativo/imprimível e HTML independente: um par por evidência elementar correlacionada à ficha; os campos de um elemento nunca são combinados com o nome de outro.
- Texto vazio é “vazio (registrado sem texto)”; dado nulo/ausente é “não disponível”. Nenhum texto é inferido da imagem, do seletor ou de outro elemento.
- HTML usa escape; apresentação viva usa `textContent`. Exemplos sintéticos com `<rascunho>` e `&` são preservados como texto, sem criar marcação.
- Modelo, hashes, regras, conclusões, classificação, protocolo, esquema de detalhe e permissões não mudam. Trata-se de apresentação de dados já registrados/sanitizados, não de nova comparação normativa automatizada.

Arquivos de produção: `src/core/report/plain-language-guidance.js`, `src/core/report/html.js`, `src/panel/panel-detail.js` e `src/review/report-view.js`.

## Testes

RED: três testes novos alcançaram os consumidores e falharam pela ausência dos pares; um quarto RED demonstrou a ausência no HTML independente. Erros anteriores de montagem da fixture (campos de acessibilidade incompletos e declaração legada sem prova de falha) foram corrigidos somente no teste, antes desse RED. Não houve alteração de validação para aceitá-los; a fixture usa resultado pendente.

GREEN: **173/173**, zero falhas/skips:

```sh
node --test test/panel/panel-detail.test.js test/review/report-view.test.js test/report/plain-language-guidance.test.js test/report/html.test.js test/panel/panel-result-bundle.test.js test/panel/panel-view.test.js
```

Log: `/tmp/audita-label-comparison-green.log`. `git diff --check` aprovado. Os testes verificam os pares separados, vazio versus indisponível, escape no HTML, ausência de mistura entre elementos e preservação do modelo e da pendência.

Revisão independente do diff congelado concluída: C=0/I=0. O revisor executou 96/96 testes nos três arquivos alterados. Refinamento menor registrado no backlog: acrescentar um identificador visível ou link à evidência quando a ficha contiver vários pares. A associação atual é por artefato, sem misturar os valores. A revisão não substitui a validação visual nativa/PDF.

Sem suíte ampla, Chrome ou ZIP neste incremento. A beta 1.1.5 entregue continua intacta; esta melhoria de código ainda não faz parte daquele pacote. A prova nativa visual/PDF do novo par pertence ao próximo candidato de entrega.
