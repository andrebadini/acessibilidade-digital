# Conferência ABNT na própria página — gate de aceitação

Status: **roteiro preparado; integração e Chrome real ainda pendentes**. Não é evidência de aprovação e não descreve recursos da beta1.1.0 já entregue.

## Referência visual e funcional

As cinco imagens WAVE enviadas pelo usuário mostram painel lateral compacto, contadores, lista de ocorrências agrupadas, explicação contextual e sinais na página. Audita usará organização por ABNT NBR17225:2025, com WCAG complementar; não copiará marca, logotipo ou conclusão normativa do WAVE. O sinal representa um resultado registrado na auditoria e um elemento correspondente localizado agora, não nova captura nem certificação de que o conteúdo permaneceu idêntico à cópia auditada.

## Percurso obrigatório no candidato

1. Abrir painel numa página de fixture com dois elementos identificáveis, pelo menos duas ocorrências no mesmo elemento, uma ocorrência geral e um alvo não localizável.
2. Avaliar silenciosamente e confirmar sumário, relatório e preservação da página original: sem mudança de rolagem, foco, seleção, valores dos controles ou ações simuladas.
3. Acionar Mostrar sinais na página. Observar vários botões com número, símbolo e quantidade; um único sinal para o elemento compartilhado. Nenhum scroll/foco automático. Contagem separa sinais efetivamente localizados, questões gerais, não localizados e omitidos pelo limite do painel.
4. Clicar no sinal. O grupo ABNT correto abre e a ocorrência correta é selecionada; controle do site não recebe clique. Explicação, anúncio estimado e evidências continuam disponíveis.
5. Selecionar outra ocorrência pelo painel: anel muda no elemento correspondente sem rolar. Só Ir ao elemento pode rolar. Teclado alcança sinais e Enter/Espaço operam o mesmo comando.
6. Filtrar falhas/alertas/revisões/positivos e impacto/nível: os sinais e suas quantidades refletem o subconjunto, mas os totais da auditoria não mudam. Filtro vazio de ocorrências não deixa um anel antigo visível.
7. Ocultar sinais, usar Escape, refazer, fechar painel, excluir auditoria e reiniciar worker: confirmar limpeza de elementos e estado próprios. Raízes/listeners de um overlay alheio permanecem.
8. Navegar A→B, inclusive B com os mesmos IDs de elementos: zero sinais em B por comandos atrasados. Mudança de documento/URL e expiração não reativam associação antiga. Mudança de conteúdo do alvo limpa a instalação e orienta nova avaliação.
9. Abrir/exportar relatório depois da conferência e comparar revisão/hash/evidências anteriores: sinais de apresentação não alteram o registro auditado nem aparecem como captura original.

Prova de continuidade: deixar o resultado aberto por pelo menos45segundos antes de mostrar sinais e, depois, manter os sinais abertos pelo mesmo período sem interação. Registrar o comportamento de idle do worker e distinguir de reinício forçado. Uma conexão Port aberta, por si só, não comprova continuidade; não aceitar sucesso obtido apenas enquanto o debugger mantém o worker vivo.

## Provas que registrar

- SHA integrado, versão, Chrome for Testing e comandos executados; somente perfil de teste isolado.
- Capturas reais do painel compacto com página marcada, grupo ABNT/ocorrência selecionada e estado após filtro. Inspeção visual a100% e zoom200%, foco visível, contraste e leitura sem depender apenas de cor.
- Resultado dos testes de autorização, protocolo/controller, overlay e percurso nativo, separando PASS de pendências.
- Resultado esperado para página/target não elegível, sem contagem falsa de localizados nem desaparecimento do achado do relatório.
- Download HTML/PDF de relatório correlacionado; não aceitar apenas a mensagem de sucesso como prova do arquivo.

## Limites transparentes

O primeiro recorte usa identificador estável/tag corroborados pela evidência. Alvos somente posicionais, iframes/Shadow DOM inacessíveis, seletores ambíguos e conteúdo mudado não recebem sinais inventados. O painel tem orçamento de64 ocorrências interativas; o relatório preserva o conjunto integral. Esses limites devem ser comunicados na interface, não ocultados atrás de um total de candidatos chamado “localizados”.

## Verificação local W3-client (não nativa)

Task5, base437f868: novos testes de protocolo produziram RED2/3 e novos testes de cliente RED6/6 antes da implementação. Após correção, `node --test test/background/worker-protocol.test.js test/panel/panel-session-port.test.js`:91/91PASS; regressões diretamente relacionadas de panel-port, panel-port-admitted-intents e service-worker:211/211PASS. `git diff --check`PASS. Revisão independente do diff congelado: C0/I0, novos testes9/9 confirmados pelo revisor.

O canal agora reconhece os quatro comandos fechados, acrescenta autoridade privada e impede evento/resposta de revisão antiga de selecionar detalhes novos. Não há wiring global nem controles visuais novos neste checkpoint. W3-runtime continua separado; o roteiro Chrome acima permanece inteiramente pendente para a funcionalidade de sinais.

Task6, basea12c697: RED7/7 na API estendida ausente; após implementação,9/9 novos testes passaram, incluindo troca result→running→mesmo result. Testes de panel-port/panel-port-admitted-intents/panel-session-port:191/191PASS; regressão service-worker95/95PASS; diff-checkPASS. Revisão independente C0/I0 e9/9 confirmados. A conexão admitida agora mantém recibo privado de resultado, publica seleção sem autoridade no payload e invalida antes de cleanup assíncrono. Wiring global e Chrome permanecem pendentes.

Task4 W3-runtime: controller e binder em cinco arquivos novos. RED comportamental inicial do controller0/11 e binder1/4; primeira versão congelada passou69/69 testes focados/relacionados. Revisão independente identificou três problemas importantes: cancelamento durante probe/instalação, janela alterada confundida com documento ausente e seleção privada obsoleta após alvo indisponível. Rodada agrupada: quatro reproduções RED0/4→GREEN4/4; conjunto final73/73PASS, confirmado pelo agente principal; syntax/diff-checkPASS. Mesmo revisor validou os três ajustes e TTL após probe: C0/I0. Nenhum teste nativo foi executado neste checkpoint.

O controller usa o símbolo privado real AUDIT_EXECUTION_INTERNAL, prova a origem, injeta somente no documentId original, mantém seleção/instalação privadas e limpa o overlay próprio com possibilidade de repetir cleanup não confirmado. Binder mantém o canal apenas durante a conferência explícita. O pacote1.1.0 não foi alterado; conexão global com worker, controles visuais e prova de continuidade antes de Mostrar sinais ainda faltam.

## Base técnica consultada

## Integração de apresentação em teste local (06/09)

Task8: nove REDs iniciais antes da API do helper; dois REDs adicionais reproduziram eco de seleção e fila antiga bloqueando novo resultado. GREEN do helper11/11. Runtime com bundle validado e cliente de Port reais (Chrome fake somente na fronteira) comprova Mostrar/Ocultar, seleção de ABNT após clique, filtros, preservação dos totais, ausência de transferência de foco e scroll somente explícito. Helper+runtime32/32 PASS. Task9 view45/45 PASS; conjunto diretamente relacionado view/client/state139/139 PASS. Diff-check limpo. Revisão independente ainda em andamento; esses números não representam aprovação nativa.

A documentação oficial de lifecycle do Chrome foi conferida novamente: abrir Port não basta para preservar estado em memória durante inatividade. O intervalo entre receber o resultado e clicar em Mostrar continua sendo um item explícito de integração/aceitação. Não foi alterada a beta1.1.0 nem gerado novo pacote.

Revisão Task8/9: C0/I1 inicial. Repro no painel importado confirmou continuação antiga selecionando A depois de usuário selecionar B. Correção agrupada associa continuações a bundle e versão de interação (inclui SHOW e Refazer). Helper+runtime32/32 PASS; teste adicional revision1→2 com mesmos IDs e retorno antigo confirma ausência de SELECT indevido. Mesmo revisor validou1/1 fresco, C0/I0. Apresentação local aprovada no recorte; gate Chrome continua pendente.

- [Chrome scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting): função injetada autocontida, mundo isolado e direcionamento por documentIds.
- [Chrome messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging): canal Port e encerramento do canal. A limpeza após reinício ainda exige prova real no gate, não inferência baseada apenas na documentação.
- [Chrome service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle): encerramento por inatividade e diferenças entre canal aberto, mensagens e debugger ativo.
