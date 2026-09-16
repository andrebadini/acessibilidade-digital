# Audita Acessibilidade

Extensão MV3 para auditoria local de acessibilidade de uma página, com regras da ABNT NBR 17225:2025, referências WCAG 2.2, evidências e revisão assistida. O processamento local evita enviar conteúdo da página a um serviço externo.

## Instalação e estado da entrega

**Versão de produção 1.1.17 preparada:** a revisão independente da 1.1.16 encontrou um achado
**Critical** no produtor de obrigatoriedade de 5.9.7 — ele convertia marcações legítimas
(`label::after`, `aria-labelledby`, `placeholder`, rótulo longo) em infração confirmada e imprimia
a frase legal de não conformidade — e um achado Important no teste de pacote, que conferia apenas
a reconstrução e nunca o arquivo entregue. A fronteira foi corrigida: 5.9.7 volta a ficar em
revisão nos dois sentidos e só reprova contradição programática demonstrável. Como isso muda o que
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

A versão **1.1.17** tem [guia de instalação e uso](docs/COMO-USAR.md). Acrescenta a identificação visível da versão de origem na metodologia do relatório e de sua impressão e corrige o sinal de cancelamento na retomada de lotes. Novas auditorias registram a versão instalada; antigas mantêm a versão de origem. Guias didáticos, grupos ABNT, sinais e evidências permanecem disponíveis. Checklist geral, suspeitas concretas e falhas são separados; a revisão automática não certifica conformidade integral. Resultados de versões anteriores são históricos, não comprovação de execução desta versão.

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

Selecione **Auditar a página atual**. Abrir o painel não inicia a coleta: esse botão é a confirmação explícita. A inspeção ocorre em uma cópia temporária e inativa, de modo que a página original permanece visível, ativa e sem rolagens, mudanças de foco ou destaques durante a auditoria. Nos modos com imagens, a extensão pausa antes da primeira captura quando identifica conteúdo potencialmente sensível; nesse caso, a pessoa usuária decide se continua ou cancela. Também é possível escolher **Outra URL**, informar um endereço HTTP ou HTTPS e usar os mesmos três modos. Em **Lote de páginas**, informe de 2 a 20 URLs, uma por linha, e escolha o modo de evidência para gerar um relatório consolidado. Cada página sensível exige sua própria confirmação antes das capturas.

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
