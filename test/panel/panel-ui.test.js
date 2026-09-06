import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const panelFile = path => readFile(new URL(`../../src/panel/${path}`, import.meta.url), 'utf8');

test('panel shell is a compact four-state mount with one heading and no legacy form or persona runtime', async () => {
  const html = await panelFile('index.html');
  assert.equal((html.match(/<h1\b/giu) ?? []).length, 1);
  assert.match(html, /<header[^>]+class="product-header"[\s\S]*Audita Acessibilidade/iu);
  assert.match(html, /<main[^>]+id="panel-root"[^>]+tabindex="-1"/iu);
  assert.match(html, /<script[^>]+type="module"[^>]+src="panel\.js"/iu);
  assert.doesNotMatch(html, /<form\b|<input\b|<textarea\b|audit-url|audit-urls|delete-after-export/iu);
  assert.doesNotMatch(html, /persona|speech|audita-persona-v1/iu);
  assert.doesNotMatch(html, /<script(?![^>]+src=)|<style\b|\sstyle=/iu);
  assert.doesNotMatch(html, /<(?:script|link|img)[^>]+(?:src|href)="https?:\/\//iu);
});

test('renderer uses only DOM construction and the fixed exhaustive screen and intent switches', async () => {
  const [view, runtime] = await Promise.all([panelFile('panel-view.js'), panelFile('panel.js')]);
  assert.match(view, /document\.createElement/u);
  assert.match(view, /textContent/u);
  assert.doesNotMatch(view, /innerHTML|insertAdjacentHTML|outerHTML/u);
  assert.doesNotMatch(runtime, /innerHTML|insertAdjacentHTML|outerHTML/u);
  for (const screen of ['initial', 'running', 'result', 'unavailable']) {
    assert.match(view, new RegExp(`case ['"]${screen}['"]`, 'u'));
  }
  for (const intent of [
    'START_ATTACHED', 'OPEN_URL_FORM', 'OPEN_BATCH_FORM', 'START_BATCH', 'CLOSE_BATCH_FORM', 'CANCEL_AUDIT',
    'CONFIRM_PIXEL_CAPTURE', 'OPEN_REPORT', 'SELECT_OCCURRENCE', 'CONSULT_EVIDENCE', 'RETRY',
  ]) assert.match(runtime, new RegExp(`case ['"]${intent}['"]`, 'u'));
  assert.doesNotMatch(runtime, /START_AUDIT|AUDIT_CONTEXT_PREFILL|GET_LAST_AUDIT/u);
  assert.doesNotMatch(runtime, /relatório completo estará disponível na próxima etapa/iu);
});

test('initial URL and functional bounded batch choices remain visible', async () => {
  const view = await panelFile('panel-view.js');
  assert.match(view, /Auditar a página atual/u);
  for (const label of ['Evidência completa', 'Somente elementos', 'Sem imagens']) {
    assert.match(view, new RegExp(label, 'u'));
  }
  assert.match(view, /Outra URL/u);
  assert.match(view, /Lote de páginas/u);
  assert.match(view, /audit-urls/u);
  assert.match(view, /batch-urls/u);
  assert.match(view, /2 a 20 URLs HTTP\/HTTPS/u);
  assert.match(view, /não segue links/u);
  assert.match(view, /Avaliar páginas/u);
  assert.match(view, /Você poderá confirmar antes de qualquer captura sensível/u);
  assert.doesNotMatch(view, /Não disponível nesta beta/u);
  assert.doesNotMatch(view, /type="url"|placeholder=.*https|prefill/iu);
});

test('running screen presents only canonical worker progress phases with an accessible native indicator', async () => {
  const view = await panelFile('panel-view.js');
  for (const phase of [
    'Abrindo e estabilizando a página',
    'Lendo estrutura e acessibilidade',
    'Verificando regras automáticas',
    'Coletando evidências',
    'Preparando o resultado',
  ]) assert.match(view, new RegExp(phase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(view, /aria-live['"], ['"]polite/u);
  assert.match(view, /progress\.dataset\.auditProgress/u);
  assert.match(view, /Etapa atual/u);
  assert.match(view, /Confirme antes de capturar imagens/u);
  assert.match(view, /Tudo permanece neste dispositivo/u);
  assert.match(view, /Continuar e capturar/u);
});

test('result copy preserves the coverage limitation and four separate checkKey metrics', async () => {
  const view = await panelFile('panel-view.js');
  assert.match(view, /testes do motor próprio que tiveram conclusão automática/u);
  assert.match(view, /não se aplica/u);
  assert.match(view, /Não mede quanto do site é acessível/u);
  for (const label of ['Falhas confirmadas', 'Alertas', 'Revisão humana', 'Resultados positivos']) {
    assert.match(view, new RegExp(label, 'u'));
  }
  assert.match(view, /ocorrência/u);
  assert.match(view, /Abrir relatório completo/u);
});

test('visual system matches the approved option-2 hierarchy and accessibility breakpoints', async () => {
  const css = await panelFile('panel.css');
  for (const token of ['#003b71', '#005a9c', '#14212b', '#eef4f8', '#738596', '#8b1e1e', '#6b4e00', '#1b6e3c']) {
    assert.match(css, new RegExp(token, 'iu'));
  }
  assert.match(css, /font-family:\s*system-ui/iu);
  assert.match(css, /min-(?:block-size|height):\s*44px/iu);
  assert.match(css, /min-(?:inline-size|width):\s*44px/iu);
  assert.match(css, /@media\s*\(max-width:\s*380px\)/iu);
  assert.match(css, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/iu);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/iu);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/iu);
  assert.match(css, /:focus-visible/iu);
  assert.match(css, /\.capture-mode-options/iu);
  assert.match(css, /\.privacy-pause/iu);
  assert.match(css, /\.batch-url-entry/iu);
  assert.match(css, /textarea/iu);
  assert.match(css, /\.capture-mode-option:has\(input:focus-visible\)/iu);
  assert.doesNotMatch(css, /@import|https?:|url\s*\(/iu);
});

test('CSS contains explicit reflow coverage for the required 320 through 600 pixel panel widths and 200 percent zoom', async () => {
  const css = await panelFile('panel.css');
  assert.match(css, /min-width:\s*min\(20rem,\s*100%\)/iu);
  assert.match(css, /max-width:\s*44rem/iu);
  assert.match(css, /overflow-wrap:\s*anywhere/iu);
  assert.doesNotMatch(css, /min-width:\s*(?:[4-9]\d\d|[1-9]\d{3,})px/iu);
  assert.doesNotMatch(css, /white-space:\s*nowrap/iu);
});
