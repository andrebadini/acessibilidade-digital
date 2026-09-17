# Prontidão para produção — Audita Acessibilidade 1.1.45

Data: 17/09/2026. Artefato: `release/audita-acessibilidade-1.1.45.zip`, digest
`9df21c059feade9b09a88283c11cac14ad07ea8d58d284e630359223548136a1`, 199 arquivos, byte a byte igual ao
commit `358ed4a` (os commits posteriores tocam apenas `docs/qa/`). Chrome for Testing 152.0.7977.64.

## 1. Estado dos 12 critérios de conclusão

| # | Critério | Estado | Evidência principal |
| --- | --- | --- | --- |
| 1 | Percurso principal funciona no Chrome sem instabilidade | **Atendido** | `mandatory-journey-mv3` e `current-page-export-mv3` a partir dos bytes empacotados; auditoria ao vivo no Google concluída em segundos, painel estável (largura/altura constantes na asserção do percurso) |
| 2 | Relatório abre e exportações funcionam | **Atendido** | quatro exportações `complete` (HTML 339 KB, PDF 1,00 MB, CSV 86 KB, JSON 374 KB), relatório em aba própria |
| 3 | Destaque corresponde ao elemento e documento corretos | **Atendido** | `highlight-marking-mv3` e `page-markers-signals-mv3`, com caixa sobre o elemento e correlação de documento |
| 4 | A inspeção automática não altera visivelmente a página | **Atendido** | medição com contadores de evento e observador de mutações: 0 eventos, 0 mutações, geometria/rolagem/foco idênticos; limite declarado: captura de regiões fora da viewport |
| 5 | Evidências autorizadas, corretas e correlacionadas | **Atendido** | `url-pixel-consent-mv3` e `batch-pixel-consent-mv3`, consentimento one-shot, prova de documento antes de cada raster, zero vínculo entre documentos, limpeza só do que é da auditoria |
| 6 | Contagens distinguem falhas, suspeitas e checklist | **Atendido** | artefatos entregues com os quatro grupos separados (0 / 1 / 3 / 9) e **109** verificações no checklist; 0 frases de "Inconformidade ao item" contra 112 "Verificar o item"; PDF de 18 páginas (o defeito histórico de 700+ páginas não se reproduz) |
| 7 | Conclusões ABNT respeitam obrigatoriedade, alternativas e limites | **Atendido** | 146 itens (96 requisitos + 50 recomendações) conferidos contra o PDF da norma; amostra conferida nos dois sentidos (5.9.1, 5.1.3, 5.9.7, 5.9.8 = Requisito; 5.1.5, 5.9.11 = Recomendação); 5.9.7 não produz `failed` por desenho |
| 8 | Interface e relatório claros para leigos | **Parcial por decisão do usuário** | os seis blocos didáticos estão no relatório entregue; não houve teste com pessoa de fora, e o usuário decidiu que isso não bloqueia |
| 9 | Recursos obrigatórios implementados | **Atendido** | rastreabilidade recurso a recurso registrada nos critérios (campo de URL, auditoria da página aberta, refazer, progresso, relatório em aba, filtros, agrupamento por item, destaques, personas, anúncios estimados com aviso honesto, menu de contexto como atalho, lote, validações brasileiras, quatro exportações, sem login) |
| 10 | Sem falha Critical/Important conhecida | **Atendido com ressalva declarada** (a revisão final da 1.1.45 achou um Critical **introduzido pela própria 1.1.45** — a fresta da flexão —, fechado na **1.1.46** e verificado com a sonda dela: `NOVOS vs 1.1.44 = 0`) | a classe de credencial foi **aprovada** na 1.1.44 e os seis Minors fechados na 1.1.45; resíduos medidos e declarados (ver §3). **Ressalva:** o percurso da página atual em modo de pixel não começa — causa raiz medida e delimitada ao incremento paralelo (ver §2) |
| 11 | Achados menores documentados | **Atendido** | `docs/qa/2026-09-16-registro-de-achados-das-revisoes.md` com desfecho por achado, de 1.1.16 a 1.1.45 |
| 12 | Versão empacotada testada em Chrome real | **Atendido** | suíte 4.180/4.178/1 (a única falha é o teste de empacotamento antes de reconstruir o zip), escopo serial 57/58 no zip (a vermelha é flake de limpeza do harness, 1/1 isolada), gate GREEN, auditoria ao vivo e integridade 146/146 |

## 2. O que **não** está pronto: revogação silenciosa no modo de pixel (corrigido por medição da revisão final)

**Correção de 17/09/2026 (rodada 92):** a descrição anterior ("o percurso não começa") estava **errada**. A
revisão final mediu dois fixtures: **com** sinal sensível na página o percurso de pixel na página atual
**começa, pausa, confirma e conclui** (com o registro de bootstrap e a suspensão criados corretamente); **sem**
sinal sensível ele é **revogado em silêncio** — a sessão fica `"revoked"`, nenhuma suspensão é criada e o
painel volta ao neutro **sem mensagem**. O defeito remanescente é, portanto, **falha silenciosa no percurso de
um modo oferecido na interface**, na fronteira do incremento paralelo.


- **Sintoma:** com `element-only` ou `full-evidence`, "Auditar a página atual" leva a tela a `running` e, em
  menos de um segundo, ao neutro ou a `reconnecting`; a confirmação de captura nunca aparece e nenhum trabalho
  é criado. Com `no-pixels` o percurso conclui normalmente, e os modos de pixel **funcionam** para "Outra URL" e
  para lote.
- **Causa raiz medida:** o registro `audita:panel-bootstrap:v1:<windowId>` — pré-condição para o trabalhador
  entregar a pausa de consentimento ao painel — **não existe** no momento da suspensão: em
  `src/background/authorized-audit-starter.js` o registro pendente é publicado (linhas 2326/2356) **depois** da
  suspensão por consentimento. Sem ele, a porta recebe `initial` e não há o que confirmar.
- **Tentativa de conserto e por que foi revertida:** dois consertos pontuais no painel e na porta (adotar a
  correlação da pausa; ignorar bootstrap ocioso durante auditoria em curso) foram implementados com RED real e
  **não fecharam o percurso**; foram revertidos para não entregar meio conserto sem prova.
- **Por que fica com o outro incremento:** a correção é de **ordenação** em
  `authorized-audit-starter.js`, arquivo **congelado** do incremento paralelo "Página atual sem interação
  visível", cujo plano lista "modos com pixels, confirmação/restart, destaque ao vivo e quatro exportações"
  como ainda não demonstrados. Editar por cima violaria a regra de nunca editar os mesmos arquivos em paralelo.
- **Prova exigida do conserto:** E2E em Chrome real que veja `[data-action="confirm-pixel-capture"]` aparecer,
  confirme e chegue a `result` em `element-only` **e** `full-evidence`, reprovando contra os bytes atuais.
- **Registro completo:** `docs/qa/2026-09-17-percurso-pixels-pagina-atual.md`.

## 3. Resíduos declarados (medidos; nenhum é vazamento)

- **Identificador ambíguo:** em `id`/`classe` que contém radical de credencial o conteúdo é tratado como valor
  (decisão de produto em `docs/qa/2026-09-17-decisao-identificador-ambiguo.md`). Preço medido: 20 de 25 ids do
  corpus PT-BR do revisor (15 são rótulo de credencial de verdade) e 99 palavras do dicionário perdem texto.
- **Outros:** rótulo em `name`/`aria-label`/`autocomplete`/`data-*` e em nós irmãos; formas literais
  `id="sen&#104;a"`/`id="sen\nha"`/`id="sen%68a"` (inalcançáveis pelo `DOM.getOuterHTML`); radicais curtos sem
  cobertura de chave (`puk…`, ~100 formas, mesmo número da 1.1.40); `codigo*`/`conta*`; `api.key`;
  `private_key`; `chave·de·api`; separadores exóticos; 10 rótulos artificiais `pix-<família>` em prosa.
- **Captura:** `captureBeyondViewport` altera a geometria real no Chrome 152; o produto usa
  `captureBeyondViewport=false` quando o recorte cabe na viewport e declara o limite para regiões fora dela.
- **5.9.1:** a automação da identificação visual do campo continua `cantTell` agregado (um só, `targets=[]`),
  sem produtor de evidência visual suficiente — declarado, não é falso positivo nem falso negativo.
- **Campo customizado com nome vazio:** cobertura pendente, com a fronteira de privacidade preservada.

## 4. O que falta para "produção", em uma frase

Falta **uma** coisa funcional (o percurso de pixel na página atual, no arquivo do incremento paralelo) e **uma**
formalidade (a revisão integrada final deste artefato, em andamento). Fora isso, o produto está construído,
medido e documentado — e **nada foi publicado**: distribuição exige autorização específica do usuário.
