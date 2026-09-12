# Caracterização MHTML — alternativa de captura passiva

Chrome for Testing 152.0.7977.64, perfil isolado, fixture sintética local. Nenhuma página do usuário, credencial real ou serviço externo envolvido. `test/e2e/mhtml-state-characterization.test.mjs` executado: 1/1.

Hipótese: `Page.captureSnapshot({format:'mhtml'})` poderia fornecer reprodução do estado atual para rasterizar em aba temporária sem alterar a origem. A [documentação oficial](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureSnapshot) prevê serialização de iframes, shadow DOM, recursos externos e estilos inline; não promete preservação de todo o estado em memória.

Observações reais do arquivo nativo, com decodificação das quebras quoted-printable para os marcadores ASCII da fixture:

| Estado após carregamento | Encontrado no MHTML |
| --- | --- |
| Botão criado com appendChild | Sim |
| Valor atual atribuído à propriedade de input | Não |
| Valor atual de textarea | Não |
| Checkbox marcado via propriedade checked | Não |
| Recurso PNG para canvas desenhado | Não |

DOM da origem, valores dos campos, checkbox, foco, scroll, viewport e canvas da página permaneceram idênticos após a captura. Isso prova a ausência das alterações verificadas nesta fixture, **não** a fidelidade de uma reprodução. O teste não navega nem rasteriza o arquivo MHTML e não persiste seu conteúdo; apenas emite as observações booleanas. Não extrai dados de usuários.

Conclusão do experimento: MHTML puro não resolve a captura fiel do estado atual exigida pelo produto. Não substituir a página real por esse arquivo nem rotular a reprodução como evidência integral. Uma eventual estratégia de reprodução teria de demonstrar preservação dos estados omitidos, fidelidade dos recursos e autorização/limpeza da cópia; isso ainda não foi implementado ou validado. A correção normativa/report de `d5979e7` é independente e permanece integrada.
