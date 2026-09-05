# Audita Acessibilidade

Extensão MV3 para auditoria local de acessibilidade de uma página, com regras da ABNT NBR 17225:2025, referências WCAG 2.2, evidências e revisão assistida. O processamento local evita enviar conteúdo da página a um serviço externo.

## Instalação da beta

1. Descompacte o arquivo da beta em uma pasta própria. Se estiver usando o código-fonte, use esta pasta do projeto.
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

Selecione **Auditar a página atual**. Abrir o painel não inicia a coleta: esse botão é a confirmação explícita. A inspeção ocorre em uma cópia temporária e inativa, de modo que a página original permanece visível, ativa e sem rolagens, mudanças de foco ou destaques durante a auditoria. Nos modos com imagens, a extensão pausa antes da primeira captura quando identifica conteúdo potencialmente sensível; nesse caso, a pessoa usuária decide se continua ou cancela. Também é possível escolher **Outra URL**, informar um endereço HTTP ou HTTPS e usar os mesmos três modos. Em **Lote de páginas**, informe de 2 a 20 URLs, uma por linha, e escolha o modo de evidência para gerar um relatório consolidado. Cada página sensível exige sua própria confirmação antes das capturas.

O painel apresenta as cinco etapas da avaliação. O indicador aparece ao lado da etapa atual e as etapas concluídas recebem um ✓ verde. Em lotes, as etapas acompanham a página em análise, enquanto a barra indica o avanço do lote inteiro. Se uma página não puder ser aberta ou observada, o relatório registra a falha e o lote segue após confirmar a limpeza daquela tentativa.

Ao final, o painel mostra o sumário, filtros e fichas das ocorrências. Cada ficha apresenta explicação, WCAG 2.2, item ABNT NBR 17225, fundamentação legal, nome acessível, anúncio estimado, seletor, código e evidências disponíveis. **Ver e destacar na página** localiza o elemento quando a prova viva ainda corresponde ao documento auditado. A auditoria da página atual e os lotes fecham suas cópias temporárias: nesses casos, o relatório permite consultar as evidências, mas não destacar o elemento ao vivo. Para testar o destaque vivo nesta beta, use **Outra URL** e mantenha a página auditada disponível. **Abrir relatório completo** abre a revisão em uma aba própria. A exportação baixa HTML autocontido, PDF, CSV e JSON-LD/EARL.

Capturas apresentadas no relatório recebem molduras derivadas por ocorrência: vermelho para falha confirmada e âmbar tracejado para revisão pendente. Os PNGs originais e seus hashes permanecem separados e inalterados.

As permissões `tabs`, `scripting` e `debugger` permitem identificar e inspecionar localmente a página ativa escolhida, coletar a árvore de acessibilidade, registrar evidências e preparar a impressão. `sidePanel` mantém a interface ao lado da página; `downloads` salva os artefatos; `storage` mantém auditoria e andamento no dispositivo; `alarms` agenda a expiração de estados temporários; `contextMenus` oferece um atalho opcional. Os sites auditados são cobertos por `host_permissions` HTTP(S). A extensão não envia o conteúdo coletado para um servidor próprio.

## Limites atuais da beta

A beta audita a página aberta, outra URL ou um lote explícito de 2 a 20 URLs nos três modos, sempre sobre os estados observados, e não todo o serviço. O mapa numerado consolidado de anúncios permanece em desenvolvimento; as evidências visuais individuais estão disponíveis nos modos com captura. Itens contextuais exigem revisão humana. Frames de terceiros, canvas, vídeo, conteúdo protegido ou coleta estrutural bloqueada podem produzir resultado parcial.

Audita Acessibilidade é uma ferramenta independente, sem vínculo institucional. A cobertura automática não equivale a certificação nem a laudo oficial. Consulte [Uso fiscal](docs/USO-FISCAL.md) para interpretar o resultado e [Backlog da beta](docs/BETA-BACKLOG.md) para as melhorias não bloqueantes já registradas.

O candidato beta só deve ser distribuído depois do gate único de suíte lógica, verificação estática, E2E real no Chrome e QA visual. O registro desse gate acompanha o pacote final.

## Desenvolvimento

Durante mudanças, execute apenas os testes afetados. No candidato de entrega, configure o Chrome for Testing previsto pelo projeto, execute a suíte ampla e os E2E reais uma vez, rode `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify` e então gere o pacote com `npm run build:release`. A política aplicável está em [Política de Privacidade](docs/POLITICA-DE-PRIVACIDADE.md).
