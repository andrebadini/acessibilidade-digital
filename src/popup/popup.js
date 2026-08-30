import { createPopupController } from './popup-state.js';

const domain = document.querySelector('#page-domain');
const title = document.querySelector('#page-title');
const auditButton = document.querySelector('#audit-page');
const otherButton = document.querySelector('#other-source');
const status = document.querySelector('#popup-status');

function renderState(state) {
  auditButton.disabled = !state.auditReady;
  otherButton.disabled = !state.otherReady;
  status.textContent = state.message;
}

const controller = createPopupController({
  createRequestId: () => crypto.randomUUID(),
  sendMessage: message => chrome.runtime.sendMessage(message),
  sidePanelOpen: options => chrome.sidePanel.open(options),
  onStateChange: renderState,
});

async function showActivePage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    title.textContent = typeof tab?.title === 'string' && tab.title.trim() ? tab.title : 'Página sem título';
    const parsed = new URL(tab?.url);
    domain.textContent = parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.hostname
      : 'Página não disponível para avaliação';
  } catch {
    title.textContent = 'Página não disponível';
    domain.textContent = 'Abra uma página HTTP ou HTTPS';
  }
}

auditButton.addEventListener('click', () => {
  void controller.handleAuditClick();
});

otherButton.addEventListener('click', () => {
  void controller.handleOtherClick();
});

void showActivePage();
void controller.prepareCapabilities();

setInterval(() => {
  if (controller.refreshValidity()) void controller.prepareCapabilities();
}, 1_000);
