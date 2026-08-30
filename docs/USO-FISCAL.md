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

A auditoria anexada atual usa o modo sem pixels: inspeciona a estrutura da página ativa, mas não produz captura da página, miniatura do elemento nem imagem anotada. O relatório deve indicar essa ausência de forma explícita. Modos futuros de captura condicionados a consentimento e decisões próprias de privacidade não devem ser presumidos neste fluxo.

## Privacidade e permissões

O processamento local não transmite o conteúdo coletado. URLs sensíveis são saneadas antes do armazenamento e da apresentação. Dados estruturais persistidos ficam no IndexedDB; Blob URLs temporárias são usadas somente durante impressão e download e depois revogadas.

As permissões `debugger`, `downloads`, `tabs`, `scripting` e `storage`, além do acesso às páginas HTTP e HTTPS indicadas pelo usuário, são necessárias para coleta, impressão, download e persistência local.

Depois de instalar, fixe o ícone do Audita Acessibilidade na barra do Chrome, se desejar. Um clique no ícone abre diretamente o painel lateral persistente; a auditoria só começa quando você escolhe **Auditar a página atual** dentro dele. A instalação sem compactação, por **Carregar sem compactação**, é reservada a desenvolvimento e testes controlados.

## Limitações operacionais

Páginas adicionais, fluxos autenticados, estados não visitados, conteúdo que muda com o tempo e equivalência de mídia podem exigir amostragem e revisão externas. Frames de terceiros, canvas, vídeo e restrições do navegador podem limitar evidências. Auditorias `partial`, `failed` ou `cancelled` não devem ser apresentadas como completas.

Nesta etapa, os testes unitários, de integração não gráfica e as verificações estáticas passaram. O gate E2E em Chrome 116 e na versão atual, incluindo QA visual em desktop, móvel e impressão, instalação sem compactação e o percurso completo até HTML, PDF, CSV e JSON-LD, ainda está pendente. Até esse gate terminar, o comportamento real no navegador não deve ser apresentado como verificado.
