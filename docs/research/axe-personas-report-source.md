# Pesquisa complementar — motor híbrido, personas e fundamentação jurídica

Data de acesso e síntese: 27 de agosto de 2026  
Produto: Audita Acessibilidade  
Escopo: axe-core, WCAG 2.2, Section 508, simulações assistivas, ABNT NBR 17225:2025 e base consumerista

## Resposta executiva

O axe-core 4.13.0 é gratuito, distribuído sob MPL-2.0 e melhora a detecção de problemas DOM, ARIA e ACT. Ele deve ser incorporado como motor suplementar local e versionado, não como substituto do motor próprio. O motor próprio permanece responsável pelo catálogo ABNT, pelas sondagens dinâmicas, pela árvore de acessibilidade, pelas evidências e pelo encaminhamento de verificações que dependem de juízo humano.

O axe-core não demonstra conformidade integral com a WCAG 2.2. A versão 4.13.0 possui 105 regras, 89 habilitadas por padrão; somente a regra `target-size` trata de um critério introduzido na WCAG 2.2 e ela vem desabilitada. Resultados `passes` do axe não devem promover automaticamente itens ABNT a “conforme”; `violations` só afetam o resultado ABNT quando houver mapeamento curado por ID de regra; `incomplete` deve ser tratado como revisão.

Section 508 vigente é um referencial estrangeiro separado. O padrão revisado incorpora WCAG 2.0 níveis A e AA e possui requisitos e exceções próprios. A tag `section508` do axe é explicitamente referente ao padrão antigo; não será usada como alegação de conformidade atual.

As personas serão apresentadas como simulações qualitativas e reversíveis, nunca como equivalentes a tecnologias assistivas reais ou a testes com pessoas. A “prévia de leitor de tela” combinará a árvore AX e o cálculo de anúncio do produto, com fala sintetizada local; a simulação visual de acromatopsia aplicará escala de cinza; o modo motor bloqueará entradas apontadoras e manterá uma saída segura por teclado.

## Decisão jurídica padronizada

O relatório usará um catálogo jurídico imutável. Em cada desconformidade técnica conclusiva, o único campo variável será o item da ABNT NBR 17225:2025. A redação fixa será:

> **Base consumerista padronizada para análise:** arts. 7º, caput, 20, § 2º, e 39, VIII, da Lei nº 8.078/1990, c/c art. 12, IX, “a”, do Decreto nº 2.181/1997.

A mesma ocorrência informará:

> A referência padronizada não constitui conclusão automática de infração, responsabilidade ou sanção; a incidência depende da qualificação jurídica do alvo e dos fatos do caso concreto.

O bloco só será associado a resultado técnico `failed`. Resultados `cantTell`, `untested` e `inapplicable` não serão apresentados como desconformidades. Recomendações da NBR não atendidas serão identificadas como “recomendação não atendida”, sem conclusão automática de infração.

O Decreto nº 2.181/1997 será citado com o inciso e a alínea corretos: art. 12, IX, “a”. O relatório preservará em nota metodológica a ressalva existente no texto vigente ao art. 3º, VI, da Lei nº 13.874/2019.

## Fatos verificados no pacote axe-core 4.13.0

- versão: `4.13.0`, publicada em 5 de agosto de 2026;
- licença: MPL-2.0, gratuita e sem royalties, com obrigações de aviso e disponibilização do código coberto;
- arquivos a distribuir: `axe.min.js`, `LICENSE` e `LICENSE-3RD-PARTY.txt`;
- tamanho do `axe.min.js`: 580.491 bytes; aproximadamente 154.842 bytes com gzip de nível 9;
- 105 regras totais, 89 habilitadas e 16 desabilitadas por padrão;
- 60 regras WCAG 2.0 A/AA, 2 regras WCAG 2.1 A/AA, 1 regra específica de WCAG 2.2 A/AA, 27 boas práticas, 3 regras AAA, 7 experimentais e 5 obsoletas/depreciadas;
- a regra específica de WCAG 2.2 é `target-size`, associada ao critério 2.5.8, desabilitada por padrão;
- a API produz `passes`, `violations`, `incomplete` e `inapplicable`;
- `axe.min.js` contém construções `new Function`; a integração só será habilitada após execução real em Chromium MV3 sob CSP estrita, sem `unsafe-eval` e sem código remoto.

## Limites de automação e interpretação

1. Uma regra automática testa uma condição de falha delimitada; aprovação não demonstra todos os aspectos do critério WCAG.
2. Regiões ocultas, diálogos fechados e estados não ativados exigem nova execução no estado correspondente.
3. Iframes inacessíveis, páginas protegidas pelo navegador e falhas de injeção geram limitação explícita, não aprovação.
4. A prévia de anúncio não é transcrição literal de VoiceOver, NVDA, JAWS ou TalkBack.
5. A simulação de acromatopsia não mede contraste nem representa toda a experiência de uma pessoa daltônica.
6. O bloqueio de mouse não demonstra sozinho navegabilidade completa por teclado.
7. A presença de VLibras ou Hand Talk não demonstra qualidade ou conformidade; a ausência não é automaticamente falha.
8. “Lorem ipsum” e texto genérico de link são heurísticas editoriais/contextuais e não recebem automaticamente o bloco jurídico.

## Section 508

O produto manterá um catálogo `foreignBenchmarks` separado. A correspondência será calculada por critério WCAG 2.0 A/AA efetivamente incorporado ao padrão revisado. O relatório exibirá “correspondência técnica potencial” e não “conforme Section 508”, salvo se todo o escopo e os requisitos aplicáveis tiverem sido avaliados por método próprio.

## Fontes primárias e ledger de alegações

| Alegação | Fonte primária | URL | Confiança e limite |
| --- | --- | --- | --- |
| axe-core 4.13.0 é MPL-2.0 e executa localmente | Deque Systems, repositório e pacote oficial | https://github.com/dequelabs/axe-core/tree/v4.13.0 | Alta; licença não equivale a parecer jurídico |
| API e categorias de resultado do axe | Deque Systems, API 4.13.0 | https://github.com/dequelabs/axe-core/blob/v4.13.0/doc/API.md | Alta |
| Regras, tags e estado habilitado/desabilitado | Deque Systems, Rule Descriptions 4.13.0 | https://github.com/dequelabs/axe-core/blob/v4.13.0/doc/rule-descriptions.md | Alta |
| Regras ACT são parciais e informativas | W3C/WAI, Understanding Test Rules | https://www.w3.org/WAI/WCAG22/Understanding/understanding-act-rules.html | Alta |
| WCAG 2.2 e seus requisitos de conformidade | W3C Recommendation | https://www.w3.org/TR/WCAG22/ | Alta |
| Section 508 revisada incorpora WCAG 2.0 A/AA | U.S. Access Board e Section508.gov | https://www.access-board.gov/ict/ ; https://www.section508.gov/develop/applicability-conformance/ | Alta; escopo estrangeiro específico |
| Texto vigente dos arts. 7º, 20 e 39 do CDC | Presidência da República, Lei nº 8.078/1990 | https://www.planalto.gov.br/ccivil_03/leis/l8078compilado.htm | Alta; aplicação exige fatos do caso |
| Texto vigente do art. 12, IX, “a” | Presidência da República, Decreto nº 2.181/1997 | https://www.planalto.gov.br/ccivil_03/decreto/d2181.htm | Alta; observar ressalva legal incorporada |
| Dever de acessibilidade em sites no escopo do art. 63 | Presidência da República, Lei nº 13.146/2015 | https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2015/lei/l13146.htm | Alta; relação por item técnico é inferência fundamentada |

## Fonte normativa local

- arquivo: `ABNT-NBR-17225-Acessibilidade-Digital.pdf`;
- edição: ABNT NBR 17225:2025, primeira edição de 11 de março de 2025;
- SHA-256: `1c3ee66b7fd606367e3de087e6a55fea90f4d368d8a1f769141d5e3b96d32afc`;
- fonte principal do mapeamento: Seção 5;
- Anexo C: checklist informativo, usado como instrumento de conferência;
- registro atual: 146 itens, sendo 96 requisitos e 50 recomendações.

## Critério de parada

A pesquisa foi encerrada porque as decisões consequenciais possuem fontes primárias suficientes: licença e cobertura do axe, limites dos testes automáticos, Section 508 vigente, redação consumerista fixa, cautelas jurídicas e fonte normativa local. As incertezas restantes são de integração MV3, desempenho e experiência de uso e serão tratadas por testes reais, não por pesquisa genérica adicional.
