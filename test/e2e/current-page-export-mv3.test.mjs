import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, launchUnpackedExtension, resolveRealChromeTestBinary, evaluate, waitForValue, waitForFourDownloads } from './support/real-chrome.mjs';

// The current-page audit stores a review-ready model whose artifact is still pending, so its
// export takes the immutable revision path. That path must accept an honest partial receipt
// and deliver the four artifacts for real: this is the exact journey that used to fail with
// "Recibo completo da revisão imutável inválido." while closing the export tab silently.
const DOCUMENT = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Exportação da página atual</title></head>
<body><main><h1>Página avaliada</h1>
<img id="missing-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
<button id="missing-name"></button><input id="missing-label" type="text">
<a href="/current">clique aqui</a></main></body></html>`;

test('current-page audit exports four verified artifacts', { timeout: 420_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([
    ['/current', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: DOCUMENT }],
  ]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/current`, chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
    viewport: { width: 1280, height: 900 }, downloadMode: 'profile',
  });
  const panel = await extension.openSidePanelFromAction();
  await panel.command('Page.bringToFront');
  await waitForValue(panel, 'document.visibilityState', value => value === 'visible', { timeoutMs: 10_000 });
  await waitForValue(panel, `(() => {
    const input=document.querySelector('input[data-capture-mode="no-pixels"]');
    const button=document.querySelector('button[data-intent="START_ATTACHED"]');
    return Boolean(input&&!input.disabled&&button&&!button.disabled);
  })()`, value => value === true, { timeoutMs: 30_000, intervalMs: 50 });
  const sourceUrl = await evaluate(extension.startPage.page, 'location.href');
  await extension.click(panel, 'input[data-capture-mode="no-pixels"]');
  await extension.click(panel, 'button[data-intent="START_ATTACHED"]');
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const screen = await evaluate(panel, `document.querySelector('[data-screen]')?.dataset.screen ?? null`).catch(() => null);
    if (screen === 'result') break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const auditId = await extension.readAttribute(panel, '[data-screen="result"]', 'data-audit-id');
  assert.match(auditId ?? '', /^[A-Za-z0-9._:-]{1,160}$/u);

  await extension.click(panel, 'button[data-intent="OPEN_REPORT"]');
  const report = await extension.waitForReport({ auditId });
  await waitForValue(report, `Boolean(document.querySelector('button[data-report-export]'))`, value => value === true, { timeoutMs: 30_000 });
  await extension.click(report, 'button[data-report-export]');

  // The durable four-format receipt is the proof: it hashes the bytes that landed on disk.
  const downloads = await waitForFourDownloads(extension, { auditId, timeoutMs: 120_000, intervalMs: 250 });
  assert.deepEqual(downloads.map(record => record.format), ['html', 'pdf', 'csv', 'json']);
  for (const record of downloads) {
    assert.equal(record.state, 'complete', record.format);
    assert.ok(record.byteLength > 0, record.format);
    assert.match(record.sha256, /^[a-f0-9]{64}$/u, record.format);
  }
  // The source page must not have been navigated by the export.
  assert.equal(await evaluate(extension.startPage.page, 'location.href'), sourceUrl);

  // Opaque audit secrets stay confined to the session area. The capability ids and any ownership
  // id are the nonces of this product: they bind one audit to one user event, and the meta requires
  // that they never reach the DOM, the reducer, the model, the report, a URL or the logs. Unit tests
  // assert containment statically; this is the runtime sweep over a real audit's real surfaces.
  const collected = await evaluate(extension.harnessPage, `(async()=>{
    const session = await chrome.storage.session.get(null);
    const local = await chrome.storage.local.get(null);
    const dump = JSON.stringify(session);
    const ids = new Set();
    for (const key of Reflect.ownKeys(session)) {
      const match = /^audita:(?:audit-session|target)-capability:v\\d+:(.+)$/u.exec(key);
      if (match && /^[A-Za-z0-9_-]{22}$/u.test(match[1])) ids.add(match[1]);
    }
    for (const match of dump.matchAll(/owner_[A-Za-z0-9_-]{22}/gu)) ids.add(match[0]);
    const secrets = [...ids];
    const localText = JSON.stringify(local);
    return { secrets, durableLeaks: secrets.filter(id => localText.includes(id)) };
  })()`, { awaitPromise: true });
  assert.ok(collected.secrets.length > 0, 'a auditoria precisa ter emitido ao menos um segredo de sessão para a varredura valer');

  const surfaces = {
    'página auditada': await evaluate(extension.startPage.page, 'document.documentElement.outerHTML'),
    painel: await evaluate(panel, 'document.documentElement.outerHTML'),
    relatório: await evaluate(report, 'document.documentElement.outerHTML'),
    'URLs de abas': (await evaluate(extension.harnessPage,
      `chrome.tabs.query({}).then(rows => rows.map(row => String(row.url ?? '')).join('\\n'))`,
      { awaitPromise: true })) ?? '',
    'armazenamento durável': JSON.stringify(await evaluate(extension.harnessPage,
      `chrome.storage.local.get(null)`, { awaitPromise: true })),
    'modelo e revisão guardados': await evaluate(extension.harnessPage, `import(chrome.runtime.getURL('/src/storage/audit-store.js'))
      .then(async module => {
        const store = module.createAuditStore();
        const [snapshot, revision] = await Promise.all([
          store.getAuditSnapshot(${JSON.stringify(auditId)}), store.getReportRevision(${JSON.stringify(auditId)}),
        ]);
        return JSON.stringify({ snapshot, revision });
      })`, { awaitPromise: true }),
  };
  const directory = extension.downloadDirectory;
  for (const name of await readdir(directory)) {
    const extensionName = name.split('.').at(-1);
    // The PDF is a compressed binary stream: a substring sweep over its bytes cannot clear it, and
    // this test does not claim to. The three text artifacts are swept byte for byte.
    if (!['html', 'csv', 'json'].includes(extensionName)) continue;
    surfaces[`artefato ${extensionName}`] = (await readFile(`${directory}/${name}`)).toString('utf8');
  }
  for (const [surface, text] of Object.entries(surfaces)) {
    for (const secret of collected.secrets) {
      assert.equal(text.includes(secret), false,
        `segredo de sessão vazou para ${surface}: ${JSON.stringify({ auditId, length: secret.length })}`);
    }
  }
  assert.deepEqual(collected.durableLeaks, [], 'segredo de sessão não pode estar no armazenamento durável');
  t.diagnostic(`segredos varridos=${collected.secrets.length}; superfícies=${Object.keys(surfaces).length}`);
  await extension.close();
});
