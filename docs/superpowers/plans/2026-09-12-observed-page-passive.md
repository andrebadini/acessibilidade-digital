# Página atual sem interação visível

Objetivo aprovado pelo usuário: avaliar o estado realmente aberto no navegador, sem navegar, recarregar, mudar foco, rolagem, zoom ou estilos na aba original. Preservar autorização de capturas, identidade do documento e correlação do relatório. Não trocar a meta por mera remoção de avisos de cópia.

## Evidência do estado inicial

Em 5284fb3, `beginAuthorizedAudit` usa `prepareAttachedCopyPlan` quando há suporte de URL. A função conserva somente a URL, não o estado do DOM. A fachada `runAttachedAuditExecution` já existe, com fronteiras de identidade, persistência e pixels. Entretanto seu adaptador legado ainda permite `runDynamicProbes`, que envia Tab e altera viewport, texto e preferência de movimento. `captureFullPage` usa Page.captureScreenshot com captureBeyondViewport, não navegação por scroll explícito.

## Contrato e incrementos congeláveis

1. Execução passiva: em run-audit.js, alvos attached não executam probes dinâmicos. A ausência é explicitamente registrada como escolha de observação passiva, não timeout, erro, aprovação nem inaplicabilidade inventada. Preservar coleta DOM/AX, regras estáticas, captura autorizada e identidade antes de cada raster. Arquivos previstos: run-audit.js, diagnóstico canônico e testes diretamente relacionados. Antes de código, revisão read-only define casos adversariais; depois TDD e uma revisão agrupada.
2. Roteamento: beginAuthorizedAudit usa a fachada attached existente para página atual; beginAuthorizedUrlAudit mantém cópia descartável para URL fornecida. Não acrescentar autorização implícita, não criar abas para o primeiro fluxo, não mudar contratos de nonce ou journaling sem RED. Testes do starter provam isolamento dos dois fluxos, cancelamento e retomada. Remover apenas o desvio comprovadamente responsável pela recarga, preservando rotas de URL.
3. Apresentação e integração: página atual informa observação do estado presente e verificações interativas não executadas; URL avisa carregamento independente. Relatório não atribui evidência de cópia à origem. Percurso real em Chrome confirma menu aberto preservado, foco/scroll/viewport/estilos idênticos, relatório e destaque no elemento do documento observado. Revisões finais paralelas no candidato congelado.

## Critérios de saída

- Zero invocação de navegação/teclas/probes de alteração na página atual.
- Capturas somente após autorização e prova documental válida; navegação durante auditoria não produz evidência atribuída ao documento anterior.
- Falhas reais estáticas continuam detectadas; testes omitidos ficam com cobertura incompleta e orientação humana.
- Abrir painel → avaliar estado atual → sumário → ocorrência → destaque → evidência → exportação funciona em Chrome real.
- URL fornecida e lote não perdem a avaliação em ambiente descartável.
- Nenhum Critical/Important conhecido no incremento integrado. Não aprovar produção só por unit tests.

## Incremento 1 — execução passiva

RED confirmado: dois testes attached (no-pixels e full-evidence) chamavam probes; teste de política não publicava limitação de omissão. Implementação usa identidade privada de adapter attached, normalização vazia conservadora e diagnóstico não parcial publicado nas limitações do relatório. URL/owned permanecem ativos. Testes adicionais cobrem fallback, throw/timeout que não podem executar nem contaminar resultados; cobertura de captura e identidade preexistente preservada.

GREEN focado: `node --test test/background/run-audit.test.js test/report/diagnostic-policy.test.js`, 164/164, em 12/09. `git diff --check` verde. Ajustado teste de snippet cujo oráculo dependia de ser o primeiro bloco do relatório; agora exige o snippet correspondente, mantendo hash, remoção de conteúdo perigoso e codificação única. Revisão independente solicitada sobre os cinco arquivos congelados. Não houve Chrome, suíte ampla, empacotamento nem alteração de starter/UI nesta etapa.

Revisão concluída C=0/I=0/M=0, 17 verificações adicionais verdes do revisor. Integrado em `742ca45`, cinco arquivos exatos, node_modules excluído. Incremento 1 congelado. Próximo: roteamento da página atual (incremento 2), mantendo recovery histórico de cópias e rota explícita de URL.

## Incremento 2 — roteamento

RED: três modos com dependências de URL presentes tentavam preparar cópia e negavam o início quando a cópia não era disponibilizada. Correção mínima remove o desvio `if (hasUrlAudit)` de `beginAuthorizedAudit`; caminho attached já existente passa a ser usado também na composição completa. Nenhuma alteração em autorização, coleta, recovery ou URL explícita.

Testes históricos de cópia agora preparam o exchange real e chamam a fronteira URL explicitamente por helper de teste, sem conservar o comportamento errado em novos inícios de página atual. Casos pré-ACTIVE continuam montando journals reais. Incluído teste de evento worker, preservação do documento/tab/window/digest/modo e ausência de preparação/execução/cleanup de cópia.

GREEN: `node --test test/background/authorized-audit-starter.test.js`, 150/150, diff-check verde. Dois arquivos congelados para revisão independente. Deps de fábrica e token interno agora sem chamador foram mantidos para não expandir o contrato; limpeza de código morto é Minor não bloqueante.

Revisão B aprovada C=0/I=0/M=0, nove verificações adicionais verdes. Integrado em `1c9b296` (dois arquivos exatos). A e B congelados; não reabrir sem RED importante reproduzível.

Próximo incremento C: adaptar E2E `current-page audits run in one inactive copy...` em sidepanel-flow-mv3.test.mjs para exigir documento original/estado aberto preservado; não conservar oráculo de cópia. Verificar destaque, relatório, modos e exportação no Chrome 152 isolado. Mensagens históricas ATTACHED_COPY permanecem corretas para relatórios antigos e não devem ser removidas globalmente. Não há prova de Chrome do novo roteamento ainda.

## C — primeira prova real, ainda parcial

Chrome for Testing confirmado em `/private/tmp/audita-cft152-hqalvn/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`, versão 152.0.7977.64. Novo caso `passive current-page observes memory-only elements without navigation or interaction`: passou em aproximadamente 2 segundos com `AUDITA_E2E_CHROME=... node --test --test-name-pattern='passive current-page observes' test/e2e/sidepanel-flow-mv3.test.mjs`. Perfil isolado gerenciado pelo helper, sem perfil pessoal.

Evidência: documento/loader iguais, DOM e estilos computados preservados, foco/seleção/scroll/viewport visual iguais, zero eventos observados e zero mutações do corpo durante auditoria; zero abas criadas, owners, raw vault ou pixels. Seletor sanitizado de axe.button-name resolve ao botão criado somente em memória; achado próprio accessible-component-name falha no mesmo nodeId. Axe conserva cantTell conforme seu mapeamento suplementar, sem falsificar sua classificação. O relatório abre e mostra ABNT/WCAG e a omissão passiva.

Ajustes do próprio teste: aguardar estabilização nativa do painel antes do baseline; resolver seletor sanitizado ao elemento em vez de procurar ID literal no JSON; distinguir a classificação suplementar do achado próprio. Sem mudança de produção nesta rodada. Teste congelado para revisão.

Revisão agrupada: lacuna Important na instrumentação permitiria clique sem mudança visual passar despercebido. Instrumentação ampliada para o conjunto de eventos do helper original, incluindo click/pointer/beforeinput/selectionchange/focus/blur e document.hasFocus. Também fixado ruleId do achado suplementar e exigida evidência não raster. Revalidação Chrome152: 1/1 em 2,2 s; diff-check verde. A ausência conhecida da versão do navegador no coletor continua gerando limitação parcial, sem ser escondida pelo teste.

C continua incompleto: modos com pixels, confirmação/restart, destaque ao vivo, quatro exportações e revisão visual ainda não demonstrados pelo caso novo. Testes antigos com expectativa de cópia continuam no arquivo e precisam ser migrados antes da suíte ampla; não os pular nem considerar esse caso único como aprovação da etapa ou da produção.

Checkpoint do teste aprovado após correção agrupada: C=0/I=0/M=0 no escopo parcial. Revisor não repetiu o Chrome; conferiu as linhas corrigidas contra o resultado recente. Próxima execução deve ampliar esse caso para destaque/exportação e pixels; não reabrir o roteamento A/B sem regressão demonstrada.

### C — destaque do achado no documento observado

RED real reproduzido: relatório oferecia o controle, mas a consulta de disponibilidade retornava indisponível para o botão criado em memória. O registro tinha dez alvos, sem a ocorrência do botão. Diagnóstico independente confirmou que a evidência usava `#memory-only-unnamed`, enquanto a gramática fechada do destaque exige tag no início. A ocorrência era descartada antes da prova do elemento, não por falta de evidência nem por navegação.

Correção mínima no produtor: IDs únicos agora geram `button#memory-only-unnamed` (tag real + ID escapado), antes do hash da evidência. Parser, autorização, identidade, correlação e modelos já gravados não foram modificados. Teste unitário de integração entre produtor e parser confirmou RED antes da alteração. Ajustadas duas expectativas do produtor e uma da evidência integrada para o formato equivalente.

GREEN: 168/168 em selector, highlight-locator, highlight-binding e run-audit. Chrome152 real: o caso passivo ampliado passou em 2,8 s, com relatório, disponibilidade, destaque geometricamente coincidente com o botão observado, remoção do destaque e hash do modelo preservado. Os controles exigem clique explícito; durante a auditoria permanecem zero eventos, zero mutações e zero navegações. Diff-check verde. Revisão independente do diff congelado solicitada.

Limite do checkpoint: não demonstra suporte a todo seletor CSS; atributos/IDs fora da gramática continuam sujeitos à indisponibilidade conservadora. Não amplia permissões para contornar esses casos. Continuam pendentes em C os modos com pixels, consentimento/restart, exportações e migração dos E2E antigos de cópia; o checkpoint não aprova produção.

Revisão independente concluída: C=0/I=0; 6/6 testes do seletor repetidos pelo revisor. A limitação de gramática acima foi classificada como Minor preexistente. Asserção geométrica confirmada pelo processo raiz no Chrome, juntamente com remoção e hash preservado. Checkpoint aprovado, sem declaração de suporte universal nem de produção global.
