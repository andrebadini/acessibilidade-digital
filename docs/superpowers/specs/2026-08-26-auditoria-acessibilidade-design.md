# Audita MT — especificação de desenho

Data: 26 de agosto de 2026  
Público principal: fiscais do PROCON-MT sem formação técnica  
Ambiente-alvo: Chrome e Microsoft Edge baseados em Chromium  
Base normativa: WCAG 2.2 e ABNT NBR 17225:2025

## 1. Objetivo e limites da alegação

Audita MT será uma extensão Manifest V3, feita somente com HTML, CSS e JavaScript empacotados. O fiscal informará uma URL e receberá uma auditoria local, acompanhada de evidências reproduzíveis e relatórios HTML e PDF.

O produto buscará automaticamente todas as falhas que possam ser determinadas com segurança a partir do DOM, CSS calculado, árvore de acessibilidade, comportamento observado e pixels renderizados. Ele não apresentará ausência de falhas automáticas como prova de conformidade integral. Cada verificação terá um destes resultados:

- `reprovado`: a evidência observada satisfaz uma condição conclusiva de falha;
- `aprovado`: todos os alvos aplicáveis passaram em uma verificação objetiva e completa;
- `revisar`: houve coleta automática, mas o resultado depende de finalidade, equivalência, qualidade ou outro juízo humano;
- `não aplicável`: nenhum alvo corresponde à aplicabilidade da verificação;
- `não testado`: uma limitação técnica impediu a execução.

O relatório distinguirá “auditoria automatizada da página/estado observado” de “declaração de conformidade do site”. A segunda só é possível após avaliar páginas completas, processos completos, tecnologias suportadas e não interferência, conforme a WCAG 2.2 e a WCAG-EM.

## 2. Decisão arquitetural

### 2.1 Abordagens consideradas

1. **Extensão Chromium com Chrome DevTools Protocol — escolhida.** A extensão usa `chrome.debugger` durante uma auditoria iniciada pelo fiscal. Isso permite obter DOM achatado, Shadow DOM, iframes, árvore de acessibilidade, estilos, capturas e PDF com maior fidelidade.
2. **Extensão somente com `activeTab` e content script.** Tem permissão menos sensível, mas não cobre adequadamente Shadow DOM fechado, árvore de acessibilidade real, iframes restritos, captura integral confiável e PDF automático.
3. **Página estática ou bookmarklet.** Não atende ao objetivo, pois a política de mesma origem e as APIs comuns do navegador impedem ler e capturar URLs arbitrárias.

### 2.2 Componentes

- **Service worker:** controla abas, navegação, sessão CDP, progresso, cancelamento, falhas e downloads.
- **Painel de auditoria:** página da extensão com um campo de URL, botão principal, progresso em linguagem simples e acesso ao relatório.
- **Coletor CDP:** captura DOMSnapshot, árvore AX, métricas, eventos de rede, console, estilos relevantes, screenshots e snapshot MHTML quando disponível.
- **Motor de regras:** executa verificações atômicas e compostas, sem biblioteca externa, sobre um modelo normalizado da página.
- **Motor de nome acessível:** prioriza o nome, descrição, função, valor e estados calculados pelo Chromium; usa cálculo DOM próprio como fallback e registra o método.
- **Coletor de evidências:** produz seletor CSS estável, caminho de frames, trecho HTML sanitizado, estilos relevantes, retângulo, miniatura, URL e hashes.
- **Base normativa:** contém os 146 itens da NBR 17225 com código, título, classificação, critérios WCAG, nível oficial e observações editoriais.
- **Gerador de relatório:** cria um HTML autocontido, um PDF e um JSON técnico compatível conceitualmente com EARL.

Cada unidade terá interface explícita e poderá ser testada isoladamente. Nenhum módulo de regra conhecerá APIs de UI ou de download.

## 3. Fluxo da auditoria

1. O fiscal abre o painel, informa uma URL HTTP/HTTPS e seleciona “Auditar”.
2. A extensão valida e normaliza a URL, cria uma aba dedicada e registra o instante inicial em ISO 8601, fuso local, versão do navegador e versão das regras.
3. O service worker navega até o endereço, registra URL final e erros, espera `DOMContentLoaded`, `load` e um intervalo curto de estabilidade. A auditoria continua com aviso se a página nunca ficar estável.
4. O coletor anexa o CDP, obtém o estado original e gera uma captura integral sem marcações.
5. O motor constrói índices de DOM, frames, nós AX, elementos focáveis, recursos multimídia, textos, controles, landmarks e estilos.
6. As regras automáticas são executadas sem alterar o conteúdo. Testes de interação usam uma aba descartável e registram cada ação.
7. Para cada falha ou candidato manual, o coletor gera evidências específicas. Imagens e vídeos recebem miniatura por captura de pixels; a URL da mídia é incluída quando disponível.
8. Todos os 146 itens recebem um resultado agregado e uma justificativa. Itens manuais mostram os candidatos coletados e a razão objetiva pela qual o juízo humano é necessário.
9. O modelo canônico da auditoria é serializado de forma determinística e recebe SHA-256. Evidências binárias também recebem hash.
10. A extensão gera e baixa o HTML, o PDF e o JSON técnico. A aba auditada pode ser fechada sem afetar os arquivos.

Cancelamento, perda da aba ou falha do CDP encerram a sessão de modo seguro e produzem relatório parcial claramente marcado.

## 4. Modelo normativo

A Seção 5 da ABNT NBR 17225:2025 é a fonte primária para o mapeamento, pois contém as diretrizes; o Anexo C é informativo. A base não reproduzirá extensamente o texto protegido da norma. Ela armazenará códigos, títulos, classificação, referências WCAG e resumos autorais necessários à explicação.

O banco contém 146 itens: 96 requisitos e 50 recomendações. Para cada item serão mantidos:

- identificador ABNT normalizado;
- identificador e redação impressos quando houver divergência;
- título;
- `requisito` ou `recomendação`;
- critérios WCAG relacionados e níveis oficiais;
- tipo de avaliação (`automática`, `semiautomática` ou `manual`);
- IDs das regras que produzem evidência;
- razão objetiva da limitação humana;
- referência à edição da norma e à fonte W3C.

Inconsistências editoriais confirmadas serão mostradas em nota de integridade normativa:

- o Anexo C imprime `5.1.12` para “Espaçamento entre as linhas”; a referência lógica e usada na Seção 5 é `5.12.1`;
- no item 5.9.1, a Seção 5 relaciona WCAG 3.3.2, enquanto o Anexo C imprime 3.2.2;
- no item 5.9.2, a Seção 5 relaciona WCAG 1.3.2, enquanto o Anexo C imprime 1.3.1;
- o item 5.9.4 imprime WCAG 2.4.6 como nível A, embora a WCAG 2.2 oficial classifique o critério como AA;
- a nota do item 5.9.17 no Anexo C aponta para o inexistente 5.8.18; a referência coerente é 5.9.18.

O relatório preservará a informação impressa e mostrará separadamente a normalização adotada, sem atribuir à ABNT uma errata que não foi localizada.

## 5. Cobertura de regras

### 5.1 Automação conclusiva

As regras conclusivas cobrirão, quando os insumos forem observáveis, presença e validade de nomes, atributos e relações; semântica nativa e ARIA; IDs e IDREFs; idioma; título; zoom; estrutura de listas, tabelas, headings e landmarks; ordem DOM e foco; armadilhas simples de teclado; foco visível e obscurecido; tamanho de alvos; contraste de texto e componentes; reflow e redimensionamento; texto visível no nome; frames; controles de mídia; autoplay; animação CSS; limites de flash mensuráveis; formulários; status e estados ARIA.

Uma regra automática somente marcará `aprovado` quando sua aplicabilidade e expectativas forem integralmente avaliadas. Do contrário, ela produzirá `revisar`.

### 5.2 Revisão assistida

O sistema coletará candidatos e evidências para qualidade de texto alternativo, finalidade de imagens e controles, equivalência de legendas/transcrições/audiodescrição, linguagem simples, instruções sensoriais, significado da sequência, consistência entre páginas, prevenção de erro, autenticação, gestos, movimento, tempo, interrupções e processos completos.

O fiscal verá uma pergunta simples e específica, por exemplo: “O texto alternativo transmite a mesma informação visível nesta imagem?”. A resposta humana será registrada com nome do avaliador, instante e observação opcional.

### 5.3 Não automatizável no estado observado

Quando o item depender de páginas não visitadas, autenticação não fornecida, conteúdo ao vivo, tarefa de negócio, conhecimento contextual ou comparação com experiência real de tecnologia assistiva, o relatório explicará exatamente a dependência. A evidência disponível ainda será anexada.

## 6. Nome acessível e prévia de anúncio

Para cada elemento relevante, o relatório mostrará:

- nome acessível;
- origem do nome (`aria-labelledby`, `aria-label`, `label`, `alt`, conteúdo, `title` ou árvore AX);
- descrição acessível e origem;
- função;
- valor, estado e propriedades;
- texto visível;
- prévia textual do anúncio.

A prévia combinará nome, função, descrição, valor e estados em uma ordem documentada. Ela será rotulada “prévia de anúncio”, nunca como transcrição literal de NVDA, JAWS, VoiceOver ou TalkBack. O relatório explicará que navegador, API de plataforma, leitor, modo e preferências podem alterar a locução real.

## 7. Evidência e cadeia de custódia

Cada ocorrência terá:

- ID estável da auditoria e da ocorrência;
- URL solicitada e URL final;
- carimbos de início, coleta e geração;
- versão da extensão, regras, navegador, sistema informado pelo agente e viewport;
- item ABNT, critério WCAG, nível e regra aplicada;
- resultado, impacto, confiança e modo de teste;
- seletor CSS, caminho de frames e backend node ID quando disponível;
- trecho HTML escapado e limitado, com opção de expandir;
- propriedades AX e estilos relevantes;
- captura do elemento e referência à captura integral original;
- miniatura e URL para imagem, áudio ou vídeo;
- passos de reprodução;
- razão para revisão humana ou limitação técnica;
- SHA-256 do modelo canônico e dos binários.

O horário será identificado como relógio local do dispositivo, não como carimbo de tempo certificado por autoridade externa. Os hashes comprovam integridade entre artefatos, mas não substituem assinatura digital ou ata notarial. Essa distinção constará da metodologia.

Dados de formulário potencialmente sensíveis serão mascarados por padrão no HTML e nas capturas anotadas; a captura integral original será incluída somente após aviso claro no início da auditoria.

## 8. Relatórios

### 8.1 HTML

O HTML será autocontido, navegável por teclado, responsivo e imprimível. Terá capa, sumário executivo, escopo, metodologia, resultados por severidade e tema, lista dos 146 itens, ocorrências, evidências, revisão humana, limitações, fundamentação normativa e manifesto de integridade.

Filtros e expansões funcionarão sem rede. Imagens serão embutidas como data URLs e compartilhadas por referência para evitar duplicação. O documento continuará legível quando JavaScript estiver desativado.

### 8.2 PDF

O PDF será produzido automaticamente do mesmo relatório, com plano de fundo, cabeçalhos, rodapés, numeração, links, sumário e quebras controladas. Quando a API permitir, será solicitado PDF marcado e outline. O produto verificará que o arquivo retornado começa com a assinatura `%PDF-` e registrará seu hash.

### 8.3 JSON técnico

O JSON conterá o modelo canônico completo e asserções compatíveis com os conceitos EARL (`automatic`, `semiAuto`, `manual`, `passed`, `failed`, `cantTell`, `inapplicable`, `untested`). Ele permitirá comparação entre auditorias e verificação independente dos hashes.

## 9. Interface e identidade visual

O painel terá uma única ação principal. A linguagem será direta: “Endereço do site”, “Auditar”, “Preparando evidências”, “Relatório pronto”. Detalhes técnicos ficarão progressivamente revelados.

O relatório usará a marca do Governo de Mato Grosso na capa e no cabeçalho, acompanhada da identificação textual “PROCON-MT — Secretaria Adjunta de Proteção e Defesa dos Direitos do Consumidor”. A marca será empacotada localmente, sem deformação, sobre fundo de contraste adequado, com texto alternativo “Governo de Mato Grosso”. A proveniência e o hash do arquivo serão registrados nos metadados do projeto.

Fonte institucional selecionada: ativo exibido em domínio oficial do Governo de Mato Grosso, validado contra a página da SECOM-MT antes do empacotamento. Nenhuma imagem gerada por IA será usada para representar a marca.

A paleta do produto usará azul institucional, branco, cinzas neutros e cores semânticas que não dependam apenas de cor. O próprio painel e os relatórios deverão atender WCAG 2.2 AA.

## 10. Segurança, privacidade e permissões

- A extensão não envia URLs, DOM, capturas ou relatórios para servidores.
- Todo código executável é empacotado, conforme Manifest V3.
- `debugger` é usado somente durante auditoria iniciada pelo usuário e sempre desconectado ao final.
- `activeTab`, `scripting`, `tabs`, `downloads`, `storage` e permissões de host são limitadas ao necessário.
- Preferências ficam em armazenamento local; evidências grandes permanecem em memória/IndexedDB apenas durante a sessão, com limpeza após download.
- Campos de senha, tokens, cookies e cabeçalhos de autenticação nunca são serializados.
- URLs `chrome:`, lojas de extensões, páginas protegidas pelo navegador, PDFs nativos e conteúdo DRM são marcados como limitação, não como aprovação.

## 11. Tratamento de erros

Falhas terão códigos estáveis e mensagens para leigos. A sessão possui estados explícitos: `idle`, `navigating`, `collecting`, `testing`, `capturing`, `reporting`, `complete`, `partial`, `failed`, `cancelled`.

O sistema sempre tenta desconectar o debugger, remover alterações temporárias e liberar recursos. Uma falha de captura específica não elimina os demais achados; a ocorrência recebe evidência ausente e justificativa. Se a coleta estrutural falhar, o relatório inteiro é marcado como parcial.

## 12. Estratégia de testes

- **Testes unitários:** URL, seletores, normalização DOM/AX, AccName fallback, contraste, tamanho, agregação, classificação, sanitização, serialização determinística e hash.
- **Fixtures de regra:** páginas mínimas com exemplos aprovado, reprovado e não aplicável; cada regra conclusiva terá ao menos os três estados quando pertinentes.
- **Testes de contrato normativo:** 146 IDs únicos, 96 requisitos, 50 recomendações, critérios existentes, níveis oficiais e divergências editoriais esperadas.
- **Integração Chromium:** extensão carregada sem erros; auditoria de fixtures com iframe, Shadow DOM, CSS, mídia e interação; geração e abertura de HTML/PDF/JSON.
- **Testes de relatório:** estrutura acessível, todos os achados presentes, imagens embutidas, hashes consistentes, PDF válido e ausência de segredos.
- **QA visual:** painel em estados vazio/em execução/concluído/erro e páginas representativas do relatório em viewport desktop, tablet e impressão A4.
- **Autoteste:** a própria extensão será auditada pelo motor antes da entrega.

Implementação de funcionalidade seguirá TDD: primeiro teste falhando, depois código mínimo, seguida de refatoração.

## 13. Critérios de aceitação

1. Instalação local no Chrome/Edge sem dependências ou build obrigatório.
2. URL arbitrária HTTP/HTTPS auditada a partir do painel.
3. Todos os 146 itens ABNT aparecem no resultado com status e justificativa.
4. Regras automáticas coletam todas as ocorrências que seus predicados identificam, sem limite silencioso.
5. Cada falha tem a evidência exigida ou uma justificativa explícita de impossibilidade.
6. Nome, descrição, função, estados e prévia de anúncio aparecem para elementos relevantes.
7. Captura integral e capturas de elemento são geradas e deduplicadas.
8. Imagem/vídeo recebe miniatura ou mídia quando tecnicamente acessível.
9. HTML, PDF e JSON são gerados localmente e têm hashes verificáveis.
10. Itens manuais exibem razão objetiva e evidência assistida.
11. Relatório inclui capa, sumário, metodologia, achados, evidências, fundamentação, limitações e integridade.
12. Logo do Governo de Mato Grosso está empacotada e aplicada de modo acessível no relatório do PROCON-MT.
13. Testes unitários, normativos, de integração e de relatório passam.
14. Nenhuma alegação excede o escopo realmente avaliado.

## 14. Fora do escopo inicial

- publicação em lojas de extensões;
- serviço remoto ou armazenamento em nuvem;
- assinatura digital ICP-Brasil ou carimbo de tempo certificado;
- rastreamento autônomo de um site inteiro sem definição de escopo;
- substituição de teste real com pessoas ou tecnologias assistivas;
- correção automática do site auditado.

Esses itens podem ser adicionados posteriormente sem alterar o modelo de regras e evidências.

