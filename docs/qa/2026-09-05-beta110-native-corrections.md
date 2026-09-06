# Correções encontradas no candidato 1.1.0

## Limpeza após exportação

O Chrome devolve objetos de `storage.session` com ordem de propriedades diferente da ordem de construção. O comparador de readback de export-launch usava JSON.stringify também na prova terminal aninhada e recusava um registro semanticamente idêntico. A exclusão escondia os dados corretamente, mas deixava a limpeza pendente.

RED local reproduziu a ordenação recursiva sem mudar valores. A correção canonicaliza somente terminalProof com seu parser fechado existente e compara todos os valores; não relaxa identidade, campos, autorização ou prova de aba. Provas adicionais recusam valor diferente, chave extra e getter sem executar o getter. Regressões de export-launch/coordenador/scheduler: **373/373 PASS**. Revisões independentes A e B: **C=0/I=0**.

## Paginação

O PDF público inicial tinha 400 páginas para 179 ocorrências (177 pendentes de revisão), incluindo grande espaço vazio entre título e classificação. A regra global `details { break-inside: avoid }` encadeada ao cabeçalho forçava deslocamentos artificiais.

O ajuste limita-se à impressão: permite fluxo dos expansores, mantém o cabeçalho unido e usa texto de 10,5 pt com espaçamento compacto. Nenhum registro ou evidência é removido. Fixture real Chrome de 12 blocos: **4 páginas antes, 2 depois**. Testes HTML/CSP/impressão/harness: **68/68 PASS**. A mesma fixture pública, com 179 ocorrências, gerou 254 páginas após o ajuste (antes: 400). Não comparar páginas reais diferentes como se fossem idênticas.

## Fechamento da página atual

O percurso final passou **5/5** em Chrome152, inclusive pausa, reinício do worker, confirmação, relatório view-only, quatro downloads físicos correlacionados e exclusão com limpeza. Log: `/private/tmp/audita-beta110-export-proof.log`. O teste agora confirma a aceitação da solicitação na interface antes de iniciar o prazo de entrega; o clique sozinho não prova que o worker aceitou exportar. Uma tentativa anterior excedeu o prazo de entrega; não houve mudança de produção nem atribuição de causa não demonstrada.

Capturas auxiliares da interface pelo CDP excederam o prazo no painel e no relatório desse subteste. Somente esse erro específico é registrado como limitação de QA; outros erros continuam falhando. Isso não dispensa imagens de evidência da auditoria, prova da página original intocada, abertura real do relatório, conteúdo/MIME/hash dos quatro downloads ou cleanup. Essas provas passaram. Capturas visuais de outros percursos e PDF público foram inspecionados; não declarar que as duas imagens ausentes foram produzidas.

## Ambiente e contratos dos testes

- Raiz externa de artefatos precisa ser canônica, sob o diretório temporário real, com prefixo `audita-marco-1-` e subpastas existentes. Corrigido o ambiente, sem enfraquecer o validador.
- Expressões CDP usadas apenas para clicar/preencher passaram a retornar booleano explícito; undefined não é aceito pelo helper.
- Resultados agora recolhidos são abertos para interação; verificações de presença usam textContent, não presumem que todos os detalhes estão simultaneamente visíveis.
- Testes de exclusão verificam ausência real da aba e aceitam o purge dos registros de ownership, em vez de exigir um registro removido remanescente.
- A publicação do resultado precede a finalização assíncrona da limpeza. O E2E de lote agora aguarda a remoção efetiva do active job com limite de 10 segundos; limpeza permanente incompleta continua falhando.
- A exclusão revoga a sessão vinculada à auditoria. Para iniciar depois dela, a ação legítima autoriza nova sessão; o teste deve provar visibilidade do painel, não apenas existência de DOM/contexto.

Documentação oficial consultada durante o diagnóstico: [Page.captureScreenshot](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot) e [Side Panel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).
