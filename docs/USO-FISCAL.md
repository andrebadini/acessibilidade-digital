# Uso fiscal do Audita MT

## O que o resultado significa

O Audita MT registra o que conseguiu observar em uma única página, naquele momento. “Aprovado” indica que a expectativa automatizável foi observada no recorte coletado. “Reprovado” indica uma falha observável. “Revisar” ou `cantTell` exige julgamento; ausência de falha automática não prova conformidade integral.

Audita MT é uma ferramenta independente, sem vínculo institucional. O relatório apoia a análise técnica, mas não equivale a certificação nem a laudo oficial.

Antes de usar o material em uma fiscalização, confira a URL, a data, o viewport quando disponível, os avisos de cobertura, as evidências e cada decisão de revisão. Identifique a pessoa avaliadora e descreva o contexto necessário. “Pular revisão” mantém o caso indeterminado.

## Arquivos gerados

- HTML: leitura acessível e autocontida do relatório.
- JSON: registro técnico com resultados EARL, o modelo auditado e a declaração de independência da ferramenta.
- PDF: impressão local do mesmo HTML. Navegadores que não aceitam parâmetros experimentais podem gerar PDF sem marcação estrutural adicional; a limitação é registrada. Se a impressão falhar, HTML e JSON continuam disponíveis.

O modelo e os arquivos registram o estado conhecido quando os artefatos são preparados, inclusive limitações de impressão e eventual fallback do PDF. A conclusão posterior de cada download fica em um recibo local separado no estado da extensão; esse recibo não é retroativamente inserido em um arquivo que já foi baixado. Assim, “artefato preparado” e “download concluído” são afirmações distintas.

Os hashes SHA-256 ajudam a comparar bytes e manifestos, mas não são assinatura digital, carimbo de tempo certificado ou ata notarial. Os horários dependem do dispositivo.

## Privacidade e permissões

O processamento local não transmite o conteúdo coletado. URLs sensíveis são saneadas antes do armazenamento e da apresentação. Evidências grandes ficam no IndexedDB; Blob URLs temporárias são usadas somente durante impressão e download e depois revogadas.

As permissões `debugger`, `downloads`, `tabs`, `scripting`, `activeTab` e `storage` são necessárias para coleta, impressão, download e persistência local. Instale como extensão não empacotada com **Carregar sem compactação** apenas em ambiente controlado e remova quando não for mais necessária.

## Limitações operacionais

Páginas adicionais, fluxos autenticados, estados não visitados, conteúdo que muda com o tempo e equivalência de mídia podem exigir amostragem e revisão externas. Frames de terceiros, canvas, vídeo e restrições do navegador podem limitar evidências. Auditorias `partial`, `failed` ou `cancelled` não devem ser apresentadas como completas.

O E2E em Chromium real e a QA visual estão pendentes e não foram executados nesta entrega. A instalação, a geração dos três formatos e a impressão devem ser repetidas no ambiente fiscal antes do uso oficial.
