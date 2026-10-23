# Como contribuir

Obrigado por querer melhorar a Audita Acessibilidade! Este guia explica como relatar problemas, propor mudanças e
preparar um pull request. Ao participar, você concorda com o [código de conduta](CODE_OF_CONDUCT.md).

## Relatar um problema

Antes de abrir uma issue, procure nas [issues existentes](https://github.com/andrebadini/acessibilidade-digital/issues).
Use o modelo adequado:

- **Bug:** algo não funciona como deveria no painel, na auditoria ou nos relatórios.
- **Falso positivo ou falso negativo:** a extensão apontou uma falha que não existe, ou deixou de apontar uma que
  existe. Inclua o item da ABNT NBR 17225 ou o critério WCAG, o trecho HTML mínimo que reproduz o caso e o que você
  esperava.
- **Sugestão:** uma regra nova, um texto mais claro ou um recurso.

Não inclua dados pessoais, capturas de sistemas internos nem URLs privadas. Vulnerabilidades seguem a
[política de segurança](SECURITY.md), nunca uma issue pública.

## Preparar o ambiente

```sh
git clone https://github.com/andrebadini/acessibilidade-digital.git
cd acessibilidade-digital
npm install
```

Para usar a versão local, abra `chrome://extensions`, ative o **Modo do desenvolvedor** e escolha
**Carregar sem compactação** apontando para a pasta do repositório. Depois de editar o código, clique em recarregar
na página de extensões.

## Testes

O projeto usa o executor nativo do Node (`node:test`), sem dependências de build.

```sh
node --test test/core/*.test.js            # rode os testes da área que você mudou
npm test                                   # suíte lógica completa
AUDITA_VERIFY_SKIP_TESTS=1 npm run verify  # manifesto, CSP, axe empacotado e identidade neutra
```

Os testes E2E em `test/e2e/` usam um Chrome real: defina `AUDITA_E2E_CHROME` com o caminho do
[Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/).

Toda mudança de comportamento deve vir com teste. Uma correção de falso positivo, por exemplo, deve acrescentar a página
ou o trecho que o reproduz em `fixtures/` ou no teste da regra.

## Estilo e princípios

- **Português do Brasil** na interface, nos relatórios e na documentação, em linguagem simples.
- **Nada sai do dispositivo.** Não adicione chamadas de rede, telemetria, fontes ou scripts remotos; a política de
  segurança de conteúdo (CSP) do manifesto e o `npm run verify` impedem isso.
- **Honestidade normativa.** Uma regra automática só pode reprovar o que consegue observar; o que depende de
  julgamento vai para a revisão humana. Cite o item da ABNT NBR 17225 e o critério WCAG correspondentes.
- **Identidade neutra.** A ferramenta é independente: não use marcas, nomes ou domínios de órgãos públicos
  (`scripts/verify-neutral-identity.mjs` verifica isso).
- Siga o estilo do código ao redor: módulos ES, sem dependências de execução além do axe-core empacotado.
- Não altere `vendor/axe/` à mão; ele é gerado por `scripts/vendor-axe.mjs` e conferido por hash.

## Pull requests

1. Crie um branch a partir de `main` (`git switch -c fix/descricao-curta`).
2. Faça commits pequenos com mensagens claras, em português.
3. Rode os testes afetados e o `npm run verify`.
4. Abra o pull request preenchendo o modelo: o que mudou, por quê e como você testou.
5. Mudanças visuais devem trazer uma captura de antes e depois.

Não é preciso alterar a versão nem gerar o pacote: isso é feito pelo mantenedor ao preparar uma release
(`manifest.json`, `docs/releases/<versão>.md`, `CHANGELOG.md` e `npm run build:release`).

## Licença

Ao contribuir, você concorda que sua contribuição seja distribuída sob a [licença MIT](LICENSE) do projeto.
