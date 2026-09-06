import { NBR17225_ITEMS } from '../normative/nbr17225.js';

// Explanations are presentation aids, never additional checks or normative mappings.
const ITEMS = new Map(NBR17225_ITEMS.map(item => [item.id, item]));
const PROFILES = {
  generic: {
    impact: 'Uma barreira neste ponto pode dificultar o uso por pessoas com deficiência. O efeito depende do conteúdo e da tarefa.',
    steps: ['Abra o trecho ou a etapa indicada na evidência e reproduza a tarefa da pessoa usuária.', 'Compare o comportamento com o item em análise e registre o que aconteceu, inclusive as limitações do teste.'],
    example: 'uma pessoa tenta concluir um serviço; a revisão registra a etapa, o resultado esperado e o que de fato aconteceu.'
  },
  '5.1': {
    impact: 'Pessoas que usam apenas teclado, inclusive pessoas com deficiência motora ou visual, precisam alcançar os controles e saber onde estão na página.',
    steps: ['Percorra os controles com Tab e Shift+Tab, observando onde está o foco (o elemento selecionado pelo teclado).', 'Experimente a ação relacionada ao item e confira se é possível continuar a tarefa e sair do controle pelo teclado.'],
    example: 'uma pessoa percorre um formulário pelo teclado e precisa reconhecer o campo selecionado antes de digitar.'
  },
  '5.2': {
    impact: 'Pessoas cegas que usam leitor de tela, programa que lê a interface em voz alta, dependem de alternativas para compreender a informação das imagens.',
    steps: ['Identifique se a imagem informa algo, executa uma ação ou apenas decora.', 'Compare a informação visual com o texto anunciado pelo leitor de tela, considerando a finalidade da imagem na página.'],
    example: 'uma fotografia que identifica um local recebe um texto alternativo que permite reconhecer esse local sem ver a foto.'
  },
  '5.3': {
    impact: 'Pessoas que navegam pelos títulos com leitor de tela precisam entender as seções e encontrar o assunto desejado.',
    steps: ['Compare os títulos visíveis com a lista de cabeçalhos anunciada pelo leitor de tela.', 'Leia a sequência e verifique o aspecto indicado pelo item: finalidade, organização ou identificação dos títulos.'],
    example: 'o título “Documentos necessários” ajuda a encontrar essa seção em uma página de serviço.'
  },
  '5.4': {
    impact: 'Pessoas que usam leitor de tela podem localizar o conteúdo mais facilmente quando as regiões da página são reconhecíveis.',
    steps: ['Use a navegação por regiões do leitor de tela e compare com as áreas visíveis da página.', 'Confira o aspecto indicado pelo item, como finalidade, identificação ou distinção entre regiões.'],
    example: 'a pessoa encontra a área principal de um serviço pela lista de regiões do leitor de tela.'
  },
  '5.5': {
    impact: 'Pessoas que usam leitor de tela precisam reconhecer quais informações fazem parte de uma lista.',
    steps: ['Localize o conjunto de itens indicado e ouça sua leitura.', 'Compare a organização visual com a lista reconhecida pelo leitor de tela e com a finalidade do conteúdo.'],
    example: 'uma relação de documentos é anunciada como lista, permitindo compreender que os documentos pertencem ao mesmo conjunto.'
  },
  '5.6': {
    impact: 'Pessoas que usam leitor de tela precisam entender a relação entre os dados de uma tabela, seus títulos e cabeçalhos.',
    steps: ['Navegue pelas células com um leitor de tela e compare cada informação com a apresentação visual.', 'Confira o aspecto do item em análise, como cabeçalhos, título ou explicação da tabela.'],
    example: 'ao ouvir um valor, a pessoa consegue identificar a qual serviço e período ele pertence.'
  },
  '5.7': {
    impact: 'Pessoas que usam leitor de tela ou têm dificuldade de compreensão precisam entender a navegação e prever para onde um link leva.',
    steps: ['Leia o link e seu contexto, acione-o e compare o destino com o que foi anunciado.', 'Quando o item envolver um conjunto de páginas, percorra essas páginas e compare a navegação entre elas.'],
    example: 'o link “Consultar andamento do pedido” permite antecipar a página de destino.'
  },
  '5.8': {
    impact: 'Pessoas com deficiência motora ou visual precisam identificar os controles e conseguir acioná-los de forma previsível.',
    steps: ['Localize o controle indicado, identifique sua ação e experimente seu acionamento.', 'Observe o aspecto indicado pelo item, como nome, área de acionamento, gesto ou mudança de contexto; registre o resultado.'],
    example: 'uma pessoa reconhece o botão “Buscar” e consegue acioná-lo para iniciar a pesquisa.'
  },
  '5.9': {
    impact: 'Pessoas que usam leitor de tela ou têm dificuldade de compreensão precisam saber o que preencher e como concluir o formulário.',
    steps: ['Percorra o formulário, leia ou ouça as instruções e realize a etapa relacionada ao item.', 'Confira o aspecto indicado, como rótulo, erro, ajuda ou autenticação; em processos com etapas, acompanhe o percurso completo.'],
    example: 'ao preencher um campo, a pessoa entende qual informação é solicitada e, se houver erro, como corrigi-lo.'
  },
  '5.10': {
    impact: 'Pessoas com baixa visão ou que usam uma apresentação diferente da página precisam compreender e alcançar o conteúdo.',
    steps: ['Observe a apresentação no estado indicado pela evidência.', 'Experimente a condição relacionada ao item, como orientação ou largura da tela, e confira se a informação continua compreensível.'],
    example: 'uma pessoa acessa um serviço em uma tela estreita e acompanha a sequência das informações.'
  },
  '5.11': {
    impact: 'Pessoas com baixa visão ou dificuldade para distinguir cores podem ter dificuldade para perceber textos, controles e informações visuais.',
    steps: ['Identifique o texto ou objeto e seu fundo no estado indicado pela evidência.', 'Meça o contraste com uma ferramenta apropriada e compare com o critério do item, considerando o tipo de elemento e as condições aplicáveis.'],
    example: 'um texto cinza muito claro sobre fundo branco pode ser difícil de ler; uma combinação mais contrastante pode facilitar a leitura.'
  },
  '5.12': {
    impact: 'Pessoas com baixa visão ou dificuldade de leitura podem precisar de ajustes na apresentação do texto ou de explicações para compreendê-lo.',
    steps: ['Localize o texto e identifique o aspecto em análise: apresentação, significado ou leitura.', 'Experimente o ajuste relacionado ao item ou leia o trecho no contexto; registre o que dificulta ou permite a compreensão.'],
    example: 'uma pessoa ajusta a apresentação de um texto para ler melhor ou consulta o significado de uma sigla.'
  },
  '5.13': {
    impact: 'Pessoas que usam leitor de tela, comandos de voz ou ampliação precisam reconhecer a página, os componentes e as informações que eles comunicam.',
    steps: ['Compare a informação visual do trecho com o que a tecnologia assistiva comunica.', 'Confira especificamente o aspecto indicado pelo item, como idioma, nome, ordem, estado ou possibilidade de ampliação.'],
    example: 'uma pessoa ouve o nome e o estado de um controle e entende como ele está configurado.'
  },
  '5.14': {
    impact: 'Pessoas surdas, com deficiência auditiva, cegas ou com baixa visão podem precisar de alternativas para compreender áudio e vídeo; a necessidade depende da mídia.',
    steps: ['Reproduza a mídia e identifique a alternativa ou o controle relacionado ao item.', 'Compare a alternativa com a informação original, inclusive falas e informações visuais ou sonoras relevantes ao item.'],
    example: 'as legendas de um vídeo permitem acompanhar uma fala sem ouvir o áudio.'
  },
  '5.15': {
    impact: 'Movimentos ou flashes podem afetar pessoas sensíveis a estímulos visuais e dificultar a concentração ou a leitura.',
    steps: ['Identifique a animação ou o efeito indicado sem prolongar desnecessariamente a exposição.', 'Verifique o controle ou a característica do efeito descrita no item; para flashes, use análise técnica apropriada, sem pedir exposição a pessoas sensíveis.'],
    example: 'uma animação durante a leitura pode distrair a pessoa; a revisão examina o comportamento e os controles pertinentes ao item.'
  },
  '5.16': {
    impact: 'Pessoas que precisam de mais tempo para ler ou interagir podem perder o progresso quando há limites de tempo ou interrupções.',
    steps: ['Percorra a tarefa até a situação de tempo, atualização ou interrupção relacionada ao item.', 'Registre os avisos, as opções disponíveis e o que acontece com as informações já preenchidas.'],
    example: 'uma pessoa demora para preencher um pedido; a revisão acompanha o que acontece com a sessão e com os dados.'
  }
};

const SPACING_REVIEW = [
  'Consulte os valores registrados ou peça apoio técnico para medi-los e testar o ajuste; não estime medidas pela captura de tela. Se houver um mecanismo de configuração, registre qual foi usado e confira se textos continuam disponíveis e controles continuam utilizáveis, sem realizar envios reais.',
  'Para conferir também a WCAG 1.4.12, teste os quatro espaçamentos juntos: linhas 1,5; parágrafos 2; letras 0,12; palavras 0,16 vezes a fonte, sem alterar outros estilos. Essa WCAG não exige um botão de ajuste no site nem esses valores como padrão. Considere propriedades aplicáveis ao idioma; se o ajuste não puder ser confirmado, registre a limitação, não uma falha automática.'
];

const SPECIFIC = {
  '5.1.1': {
    correction: 'Torne perceptível qual controle está selecionado pelo teclado, por exemplo com um contorno visível.',
    steps: ['Use Tab e Shift+Tab para percorrer os controles sem o mouse.', 'Confira se é possível enxergar qual elemento está selecionado em cada parada.']
  },
  '5.1.6': {
    correction: 'Permita sair do componente usando o teclado, conforme a interação prevista para ele.',
    steps: ['Entre no componente pelo teclado e tente avançar e voltar com Tab e Shift+Tab.', 'Confira se existe uma forma de sair pelo teclado; registre as teclas e o ponto em que a navegação fica presa, se isso ocorrer.']
  },
  '5.1.7': {
    impact: 'Pessoas com baixa visão, dificuldade motora ou que usam teclado podem não encontrar uma explicação que aparece apenas quando o ponteiro está em um ponto ou um controle recebe foco.',
    correction: 'Como melhoria recomendada pela ABNT, disponibilize a informação sem depender somente da passagem do mouse ou do foco do teclado, por exemplo no próprio texto ou por uma ajuda acionável.',
    steps: ['Localize a dica ou o conteúdo que aparece ao passar o mouse sem clicar. Depois, confira se aparece ao chegar ao controle com Tab; foco é o controle selecionado pelo teclado.', 'Procure outra forma de obter a mesma informação, como texto permanente ou um botão de ajuda. Registre o que faz o conteúdo aparecer; a existência de uma dica não confirma, sozinha, falha na WCAG. Se houver conteúdo adicional, examine separadamente a permanência (5.1.8) e a possibilidade de dispensá-lo (5.1.9).'],
    example: 'a explicação de um campo está escrita junto dele ou pode ser aberta pelo botão “Ajuda”, sem exigir que a pessoa descubra onde parar o ponteiro.'
  },
  '5.1.8': {
    impact: 'Pessoas com baixa visão ou dificuldade de leitura podem precisar de mais tempo para localizar e ler uma dica. Se ela desaparecer sozinha, podem perder a informação antes de compreendê-la.',
    correction: 'Mantenha o conteúdo adicional visível até a pessoa retirar o foco, mover o ponteiro para fora, dispensar o conteúdo ou a informação deixar de ser válida; não o esconda apenas porque passou um prazo.',
    steps: ['Faça a dica aparecer pelo mouse e, separadamente, pelo teclado. Observe sem mover o mouse nem mudar o foco e registre se ela desaparece sozinha e o tempo observado; uma captura isolada não prova esse comportamento.', 'Se desaparecer, confira se você retirou o foco, saiu da área com o ponteiro, dispensou a dica ou se a informação deixou de ser válida. Diferencie essas situações de um desaparecimento por tempo. Se não conseguir reproduzir, mantenha a revisão pendente.'],
    example: 'uma explicação de preenchimento some sozinha enquanto a pessoa ainda a lê, sem que ela tenha movido o ponteiro ou o foco; isso merece verificação. Já um aviso de “Carregando” pode deixar de ser válido quando a operação termina.'
  },
  '5.1.9': {
    impact: 'Quem usa ampliação da tela pode ter uma área pequena para ler. Uma dica que cobre o conteúdo pode impedir a leitura se só desaparecer quando a pessoa abandona aquele ponto.',
    correction: 'Permita dispensar o conteúdo adicional sem retirar o foco nem reposicionar o ponteiro, quando não se aplicar a exceção de erro de entrada ou de conteúdo que não oculta nem substitui outro conteúdo.',
    steps: ['Faça a dica aparecer e confira se ela cobre ou substitui outra informação. Sem preencher dados reais, verifique também se ela comunica um erro de preenchimento.', 'Se não houver uma dessas exceções, tente dispensá-la sem mover o mouse nem mudar o foco, por exemplo com Esc. Essa tecla não é a única solução possível: registre o mecanismo oferecido e se ele preserva a posição. Não conclua falha só por Esc não funcionar.', 'Registre se a dica comunica erro de entrada ou não oculta nem substitui outro conteúdo: essas são alternativas previstas neste item. Uma captura mostra a posição, mas é necessário reproduzir a interação para verificar como dispensar.'],
    example: 'uma dica aparece cobrindo parte de um parágrafo; ao pressionar Esc, ela fecha e a pessoa continua no mesmo controle, podendo ler o que estava atrás.'
  },
  '5.2.1': { correction: 'Forneça um texto alternativo que transmita a informação relevante da imagem no contexto.' },
  '5.2.2': {
    correction: 'Descreva a ação ou o destino da imagem funcional em seu texto alternativo.',
    example: 'uma imagem que funciona como botão de busca é anunciada como “Buscar”, indicando sua ação.'
  },
  '5.2.3': {
    correction: 'Se a imagem for apenas decorativa, faça com que seja ignorada pelo leitor de tela, por exemplo com texto alternativo vazio quando apropriado.',
    steps: ['Confirme se a imagem é apenas decorativa e não transmite informação nem executa uma ação.', 'Ouça o trecho com leitor de tela e confira se a decoração é ignorada.'],
    example: 'um enfeite ao lado de um título pode ser ignorado pelo leitor de tela, preservando a leitura do título.'
  },
  '5.2.4': {
    correction: 'Disponibilize uma descrição que permita compreender as informações relevantes da imagem complexa.',
    example: 'um gráfico de atendimentos tem uma descrição dos dados e da tendência que ele comunica.'
  },
  '5.3.1': {
    correction: 'Marque os títulos de seção como cabeçalhos no código, para que possam ser encontrados por quem navega com leitor de tela; aumentar ou engrossar a fonte não faz essa marcação.',
    steps: ['Localize um texto que funciona visualmente como título de seção.', 'Compare-o com a lista de títulos do leitor de tela. Sem acesso a essa lista ou ao código correspondente, registre a limitação em vez de concluir apenas pela aparência.'],
    example: '“Documentos necessários” aparece como título na página e também na lista de cabeçalhos do leitor de tela.'
  },
  '5.3.2': {
    correction: 'Use títulos que descrevam o assunto ou a finalidade da seção que apresentam.',
    steps: ['Leia o título e tente prever o assunto da seção antes de ler seu conteúdo.', 'Leia a seção e compare: o título ajuda a encontrar aquela informação ou indica outro assunto? Registre o título e o trecho que sustentam sua conclusão.'],
    example: '“Documentos necessários” identifica uma lista de documentos com mais clareza que um título vago como “Informações”.'
  },
  '5.3.5': {
    correction: 'Organize os níveis dos cabeçalhos para representar a relação entre assuntos e subassuntos, sem escolher o nível apenas pelo tamanho da fonte.',
    steps: ['Consulte a lista de cabeçalhos com seus níveis no leitor de tela e compare com as seções visíveis.', 'Leia a lista como um sumário: confira quais títulos são assuntos principais e quais pertencem a uma seção maior. Se os níveis não estiverem disponíveis, registre que essa parte depende de verificação técnica.'],
    example: '“Documentos” é uma seção; “Identificação” é um assunto dentro dela e recebe um nível subordinado na estrutura.'
  },
  '5.7.3': {
    correction: 'Como melhoria recomendada, use um texto de link que permita compreender o destino mesmo fora do parágrafo.',
    steps: ['Leia o nome do link isoladamente, como na lista de links de um leitor de tela.', 'Pergunte qual destino esse nome comunica. Compare com o destino informado na evidência; este item recomenda compreensão sem depender do contexto.'],
    example: '“Consultar andamento do pedido” explica o destino mesmo quando lido sem o parágrafo ao redor.'
  },
  '5.7.4': {
    correction: 'Torne o propósito do link compreensível pelo seu nome ou pelo contexto associado a ele e disponível ao leitor de tela.',
    steps: ['Leia o link junto da frase, do parágrafo ou do item de lista a que pertence e identifique o destino esperado.', 'Compare com o destino na evidência. Encontrar “clique aqui” não basta para concluir falha: verifique se o contexto esclarece a finalidade e se essa relação também está disponível ao leitor de tela; se não puder confirmar, mantenha a revisão pendente.'],
    example: 'em “Para consultar seu pedido, clique aqui”, a frase pode esclarecer o propósito; “Consultar pedido” torna o próprio link mais claro. É preciso conferir o contexto acessível antes de concluir.'
  },
  '5.7.6': {
    correction: 'Como melhoria recomendada, avise antes do acionamento quando o link abre outra aba ou janela, de modo perceptível também ao leitor de tela.',
    steps: ['Procure, no link ou no aviso associado, uma indicação de nova aba (outra página na barra superior do navegador) ou nova janela.', 'Somente se o destino for seguro para testar, acione o link normalmente, sem teclas que forcem outra aba, e compare o comportamento com o aviso. Se não testar, registre essa limitação.'],
    example: '“Consultar regras (abre em nova aba)” antecipa a mudança; o aviso também fica disponível a quem ouve o link.'
  },
  '5.8.3': {
    correction: 'Dê ao botão um nome que explique sua ação, inclusive quando ele mostra apenas um desenho.',
    steps: ['Confira o texto visível e o nome acessível (o nome que o navegador fornece às tecnologias assistivas) registrados para o botão, sem acionar compras, exclusões ou envios.', 'Compare o nome com a ação esperada. A leitura estimada do relatório ajuda a revisar, mas não substitui a confirmação com um leitor de tela quando houver dúvida.'],
    example: 'um botão com desenho de lupa recebe o nome “Buscar”; o desenho sozinho pode não explicar a ação a quem não o vê.'
  },
  '5.9.1': {
    correction: 'Identifique o campo com um rótulo que explique qual informação preencher e que esteja disponível às tecnologias assistivas.',
    steps: ['Procure a identificação do campo antes de preenchê-lo. Se houver uma dica dentro da caixa, confira se ela desaparece ao digitar; não use dados pessoais reais no teste.', 'Confira também o nome anunciado ao chegar ao campo pelo leitor de tela. Não conclua que a identificação é suficiente apenas porque há texto perto da caixa.'],
    example: 'um campo apresenta “Nome completo” como identificação, em vez de depender apenas de uma dica que some quando a pessoa começa a escrever.'
  },
  '5.9.2': {
    correction: 'Posicione a identificação de modo que a pessoa entenda a qual campo ela pertence durante o preenchimento.',
    steps: ['Observe a posição dos rótulos e identifique a qual campo cada um se refere, antes de preencher.', 'Percorra os campos na ordem de leitura e confira se a identificação aparece em uma sequência compreensível; considere também as opções de marcar ou selecionar.'],
    example: '“Nome completo” fica próximo do campo correspondente, sem parecer identificar a caixa de e-mail ao lado.'
  },
  '5.9.3': {
    correction: 'Associe o rótulo ao campo no código, para que o navegador comunique qual identificação pertence a ele.',
    steps: ['Localize o campo e o rótulo que visualmente parece identificá-lo.', 'Chegue ao campo pelo teclado com um leitor de tela e confira a identificação anunciada. Texto próximo, por si só, não prova associação; se necessário, peça a verificação da associação no código e registre a limitação.'],
    example: 'ao chegar à caixa de e-mail, o leitor de tela identifica “E-mail”, e não apenas um campo de edição sem nome.'
  },
  '5.9.4': {
    correction: 'Escreva um rótulo que permita entender a informação solicitada sem adivinhar o significado do campo.',
    steps: ['Leia o rótulo e diga qual informação você preencheria, sem usar dados pessoais reais.', 'Compare essa interpretação com a finalidade do campo e as instruções disponíveis. Registre palavras vagas ou ambíguas e por que dificultam o entendimento, caso existam.'],
    example: '“Nome completo” descreve a informação solicitada com mais clareza que “Dados”, quando o campo pede o nome da pessoa.'
  },
  '5.11.1': {
    correction: 'Acrescente uma forma de comunicar a informação que não dependa apenas da cor.',
    steps: ['Localize a informação comunicada por cor.', 'Confira se um texto, símbolo ou outra indicação também permite entender a mesma informação.'],
    example: 'um campo inválido apresenta uma mensagem de erro além da borda vermelha.'
  },
  '5.12.1': {
    impact: 'Pessoas com baixa visão ou dificuldade de leitura podem confundir linhas muito próximas e perder o ponto em que estavam lendo.',
    correction: 'Ofereça entrelinhas de pelo menos 1,5 vez o tamanho da fonte ou um mecanismo para configurar esse espaçamento sem perda de conteúdo ou funcionalidade, conforme a alternativa prevista na ABNT.',
    steps: ['Localize um bloco de texto com várias linhas. Confira o tamanho da fonte e a altura de cada linha (entrelinha); essa medida não é apenas a faixa branca entre as letras de duas linhas.', ...SPACING_REVIEW],
    example: 'para uma fonte de 16 pixels, a entrelinha de referência é 24 pixels (16 × 1,5). Ao aplicar o ajuste, o final de um aviso continua legível, sem ficar cortado pela caixa.'
  },
  '5.12.2': {
    impact: 'Pessoas com baixa visão ou dificuldade de leitura podem ter dificuldade para distinguir parágrafos muito próximos e perceber onde termina uma ideia e começa outra.',
    correction: 'Ofereça espaço entre parágrafos de pelo menos 2 vezes o tamanho da fonte ou um mecanismo para configurar esse espaçamento sem perda de conteúdo ou funcionalidade, conforme a alternativa prevista na ABNT.',
    steps: ['Localize dois parágrafos consecutivos. Confira o tamanho da fonte e o espaço que separa os parágrafos; não confunda esse espaço com a distância entre linhas de um mesmo parágrafo.', ...SPACING_REVIEW],
    example: 'para uma fonte de 16 pixels, o espaço de referência entre parágrafos é 32 pixels (16 × 2). Depois do ajuste, o parágrafo seguinte e o botão abaixo dele continuam disponíveis.'
  },
  '5.12.3': {
    impact: 'Pessoas com baixa visão ou dificuldade de leitura podem precisar afastar as letras para reconhecer palavras com mais facilidade.',
    correction: 'Ofereça espaçamento entre letras de pelo menos 0,12 vez o tamanho da fonte ou um mecanismo para configurar esse espaçamento sem perda de conteúdo ou funcionalidade, conforme a alternativa prevista na ABNT.',
    steps: ['Localize um bloco de texto e confira o tamanho da fonte e o ajuste de espaçamento entre letras. A equipe técnica pode verificar letter-spacing; medir a largura do desenho de uma letra não verifica esse ajuste.', ...SPACING_REVIEW],
    example: 'para uma fonte de 16 pixels, o ajuste de referência entre letras é 1,92 pixels (16 × 0,12). Um título pode ocupar mais espaço, mas suas últimas letras continuam disponíveis para leitura.'
  },
  '5.12.4': {
    impact: 'Pessoas com baixa visão ou dificuldade de leitura podem precisar de mais separação entre palavras para reconhecê-las sem confundi-las.',
    correction: 'Ofereça espaçamento entre palavras de pelo menos 0,16 vez o tamanho da fonte ou um mecanismo para configurar esse espaçamento sem perda de conteúdo ou funcionalidade, conforme a alternativa prevista na ABNT.',
    steps: ['Localize um bloco de texto e confira o tamanho da fonte e o ajuste de espaçamento entre palavras. A equipe técnica pode verificar word-spacing; não confunda esse ajuste com o espaçamento entre letras.', ...SPACING_REVIEW],
    example: 'para uma fonte de 16 pixels, o ajuste de referência entre palavras é 2,56 pixels (16 × 0,16). Depois do ajuste, uma instrução pode quebrar em mais linhas, mas nenhuma palavra fica inacessível.'
  },
  '5.12.5': {
    impact: 'Pessoas com dificuldade de leitura podem perder a sequência quando o texto justificado cria espaços desiguais entre as palavras para alinhar as duas bordas do parágrafo.',
    correction: 'Como melhoria recomendada, ofereça uma apresentação dos blocos de texto sem alinhamento justificado, evitando esticar os espaços para alinhar as duas bordas.',
    steps: ['Observe um parágrafo com várias linhas: o texto se alinha às duas margens, com espaços aumentados entre palavras? Compare com a evidência de alinhamento disponível.', 'Confira se há uma opção de apresentação sem justificação. A aparência é uma pista, não uma medição; registre a configuração verificada e as limitações da revisão.'],
    example: 'um parágrafo em português alinhado à esquerda mantém a margem direita irregular, sem aumentar os espaços para preencher toda a linha.'
  },
  '5.12.11': {
    impact: 'Pessoas com dificuldade de compreensão ou que não conhecem o assunto podem não entender uma sigla, mesmo conseguindo ler suas letras.',
    correction: 'Como melhoria recomendada, disponibilize o significado das siglas e abreviaturas, por exemplo por uma explicação no texto ou um glossário acessível.',
    steps: ['Localize a sigla e procure seu significado por extenso no texto, em uma explicação associada ou em um glossário disponível.', 'Confira se a explicação corresponde ao uso naquele contexto e pode ser encontrada também pelo teclado ou leitor de tela. Registre onde foi encontrada ou quais locais foram verificados.'],
    example: '“CPF (Cadastro de Pessoas Físicas)” apresenta o significado de CPF para quem ainda não conhece a sigla.'
  },
  '5.13.1': {
    impact: 'Pessoas cegas ou com dificuldade de orientação usam o título da página para reconhecer onde estão e distinguir abas abertas.',
    correction: 'Defina um título da página que descreva seu assunto ou sua finalidade; ele é diferente de um título de seção dentro do conteúdo.',
    steps: ['Confira o título da aba do navegador ou o título registrado no relatório; se estiver cortado na aba, consulte sua versão completa.', 'Compare-o com a finalidade da página: ele permite reconhecer o serviço ou assunto sem depender apenas de um nome genérico do site?'],
    example: '“Agendar atendimento — Portal de serviços” identifica a finalidade da página com mais clareza que apenas “Início”.'
  },
  '5.13.2': {
    impact: 'Pessoas cegas dependem da indicação de idioma para que o leitor de tela possa escolher a pronúncia adequada. Um texto em português tratado como outro idioma pode ser difícil de entender.',
    correction: 'Informe no código o idioma principal que corresponde ao conteúdo da página. A equipe técnica pode ajustar o atributo lang do elemento html.',
    steps: ['Leia uma amostra do conteúdo principal e identifique em qual idioma ele está escrito.', 'Compare com o idioma declarado na evidência ou no código da página. Se essa informação não estiver disponível, solicite a verificação técnica; ouvir uma pronúncia correta, sozinho, não prova que a declaração existe.'],
    example: 'uma página predominantemente em português do Brasil declara lang="pt-BR" no elemento html. Esse é um exemplo de declaração, não um dado observado nesta auditoria.'
  },
  '5.13.3': {
    impact: 'Quem usa leitor de tela pode ouvir um trecho estrangeiro com pronúncia inadequada se a mudança de idioma não estiver identificada.',
    correction: 'Identifique no código o idioma dos trechos em outra língua quando o item se aplicar, para permitir a mudança de pronúncia pelo leitor de tela.',
    steps: ['Procure frases ou passagens em idioma diferente do idioma principal e anote o trecho exato.', 'Confira a indicação de idioma daquele trecho na evidência ou peça ajuda técnica. Não trate automaticamente nomes próprios, termos técnicos e palavras incorporadas ao idioma como falhas: verifique as exceções aplicáveis; a pronúncia ouvida não substitui essa confirmação.'],
    example: 'em uma página em português, uma frase citada em inglês pode receber lang="en" no trecho correspondente, sem mudar o idioma da página inteira.'
  },
  '5.13.6': {
    impact: 'Pessoas que ouvem a página com leitor de tela podem receber frases ou etapas fora de sequência e perder o sentido, mesmo quando a disposição visual parece correta.',
    correction: 'Organize a sequência do conteúdo no código para preservar o sentido quando ele for lido de forma linear, sem depender da posição visual dos blocos.',
    steps: ['Acompanhe a leitura contínua do trecho com um leitor de tela, incluindo títulos, parágrafos e instruções. Usar somente Tab percorre controles e não verifica toda a ordem de leitura.', 'Compare a sequência ouvida com o sentido do conteúdo: uma etapa aparece antes da instrução necessária ou frases de colunas diferentes se misturam? Uma ordem diferente da visual não é, sozinha, uma falha se preservar o sentido. Sem conseguir verificar a sequência, registre a limitação e mantenha a conclusão pendente.'],
    example: 'em duas colunas com textos independentes, a leitura termina um texto antes de iniciar o outro, sem alternar frases entre os dois.'
  },
  '5.13.7': {
    impact: 'Pessoas que usam comandos de voz dizem as palavras que veem para selecionar um controle. Se o navegador o identificar por outro nome, o comando pode não funcionar; quem vê e ouve a página também pode receber informações conflitantes.',
    correction: 'Faça com que o nome acessível (a identificação fornecida pelo navegador às tecnologias assistivas) contenha o texto visível que identifica o controle. Ele pode incluir informação adicional; não precisa ser apenas esse texto.',
    steps: ['Localize o controle pelo sinal ou pela captura e compare seu texto visível com o campo “Nome acessível” da ficha, sem acionar sua função.', 'Confira se as palavras visíveis estão no nome, na mesma ordem. Não conclua falha apenas por maiúsculas ou pontuação. Se houver só um ícone sem texto, não aplique automaticamente esta comparação; verifique o nome do componente no item próprio. Se faltar o nome registrado ou houver dúvida, peça confirmação técnica e mantenha a revisão pendente.'],
    example: 'um botão mostra “Buscar”, mas tem o nome “Pesquisar”: as palavras não coincidem. “Buscar produtos” inclui o texto visível e esclarece a ação. Este exemplo não descreve o elemento auditado.'
  },
  '5.13.8': {
    impact: 'Pessoas cegas ou com baixa visão podem não perceber um aviso que surge em outra parte da página, como o término de uma busca, e ficar sem saber se a ação deu resultado.',
    correction: 'Identifique as mensagens de status no código para que a tecnologia assistiva possa comunicá-las sem deslocar o foco da pessoa. A equipe técnica deve escolher a marcação adequada à mensagem; não basta fazê-la aparecer visualmente.',
    steps: ['Em uma tarefa segura para testar, como uma busca de teste sem dados pessoais, identifique o aviso de andamento, resultado ou erro que aparece sem abrir outra página ou diálogo. Não realize compras, exclusões ou envios reais para provocar um aviso.', 'Com o leitor de tela ativo, confira se o aviso é comunicado sem mover manualmente o foco até ele. O anúncio estimado do relatório não comprova essa atualização dinâmica. Se não puder reproduzir a mensagem ou confirmar sua marcação com apoio técnico, registre a limitação e mantenha a conclusão pendente.'],
    example: 'ao terminar uma busca, aparece “3 resultados encontrados” e o leitor de tela pode comunicar esse aviso enquanto a pessoa permanece no controle de busca.'
  },
  '5.13.10': {
    correction: 'Forneça ao componente um nome acessível, isto é, uma identificação que o navegador consiga comunicar às tecnologias assistivas.',
    steps: ['Consulte o nome acessível registrado na ficha do componente e compare com sua identificação visual, sem acionar a função.', 'Se não houver nome registrado, confira com leitor de tela ou apoio técnico antes de concluir quando o resultado estiver pendente. O anúncio estimado não garante a fala exata de todos os leitores de tela.'],
    example: 'um controle com desenho de lupa tem o nome acessível “Buscar”, permitindo reconhecer sua função sem enxergar o desenho.'
  }
};

/** Pair fields from each already validated, correlated element; never infer a conclusion. */
export function recordedLabelComparisons(itemId, evidence) {
  if (itemId !== '5.13.7') return [];
  const display = value => value === null || value === undefined ? 'não disponível'
    : value === '' ? 'vazio (registrado sem texto)' : `“${value}”`;
  return evidence.filter(artifact => artifact.kind === 'element' && artifact.accessibility)
    .map(artifact => ({ evidenceId: artifact.evidenceId,
      text: `Texto visível registrado: ${display(artifact.accessibility.visibleText)} · Nome acessível registrado: ${display(artifact.accessibility.name)}.`,
    }));
}

/** Explain an existing result without deriving or modifying its outcome. */
export function accessibilityGuidance({ itemId, title, outcome, observed, correction } = {}) {
  const item = ITEMS.get(itemId);
  const topic = item?.title || title || 'Verificação de acessibilidade';
  const family = item ? PROFILES[item.id.split('.').slice(0, 2).join('.')] : PROFILES.generic;
  const profile = { ...family, ...(item ? SPECIFIC[item.id] : {}) };
  const evidence = typeof observed === 'string' && observed.trim() ? observed : '';
  const suppliedCorrection = typeof correction === 'string' && correction.trim() ? correction : '';
  const action = suppliedCorrection || profile.correction || `Revise “${topic}” no trecho indicado e ajuste o aspecto confirmado na revisão, conforme o item aplicável.`;
  const introductions = {
    failed: 'O resultado registrado aponta uma falha neste item.',
    cantTell: 'O resultado disponível não confirma atendimento nem falha; é necessária revisão humana.',
    untested: 'Este item não foi avaliado; ainda não há conclusão.',
    passed: 'O resultado registrado indica atendimento no escopo verificado.',
    inapplicable: 'O item foi registrado como não aplicável ao escopo verificado.'
  };
  let nextAction;
  if (outcome === 'passed') nextAction = 'Nenhuma correção é indicada por este resultado. Mantenha o comportamento e reavalie quando houver mudanças.';
  else if (outcome === 'inapplicable') nextAction = 'Nenhuma correção é indicada para este resultado. Reavalie a aplicabilidade se o conteúdo mudar.';
  else if (outcome === 'failed') nextAction = action;
  else nextAction = `Se a revisão confirmar um problema neste item: ${action}`;

  return {
    impact: profile.impact,
    observed: `${introductions[outcome] || introductions.cantTell}${evidence ? ` Registro original: ${evidence}` : ' Não foi fornecida uma descrição do que foi observado.'}`,
    correction: nextAction,
    reviewSteps: [`Confira “${topic}” no trecho e no estado da página indicados pelo relatório.`, ...profile.steps, 'Registre a conclusão, a evidência e as limitações da revisão; o exemplo abaixo não é evidência da página.'],
    example: `Exemplo hipotético: ${profile.example}`
  };
}
