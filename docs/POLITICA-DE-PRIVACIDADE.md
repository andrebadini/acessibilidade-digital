# Política de Privacidade — Audita Acessibilidade

Versão 1.2, atualizada em 28 de agosto de 2026.

## 1. Finalidade

Audita Acessibilidade é uma extensão independente que audita localmente a acessibilidade de uma página web indicada pelo usuário. A extensão coleta evidências técnicas, executa verificações automatizadas e assistidas e gera relatórios para revisão humana.

O resultado cobre apenas a página e o estado observados. Ele não constitui certificação de conformidade de um site inteiro.

## 2. Dados tratados

Durante uma auditoria, a extensão pode tratar:

- URL solicitada e URL final da página;
- data, hora, versão do navegador e dimensões do viewport;
- estrutura DOM, árvore de acessibilidade, estilos computados e propriedades necessárias às regras;
- seletores, trechos de HTML sanitizados e URLs de mídia sanitizadas;
- capturas da página inteira e de elementos relacionados a ocorrências;
- nomes acessíveis, funções, estados e prévias explicativas do anúncio esperado por tecnologia assistiva;
- respostas de revisão, notas, data da decisão e nome informado pelo avaliador.

Esse tratamento inclui dados de navegação (a URL escolhida e os horários da auditoria) e conteúdo do site (texto, estrutura, imagens, mídia e demais recursos da página auditada). Esses dados são processados e armazenados localmente mesmo quando não são transmitidos a terceiros.

As capturas podem conter dados pessoais ou sigilosos que estejam visíveis na página. Por isso, o usuário deve ocultar ou remover informações sensíveis antes de iniciar a auditoria.

## 3. Processamento local e transmissão

O processamento da auditoria ocorre no dispositivo do usuário. Audita Acessibilidade não possui servidor próprio, não executa código remoto e não envia o conteúdo coletado para o desenvolvedor ou para serviços de análise, publicidade ou comercialização de dados.

Ao abrir a URL indicada, o navegador se comunica normalmente com o site auditado e com os recursos que esse site carregar. Essas comunicações são determinadas pelo próprio site e estão sujeitas às políticas dele, não à Audita Acessibilidade.

## 4. Armazenamento e retenção

O andamento, o modelo da auditoria, as evidências — inclusive pixels de capturas — e as decisões de revisão ficam no armazenamento local do perfil do navegador. A URL armazenada é sanitizada, mas ainda pode identificar a página ou conter dados pessoais que não tenham sido reconhecidos automaticamente. Os relatórios HTML, JSON-LD/EARL, CSV e PDF são salvos na pasta de downloads escolhida pelo navegador.

Cada auditoria local permanece por, no máximo, 30 dias absolutos contados da primeira persistência. Revisar ou exportar novamente não reinicia nem prolonga esse prazo. Ao abrir o painel, a extensão procura auditorias vencidas e faz uma limpeza local incremental; uma exportação ou entrega ativa pode adiar a exclusão daquele registro, sem estender o vencimento.

Antes de iniciar, o usuário pode escolher excluir a auditoria local depois da exportação. Essa exclusão ocorre somente se os quatro arquivos — HTML, JSON-LD/EARL, CSV e PDF — tiverem sido baixados com sucesso. Download incompleto, interrompido ou com falha preserva a auditoria local para permitir nova tentativa.

Os arquivos já baixados ficam fora do armazenamento interno da extensão. A limpeza por prazo, a exclusão de uma auditoria, a exclusão de todas e a opção após exportar não apagam esses arquivos da pasta de downloads; eles permanecem no sistema de arquivos até serem excluídos pelo usuário.

## 5. Uso e compartilhamento

Os dados são usados somente para:

- executar a auditoria solicitada;
- produzir evidências e resultados reproduzíveis;
- permitir revisão humana de itens não automatizáveis;
- gerar e baixar os relatórios.

Audita Acessibilidade não vende, aluga ou compartilha esses dados com terceiros. Os dados não são usados para publicidade, perfil comportamental, avaliação de crédito ou qualquer finalidade incompatível com a auditoria de acessibilidade.

O usuário controla o compartilhamento posterior dos relatórios que baixar.

## 6. Permissões do navegador

- `tabs`: cria, acompanha e fecha as abas descartáveis de auditoria e impressão.
- `scripting`: executa somente os coletores e testes locais incluídos na extensão.
- `debugger`: usa o Chrome DevTools Protocol para ler a estrutura técnica, obter a árvore de acessibilidade, capturar evidências e gerar PDF.
- `downloads`: salva os relatórios solicitados pelo usuário.
- `storage`: mantém localmente o andamento, os resultados e as decisões de revisão.
- acesso a endereços HTTP e HTTPS: permite auditar a URL informada pelo usuário.

As permissões são usadas exclusivamente para a finalidade única descrita nesta política.

## 7. Segurança e integridade

A extensão aplica sanitização a URLs e trechos de código, omite valores atuais de campos editáveis e usa hashes SHA-256 para permitir a verificação de integridade dos artefatos. Capturas originais são preservadas separadamente das molduras de destaque apresentadas no relatório.

Nenhum mecanismo elimina o risco de uma informação sensível já visível aparecer em uma captura. A preparação da página antes da auditoria continua necessária.

## 8. Controle do usuário

O usuário pode:

- deixar de iniciar ou cancelar uma auditoria;
- ocultar dados antes da captura;
- revisar cada ocorrência que dependa de julgamento humano;
- excluir uma auditoria e todas as evidências, pixels e revisões locais pela respectiva página de revisão;
- excluir todas as auditorias locais pelo painel, sempre após confirmação;
- escolher, antes de iniciar, a exclusão local condicionada ao download bem-sucedido dos quatro formatos;
- excluir relatórios baixados;
- apagar os dados locais removendo a extensão ou limpando seus dados no Chrome.

Essas ações destrutivas não apagam arquivos que já estejam na pasta de downloads.

## 9. Alterações

Alterações materiais desta política serão acompanhadas de nova data e versão. A versão aplicável deve permanecer disponível junto ao canal público de distribuição da extensão.

## 10. Contato

Solicitações sobre privacidade, suporte ou exclusão de dados podem ser enviadas pelo canal público de contato informado junto ao pacote ou à página de distribuição da Audita Acessibilidade.
