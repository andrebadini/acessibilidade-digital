# Uso fiscal do Audita Acessibilidade

## O que o resultado significa

O Audita Acessibilidade registra o que conseguiu observar em uma única página, naquele momento. “Aprovado” indica que a expectativa automatizável foi observada no recorte coletado. “Reprovado” indica uma falha observável. “Revisar” ou `cantTell` exige julgamento; ausência de falha automática não prova conformidade integral.

Audita Acessibilidade é uma ferramenta independente, sem vínculo institucional. O relatório apoia a análise técnica, mas não equivale a certificação nem a laudo oficial.

Antes de usar o material em uma fiscalização, confira a URL, a data, o viewport quando disponível, os avisos de cobertura, as evidências e cada decisão de revisão. Identifique a pessoa avaliadora e descreva o contexto necessário. “Pular revisão” mantém o caso indeterminado.

## Arquivos gerados

- HTML: leitura acessível e autocontida do relatório.
- CSV: tabela das ocorrências para triagem e análise complementar.
- JSON-LD: registro técnico no vocabulário EARL, com o modelo auditado e a declaração de independência da ferramenta.
- PDF: impressão local do mesmo HTML. Navegadores que não aceitam parâmetros experimentais podem gerar PDF sem marcação estrutural adicional; a limitação é registrada. Se a impressão falhar, HTML, CSV e JSON-LD continuam disponíveis.

O modelo e os arquivos registram o estado conhecido quando os artefatos são preparados, inclusive limitações de impressão e eventual fallback do PDF. A conclusão posterior de cada download fica em um recibo local separado no estado da extensão; esse recibo não é retroativamente inserido em um arquivo que já foi baixado. Assim, “artefato preparado” e “download concluído” são afirmações distintas.

Os hashes SHA-256 ajudam a comparar bytes e manifestos, mas não são assinatura digital, carimbo de tempo certificado ou ata notarial. Os horários dependem do dispositivo.

## Evidências visuais

A pessoa operadora escolhe o modo antes de iniciar:

- **Evidência completa:** pode produzir captura da página e dos elementos relacionados às ocorrências.
- **Somente elementos:** restringe os pixels aos elementos relacionados às ocorrências.
- **Sem imagens:** não captura pixels e registra essa limitação no relatório.

Nos dois modos com imagens, a extensão verifica sinais sensíveis antes de cada captura. A primeira detecção pausa a auditoria e a captura só prossegue após confirmação explícita; uma categoria nova identificada nas verificações posteriores bloqueia aquela captura. Como páginas dinâmicas podem mudar no intervalo técnico inevitável entre a última verificação e a captura, esse controle reduz, mas não elimina o risco. Oculte dados pessoais ou sigilosos antes de confirmar.

As molduras vermelha e âmbar exibidas no relatório são derivações visuais correlacionadas às ocorrências. Os PNGs originais e os respectivos hashes permanecem separados e não são modificados. No modo de evidência completa, o mapa numerado relaciona elementos e legenda dos anúncios estimados quando a coleta consegue produzi-lo. Omissões e limites ficam registrados; o anúncio não é a transcrição garantida de um leitor de tela real.

## Privacidade e permissões

O processamento local não transmite o conteúdo coletado. URLs sensíveis são saneadas antes do armazenamento e da apresentação. Dados estruturais persistidos ficam no IndexedDB; Blob URLs temporárias são usadas somente durante impressão e download e depois revogadas.

As permissões `debugger`, `downloads`, `tabs`, `scripting`, `sidePanel`, `storage`, `alarms` e `contextMenus`, além do acesso às páginas HTTP e HTTPS, são necessárias para coleta local, painel lateral, atalhos, expiração de estados temporários, impressão, download e persistência.

Depois de instalar, fixe o ícone do Audita Acessibilidade na barra do Chrome, se desejar. Um clique no ícone abre diretamente o painel lateral persistente; a auditoria só começa quando você escolhe **Auditar a página atual** dentro dele. A inspeção acontece na própria página e somente para leitura, mantendo-a visível e sem interações da extensão durante a coleta: nenhuma aba é criada, e não há navegação, rolagem, mudança de foco ou destaque. Também é possível informar **Outra URL** — aberta em uma aba temporária inativa, removida ao final — e usar os três modos de evidência. A instalação sem compactação, por **Carregar sem compactação**, é reservada a desenvolvimento e testes controlados.

## Limitações operacionais

Esta versão audita a página aberta, outra URL ou um lote explícito de 2 a 20 URLs nos três modos. Em lotes, o consentimento para capturas é individual por página; o progresso e os resultados concluídos podem ser recuperados após reinício do processo da extensão. Cancelar ou interromper definitivamente a auditoria descarta os dados temporários daquela execução após confirmar a limpeza dos recursos. Páginas adicionais, fluxos autenticados, estados não visitados, conteúdo que muda com o tempo e equivalência de mídia podem exigir amostragem e revisão externas. Frames de terceiros, canvas, vídeo e restrições do navegador podem limitar evidências. Auditorias `partial`, `failed` ou `cancelled` não devem ser apresentadas como completas.

O prazo de retenção local é de 30 dias desde o primeiro registro persistido, sem renovação ao revisar ou exportar. A limpeza depende de o Chrome executar a extensão e pode ser retomada após interrupção. Exporte antes do prazo o material que deseja conservar. A opção de exclusão após exportação começa desmarcada e depende da confirmação dos quatro downloads da mesma revisão. Arquivos já baixados não são apagados pela exclusão local. Consulte a [Política de Privacidade](POLITICA-DE-PRIVACIDADE.md).

A distribuição desta versão foi condicionada a um gate único, executado e registrado junto ao pacote: suíte lógica, verificação estática, E2E real na versão fixada do Chrome, instalação sem compactação, percurso completo até HTML, PDF, CSV e JSON-LD/EARL e QA visual do painel e do relatório. O dossiê de prontidão (`docs/qa/2026-09-17-prontidao-para-producao.md`) e o relatório da revisão independente (`docs/qa/revisoes/REVIEW-1.1.48.md`) são o registro desse gate.
