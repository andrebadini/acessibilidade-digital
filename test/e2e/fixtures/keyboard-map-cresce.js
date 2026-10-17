// Página que se monta aos poucos, para provar que o mapa do teclado desenha caixa ALINHADA mesmo assim.
//
// Por que existe: até a 1.1.61 o mapa comparava a altura do documento na leitura estrutural com a altura no
// instante da captura e, quando as duas não coincidiam, desistia do mapa inteiro — nenhuma caixa desenhada.
// O aquecimento da 1.1.60 resolveu o caso em que a própria captura acorda a página, porque o conteúdo então
// chega ANTES da leitura. Sobra o caso desta página: o aviso ilustrado chega DEPOIS da leitura da estrutura.
// Desde a 1.1.62 os retângulos são medidos depois da captura, no leiaute da imagem, e o mapa volta a marcar.
//
// Como o crescimento é cronometrado (o ponto mais delicado desta fixture):
// - numa aba escondida o Chrome adia temporizador, `requestAnimationFrame`, animação e ATÉ as continuações
//   de `fetch` (medido em docs/qa/mapa-alinhado-1.1.60.md, §1); a rede, essa não é adiada;
// - sobra o evento `resize`, que é justamente o que cada captura integral provoca. O primeiro `resize` é o
//   da captura de aquecimento, e é ali que o pedido da imagem sai (síncrono, dentro do próprio evento);
// - quem segura a resposta é o servidor de teste, por `?atraso=`, e o leiaute cresce quando a imagem chega.
//   Não é preciso rodar JavaScript nesse instante: imagem sem tamanho declarado empurra o conteúdo sozinha.
// Assim o crescimento cai sempre no mesmo lugar relativo à auditoria: depois de o aquecimento assentar (a
// espera exige 1.000 ms de altura parada, contados do próprio `resize`) e durante a leitura da estrutura.
//
// Detalhe que só apareceu na medição desta fixture e vale registrar: o aviso entrando é o que devolve a
// barra de rolagem. A captura de aquecimento amplia a área de renderização e o estado alargado continua
// valendo depois dela; quem obriga a página a se rearranjar de novo é o conteúdo que chega. Ou seja, o
// crescimento medido aqui é a diferença entre a altura da carga e a altura do estado ALARGADO em que a
// imagem é tirada — e é essa diferença que o teste soma à posição de carga. Ver
// `establishWidenedLayout`, em src/background/full-page-warm-up.js.
//
// Medir posição DENTRO dos eventos seria mentira: é durante a captura que a área de renderização é ampliada
// e devolvida, e a leitura feita nesse instante não corresponde a leiaute nenhum. A única medida de posição
// confiável é a da carga, antes de tudo. O que o teste compara, então, é a posição de carga somada ao
// crescimento — e o crescimento sai da própria geometria do mapa (altura da imagem menos altura de carga) e
// do registro de marcos abaixo. Ver `test/e2e/keyboard-map-cresce-mv3.test.mjs`.
const parametros = new URLSearchParams(location.search);
const atraso = Number(parametros.get('atraso') ?? 1400);
const quantidadeDeEtiquetas = Number(parametros.get('etiquetas') ?? 1500);
// Esta página pode ser aberta duas vezes no mesmo teste (a aba inicial do Chrome e a aba da auditoria) e os
// dois carregamentos crescem em paralelo. Cada carregamento se identifica para o servidor de teste poder
// separar o que é de um e o que é do outro — sem isso, um marco de uma aba seria comparado com um marco da
// outra, e a prova de tempo não valeria nada.
const marcador = `${Math.random().toString(36).slice(2)}-${Math.round(performance.now())}`;

const novidades = document.getElementById('novidades');
const catalogo = document.getElementById('catalogo');
const controles = document.getElementById('controles');
let jaInseriu = false;
let resizes = 0;

// Catálogo comprido de propósito: são estes elementos que fazem a leitura da estrutura demorar alguns
// centésimos de segundo, e é essa demora que dá janela ao crescimento. Nenhum deles é alcançável pelo Tab.
catalogo.innerHTML = Array.from({ length: quantidadeDeEtiquetas },
  (_, indice) => `<span class="etiqueta">Serviço ${indice + 1}</span>`).join('');

/** Os cinco controles, com id e posição no documento em px CSS — a mesma medida que o mapa usa. */
function posicoesDosControles() {
  const posicoes = {};
  for (const elemento of controles.querySelectorAll('[id]')) {
    const caixa = elemento.getBoundingClientRect();
    posicoes[elemento.id] = {
      x: caixa.x + window.scrollX,
      y: caixa.y + window.scrollY,
      largura: caixa.width,
      altura: caixa.height,
    };
  }
  return posicoes;
}

// O registro sai por `fetch`: o PEDIDO sai na hora, mesmo que a resposta seja adiada como o resto. O que
// interessa é o servidor saber QUANDO cada marco aconteceu, não o que a página responde.
function registrar(motivo, extra = {}) {
  const corpo = JSON.stringify({ marcador, motivo, ...extra });
  fetch('/cresce', { method: 'POST', body: corpo, keepalive: true, headers: { 'content-type': 'application/json' } })
    .catch(() => {});
}

/** O aviso ilustrado: imagem sem largura/altura declaradas, então sem tamanho até a resposta chegar. */
function inserirAviso() {
  const aviso = document.createElement('figure');
  aviso.className = 'banner';
  const imagem = document.createElement('img');
  imagem.alt = 'Aviso ilustrado do atendimento';
  imagem.src = `/banner-lento.png?atraso=${atraso}&marcador=${encodeURIComponent(marcador)}`;
  imagem.addEventListener('load', () => registrar('imagem-chegou'));
  imagem.addEventListener('error', () => registrar('imagem-falhou'));
  aviso.append(imagem);
  novidades.append(aviso);
  registrar('aviso-inserido');
}

addEventListener('resize', () => {
  // Todo `resize` é registrado. Uma captura integral entrega MAIS DE UM (medido: dois, com ~84 ms entre
  // eles — a área de renderização é ampliada e devolvida), então contar "o primeiro" e "o segundo" seria
  // confundir a captura de aquecimento com a de verdade. Quem separa os grupos é o teste, pelas pausas
  // entre um e outro; aqui só se registra.
  resizes += 1;
  registrar('resize', { indice: resizes });
  // O primeiro `resize` de todos é o da captura de aquecimento: é agora que o pedido da imagem sai, e é
  // deste instante que passa a correr o relógio do crescimento.
  if (!jaInseriu) { jaInseriu = true; inserirAviso(); }
});

// Estado inicial: altura do documento e posição dos controles ANTES do crescimento. É a base de tudo o que
// o teste confere — daqui em diante nenhuma medida da página é confiável.
registrar('carga', { altura: document.documentElement.scrollHeight, controles: posicoesDosControles() });
