# Audita Acessibilidade 1.1.14 — entrega de produção

Runtime congelado e revisado: `607fc02003d569161603ec1ad5679858c5e0739b`. Esta entrega substitui o estado de candidata, não os pacotes ou registros históricos. Distribuição local instalável; não houve publicação em loja, login ou alteração da instalação pessoal do Chrome.

## Alterações e revisão

- Versão de origem visível na metodologia do relatório vivo, HTML e impressão/PDF. Usa o valor armazenado na auditoria, inclusive valores antigos ou desconhecidos, sem alterar evidência/hash. RED 2 casos; GREEN 94/94.
- Retomada de lote preserva o `AbortSignal` vivo em vez de congelá-lo recursivamente. Os outros dados permanecem congelados. RED reproduzido em Node 26.5.0 e 24.19.0; GREEN 91/91 relacionados.
- Duas revisões independentes do mesmo SHA final: **C=0/I=0**, cada uma com um achado documental menor (README e instruções de teste ainda usavam linguagem de beta). Ambos corrigidos somente na documentação; release-assets 6/6. A apresentação e o pacote permanecem nos bytes do SHA revisado.
- Revisão adicional anterior de `81e56db`: C=0/I=0/M=0, 74 testes focados. Não é usada como substituto das revisões finais.

## Gates e limitações da prova

Diretório dos logs: `/tmp/audita-production1114-d3Cxqz/`.

1. Chrome for Testing **152.0.7977.64** confirmado antes da execução, com perfil exclusivo e keychain de teste.
2. Metadados/pacote focados: **17/17**, `/tmp/audita-1114-metadata-focused.log`.
3. `npm test` inicial: **4.047/4.048 lógicos**, uma falha na retomada do lote, `npm-test.log`. A etapa nativa não iniciou nessa execução. Depois da correção, **91/91 relacionados**, `batch-green.log`. Não reclassificar a execução original como totalmente verde; não repetida a suíte ampla por essa correção localizada.
4. Etapa nativa completa, 12 arquivos em ordem serial: primeira execução **30 aprovados/5 recusados**, `native.log`. As cinco recusas foram `UNSAFE_LAUNCH_DIRECTORY`, antes da criação dos navegadores desses casos: o diretório externo preparado pelo coordenador não atendia ao caminho canônico/prefixo exigido pelo controlador. Os testes que não usavam esse diretório passaram.
5. Repetidos somente os cinco casos recusados, com diretório canônico sob o temporário do sistema e prefixo `audita-marco-1-`: **9/9**, incluindo os subtestes que não haviam iniciado. Log `native-corrected-environment.log`. Resultado agregado do plano nativo: **39 casos aprovados**, sem pendência funcional conhecida. Não afirmar que a primeira execução foi verde.
6. `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify` passou; repetido após a correção de runtime para conferir o candidato final, `verify-final.log`. `git diff --check` passou.

O percurso nativo inclui painel, progresso, página atual sem modificar a original, A→B/nova avaliação, consentimento por página, retomada após reinício, sinais/destaque, revisão humana, personas, URL/lote, quatro downloads e limpeza. As duas capturas auxiliares de UI após reinício atingiram timeout, como na versão anterior: `PANEL_SCREENSHOT_CDP_TIMEOUT` e `REPORT_SCREENSHOT_CDP_TIMEOUT`. Não foram aceitas como imagens produzidas. O cenário confirmou relatório, evidências, downloads e limpeza; outras capturas reais foram inspecionadas. É uma limitação do registro visual daquele cenário, não uma dispensa dos testes funcionais.

QA visual em `/private/var/folders/3b/dv2ydqf51zq_qdv0gp1xmzzr0000gn/T/audita-marco-1-production1114-EVeAdU/qa/`: sumário legível no painel estreito, legenda da persona, mapa com números e legenda, e moldura vermelha na página original. PDFs da fixture em `/tmp/audita-production1114-d3Cxqz/print/`: HTML baixado completo 22 páginas/resumo 9; relatório vivo completo 34/resumo 10. A versão histórica 0.1.0 aparece nos quatro PDFs, sem relabelar a fixture; página 21 do completo baixado foi renderizada e inspecionada.

## Pacote

Gerado uma vez com `npm run build:release`; `unzip -t` aprovado. **198/198 entradas** comparadas byte a byte com `607fc02` e com a pasta entregue. Sem extras, duplicatas ou node_modules. Uma primeira comparação auxiliar incluiu equivocadamente os dois arquivos-fonte de ícones não distribuídos; a lista foi corrigida para os quatro tamanhos de runtime explicitamente empacotados, sem alterar ou reconstruir o ZIP.

SHA-256: `ec7d309acd2f72322c20f10ccd2b000b6b2afc08675a9b3f2097f20a422ebdce`.

Entregas em `/Volumes/SSD1/acessibilidade-digital/entregas/`:

- `audita-acessibilidade-1.1.14.zip`;
- `audita-acessibilidade-1.1.14/`, pasta descompactada;
- `COMO-USAR-1.1.14.md`;
- `teste-google-com-1.1.14/`, quatro relatórios desta versão.

As cópias foram feitas com recusa de sobrescrita. Pacotes anteriores preservados. Código mantido na branch/worktree existente, sem merge, push ou exclusão de arquivos do usuário.

## Google — execução da versão entregue

Controlador `/private/tmp/audita-google-production1114.mjs`, log `google.log`: SHA e 198 arquivos do pacote conferidos antes do lançamento. O runtime carregado é idêntico ao ZIP, acrescido do harness de teste; não se alega instalação manual do ZIP sem harness. Primeira tentativa desta versão passou, exit 0.

Página `https://www.google.com/`, perfil isolado sem login, evidência completa. Observação **12/09/2026 12:12:47.752Z–12:12:49.475Z** (08:12 em Cuiabá); quatro downloads concluídos às 12:12:54.008Z.

| Resultado | Coleta 1.1.14 |
| --- | --- |
| Falhas de requisitos confirmadas | 0 |
| Recomendação não atendida | 1 — contraste aprimorado, ABNT 5.11.2 |
| Verificações com suspeitas concretas | 2, com 3 ocorrências: ARIA (1) e contraste (2) |
| Resultados positivos | 11 verificações |
| Checklist geral, fora dos achados | 97 verificações ainda sem conclusão |
| Cobertura automática | 37,7%, inventário do motor próprio |
| Índice técnico | 9,2/10 — 11/12 verificações aplicáveis concluídas do motor próprio |
| PDF de leitura | **24 páginas** |

Os três sinais suplementares têm alvo e captura de elemento correlacionados; dois têm anúncio estimado não vazio. JSON identifica **1.1.14**, assim como o HTML e o texto extraído do PDF. Páginas 1, 3 e 21 do PDF foram renderizadas e inspecionadas: sumário, recomendação com captura e versão produtora. O relatório vivo foi aberto e seu gráfico/metodologia examinados.

Viewport registrado 1399 × 856, escala 1. A versão do navegador não pôde ser lida pelo coletor e permanece `não disponível` no modelo; não foi preenchida a partir do controlador. Resultado parcial explicitamente limitado, incluindo cópia recarregada e observação estrutural incompleta. Não certifica conformidade integral ou autoriza sanção automaticamente.

AMAWeb continua sendo o PDF fornecido de **06/09**, não nova execução: 5 erros, 3 revisões, 21 aceitos, nota 8,0 e 13 páginas. O teste atual usa 1.1.14; datas, DOM e inventários diferem. A diferença de contagem não demonstra superioridade e o índice próprio não é a nota AMAWeb. As divergências por critério estão no registro `2026-09-08-google-amaweb-comparison.md`. A causa do erro CDP isolado de 1.1.12 permanece desconhecida; esta execução não o explica retrospectivamente e não o reproduziu.

### Integridade dos relatórios entregues

| Arquivo | SHA-256 |
| --- | --- |
| google-com-1.1.14.html | bfc7f1a272a2f58bc83a24e16f737e0d4b74733f1f96fe1d6ef35c88a3277c6a |
| google-com-1.1.14.pdf | 88fbc02b0c381f3669bf4289724752dd0bc93db0aaa4968ee9ab1d91c52f16c6 |
| google-com-1.1.14.csv | d54847b7d6f93f7f933c80571e7a8df221e83c3e3527e49f7d0e66f85ac5c43b |
| google-com-1.1.14.json | 82adc538a1cfd4082356abafbb187a7b83978610aee6a29e48ded3e909f5dfad |

## Encerramento e continuidade

Aceitação de produção concluída para a distribuição local no Chrome validado, com limites técnicos explícitos e sem achado crítico/importante conhecido nas revisões e testes descritos. O refinamento visual/didático incremental permanece em `BETA-BACKLOG.md`, como histórico de melhorias, sem converter checklist geral em problemas ou prometer automação de julgamento humano. A publicação em loja não faz parte desta entrega.
