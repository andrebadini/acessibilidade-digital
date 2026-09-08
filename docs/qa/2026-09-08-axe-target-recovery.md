# Recuperação dos alvos axe em árvores profundas e componentes personalizados

## Estado e evidência

Base: `14c1eb3` (beta 1.1.10 entregue). Turno anterior classificado como progresso: versão gerada, testada e entregue; não reiniciado. Este incremento não substitui esse ZIP.

Diagnóstico em Chrome for Testing 152.0.7977.64, perfil temporário sem login, Google acessado diretamente. Nenhuma captura de pixel foi solicitada nesta investigação. Somente contagens, categorias e seletores estruturais foram lidos; a aba e o perfil pertencentes ao teste foram encerrados.

O axe real resolvia os seis alvos do catálogo local com unicidade, mas a projeção do Audita os descartava. Causas verificadas: ancestrais personalizados (por exemplo componentes de promoção), elemento `center` fora da lista de tags, e caminhos com 13–15 níveis, acima do limite de 12. Não era ausência do elemento nem um getter no campo `target`.

## Correção

- Conservar o caminho completo nos casos já suportados.
- Representar tags fora da lista por `*:nth-child(n)`, sem exportar seu nome, classes, atributos, ID ou texto.
- Quando o limite de profundidade/comprimento impedir um caminho completo, conservar somente um sufixo que resolva para exatamente o mesmo elemento (`length === 1` e identidade estrita).
- Conservar os limites de 12 partes e 256 caracteres, a verificação de raiz do documento e a recusa de seletores ambíguos.
- A gramática compartilhada aceita somente a nova forma posicional positiva limitada; wildcard livre e seletores com atributos permanecem recusados.
- Não altera resultado normativo, resultado original do motor, autorização de captura ou evidências armazenadas.

## RED / GREEN e revisão

- RED unitário observado: `figure > img` esperado, `[target-unavailable]` obtido abaixo de componente personalizado.
- RED Chrome real observado: a fixture `image-alt` perdia o alvo. Fixture inclui ancestral personalizado, `center`, caminho profundo e descendentes iguais sob componentes distintos.
- A primeira correção por sufixo recuperou somente 1/6 sinais na checagem do Google. Novo RED para descendentes ambíguos demonstrou a necessidade de posição anônima do ancestral.
- GREEN: 59/59 testes em `test/browser/axe-adapter.test.js`, `test/axe/normalize-axe-results.test.js`, `test/axe/validate-supplemental.test.js`.
- GREEN Chrome focado: `test/e2e/axe-mv3-csp.test.mjs`, 1/1. A fixture verifica projeção no mundo isolado, transporte real MV3 e unicidade dos alvos.
- Nova checagem do adaptador real no Google: status complete; seis registros do catálogo local, todos com seletor disponível e `querySelectorAll(selector).length === 1`. Dois resultados originais violations (contraste e imagem) e quatro incomplete (ARIA e três de contraste). Não são seis falhas ABNT confirmadas.
- Revisão independente somente leitura: C=0/I=0, 59/59 testes e diff-check aprovados. Não houve suíte ampla, novo pacote ou mudança no Chrome pessoal.

## Próxima fronteira ainda pendente

A recuperação do seletor não equivale à correlação com o snapshot e não produz automaticamente imagem, anúncio ou destaque seguro. O normalizador e seu validador atualmente só admitem `nodeId` para target-size; a integração genérica com o snapshot precisa de RED próprio, preservando a distinção entre localizar um elemento e comprovar uma infração ABNT. Esse é o próximo passo para os sinais suplementares no percurso ocorrência → elemento → evidência. Não declarar esta integração concluída nem preencher dados por aproximação.
