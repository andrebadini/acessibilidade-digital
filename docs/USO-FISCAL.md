# Uso fiscal do Audita MT

## O que o resultado significa

O Audita MT registra o que conseguiu observar em uma única página, naquele momento. “Aprovado” indica que a expectativa automatizável foi observada no recorte coletado. “Reprovado” indica uma falha observável. “Revisar” ou `cantTell` exige julgamento; ausência de falha automática não prova conformidade integral.

Audita MT é uma ferramenta independente, sem vínculo institucional. O relatório apoia a análise técnica, mas não equivale a certificação nem a laudo oficial.

Antes de usar o material em uma fiscalização, confira a URL, a data, o viewport quando disponível, os avisos de cobertura, as evidências e cada decisão de revisão. Identifique a pessoa avaliadora e descreva o contexto necessário. “Pular revisão” mantém o caso indeterminado.

## Arquivos gerados

- HTML: leitura acessível e autocontida do relatório.
- JSON-LD: registro técnico no vocabulário EARL, com o modelo auditado e a declaração de independência da ferramenta.
- PDF: impressão local do mesmo HTML. Navegadores que não aceitam parâmetros experimentais podem gerar PDF sem marcação estrutural adicional; a limitação é registrada. Se a impressão falhar, HTML e JSON-LD continuam disponíveis.

O modelo e os arquivos registram o estado conhecido quando os artefatos são preparados, inclusive limitações de impressão e eventual fallback do PDF. A conclusão posterior de cada download fica em um recibo local separado no estado da extensão; esse recibo não é retroativamente inserido em um arquivo que já foi baixado. Assim, “artefato preparado” e “download concluído” são afirmações distintas.

Os hashes SHA-256 ajudam a comparar bytes e manifestos, mas não são assinatura digital, carimbo de tempo certificado ou ata notarial. Os horários dependem do dispositivo.

## Destaques automáticos nas capturas

Cada ocorrência apresentada no HTML e no PDF inclui uma prévia marcada quando existe evidência visual. A moldura vermelha, acompanhada do texto “não conformidade detectada ou confirmada”, identifica falhas. A moldura âmbar, acompanhada do texto “depende de revisão humana”, identifica itens que ainda exigem julgamento. Após uma decisão humana, “conforme” produz moldura verde, “não conforme” produz moldura vermelha e “não foi possível determinar” conserva a moldura âmbar. Quando não há alvo elementar confiável, a moldura delimita a evidência da página inteira e o relatório informa essa limitação.

A marcação é uma camada de apresentação do relatório. O PNG original, sem sobreposição, permanece na seção de evidências originais com seu hash. Essa separação permite comparar a imagem-fonte com a versão destacada sem alterar a evidência coletada.

## Privacidade e permissões

O processamento local não transmite o conteúdo coletado. URLs sensíveis são saneadas antes do armazenamento e da apresentação. Evidências grandes ficam no IndexedDB; Blob URLs temporárias são usadas somente durante impressão e download e depois revogadas.

As permissões `debugger`, `downloads`, `tabs`, `scripting` e `storage`, além do acesso às páginas HTTP e HTTPS indicadas pelo usuário, são necessárias para coleta, impressão, download e persistência local.

Para uso público, instale pela Chrome Web Store e fixe o ícone do Audita MT na barra do Chrome. A instalação sem compactação, por **Carregar sem compactação**, é reservada a desenvolvimento e testes controlados.

## Limitações operacionais

Páginas adicionais, fluxos autenticados, estados não visitados, conteúdo que muda com o tempo e equivalência de mídia podem exigir amostragem e revisão externas. Frames de terceiros, canvas, vídeo e restrições do navegador podem limitar evidências. Auditorias `partial`, `failed` ou `cancelled` não devem ser apresentadas como completas.

Nesta entrega, o E2E em Chrome/Chromium real e a QA visual foram executados. A validação cobriu a instalação sem compactação, o fluxo de auditoria e revisão, os downloads HTML, JSON-LD e PDF e a apresentação em desktop, móvel e impressão. Esses ensaios devem ser repetidos no ambiente-alvo antes do uso em fiscalização.
