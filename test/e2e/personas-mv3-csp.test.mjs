import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_CHROME_PRODUCT,
  activateRealTab,
  createRealPage,
  launchUnpackedExtension,
  resolveRealChromeTestBinary,
  startFixtureServer,
} from './support/real-chrome.mjs';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtureRoot = join(workspaceRoot, 'test/e2e/fixtures');
const chromeBinary = resolveRealChromeTestBinary();
const sentinel = 'SEGREDO-PERSONA-E2E-918273';

test('runs reversible personas against the exact real MV3 document under strict CSP', { timeout: 90_000 }, async t => {
  assert.ok(chromeBinary, 'AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório para o E2E real de personas.');

  const [fixtureTemplate, fixtureScript, frameHtml] = await Promise.all([
    readFile(join(fixtureRoot, 'personas-csp.html'), 'utf8'),
    readFile(join(fixtureRoot, 'personas-csp.fixture'), 'utf8'),
    readFile(join(fixtureRoot, 'personas-frame.html'), 'utf8'),
  ]);
  const cross = await startFixtureServer(t, new Map([['/personas-frame.html', {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'",
    },
    body: frameHtml,
  }]]));
  const strictCsp = `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self' ${cross.origin}; base-uri 'none'; form-action 'none'; connect-src 'none'`;
  const main = await startFixtureServer(t, new Map([
    ['/personas-csp.html', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': strictCsp },
      body: fixtureTemplate.replace('__CROSS_FRAME_URL__', `${cross.origin}/personas-frame.html`),
    }],
    ['/personas-csp.js', {
      status: 200,
      headers: { 'content-type': 'text/javascript; charset=utf-8', 'content-security-policy': strictCsp },
      body: fixtureScript,
    }],
    ['/personas-frame.html', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': strictCsp },
      body: frameHtml,
    }],
    ['/decoy.html', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': strictCsp },
      body: '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Decoy personas</title></head><body><button>Decoy</button></body></html>',
    }],
  ]));
  const fixtureUrl = `${main.origin}/personas-csp.html`;
  const decoyUrl = `${main.origin}/decoy.html`;
  const response = await fetch(fixtureUrl);
  assert.equal(response.headers.get('content-security-policy'), strictCsp);
  await response.arrayBuffer();

  for (const relativePath of [
    'src/core/accessibility/accessible-preview-runtime.classic.js',
    'src/personas/screen-reader-module.js',
    'src/personas/content.js',
  ]) {
    const source = await readFile(join(workspaceRoot, relativePath), 'utf8');
    assert.doesNotMatch(source, /^\s*(?:import|export)\s/mu, `${relativePath} precisa permanecer script clássico`);
    assert.doesNotMatch(source, /\beval\s*\(|\bnew\s+Function\b/u, `${relativePath} não pode relaxar a CSP`);
  }

  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(workspaceRoot),
    startUrl: fixtureUrl,
    chromeBinary,
    expectedMajor: 152,
    viewport: { width: 1280, height: 800 },
  });
  assert.equal(extension.chromeProduct, CANONICAL_CHROME_PRODUCT);
  await extension.waitForValue(extension.startPage.page,
    `location.href === ${JSON.stringify(fixtureUrl)} && document.readyState === 'complete' && Boolean(globalThis.__personaFixtureState)`,
    Boolean, { timeoutMs: 15_000, intervalMs: 50 });

  const decoy = await createRealPage(extension, {
    url: decoyUrl,
    active: true,
    operationId: 'persona-decoy',
  });
  await extension.waitForValue(decoy.page,
    `location.href === ${JSON.stringify(decoyUrl)} && document.readyState === 'complete'`,
    Boolean, { timeoutMs: 15_000, intervalMs: 50 });

  await activateRealTab(extension, extension.startPage, { operationId: 'persona-activate-fixture' });
  const panel = await extension.openSidePanelFromAction();
  const contexts = await extension.runtimeContexts({ contextTypes: ['SIDE_PANEL', 'POPUP'] });
  assert.deepEqual({
    sidePanels: contexts.filter(value => value.contextType === 'SIDE_PANEL').length,
    popups: contexts.filter(value => value.contextType === 'POPUP').length,
  }, { sidePanels: 1, popups: 0 });
  try {
    await extension.waitForValue(panel,
      `document.querySelector('[data-screen]')?.dataset.screen`, value => value === 'initial');
  } catch (cause) {
    const observed = await extension.evaluate(panel, `(() => ({
      screen:document.querySelector('[data-screen]')?.dataset.screen??null,
      status:document.querySelector('[role="status"]')?.textContent??null,
      launchLength:new URL(location.href).searchParams.get('launch')?.length??0
    }))()`);
    throw new Error(`PERSONA_PANEL_BOOTSTRAP_FAILED ${JSON.stringify(observed)}`, { cause });
  }
  assert.doesNotMatch(await extension.evaluate(panel, 'document.body.innerText'), new RegExp(sentinel, 'u'));
  assert.deepEqual(await pagePersonaState(extension, extension.startPage.page), { classes: [], artifacts: 0 });

  await extension.click(panel, 'button[data-persona-mode="reader"][data-intent="PERSONA_SELECT"]');
  await extension.waitForValue(panel,
    `document.querySelector('button[data-persona-mode="reader"]')?.getAttribute('aria-pressed')`,
    value => value === 'true');
  let readerVisual = null;
  try {
    readerVisual = await extension.waitForValue(extension.startPage.page, `(() => ({
      classes: [...document.documentElement.classList].filter(name => name.startsWith('audita-persona-')),
      artifacts: [...document.querySelectorAll('[data-audita-persona-owned]')].map(node => node.textContent),
      sameFrameArtifacts: document.querySelector('#same-frame').contentDocument.querySelectorAll('[data-audita-persona-owned]').length,
      crossFrameReadable: (() => { try { return Boolean(document.querySelector('#cross-frame').contentDocument); } catch { return false; } })()
    }))()`, value => value?.classes?.[0] === 'audita-persona-reader' && value.artifacts.length >= 1,
    { timeoutMs: 10_000, intervalMs: 50 });
  } catch { /* projected below as an objective public-wiring RED */ }
  const readerLease = await extension.evaluate(extension.harnessPage, `chrome.storage.session
    .get('audita:persona-leases:v1').then(value => {
      const registry = value['audita:persona-leases:v1'];
      const leases = registry && typeof registry === 'object' && registry.leases && typeof registry.leases === 'object'
        ? Object.values(registry.leases) : [];
      return {
        active: leases.filter(lease => lease?.state === 'active' && lease?.activeMode === 'reader').length,
        sanitized: !JSON.stringify(value).includes(${JSON.stringify(sentinel)}) &&
          !JSON.stringify(value).includes(${JSON.stringify(fixtureUrl)})
      };
    })`, { awaitPromise: true });
  const publicReaderProof = {
    targetMode: readerVisual?.classes?.[0] ?? null,
    artifacts: readerVisual?.artifacts?.length ?? 0,
    sameFrameArtifacts: readerVisual?.sameFrameArtifacts ?? null,
    crossFrameReadable: readerVisual?.crossFrameReadable ?? null,
    activeLeases: readerLease.active,
    sanitized: readerLease.sanitized,
  };
  assert.deepEqual(publicReaderProof, {
    targetMode: 'audita-persona-reader',
    artifacts: 2,
    sameFrameArtifacts: 0,
    crossFrameReadable: false,
    activeLeases: 1,
    sanitized: true,
  }, 'PERSONA_PANEL_WORKER_WIRING_MISSING');
  assert.doesNotMatch(JSON.stringify(readerVisual), new RegExp(sentinel, 'u'));
  assert.deepEqual(await pagePersonaState(extension, decoy.page), { classes: [], artifacts: 0 },
    'a aba decoy nunca recebe a persona vinculada ao documento explícito');

  await extension.click(panel, 'button[data-intent="PERSONA_READER_NEXT"]');
  try {
    await extension.waitForValue(panel,
      `/Leitura 2 de \\d+: Positivo dois, botão/iu.test(document.querySelector('.persona-message')?.textContent || '')`,
      Boolean);
    await extension.waitForValue(extension.startPage.page,
      `document.activeElement?.id === 'positive-two'`, Boolean);
  } catch {
    const diagnostic = await extension.evaluate(extension.startPage.page, `(() => ({
      artifacts: [...document.querySelectorAll('[data-audita-persona-owned]')].map(node => node.textContent),
      classes: [...document.documentElement.classList].filter(name => name.startsWith('audita-persona-'))
    }))()`);
    const panelText = await extension.evaluate(panel, 'document.body.innerText');
    assert.fail(`PERSONA_READER_NEXT_TIMEOUT:${JSON.stringify({ diagnostic, panelText })}`);
  }

  await extension.command(panel, 'Emulation.setDeviceMetricsOverride', {
    width: 640, height: 400, deviceScaleFactor: 2, mobile: false,
  });
  try {
    const responsive = await extension.evaluate(panel, `(() => ({
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      controlsVisible: [...document.querySelectorAll('.persona-controls button')].every(button => {
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.height >= 44;
      })
    }))()`);
    assert.deepEqual(responsive, { horizontalOverflow: false, controlsVisible: true });
    await extension.captureJourney('persona-side-panel-200-percent', panel);
  } finally {
    await extension.command(panel, 'Emulation.clearDeviceMetricsOverride');
  }

  await extension.click(panel, 'button[data-persona-mode="achromatopsia"]');
  const achromatopsiaVisual = await extension.waitForValue(extension.startPage.page, `(() => ({
    classes: [...document.documentElement.classList].filter(name => name.startsWith('audita-persona-')),
    artifacts: document.querySelectorAll('[data-audita-persona-owned]').length,
    filter: getComputedStyle(document.documentElement).filter
  }))()`, value => value?.classes?.[0] === 'audita-persona-achromatopsia');
  assert.deepEqual(achromatopsiaVisual.classes, ['audita-persona-achromatopsia']);
  assert.equal(achromatopsiaVisual.artifacts, 0);
  assert.match(achromatopsiaVisual.filter, /grayscale\(1\)/u);

  await extension.click(panel, 'button[data-persona-mode="keyboard"]');
  await extension.waitForValue(extension.startPage.page,
    `document.documentElement.classList.contains('audita-persona-motor')`, Boolean);
  const box = await extension.evaluate(extension.startPage.page, `(() => {
    const rect = document.querySelector('#input-target').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await extension.command(extension.startPage.page, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1,
  });
  await extension.command(extension.startPage.page, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1,
  });
  assert.deepEqual(await extension.evaluate(extension.startPage.page, 'globalThis.__personaFixtureState'), {
    pointerDown: 0, pointerClick: 0, keyboardClick: 0,
  });
  await extension.evaluate(extension.startPage.page, `(() => {
    document.querySelector('#input-target').focus();
    return true;
  })()`);
  await extension.waitForValue(extension.startPage.page,
    `document.hasFocus() && document.activeElement?.id === 'input-target'`, Boolean);
  await extension.command(extension.startPage.page, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await extension.command(extension.startPage.page, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await extension.waitForValue(extension.startPage.page,
    'globalThis.__personaFixtureState.keyboardClick', value => value === 1);

  await extension.click(panel, 'button[data-intent="PERSONA_END"]');
  await extension.waitForValue(extension.startPage.page,
    `[...document.documentElement.classList].some(name => name.startsWith('audita-persona-'))`,
    value => value === false);
  assert.deepEqual(await pagePersonaState(extension, extension.startPage.page), {
    classes: [], artifacts: 0,
  });

  const privateStorage = await extension.evaluate(extension.harnessPage, `Promise.all([
    chrome.storage.local.get(null), chrome.storage.session.get(null)
  ]).then(([local, session]) => ({ local, session }))`, { awaitPromise: true });
  assert.doesNotMatch(JSON.stringify(privateStorage), new RegExp(`${sentinel}|Positivo|http://127\\.0\\.0\\.1`, 'iu'));

  await extension.click(panel, 'button[data-persona-mode="reader"]');
  await extension.waitForValue(extension.startPage.page,
    `document.documentElement.classList.contains('audita-persona-reader')`, Boolean);
  await extension.browser.command('Target.closeTarget', { targetId: panel.targetId });
  await extension.waitForValue(extension.harnessPage,
    `chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']}).then(contexts=>contexts.length===0)`,
    Boolean, { timeoutMs: 10_000, intervalMs: 25 });
  const reconnectedPanel = await extension.openSidePanelFromAction();
  await extension.waitForValue(reconnectedPanel,
    `document.querySelector('button[data-persona-mode="reader"]')?.getAttribute('aria-pressed')`,
    value => value === 'true');
  assert.equal(await extension.evaluate(extension.startPage.page,
    `document.documentElement.classList.contains('audita-persona-reader')`), true,
  'fechar o painel não pode abandonar uma persona invisível ao usuário');
  await extension.click(reconnectedPanel, 'button[data-intent="PERSONA_END"]');
  await extension.waitForValue(extension.startPage.page, `(() => ({
    active: [...document.documentElement.classList].some(name => name.startsWith('audita-persona-')),
    artifacts: document.querySelectorAll('[data-audita-persona-owned]').length
  }))()`, value => value?.active === false && value.artifacts === 0, { timeoutMs: 15_000, intervalMs: 50 });
  await extension.waitForValue(reconnectedPanel,
    `[...document.querySelectorAll('[data-persona-mode]')].every(button => button.getAttribute('aria-pressed') === 'false')`,
    Boolean);
  assert.equal(await extension.evaluate(extension.startPage.page,
    `document.querySelector('#private-button')?.textContent`), sentinel,
  'o conteúdo privado da página permanece intacto; apenas nunca é projetado pela extensão');
});

function pagePersonaState(extension, page) {
  return extension.evaluate(page, `(() => ({
    classes: [...document.documentElement.classList].filter(name => name.startsWith('audita-persona-')),
    artifacts: document.querySelectorAll('[data-audita-persona-owned]').length
  }))()`);
}
