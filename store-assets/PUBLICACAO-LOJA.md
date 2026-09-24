# Publicação na Chrome Web Store — 1.1.51

Roteiro de preparação e envio da Audita Acessibilidade. A publicação exige uma conta de desenvolvedor
autenticada; o estado do console é a fonte para saber se o item está em rascunho, em revisão ou publicado.
Este documento não comprova um envio.

## Pré-requisitos

1. Conta registrada no [console de desenvolvedores](https://chrome.google.com/webstore/devconsole), com
   verificação de identidade e verificação em duas etapas concluídas.
2. Política vigente em HTTPS público: <https://andrebadini.github.io/audita-acessibilidade-privacidade/>.
   O destino é o repositório público `andrebadini/audita-acessibilidade-privacidade`, servido pelo GitHub Pages.
   O arquivo local é `store-assets/privacy.html`, gerado de `docs/POLITICA-DE-PRIVACIDADE.md` por
   `node store-assets/render-privacy.mjs`. Confira a versão publicada e a correspondência dos bytes antes do envio.
3. Ícone de 128×128 no pacote (`assets/icons/icon-128.png`) e imagem promocional pequena
   `store-assets/promo-small.png`, de 440×280, RGB sem alfa. A fonte vetorial está em `promo-small.svg`;
   no macOS, `sh store-assets/render-promo.sh` regenera o PNG sem iniciar Chrome.
4. Use as três capturas reais do percurso de Tab, todas em **1280×800**, PNG RGB sem alfa, nesta ordem:
   `screenshot-tab-report.png` (visão geral e totais), `screenshot-tab-elements.png` (sequência estimada,
   nomes e funções) e `screenshot-tab-highlight.png` (foco real com legenda na página).
   Elas mostram a interface atual sobre a página demonstrativa local `fixtures/pages/tab-reading.html`, com
   dados fictícios. As capturas foram inspecionadas visualmente; as dimensões e o formato são verificados pelo
   teste de assets. Os arquivos `screenshot-panel.png`, `screenshot-evidence-failed.png` e
   `screenshot-evidence-review.png` ficam como histórico e **não devem ser enviados nesta versão**.

Os requisitos oficiais de imagem estão em
[Fornecer imagens](https://developer.chrome.com/docs/webstore/images). A imagem promocional é uma peça de marca,
não uma captura de tela nem evidência de execução do produto.

## Pacote e verificação

O arquivo de envio é `release/audita-acessibilidade-1.1.51.zip`, com `manifest.json` na raiz e versão `1.1.51`.
O ZIP deve ser gerado somente depois da validação da implementação final. Confira o digest contra a nota
`docs/releases/1.1.51.md`; não reutilize o digest de 1.1.50.

Comandos de conferência local:

```sh
AUDITA_VERIFY_SKIP_TESTS=1 npm run verify
node --test test/release-assets.test.js test/release-package.test.js
shasum -a 256 release/audita-acessibilidade-1.1.51.zip
unzip -p release/audita-acessibilidade-1.1.51.zip manifest.json
```

Os dois primeiros comandos verificam estrutura, política, assets e correspondência de bytes. Eles não
substituem o teste do novo percurso em Chrome real nem comprovam a submissão. Para reconstruir o pacote,
use `npm run build:release` e registre o novo digest após a validação.

## Campos do formulário

Copie os textos de `store-assets/STORE-LISTING.md` e confirme cada campo no console.

| Campo | Conteúdo |
| --- | --- |
| Nome, resumo e descrição | Seções correspondentes do listing |
| Categoria e idioma | Acessibilidade; Português (Brasil) |
| Finalidade única | Auditoria e conferência local de acessibilidade |
| Permissões | Justificativa individual para cada permissão e para hosts HTTP/HTTPS |
| Código remoto | Não; runtime incluído no pacote Manifest V3 |
| Categorias de dados | Histórico da Web, Conteúdo do site, Informações de identificação pessoal (nome do avaliador informado) e Atividade do usuário (observação transitória do foco e de eventos de navegação durante acompanhamento explicitamente ativado, sem registrar texto digitado ou histórico de teclas) |
| Uso dos dados | Local, restrito à finalidade declarada; sem venda ou publicidade |
| Visibilidade e regiões | Pública; todas as regiões, preservando a configuração do item existente |
| Política de privacidade | URL HTTPS acima, com versão e conteúdo vigentes |
| Suporte | `https://github.com/andrebadini/audita-acessibilidade-privacidade/issues` |
| Instruções para o revisor | `store-assets/TEST-INSTRUCTIONS.md`, incluindo Tab sem áudio e exportações complementares |
| Imagens | Ícone, `promo-small.png`, `screenshot-tab-report.png`, `screenshot-tab-elements.png` e `screenshot-tab-highlight.png` |

A finalidade única inclui o relatório complementar de Tab: uma inspeção de acessibilidade independente, sem
imagens, com sequência estimada e acompanhamento de foco real. A prévia textual não deve ser anunciada como
fala literal de tecnologia assistiva ou como certificação de conformidade.

## Envio e acompanhamento

1. Abra o item existente quando houver um; evite criar uma duplicata. Se for o primeiro envio, crie o item e
   registre seu ID e URL reais após a criação.
2. Faça upload do ZIP verificado, preencha os campos, confira a política e as imagens e resolva as exigências
   que o console apresentar.
3. Envie para revisão e registre versão, digest, ID do item, data/hora, visibilidade e estado retornado.
4. Diferencie “enviado para revisão” de “publicado”. O resultado depende da análise da loja; confirme a
   disponibilidade da página pública antes de anunciar a publicação.
5. Nos próximos envios, use uma versão de manifesto maior que a versão já enviada/aceita pelo console.
