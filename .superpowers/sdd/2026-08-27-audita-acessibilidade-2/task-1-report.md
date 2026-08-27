# Task 1 — relatório: contrato coletor → normalizador → regras

## Implementação

- O coletor de página passou a observar `background-image`, `font-family` e `text-align`, além de expor faixas de legenda como objetos `{ kind, srclang }`. Para mídia com duração finita, registra a observação de pré-gravação; `audio` registra que possui áudio.
- O normalizador preserva `accessibleName: ''` quando o nó AX observou explicitamente um nome vazio. A ausência da propriedade continua significando dado não coletado.
- O normalizador deriva, uma vez, os campos que as regras existentes consomem: `textBlock`, `textAlign`, contraste (cores, imagem de fundo, fonte, tamanho e peso) e os campos de mídia/controle de áudio. Nenhuma regra nem alegação normativa foi modificada.
- Probes priorizam `backendNodeId` para a identidade canônica (`n-<id>`). Sem ele, usam o hash determinístico de `frameId:selector`; a mesclagem só aceita esse fallback quando ele identifica exatamente um nó e uma observação.
- O adaptador de Chrome anexa o frame principal às medições de alvo e gera seletor estrutural determinístico para elementos sem `id`.

## Arquivos

- `src/collector/page-collector.js`
- `src/core/normalize-snapshot.js`
- `src/core/normalize-probes.js`
- `src/background/chrome-adapter.js`
- `test/integration/collector-rule-contract.test.js` (novo)

## TDD — RED

1. `node --test test/integration/collector-rule-contract.test.js test/core/normalize-snapshot.test.js test/core/normalize-probes.test.js`
   - 29/31 passaram; falharam como esperado: nome AX vazio era descartado (`undefined !== ''`) e o fallback selector+frame não vinculava o target.
2. `node --test test/integration/collector-rule-contract.test.js`
   - 1/2 falhou como esperado: `captionTracks` emitido pelo coletor era descartado pelo normalizador (`undefined !== []`).
3. `node --test test/integration/collector-rule-contract.test.js`
   - 2/3 passaram; falhou como esperado porque um fallback ambíguo aplicava a mesma medida a múltiplos nós.

## GREEN

- `node --test test/integration/collector-rule-contract.test.js`
  - 3/3 passaram.
- `node --test test/integration/collector-rule-contract.test.js test/core/normalize-snapshot.test.js test/core/normalize-probes.test.js`
  - 32/32 passaram.
- `npm test`
  - 375/375 passaram; saída final com `fail 0`, duração aproximada de 3,1 s.

## Auto-revisão

- `git diff --check` passou sem problemas de whitespace.
- A nova integração usa o wire format de `pageData` por frame, exercita nome AX vazio, texto justificado, contraste, áudio, target-size por backend e fallback selector+frame.
- A suíte completa preserva a composição de 130 regras e 146 itens; não houve alteração em regras ou catálogo normativo.
- O ZIP de release regenerado por `npm test` foi restaurado e não integra as mudanças da tarefa.

## Preocupações

- O contraste é deliberadamente conservador: imagem/gradiente de fundo não é tratado como composição de pixels confiável.
- Sem `backendNodeId`, medições só são associadas com seletor+frame único; casos ambíguos permanecem sem observação em vez de receberem uma associação incorreta.

## Fix round 1 — revisão de contrato

### Correções

- `controls: false` não cria mais `audioControl` negativo. Sem observação de controles equivalentes, a regra de áudio retorna `cantTell`.
- A confiabilidade de contraste agora exige contexto coletado como confiável e opacidade própria igual a 1. O coletor percorre o contexto de fundo/ancestrais, recusando opacidade, imagens/gradientes ou ausência de fundo opaco observável.
- A medição de alvo consulta `DOM.getDocument` → `DOM.querySelector` → `DOM.describeNode` para emitir `backendNodeId` quando disponível; seletor estrutural + frame continua o fallback seguro.
- A identidade de fallback deixou de usar hash de 32 bits. IDs públicos opacos sequenciais não carregam o seletor; a chave bruta `frame+selector` fica apenas em um `WeakMap` privado usado durante a mesma mesclagem e é comparada sem colisão.
- O coletor não infere mais `mediaTiming: 'prerecorded'` a partir de duração finita.

### TDD — RED

`node --test test/integration/collector-rule-contract.test.js test/core/normalize-probes.test.js test/background/chrome-adapter.test.js`

- 21/27 passaram; as seis falhas esperadas expuseram: ausência de `backendNodeId` no adaptador; tokens de hash de 32 bits e uma colisão FNV-1a real; controles ausentes tratados como negativos; opacidade 0,5 tratada como contraste confiável; e timing pré-gravado inferido de duração finita.

### GREEN e verificação

`node --test test/integration/collector-rule-contract.test.js test/core/normalize-probes.test.js test/background/chrome-adapter.test.js`

- 27/27 passaram.

`npm test`

- 378/378 passaram; `fail 0`, duração aproximada de 3,1 s.

### Auto-revisão

- A fixture de integração agora espelha todos os campos de mídia observados pelo coletor corrigido (`kind`, URL sanitizada, duração, mudo, autoplay, controls, faixas e `hasAudio`) e verifica resultado conservador para controles ausentes.
- A cobertura do adaptador verifica frame, seletor estrutural e o caminho CDP que produz o backend node ID.
- O ZIP de release regenerado pela suíte foi restaurado e não integra a rodada.
