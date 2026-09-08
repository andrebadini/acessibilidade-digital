// Presentation of an already validated ReportView. Never changes recorded outcomes.
const GROUPS = [
  ['errors', 'Falhas', '#9d2b18'], ['alerts', 'Recomendações e alertas', '#986000'],
  ['humanReview', 'Suspeitas a confirmar', '#bd8700'], ['positive', 'Resultados positivos', '#236b3b'],
];
export const RESULTS_OVERVIEW_CSS = `
.results-overview{display:flex;align-items:center;flex-wrap:wrap;gap:1.25rem;padding:1.1rem;margin-block:1rem;background:#f4f8fb;border:1px solid #738596;border-radius:.75rem;break-inside:avoid}
.results-overview svg{width:10rem;height:10rem;flex:none}
.results-overview .overview-copy{flex:1;min-width:13rem}
.results-overview ul{margin:.5rem 0;padding-left:1.2rem}
.results-overview .overview-score{font-size:2rem;font-weight:800;color:#003b71;margin:.2rem 0}
.results-overview details{font-size:.9rem}
`;
export function resultsOverview(view) {
  const concluded = new Map();
  for (const issue of Object.values(view.issues).flat()) {
    if (issue.engine === 'audita-core' && ['passed', 'failed'].includes(issue.originalOutcome)) {
      // A contradictory duplicate may not turn a failed check into a pass.
      if (concluded.get(issue.checkKey) !== 'failed') concluded.set(issue.checkKey, issue.originalOutcome);
    }
  }
  const passed = [...concluded.values()].filter(outcome => outcome === 'passed').length;
  const counts = view.executive.counts;
  const total = GROUPS.reduce((sum, [key]) => sum + (counts[key]?.checkKeys ?? 0), 0);
  let offset = 0;
  const segments = GROUPS.map(([key,label,color]) => {
    const count = counts[key]?.checkKeys ?? 0;
    const size = total ? 100 * count / total : 0;
    const segment = {key,label,color,count,size,offset};
    offset += size;
    return segment;
  });
  return {passed,concluded:concluded.size,score:concluded.size ? Math.round(100 * passed / concluded.size) / 10 : null,total,segments};
}

function overviewTree(view) {
  const result = resultsOverview(view);
  const node = (tag, text='', attrs={}, children=[]) => ({tag,text,attrs,children});
  const score = result.score === null ? 'Sem nota' : `${result.score.toFixed(1).replace('.', ',')} / 10`;
  return node('section','',{'class':'results-overview','data-results-overview':'','aria-label':'Panorama dos resultados'},[
    node('svg','',{viewBox:'0 0 120 120',role:'img','aria-label':`${result.total} verificações; distribuição descrita na legenda.`,xmlns:'http://www.w3.org/2000/svg'},[
      node('circle','',{cx:60,cy:60,r:44,fill:'none',stroke:'#dbe4ea','stroke-width':17}),
      ...result.segments.filter(segment=>segment.count>0).map(segment=>node('circle','',{
        cx:60,cy:60,r:44,fill:'none',stroke:segment.color,'stroke-width':17,pathLength:100,
        'stroke-dasharray':`${segment.size} ${100-segment.size}`,'stroke-dashoffset':-segment.offset,
        transform:'rotate(-90 60 60)'
      })),
      node('text',String(result.total),{x:60,y:64,'text-anchor':'middle','font-size':22,fill:'#003b71'}),
    ]),
    node('div','',{'class':'overview-copy'},[
      node('strong','Índice técnico automático — motor próprio'),
      node('p',score,{'class':'overview-score','data-automatic-score':''}),
      node('p',`${result.passed} verificações atendidas entre ${result.concluded} com conclusão automática aplicável.`),
      node('ul','',{},result.segments.map(segment=>node('li',`${segment.label}: ${segment.count} verificações`))),
      node('p','Revisão humana reúne indícios e sinais inconclusivos dos motores, não falhas confirmadas. Um sinal pode estar sem elemento correlacionado: nesse caso, é preciso localizar e reproduzir a situação antes de concluir. Perguntas gerais sem sinal específico ficam no checklist separado, fora deste gráfico.'),
      node('details','',{'data-score-methodology':''},[
        node('summary','Como o gráfico e o índice são calculados'),
        node('p','Índice = 10 × testes atendidos ÷ (atendidos + falhos), uma vez por regra e página do motor próprio, antes de decisões humanas. Exclui não aplicáveis, inconclusivos, não testados e motores suplementares. Sem denominador, não há nota.'),
        node('p','O gráfico usa verificações agrupadas, não quantidade de elementos. Mostra resultados consolidados, incluindo os suplementares, e exclui não aplicáveis e checklist. Por isso seu denominador difere do índice. O índice inclui requisitos e recomendações dos níveis avaliados, inclusive AAA; não representa conformidade AA. A cobertura automática continua separada.'),
        node('p','Mesmo 10 não comprova acessibilidade integral. Pendências, limitações, nível WCAG e impacto devem ser considerados. O índice não é certificação, não é a nota do AMAWeb e não permite comparar motores ou versões diferentes diretamente.'),
      ]),
    ]),
  ]);
}

export function resultsOverviewElement(document, view) {
  const render = (tree, svg=false) => {
    svg ||= tree.tag === 'svg';
    const element = svg ? document.createElementNS('http://www.w3.org/2000/svg',tree.tag) : document.createElement(tree.tag);
    for (const [key,value] of Object.entries(tree.attrs)) element.setAttribute(key,String(value));
    if (tree.text) element.textContent = tree.text;
    for (const child of tree.children) element.append(render(child,svg));
    return element;
  };
  return render(overviewTree(view));
}

export function resultsOverviewHtml(view) {
  const escape = value => String(value).replace(/[&<>"']/gu, character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const render = tree => `<${tree.tag}${Object.entries(tree.attrs).map(([key,value])=>` ${key}="${escape(value)}"`).join('')}>${escape(tree.text)}${tree.children.map(render).join('')}</${tree.tag}>`;
  return render(overviewTree(view));
}
