# Decisão de produto: identificador ambíguo entre privacidade e evidência

Data: 17/09/2026. Vale para a partir da **1.1.44**. Este documento existe porque **nove revisões
independentes** desta classe mediram a mesma tensão por lados opostos, e a decisão precisa ficar visível como
decisão — não como defeito escondido.

## O caso, com as fixtures dos próprios revisores

| fixture | revisão que exigiu | o que ela pediu |
| --- | --- | --- |
| `<div id="senha">borboleta</div>` | 1.1.40 (I-1) e 1.1.42 (C1) | **selar**: o valor não pode sair no modelo guardado nem nos artefatos |
| `<div class="password">Zqwkvbrtnmx9</div>` | 1.1.42 (C1) | **selar** |
| `<div id="sessao">Avenida Paulista</div>` | 1.1.42 (I-1) e 1.1.43 (I-1) | **preservar**: é prosa da página, não valor de campo |
| `<div class="password">Instruções do formulário de contato.</div>` | 1.1.40 (I-1) | **preservar** |
| `<div id="token-de-acesso">Conteúdo público da seção.</div>` | 1.1.40 (I-1) | **preservar** |

As duas exigências são **estruturalmente idênticas** (`<div id="X">texto</div>` com `X` no vocabulário de
credencial do produto) e só se distinguem por julgamento lexical: `senha`/`password` são rótulo de credencial,
`sessao`/`token-de-acesso` "não são". O produto não tem léxico de português em tempo de execução (a máquina do
revisor também não) e **não pode** decidir isso por forma: a 1.1.43 tentou decidir pela forma do conteúdo
(`looksLikeFieldValue`) e a revisão da 1.1.43 mediu **198.360 de 198.360** formas reabertas quando o valor
tinha 5+ palavras, pontuação final ou mais de 64 caracteres.

## A decisão

**Vale a privacidade.** Se o `id`/`classe` de um elemento é rótulo de credencial pelo vocabulário de chave
(menos as famílias da língua medidas, com a guarda dos dois lados e do que sobra depois da flexão), **o
conteúdo do elemento é tratado como valor** — sempre, sem heurística de forma, sem pilha por nome de tag e sem
limite de profundidade. É a decisão que o mandato do usuário determina ("rigor máximo em privacidade e
vazamento"; "não enfraquecer as proteções existentes para obter um teste verde").

## Preço medido e declarado

- **20 de 25** ids do corpus PT-BR do revisor da 1.1.43 têm o texto tratado como valor. **15 deles são rótulo
  de credencial de verdade** (`senha`, `password`, `token`, `pin`, `chave`, `credencial`, `sessao`, `cookie`,
  `segredo`, `session`, `secret`, `puk`, `seed`, `sessões` e as palavras com radical `chavear`/`chavena`/
  `secretas`); os outros (`token-de-acesso`, `cookie-banner`, `map-pin`) são compostos com separador.
- **99 palavras** do dicionário do sistema (minúsculas, 3+ letras) perdem texto quando usadas como `id`
  (a 1.1.41 destruía 93; a diferença são palavras inglesas que **terminam** em radical, cuja exceção de sufixo
  foi removida na 1.1.42 por vazar `<prefixo><radical>` — `xsession`, `novaseed`, `getseed`).
- Nada disso é vazamento: é **perda de evidência** em identificador ambíguo, e o texto continua legível na
  página e no relatório renderizado; o que não sai são os trechos entregues daquele elemento.

## O que está do outro lado (e não pode ser perdido)

Sealhar por identificador é o que mantém **zero vazamento** nas superfícies entregues: `v143-shapes` **0/18 em
todas as formas de valor** (1 palavra a 200 caracteres, com `.`/`!`/`?`/`:`/`;`/`,` final, 64 e 65 chars),
`v143-recall-198k` com `VAZA=6.707` em todas e **0 reabertos** contra a 1.1.41 e a 1.1.42, `v143-context-stack`
com tarja em todos os casos estruturais, e os E2E de gate, ataque e reabertos com todos os casos selados.

## Como tratar um achado futuro neste eixo

1. Se o achado for **vazamento** (valor saindo em qualquer superfície), é **Critical** e se conserta — sem
   reabrir a decisão.
2. Se o achado for **perda de evidência** em identificador ambíguo, ele já está **medido e declarado** aqui e
   no registro de achados: não é regressão nova, e a resposta é ampliar a lista de **famílias** da língua (com
   medição nas duas direções) ou registrar o número — não reintroduzir heurística de forma.
3. Se o achado propuser decidir por léxico, exige **fonte lexical embarcada** e medição de custo: é incremento
   próprio, não conserto de revisão.
