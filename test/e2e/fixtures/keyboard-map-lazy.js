// Carga sob demanda: cada bloco novo só aparece quando a captura integral acontece — é o padrão real que
// estragava o mapa. A captura amplia a área de renderização para caber a página inteira, o site aproveita e
// carrega o que faltava, e os retângulos (medidos no instantâneo) e os pixels (capturados no instante
// seguinte) acabam sendo de estados diferentes: cada caixa cai longe do item.
//
// O gatilho é o evento `resize` que a própria captura provoca (medido: `captureBeyondViewport` encolhe a
// janela para 1×1 e devolve o tamanho depois, e cada captura entrega pelo menos um `resize`). Numa aba
// escondida o Chrome congela temporizador, `requestAnimationFrame` e animação CSS — zero blocos em 2 s com
// `setInterval` —; evento de janela continua chegando. A carga é SÍNCRONA dentro do próprio evento, de
// propósito: com `fetch`, a resposta chegava, mas a continuação só era executada na próxima vez que o
// renderizador acordasse (no encolhimento seguinte), tarde demais para a leitura da estrutura.
//
// Dois modos, escolhidos pela consulta da URL:
// - `?modo=captura` — a lista cresce UMA vez, no primeiro `resize` (o da captura de aquecimento da 1.1.60),
//   e depois fica parada. É o caso que o aquecimento resolve: a carga acontece ANTES da leitura da estrutura,
//   a página assenta, e o mapa volta a marcar — alinhado.
// - sem consulta (padrão) — a lista cresce em TODO `resize`, inclusive nos das capturas de verdade, e não
//   sobra acordo de leiaute nenhum: a captura sempre muda a altura, então o mapa sai sem caixa, com a lista
//   completa e a explicação em português. O teto de blocos existe só para a página não crescer sem limite
//   dentro do teste.
const alvo = document.getElementById('itens');
const modo = new URLSearchParams(location.search).get('modo') === 'captura' ? 'captura' : 'sem-fim';
const LIMITE_DE_BLOCOS = modo === 'captura' ? 3 : 12;
let blocos = 0;
let jaCarregou = false;

const acrescentarBloco = () => {
  if (blocos >= LIMITE_DE_BLOCOS) return;
  blocos += 1;
  const item = document.createElement('div');
  item.className = 'item grande';
  const botao = document.createElement('button');
  botao.type = 'button';
  botao.textContent = `Protocolo ${blocos}`;
  item.append(botao);
  alvo.append(item);
};

addEventListener('resize', () => {
  if (modo === 'captura') {
    if (jaCarregou) return;
    jaCarregou = true;
    for (let indice = 0; indice < 3; indice += 1) acrescentarBloco();
    return;
  }
  acrescentarBloco();
});
