(() => {
  'use strict';
  const state = { pointerDown: 0, pointerClick: 0, keyboardClick: 0 };
  const inputTarget = document.querySelector('#input-target');
  const counts = document.querySelector('#input-counts');
  const render = () => {
    counts.textContent = `Pointer ${state.pointerDown}/${state.pointerClick}; teclado ${state.keyboardClick}.`;
  };
  inputTarget.addEventListener('pointerdown', () => { state.pointerDown += 1; render(); });
  inputTarget.addEventListener('click', event => {
    if (event.detail === 0) state.keyboardClick += 1;
    else state.pointerClick += 1;
    render();
  });
  const openRoot = document.querySelector('#open-shadow-host').attachShadow({ mode: 'open' });
  const shadowButton = document.createElement('button');
  shadowButton.id = 'open-shadow-button';
  shadowButton.textContent = 'Botão no Shadow DOM aberto';
  openRoot.append(shadowButton);
  const closedRoot = document.querySelector('#closed-shadow-host').attachShadow({ mode: 'closed' });
  const closedButton = document.createElement('button');
  closedButton.id = 'closed-shadow-button';
  closedButton.textContent = 'Conteúdo fechado não observável';
  closedRoot.append(closedButton);
  Object.defineProperty(globalThis, '__personaFixtureState', {
    value: state, enumerable: false, configurable: false, writable: false,
  });
  render();
})();
