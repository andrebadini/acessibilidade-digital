# Sinais na página para elementos sem ID

Base: `0f469ba`. Incremento local de apresentação; nenhum pacote novo nesta etapa. A beta 1.1.3 entregue permanece inalterada.

## Contrato reduzido

- O caminho aprovado por ID estável permanece disponível. Para elementos sem atributo ID, a nova alternativa usa até duas classes seguras do trecho de evidência e o caminho estrutural registrado (`tag` e `:nth-of-type`, com filhos diretos).
- O caminho e a combinação de classes precisam encontrar, cada um, exatamente um elemento no documento original, e ambos precisam apontar para o mesmo objeto DOM. Duplicidades não são filtradas para escolher arbitrariamente um alvo. O único elemento também precisa estar renderizado e não possuir atributo ID, nem mesmo vazio.
- As classes e o caminho ficam na comunicação privada de instalação. O painel e os sinais continuam recebendo somente números, contagens, classificações e seleções opacas; não se acrescentam textos da página, URLs ou trechos de código à camada de sinais.
- A instalação repetida deve preservar também classes e caminho. Mudança de elemento, de classes, de posição estrutural ou de unicidade invalida os sinais, sem procurar um substituto. Rolagem continua exclusiva do comando explícito de ir ao elemento.
- Autorização do documento original, capturas, armazenamento, decisões humanas e associação ABNT/WCAG não foram alterados. Esta associação é uma conferência de apresentação, não uma nova evidência nem garantia de persistência de identidade após mudanças dinâmicas anteriores à instalação.

## RED e correção

Os seis testes iniciais produziram quatro falhas e duas recusas já corretas. A implementação inicial passou em 78 testes relacionados. A revisão independente encontrou um Important reproduzível: separar classes com `\s` inventava tokens quando havia espaço não ASCII.

O RED de integração manteve o botão auditado com `primary\u00a0action` e outro botão com `primary action`. A extensão sinalizava duas ocorrências no botão errado. Apenas trocar o separador não bastou, porque o sanitizador existente já normaliza espaços no trecho armazenado. Não houve alteração desse sanitizador ou de registros existentes.

A fronteira foi reduzida: exigir também a correspondência exata do caminho estrutural registrado. O teste passou a impedir a associação ao botão errado. NBSP, espaço em U+2003 e BOM estão cobertos. O tokenizer da camada e da fixture foi alinhado a espaços ASCII, conforme a [microssintaxe oficial do HTML](https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#space-separated-tokens).

## Validação focada

81/81 testes passaram, sem skips:

```sh
node --test test/background/page-marker-projection.test.js test/highlight/page-markers-overlay.test.js test/background/page-markers-controller.test.js test/highlight/page-markers-port.test.js test/background/page-markers-worker-bridge.test.js test/panel/page-markers-session.test.js
```

Incluem associação e seleção pelo controlador real, dados públicos sem locatores, classes e caminhos malformados, ambiguidade em ambas as consultas, troca de identidade em reinstalação, mudança de posição e remoção dos sinais. `git diff --check` passou. Revisão final da correção pelo mesmo revisor independente: **C=0/I=0**, sem Minor necessário; execução independente dos 11 testes novos passou (padrão `idless|non-ASCII` nos três arquivos de projeção/controlador/camada). O revisor não executou Chrome ou suíte ampla.

## Limites preservados

Não cobre todo elemento sem ID: elementos sem classes seguras, locatores fora da gramática estrutural, frames, shadow roots e associações ambíguas continuam explicitamente não localizados. O limite transparente de 64 ocorrências interativas não mudou. Relatório e contagens totais não são reduzidos por esse limite.

Não foram executados suíte ampla, Chrome real, `verify` ou ZIP nesta etapa. A nova alternativa ainda precisa compor o próximo candidato nativo antes de entrega ao usuário. O histórico humano legível de `0f469ba` também aguarda o próximo pacote.
