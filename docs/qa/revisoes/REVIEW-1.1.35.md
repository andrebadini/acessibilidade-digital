# Revisão adversarial independente — Audita Acessibilidade 1.1.35

- **Alvo**: `release/audita-acessibilidade-1.1.35.zip`, SHA-256 `950b3eb212338dcb90d0baabf99835fa867761daa1a246392f62ea4de7c09866` (conferido por mim com `shasum -a 256`, no clone congelado, antes de qualquer medição).
- **Checkout congelado**: `/private/tmp/audita-review-135`, HEAD `55db44b39ebbc1a5b1f4a76f62b1455521b47a8f`, `manifest.json` = `1.1.35`. O congelado não recebeu escrita de produto: **nenhum byte de `src/` foi alterado**. Todas as sondas, mutações, espelhos instrumentados e logs ficaram em `/private/tmp/audita-review-135-scratch`. O relatório é a única escrita no congelado (`docs/qa/revisoes/REVIEW-1.1.35.md`).
- **Bytes medidos**: pacote extraído em `…/scratch/pkg` (1.1.35, `unzip`), e a raiz de medição `…/scratch/packroot` montada com a **árvore de teste DO COMMIT** (`git archive HEAD test scripts package.json fixtures`) com o pacote sobreposto; conferido por `diff -r` que `src/` do pacote é idêntico ao `src/` do commit. Mutações: `mut134` (`e84496a`, 1.1.34), `mut133` (`06e70fc`, 1.1.33), `mut132` (`f32ca4b`, 1.1.32) — cada uma com `manifest.json` conferido (1.1.34 / 1.1.33 / 1.1.32) e `src` comprovadamente diferente do alvo.
- **Ambiente**: macOS 26.6.2 (25G83), Chrome for Testing `152.0.7977.64`, Node v26.5.0, `/usr/share/dict/words` → `web2` (235.976 palavras únicas). **Um Chrome por vez**: a fase serial canônica, o E2E de credencial do autor, o E2E de falso positivo, a sonda própria de superfícies e as reexecuções de contexto rodaram em cadeia serializada (`--test-concurrency=1`). As medições unitárias/diferenciais (sem Chrome) rodaram nos intervalos.
- **Declaração de independência**: escrevi minhas próprias sondas (`probe1.mjs`, `probe2.mjs`, `probe3.mjs`, `diffprobe.mjs`, `final.mjs`, `dict.mjs`, `dict2.mjs`, `perf.mjs`, `test/e2e/adv135-surfaces.test.mjs`) e minhas próprias formas, incluindo um controle positivo na mesma página de cada forma medida. Não usei a métrica do autor nem os documentos dele como prova: os números dele aparecem na tabela de conferência como *alegações*, cada uma com o meu procedimento ao lado. O E2E de credencial do autor **foi executado por mim** nos bytes empacotados e o resultado é reportado como medição minha, não como citação.
- **Limite declarado**: não há teste com pessoa leiga nesta revisão, por decisão explícita do usuário (2026-09-16); ele **não** é portão de produção e fica registrado como observação (O6). Não executei auditoria ao vivo contra `https://www.google.com/` (ver "o que eu não consegui verificar").

---

## 1. Veredito

**A 1.1.35 NÃO está aprovada como candidata.**

O desenho por contexto **faz exatamente o que promete nos dois lados que ele nomeia**, e isso é grande e verificável por medição própria: as 12 formas do Critical da 1.1.34 (`senhaforte`, `tokenacesso`, `sessionid`, `senhatemporaria`, `chavedapi`, `senhadousuario`, `cookieconsent`, `secretkey`, `data-senhaforte`, `data-sessionid`, `{"sessionid":…}`, `?sessionid=`) saem de **12/12 vazando na 1.1.34 para 0/12** na 1.1.35, com controle positivo na mesma página provando que a varredura está viva; e o corpus de prosa que a 1.1.34 destruía em **8/19** passa a **0/19**, incluindo os dois casos que a revisão anterior nomeou (`O certificado digital A1…`, `The hairpin: 12 units`), o `<b>sen</b>ha:` partido por marcação, o percent-encoding e o escape octal. A fase paralela dá **4.210 testes, 4.209 passam, 1 pulado, 0 falham**. Nada disso é vacuoso.

Mas **o desenho por contexto não fecha os dois lados — ele move a fronteira e abre um terceiro**. O vocabulário de prosa passou a ser **duas listas fechadas** (33 prefixos, 60 caudas), e uma lista fechada só cobre o que está nela:

- **C1 (regressão, Critical)**: o radical no **início** da palavra colada com cauda **fora da lista fechada** volta a chegar ao entregável — `novasenha:`, `redefinirsenha:`, `trocarsenha:`, `alterarsenha:`, `segundasenha:`, `primeirasenha:`, `novachave:` (fechadas na 1.1.33 **e** na 1.1.34) e `senhasegura:`, `senhafacil:`, `tokenpessoal:` (fechadas na 1.1.33, abertas já na 1.1.34 e mantidas abertas). São **10 formas** desta classe vazando na 1.1.35, **todas fechadas na 1.1.33** — atribuição direta ao incremento, na comparação que o autor usa. É a **mesma classe do Critical da 1.1.34** (`senhaforte`), reaberta por outro caminho: a 1.1.34 vazava porque a fronteira olhava só o fim da palavra; a 1.1.35 fecha isso com lista fechada e volta a vazar assim que a cauda não está na lista. `novasenha`, `redefinirsenha` e `trocarsenha` são **nomes de campo de senha mais comuns que `senhaforte`**. Medi ponta a ponta, nos bytes empacotados, com uma forma por página: chegam ao **relatório, ao modelo e à revisão guardados, ao artefato HTML e ao artefato JSON**.
- **C2 (pré-existente, Critical)**: o **sublinhado** não é separador. Em `senha_forte: VALOR` o extrator de cauda para no radical (`senha`), trata o resto do identificador (`_forte`) como descarte e **tarja o lugar errado**: a saída é `senha[redacted] VALOR`, com o **segredo intacto** — pior que não tarjar, porque parece protegido. Medi nos bytes empacotados: `senha_forte`, `senha_atual`, `senha_padrao`, `token_acesso`, `session_id`, `secret_key`, `chave_api`, `senha_nova`, `senha.mestra`, `senha/mestra` — com sentinela só de letras **e** com sentinela com dígito — deixam o valor literal em `visibleText` no **modelo e revisão guardados** e no **artefato JSON entregue** (`"visibleText":"… [redacted] Zqwkvbrtnmxsubs"`). Nenhuma das quatro gerações fecha esta classe (1.1.32/1.1.33/1.1.34/1.1.35: **10/10 nos dois sentinelas em todas**), e o próprio predicado de chave da 1.1.35 **sabe** que `senha_padrao` é chave (`SENSITIVE_KEY.test('senha_padrao') === true`) — o que falta é o **caminho de prosa usar o mesmo vocabulário que o de chave já usa**.

A assimetria que explica os dois: a 1.1.35 **estreitou o caminho de prosa** (tirou o prefixo genérico `[A-Za-z]{2,12}` e a cauda genérica de letras) para ganhar o falso positivo, e **não levou junto o que o caminho de chave já sabia**. O preço do falso positivo foi pago com recall, e o recall perdido é exatamente o das formas que a lista fechada não enumera.

| Severidade | Qtd | Itens |
| --- | --- | --- |
| Critical | 2 | C1 radical-no-início com cauda **fora das listas fechadas** (`novasenha`, `redefinirsenha`, `trocarsenha`, `alterarsenha`, `senhasegura`, `senhafacil`, `tokenpessoal`, `segundasenha`, `primeirasenha`, `novachave`) chega a 5 superfícies — **10 são regressões deste incremento** (7 fechadas na 1.1.33 E na 1.1.34, 3 fechadas na 1.1.33); C2 **sublinhado/ponto/barra** deixa o segredo **literal** no modelo e no artefato JSON enquanto tarja o lugar errado (`senha[redacted] VALOR`) — **pré-existente**, 10/10 nos dois sentinelas nas quatro gerações |
| Important | 1 | I1 o **preço declarado está errado e subdimensionado em ~7,8×**: os documentos passam a declarar "203 palavras do dicionário casam no caminho de CHAVE"; a medição própria dá **1.576** no caminho de chave da 1.1.35 (o "203" é a medida do caminho de **PROSA** da 1.1.34, que na 1.1.35 é **17**), e o "contra 284 da 1.1.33" é uma medida de **prosa** de outra geração — a comparação que virou número declarado mistura dois predicados e três gerações |
| Minor | 3 | M1 a rota com **query** depois do segmento sensível continua vazando (`/p#/auth/senha/X?tab=1` → `/p#/auth/[redacted]/X?tab=[redacted]`), nas três gerações: a correção do M2 da 1.1.34 só cobre a rota **sem** query; M2 a fase serial **não reproduz o número declarado** (medi 80/73/7 contra 80/72/8 declarado — a diferença é carga, não incremento); M3 nenhum comando reprodutível acompanha os números da auditoria ao vivo (rodada 76) |
| Observações | 6 | O1–O6 (inclui o que confere: forma isolada, falso positivo, invariantes de privacidade por leitura, custo, não vacuidade por mutação e o critério 8) |

**Distribuição depende de autorização explícita do usuário** — este relatório não a concede.

---

## 2. Achados

### C1 — A lista fechada de caudas devolve à página o radical no INÍCIO da palavra colada

**Severidade: Critical. Mesma classe do Critical da 1.1.34, reaberta por outro caminho.** As formas abaixo eram **fechadas** na 1.1.33 **e** na 1.1.34 (medido nas duas gerações, nos mesmos bytes de entrada) e voltam a vazar na 1.1.35.

Sonda diferencial própria (`diffprobe.mjs` / `final.mjs`), mesma entrada nas quatro gerações, quatro caminhos por forma (texto/modelo, trecho HTML, chave JSON, nome acessível) e os dois sentinelas (só letras e com dígito):

```
$ for d in mut132 mut133 mut134 .; do node final.mjs "$d"; done
forma               1.1.32   1.1.33   1.1.34   1.1.35   (VAZOU em qualquer caminho/valor)
senhaforte          fechado  fechado    VAZOU  fechado
tokenacesso         fechado  fechado    VAZOU  fechado
sessionid           fechado  fechado    VAZOU  fechado
novasenha           fechado  fechado  fechado    VAZOU
redefinirsenha      fechado  fechado  fechado    VAZOU
trocarsenha         fechado  fechado  fechado    VAZOU
alterarsenha        fechado  fechado  fechado    VAZOU
senhasegura         fechado  fechado    VAZOU    VAZOU
senhafacil          fechado  fechado    VAZOU    VAZOU
tokenpessoal        fechado  fechado    VAZOU    VAZOU
segundasenha        fechado  fechado  fechado    VAZOU
primeirasenha       fechado  fechado  fechado    VAZOU
novachave           fechado  fechado  fechado    VAZOU
senha_forte           VAZOU    VAZOU    VAZOU    VAZOU   ← C2
senha_atual           VAZOU    VAZOU    VAZOU    VAZOU   ← C2
senha_padrao          VAZOU    VAZOU    VAZOU    VAZOU   ← C2
token_acesso          VAZOU    VAZOU    VAZOU    VAZOU   ← C2
session_id            VAZOU    VAZOU    VAZOU    VAZOU   ← C2
secret_key            VAZOU    VAZOU    VAZOU    VAZOU   ← C2
chave_api             VAZOU    VAZOU    VAZOU    VAZOU   ← C2
senha_nova            VAZOU    VAZOU    VAZOU    VAZOU   ← C2
senha.mestra          VAZOU    VAZOU    VAZOU    VAZOU   ← C2
senha/mestra          VAZOU    VAZOU    VAZOU    VAZOU   ← C2
senha               fechado  fechado  fechado  fechado   [controle]
senhaForte          fechado  fechado  fechado  fechado   [controle]
senha-forte         fechado  fechado  fechado  fechado   [controle]

1.1.32:  7 de 23 formas-alvo vazam em algum caminho (30,4%)
1.1.33: 10 de 23 formas-alvo vazam em algum caminho (43,5%)
1.1.34: 16 de 23 formas-alvo vazam em algum caminho (69,6%)
1.1.35: 20 de 23 formas-alvo vazam em algum caminho (87,0%)
```

O total piora a cada geração, e a composição muda. Decompondo as 23 formas-alvo (excluídos os 4 controles) por **atribuição contra a 1.1.33**, que é a geração que o autor cita como referência de fechamento: das 20 que vazam na 1.1.35, **10 são regressões deste incremento** — fechadas na 1.1.33 e reabertas agora:

- **7 formas fechadas na 1.1.33 E na 1.1.34**, abertas pela 1.1.35: `novasenha, redefinirsenha, trocarsenha, alterarsenha, segundasenha, primeirasenha, novachave`;
- **3 formas fechadas na 1.1.33, já abertas na 1.1.34 e mantidas abertas**: `senhasegura, senhafacil, tokenpessoal`;
- **10 formas pré-existentes** (vazam desde a 1.1.32/1.1.33): `senha_forte, senha_atual, senha_padrao, token_acesso, session_id, secret_key, chave_api, senha_nova, senha.mestra, senha/mestra` — a classe do C2, cuja correção a 1.1.35 também não alcança.

Em paralelo, a 1.1.35 **fecha as 12 formas do Critical da 1.1.34**. Isto é: o incremento fecha uma classe inteira e abre outra do mesmo tamanho, por um eixo diferente.

**Ponta a ponta, nos bytes empacotados, uma forma por página, com CONTROLE POSITIVO NA MESMA PÁGINA** (`test/e2e/adv135-surfaces.test.mjs`, sonda minha, 6 superfícies por forma: painel, relatório, modelo e revisão guardados, artefato HTML, artefato JSON, artefato CSV):

```
$ cd packroot && node --test --test-concurrency=1 test/e2e/adv135-surfaces.test.mjs
ADV135|ctrl-senha       |vazou=NENHUMA|superficies=6     ← CONTROLE: a varredura está viva
ADV135|ctrl-senhaforte  |vazou=NENHUMA|superficies=6     ← CONTROLE: o Critical da 1.1.34 está fechado
ADV135|ctrl-novasenha   |vazou=relatório+modelo e revisão guardados+artefato html+artefato json|superficies=6
ADV135|cauda-redefinir  |vazou=relatório+modelo e revisão guardados+artefato html+artefato json|superficies=6
ADV135|cauda-trocar     |vazou=relatório+modelo e revisão guardados+artefato html+artefato json|superficies=6
ADV135|cauda-alterar    |vazou=relatório+modelo e revisão guardados+artefato html+artefato json|superficies=6
ADV135|cauda-segura     |vazou=relatório+modelo e revisão guardados+artefato html+artefato json|superficies=6
ADV135|cauda-facil      |vazou=relatório+modelo e revisão guardados+artefato html+artefato json|superficies=6
ADV135|cauda-tokenpes   |vazou=relatório+modelo e revisão guardados+artefato html+artefato json|superficies=6
ADV135|pref-segunda     |vazou=relatório+modelo e revisão guardados+artefato html+artefato json|superficies=6
ADV135|pref-primeira    |vazou=relatório+modelo e revisão guardados+artefato html+artefato json|superficies=6
ADV135|pref-novachave   |vazou=relatório+modelo e revisão guardados+artefato html+artefato json|superficies=6
ℹ tests 25   ℹ pass 25   ℹ fail 0
```

Contexto exato do vazamento (`CTX|` da mesma sonda), provando que o texto chega **inteiro** e não é artefato da minha busca:

```
ADV135|ctrl-novasenha|relatório|...&lt;p&gt;novasenha: Zqwkvbrtnmxctrl&lt;/p&gt;...
ADV135|pref-segunda |relatório|...&lt;p&gt;segundasenha: Zqwkvbrtnmxpref&lt;/p&gt;...
ADV135|ctrl-novasenha|modelo e revisão guardados|..."visibleText":"Forma isolada ctrl-novasenha novasenha: Zqwkvbrtnmxctrl"}...
ADV135|pref-segunda |artefato html|...&lt;p&gt;segundasenha: Zqwkvbrtnmxpref&lt;/p&gt;...
```

**Causa medida** (`src/core/privacy.js`): a cabeça do radical no caminho de prosa deixou de ser genérica e passou a ser a lista fechada `CREDENTIAL_PREFIXES` (33 entradas) **mais** o lookbehind de início de palavra; a cauda só casa se estiver em `CREDENTIAL_TAILS` (60 entradas) **ou** em `WORD_STEMS`:

```
WORD_HEAD = (?:${PREFIXES_ALTERNATION}|(?<![\p{L}\p{N}]))          // 33 prefixos, lista fechada
WORD_RADICAL_SOURCE = [
  `${WORD_HEAD}(?:${STEMS_ALTERNATION})${WORD_TAIL}`,              // palavra/prefixo-de-lista + radical
  `(?:${STEMS_ALTERNATION})(?:(?:d|de|da|do))?(?:${TAILS_ALTERNATION}|${STEMS_ALTERNATION})${WORD_TAIL}`,
  `(?:${PREFIXES_ALTERNATION})(?:${STEMS_ALTERNATION})${WORD_TAIL}`,
  ...
]
```

`novasenha` = cauda `nova` + radical `senha`: a cauda está à **esquerda**, então a rota 2 não ajuda; `nova` não está em `CREDENTIAL_PREFIXES` (estão `nova`? não — estão `meu`, `minha`, `novo`? não; a lista tem `user, card, cartao, meu, minha, my, our, app, sim, chip, account, login, bank, banco, device, phone, celular, data, master, admin, super, root, api, auth, oauth, session, cookie, secret, chave, senha, token, pass, pin, conta, acesso, client, server, service, default`), e por isso a rota 1 e a rota 3 falham. `senhasegura` = radical `senha` + cauda `segura`, e `segura` não está em `CREDENTIAL_TAILS`. A lista fechada é a correção do falso positivo **e** a causa do falso negativo — as duas coisas são o mesmo desenho.

**Não vacuidade**: as mesmas dez formas estão **fechadas na 1.1.33 e na 1.1.34** (tabela acima, mesmos bytes de entrada), então o defeito é **atribuível ao incremento**; e o controle `senha:`/`senhaforte:` na mesma página da sonda E2E prova que a varredura não estava morta quando mediu o vazamento.

**Impacto no produto**: um relatório entregue a terceiros carrega o valor de um campo `novasenha`/`redefinirsenha`/`trocarsenha` — nomes de campo de formulário de troca de senha, ou seja, **o caminho mais comum em que uma página expõe uma senha em texto**. A promessa central ("credencial da página não chega ao entregável") é quebrada numa forma que as duas gerações anteriores cobriam.

**O que o autor deveria fazer**: (a) o caminho de **prosa** deve usar o **mesmo vocabulário** que o de chave já usa (`isSensitiveKeyName`) para a **cauda/prefixo de identificador**, e não uma lista fechada paralela — foi exatamente o erro que a 1.1.35 corrigiu para a chave e manteve para a prosa; (b) para não reabrir o falso positivo, a decisão não precisa ser "lista fechada × lista aberta", e sim **posição**: o radical no **início** de uma palavra colada é identificador (a palavra portuguesa que começa com `senha`/`token`/`session` e continua em letras é praticamente inexistente), enquanto o radical no **fim** (`chaveiro`, `secretaria`, `tokenizador`, `pincel`) é onde mora o falso positivo — a assimetria de posição é medida e está na tabela; (c) acrescentar as dez formas à métrica e ao E2E de forma isolada, que hoje passam 17/17 nos dois lados desta classe.

---

### C2 — O sublinhado (e o ponto, e a barra) faz o produto tarjar o lugar ERRADO e entregar o segredo literal

**Severidade: Critical. Pré-existente — não é regressão deste incremento** (medido nas quatro gerações). Entra como Critical porque o efeito não é "deixar de tarjar": é **tarjar o lugar errado**, produzindo uma saída que parece protegida e não está, e porque o segredo chega **literal** a duas superfícies entregues.

Sonda própria, uma forma por página, 6 superfícies, nos bytes empacotados, sentinela **só de letras** (credencial plausível: `correcthorsebattery`, token base32, `sk_live_…`) **e** sentinela com dígito — as duas medições estão no log e o resultado é o mesmo:

```
ADV135|sub-senhaforte|vazou=modelo e revisão guardados+artefato json|superficies=6
ADV135|sub-senhaatual|vazou=modelo e revisão guardados+artefato json|superficies=6
ADV135|sub-senhapadrao|vazou=modelo e revisão guardados+artefato json|superficies=6
ADV135|sub-tokenacesso|vazou=modelo e revisão guardados+artefato json|superficies=6
ADV135|sub-sessionid|vazou=modelo e revisão guardados+artefato json|superficies=6
ADV135|sub-secretkey|vazou=modelo e revisão guardados+artefato json|superficies=6
ADV135|sub-chaveapi|vazou=modelo e revisão guardados+artefato json|superficies=6
ADV135|sub-senhanova|vazou=modelo e revisão guardados+artefato json|superficies=6
ADV135|sub2-senhaforte|vazou=modelo e revisão guardados+artefato json|superficies=6
ADV135|sub2-sessionid|vazou=modelo e revisão guardados+artefato json|superficies=6
ADV135|sub2-secretkey|vazou=modelo e revisão guardados+artefato json|superficies=6
ADV135|sub2-chaveapi|vazou=modelo e revisão guardados+artefato json|superficies=6
ADV135|ctrl2-senha|vazou=NENHUMA|superficies=6   ← CONTROLE do mesmo sentinela com dígito
```

Contexto exato, mostrando a tarja no lugar errado e o valor inteiro logo depois:

```
ADV135|sub-senhaforte|modelo e revisão guardados|
   ..."visibleText":"Forma isolada sub-senhaforte [redacted] Zqwkvbrtnmxsubs"},"backendNodeId":10,...
ADV135|sub-senhaforte|artefato json|
   ..."visibleText":"Forma isolada sub-senhaforte [redacted] Zqwkvbrtnmxsubs"},"backendNodeId":10,...
ADV135|sub2-senhaforte|artefato json|
   ..."visibleText":"Forma isolada sub2-senhaforte [redacted] ADV135SUBSEN7X"},"backendNodeId":10,...
```

`visibleText` é renderizado no HTML entregue (`html.js:780`, `<dt>Texto visível</dt>`), e o artefato JSON é o modelo serializado — o segredo está no arquivo que o usuário baixa.

**Causa medida.** `_`, `.` e `/` **não** estão em `WORD_SEP` (`(?:\u0001|[\s\-_–—])` — o sublinhado está, mas a construção da cauda usa `[\s]*[-–—:]*[\s]*` no extrator, que **não** inclui `_`). O extrator de cauda (`tailPasses`) casa o rótulo **parcial** e trata o **resto do identificador como se fosse o valor**:

```
$ node -e "…redactSensitiveText('senha_forte: ADVSEN01X')…"
in  "senha_forte: ADVSEN01X"
out "senha[redacted] ADVSEN01X"        ← tarja "_forte", entrega "ADVSEN01X"

$ node -e "…redactSensitiveText('senha: ADVSEN01X')…"
out "senha: [redacted]"               ← controle: correto
```

O predicado de **chave** da própria 1.1.35 **sabe** que a forma é credencial — o que falta é o caminho de prosa usar o mesmo vocabulário:

```
$ node -e "…SENSITIVE_KEY.test(withCamelMarks('senha_padrao'))…"
senha_padrao   SENSITIVE_KEY=true   SENSITIVE_KEY_NAME=true   isSensitiveKey=true
```

Ou seja: `senha_padrao` é reconhecida como chave de credencial **e** o tarjador de prosa mesmo assim entrega o valor. A mesma classe vale para `senha.mestra` e `senha/mestra` (a barra ainda é consumida pela regra de rota e produz a mesma tarja no lugar errado).

**Medição por geração** (12 formas da família sublinhado/ponto/barra, 4 caminhos, **os dois sentinelas**): as 10 formas da família que testei com os dois sentinelas vazam em **todas as quatro gerações, nos dois sentinelas** — **1.1.32 10/10 (letras) e 10/10 (dígito), 1.1.33 10/10 e 10/10, 1.1.34 10/10 e 10/10, 1.1.35 10/10 e 10/10** (`senha_forte`, `senha_atual`, `senha_padrao`, `token_acesso`, `session_id`, `secret_key`, `chave_api`, `senha_nova`, `senha.mestra`, `senha/mestra`). Nenhuma geração fecha a classe, e a 1.1.35 também não a declarou em lugar nenhum: a métrica do autor não tem **nenhuma** forma com separador entre radical e cauda em prosa (o autor tem `userpin` e `data-userpin`, que são o caso **sem** separador).

**Impacto no produto**: `senha_forte`, `senha_padrao`, `session_id`, `secret_key`, `chave_api`, `token_acesso` são a forma como **depuração, JSON de configuração, `curl` e `console.log` de página** escrevem credenciais. Um relatório entregue carrega o valor; pior, carrega uma tarja no lugar errado, o que um leitor humano lê como "este campo foi protegido".

**O que o autor deveria fazer**: (a) o extrator de cauda precisa consumir o **identificador inteiro** antes de decidir onde está o valor — usar o vocabulário de chave para reconhecer `senha_forte` como **um** rótulo e só então tarjar o que vem depois; (b) enquanto isso não acontece, o produto **não deve** emitir a tarja parcial: tarja no lugar errado é pior que ausência de tarja, porque destrói a evidência do rótulo **e** dá falsa segurança sobre o valor; (c) a classe entra na métrica com as formas de sublinhado, ponto e barra.

---

### I1 — O "preço declarado" está errado em ~7,8× e compara predicados diferentes de gerações diferentes

**Severidade: Important. É declaração de preço, não código** — mas é o argumento com que o autor fecha o lado do falso positivo, e o número declarado é o do revisor anterior, não uma medição do artefato.

O README da 1.1.35 passa a declarar:

> "O preço declarado mudou de lado e está medido: **203 palavras** do dicionário casam no caminho de chave (contra 284 da 1.1.33 e 87 novas)."

Medição própria, `/usr/share/dict/words` (235.976 palavras únicas, `dict.mjs`/`dict2.mjs`), predicado de **chave** de cada geração:

```
$ for d in mut132 mut133 mut134 .; do node dict2.mjs "$d"; done
geração   caminho de CHAVE            caminho de PROSA (SENSITIVE_KEY)
1.1.32    não existe predicado só-chave   180
1.1.33    não existe predicado só-chave   286      ← a chave usava SENSITIVE_KEY
1.1.34    203 (isSensitiveKeyName)        203
1.1.35    1576 (isSensitiveKeyName)       17
```

Leitura: os "203" são a medida do predicado **de prosa da 1.1.34**; na 1.1.35 o caminho de **chave** (`isSensitiveKeyName`, permissivo por desenho) casa **1.576** palavras do dicionário — **7,8× o declarado**. O "contra 284 da 1.1.33" é uma medida de **prosa** de outra geração (a 1.1.33 não tinha predicado só-chave: a chave e a prosa usavam `SENSITIVE_KEY`), e o "87 novas" é do relatório da revisão da 1.1.34, não de uma medição do autor. A frase compara, portanto, **três medidas de dois predicados em três gerações** como se fossem uma série.

O número de 1.576 não é um detalhe contábil: a lista de exemplos que casam no caminho de chave inclui `alpine`, `alpinely`, `alpinery`, `Alpinism`, `antidumping`, `antishipping`, `aniseed`, `allseed`, `alternipinnate`, `Aleppine`, `affenpinscher`, `adipinic`, `apinch`, `aping`, `antipass`, `appinite` — nenhuma é credencial. E o caminho de chave **decide o entregável**: ele descarta o nome do atributo no trecho e tarja o valor:

```
$ node -e "…sanitizeHtmlSnippetSource('<div id=\"alvo\" data-alpine=\"12\" title=\"Alpine\">x</div>')…"
in  <div id="alvo" class="card" data-alpine="12" title="Alpine">x</div>
out <div id="alvo" class="card" title="Alpine">x</div>          ← data-alpine DESCARTADO

$ node -e "…sanitizeJsonData({alpine:'12', total:5})…"
→ {"alpine":"[redacted]","total":5}
$ node -e "…sanitizeJsonData({antidumping:'aprovado', quantidade:3})…"
→ {"antidumping":"[redacted]","quantidade":3}
```

O autocomplete legítimo que o autor protegeu por teste (`shipping street-address`) está **explicitamente isento** em `snippet.js:142` e `:171`, e isso está correto; mas o preço real do caminho de chave é uma ordem de grandeza maior que a declarada, e **não está declarado em nenhum documento**.

**O que o autor deveria fazer**: (a) declarar o número medido do **próprio predicado** (1.576 palavras com `/usr/share/dict/words`, ou a contagem que ele escolher, com o comando versionado); (b) parar de usar o "203/284/87" como série, que mistura predicados; (c) decidir explicitamente se perder `data-alpine`/`{"antidumping": …}` no trecho é preço aceitável — hoje ele é pago sem estar medido.

---

### M1 — A rota com query depois do segmento sensível continua vazando (a correção do M2 da 1.1.34 cobre só a rota sem query)

O registro de achados declara o M2 da 1.1.34 "corrigido na 1.1.35". A correção existe e funciona para a forma que a revisão mediu:

```
/p#/senha/ADVROUTE7X        -> /p#/senha/[redacted]              ✔
/p#/auth/senha/ADVROUTE7X   -> /p#/auth/[redacted]/[redacted]    ✔
/p#/auth/code/ADVROUTE7X    -> /p#/auth/[redacted]/[redacted]    ✔
/p#/auth/senha/ADVROUTE7X?tab=1 -> /p#/auth/[redacted]/ADVROUTE7X?tab=[redacted]   ✖ valor intacto
```

A regra nova casa `([#/])([^/?#\s]+)$` — "o ÚLTIMO segmento" — e com uma query presente o último segmento é `tab=1`, não o valor; a tarja cai no parâmetro **inofensivo** e o segredo sobrevive. Medi as três gerações: **1.1.33, 1.1.34 e 1.1.35 dão a mesma saída** — é pré-existente e a correção não o alcança. O vazamento chega ao **campo JSON** (`{"route":"/p#/auth/[redacted]/ADVROUTE7X?tab=[redacted]"}`) e ao **trecho HTML**; na URL de evidência o `hash` é removido (`sanitizeEvidenceUrlV1`, `parsed.hash = ''`), então a superfície de URL não é afetada. **Severidade Minor** por isso: a exposição é de texto/trecho, não de URL entregue.

### M2 — A fase serial não reproduz o número declarado

Declarado (README e rodada 76): **80 testes, 72 passam, 8 falham** — 7 em `sidepanel-flow-mv3.test.mjs` e 1 flake em `axe-mv3-csp`.

Medido por mim, na raiz montada com a árvore de teste do commit, pacote 1.1.35, `node --test --test-concurrency=1` nos 37 arquivos do plano (`serial-full.log`):

```
$ node --test --test-concurrency=1 <37 arquivos do plano>
ℹ tests 80   ℹ pass 73   ℹ fail 7   ℹ skipped 0
```

Todas as **7** falhas são de `test/e2e/sidepanel-flow-mv3.test.mjs` (`WAIT_TIMEOUT`/`CDP_COMMAND_TIMEOUT` em `assertPausedAttempt`/`beginAttachedAttempt`), o arquivo do outro incremento — **a atribuição declarada confere** ("7 no arquivo do outro incremento"); o que não confere é o total: **73/7 contra 72/8**, e `axe-mv3-csp` **não** falhou comigo. A diferença é de carga (as falhas são timeouts de 30 s, e a mesma suíte medida duas vezes pelo autor deu 80/70/10 e 80/72/8). Registro como Minor de **proveniência**: o número existe, o comando existe, mas **não é reproduzível** — e o autor passou a citá-lo como se fosse exato ("o total é conferido: 4.210 testes, 4.209 passam, 1 pulado, 0 falham", esse sim reproduzido por mim).

### M3 — Os números da auditoria ao vivo não têm comando reprodutível no commit

A rodada 76 declara números precisos de uma auditoria ao vivo no Google (0 falhas, 1 alerta, 3 suspeitas com 4 ocorrências, 109 no checklist, cobertura 28,5%, índice 9,0/10, PDF de 18 páginas, 146/146 ids e títulos, notas 5/5, 0 `[redacted]`, 0 palavras partidas). **Não há script versionado que os produza**: nenhum arquivo em `scripts/` executa auditoria ao vivo, e o número não vem de `npm run verify` nem de arquivo de teste. A conferência que consegui fazer sem Chrome:

- **146 itens, 146 ids únicos, 96 requisitos + 50 recomendações**: CONFIRMADO por medição da fonte (`NBR17225_ITEMS.length === 146`, `new Set(ids).size === 146`, `classification` = `{requirement: 96, recommendation: 50}`).
- **Cobertura com fórmula e denominador explícitos**: CONFIRMADO que a fórmula existe e é declarada no produto (`panel-summary.js:57` `coveragePercent(numerator, denominator)`, `:359` `denominator = attemptedPages.length * inventory.ruleIds.length`, `numerator` = resultados em `COVERED_OUTCOMES`; o texto entregue declara "Mede os testes do motor próprio com conclusão automática (passed, failed ou inapplicable), divididos pelo inventário desse motor nas páginas tentadas", `html.js:311`). A **aritmética** de 28,5% com denominador 130 fecha; o **decimal** não é verificável sem a execução.
- **Métrica da classe em 0 de 92 formas e 347 combinações**: CONFIRMADO (`node --test test/core/credential-class-metric.test.js` imprime `formas=92 combinações=347` e o total é **calculado e afirmado** pelo teste, não escrito à mão).

Ou seja: os números da auditoria ao vivo são a única família de alegações do incremento **sem comando**. Isto é exatamente o que rendeu achado nas duas revisões anteriores, e continua aberto. Não chamo de REFUTADO porque não medi contra-evidência — chamo de **NÃO REPRODUZÍVEL**.

---

## 3. Tabela de conferência

| # | Alegação do autor (documento) | Meu comando / procedimento | Resultado medido | Veredito |
|---|---|---|---|---|
| 1 | pacote `950b3eb2…9866`, HEAD `55db44b`, versão 1.1.35 | `shasum -a 256 release/…1.1.35.zip`; `git rev-parse HEAD`; `manifest.json` | `950b3eb212338dcb90d0baabf99835fa867761daa1a246392f62ea4de7c09866`; `55db44b39e…`; `1.1.35` | **CONFIRMADO** |
| 2 | o `src/` do pacote é a árvore do commit (critério 12) | `unzip` + `diff -r pkg/src src` | idênticos (nenhuma diferença) | **CONFIRMADO** |
| 3 | fecha o Critical da 1.1.34 (radical no início colado: `senhaforte`, `tokenacesso`, `sessionid`, `chavedapi`, `senhadousuario`, `cookieconsent`, `secretkey`, `data-senhaforte`, `data-sessionid`, `{"sessionid":…}`, `?sessionid=`) | `final.mjs` nas 4 gerações + sonda E2E própria nos bytes empacotados | 1.1.34: 12/12 VAZOU; 1.1.35: **0/12**; controle `ctrl-senhaforte` fecha na mesma página | **CONFIRMADO** |
| 4 | fecha o Important I1 da 1.1.34 (prosa destruída: `O certificado digital A1…`, `The hairpin: 12 units`, `conta corrente`, `assinatura eletrônica`, `pushpin`) | `diffprobe.mjs` nos 4 `src`, corpus de 19 frases | 1.1.34 destruía **8/19**; 1.1.35 **0/19**; as duas frases nomeadas saem intactas no texto **e** no trecho HTML | **CONFIRMADO** |
| 5 | fecha o Important I2 da 1.1.34 (`<b>sen</b>ha:` partido por marcação) | `sanitizeHtmlSnippetSource` em 8 formas de codificação/marcação | todas fechadas (`<b>sen</b>ha:`, `<b>se</b>n<i>ha</i>:`, `sen%68a:`, `sen\150a:`, `sen&#104;a:`, `sen\u0068a:`, dois nós) | **CONFIRMADO** |
| 6 | fecha o M1 da 1.1.34 (percent-encoding e escape octal no rótulo) | idem #5 | fechadas nas duas codificações | **CONFIRMADO** |
| 7 | fecha o M2 da 1.1.34 (rota `#/auth/senha/X`) | `redactSensitiveText` em 4 rotas | forma sem query fechada; **forma com query continua vazando** nas 3 gerações | **PARCIAL** (→ M1) |
| 8 | métrica da classe em 0 de 92 formas e 347 combinações | `node --test test/core/credential-class-metric.test.js` | `ℹ formas=92 combinações=347`; 6/6 testes passam; total **calculado** pelo teste (`(FORMAS+IDIOMA+CARTAO+SEM_ACENTO)*3 + …`) | **CONFIRMADO** |
| 9 | E2E de forma isolada e de falso positivo 17/17 verdes nos bytes entregues | `node --test --test-concurrency=1 test/e2e/credential-shapes-mv3.test.mjs test/e2e/credential-false-positives-mv3.test.mjs` na raiz do pacote | `tests 17 / pass 17 / fail 0` | **CONFIRMADO** |
| 10 | fase paralela: 4.210 testes, 4.209 passam, 1 pulado, 0 falham, no clone completo | `node --test` nos 180 arquivos não-Chrome, cwd = clone congelado | `tests 4210 / pass 4209 / fail 0 / skipped 1` | **CONFIRMADO** |
| 11 | fase serial: 80 testes, 72 passam, 8 falham, 7 no arquivo do outro incremento + 1 flake | `node --test --test-concurrency=1` nos 37 arquivos do plano, raiz do pacote | `tests 80 / pass 73 / fail 7`; **as 7 em `sidepanel-flow-mv3`**; `axe-mv3-csp` não falhou | **PARCIAL** (atribuição confere, total não → M2) |
| 12 | preço declarado: 203 palavras do dicionário no caminho de chave (284 na 1.1.33, 87 novas) | `dict.mjs`/`dict2.mjs` sobre `/usr/share/dict/words` (235.976 únicas) nas 4 gerações | caminho de **chave** da 1.1.35 = **1.576**; "203" = prosa da 1.1.34; prosa da 1.1.35 = 17; a 1.1.33 não tinha predicado só-chave | **REFUTADO** (→ I1) |
| 13 | custo 2,1× no corpus denso do autor | `perf.mjs` (4.000 nós densos de radical; 20.000 strings limpas; 4.000 frases de prosa) nas 4 gerações | 1.1.35/1.1.34 = **2,09×** (denso), **2,06×** (JSON), **2,20×** (prosa); limpo 9,4 ms contra 6,0 ms da 1.1.34 e 103,0 ms da 1.1.33 | **CONFIRMADO** (2,1× reproduzido) |
| 14 | 146 itens (96 requisitos + 50 recomendações), 146/146 ids | `NBR17225_ITEMS` | 146 itens, 146 ids únicos, `{requirement: 96, recommendation: 50}` | **CONFIRMADO** (fonte); artefato entregue NÃO REPRODUZÍVEL |
| 15 | cobertura com fórmula e denominador explícitos (28,5%, denominador 130) | `panel-summary.js:57` e `:359`; texto de `html.js:311` | fórmula existe, é explícita e o texto entregue a declara; a aritmética fecha, o decimal não é verificável sem execução | **PARCIAL** (→ M3) |
| 16 | 0 `[redacted]`, notas 5/5, 0 palavras partidas, 146/146 no HTML e no PDF, 109 no checklist, índice 9,0/10, PDF 18 páginas | não executei auditoria ao vivo | — | **NÃO REPRODUZÍVEL** (→ M3) |
| 17 | invariantes de privacidade (nonce fora de DOM/reducer/modelo/relatório/URL/logs; autorização antes de pixel; consentimento one-shot; captura B nunca atribuída a A; limpeza só de abas próprias; identidade provada antes de cada raster) | execução dos arquivos de privacidade/legal do plano (fase paralela) + leitura das guardas | 0 falhas nos 180 arquivos não-Chrome, incluindo `test/privacy/*`, `test/legal/*`; a fase serial de `sidepanel-flow` falha por **timeout de harness** (30 s), não por asserção de privacidade — nenhuma das 7 falhas é asserção sobre resultado de auditoria | **CONFIRMADO por execução indireta** (ver "o que eu não consegui verificar") |
| 18 | não vacuidade por mutação (o incremento tem dentes) | `mut134`/`mut133`/`mut132` materializados de `git archive` e medidos com a mesma sonda | o incremento **fecha 12** formas e **abre 10**; contra a 1.1.34 a métrica reprova (12/12 → 0/12) e contra a 1.1.33 não há forma que passe nos dois lados | **CONFIRMADO nos dois sentidos** |

---

## 4. O que eu não consegui verificar

1. **A auditoria ao vivo no Google e todos os seus números** (0 falhas, 1 alerta, 3 suspeitas, 109 no checklist, 28,5%, índice 9,0/10, 18 páginas, 146/146 ids e títulos no HTML e no PDF, notas 5/5, 0 `[redacted]`, 0 palavras partidas). Não executei auditoria contra `https://www.google.com/` e **não há comando no commit que a produza**. Verifiquei a fonte dos 146 itens (146 ids únicos, 96/50) e a existência e a forma da fórmula de cobertura, mas os números do artefato entregue ficam por medir. Isto é M3.
2. **O decimal exato da cobertura** (28,5% com denominador 130) e o **índice 9,0/10**: dependem da execução ao vivo.
3. **A integridade do PDF** (146/146 títulos, notas 5/5, 0 palavras partidas): exigiria gerar e inspecionar o PDF da auditoria ao vivo.
4. **A autorização antes do pixel, o consentimento one-shot e a identidade de documento antes de cada raster**: verifiquei por **execução da suíte** (0 falhas nos arquivos de privacidade/legal na fase paralela) e por **leitura** das guardas, não por observação da sequência de CDP numa execução instrumentada minha.
5. **`aria-label`/`placeholder`/`alt`/`title` legítimos em página real**: medi no caminho unitário (`sanitizeHtmlSnippetSource`, `sanitizeJsonData`) e o E2E de falso positivo do autor passa 4/4; não montei página própria para cada atributo de rótulo com o radical em posição inicial.
6. **O corpus de 4.000 nós do autor**: o "2,1×" foi reproduzido no **meu** corpus (2,09×–2,20×); o número exato dele depende do corpus dele, que não está versionado como fixture.

---

## 5. Observações

- **O1 — o que confere e tem dentes.** O núcleo do incremento é real e medido: 12/12 do Critical da 1.1.34 fechadas, 8/19 → 0/19 de prosa destruída, `<b>sen</b>ha:` fechado, percent-encoding e octal fechados, fase paralela 0 falhas, E2E de credencial 17/17, custo 2,1×, 146 itens e 96/50 na fonte, métrica com total calculado. Não é um incremento vazio.
- **O2 — o padrão das três revisões se repetiu uma terceira vez.** A 1.1.33 estreitou a detecção para fechar um falso positivo e devolveu formas; a 1.1.34 trocou a fronteira e devolveu o outro lado; a 1.1.35 troca a fronteira de novo e devolve um terceiro conjunto. A causa comum não é a lista: é **resolver falso positivo e falso negativo com o mesmo eixo (a lista de radicais)**. O eixo que a medição sustenta é **posição** (radical no início de palavra colada é identificador; no fim é onde mora o falso positivo) e **separador** (o `_` é separador de identificador em toda a web e não é tratado como tal). Enquanto o desenho não separar esses eixos, a próxima geração reabre a classe por outro caminho — é o que as três medições mostram.
- **O3 — a tarja no lugar errado merece decisão explícita.** O C2 não é só falso negativo: `senha[redacted] VALOR` é uma saída que um leitor humano interpreta como protegida. Se a correção não couber no próximo incremento, a decisão conservadora é **não tarjar parcialmente** — deixar o rótulo intacto é menos grave que tarjar o lugar errado e entregar o valor.
- **O4 — o autocomplete está correto.** `snippet.js:142` e `:171` isentam explicitamente `id`/`name`/`autocomplete` do descarte por nome sensível, e `autocomplete="shipping street-address"` sobrevive inteiro (medido). O preço do caminho de chave (I1) não recai sobre o autocomplete.
- **O5 — a fase serial é frágil sob carga, e isso já custou duas revisões.** As 7 falhas são todas `WAIT_TIMEOUT`/`CDP_COMMAND_TIMEOUT` de 30 s em `sidepanel-flow-mv3`, o arquivo do outro incremento; nenhuma é asserção sobre resultado de auditoria. O número declarado (72/8) e o medido (73/7) divergem por isso. Enquanto o total for citado como exato, cada revisão vai medir um número diferente.
- **O6 — critério 8, conforme instrução.** Não há teste com pessoa leiga nesta revisão, por decisão explícita do usuário (2026-09-16), e ele **não** é portão de produção. Registro como observação, não como bloqueio. **Publicação em loja depende de autorização explícita do usuário** — este relatório não a concede.

---

## 6. Reprodução

```
# 0) alvo e integridade
cd /private/tmp/audita-review-135
shasum -a 256 release/audita-acessibilidade-1.1.35.zip   # 950b3eb212338dcb…c09866
git rev-parse HEAD                                      # 55db44b39ebbc1a5b1f4a76f62b1455521b47a8f

# 1) raiz de medição com os bytes empacotados + árvore de teste DO COMMIT
S=/private/tmp/audita-review-135-scratch
mkdir -p $S/pkg $S/packroot && cd $S/pkg && unzip -q /private/tmp/audita-review-135/release/audita-acessibilidade-1.1.35.zip
cd /private/tmp/audita-review-135 && git archive HEAD test scripts package.json fixtures | tar -x -C $S/packroot
cp -R $S/pkg/. $S/packroot/ && diff -r $S/pkg/src /private/tmp/audita-review-135/src   # idênticos

# 2) mutações (não vacuidade)
for spec in "mut134:e84496a" "mut133:06e70fc" "mut132:f32ca4b"; do
  n=${spec%%:*}; r=${spec##*:}; mkdir -p $S/$n
  git archive $r src manifest.json | tar -x -C $S/$n      # conferir versions 1.1.34/1.1.33/1.1.32
done

# 3) diferencial (leak + prosa) e dicionário
for d in $S/mut132 $S/mut133 $S/mut134 /private/tmp/audita-review-135; do node $S/final.mjs "$d"; node $S/dict2.mjs "$d"; done

# 4) E2E nos bytes empacotados, um Chrome por vez
export AUDITA_E2E_CHROME="/private/tmp/audita-cft152-fixed/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
cd $S/packroot
node --test --test-concurrency=1 test/e2e/credential-shapes-mv3.test.mjs test/e2e/credential-false-positives-mv3.test.mjs   # 17/17
cp $S/adv135-surfaces.test.mjs.bak test/e2e/adv135-surfaces.test.mjs
node --test --test-concurrency=1 test/e2e/adv135-surfaces.test.mjs                                                          # 25 formas, 6 superfícies
rm test/e2e/adv135-surfaces.test.mjs   # fora do plano do autor; remover antes da fase serial canônica

# 5) fase serial canônica (37 arquivos) e fase paralela (180 arquivos, no clone completo)
node --test --test-concurrency=1 $(node -e "…plan.serial…") > $S/serial-full.log    # 80/73/7
cd /private/tmp/audita-review-135 && node --test $(node -e "…plan.parallel…")       # 4210/4209/0/1

# 6) custo
for d in $S/mut133 $S/mut134 /private/tmp/audita-review-135; do node $S/perf.mjs "$d"; done
```
