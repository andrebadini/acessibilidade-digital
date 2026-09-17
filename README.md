# Audita Acessibilidade

Extensão MV3 para auditoria local de acessibilidade de uma página, com regras da ABNT NBR 17225:2025, referências WCAG 2.2, evidências e revisão assistida. O processamento local evita enviar conteúdo da página a um serviço externo.

## Instalação e estado da entrega

**Versão 1.1.41 preparada — sem revisão independente ainda.** A revisão da **1.1.40** confirmou por medição
própria tudo o que aquela geração tinha de real — em especial que o **Critical da 1.1.39 está fechado de fato**
no caminho de prosa/modelo, com E2E por caso em Chrome real e controle de não vacuidade — e mediu **3
Important**: (I-1) o rótulo da credencial num **identificador** (`<div id="senhaassinatura">borboleta</div>`,
`<div class="senhaassinatura">`, `<div id="chavepix" title="girassol">`) entregava o valor ao **modelo, ao HTML
e ao JSON** — resíduo pré-existente, idêntico na 1.1.39; (I-2) a troca de predicado nas **chaves** tirou
cobertura da própria família do Critical (`sanitizeJsonData({senhaassinatura: …})`, `?senhaassinatura=`,
`data-chavepix`), regressão latente no código de produto; (I-3) a lista de exceções cobria o que os revisores
mediram, não a **classe** — 20 de 39 frases de morfologia portuguesa eram destruídas (`Chaveiros:`,
`Pinturas:`, `Secretarias:`, `Tokenização:`) e a prosa sem separador virava tarja inteira
(`A loja vende chaveiros personalizados.`).

A 1.1.41 fecha os três eixos com medição nas duas direções (nenhuma forma de credencial perdida, nenhuma
palavra da língua destruída). As exceções passam a ser **famílias** — radicais de prefixo (`chaveir`,
`pintura`→`pintur`, `pincel`, `tokeniz`, `obsess`, `possess`, `espinh`, `opini`, `secretar`, `secretári`) e
sufixos ingleses que a credencial não usa como cauda (`seed`, `session`, `pass`, `spin`, `pping`) —, e o
vocabulário de chave ganha a **cauda colada sem prefixo** (`senhaassinatura`, `chavepix`, `data-chavepix`,
`xchavepix`) sem tocar na lista fechada, que continua tarjando `pin`/`pins`. O valor de um elemento cujo
identificador é rótulo de credencial deixa de ser entregue (texto e atributos que carregam valor), com os
controles negativos preservados: `<button id="token-…">Abrir</button>` mantém o rótulo acessível e
`data-chaveiro`/`data-pintura` continuam na evidência. **Medições desta geração:** métrica da classe **11/11**
com as famílias percorridas pela asserção; **`COBERTURA_PERDIDA=0`** em 516.235 formas; caçador adversarial do
revisor **336 → 0** vazamentos em 1.728 casos; caudas realistas **0** em 880 formas; dicionário com
**563 → 360** palavras inocentes destruindo valor e **20 → 0** frases de morfologia; corpus de chaves do
revisor **3/55** (o mesmo resíduo da 1.1.40) e **12/12** atributos `data-<palavra>` preservados no trecho;
E2E novo `identifier-credential-mv3` **6/6** e o E2E do revisor (eixo de chave) **1/1**, ambos em Chrome real
com as quatro exportações. **Resíduo declarado e medido:** `pallbearer`, `cupbearer` e `seedling` continuam
sendo lidos como chave (a família de sufixo não pode poupá-los sem poupar `jwtbearer`/`bearertoken`/
`seedphrase`), e os radicais curtos (`pin`, `puk`, `seed`, `auth`) seguem sem cobertura de chave composta —
o teste afirma o teto para o resíduo não crescer.

**Versão 1.1.40.** A revisão da **1.1.39** confirmou tudo o
que aquela geração entregou (fase paralela 4.221/4.220/0/1, escopo serial 52/52, gate GREEN, auditoria ao
vivo reproduzida, 146 itens, axe do produto sem violação) e mediu **1 Critical e 3 Important** — o Critical
era **resíduo de quatro gerações**: `senhaassinatura: borboleta` e `chavepix: girassol`, com rótulo
**minúsculo** e cauda **fora** da lista fechada, chegavam ao modelo e aos **artefatos HTML/JSON entregues**,
sem nenhum `[redacted]`. A causa é a assimetria que a revisão mediu: o camelCase (`SenhaAssinatura:`) fechava
porque a marca cria a borda de palavra, e a cauda listada fechava pela lista — a cauda desconhecida em
minúscula não tinha nem uma coisa nem outra.

A 1.1.40 fecha isso na **posição de atribuição** (`rótulo: valor`, rótulo de um token): o vocabulário
**permissivo** passa a contar como rótulo reconhecido, menos as **22 palavras da língua medidas** pelos
revisores (`chaveiro`, `chaveta`, `chaveamento`, `secretaria`, `pintura`, `pincel`, `pingente`, `tokenizador`,
`obsessão`, `hairpin`, `spin`, …) — a lista é fonte única e a métrica a percorre, de modo que acrescentar um
radical sem conferir colisões derruba o teste. A forma `prefixo curto (1-3) + radical longo + cauda`
(`xsenhapix`) entra na fonte do rótulo com **preço medido no dicionário**: 35 palavras inglesas e **zero**
portuguesas. O preço do lado permissivo nas superfícies de **chave** foi revertido — chave JSON, consulta de
URL e nome de atributo voltam ao vocabulário fechado (**1/34 nas três, igual à 1.1.38**), que agora inclui a
regra de prefixo e continua fechando `xsenha`/`data-xsenha`. E a alegação de cobertura passou a valer no
universo certo: **`COBERTURA_PERDIDA=0 / GANHA=0` em 516.235 formas**. Medições do pacote: fase paralela
**4.221/4.220/0/1**, escopo serial **52/52**, auditoria ao vivo no Google com 0 falhas, 1 alerta, 3 suspeitas,
9 positivos, 109 no checklist, 28,5%, 9,0 de 10, 146/146 ids e títulos no HTML e no PDF, notas 5/5, 0
palavras partidas e 0 `[redacted]`; o E2E do próprio revisor, rodado nos bytes empacotados, mede **S1/S2 =
false** nas cinco superfícies. **Resíduos declarados:** `codigo*`/`conta*` (radicais fora do vocabulário de
propósito — `Conta: R$ 30,00` é evidência), `api.key`, `private_key`, `chave·de·api`, separadores exóticos,
rótulos codificados no caminho de prosa/modelo e rótulo+valor em nós irmãos.

**Versão 1.1.36 — revisada: 2 Critical, 4 Important, 5 Minor e 8 observações**, todos fechados na 1.1.37.
A revisão da **1.1.35** deu **2 Critical,
1 Important, 3 Minor e 6 observações** e **reprovou** o artefato. Ela confirmou por medição própria, com
controle positivo na mesma página, que o desenho por contexto fechou o que a 1.1.34 tinha aberto (as 12
formas de concatenação foram de 12/12 vazando para **0/12**; a prosa destruída, de 8/19 para **0/19**),
mas mediu dois bloqueios: a **lista fechada de caudas** só cobria o que enumerava — `novasenha`,
`redefinirsenha`, `trocarsenha`, `senhasegura` voltaram a vazar, formas que a 1.1.33 **e** a 1.1.34
fechavam — e o **sublinhado** (e o ponto, e a barra) fazia o extrator parar no radical, **tarjar o lugar
errado** e entregar o segredo literal (`senha[redacted] VALOR`), defeito pré-existente nas quatro gerações
e pior que não tarjar, porque parece protegido.

A 1.1.36 troca a lista fechada por **regra estrutural com decisão de valor no contexto**: o radical conta
quando **toca uma borda do token** — começa nele (`senhaforte`, `Chaveiro`) ou termina nele (`novasenha`,
`userpin`); com as duas bordas livres, `pin` dentro de `shipping` continua fora. Não há mais cauda para
enumerar: **41 concatenações medidas, 0 vazam**. O preço do recall é pago no valor: quando o token **não**
é palavra do vocabulário, o valor precisa ter cara de credencial, e é isso que mantém `Chaveiro: R$ 30,00`,
`Secretaria de Saúde: 12 unidades`, `The hairpin: 12 units` e `tokenizador: interno` como evidência —
rótulo que **é** palavra do vocabulário mantém a semântica de atribuição (`senha: abc` sai inteiro). A
**continuação de identificador** (`senha_forte`, `senha.mestra`, `senha/mestra`, `session-id`) entra no
rótulo e tarja o lugar certo; o valor de atributo passa a usar predicado **estrito**, preservando
`placeholder="Chaveiro de latão"` e `autocomplete="shipping street-address"`; as frases que só valem com
separador saem do vocabulário de cauda (`conta corrente 12345-6` é prosa, `Conta corrente: 12345-6` é
rótulo); e o sinal de credencial passa a ser **derivado** das decisões do tarjador (sinal ⟺ tarja, ou
rótulo pendente no fim), porque antes `Pingente: prata` acendia o sinal sem tarja e o trecho inteiro caía.
O preço declarado, que a revisão refutou, passa a ser medido por predicado com comando: **566** palavras do
dicionário no caminho de chave, **101** no predicado estrito de valor, **566** no de prosa.

**Versão 1.1.35 — revisada: 2 Critical, 1 Important, 3 Minor e 6 observações**, todos fechados na 1.1.36.
A revisão da **1.1.34** deu **1 Critical, 2 Important, 5 Minor e 10 observações** e **reprovou** o artefato. O Critical era **regressão minha**: a
fronteira de palavra da 1.1.34 cobria só o radical no **fim** da palavra (`userpin`) e devolveu ao
entregável o radical no **início** da palavra colada — `senhaforte:`, `tokenacesso:`, `sessionid:`,
`data-senhaforte="…"`, `?sessionid=`, `{"sessionid":…}` —, formas que a 1.1.33 tarjava. O Important I1
era o outro lado: as frases que eu tinha acrescentado e a regra genérica de prefixo destruíam prosa
(`O certificado digital A1 é válido`, `The hairpin: 12 units`). O I2 era pré-existente: `<b>sen</b>ha: X`,
o rótulo partido por marcação, vazava nas quatro superfícies.

A 1.1.35 tira a lição de desenho: **um vocabulário só não serve para contextos diferentes**. Agora há
**dois** — o de **prosa** (palavra inteira, camelCase, prefixo de credencial como `user`/`card`/`data` e
cauda de credencial como `id`/`key`/`acesso`/`forte`/`dousuario`, com o conector `de/da/do/d`, em listas
**fechadas**, que é o que separa `senhaforte` de `chaveiro`) e o de **chave** (nome de atributo, chave de
JSON, chave de URL, `id`, nome no seletor: **permissivo**, com o radical em qualquer posição, como a
1.1.33 fazia para tudo). As frases `certificado digital`, `conta corrente`, `assinatura eletrônica` e
`dígito verificador` valem em prosa **só com separador** e continuam valendo como chave; `hairpin`, `spin`
e `chaveiro` voltam a ser palavra. O rótulo partido por marcação é lido por uma **segunda leitura sem
espaço** entre fragmentos, o caminho JSON decide sobre duas projeções (com e sem espaço entre tags), o
**percent-encoding** entra no decodificador (`sen%68a:`), o pré-filtro aceita **escape octal** e a rota com
chave no penúltimo segmento (`#/auth/senha/X`) tarja o último. O preço declarado mudou de lado e está
medido: **203 palavras** do dicionário casam no caminho de chave (contra 284 da 1.1.33 e 87 novas).

**Versão 1.1.34 — revisada: 1 Critical, 2 Important, 5 Minor e 10 observações**, todos fechados na 1.1.35.
A revisão da **1.1.33** deu **1 Critical, 3 Important, 4 Minor e 8 observações** e **reprovou** o artefato. O Critical era **estreitamento meu**: a
fronteira de palavra que fechou o falso positivo de "shipping" devolveu à página `userPin`, `cardPin`,
`PINpad` e `data-userpin`, que voltaram a chegar a quatro superfícies entregues. O Important mais grave
mediu o outro lado, e é o que muda o desenho daqui em diante: o resíduo de falso positivo que eu havia
declarado como observação **destruía evidência** — `Chaveiro: R$ 30,00` e `Secretaria de Saúde: 12
unidades` viravam tarja, `placeholder="Chaveiro"` era descartado inteiro do trecho, e no caminho
JSON/MODELO **14 de 16 frases realistas** com marcação eram destruídas (`<p>A senha deve ser forte</p>`
saía como `<p>A [redacted]`).

A 1.1.34 troca o remendo pelo desenho. O vocabulário passa a ser uma **lista única de radicais com
fronteira de palavra**: um radical casa a palavra inteira (`senha`, `senha:`, `pin`) ou o **fim** de uma
palavra com prefixo de duas letras ou mais (`userpin`, `datapin`), nunca o meio — é isso que tira
`Chaveiro`, `Secretaria`, `tokenizador`, `chaveamento`, `obsessão` e `passível` da tarja. O camelCase, que
era a razão de não haver fronteira nenhuma, passa a ter **marca interna** nas transições
minúscula→maiúscula (`senhaAtual`, `userPin`, `PINpad` continuam fechados) e a marca é removida de toda
saída. Do outro lado, a decisão de "cara de valor" passa a descartar marcação colada na cauda (`</p>`) e
datas com ano de quatro dígitos, e a string com marcação é decidida na projeção sem tags. Entram `dígito
verificador`, `conta corrente`, `certificado digital` e `assinatura eletrônica`; `agência`, `matrícula` e
`protocolo` ficam fora por decisão. O preço está declarado e medido: palavra terminada em radical curto
com 2+ letras de prefixo é rótulo (`hairpin`, `pushpin`), e `spin` fica preservado.

A revisão também mostrou que a suíte de formas passava **8/8 dos dois lados** da mutação — prova sem
dentes para a fronteira. Entram cinco formas compostas de PIN e um E2E novo de **falso positivo**
(`credential-false-positives-mv3`), com controle negativo na mesma página para a medição não ser vacuosa:
contra os bytes da 1.1.33, **9 dos 17 testes reprovam**. A métrica da classe vai a **75 formas e 286
combinações** calculadas, e reprova 4 de 6 testes contra cada uma das duas gerações anteriores.

**Versão 1.1.33 — revisada: 1 Critical, 3 Important, 4 Minor e 8 observações**, todos fechados na 1.1.34.
A revisão da **1.1.32** deu **1 Critical,
3 Important, 4 Minor e 6 observações**, e três dos quatro bloqueios eram **regressões minhas**, todas da
mesma família: consertei um caso e quebrei outro. O Critical era pré-existente e de vocabulário — `PIN`,
`CVV`/`CVC`, `PUK`, `seed` de 2FA, `Número de segurança`, `Linha digitável` e `Código de barras` de boleto
não estavam no vocabulário compartilhado e chegavam inteiros a quatro superfícies. O primeiro Important era
meu: uma guarda que eu escrevi para não tarjar marcação (`&& !/[<>]/u.test(token)`) fez o tarjador de cauda
**desistir**, e `<div title="senha X">` e `<p><b>senha</b> X</p>` saíam **intactos** — na 1.1.31 saíam
tarjados. O segundo era pior: o scanner da cauda multi-palavra aceitava palavra de 12+ letras como valor, e
**15 de 29 frases realistas** passaram a ser tarjadas (`A senha expira em 12/03 e pode ser trocada no
portal.` → `A [redacted]`), inclusive uma que os meus próprios documentos declaravam intacta. O terceiro era
de ferramenta: `npm test` abortava com `TEST_PLAN_UNCLASSIFIED_E2E` porque o E2E novo não estava no plano.

A 1.1.33 fecha os quatro. O vocabulário de cartão e boleto entra na fonte única. Para a guarda, a resposta
certa **não** era desistir: é **pular a marcação** entre o rótulo e o valor, o que fecha os dois casos ao
mesmo tempo. O predicado da cauda multi-palavra passa a exigir **6+ caracteres com dígito ou símbolo** — o
preço declarado é que `cartão de crédito correcthorsebattery` (frase-senha só de letras) deixa de ser
reconhecida pela cauda multi-palavra e continua sendo pelo rótulo adjacente e por qualquer separador. E o
E2E novo está registrado no plano.

O Critical da 1.1.33 quase ficou **sem prova**, e quem mostrou foi a mutação que eu rodo antes de cada
revisão: rodando a métrica da classe com o `privacy.js` da geração anterior, os
quatro testes **passavam** — a lista não continha as formas de cartão e boleto, então o "0 vazamentos" valia
para a geração anterior, não para o defeito. A métrica ganhou o grupo de **cartão e boleto** (nove formas) e
quatro controles de prosa que falam do dado sem trazer valor; com os bytes da 1.1.32 ela reprova nomeando
**24 vazamentos** e reprova a metade positiva do teste de sinal, e com os da 1.1.33 passa. O E2E de forma
isolada ganhou as duas formas medidas nos artefatos (`CVV`, `Linha digitável`). O total de combinações
passou a ser **calculado e afirmado pelo teste** — **57 formas, 222 combinações** —, porque o número que os
documentos citavam antes era escrito à mão e não batia com a lista (era ele o Minor reincidente das revisões
da 1.1.29 e da 1.1.30).

E a fase serial do primeiro pacote da 1.1.33 pegou **uma regressão minha que a métrica não veria**: o
vocabulário de cartão entrou como `pins?`, **sem fronteira de palavra**, e como a chave sensível casa
substring, o "pin" dentro de "ship**pin**g" virou rótulo de credencial. O E2E do item **5.9.8** reprovou,
porque `autocomplete="shipping street-address"` saía do snapshot como `shipping [redacted]` e um campo
legítimo virava falha. Não era caso de teste: `Pintura: látex acrílico`, `Opinião do cliente: ótima`,
`Pincel: cerda sintética` e `Espinha de peixe: 12` também eram tarjadas. O conserto tem fronteira de palavra
para o rótulo isolado (`PIN: 4712`, `Pins: 12`, `meu_pin: 4712`) e formas compostas explícitas
(`pin-code`, `pin_code`, `pinCode`, `pincode`, `PIN CODE`), e o controle é um corpus de **17 palavras que
contêm radical curto e não são rótulo** mais sete frases — sem ele, estreitar o radical não teria prova. O
pacote medido antes disso (`6f26a822`) **foi substituído antes de qualquer revisão**, e o artefato corrente
é `6b1f2733…ee20`.

Medido nesses bytes: gate de release GREEN; fase paralela no **clone completo** (com `.git` e `release/`)
com **4.210 testes, 4.209 passam, 1 pulado, 0 falham**; fase serial na raiz extraída do zip **com a árvore
de teste do próprio commit**: 80 testes, 72 passam, 8 falham — 7 no arquivo do outro incremento e 1 flake
declarada, que passa isolada; E2E de forma isolada e de falso positivo **17/17 verdes**; métrica da classe
em **0 de 92 formas e 347 combinações**; e auditoria ao vivo no Google, do pacote, em modo sem pixels:
**0 falhas confirmadas, 1 recomendação/alerta, 3 suspeitas a confirmar (4 ocorrências), 9 resultados
positivos, 109 verificações no checklist, cobertura 28,5%, índice 9,0/10, PDF de 18 páginas**, quatro
exportações `complete`, **146/146 ids e títulos no HTML e no PDF**, notas editoriais 5/5 nos dois, 0 palavras
partidas e **0 `[redacted]`** no HTML e no JSON. A página do Google entrega conteúdo diferente em sessões
diferentes — medições da mesma versão deram 2 ou 3 suspeitas, 108 ou 109 no checklist, 28,5% ou 29,2% e 17
ou 18 páginas —, e a diferença é de instância, não de versão.

A revisão da **1.1.31** deu **2 Critical, 4 Important, 5 Minor e 5 observações**, e o diagnóstico dela é o que
importa. Ela confirmou o conserto de
idioma ponta a ponta (com fixture isolada, os bytes da 1.1.30 entregam `Cartão de crédito:` em quatro
superfícies e os da 1.1.31 não entregam nenhuma), mas mostrou que a classe continuava aberta em **10 das 24
formas** medidas antes, mais quatro famílias novas — e encontrou o **quinto vocabulário privado** do
produto: o gerador de seletor CSS, só em inglês, que transformava `title="senha …"` em
`input[title="senha …"]` e mandava o valor ao relatório, ao modelo e aos artefatos.

Duas outras coisas que a revisão mediu merecem registro. A primeira é que a **minha prova de não vacuidade
era falsa para aquele incremento**: restaurar os sanitizadores da versão anterior e rodar o E2E de
exportação **passava**, porque a marcação por conteúdo é monotônica e um crédito reconhecido antes mascara
as formas seguintes no mesmo contêiner. A segunda é que a abertura do rótulo para aceitar acento criou
**sete tarjas novas em prosa realista** — `Segredo de justiça: o processo tramita em sigilo.` entre elas —,
inclusive uma frase que os meus próprios documentos declaravam intacta. E, no meio disso, a revisão expôs
um defeito meu de escape: ao reescrever o tarjador de cauda num template literal comum, `\s` virou `s` e a
função ficou **no-op silencioso**.

A 1.1.32 fecha tudo isso: a janela do rótulo aceita quatro palavras (com parênteses e hífen), entram as
formas qualificadas em português (`código de verificação`, `frase de recuperação`), a cauda sem separador
ganha um **scanner de tokens** (o regex não consegue exigir "token com cara de valor" com janela
preguiçosa, porque o motor se compromete com a primeira segmentação), o gerador de seletor passa a usar o
vocabulário compartilhado, e a tarja do rótulo com separador passa a decidir pelo **valor** — valor com
cara de valor ou token único —, o que preserva prosa (`Segredo de justiça:`, `Senha do usuário: mínimo de
8 caracteres.`, `Chave da API: consulte o manual.`) sem reabrir credencial. A não vacuidade passou a ter
duas provas com dentes: a métrica inclui as formas de idioma no grupo de vazamento (com os bytes da 1.1.31
ela reprova com 23 vazamentos) e um **E2E de forma isolada** (`credential-shapes-mv3`, uma página por
forma) reprova 4 das 6 formas contra os bytes da 1.1.31.

Os seis E2E de escopo citados nas versões anteriores são **percurso obrigatório**
(`mandatory-journey-mv3`), exportação da página atual, impressão executiva, layout de impressão,
quebras de impressão e proveniência de versão. A revisão da **1.1.24** saiu favorável
(**0 Critical, 0 Important**, 4 Minor + 2 observações) e aprovou aquele artefato como candidato. A 1.1.25
fecha o que ela achou: o **A2**, uma regressão de privacidade que eu introduzi na 1.1.23 — o lookbehind de
dois caracteres deixava escapar `bypasscode`, `bypass_code`, `bypasswd`, `bypass_key` e `bypassword`, que
**era tarjado antes** (o radical agora exige cauda de credencial); o **A1**, o tarjador de valores que só
conhecia rótulos em inglês (`senha: …` passava intacto); o **A3**, `node_modules/` com barra que não ignorava
o symlink; o **A4**, uma frase do README que o próprio delta contradisse; e o **A5**, um total de testes que
eu citava sem declarar a seleção. Traz também os Minors herdados **V6** (códigos com a mesma frase viram uma
entrada), **V7** (a deduplicação não depende mais da forma do código) e **V9** (o build recusa pacote com
hash de CSP divergente do CSS estagiado). A revisão da **1.1.22** saiu e é favorável (**0 Critical, 0 Important**, 4 Minor + 3 observações, nada bloqueante): os três Minors que aquele incremento se propôs a fechar foram reproduzidos nos bytes empacotados e a guarda de impressão foi julgada **mais forte que a alegação** — ela falha também quando a regra está presente mas ineficaz. A **1.1.24** traz o que aquele veredito pediu: as cinco frases de documentação que a medição não sustentava, a cláusula e a lista derivando da **mesma fonte** (um diagnóstico só na página não pode gerar cláusula sem entrada na lista), a regra de impressão chegando também ao **Ctrl+P da aba interativa** — que partia 198 palavras na matriz —, o oráculo de largura do E2E derivado do **`@page`** da própria folha em vez de uma constante, o import morto removido e `node_modules/` no `.gitignore`. A
1.1.22 fechou os três Minors que a revisão da 1.1.21 apontou (cláusula em linguagem simples chegando ao
PDF, cabeçalho de anexo inteiro, guarda automatizada do comportamento de impressão) e levou ao
relatório entregue a proveniência que só existia no modelo. A **1.1.23** acrescenta duas correções de
**privacidade e integridade de dado**, ambas com defeito medido antes da correção:

- **Vocabulário sensível só em inglês.** `sanitizeEvidenceUrl('…?senha=s3gredo&cpf=12345678900&id=7')`
  devolvia a URL **com** `senha` e `cpf`; `sanitizeJsonData` deixava passar `senha`, `cpf` e
  `chaveAcesso` enquanto tarjava `token`. Entraram `senha`, `segredo`, `credencial`, `sessão`,
  `autenticação`, `autorização`, `chave`, `cpf`, `cnpj` e `cartão`, sem radicais curtos que pegariam
  palavra legítima ("conta" pegaria "contato", "pix" pegaria "pixelRatio", "rg" pegaria "cargo").
- **O radical de senha engolia dado do próprio produto.** `pass(?:word|wd)?` casava `passed`,
  `passes`, `bypass` e `passive` — resultado de item, contagem `passes` do JSON, 2.4.1 Bypass Blocks e
  observação passiva. Um dado cru com essas chaves era tarjado e sumia. O radical daquele incremento
  (histórico, **não** o vigente) era `pass[-_ ]?(?:word|wd|code|phrase|key)|(?<!by)pass(?![-_a-z])|pwd`;
  o vigente na 1.1.27 é o de `src/core/privacy.js`, com as caudas estrangeiras, as formas compostas e o
  `(?<!by)(?<!com)pass`.
- **`listedLimitations` falhava aberto:** entrada fora de lista devolvia `[]`, o que faria o relatório
  afirmar "Limitações registradas (0)" e esconder limitações reais. Entrada inválida agora falha alto.

Verificação: os consumidores do sanitizador e da política de texto fecharam verdes, e os dois patches
aplicados juntos num clone limpo do HEAD anterior. Os seis E2E de Chrome real e a auditoria empacotada
da 1.1.23 **já foram executados** (6/6 e 0 falhas / 9 positivos / 109 no checklist / 18 páginas); o que
falta da 1.1.23 é apenas a revisão independente, que ficou coberta pela revisão da 1.1.24.

A revisão da
1.1.21 deu **0 Critical, 0 Important e 5 Minor** e aprovou aquele artefato como candidato: a regressão
Important da 1.1.20 está fechada e foi **reproduzida por detector independente** — na matriz do PDF
entregue, **56 quebras de rótulo de item** na 1.1.19, **0 quebras de item e 50 palavras partidas** na
1.1.20 (`Recomendaçã` / `o ABNT`) e **0 e 0** na 1.1.21, com A/B/C controlado sobre os mesmos bytes de
modelo (0 / 50 / 0) e conferência página a página.

Três afirmações minhas **não se sustentaram como escritas** e estão corrigidas aqui: (a) a paginação
**mudou** — no A/B controlado sobre o mesmo modelo, a regra nova imprime **uma página a menos**
(15 → 14); os totais ao vivo (18 / 18 / 17) vêm de capturas com conteúdo diferente e não isolam causa,
e "18 páginas" é propriedade de uma captura, não do artefato; (b) "0 fragmentos de palavra" valia para
a **matriz**, não para o documento: restavam **3** quebras no cabeçalho da tabela de anexos
(`Evidênc` / `ia`), pré-existentes desde a 1.1.19; (c) a cláusula em linguagem simples do Minor 5
existia **só na aba interativa** e não chegava ao HTML/PDF entregue.

A **1.1.22** completa o que faltava: a cláusula em linguagem simples passa a ser derivada do **código
do diagnóstico** (não da forma exata da frase) e chega aos dois renderizadores; o cabeçalho de tabela
não parte mais palavra (`thead th{overflow-wrap:normal}`), zerando as 3 quebras do anexo; o relatório
entregue passa a trazer a proveniência que já estava no modelo (método, regras, **viewport observado**,
**ledger normativo com arquivo e SHA-256** e as **cinco notas de integridade normativa**); e um E2E
novo mede a folha de impressão na largura real da página, com controles positivos que **falham na CSS
da 1.1.20 (50 quebras **sob compressão de coluna injetada pelo teste**, que é o que reproduz a pressão do
conteúdo real; sem ela a fixture não quebra, porque 126 dos 146 itens são "Não aplicável" — por isso a asserção
é `> 0`, não "50") e passam na atual**. O teste do baseline `78ba813` deixou de depender do
diretório de invocação — era ele que fazia uma cópia sem `.git` registrar 1 falha que não era do
produto.

**Versão 1.1.20 — revisão independente concluída: pode substituir a 1.1.19, com o Important acima.**
Ela corrigiu dois defeitos de apresentação medidos no PDF entregue da 1.1.19, nenhum de correção.
Primeiro: o sumário executivo listava **8 limitações para 6 frases distintas**, porque a
frase simples de um diagnóstico de política entrava na lista junto da forma `CÓDIGO: mensagem`; agora
a lista mantém a forma com código, não repete a frase, e o título conta o que a lista mostra.
Segundo: **56 dos 146 números de item quebravam no meio** na matriz impressa (`5.10.` numa linha, `1`
na seguinte). Contagem, classificação, frase legal e conclusão não mudam em nenhuma das duas.

**Versão de produção 1.1.19 (revisada):** a revisão independente da 1.1.18 confirmou que os três
achados Important anteriores estavam fechados, mas mediu um quarto, da mesma classe: quando um campo
tem o atributo nativo `required` **e** um token ARIA malformado, o coletor deixa o estado sem
observação e a devolução antecipada de "faltam dados" **descartava todos os alvos do item** — um
campo obrigatório sem marcação nenhuma na mesma página sumia do HTML, do JSON e do PDF, e o item
caía no checklist genérico. Corrigido: a falta de dado passou a ser limitação declarada, não motivo
para silenciar o que foi observado. Na mesma revisão, o terceiro sítio que pode imprimir a
referência legal passou a exigir nota, autor e data como os outros dois. Como isso muda o que o
relatório decide e apresenta, o pacote passa a se identificar como 1.1.19. Os registros da 1.1.18,
1.1.17, 1.1.16 e 1.1.15 ficam abaixo.

**Versão de produção 1.1.17:** a revisão independente da 1.1.16 encontrou um achado
**Critical** no produtor de obrigatoriedade de 5.9.7 — ele convertia marcações legítimas
(`label::after`, `aria-labelledby`, `placeholder`, rótulo longo) em infração confirmada e imprimia
a frase legal de não conformidade — e um achado Important no teste de pacote, que conferia apenas
a reconstrução e nunca o arquivo entregue. A fronteira foi corrigida: 5.9.7 voltou a ficar em
revisão nos dois sentidos. Como isso muda o que
o relatório decide, o pacote passou a se identificar como 1.1.17. Os registros da 1.1.16 e da 1.1.15
ficam abaixo.

**Versão de produção 1.1.16:** a 1.1.15 foi revisada de forma independente no
artefato `5619e27d…`, com veredito de que podia substituir o candidato. Depois dessa revisão
entrou o produtor de obrigatoriedade de 5.9.7, que fez o relatório **decidir** onde antes ele
relatava dado ausente — e um relatório que decide diferente é outro produto. Por isso o pacote
passou a se identificar como 1.1.16, e o registro da 1.1.15 fica abaixo.

**Versão de produção 1.1.15:** o candidato 1.1.14 foi congelado e revisado no SHA
`607fc02`; desde então entraram nesta árvore as correções apontadas pela revisão independente
(recomendação não atendida deixando de receber a frase de inconformidade, decisão humana sem nota
deixando de carimbar falha confirmada, e URL de recurso deixando de levar query para o relatório),
a origem dos sinais numerados na página e o primeiro produtor de recorte de 5.9.1. Por isso o pacote
passou a se identificar como 1.1.15, para não se confundir com o candidato revisado. Registro da
1.1.14 preservado abaixo.

**Versão de produção 1.1.14 entregue:** confira o [registro de validação e pacote](docs/qa/2026-09-12-production1114-release.md). A meta foi retomada em 12/09 e encerrada após correções, revisões independentes, testes no Chrome e avaliação do Google com esta versão. Distribuição local, sem publicação em loja.

A versão **1.1.20** tem [guia de instalação e uso](docs/COMO-USAR.md). Novas auditorias registram a versão instalada; antigas mantêm a versão de origem. Guias didáticos, grupos ABNT, sinais e evidências permanecem disponíveis. Checklist geral, suspeitas concretas e falhas são separados; a revisão automática não certifica conformidade integral. Resultados de versões anteriores são históricos, não comprovação de execução desta versão.

Google na **1.1.14**, em 12/09: 0 falhas de requisitos confirmadas, 1 recomendação não atendida e 2 verificações com suspeitas (3 ocorrências); PDF de 24 páginas e quatro formatos exportados. Histórico preservado: [validação e Google da 1.1.13](docs/qa/2026-09-08-beta1113-release.md). Não são testes simultâneos ou de estados idênticos da página.

1. Descompacte o arquivo da versão entregue em uma pasta própria. Se estiver usando o código-fonte, use esta pasta do projeto.
2. Abra `chrome://extensions` no Chrome.
3. Ative o **Modo do desenvolvedor**.
4. Escolha **Carregar sem compactação** e selecione a pasta que contém o `manifest.json`.
5. Fixe “Audita Acessibilidade” na barra do navegador, se desejar. Ao clicar no ícone, o Chrome abre o painel lateral persistente ao lado da página.

Para gerar o pacote distribuível a partir do código-fonte, execute `npm run build:release`. O ZIP criado em `release/` contém somente o manifesto, o código executável local, o axe-core empacotado e os ícones necessários, com `manifest.json` na raiz.

## Uso básico

Abra a página que deseja examinar, clique no ícone da extensão e escolha um dos três modos de evidência:

- **Evidência completa:** pode capturar a página e os elementos relacionados às ocorrências.
- **Somente elementos:** limita as capturas aos elementos relacionados às ocorrências.
- **Sem imagens:** executa a auditoria sem capturar pixels.

Selecione **Auditar a página atual**. Abrir o painel não inicia a coleta: esse botão é a confirmação explícita. A inspeção acontece na própria página e somente para leitura: a extensão não cria aba, não navega, não rola, não move o foco e não desenha destaques durante a coleta, de modo que a página permanece visível e ativa como você a deixou. Como o documento observado é o que está aberto, o estado atual — inclusive o que ainda não foi salvo — faz parte da avaliação. Nos modos com imagens, a extensão pausa antes da primeira captura quando identifica conteúdo potencialmente sensível; nesse caso, a pessoa usuária decide se continua ou cancela. Também é possível escolher **Outra URL**, informar um endereço HTTP ou HTTPS e usar os mesmos três modos; nesse caminho o endereço é aberto em uma aba temporária inativa, removida ao final. Em **Lote de páginas**, informe de 2 a 20 URLs, uma por linha, e escolha o modo de evidência para gerar um relatório consolidado; cada página também é aberta em aba temporária inativa. Cada página sensível exige sua própria confirmação antes das capturas.

O painel apresenta as cinco etapas da avaliação. O indicador aparece ao lado da etapa atual e as etapas concluídas recebem um ✓ verde. Em lotes, as etapas acompanham a página em análise, enquanto a barra indica o avanço do lote inteiro. Se uma página não puder ser aberta ou observada, o relatório registra a falha e o lote segue após confirmar a limpeza daquela tentativa.

Ao final, o painel mostra o sumário, filtros e fichas das ocorrências. Cada ficha apresenta explicação, WCAG 2.2, item ABNT NBR 17225, referência normativa, nome acessível, anúncio estimado, seletor, código e evidências disponíveis. **Abrir relatório completo** abre a revisão em uma aba própria. A exportação baixa HTML autocontido, PDF, CSV e JSON-LD/EARL.

### Conferir os elementos na própria página

Depois de avaliar **a página atual**, escolha **Mostrar sinais na página**. Os sinais numerados aparecem junto aos elementos que puderam ser associados com segurança ao resultado. Um mesmo elemento pode reunir várias ocorrências. As cores e os símbolos distinguem falha (×), alerta (!), revisão humana (?) e resultado positivo (✓).

- Clique no sinal para abrir a ocorrência e o item ABNT correspondente no painel.
- Selecione uma ocorrência no painel para realçar seu elemento, sem mover a página automaticamente. **Ir ao elemento** faz a navegação imediata quando você a solicita.
- Os filtros também controlam os sinais, sem alterar os totais nem as evidências da auditoria.
- Use **Ocultar sinais na página** ou Escape para encerrar a marcação.

Essa conferência é uma camada visual temporária, não uma nova captura. Não altera os arquivos de evidência nem aciona botões do site. Navegar para outro documento encerra a associação antiga. Após expiração ou reinício da extensão, pode ser necessário refazer a avaliação para recuperar os sinais.

O painel oferece até 64 ocorrências interativas; o relatório mantém todas. Questões gerais, alvos sem identificador estável corroborado, elementos mudados ou não localizados são informados separadamente, sem inventar sua posição. Lotes não recebem sinais na página original. O destaque individual **Ver e destacar na página** continua disponível quando a prova viva da página auditada ainda é válida, por exemplo em **Outra URL** enquanto essa página permanece disponível.

Os quatro cartões do sumário funcionam como filtros. Clique novamente no cartão selecionado para mostrar todos os resultados. As ocorrências estão agrupadas por item da ABNT: abra o item e depois a ficha que deseja entender. A ficha explica o impacto, o que foi observado e como revisar ou corrigir, com exemplos. Código e detalhes técnicos ficam recolhidos. A referência curta distingue inconformidade confirmada de item ainda a verificar.

**Refazer auditoria** volta à escolha de página e modo sem apagar o relatório anterior nem iniciar outra captura automaticamente. O HTML baixado também tem filtros; os filtros de tela não removem registros do PDF ou dos demais arquivos.

A beta 1.1.4 acrescenta histórico legível das conclusões humanas no HTML/PDF completo, com nome informado, data, decisão e nota. Amplia também os sinais para elementos sem ID quando classes e caminho estrutural encontram inequivocamente o mesmo elemento. A conferência real no Chrome está registrada em [QA do candidato](docs/qa/2026-09-06-beta114-native.md) e o pacote em [registro de entrega](docs/qa/2026-09-06-beta114-release.md); a página original continua sem ações automáticas de navegação durante a auditoria.

A beta 1.1.5 acrescenta o horário de recebimento individual das capturas, identificado como relógio local não certificado, e orientações práticas para ABNT 5.13.6, 5.13.7 e 5.13.8. Não inventa datas para evidências antigas nem altera conclusões a partir dos exemplos. Consulte o [guia de teste e atualização](docs/COMO-TESTAR-BETA-1.1.5.md) e o [registro da entrega verificada](docs/qa/2026-09-06-beta115-release.md).

A partir da beta 1.1.2, **Imprimir resumo / salvar PDF** oferece uma edição curta com totais, limitações, matriz ABNT e metodologia. Escolha **Salvar como PDF** no diálogo do navegador. O resumo identifica a auditoria e revisão, mas não substitui as fichas e evidências do relatório completo. Na beta 1.1.8, a exportação automática mantém HTML completo, CSV e JSON e produz um **PDF de leitura**: agrupa revisões, apresenta as orientações essenciais e evita repetir dossiês por ocorrência. Os registros técnicos integrais continuam no HTML/JSON da mesma revisão.

A beta 1.1.3 corrige o salvamento da revisão humana e atualiza imediatamente o relatório aberto, preservando notas e formulários. **Não salve novas decisões na beta 1.1.2**: ela pode deixar o hash da revisão pendente e impedir a leitura do relatório. A atualização previne novas gravações defeituosas, mas não recupera automaticamente registros já afetados. Preserve os dados e arquivos exportados; uma nova auditoria não recupera decisões anteriores. Detalhes no [registro da correção](docs/qa/2026-09-06-live-review-refresh.md).

**Cobertura automática** é a proporção de testes do motor próprio que chegaram a uma conclusão automática — passou, falhou ou não se aplica — em relação ao inventário desse motor nas páginas tentadas. Não é o percentual da página acessível nem o percentual de toda a WCAG ou da ABNT que uma máquina consegue verificar. O axe-core e as revisões humanas aparecem nos resultados, mas não compõem esse denominador.

## Dados locais e exclusão

As auditorias ficam no dispositivo por até 30 dias desde o primeiro registro, sem renovação automática do prazo ao revisar ou exportar. A limpeza é retomada quando o Chrome puder executar a extensão; fechar o navegador não mantém um processo rodando.

No relatório, **Excluir auditoria local** pede confirmação. Se desejar excluir depois de salvar, marque a opção junto a **Exportar HTML, PDF, CSV e JSON**. Ela começa desmarcada e só autoriza a exclusão daquela auditoria depois da confirmação dos quatro downloads. Entregas parciais e revisões que mudaram durante a exportação preservam os dados locais. A limpeza de recursos pode ser retomada automaticamente se houver interrupção. Os arquivos já baixados não são apagados.

Capturas apresentadas no relatório recebem molduras derivadas por ocorrência: vermelho para falha confirmada e âmbar tracejado para revisão pendente. Os PNGs originais e seus hashes permanecem separados e inalterados.

As permissões `tabs`, `scripting` e `debugger` permitem identificar e inspecionar localmente a página ativa escolhida, coletar a árvore de acessibilidade, registrar evidências e preparar a impressão. `sidePanel` mantém a interface ao lado da página; `downloads` salva os artefatos; `storage` mantém auditoria e andamento no dispositivo; `alarms` agenda a expiração de estados temporários; `contextMenus` oferece um atalho opcional. Os sites auditados são cobertos por `host_permissions` HTTP(S). A extensão não envia o conteúdo coletado para um servidor próprio.

## Limites atuais

A extensão audita a página aberta, outra URL ou um lote explícito de 2 a 20 URLs nos três modos, sempre sobre os estados observados, e não todo o serviço. No modo de evidência completa, o relatório inclui o mapa numerado e a legenda dos anúncios estimados quando a coleta consegue produzi-los; omissões e limites ficam registrados. Itens contextuais exigem revisão humana. Frames de terceiros, canvas, vídeo, conteúdo protegido ou coleta estrutural bloqueada podem produzir resultado parcial.

Audita Acessibilidade é uma ferramenta independente, sem vínculo institucional. A cobertura automática não equivale a certificação nem a laudo oficial. Consulte [Uso fiscal](docs/USO-FISCAL.md) para interpretar o resultado e [Backlog da beta](docs/BETA-BACKLOG.md) para as melhorias não bloqueantes já registradas.

O candidato só deve ser distribuído depois do gate de suíte lógica, verificação estática, E2E real no Chrome e QA visual. O registro desse gate acompanha o pacote final, distinguindo eventuais correções e repetições focadas.

## Desenvolvimento

Durante mudanças, execute apenas os testes afetados. No candidato de entrega, configure o Chrome for Testing previsto pelo projeto, execute a suíte ampla e os E2E reais uma vez, rode `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify` e então gere o pacote com `npm run build:release`. A política aplicável está em [Política de Privacidade](docs/POLITICA-DE-PRIVACIDADE.md).
