import { NBR17225_ITEMS } from '../normative/nbr17225.js';

// Revisão guiada para quem não tem formação técnica.
//
// Este módulo só apresenta: nada aqui altera regra, resultado, decisão ou modelo canônico. A pessoa
// responde sobre o que vê ("esta imagem mostra um produto?"); a interface traduz a resposta para as
// quatro respostas canônicas de revisão. As perguntas são paráfrases próprias dos itens da
// ABNT NBR 17225:2025, nunca transcrições do texto da norma.

const ITEM_BY_ID = new Map(NBR17225_ITEMS.map(item => [item.id, item]));

/** Respostas oferecidas, na linguagem de quem revisa, e a resposta canônica que cada uma grava. */
export const LAY_ANSWERS = Object.freeze([
  Object.freeze({ answer: 'conforme', label: 'Sim', meaning: 'atende ao item' }),
  Object.freeze({ answer: 'não conforme', label: 'Não', meaning: 'não atende ao item' }),
  Object.freeze({ answer: 'não foi possível determinar', label: 'Não consegui verificar', meaning: 'fica sem conclusão' }),
  Object.freeze({ answer: 'não se aplica', label: 'Não existe nesta página', meaning: 'não se aplica' }),
]);

export const ANSWER_LABELS = Object.freeze({
  conforme: 'Conforme (atende ao item)',
  'não conforme': 'Não conforme (não atende ao item)',
  'não foi possível determinar': 'Não foi possível determinar',
  'não se aplica': 'Não se aplica',
});

export const CLASSIFICATION_WORDS = Object.freeze({ requirement: 'requisito', recommendation: 'recomendação' });

/** Grupos por "coisa" que a pessoa vê, na ordem em que a revisão guiada os apresenta. */
export const LAY_GROUPS = Object.freeze([
  Object.freeze({ id: 'pagina', label: 'Página inteira', description: 'Título, idioma e ampliação da página.' }),
  Object.freeze({ id: 'imagens', label: 'Imagens', description: 'Para que serve cada imagem e se ela tem descrição em texto.' }),
  Object.freeze({ id: 'links', label: 'Links', description: 'Se dá para saber aonde cada link leva.' }),
  Object.freeze({ id: 'botoes', label: 'Botões e outros controles', description: 'Se cada controle tem nome e pode ser acionado.' }),
  Object.freeze({ id: 'formularios', label: 'Formulários', description: 'Nomes dos campos, campos obrigatórios e mensagens de erro.' }),
  Object.freeze({ id: 'teclado', label: 'Teclado e foco', description: 'Se tudo funciona só com o teclado e se dá para ver onde se está.' }),
  Object.freeze({ id: 'cores', label: 'Cores e contraste', description: 'Se textos e controles se destacam do fundo e se a cor não é o único sinal.' }),
  Object.freeze({ id: 'texto', label: 'Texto, espaçamento e ampliação', description: 'Se o texto continua legível ampliado, espaçado ou em tela estreita.' }),
  Object.freeze({ id: 'estrutura', label: 'Organização da página', description: 'Títulos, regiões, listas e tabelas.' }),
  Object.freeze({ id: 'midia', label: 'Vídeo, áudio e animações', description: 'Legendas, audiodescrição, Libras, som automático e movimento.' }),
  Object.freeze({ id: 'tempo', label: 'Tempo e interrupções', description: 'Limites de tempo, atualizações automáticas e sessões que expiram.' }),
  Object.freeze({ id: 'conjunto', label: 'Comparação com outras páginas do site', description: 'Itens que exigem abrir outras páginas do mesmo site.' }),
  Object.freeze({ id: 'codigo', label: 'Itens que dependem de exame do código', description: 'Sem apoio técnico, a resposta honesta é “Não consegui verificar”.' }),
]);
const GROUP_ORDER = new Map(LAY_GROUPS.map((group, index) => [group.id, index]));

/** Termos explicados no ponto de uso. */
export const GLOSSARY = Object.freeze({
  foco: 'Marca que mostra qual item da página está selecionado pelo teclado. Ela anda quando você aperta Tab.',
  'leitor de tela': 'Programa que lê a página em voz alta para pessoas cegas ou com baixa visão.',
  'texto alternativo': 'Descrição em texto de uma imagem. O leitor de tela lê essa descrição no lugar da imagem.',
  rótulo: 'Nome que identifica um campo de formulário, como “Nome” ou “E-mail”.',
  'nome acessível': 'Nome que o leitor de tela anuncia para um link, botão ou campo.',
  cabeçalho: 'Título de uma seção da página. Quem usa leitor de tela pula de título em título para se orientar.',
  região: 'Área da página com função própria, como cabeçalho, menu, conteúdo principal ou rodapé.',
  contraste: 'Diferença de claridade entre o texto e o fundo. Pouco contraste dificulta a leitura.',
  legendas: 'Texto que mostra as falas e os sons importantes de um vídeo.',
  audiodescrição: 'Narração que descreve o que aparece na imagem de um vídeo, para quem não vê.',
  libras: 'Língua Brasileira de Sinais, usada pela comunidade surda.',
  zoom: 'Ampliação da página pelo navegador (Ctrl e + no Windows, Cmd e + no Mac).',
  'tecnologia assistiva': 'Recurso que ajuda pessoas com deficiência a usar o computador, como leitor de tela ou ampliador.',
  'componente customizado': 'Controle criado pelo próprio site (por exemplo, um menu diferente do padrão do navegador).',
  'mudança de contexto': 'Mudança grande e repentina, como abrir outra página ou janela, ou mover o foco sozinho.',
  'conjunto de páginas': 'Outras páginas do mesmo site, que precisam ser comparadas com esta.',
});

// q: pergunta (Sim = atende). s: como verificar. g: grupo. aid: ajuda interativa. tech: depende do código.
// t: termos do glossário que a pergunta usa.
const GUIDES = {
  '5.1.1': { g: 'teclado', aid: 'tab', t: ['foco'], q: 'Ao apertar Tab, dá para ver em todo momento qual item está selecionado?', s: ['Clique numa área vazia da página e aperte Tab várias vezes.', 'A cada toque, procure um contorno, sublinhado ou mudança de cor no item selecionado.', 'Responda “Não” se em algum ponto você perder de vista onde está a seleção.'] },
  '5.1.2': { g: 'teclado', aid: 'tab', t: ['foco'], q: 'Quando um item recebe a seleção do teclado, ele aparece inteiro na tela, sem nada cobrindo?', s: ['Aperte Tab e observe cada item selecionado.', 'Veja se algum fica escondido atrás de barras fixas, avisos de cookies ou janelas.'] },
  '5.1.3': { g: 'teclado', aid: 'tab', t: ['foco'], q: 'Quando um item recebe a seleção do teclado, pelo menos parte dele continua visível?', s: ['Aperte Tab e observe cada item selecionado.', 'Responda “Não” se algum item ficar totalmente coberto por barras fixas, avisos ou janelas.'] },
  '5.1.4': { g: 'teclado', aid: 'tab', t: ['foco'], q: 'Ao apertar Tab, a seleção percorre a página numa ordem lógica, como a de leitura?', s: ['Aperte Tab do início ao fim da página.', 'Veja se a seleção segue a ordem em que você leria (de cima para baixo, da esquerda para a direita) sem saltos sem sentido.'] },
  '5.1.5': { g: 'teclado', aid: 'tab', t: ['foco'], q: 'Todo lugar onde a seleção do Tab para é algo com que se pode interagir (link, botão, campo)?', s: ['Aperte Tab pela página.', 'Responda “Não” se a seleção parar em textos ou áreas que não fazem nada.'] },
  '5.1.6': { g: 'teclado', aid: 'tab', q: 'Dá para entrar e sair de todas as partes da página usando só o teclado, sem ficar preso?', s: ['Percorra a página com Tab e volte com Shift+Tab.', 'Em janelas, menus ou vídeos, tente sair com Tab ou Esc.', 'Responda “Não” se o teclado ficar preso num ponto.'] },
  '5.1.7': { g: 'teclado', q: 'As informações que aparecem só ao passar o mouse ou ao selecionar um item também podem ser vistas de outra forma?', s: ['Passe o mouse sobre ícones e campos e veja se surgem dicas.', 'Procure a mesma informação escrita na página ou num botão de ajuda.'] },
  '5.1.8': { g: 'teclado', q: 'As dicas que aparecem ao passar o mouse ou com o teclado ficam na tela até você sair delas?', s: ['Passe o mouse sobre itens com dica e espere alguns segundos.', 'Responda “Não” se a dica sumir sozinha antes de dar tempo de ler.'] },
  '5.1.9': { g: 'teclado', q: 'As dicas que aparecem ao passar o mouse podem ser fechadas (por exemplo, com Esc) sem mover o mouse?', s: ['Faça uma dica aparecer.', 'Aperte Esc e veja se ela some sem que você mova o mouse.'] },
  '5.1.10': { g: 'teclado', q: 'Os atalhos de teclado do site sempre usam uma tecla como Ctrl ou Alt junto com a letra?', s: ['Procure na página uma lista de atalhos de teclado.', 'Se não houver atalhos, responda “Não existe nesta página”.'] },
  '5.1.11': { g: 'teclado', q: 'Se o site tem atalhos de uma tecla só, é possível desligá-los ou trocá-los?', s: ['Procure atalhos de uma letra só (por exemplo, “S” para buscar).', 'Se existirem, procure uma opção para desativá-los. Se não houver atalhos assim, responda “Não existe nesta página”.'] },
  '5.1.12': { g: 'teclado', aid: 'tab', q: 'Todas as funções da página podem ser usadas só com o teclado?', s: ['Sem usar o mouse, tente usar cada função da página com Tab, Enter, Espaço e as setas.', 'Responda “Não” se alguma função só funcionar com o mouse.'] },
  '5.1.13': { g: 'teclado', aid: 'tab', q: 'Dá para usar só com o teclado todas as funções que não exigem o mouse por natureza (como desenhar à mão livre)?', s: ['Sem usar o mouse, tente chegar a cada link, botão e campo com Tab.', 'Tente acionar cada um com Enter ou Espaço.', 'Responda “Não” se algo comum, como um botão “Enviar”, não puder ser alcançado ou acionado pelo teclado.'] },
  '5.1.14': { g: 'teclado', q: 'A página deixa usar mouse, teclado e toque à vontade, sem bloquear nenhum deles?', s: ['Use a página com o mouse e depois com o teclado.', 'Responda “Não” se a página impedir um desses meios sem motivo de segurança.'] },
  '5.1.15': { g: 'teclado', t: ['componente customizado'], q: 'Os menus, abas e controles diferentes do comum funcionam de um jeito previsível?', s: ['Use os menus e abas com o mouse e com o teclado (setas, Enter, Esc).', 'Responda “Não” se algum se comportar de forma inesperada.'] },
  '5.1.16': { g: 'teclado', t: ['componente customizado'], q: 'Os controles complicados ou fora do comum têm instruções de uso na página?', s: ['Identifique controles que não sejam links, botões ou campos comuns.', 'Procure instruções de como operá-los. Se não houver controles assim, responda “Não existe nesta página”.'] },
  '5.2.1': { g: 'imagens', t: ['texto alternativo'], q: 'Se esta imagem transmite informação, ela tem um texto alternativo que diz essa informação?', s: ['Olhe a imagem e o texto alternativo lido pela extensão.', 'Responda “Não” se a imagem informa algo e o texto alternativo falta ou não diz o que ela mostra.'] },
  '5.2.2': { g: 'imagens', t: ['texto alternativo'], q: 'Se esta imagem é um botão ou link, o texto alternativo diz o que ela faz?', s: ['Veja se clicar na imagem leva a algum lugar ou executa algo.', 'Compare com o texto alternativo lido pela extensão.'] },
  '5.2.3': { g: 'imagens', t: ['texto alternativo'], q: 'Se esta imagem é só enfeite, ela está marcada para o leitor de tela ignorar?', s: ['Decida se a imagem é só decoração.', 'Se for, o texto alternativo deve estar vazio. Se faltar a marcação, responda “Não”.'] },
  '5.2.4': { g: 'imagens', q: 'Se esta imagem é complexa (gráfico, mapa, esquema), há uma descrição detalhada perto dela ou num link indicado?', s: ['Veja se a imagem tem muitos dados.', 'Procure ao lado dela, ou num link próximo, uma explicação completa em texto.'] },
  '5.2.5': { g: 'imagens', q: 'Se esta imagem contém texto escrito, isso é indispensável (como um logotipo) e o texto alternativo repete o que está escrito?', s: ['Veja se há palavras desenhadas dentro da imagem.', 'Texto que poderia ser texto comum não deveria estar em imagem, exceto logotipos e marcas.'] },
  '5.2.6': { g: 'imagens', q: 'Se esta imagem tem áreas clicáveis diferentes (mapa de imagem), cada área tem texto alternativo?', s: ['Passe o mouse pela imagem e veja se partes diferentes levam a lugares diferentes.', 'Se não for um mapa de imagem, responda “Não existe nesta página”.'] },
  '5.3.1': { g: 'codigo', tech: true, t: ['cabeçalho'], q: 'Os títulos visíveis da página estão marcados como títulos no código?', s: ['Este item depende do código. A extensão já confere o que consegue automaticamente.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.3.2': { g: 'estrutura', t: ['cabeçalho'], q: 'Os textos destacados como títulos são realmente títulos de seções (e não só frases em negrito usadas como enfeite)?', s: ['Percorra a página e observe os títulos.', 'Responda “Não” se textos comuns estiverem marcados como título só para ficarem grandes.'] },
  '5.3.3': { g: 'estrutura', t: ['cabeçalho'], q: 'A página tem um único título principal, que diz do que ela trata?', s: ['Procure o título principal no alto do conteúdo.', 'Ele deve identificar a página, como “Ofertas da semana”.'] },
  '5.3.4': { g: 'estrutura', t: ['cabeçalho'], q: 'Cada seção de conteúdo começa com um título que a identifica?', s: ['Percorra a página.', 'Responda “Não” se houver blocos de conteúdo sem título.'] },
  '5.3.5': { g: 'estrutura', t: ['cabeçalho'], q: 'Os títulos seguem uma hierarquia lógica (título principal, depois subtítulos)?', s: ['Este item depende em parte do código; a extensão aponta saltos de nível.', 'Sem apoio técnico, use a pista da extensão ou responda “Não consegui verificar”.'] },
  '5.4.1': { g: 'codigo', tech: true, t: ['região'], q: 'As áreas da página (cabeçalho, menu, conteúdo, rodapé) estão marcadas como tais no código?', s: ['Este item depende do código.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.4.2': { g: 'codigo', tech: true, t: ['região'], q: 'As regiões marcadas no código correspondem às áreas que se veem na tela?', s: ['Este item depende do código.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.4.3': { g: 'codigo', tech: true, t: ['região'], q: 'Todo o conteúdo da página está dentro de alguma região (cabeçalho, menu, conteúdo, rodapé)?', s: ['Este item depende do código.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.4.4': { g: 'codigo', tech: true, t: ['região'], q: 'Há no máximo um cabeçalho, um conteúdo principal e um rodapé marcados no código?', s: ['Este item depende do código.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.4.5': { g: 'codigo', tech: true, t: ['região'], q: 'Quando há duas regiões do mesmo tipo (por exemplo, dois menus), cada uma tem um nome diferente?', s: ['Este item depende do código.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.5.1': { g: 'codigo', tech: true, q: 'As listas que aparecem na tela estão marcadas como listas no código?', s: ['Este item depende do código.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.5.2': { g: 'estrutura', q: 'O que aparece como lista agrupa itens da mesma natureza?', s: ['Observe as listas de itens da página.', 'Responda “Não” se itens sem relação forem apresentados como uma lista.'] },
  '5.6.1': { g: 'codigo', tech: true, q: 'As tabelas de dados estão marcadas como tabelas no código?', s: ['Este item depende do código.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.6.2': { g: 'estrutura', q: 'As tabelas da página servem para mostrar dados (e não só para posicionar elementos)?', s: ['Observe as tabelas.', 'Uma tabela de dados tem linhas e colunas com informações relacionadas, como produto e preço.'] },
  '5.6.3': { g: 'codigo', tech: true, q: 'Cada dado da tabela está ligado, no código, ao título da sua linha e da sua coluna?', s: ['Este item depende do código.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.6.4': { g: 'estrutura', q: 'Cada tabela tem um título ou legenda que diz do que ela trata?', s: ['Procure um título logo acima ou abaixo da tabela.'] },
  '5.6.5': { g: 'codigo', tech: true, q: 'O título da tabela está ligado a ela no código?', s: ['Este item depende do código.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.6.6': { g: 'estrutura', q: 'Se a tabela é complexa (vários níveis de títulos), há uma explicação em texto de como lê-la?', s: ['Veja se a tabela tem títulos agrupados ou células mescladas.', 'Se for uma tabela simples, responda “Não existe nesta página”.'] },
  '5.7.1': { g: 'codigo', tech: true, q: 'Os links estão marcados como links no código?', s: ['Este item depende do código.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.7.2': { g: 'links', q: 'Este link leva a outro lugar (outra página ou outra parte da página), como se espera de um link?', s: ['Clique no link (ou use “Mostrar na página”).', 'Responda “Não” se ele, em vez de navegar, executar uma ação como enviar ou abrir um menu (isso seria papel de botão).'] },
  '5.7.3': { g: 'links', q: 'Lendo só o texto deste link, sem o resto da frase, dá para saber aonde ele leva?', s: ['Leia o texto do link mostrado acima.', 'Textos como “saiba mais” ou “clique aqui” sozinhos não dizem o destino.'] },
  '5.7.4': { g: 'links', q: 'Lendo o texto deste link junto com a frase ou o bloco em volta, dá para saber aonde ele leva?', s: ['Use “Mostrar na página” para ver o link no lugar.', 'Leia o link junto com o título ou a frase mais próxima.', 'Responda “Não” se mesmo assim não der para saber o destino.'] },
  '5.7.5': { g: 'conjunto', q: 'Links com o mesmo texto levam sempre ao mesmo destino?', s: ['Procure links com textos iguais (por exemplo, vários “Saiba mais”).', 'Responda “Não” se textos iguais levarem a lugares diferentes sem que isso fique claro.'] },
  '5.7.6': { g: 'links', q: 'Os links que abrem uma nova aba ou janela avisam isso antes?', s: ['Clique nos links e veja se algum abre outra aba.', 'Se abrir, veja se havia aviso (texto ou ícone com descrição). Se nenhum abrir nova aba, responda “Não existe nesta página”.'] },
  '5.7.7': { g: 'links', q: 'Os links para arquivos (PDF, planilhas) informam o formato e o tamanho do arquivo?', s: ['Procure links para documentos para baixar.', 'Veja se o texto informa, por exemplo, “(PDF, 2 MB)”. Se não houver, responda “Não existe nesta página”.'] },
  '5.7.8': { g: 'links', q: 'Os links que levam a outros sites avisam que você vai sair deste site?', s: ['Passe o mouse sobre os links e veja o endereço no canto da tela.', 'Se levam a outro site, veja se há aviso.'] },
  '5.7.9': { g: 'links', q: 'O texto ao redor dos links evita repetir à toa o que o próprio link já diz?', s: ['Leia os links e o texto em volta.', 'Responda “Não” se houver repetições como um link “Contato” seguido do texto “Contato”.'] },
  '5.7.10': { g: 'links', q: 'Itens lado a lado (como uma imagem e um título) que levam ao mesmo lugar formam um link só?', s: ['Veja se há uma imagem e um texto, um ao lado do outro, que levam ao mesmo destino.', 'Responda “Não” se forem dois links separados para o mesmo lugar.'] },
  '5.7.11': { g: 'links', aid: 'tab', q: 'Há um jeito de pular blocos repetidos (como o menu) e ir direto ao conteúdo?', s: ['Recarregue a página e aperte Tab uma vez.', 'Veja se aparece algo como “Pular para o conteúdo”.'] },
  '5.7.12': { g: 'conjunto', aid: 'tab', q: 'Em todas as páginas do site há um jeito de pular os blocos que se repetem (como o menu)?', s: ['Abra outras páginas do site.', 'Em cada uma, aperte Tab uma vez e procure “Pular para o conteúdo” ou mecanismo equivalente.'] },
  '5.7.13': { g: 'conjunto', q: 'Há mais de um jeito de chegar a esta página no site (menu, busca, mapa do site)?', s: ['Procure busca, mapa do site ou menu.', 'Se a página é uma etapa de um processo (como o carrinho), responda “Não existe nesta página”.'] },
  '5.7.14': { g: 'conjunto', q: 'A página mostra onde você está dentro do site (por exemplo, “Início > Ofertas”)?', s: ['Procure uma trilha de navegação ou o item do menu destacado.'] },
  '5.7.15': { g: 'conjunto', q: 'O menu e outros mecanismos de navegação ficam na mesma ordem em todas as páginas do site?', s: ['Abra duas ou três páginas do site.', 'Compare a posição e a ordem dos menus.'] },
  '5.7.16': { g: 'conjunto', q: 'Os meios de ajuda (fale conosco, chat, telefone) ficam no mesmo lugar relativo em todas as páginas?', s: ['Abra duas ou três páginas do site.', 'Compare onde aparecem os meios de ajuda.'] },
  '5.8.1': { g: 'codigo', tech: true, q: 'Os botões estão marcados como botões no código?', s: ['Este item depende do código.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.8.2': { g: 'botoes', q: 'Este botão executa uma ação (enviar, abrir, fechar), como se espera de um botão?', s: ['Use “Mostrar na página” e veja o botão.', 'Responda “Não” se ele apenas levar a outra página (isso seria papel de link).'] },
  '5.8.3': { g: 'botoes', t: ['nome acessível'], q: 'O nome deste botão diz o que ele faz?', s: ['Compare o nome lido pela extensão com a aparência do botão.', 'Responda “Não” se o botão não tiver nome ou o nome não disser a função.'] },
  '5.8.4': { g: 'botoes', q: 'Controles que fazem a mesma coisa aparecem com o mesmo nome e o mesmo ícone em toda a página?', s: ['Procure botões repetidos (por exemplo, vários “Comprar”).', 'Veja se mantêm o mesmo nome e aparência.'] },
  '5.8.5': { g: 'conjunto', q: 'Controles que fazem a mesma coisa têm o mesmo nome em todas as páginas do site?', s: ['Abra outras páginas do site.', 'Compare nomes e ícones de controles com a mesma função, como a busca.'] },
  '5.8.6': { g: 'botoes', q: 'Os botões e links são grandes o bastante para tocar com folga (cerca de 1 cm)?', s: ['Observe o tamanho dos controles na tela.', 'Esta é uma recomendação; a medida mínima obrigatória é menor.'] },
  '5.8.7': { g: 'botoes', q: 'Este controle é grande o bastante (ou tem espaço suficiente em volta) para ser acionado sem acertar o vizinho por engano?', s: ['Use “Mostrar na página” e veja o controle.', 'A medida mínima é de cerca de 24 pixels, pouco mais de meio centímetro na tela. A pista da extensão mostra o tamanho medido.'] },
  '5.8.8': { g: 'botoes', t: ['mudança de contexto'], q: 'Mudanças grandes (abrir outra página ou janela) só acontecem quando você pede?', s: ['Use a página normalmente.', 'Responda “Não” se algo abrir ou mudar de página sozinho.'] },
  '5.8.9': { g: 'botoes', aid: 'tab', t: ['mudança de contexto', 'foco'], q: 'Só de selecionar um item com Tab (sem apertar Enter), nada muda de página nem abre sozinho?', s: ['Aperte Tab pela página sem apertar Enter.', 'Responda “Não” se a página mudar, abrir janela ou enviar algo só com a seleção.'] },
  '5.8.10': { g: 'formularios', t: ['mudança de contexto'], q: 'Ao escolher uma opção ou digitar num campo, a página não muda sozinha sem avisar antes?', s: ['Escolha opções em listas e marque caixas, sem enviar.', 'Responda “Não” se a página mudar ou enviar dados sem aviso prévio.'] },
  '5.8.11': { g: 'botoes', q: 'Ações acionadas com o mouse só acontecem ao soltar o botão do mouse (dando chance de desistir)?', s: ['Aperte e segure o mouse sobre um botão, arraste para fora e solte.', 'Responda “Não” se a ação acontecer mesmo assim.'] },
  '5.8.12': { g: 'botoes', q: 'Funções que usam gestos (pinçar, deslizar) também funcionam com um clique simples?', s: ['Procure carrosséis, mapas ou galerias.', 'Veja se há botões (setas, + e −) que fazem o mesmo. Se não houver gestos, responda “Não existe nesta página”.'] },
  '5.8.13': { g: 'botoes', q: 'O que exige arrastar (por exemplo, um controle deslizante) também pode ser feito com cliques?', s: ['Procure controles de arrastar.', 'Veja se há alternativa por clique. Se não houver arrastar, responda “Não existe nesta página”.'] },
  '5.8.14': { g: 'botoes', q: 'Funções acionadas por movimentar o aparelho (sacudir, inclinar) também têm botão e podem ser desligadas?', s: ['Se não houver funções por movimento, responda “Não existe nesta página”.'] },
  '5.8.15': { g: 'botoes', q: 'Ao acionar um controle, a página mostra algum retorno (mensagem, mudança visual)?', s: ['Acione alguns botões, sem enviar dados reais.', 'Veja se aparece alguma confirmação ou mudança.'] },
  '5.9.1': { g: 'formularios', t: ['rótulo'], q: 'Cada campo do formulário tem um nome visível que diz o que preencher?', s: ['Olhe os campos do formulário.', 'Clique num campo e comece a digitar: se o único nome era o texto cinza de exemplo e ele sumiu, responda “Não”.'] },
  '5.9.2': { g: 'formularios', t: ['rótulo'], q: 'Os nomes dos campos ficam sempre no mesmo lugar em relação ao campo (por exemplo, sempre acima)?', s: ['Observe a posição dos nomes de cada campo.'] },
  '5.9.3': { g: 'codigo', tech: true, t: ['rótulo'], q: 'O nome visível de cada campo está ligado ao campo no código?', s: ['Este item depende do código; a extensão confere isso automaticamente.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.9.4': { g: 'formularios', t: ['rótulo'], q: 'O nome de cada campo deixa claro qual informação deve ser preenchida?', s: ['Leia o nome de cada campo.', 'Responda “Não” se algum for vago, como “Campo 1”.'] },
  '5.9.5': { g: 'formularios', q: 'As dicas de preenchimento ficam sempre no mesmo lugar em relação aos campos?', s: ['Observe onde aparecem as instruções de preenchimento.'] },
  '5.9.6': { g: 'codigo', tech: true, q: 'Campos relacionados (como dia, mês e ano) estão agrupados no código?', s: ['Este item depende do código.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.9.7': { g: 'formularios', q: 'Os campos obrigatórios estão identificados de um jeito que todos percebam (por exemplo, a palavra “obrigatório”, e não só a cor)?', s: ['Procure a marcação de campos obrigatórios.', 'Responda “Não” se a indicação for só por cor ou não existir.'] },
  '5.9.8': { g: 'codigo', tech: true, q: 'Os campos de dados pessoais (nome, e-mail, telefone) informam o tipo de dado no código, para permitir o preenchimento automático?', s: ['Este item depende do código.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.9.9': { g: 'formularios', q: 'Quando há erro no preenchimento, a mensagem diz em texto qual é o erro e em qual campo?', s: ['Tente enviar o formulário vazio ou com um e-mail inválido, sem dados reais.', 'Veja se a mensagem explica o erro e indica o campo.'] },
  '5.9.10': { g: 'formularios', q: 'As mensagens de erro sugerem como corrigir (por exemplo, “use o formato nome@dominio.com”)?', s: ['Provoque um erro de preenchimento, sem dados reais.', 'Veja se a mensagem sugere a correção.'] },
  '5.9.11': { g: 'formularios', q: 'Antes de enviar, dá para revisar, corrigir ou cancelar os dados?', s: ['Percorra o formulário até antes do envio.', 'Veja se há etapa de conferência ou forma de desfazer.'] },
  '5.9.12': { g: 'formularios', q: 'Em formulários importantes (compras, contratos, dados financeiros), dá para revisar, corrigir ou cancelar antes de concluir?', s: ['Percorra o processo até antes da confirmação final, sem concluir.', 'Veja se há revisão, correção ou cancelamento.'] },
  '5.9.13': { g: 'formularios', q: 'O formulário oferece instruções ou dicas que ajudam a preencher?', s: ['Procure textos de ajuda junto dos campos.'] },
  '5.9.14': { g: 'formularios', q: 'Cada formulário tem um botão para enviar os dados?', s: ['Procure o botão de envio do formulário.'] },
  '5.9.15': { g: 'formularios', q: 'O site evita pedir de novo informações que você já digitou no mesmo processo?', s: ['Percorra o processo, sem dados reais.', 'Responda “Não” se o mesmo dado for pedido duas vezes sem preenchimento automático ou opção de escolha.'] },
  '5.9.16': { g: 'formularios', q: 'Verificações que exigem ver, ouvir ou fazer um movimento têm uma alternativa?', s: ['Procure verificações como “arraste a peça” ou “digite as letras da imagem”.', 'Veja se há outra opção, como áudio ou verificação por e-mail. Se não houver verificação, responda “Não existe nesta página”.'] },
  '5.9.17': { g: 'formularios', q: 'Para entrar na conta, o site não exige memorizar, transcrever ou resolver algo (ou oferece alternativa)?', s: ['Veja a tela de entrada, sem usar senha real.', 'Se não houver entrada em conta, responda “Não existe nesta página”.'] },
  '5.9.18': { g: 'formularios', q: 'Para entrar na conta, o site permite colar a senha, usar gerenciador de senhas ou outra forma que não exija memorizar ou transcrever?', s: ['Veja a tela de entrada, sem usar senha real.', 'Se não houver entrada em conta, responda “Não existe nesta página”.'] },
  '5.10.1': { g: 'cores', q: 'As instruções da página funcionam sem depender só de cor, forma ou posição (por exemplo, “clique no botão verde”)?', s: ['Leia as instruções da página.', 'Responda “Não” se alguma só puder ser entendida vendo cor, forma ou posição.'] },
  '5.10.2': { g: 'estrutura', q: 'A ordem em que as coisas aparecem na tela faz sentido para ler e usar a página?', s: ['Leia a página de cima para baixo.', 'Responda “Não” se a ordem confundir o significado.'] },
  '5.10.3': { g: 'texto', q: 'A página funciona tanto com a tela em pé quanto deitada?', s: ['No celular, gire a tela; no computador, esta verificação costuma não se aplicar.', 'Responda “Não” se a página obrigar uma única posição sem necessidade.'] },
  '5.10.4': { g: 'texto', aid: 'reflow', q: 'Na largura de uma tela de celular, dá para ler tudo e usar todas as funções sem rolar para os lados?', s: ['Use “Ver como celular (320 px)”.', 'Leia o texto e veja se precisa rolar para a direita para ler uma linha, ou se algo sumiu.', 'Depois use “Voltar ao normal”.'] },
  '5.10.5': { g: 'teclado', aid: 'tab', t: ['foco'], q: 'A marca de seleção do teclado é bem visível, contornando o item inteiro (recomendação)?', s: ['Aperte Tab e observe a marca de seleção.'] },
  '5.11.1': { g: 'cores', aid: 'grayscale', q: 'A página usa outro sinal além da cor para transmitir informação (texto, ícone, sublinhado)?', s: ['Procure informações dadas por cor: links, campos com erro, legendas de gráfico.', 'Responda “Não” se a informação se perder sem a cor.'] },
  '5.11.2': { g: 'cores', t: ['contraste'], q: 'O texto tem contraste reforçado em relação ao fundo (recomendação: 7 para 1)?', s: ['A extensão mede o contraste automaticamente; veja a pista acima.', 'Esta é uma recomendação. O mínimo obrigatório está no item 5.11.3.'] },
  '5.11.3': { g: 'cores', t: ['contraste'], q: 'O texto tem contraste suficiente em relação ao fundo para ser lido com facilidade?', s: ['Veja a medição da extensão na pista acima. O mínimo é 4,5 para 1 em texto comum e 3 para 1 em texto grande.', 'Use “Mostrar na página” e confira se o trecho é mesmo texto (e não logotipo ou texto desativado, que são exceções).'] },
  '5.11.4': { g: 'cores', t: ['contraste'], q: 'Bordas de campos, botões e caixas de seleção se destacam do fundo o suficiente para serem vistas?', s: ['Observe os contornos dos campos e botões.', 'Responda “Não” se algum controle quase desaparecer no fundo.'] },
  '5.11.5': { g: 'cores', t: ['contraste'], q: 'Ícones e partes de gráficos necessários para entender a página se destacam do fundo?', s: ['Observe ícones, gráficos e mapas.', 'Responda “Não” se partes importantes quase desaparecerem.'] },
  '5.11.6': { g: 'cores', aid: 'tab', t: ['foco', 'contraste'], q: 'A marca de seleção do teclado se destaca do fundo o suficiente para ser vista?', s: ['Aperte Tab e observe a marca de seleção.', 'Responda “Não” se ela for muito clara ou fraca.'] },
  '5.12.1': { g: 'texto', aid: 'spacing', q: 'Com o espaçamento de leitura aumentado, todo o texto continua visível, sem cortes nem sobreposições?', s: ['Use “Aplicar espaçamento de leitura”.', 'Percorra a página procurando textos cortados ou sobrepostos.', 'Depois use “Voltar ao normal”.'] },
  '5.12.2': { g: 'texto', aid: 'spacing', q: 'Com o espaço entre parágrafos aumentado, o conteúdo continua inteiro e legível?', s: ['Use “Aplicar espaçamento de leitura”.', 'Procure textos cortados ou sobrepostos e depois use “Voltar ao normal”.'] },
  '5.12.3': { g: 'texto', aid: 'spacing', q: 'Com o espaço entre letras aumentado, o texto continua inteiro, sem cortes?', s: ['Use “Aplicar espaçamento de leitura”.', 'Procure palavras cortadas em botões e menus e depois use “Voltar ao normal”.'] },
  '5.12.4': { g: 'texto', aid: 'spacing', q: 'Com o espaço entre palavras aumentado, o texto continua inteiro, sem cortes?', s: ['Use “Aplicar espaçamento de leitura”.', 'Procure textos cortados e depois use “Voltar ao normal”.'] },
  '5.12.5': { g: 'texto', q: 'Os blocos de texto estão alinhados à esquerda (e não justificados nem centralizados)?', s: ['Observe os parágrafos longos.'] },
  '5.12.6': { g: 'texto', q: 'As linhas dos parágrafos são curtas o bastante para ler com conforto (até cerca de 80 caracteres), ou há opção de ajustar?', s: ['Observe os parágrafos longos numa janela grande.'] },
  '5.12.7': { g: 'texto', aid: 'zoom', t: ['zoom'], q: 'Com a página ampliada a 200%, o texto fica maior sem sumir, cortar ou exigir rolar para os lados?', s: ['Use “Ampliar para 200%” (ou aperte Ctrl e + no Windows, Cmd e + no Mac, até 200%).', 'Leia a página e veja se algo sumiu, ficou sobreposto ou exige rolar para os lados.', 'Depois use “Voltar ao normal”.'] },
  '5.12.8': { g: 'codigo', tech: true, q: 'Trechos especiais (citações, ênfases, siglas) estão marcados como tais no código?', s: ['Este item depende do código.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.12.9': { g: 'texto', q: 'Destaques como itálico, negrito e citações são usados só para dar ênfase ou citar, e não como enfeite?', s: ['Observe os trechos destacados.'] },
  '5.12.10': { g: 'texto', q: 'Palavras incomuns, jargões ou expressões têm explicação disponível?', s: ['Procure termos técnicos ou expressões pouco conhecidas.', 'Veja se há explicação no texto, num glossário ou num link.'] },
  '5.12.11': { g: 'texto', q: 'Siglas e abreviaturas têm o significado disponível?', s: ['Procure siglas como “CDC” ou “SAC”.', 'Veja se o significado aparece na primeira vez ou num glossário.'] },
  '5.12.12': { g: 'texto', q: 'O texto usa linguagem simples e clara, ou oferece uma versão simplificada?', s: ['Leia os textos principais da página.'] },
  '5.12.13': { g: 'texto', q: 'Palavras cuja pronúncia muda o sentido têm a pronúncia indicada?', s: ['Situação rara. Se não houver palavras assim, responda “Não existe nesta página”.'] },
  '5.13.1': { g: 'pagina', q: 'O título que aparece na aba do navegador identifica esta página (e não é igual ao de outras páginas do site)?', s: ['Olhe o nome escrito na aba do navegador da página auditada (passe o mouse sobre a aba para ler inteiro).', 'Responda “Não” se o título for vazio, genérico (como “Início” ou só o nome do site) ou não corresponder ao conteúdo.'] },
  '5.13.2': { g: 'codigo', tech: true, q: 'O idioma principal da página (português) está declarado no código?', s: ['Este item depende do código; a extensão confere se a declaração existe e é válida.', 'Sem apoio técnico, use a pista da extensão ou responda “Não consegui verificar”.'] },
  '5.13.3': { g: 'pagina', q: 'Trechos em outro idioma (por exemplo, uma frase em inglês) estão identificados para o leitor de tela pronunciar corretamente?', s: ['Procure trechos em outra língua.', 'Se não houver, responda “Não existe nesta página”. Se houver, a verificação depende do código.'] },
  '5.13.4': { g: 'codigo', tech: true, q: 'Cada quadro incorporado (vídeo, mapa, formulário de outro site) tem um título que o identifica?', s: ['Este item depende do código.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.13.5': { g: 'pagina', aid: 'zoom', t: ['zoom'], q: 'A página deixa ampliar (dar zoom) normalmente?', s: ['Use “Ampliar para 200%” ou aperte Ctrl e + (Cmd e + no Mac).', 'Responda “Não” se a página impedir a ampliação. A pista acima diz se o código tenta bloquear o zoom, o que afeta principalmente celulares.', 'Depois use “Voltar ao normal”.'] },
  '5.13.6': { g: 'codigo', tech: true, q: 'A ordem dos elementos no código faz sentido para quem usa leitor de tela?', s: ['Este item depende do código. Use “Conferir leitura por Tab” no painel para uma aproximação.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.13.7': { g: 'botoes', t: ['nome acessível'], q: 'O nome anunciado para este controle contém o texto que aparece nele?', s: ['Compare o texto visível do controle com o nome lido pela extensão.', 'Responda “Não” se o nome anunciado for diferente do texto visível.'] },
  '5.13.8': { g: 'codigo', tech: true, q: 'Mensagens de aviso (como “item adicionado ao carrinho”) são anunciadas pelo leitor de tela sem precisar procurá-las?', s: ['Este item depende do código.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.13.9': { g: 'codigo', tech: true, q: 'A finalidade de controles, ícones e regiões está identificada no código?', s: ['Este item depende do código.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.13.10': { g: 'botoes', t: ['nome acessível'], q: 'Este controle tem um nome que o leitor de tela consegue anunciar?', s: ['Veja o nome lido pela extensão.', 'Responda “Não” se ele estiver vazio, como num botão só com ícone.'] },
  '5.13.11': { g: 'codigo', tech: true, q: 'Os controles usam os elementos padrão do navegador (botão, link, campo)?', s: ['Este item depende do código.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.13.12': { g: 'codigo', tech: true, t: ['componente customizado'], q: 'Os controles criados pelo próprio site informam ao leitor de tela o que são e em que estado estão?', s: ['Este item depende do código.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.13.13': { g: 'codigo', tech: true, t: ['componente customizado'], q: 'Os estados que a pessoa muda (marcado, aberto, valor) são informados no código?', s: ['Este item depende do código.', 'Sem apoio técnico, responda “Não consegui verificar”.'] },
  '5.14.1': { g: 'midia', q: 'Os áudios gravados têm uma transcrição em texto?', s: ['Procure o texto do áudio perto do player ou num link.'] },
  '5.14.2': { g: 'midia', t: ['legendas'], q: 'Os vídeos com som têm legendas que mostram as falas e os sons importantes?', s: ['Abra o vídeo e procure o botão de legendas (CC).', 'Ative e veja se as falas aparecem escritas.'] },
  '5.14.3': { g: 'midia', q: 'Os vídeos têm transcrição em texto do que se vê e se ouve?', s: ['Procure uma transcrição perto do vídeo ou num link.'] },
  '5.14.4': { g: 'midia', t: ['audiodescrição'], q: 'Os vídeos têm audiodescrição (narração do que aparece na imagem), quando a imagem traz informação que o som não diz?', s: ['Assista a um trecho do vídeo de olhos fechados.', 'Se perder informação importante, procure a versão com audiodescrição.'] },
  '5.14.5': { g: 'midia', t: ['audiodescrição'], q: 'Se as pausas do vídeo não bastam para a audiodescrição, há uma versão estendida?', s: ['Esta é uma recomendação para vídeos com pouca pausa na fala.'] },
  '5.14.6': { g: 'midia', t: ['libras'], q: 'Os vídeos com fala têm janela de Libras?', s: ['Veja se há intérprete de Libras no vídeo ou uma versão com Libras.'] },
  '5.14.7': { g: 'midia', q: 'Se algum som toca sozinho por mais de 3 segundos, dá para pausar ou baixar o volume?', s: ['Abra a página e escute.', 'Se nada tocar sozinho, responda “Não existe nesta página”.'] },
  '5.14.8': { g: 'midia', q: 'As falas gravadas estão livres de música ou ruído de fundo que atrapalhe?', s: ['Ouça um trecho do áudio ou vídeo.'] },
  '5.14.9': { g: 'midia', t: ['legendas'], q: 'Transmissões ao vivo têm legendas?', s: ['Se não houver transmissão ao vivo, responda “Não existe nesta página”.'] },
  '5.14.10': { g: 'midia', q: 'Áudios ao vivo têm transcrição?', s: ['Se não houver áudio ao vivo, responda “Não existe nesta página”.'] },
  '5.15.1': { g: 'midia', q: 'Animações e carrosséis que se movem sozinhos por mais de 5 segundos podem ser pausados ou parados?', s: ['Observe banners e carrosséis que mudam sozinhos.', 'Procure um botão de pausa.'] },
  '5.15.2': { g: 'midia', q: 'Animações que acontecem ao rolar ou clicar podem ser desligadas?', s: ['Role a página e veja se elementos se movem.', 'Se não houver animações assim, responda “Não existe nesta página”.'] },
  '5.15.3': { g: 'midia', q: 'Nada na página pisca mais de três vezes por segundo?', s: ['Não fique olhando para flashes. Observe de relance.', 'Se houver dúvida, peça análise técnica.'] },
  '5.15.4': { g: 'midia', q: 'Se algo pisca, o piscar é fraco o bastante para não oferecer risco a pessoas sensíveis?', s: ['Não fique olhando para flashes.', 'Esta verificação exige análise técnica; sem ela, responda “Não consegui verificar”.'] },
  '5.16.1': { g: 'tempo', q: 'A página evita limites de tempo que não sejam essenciais?', s: ['Veja se há contagens regressivas ou prazos para concluir uma tarefa.'] },
  '5.16.2': { g: 'tempo', q: 'Se há limite de tempo, dá para desligá-lo, ajustá-lo ou pedir mais tempo antes que acabe?', s: ['Procure avisos de sessão expirando ou contagens regressivas.', 'Se não houver limite de tempo, responda “Não existe nesta página”.'] },
  '5.16.3': { g: 'tempo', q: 'Conteúdos que se atualizam sozinhos (placares, cotações, notícias) podem ser pausados?', s: ['Observe se algo muda sozinho na página.', 'Se nada se atualizar sozinho, responda “Não existe nesta página”.'] },
  '5.16.4': { g: 'tempo', q: 'As interrupções (janelas que surgem, avisos) podem ser adiadas ou desligadas?', s: ['Use a página por alguns minutos e veja se surgem janelas ou avisos.'] },
  '5.16.5': { g: 'tempo', q: 'Se a sessão expira, depois de entrar de novo os dados já preenchidos continuam lá?', s: ['Situação que exige conta e tempo de espera. Sem isso, responda “Não consegui verificar”.'] },
  '5.16.6': { g: 'tempo', q: 'Se há perda de dados por inatividade, o site avisa antes?', s: ['Veja se a página informa o tempo máximo sem uso antes de perder dados.'] },
};

const AID_LABELS = Object.freeze({
  tab: 'Percorrer com Tab',
  zoom: 'Ampliar para 200%',
  reflow: 'Ver como celular (320 px)',
  spacing: 'Aplicar espaçamento de leitura',
  grayscale: 'Ver em tons de cinza',
});
export const PAGE_AIDS = Object.freeze({ zoom: 'zoom-200', reflow: 'reflow-320', spacing: 'text-spacing' });
export const PAGE_AID_DESCRIPTIONS = Object.freeze({
  'zoom-200': 'ampliação de 200% no navegador',
  'reflow-320': 'largura equivalente a 320 pixels (tela de celular)',
  'text-spacing': 'espaçamento de leitura (linhas 1,5; parágrafos 2; letras 0,12; palavras 0,16 vez a fonte)',
});

export function aidLabel(aid) { return AID_LABELS[aid] ?? null; }

/** Guia leigo do item. Itens sem roteiro próprio recebem uma pergunta honesta a partir do título. */
export function layGuideFor(itemId) {
  const item = ITEM_BY_ID.get(itemId);
  const guide = GUIDES[itemId];
  if (!item) return null;
  if (!guide) {
    return Object.freeze({
      itemId, group: 'codigo', question: `A página atende a “${item.title}”?`,
      steps: Object.freeze(['Sem roteiro próprio. Se não tiver apoio técnico, responda “Não consegui verificar”.']),
      aid: null, technical: true, terms: Object.freeze([]),
    });
  }
  return Object.freeze({
    itemId, group: guide.g, question: guide.q, steps: Object.freeze([...guide.s]), aid: guide.aid ?? null,
    technical: guide.tech === true, terms: Object.freeze([...(guide.t ?? [])]),
  });
}

export function layGroupFor(itemId) {
  return layGuideFor(itemId)?.group ?? 'codigo';
}

export function compareItemIds(left, right) {
  const a = String(left).split('.').map(Number);
  const b = String(right).split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? -1) - (b[index] ?? -1);
    if (difference !== 0) return Number.isFinite(difference) ? difference : 0;
  }
  return 0;
}

const ROLE_WORDS = Object.freeze({
  button: 'botão', link: 'link', heading: 'título', img: 'imagem', image: 'imagem', textbox: 'campo de texto',
  searchbox: 'campo de busca', checkbox: 'caixa de seleção', radio: 'botão de opção', combobox: 'lista de opções',
  listbox: 'lista de opções', option: 'opção', slider: 'controle deslizante', spinbutton: 'campo numérico',
  switch: 'interruptor', tab: 'aba', menuitem: 'item de menu', navigation: 'menu de navegação',
  main: 'conteúdo principal', banner: 'cabeçalho da página', contentinfo: 'rodapé', list: 'lista',
  table: 'tabela', layouttable: 'tabela', video: 'vídeo', audio: 'áudio', dialog: 'janela', form: 'formulário',
  paragraph: 'parágrafo', region: 'região', generic: 'bloco', StaticText: 'texto',
});
const TAG_WORDS = Object.freeze({
  img: 'imagem', svg: 'imagem', a: 'link', button: 'botão', input: 'campo', select: 'lista de opções',
  textarea: 'campo de texto', video: 'vídeo', audio: 'áudio', table: 'tabela', iframe: 'quadro incorporado',
  meta: 'configuração da página', div: 'bloco', span: 'trecho', p: 'parágrafo', header: 'cabeçalho da página',
  footer: 'rodapé', nav: 'menu de navegação', form: 'formulário', h1: 'título', h2: 'título', h3: 'título',
});

const FEMININE_WORDS = new Set([
  'imagem', 'lista de opções', 'caixa de seleção', 'opção', 'aba', 'tabela', 'região', 'janela',
  'configuração da página', 'lista', 'caixa de combinação',
]);

/** "ao link “Saiba mais”" ou "à imagem sem nome", para frases de constatação. */
export function withArticle(element) {
  if (!element?.label) return 'à página';
  return `${FEMININE_WORDS.has(element.roleWord) ? 'à' : 'ao'} ${element.label}`;
}

function snippetTag(snippet) {
  const match = typeof snippet === 'string' ? /^\s*<([a-zA-Z][a-zA-Z0-9-]*)/u.exec(snippet) : null;
  return match ? match[1].toLowerCase() : '';
}

function snippetAttribute(snippet, name) {
  if (typeof snippet !== 'string') return null;
  const open = /^\s*<[^>]*>/u.exec(snippet)?.[0] ?? '';
  const pattern = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu');
  const match = pattern.exec(open);
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? '';
}

function shortText(value, maximum = 80) {
  const text = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

/** Fatos sobre o elemento, lidos da evidência registrada, em linguagem simples. */
export function describeEvidenceElement(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  const accessibility = evidence.accessibility && typeof evidence.accessibility === 'object' ? evidence.accessibility : {};
  const tag = snippetTag(evidence.snippet);
  const roleWord = ROLE_WORDS[accessibility.role] ?? TAG_WORDS[tag] ?? 'elemento';
  const name = shortText(accessibility.name);
  const visibleText = shortText(accessibility.visibleText);
  const altAttribute = ['img', 'area'].includes(tag) || (tag === 'input' && snippetAttribute(evidence.snippet, 'type') === 'image')
    ? snippetAttribute(evidence.snippet, 'alt') : undefined;
  const isImage = ['img', 'svg', 'area'].includes(tag) || ['img', 'image'].includes(accessibility.role);
  const label = name ? `${roleWord} “${name}”` : visibleText ? `${roleWord} com o texto “${visibleText}”` : `${roleWord} sem nome`;
  const ariaHidden = snippetAttribute(evidence.snippet, 'aria-hidden') === 'true';
  const explicitRole = (snippetAttribute(evidence.snippet, 'role') ?? '').toLowerCase();
  return Object.freeze({
    tag, roleWord, name, visibleText, label, isImage,
    // O nome só conta como observado quando a evidência trouxe o registro de acessibilidade.
    nameObserved: typeof accessibility.nameSource === 'string',
    ignored: ariaHidden || ['none', 'presentation'].includes(explicitRole) || ['none', 'presentation'].includes(accessibility.role),
    // undefined: não é imagem nativa; null: atributo ausente; '': texto alternativo vazio.
    altAttribute,
    usemap: isImage && snippetAttribute(evidence.snippet, 'usemap') !== null,
  });
}

function ratio(value) {
  if (!Number.isFinite(value)) return null;
  return `${value.toFixed(2).replace(/\.?0+$/u, '').replace('.', ',')}:1`;
}

/** Pista concreta do motor sobre a ocorrência, em linguagem simples. */
export function layHint(target) {
  const data = target?.data && typeof target.data === 'object' ? target.data : {};
  const reason = typeof data.reason === 'string' ? data.reason : '';
  switch (reason) {
    case 'zoom-restricted': return 'O código da página contém uma instrução que tenta impedir a ampliação (zoom), o que afeta principalmente celulares.';
    case 'unknown-image-purpose': return 'A extensão não consegue saber sozinha para que serve esta imagem. Sua resposta decide quais itens se aplicam.';
    case 'verify-alternative-quality': return 'A imagem tem texto alternativo. Confira se ele descreve o que a imagem mostra ou faz.';
    case 'insufficient-text-contrast':
    case 'insufficient-non-text-contrast': {
      const measured = ratio(data.ratio);
      const minimum = ratio(data.threshold);
      return measured && minimum
        ? `A extensão mediu contraste de ${measured}, abaixo do mínimo de ${minimum} exigido para este caso.`
        : 'A extensão mediu contraste abaixo do mínimo para este caso.';
    }
    case 'generic-link-purpose': return 'O texto do link é genérico, como “saiba mais” ou “clique aqui”.';
    case 'target-too-small': {
      const width = Number.isFinite(data.width) ? Math.round(data.width) : null;
      const height = Number.isFinite(data.height) ? Math.round(data.height) : null;
      return width && height
        ? `A área de clique medida é de ${width} × ${height} pixels; o mínimo é 24 × 24, salvo espaço livre em volta.`
        : 'A área de clique parece menor que 24 × 24 pixels.';
    }
    case 'missing-accessible-name': return 'O elemento não tem nome que o leitor de tela possa anunciar.';
    case 'placeholder-text': return 'O campo parece usar só o texto de exemplo (que some ao digitar) como nome.';
    case 'missing-page-title': return 'A página não tem título.';
    case 'invalid-page-language': return 'O idioma declarado no código está ausente ou é inválido.';
    case 'invalid-part-language': return 'Há um trecho com idioma declarado de forma inválida.';
    case 'heading-level-skip': return 'Os títulos pulam níveis (por exemplo, do nível 1 direto para o 3).';
    case 'multiple-main-headings': return 'Há mais de um título principal (nível 1).';
    case 'missing-main-heading': return 'Não foi encontrado título principal (nível 1).';
    case 'missing-new-window-warning': return 'O link abre outra aba ou janela sem avisar.';
    case 'focus-indicator-not-visible': return 'Ao receber a seleção do teclado, o elemento não mostrou destaque visível.';
    case 'captions-not-determined':
    case 'missing-captions-observation': return 'A extensão não conseguiu confirmar se o vídeo tem legendas.';
    case 'orientation-restricted': return 'A página parece restringir a orientação da tela.';
    case 'two-dimensional-scroll': return 'Em tela estreita, apareceu rolagem para os lados e para baixo ao mesmo tempo.';
    case 'missing-required-identification': return 'Há campo obrigatório sem identificação perceptível.';
    case 'missing-association': return 'O nome visível do campo não está ligado a ele no código.';
    case 'visible-label-not-in-name': return 'O nome anunciado não contém o texto visível do controle.';
    case 'missing-autoplay-audio-control': return 'Há som que toca sozinho sem controle aparente.';
    case 'missing-animation-control': return 'Há animação sem controle aparente para pausar.';
    case 'missing-frame-title': return 'Há quadro incorporado sem título.';
    case 'missing-submit-button': return 'O formulário parece não ter botão de envio.';
    default: return null;
  }
}

/** Data e hora no fuso registrado pela auditoria, com o deslocamento explícito. */
export function formatLocalInstant(iso, timeZone) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return String(iso ?? '');
  let zone = typeof timeZone === 'string' && timeZone ? timeZone : 'UTC';
  let parts;
  try {
    parts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
    }).formatToParts(date);
  } catch {
    zone = 'UTC';
    parts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
    }).formatToParts(date);
  }
  const part = type => parts.find(value => value.type === type)?.value ?? '';
  const offset = part('timeZoneName').replace(/^GMT/u, 'UTC').replace('-', '−') || 'UTC';
  const clock = `${part('day')}/${part('month')}/${part('year')}, ${part('hour')}:${part('minute')}:${part('second')}`;
  return zone === 'UTC' ? `${clock} (UTC)` : `${clock} (${zone}, ${offset})`;
}

/** Rascunho editável da constatação para uma resposta "não atende". */
export function draftFinding({ itemId, element, hint, aid, aids } = {}) {
  const item = ITEM_BY_ID.get(itemId);
  const subject = withArticle(element);
  const used = [...(aids ?? []), ...(aid ? [aid] : [])].filter(value => PAGE_AID_DESCRIPTIONS[value]);
  const aidText = used.length ? ` Verificação feita com ${used.map(value => PAGE_AID_DESCRIPTIONS[value]).join(' e ')}.` : '';
  const specific = {
    '5.2.1': 'a imagem transmite informação, mas não há texto alternativo que a descreva',
    '5.2.2': 'a imagem funciona como botão ou link, mas o texto alternativo não descreve a função',
    '5.2.3': 'a imagem é decorativa, mas não está marcada para ser ignorada pelo leitor de tela',
    '5.7.3': 'o texto do link, sozinho, não indica o destino',
    '5.7.4': 'nem o texto do link nem o contexto em volta indicam o destino',
    '5.8.3': 'o botão não tem nome que indique sua função',
    '5.9.1': 'o campo não tem nome visível que identifique o que preencher',
    '5.11.3': 'o texto não tem contraste suficiente com o fundo',
    '5.12.7': 'com a página ampliada a 200%, houve perda de conteúdo ou necessidade de rolar para os lados',
    '5.13.1': 'o título da página não a identifica',
    '5.13.5': 'a página impede a ampliação (zoom)',
    '5.13.10': 'o controle não tem nome que o leitor de tela possa anunciar',
    '5.1.13': 'há função que não pode ser usada só com o teclado',
    '5.1.1': 'em algum ponto não é possível ver qual item está selecionado pelo teclado',
    '5.10.4': 'em largura de celular, houve perda de conteúdo ou necessidade de rolar para os lados',
  }[itemId];
  const body = specific
    ? `Constatei, em relação ${subject}, que ${specific}.`
    : `Constatei, em relação ${subject}, que não é atendido o item ${itemId}${item ? ` (${item.title})` : ''}.`;
  return `${body}${hint ? ` ${hint}` : ''}${aidText}`.trim();
}

// ---- Imagens: uma pergunta resolve os itens 5.2.1 a 5.2.6 ----

export const IMAGE_PURPOSES = Object.freeze([
  Object.freeze({ id: 'conteudo', label: 'Mostra informação ou conteúdo', example: 'foto de produto, ilustração de uma notícia' }),
  Object.freeze({ id: 'funcional', label: 'É um botão ou link (faz algo ao clicar)', example: 'lupa de busca, logotipo que leva à página inicial' }),
  Object.freeze({ id: 'decorativa', label: 'É só enfeite', example: 'fundo, separador, ícone repetido ao lado de um texto que já diz tudo' }),
  Object.freeze({ id: 'complexa', label: 'É gráfico, mapa ou esquema com muitos dados', example: 'gráfico de preços, mapa de lojas' }),
  Object.freeze({ id: 'texto', label: 'É um texto escrito em forma de imagem', example: 'banner com frase, logotipo com nome' }),
]);

const PURPOSE_ITEMS = Object.freeze({
  conteudo: ['5.2.1'], funcional: ['5.2.2'], decorativa: ['5.2.3'], complexa: ['5.2.1', '5.2.4'], texto: ['5.2.1', '5.2.5'],
});

/**
 * Converte a finalidade escolhida e o texto alternativo observado em perguntas e conclusões.
 * Retorna, por item, uma conclusão já definida ('conforme', 'não conforme', 'não se aplica') ou a
 * pergunta de acompanhamento que a pessoa ainda precisa responder.
 */
export function imagePlan({ purpose, element } = {}) {
  const relevant = new Set(PURPOSE_ITEMS[purpose] ?? []);
  const alt = element?.altAttribute;
  const name = element?.name ?? '';
  // Só conclui sozinho o que a evidência mostrou: o atributo alt no código ou o nome lido na árvore de
  // acessibilidade. Sem isso, pergunta (e aceita "Não sei"), em vez de presumir que falta texto.
  const observed = Boolean(element) && (element.nameObserved === true || alt !== undefined);
  const textValue = name || (typeof alt === 'string' ? alt.trim() : '');
  const marksDecorative = !name && (alt === '' || element?.ignored === true);
  const unknown = ' (A extensão não conseguiu ler o texto alternativo. Use “Mostrar na página”; se não souber, responda “Não sei”.)';
  const plan = {};
  for (const itemId of ['5.2.1', '5.2.2', '5.2.3', '5.2.4', '5.2.5', '5.2.6']) {
    if (itemId === '5.2.6') {
      plan[itemId] = element?.usemap
        ? { followUp: 'Cada área clicável desta imagem tem texto alternativo próprio?' }
        : { answer: 'não se aplica', reason: 'a imagem não é um mapa de imagem' };
      continue;
    }
    if (!relevant.has(itemId)) {
      plan[itemId] = { answer: 'não se aplica', reason: 'a finalidade escolhida não corresponde a este item' };
      continue;
    }
    if (itemId === '5.2.3') {
      if (observed && marksDecorative) plan[itemId] = { answer: 'conforme', reason: 'a imagem decorativa está marcada para ser ignorada pelo leitor de tela' };
      else if (observed && textValue) plan[itemId] = { answer: 'não conforme', reason: `a imagem decorativa é anunciada como “${textValue}”` };
      else if (observed && element.tag === 'img' && alt === null) plan[itemId] = { answer: 'não conforme', reason: 'a imagem decorativa não tem texto alternativo vazio, então o leitor de tela pode anunciá-la' };
      else plan[itemId] = { followUp: `Esta imagem está marcada para o leitor de tela ignorá-la?${unknown}` };
      continue;
    }
    if (itemId === '5.2.4') {
      plan[itemId] = { followUp: 'Há uma descrição completa desta imagem perto dela ou num link indicado?' };
      continue;
    }
    if (itemId === '5.2.5') {
      plan[itemId] = { followUp: 'O texto desta imagem é um logotipo ou marca (ou precisa mesmo estar em imagem) e o texto alternativo repete o que está escrito?' };
      continue;
    }
    const functional = itemId === '5.2.2';
    if (!observed) {
      plan[itemId] = { followUp: `${functional ? 'Esta imagem tem um texto alternativo que diz o que acontece ao clicar nela?' : 'Esta imagem tem um texto alternativo que descreve a informação que ela transmite?'}${unknown}` };
    } else if (textValue) {
      plan[itemId] = { followUp: functional
        ? `O texto alternativo “${textValue}” diz o que acontece ao clicar na imagem?`
        : `O texto alternativo “${textValue}” descreve a informação que a imagem transmite?` };
    } else if (marksDecorative) {
      plan[itemId] = { answer: 'não conforme', reason: functional
        ? 'a imagem está marcada como enfeite (texto alternativo vazio), mas funciona como botão ou link'
        : 'a imagem está marcada como enfeite (texto alternativo vazio), mas transmite informação' };
    } else {
      plan[itemId] = { answer: 'não conforme', reason: 'a imagem não tem texto alternativo' };
    }
  }
  return Object.freeze(plan);
}

export function imageFindingText({ itemId, element, reason, withItem = false } = {}) {
  return `Constatei, em relação ${element?.label ? withArticle(element) : 'à imagem'}, que ${reason}${withItem ? ` (item ${itemId})` : ''}.`;
}

// ---- Plano da revisão guiada ----

const DOCUMENT_TAGS = new Set(['meta', 'html', 'head', 'title', 'body']);

// Algumas pistas valem só para parte dos itens que a mesma regra alimenta.
const HINT_ITEMS = Object.freeze({
  'generic-link-purpose': new Set(['5.7.3', '5.7.4']),
});

function hintAppliesTo(target, itemId) {
  const reason = target?.data?.reason;
  const items = typeof reason === 'string' ? HINT_ITEMS[reason] : undefined;
  return !items || items.has(itemId);
}

function evidenceForOccurrence(occurrence, evidenceById) {
  const refs = Array.isArray(occurrence?.evidenceRefs) ? occurrence.evidenceRefs : [];
  const all = refs.map(id => evidenceById.get(id)).filter(Boolean);
  const nodeId = occurrence?.target?.nodeId;
  return all.find(value => value.kind === 'element' && value.nodeId === nodeId) ??
    all.find(value => value.kind === 'element') ?? null;
}

function targetFor(occurrence, ruleById) {
  const rule = ruleById.get(occurrence?.source?.ruleId ?? occurrence?.ruleId);
  const nodeId = occurrence?.target?.nodeId;
  if (!rule || !Array.isArray(rule.targets)) return null;
  return rule.targets.find(target => target?.nodeId === nodeId) ??
    (rule.targets.length === 1 ? rule.targets[0] : null);
}

/**
 * Agrupa a fila de revisão em cartões por elemento (ou por item, quando a pergunta é sobre a página),
 * com requisitos antes de recomendações. Inclui entradas já respondidas, para permitir rever.
 */
export function buildLayReviewPlan(model) {
  const occurrenceById = new Map((model?.occurrences ?? []).map(value => [value.occurrenceId, value]));
  const itemById = new Map((model?.itemResults ?? []).map(value => [value.id, value]));
  const evidenceById = new Map((model?.evidence ?? []).map(value => [value.evidenceId, value]));
  const ruleById = new Map((model?.ruleResults ?? []).map(value => [value.ruleId, value]));
  const decisionByOccurrence = new Map((model?.reviewDecisions ?? []).map(value => [value.occurrenceId, value]));
  const failedByNodeItem = new Set((model?.occurrences ?? [])
    .filter(value => value.outcome === 'failed' && value.target?.nodeId)
    .map(value => `${value.pageId}\u0000${value.target.nodeId}\u0000${value.itemId}`));
  const cards = new Map();
  for (const entry of model?.manualReview ?? []) {
    const occurrence = occurrenceById.get(entry.occurrenceId);
    const item = itemById.get(entry.itemId);
    if (!occurrence || !item) continue;
    const nodeId = occurrence.target?.nodeId;
    const candidate = typeof nodeId === 'string' && nodeId && nodeId !== 'document'
      ? evidenceForOccurrence(occurrence, evidenceById) : null;
    const candidateElement = describeEvidenceElement(candidate);
    // Configurações do documento (meta, html, head) são perguntas sobre a página inteira: juntam-se
    // à pergunta do mesmo item, em vez de virar um cartão de "elemento" que a pessoa não vê.
    const elementLevel = typeof nodeId === 'string' && nodeId && nodeId !== 'document' &&
      !DOCUMENT_TAGS.has(candidateElement?.tag ?? '');
    const evidence = elementLevel ? candidate : null;
    const element = elementLevel ? candidateElement : null;
    const key = elementLevel ? `${occurrence.pageId}|${nodeId}` : `${occurrence.pageId}|item|${item.id}`;
    let card = cards.get(key);
    if (!card) {
      card = {
        key, pageId: occurrence.pageId, nodeId: elementLevel ? nodeId : null, elementLevel, evidence, element,
        questions: new Map(), groupId: null, requirement: false, firstOccurrenceId: occurrence.occurrenceId,
      };
      cards.set(key, card);
    }
    if (!card.evidence && evidence) { card.evidence = evidence; card.element = element; }
    let question = card.questions.get(item.id);
    if (!question) {
      const guide = layGuideFor(item.id);
      question = { itemId: item.id, item, guide, entries: [], hints: [], alreadyFailed: false };
      card.questions.set(item.id, question);
    }
    const target = targetFor(occurrence, ruleById);
    const hint = hintAppliesTo(target, item.id) ? layHint(target) : null;
    if (hint && !question.hints.includes(hint)) question.hints.push(hint);
    if (elementLevel && failedByNodeItem.has(`${occurrence.pageId}\u0000${nodeId}\u0000${item.id}`)) question.alreadyFailed = true;
    question.entries.push({ entry, occurrence, decision: decisionByOccurrence.get(occurrence.occurrenceId) ?? null });
    if (item.classification === 'requirement') card.requirement = true;
  }
  const result = [];
  for (const card of cards.values()) {
    const questions = [...card.questions.values()].sort((a, b) =>
      (a.item.classification === b.item.classification ? 0 : a.item.classification === 'requirement' ? -1 : 1) ||
      compareItemIds(a.itemId, b.itemId));
    const groups = questions.map(question => question.guide?.group ?? 'codigo');
    const imageCard = card.elementLevel && Boolean(card.element) &&
      (card.element.isImage || questions.every(question => question.itemId.startsWith('5.2.')));
    const groupId = imageCard ? 'imagens' : card.elementLevel
      ? groups.find(group => group !== 'codigo') ?? groups[0]
      : groups[0];
    result.push(Object.freeze({
      ...card, groupId, imageCard, questions: Object.freeze(questions),
      answered: questions.every(question => question.entries.every(value => value.decision)),
    }));
  }
  result.sort((a, b) => (a.requirement === b.requirement ? 0 : a.requirement ? -1 : 1) ||
    (GROUP_ORDER.get(a.groupId) ?? 99) - (GROUP_ORDER.get(b.groupId) ?? 99) ||
    compareItemIds(a.questions[0]?.itemId, b.questions[0]?.itemId) ||
    a.firstOccurrenceId.localeCompare(b.firstOccurrenceId));
  return Object.freeze(result);
}

/** Progresso por classe, contado por pergunta (item × elemento), não por ocorrência técnica. */
export function layReviewProgress(cards) {
  const progress = { requirement: { total: 0, answered: 0 }, recommendation: { total: 0, answered: 0 } };
  for (const card of cards) {
    for (const question of card.questions) {
      const bucket = progress[question.item.classification] ?? null;
      if (!bucket) continue;
      bucket.total += 1;
      if (question.entries.every(value => value.decision)) bucket.answered += 1;
    }
  }
  return progress;
}
