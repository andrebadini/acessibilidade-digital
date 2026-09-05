import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_CHROME_PRODUCT,
  launchUnpackedExtension,
  resolveRealChromeTestBinary,
  startFixtureServer,
} from './support/real-chrome.mjs';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
const chromeBinary = resolveRealChromeTestBinary();
const queryMarkerA = 'AUDITA5A_QUERY_A_5F26C718';
const queryMarkerB = 'AUDITA5A_QUERY_B_8A741DE3';
const fragmentMarkerA = 'AUDITA5A_FRAGMENT_A_693CE140';
const fragmentMarkerB = 'AUDITA5A_FRAGMENT_B_D50E2A63';
const forbiddenPublicNames = Object.freeze([
  'navigationToken', 'sessionDigest', 'ownershipId', 'capabilityId', 'owner_', 'hmac-sha256',
]);

function targetDocument(kind) {
  const controls = Array.from({ length: 180 }, (_unused, index) =>
    `<button type="button" aria-label="Controle ${kind} ${index + 1}"></button>`).join('');
  const barrier = kind === 'A'
    ? '<img id="missing-alt-a" src="/audit-pixel.gif">'
    : '<label>Campo sem associação</label><input id="missing-label-b" type="text">';
  return `<!doctype html>
    <html lang="pt-BR">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Alvo ${kind}</title></head>
      <body><main><h1>Página explícita ${kind}</h1>${barrier}<div>${controls}</div></main></body>
    </html>`;
}

async function armOriginalPageProof(extension) {
  const identity = await extension.identityOf(extension.startPage);
  const armed = await extension.evaluate(extension.startPage.page, `(async () => {
    try { globalThis.__auditaBatchSourceProofV1?.observer?.disconnect?.(); } catch {}
    const snapshot = () => ({
      href: location.href,
      title: document.title,
      html: document.documentElement.outerHTML,
      history: { length: history.length, state: JSON.stringify(history.state), restoration: history.scrollRestoration },
      scroll: { x: scrollX, y: scrollY },
      viewport: {
        innerWidth, innerHeight, devicePixelRatio,
        clientWidth: document.documentElement.clientWidth,
        clientHeight: document.documentElement.clientHeight
      }
    });
    const viewportStable = await new Promise(resolve => {
      let previous = null;
      let equalSamples = 0;
      let elapsed = 0;
      const sample = () => {
        const value = JSON.stringify(snapshot().viewport);
        equalSamples = value === previous ? equalSamples + 1 : 0;
        previous = value;
        elapsed += 50;
        if (equalSamples >= 4) { resolve(true); return; }
        if (elapsed >= 2_000) { resolve(false); return; }
        setTimeout(sample, 50);
      };
      sample();
    });
    if (!viewportStable) return false;
    const baseline = snapshot();
    const mutations = { childList: 0, attributes: 0, characterData: 0 };
    const observer = new MutationObserver(records => {
      for (const record of records) mutations[record.type] += 1;
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    const actions = Object.fromEntries([
      'scroll', 'beforeinput', 'input', 'change', 'click', 'pointerdown', 'pointerup',
      'keydown', 'keyup', 'popstate', 'hashchange'
    ].map(name => [name, 0]));
    for (const name of Object.keys(actions)) addEventListener(name, event => {
      if (event.isTrusted) actions[name] += 1;
    }, true);
    Object.defineProperty(globalThis, '__auditaBatchSourceProofV1', {
      value: {
        observer,
        compare() {
          for (const record of observer.takeRecords()) mutations[record.type] += 1;
          const current = snapshot();
          return {
            sameSnapshot: JSON.stringify(current) === JSON.stringify(baseline),
            href: current.href === baseline.href,
            title: current.title === baseline.title,
            html: current.html === baseline.html,
            history: JSON.stringify(current.history) === JSON.stringify(baseline.history),
            scroll: JSON.stringify(current.scroll) === JSON.stringify(baseline.scroll),
            viewport: JSON.stringify(current.viewport) === JSON.stringify(baseline.viewport),
            mutationTotal: Object.values(mutations).reduce((sum, value) => sum + value, 0),
            actionTotal: Object.values(actions).reduce((sum, value) => sum + value, 0)
          };
        }
      },
      configurable: true,
      enumerable: false,
      writable: false
    });
    return true;
  })()`, { awaitPromise: true });
  assert.equal(armed, true);
  return identity;
}

async function armInvisibleTabsProof(extension) {
  const armed = await extension.evaluate(extension.harnessPage, `(() => {
    try { globalThis.__auditaBatchTabsProofV1?.dispose?.(); } catch {}
    const sourceTabId = ${JSON.stringify(extension.startPage.tabId)};
    const sourceWindowId = ${JSON.stringify(extension.startPage.windowId)};
    const state = { created: [], activated: [], removed: [], sourceUpdates: [] };
    const onCreated = tab => {
      if (tab.windowId === sourceWindowId && tab.id !== sourceTabId) {
        state.created.push({ tabId: tab.id, windowId: tab.windowId, active: tab.active === true });
      }
    };
    const onActivated = info => {
      if (info.windowId === sourceWindowId) state.activated.push(info.tabId);
    };
    const onRemoved = (tabId, info) => {
      if (info.windowId === sourceWindowId) state.removed.push(tabId);
    };
    const onUpdated = (tabId, changeInfo) => {
      if (tabId === sourceTabId && (Object.hasOwn(changeInfo, 'url') || Object.hasOwn(changeInfo, 'discarded'))) {
        state.sourceUpdates.push(Object.keys(changeInfo).filter(key => key === 'url' || key === 'discarded').sort());
      }
    };
    chrome.tabs.onCreated.addListener(onCreated);
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.onUpdated.addListener(onUpdated);
    Object.defineProperty(globalThis, '__auditaBatchTabsProofV1', {
      value: {
        state,
        dispose() {
          chrome.tabs.onCreated.removeListener(onCreated);
          chrome.tabs.onActivated.removeListener(onActivated);
          chrome.tabs.onRemoved.removeListener(onRemoved);
          chrome.tabs.onUpdated.removeListener(onUpdated);
        }
      },
      configurable: true,
      enumerable: false,
      writable: false
    });
    return true;
  })()`);
  assert.equal(armed, true);
}

async function armProgressProof(extension, panel) {
  const armed = await extension.evaluate(panel, `(() => {
    try { globalThis.__auditaBatchProgressProofV1?.observer?.disconnect?.(); } catch {}
    const readings = [];
    const sample = () => {
      const root = document.querySelector('[data-screen="running"]');
      const progress = root?.querySelector('progress[data-audit-progress]');
      if (!root || !progress || !root.hasAttribute('data-page-number') || !root.hasAttribute('data-total') ||
        !progress.hasAttribute('value') || !progress.hasAttribute('max')) return;
      const reading = {
        pageNumber: Number(root.dataset.pageNumber),
        total: Number(root.dataset.total),
        value: Number(progress.getAttribute('value')),
        max: Number(progress.getAttribute('max')),
        label: progress.getAttribute('aria-label')
      };
      const serialized = JSON.stringify(reading);
      if (JSON.stringify(readings.at(-1) ?? null) !== serialized) readings.push(reading);
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.querySelector('#panel-root'), { subtree: true, childList: true, attributes: true });
    Object.defineProperty(globalThis, '__auditaBatchProgressProofV1', {
      value: { observer, readings }, configurable: true, enumerable: false, writable: false
    });
    sample();
    return true;
  })()`);
  assert.equal(armed, true);
}

async function assertOriginalPageIntact(extension, identityBefore) {
  const [comparison, identityAfter] = await Promise.all([
    extension.evaluate(extension.startPage.page, 'globalThis.__auditaBatchSourceProofV1.compare()'),
    extension.identityOf(extension.startPage),
  ]);
  assert.deepEqual(comparison, {
    sameSnapshot: true, href: true, title: true, html: true, history: true, scroll: true, viewport: true,
    mutationTotal: 0, actionTotal: 0,
  });
  assert.deepEqual(identityAfter, identityBefore, 'a identidade do documento original mudou durante o lote');
}

async function readInvisibleTabsProof(extension) {
  return extension.evaluate(extension.harnessPage, `(async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    const proof = globalThis.__auditaBatchTabsProofV1;
    const createdIds = proof.state.created.map(value => value.tabId);
    const active = await chrome.tabs.query({ active: true, windowId: ${JSON.stringify(extension.startPage.windowId)} });
    const stillPresent = [];
    for (const tabId of createdIds) {
      try { await chrome.tabs.get(tabId); stillPresent.push(tabId); } catch {}
    }
    return {
      created: proof.state.created.map(value => ({ ...value })),
      activatedOwners: proof.state.activated.filter(tabId => createdIds.includes(tabId)),
      removedOwners: proof.state.removed.filter(tabId => createdIds.includes(tabId)),
      activeIds: active.map(tab => tab.id),
      stillPresent,
      sourceUpdates: proof.state.sourceUpdates.map(value => [...value])
    };
  })()`, { awaitPromise: true });
}

test('audits exactly two explicit URLs invisibly in one sanitized no-pixels batch report', { timeout: 300_000 }, async t => {
  assert.ok(chromeBinary, 'AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório para o E2E real de lote.');
  await access(chromeBinary, fsConstants.X_OK);
  const fixtureA = await startFixtureServer(t, new Map([
    ['/', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      body: '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Origem preservada do lote</title></head><body><main><h1>Página original intacta</h1><textarea id="source-state">estado original</textarea><p>Esta página não integra o lote.</p></main></body></html>',
    }],
    ['/batch-a', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      body: targetDocument('A'),
    }],
    ['/audit-pixel.gif', {
      status: 200,
      headers: { 'content-type': 'image/gif', 'cache-control': 'no-store' },
      body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'),
    }],
  ]));
  const fixtureB = await startFixtureServer(t, new Map([
    ['/batch-b', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      body: targetDocument('B'),
    }],
  ]));
  const rawUrlA = `${fixtureA.origin}/batch-a?private_a=${queryMarkerA}#${fragmentMarkerA}`;
  const rawUrlB = `${fixtureB.origin}/batch-b?private_b=${queryMarkerB}#${fragmentMarkerB}`;
  const publicUrlA = `${fixtureA.origin}/`;
  const publicUrlB = `${fixtureB.origin}/`;

  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(workspaceRoot),
    startUrl: `${fixtureA.origin}/`,
    downloadMode: 'profile',
    viewport: { width: 1280, height: 900 },
    chromeBinary,
    expectedMajor: 152,
  });
  assert.equal(extension.chromeProduct, CANONICAL_CHROME_PRODUCT);

  const panel = await extension.openSidePanelFromAction();
  await extension.waitForValue(panel,
    `document.querySelector('[data-screen]')?.dataset.screen`, value => value === 'initial');
  const sourceIdentity = await armOriginalPageProof(extension);
  await armInvisibleTabsProof(extension);
  await armProgressProof(extension, panel);

  await extension.click(panel, 'button[data-intent="OPEN_BATCH_FORM"]');
  const entry = await extension.waitForValue(panel, `(() => ({
    form: Boolean(document.querySelector('#batch-audit-form')),
    textarea: Boolean(document.querySelector('#audit-urls[name="batch-urls"]')),
    selected: document.querySelector('input[name="capture-mode"]:checked')?.value ?? null,
    disabled: document.querySelector('input[name="capture-mode"]:checked')?.disabled ?? null,
    submit: Boolean(document.querySelector('[data-action="start-batch-audit"]')),
    status: document.querySelector('[role="status"]')?.textContent ?? ''
  }))()`, value => value?.form === true, { timeoutMs: 10_000, intervalMs: 25 });
  assert.deepEqual(entry, {
    form: true,
    textarea: true,
    selected: 'no-pixels',
    disabled: false,
    submit: true,
    status: 'Informe uma URL por linha e escolha como coletar as evidências.',
  });

  assert.equal(await extension.evaluate(panel, `(() => {
    const textarea = document.querySelector('#audit-urls');
    textarea.value = ${JSON.stringify(`${rawUrlA}\n${rawUrlB}`)};
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return textarea.value.split('\\n').length === 2;
  })()`), true);
  await extension.click(panel, '[data-action="start-batch-audit"]');

  await extension.waitForValue(panel,
    `document.querySelector('[data-screen]')?.dataset.screen ?? null`,
    value => ['running', 'result', 'unavailable'].includes(value),
    { timeoutMs: 10_000, intervalMs: 25 });
  let terminal;
  try {
    terminal = await extension.waitForValue(panel, `(() => ({
      screen: document.querySelector('[data-screen]')?.dataset.screen ?? null,
      status: document.querySelector('[role="status"]')?.textContent ?? null
    }))()`, value => ['result', 'unavailable', 'initial'].includes(value?.screen), {
      timeoutMs: 150_000,
      intervalMs: 50,
    });
  } catch (error) {
    const diagnostic = await extension.evaluate(extension.harnessPage, `(async () => {
      const store = (await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
      const [latest, session] = await Promise.all([store.getLatest(), chrome.storage.session.get(null)]);
      const rows = Object.entries(session).map(([key, value]) => ({
        family: key.replace(/:[^:]+$/u, ':*'),
        state: value && typeof value === 'object' && typeof value.state === 'string' ? value.state : null,
        mode: value && typeof value === 'object' && typeof value.mode === 'string' ? value.mode : null,
        commitState: value && typeof value === 'object' && typeof value.commitState === 'string' ? value.commitState : null
      })).sort((left, right) => left.family.localeCompare(right.family));
      return {
        latest: latest ? { status: latest.status, failureCode: latest.failureCode ?? null, modelRevision: latest.modelRevision } : null,
        session: rows,
        rawMarkersPresent: JSON.stringify(session).includes(${JSON.stringify(queryMarkerA)}) ||
          JSON.stringify(session).includes(${JSON.stringify(queryMarkerB)})
      };
    })()`, { awaitPromise: true });
    const panelState = await extension.evaluate(panel, `(() => ({
      screen: document.querySelector('[data-screen]')?.dataset.screen ?? null,
      status: document.querySelector('[role="status"]')?.textContent ?? null,
      pageNumber: document.querySelector('[data-page-number]')?.getAttribute('data-page-number') ?? null,
      total: document.querySelector('[data-total]')?.getAttribute('data-total') ?? null,
      progress: document.querySelector('progress[data-audit-progress]')?.getAttribute('value') ?? null
    }))()`);
    t.diagnostic(`sanitized-batch-timeout=${JSON.stringify({ panelState, diagnostic })}`);
    throw error;
  }
  if (terminal.screen !== 'result') {
    const terminalDiagnostic = await extension.evaluate(extension.harnessPage, `(async () => {
      const store = (await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
      const latest = await store.getLatest();
      return latest ? {
        status: latest.status,
        failureCode: latest.failureCode ?? null,
        modelRevision: latest.modelRevision,
        message: typeof latest.message === 'string' && !/[?#]/u.test(latest.message) ? latest.message : null
      } : null;
    })()`, { awaitPromise: true });
    t.diagnostic(`sanitized-batch-terminal=${JSON.stringify({ terminal, latest: terminalDiagnostic })}`);
  }
  assert.equal(terminal.screen, 'result', `o lote terminou na tela ${terminal.screen}; estado público=${terminal.status}`);
  const auditId = await extension.readAttribute(panel, '[data-screen="result"]', 'data-audit-id');
  assert.match(auditId ?? '', /^[A-Za-z0-9._:-]{1,160}$/u);

  const progressReadings = await extension.evaluate(panel,
    'globalThis.__auditaBatchProgressProofV1.readings.map(value => ({ ...value }))');
  assert.ok(progressReadings.length >= 2, 'o progresso por página não ficou observável');
  assert.deepEqual([...new Set(progressReadings.map(value => value.pageNumber))], [1, 2]);
  assert.equal(progressReadings.every(value => value.total === 2 && value.max === 100 &&
    Number.isFinite(value.value) && value.value >= 0 && value.value <= 100 &&
    /^Progresso do lote: (?:100|[0-9]{1,2}(?:\.[0-9]+)?)%$/u.test(value.label ?? '')), true);
  assert.equal(progressReadings.every((value, index) => index === 0 || value.value > progressReadings[index - 1].value), true,
    'o indicador público do lote regrediu ou repetiu percentuais');
  const progressText = JSON.stringify(progressReadings);
  assert.equal([rawUrlA, rawUrlB, queryMarkerA, queryMarkerB, fragmentMarkerA, fragmentMarkerB]
    .some(value => progressText.includes(value)), false);

  const tabsProof = await readInvisibleTabsProof(extension);
  assert.deepEqual(tabsProof.created.map(value => ({ windowId: value.windowId, active: value.active })), [
    { windowId: extension.startPage.windowId, active: false },
    { windowId: extension.startPage.windowId, active: false },
  ]);
  assert.deepEqual(tabsProof.activatedOwners, []);
  assert.equal(new Set(tabsProof.removedOwners).size, 2);
  assert.deepEqual(tabsProof.stillPresent, []);
  assert.deepEqual(tabsProof.activeIds, [extension.startPage.tabId]);
  assert.deepEqual(tabsProof.sourceUpdates, []);
  await assertOriginalPageIntact(extension, sourceIdentity);

  const durable = await extension.evaluate(extension.harnessPage, `(async () => {
    const store = (await import(chrome.runtime.getURL('/src/storage/audit-store.js'))).createAuditStore();
    const [revision, latest, session] = await Promise.all([
      store.getReportRevision(${JSON.stringify(auditId)}),
      store.getLatest(),
      chrome.storage.session.get(null)
    ]);
    const model = revision?.model;
    const operation = indexedDB.open('audita-mt');
    const db = await new Promise((resolve, reject) => {
      operation.onsuccess = () => resolve(operation.result);
      operation.onerror = () => reject(new Error('BATCH_DATABASE_UNAVAILABLE'));
    });
    const tx = db.transaction(['audits'], 'readonly');
    const request = tx.objectStore('audits').getAllKeys();
    const keys = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('BATCH_DATABASE_UNAVAILABLE'));
    });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(new Error('BATCH_DATABASE_UNAVAILABLE'));
      tx.onabort = () => reject(new Error('BATCH_DATABASE_UNAVAILABLE'));
    });
    db.close();
    const publicKeys = keys.filter(key => typeof key === 'string' && !key.startsWith('__'));
    const modelText = JSON.stringify(model ?? null);
    const sessionText = JSON.stringify(session);
    const forbidden = ${JSON.stringify([
      queryMarkerA, queryMarkerB, fragmentMarkerA, fragmentMarkerB, ...forbiddenPublicNames,
    ])};
    const pageIds = Array.isArray(model?.pages) ? model.pages.map(page => page.pageId) : [];
    const occurrenceCount = Array.isArray(model?.occurrences) ? model.occurrences.length : 0;
    const occurrenceCounts = Object.fromEntries(pageIds.map(pageId => [
      pageId,
      Array.isArray(model?.occurrences) ? model.occurrences.filter(value => value?.pageId === pageId).length : 0,
    ]));
    const occurrencePageIds = [...new Set((model?.occurrences ?? []).map(value => value.pageId))].sort();
    return {
      revision: Boolean(revision),
      latest: latest?.auditId === ${JSON.stringify(auditId)} && ['complete', 'partial'].includes(latest.status),
      mode: model?.requestedScope?.mode ?? null,
      pageIds,
      orderedUrls: model?.pages?.[0]?.requestedUrl === ${JSON.stringify(publicUrlA)} &&
        model?.pages?.[1]?.requestedUrl === ${JSON.stringify(publicUrlB)},
      allAttempted: model?.pages?.every(page => page.attempted === true) ?? false,
      occurrenceCount,
      occurrenceCounts,
      occurrencePageIds,
      singlePublicRecord: publicKeys.length === 1 && publicKeys[0] === ${JSON.stringify(auditId)} &&
        !publicKeys.some(key => key.includes(':page-')),
      rawVaultAbsent: !Object.keys(session).some(key => key.startsWith('audita:raw-navigation:v1:') ||
        key.startsWith('audita:raw-navigation-queue:v1:')),
      forbiddenModel: forbidden.filter(value => modelText.includes(value)),
      forbiddenSessionMarkers: ${JSON.stringify([queryMarkerA, queryMarkerB, fragmentMarkerA, fragmentMarkerB])}
        .filter(value => sessionText.includes(value)),
      pixelPayloads: (model?.evidence ?? []).filter(value =>
        typeof value?.dataUrl === 'string' && value.dataUrl.length > 0).length,
      rasterDataUrls: (modelText.match(/data:image\\/(?:png|jpeg|webp);base64,/giu) ?? []).length,
      limitation: modelText.includes('PIXEL_CAPTURE_OMITTED')
    };
  })()`, { awaitPromise: true });
  const { occurrenceCount, occurrenceCounts, ...durableContract } = durable;
  assert.equal(Number.isSafeInteger(occurrenceCount) && occurrenceCount > 0, true);
  assert.equal(Number.isSafeInteger(occurrenceCounts['page-1']) && occurrenceCounts['page-1'] > 0, true);
  assert.equal(Number.isSafeInteger(occurrenceCounts['page-2']) && occurrenceCounts['page-2'] > 0, true);
  assert.equal(occurrenceCounts['page-1'] + occurrenceCounts['page-2'], occurrenceCount);
  assert.deepEqual(durableContract, {
    revision: true,
    latest: true,
    mode: 'batch',
    pageIds: ['page-1', 'page-2'],
    orderedUrls: true,
    allAttempted: true,
    occurrencePageIds: ['page-1', 'page-2'],
    singlePublicRecord: true,
    rawVaultAbsent: true,
    forbiddenModel: [],
    forbiddenSessionMarkers: [],
    pixelPayloads: 0,
    rasterDataUrls: 0,
    limitation: true,
  });

  const panelPublic = await extension.evaluate(panel, `(() => {
    const text = document.documentElement?.outerHTML ?? '';
    const forbidden = ${JSON.stringify([
      rawUrlA, rawUrlB, queryMarkerA, queryMarkerB, fragmentMarkerA, fragmentMarkerB, ...forbiddenPublicNames,
    ])};
    return {
      forbidden: forbidden.filter(value => text.includes(value)),
      rasterDataUrls: (text.match(/data:image\\/(?:png|jpeg|webp);base64,/giu) ?? []).length,
      evidenceImages: document.querySelectorAll('[data-evidence-preview-image]').length
    };
  })()`);
  assert.deepEqual(panelPublic, { forbidden: [], rasterDataUrls: 0, evidenceImages: 0 });

  await extension.click(panel, 'button[data-intent="OPEN_REPORT"]');
  const report = await extension.waitForReport({ auditId });
  const reportProof = await extension.waitForValue(report, `(() => {
    const text = document.documentElement?.outerHTML ?? '';
    const forbidden = ${JSON.stringify([
      rawUrlA, rawUrlB, queryMarkerA, queryMarkerB, fragmentMarkerA, fragmentMarkerB, ...forbiddenPublicNames,
    ])};
    return {
      ready: Boolean(document.querySelector('[data-report-navigation]') && document.querySelector('[data-report-export]')),
      status: document.querySelector('#review-status')?.textContent ?? null,
      page1Issues: document.querySelectorAll('[data-report-issue][data-page="page-1"]').length,
      page2Issues: document.querySelectorAll('[data-report-issue][data-page="page-2"]').length,
      page1Occurrences: document.querySelectorAll(
        '[data-report-issue][data-page="page-1"] [data-report-occurrence-technical]').length,
      page2Occurrences: document.querySelectorAll(
        '[data-report-issue][data-page="page-2"] [data-report-occurrence-technical]').length,
      totalOccurrences: document.querySelectorAll('[data-report-occurrence-technical]').length,
      forbidden: forbidden.filter(value => text.includes(value)),
      rasterDataUrls: (text.match(/data:image\\/(?:png|jpeg|webp);base64,/giu) ?? []).length,
      evidenceImages: document.querySelectorAll('[data-evidence-preview-image], img.evidence-media').length,
      limitation: text.includes('PIXEL_CAPTURE_OMITTED') || /sem imagens|nenhuma captura raster/iu.test(document.body?.innerText ?? '')
    };
  })()`, value => typeof value?.status === 'string' && value.status !== 'Carregando a auditoria.', {
    timeoutMs: 30_000,
    intervalMs: 50,
  });
  assert.equal(reportProof.ready, true, `o relatório consolidado não carregou: ${reportProof.status}`);
  assert.equal(reportProof.page1Issues > 0 && reportProof.page2Issues > 0, true);
  assert.equal(reportProof.page1Occurrences, occurrenceCounts['page-1'],
    'o relatório omitiu ocorrências da primeira página');
  assert.equal(reportProof.page2Occurrences, occurrenceCounts['page-2'],
    'o relatório omitiu ocorrências da segunda página');
  assert.equal(reportProof.totalOccurrences, occurrenceCount,
    'o relatório não renderizou todas as ocorrências do modelo completo');
  assert.deepEqual(reportProof.forbidden, []);
  assert.equal(reportProof.rasterDataUrls, 0);
  assert.equal(reportProof.evidenceImages, 0);
  assert.equal(reportProof.limitation, true);
  await assertOriginalPageIntact(extension, sourceIdentity);

  t.diagnostic(`Chrome=${extension.chromeProduct}; source=batch; pages=2; mode=no-pixels; progress=monotonic; audit-tabs=inactive; original=untouched; publicLeaks=0; rasterEvidence=0; auditId=${auditId}`);
});
