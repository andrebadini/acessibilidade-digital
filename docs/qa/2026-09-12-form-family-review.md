# Revisão da família 5.9 — formulários

Base: `1a897c4`. Norma do usuário, páginas impressas 22–25, lida diretamente; diagnóstico independente somente leitura de 5.9.1–8. Todos os itens abaixo são requisitos, salvo quando indicado. A existência de testes ou de uma regra não comprova cobertura completa.

| Item | Evidência e situação |
|---|---|
| 5.9.1 | Correção de conclusões em revisão: nome acessível sozinho não fundamenta mais aprovação/falha visual; campos ARIA são inventariados localmente. Resultado agregado inconclusivo, sem alvo por campo. Continua pendente um produtor de identificação visual confiável para ampliar a automação; não se considera este item integralmente desenvolvido. |
| 5.9.2/4/5 | Revisão contextual assistida; posição, descrição e previsibilidade não estão comprovadas automaticamente. Nenhum defeito novo demonstrado nessa rodada. |
| 5.9.3 | RED local: label com `for=other` aprovava input aninhado diferente; label implícito aprovava dois descendentes, embora só o primeiro fosse seu controle. Correção e revisão independente concluídas nesse escopo. |
| 5.9.6 | RED local: controles com mesmo name em formulários/documentos distintos eram agrupados globalmente. Chave passa a considerar documento e formulário proprietário, incluindo atributo form explícito. Ancestralidade insuficiente/associação não demonstrada permanece pendente. Revisão corrigiu também form vazio: não referencia form de id vazio. Revisão independente concluída no diff, sem novo achado. |
| 5.9.7 | Lacuna de automação: runtime conserva required dentro de form, consumidor pede required/requiredIndicator no nível do campo. A presença real da identificação perceptível não foi demonstrada por esse contrato. Não converter automaticamente a lacuna em falha. |
| 5.9.8 | Lacuna de automação: consumidor pede inputPurpose não produzido. Não inferir finalidade pessoal apenas do nome/tipo/atributo autocomplete. Revisão do alcance próprio da ABNT ainda necessária. |

Evidência de implementação 5.9.3/6: três REDs unitários observados antes da mudança; 18/18 testes de formulários após correção; conjunto focado forms+guidance+normalize 71/71. Chrome152 1/1 no teste novo `form-association-observation`: usa `label.control` e `input.form` como observação nativa, coleta e normaliza DOM/AX/runtime sem interação e exige alvos corretos, preservando HTML/foco/scroll. Não foi executada suíte ampla nem gerado pacote.

Fonte técnica de associação: [HTML label](https://html.spec.whatwg.org/multipage/forms.html#the-label-element) e [form owner](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#association-of-controls-and-forms). A fonte técnica não substitui o texto ABNT.

Guias 5.9.9/10/12/15/16/18: perfis didáticos específicos para erro, sugestão e exceção de segurança, alternativas de prevenção em formulário crítico, reentrada e suas exceções, validação sensorial/motora e distinção autenticação mínima/aprimorada. Não modificam conclusão técnica. Orientam ambiente autorizado/dados fictícios e não registrar credenciais nem provocar transações reais. 31/31 testes de orientação; revisão textual normativa independente ainda em fechamento.

Fechamento: revisão dos seis guias C=0/I=0, conferidos pelo revisor com impressas 23–25, sem execução de testes nessa revisão documental. Revisão do núcleo encontrou `form=""` confundido com `id=""`; Chrome confirmou que o segundo campo não tem proprietário. RED adicionado e corrigido; revisor repetiu 19/19 testes de formulários e repro normalizador→regra, sem novo achado no diff. Main executou 72/72 testes focados e novamente o E2E Chrome de associação. Sem conclusão global sobre formulários, especialmente as pendências explicitadas de 5.9.1/7/8.

## 5.9.1 — correção de inferência, posterior a c213a27

Revisor confirmou no Chrome que label com caixa de 1×1 e `clip-path:inset(50%)` permanece `hasRenderedBox:true`, `hidden:false`, `visibleText:Nome`. Portanto essas propriedades não provam identificação visual. A alternativa normativa exige considerar um rótulo identificador ou propósito visualmente evidente com nome acessível. Definição 3.42, impressa 7, também diferencia nome acessível de texto visível.

Novo RED: campo com somente aria-label recebia passed. Correção em validação: 5.9.1 registra uma pendência agregada sem alvos, inclui campos ARIA reconhecidos sem expandir o helper global e não confunde dados apagados/ausentes com inexistência de rótulo. As falhas de nome acessível continuam em 5.13.10; associação em 5.9.3. Testes existentes que confundiam esses requisitos foram transferidos ao consumidor correto, preservando detecção de nomes vazios.

GREEN local: 82 testes forms/visual/guidance; cinco testes selecionados de audit-model-v2 para inventário e correlação; Chrome1/1 no novo field-label-review. Não é ampliação da prova visual. Metadado histórico `mode:automated` permanece inalterado porque o validador atual confronta modo com o catálogo vigente; alteração desse metadado exige tratar compatibilidade dos relatórios anteriores. O resultado explícito `cantTell` e sua limitação informam a necessidade de revisão, sem alegar conformidade. Ampliação da observação visual permanece tarefa necessária antes de declarar concluída a revisão abrangente.

## 5.9.1 — encerramento da revisão no escopo deste incremento

Revisão independente encerrada no escopo do diff congelado, sem achado bloqueante demonstrado. Reexecução pelo processo principal no Chrome 152: 51/51 em `forms`+`visual`+`plain-language-guidance` (166/166 na família completa de regras), 62/62 em `audit-model-v2` e Chrome real 1/1 em `test/e2e/field-label-review.test.mjs`, que confirma tanto o caso nativo quanto o campo customizado `div[role=textbox][contenteditable=true]` sem alterar HTML, foco ou rolagem. Este encerramento vale para a correção de inferência; **não** declara o item 5.9.1 integralmente automatizado.

Cobertura ainda pendente, registrada para não ser confundida com conclusão:

- **Produtor de identificação visual ausente.** Nenhuma evidência coletada hoje prova rótulo percebido. Permanecem insuficientes: `hasRenderedBox`, `hidden:false`, `visibleText` e presença de `label` no DOM — o RED do revisor mostrou `label` com `clip-path:inset(50%)` mantendo caixa e texto. Até existir produtor confiável, a automação de 5.9.1 fica em `cantTell` agregado, sem alvo por campo.
- **Campos customizados com nome acessível vazio.** A preservação de detecção de nome vazio foi demonstrada para campos nativos testados, não para todo campo customizado. Em `div[role=textbox][contenteditable=true]`, o normalizador pode remover nome AX vazio por privacidade, e a regra de nome fica `cantTell`. Não enfraquecer a fronteira de privacidade para "resolver" isso; investigar cobertura dentro do contrato existente.
- **Integração 5.9.7 e 5.9.8** segue com as lacunas já descritas na tabela acima.

## Infraestrutura de teste — Chrome for Testing corrompido

Durante esta rodada, todo E2E de Chrome real falhou com `CDP_CLOSED`. Causa demonstrada, não suposta: o bundle registrado em `/private/tmp/audita-cft152-hqalvn` está **incompleto** — `Contents/Info.plist` ausente e `codesign --verify` reprovando com "code has no resources but signature indicates they must be present". Os processos Helper morriam com `EXC_BREAKPOINT`/`SIGTRAP`, e o navegador abortava com `GPU process isn't usable. Goodbye.` Reextrair o mesmo ZIP oficial `152.0.7977.64` restaurou `Info.plist` e os E2E passaram a executar (Chrome real 1/1 em `field-label-review`). O binário antigo não deve ser reutilizado.

O Chrome estável instalado (`152.0.7977.84`) **não** substitui o CFT: o log do próprio navegador traz `--disable-extensions-except is not allowed in Google Chrome, ignoring.`, então a extensão nunca carrega e a descoberta do service worker expira. O pin `Chrome/152.0.7977.64` do harness permanece inalterado.

Também foi corrigida uma divergência de infraestrutura no runner: treze E2E de Chrome real (incluindo `field-label-review`, `capture-visible-element`, `focus-observation-contract` e `form-association-observation`) não estavam classificados em `REAL_CHROME_E2E`, e `createTestPlan` interrompia a suíte inteira com `TEST_PLAN_UNCLASSIFIED_E2E` antes de executar qualquer teste. Todos foram classificados para execução serial; nenhuma asserção de teste foi enfraquecida.
