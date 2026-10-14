// CASO 10 — o carrossel troca a classe "is-active" entre os slides a cada 2 s.
// A mutação é a parte difícil da marcação na página: quando o slide ativo muda, as caixas
// desenhadas para elementos do slide anterior deixam de corresponder a qualquer coisa visível.
// Este arquivo existe para que essa condição aconteça sozinha, sem interação de quem audita.

const slides = [...document.querySelectorAll('[data-carrossel] .slide')];
const pontos = [...document.querySelectorAll('[data-carrossel] .ponto')];

let atual = 0;

function mostrar(indice) {
  atual = ((indice % slides.length) + slides.length) % slides.length;
  slides.forEach((slide, posicao) => slide.classList.toggle('is-active', posicao === atual));
  pontos.forEach((ponto, posicao) => ponto.classList.toggle('is-active', posicao === atual));
}

for (const ponto of pontos) {
  ponto.addEventListener('click', () => mostrar(Number(ponto.dataset.ir)));
}

if (slides.length > 1) setInterval(() => mostrar(atual + 1), 2000);
