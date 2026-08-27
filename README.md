# Audita MT

Extensão MV3 para auditoria local de acessibilidade de uma página, com regras da ABNT NBR 17225:2025, referências WCAG 2.2, evidências e revisão assistida. O processamento local evita enviar conteúdo da página a um serviço externo.

## Instalação para desenvolvimento

1. Abra `chrome://extensions` em uma versão compatível do Chrome ou Chromium.
2. Ative o **Modo do desenvolvedor**.
3. Escolha **Carregar sem compactação** e selecione esta pasta.
4. Fixe “Audita MT” na barra do navegador, se desejar.

Para distribuição pela Chrome Web Store, execute `npm run build:release`. O ZIP gerado em `release/` contém somente o manifesto, o código executável local e os ícones necessários, com `manifest.json` na raiz.

## Uso básico

Abra o painel, informe uma URL HTTP(S) e escolha **Auditar**. Ao final, revise os casos indeterminados e use **Gerar relatório atualizado** quando registrar novas decisões. A exportação baixa HTML autocontido, JSON-LD técnico no vocabulário EARL e, quando o navegador permite, PDF.

A auditoria captura a página inteira e elementos, incluindo pixels e dados sensíveis que estejam visíveis. Essas evidências permanecem no dispositivo e são incorporadas aos relatórios; oculte ou remova dados sensíveis antes de iniciar.

Nos relatórios, cada ocorrência com alvo recebe automaticamente uma moldura: vermelha para não conformidade e âmbar enquanto depende de revisão humana. Depois da revisão, uma resposta “conforme” muda a moldura para verde e uma resposta “não conforme” para vermelha; uma resposta inconclusiva permanece âmbar. A miniatura inclui margem ao redor do alvo; a anotação é aplicada na apresentação HTML/PDF, enquanto o PNG original e o hash permanecem preservados na seção de evidências.

As permissões `tabs` e `scripting` abrem e observam somente a aba descartável criada pela auditoria. `debugger` dá acesso local ao protocolo do Chrome para estrutura, evidência e impressão. `downloads` salva os artefatos e `storage` mantém auditoria e andamento no dispositivo. Os sites auditados são cobertos por `host_permissions` HTTP(S).

## Limites atuais

A auditoria cobre uma página e o estado observado, não todo o serviço. Itens contextuais exigem revisão humana. Frames ou capturas bloqueados podem produzir resultado parcial. Audita MT é uma ferramenta independente, sem vínculo institucional; seus resultados não equivalem a certificação nem a laudo oficial.

Nesta entrega, o E2E em Chrome/Chromium real e a QA visual foram executados. A validação cobriu a instalação sem compactação, o fluxo de auditoria e revisão, os downloads HTML, JSON-LD e PDF e a apresentação em desktop, móvel e impressão. Esses ensaios devem ser repetidos no ambiente-alvo antes do uso em fiscalização. Consulte [Uso fiscal](docs/USO-FISCAL.md) para a leitura correta dos resultados.

## Desenvolvimento

Execute `npm test` para a suíte, `node scripts/verify-project.mjs` para o checklist de entrega local e `npm run build:release` para gerar o pacote público. O verificador não substitui o ensaio manual em navegador. A política aplicável está em [Política de Privacidade](docs/POLITICA-DE-PRIVACIDADE.md).
