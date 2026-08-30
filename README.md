# Audita Acessibilidade

Extensão MV3 para auditoria local de acessibilidade de uma página, com regras da ABNT NBR 17225:2025, referências WCAG 2.2, evidências e revisão assistida. O processamento local evita enviar conteúdo da página a um serviço externo.

## Instalação para desenvolvimento

1. Abra `chrome://extensions` em uma versão compatível do Chrome ou Chromium.
2. Ative o **Modo do desenvolvedor**.
3. Escolha **Carregar sem compactação** e selecione esta pasta.
4. Fixe “Audita Acessibilidade” na barra do navegador, se desejar. Ao clicar no ícone, o Chrome abre o painel lateral persistente ao lado da página.

Para gerar o pacote distribuível, execute `npm run build:release`. O ZIP criado em `release/` contém somente o manifesto, o código executável local e os ícones necessários, com `manifest.json` na raiz.

## Uso básico

Clique no ícone da extensão para abrir o painel lateral e escolha **Auditar a página atual**. Abrir o painel não inicia a coleta: o botão é a confirmação explícita. O Chrome controla e permite redimensionar a largura do painel. Ao final, revise os casos indeterminados e use **Gerar relatório atualizado** quando registrar novas decisões. A exportação baixa HTML autocontido, PDF, CSV e JSON-LD técnico no vocabulário EARL.

A auditoria anexada atual inspeciona localmente a estrutura da página ativa e não captura pixels. A URL e o conteúdo estrutural necessário à análise podem conter dados sensíveis; oculte ou remova esses dados antes de iniciar. Modos de captura visual condicionados a uma etapa própria de privacidade não fazem parte deste fluxo atual.

Os relatórios apresentam as ocorrências, os alvos estruturais disponíveis e as decisões de revisão. Como o fluxo anexado atual usa o modo sem pixels, ele não produz miniaturas nem capturas anotadas da página.

As permissões `tabs` e `scripting` permitem identificar e inspecionar localmente a página ativa escolhida no painel; a auditoria anexada não navega, fecha nem substitui essa aba. `debugger` dá acesso local ao protocolo do Chrome para coletar a estrutura e preparar a impressão. `downloads` salva os artefatos e `storage` mantém auditoria e andamento no dispositivo. Os sites auditados são cobertos por `host_permissions` HTTP(S).

## Limites atuais

A auditoria cobre uma página e o estado observado, não todo o serviço. Itens contextuais exigem revisão humana. Frames de terceiros ou coleta estrutural bloqueada podem produzir resultado parcial. Audita Acessibilidade é uma ferramenta independente, sem vínculo institucional; seus resultados não equivalem a certificação nem a laudo oficial.

Nesta etapa, os testes unitários, de integração não gráfica e as verificações estáticas passaram. O gate E2E em Chrome 116 e na versão atual, incluindo QA visual em desktop, móvel e impressão, instalação sem compactação e o percurso completo até os quatro downloads, ainda está pendente e não deve ser tratado como comportamento verificado. Consulte [Uso fiscal](docs/USO-FISCAL.md) para a leitura correta dos resultados.

## Desenvolvimento

Execute `npm test` para a suíte, `node scripts/verify-project.mjs` para o checklist de entrega local e `npm run build:release` para gerar o pacote público. O verificador não substitui o ensaio manual em navegador. A política aplicável está em [Política de Privacidade](docs/POLITICA-DE-PRIVACIDADE.md).
