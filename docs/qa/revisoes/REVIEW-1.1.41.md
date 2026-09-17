# REVIEW-1.1.41 — revisão independente e adversarial do artefato Audita Acessibilidade 1.1.41

Revisor independente e adversarial. **Nenhuma afirmação do autor foi aceita como prova**: toda medida
deste relatório foi produzida por comando próprio, com a saída bruta guardada em
`/private/tmp/audita-review-141/evidence/`. Nada foi escrito dentro do repositório do autor.

## Ambiente de medição

| Item | Valor |
| --- | --- |
| Worktree do autor (somente leitura) | `/Volumes/SSD1/acessibilidade-digital/.worktrees/audita-mt`, branch `feature/audita-mt` |
| Commit do artefato | `4df8c8c91dbd24aea363293feec5287155b1ce77` |
| Clone independente (regra 1) | `git -C <worktree> clone --no-hardlinks --local … /private/tmp/audita-review-141/clone` (sem `cp -R .git`) |
| Raiz de medição (regra 2) | `/private/tmp/audita-review-141/root` = árvore do commit com o **zip sobreposto** (`unzip -o`), mais `test/` e `scripts/` copiados e `node_modules` (axe-core 4.13.0); `.git` do meu próprio clone, só para o teste de baseline |
| Gerações de comparação (mutações por `git archive`) | 1.1.40 = `c9d7dd4` (`mut-140`), 1.1.39 = `746a696` (`mut-139`), 1.1.38 = `733cd01` (`mut-138`); o `src/` de cada pacote confere com o `git archive` do commit (`SRC_IDENTICAL_140/139/138`) |
| Chrome (regra 3) | `Google Chrome for Testing 152.0.7977.64`, **um Chrome por vez**, `--test-concurrency=1` |
| Node | v26.5.0 |

> **Nota de estado do worktree.** Quando esta revisão começou, o worktree estava em `4df8c8c`; ao
> terminar, o `HEAD` do worktree já era `5d751bb…` (avanço do próprio autor, com
> `M test/e2e/sidepanel-flow-mv3.test.mjs` no diretório de trabalho). **Nada foi escrito por mim no
> repositório do autor** — todos os comandos `git` de medição rodaram com `git -C` na minha cópia, e o
> arquivo-ponteiro `.git` do worktree continua intacto (`gitdir: …/worktrees/audita-mt`). Todas as
> medidas deste relatório se referem ao commit `4df8c8c` e ao zip cujo SHA-256 foi medido no início
> (`0656fd…`), byte a byte igual ao `git archive 4df8c8c` da minha cópia.

## 0. Integridade do pacote

| Medida | Comando próprio | Resultado |
| --- | --- | --- |
| SHA-256 do zip | `shasum -a 256 release/audita-acessibilidade-1.1.41.zip` | `0656fd445f846075ee70d432c3fe189bdd4bcc13c1284806ac6e6301520b5d20` — **igual ao declarado** |
| Arquivos | `unzip -l` + `find` | 199 arquivos |
| Nada fora do commit | `comm -23 zip-filelist commit-filelist` (commit = `git archive 4df8c8c`) | **0** arquivos só no zip |
| Byte a byte vs commit | `cmp` nos 199 arquivos | **0 divergências** |
| Sobreposição na raiz | `unzip -o` + novo `cmp` (mede os bytes empacotados) | **0 divergências** |
| Versão no artefato | `manifest.json` empacotado | `1.1.41` |

Evidência: `evidence/zip-sha256.txt`, `zip-filelist.txt`, `commit-filelist.txt`, `zip-only.txt`,
`byte-diff.txt` (0 linhas), `overlay-diff.txt` (0 linhas).

## 1. Veredito por alegação

Comandos: `node probes/*.mjs`, `node --test …`, `bash probes/*.sh`. Saídas brutas em `evidence/`.

### 1.1 Métrica da classe e falsos positivos (I-3)

| # | Alegação do autor | Comando | Resultado medido | Veredito |
| --- | --- | --- | --- | --- |
| 1 | `node --test test/core/credential-class-metric.test.js` → **11/11** | idem, na raiz empacotada | `tests 11 / pass 11 / fail 0` | **CONFIRMADO** |
| 2 | Não vacuidade: o MESMO teste sobre o `src` de 1.1.40/1.1.39/1.1.38 **reprova** | `cp` do teste da 1.1.41 sobre `mut-140/139/138` + `node --test` | 1.1.40 = **3 falhas** (8/11), 1.1.39 = **4 falhas** (7/11), 1.1.38 = **5 falhas** (6/11) | **CONFIRMADO** |
| 3 | Morfologia portuguesa **20 → 0** frases destruídas (corpus de 39) | `node probes/morfologia-141.mjs` (corpus exato do revisor da 1.1.40) | 1.1.40 = **20/39** destruídas, 1.1.41 = **0/39** | **CONFIRMADO** |
| 4 | Dicionário do sistema **563 → 360** palavras minúsculas 3+ que disparam `isPermissiveCredentialLabel` | `node probes/dict-author-141.mjs` (filtro do revisor da 1.1.40: 234.291 palavras) | 1.1.40 = **563**, 1.1.41 = **360**, PERDEU=203, **GANHOU=0** | **CONFIRMADO (exato)** |
| 5 | "a asserção da métrica percorre as famílias nas duas direções" | leitura do teste + `probes/hunter-141.mjs` | A varredura existe e percorre as duas direções, mas o corpus do "outro lado" é `RADICAIS(22) × CAUDAS(55)` **sem a dimensão de família** — a composição `<radical><cauda><palavra-de-família>` não é testada (e é onde a regressão vive) | **PARCIAL** |
| 6 | Famílias de prefixo PT preservam a evidência (`chaveiro`, `pinturas`, `pincel`, `pingente`, `secretaria`, `tokenizacao`, `obsessão`, `data-chaveiro`, `pintura.png`, `secretaria-saude`) | `probes/attack-141.mjs` §C, `probes/fp-ptbr-141.mjs` | Trecho e id preservam; 30 palavras antes destruídas passaram a ser preservadas | **CONFIRMADO** |
| 7 | "`token`/`pin`/`bearer` foram medidos e **RECUSADOS** como sufixo" | `probes/causa-raiz-141.txt` | **REFUTADO no caminho da CHAVE**: `LANGUAGE_SUFFIX_FAMILIES` (usada por `isPermissiveCredentialLabel` e pela nova `BARE_TAIL` de `isSensitiveKeyName`) **inclui** `token`, `pin`, `bearer`; só a lista ESTRITA (prosa/tail) os recusa | **REFUTADO** |

### 1.2 Identificador e chave (I-1/I-2)

| # | Alegação do autor | Comando | Resultado medido | Veredito |
| --- | --- | --- | --- | --- |
| 8 | Formas do Critical fechadas em id/classe/chave/URL (`senhaassinatura`, `chavepix`, `data-chavepix`, `xchavepix`, `senhaassinatura2`) | `probes/attack-141.mjs` §B | 1.1.41: `chave=true`, `vaza=0/4` em todas; 1.1.40: `vaza=4/4` | **CONFIRMADO** |
| 9 | Caçador 96 rótulos × 3 valores × 6 superfícies = 1.728 casos, **336 → 0** | `probes/hunter-141.mjs` §C1 (corpus idêntico ao do revisor da 1.1.40) | 1.1.41 = **0/1728**; 1.1.40 = **336/1728** (json_chave 168 + url 168) | **CONFIRMADO** |
| 10 | "caudas realistas **880 formas, 0 vazamentos**" | `probes/realistas-141.mjs` (16 radicais × 55 caudas) | No caminho **modelo/prosa/trecho**: 1.1.41 = **0** (o mesmo 0 da 1.1.40 — a 1.1.40 já era 0 aí, então a prova é fraca). Nas superfícies de **chave/URL/id**: **108/880 continuam vazando** (resíduo declarado de radicais curtos `puk`/`pwd`/`auth`) | **PARCIAL** |
| 11 | **COBERTURA_PERDIDA=0 / GANHA=5.661** em 516.235 formas | `probes/coverage-141.mjs` (U1=1.063.290, U2=1.088.992, U3=9.754.688 formas; amostra de U3 = 195.094) | Vocabulário de **CHAVE**: PERDIDA=**0** em U1/U2/U3 e GANHA=**5.764** em U2/U3 → o número do autor se reproduz nesse vocabulário. Vocabulário de **PROSA/MODELO**: U1 = 0 perdida, U2 = 0 perdida, **U3 (com a dimensão de família) = 77.111 de 195.094 amostradas (39,5%)**, GANHA=0 — e **19.141** no corpus diferencial de 64.055 rótulos | **PARCIAL / REFUTADO na prosa** |
| 12 | Corpus de chaves inocentes **3/55** (mesmo resíduo da 1.1.40) | `probes/coverage-141.mjs` (corpus do revisor da 1.1.40) | 1.1.41 = **3/55** (`cupbearer`, `pallbearer`, `chipping`), 1.1.40 = **3/55** | **CONFIRMADO** |
| 13 | `data-<palavra>` legítimo no trecho **12/12** preservado (M-2) | `probes/fp-ptbr-141.mjs` (70 palavras) | 30 palavras **corrigidas** em relação à 1.1.40, mas **21/70 continuam com o atributo descartado** (`pingo`, `pinhão`, `pinheiro`, `pinha`, `pino(s)`, `pinta`, `pintado`, `pintar`, `pinga`, `pinto`, `pintinho`, `secreto/a(s)`, `sessão`, `sessões`, `chavear`, `chavena`, `password`) | **PARCIAL** |
| 14 | Elemento com `id`/`class` de credencial perde texto e atributos de valor, "sem virar raiz privada inteira" | `probes/positions-141.mjs`, E2E `probes/attack-e2e-141.test.mjs` | O mecanismo existe e preserva o nome acessível de `button`/`a`/`label`/`input`/`textarea`; **mas destrói texto legítimo** de elementos inocentes (Achado I-1) | **CONFIRMADO no mecanismo / efeito colateral novo** |
| 15 | `pin`/`pins` continuam tarjados (lista fechada intocada) | `probes/attack-141.mjs` §C | `isSensitiveKeyName('pin')='pins'=true` em 1.1.41 e 1.1.40 | **CONFIRMADO** |
| 16 | E2E novo `identifier-credential-mv3.test.mjs` → **6/6** | `bash probes/serial-scope-141.sh` | 6/6 passam (dentro do escopo de 58) | **CONFIRMADO** |
| 17 | E2E do revisor anterior `key-axis-140` → **1/1** com `VAZA_EM=(nenhuma)` nos seis casos | `probes/key-axis-141.test.mjs` (porte para a minha raiz, Chrome real) | 1/1, **seis casos `VAZA_EM=(nenhuma)`**; rótulo presente no modelo/html/json (a evidência do rótulo sobrevive) | **CONFIRMADO** |

### 1.3 Suíte, gate e auditoria ao vivo

| # | Alegação do autor | Comando | Resultado medido | Veredito |
| --- | --- | --- | --- | --- |
| 18 | Fase paralela (sem `test/e2e/`): **4.180 testes, 4.179 passam, 0 falham, 1 pulado, EXIT=0** | `node probes/run-parallel-noe2e-141.mjs` | `tests 4180 / pass 4179 / fail 0 / skipped 1`, `PARALLEL_SEM_E2E_EXIT=0` | **CONFIRMADO (exato)** |
| 19 | (contexto) plano inteiro do runner | `node probes/run-parallel-141.mjs` (181 arquivos) | `tests 4224 / pass 4223 / fail 0 / skipped 1`, EXIT=0 (a diferença de 44 são os 2 arquivos de `test/e2e/` classificados como process-safe: 5 + 39) | **CONFIRMADO** |
| 20 | Escopo serial em Chrome real (12 arquivos): **58/58** | `bash probes/serial-scope-141.sh` (2 execuções) | 1ª: `tests 58 / pass 57 / fail 1` — falha de **cleanup do harness** (`cleanup axe limitado falhou: [{"stage":"profile","code":"failed"}]` em `axe-mv3-csp.test.mjs`, arquivo que passa **1/1 isolado**); 2ª: **`tests 58 / pass 58 / fail 0`, EXIT=0** | **CONFIRMADO (com 1 flake de cleanup na 1ª passada)** |
| 21 | Gate `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify` → GREEN | idem, na raiz empacotada | `VERIFY_EXIT=0`; 130 regras, 146 itens (96+50), 0 erros normativos | **CONFIRMADO** |
| 22 | Auditoria ao vivo no Google: 0 falhas confirmadas, 3 sob revisão humana (4 ocorrências), 9 positivos, 109 no checklist, cobertura 28,5%, índice 9,0/10, versão 1.1.41, 4 exportações `complete` | `probes/live-google-141.test.mjs` + `probes/live-artifacts-141.mjs` | Painel: `0 Falhas confirmadas (0 ocorrências)`, `3 Suspeitas a confirmar (4 ocorrências)`, `9 Resultados positivos`, `109 verificações ainda sem conclusão`; relatório HTML: `Cobertura automática: 28,5%`, `Índice técnico automático — motor próprio 9,0 / 10`; JSON `audit.versions.extension=1.1.41`; `downloads=complete/complete/complete/complete` | **CONFIRMADO** |
| 23 | Integridade: 146 itens (96+50), **146/146 ids e títulos no HTML e no PDF**, notas editoriais **5/5** nos dois, **0 palavras partidas**, **0 `[redacted]`** | `probes/integrity-141.mjs`, `probes/integrity-pdf-141.mjs` (pypdf), `probes/_pdf2.py` | HTML: 146/146 ids, 146/146 títulos, 5/5 notas, 0 `[redacted]`, 0 palavras partidas. PDF (18 páginas): 146/146 ids, 146/146 títulos, 0 `[redacted]`, 23 pares hífen+quebra **todos** correspondendo a hífens já existentes no HTML (0 palavras partidas) | **CONFIRMADO** |

### 1.4 Resíduos declarados

| # | Resíduo declarado | Medição própria | Veredito |
| --- | --- | --- | --- |
| 24 | `pallbearer`, `cupbearer`, `seedling` continuam lidos como chave | `probes/morfologia-141.mjs`: `pallbearer` e `cupbearer` = tarja na prosa **e** na chave; `seedling` = tarja na prosa, **preservado na chave** (`isSensitiveKeyName=false`); o terceiro do corpus 3/55 é **`chipping`**, não `seedling` | **CONFIRMADO com nuance** (a mensagem do commit cita `seedling`; o comentário do código cita `chipping` — o corpus de 55 confirma `chipping`) |
| 25 | Radicais curtos (`pin`, `puk`, `seed`, `auth`, `pwd`) seguem sem cobertura de chave composta | `probes/realistas-141.mjs`: 108/880 formas com radicais curtos vazam nas superfícies de chave/URL/id; `test/core/credential-class-metric.test.js` diagnostica `resíduo de chave com radical curto: 360 de 550` | **CONFIRMADO** |
| 26 | `codigo*`/`conta*`, `api.key`, `private_key`, `chave·de·api`, separadores exóticos, rótulos codificados e rótulo+valor em nós irmãos continuam abertos | `probes/residuos-141.mjs` | Todos **ABERTOS** nas cinco superfícies, idênticos à 1.1.40 (exceção: `sen&#104;aassinatura` na chave JSON passou a FECHADO) | **CONFIRMADO** |
| 27 | Percurso da página atual em modo de pixel **não começa** (`element-only`/`full-evidence` ficam em `initial`, sem confirmação e sem trabalho) | `probes/pixel-detail-141.test.mjs` (Chrome real) | `element-only`: `running` em 0,5–1 s → `reconnecting` em 1,5 s → **`initial`** em 2,5 s e assim até 20 s, marcador voltando a `full-evidence`, `confirmacao=false`, `trabalho=false`. `full-evidence`: mesma sequência, `initial` a partir de 5 s. `no-pixels` conclui (`result`) | **CONFIRMADO** |

## 2. Achados por severidade

### CRITICAL

#### C1 — A decisão por FAMÍLIA reabre o vazamento de credencial no caminho de prosa/modelo/trecho (regressão medida contra a 1.1.40)

**Causa raiz (isolada).** `isPermissiveCredentialLabel` passa a consultar `isLanguageWordForm`, e a nova
`BARE_TAIL_SOURCE` de `isSensitiveKeyName` consulta `isLanguageWordForm` — e essa função usa
`LANGUAGE_SUFFIX_FAMILIES` = `['seed','bearer','session','pass','token','spin','pin','pping']`, **com
`token`, `pin` e `bearer`**, exatamente os três que o commit afirma ter "medido e RECUSADO como sufixo"
(a lista ESTRITA, sem eles, só é usada em `shapesValue`/`shapesValueTail`). Como o teste é de sufixo
sobre o **token inteiro**, qualquer rótulo de credencial que **termine** numa dessas oito palavras é
poupado nas três posições — mesmo quando o radical está no começo e a "palavra da língua" é, na
verdade, o qualificador colado da credencial.

```
$ node -e "…importa as duas gerações e imprime os predicados…"   # saída bruta: evidence/causa-raiz-141.txt
senhaassinaturatoken  SENSITIVE_KEY(permissivo bruto)=true | isPermissive=false | isLanguageWordForm=true | isSensitiveKeyName=false
senhapixpin           SENSITIVE_KEY(permissivo bruto)=true | isPermissive=false | isLanguageWordForm=true | isSensitiveKeyName=false
senhacadastrotoken    SENSITIVE_KEY(permissivo bruto)=true | isPermissive=false | isLanguageWordForm=true | isSensitiveKeyName=false
```
O único predicado que mudou de opinião é a família: o vocabulário permissivo (`SENSITIVE_KEY`) continua
casando as três formas.

**Reprodução mínima (unidade).**
```
$ node -e "const A=await import('./root/src/core/privacy.js');const B=await import('./mut-140/src/core/privacy.js');
  for (const r of ['senhaassinaturatoken','senhacadastrotoken','senhapixpin'])
    console.log(r, 'prosa41=', A.redactSensitiveText(r+': borboleta').includes('borboleta')?'VAZA':'tarja',
                     'prosa40=', B.redactSensitiveText(r+': borboleta').includes('borboleta')?'VAZA':'tarja');"
senhaassinaturatoken    41=VAZA   40=tarja
senhacadastrotoken      41=VAZA   40=tarja
senhapixpin             41=VAZA   40=tarja
```
`evidence/regressao-superficies-141.txt` mostra o mesmo par VAZA/tarja em **modelo JSON** e **trecho**;
`redactSensitiveText` (o sinal de conteúdo do sanitizador) deixa de acender.

**Reprodução mínima (artefatos entregues, Chrome real).** `probes/attack-e2e-141.test.mjs` (fixture
local, percurso completo do autor: painel → relatório → modelo/revisão guardados → quatro exportações):

| caso | fixture | 1.1.41 (`AUDITA_EXT_PATH=root`) | 1.1.40 (`AUDITA_EXT_PATH=mut-140`) |
| --- | --- | --- | --- |
| d01 | `<p>senhaassinaturatoken: borboleta</p>` | **VAZOU em `guardado`, `artefato html`, `artefato json` (3/6)** | `(nenhuma)` — 0/6 |
| d02 | `<p>senhacadastrotoken: Zqwkvbrtnmx</p>` (valor forte) | **VAZOU em `guardado`, `artefato html`, `artefato json`** | `(nenhuma)` |
| d03 | `<p>senhapixpin: abc123</p>` | **VAZOU em `guardado`, `artefato html`, `artefato json`** | `(nenhuma)` |

**Extensão do dano (números próprios).**
- `probes/hunter-141.mjs`: o caçador do revisor da 1.1.40 (96 rótulos × 3 valores × 6 superfícies) vai a
  **0/1728**; com a dimensão de família (768 rótulos × 3 × 6 = 13.824) a 1.1.41 vaza **7.302** contra
  **1.830** da 1.1.40 → **5.472 casos novos**, sendo 1.386 em cada um de prosa, modelo, trecho e 1.314 em
  `aria-label` (todos zero na 1.1.40).
- `probes/diff-coverage-141.mjs` (corpus de 64.055 rótulos): **19.141 formas** redigidas na 1.1.40 e
  entregues na 1.1.41, nas superfícies `prosa`, `prosa-forte` e `trecho-prosa`; **0 melhorias** nessas
  superfícies. Amostra: `senhaassinaturatoken`, `senhatelegramtoken`, `senhacobrancatoken`,
  `senhaassinaturapin`, `senhapixpin`, `senhabackuppin`, `senhanuvempin`…
- `probes/coverage-141.mjs` (universos U1/U2 do revisor da 1.1.40 mais a dimensão de família, U3): no
  vocabulário de **chave** a cobertura perdida é **0** (1,06 M / 1,09 M / 9,75 M formas), mas no de
  **prosa/modelo** a amostra de U3 (195.094 formas) perde **77.111** (39,5%) contra ganho **0** — o
  mesmo efeito do achado, medido num universo ~3× maior que o do autor.
- `probes/realistas-141.mjs`: nas 880 formas realistas × 8 sufixos = 7.040 formas, a 1.1.41 vaza **5.542
  em cada** de prosa/modelo/trecho (1.1.40 = 0) → **16.626 vazamentos novos**.
- O mesmo desvio atinge a posição de **identificador** que o I-1/I-2 dizia fechar:
  `b01 <div id="senhaassinaturatoken">`, `b02 <div id="senhapixpin">`, `b03 <div id="senhaassinaturaToken">`,
  `b05 <div class="senhaassinaturaseed">` → **VAZOU em `guardado` + `artefato html` + `artefato json`** na
  1.1.41 (casos b04 `senhapixtoken` e b06 `chavepixtoken` fecham, porque a lista fechada os pega).

**Impacto.** É a própria classe sob revisão — "credencial da página chegando às superfícies entregues" —
em **regressão** introduzida pela geração que a deveria fechar: o valor sai no modelo guardado e nos
artefatos HTML/JSON exportados, onde a 1.1.40 tarjava. A declaração "COBERTURA_PERDIDA=0" não se sustenta
fora do vocabulário de chave, e a declaração "token/pin/bearer recusados como sufixo" não corresponde ao
código do lado da chave.

**Ressalva de realismo (declarada para o leitor pesar).** As formas exigem um rótulo que termine numa das
oito palavras; as mais plausíveis medidas são `senhaassinaturatoken`, `senhacadastrotoken`, `senhapixpin`,
`senhaassinaturaToken` (formas que a lista fechada **não** conhece e que a 1.1.40 reconhecia pela regra
permissiva). As variantes com separador (`senha_assinatura_token`), camelCase de várias partes
(`chavePixToken`) e `senhapixtoken`/`chavepixtoken` continuam fechadas.

### IMPORTANT

#### I-1 — O novo par identificador→valor **apaga evidência legítima** de elementos inocentes (regressão)

`credentialIdentityAttributes` (modelo) e `credentialIdentity` (trecho) tratam qualquer `id`/`class` que
`isSensitiveKeyName` reconheça como raiz de texto privado — sem exigir que o conteúdo tenha cara de
credencial. Resultado: o **texto** do elemento é descartado silenciosamente (e, para `sessao`/`password`,
até o atributo `id` desaparece).

```
$ node -e "…imprime o trecho das duas gerações para o mesmo id…"   # saída bruta: evidence/regressao-identificador-141.txt
WORD=chavear   1.1.41: "<div id=\"chavear\"></div>"   1.1.40: "<div id=\"chavear\">Conteúdo público da seção.</div>"
WORD=chavena   1.1.41: "<div id=\"chavena\"></div>"   1.1.40: "<div id=\"chavena\">Conteúdo público da seção.</div>"
WORD=secretas  1.1.41: "<div id=\"secretas\"></div>"   1.1.40: "<div id=\"secretas\">…</div>"
WORD=sessao    1.1.41: "<div></div>"                   1.1.40: "<div>Conteúdo público da seção.</div>"
WORD=password  1.1.41: "<div></div>"                   1.1.40: "<div>Conteúdo público da seção.</div>"
```
`probes/fp-ptbr-141.mjs` (70 palavras PT/EN): **NOVOS=6** (`chavear`, `chavena`, `secretas`, `sessão`,
`sessões`, `password`), **CORRIGIDOS=0** — nenhuma dessas era destruída na 1.1.40.

**Confirmado nos artefatos entregues** (`probes/attack-e2e-141.test.mjs`; A/B com a mesma fixture):

| caso | fixture | 1.1.41 (superfícies com a evidência) | 1.1.40 |
| --- | --- | --- | --- |
| e01 | `<div id="chavear">Conteúdo público da seção.</div>` | **0/6** | 3/6 (`guardado`, `artefato html`, `artefato json`) |
| e02 | `<div id="sessao">Sessão das 19h no cinema do bairro.</div>` | **0/6** | 2/6 |
| e03 | `<div class="password">Instruções do formulário de contato.</div>` | **0/6** | 3/6 |
| e04 | `<div id="chavena">Coleção de xícaras artesanais.</div>` | **0/6** | 3/6 |
| c01 | `<div id="cookie-banner">Este site usa cookies…</div>` | **0/6** | 3/6 |
| c02 | `<div id="map-pin">Marcador: Avenida Paulista, 1578.</div>` | **0/6** | 3/6 |
| c03 | `<div id="session-info">Sua sessão expira em 30 minutos.</div>` | **0/6** | 3/6 |
| c04 | `<div class="pin">Mapa do sítio com 12 pontos turísticos.</div>` | **0/6** | 3/6 |
| c05 | `<div id="token-de-acesso">Conteúdo público da seção.</div>` | **0/6** | 3/6 |

**Impacto.** Perda de evidência no relatório entregue (o texto do autor simplesmente não existe no trecho,
no modelo, no HTML e no JSON) para elementos cujo identificador **coincide com uma palavra comum**:
`chavear`, `chavena`, `secretas`, `sessao`/`sessoes`, `password`, `cookie-banner`, `map-pin`,
`session-info`, `pin`, `token-de-acesso`. É a mesma classe do Important I-3 da 1.1.40 (falsos positivos
destrutivos), deslocada para a posição sintática nova — e a lista de famílias de prefixo não cobre
`chavear`/`chavena`/`secretas`/`sessao`.

### MINOR

- **M-1 — `data-<palavra>` residual maior que o declarado.** O autor declara 12/12 preservados; no meu
  corpus de 70 palavras, **21 continuam com o atributo descartado** no trecho (`pingo`, `pinhão`,
  `pinheiro`, `pinha`, `pino(s)`, `pinta`, `pintado`, `pintar`, `pinga`, `pinto`, `pintinho`,
  `secreto/a(s)`, `sessão`, `sessões`, `chavear`, `chavena`, `password`). Não é regressão (a 1.1.40
  descartava 51), mas a afirmação "12/12" mede um corpus menor que a classe. `evidence/fp-ptbr-141.txt`.
- **M-2 — Posições vizinhas do identificador continuam entregando o valor.** Com o rótulo em `name`,
  `aria-label`, `autocomplete`, `title` do próprio elemento ou em `data-*` (e o valor no texto), o valor
  continua saindo; `th`/`td` e nós irmãos idem. `probes/positions-141.txt` (7 posições VAZA na 1.1.41).
  O autor declara "nós irmãos" e "rótulos codificados"; `name`/`aria-label`/`autocomplete`/`title` não
  estão na lista de resíduos.
- **M-3 — Assimetria entre vocabulários.** `senhaassinaturapass` é **tarjado** na chave JSON e **não**
  é tarjado na prosa/modelo (`isSensitiveKeyName=true`, `isPermissiveCredentialLabel=false`,
  `isLanguageWordStrictForm=true`), o oposto do objetivo declarado de "a MESMA decisão nas três posições".
- **M-4 — Declaração imprecisa do resíduo de sufixo.** A mensagem do commit diz "`pallbearer`,
  `cupbearer` e `seedling` seguem lidos como chave"; medido: `seedling` **não** é lido como chave
  (`isSensitiveKeyName=false`), e o terceiro do corpus 3/55 é `chipping` (o comentário do código está
  certo, a mensagem não).

## 3. O que tentei para refutar cada item declarado como fechado

| Item declarado fechado | Ataque feito | Resultado |
| --- | --- | --- |
| I-3 famílias: "20 → 0 frases destruídas" | Corpus exato de 39 frases do revisor da 1.1.40, nas duas gerações, modelo+trecho | **Fechado** (0 vs 20) |
| I-3 dicionário "563 → 360" | Varredura do dicionário com o filtro do revisor da 1.1.40 (234.291 palavras) | **Fechado**, números exatos |
| I-3: famílias não engolem forma de credencial | Corpus próprio de 64.055 rótulos × 9 superfícies nas duas gerações; caçador 96×3×6 estendido a 768 rótulos; 880 caudas realistas × 8 sufixos | **REABERTO (C1)**: 19.141 formas perdidas na prosa/modelo, 5.472 casos novos no caçador estendido, 16.626 nas caudas realistas estendidas |
| I-1/I-2: "cauda colada sem prefixo reconhecida em chave/identificador" | Formas do Critical, formas com cauda realista, 3.240 rótulos `radical+cauda+sufixo`, camelCase, `_`/`-`/`.`, caixa mista, entidade (`&#104;`), invisíveis | **Parcialmente fechado**: as formas do Critical fecham; **982/3.240** variantes com sufixo de família continuam vazando em id/classe/chave/URL (b01/b02/b03/b05 no E2E) |
| I-1: "elemento com id/classe de credencial perde texto e atributos de valor" | `<div id="token-de-acesso">`, `id="chavear"`, `class="password"`, `id="cookie-banner"`, `map-pin`, `session-info`, `pin` | **Fechado contra o vazamento, reaberto como destruição**: 0/6 superfícies preservam a evidência legítima (I-1 deste relatório) |
| "sem virar raiz privada inteira" (nome acessível sobrevive) | `button`/`a`/`label`/`input`/`textarea` com id de credencial | **Confirmado**: o texto/nome continua na evidência |
| "pin/pins continuam tarjados" | `isSensitiveKeyName('pin'|'pins')`, `<div class="pin">` | **Confirmado** (e é a origem do FP `class="pin"`) |
| "COBERTURA_PERDIDA=0 em 516.235 formas" | Universos U1/U2/U3 (1,06 M / 1,09 M / 9,75 M) nas duas vocabularies | **Chave: 0 perdida (confirmado)**; **prosa/modelo: 19.141 perdidas (refutado)** |
| "caudas realistas 880 formas, 0 vazamentos" | As 880 formas nas 6 superfícies | **0 na prosa/modelo (mas a 1.1.40 já era 0)**; **108/880 ainda vazam em chave/URL/id** (radicais curtos, resíduo declarado) |
| "data-`<palavra>` 12/12" | 70 palavras PT/EN com `data-<palavra>` | **21/70 descartadas** |
| Resíduos: `api.key`, `private_key`, `codigo*`/`conta*`, `chave·de·api`, separadores exóticos, codificados, nós irmãos | 14 formas × 5 superfícies, 1.1.41 vs 1.1.40 | **Abertos como declarado** (1 melhoria: `sen&#104;aassinatura` na chave JSON) |
| Percurso de pixel "não começa" | 3 modos, Chrome real, estado a cada 0,5 s até 20 s | **Confirmado**: `element-only`/`full-evidence` voltam a `initial`, marcador volta a `full-evidence`, sem confirmação e sem trabalho; `no-pixels` conclui |
| Suíte/gate/ao vivo | Fase paralela sem `test/e2e` (4.180/4.179/0/1), escopo serial 58/58, `verify` GREEN, auditoria ao vivo no Google com 4 exportações e checagem de 146 itens/ids/títulos/notas no HTML e no PDF | **Todos confirmados** |

## 4. O que NÃO foi medido

- **Aparato/PDF sob carga real de impressão**: a checagem do PDF usa o artefato exportado pelo produto
  (pypdf); não re-renderizei o PDF por impressão do navegador.
- **Pixel path com página pesada**: medi o percurso da página atual em fixture local simples; não medi
  páginas reais com frames/cross-origin nos modos `element-only`/`full-evidence`.
- **Corpus do autor**: não tenho os 516.235, os 1.728 "do autor" nem as "880 realistas" dele; reproduzi
  os corpora do revisor da 1.1.40 e construí corpora próprios maiores. Onde o número do autor não
  reproduziu, está dito explicitamente.
- **`pallbearer`/`cupbearer`/`chipping` em artefatos entregues**: medidos no predicado e no sanitizador,
  não num percurso E2E dedicado.
- **Frames/shadow DOM, iframes cross-origin e MHTML**: não medi a classe de credencial nessas fronteiras
  nesta rodada (o escopo declarado do autor também não as cobre).
- **Ambientes além do macOS/Chrome 152**: nada medido em outro navegador, sistema ou versão de Chrome.
- **Gerações mais antigas**: comparei com 1.1.38/1.1.39/1.1.40; não desci mais na linhagem.

## 5. Veredito final

**REPROVADO** para o escopo declarado (fechamento dos três Important da revisão da 1.1.40).

Motivo: o conserto **reabriu a própria classe** no caminho de prosa/modelo/trecho — o valor da credencial
volta a chegar ao modelo guardado e aos artefatos HTML/JSON exportados em formas que a 1.1.40 tarjava
(**C1, Critical**, 19.141 formas perdidas no meu corpus, 5.472 casos novos no caçador estendido,
confirmado em Chrome real nos artefatos entregues) — e **introduziu destruição de evidência legítima** na
posição de identificador (**I-1, Important**: `chavear`, `chavena`, `secretas`, `sessao`, `password`,
`cookie-banner`, `map-pin`, `session-info`, `pin`, `token-de-acesso` perdem o texto; 0/6 superfícies
preservam contra 3/6 na 1.1.40).

O que a geração **faz bem e está confirmado por medição própria**: o SHA-256 e a correspondência byte a
byte com o commit; a métrica 11/11 com não vacuidade nas três gerações anteriores; a morfologia PT
20 → 0; o dicionário 563 → 360 exato; as formas do Critical fechadas em id/classe/chave/URL; o caçador
do revisor anterior 336 → 0; o E2E novo 6/6; o eixo de chave 1/1 com `VAZA_EM=(nenhuma)` nos seis casos;
a fase paralela 4.180/4.179/0/1 exata; o escopo serial 58/58 (com um flake de cleanup na primeira
passada); o gate GREEN; a auditoria ao vivo com todos os números; e a integridade 146/96/50, 146/146 ids
e títulos no HTML e no PDF, 5/5 notas editoriais, 0 palavras partidas e 0 `[redacted]`.

**Para reverter o veredito**, é suficiente: (a) fazer `isPermissiveCredentialLabel` e a `BARE_TAIL` de
`isSensitiveKeyName` consultarem a lista **ESTRITA** de sufixo (ou condicionar a família à posição do
radical: só poupar quando a palavra da língua **não** for precedida pelo radical da credencial), com
medição nas duas direções incluindo a composição `<radical><cauda><sufixo>`; e (b) exigir que o
identificador de credencial só torne o elemento raiz privada quando o conteúdo/atributo tiver cara de
valor, ou restringir a decisão aos identificadores que a lista FECHADA conhece (preservando
`chavear`/`chavena`/`secretas`/`sessao`/`password` como evidência).
