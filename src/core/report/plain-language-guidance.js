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

const SPECIFIC = {
  '5.1.1': {
    correction: 'Torne perceptível qual controle está selecionado pelo teclado, por exemplo com um contorno visível.',
    steps: ['Use Tab e Shift+Tab para percorrer os controles sem o mouse.', 'Confira se é possível enxergar qual elemento está selecionado em cada parada.']
  },
  '5.1.6': {
    correction: 'Permita sair do componente usando o teclado, conforme a interação prevista para ele.',
    steps: ['Entre no componente pelo teclado e tente avançar e voltar com Tab e Shift+Tab.', 'Confira se existe uma forma de sair pelo teclado; registre as teclas e o ponto em que a navegação fica presa, se isso ocorrer.']
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
  '5.11.1': {
    correction: 'Acrescente uma forma de comunicar a informação que não dependa apenas da cor.',
    steps: ['Localize a informação comunicada por cor.', 'Confira se um texto, símbolo ou outra indicação também permite entender a mesma informação.'],
    example: 'um campo inválido apresenta uma mensagem de erro além da borda vermelha.'
  }
};

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
