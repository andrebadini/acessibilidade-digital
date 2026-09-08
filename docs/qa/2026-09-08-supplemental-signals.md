# Sinais suplementares separados do checklist

## Correção

Um resultado persistido do axe-core com tipo original `violations` ou `incomplete`, mantido como `cantTell`, representa um sinal do motor ainda não confirmado. Não deve ser confundido com perguntas gerais sem sinal observado. O classificador compartilhado agora encaminha esses registros para revisão humana, mesmo quando a correlação do elemento está indisponível.

O texto no panorama e no relatório explica essa limitação. Não altera resultado armazenado, equivalência normativa, nota do motor próprio, evidências, permissões, decisões humanas ou autorização para destacar elementos. Os resultados são agrupados por página, motor e regra; registros sem alvo não equivalem a elementos distintos comprovados.

## Verificação

- RED: novo teste no classificador falhou com `checklist` em vez de `suspected`.
- GREEN: testes focados finding-kind, results-overview, panel-summary, panel-detail, normative-presentation, report-view e html, exit 0.
- Revisão independente C=0/I=0/M=0, 102/102 testes focados em seis arquivos; rastreou painel, relatório, referência legal, agrupamento e guardas do destaque.
- Reapresentação, sem nova coleta, do JSON validado de Google 1.1.9: seis registros suplementares passam a três verificações agrupadas de revisão humana (contraste, alternativa de imagem, ARIA); checklist passa de 106 a 103 grupos; uma recomendação de contraste aprimorado permanece. O modelo original não foi modificado. Não há comprovação de seis barreiras nem de seis elementos diferentes.
- `git diff --check` aprovado.

## Limites

Ainda é necessário investigar os seletores indisponíveis e melhorar a correlação/evidência individual onde possível, com RED de reprodução. Esta alteração não resolve ou oculta essa limitação. A beta 1.1.9 já distribuída permanece imutável; falta candidato integrado e novo pacote para distribuir a mudança.
