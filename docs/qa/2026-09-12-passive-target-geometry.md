# Área de acionamento na observação passiva — diagnóstico e próximo contrato

Base inspecionada: `f482c56`. A análise inicial abaixo antecede a implementação. O registro de execução ao final distingue os testes do escopo das pendências de entrega.

## Constatação reproduzível no código

`run-audit.js` entrega `{}` à normalização de probes para o adapter attached passivo. Logo, o incremento anterior, que preserva medidas independentemente dos limiares, não produz novas medidas no percurso da página atual. `page-collector.js` já lê `getBoundingClientRect()` sem interação; seus retângulos runtime são associados ao nó na normalização. Não é necessário executar o runner dinâmico para obter essas dimensões.

Não reutilizar diretamente o método dinâmico `measureTargetSizes`: ele lê a página, lê a árvore de frames e depois resolve seletores/backend IDs em operações distintas. Além de limitar a seleção ao documento principal, essa rota adicionaria uma nova associação temporal desnecessária. Também não usar `node.rect` como substituto: ele pode proceder dos bounds do DOMSnapshot, com precedência sobre o retângulo runtime.

## Referência normativa

Corpo da ABNT fornecida, página impressa 20 (PDF, índice 29): 5.8.6 é recomendação de área aprimorada 44×44 CSS px; 5.8.7 é requisito de área mínima 24×24 CSS px. Ambos admitem alternativas. Tamanho insuficiente isoladamente não prova infração: espaçamento, equivalência, contexto textual, agente de usuário e essencialidade precisam ser considerados conforme cada item.

A orientação suplementar do W3C não substitui a ABNT. Ela explicita cuidados de medição: a [caixa de um componente que quebra linhas](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) não deve ser interpretada simplesmente como a união vertical de linhas; [sobreposição de alvos com ações diferentes](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html) não integra indiscriminadamente sua área útil.

## Fronteira proposta, ainda não implementada

- Reaproveitar a identidade normalizada do próprio nó e geometria runtime da mesma coleta, sem nova busca por seletor, navegação, foco, scroll, emulação ou raster.
- Não converter qualquer bounding box em prova de área acionável. Recortes, transformações, fragmentação e sobreposição são casos concretos a representar nas fixtures antes de habilitar aprovação automática.
- Uma indicação de elegibilidade estrutural (controle nativo, uma caixa, ausência de recorte/transformação) é necessária para uma primeira implementação conservadora, mas não basta por si só para resolver sobreposição. Não chamar esse booleano de prova de área efetiva.
- Medida ou prova ausente continua inconclusiva, sem transformar o checklist em ocorrência detectada. Exceção não verificada permanece `unknown`, nunca `none`.
- Manter independência dos limiares e cobertura de todos os candidatos: um alvo medido não aprova os demais. Runtime incompleto continua impedindo aprovação agregada.

## Matriz antes da implementação

1. Controle simples 30×30, área comprovada: mínimo aprovado; aprimorado inconclusivo se nenhuma exceção for conhecida.
2. Controle simples 44×44: ambos aprovados; 20×20 com exceções desconhecidas: ambos inconclusivos, não falhas.
3. Caixa externa grande com recorte, quebra de linha, transformação ou sobreposição: não aprovar com base somente no retângulo externo.
4. Retângulo genérico grande sem geometria runtime: não usá-lo como fallback.
5. Alvo medido junto de candidato sem medida, ou runtime parcial: não aprovar o conjunto.
6. Seletores iguais em frames distintos: conservar identidades e medidas independentes.
7. Percurso attached: nenhum runner/probe interativo ou restauração de viewport/foco/scroll executado.

Revisão prévia independente somente leitura recomendou reutilizar a coleta existente e definiu os riscos de associação, exceção e cobertura. A análise principal acrescentou a exigência de testar sobreposição antes de habilitar a aprovação. Não houve alteração de código de produção ou execução de suíte neste diagnóstico. Capturas passivas e demais incrementos aprovados permanecem fora deste escopo.

## Execução do incremento

REDs observados: attached ignorava medida da própria coleta; Chrome real não emitia a medida; em seguida, uma sobreposição estreita por pseudo-elemento ancestral escapava dos pontos amostrados. A implementação coleta `targetSizeRect` apenas para controles nativos visíveis com geometria simples, sem recorte/transformação/sobreposição observada. Mantém desconhecidas as exceções. O campo passa pela associação runtime existente, não por uma nova consulta de seletor; a rota passiva o encaminha à normalização dos limiares sem executar probes interativos.

GREEN: 10 testes attached (inclui ausência de medidas/runtime parcial), 97 testes de normalização/regras/contrato e um teste Chrome 152 com múltiplas situações geométricas e preservação de estado. Revisão independente encontrou um Important: um botão 44×44 em iframe com scale(.25) aprovava apesar de aparecer 11×11. RED confirmado e corrigido: não emitir medida para subframes sem prova da geometria externa. Revisor repetiu o E2E 1/1 e confirmou ausência de C/I remanescentes **neste escopo**; diff-check verde. Não representa aprovação de todos os tipos de controle; geometrias não suportadas, inclusive composição entre frames, continuam necessitando revisão. Nenhum ZIP gerado.

Limites conservadores para evolução: controles fora do viewport, controles customizados, caixas arredondadas cujos pontos externos não recebem ponteiro, pseudo-elementos com geometria não observada e recortes/transformações não recebem certificação por esta rota. O restante da auditoria continua; ausência dessa medida não é falha normativa. A lista não significa que esses controles sejam inacessíveis. Ampliar a cobertura com fixtures de navegador, sem remover as proteções demonstradas.

### Falha separada descoberta na regressão

`node --test test/background/run-audit.test.js`: 167/168. Falha `lets true ARIA presence win over false node.form state and ignores aria-selected on a button` reproduzida também no HEAD original, exportado com `git archive HEAD` em `/tmp/audita-baseline-E8zfhX`, antes de instrumentação local. Logo, não é regressão da medição passiva.

Instrumentação **somente na cópia temporária**, com fixture sintética, localizou a rejeição: `enrichAuditForReport` → `createAuditModel` → `validateCoreRuleTargets`, regra `component-contrast`. O produtor já emite revisão concreta `inactive-component-unconfirmed` para `aria-disabled=true`, mas a política de remediação não contempla esse alvo. Tratar na próxima correção como incompatibilidade produtor/consumidor que pode impedir relatório, com TDD e preservação da validação normativa. Não declarar suíte do arquivo inteiramente verde nem C/I global zero enquanto essa pendência existir.
