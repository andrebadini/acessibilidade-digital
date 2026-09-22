import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_CHROME_PRODUCT,
  launchUnpackedExtension,
  navigateRealPage,
  redactDiagnostic,
  resolveRealChromeTestBinary,
  startFixtureServer,
  waitForServiceWorker,
} from './support/real-chrome.mjs';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
const chromeBinary = resolveRealChromeTestBinary();
const queryMarker = 'AUDITA4D_QUERY_71F02A9C';
const fragmentMarker = 'AUDITA4D_FRAGMENT_149B8C30';
const memoryMarker = 'AUDITA4D_MEMORY_ONLY_4CC931E2';
const attachedCopyLimitation =
  'A auditoria foi executada em uma cópia temporária recarregada da URL da aba escolhida; alterações não salvas e estado mantido apenas em memória na aba original não foram observados.';
// A frase é literal e foi CORRIGIDA na 1.1.49 (achado N-1 da revisão adversarial): a captura de elementos
// mexe transitoriamente na geometria do documento, e numa página que reage a `resize` o efeito fica
// registrado — a versão anterior negava isso.
const passiveObservationLimitation =
  'A página foi observada sem navegação e sem alterar foco, rolagem ou o layout final. Nas verificações com imagens, a captura de elementos pode redimensionar a área de captura por um instante e restaurá-la; páginas que reagem a redimensionamento podem registrar essa mudança. Testes interativos de teclado, redimensionamento e movimento não foram executados; revise esses aspectos manualmente.';
const supersededPassiveObservationClaim = 'sem alterar foco, rolagem ou layout.';
// A página atual é auditada NO documento aberto (roteamento entregue em 1c9b296, passivo desde então). O
// elemento observado é o que existe AGORA: `armSourceInvariantProof` remove a imagem do servidor só em
// memória, então a ocorrência conhecida do percurso passivo é o BOTÃO sem nome acessível, presente no
// documento vivo, com evidência de elemento correlacionada pelo seletor qualificado (`button#missing-name`).
// Medido no inventário real: `axe.button-name` (ABNT 5.13.10, WCAG 4.1.2) sai como `cantTell` complementar, e
// o produtor de seletor qualifica o ID com a tag real do elemento.
// O produtor qualifica o seletor com o ID quando ele existe e cai no caminho estrutural quando não existe:
// os dois cenários desta suíte usam o MESMO botão sem nome, um com `id="missing-name"` e outro sem ID algum.
const knownOccurrence = Object.freeze({
  ruleId: 'axe.button-name', wcag: '4.1.2', abnt: '5.13.10', outcome: 'cantTell',
  selectors: Object.freeze(['button#missing-name', 'html > body > main > button']),
});
const canonicalReportTitle = 'Relatório de auditoria — Audita Acessibilidade';
const exportMime = Object.freeze({
  html: 'text/html;charset=utf-8', pdf: 'application/pdf',
  csv: 'text/csv;charset=utf-8', json: 'application/json;charset=utf-8',
});
const privateFieldNames = Object.freeze([
  'consentId', 'navigationToken', 'sessionDigest', 'urlSessionDigest', 'ownershipId', 'capabilityId',
  'owner_', 'hmac-sha256',
]);

function currentPageDocument(controlCount = 240) {
  const repeatedControls = Array.from({ length: controlCount }, (_, index) =>
    `<button class="unnamed-control" data-sequence="${index}"></button>`).join('');
  return `<!doctype html>
    <html lang="pt-BR">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width">
        <title>Origem preservada</title>
        <style>
          body{font-family:system-ui;min-height:2400px;margin:0}
          main{max-width:760px;margin:24px auto;padding:16px}
          #runtime-style-target{color:rgb(21,44,72);border:1px solid rgb(160,170,180);padding:8px}
          .unnamed-control{display:inline-block;width:10px;height:10px;margin:1px}
        </style>
      </head>
      <body>
        <main>
          <h1>Origem que deve permanecer intacta</h1>
          <label for="password-field">Senha</label>
          <input id="password-field" type="password" autocomplete="current-password" value="">
          <section data-audita-private><p>Área local marcada como privada.</p></section>
          <label for="source-notes">Anotações locais</label>
          <textarea id="source-notes">valor vindo do servidor</textarea>
          <p id="selection-target">Texto determinístico para preservar a seleção da página.</p>
          <p id="runtime-style-target" data-runtime-state="server">Estado visual do servidor</p>
          <img id="missing-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
          <input id="missing-label" type="text">
          <button id="missing-name"></button>
          <a href="/current">clique aqui</a>
          <div aria-label="Controles sem nome">${repeatedControls}</div>
        </main>
      </body>
    </html>`;
}

// Página REATIVA: a mesma fixture do percurso passivo mais um handler de `resize` comum, que escreve no DOM.
// A revisão adversarial da 1.1.49 mediu que a captura de elementos (`captureBeyondViewport`) leva o viewport
// do documento observado a 1x1 por um instante e o restaura; numa página assim o handler roda e o documento
// termina diferente do inicial. O produto não evita isso sem perder a captura fora da área visível — o que
// ele tem de fazer é restaurar a geometria e DECLARAR o efeito no relatório.
function reactiveCurrentPageDocument() {
  return currentPageDocument().replace('</body>', `    <div id="reactive-counter">resizes=0</div>
    <script>
      let reactiveCount = 0;
      const reactiveNode = document.getElementById('reactive-counter');
      addEventListener('resize', () => {
        reactiveCount += 1;
        reactiveNode.textContent = 'resizes=' + reactiveCount + ' w=' + innerWidth + ' h=' + innerHeight;
      });
    </script>
  </body>`);
}

// Read only public presentation and a digest of the durable record. Native
// marker interaction must not become a new capture or change the audit model.
async function markerRecordFingerprint(extension, auditId) {
  return extension.evaluate(extension.harnessPage, `(async()=>{
    const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
    const revision=await store.getReportRevision(${JSON.stringify(auditId)});
    const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'
      ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(stable({model:revision?.model,checkpoint:revision?.checkpoint}))));
    return {present:Boolean(revision?.model),revision:revision?.modelRevision,sha256:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')};
  })()`, { awaitPromise: true });
}

const markerSurface = `(() => {
  const host=document.querySelector('[data-audita-page-markers-root="v1"]');
  const buttons=[...host?.shadowRoot?.querySelectorAll('.audita-marker')??[]];
  return {roots:document.querySelectorAll('[data-audita-page-markers-root="v1"]').length,
    buttons:buttons.map(button=>({label:button.getAttribute('aria-label'),text:button.textContent,
      hidden:button.style.display==='none'})),
    rings:[...host?.shadowRoot?.querySelectorAll('.audita-ring')??[]].filter(node=>node.style.display!=='none').length,
    selectedNumbers:[...host?.shadowRoot?.querySelectorAll('.audita-ring')??[]].filter(node=>node.style.display!=='none')
      .map(node=>Number(node.parentElement.querySelector('.audita-marker').getAttribute('aria-label').match(/^Sinal ([0-9]+)/)[1]))};
})()`;

async function waitForMarkerState(extension, panel, expected) {
  return extension.waitForValue(panel, `(() => ({
    state:document.querySelector('[data-page-marker-review]')?.dataset.markerStatus??null,
    message:document.querySelector('.page-marker-status')?.textContent??null,
    counts:[...document.querySelectorAll('.page-marker-counts li')].map(node=>node.textContent)
  }))()`, value => value?.state === expected || value?.state === 'unavailable', {
    timeoutMs: 65_000, intervalMs: 100,
  });
}

async function activateMarkerByKey(extension, page, key) {
  // Native activation needs the text-producing keyDown, not only raw key codes.
  // CDP Input.dispatchKeyEvent; Enter's generated text is CR, Space's is space.
  const code = key === 'Enter' ? 'Enter' : 'Space';
  const text = key === 'Enter' ? '\r' : ' ';
  const windowsVirtualKeyCode = key === 'Enter' ? 13 : 32;
  await extension.command(page, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key, code, windowsVirtualKeyCode, text, unmodifiedText: text,
  });
  await extension.command(page, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
}

for (const scenario of [
  { name: 'original-page ABNT markers remain usable across idle and preserve the report', idle: true },
  { name: 'original-page ABNT markers visual review and verified exports', idle: false },
]) test(scenario.name, { timeout: 420_000 }, async t => {
  assert.ok(chromeBinary, 'AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório.');
  const documentBody = scenario.idle ? currentPageDocument(0) : currentPageDocument(0).replace(
    '<button id="missing-name"></button>',
    '<button class="idless-primary" style="width:180px;height:42px"></button>');
  const fixture = await startFixtureServer(t, new Map([
    ['/current', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
      body: documentBody }],
    ['/other', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
      body: currentPageDocument(0).replace('Origem preservada', 'Outro documento') }],
  ]));
  let extension;
  const step = async (name, operation) => {
    t.diagnostic(`page-markers-step=${name}:begin`);
    try { const value = await operation(); t.diagnostic(`page-markers-step=${name}:passed`); return value; }
    catch (cause) { throw new Error(`PAGE_MARKERS_${name}_FAILED`, { cause }); }
  };
  try {
    extension = await launchUnpackedExtension(t, {
      extensionPath: await realpath(workspaceRoot), startUrl: `${fixture.origin}/current`,
      downloadMode: 'profile',
      ...(process.env.AUDITA_E2E_ARTIFACT_ROOT ? {
        qaDirectory: join(process.env.AUDITA_E2E_ARTIFACT_ROOT, 'qa'),
        downloadDirectory: join(process.env.AUDITA_E2E_ARTIFACT_ROOT, 'downloads'),
      } : {}),
      viewport: { width: 1280, height: 900 }, chromeBinary, expectedMajor: 152,
    });
    await armSourceInvariantProof(extension);
    const panel = await extension.openSidePanelFromAction();
    await extension.waitForValue(panel, `document.querySelector('[data-screen]')?.dataset.screen`,
      value => value === 'initial', { timeoutMs: 30_000 });
    const { identityBefore, auditIdPromise } = await beginAttachedAttempt(extension, panel, 'element-only');
    await waitForPrivacyPause(extension, panel);
    const auditId = await auditIdPromise;
    await assertPausedObservedAttempt(extension, auditId, identityBefore);
    await confirmOnce(extension, panel);
    assert.equal(await waitForResult(extension, panel, auditId).catch(async cause => {
      const attempt = await readPrivateAttempt(extension, auditId).catch(() => null);
      const surface = await extension.evaluate(panel, `(() => ({
        screen:document.querySelector('[data-screen]')?.dataset.screen,
        status:document.querySelector('[role="status"]')?.textContent,
        stages:[...document.querySelectorAll('[data-phase-state]')].map(node=>({state:node.dataset.phaseState,text:node.textContent}))
      }))()`).catch(() => null);
      t.diagnostic(JSON.stringify({surface, attempt:attempt?{
        activeState:attempt.activeState,latestStatus:attempt.latestStatus,latestMessage:attempt.latestMessage,
        modelPresent:attempt.modelPresent,reportPresent:attempt.reportPresent,
        owners:attempt.owners.map(owner=>({state:owner.state,tabExists:owner.tabExists})),
        pixelStateCount:attempt.pixelStateCount,executionCheckpointPresent:attempt.executionCheckpointPresent,
      }:null}));
      throw cause;
    }), auditId);
    const terminalAttempt = await step('SILENT_AUDIT', async () => {
      const attempt = await assertObservedTerminalAttempt(extension, auditId, identityBefore, {
        minimumFullPage: 0, minimumElements: 1, fullPageExact: 0,
        diagnostics: ['FULL_PAGE_CAPTURE_OMITTED'],
      }, fixture.origin);
      await assertPanelSummaryAndDetail(extension, panel, 'element-only', 1, identityBefore,
        { maxCaptureResizes: captureResizeCeiling(attempt) });
      return attempt;
    });
    const fingerprint = await markerRecordFingerprint(extension, auditId);
    assert.equal(fingerprint.present, true);
    const workerTarget = (await extension.browser.command('Target.getTargets')).targetInfos
      .find(info => info.type === 'service_worker' && info.url.startsWith(`chrome-extension://${extension.extensionId}/`));
    assert.ok(workerTarget);
    // Discovery attaches a debugger by default: detach it BEFORE both idle
    // windows. Do not attach or evaluate the worker again during this journey.
    await extension.browser.command('Target.detachFromTarget', { sessionId: extension.worker.sessionId });
    if (scenario.idle) await step('IDLE_BEFORE_SHOW', async () => {
      await new Promise(resolve => setTimeout(resolve, 45_000));
      const targets = (await extension.browser.command('Target.getTargets')).targetInfos;
      assert.equal(targets.some(info => info.targetId === workerTarget.targetId && info.attached === false), true);
      // O passo anterior capturou elementos (element-only): a oscilação transitória de geometria da
      // captura fora da viewport é o limite declarado, e não uma alteração do documento. O teto vem do que
      // foi capturado (A-3 do adendo da 1.1.49), não de um número fixo.
      await assertSourceUntouched(extension, identityBefore,
        { allowCaptureResize: true, maxCaptureResizes: captureResizeCeiling(terminalAttempt) });
    });
    const preserved = await extension.evaluate(extension.startPage.page, `(() => {
      globalThis.__auditaSourceInvariantV1.dispose();
      const sentinel=document.createElement('aside');sentinel.id='foreign-review-overlay';sentinel.textContent='Outra ferramenta';
      sentinel.style.cssText='position:fixed;right:8px;bottom:8px;background:white';document.body.append(sentinel);
      globalThis.__markerControlClicks=0;
      document.querySelector('#missing-name, button.idless-primary').addEventListener('click',()=>globalThis.__markerControlClicks++);
      return {x:scrollX,y:scrollY,active:document.activeElement?.id,notes:document.querySelector('#source-notes').value};
    })()`);
    await step('SHOW', async () => {
      await extension.click(panel, 'button[data-intent="SHOW_PAGE_MARKERS"]');
      const state = await waitForMarkerState(extension, panel, 'active');
      assert.equal(state.state, 'active', JSON.stringify(state));
      const surface = await extension.evaluate(extension.startPage.page, markerSurface);
      assert.equal(surface.roots, 1);
      assert.ok(surface.buttons.length >= 2, JSON.stringify(surface));
      assert.ok(surface.buttons.some(button => /[2-9] ocorrências/u.test(button.label)), 'shared element has one signal for several occurrences');
      assert.ok(state.counts.some(text => /^[1-9]\d* ocorrências? não localizadas?/u.test(text)), JSON.stringify(state));
      assert.deepEqual(await extension.evaluate(extension.startPage.page, `({x:scrollX,y:scrollY,
        active:document.activeElement?.id,notes:document.querySelector('#source-notes').value})`), preserved);
    });
    if (!scenario.idle) await step('IDLESS_ORIGINAL_ELEMENT', async () => {
      const number = await extension.evaluate(extension.startPage.page, `(() => {
        const target=document.querySelector('button.idless-primary');
        if(!target||target.hasAttribute('id'))throw Error('IDLESS_FIXTURE_INVALID');
        const rect=target.getBoundingClientRect();
        const root=document.querySelector('[data-audita-page-markers-root="v1"]');
        const groups=[...root.shadowRoot.querySelectorAll('.audita-group')].filter(group=>{
          const ring=group.querySelector('.audita-ring');
          return ['left','top','width','height'].every(key=>Math.abs(parseFloat(ring.style[key])-rect[key])<1);
        });
        if(groups.length!==1)return {reason:'IDLESS_MARKER_NOT_CORRELATED',matches:groups.length,total:root.shadowRoot.querySelectorAll('.audita-group').length};
        const button=groups[0].querySelector('.audita-marker');
        const number=Number(button.getAttribute('aria-label').match(/^Sinal ([0-9]+)/)[1]);
        button.click();return number;
      })()`, { userGesture: true });
      assert.equal(typeof number, 'number', JSON.stringify(number));
      await extension.waitForValue(panel, `(() => ({
        number:Number(document.querySelector('[data-intent="SELECT_OCCURRENCE"][aria-pressed="true"] [data-page-marker-number]')?.dataset.pageMarkerNumber),
        technical:document.querySelector('[data-detail-block="technical"]')?.textContent??'',
        normative:document.querySelector('[data-detail-block="normative"]')?.textContent??''
      }))()`, value => value?.number === number && value.technical.includes('html > body > main > button') && /ABNT NBR 17225: 5\./u.test(value.normative));
      assert.deepEqual(await extension.evaluate(extension.startPage.page, '({x:scrollX,y:scrollY})'), { x: preserved.x, y: preserved.y });
      await extension.click(panel, '[data-intent="GO_TO_PAGE_MARKER"]');
      await extension.waitForValue(extension.startPage.page, `(() => {
        const r=document.querySelector('button.idless-primary').getBoundingClientRect();
        const roots=[...document.querySelector('[data-audita-page-markers-root="v1"]').shadowRoot.querySelectorAll('.audita-ring')];
        return r.top>=0&&r.bottom<=innerHeight&&roots.some(ring=>ring.style.display!=='none'&&
          Math.abs(parseFloat(ring.style.top)-r.top)<1&&Math.abs(parseFloat(ring.style.left)-r.left)<1);
      })()`, Boolean);
      await extension.captureJourney('idless-original-selected', extension.startPage.page, { captureBeyondViewport: false });
      // Restore only the harness scroll baseline for the unchanged silent-selection checks below.
      await extension.evaluate(extension.startPage.page, `scrollTo({left:${preserved.x},top:${preserved.y},behavior:'instant'})`);
    });
    if (scenario.idle) await step('IDLE_WITH_SIGNALS', async () => {
      await new Promise(resolve => setTimeout(resolve, 45_000));
      const targets = (await extension.browser.command('Target.getTargets')).targetInfos;
      assert.equal(targets.some(info => info.targetId === workerTarget.targetId && info.attached === false), true);
      assert.equal((await extension.evaluate(extension.startPage.page, markerSurface)).roots, 1);
      assert.equal((await waitForMarkerState(extension, panel, 'active')).state, 'active');
    });
    const expectedSelection = await step('PAGE_TO_ABNT', async () => {
      const number = await extension.evaluate(extension.startPage.page, `(() => {
        const button=document.querySelector('[data-audita-page-markers-root="v1"]').shadowRoot.querySelector('.audita-marker');
        return Number(button.getAttribute('aria-label').match(/^Sinal ([0-9]+)/)[1]);
      })()`);
      const expected = await extension.evaluate(panel, `(() => {
        const buttons=[...document.querySelectorAll('[data-intent="SELECT_OCCURRENCE"]')]
          .filter(button=>Number(button.querySelector('[data-page-marker-number]')?.dataset.pageMarkerNumber)===${number})
          .sort((a,b)=>a.dataset.focusId.localeCompare(b.dataset.focusId));
        const first=buttons[0];return {number:${number},focusId:first?.dataset.focusId,
          abnt:first?.closest('details[data-abnt-group]')?.dataset.abntGroup};
      })()`);
      assert.match(expected.focusId ?? '', /^occurrence-/u);
      assert.match(expected.abnt ?? '', /^5\./u);
      await extension.evaluate(extension.startPage.page, `(() => {
        document.querySelector('[data-audita-page-markers-root="v1"]').shadowRoot.querySelector('.audita-marker').click();return true;
      })()`, { userGesture: true });
      const selection = await extension.waitForValue(panel, `(() => {
        const button=document.querySelector('[data-intent="SELECT_OCCURRENCE"][aria-pressed="true"]');
        return {number:Number(button?.querySelector('[data-page-marker-number]')?.dataset.pageMarkerNumber),
          focusId:button?.dataset.focusId,abnt:button?.closest('details[data-abnt-group]')?.dataset.abntGroup,
          open:button?.closest('details[data-abnt-group]')?.open===true,
          normative:document.querySelector('[data-detail-block="normative"]')?.textContent??'',
          announcement:document.querySelector('[data-detail-block="accessibility"]')?.textContent??''};
      })()`, value => value?.number === number && value.focusId === expected.focusId && value.open === true);
      assert.equal(selection.abnt, expected.abnt);
      assert.ok(selection.normative.includes(`ABNT NBR 17225: ${expected.abnt}`));
      assert.match(selection.announcement, /Anúncio esperado:/u);
      assert.equal(await extension.evaluate(extension.startPage.page, 'globalThis.__markerControlClicks'), 0);
      // Panel selection and the page's validated select command arrive through
      // separate asynchronous channels. Require the exact ring, not a same-tick snapshot.
      await extension.waitForValue(extension.startPage.page, markerSurface,
        value => value.rings === 1 && value.selectedNumbers[0] === number,
        { timeoutMs: 10_000, intervalMs: 50 });
      return expected;
    });
    await step('PANEL_TO_PAGE_AND_KEYBOARD', async () => {
      const otherNumber = await extension.evaluate(panel, `(() => {
        const buttons=[...document.querySelectorAll('[data-intent="SELECT_OCCURRENCE"]')];
        const other=buttons.find(button=>{const number=Number(button.querySelector('[data-page-marker-number]')?.dataset.pageMarkerNumber);
          return number>0&&number!==${expectedSelection.number}});if(!other)return null;
        const number=Number(other.querySelector('[data-page-marker-number]').dataset.pageMarkerNumber);
        other.closest('details[data-abnt-group]').open=true;other.click();return number;
      })()`, { userGesture: true });
      assert.ok(otherNumber > 0 && otherNumber !== expectedSelection.number);
      await extension.waitForValue(extension.startPage.page, markerSurface,
        value => value.rings === 1 && value.selectedNumbers[0] === otherNumber);
      assert.deepEqual(await extension.evaluate(extension.startPage.page, '({x:scrollX,y:scrollY})'), { x: preserved.x, y: preserved.y });
      await step('EXPLICIT_GO', async () => {
        await extension.click(panel, '[data-intent="GO_TO_PAGE_MARKER"]');
        await extension.waitForValue(extension.startPage.page, 'scrollY', value => value !== preserved.y);
      });
      // Start from the final native page control, then Tab into the first
      // overlay button. Only the starting point is focused by the harness.
      await extension.evaluate(extension.startPage.page, `(() => {
        document.querySelector('a[href="/current"]').focus();return true;
      })()`);
      await extension.pressKey(extension.startPage.page, { key: 'Tab', code: 'Tab', virtualKeyCode: 9, modifiers: 0 });
      assert.equal(await extension.evaluate(extension.startPage.page, `document.querySelector('[data-audita-page-markers-root="v1"]').shadowRoot.activeElement?.className`), 'audita-marker');
      await activateMarkerByKey(extension, extension.startPage.page, 'Enter');
      await extension.waitForValue(panel, `document.querySelector('[data-intent="SELECT_OCCURRENCE"][aria-pressed="true"]')?.dataset.focusId`, value => value === expectedSelection.focusId);
      await extension.evaluate(panel, `(() => {
        const other=[...document.querySelectorAll('[data-intent="SELECT_OCCURRENCE"]')]
          .find(button=>Number(button.querySelector('[data-page-marker-number]')?.dataset.pageMarkerNumber)===${otherNumber});
        other.click();return true;
      })()`, { userGesture: true });
      await extension.waitForValue(extension.startPage.page, markerSurface, value => value.selectedNumbers[0] === otherNumber);
      // Selecting a control in the panel is an explicit focus interaction.
      // Return through the page's native tab order before testing Space there.
      await extension.evaluate(extension.startPage.page, `(() => {
        document.querySelector('a[href="/current"]').focus();return true;
      })()`);
      await extension.pressKey(extension.startPage.page, { key: 'Tab', code: 'Tab', virtualKeyCode: 9, modifiers: 0 });
      assert.equal(await extension.evaluate(extension.startPage.page, `document.querySelector('[data-audita-page-markers-root="v1"]').shadowRoot.activeElement?.className`), 'audita-marker');
      await activateMarkerByKey(extension, extension.startPage.page, ' ');
      await extension.waitForValue(extension.startPage.page, markerSurface,
        value => value.selectedNumbers[0] === expectedSelection.number);
      assert.equal(await extension.evaluate(extension.startPage.page, 'globalThis.__markerControlClicks'), 0);
      if (!scenario.idle) await step('QA_SCREENSHOTS', async () => {
        await extension.captureJourney('markers-original-selected', extension.startPage.page, { captureBeyondViewport: false });
        await extension.captureJourney('markers-panel-abnt-selected', panel, { captureBeyondViewport: false });
        await extension.evaluate(panel, `(() => {document.querySelector('#panel-root').scrollTop=0;return true})()`);
        await extension.captureJourney('markers-panel-summary', panel, { captureBeyondViewport: false });
        try {
          for (const width of [320, 360, 600]) {
            await extension.command(panel, 'Emulation.setDeviceMetricsOverride', {
              width, height: 900, deviceScaleFactor: 1, mobile: false,
            });
            const layout = await extension.evaluate(panel, `(() => {
              document.querySelector('#panel-root').scrollTop=0;
              const box=selector=>document.querySelector(selector).getBoundingClientRect();
              const buttons=[...document.querySelectorAll('[data-result-filter]')];
              return {
                overflow:document.querySelector('#panel-root').scrollWidth>document.querySelector('#panel-root').clientWidth,
                metricsVisible:buttons.every(node=>{const r=node.getBoundingClientRect();return r.top>=0&&r.bottom<900&&r.height>=44&&r.width>=44}),
                summaryBeforeActions:box('[data-result-filter]').top<box('[data-report-ready]').top,
                firstAbntBottom:box('[data-abnt-group] > summary').bottom,
                checklistBottom:box('[data-report-checklist] > summary').bottom,
                reportVisible:!document.querySelector('[data-intent="OPEN_REPORT"]').closest('details:not([open])'),
                statusVisible:!document.querySelector('[data-report-launch-status]').closest('details:not([open])'),
                markerVisible:!document.querySelector('[data-page-marker-review] button').closest('details:not([open])'),
                helpClosed:!document.querySelector('[data-marker-help]').open,
                guidanceClosed:!document.querySelector('[data-result-guidance]').open
              };
            })()`);
            assert.equal(layout.overflow, false, `horizontal reflow at ${width}px`);
            for (const key of ['metricsVisible','summaryBeforeActions','reportVisible','statusVisible','markerVisible','helpClosed','guidanceClosed']) {
              assert.equal(layout[key], true, `${key} at ${width}px`);
            }
            if (width === 360) {
              assert.ok(layout.checklistBottom < 900, `separate checklist below fold: ${layout.checklistBottom}`);
              assert.ok(layout.firstAbntBottom > layout.checklistBottom, 'checklist disclosure precedes finding groups');
              await extension.captureJourney('compact-panel-360', panel, { captureBeyondViewport: false });
            }
          }
          await extension.evaluate(panel, `(() => {document.documentElement.style.zoom='2';document.querySelector('#panel-root').scrollTop=0;return true})()`);
          assert.equal(await extension.evaluate(panel, `document.querySelector('#panel-root').scrollWidth>document.querySelector('#panel-root').clientWidth`), false, '200% CSS enlargement reflows without horizontal overflow');
          assert.equal(await extension.evaluate(panel, `[...document.querySelectorAll('[data-result-filter]')].every(node=>node.getBoundingClientRect().width>=200)`), true, 'enlarged metric cards must not compress labels into vertical strips');
          await extension.captureJourney('compact-panel-enlarged-200', panel, { captureBeyondViewport: false });
        } finally {
          await extension.evaluate(panel, `(() => {document.documentElement.style.zoom='';return true})()`);
          await extension.command(panel, 'Emulation.clearDeviceMetricsOverride');
        }
      });
    });
    await step('FILTER_AND_HIDE', async () => {
      const totals = await extension.evaluate(panel, `[...document.querySelectorAll('[data-result-filter]')].map(node=>node.textContent)`);
      const expected = await extension.evaluate(panel, `(() => {
        const rows=[...document.querySelectorAll('[data-intent="SELECT_OCCURRENCE"]')].map(button=>({
          number:Number(button.querySelector('[data-page-marker-number]')?.dataset.pageMarkerNumber),
          classification:button.closest('[data-result-card]').dataset.classification})).filter(row=>row.number>0);
        const classification=rows.some(row=>row.classification==='passed')?'passed':'failed';
        const counts={};for(const row of rows.filter(row=>row.classification===classification))counts[row.number]=(counts[row.number]??0)+1;
        return {classification,counts};
      })()`);
      assert.ok(Object.keys(expected.counts).length > 0);
      await extension.click(panel, `[data-result-filter="${expected.classification}"]`);
      const symbol = expected.classification === 'passed' ? '✓' : '×';
      const expectedLabels = Object.entries(expected.counts).map(([number, count]) => `${number}${symbol}${count}`).sort();
      await extension.waitForValue(extension.startPage.page, markerSurface, value => value.roots === 1 &&
        JSON.stringify(value.buttons.filter(button=>!button.hidden).map(button=>button.text).sort()) === JSON.stringify(expectedLabels));
      assert.deepEqual(await extension.evaluate(panel, `[...document.querySelectorAll('[data-result-filter]')].map(node=>node.textContent)`), totals);
      await extension.click(panel, '[data-focus-id="metric-all"]');
      await extension.click(panel, '[data-intent="HIDE_PAGE_MARKERS"]');
      await extension.waitForValue(extension.startPage.page, markerSurface, value => value.roots === 0);
      assert.equal(await extension.evaluate(extension.startPage.page, `Boolean(document.querySelector('#foreign-review-overlay'))`), true);
    });
    await step('NAVIGATION_CLEANUP', async () => {
      await extension.click(panel, '[data-intent="SHOW_PAGE_MARKERS"]');
      assert.equal((await waitForMarkerState(extension, panel, 'active')).state, 'active');
      await navigateRealPage(extension, extension.startPage, { url: `${fixture.origin}/other`, operationId: 'markers-document-b' });
      assert.equal((await extension.evaluate(extension.startPage.page, markerSurface)).roots, 0);
      await extension.waitForValue(panel, `document.querySelector('[data-page-marker-review]')?.dataset.markerStatus`, value => value === 'idle');
      await extension.waitForValue(panel, `Boolean(document.querySelector('[data-intent="SHOW_PAGE_MARKERS"]:not(:disabled)'))`, Boolean);
      await extension.click(panel, '[data-intent="SHOW_PAGE_MARKERS"]');
      assert.equal((await waitForMarkerState(extension, panel, 'unavailable')).state, 'unavailable');
      assert.equal((await extension.evaluate(extension.startPage.page, markerSurface)).roots, 0);
      assert.deepEqual(await markerRecordFingerprint(extension, auditId), fingerprint);
    });
    await step('REPORT_AND_EXPORT', async () => {
      await extension.click(panel, '[data-intent="OPEN_REPORT"]');
      const report = await extension.waitForReport({ auditId });
      await extension.waitForValue(report, `Boolean(document.querySelector('[data-report-export]'))`, Boolean, { timeoutMs: 30_000 });
      const surface = await extension.evaluate(report, reportSurfaceExpression());
      assert.equal(surface.ready && surface.abnt && surface.wcag && surface.announcement, true);
      assert.ok(surface.images > 0);
      assert.equal(surface.limitation, false, 'o relatório da página atual não é o de uma cópia recarregada');
      assert.equal(surface.passiveLimitation, true, 'o relatório deve declarar a observação passiva');
      assert.equal(surface.explanationVisible, false);
      if (!scenario.idle) await extension.captureJourney('markers-report-after-review', report, { captureBeyondViewport: false });
      await exportFourFormats(extension, report, auditId, extension.downloadDirectory);
      // Finalizing a verified export advances the storage revision once; the
      // canonical model, evidence and checkpoint themselves remain unchanged.
      assert.deepEqual(await markerRecordFingerprint(extension, auditId), { ...fingerprint, revision: fingerprint.revision + 1 });
      if (!scenario.idle) await step('LIVE_REVIEW_REFRESH', async () => {
        const prerequisites = await extension.evaluate(report, `(() => ({
          cards:document.querySelectorAll('#review-list > details').length,
          target:Boolean(document.querySelector('[data-review-controls-target]')),
          evaluator:Boolean(document.querySelector('#review-evaluator')),
          identity:/Revisão do modelo: [0-9]+/.test(document.querySelector('[data-report-section="7"]')?.textContent??'')
        }))()`);
        assert.ok(prerequisites.cards >= 2 && prerequisites.target && prerequisites.evaluator && prerequisites.identity,
          JSON.stringify(prerequisites));
        const beforeReview = await extension.evaluate(report, `(() => {
          const cards=[...document.querySelectorAll('#review-list > details')];
          if(cards.length<2)throw Error('REVIEW_FIXTURE_TOO_SMALL');
          document.querySelector('[data-review-controls-target]').open=true;
          cards[0].open=true;
          document.querySelector('#review-evaluator').value='Avaliadora QA';
          cards[1].querySelector('textarea').value='Nota ainda não salva';
          window.__reviewPreserved={list:document.querySelector('#review-list'),evaluator:document.querySelector('#review-evaluator'),next:cards[1]};
          const methodology=document.querySelector('[data-report-section="7"]').textContent;
          const before=Number(methodology.match(/Revisão do modelo: ([0-9]+)/)[1]);
          cards[0].querySelector('textarea').value='Barreira confirmada no teste local';
          [...cards[0].querySelectorAll('button')].find(node=>node.textContent==='não conforme').click();
          return before;
        })()`, { userGesture: true });
        const savedStatus = await extension.waitForValue(report, `document.querySelector('#review-status').textContent`,
          value => /Decisão salva.*Relatório atualizado|[Nn]ão foi possível/u.test(value), { timeoutMs: 15_000, intervalMs: 50 });
        assert.match(savedStatus, /Decisão salva.*Relatório atualizado/u);
        const refreshed = await extension.evaluate(report, `(() => {
          const kept=window.__reviewPreserved;
          const text=document.querySelector('[data-report-section="7"]').textContent;
          return {revision:Number(text.match(/Revisão do modelo: ([0-9]+)/)[1]),
            sameForms:document.querySelector('#review-list')===kept.list&&document.querySelector('#review-evaluator')===kept.evaluator,
            note:kept.next.querySelector('textarea').value,evaluator:kept.evaluator.value,
            focus:document.activeElement===kept.next.querySelector('summary'),
            open:kept.next.open&&document.querySelector('[data-review-controls-target]').open,
            answered:kept.list.firstElementChild.classList.contains('answered'),
            matrixRows:document.querySelectorAll('[data-report-matrix] tbody tr').length,
            history:document.querySelector('[data-review-history]')?.textContent??'',
            hash:text.match(/Integridade: ([a-f0-9]{64})/)[1]};
        })()`);
        assert.ok(refreshed.revision > beforeReview);
        for (const key of ['sameForms', 'focus', 'open', 'answered']) assert.equal(refreshed[key], true, key);
        assert.equal(refreshed.note, 'Nota ainda não salva');
        assert.equal(refreshed.evaluator, 'Avaliadora QA');
        assert.equal(refreshed.matrixRows, 146);
        assert.ok(refreshed.history.includes('Avaliadora QA') && refreshed.history.includes('Barreira confirmada no teste local'));
        const durable = await extension.evaluate(extension.harnessPage, `(async()=>{
          const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
          const revision=await store.getReportRevision(${JSON.stringify(auditId)});
          return {revision:revision.modelRevision,hash:revision.modelHash};
        })()`, { awaitPromise: true });
        assert.equal(refreshed.revision, durable.revision);
        assert.equal(refreshed.hash, durable.hash);
        await extension.captureJourney('report-after-live-review', report, { captureBeyondViewport: false });
        await exportFourFormats(extension, report, auditId, extension.downloadDirectory, {
          modelHash: durable.hash, modelRevision: durable.revision,
        });
      });
    });
    t.diagnostic(`Chrome152; native-page-markers; original-not-copy; ${scenario.idle
      ? 'no-worker-debugger-during-two-idle-windows' : 'visual-QA-without-idle-claim'}; four-verified-downloads`);
  } finally { await extension?.close().catch(() => {}); }
});

async function armSourceInvariantProof(extension) {
  const ready = await extension.evaluate(extension.startPage.page, `(async()=>{
    try{globalThis.__auditaSourceInvariantV1?.dispose?.()}catch{}
    const notes=document.querySelector('#source-notes');
    const selected=document.querySelector('#selection-target')?.firstChild;
    const styled=document.querySelector('#runtime-style-target');
    const serverImage=document.querySelector('img#missing-alt');
    const imageAlreadyRemoved=globalThis.__auditaP4dImageRemovedV1===true;
    if(!(notes instanceof HTMLTextAreaElement)||!(selected instanceof Text)||!(styled instanceof HTMLElement)||
      (!imageAlreadyRemoved&&!(serverImage instanceof HTMLImageElement))||(imageAlreadyRemoved&&serverImage!==null))return false;
    if(!imageAlreadyRemoved){
      serverImage.remove();
      Object.defineProperty(globalThis,'__auditaP4dImageRemovedV1',{
        value:true,configurable:true,enumerable:false,writable:false
      });
      notes.value=${JSON.stringify(memoryMarker)};
      notes.focus({preventScroll:true});
      notes.setSelectionRange(3,15,'forward');
      const range=document.createRange();
      range.setStart(selected,2);range.setEnd(selected,14);
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      styled.dataset.runtimeState='memory-only';
      styled.style.cssText='color:rgb(93,31,120);border:3px dashed rgb(12,94,81);padding:11px';
      styled.textContent='Estado mantido apenas em memória';
      history.replaceState({fixture:'source-intact',revision:7},'',location.href);
      history.scrollRestoration='manual';
      scrollTo(0,640);
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    }else if(notes.value!==${JSON.stringify(memoryMarker)}||styled.dataset.runtimeState!=='memory-only'||
      styled.textContent!=='Estado mantido apenas em memória')return false;
    const viewportStable=await new Promise(resolve=>{
      let prior=null;let equalSamples=0;let elapsed=0;
      const sample=()=>{
        const visual=visualViewport;
        const current=JSON.stringify({innerWidth,innerHeight,clientWidth:document.documentElement.clientWidth,
          clientHeight:document.documentElement.clientHeight,visual:visual?{width:visual.width,height:visual.height}:null});
        equalSamples=current===prior?equalSamples+1:0;prior=current;elapsed+=50;
        if(equalSamples>=4){resolve(true);return}
        if(elapsed>=2000){resolve(false);return}
        setTimeout(sample,50);
      };
      sample();
    });
    if(!viewportStable)return false;
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const eventNames=[
      'scroll','resize','focus','blur','focusin','focusout','visibilitychange','selectionchange',
      'beforeinput','input','change','click','pointerdown','pointerup','keydown','keyup',
      'popstate','hashchange','pagehide'
    ];
    const events=Object.fromEntries(eventNames.map(name=>[name,0]));
    const resizeSamples=[];
    const onEvent=event=>{
      if(!Object.hasOwn(events,event.type))return;
      events[event.type]+=1;
      // O percurso passivo não pode redimensionar o documento observado. Quando um evento de resize
      // aparece, a geometria do momento é a prova que separa a animação do painel de uma alteração
      // causada pela auditoria; sem ela o diagnóstico só diz "248 eventos".
      if(event.type==='resize'&&resizeSamples.length<24){
        const visual=visualViewport;
        resizeSamples.push('t='+Math.round(performance.now())+' '+innerWidth+'x'+innerHeight+'/'+
          document.documentElement.clientWidth+'x'+document.documentElement.clientHeight+
          (visual?'/'+Math.round(visual.width)+'x'+Math.round(visual.height):''));
      }
    };
    for(const name of eventNames)window.addEventListener(name,onEvent,true);
    const mutationCounts={childList:0,attributes:0,characterData:0};
    const recordMutations=records=>{for(const record of records)mutationCounts[record.type]+=1};
    const observer=new MutationObserver(recordMutations);
    observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
    const snapshot=()=>{
      const currentSelection=getSelection();
      const visual=visualViewport;
      return {
        href:location.href,title:document.title,html:document.documentElement.outerHTML,
        history:{length:history.length,state:JSON.stringify(history.state),scrollRestoration:history.scrollRestoration},
        scroll:{x:scrollX,y:scrollY},
        viewport:{
          innerWidth,innerHeight,devicePixelRatio,
          clientWidth:document.documentElement.clientWidth,clientHeight:document.documentElement.clientHeight,
          visual:visual?{width:visual.width,height:visual.height,offsetLeft:visual.offsetLeft,offsetTop:visual.offsetTop,scale:visual.scale}:null
        },
        focus:{hasFocus:document.hasFocus(),activeId:document.activeElement?.id??null},
        input:{value:notes.value,start:notes.selectionStart,end:notes.selectionEnd,direction:notes.selectionDirection},
        selection:{
          text:currentSelection?.toString()??'',anchorId:currentSelection?.anchorNode?.parentElement?.id??null,
          anchorOffset:currentSelection?.anchorOffset??null,focusId:currentSelection?.focusNode?.parentElement?.id??null,
          focusOffset:currentSelection?.focusOffset??null,rangeCount:currentSelection?.rangeCount??0
        },
        style:{attribute:styled.getAttribute('style'),state:styled.dataset.runtimeState,text:styled.textContent,
          color:getComputedStyle(styled).color,border:getComputedStyle(styled).border,padding:getComputedStyle(styled).padding},
        missingAltAbsent:document.querySelector('img#missing-alt')===null,
        overlays:document.querySelectorAll('[data-audita-highlight-root="v1"]').length
      };
    };
    const baseline=snapshot();
    const proof={
      compare(){
        recordMutations(observer.takeRecords());
        const current=snapshot();
        const eventTotal=Object.entries(events).filter(([name])=>name!=='visibilitychange')
          .reduce((sum,[,value])=>sum+value,0);
        const mutationTotal=Object.values(mutationCounts).reduce((sum,value)=>sum+value,0);
        return {
          stable:JSON.stringify(current)===JSON.stringify(baseline),
          url:current.href===baseline.href,title:current.title===baseline.title,dom:current.html===baseline.html,
          history:JSON.stringify(current.history)===JSON.stringify(baseline.history),
          scroll:JSON.stringify(current.scroll)===JSON.stringify(baseline.scroll),
          viewport:JSON.stringify(current.viewport)===JSON.stringify(baseline.viewport),
          focus:JSON.stringify(current.focus)===JSON.stringify(baseline.focus),
          input:JSON.stringify(current.input)===JSON.stringify(baseline.input),
          selection:JSON.stringify(current.selection)===JSON.stringify(baseline.selection),
          style:JSON.stringify(current.style)===JSON.stringify(baseline.style),
          missingAltAbsent:current.missingAltAbsent===true&&baseline.missingAltAbsent===true,
          eventTotal,mutationTotal,overlays:current.overlays,
          eventCounts:{...events},resizeSamples:[...resizeSamples],
          viewportBefore:baseline.viewport,viewportAfter:current.viewport
        };
      },
      dispose(){observer.disconnect();for(const name of eventNames)window.removeEventListener(name,onEvent,true)}
    };
    Object.defineProperty(globalThis,'__auditaSourceInvariantV1',{
      value:proof,configurable:true,enumerable:false,writable:false
    });
    return true;
  })()`, { awaitPromise: true });
  assert.equal(ready, true);
  return extension.identityOf(extension.startPage);
}

async function armTabIsolationProof(extension) {
  const ready = await extension.evaluate(extension.harnessPage, `(async() => {
    try{globalThis.__auditaCurrentCopyProofV1?.dispose?.()}catch{}
    const sourceTabId=${JSON.stringify(extension.startPage.tabId)};
    const sourceWindowId=${JSON.stringify(extension.startPage.windowId)};
    const initialTargets=await chrome.debugger.getTargets();
    const state={created:[],sourceUpdates:[],activations:[],removed:[],debugSamples:0,sourceDebugAttached:0,
      sourceDebuggerBaseline:initialTargets.some(target=>target.tabId===sourceTabId&&target.attached===true),sampling:false};
    const onCreated=tab=>{
      if(tab.windowId===sourceWindowId&&tab.id!==sourceTabId){
        state.created.push({tabId:tab.id,windowId:tab.windowId,active:tab.active===true});
      }
    };
    const onUpdated=(tabId,changeInfo)=>{
      if(tabId!==sourceTabId)return;
      const relevant=Object.keys(changeInfo).filter(key=>['url','status','discarded'].includes(key)).sort();
      if(relevant.length)state.sourceUpdates.push(relevant);
    };
    const onActivated=info=>state.activations.push({tabId:info.tabId,windowId:info.windowId});
    const onRemoved=(tabId,info)=>state.removed.push({tabId,windowId:info.windowId});
    chrome.tabs.onCreated.addListener(onCreated);chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onActivated.addListener(onActivated);chrome.tabs.onRemoved.addListener(onRemoved);
    const timer=setInterval(async()=>{
      if(state.sampling)return;state.sampling=true;
      try{
        const targets=await chrome.debugger.getTargets();state.debugSamples+=1;
        if(targets.some(target=>target.tabId===sourceTabId&&target.attached===true))state.sourceDebugAttached+=1;
      }finally{state.sampling=false}
    },10);
    const proof={state,dispose(){
      clearInterval(timer);chrome.tabs.onCreated.removeListener(onCreated);chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onActivated.removeListener(onActivated);chrome.tabs.onRemoved.removeListener(onRemoved);
    }};
    Object.defineProperty(globalThis,'__auditaCurrentCopyProofV1',{
      value:proof,configurable:true,enumerable:false,writable:false
    });
    return true;
  })()`, { awaitPromise: true });
  assert.equal(ready, true);
}


// `allowCaptureResize` existe por MEDIÇÃO, não por conveniência: capturar um elemento fora da viewport usa
// `Page.captureScreenshot` com `captureBeyondViewport: true`, e no Chrome 152 isso altera transitoriamente a
// geometria (medido: o viewport chega a 1x1 e volta; 248 eventos de `resize` num fixture de 240 controles,
// com a geometria final idêntica). É o limite já declarado do produto para regiões fora da viewport. O que
// NÃO é permitido em nenhum modo: navegação, mutação de DOM, rolagem, foco, seleção, entrada, estilo ou
// sobreposição — e a geometria final tem de ser exatamente a inicial (`viewport: true`).
async function assertSourceUntouched(extension, identityBefore,
  { allowCaptureResize = false, maxCaptureResizes = 512 } = {}) {
  const [comparison, identityAfter] = await Promise.all([
    extension.evaluate(extension.startPage.page, 'globalThis.__auditaSourceInvariantV1.compare()'),
    extension.identityOf(extension.startPage),
  ]);
  const diagnostic = {
    eventCounts: comparison.eventCounts,
    resizeSamples: comparison.resizeSamples,
    viewportBefore: comparison.viewportBefore,
    viewportAfter: comparison.viewportAfter,
  };
  const verified = { ...comparison };
  delete verified.eventCounts;
  delete verified.resizeSamples;
  delete verified.viewportBefore;
  delete verified.viewportAfter;
  const captureResizes = Number(comparison.eventCounts?.resize ?? 0);
  if (allowCaptureResize && captureResizes > 0) {
    // N-5 da revisão da 1.1.49: o perdão não pode ser incondicional. A geometria final continua obrigatória,
    // a oscilação tem TETO, nenhuma amostra pode colapsar o documento abaixo de 1x1 e a oscilação tem de
    // estar AMOSTRADA (alguma geometria diferente da inicial, ou a lista cheia, quando a amostragem trunca).
    assert.equal(comparison.viewport, true,
      `a geometria final tem de ser idêntica à inicial: ${JSON.stringify(diagnostic)}`);
    assert.ok(captureResizes <= maxCaptureResizes,
      `a oscilação da captura passou do teto medido: ${JSON.stringify({ captureResizes, maxCaptureResizes, eventCounts: comparison.eventCounts })}`);
    const geometries = (comparison.resizeSamples ?? [])
      .map(sample => /^t=\d+ (\d+)x(\d+)\//u.exec(sample))
      .filter(Boolean)
      .map(match => ({ width: Number(match[1]), height: Number(match[2]) }));
    assert.ok(geometries.length > 0, `a oscilação precisa deixar amostras: ${JSON.stringify(diagnostic)}`);
    assert.equal(geometries.every(({ width, height }) => width >= 1 && height >= 1), true,
      `nenhuma amostra pode colapsar o documento abaixo de 1x1: ${JSON.stringify(geometries)}`);
    const baseline = comparison.viewportBefore;
    const differs = ({ width, height }) => width !== baseline.innerWidth || height !== baseline.innerHeight;
    // Poucos eventos de `resize` também aparecem quando o PRÓPRIO painel assume a largura final (medido: 6
    // eventos sem mudança de geometria). O que não pode passar despercebido é a oscilação da captura: a
    // partir de um punhado de eventos, alguma amostra TEM de mostrar geometria diferente da inicial — sem
    // isso a oscilação não estaria medida, e o perdão seria fé, não prova.
    if (captureResizes > 16) {
      assert.equal(geometries.some(differs), true,
        `a oscilação da captura precisa estar amostrada: ${JSON.stringify({ geometries, baseline, captureResizes })}`);
    }
    verified.eventTotal -= captureResizes;
  }
  assert.deepEqual(verified, {
    stable: true, url: true, title: true, dom: true, history: true, scroll: true, viewport: true,
    focus: true, input: true, selection: true, style: true, missingAltAbsent: true,
    eventTotal: 0, mutationTotal: 0, overlays: 0,
  }, JSON.stringify(diagnostic));
  assert.equal(identityAfter.targetId === identityBefore.targetId &&
    identityAfter.frameId === identityBefore.frameId &&
    identityAfter.loaderId === identityBefore.loaderId && identityAfter.url === identityBefore.url, true,
  'a identidade do documento original mudou durante a auditoria');
}

// Percurso passivo (página atual): nenhuma cópia, nenhuma aba criada, nenhum registro de posse. O documento
// original continua sendo o único documento observado, com o CDP do próprio E2E possuindo a aba antes e depois.
// Teto da oscilação da captura, proporcional ao que foi capturado (medido: ~2 eventos por elemento; o teto é
// folgado, mas finito). Usado em TODAS as chamadas que perdoam `resize` — antes só uma delas tinha o teto
// proporcional (A-3 do adendo da 1.1.49).
function captureResizeCeiling(attempt) {
  return 8 * ((attempt?.elements ?? 0) + (attempt?.fullPage ?? 0)) + 32;
}

async function assertNoCopyCreated(extension, identityBefore, options = {}) {
  await assertSourceUntouched(extension, identityBefore, options);
  const proof = await extension.evaluate(extension.harnessPage, `(async()=>{
    await new Promise(resolve=>setTimeout(resolve,30));
    const stored=await chrome.storage.session.get(null);
    const proof=globalThis.__auditaCurrentCopyProofV1;
    const active=await chrome.tabs.query({active:true,windowId:${JSON.stringify(extension.startPage.windowId)}});
    let sourceDebuggerAttachedNow=false;
    try{sourceDebuggerAttachedNow=(await chrome.debugger.getTargets()).some(target=>
      target.tabId===${JSON.stringify(extension.startPage.tabId)}&&target.attached===true)}catch{sourceDebuggerAttachedNow=true}
    return {
      created:proof.state.created,sourceUpdates:proof.state.sourceUpdates,
      activations:proof.state.activations.filter(value=>value.tabId!==${JSON.stringify(extension.startPage.tabId)}).length,
      removals:proof.state.removed.filter(value=>value.tabId!==${JSON.stringify(extension.startPage.tabId)}).length,
      activeIds:active.map(tab=>tab.id),
      ownedRecords:Object.entries(stored).filter(([key])=>key.startsWith('audita:owned-tab:v2:')).length,
      debugSamples:proof.state.debugSamples,sourceDebugAttached:proof.state.sourceDebugAttached,
      sourceDebuggerBaseline:proof.state.sourceDebuggerBaseline,sourceDebuggerAttachedNow,
      sourceTabStillOpen:true
    };
  })()`, { awaitPromise: true });
  assert.deepEqual(proof.created, [], 'a auditoria da página atual não pode criar abas');
  assert.equal(proof.activations, 0, 'nenhuma aba pode ser ativada pela auditoria da página atual');
  assert.equal(proof.removals, 0, 'nenhuma aba pode ser fechada pela auditoria da página atual');
  assert.deepEqual(proof.activeIds, [extension.startPage.tabId]);
  assert.deepEqual(proof.sourceUpdates, []);
  assert.equal(proof.ownedRecords, 0, 'o percurso passivo não registra posse de aba');
  assert.ok(proof.debugSamples >= 1);
  assert.equal(proof.sourceDebuggerBaseline, true,
    'o CDP do próprio E2E deve possuir a aba original antes da auditoria');
  assert.equal(proof.sourceDebugAttached, proof.debugSamples,
    'a posse externa do CDP sobre a origem não pode oscilar durante a auditoria');
  assert.equal(proof.sourceDebuggerAttachedNow, true);
  return proof;
}

async function stopServiceWorker(extension) {
  const worker = await waitForServiceWorker(extension);
  assert.equal(await extension.evaluate(worker,
    `(() => { globalThis.__auditaP4dWorkerProof='before-stop'; return globalThis.__auditaP4dWorkerProof; })()`),
  'before-stop');
  const expectedUrl = `chrome-extension://${extension.extensionId}/src/background/service-worker.js`;
  await extension.command(extension.harnessPage, 'ServiceWorker.disable');
  const runningEvent = extension.harnessPage.waitForEvent('ServiceWorker.workerVersionUpdated', value =>
    Array.isArray(value?.versions) && value.versions.some(version =>
      version?.scriptURL === expectedUrl && version?.runningStatus === 'running'), { timeoutMs: 10_000 });
  await extension.command(extension.harnessPage, 'ServiceWorker.enable');
  const running = await runningEvent;
  const versions = running.versions.filter(version =>
    version?.scriptURL === expectedUrl && version?.runningStatus === 'running');
  assert.equal(versions.length, 1);
  const stoppedEvent = extension.harnessPage.waitForEvent('ServiceWorker.workerVersionUpdated', value =>
    Array.isArray(value?.versions) && value.versions.some(version =>
      version?.versionId === versions[0].versionId && version?.runningStatus === 'stopped'), { timeoutMs: 10_000 });
  await extension.command(extension.harnessPage, 'ServiceWorker.stopWorker', { versionId: versions[0].versionId });
  await stoppedEvent;
}

async function proveReplacementServiceWorker(extension) {
  const replacement = await waitForServiceWorker(extension, { timeoutMs: 20_000, intervalMs: 50 });
  assert.equal(await extension.evaluate(replacement,
    `typeof globalThis.__auditaP4dWorkerProof==='undefined'`), true);
}

function privacyPauseExpression() {
  return `(() => {
    const root=document.querySelector('[data-screen="running"][data-session-status="privacy-paused"]');
    return root?{
      screen:root.dataset.screen,status:root.dataset.sessionStatus,
      categories:[...root.querySelectorAll('.privacy-signals li')].map(item=>item.textContent),
      confirm:root.querySelector('[data-action="confirm-pixel-capture"]')?.textContent??null,
      cancel:root.querySelector('button[data-intent="CANCEL_AUDIT"]')?.textContent??null
    }:null;
  })()`;
}

async function waitForPrivacyPause(extension, panel) {
  return extension.waitForValue(panel, privacyPauseExpression(), value =>
    value?.screen === 'running' && value?.status === 'privacy-paused' &&
    value?.categories?.includes('Campo de senha') && value?.categories?.includes('Conteúdo marcado como privado') &&
    /Continuar e capturar/u.test(value?.confirm ?? '') && /Cancelar auditoria/u.test(value?.cancel ?? ''), {
    timeoutMs: 30_000, intervalMs: 50,
  });
}

async function confirmOnce(extension, panel) {
  await extension.click(panel, '[data-action="confirm-pixel-capture"]');
  const pending = await extension.waitForValue(panel, `(() => {
    const button=document.querySelector('[data-action="confirm-pixel-capture"]');
    return button?{label:button.textContent,disabled:button.getAttribute('aria-disabled'),count:
      document.querySelectorAll('[data-action="confirm-pixel-capture"]').length}:null;
  })()`, value => value?.label === 'Confirmação enviada' && value?.disabled === 'true', {
    timeoutMs: 10_000, intervalMs: 25,
  });
  assert.deepEqual(pending, { label: 'Confirmação enviada', disabled: 'true', count: 1 });
  assert.equal(await extension.evaluate(panel, `(() => {
    const button=document.querySelector('[data-action="confirm-pixel-capture"]');button?.click();
    return button?.getAttribute('aria-disabled')??null;
  })()`, { userGesture: true }), 'true');
}

async function readPrivateAttempt(extension, requestedAuditId = null) {
  return extension.evaluate(extension.harnessPage, `(async()=>{
    const stored=await chrome.storage.session.get(null);
    const active=stored['audita:active-audit-job:v1']??null;
    const auditId=${JSON.stringify(requestedAuditId)}??active?.auditId??null;
    const owners=[];
    for(const [key,value] of Object.entries(stored)){
      if(!key.startsWith('audita:owned-tab:v2:')||value?.auditId!==auditId)continue;
      let tabExists=true;let tabActive=false;
      try{tabActive=(await chrome.tabs.get(value.tabId)).active===true}catch{tabExists=false}
      owners.push({tabId:value.tabId,windowId:value.windowId,state:value.state,cleanupMode:value.cleanupMode,
        tabExists,tabActive});
    }
    const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
    const [audit,revision,latest,exportJournal]=await Promise.all([
      store.getAudit(auditId),store.getReportRevision(auditId),store.getLatest(),
      store.getExportDeliveryJournal(auditId)
    ]);
    const model=revision?.model??null;
    const evidence=Array.isArray(model?.evidence)?model.evidence:[];
    const publicText=JSON.stringify({audit,revision,latest:latest?.auditId===auditId?latest:null});
    const sessionText=JSON.stringify(stored);
    const forbiddenPublic=${JSON.stringify([queryMarker, fragmentMarker, memoryMarker, ...privateFieldNames])};
    const rawNavigationCount=Object.keys(stored).filter(key=>
      key.startsWith('audita:raw-navigation:v1:')||key.startsWith('audita:raw-navigation-queue:v1:')||
      key==='audita:raw-navigation-cleanup:v1').length;
    const pixelStateCount=Object.keys(stored).filter(key=>
      key.startsWith('audita:pixel-capture:v1:')||key.startsWith('audita:pixel-attempt:v1:')).length;
    const pixelCompanionPresent=await new Promise(resolve=>{
      const opening=indexedDB.open('audita-mt');
      opening.onerror=()=>resolve(null);
      opening.onsuccess=()=>{
        const database=opening.result;let transaction;
        try{transaction=database.transaction('audits','readonly')}catch{database.close();resolve(null);return}
        const request=transaction.objectStore('audits').get('__audit_checkpoint__:/pixel-attempt/:'+auditId);
        request.onerror=()=>{database.close();resolve(null)};
        request.onsuccess=()=>{const present=request.result!==undefined;database.close();resolve(present)};
      };
    });
    return {
      auditId,
      activeSame:active?.auditId===auditId,activeState:active?.auditId===auditId?active.state:null,
      latestSame:latest?.auditId===auditId,
      latestStatus:latest?.auditId===auditId?latest.status:null,
      latestFailureCode:latest?.auditId===auditId?latest.failureCode:null,
      latestMessage:latest?.auditId===auditId?latest.message:null,
      owners,auditPresent:Boolean(audit),modelPresent:Boolean(model),reportPresent:Boolean(revision),
      evidenceCount:evidence.length,exportJournalCount:Array.isArray(exportJournal)?exportJournal.length:null,
      executionCheckpointPresent:Object.hasOwn(stored,'audita:execution-checkpoint:v1:'+auditId),
      status:model?.session?.status??null,
      knownOccurrenceRefs:(model?.occurrences??[]).filter(item=>item?.nbrItemRef===${JSON.stringify(knownOccurrence.abnt)})
        .map(item=>({ruleId:item?.ruleId??null,source:item?.source??null,selector:item?.target?.selector??null,
          nodeId:item?.nodeId??null,nbrItemRef:item?.nbrItemRef??null,outcome:item?.outcome??null,
          evidenceRefs:item?.evidenceRefs??[],itemWcagRefs:item?.itemWcagRefs??[],
          sourceWcagRefs:item?.sourceWcagRefs??[],testedWcagRefs:item?.testedWcagRefs??[],wcagRefs:item?.wcagRefs??[]})),
      knownLiveOccurrence:Boolean(model?.occurrences?.some(item=>
        item?.source?.ruleId===${JSON.stringify(knownOccurrence.ruleId)}&&
        item?.nbrItemRef===${JSON.stringify(knownOccurrence.abnt)}&&
        item?.itemWcagRefs?.includes(${JSON.stringify(knownOccurrence.wcag)})&&
        item?.evidenceRefs?.some(evidenceId=>{
          const artifact=evidence.find(value=>value?.evidenceId===evidenceId);
          return artifact?.nodeId===item?.nodeId&&${JSON.stringify(knownOccurrence.selectors)}.includes(artifact?.selector?.css);
        }))),
      knownLiveSelector:(()=>{
        const item=(model?.occurrences??[]).find(candidate=>
          candidate?.source?.ruleId===${JSON.stringify(knownOccurrence.ruleId)}&&
          candidate?.nbrItemRef===${JSON.stringify(knownOccurrence.abnt)}&&
          candidate?.itemWcagRefs?.includes(${JSON.stringify(knownOccurrence.wcag)})&&
          candidate?.evidenceRefs?.some(evidenceId=>{
            const artifact=evidence.find(value=>value?.evidenceId===evidenceId);
            return artifact?.nodeId===candidate?.nodeId&&${JSON.stringify(knownOccurrence.selectors)}.includes(artifact?.selector?.css);
          }));
        if(!item)return null;
        const artifact=evidence.find(value=>item.evidenceRefs?.includes(value?.evidenceId)&&value?.nodeId===item.nodeId);
        return artifact?.selector?.css??null;
      })(),
      fullPage:evidence.filter(item=>item?.kind==='full-page'&&/^data:image\\/png;base64,/u.test(item.dataUrl??'')).length,
      elements:evidence.filter(item=>item?.kind==='element'&&/^data:image\\/png;base64,/u.test(item.dataUrl??'')).length,
      rasterDataUrls:(publicText.match(/data:image\\/(?:png|jpeg|webp);base64,/giu)||[]).length,
      diagnostics:Array.isArray(model?.session?.diagnostics)?model.session.diagnostics.map(item=>item.code):[],
      urls:[model?.requestedUrl,model?.finalUrl,model?.pages?.[0]?.requestedUrl,model?.pages?.[0]?.finalUrl],
      forbiddenPublicCount:forbiddenPublic.filter(value=>publicText.includes(value)).length,
      forbiddenSessionUrlCount:${JSON.stringify([queryMarker, fragmentMarker, memoryMarker])}.filter(value=>sessionText.includes(value)).length,
      sessionRasterDataUrls:(sessionText.match(/data:image\\/(?:png|jpeg|webp);base64,/giu)||[]).length,
      startJournalPresent:Object.hasOwn(stored,'audita:start-journal:v1'),
      rawNavigationCount,pixelStateCount,pixelCompanionPresent
    };
  })()`, { awaitPromise: true });
}

async function waitForActiveAuditId(extension) {
  return extension.waitForValue(extension.harnessPage, `(async()=>{
    const active=(await chrome.storage.session.get('audita:active-audit-job:v1'))['audita:active-audit-job:v1'];
    return typeof active?.auditId==='string'?active.auditId:null;
  })()`, value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(value), {
    timeoutMs: 10_000, intervalMs: 25,
  });
}



async function waitForActiveAuditCleanup(extension, auditId) {
  return extension.waitForValue(extension.harnessPage, `(async()=>{
    const active=(await chrome.storage.session.get('audita:active-audit-job:v1'))['audita:active-audit-job:v1'];
    return active?.auditId===${JSON.stringify(auditId)}?false:true;
  })()`, value => value === true, {
    timeoutMs: 30_000, intervalMs: 50,
  });
}

async function waitForResult(extension, panel, expectedAuditId = null) {
  const terminal = await extension.waitForValue(panel, `(() => ({
    screen:document.querySelector('[data-screen]')?.dataset.screen??null,
    auditId:document.querySelector('[data-screen="result"]')?.dataset.auditId??null,
    status:document.querySelector('[role="status"]')?.textContent??null
  }))()`, value => ['result', 'initial', 'unavailable'].includes(value?.screen) ||
    value?.status === 'Não foi possível confirmar a captura. Cancele a auditoria ou aguarde uma nova confirmação.', {
    timeoutMs: 120_000, intervalMs: 50,
  });
  if (terminal.screen !== 'result') {
    const attempt = expectedAuditId === null ? null : await readPrivateAttempt(extension, expectedAuditId).catch(() => null);
    const progressProof = await extension.evaluate(panel, `(() => ({
      samples:globalThis.__auditaP4dProgressV1?.state?.samples??[],
      terminalResult:globalThis.__auditaP4dProgressV1?.state?.terminalResult===true
    }))()`).catch(() => null);
    assert.equal(terminal.screen, 'result', JSON.stringify({
      screen: terminal.screen, status: terminal.status, attempt, progressProof,
    }));
  }
  assert.match(terminal.auditId ?? '', /^[A-Za-z0-9._:-]{1,160}$/u);
  return terminal.auditId;
}

async function armProgressObserver(extension, panel) {
  const armed = await extension.evaluate(panel, `(() => {
    globalThis.__auditaP4dProgressV1?.observer?.disconnect?.();
    const state={samples:[],terminalResult:false};
    const sample=()=>{
      const root=document.querySelector('[data-screen]');
      const progress=root?.querySelector('progress[data-audit-progress]');
      const percent=progress?.hasAttribute('value')?Number(progress.value):null;
      const phase=[...root?.querySelectorAll?.('[data-running-phases] li')??[]]
        .find(item=>item.getAttribute('aria-current')==='step')?.textContent?.trim()??null;
      const previous=state.samples.at(-1);
      if(root?.dataset.screen==='result')state.terminalResult=true;
      if(root?.dataset.screen==='running'&&Number.isFinite(percent)&&
        (!previous||previous.percent!==percent||previous.phase!==phase))state.samples.push({percent,phase});
    };
    const observer=new MutationObserver(sample);observer.observe(document,{subtree:true,childList:true,attributes:true});
    Object.defineProperty(globalThis,'__auditaP4dProgressV1',{
      configurable:true,enumerable:false,writable:false,value:{state,observer}
    });
    sample();return true;
  })()`);
  assert.equal(armed, true);
}

async function assertObservedProgress(extension, panel) {
  const proof = await extension.evaluate(panel, `(() => {
    const proof=globalThis.__auditaP4dProgressV1;proof?.observer?.takeRecords?.();
    const root=document.querySelector('[data-screen]');
    if(root?.dataset.screen==='result')proof.state.terminalResult=true;
    return {samples:proof?.state?.samples??[],terminalResult:proof?.state?.terminalResult===true};
  })()`);
  const percents = proof.samples.map(sample => sample.percent);
  assert.equal(proof.terminalResult, true);
  assert.equal(percents.length >= 2, true, JSON.stringify({ observedProgressSamples: percents.length }));
  assert.equal(percents.every((value, index) => index === 0 || value >= percents[index - 1]), true);
  assert.equal(new Set(percents).size >= 2, true);
  assert.equal(Math.max(...percents) >= 92, true);
}

async function beginAttachedAttempt(extension, panel, mode) {
  // Establish native visibility before arming source invariants, never during inspection.
  await panel.command('Page.bringToFront');
  await extension.waitForValue(panel,
    'document.visibilityState', value => value === 'visible', { timeoutMs: 10_000, intervalMs: 50 });
  await extension.evaluate(panel, 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))',
    { awaitPromise: true });
  await extension.waitForValue(panel,
    `document.querySelector('[data-screen]')?.dataset.screen`, value => value === 'initial', {
      timeoutMs: 30_000, intervalMs: 50,
    });
  await extension.waitForValue(panel, `(() => {
    const input=document.querySelector('input[data-capture-mode="${mode}"]');
    const button=document.querySelector('button[data-intent="START_ATTACHED"]');
    return Boolean(input&&!input.disabled&&button&&!button.disabled);
  })()`, value => value === true, { timeoutMs: 10_000, intervalMs: 25 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await extension.click(panel, `input[data-capture-mode="${mode}"]`);
    try {
      await extension.waitForValue(panel,
        `document.querySelector('input[name="capture-mode"]:checked')?.value`, value => value === mode, {
          timeoutMs: 5_000, intervalMs: 25,
        });
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      // Um bootstrap ocioso pode re-renderizar a tela inicial logo depois de o painel abrir e devolver a
      // seleção ao padrão. Repetir o clique é o que o usuário faria; a asserção seguinte continua exigindo o
      // modo escolhido, os controles habilitados e a fonte intocada antes do arranque.
      await extension.waitForValue(panel,
        `document.querySelector('[data-screen]')?.dataset.screen`, value => value === 'initial', {
          timeoutMs: 10_000, intervalMs: 50,
        });
    }
  }
  await armTabIsolationProof(extension);
  await armProgressObserver(extension, panel);
  const identityBefore = await armSourceInvariantProof(extension);
  const ready = await extension.evaluate(panel, `(() => {
    const root=document.querySelector('[data-screen]');
    const button=document.querySelector('button[data-intent="START_ATTACHED"]');
    return {
      screen:root?.dataset.screen??null,
      selected:document.querySelector('input[name="capture-mode"]:checked')?.value??null,
      button:Boolean(button),disabled:button?.disabled??null,
      ariaDisabled:button?.getAttribute('aria-disabled')??null,
      status:document.querySelector('[role="status"]')?.textContent??null
    };
  })()`);
  const { status, ...controls } = ready;
  assert.deepEqual(controls, {
    screen: 'initial', selected: mode, button: true, disabled: false,
    ariaDisabled: null,
  });
  // A completed cancellation may leave its acknowledgement in the live region;
  // both messages are compatible with these proven, enabled initial controls.
  assert.ok(['Escolha como iniciar a auditoria.', 'Cancelamento solicitado.'].includes(status));
  await assertSourceUntouched(extension, identityBefore);
  const auditIdPromise = waitForActiveAuditId(extension);
  await extension.click(panel, 'button[data-intent="START_ATTACHED"]');
  return { identityBefore, auditIdPromise };
}

function assertSanitizedModelUrls(values, fixtureOrigin) {
  assert.equal(Array.isArray(values) && values.length === 4, true);
  for (const value of values) {
    assert.equal(typeof value, 'string');
    const parsed = new URL(value);
    assert.equal(parsed.origin, fixtureOrigin);
    assert.equal(parsed.pathname, '/current');
    assert.equal(parsed.search, '');
    assert.equal(parsed.hash, '');
  }
}

// Pausa por privacidade no percurso passivo: a sessão existe, o trabalho terminou antes de qualquer raster, e
// NÃO há posse de aba — o documento pausado é o próprio documento do usuário.
async function assertPausedObservedAttempt(extension, auditId, identityBefore) {
  const attempt = await readPrivateAttempt(extension, auditId);
  assert.equal(attempt.activeSame, true);
  assert.equal(attempt.activeState, 'privacy-paused');
  assert.deepEqual(attempt.owners, []);
  assert.equal(attempt.auditPresent, false);
  assert.equal(attempt.modelPresent, false);
  assert.equal(attempt.reportPresent, false);
  assert.equal(attempt.evidenceCount, 0);
  assert.equal(attempt.exportJournalCount, 0);
  assert.equal(attempt.executionCheckpointPresent, true);
  assert.equal(attempt.sessionRasterDataUrls, 0, 'nenhum raster pode existir antes do consentimento');
  assert.equal(attempt.forbiddenSessionUrlCount, 0);
  assert.equal(attempt.startJournalPresent, false);
  assert.equal(attempt.rawNavigationCount, 0);
  assert.equal(attempt.pixelStateCount >= 1, true);
  await assertNoCopyCreated(extension, identityBefore);
  return attempt;
}

async function assertObservedTerminalAttempt(extension, auditId, identityBefore, expected, fixtureOrigin) {
  await waitForActiveAuditCleanup(extension, auditId);
  const attempt = await readPrivateAttempt(extension, auditId);
  assert.equal(attempt.activeSame, false);
  assert.equal(attempt.auditPresent, true);
  assert.equal(attempt.modelPresent, true);
  assert.equal(attempt.reportPresent, true);
  assert.deepEqual(attempt.owners, [], 'o percurso passivo não deixa posse de aba');
  assert.equal(attempt.knownLiveOccurrence, true,
    `a falha do botão sem nome do documento VIVO deve estar no modelo, com evidência de elemento correlacionada: ${JSON.stringify(attempt.knownOccurrenceRefs)}`);
  const liveResolution = await extension.evaluate(extension.startPage.page, `(() => {
    let node=null;
    try{node=document.querySelector(${JSON.stringify(attempt.knownLiveSelector)})}catch{return {ok:false,reason:'selector-invalid'}}
    if(!node)return {ok:false,reason:'not-found'};
    const name=(node.getAttribute('aria-label')??node.textContent??'').trim();
    return {ok:node.tagName==='BUTTON'&&name==='',tag:node.tagName,id:node.id??null,name};
  })()`);
  assert.equal(liveResolution.ok, true,
    `o seletor registrado na evidência deve resolver, no documento vivo, ao botão sem nome acessível: ${JSON.stringify(liveResolution)}`);
  assert.equal(attempt.executionCheckpointPresent, false);
  assert.equal(attempt.exportJournalCount, 0);
  assert.ok(['complete', 'partial'].includes(attempt.status));
  assert.equal(attempt.fullPage >= expected.minimumFullPage, true, JSON.stringify({ fullPage: attempt.fullPage }));
  assert.equal(attempt.elements >= expected.minimumElements, true, JSON.stringify({ elements: attempt.elements }));
  if (expected.fullPageExact !== undefined) assert.equal(attempt.fullPage, expected.fullPageExact);
  if (expected.elementsExact !== undefined) assert.equal(attempt.elements, expected.elementsExact);
  assert.equal(attempt.diagnostics.includes('ATTACHED_COPY_RELOADED'), false,
    'a página atual não é auditada em cópia recarregada');
  assert.equal(attempt.diagnostics.includes('DYNAMIC_PROBES_OMITTED_PASSIVE'), true);
  for (const diagnostic of expected.diagnostics ?? []) assert.equal(attempt.diagnostics.includes(diagnostic), true);
  assert.equal(attempt.forbiddenPublicCount, 0);
  assert.equal(attempt.forbiddenSessionUrlCount, 0);
  assert.equal(attempt.startJournalPresent, false);
  assert.equal(attempt.rawNavigationCount, 0);
  assert.equal(attempt.pixelStateCount, 0);
  assert.equal(attempt.pixelCompanionPresent, false);
  assertSanitizedModelUrls(attempt.urls, fixtureOrigin);
  const capturesPixels = (expected.minimumElements ?? 0) > 0 || (expected.minimumFullPage ?? 0) > 0;
  // Teto medido: a oscilação observada ficou em ~2 eventos por elemento capturado (248 num fixture de 240
  // controles, com ~124 elementos capturados). O teto é folgado, mas finito — uma oscilação descontrolada
  // (ou um laço de redimensionamento) reprova em vez de passar despercebida.
  const captured = (attempt.elements ?? 0) + (attempt.fullPage ?? 0);
  await assertNoCopyCreated(extension, identityBefore, {
    allowCaptureResize: capturesPixels, maxCaptureResizes: 8 * captured + 32,
  });
  return attempt;
}

async function assertPanelSummaryAndDetail(extension, panel, mode, expectedImages, identityBefore,
  { maxCaptureResizes = 512 } = {}) {
  const summary = await extension.evaluate(panel, `(() => ({
    coverage:Number(document.querySelector('progress.coverage-progress')?.max??0),
    failures:document.querySelectorAll('[data-result-card][data-classification="failed"]').length,
    occurrences:document.querySelectorAll('button[data-intent="SELECT_OCCURRENCE"]').length,
    forbiddenCount:${JSON.stringify([queryMarker, fragmentMarker, memoryMarker, ...privateFieldNames])}
      .filter(value=>(document.documentElement?.outerHTML??'').includes(value)).length
  }))()`);
  assert.ok(summary.coverage > 0);
  assert.ok(summary.failures > 0);
  assert.ok(summary.occurrences > 0);
  assert.equal(summary.forbiddenCount, 0);
  const selectedIndex = await extension.evaluate(panel, `(() => {
    const expected=${JSON.stringify(JSON.stringify(['page-1', 'audita-core', 'accessible-component-name']))};
    const card=[...document.querySelectorAll('[data-result-card]')]
      .find(value=>value.dataset.checkKey===expected);
    const button=card?.querySelector('button[data-intent="SELECT_OCCURRENCE"]');
    if(!button)return -1;
    const group=card.closest('details[data-abnt-group]');
    if(group&&!group.open)group.querySelector('summary').click();
    const index=[...document.querySelectorAll('button[data-intent="SELECT_OCCURRENCE"]')].indexOf(button);
    button.click();return index;
  })()`, { userGesture: true });
  if (selectedIndex < 0) {
    await extension.captureJourney('panel-current-copy-missing-card', panel);
    const cardKeys = await extension.evaluate(panel,
      `Array.from(document.querySelectorAll('[data-result-card]'), card => card.dataset.checkKey)`);
    assert.fail(`a falha detectada de rótulo deve existir no sumário: ${JSON.stringify(cardKeys)}`);
  }
  assert.equal(Number.isSafeInteger(selectedIndex) && selectedIndex >= 0, true,
    'a falha detectada de rótulo deve existir no sumário');
  const detail = await extension.waitForValue(panel, `(() => {
      const selected=[...document.querySelectorAll('button[data-intent="SELECT_OCCURRENCE"]')]
        .findIndex(button=>button.getAttribute('aria-pressed')==='true');
      const technical=document.querySelector('[data-detail-block="technical"]');
      const selector=[...technical?.querySelectorAll('.technical-field')??[]]
        .find(field=>field.querySelector('.technical-label')?.textContent==='Seletor sanitizado')
        ?.querySelector('code')?.textContent??null;
      return {
        selected,selector,visible:Boolean(document.querySelector('[data-result-detail]')),
        normative:[...document.querySelectorAll('[data-detail-block="normative"] p')].map(node=>node.textContent),
        accessibility:document.querySelector('[data-detail-block="accessibility"]')?.textContent??'',
        technical:technical?.textContent??'',
        previewText:document.querySelector('[data-detail-block="previews"]')?.textContent??'',
        images:document.querySelectorAll('[data-detail-block="previews"] [data-evidence-preview-image]').length,
        consult:Boolean(document.querySelector('[data-action="consult-evidence"]')),
        highlight:Boolean(document.querySelector('[data-action="highlight-occurrence"]'))
      };
    })()`, value => value?.visible === true && value?.selected === selectedIndex &&
      (value?.highlight === true || value?.consult === true), {
    timeoutMs: 15_000, intervalMs: 25,
  });
  // N-4 da revisão da 1.1.49: o seletor exibido na ficha não pode ser só "string não vazia" — ele tem de
  // resolver, no documento VIVO, ao mesmo tipo de elemento sem nome acessível que a auditoria observou.
  assert.ok(typeof detail.selector === 'string' && detail.selector.length > 0,
    `a ficha da ocorrência observada deve trazer o seletor sanitizado: ${JSON.stringify(detail.selector)}`);
  const sheetResolution = await extension.evaluate(extension.startPage.page, `(() => {
    let node=null;
    try{node=document.querySelector(${JSON.stringify(detail.selector)})}catch{return {ok:false,reason:'selector-invalid'}}
    if(!node)return {ok:false,reason:'not-found'};
    const name=(node.getAttribute('aria-label')??node.textContent??'').trim();
    // A ficha pode apontar o botão sem nome OU o campo sem rótulo — os dois achados reais desta fixture. O
    // que a asserção exige é que o seletor exibido resolva, no documento VIVO, a um elemento defeituoso.
    const labelled = Boolean(node.getAttribute('aria-label')??node.getAttribute('aria-labelledby'));
    const hasLabelElement = typeof node.labels?.length === 'number' ? node.labels.length > 0 : false;
    const inputWithoutLabel = node.tagName==='INPUT' && !labelled && !hasLabelElement;
    return {ok:(node.tagName==='BUTTON'&&name==='')||inputWithoutLabel,
      tag:node.tagName,id:node.id??null,name,labelled,hasLabelElement};
  })()`);
  assert.equal(sheetResolution.ok, true,
    `o seletor da ficha do painel deve resolver, no documento vivo, a um elemento com o defeito observado: ${JSON.stringify({selector: detail.selector, sheetResolution})}`);
  assert.match(detail.normative.join(' '), /WCAG[^]{0,60}4\.1\.2/u);
  assert.match(detail.normative.join(' '), /ABNT NBR 17225: 5\.13\.10/u);
  assert.match(detail.accessibility, /Anúncio esperado:\s*\S/u);
  assert.match(detail.technical, /Regra:\s*accessible-component-name/u);
  assert.match(detail.technical, /Trecho sanitizado/u);
  assert.match(detail.previewText, /Evidências/u);
  // A sessão da página atual é viva: o painel oferece o destaque no próprio documento observado, e não o
  // caminho alternativo de consulta usado quando não há elemento destacável.
  assert.equal(detail.highlight, true);
  assert.equal(detail.consult, false);
  if (mode === 'no-pixels') assert.equal(detail.images, 0);
  else if (mode === 'full-evidence') {
    assert.equal(detail.images >= expectedImages ||
      /Prévia omitida no painel para manter o resultado leve/u.test(detail.previewText), true,
    'o painel deve exibir a miniatura ou informar que a captura integral está no relatório');
  } else assert.equal(detail.images >= expectedImages, true);
  await assertSourceUntouched(extension, identityBefore,
    { allowCaptureResize: mode !== 'no-pixels', maxCaptureResizes });
}

function reportSurfaceExpression() {
  return `(() => {
    const text=document.body?.textContent??'';
    const html=document.documentElement?.outerHTML??'';
    const explanation=document.querySelector('#report-source-explanation');
    const back=document.querySelector('#return-to-page');
    return {
      ready:Boolean(document.querySelector('button[data-report-export]')),
      issues:document.querySelectorAll('[data-report-issue]').length,
      wcag:text.includes('WCAG 2.2:'),abnt:text.includes('ABNT NBR 17225:'),
      announcement:text.includes('Anúncio estimado:'),selector:text.includes('Seletor:'),
      limitation:(document.body?.textContent??'').includes(${JSON.stringify(attachedCopyLimitation)}),
      passiveLimitation:(document.body?.textContent??'').includes(${JSON.stringify(passiveObservationLimitation)}),
      explanationVisible:Boolean(explanation&&!explanation.hidden&&/cópia temporária/iu.test(explanation.textContent??'')),
      returnHidden:Boolean(back?.hidden),returnDisabled:Boolean(back?.disabled),
      highlightControls:document.querySelectorAll('[data-report-highlight-control]').length,
      evidenceOnly:document.querySelectorAll('[data-report-live-action="evidence-only"]').length,
      images:document.querySelectorAll('[data-report-evidence-preview] img.evidence-media, [data-report-evidence-preview] svg.evidence-media image').length,
      forbiddenCount:${JSON.stringify([queryMarker, fragmentMarker, memoryMarker, ...privateFieldNames])}
        .filter(value=>html.includes(value)).length
    };
  })()`;
}

// O relatório da página atual é VIVO: a sessão continua ligada ao documento observado, então o retorno e o
// destaque ao vivo existem. O que não existe é a limitação de cópia recarregada — no lugar dela vai a
// declaração de observação passiva.
async function openLiveReport(extension, panel, auditId, minimumImages, identityBefore,
  { maxCaptureResizes = 512 } = {}) {
  const step = async (name, operation) => {
    try { return await operation(); }
    catch (cause) { throw new Error(`REPORT_${name}_${cause?.code ?? 'FAILED'}`, { cause }); }
  };
  await assertSourceUntouched(extension, identityBefore,
    { allowCaptureResize: minimumImages > 0, maxCaptureResizes });
  await step('OPEN', () => extension.click(panel, 'button[data-intent="OPEN_REPORT"]'));
  const report = await step('CONNECT', async () => {
    try { return await extension.waitForReport({ auditId }); }
    catch (cause) {
      const panelState = await extension.evaluate(panel, `(() => ({
        screen:document.querySelector('[data-screen]')?.dataset.screen??null,
        status:document.querySelector('[data-report-launch-status]')?.textContent??null,
        busy:document.querySelector('button[data-intent="OPEN_REPORT"]')?.getAttribute('aria-busy')??null
      }))()`).catch(() => null);
      const graph = await extension.evaluate(extension.harnessPage, `(async()=>{
        const values=Object.values(await chrome.storage.session.get(null)).filter(value=>value?.auditId===${JSON.stringify(auditId)});
        const states=['running','privacy-paused','result','view-only','allocated','awaiting-connection','connected','revoked','removed','observing','retained-for-review'];
        return {records:values.map(value=>({state:states.includes(value.state)?value.state:'other',
          report:value.path==='/src/review/index.html',
          binding:['attached','disposable','batch','view-only'].includes(value.targetBinding?.kind)?value.targetBinding.kind:null})),
          reportTabs:(await chrome.tabs.query({})).filter(tab=>tab.url?.startsWith(chrome.runtime.getURL('src/review/index.html'))).length};
      })()`, { awaitPromise: true }).catch(() => null);
      throw new Error(`REPORT_LAUNCH_SNAPSHOT:${JSON.stringify({ panelState, graph })}`, { cause });
    }
  });
  // Poll only readiness; serializing all embedded captures on every poll can itself
  // stall a large report. Inspect its complete surface once it has rendered.
  const ready = await step('READY', () => extension.waitForValue(report, `(() => ({
    ready:Boolean(document.querySelector('button[data-report-export]')),
    issues:document.querySelectorAll('[data-report-issue]').length,
    status:document.querySelector('#review-status')?.textContent??''
  }))()`, value => value?.ready === true && value?.issues > 0 ||
    /não foi possível|não autorizad|não encontrad/iu.test(value?.status??''), {
    timeoutMs: 30_000, intervalMs: 100,
  }));
  assert.equal(ready.ready, true, `report readiness: ${JSON.stringify(ready)}`);
  const state = await step('SURFACE', () => extension.evaluate(report, reportSurfaceExpression()));
  assert.equal(state.ready, true);
  assert.ok(state.issues > 0);
  assert.equal(state.wcag, true);
  assert.equal(state.abnt, true);
  assert.equal(state.announcement, true);
  assert.equal(state.selector, true);
  assert.equal(state.limitation, false,
    'a página atual não pode ser declarada como cópia recarregada');
  assert.equal(state.passiveLimitation, true,
    'o relatório deve declarar a observação passiva do estado presente');
  assert.equal(state.explanationVisible, false);
  assert.equal(state.returnHidden, false);
  assert.equal(state.returnDisabled, false);
  assert.ok(state.highlightControls > 0, 'a sessão viva da página atual oferece destaque no relatório');
  assert.ok(state.evidenceOnly > 0);
  assert.equal(state.images >= minimumImages, true);
  assert.equal(state.forbiddenCount, 0);
  return report;
}

function durableDeletionExpression(auditId, sourceTabId) {
  return `(async()=>{
    const auditId=${JSON.stringify(auditId)};
    const stored=await chrome.storage.session.get(null);const entries=Object.entries(stored);
    const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
    const [audit,revision,latest,retention,journal,receipt]=await Promise.all([
      store.getAudit(auditId),store.getReportRevision(auditId),store.getLatest(),store.getAuditRetention(auditId),
      store.getExportDeliveryJournal(auditId),store.getExportReceipt(auditId)
    ]);
    const owners=[];
    for(const [key,value] of entries){
      if(!key.startsWith('audita:owned-tab:v2:')||value?.auditId!==auditId)continue;
      let tabExists=true;try{await chrome.tabs.get(value.tabId)}catch{tabExists=false}
      owners.push({tabId:value.tabId,state:value.state,cleanupMode:value.cleanupMode,tabExists});
    }
    const readKeys=storeName=>new Promise(resolve=>{
      const opening=indexedDB.open('audita-mt');opening.onerror=()=>resolve(null);
      opening.onsuccess=()=>{const database=opening.result;let transaction;
        try{transaction=database.transaction(storeName,'readonly')}catch{database.close();resolve(null);return}
        const request=transaction.objectStore(storeName).getAllKeys();
        request.onerror=()=>{database.close();resolve(null)};
        request.onsuccess=()=>{const keys=request.result;database.close();resolve(keys)};
      };
    });
    const [auditKeys,retentionKeys]=await Promise.all([readKeys('audits'),readKeys('audit-retention')]);
    const related=(key,value)=>key.includes(auditId)||JSON.stringify(value).includes(auditId);
    return {
      auditPresent:Boolean(audit),reportPresent:Boolean(revision),latestSame:latest?.auditId===auditId,
      ownedTabPresent:(await chrome.tabs.query({})).some(tab=>tab.id===${JSON.stringify(sourceTabId)}),
      retentionPresent:Boolean(retention),exportJournalCount:Array.isArray(journal)?journal.length:null,
      exportReceiptPresent:Boolean(receipt),activeSame:stored['audita:active-audit-job:v1']?.auditId===auditId,
      owners,
      checkpointSessionCount:entries.filter(([key])=>key==='audita:execution-checkpoint:v1:'+auditId).length,
      retentionSessionCount:entries.filter(([key])=>key==='audita:retention-preference:v1:'+auditId).length,
      reportLaunchCount:entries.filter(([key,value])=>(key.startsWith('audita:report-launch:v1:')||
        key.startsWith('audita:report-launch-tab:v1:'))&&related(key,value)).length,
      highlightCount:JSON.stringify(stored['audita:highlight-bindings:v1']??null).includes(auditId)?1:0,
      rawNavigationCount:entries.filter(([key,value])=>(key.startsWith('audita:raw-navigation:v1:')||
        key.startsWith('audita:raw-navigation-queue:v1:')||key==='audita:raw-navigation-cleanup:v1')&&related(key,value)).length,
      pixelSessionCount:entries.filter(([key,value])=>(key.startsWith('audita:pixel-capture:v1:')||
        key.startsWith('audita:pixel-attempt:v1:'))&&related(key,value)).length,
      auditKeyCount:Array.isArray(auditKeys)?auditKeys.filter(key=>String(key).includes(auditId)).length:null,
      retentionKeyCount:Array.isArray(retentionKeys)?retentionKeys.filter(key=>String(key).includes(auditId)).length:null,
      pixelCompanionPresent:Array.isArray(auditKeys)&&auditKeys.includes('__audit_checkpoint__:/pixel-attempt/:'+auditId)
    };
  })()`;
}

function isDurablyDeleted(value, sourceTabId) {
  // No percurso passivo a aba observada é a aba do usuário: a exclusão apaga o registro local e NÃO fecha a
  // aba. `ownedTabPresent` aqui significa "a aba original continua aberta", e não há posse residual alguma.
  return Boolean(value && value.auditPresent === false && value.reportPresent === false &&
    value.latestSame === false && value.retentionPresent === false && value.exportJournalCount === 0 &&
    value.exportReceiptPresent === false && value.activeSame === false && Array.isArray(value.owners) &&
    value.owners.length === 0 && value.ownedTabPresent === true &&
    value.checkpointSessionCount === 0 && value.highlightCount === 0 &&
    value.rawNavigationCount === 0 && value.pixelSessionCount === 0 &&
    value.auditKeyCount === 0 && value.retentionKeyCount === 0 && value.pixelCompanionPresent === false);
}

async function deleteAuditAndKeepSource(extension, panel, report, auditId, sourceTabId) {
  await extension.click(report, '#delete-audit');
  await extension.waitForValue(report, `document.querySelector('#delete-audit-dialog')?.open`, Boolean, {
    timeoutMs: 10_000, intervalMs: 25,
  });
  await extension.click(report, '#delete-audit-confirm');
  let deletion;
  try {
    deletion = await extension.waitForValue(extension.harnessPage, durableDeletionExpression(auditId, sourceTabId),
      value => isDurablyDeleted(value, sourceTabId), { timeoutMs: 20_000, intervalMs: 50 });
  } catch (error) {
    deletion = await extension.evaluate(extension.harnessPage, durableDeletionExpression(auditId, sourceTabId), { awaitPromise: true });
    throw new Error(`DELETE_WAIT_TIMEOUT ${JSON.stringify(deletion)}`, { cause: error });
  }
  assert.equal(isDurablyDeleted(deletion, sourceTabId), true, JSON.stringify(deletion));
  let nextPanel;
  try {
    // Deletion revokes the audit session; the action authorizes a new panel session.
    nextPanel = await extension.openSidePanelFromAction();
  } catch (openError) {
    try {
      nextPanel = await extension.waitForSidePanel();
    } catch (waitError) {
      const [contexts, targets] = await Promise.all([
        extension.runtimeContexts({ contextTypes: ['SIDE_PANEL'] }),
        extension.browser.command('Target.getTargets'),
      ]);
      const extensionTargets = (targets?.targetInfos ?? []).filter(value =>
        typeof value?.url === 'string' && value.url.startsWith(`chrome-extension://${extension.extensionId}/`))
        .map(value => ({ type: value.type, url: value.url }));
      throw new Error(`PANEL_REOPEN_FAILED ${JSON.stringify({ contexts, extensionTargets })}`, {
        cause: new AggregateError([openError, waitError]),
      });
    }
  }
  try {
    await extension.waitForValue(nextPanel,
      `document.querySelector('[data-screen]')?.dataset.screen`, value => value === 'initial', {
        timeoutMs: 20_000, intervalMs: 50,
      });
  } catch (error) {
    const observed = await extension.evaluate(nextPanel, `(() => ({
      screen:document.querySelector('[data-screen]')?.dataset.screen??null,
      text:(document.body?.innerText??'').slice(0,600),
      launchLength:new URL(location.href).searchParams.get('launch')?.length??0
    }))()`);
    const [contexts, targets, launchState] = await Promise.all([
      extension.runtimeContexts({ contextTypes: ['SIDE_PANEL'] }),
      extension.browser.command('Target.getTargets'),
      extension.evaluate(extension.harnessPage, `(async()=>{
        const stored=await chrome.storage.session.get(null);
        return Object.entries(stored).flatMap(([key,value])=>{
          if(key.startsWith('audita:panel-launch:record:v1:'))return [{
            kind:'record',state:value?.state??null,tabId:value?.tabId??null,
            windowId:value?.windowId??null,generation:value?.generation??null
          }];
          if(key.startsWith('audita:panel-launch:index:v1:'))return [{
            kind:'index',state:value?.state??null,tabId:value?.tabId??null,generation:value?.generation??null
          }];
          return [];
        });
      })()`, { awaitPromise: true }),
    ]);
    const topology = {
      contextCount: contexts.length,
      contexts: contexts.map(value => ({ documentId: value.documentId, contextId: value.contextId })),
      panelTargetCount: (targets?.targetInfos ?? []).filter(value => value?.type === 'page' &&
        typeof value.url === 'string' && value.url.includes('/src/panel/index.html?launch=')).length,
      launchState,
    };
    throw new Error(`PANEL_DELETE_WAIT_TIMEOUT ${JSON.stringify({ observed, topology })}`, { cause: error });
  }
  return nextPanel;
}

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') { row.push(cell); cell = ''; }
    else if (character === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (character !== '\r') cell += character;
  }
  if (quoted) throw new Error('E2E_CSV_UNCLOSED_FIELD');
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

function decodePdfText(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let value = '';
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      value += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
    }
    return value;
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    let value = '';
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      value += String.fromCharCode(bytes[index] | (bytes[index + 1] << 8));
    }
    return value;
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodePdfString(token) {
  if (token.startsWith('<')) {
    const hex = token.slice(1, -1).replace(/\s/gu, '');
    if (hex.length === 0 || hex.length % 2 !== 0 || !/^[a-f0-9]+$/iu.test(hex)) return null;
    return decodePdfText(Buffer.from(hex, 'hex'));
  }
  const bytes = [];
  const body = token.slice(1, -1);
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== '\\') { bytes.push(character.charCodeAt(0) & 0xff); continue; }
    const next = body[++index];
    if (next === undefined) return null;
    if (next === '\n' || next === '\r') {
      if (next === '\r' && body[index + 1] === '\n') index += 1;
      continue;
    }
    const escapes = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
    if (Object.hasOwn(escapes, next)) { bytes.push(escapes[next]); continue; }
    if (/[0-7]/u.test(next)) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/u.test(body[index + 1] ?? '')) octal += body[++index];
      bytes.push(Number.parseInt(octal, 8) & 0xff);continue;
    }
    bytes.push(next.charCodeAt(0) & 0xff);
  }
  return decodePdfText(bytes);
}

function pdfInfoTitles(bytes) {
  const source = bytes.toString('latin1');
  const pattern = /\/Title\s*(<\s*[a-f0-9\s]+>|\((?:\\[\s\S]|[^\\)])*\))/giu;
  return [...source.matchAll(pattern)].map(match => decodePdfString(match[1])).filter(Boolean);
}

async function exportFourFormats(extension, report, auditId, downloadDirectory, reviewedIdentity = null) {
  await extension.click(report, 'button[data-report-export]');
  const exportResponse = await extension.waitForValue(report,
    `document.querySelector('#review-status')?.textContent??''`,
    value => /Relatório atualizado na fila|Não foi possível gerar/u.test(value),
    { timeoutMs: 15_000, intervalMs: 100 });
  assert.equal(exportResponse, 'Relatório atualizado na fila de geração.', 'export request must be accepted');
  if (reviewedIdentity) {
    // A previous successful export must not satisfy the proof for this review.
    await extension.waitForValue(extension.harnessPage, `(async()=>{
      const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
      const receipt=await store.getExportReceipt(${JSON.stringify(auditId)});
      return receipt?.status==='complete'&&receipt.modelHash===${JSON.stringify(reviewedIdentity.modelHash)}&&
        receipt.modelRevision===${reviewedIdentity.modelRevision};
    })()`, Boolean, { timeoutMs: 90_000, intervalMs: 100, awaitPromise: true });
  }
  let downloads;
  try { downloads = await extension.waitForFourDownloads({ auditId, timeoutMs: 90_000, intervalMs: 50 }); }
  catch (cause) {
    // Diagnose a partial delivery without logging model contents, URL, IDs,
    // filenames or private launch/lease correlation.
    const progress = await extension.evaluate(extension.harnessPage, `(async () => {
      const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
      const receipt=await store.getExportReceipt(${JSON.stringify(auditId)});
      const latest=await store.getLatest();
      const statuses=['running','preparing','delivering','complete','partial','failed'];
      const formats=['html','pdf','csv','json'];
      const rows=Object.values(await chrome.storage.session.get(null)).filter(row=>row?.auditId===${JSON.stringify(auditId)});
      const launchStates=['allocated','awaiting-connection','connected','terminal','revoked'];
      return {
        receipt:statuses.includes(receipt?.status)?receipt.status:null,
        completed:formats.filter(format=>receipt?.formats?.some(item=>item.format===format&&item.state==='complete')),
        exportState:latest?.auditId===${JSON.stringify(auditId)}&&statuses.includes(latest?.exportStatus)?latest.exportStatus:null,
        exportLaunchStates:rows.filter(row=>row?.path==='/src/export/index.html').map(row=>launchStates.includes(row.state)?row.state:'other')
      };
    })()`, { awaitPromise: true }).catch(() => null);
    throw new Error(`EXPORT_DELIVERY_SNAPSHOT:${JSON.stringify(progress)}`, { cause });
  }
  assert.deepEqual(downloads.map(row => row.format), ['html', 'pdf', 'csv', 'json']);
  assert.equal(downloads.every(row => row.state === 'complete' && row.byteLength > 0 &&
    /^[a-f0-9]{64}$/u.test(row.sha256)), true);
  const forbidden = [queryMarker, fragmentMarker, memoryMarker, ...privateFieldNames];
  const artifacts = new Map(await Promise.all(downloads.map(async row => {
    const bytes = await readFile(join(downloadDirectory, row.filename));
    assert.equal(row.mime, exportMime[row.format]);
    assert.equal(bytes.length, row.byteLength);
    assert.equal([queryMarker, fragmentMarker, memoryMarker].some(value => row.filename.includes(value)), false);
    if (row.format !== 'pdf') {
      assert.equal(forbidden.filter(value => bytes.includes(Buffer.from(value))).length, 0);
    }
    return [row.format, { row, bytes }];
  })));

  const html = artifacts.get('html').bytes.toString('utf8');
  assert.match(html, /^<!doctype html>/iu);
  assert.match(html, /<html\b[^>]*\blang="pt-BR"/iu);
  assert.equal(html.includes(`<title>${canonicalReportTitle}</title>`), true);
  assert.equal(html.includes(knownOccurrence.abnt), true);
  // N-4 da revisão da 1.1.49: o HTML entregue precisa citar também a referência WCAG da ocorrência
  // conhecida (antes da migração ele exigia uma citação WCAG; a nova versão tinha perdido essa prova).
  assert.equal(html.includes(knownOccurrence.wcag), true);
  assert.equal(html.includes(attachedCopyLimitation), false,
    'o relatório da página atual não pode declarar cópia recarregada');
  assert.equal(html.includes(passiveObservationLimitation), true,
    'o relatório da página atual deve declarar a observação passiva');
  assert.match(html, /<\/body>\s*<\/html>\s*$/iu);

  const technical = JSON.parse(artifacts.get('json').bytes.toString('utf8'));
  assert.equal(technical.schemaVersion, 2);
  assert.equal(technical.audit?.auditId, auditId);
  assert.equal(technical.exportDeliveryIdentityType, 'ExportDeliveryIdentityV1');
  assert.equal(technical.exportDeliveryIdentity?.auditId, auditId);
  if (reviewedIdentity) {
    assert.equal(technical.exportDeliveryIdentity.modelHash, reviewedIdentity.modelHash);
    assert.equal(technical.exportDeliveryIdentity.modelRevision, reviewedIdentity.modelRevision);
    assert.equal(technical.audit.reviewDecisions.length, 1);
    assert.equal(technical.audit.reviewDecisions[0].note, 'Barreira confirmada no teste local');
    assert.match(html, /<details\b[^>]*\bdata-review-history(?:\s|=|>)/u);
    assert.ok(html.includes('Avaliadora QA') && html.includes('Barreira confirmada no teste local'));
  }
  const occurrence = technical.audit?.occurrences?.find(candidate =>
    candidate?.source?.ruleId === knownOccurrence.ruleId &&
    candidate?.nbrItemRef === knownOccurrence.abnt);
  assert.ok(occurrence, `a ocorrência observada no documento vivo deve ser exportada: ${JSON.stringify(
    (technical.audit?.occurrences ?? []).filter(candidate => candidate?.nbrItemRef === knownOccurrence.abnt)
      .map(candidate => ({ ruleId: candidate?.source?.ruleId, selector: candidate?.target?.selector })))}`);
  assert.equal(occurrence.itemWcagRefs.includes(knownOccurrence.wcag), true);
  const stableEvidence = technical.audit?.evidence?.find(candidate =>
    occurrence.evidenceRefs?.includes(candidate?.evidenceId) &&
    candidate?.nodeId === occurrence.nodeId &&
    knownOccurrence.selectors.includes(candidate?.selector?.css));
  assert.ok(stableEvidence, `a evidência do elemento vivo deve acompanhar a exportação: ${JSON.stringify(
    (technical.audit?.evidence ?? []).map(candidate => ({ nodeId: candidate?.nodeId, selector: candidate?.selector })))}`);
  assert.equal(technical.assertions.some(assertion => assertion?.test?.id === `urn:abnt:nbr17225:${knownOccurrence.abnt}` &&
    assertion.test.itemWcagRefs?.includes(knownOccurrence.wcag)), true);

  const csvText = artifacts.get('csv').bytes.toString('utf8');
  assert.equal(csvText.startsWith('\uFEFF'), true);
  const rows = parseCsv(csvText.slice(1));
  assert.equal(rows.length > 1, true);
  const headers = rows[0];
  const requiredHeaders = ['csv_schema_version', 'audit_id', 'source_rule_id', 'nbr_item_ref',
    'item_wcag_refs', 'source_wcag_refs', 'tested_wcag_refs', 'wcag_refs',
    'section_508_refs', 'consumer_basis_ref',
    'export_delivery_identity_type', 'export_delivery_audit_id', 'export_delivery_model_hash'];
  assert.equal(requiredHeaders.every(header => headers.includes(header)), true);
  const record = rows.slice(1).map(values => Object.fromEntries(headers.map((header, index) => [header, values[index]])))
    .find(value => value.nbr_item_ref === knownOccurrence.abnt &&
      value.item_wcag_refs.split(';').includes(knownOccurrence.wcag) &&
      value.source_rule_id === knownOccurrence.ruleId);
  assert.ok(record, JSON.stringify(rows.slice(1)
    .map(values => Object.fromEntries(headers.map((header, index) => [header, values[index]])))
    .filter(value => value.nbr_item_ref === knownOccurrence.abnt)
    .map(value => ({ source_rule_id: value.source_rule_id, item_wcag_refs: value.item_wcag_refs,
      source_wcag_refs: value.source_wcag_refs, tested_wcag_refs: value.tested_wcag_refs, wcag_refs: value.wcag_refs,
      outcome: value.outcome, classification: value.classification }))));
  assert.equal(record.csv_schema_version, 'audita-occurrences-v2');
  assert.equal(record.outcome, knownOccurrence.outcome);
  assert.equal(record.source_wcag_refs.split(';').includes(knownOccurrence.wcag), true);
  // N-3 da revisão da 1.1.49: estas quatro asserções existiam antes da migração, continuam verdadeiras no
  // produto (o revisor mediu) e foram repostas — a troca de oráculo não as exigia.
  assert.equal(record.tested_wcag_refs, '');
  assert.equal(record.wcag_refs, '');
  assert.equal(record.section_508_refs, '');
  assert.equal(record.consumer_basis_ref, '');
  assert.equal(record.audit_id, auditId);
  assert.equal(record.export_delivery_identity_type, 'ExportDeliveryIdentityV1');
  assert.equal(record.export_delivery_audit_id, auditId);
  assert.match(record.export_delivery_model_hash, /^[a-f0-9]{64}$/u);

  const pdf = artifacts.get('pdf').bytes;
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.match(pdf.subarray(Math.max(0, pdf.length - 1024)).toString('latin1'), /%%EOF\s*$/u);
  assert.equal(pdf.length >= 1024, true);
  // Chrome comprime os fluxos de página; o título Info não comprimido liga os bytes finais ao HTML canônico.
  assert.equal(pdfInfoTitles(pdf).includes(canonicalReportTitle), true,
    'o PDF final deve preservar o título do mesmo relatório HTML canônico');

  const receipt = await extension.evaluate(extension.harnessPage, `(async()=>{
    const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
    return store.getExportReceipt(${JSON.stringify(auditId)});
  })()`, { awaitPromise: true });
  assert.equal(receipt?.status, 'complete');
  assert.equal(receipt?.auditId, auditId);
  assert.equal(receipt?.modelHash, technical.exportDeliveryIdentity.modelHash);
  assert.equal(receipt?.modelRevision, technical.exportDeliveryIdentity.modelRevision);
  assert.equal(receipt?.attemptId, technical.exportDeliveryIdentity.attemptId);
  assert.equal(receipt?.formats?.length, 4);
  assert.equal(new Set(receipt.formats.map(entry => entry.downloadId)).size, 4);
  for (const row of downloads) {
    const entry = receipt.formats.find(candidate => candidate.format === row.format);
    assert.deepEqual(entry, {
      format: row.format, mimeType: exportMime[row.format], byteSize: row.byteLength,
      sha256: row.sha256, downloadId: row.downloadId, state: 'complete',
    });
  }
}

test('new audit after address-bar navigation preserves A and audits B in the same panel', { timeout: 180_000 }, async t => {
  assert.ok(chromeBinary, 'Chrome for Testing is required');
  const fixture = await startFixtureServer(t, new Map(['/current', '/other'].map(path => [path, {
    status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
    body: currentPageDocument(0),
  }])));
  let extension;
  try {
    extension = await launchUnpackedExtension(t, {
      extensionPath: await realpath(workspaceRoot), startUrl: `${fixture.origin}/current`,
      viewport: { width: 1280, height: 900 }, chromeBinary, expectedMajor: 152,
    });
    await armSourceInvariantProof(extension);
    let panel = await extension.openSidePanelFromAction();
    const first = await beginAttachedAttempt(extension, panel, 'no-pixels');
    const firstId = await first.auditIdPromise;
    await waitForResult(extension, panel, firstId);
    const original = await markerRecordFingerprint(extension, firstId);
    await navigateRealPage(extension, extension.startPage, { url: `${fixture.origin}/other`, operationId: 'reaudit-document-b' });
    await armSourceInvariantProof(extension);
    panel = await extension.waitForSidePanel();
    const screen = await extension.waitForValue(panel, `document.querySelector('[data-screen]')?.dataset.screen`,
      value => ['result', 'initial'].includes(value), { timeoutMs: 15_000 });
    if (screen === 'result') await extension.click(panel, '[data-intent="NEW_AUDIT"]');
    const second = await beginAttachedAttempt(extension, panel, 'no-pixels');
    const secondId = await second.auditIdPromise.catch(async error => {
      t.diagnostic(JSON.stringify(await extension.evaluate(panel, `({screen:document.querySelector('[data-screen]')?.dataset.screen,status:document.querySelector('[role="status"]')?.textContent})`)));
      t.diagnostic(JSON.stringify(await extension.evaluate(extension.harnessPage, `(async()=>{
        const entries=Object.entries(await chrome.storage.session.get(null));
        return entries.filter(([key])=>/active-audit-job|start-journal|panel-bootstrap/.test(key)).map(([key,value])=>({kind:key.split(':').slice(0,3).join(':'),state:value?.state}));
      })()`, {awaitPromise:true})));
      throw error;
    });
    assert.notEqual(secondId, firstId);
    assert.equal(await waitForResult(extension, panel, secondId), secondId);
    const urls = await extension.evaluate(extension.harnessPage, `(async()=>{
      const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
      const value=await store.getReportRevision(${JSON.stringify(secondId)});
      return [value?.model?.requestedUrl,value?.model?.finalUrl];
    })()`, { awaitPromise: true });
    assert.deepEqual(urls, [`${fixture.origin}/other`, `${fixture.origin}/other`]);
    assert.deepEqual(await markerRecordFingerprint(extension, firstId), original);
  } finally { await extension?.close().catch(() => {}); }
});

test('passive current-page observes memory-only elements without navigation or interaction', { timeout: 180_000 }, async t => {
  assert.ok(chromeBinary, 'Chrome for Testing configurado é obrigatório.');
  const fixture = await startFixtureServer(t, new Map([
    ['/current', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: currentPageDocument(0) }],
  ]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(workspaceRoot), startUrl: `${fixture.origin}/current`,
    downloadMode: 'profile', viewport: { width: 1280, height: 900 }, chromeBinary, expectedMajor: 152,
  });
  const panel = await extension.openSidePanelFromAction();
  await extension.waitForValue(panel, 'document.querySelector("[data-screen]")?.dataset.screen',
    value => value === 'initial', { timeoutMs: 30_000 });
  await extension.click(panel, 'input[data-capture-mode="no-pixels"]');
  await panel.command('Page.bringToFront');
  await extension.waitForValue(panel, 'document.visibilityState', value => value === 'visible', { timeoutMs: 10_000 });
  assert.equal(await extension.evaluate(extension.startPage.page, `new Promise(resolve=>{
    let previous='';let stable=0;let samples=0;
    const sample=()=>{const current=innerWidth+':'+innerHeight;
      stable=current===previous?stable+1:0;previous=current;
      if(stable>=6)return resolve(true);if(++samples>=60)return resolve(false);setTimeout(sample,50)};sample();
  })`, { awaitPromise: true }), true, 'native side panel must settle before measuring source invariants');
  await extension.evaluate(extension.startPage.page, `(() => {
    const region=document.createElement('section');region.id='memory-only-menu';
    region.innerHTML='<h2>Menu aberto somente em memória</h2><button id="memory-only-unnamed" style="width:80px;height:40px"></button>';
    document.querySelector('main').append(region);
    const notes=document.querySelector('#source-notes');notes.focus();notes.setSelectionRange(2,5);scrollTo(0,200);
    const state=()=>({html:document.body.innerHTML,focus:document.activeElement?.id,hasFocus:document.hasFocus(),scroll:[scrollX,scrollY],
      viewport:[innerWidth,innerHeight,visualViewport.width,visualViewport.height,visualViewport.scale],
      selection:[notes.selectionStart,notes.selectionEnd],
      style:[getComputedStyle(document.querySelector('#runtime-style-target')).color,getComputedStyle(notes).fontSize]});
    globalThis.__passiveProof={state,events:[],mutations:0};
    const observer=new MutationObserver(records=>{globalThis.__passiveProof.mutations+=records.length});
    observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
    globalThis.__passiveProof.observer=observer;
    for(const type of ['keydown','keyup','beforeinput','input','change','click','pointerdown','pointerup','selectionchange','scroll','resize','focus','blur','focusin','focusout','visibilitychange','popstate','hashchange','pagehide'])addEventListener(type,()=>globalThis.__passiveProof.events.push(type),true);
    return true;
  })()`);
  // Drain the scroll event caused by test setup before recording the baseline.
  await extension.evaluate(extension.startPage.page, 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{globalThis.__passiveProof.observer.takeRecords();globalThis.__passiveProof.mutations=0;globalThis.__passiveProof.events=[];resolve(true)})))', { awaitPromise: true });
  const before = await extension.evaluate(extension.startPage.page, 'globalThis.__passiveProof.state()');
  const identityBefore = await extension.identityOf(extension.startPage);
  await armTabIsolationProof(extension);
  await armProgressObserver(extension, panel);
  // The extension, not this test's CDP session, must own observation during the audit.
  await extension.browser.command('Target.detachFromTarget', { sessionId: extension.startPage.page.sessionId });
  const auditIdPromise = waitForActiveAuditId(extension);
  await extension.click(panel, 'button[data-intent="START_ATTACHED"]');
  const auditId = await auditIdPromise;
  assert.equal(await waitForResult(extension, panel, auditId), auditId);
  await assertObservedProgress(extension, panel);
  const source = await extension.attachPage(extension.startPage.targetId);
  assert.deepEqual(await extension.identityOf({ targetId: extension.startPage.targetId, page: source }), identityBefore);
  const after = await extension.evaluate(source, '({state:globalThis.__passiveProof.state(),events:globalThis.__passiveProof.events,mutations:globalThis.__passiveProof.mutations})');
  assert.deepEqual(after.state, before);
  assert.deepEqual(after.events, []);
  assert.equal(after.mutations, 0);
  const observed = await extension.evaluate(extension.harnessPage, `(async()=>{
    const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
    const revision=await store.getReportRevision(${JSON.stringify(auditId)});
    const model=revision?.model;
    return {present:Boolean(model),modelHash:model?.integrity?.canonicalModelHash,
      codes:model?.session?.diagnostics?.map(value=>value.code)??[],evidence:model?.evidence?.length??-1,
      targets:model?.occurrences?.filter(value=>['axe.button-name','accessible-component-name'].includes(value.ruleId)).map(value=>({occurrenceId:value.occurrenceId,ruleId:value.ruleId,outcome:value.outcome,target:value.target})),
      created:globalThis.__auditaCurrentCopyProofV1.state.created.length,
      updates:globalThis.__auditaCurrentCopyProofV1.state.sourceUpdates};
  })()`, { awaitPromise: true });
  assert.equal(observed.present, true);
  assert.ok(observed.evidence > 0, 'non-raster evidence remains available in no-pixels mode');
  const memoryTargets = await extension.evaluate(source, `(${JSON.stringify(observed.targets)}).filter(value=>{
    const selector=value.target?.selector;return selector&&document.querySelector(selector)?.id==='memory-only-unnamed';
  })`);
  assert.equal(memoryTargets.length, 1, 'the recorded selector must resolve to the memory-only element');
  assert.equal(memoryTargets[0].ruleId, 'axe.button-name');
  assert.equal(memoryTargets[0].outcome, 'cantTell', 'the supplemental ABNT mapping requires confirmation');
  assert.ok(observed.targets.some(value=>value.ruleId==='accessible-component-name' && value.outcome==='failed' &&
    value.target.nodeId===memoryTargets[0].target.nodeId), 'core must detect the missing accessible name on the same live node');
  const privateState = await readPrivateAttempt(extension, auditId);
  assert.deepEqual(privateState.owners, []);
  assert.equal(privateState.rawNavigationCount, 0);
  assert.equal(privateState.rasterDataUrls, 0);
  assert.equal(privateState.sessionRasterDataUrls, 0);
  assert.equal(privateState.pixelStateCount, 0);
  assert.ok(observed.codes.includes('DYNAMIC_PROBES_OMITTED_PASSIVE'));
  assert.equal(observed.codes.includes('ATTACHED_COPY_RELOADED'), false);
  assert.equal(observed.created, 0);
  assert.deepEqual(observed.updates, []);
  await extension.click(panel, 'button[data-intent="OPEN_REPORT"]');
  const report = await extension.waitForReport({ auditId });
  await extension.waitForValue(report, 'document.querySelectorAll("[data-report-issue]").length',
    value => value > 0, { timeoutMs: 30_000 });
  const reportText = await extension.evaluate(report, 'document.body.textContent');
  assert.match(reportText, /ABNT/);
  assert.match(reportText, /WCAG/);
  assert.match(reportText, /sem alterar foco/);
  const occurrenceId = memoryTargets[0].occurrenceId;
  const controlSelector = `[data-report-highlight-control="${occurrenceId}"] button`;
  await extension.browser.command('Target.detachFromTarget', { sessionId: source.sessionId });
  assert.equal(await extension.evaluate(report, `(() => {
    const control=document.querySelector(${JSON.stringify(controlSelector)});
    if(!control)return false;
    for(let parent=control.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
    return true;
  })()`), true, 'the live occurrence must offer a highlight control');
  await extension.click(report, controlSelector);
  const available = await extension.waitForValue(report, `document.querySelector(${JSON.stringify(controlSelector)})?.dataset.highlightAction`,
    value => ['highlight','unavailable'].includes(value), { timeoutMs: 15_000 });
  assert.equal(available, 'highlight');
  await extension.click(report, controlSelector);
  await extension.waitForValue(report, `document.querySelector(${JSON.stringify(controlSelector)})?.dataset.highlightAction`,
    value => value === 'clear', { timeoutMs: 15_000 });
  const highlightedSource = await extension.attachPage(extension.startPage.targetId);
  assert.equal(await extension.evaluate(highlightedSource, 'document.querySelectorAll("[data-audita-highlight-root=v1]").length'), 1);
  assert.equal(await extension.evaluate(highlightedSource, `(() => {
    const overlay=document.querySelector('[data-audita-highlight-root=v1]').getBoundingClientRect();
    const target=document.querySelector('#memory-only-unnamed').getBoundingClientRect();
    return ['left','top','width','height'].every(key=>Math.abs(overlay[key]-target[key])<1);
  })()`), true, 'the overlay must surround the audited element, not another node');
  await extension.browser.command('Target.detachFromTarget', { sessionId: highlightedSource.sessionId });
  await extension.click(report, controlSelector);
  await extension.waitForValue(report, `document.querySelector(${JSON.stringify(controlSelector)})?.dataset.highlightAction`,
    value => value === 'highlight', { timeoutMs: 15_000 });
  const clearedSource = await extension.attachPage(extension.startPage.targetId);
  assert.equal(await extension.evaluate(clearedSource, 'document.querySelectorAll("[data-audita-highlight-root=v1]").length'), 0);
  const finalHash = await extension.evaluate(extension.harnessPage, `(async()=>{
    const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
    return (await store.getReportRevision(${JSON.stringify(auditId)}))?.model?.integrity?.canonicalModelHash;
  })()`, { awaitPromise: true });
  assert.equal(typeof observed.modelHash, 'string');
  assert.equal(finalHash, observed.modelHash, 'highlight and clear must not rewrite the audit evidence');
  t.diagnostic('Chrome152; actual-document; memory-only finding retained; no created tabs; focus/scroll/layout preserved; report opened; highlight/clear; model hash preserved');
});

test('passive current-page declares the capture resize on a page that reacts to it', { timeout: 420_000 }, async t => {
  assert.ok(chromeBinary, 'AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório para o E2E real do painel lateral.');
  const fixture = await startFixtureServer(t, new Map([
    ['/current', {
      status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: reactiveCurrentPageDocument(),
    }],
  ]));
  let extension;
  try {
    extension = await launchUnpackedExtension(t, {
      extensionPath: await realpath(workspaceRoot), startUrl: `${fixture.origin}/current`,
      viewport: { width: 1280, height: 900 }, chromeBinary, expectedMajor: 152,
    });
    await armSourceInvariantProof(extension);
    const panel = await extension.openSidePanelFromAction();
    await extension.waitForValue(panel, `(() => ({
      screen:document.querySelector('[data-screen]')?.dataset.screen??null,
      modes:[...document.querySelectorAll('input[data-capture-mode]')].map(input=>({
        mode:input.value,checked:input.checked,disabled:input.disabled
      })),
    }))()`, value => value?.screen === 'initial' && value.modes.length === 3, { timeoutMs: 30_000, intervalMs: 50 });
    // A linha de base é lida com o painel JÁ ABERTO e depois que a geometria PARA de mudar: abrir o painel
    // encolhe o viewport da página ao longo de algumas centenas de milissegundos, e essa mudança é do
    // navegador, não da auditoria (o mesmo cuidado que o caso de memória só em memória toma).
    assert.equal(await extension.evaluate(extension.startPage.page, `new Promise(resolve => {
      let previous='';let stable=0;let samples=0;
      const sample=()=>{const current=innerWidth+':'+innerHeight;
        stable=current===previous?stable+1:0;previous=current;
        if(stable>=6)return resolve(true);if(++samples>=60)return resolve(false);setTimeout(sample,50)};
      sample();
    })`, { awaitPromise: true }), true, 'a geometria do documento precisa estabilizar antes da linha de base');
    const baseline = await extension.evaluate(extension.startPage.page, `(() => ({
      href:location.href,scrollY,viewport:[innerWidth,innerHeight],
      counterValue:Number((document.getElementById('reactive-counter')?.textContent??'').match(/^resizes=(\\d+)/u)?.[1] ?? -1),
    }))()`);
    assert.equal(baseline.counterValue >= 0, true,
      `o contador da página reativa precisa existir antes da auditoria: ${JSON.stringify(baseline)}`);
    // `beginAttachedAttempt` prova a fonte intocada ANTES do arranque (a mutação do handler só pode
    // acontecer depois, na captura) e já arma a observação de abas criadas.
    const { auditIdPromise } = await beginAttachedAttempt(extension, panel, 'element-only');
    await waitForPrivacyPause(extension, panel);
    const auditId = await auditIdPromise;
    await confirmOnce(extension, panel);
    assert.equal(await waitForResult(extension, panel, auditId), auditId);
    const after = await extension.evaluate(extension.startPage.page, `(() => ({
      href:location.href,scrollY,viewport:[innerWidth,innerHeight],
      counter:document.getElementById('reactive-counter')?.textContent??null,
      counterValue:Number((document.getElementById('reactive-counter')?.textContent??'').match(/^resizes=(\\d+)/u)?.[1] ?? -1),
      proofResizes:Number(globalThis.__auditaSourceInvariantV1?.compare?.().eventCounts?.resize ?? -1),
      resizeSamples:globalThis.__auditaSourceInvariantV1?.compare?.().resizeSamples??[],
    }))()`);
    assert.deepEqual(after.viewport, baseline.viewport,
      'a geometria final do documento observado tem de voltar à inicial');
    assert.equal(after.href, baseline.href, 'a auditoria não pode navegar o documento observado');
    assert.equal(after.scrollY, baseline.scrollY, 'a auditoria não pode rolar o documento observado');
    assert.match(after.counter ?? '', /^resizes=\d+ w=\d+ h=\d+$/u,
      'o contador da fixture precisa registrar o redimensionamento observado');
    // A-1 do adendo da 1.1.49: descontar os eventos anteriores evita confundir a animação do painel com
    // a captura. O piso histórico de 32 dependia de uma medição de 246 eventos; no mesmo CFT 152.0.7977.64,
    // tanto a 1.1.49 quanto a 1.1.50 produziram quatro eventos e 138 PNGs decodificáveis. Exigimos agora
    // a assinatura causal observada: colapso a 1x1 seguido do retorno à linha de base. O mutante que força
    // captureBeyondViewport:false produz zero eventos e nenhuma amostra 1x1, e continua reprovado.
    const counterDelta = after.counterValue - baseline.counterValue;
    const attempt = await readPrivateAttempt(extension, auditId);
    const rasterProof = await extension.evaluate(extension.harnessPage, `(async()=>{
      const store=(await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
      const revision=await store.getReportRevision(${JSON.stringify(auditId)});
      const elements=(revision?.model?.evidence??[]).filter(item=>item.kind==='element');
      const rasters=elements.filter(item=>item.dataUrl?.startsWith('data:image/png;base64,'));
      const sizes=await Promise.all(rasters.map(async item=>{
        try{
          const bytes=Uint8Array.from(atob(item.dataUrl.slice('data:image/png;base64,'.length)),c=>c.charCodeAt(0));
          const image=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
          const result={width:image.width,height:image.height};
          image.close();return result;
        }catch{return null}
      }));
      const diagnostics=revision?.model?.session?.diagnostics??[];
      return {totalElements:elements.length,rasters:rasters.length,
        decoded:sizes.filter(item=>item?.width>0&&item?.height>0).length,
        dimensions:[...new Set(sizes.map(item=>item?item.width+'x'+item.height:'invalid'))],
        diagnosticCounts:diagnostics.reduce((counts,item)=>(counts[item.code]=(counts[item.code]??0)+1,counts),{})};
    })()`, { awaitPromise: true });
    t.diagnostic('reactive-capture=' + JSON.stringify({ counterDelta, proofResizes: after.proofResizes,
      resizeSamples: after.resizeSamples, baselineViewport: baseline.viewport, finalViewport: after.viewport,
      elements: attempt.elements, rasterProof }));
    assert.equal(counterDelta >= 2, true,
      `a saída e o retorno da captura precisam aparecer no contador da página: ${JSON.stringify({ baselineCounter: baseline.counterValue, afterCounter: after.counterValue, counterDelta })}`);
    // Segunda medida independente, do próprio oráculo de fonte: o mesmo efeito, contado por outro observador.
    assert.equal(after.proofResizes >= 2, true,
      `o oráculo de fonte precisa contar a oscilação da captura: ${JSON.stringify({ proofResizes: after.proofResizes, counterDelta })}`);
    const geometries = after.resizeSamples.map(sample => /^t=\d+ (\d+)x(\d+)\//u.exec(sample))
      .filter(Boolean).map(match => [Number(match[1]), Number(match[2])]);
    const collapseIndex = geometries.findIndex(([width, height]) => width === 1 && height === 1);
    assert.ok(collapseIndex >= 0,
      `a captura precisa registrar a geometria 1x1, ausente na animação do painel: ${JSON.stringify(after.resizeSamples)}`);
    assert.equal(geometries.slice(collapseIndex + 1).some(([width, height]) =>
      width === baseline.viewport[0] && height === baseline.viewport[1]), true,
    'a amostragem precisa registrar o retorno de 1x1 à geometria inicial');
    assert.equal(attempt.diagnostics.includes('DYNAMIC_PROBES_OMITTED_PASSIVE'), true);
    assert.equal(attempt.elements >= 1, true,
      'a captura de elementos continua existindo numa página reativa — é ela que causa a oscilação');
    assert.equal(rasterProof.rasters, attempt.elements);
    assert.equal(rasterProof.decoded, rasterProof.rasters,
      'todos os PNGs de elementos precisam decodificar com dimensões positivas');
    assert.equal(attempt.forbiddenSessionUrlCount, 0);
    await extension.click(panel, 'button[data-intent="OPEN_REPORT"]');
    const report = await extension.waitForReport({ auditId });
    await extension.waitForValue(report, 'Boolean(document.querySelector("button[data-report-export]"))', Boolean,
      { timeoutMs: 30_000 });
    const declaration = await extension.evaluate(report, 'document.body.textContent');
    // A mensagem corrigida (N-1 da revisão da 1.1.49) declara o efeito em vez de negá-lo.
    assert.match(declaration, /pode redimensionar a área de captura por um instante/u);
    assert.match(declaration, /páginas que reagem a redimensionamento podem registrar essa mudança/u);
    assert.equal(declaration.includes(supersededPassiveObservationClaim), false,
      'a frase antiga, que negava o efeito, não pode voltar');
    t.diagnostic(`Chrome152; página reativa; ${after.counter}; geometria final idêntica; efeito declarado no relatório`);
  } finally { await extension?.close().catch(() => {}); }
});

test('passive current-page audits complete in every mode and keep the observed document intact', { timeout: 600_000 }, async t => {
  assert.ok(chromeBinary, 'AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório para o E2E real do painel lateral.');
  const fixture = await startFixtureServer(t, new Map([
    ['/current', {
      status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: currentPageDocument(),
    }],
  ]));
  const sourceUrl = `${fixture.origin}/current?private_marker=${queryMarker}#${fragmentMarker}`;
  let extension;
  try {
    extension = await launchUnpackedExtension(t, {
      extensionPath: await realpath(workspaceRoot), startUrl: sourceUrl,
      downloadMode: 'profile',
      ...(process.env.AUDITA_E2E_ARTIFACT_ROOT ? {
        qaDirectory: join(process.env.AUDITA_E2E_ARTIFACT_ROOT, 'qa'),
        downloadDirectory: join(process.env.AUDITA_E2E_ARTIFACT_ROOT, 'downloads'),
      } : {}),
      viewport: { width: 1280, height: 900 }, chromeBinary, expectedMajor: 152,
    });
    assert.equal(extension.chromeProduct, CANONICAL_CHROME_PRODUCT);
    await armSourceInvariantProof(extension);
    let panel = await extension.openSidePanelFromAction();
    const initial = await extension.waitForValue(panel, `(() => ({
      screen:document.querySelector('[data-screen]')?.dataset.screen??null,
      heading:document.querySelector('[data-screen] h2')?.textContent??null,
      modes:[...document.querySelectorAll('input[data-capture-mode]')].map(input=>({
        mode:input.value,checked:input.checked,disabled:input.disabled
      })),
      startButtons:document.querySelectorAll('button[data-intent="START_ATTACHED"]').length
    }))()`, value => value?.screen === 'initial', { timeoutMs: 30_000, intervalMs: 50 });
    assert.equal(initial.heading, 'Avaliar acessibilidade');
    assert.deepEqual(initial.modes, [
      { mode: 'full-evidence', checked: true, disabled: false },
      { mode: 'element-only', checked: false, disabled: false },
      { mode: 'no-pixels', checked: false, disabled: false },
    ]);
    assert.equal(initial.startButtons, 1);
    assert.equal((await extension.runtimeContexts({ contextTypes: ['POPUP'] })).length, 0);
    await extension.captureJourney('panel-current-passive-initial', panel);

    await t.test('full-evidence can be cancelled at the privacy pause without touching the source', async () => {
      const { identityBefore, auditIdPromise } = await beginAttachedAttempt(extension, panel, 'full-evidence');
      await waitForPrivacyPause(extension, panel);
      const auditId = await auditIdPromise;
      assert.match(auditId ?? '', /^[A-Za-z0-9._:-]{1,160}$/u);
      await assertPausedObservedAttempt(extension, auditId, identityBefore);
      await extension.click(panel, 'button[data-intent="CANCEL_AUDIT"]');
      await extension.waitForValue(panel,
        `document.querySelector('[data-screen]')?.dataset.screen`, value => value === 'initial', {
          timeoutMs: 30_000, intervalMs: 50,
        });
      await waitForActiveAuditCleanup(extension, auditId);
      const cancelled = await readPrivateAttempt(extension, auditId);
      assert.equal(cancelled.auditPresent, false);
      assert.equal(cancelled.modelPresent, false);
      assert.equal(cancelled.reportPresent, false);
      assert.equal(cancelled.evidenceCount, 0);
      assert.equal(cancelled.exportJournalCount, 0);
      assert.equal(cancelled.activeSame, false);
      assert.equal(cancelled.executionCheckpointPresent, false);
      assert.equal(cancelled.sessionRasterDataUrls, 0);
      assert.equal(cancelled.rawNavigationCount, 0);
      assert.equal(cancelled.pixelStateCount, 0);
      assert.equal(cancelled.pixelCompanionPresent, false);
      assert.equal(cancelled.forbiddenSessionUrlCount, 0);
      assert.deepEqual(cancelled.owners, []);
      await assertNoCopyCreated(extension, identityBefore);
    });

    await t.test('no-pixels shows progress, completes in the observed document and exposes a live report', async () => {
      const { identityBefore, auditIdPromise } = await beginAttachedAttempt(extension, panel, 'no-pixels');
      const auditId = await auditIdPromise;
      assert.equal(await waitForResult(extension, panel, auditId), auditId);
      await assertObservedProgress(extension, panel);
      const attempt = await assertObservedTerminalAttempt(extension, auditId, identityBefore, {
        minimumFullPage: 0, minimumElements: 0, fullPageExact: 0, elementsExact: 0,
        diagnostics: ['PIXEL_CAPTURE_OMITTED'],
      }, fixture.origin);
      assert.equal(attempt.rasterDataUrls, 0);
      await assertPanelSummaryAndDetail(extension, panel, 'no-pixels', 0, identityBefore,
        { maxCaptureResizes: captureResizeCeiling(attempt) });
      const report = await openLiveReport(extension, panel, auditId, 0, identityBefore,
        { maxCaptureResizes: captureResizeCeiling(attempt) });
      await extension.captureJourney('report-current-passive-no-pixels', report, { captureBeyondViewport: false });
      panel = await deleteAuditAndKeepSource(extension, panel, report, auditId, extension.startPage.tabId);
    });

    await t.test('element-only confirms once and keeps the full-page capture omitted', async () => {
      const { identityBefore, auditIdPromise } = await beginAttachedAttempt(extension, panel, 'element-only');
      await waitForPrivacyPause(extension, panel);
      const auditId = await auditIdPromise;
      assert.match(auditId ?? '', /^[A-Za-z0-9._:-]{1,160}$/u);
      await assertPausedObservedAttempt(extension, auditId, identityBefore);
      await confirmOnce(extension, panel);
      assert.equal(await waitForResult(extension, panel, auditId), auditId);
      await assertObservedProgress(extension, panel);
      const attempt = await assertObservedTerminalAttempt(extension, auditId, identityBefore, {
        minimumFullPage: 0, minimumElements: 1, fullPageExact: 0,
        diagnostics: ['FULL_PAGE_CAPTURE_OMITTED'],
      }, fixture.origin);
      await assertPanelSummaryAndDetail(extension, panel, 'element-only', 1, identityBefore,
        { maxCaptureResizes: captureResizeCeiling(attempt) });
      const report = await openLiveReport(extension, panel, auditId, 1, identityBefore,
        { maxCaptureResizes: captureResizeCeiling(attempt) });
      await extension.captureJourney('report-current-passive-elements', report, { captureBeyondViewport: false });
      panel = await deleteAuditAndKeepSource(extension, panel, report, auditId, extension.startPage.tabId);
    });

    await t.test('full-evidence rehydrates after worker restart and exports all four formats', async subtest => {
      const step = async (name, operation) => {
        subtest.diagnostic(`full-evidence-step=${name}:begin`);
        try {
          const result = await operation();
          subtest.diagnostic(`full-evidence-step=${name}:passed`);
          return result;
        } catch (cause) {
          subtest.diagnostic(`full-evidence-step=${name}:failed`);
          throw new Error(`FULL_EVIDENCE_${name}_FAILED`, { cause });
        }
      };
      const { identityBefore, auditIdPromise } = await step('BEGIN_ATTEMPT', () =>
        beginAttachedAttempt(extension, panel, 'full-evidence'));
      await step('PRIVACY_PAUSE', () => waitForPrivacyPause(extension, panel));
      const auditId = await step('RESOLVE_AUDIT', () => auditIdPromise);
      assert.match(auditId ?? '', /^[A-Za-z0-9._:-]{1,160}$/u);
      await step('PAUSED_PROOF', () => assertPausedObservedAttempt(extension, auditId, identityBefore));
      await step('WORKER_STOP', () => stopServiceWorker(extension));
      await step('WORKER_REPLACEMENT', () => proveReplacementServiceWorker(extension));
      await step('REHYDRATED_PAUSE', () => waitForPrivacyPause(extension, panel));
      await step('REHYDRATED_STORAGE', async () => {
        const rehydrated = await readPrivateAttempt(extension, auditId);
        assert.equal(rehydrated.activeState, 'privacy-paused');
        assert.deepEqual(rehydrated.owners, []);
        assert.equal(rehydrated.sessionRasterDataUrls, 0);
      });
      await step('REHYDRATED_SOURCE', () => assertNoCopyCreated(extension, identityBefore));
      await step('CONFIRM', () => confirmOnce(extension, panel));
      assert.equal(await step('RESULT', () => waitForResult(extension, panel, auditId)), auditId);
      await step('PROGRESS', () => assertObservedProgress(extension, panel));
      const terminalAttempt = await step('TERMINAL_PROOF', () => assertObservedTerminalAttempt(
        extension, auditId, identityBefore, { minimumFullPage: 1, minimumElements: 1 }, fixture.origin));
      await step('PANEL_DETAIL', () =>
        assertPanelSummaryAndDetail(extension, panel, 'full-evidence', 1, identityBefore,
          { maxCaptureResizes: captureResizeCeiling(terminalAttempt) }));
      await step('PANEL_VISIBLE', () => extension.waitForValue(panel,
        'document.visibilityState', value => value === 'visible', { timeoutMs: 10_000, intervalMs: 50 }));
      // Chrome 152 may time out rasterizing this native panel after worker restart,
      // despite visible frames and a verified detail. This QA image is separate from
      // required audit evidence, source isolation and export proofs.
      try {
        await step('PANEL_CAPTURE', () => extension.captureJourney('panel-current-passive-summary', panel,
          { captureBeyondViewport: false }));
      } catch (error) {
        if (error?.cause?.code !== 'CDP_COMMAND_TIMEOUT') throw error;
        subtest.diagnostic('qa-limitation=PANEL_SCREENSHOT_CDP_TIMEOUT; panel-screenshot=not-produced; report-and-export-proofs=still-required');
      }
      const report = await step('REPORT_OPEN', () =>
        openLiveReport(extension, panel, auditId, 1, identityBefore,
          { maxCaptureResizes: captureResizeCeiling(terminalAttempt) }));
      try {
        await step('REPORT_CAPTURE', () =>
          extension.captureJourney('report-current-passive-full', report, { captureBeyondViewport: false }));
      } catch (error) {
        if (error?.cause?.code !== 'CDP_COMMAND_TIMEOUT') throw error;
        subtest.diagnostic('qa-limitation=REPORT_SCREENSHOT_CDP_TIMEOUT; report-ui-screenshot=not-produced; actual-evidence-and-four-downloads=still-required');
      }
      await step('EXPORT_FOUR', () => exportFourFormats(extension, report, auditId, extension.downloadDirectory));
      panel = await step('CLEANUP', () =>
        deleteAuditAndKeepSource(extension, panel, report, auditId, extension.startPage.tabId));
    });

    // A aba do usuário continua a mesma depois de quatro auditorias, uma exclusão e um reinício do worker.
    const finalSurface = await extension.evaluate(extension.harnessPage, `(async()=>{
      const tabs=await chrome.tabs.query({});
      const stored=await chrome.storage.session.get(null);
      return {sourceOpen:tabs.some(tab=>tab.id===${JSON.stringify(extension.startPage.tabId)}),
        owned:Object.keys(stored).filter(key=>key.startsWith('audita:owned-tab:v2:')).length};
    })()`, { awaitPromise: true });
    assert.equal(finalSurface.sourceOpen, true, 'a aba original do usuário deve continuar aberta');
    assert.equal(finalSurface.owned, 0, 'nenhuma posse de aba pode sobrar do percurso passivo');
    assert.equal(await extension.evaluate(extension.startPage.page, `(() => {
      globalThis.__auditaSourceInvariantV1?.dispose?.();delete globalThis.__auditaP4dImageRemovedV1;return true;
    })()`), true);
    assert.equal(await extension.evaluate(extension.harnessPage, `(() => {
      globalThis.__auditaCurrentCopyProofV1?.dispose?.();return true;
    })()`), true);
    t.diagnostic('Chrome=152; current-page=passive-live-document; consult each subtest result for mode, restart, report and export proof');
  } catch (error) {
    t.diagnostic(`controlled-failure=${redactDiagnostic(error?.code ?? error?.message ?? 'E2E_DENIED')}`);
    throw error;
  } finally {
    await extension?.close().catch(() => {});
  }
});
