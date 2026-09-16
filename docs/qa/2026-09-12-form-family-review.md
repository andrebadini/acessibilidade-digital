# Revisão da família 5.9 — formulários

Base: `1a897c4`. Norma do usuário, páginas impressas 22–25, lida diretamente; diagnóstico independente somente leitura de 5.9.1–8. Todos os itens abaixo são requisitos, salvo quando indicado. A existência de testes ou de uma regra não comprova cobertura completa.

| Item | Evidência e situação |
|---|---|
| 5.9.1 | Correção de conclusões em revisão: nome acessível sozinho não fundamenta mais aprovação/falha visual; campos ARIA são inventariados localmente. Resultado agregado inconclusivo, sem alvo por campo. Continua pendente um produtor de identificação visual confiável para ampliar a automação; não se considera este item integralmente desenvolvido. |
| 5.9.2/4/5 | Revisão contextual assistida; posição, descrição e previsibilidade não estão comprovadas automaticamente. Nenhum defeito novo demonstrado nessa rodada. |
| 5.9.3 | RED local: label com `for=other` aprovava input aninhado diferente; label implícito aprovava dois descendentes, embora só o primeiro fosse seu controle. Correção e revisão independente concluídas nesse escopo. |
| 5.9.6 | RED local: controles com mesmo name em formulários/documentos distintos eram agrupados globalmente. Chave passa a considerar documento e formulário proprietário, incluindo atributo form explícito. Ancestralidade insuficiente/associação não demonstrada permanece pendente. Revisão corrigiu também form vazio: não referencia form de id vazio. Revisão independente concluída no diff, sem novo achado. |
| 5.9.7 | Corrigido no contrato de observação: o runtime reporta o estado obrigatório no nível do registro e o consumidor volta a julgar coerência de estado. Chrome real confirmou `required` nativo, `aria-required` e ausência em campo customizado. A identificação perceptível continua sem produtor e o item permanece em revisão, sem converter a lacuna em falha. |
| 5.9.8 | Corrigido no contrato de observação: a finalidade declarada passa a ser lida apenas do `autocomplete` do próprio campo; declaração estruturalmente inválida é falha confirmada e campo sem declaração permanece em revisão. Nome, tipo de entrada e contexto continuam proibidos como prova. |

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
- **Campos customizados editáveis são anônimos no instantâneo.** Caracterização no Chrome mostrou que um `div[role=textbox][contenteditable=true]` chega ao consumidor sem `id`, sem `accessibleName` e sem resolução de `aria-labelledby`, porque `contentEditableRootAttributes` mantém apenas uma allowlist mínima (`contenteditable`, `role`, `tabindex`, `aria-labelledby`, `aria-describedby`) e `preserveAccessibleText` cobre hoje somente `input`, `select` e `textarea`. O nome vazio de campo nativo continua observado normalmente. A consequência prática é que 5.9.1 e 5.13.10 não conseguem culpar nem aprovar esses campos, e é por isso que o item permanece em revisão agregada. Recuperar o nome acessível desses campos exige uma decisão explícita de fronteira de privacidade — o nome vem do autor da página, mas o conteúdo editável é do usuário — e não foi feita nesta rodada nem deve ser feita por atalho. Registrado como limitação delimitada, não como conclusão do item.
- **Identificação perceptível de obrigatoriedade (5.9.7).** O estado obrigatório agora chega ao consumidor, mas nenhum produtor demonstra que a obrigatoriedade é perceptível. O item continua em `cantTell` enquanto esse produtor não existir; a presença do atributo não é prova de percepção.

## 5.9.7 e 5.9.8 — fechamento da lacuna de integração

Dois REDs reais foram observados no Chrome antes das correções, ambos pelo consumidor final e não por dados injetados no teste:

- 5.9.7: `native required state must survive normalization` — o coletor guardava a obrigatoriedade em `record.form.required` e o consumidor lia `required` no nível do registro, então todo campo obrigatório caía em coleta ausente.
- 5.9.8: `declared must expose only its declared purpose` — o consumidor exigia `inputPurpose`, que nenhum produtor emitia, então o item nunca saía de coleta ausente.

Correções, com a fronteira normativa preservada:

- O coletor passa a reportar `required` no nível do registro para controles rotuláveis nativos: a propriedade IDL quando não há declaração ARIA, o token ARIA quando existe, e nada quando o token é malformado — deixando o consumidor relatar estado inválido em vez de inventar booleano. Campo customizado não recebe essa observação.
- A finalidade do campo passa a ser derivada exclusivamente da declaração `autocomplete` do próprio campo, dentro da regra. Nome, tipo de entrada, texto ao redor e contexto de página continuam proibidos como prova. `autocomplete="off"` é declaração estrutural sem finalidade: não falha e também não aprova.
- A regra 5.9.8 preserva o caso de falha real (declaração estruturalmente inválida) e mantém em revisão os campos sem declaração, sem multiplicar a pendência e sem inventar finalidade pessoal.

GREEN local: 634/634 em regras, integração, core e relatório; 20/20 em formulários; Chrome real 4/4 somando `field-label-review`, `form-association-observation`, `required-field-observation` e `input-purpose-observation`. Nenhum alvo novo é produzido por suspeita; a aprovação de 5.9.8 só ocorre quando todos os campos aplicáveis têm declaração válida observada. Metadado `mode:automated` permanece inalterado pelo mesmo motivo de compatibilidade já registrado.

## Infraestrutura de teste — Chrome for Testing corrompido

Durante esta rodada, todo E2E de Chrome real falhou com `CDP_CLOSED`. Causa demonstrada, não suposta: o bundle registrado em `/private/tmp/audita-cft152-hqalvn` está **incompleto** — `Contents/Info.plist` ausente e `codesign --verify` reprovando com "code has no resources but signature indicates they must be present". Os processos Helper morriam com `EXC_BREAKPOINT`/`SIGTRAP`, e o navegador abortava com `GPU process isn't usable. Goodbye.` Reextrair o mesmo ZIP oficial `152.0.7977.64` restaurou `Info.plist` e os E2E passaram a executar (Chrome real 1/1 em `field-label-review`). O binário antigo não deve ser reutilizado.

O Chrome estável instalado (`152.0.7977.84`) **não** substitui o CFT: o log do próprio navegador traz `--disable-extensions-except is not allowed in Google Chrome, ignoring.`, então a extensão nunca carrega e a descoberta do service worker expira. O pin `Chrome/152.0.7977.64` do harness permanece inalterado.

Também foi corrigida uma divergência de infraestrutura no runner: treze E2E de Chrome real (incluindo `field-label-review`, `capture-visible-element`, `focus-observation-contract` e `form-association-observation`) não estavam classificados em `REAL_CHROME_E2E`, e `createTestPlan` interrompia a suíte inteira com `TEST_PLAN_UNCLASSIFIED_E2E` antes de executar qualquer teste. Todos foram classificados para execução serial; nenhuma asserção de teste foi enfraquecida.

## Campos customizados editáveis — limitação fechada por decisão de fronteira explícita

A limitação registrada acima ("campos customizados editáveis são anônimos no instantâneo") está **corrigida**, com a fronteira decidida antes do código, como ficou acordado.

**O que foi medido, não suposto.** Levei quatro campos `div[role=textbox][contenteditable=true]` ao Chrome real pelo consumidor final: com `aria-labelledby`, com `aria-label`, sem nenhuma declaração e com conteúdo digitado, mais um com `aria-label` em forma de credencial. Antes da correção, os quatro chegavam ao normalizador com `id: null` e sem nome — indistinguíveis entre si. A causa era `contentEditableRootAttributes` (`src/core/privacy.js`): a allowlist preservava `aria-labelledby`, `aria-describedby`, `role`, `tabindex` e `contenteditable`, e descartava `aria-label` e `id`.

**A decisão de fronteira.** O que a allowlist preserva é o que **o autor da página declarou**; o que ela remove é o que **o usuário digitou**. Um `id`, um `aria-label` e uma referência `aria-labelledby` só existem porque o autor os escreveu — não são conteúdo de usuário. O nome que o Chrome expõe na árvore de acessibilidade (`accessibleName`) continua removido para esses nós, porque a árvore pode derivá-lo do próprio conteúdo (regra "name from contents"), e aí haveria vazamento real. Foi por isso que a correção preserva a **declaração do autor** em vez de afrouxar a remoção do nome da árvore.

**O que mudou.** `contentEditableRootAttributes` passa a aceitar `aria-label` (validado por um portão próprio, `safeAuthoredLabel`: é prosa, então aceita espaços, com limite de 512 caracteres, sem caracteres de controle e recusando palavra sensível) e `id` (validado pelo portão de identificador já existente, que recusa valor com forma inválida e palavra sensível).

**Prova depois da correção**, no mesmo Chrome real: `ce-a` chega com `id: "ce-a"` e `aria-labelledby: "lbl-a"`; `ce-b` com `id: "ce-b"` e `aria-label: "Rótulo direto do campo B"`; o rótulo `lbl-a` está presente no instantâneo, então a referência resolve; o campo sem declaração continua anônimo; e o conteúdo digitado continua fora — `text: ""`, `visibleText: ""`, `valueStatus: "omitted-privacy"` e nenhuma ocorrência do texto do usuário no instantâneo serializado.

**Testes.** `test/core/privacy.test.js` ganhou três casos unitários (identidade do autor preservada e conteúdo digitado removido; declaração em forma de credencial descartada; `id` recusado quando não tem forma de identificador ou parece sensível). `test/e2e/field-label-review.test.mjs` deixou de usar um campo customizado vazio e passou a exigir a identidade declarada, a ausência do conteúdo digitado e a presença do rótulo referenciado. Focado: 53/53 em privacidade + normalizador + formulários, e Chrome real 1/1.

**Lacuna registrada, e não escondida.** O filtro de palavra sensível (`SENSITIVE_KEY`) é de vocabulário inglês: pega `token`, `secret`, `session`, `api-key`, mas **não pega "senha"**, "sessão" nem "chave". Medi isso diretamente: `senha do usuário` e `chave de api` passam pelo filtro. Como o produto é brasileiro, essa é uma lacuna real do portão. **Não a fechei nesta rodada de propósito**: ampliar a lista de palavras muda a redação de todo campo do produto, inclusive ids legítimos que contenham esses termos, e a decisão de quais termos entram e com que escopo merece ser tomada explicitamente, com o vocabulário acordado, em vez de por iniciativa minha dentro de uma correção de outra coisa. Enquanto isso, a exposição é limitada ao que o autor escreveu como rótulo de um campo editável — não é conteúdo de usuário —, e nenhum valor em forma de credencial em inglês passa.

**O que continua pendente neste item.** O produtor de **identificação visual** de 5.9.1 segue ausente, e 5.9.1 continua em `cantTell` agregado, sem alvo por campo. A correção acima remove o obstáculo que impedia sequer julgar o campo; ela **não** amplia a automação visual, e não a declarei concluída.

## 5.9.1 — primeiro produtor de identificação visual, com escopo deliberadamente estreito

O produtor ausente começou a ser fechado, e o escopo é estreito de propósito.

**O que ficou observável.** O coletor passa a registrar `clip-path` e `clip` (`page-collector.js`, `styleNames`). Sobre isso, a regra 5.9.1 ganhou o predicado `clippedAway`: ele reconhece recorte **declarado** — `clip-path: inset(...)` com todas as bordas em 49% ou mais, e a técnica legada `clip: rect(0,0,0,0)`. Nada de "parece escondido": só o que a folha de estilo afirma.

**Por que o inverso, e não a prova positiva.** A revisão anterior demonstrou que um rótulo totalmente recortado mantém `hasRenderedBox: true` e `visibleText` preenchido. Portanto geometria e texto no DOM **não** provam que o rótulo é visto. O que a medição sustenta é o contrário: se o recorte está aplicado, o rótulo não está visível. É esse o único fato que a automação passa a afirmar.

**O que mudou no resultado.** Quando algum campo tem rótulo associado recortado, 5.9.1 deixa de ser uma pendência agregada sem alvo e passa a produzir **um alvo por campo afetado**, com `reason: 'clipped-label'`, cada um dizendo que o rótulo associado está recortado e pedindo rótulo visível ou propósito visualmente evidente. A conclusão **continua `cantTell`**, nunca `failed`: a norma admite propósito visualmente evidente com nome acessível, e recorte não prova ausência de percepção. Quando nenhum rótulo está recortado, o resultado segue como antes — pendência agregada, `targets: []`, sem multiplicar um item por campo.

**Verificação.** Medido antes de concluir: o RED no E2E mostrou o alvo novo surgindo com `reason: 'clipped-label'` e `selectorHint: '#name'` antes de eu ajustar a expectativa. Testes: `test/rules/forms.test.js` com quatro casos (recorte por `clip-path`, rótulo visível sem alvo, `inset(10%)` parcial sem alvo, `clip: rect(0,0,0,0)` legado com alvo); `test/e2e/field-label-review.test.mjs` em Chrome real confirmando o alvo no caso nativo e ausência de alvo no campo customizado com rótulo visível. Focado: 21/21 formulários, 896/896 em regras, core, integração, painel e relatório, Chrome real 1/1, `verify-project` GREEN.

**O que continua pendente, e não é pouco.** Este produtor cobre **um** mecanismo de ocultação — recorte declarado. Continuam sem prova: rótulo fora da tela por posicionamento, rótulo coberto por outro elemento, rótulo com contraste insuficiente, `font-size: 0`, `text-indent` negativo, `opacity` muito baixa sem ser zero, e o caso mais comum de todos, que é o campo sem nenhum rótulo associado. Para todos esses, 5.9.1 segue em revisão agregada. **Não declaro a automação de 5.9.1 concluída**: o que existe agora é o primeiro produtor, com escopo explícito, substituindo a inferência incorreta que havia antes.

## 5.9.7 — por que o produtor de perceptibilidade NÃO foi implementado nesta rodada

Registro a decisão e o raciocínio, porque "não implementei" precisa ser distinguível de "esqueci".

A lacuna é conhecida: a regra `required-field-identification` lê `field.requiredIndicator`, e nenhum produtor emite esse campo. Com isso, todo campo obrigatório cai em `cantTell` ("Faltam dados do estado ou da identificação de campo obrigatório"). É cobertura incompleta, mas é uma conclusão **honesta**: não afirma nada que não foi medido.

Examinei o caminho óbvio — fazer o coletor emitir `requiredIndicator` quando o rótulo associado traz um marcador declarado (`*`, `(obrigatório)`, "obrigatório") — e **descartei**, por um motivo concreto. A regra trata `requiredIndicator` não vazio como `passed`:

```
} else if (!normalizeText(field.requiredIndicator)) {
  failures.push(target(field, 'Identifique de modo perceptível que este campo é obrigatório.', …));
}
…
return result('passed', 'Os campos obrigatórios possuem estado e identificação observáveis.');
```

Produzir esse campo faria a regra declarar **aprovado** um campo só porque existe um asterisco no texto do rótulo. Isso é exatamente a confusão proibida — presença de marcador não é prova de percepção, do mesmo modo que `hasRenderedBox` e `visibleText` não provaram identificação visual em 5.9.1. Eu estaria trocando uma lacuna honesta (`cantTell`) por um veredito falso (`passed`), que é estritamente pior para uma ferramenta de fiscalização.

O que uma implementação correta exige, e que fica registrado como desenho a executar:

1. o coletor precisa reportar o marcador declarado **e** se ele é percebível — a evidência de recorte já existe desde esta rodada (`clip-path` e `clip` em `styleNames`, com o predicado `clippedAway` em `forms.js`), então o insumo está disponível;
2. a regra precisa parar de tratar "indicador não vazio" como aprovação e passar a tratar como **revisão**, do mesmo jeito que 5.9.1 faz agora: um marcador declarado e visível é indício forte, não prova de percepção, porque percepção depende de contraste, tamanho e posição que a árvore de acessibilidade não mede;
3. a reprovação confirmada continua reservada ao caso em que **nenhum** marcador foi declarado, porque aí não há o que perceber.

Os três passos são coerentes entre si e nenhum deles pode ser feito sozinho sem produzir conclusão errada. Enquanto os três não forem feitos juntos, 5.9.7 permanece em `cantTell` agregado — sem alvo por campo, sem aprovação falsa e sem reprovação falsa.

### Correção do predicado de recorte, encontrada por tentativa de refutação

Depois de implementar `clippedAway`, escrevi uma sondagem cujo único objetivo era **refutar** a detecção: dezessete declarações de recorte num rótulo visível, medindo quais viravam alvo. Ela expôs dois falsos negativos reais, os dois em `clip-path:inset(...)`:

- `inset(50% round 10px)` — recorte total, não detectado, porque a expressão regular exigia que o parêntese fechasse logo após os valores e o `round` no fim quebrava o casamento.
- `inset(50% 0%)` — recorte total na vertical, não detectado, porque eu exigia 49% ou mais em **todos** os tokens e ignorava a expansão CSS de um a quatro valores.

Também confirmei que a detecção **não** produz falso positivo nos casos que devem passar: `inset(0%)`, `inset(10%)`, `inset(25%)`, `inset(40%)`, `circle(50%)`, `ellipse(25% 25%)`, `polygon(...)`, `clip: auto` e `clip-path: none` — nenhum vira alvo. E `clip:rect(0px,0px,0px,0px)` continua detectado enquanto `clip:rect(0px,100px,30px,0px)` não.

Correção: o predicado agora expande os valores como margens (um valor para os quatro lados, dois para vertical e horizontal, três para topo, horizontal e base) e aceita o `round` opcional. A condição é **um eixo fechado**, não dois: 50% à esquerda e à direita zera a largura independentemente dos valores verticais.

Ao escrever os testes unitários errei **sete vezes** a expansão do `inset` — cheguei a afirmar que `inset(50% 0% 0% 0%)` fechava o eixo horizontal quando na verdade fecha o topo. Cada erro foi corrigido pela medição, não por releitura, e o teste final usa uma matriz de valores em vez de estilos escritos à mão, justamente para não repetir esse tipo de engano.

Cobertura: matriz de seis casos que fecham um eixo (incluindo as duas formas com `round`) e seis que não fecham, mais a lista de formas não interpretadas. 21/21 em formulários.
