# Revisão da família 5.9 — formulários

Base: `1a897c4`. Norma do usuário, páginas impressas 22–25, lida diretamente; diagnóstico independente somente leitura de 5.9.1–8. Todos os itens abaixo são requisitos, salvo quando indicado. A existência de testes ou de uma regra não comprova cobertura completa.

| Item | Evidência e situação |
|---|---|
| 5.9.1 | Pendente importante: nome acessível sozinho recebe aprovação sem demonstrar identificação visual ou alternativa de propósito visualmente evidente. Campo ARIA customizado também pode ser excluído pelo inventário nativo. Repros normalizer→rule do revisor, ainda não corrigidos. |
| 5.9.2/4/5 | Revisão contextual assistida; posição, descrição e previsibilidade não estão comprovadas automaticamente. Nenhum defeito novo demonstrado nessa rodada. |
| 5.9.3 | RED local: label com `for=other` aprovava input aninhado diferente; label implícito aprovava dois descendentes, embora só o primeiro fosse seu controle. Correção e revisão independente concluídas nesse escopo. |
| 5.9.6 | RED local: controles com mesmo name em formulários/documentos distintos eram agrupados globalmente. Chave passa a considerar documento e formulário proprietário, incluindo atributo form explícito. Ancestralidade insuficiente/associação não demonstrada permanece pendente. Revisão corrigiu também form vazio: não referencia form de id vazio. Revisão independente concluída no diff, sem novo achado. |
| 5.9.7 | Lacuna de automação: runtime conserva required dentro de form, consumidor pede required/requiredIndicator no nível do campo. A presença real da identificação perceptível não foi demonstrada por esse contrato. Não converter automaticamente a lacuna em falha. |
| 5.9.8 | Lacuna de automação: consumidor pede inputPurpose não produzido. Não inferir finalidade pessoal apenas do nome/tipo/atributo autocomplete. Revisão do alcance próprio da ABNT ainda necessária. |

Evidência de implementação 5.9.3/6: três REDs unitários observados antes da mudança; 18/18 testes de formulários após correção; conjunto focado forms+guidance+normalize 71/71. Chrome152 1/1 no teste novo `form-association-observation`: usa `label.control` e `input.form` como observação nativa, coleta e normaliza DOM/AX/runtime sem interação e exige alvos corretos, preservando HTML/foco/scroll. Não foi executada suíte ampla nem gerado pacote.

Fonte técnica de associação: [HTML label](https://html.spec.whatwg.org/multipage/forms.html#the-label-element) e [form owner](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#association-of-controls-and-forms). A fonte técnica não substitui o texto ABNT.

Guias 5.9.9/10/12/15/16/18: perfis didáticos específicos para erro, sugestão e exceção de segurança, alternativas de prevenção em formulário crítico, reentrada e suas exceções, validação sensorial/motora e distinção autenticação mínima/aprimorada. Não modificam conclusão técnica. Orientam ambiente autorizado/dados fictícios e não registrar credenciais nem provocar transações reais. 31/31 testes de orientação; revisão textual normativa independente ainda em fechamento.

Fechamento: revisão dos seis guias C=0/I=0, conferidos pelo revisor com impressas 23–25, sem execução de testes nessa revisão documental. Revisão do núcleo encontrou `form=""` confundido com `id=""`; Chrome confirmou que o segundo campo não tem proprietário. RED adicionado e corrigido; revisor repetiu 19/19 testes de formulários e repro normalizador→regra, sem novo achado no diff. Main executou 72/72 testes focados e novamente o E2E Chrome de associação. Sem conclusão global sobre formulários, especialmente as pendências explicitadas de 5.9.1/7/8.
