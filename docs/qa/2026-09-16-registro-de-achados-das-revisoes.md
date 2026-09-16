# Registro de achados das revisões independentes — 1.1.16 a 1.1.19

Consolidação de **todo achado** das três revisões independentes desta sessão, com o desfecho de cada um e a evidência que o sustenta. Existe para que a afirmação "não há falha Critical/Important conhecida" (critério 10) seja conferível linha a linha, e não uma frase de fé.

Legenda de desfecho: **corrigido** (com medição de não vacuidade) · **documentado** (backlog com análise) · **delimitado** (fronteira de projeto, não defeito) · **aberto** (ainda sem desfecho).

## Revisão da 1.1.16 → veredito 1 Critical, 2 Important, 3 Minor

| # | Sev. | Achado | Desfecho | Evidência |
|---|---|---|---|---|
| C1 | Critical | 5.9.7 condenava marcação legítima (`label::after`, irmão, `aria-labelledby`, `placeholder`, rótulo de 148 caracteres) e imprimia a frase legal | **corrigido** | Reproduzido por mim em Chrome real; depois, `cantTell` com 0 frases legais. E2E falha contra os bytes anteriores (`actual: ''`, `expected: '*'`) e passa depois |
| I1 | Important | O mesmo produtor aprovava marcação invisível | **corrigido** | 0 de 120 estados sintéticos devolvem `passed`; 0 ocorrências estáticas de `result('passed'` no produtor — medido por mim e confirmado pela revisão seguinte |
| I2 | Important | O zip entregue nunca era conferido contra o hash fixado | **corrigido** | Lixo no arquivo entregue passou a **falhar** a suíte (7/7 verde antes) — procedimento repetido por mim e pela revisão |
| M1 | Minor | Alvo "fora da tela" também dispara em contêiner com rolagem, e o texto afirmava "fora da página" | **corrigido** | Texto do alvo e comentário do predicado reescritos; resultado já era `cantTell` |
| M2 | Minor | Renderizador de modelo imprimia a frase legal para decisão humana sem nota | **corrigido** na 1.1.19 | Os três sítios passam a exigir `evaluator`, `decidedAt` e `note`; teste novo fixa o caso sem nota |
| M3 | Minor | Três afirmações documentais refutadas por medição | **corrigido** | `element.labels` não inclui `aria-labelledby`; "rótulo escondido é ignorado" era falso; comentário de teste contradizia a asserção |

## Revisão da 1.1.17 → veredito 0 Critical, 3 Important, 5 Minor

| # | Sev. | Achado | Desfecho | Evidência |
|---|---|---|---|---|
| A | Important | A suspeita por campo de 5.9.7 caía no checklist genérico e a mensagem do campo não chegava ao HTML/PDF | **corrigido** | Os três motivos entraram em `CONCRETE_REASONS`; as ocorrências passaram ao grupo de revisão humana. Teste de classificação novo |
| B | Important | Campos sem marcação eram descartados em silêncio quando algum campo tinha declaração inválida | **corrigido** | Um único `cantTell` lista os dois grupos; teste unitário falha contra o `src/` anterior (`actual: []`) |
| C | Important | A branch sobrevivente imprimia a frase legal para campo que a árvore do Chrome expõe como obrigatório | **corrigido** | 5.9.7 deixou de produzir `failed`; `Accessibility.getPartialAXTree` mostrava `required: true` nos dois casos |
| M-a | Minor | E2E sem asserção sobre a cadeia de relatório, e duas asserções de linguagem legal que passavam no código anterior | **delimitado** | A cadeia genérica já é fixada em `test/report/html.test.js`; a regra agora está fixada em unidade e no E2E |
| M-b | Minor | Comentário do E2E afirmava observação "de toda fonte" | **corrigido** | Comentário passou a nomear as quatro fontes observadas |
| M-c | Minor | Alvo de `aria-labelledby` dentro de shadow root não é observado | **delimitado** | Direção segura: suspeita, nunca violação |
| M-d | Minor | M2 não corrigido e a afirmação de inalcançabilidade estava errada | **corrigido** na 1.1.19 | Ver M2 acima |
| M-e | Minor | Relato impreciso das 8 falhas do `service-worker` | **corrigido** | Causa estabelecida e cenário aposentado com motivo escrito |

## Revisão da 1.1.18 → veredito 0 Critical, 1 Important, 3 Minor

| # | Sev. | Achado | Desfecho | Evidência |
|---|---|---|---|---|
| — | Important | A devolução antecipada de "faltam dados" descartava **todos** os alvos de 5.9.7 (gatilho: `required` nativo + token ARIA malformado) | **corrigido** na 1.1.19 | Falta de dado virou limitação declarada; unidade e E2E falham contra os bytes anteriores (`actual: []`, `expected: ['unmarked']`) |
| m1 | Minor | M2 ainda aberto | **corrigido** na 1.1.19 | Ver M2 acima |
| m2 | Minor | HTML/PDF mostram o seletor por ocorrência, mas não o motivo de cada uma | **documentado** | O motivo por alvo existe no JSON e no detalhe do painel; renderizá-lo por ocorrência exige campo novo no modelo |
| m3 | Minor | O E2E revisado era cego ao delta da 1.1.18 | **corrigido** | A fixture ganhou o campo com `required` + token malformado e o E2E passou a falhar contra os bytes anteriores |

## O que continua aberto, e não é achado de revisão

- **Critério 1** — intermitência da asserção de tamanho do painel no percurso (falhou 1 vez em 3 execuções minhas; passou comigo 2 vezes e com a triagem 1 vez). Pista medida e registrada: a linha de base é capturada assim que o documento do painel carrega, e o harness não espera o tamanho assentar.
- **Triagem da fase serial** — 9 falhas mapeadas por dono: 7 no arquivo do outro incremento, 1 orçamento de download já corrigido, 1 limpeza de perfil no teardown do harness. Nenhum defeito de produto confirmado na minha área; o relatório da triagem está pendente.
- **Backlog documentado com análise pronta**: remediação por ocorrência no cartão; vocabulário português do `SENSITIVE_KEY` (decisão do usuário); reescrita do cenário aposentado sobre `beginAuthorizedUrlAudit`; técnicas restantes de ocultação em 5.9.1; `inputPurpose` de 5.9.8; verificação com leitor de tela real.
