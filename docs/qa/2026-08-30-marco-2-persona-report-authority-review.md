# Revisão crítica — personas e autoridade do relatório

- Data: 2026-08-30
- Escopo: coordenação de personas, limpeza e recuperação, decisão de revisão humana, autorização do relatório e resistência a relógio regressivo e transplante de registros.
- Resultado final: **GO**.
- Achados remanescentes: **0 Critical / 0 Important / 0 Minor**.

## Achados corrigidos durante a revisão

1. Uma lease de persona podia permanecer dona do alvo depois do desaparecimento autônomo do runtime. A reconciliação agora revoga o dono obsoleto antes de instalar uma nova lease.
2. A lane privilegiada legada ainda podia aceitar mensagens diretas. O protocolo e seus testes foram removidos; o único caminho é a autoridade autenticada do painel.
3. A interface registrava uma decisão humana antes de comprovar a autoridade. Agora envia `REPORT_COMMIT_REVIEW_DECISION`; o worker autoriza primeiro, aplica CAS com retry e devolve um recibo fechado.
4. Registros de lançamento do relatório podiam ser aceitos após regressão do relógio. Emissão futura, instante exato da expiração, transplante e relógio regressivo agora falham fechados.

## Evidências verificadas

- Autorizações negadas não alteram IndexedDB nem exibem confirmação de salvamento.
- O commit autorizado faz uma única mutação efetiva, relê revisão, hash e decisão persistidos e devolve apenas o recibo esperado.
- A interface relê o relatório e valida recibo, revisão, hash, auditoria e decisão antes de publicar sucesso.
- A autoridade correlaciona capability, auditoria, lançamento, aba, janela, documento, emissão, expiração, estado e intent.
- Conectar, validar, exportar, decidir revisão e excluir um ou todos os relatórios utilizam a mesma prova correlacionada.

## Verificação independente

- 175 testes focados aprovados, sem falha ou teste ignorado.
- Cobertura de ataque: relógio regressivo, emissão futura, limite exato de expiração, transplante de auditoria, divergência de capability/aba/janela/documento, revogação, recibo forjado e releitura divergente.
- Uma segunda revisão do patch corretivo aprovou 195 testes e confirmou zero mutação sob negação.
- `git diff --check` aprovado.

## Decisão

O conjunto revisado satisfaz o gate crítico desta etapa. Não restam achados Critical, Important ou Minor no escopo.
