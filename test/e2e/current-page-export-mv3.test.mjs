import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, launchUnpackedExtension, resolveRealChromeTestBinary, evaluate, waitForValue, waitForFourDownloads } from './support/real-chrome.mjs';

// The current-page audit stores a review-ready model whose artifact is still pending, so its
// export takes the immutable revision path. That path must accept an honest partial receipt
// and deliver the four artifacts for real: this is the exact journey that used to fail with
// "Recibo completo da revisão imutável inválido." while closing the export tab silently.
//
// The page also carries credential-shaped content of its own, in text, in a value in ANOTHER node
// (inline element, table cell, JSON inside pre, after a void element, split across nodes, behind HTML
// entities), in an attribute value and in the URL — including a credential key in the query and in the
// fragment. Every one of these shapes was measured leaking by an independent review at some point. The sweep at the end of this test is only worth something if the material it sweeps
// exists, so the fixture makes it exist: without it the label scan was vacuously green (any list,
// including an empty one, cleared the homepage), and measuring non-vacuously is what found the
// snippet sanitizer shipping `senha: …` and `cartão: 4111 1111 1111 1111` into the delivered HTML
// and JSON.
const CREDENTIAL = 'S3GR3D0XYZQ';
const DOCUMENT = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Exportação da página atual</title></head>
<body><main><h1>Página avaliada</h1>
<p id="credential-text">senha: ${CREDENTIAL}</p>
<p id="credential-nested">token: <code>${CREDENTIAL}</code></p>
<table><tbody><tr><th scope="row">chave:</th><td>${CREDENTIAL}</td></tr></tbody></table>
<pre id="credential-json">{"senha": "${CREDENTIAL}"}</pre>
<p id="credential-multi">cartão: 4111 1111 1111 1111</p>
<p id="credential-br">token:<br>${CREDENTIAL}</p>
<p id="credential-newline">senha: ${CREDENTIAL.slice(0, 4)}
${CREDENTIAL.slice(4)}</p>
<p id="credential-suffix">senhaAtual: ${CREDENTIAL}</p>
<p id="credential-split"><span>chave</span>: <span>${CREDENTIAL}</span></p>
<pre id="credential-entity">{&quot;senha&quot;: &quot;${CREDENTIAL}&quot;}</pre>
<div id="credential-attribute" data-note="chave: ${CREDENTIAL}">Nota do autor</div>
<p id="adv-a1"><b>senha</b>: ${CREDENTIAL}</p>
<p id="adv-idioma">Cartão de crédito: ${CREDENTIAL}</p>
<p id="adv-janela">Número do cartão de crédito do titular: 4111 1111 1111 1111</p>
<p id="adv-parenteses">Senha (provisória): ${CREDENTIAL}</p>
<p id="adv-qualificado">Código de verificação: ${CREDENTIAL}</p>
<p id="adv-recuperacao">frase de recuperação: ${CREDENTIAL}</p>
<p id="adv-cauda">cartão de crédito ${CREDENTIAL}</p>
<input id="adv-seletor" title="senha ${CREDENTIAL}">
<p id="adv-a2">senha<!-- nota -->: ${CREDENTIAL}</p>
<p id="adv-a3">senha:<img alt="i">${CREDENTIAL}</p>
<p id="adv-a4">senha:<span></span>${CREDENTIAL}</p>
<p id="adv-a5">senha&nbsp;: ${CREDENTIAL}</p>
<p id="adv-a6">Senha atual: ${CREDENTIAL}</p>
<pre id="adv-a7">{&amp;quot;senha&amp;quot;: &amp;quot;${CREDENTIAL}&amp;quot;}</pre>
<p id="adv-a9"><b>senha</b> ${CREDENTIAL}</p>
<table><tbody><tr><th scope="row">senha:</th><td></td><td>${CREDENTIAL}</td></tr></tbody></table>
<pre id="adv-a11">{"code": "${CREDENTIAL}"}</pre>
<pre id="adv-a12">{"assertion": "${CREDENTIAL}"}</pre>
<p id="adv-a13">senha:<svg></svg>${CREDENTIAL}</p>
<a id="credential-query" href="/current?code=${CREDENTIAL}">código</a>
<a id="credential-hash" href="/current#assertion=${CREDENTIAL}">afirmação</a>
<a id="credential-encoded" href="/current?co%64e=${CREDENTIAL}">codificado</a>
<div id="credential-title" title="chave ${CREDENTIAL}">Título do autor</div>
<input id="credential-placeholder" placeholder="senha ${CREDENTIAL}" aria-label="Campo">
<img id="missing-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
<button id="missing-name"></button><input id="missing-label" type="text">
<a href="/current">clique aqui</a></main></body></html>`;

test('current-page audit exports four verified artifacts', { timeout: 420_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([
    ['/current', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: DOCUMENT }],
  ]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/current?senha=${CREDENTIAL}&cpf=12345678900&id=7`, chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
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

  // Ask for one live marking before exporting. Besides being part of the required journey, this is
  // what makes the audit mint the highlight nonce — the value that binds one marking to one document.
  // Without it the nonce sweep below would have nothing to sweep and would pass vacuously.
  // A tela de resultado aparece antes de os cartões serem renderizados: ler a lista uma única vez já
  // falhou por corrida numa execução sob carga. A espera não afrouxa a asserção — ela continua exigindo
  // ao menos um achado confirmado —, só não confunde renderização com ausência.
  await waitForValue(panel,
    `document.querySelectorAll('[data-result-card][data-classification="failed"] button[data-intent="SELECT_OCCURRENCE"]').length`,
    value => typeof value === 'number' && value > 0, { timeoutMs: 30_000, intervalMs: 50 });
  const candidates = await evaluate(panel,
    `Array.from(document.querySelectorAll('[data-result-card][data-classification="failed"] button[data-intent="SELECT_OCCURRENCE"]'), element => element.dataset.focusId)`);
  assert.ok(candidates.length > 0, 'a fixture precisa produzir um achado confirmado para o destaque');
  let highlighted = false;
  for (const focusId of candidates) {
    await evaluate(panel, `(() => {
      const button = [...document.querySelectorAll('button[data-focus-id]')].find(node => node.dataset.focusId === ${JSON.stringify(focusId)});
      const group = button?.closest('details[data-abnt-group]');
      if (group && !group.open) group.querySelector('summary').click();
      return Boolean(button);
    })()`);
    await extension.click(panel, `button[data-focus-id="${focusId}"]`);
    // The action starts as `highlight-checking` while the worker proves the binding, exactly as in
    // the mandatory journey; reading it immediately would sample that transient state.
    const action = await waitForValue(panel,
      `document.querySelector('[data-result-detail] .detail-actions [data-action]')?.dataset.action ?? null`,
      value => value !== null && value !== 'highlight-checking', { timeoutMs: 5_000, intervalMs: 25 })
      .catch(() => null);
    if (action !== 'highlight-occurrence') continue;
    await extension.click(panel, '[data-result-detail] .detail-actions [data-action="highlight-occurrence"]');
    await waitForValue(extension.startPage.page,
      `Boolean(document.querySelector('[data-audita-highlight-root]'))`, value => value === true,
      { timeoutMs: 10_000, intervalMs: 50 });
    highlighted = true;
    break;
  }
  assert.equal(highlighted, true, 'o percurso precisa oferecer "Destacar elemento" em um achado confirmado');

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

  // Exportar de novo é caminho que a pessoa usuária alcança: o botão da aba de revisão nunca é
  // desabilitado (`review.js` só desabilita o "Refazer auditoria"). Este passo existe porque eu
  // havia afirmado que o descasamento validador/renderizador de `persistExportSuccess` também
  // atingia a segunda exportação — e a medição **refutou** a afirmação: como a exportação da
  // revisão imutável preserva o modelo guardado (`export-controller.js:182-184`), o segundo pedido
  // encontra `review-ready` + `artifact: pending` e percorre o mesmo caminho do primeiro. Fica como
  // cobertura de "exportar duas vezes funciona", que é o que a medição sustenta.
  await extension.click(report, 'button[data-report-export]');
  const second = await waitForFourDownloads(extension, { auditId, timeoutMs: 120_000, intervalMs: 250 });
  assert.deepEqual(second.map(record => record.format), ['html', 'pdf', 'csv', 'json'],
    'a segunda exportação precisa entregar os quatro formatos');
  for (const record of second) {
    assert.equal(record.state, 'complete', record.format);
    assert.ok(record.byteLength > 0, record.format);
    assert.match(record.sha256, /^[a-f0-9]{64}$/u, record.format);
  }

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
    let highlightNonces = 0;
    for (const [key, value] of Object.entries(session)) {
      if (!key.startsWith('audita:highlight-bindings')) continue;
      for (const match of JSON.stringify(value).matchAll(/"nonce":"([A-Za-z0-9_-]{22})"/gu)) {
        ids.add(match[1]);
        highlightNonces += 1;
      }
    }
    const secrets = [...ids];
    const localText = JSON.stringify(local);
    return { secrets, highlightNonces, durableLeaks: secrets.filter(id => localText.includes(id)) };
  })()`, { awaitPromise: true });
  assert.ok(collected.secrets.length > 0, 'a auditoria precisa ter emitido ao menos um segredo de sessão para a varredura valer');
  assert.ok(collected.highlightNonces > 0,
    'a varredura do nonce do destaque precisa ter um nonce real para varrer, senão ela passa por vacuidade');

  const surfaces = {
    'página auditada': await evaluate(extension.startPage.page, 'document.documentElement.outerHTML'),
    painel: await evaluate(panel, 'document.documentElement.outerHTML'),
    relatório: await evaluate(report, 'document.documentElement.outerHTML'),
    'URLs de abas': (await evaluate(extension.harnessPage,
      `chrome.tabs.query({}).then(rows => rows.map(row => String(row.url ?? '')).filter(url =>
        url.startsWith('chrome-extension://') || url !== ${JSON.stringify(sourceUrl)}).join('\\n'))`,
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

  // A varredura de credencial da PÁGINA, com a fonte provada antes: a página auditada contém o valor
  // (medido abaixo), então uma varredura verde significa que o produto o retirou — não que não havia
  // o que varrer.
  const rawPage = await evaluate(extension.startPage.page, 'document.documentElement.outerHTML');
  assert.ok(rawPage.includes(CREDENTIAL) && rawPage.includes('4111 1111 1111 1111'),
    'a fixture precisa conter credencial de verdade, senão a varredura abaixo passa por vacuidade');
  const leaked = [];
  for (const [surface, text] of Object.entries(surfaces)) {
    // A página auditada é a FONTE e a URL dela é a que a pessoa já tinha aberta: nenhuma das duas é
    // entregável do produto. Todo o resto — inclusive as URLs que a extensão cria — precisa estar limpo.
    if (surface === 'página auditada') continue;
    if (surface === 'URL da aba auditada') continue;
    if (text.includes(CREDENTIAL) || text.includes('4111 1111 1111 1111')) leaked.push(surface);
  }
  assert.deepEqual(leaked, [], `credencial da página chegou ao entregável em: ${leaked.join(', ')}`);
  // E o outro lado: a URL do escopo continua útil e sanitizada nos artefatos entregues.
  const deliveredHtml = surfaces['artefato html'] ?? '';
  const deliveredJson = surfaces['artefato json'] ?? '';
  assert.equal(deliveredHtml.length > 0 && deliveredJson.length > 0, true, 'os dois artefatos de texto precisam existir');
  assert.doesNotMatch(deliveredJson, /[?&](?:senha|cpf)=/iu,
    'a URL do escopo entregue não pode carregar parâmetro de credencial');
  // Medido: `sanitizeEvidenceUrlV1` descarta a consulta INTEIRA quando qualquer parâmetro é sensível
  // (`queryIncluded: false`), então nem o `id=7` inofensivo sobrevive — fail-closed, e é isso que este
  // teste fixa em vez de afirmar uma filtragem por parâmetro que o produto não faz.
  assert.doesNotMatch(deliveredJson, /id=7/u,
    'a consulta inteira é descartada quando algum parâmetro é sensível');
  await extension.close();
});
