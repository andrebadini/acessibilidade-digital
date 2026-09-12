# Captura de elemento visível — incremento limitado

Base: `2584257`. Objetivo: evitar o ramo beyond-viewport para miniaturas cujo recorte integral já cabe nos viewports CSS observados, sem reduzir margens, imagem ou geometria de evidência.

Fonte oficial: [CDP Page.captureScreenshot](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot). A documentação descreve a flag; preservação geométrica foi verificada no binário real, não inferida da documentação.

RED: `test/e2e/capture-visible-element.test.mjs` no Chrome 152, com página longa e scrollbar, capturou pixels reais mas deslocou alvo centralizado 582,5→590 e clientWidth 1265→1280. RED unitário: flag `true` onde o recorte completo cabia nos dois viewports.

Correção: `captureElement` usa `captureBeyondViewport:false` somente com escala visual 1, métricas CSS finitas/positivas e contenção integral em ambos os viewports. Considera coordenadas documentais e margem de contexto de 24 px. Não acrescenta comandos, não muda gates, hash, recorte ou full-page. Ausência de prova conserva o caminho anterior.

GREEN: 9/9 testes de captura; Chrome 1/1 com scroll 0 e 150, pixels vermelhos reais, HTML, foco, scroll, viewport e geometria preservados. Revisão independente repetiu ambos: C=0/I=0 nesse escopo de três arquivos.

Integração: o teste existente `passive current-page…element-only` ainda falha, 879→894 de largura visual. Não houve redução da asserção nem declaração de sucesso do modo inteiro. Este resultado exige investigar quais recortes do percurso integrado continuam usando o caminho beyond-viewport; o teste isolado não demonstra que todos os elementos de uma página caibam no viewport. Full-evidence e captura integral passiva continuam pendentes. Não foi feita suíte ampla, release ou ZIP.
