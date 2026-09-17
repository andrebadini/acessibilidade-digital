# Estado dos 12 critérios de conclusão — 1.1.19

> **Incremento 1.1.43, e o que ele muda aqui.** Artefato corrente
> `release/audita-acessibilidade-1.1.43.zip` (`da5889de…ec2c`), **sem revisão independente ainda**.
> Fecha o **Critical** e os quatro **Minor** da revisão da 1.1.42. O Critical era o par
> identificador→valor **estreitado além do necessário** na 1.1.42 (radical de 5+ letras + cauda de 3+):
> `id="senha"`, `class="password"`, `id="apikey"`, `id="token"`, `id="minhasenha"`, `class="secret"`,
> `id="pin"` e `id="credencial"` voltavam a entregar o conteúdo (160.397 formas reabertas no corpus de
> 198.360 do revisor; a 1.1.41 tinha 6.707). A 1.1.43 devolve ao par o **vocabulário de chave inteiro**
> (menos famílias) e põe a decisão na **forma do conteúdo** (`looksLikeFieldValue`: curto, até 4 palavras,
> sem pontuação de frase) — no trecho, por fragmento de texto com pilha de contexto, e no modelo,
> inclusive no **caminho colunar**, onde o texto vem de `descendantText` e o portão via vazio. Fecha
> também os Minor: a guarda da família passou a conferir **os dois lados e o que sobra depois da flexão**
> (prosa `NOVOS vs 1.1.40` 2.038 → 10, `id` 4.797 → 0 reabertos), o par deixou de apagar **qualquer**
> palavra do dicionário (0, contra 93 da 1.1.41), o export morto `isLanguageWordHead` saiu, e os números que
> não reproduzem ficam **declarados** (escopo serial 57/58 aqui e 55/58 no revisor; a falha da fase
> paralela muda de arquivo entre execuções e passa isolada; `COBERTURA_GANHA` é 5.661 nos meus universos e
> 5.764 nos dele). **Medições:** suíte **4.180/4.178/1** (a única falha é o `release-package` antes de
> reconstruir o zip), escopo serial no pacote **57/58**, gate **GREEN**, auditoria ao vivo **0 falhas / 3
> suspeitas (4 ocorrências) / 9 positivos / 109 no checklist / 28,5% / 9,0 de 10** com versão **1.1.43** e
> quatro exportações `complete`, integridade **146/146 ids e títulos no HTML e no PDF**, notas 5/5, 0
> palavras partidas e 0 `[redacted]`; e as sondas do revisor: caçador **0/13.824**, **0 reabertos** nos
> corpora de 198.360 e de 64.064, **0** texto destruído no dicionário, morfologia PT **0/39**, falsos
> positivos PT-BR `NOVOS=[]`, 880 formas realistas com **0** em prosa/modelo. **8** segue **Parcial** por
> decisão do usuário, fora do caminho de bloqueio.

> **Incremento 1.1.42, e o que ele muda aqui.** Artefato
> `release/audita-acessibilidade-1.1.42.zip` (`4d960106…787e`), **sem revisão independente ainda**.
> Fecha o **Critical** e o **Important** da revisão da 1.1.41 — os dois eram **regressão da 1.1.41**. O
> Critical era a família de **SUFIXO**: como as palavras de sufixo (`token`, `pin`, `bearer`, `session`,
> `seed`, `pass`, `spin`) são elas mesmas radicais de credencial, a exceção poupava `<prefixo><radical>`
> (`xsession`, `novaseed`, `getseed`, `xpin`) e `<radical><cauda><palavra>` (`senhaassinaturatoken`,
> `senhapixpin`), com o valor saindo no modelo guardado e nos artefatos HTML/JSON (7.302 vazamentos em
> 13.824 casos; 1.1.40: 1.830). O Important era o par identificador→valor **apagando evidência legítima**
> (`chavear`, `chavena`, `secretas`, `sessao`, `password`, `cookie-banner`, `map-pin`, `session-info`,
> `token-de-acesso`). A 1.1.42 **redesenha a fronteira** em vez de somar remendos: (a) a família de sufixo
> foi **removida** — ficam só as famílias de prefixo medidas, com guarda simétrica (o prefixo só poupa
> quando o que vem depois não carrega radical); (b) o par identificador→valor passa a exigir **rótulo
> colado** (radical longo + cauda de conteúdo ≥3, prefixo ≤3) e não-família. **Medições com as sondas do
> revisor:** caçador **0/13.824**, 880 formas realistas com **0** em prosa/modelo, E2E dele em Chrome real
> **19/19** com `vazou_em=(nenhuma)` nos 6 casos de identificador e nos 3 de prosa, falsos positivos PT-BR
> **NOVOS=6 → []**. **Medições próprias:** `COBERTURA_PERDIDA=0` em 516.235, morfologia PT **0/39**,
> chaves inocentes **3/55**, bateria de 39 rótulos sem perda, **70/70** nos testes afetados, fase paralela
> **4.180/4.178/1** (a única falha é o `release-package` antes de reconstruir o zip), escopo serial no zip
> **57/58** (a única vermelha é o flake de limpeza do `axe-mv3-csp`, 1/1 isolado), auditoria ao vivo
> **0 falhas / 3 sob revisão humana / 9 positivos / 109 no checklist / 28,5% / 9,0 de 10**, 146/146 ids e
> títulos no HTML e no PDF, notas 5/5, 0 palavras partidas, 0 `[redacted]`. **Preço declarado e medido da
> troca:** palavras inglesas que TERMINAM num radical (`pallbearer`, `allseed`, `antipass`, `chipping`)
> voltam a ser tarjadas em prosa — dicionário **360 → 537** (1.1.40: 563), falso positivo, nunca vazamento.
> No corpus de chaves inocentes do revisor os três lidos como chave são `cupbearer`, `pallbearer` e
> `chipping` (`seedling` é tarjado em prosa/modelo/trecho, não como chave), e o Minor M-3 da revisão
> (assimetria de `senhaassinaturapass`) fecha junto: a forma é tarjada nas quatro superfícies.
> **8** segue **Parcial** por decisão do usuário, fora do caminho de bloqueio.

> **Incremento 1.1.41, e o que ele muda aqui.** Artefato
> `release/audita-acessibilidade-1.1.41.zip` (`0656fd44…5d20`), **sem revisão independente ainda**.
> Fecha os **três Important** da revisão da 1.1.40 — todos da mesma classe, em três posições sintáticas
> diferentes. **I-1 (identificador):** `<div id="senhaassinatura">borboleta</div>`,
> `<div class="senhaassinatura">` e `<div id="chavepix" title="girassol">` entregavam o valor ao modelo,
> ao HTML e ao JSON (resíduo pré-existente, idêntico na 1.1.39); agora o elemento cujo identificador é
> rótulo de credencial perde texto e atributos que carregam valor, com os controles negativos preservados
> (`<button id="token-…">Abrir</button>` mantém o rótulo acessível; `data-chaveiro`/`data-pintura` ficam).
> **I-2 (chave):** a cauda colada **sem prefixo** (`senhaassinatura`, `chavepix`, `data-chavepix`,
> `xchavepix`) entra no vocabulário de chave **sem tocar na lista fechada** — `pin`/`pins` continuam
> tarjados —, e o caçador adversarial do revisor cai de **336 para 0** vazamentos em 1.728 casos, com
> **`COBERTURA_PERDIDA=0`** em 516.235 formas. **I-3 (falsos positivos):** as exceções passam a ser
> **famílias** (prefixo PT — `chaveir`, `pintur`, `pincel`, `tokeniz`, `obsess`, `possess`, `espinh`,
> `opini`, `secretar`, `secretári` — e sufixo inglês que a credencial não usa como cauda — `seed`,
> `session`, `pass`, `spin`, `pping`), medidas nas duas direções: **20 → 0** frases de morfologia
> portuguesa destruídas, dicionário **563 → 360** palavras inocentes destruindo valor, caudas realistas
> **0** em 880 formas, e nenhuma forma `<radical><cauda>` poupada pela família. **Minor M-2 fechado:**
> **12/12** atributos `data-<palavra>` legítimos preservados no trecho. **Resíduo declarado e medido:**
> `pallbearer`, `cupbearer` e `seedling` continuam lidos como chave (a família de sufixo não pode
> poupá-los sem poupar `jwtbearer`/`bearertoken`/`seedphrase`), e radicais curtos seguem sem cobertura de
> chave composta, com teto afirmado em teste. Provas: métrica **11/11**, E2E próprio
> `identifier-credential-mv3` **6/6** nos artefatos entregues, E2E do revisor (eixo de chave) **1/1**,
> fase paralela **4.180 testes / 4.179 passam / 1 pulado / 0 falham**, escopo serial **58/58** nos bytes
> empacotados, auditoria ao vivo no Google com **0 falhas / 3 verificações sob revisão humana / 9
> positivos / 109 no checklist / 28,5% / 9,0 de 10**, 146/146 ids e títulos no HTML e no PDF, notas 5/5,
> 0 `[redacted]` e 0 palavra partida. **8** segue **Parcial** por decisão do usuário, fora do caminho de
> bloqueio.

> **Incremento 1.1.40, e o que ele muda aqui.** Artefato
> `release/audita-acessibilidade-1.1.40.zip` (`8deba155…9a52`), **revisado: 0 Critical novo, 3 Important, 5 Minor** (relatório em `docs/qa/revisoes/REVIEW-1.1.40.md`; os três Important fechados na 1.1.41).
> Fecha o **Critical** da revisão da 1.1.39 e os três Important dela. O Critical era resíduo de quatro
> gerações: `senhaassinatura: borboleta` / `chavepix: girassol` — rótulo **minúsculo** com cauda **fora** da
> lista fechada — chegavam ao modelo e aos artefatos **HTML/JSON entregues**, porque a marca de camelCase
> (que cria a borda) só existe quando há transição de caixa. Agora, na posição de atribuição, o vocabulário
> **permissivo** conta como rótulo reconhecido, menos as **22 palavras da língua medidas** (`chaveiro`,
> `pintura`, `pincel`, `pingente`, `tokenizador`, `secretaria`, `obsessão`, `hairpin`, `spin`, …), em fonte
> única percorrida pela métrica; a forma `prefixo curto + radical longo + cauda` entra na fonte do rótulo
> com **preço medido**: 35 palavras inglesas, **zero** portuguesas. O preço do lado permissivo nas
> superfícies de **chave** foi revertido (1/34 nas três, igual à 1.1.38) e a alegação de cobertura passou a
> valer no universo certo: **`COBERTURA_PERDIDA=0 / GANHA=0` em 516.235**. Medições do pacote: fase paralela
> **4.221/4.220/0/1 EXIT=0**, escopo serial **52/52**, auditoria ao vivo no Google **0 falhas/1 alerta/3
> suspeitas/9 positivos/109 no checklist/28,5%/9,0 de 10**, 146/146 ids e títulos no HTML e no PDF, notas
> 5/5, 0 palavras partidas, 0 `[redacted]`, gate **GREEN**; e o E2E do próprio revisor, rodado nos bytes
> empacotados, mede **S1/S2 = false** nas cinco superfícies. **Resíduos declarados:** `codigo*`/`conta*`
> (radicais fora do vocabulário de propósito), `api.key`, `private_key`, `chave·de·api`, separadores
> exóticos, rótulos codificados no caminho de prosa e rótulo+valor em nós irmãos. **8** segue **Parcial**
> por decisão do usuário, fora do caminho de bloqueio.
>
> **Medições de 17/09/2026 (rodada 86), com o artefato congelado.** Duas medições em Chrome real
> 152.0.7977.64. (a) O **percurso da página atual em modo de pixel não começa**: com `element-only` ou
> `full-evidence`, o clique em "Auditar a página atual" leva a tela a `running` e, ~500 ms depois, um
> *bootstrap* ocioso recria o estado neutro (`initial`, modo de volta ao padrão), o botão de confirmação
> de captura nunca aparece e **nenhum trabalho é criado**; `no-pixels` conclui e chega a `result`. Os
> **bytes empacotados** da 1.1.39 e da 1.1.38 falham **do mesmo jeito** — é **preexistente**, não
> regressão da classe de credencial —, e as sete falhas de `test/e2e/sidepanel-flow-mv3.test.mjs` na fase
> serial são **este defeito**, não oráculo obsoleto. O conserto toca `src/panel/*` e o atendimento de
> bootstrap em `src/background/panel-port.js`, fora dos meus arquivos e dos congelados do incremento
> paralelo: fica **medido, com mecanismo, direção de conserto e prova exigida, e aberto** em
> `docs/qa/2026-09-17-percurso-pixels-pagina-atual.md`. (b) O **critério 4** foi medido no modo que
> conclui: **0 eventos** (rolagem, foco, redimensionamento, tecla, clique), **0 mutações** (inclusive de
> atributo e de texto), geometria, rolagem e foco **idênticos** antes e depois, 5 amostras com **0
> divergências**.

> Artefato corrente
> `release/audita-acessibilidade-1.1.39.zip` (`4ada4e9a…896c`), **sem revisão independente ainda**.
> Fecha os três Important da revisão da 1.1.38 — e o primeiro deles era **regressão do meu próprio
> conserto do C1**: o vocabulário de CHAVE perdeu o conector `de/da/do` (30.550 formas, 23/28 nomes
> realistas vazando em URL, chave JSON e seletor) porque a marca de camelCase era dispensada pela leitura
> contígua do vocabulário de PROSA. Agora a marca só é dispensada quando **os dois** vocabulários
> reconhecem a forma contígua, a marca só fica quando **acrescenta** reconhecimento, e o conector entra no
> vocabulário de chave — medido com as sondas do próprio revisor: **`COBERTURA_PERDIDA=0 / GANHA=0`** em
> 341.164 formas, URL/JSON/seletor com zero vazamentos. O I-3 (C2 nas chaves) fecha com **chave de
> atribuição** no vocabulário de prosa (chave JSON com decodificação, consulta/hash de URL, nome de
> atributo) e vocabulário **fechado** onde a string é identificador — é o que preserva `pintura.png`,
> `secretaria-saude` e `Chaveiro` —, mais as **caudas qualificadoras medidas** (383 → 86 vazando, **0**
> delas cobertas na 1.1.36) e o nome acessível passando pelo tarjador completo (57 → 10); o caçador do
> revisor foi de **329 para 154** vazamentos em 1.260 casos, com **nenhuma** palavra nova no dicionário. O
> I-2(b) fecha o fail-open da limpeza: leitura de aba impossível **não** é "aba ausente" — nada fecha e o
> registro fica em `cleanup-pending`. **Resíduo declarado:** journal forjado com `tabId` **e** `windowId`
> que casam (o vínculo por documento é frágil sob navegação e o atacante já executa código na extensão).
> **10** segue **Atendido**; **11** ganha os resíduos declarados; **12** ganha as medições do pacote
> (paralela **4.221/4.220/0/1**, escopo serial e Google ao vivo). **8** segue **Parcial** por decisão do
> usuário, fora do caminho de bloqueio.

 Artefato corrente
> `release/audita-acessibilidade-1.1.38.zip` (`c3228127…fb0d`), **sem revisão independente ainda**.
> Fecha os dois Critical, o Important da métrica e os dois achados de privacidade da revisão da 1.1.37
> (2 Critical, 7 Important, 6 Minor, 6 observações). **5** de novo, na quinta rodada da mesma classe, e o
> que mudou foi o método: a marca de camelCase passou a ser decidida **por token** (a leitura contígua
> decide se a marca entra), então `SeNhA: abc123` sai como `SeNhA: [redacted]` **sem baixar a caixa do
> texto entregue** — a alternativa em minúsculas segue revertida e registrada; o **prefixo arbitrário**
> antes do radical (`xsenha`, `xsenhaforte`) entra no portão de valor com o radical encerrando o token e
> comprimento ≥ 5, custando **39 palavras do dicionário** (todas compostas inglesas de radical longo,
> zero do português) e devolvendo **0 vazamentos em 72 combinações de valor fraco** onde havia 56; e o E2E
> de formas ganha 4 formas fracas que **reprovam 4 de 4 contra o `src` da geração anterior**. Na
> privacidade, a limpeza **reatesta a aba viva** antes de fechar (D1) e o commit terminal **recusa raster
> sem a alça da tentativa** (D2) — com a fronteira do lote declarada e medida (o E2E
> `batch-pixel-consent-mv3` reprova sem ela). **10** segue **Atendido** com o resíduo do lote declarado;
> **11** ganha o preço do prefixo (+39 palavras no dicionário) e a métrica de 543 combinações; **12**
> segue medindo a partir da árvore de teste do commit. **8** segue **Parcial** por decisão do usuário,
> fora do caminho de bloqueio.

> **Incremento 1.1.37, e o que ele muda aqui.** Artefato corrente
> `release/audita-acessibilidade-1.1.37.zip` (`b6a1a8c0…44de`), **sem revisão independente ainda**.
> Fecha o veredito da 1.1.36 inteiro (2 Critical, 4 Important, 5 Minor, 8 observações). **5** de novo, na
> quarta rodada da mesma classe, e a lição agora é sobre prova: a revisão mediu que o **meu E2E passava
> 17/17 com o `src/` da geração anterior** — um teste que passa com o código antigo não é prova do
> incremento. As seis formas novas reprovam **4 de 6 contra a 1.1.36** e **2 de 6 contra a 1.1.35**, e é
> isso que dá dentes à correção. No produto: o portão de valor aceita comprimento de segredo (12+), 4+
> dígitos ou 8+ com cara de credencial; o radical no **meio** do token é coberto por composto de três
> partes e prefixo curto com cauda; o vocabulário de **chave** volta às **listas fechadas**, preservando
> `pintura.png`, `pincel`, `secretaria-saude` e `hairpin`; e o gate de `id`/rótulo de autor volta ao
> predicado de **prosa**, com a cauda exigindo espaço ou separador — a falha **determinística** que eu
> havia declarado como flake de carga (`normalize-snapshot.test.js`) está fechada. **10** continua
> **Atendido**; **11** ganha o preço declarado do lado do falso negativo (`novasenha: abc123` deixa de ser
> tarjado) e a limitação do CSV; **12** segue medindo a partir da árvore de teste do commit. **8** segue
> **Parcial** por decisão do usuário, fora do caminho de bloqueio.

> **Incremento 1.1.36, e o que ele muda aqui.** Artefato corrente
> `release/audita-acessibilidade-1.1.36.zip` (`8fffa961…56f5`), **sem revisão independente ainda**.
> Fecha o veredito da 1.1.35 inteiro (2 Critical, 1 Important, 3 Minor, 6 observações). **5** de novo, e a
> terceira rodada da mesma classe ensinou o desenho: nem "sem fronteira" (1.1.33), nem "fronteira só no
> fim" (1.1.34), nem "lista fechada" (1.1.35) fecham os dois lados — o que fecha é **regra estrutural com
> decisão de valor no contexto**: o radical conta quando **toca uma borda do token** (recall para
> `senhaforte`, `novasenha`, `session_id`, `chave_api`) e, quando o token não é palavra do vocabulário, o
> valor precisa ter cara de credencial (precisão para `Chaveiro: R$ 30,00`, `Secretaria de Saúde: 12
> unidades`, `The hairpin: 12 units`, `tokenizador: interno`). O sublinhado, o ponto e a barra deixam de
> tarjar o lugar errado (a continuação de identificador entra no rótulo). O preço declarado passa a ser
> medido por predicado com comando (566 chave / 101 valor estrito / 566 prosa), corrigindo o número que a
> revisão refutou. **10** continua **Atendido**; **11** ganha M1 (rota com query), M3 (comando da auditoria
> ao vivo) e o preço correto; **12** segue medindo a partir da árvore de teste do commit. **8** segue
> **Parcial** por decisão do usuário, fora do caminho de bloqueio.

> **Incremento 1.1.35, e o que ele muda aqui.** Artefato corrente
> `release/audita-acessibilidade-1.1.35.zip` (`950b3eb2…9866`), **sem revisão independente ainda**.
> Fecha o veredito da 1.1.34 inteiro (1 Critical, 2 Important, 5 Minor, 10 observações) — e o Critical era
> **regressão minha**: a fronteira de palavra da 1.1.34 cobria só o radical no FIM (`userpin`) e devolveu
> ao entregável o radical no INÍCIO da palavra colada (`senhaforte:`, `sessionid:`, `data-senhaforte="…"`,
> `?sessionid=`, `{"sessionid":…}`), formas que a 1.1.33 tarjava. **5** de novo, com a lição de desenho: um
> vocabulário só não serve para contextos diferentes. A 1.1.35 separa **prosa** (palavra inteira +
> camelCase + prefixo e cauda de credencial em listas fechadas) de **chave** (nome de atributo, chave de
> JSON, chave de URL, `id`, nome no seletor: vocabulário permissivo próprio). Fecha também o Important da
> prosa destruída (`O certificado digital A1…`, `The hairpin: 12 units`) e o rótulo partido por marcação
> (`<b>sen</b>ha:`), além do percent-encoding no rótulo e da rota com chave no penúltimo segmento. **10**
> continua **Atendido**; **11** ganha o preço declarado (203 palavras do dicionário casam no caminho de
> chave, 87 novas) e as correções de número da fase paralela (comando e raiz corretos: 4.210 testes,
> 4.209 passam, 1 pulado, 0 falham) e da fase serial (80/72/8, com as duas flakiness declaradas);
> **12** continua medindo a partir da árvore de teste do commit. **8** segue **Parcial** por decisão do
> usuário, fora do caminho de bloqueio.

> **Incremento 1.1.34, e o que ele muda aqui.** Artefato corrente
> `release/audita-acessibilidade-1.1.34.zip` (`5ed1b333…2812`), **sem revisão independente ainda**.
> Fecha o veredito da 1.1.33 inteiro (1 Critical, 3 Important, 4 Minor, 8 observações). **5** de novo, e
> desta vez o defeito tem **os dois lados medidos**: a fronteira que fechou o falso positivo de "shipping"
> **estreitou** a detecção (o Critical: `userPin`, `cardPin`, `PINpad` e `data-userpin` voltaram a chegar a
> quatro superfícies) e o resíduo de falso positivo que eu havia declarado como observação **destruía
> evidência** (Important: `Chaveiro: R$ 30,00`, `Secretaria de Saúde: 12 unidades`, prosa com data longa e
> `placeholder`/`aria-label` legítimos descartados do trecho; 14 de 16 frases realistas destruídas no
> caminho JSON/MODELO com marcação). A 1.1.34 troca o remendo pelo desenho: **lista única de radicais com
> fronteira de palavra** (palavra inteira, ou fim de palavra com prefixo de duas letras ou mais) e **marca
> interna de camelCase** para não perder `senhaAtual`, `chaveDeApi`, `apiKeys`, `userPin` e `PINpad`. **10**
> continua **Atendido** — nenhum Critical/Important conhecido em aberto depois das correções medidas — e o
> que sustenta isso agora é uma prova **dos dois lados**: o E2E de falso positivo com controle negativo na
> mesma página **reprova 4 de 4** contra os bytes da 1.1.33, e as cinco formas compostas de PIN reprovam
> 5 de 5 contra os mesmos bytes; contra a 1.1.32 as duas gerações de mutação reprovam 4 de 6 na métrica.
> **11** ganha o preço declarado (palavra terminada em radical curto com 2+ letras de prefixo é rótulo:
> `hairpin`, `pushpin`; `spin` fica preservado) e o custo de CPU medido (2,1× no corpus denso de radicais,
> depois de a primeira versão custar 46× e derrubar teste de agenda sob carga). **12** passa a medir a fase
> serial na raiz montada com a **árvore de teste do commit** (`git archive`), corrigindo a reincidência que
> a revisão apontou. **8** continua **Parcial** por decisão do usuário, que o tirou do caminho de bloqueio.

> **Incremento 1.1.33, e o que ele muda aqui.** Artefato corrente
> `release/audita-acessibilidade-1.1.33.zip` (`6b1f2733…ee20`), **sem revisão independente ainda**.
> Fecha o veredito da 1.1.32 inteiro (1 Critical, 3 Important, 4 Minor, 6 observações) — e três dos quatro
> bloqueios eram **regressões minhas da mesma família**, consertar um caso quebrando outro. **5** de novo, e
> a forma do defeito é a mesma das seis revisões anteriores: o vocabulário compartilhado não conhecia
> `PIN`, `CVV`/`CVC`, `PUK`, `seed`, `Número de segurança`, `Linha digitável` nem `Código de barras`, e eles
> chegavam inteiros a quatro superfícies. **10** continua **Atendido**. Duas medições deste incremento
> valem mais que os consertos. A primeira: **o Critical estava sem prova** — a mutação que eu rodo antes de
> cada revisão (restaurar o `privacy.js` da geração anterior e rodar a métrica nova) **passou nos quatro
> testes**, porque a lista não continha as formas de cartão e boleto; a lista foi ampliada para nove formas
> da família, e com os bytes da 1.1.32 a métrica reprova nomeando **24 vazamentos**. A segunda: o
> vocabulário novo entrou como `pins?`, **sem fronteira de palavra**, e `SENSITIVE_KEY` casa substring — o
> "pin" dentro de "ship**pin**g" virou rótulo de credencial e o E2E do **5.9.8** reprovou
> (`autocomplete="shipping street-address"` saía do snapshot como `shipping [redacted]`, e o campo
> legítimo virava falha do item). O conserto tem fronteira (`pin` isolado mais as formas
> `pin-code`/`pinCode`) e controle de não vacuidade: um corpus de **17 palavras que contêm radical curto e
> não são rótulo** e sete frases. O pacote `6f26a822`, medido antes disso, **foi substituído antes de
> qualquer revisão** — nada medido nele vale como atual. **11** ganha duas correções de documentação de
> medida: o total de combinações passou a ser **calculado e afirmado pelo teste** (**57 formas, 222
> combinações**), porque o número citado antes era escrito à mão e não batia com a lista — o Minor
> reincidente das revisões da 1.1.29 e da 1.1.30 —, e o E2E novo passou a estar no plano de teste, que era
> a causa do `TEST_PLAN_UNCLASSIFIED_E2E`. **8** continua **Parcial**
> (não houve teste com pessoa leiga), mas **por decisão explícita do usuário em 2026-09-16 o teste com
> pessoa leiga deixou de ser portão de produção**: ele será feito depois do lançamento e o que ele revelar
> entra como melhoria ou atualização. O protocolo continua no repositório, executável, em
> `docs/qa/2026-09-16-protocolo-teste-pessoa-leiga.md`.

> **Incremento 1.1.32, e o que ele muda aqui.** Artefato corrente
> `release/audita-acessibilidade-1.1.32.zip` (`0f0d5f38…89375`), **revisado**: 1 Critical, 3 Important,
> 4 Minor e 6 observações, todos fechados na 1.1.33.
> Fecha o veredito da 1.1.31 inteiro (2 Critical, 4 Important, 5 Minor). Para os critérios, **5** outra
> vez, e agora com duas lições de método: (a) o gerador de seletor CSS era o **quinto vocabulário**
> privado do produto, só em inglês, e mandava `title="senha …"` inteiro ao relatório, ao modelo e aos
> artefatos; (b) a minha prova de não vacuidade era **falsa** para aquele incremento, porque a marcação
> por conteúdo mascara as formas seguintes no mesmo contêiner — a resposta foi incluir as formas de
> idioma na métrica (com os bytes da 1.1.31 ela reprova com 23 vazamentos) e criar um **E2E de forma
> isolada**, uma página por forma, que reprova 4 das 6 contra os bytes da 1.1.31. **11** ganha um defeito
> meu que a revisão não nomeou e eu encontrei corrigindo: `\s` dentro de template literal virou `s` e o
> tarjador de cauda ficou no-op silencioso — o conserto usa `String.raw` e a métrica fixa a função.
> **10** volta a **Atendido**; **8** continua **Parcial** (não houve teste com pessoa leiga), mas
> **por decisão explícita do usuário em 2026-09-16 o teste com pessoa leiga deixou de ser portão de
> produção**: ele será feito depois do lançamento e o que ele revelar entra como melhoria ou
> atualização. O protocolo continua no repositório, executável, em
> `docs/qa/2026-09-16-protocolo-teste-pessoa-leiga.md`.

> **Incremento 1.1.31, e o que ele muda aqui.** Artefato corrente
> `release/audita-acessibilidade-1.1.31.zip` (`28a53946…32ba`), **sem revisão independente ainda**.
> Fecha o veredito da 1.1.30 inteiro (1 Critical, 3 Important, 5 Minor). Para os critérios, **5** de novo:
> a classe continuava aberta em 24 formas, e a mais grave era de idioma — o rótulo só aceitava ASCII nos
> tokens do sufixo, então `Cartão de crédito:` e `senha do usuário:` não acendiam o sinal. Entram as
> letras acentuadas (`[\p{L}\p{N}]{1,24}`), a "cara de valor" volta a aceitar comprimento de segredo e
> símbolo (por token, descontando a pontuação final de frase) e o sinal passa a exigir valor com cara de
> valor **ou** token final do acumulado, o que preserva prosa comum (`A senha deve ter 8 caracteres`,
> `Chave da API: consulte o manual.`) sem reabrir as formas com valor. **11** ganha também a resposta ao
> Minor reincidente: a métrica da classe virou teste do repositório
> (`test/core/credential-class-metric.test.js`), com comando reproduzível. **10** volta a **Atendido**;
> **8** continua **Parcial**, porque depende de pessoa de fora.

> **Incremento 1.1.30, e o que ele muda aqui.** Artefato corrente
> `release/audita-acessibilidade-1.1.30.zip` (`0c690ba3…f6ae2`), **sem revisão independente ainda**.
> Fecha o veredito da 1.1.29 inteiro (1 Critical, 7 Important, 5 Minor). Para os critérios, **5** é a
> mudança: a classe do C1 — credencial da página chegando às superfícies entregues — continuava aberta em
> 15 formas, porque no sanitizador de trecho a decisão era tomada **depois** de emitir o fragmento e a
> espera por valor era consumida por **estrutura** (comentário, elemento vazio, elemento vazio com
> atributos). A 1.1.30 troca o mecanismo por **marcação por conteúdo**: uma vez que o texto acumulado
> (com entidades e escapes decodificados em até três passagens) mostra sinal de credencial, tudo o que
> vier depois no trecho perde texto e atributos, sem destarjar. Fecha também o **nome acessível** pelo
> fallback de DOM e as **chaves de URL percent-encoded**. A métrica de aceitação tem **125 combinações**
> em quatro caminhos, com **zero segredos sobreviventes** e controles de prosa preservados; o preço
> (perder o texto do trecho depois do sinal, e tarjar `?code=` de promoção) está declarado e medido, com
> **zero custo na página real** (artefatos byte a byte idênticos aos da 1.1.29 no Google). **10** volta a
> **Atendido**; **11** ganha os sete Important e os cinco Minors da 1.1.29, todos com desfecho; **8**
> continua **Parcial**, porque depende de pessoa de fora.

> **Incremento 1.1.29, e o que ele muda aqui.** Artefato corrente
> `release/audita-acessibilidade-1.1.29.zip` (`6926fe17…c74bf`), **sem revisão independente ainda**.
> Fecha o veredito da 1.1.28 inteiro. Para os critérios, **5** é onde está a mudança: a classe do C1 —
> credencial da página chegando ao entregável — continuava aberta em oito formas de HTML comum, e agora o
> sanitizador de trecho decide sobre o **texto acumulado** (entidades decodificadas), a espera atravessa
> fragmentos, elementos vazios sem atributo e tags de fechamento, e o separador aceita aspa literal,
> escapada e codificada. Os dois **Important** também estão fechados: a credencial que chegava pelo **nome
> acessível** de `placeholder`/`alt`/`title` (tarjada por cauda, exigindo cara de valor, para rótulos
> legítimos continuarem sendo evidência) e as chaves de credencial de URL em consulta, fragmento e rota. A
> métrica da classe passou de 81 para **115 combinações**, com **zero** segredos sobreviventes, e a prova
> de não vacuidade é por mutação. **10** volta a **Atendido** (nenhum Critical/Important conhecido em
> aberto); **11** ganha os quatro Minors e as seis observações da 1.1.28, todas com desfecho; **8**
> continua **Parcial**, porque depende de pessoa de fora.

> **Incremento 1.1.28, e o que ele muda aqui.** Artefato corrente
> `release/audita-acessibilidade-1.1.28.zip` (`32647285…070e2`), **sem revisão independente ainda**.
> Fecha o veredito da 1.1.27 inteiro: o **Critical C1** que aquela versão declarava fechado continuava
> aberto quando rótulo e valor estão em **nós diferentes** (`<p>senha: <code>X</code></p>`,
> `<th>chave:</th><td>X</td>`, `<pre>{"senha": "X"}</pre>`) — o valor passa a ser qualquer coisa até a
> quebra de linha, o separador aceita aspa e setas, e o sanitizador de trecho trata o **nó seguinte**
> como valor, tarjando o fragmento e removendo os atributos do próximo elemento. Fecha também o
> fragmento de URL com `code` (regressão estreita que o A7 introduziu), os **plurais em português** e os
> meus números sem escopo. Para os critérios: **5** passa a ter a classe fechada nas duas camadas, com
> prova por mutação composta (sanitizadores exatos da 1.1.27 fazem o E2E do produto reprovar nomeando as
> superfícies; a correção faz passar) e com a fixture do E2E contendo credencial em seis formas, incluindo
> as três de nó cruzado; **10** volta a **Atendido** — nenhum Critical/Important conhecido em aberto, e o
> C1 registrado com a medição que o sustentava e a que o fechou; **11** ganha os cinco Minors e as cinco
> observações da 1.1.27, todas com desfecho; **8** continua **Parcial** (depende de pessoa de fora).

> **Incremento 1.1.27, e o que ele muda aqui.** Artefato corrente
> `release/audita-acessibilidade-1.1.27.zip` (`1962d439…43b586`), **sem revisão independente ainda**.
> Fecha o veredito da 1.1.26 inteiro: o **Important** (o teto de 120 caracteres e o `;` devolviam a
> cauda do valor tarjado), o Minor das formas de credencial que a 1.1.24 tarjava e a 1.1.26 ainda
> perdia, o `compass`, o `auth`/`author*`, os dois nomes de E2E do README e os números sem escopo.
> Para os critérios: **5** é onde está a mudança séria — a revisão mediu que a minha varredura de
> credencial do artefato era **vacuamente verde** (zero rótulos com valor nos quatro formatos) e, ao
> medir sem vacuidade numa fixture que **contém** credencial, apareceu um defeito **Critical
> pré-existente**: o sanitizador de trecho tinha o terceiro e o quarto vocabulário do produto, só em
> inglês, e copiava valor de atributo literalmente, então `senha: S3GR3D0XYZQ` e
> `cartão: 4111 1111 1111 1111` chegavam ao modelo, ao relatório e aos artefatos HTML/JSON entregues.
> As quatro listas passam a vir do mesmo radical, o texto e os atributos usam o mesmo tarjador, e o
> E2E de exportação audita uma página com credencial e **falha** se ela chegar a qualquer superfície
> entregue (provado por mutação). **10** volta a **Atendido** depois da correção, com o Critical
> registrado e fechado — nenhuma versão desta sessão foi declarada candidata com Critical/Important
> aberto. **11** ganha os achados da 1.1.26 (O4 documentado) e o **C1**. **8** continua **Parcial**,
> porque o que falta é teste com pessoa leiga, e isso não se resolve por código.

> **Incremento 1.1.25, e o que ele muda aqui.** Artefato corrente
> `release/audita-acessibilidade-1.1.25.zip` (`499e1de3…d6a23`), **sem revisão independente ainda**.
> Fecha o veredito da 1.1.24 inteiro (A1 a A6) mais os Minors herdados V6, V7 e V9. Para os critérios:
> **5** melhora em dois pontos medidos — o radical de senha voltou a tarjar `bypasscode` e companhia
> (regressão que eu havia introduzido) e o tarjador de valores passou a conhecer rótulos em português;
> **11** fica com o backlog de Minors **vazio**; **2** e **12** foram medidos nos bytes empacotados
> (paralela 4.145/4.144/0 com 1 pulado, `release-package` + `extension-shell` + `release-assets` 19/19
> com o digest fixado, seis E2E do escopo 6/6, E2E de consentimento de pixels 10/10 com a asserção nova
> da manchete, auditoria real do Google com 0 falhas, 9 positivos, 109 no checklist, 18 páginas e quatro
> exportações completas, artefato entregue com notas 5/5 nos dois formatos e proveniência presente);
> **9** ganha a verificação estática do `verify-project` (modo `AUDITA_VERIFY_SKIP_TESTS=1`, verde na
> 1.1.25): manifest MV3 com CSP sem origem remota e sem `unsafe-eval`, axe-core fixado em 4.13.0 no
> pacote e no lock, catálogo **130/146 (96 requisitos / 50 recomendações)**, **identidade neutra**
> (nenhuma marca institucional), HTML/JSON/PDF, fixtures, privacidade e varredura de segredo/origem
> remota em `src/`. **7** fica coberto por essa mesma checagem mais a conferência normativa dos 146
> itens. **10** segue pendente até a revisão da 1.1.25; **8** continua **Parcial**. A execução completa
> do `verify-project` (que roda `npm test`, incluindo a fase serial de Chrome real) fica para depois da
> fase serial.

> **Incremento 1.1.24, e o que ele muda aqui.** Artefato corrente
> `release/audita-acessibilidade-1.1.24.zip` (`978fa19e…665c01`), **sem revisão independente ainda**.
> Ele carrega o que o veredito da 1.1.22 pediu — a cláusula e a lista derivando da mesma fonte, a regra
> de impressão chegando ao Ctrl+P da aba interativa, o oráculo de largura do E2E derivado do `@page`,
> as cinco frases de documentação corrigidas, o import morto e o `node_modules/` no `.gitignore` — mais
> o que a 1.1.23 trouxe em privacidade. Para os critérios: **2** e **12** medidos nos bytes empacotados
> (fase paralela 4.140/4.139/0 com 1 pulado, `release-package` + `extension-shell` 12/12 com o digest
> fixado, seis E2E de Chrome real 6/6, auditoria real do Google com 0 falhas, 9 positivos, 109 no
> checklist, 18 páginas e quatro exportações completas, CSP do HTML entregue batendo com o `<style>`);
> **10** segue pendente até a revisão da 1.1.24; **8** continua **Parcial**.

> **Incremento 1.1.23, e o que ele muda aqui.** Artefato corrente
> `release/audita-acessibilidade-1.1.23.zip` (`7e816d7b…12068`), **sem revisão independente ainda**.
> Três correções, todas com defeito medido antes: o vocabulário sensível passa a cobrir português
> (`?senha=`, `?cpf=` sobreviviam à URL anunciada como sanitizada), o radical de senha deixa de tarjar
> `passed`/`passes`/`bypass`/`passive` (vocabulário do próprio produto) e `listedLimitations` deixa de
> falhar aberto. Para os critérios: **12** está medido nos bytes empacotados desta versão — seis E2E de
> Chrome real **6/6**, auditoria real do Google com 0 falhas, 9 positivos, 109 no checklist, 18 páginas,
> quatro exportações completas e artefato entregue conferido (notas 5/5, proveniência presente, 0
> palavras partidas); **5** e **6** ganham a verificação de que a expansão do vocabulário não alterou o
> relatório entregue; **10** segue pendente até a revisão da 1.1.23; **8** continua **Parcial**.

> **Incremento 1.1.22, e o que ele muda aqui.** O artefato corrente é
> `release/audita-acessibilidade-1.1.22.zip` (`c2d6c44d…5951b5`), ainda **sem revisão independente**.
> Ele fecha três Minors da revisão da 1.1.21: a cláusula em linguagem simples passa a chegar ao
> **PDF/HTML entregue** (não só à aba) e passa a ser derivada do **código** do diagnóstico em vez da
> forma exata da frase; o cabeçalho da tabela de anexos deixa de partir palavra (`Evidênc`/`ia`,
> 3 → 0); e o comportamento de impressão da matriz ganha **guarda automatizada** — um E2E que mede a
> folha na largura real da página e **falha na CSS da 1.1.20** (50 quebras sob compressão) e passa na
> atual. Leva também ao entregue a proveniência que só existia no modelo (viewport, ledger normativo
> com arquivo e SHA-256, método e as cinco notas de integridade normativa), medida nos bytes
> empacotados. Para os critérios: **12** passa a ter medição na versão efetivamente empacotada
> (auditoria real do Google: 0 falhas, 9 positivos, 109 no checklist, 18 páginas, quatro exportações
> completas, notas 5/5 e 0 palavras partidas); **7** ganha rastreabilidade normativa no artefato
> entregue; **2** foi re-verificado (fase paralela 4.137/4.136/0 com 1 pulado, `release-package` +
> `extension-shell` 12/12, seis E2E de Chrome real verdes); **10** segue pendente até a revisão da
> 1.1.22; **8** continua **Parcial**. A frase "mesma paginação de 18 páginas" do bloco abaixo está
> **corrigida** pela revisão da 1.1.21: no A/B controlado a regra imprime uma página a menos, e o
> total depende do conteúdo da captura.

> **Incremento 1.1.20 (apresentação), e o que ele muda aqui.** O artefato corrente passou a ser
> `release/audita-acessibilidade-1.1.20.zip` (`140e30bb…6e1b1`), com duas correções de apresentação
> medidas no artefato entregue da página real: a limitação deixou de ser dita duas vezes no sumário
> executivo (8 → 6 entradas, 2 → 0 repetições, título coerente com a lista) e o rótulo do item deixou
> de quebrar no meio na matriz impressa (**56 → 0**). **A paginação não ficou igual:** em A/B controlado
> sobre o mesmo modelo e o mesmo HTML, a regra da 1.1.21 imprime **uma página a menos** (no HTML da
> 1.1.21, 15 → 14; no HTML da 1.1.22, que acrescenta a proveniência, 16 → 15), e a 1.1.20 tinha trocado
> as 56 quebras de rótulo por **50 palavras partidas** (`Recomendaçã`/`o ABNT`), corrigidas na 1.1.21. Nada
> disso altera contagem, classificação, frase legal ou conclusão. Para os critérios: **2 e 12** foram
> re-verificados com o artefato novo (fase paralela 4180/4179/0, `release-package` 7/7, quatro E2E de
> relatório, impressão e exportação verdes, e `verify-project` **estático** verde com os testes
> pulados — a execução completa do `verify`, que roda a suíte, fica para depois do veredito porque o
> Chrome está com a revisão); **8** melhora em legibilidade mas continua **Parcial**
> por falta de teste com pessoa leiga; **10** volta a depender de veredito, porque a revisão
> independente **do artefato 1.1.20 ainda não saiu** — o checkout congelado é `a73a9e3` em
> `/private/tmp/audita-review-120`. Os números das linhas abaixo continuam sendo os medidos na
> 1.1.19, que é o que eles documentam.

Registro de 16/09/2026, na revisão `dad1cda` (manifest 1.1.19, artefato `audita-acessibilidade-1.1.19.zip`,
SHA-256 `0e429e226e07e5de365e1fed6542398f1d2acb8e80eada4babb78e0e0af14ec9`). Cada linha diz **o que foi
medido**, **como** e **o que falta**. Onde não há medição, está escrito que não há — este documento não
transforma leitura de código em teste de comportamento.

| # | Critério | Estado | Evidência e limite |
|---|---|---|---|
| 1 | Percurso principal sem instabilidade | **Atendido** | O percurso completo roda numa sessão a partir dos **bytes empacotados** (`mandatory-journey-mv3`, 1/1, com o diagnóstico `journey ok; formats=html,pdf,csv,json`). A intermitência de *"the side panel must not resize itself during the journey"* tem **causa estabelecida e é do teste, não do produto**: a linha de base era lida logo após `visibilityState === "visible"`, e isso **não** implica layout — medido no mesmo ponto, `innerWidth/innerHeight` devolveu `0×0` e, mais tarde, na mesma sessão, `360×765`. Quando o layout já ocorreu, a linha de base é real e o percurso passa; quando não, a comparação final culpa o painel por um layout do navegador. A captura passou a esperar por uma caixa definida (a asserção não mudou, e um redimensionamento real continua a falhar), e **3 de 3 execuções passaram** depois disso. **Limite medido em 17/09/2026 (rodada 86):** o percurso da página atual **em modo de pixel** (`element-only`, `full-evidence`) não começa — a tela volta ao neutro por um bootstrap ocioso, nenhuma confirmação de captura aparece e nenhum trabalho é criado; `no-pixels` conclui. O mesmo resultado nos bytes empacotados da 1.1.39 e da 1.1.38 mostra que o defeito é **preexistente** e pertence ao escopo ainda não demonstrado do incremento paralelo (`docs/qa/2026-09-17-percurso-pixels-pagina-atual.md`); a jornada **sem pixels** e a de **URL com pixels** seguem verdes. |
| 2 | Relatório abre e exportações funcionam | **Atendido** | Quatro formatos com recibo `complete` e sha256, medidos a partir do pacote extraído — na fixture (HTML 321 KB, PDF 1,03 MB, CSV 81 KB, JSON 347 KB) e **na página real do Google, com os bytes da 1.1.19** (HTML 337.235 B, PDF 993.996 B com 18 páginas, CSV 86.142 B, JSON 374.160 B), com o percurso inteiro em **4,3 s**. Inspeção do relatório renderizado feita por captura e pelo HTML entregue: zero "Inconformidade ao item …", 112 "Verificar o item …", avisos de fórmula, denominador e estimativa presentes. Rodada 52. |
| 3 | Destaque corresponde ao elemento e documento corretos | **Atendido** | `highlight-marking-mv3` 1/1 e `page-markers-signals-mv3` 1/1 a partir do pacote, com a caixa marcada sobre o elemento auditado; o percurso exige `z-index 2147483647`, área visível e cobertura do elemento. |
| 4 | Inspeção automática não altera visivelmente a página | **Atendido** | O percurso compara rolagem, foco e a marcação do autor antes e depois e passa; `capture-visible-element` 1/1 exige que a captura **preserve a viewport** — o ponto exato onde o Chrome 152 já havia mostrado `clientWidth 1265 → 1280`. **Medição direta em 17/09/2026 (rodada 86), no modo que conclui:** página com elemento fora da dobra, foco e rolagem não triviais (`scrollY=120`, `activeElement=#foco`), contadores de evento e observador de mutações instalados na página antes do clique, linha de base depois de a largura do painel assentar — **0 eventos** (rolagem, foco, redimensionamento, tecla, clique), **0 mutações** (inclusive de atributo e de texto), geometria/rolagem/foco **idênticos** antes e depois, 5 amostras com **0 divergências** (`C4 tela=result amostras=5 divergentes=0`). Os modos com pixels não podem ser medidos enquanto o defeito de começo da página atual estiver aberto. Limite conhecido: captura de regiões fora da viewport. |
| 5 | Evidências autorizadas, corretas e correlacionadas | **Atendido** | `url-pixel-consent-mv3` 1/1 (pausa, one-shot, reinício do trabalhador, limpeza só das abas próprias) e `capture-visible-element` 1/1, executados a partir do pacote. `batch-pixel-consent-mv3` era o único arquivo, além do arquivo do outro incremento, que falhava sozinho: `DOWNLOAD_PROOF_TIMEOUT` aos ~311 s, sempre no mesmo ponto e com quase nenhuma CPU (`user 5,24 s` de 311 s de parede — **esperava**, não calculava). Instrumentei o passo e a prova foi satisfeita **na primeira consulta**, com 5 s de janela; o experimento de uma variável só, com controle nos mesmos minutos, deu arquivo intocado ✖ 312,02 s contra **apenas** `intervalMs: 50` → `250` ✔ **14,93 s**. A consulta a 20 Hz ao IndexedDB da extensão concorria com a exportação de lote em evidência completa que ela esperava. Corrigido no arquivo (a asserção não mudou: quatro artefatos, completos, com byte length e sha256) e verificado na árvore do produto: **14,9 s, 1/1**. **Varredura de segredos em tempo de execução** (nova): o E2E `current-page-export-mv3` agora **pede um destaque** — parte do percurso obrigatório — e por isso a auditoria emite o **nonce do destaque** (`audita:highlight-bindings`, campo `nonce`), além dos ids opacos de capacidade de sessão e de alvo e de qualquer `owner_…`. Ele exige que **nenhum** deles apareça na página auditada, no painel, no relatório, nas URLs de todas as abas, no armazenamento **durável** (`chrome.storage.local`), no modelo e na revisão guardados, nem nos três artefatos de texto entregues (HTML, CSV, JSON; o PDF é fluxo binário comprimido e o teste **não** afirma tê-lo varrido). Medido: **3 segredos — dois ids de capacidade e o nonce do destaque — × 9 superfícies, zero vazamentos**, com asserção de não vacuidade (`highlightNonces > 0`) para que a varredura do nonce não possa passar sem ter varrido nonce nenhum. Antes disso havia só contenção estática em testes unitários. **Na 1.1.27**, a revisão da 1.1.26 mediu que a varredura de rótulo sensível do artefato era **vacuamente verde** (0 rótulos-com-valor em HTML, JSON, CSV e PDF: qualquer lista, inclusive vazia, passaria) e o meu driver do Google não tinha varredura nenhuma. Medindo sem vacuidade — fixture com `senha: S3GR3D0XYZQ` em texto, `cartão: 4111 1111 1111 1111` e `chave: …` em atributo e credencial na URL, no percurso real de exportação — apareceu o **Critical C1**: o sanitizador de trecho (`src/core/evidence/snippet.js`) tinha o terceiro e o quarto vocabulário do produto, só em inglês, e copiava valor de atributo literalmente, então as duas credenciais chegavam ao modelo guardado, ao relatório e aos artefatos HTML/JSON entregues. Corrigido: as quatro listas vêm do mesmo radical de `privacy.js`, o texto e os atributos passam pelo mesmo tarjador, e o E2E de exportação agora **exige** a credencial na página (fonte provada) e a proíbe em painel, relatório, URLs, armazenamento durável e de sessão, modelo, revisão e nos três artefatos de texto — com a URL do escopo sanitizada e sem a consulta inteira quando algum parâmetro é sensível. Não vacuidade provada por mutação: com o sanitizador anterior o E2E reprova nomeando `relatório, modelo e revisão guardados, artefato html, artefato json`. |
| 6 | Contagens distinguem falhas, suspeitas e checklist | **Atendido** | Medido no produto entregue, **na versão atual e em rodadas rastreáveis**: fixture com quatro defeitos injetados (rodada 53) — **4 falhas confirmadas (5 ocorrências), 0 recomendações, 7 suspeitas (7 ocorrências), 6 positivos, 104 no checklist separado**, e no JSON as 146 asserções separadas em **4 `failed` / 107 `cantTell` / 29 `inapplicable` / 6 `passed`**, com as 4 frases legais correspondendo exatamente aos 4 itens confirmados. Página real do Google (rodada 52) — **0 / 1 / 3 (4 ocorrências) / 9 e 109 no checklist**, com **zero** frases legais. Checklist por **item**, não por elemento. |
| 7 | Conclusões ABNT respeitam obrigatoriedade, alternativas e limites | **Atendido** | Texto de 5.9.1 e 5.9.7 lido no PDF do usuário (impressas 22–23). Zero "Inconformidade ao item …" no Google (0 falhas) e no relatório de fixture apenas para as duas falhas reais (5.13.10, 5.9.3); 5.9.7 sai como "Verificar o item 5.9.7". Três revisões independentes mediram a retirada das condenações indevidas. **E os 146 itens foram conferidos um a um contra o PDF** (16/09): natureza e título sem nenhuma divergência, referências WCAG iguais em 143 e nas 3 restantes a diferença está medida e declarada — incluindo 5.9.4, em que a norma imprime nível A e o catálogo normaliza para AA com nota editorial própria. |
| 8 | Interface e relatório completos, claros, usáveis por leigos | **Parcial** | Inspeção do relatório entregue confirma sumário executivo, rosca com "não é uma nota de acessibilidade", fórmula e denominador explícitos, cobertura à parte, quatro grupos nomeados com texto além da cor, prioridades, registro de decisão, mapas de anúncios, matriz dos 146 itens, metodologia com versão e hashes. Os seis blocos didáticos que a meta exige estão no relatório entregue: **quem é afetado** (`impact`), **o que foi observado** (`observed`), **por que importa**, **como corrigir** (`correction`), **como verificar manualmente** (`guidance.reviewSteps` + `guidance.example`) e **quais evidências permitem concluir e quais faltam** — este último como bloco explícito de confirmação, diferenciado por desfecho: `html.js:227-232` diz o que confirmar para resultado positivo ("mantenha este registro como evidência positiva … e reavalie se a página mudar"), revisão humana ("registre a decisão humana, a justificativa e as evidências consideradas"), alerta e falha ("repita a verificação após a correção"), e `:463` imprime "Como confirmar" com a instrução específica da ocorrência. Não fiz teste de usabilidade com pessoa leiga. **Decisão do usuário (2026-09-16): esse teste não é impeditivo para a produção** — será feito depois do lançamento e o que ele revelar entra como melhoria ou atualização. O protocolo permanece em `docs/qa/2026-09-16-protocolo-teste-pessoa-leiga.md`. Com isso, o critério deixa de ser pendência de bloqueio e passa a item de acompanhamento pós-lançamento. |

> **O que a varredura automática acrescenta ao critério 8, e o que ela não substitui.** A interface do
> próprio produto passou a ser conferida por nome acessível em três superfícies: o **painel** nas sete telas
> (`initial`, `running`, `result`, `batch`, `single-url`, `start-failed`, `unavailable`), a **casca estática
> da aba** (campo do avaliador com `<label for>`, diálogo com `aria-labelledby`) e o **documento entregue**
> nas duas variantes (vivo e resumo impresso). Resultado: nenhum `button`/`input`/`select`/`textarea`/`a` sem
> nome, e a checagem tem teste contra exemplo sintético para não ser vacuosa. Isso cobre o que se pode
> afirmar por medição automática sobre a interface; **não fecha o critério 8**, que continua **Parcial**
> porque clareza para leigos só se mede com uma pessoa de fora tentando usar o produto.
| 9 | Recursos obrigatórios implementados | **Atendido** | Verificados por execução: percurso, exportações, destaques, personas sob CSP (1/1 a partir do pacote) e auditoria de várias URLs (`audits exactly two explicit URLs invisibly in one sanitized no-pixels batch report`, medido pelo revisor). Verificados por leitura (existe e é alcançável, não código morto): menu de contexto (`contextMenus` + `service-worker.js:2129/2137`) e o caminho de lote (`PANEL_START_BATCH_AUDIT` → `startBatch`). Módulo de leitor de tela e anúncios: `src/panel/persona-session.js` mais o mapa de anúncios que liga marcador, elemento e prévia (`html.js:550`), e o aviso honesto exigido pela meta está em **cinco** pontos do relatório entregue — `html.js:250` ("não é transcrição literal de tecnologia assistiva"), `:466` ("não é transcrição literal de VoiceOver, NVDA, JAWS ou outro leitor de tela"), `:550`, `:755` ("pode variar conforme o navegador, a API da plataforma, o leitor, o modo e as preferências") e `report-view.js:744`, que é o caminho de produção. Limite: não testei com leitor de tela real — que é exatamente o que o aviso declara. |
| 10 | Sem falha Critical/Important conhecida | **Atendido** | **Atualização de 17/09/2026 (rodadas 87–89):** a classe de credencial teve **sete reprovações consecutivas** de revisões independentes, cada uma fechada com medição nas duas direções; a última (**1.1.42**) mediu **1 Critical** — o par identificador→valor estreitado além do necessário, com 160.397 formas reabertas no corpus de 198.360 do revisor — e **4 Minor**, todos fechados na **1.1.43**, cujas medições (0 reabertos nos corpora de 198.360 e 64.064, 0 texto destruído no dicionário, morfologia PT 0/39, falsos positivos PT-BR zerados, E2E do revisor 19/19 e 13/13) **aguardam a revisão independente da própria 1.1.43**. O outro achado aberto continua sendo o **percurso da página atual em modo de pixel**, documentado em `docs/qa/2026-09-17-percurso-pixels-pagina-atual.md` e pertencente ao incremento paralelo. | As revisões da 1.1.16 a 1.1.18 acharam 1 Critical e 6 Important, **todos corrigidos** com não vacuidade demonstrada. A revisão independente da 1.1.19 deu **0 Critical e 2 Important, nenhum dos dois no produto**: (a) a limitação da 5.9.7 é canonizada antes da entrega e por isso não chega aos artefatos — conferi por medição que o item **não** desaparece (146 asserções, uma por item, sempre; `cantTell` ≠ `passed` no texto entregue), de modo que a afirmação a corrigir era a minha, não o código; (b) cinco documentos de usuário afirmavam inspeção em cópia temporária para a página atual, que desde `1c9b296` roda na própria página — corrigidos, e as três cadeias **do produto** que falam em cópia foram conferidas por alcance e só valem no fluxo de URL `attached-copy`, onde são verdadeiras. A mesma revisão **refutou** a minha hipótese de que as 4 falhas de prontidão seriam teto de 30 s do harness: elas são cascata do primeiro subteste, que morre antes de cancelar e deixa o painel em `privacy-paused`. **Nenhuma das 9 falhas morre em asserção sobre o resultado de uma auditoria**, e a varredura de 34 arquivos isolados confirmou: 32 passam sozinhos. Medição final da fase serial, depois das correções: **65 testes, 56 passam, 9 falham — e as 9 estão todas em `test/e2e/sidepanel-flow-mv3.test.mjs`**, o arquivo do outro incremento. `axe-mv3-csp` e `batch-pixel-consent-mv3` deixaram de falhar. **A revisão da 1.1.26 deu 0 Critical, 1 Important e 5 Minor**, e o Important era regressão minha do conserto do N2 (teto de 120 caracteres e `;` devolviam a cauda do valor tarjado). **Na 1.1.27** esse Important está fechado com métrica da largura da classe (28 formas, zero sentinela sobrevivente), junto com os cinco Minors e as três observações pertinentes. E a mesma revisão, ao pedir medição sem vacuidade, levou ao **Critical C1** (credencial da página chegando aos artefatos entregues), **pré-existente e não uma regressão de incremento**, também corrigido e fixado por E2E com prova de mutação. Estado corrente: nenhum Critical/Important conhecido em aberto. **A revisão da 1.1.27 deu 1 Critical, 0 Important, 4 Minor e 5 observações**: o Critical era o **mesmo C1, ainda aberto** quando rótulo e valor moram em nós diferentes — medido ponta a ponta nos bytes empacotados, com o E2E reprovando nomeando `relatório, modelo e revisão guardados, artefato html, artefato json`. **Na 1.1.28** ele está fechado nas duas camadas, com mutação composta reproduzindo a falha e a correção fazendo o E2E passar; os três Minors (fragmento de URL com `code`, plurais em português, números sem escopo) também. Nenhuma versão desta sessão foi declarada candidata com Critical/Important aberto. **A revisão da 1.1.29 está em andamento**; antes dela, a da 1.1.28 deu 1 Critical e 2 Important (a classe do C1 aberta em oito formas de HTML comum, a credencial chegando pelo nome acessível e as chaves de credencial de URL), todos fechados na 1.1.29 com métrica da classe em 115 combinações e prova por mutação. **A revisão da 1.1.30 deu 1 Critical, 3 Important, 5 Minor e 5 observações** e a da **1.1.31**, **2 Critical, 4 Important, 5 Minor e 5 observações** — a mesma classe, em formas novas a cada geração —, todas fechadas nos incrementos seguintes. **A revisão da 1.1.32 deu 1 Critical, 3 Important, 4 Minor e 6 observações**, e três dos quatro bloqueios eram regressões minhas: a guarda que fez o tarjador desistir da marcação, o scanner de cauda que passou a tarjar 15 de 29 frases de prosa e o E2E fora do plano que abortava `npm test`. Os quatro estão fechados na 1.1.33. O que fica registrado deste incremento é que **o Critical de vocabulário estava sem prova**: a mutação contra os bytes da 1.1.32 passava, porque a métrica não continha as formas de cartão e boleto; a lista foi ampliada para nove formas da família e o E2E de forma isolada para as duas medidas nos artefatos. **Nenhuma versão desta sessão foi declarada candidata com Critical/Important aberto**, e a 1.1.33 aguarda revisão independente. **Achado aberto, declarado em 17/09/2026 (rodada 86):** o percurso da **página atual em modo de pixel** não começa (bootstrap ocioso devolve o painel ao neutro antes de o registro da auditoria existir), medido de forma idêntica nos bytes empacotados da 1.1.38, da 1.1.39 e da 1.1.40 — é **preexistente** e está no escopo ainda não demonstrado do incremento paralelo ("Página atual sem interação visível", seção C), com as sete falhas de `test/e2e/sidepanel-flow-mv3.test.mjs` sendo **este defeito**. Não é falha de nenhuma revisão da classe de credencial e **não foi consertado aqui** para não editar os mesmos arquivos em paralelo; fica medido, com mecanismo, direção de conserto e prova exigida, em `docs/qa/2026-09-17-percurso-pixels-pagina-atual.md`. |
| 11 | Achados menores documentados | **Atendido** | Trilha `docs/qa/2026-09-13-continuity-and-e2e-triage.md` e `docs/qa/2026-09-12-form-family-review.md`: M2 (corrigido), remediação por ocorrência no cartão (analisado), vocabulário português do `SENSITIVE_KEY` (**implementado** na 1.1.23, ampliado na 1.1.27 e com os plurais na 1.1.28), técnicas restantes de ocultação em 5.9.1, `inputPurpose` de 5.9.8, alvo de `aria-labelledby` em shadow root, rótulo em contêiner com rolagem, limitação de captura, as 8 falhas obsoletas do `service-worker` com causa estabelecida, e **os três achados de apresentação da inspeção visual da 1.1.19 (rodada 54)** — limitações duplicadas no sumário executivo, códigos internos no sumário (deliberado, fixado em teste) e **56 dos 146 números de item quebrados no meio na matriz do PDF**. **Na 1.1.33** entram duas correções de documentação de medida: o total de combinações da métrica da classe passou a ser **calculado e afirmado pelo teste** (**75 formas, 286 combinações**, com o número impresso como diagnóstico), porque os 125 citados antes eram escritos à mão e não batiam com a lista — o Minor reincidente das revisões da 1.1.29 e da 1.1.30 —, e o E2E novo passou a estar no plano de teste, que era a causa do `TEST_PLAN_UNCLASSIFIED_E2E`. |
| 12 | Versão empacotada testada em Chrome real | **Atendido** | Os 199 arquivos do zip são byte a byte idênticos à árvore (conferido por mim em 1.1.17, 1.1.18 e 1.1.19, e por dois revisores de forma independente), **e** o pacote extraído foi executado em Chrome real: percurso completo, exportações, destaques, sinais, privacidade de URL e persona sob CSP. **Na 1.1.19, e em página real**, a rodada 52 executou o pacote extraído contra `https://www.google.com/` e fechou o percurso em 4,3 s com as quatro exportações `complete`, o relatório declarando 1.1.19 e o HTML entregue sem nenhuma frase legal. **A execução sobre bytes empacotados continuou em cada incremento desde então** — 1.1.22, 1.1.23, 1.1.24 e 1.1.25 têm, cada uma, os seis E2E do escopo verdes na raiz extraída do zip e uma auditoria real empacotada conferida (notas 5/5 nos dois formatos, proveniência presente, 0 palavras partidas); os números de cada uma estão nos blocos do cabeçalho deste documento. **Na 1.1.36**, a raiz extraída do zip `8fffa961…56f5` rodou a fase serial (80 testes, 71 passam, 9 falham: 7 no arquivo do outro incremento e 2 flakiness declaradas, que passam 29/29 isoladas com os dois arquivos de credencial) e a auditoria ao vivo deu 0 falhas, 1 alerta, 3 suspeitas (4 ocorrências), 9 positivos, 109 no checklist, 28,5%, 9,0/10, PDF de 18 páginas, 118 ocorrências, 11 evidências, 146/146 ids e títulos, notas 5/5, 0 palavras partidas, 0 `[redacted]`. **Na 1.1.35**, a fase paralela foi medida no **clone completo** (com `.git` e `release/`, que a raiz extraída do zip não tem — correção apontada pela revisão da 1.1.34): 4.210 testes, 4.209 passam, 1 pulado, 0 falham; e a fase serial, na raiz extraída do zip com a árvore de teste do commit, deu 80 testes, 72 passam, 8 falham (7 no arquivo do outro incremento e 1 flake declarada, que passa isolada). **Na 1.1.34**, a raiz de medição passou a ser montada com a **árvore de teste do próprio commit** (`git archive <commit> test scripts package.json fixtures`, hash conferido contra `git show <commit>:…`), corrigindo a reincidência que a revisão da 1.1.33 apontou; a fase serial completa rodou nos bytes `5ed1b333…2812` (37 arquivos, 80 testes, 70 passam, 10 falham: 7 no arquivo do outro incremento e 3 em arquivos de flakiness sob carga que passam 11/11 isolados) e o E2E de forma isolada e de falso positivo passou 17/17 na raiz extraída do zip. **Na 1.1.33**, a raiz extraída do zip `6b1f2733…ee20` rodou a **fase serial completa do plano** (36 arquivos, `--test-concurrency=1`): **74 testes, 65 passam e as 9 falhas estão todas em `test/e2e/sidepanel-flow-mv3.test.mjs`**, o arquivo do outro incremento; os 6 arquivos de escopo e as 8 formas isoladas de credencial passam, e a mutação com o `privacy.js` da 1.1.32 reprova exatamente as duas formas de cartão e boleto. A **auditoria real do Google** nesses bytes deu 0 falhas, 1 alerta, 2 suspeitas (2 ocorrências), 9 positivos, 108 no checklist, 29,2%, 9,0/10, PDF de 17 páginas, 4 exportações `complete`, 146/146 ids e títulos no HTML e no PDF, notas 5/5 nos dois, 0 palavras partidas e 0 `[redacted]`; uma segunda medição dos MESMOS bytes deu 3 suspeitas (4 ocorrências), 109, 28,5% e 18 páginas — variação de instância da página, não de versão. **Na 1.1.32**, a raiz extraída do zip `0f0d5f38…89375` rodou **22 testes de Chrome real** — os 16 de escopo mais os **6 de forma isolada** (`credential-shapes-mv3`, uma página por forma) —, a fase serial (32/35 nesta passagem, com três vermelhos que passam isolados) e a auditoria real do Google com os mesmos números (18 páginas, 146/146 ids e títulos, 0 palavras partidas, notas 5/5 nos dois formatos). **Na 1.1.29**, a raiz extraída do zip `6926fe17…c74bf` repetiu os **16 testes de escopo** (com a fixture de credencial em onze formas), a **fase serial** (34/35, o vermelho no arquivo de outro incremento) e a **auditoria real do Google** com os mesmos números — 18 páginas, 146/146 ids e títulos, 0 palavras partidas, notas 5/5 nos dois formatos e proveniência presente. **Na 1.1.28**, a raiz extraída do zip `32647285…070e2` repetiu os 16 testes de escopo, a fase serial (34/35, o vermelho no arquivo de outro incremento) e a auditoria real do Google com os mesmos números — 18 páginas, 146/146 ids e títulos, 0 palavras partidas, notas 5/5 e proveniência nos dois. **Na 1.1.27**, a raiz extraída do zip `1962d439…43b586` rodou os **16 testes de escopo** (incluindo o de exportação com a fixture de credencial), a **fase serial completa de 35 arquivos** (34 verdes; o vermelho é o arquivo de outro incremento) e uma **auditoria real do Google** com 18 páginas, 146/146 ids e títulos, 0 palavras partidas, notas 5/5 no PDF e no HTML e proveniência nos dois — mais a página 1 do PDF conferida a olho. A única etapa não exercitada é o ato de descompactar em si, que é o que o `unzip` faz. **Na 1.1.38**, a raiz de medição foi um **clone completo** (com `.git` e `release/`) com os bytes do zip sobrepostos e `git status` limpo: a fase paralela deu **4.218 testes, 4.217 passam, 0 falham, 1 pulado**, EXIT=0 — o número que a revisão da 1.1.37 tinha refutado (4.210/4.207/2) e que agora está medido no artefato corrente. Os arquivos de escopo em Chrome real na raiz empacotada deram **63 testes, 56 passam e 7 falham — todas as 7 em `test/e2e/sidepanel-flow-mv3.test.mjs`**, o arquivo do outro incremento; passam, entre outros, `credential-shapes-mv3` (23/23, com as 4 formas fracas novas), `credential-false-positives-mv3` (4/4), `current-page-export-mv3` (4 exportações verificadas), `url-pixel-consent-mv3` (pausa, one-shot, reinício do trabalhador, `document-drift=denied`, limpeza só das abas próprias), `batch-audit-mv3`, `batch-pixel-consent-mv3` (a fronteira do lote declarada no D2), `retention-indexeddb-mv3`, `page-markers-signals-mv3`, `blob-lifecycle` e `field-label-review`; `axe-mv3-csp` falhou na passagem cheia (`cleanup axe limitado falhou`) e **passa 1/1 isolado**, como já estava declarado. A **auditoria ao vivo no Google, do pacote e sem pixels**, deu **0 falhas confirmadas (0 ocorrências)**, 1 recomendação/alerta, **3 suspeitas a confirmar (4 ocorrências)**, 9 resultados positivos, **109 no checklist**, cobertura **28,5%** com denominador 130, índice **9,0/10**, **PDF de 18 páginas**, 4 exportações `complete`, 146/146 ids e títulos no HTML **e** no PDF, notas editoriais **5/5** nos dois, **0 palavras partidas**, **0 `[redacted]`** no HTML e no JSON, 0 "Inconformidade ao item" e 112 "Verificar o item", versão **1.1.38** declarada no artefato. **Na 1.1.39**, a raiz foi um clone completo no commit `746a696` com o zip `c49a48d0…4769` sobreposto: fase paralela **4.221 / 4.220 passam / 0 falham / 1 pulado, EXIT=0**; fase serial de escopo na raiz empacotada (11 arquivos, com a guarda de nome em campo customizado, as superfícies do produto sob o axe e 5.9.7/5.9.8) **52/52, 0 falhas**; auditoria ao vivo no Google, do pacote e sem pixels, **0 falhas (0 ocorrências), 1 alerta, 3 suspeitas (4 ocorrências), 9 positivos, 109 no checklist, 28,5%, 9,0/10, PDF de 18 páginas**, quatro exportações `complete`, versão **1.1.39** no artefato, 146/146 ids e títulos no HTML e no PDF, notas 5/5 nos dois, 0 palavras partidas e 0 `[redacted]`; gate `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify` **GREEN**.  **Na 1.1.43**, a raiz extraída do zip `da5889de…ec2c` rodou o **escopo serial** (12 arquivos) **57/58** — a única vermelha é o flake de limpeza do `axe-mv3-csp`, que passa **1/1 isolado** —, o gate deu **GREEN**, a **auditoria ao vivo do pacote** declarou **1.1.43** com 0 falhas confirmadas, 3 suspeitas a confirmar (4 ocorrências), 9 positivos, 109 no checklist, 28,5%, 9,0/10 e quatro exportações `complete`, e o instrumento de integridade mediu **146 itens, 146/146 ids e títulos no HTML e no PDF**, notas 5/5, **0 palavras partidas** e **0 `[redacted]`**. **Na 1.1.42**, a raiz extraída do zip `4d960106…787e` rodou o **escopo serial** (12 arquivos, incluindo o E2E do eixo de identificador) **57/58** — a única vermelha é o flake de limpeza do `axe-mv3-csp`, que passa **1/1 isolado** —, o gate deu **GREEN**, a **auditoria ao vivo do pacote** declarou **1.1.42** com 0 falhas confirmadas, 3 verificações sob revisão humana (4 ocorrências), 9 positivos, 109 no checklist, 28,5%, 9,0/10 e quatro exportações `complete`, e o instrumento de integridade mediu **146 itens, 146/146 ids e títulos no HTML e no PDF**, notas editoriais 5/5, **0 palavras partidas** e **0 `[redacted]`**; a **inspeção visual** da página 1 do PDF entregue e dos seis blocos didáticos do HTML está registrada na rodada 88. **Na 1.1.41**, a raiz extraída do zip `0656fd44…5d20` rodou o **escopo serial** (12 arquivos em Chrome real, incluindo o E2E novo do eixo de identificador) **58/58**, a **fase paralela** deu **4.180 testes / 4.179 passam / 0 falham / 1 pulado EXIT=0**, o gate `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify` deu **GREEN**, e a **auditoria ao vivo do pacote** contra `https://www.google.com/` declarou **1.1.41**, 0 falhas confirmadas, 3 verificações sob revisão humana (4 ocorrências), 9 positivos, 109 no checklist, 28,5%, 9,0/10, quatro exportações `complete`, **146/146 ids e títulos no HTML e no PDF**, notas 5/5, 0 palavras partidas e 0 `[redacted]`; a conferência byte a byte do zip contra o commit `4df8c8c` deu **199 arquivos, nenhum divergente**. |

## O que impede declarar produção agora

0. **Estado em 1.1.39, para não ler o histórico como se fosse o presente.** Os critérios 1 a 7, 9, 10,
   11 e 12 estão **Atendidos** com a evidência medida nos bytes empacotados da 1.1.39 (fase paralela
   4.221/4.220/0/1, escopo serial 52/52, auditoria ao vivo no Google com 0 falhas/1 alerta/3 suspeitas/9
   positivos/109 no checklist/28,5%/9,0 de 10, PDF de 18 páginas, 146/146 ids e títulos, gate GREEN); o **8**
   continua **Parcial** porque depende de uma pessoa de fora, mas **por decisão do usuário (2026-09-16)
   deixou de ser portão de produção**; e a **revisão independente da 1.1.39** é o único portão que falta —
   os vereditos anteriores deram 2 Critical e 7 Important (1.1.37) e 3 Important (1.1.38), **todos
   fechados**, com um resíduo declarado e medido (journal de posse forjado com `tabId` e `windowId` que
   casam). Os itens 3
   e 5 abaixo descrevem o estado de 1.1.19/1.1.22 e ficam como histórico do caminho, não como pendência
   de agora: o teste do caminho imutável com recibo parcial **foi escrito** (`test/export/report-export.test.js`,
   com mutação provando o portão nos dois sentidos).
1. **Nada do meu lado está em aberto nos critérios 1, 5 e 10.** A correção da linha de base do painel não só passa 3 de 3 como foi **falsificada**: forçando uma mudança real de caixa durante o percurso (321×654), a asserção reprova com a mensagem certa, e a linha de base agora é um `360×765` de verdade — os dentes continuam lá. A falha de exportação de lote era a taxa de consulta do próprio teste (controle: 312 s falhando; só o intervalo alterado: 14,9 s passando).
2. **Trabalho que não é meu** — as **9** falhas restantes da fase serial estão todas em `sidepanel-flow-mv3.test.mjs`, e pedem reescrita das expectativas de posse para o modo anexado (e um `finally` que cancele a tentativa do primeiro subteste, para acabar com a cascata). O arquivo está modificado no worktree por outro incremento, com fixture de observação passiva ainda em andamento; editar por cima seria adivinhar trabalho alheio. O achado está registrado com medição e o caminho de correção escrito.
3. **Critério 10 fecha** com 0 Critical e 2 Important, ambos de documentação/afirmação e ambos resolvidos sem tocar em byte de produto — que é o que a própria revisão recomendou. Nenhuma versão desta sessão foi declarada candidata com falha Critical/Important aberta.
4. **Critério 8** continua sem teste de pessoa leiga, **mas deixou de ser impedimento por decisão do
   usuário (2026-09-16)**: o teste será feito depois do lançamento e o resultado entra como melhoria.
   O protocolo executável fica no repositório.
5. **A suspeita sobre `persistExportSuccess` foi fechada por leitura da cadeia, sem mudança de produto** — o estado `report.status: 'pending'` criado pelo agregado de lote (`aggregate-audits.js:154`) nunca chega à exportação: `runBatch` sempre enriquece antes de devolver (`run-batch.js:391`, `return finalModel`) e o enriquecimento grava `review-ready` com artefato `pending` (`enrich-audit.js:111-113`), que é exatamente o par que escolhe o validador tolerante a recibo parcial (`export-controller.js:185-189`). Não há caminho em que o painel ofereça exportar e o `pending` derrube a exportação; a decisão de produto está registrada no registro de achados (**auditoria com artefato pendente é exportável**, com recibo `partial` e limitações quando houver). Fica faltando **um teste**, não um conserto: o caminho imutável com recibo parcial, a escrever com RED próprio quando o fluxo de lote rodar em Chrome.

## Decisões que dependem do usuário, não de mim

- **Vocabulário do portão de privacidade** (`SENSITIVE_KEY`): ampliar para "senha", "sessão", "chave" e afins muda a redação de campos legítimos que contenham esses termos. O efeito é sempre fail-closed. **Decidido e implementado** (a lista em português entrou na 1.1.23; as caudas estrangeiras, os plurais e o `auth(?!or)` na 1.1.27), e a decisão de produto que fica é a direção fail-closed: tarjar a mais, nunca a menos.
- **Fronteira de privacidade dos campos editáveis customizados**: recuperar o nome acessível de um `div[role=textbox][contenteditable=true]` exige decidir se o conteúdo editável (do usuário) pode ser lido para prova. Não foi decidido nesta sessão, e o item 5.9.1 permanece em revisão agregada por causa disso.
- **Publicação**: nenhuma ação externa de distribuição foi executada, e nenhuma será sem autorização específica.
