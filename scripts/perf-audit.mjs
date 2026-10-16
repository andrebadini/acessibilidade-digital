#!/usr/bin/env node
// Roteiro de MEDIÇÃO de desempenho da extensão "Audita Acessibilidade" (1.1.62).
//
// Ele carrega a extensão de verdade no Chrome for Testing, liga a instrumentação de bancada
// (`globalThis.__auditaPerf`, ver src/background/perf-log.js), audita a página em modo "Evidência
// completa" e recolhe duas famílias de números:
//
//   * tempos por fase da auditoria, medidos DENTRO do worker de segundo plano (e o perfil de
//     chamadas CDP por método, que diz qual comando domina cada fase);
//   * tempos de relógio de parede das etapas que a pessoa vê: painel com resultado, verificação
//     guiada, relatório completo e exportação dos quatro formatos;
//   * tamanho do modelo guardado no IndexedDB, separando o que é imagem.
//
// Nada disto entra no produto: com a chave desligada (o padrão fora daqui) cada ponto de medição é
// uma comparação booleana e o registro fica vazio.
//
// Uso:
//   node scripts/perf-audit.mjs [--out qa-out/perf-<nome>] [--label antes] [--runs 2] [--url ...]
//                              [--no-fixture] [--no-journey] [--no-export]

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  click,
  evaluate,
  launchUnpackedExtension,
  resolveRealChromeTestBinary,
  startFixtureServer,
  waitForValue,
} from '../test/e2e/support/real-chrome.mjs';

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIRECTORY = join(WORKSPACE_ROOT, 'test/e2e/fixtures/visual-qa');
const FIXTURE_PATH = '/marcacao.html';
const VIEWPORT = Object.freeze({ width: 1280, height: 900 });
const CAPTURE_MODE = 'full-evidence';
const CHROME_MAJOR = Number(process.env.AUDITA_EXPECT_CHROME_MAJOR ?? 152);
// Fases do worker que a tabela mostra; a ordem é a ordem em que acontecem na auditoria.
const PHASES = Object.freeze([
  'abrir-e-navegar', 'axe', 'ambiente', 'aquecimento-pagina', 'coleta-estrutural', 'captura-integral',
  'sondas-dinamicas', 'sonda-hover', 'regras-proprias', 'evidencias', 'mapa-anuncios', 'mapa-teclado',
  'apresentacao', 'modelo-handoff', 'modelo-final', 'enriquecer-modelo', 'gravacao-indexeddb',
  'persist-verificar-integridade', 'persist-bundle-painel', 'persist-gravar-terminal',
  'rascunho-hashes', 'rascunho-clone', 'rascunho-congelar', 'total',
]);

/**
 * A tabela lista as fases conhecidas na ordem acima e, depois delas, qualquer fase medida que não esteja
 * na lista — senão uma medição nova (por exemplo, o detalhe de dentro do enriquecimento) some da tabela
 * sem aviso, e a leitura fica incompleta sem parecer incompleta.
 */
function orderedPhaseNames(observed) {
  const known = PHASES.filter(name => observed.includes(name));
  const extra = observed.filter(name => !PHASES.includes(name)).sort((left, right) => left.localeCompare(right));
  return [...known, ...extra];
}

const USAGE = `Uso: node scripts/perf-audit.mjs [--out qa-out/perf-<nome>] [--label antes|depois] [--runs N]
                        [--url https://... ...] [--no-fixture] [--no-journey] [--no-export] [--help]

  --out <dir>    diretório de saída (padrão: qa-out/perf-<data-hora>)
  --label <nome> rótulo desta medição (ex.: antes, depois)
  --runs <n>     execuções por página (padrão: 2)
  --url <url>    mede também esta página (pode repetir)
  --no-fixture   não mede a fixture local
  --no-journey   não mede painel/verificação guiada/relatório
  --no-export    mede a jornada longa, mas não a exportação dos quatro formatos
  --help         mostra esta ajuda
`;

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19);
}

function slugify(rawUrl) {
  const url = new URL(rawUrl);
  const base = `${url.hostname}${url.pathname}`.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[.-]+|[.-]+$/gu, '');
  return (base || 'pagina').slice(0, 80);
}

function parseArguments(argv) {
  const options = { out: null, label: null, runs: 2, urls: [], fixture: true, journey: true, export: true, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') { options.help = true; continue; }
    if (argument === '--no-fixture') { options.fixture = false; continue; }
    if (argument === '--no-journey') { options.journey = false; continue; }
    if (argument === '--no-export') { options.export = false; continue; }
    if (['--out', '--url', '--runs', '--label'].includes(argument)) {
      const value = argv[index + 1];
      if (typeof value !== 'string' || !value || value.startsWith('--')) throw new Error(`ARGUMENTO_SEM_VALOR: ${argument}`);
      index += 1;
      if (argument === '--out') options.out = value;
      else if (argument === '--url') options.urls.push(value);
      else if (argument === '--label') options.label = value;
      else {
        const runs = Number(value);
        if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error(`ARGUMENTO_INVALIDO: --runs ${value}`);
        options.runs = runs;
      }
      continue;
    }
    throw new Error(`ARGUMENTO_DESCONHECIDO: ${argument}`);
  }
  return options;
}

async function fixtureRoutes() {
  const routes = new Map();
  const file = async (routePath, name, contentType, directory = FIXTURE_DIRECTORY) => {
    routes.set(routePath, {
      status: 200,
      headers: { 'content-type': contentType, 'cache-control': 'no-store' },
      body: await readFile(join(directory, name), 'utf8'),
    });
  };
  await file(FIXTURE_PATH, 'marcacao.html', 'text/html; charset=utf-8');
  await file('/marcacao.css', 'marcacao.css', 'text/css; charset=utf-8');
  await file('/marcacao.js', 'marcacao.js', 'text/javascript; charset=utf-8');
  const images = join(FIXTURE_DIRECTORY, 'img');
  for (const name of (await readdir(images).catch(() => []))) {
    if (!/^[A-Za-z0-9._-]+\.svg$/u.test(name)) continue;
    await file(`/img/${name}`, name, 'image/svg+xml; charset=utf-8', images);
  }
  return routes;
}

// ---------------------------------------------------------------------------------------------
// Expressões executadas dentro do painel e das páginas da extensão
// ---------------------------------------------------------------------------------------------

const PANEL_READY = `(() => {
  const input = document.querySelector('input[data-capture-mode="${CAPTURE_MODE}"]');
  const button = document.querySelector('button[data-intent="START_ATTACHED"]');
  return Boolean(input && !input.disabled && button && !button.disabled);
})()`;

const PANEL_SCREEN = `(() => {
  const root = document.querySelector('[data-screen]');
  return { screen: root?.dataset.screen ?? null, auditId: root?.dataset.auditId ?? null };
})()`;

// Tamanho do modelo guardado, separando imagem de texto. Roda DENTRO da página da extensão: o
// registro inteiro passa por JSON.stringify uma única vez, e volta para o Node só o resumo.
const MODEL_SIZE = auditId => `(async () => {
  const open = () => new Promise((res, rej) => {
    const request = indexedDB.open('audita-mt');
    request.onsuccess = () => res(request.result);
    request.onerror = () => rej(request.error);
  });
  const db = await open();
  const record = await new Promise((res, rej) => {
    const request = db.transaction(['audits'], 'readonly').objectStore('audits').get(${JSON.stringify(auditId)});
    request.onsuccess = () => res(request.result);
    request.onerror = () => rej(request.error);
  });
  if (!record) return null;
  const dataUrlLength = value => (typeof value === 'string' && value.startsWith('data:image/') ? value.length : 0);
  // O modelo guardado é o AuditModel V2: evidence é a lista de artefatos e o instantâneo guardado
  // traz só a contagem de nós (nodeCount), não a árvore inteira.
  const artifactsList = Array.isArray(record.evidence) ? record.evidence : (record.evidence?.artifacts ?? []);
  let images = 0;
  for (const artifact of artifactsList) {
    images += dataUrlLength(artifact.dataUrl);
    for (const segment of artifact.segments ?? []) images += dataUrlLength(segment.dataUrl);
  }
  return {
    totalBytes: JSON.stringify(record).length,
    imageBytes: images,
    artifacts: artifactsList.length,
    nodes: record.snapshot?.nodeCount ?? record.snapshot?.nodes?.length ?? 0,
    occurrences: record.occurrences?.length ?? 0,
  };
})()`;

function summarizePhases(entries) {
  const byPhase = new Map();
  const cdp = new Map();
  for (const entry of entries ?? []) {
    if (typeof entry?.phase !== 'string') continue;
    if (entry.phase.startsWith('cdp:')) {
      const current = cdp.get(entry.phase.slice(4)) ?? { ms: 0, count: 0 };
      cdp.set(entry.phase.slice(4), { ms: current.ms + entry.value, count: current.count + (entry.detail?.count ?? 0) });
      continue;
    }
    const current = byPhase.get(entry.phase) ?? { ms: 0, count: 0, detail: entry.detail ?? null };
    byPhase.set(entry.phase, { ms: current.ms + entry.value, count: current.count + 1, detail: current.detail ?? entry.detail ?? null });
  }
  return {
    phases: Object.fromEntries([...byPhase.entries()].map(([name, value]) => [name, {
      ms: Math.round(value.ms), count: value.count, detail: value.detail,
    }])),
    cdp: Object.fromEntries([...cdp.entries()]
      .sort((left, right) => right[1].ms - left[1].ms)
      .map(([name, value]) => [name, { ms: Math.round(value.ms), count: value.count }])),
  };
}

/**
 * Espera o worker terminar a gravação terminal e devolve quanto tempo isso levou (ms).
 *
 * A tela de resultado aparece ANTES desse instante: um clique em "Abrir relatório completo" nesse
 * intervalo fica pendente para sempre no painel ("Abrindo o relatório completo…") porque o pedido chega
 * enquanto a auditoria ainda está em finalização — medido nas duas versões, e é o motivo de a jornada
 * nunca abrir numa página pesada quando a espera é curta. O sinal usado aqui é a fase de gravação
 * (`gravacao-indexeddb`), que é justamente o último passo do worker; o valor medido entra na tabela.
 */
async function waitForTerminalWrite(worker, auditId, timeoutMs = 180_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const log = await readWorkerPhaseLog(worker, auditId).catch(() => null);
    if (log?.phases && Object.hasOwn(log.phases, 'gravacao-indexeddb')) return Date.now() - startedAt;
    await sleep(250);
  }
  return null;
}

async function readWorkerPhaseLog(worker, auditId) {
  const raw = await evaluate(worker, `(() => {
    if (typeof globalThis.__auditaPerfFlushCdp === 'function') globalThis.__auditaPerfFlushCdp();
    return JSON.stringify((globalThis.__auditaPerfLogV1 ?? []).filter(entry => entry.scope === ${JSON.stringify(auditId)}));
  })()`);
  if (typeof raw !== 'string') return null;
  try { return summarizePhases(JSON.parse(raw)); } catch { return null; }
}

/** Uma auditoria completa, com a jornada opcional depois do resultado. */
async function measureOnce({ target, chromeBinary, journey, doExport, runIndex }) {
  const cleanups = [];
  const host = { after: handler => cleanups.push(handler) };
  const record = { url: target.url, run: runIndex, stages: {}, phases: null, cdp: null, model: null, errors: [] };
  let launch = null;
  try {
    launch = await launchUnpackedExtension(host, {
      extensionPath: WORKSPACE_ROOT,
      startUrl: target.url,
      chromeBinary,
      expectedMajor: CHROME_MAJOR,
      viewport: { ...VIEWPORT },
      downloadMode: 'profile',
    });
    // Liga a medição no worker ANTES de qualquer trabalho: a chave é lida a cada ponto de medição,
    // então vale para toda a auditoria. Ela morre com o worker (nada é gravado em disco).
    await evaluate(launch.worker, 'globalThis.__auditaPerf = true; globalThis.__auditaPerfLogV1 = []; true');
    const panel = await launch.openSidePanelFromAction();
    await waitForValue(panel, 'document.visibilityState', value => value === 'visible', { timeoutMs: 15_000 });
    await waitForValue(panel, PANEL_READY, Boolean, { timeoutMs: 60_000, intervalMs: 100 });
    // O painel também conduz trabalho pesado (montagem do bundle, enriquecimento e verificação no
    // caminho anexado): sem ligar a chave aqui, essas fases ficariam invisíveis.
    await evaluate(panel, 'globalThis.__auditaPerf = true; globalThis.__auditaPerfLogV1 = []; true');

    await click(panel, `input[data-capture-mode="${CAPTURE_MODE}"]`);
    await sleep(300);
    const startedAt = Date.now();
    await click(panel, 'button[data-intent="START_ATTACHED"]');
    let screen = null;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      screen = await evaluate(panel, PANEL_SCREEN).catch(() => null);
      if (screen?.screen === 'result' || screen?.screen === 'unavailable') break;
      await sleep(200);
    }
    record.stages.auditoriaAteResultado = Date.now() - startedAt;
    record.stages.tela = screen?.screen ?? null;
    const auditId = screen?.auditId ?? null;
    record.auditId = auditId;
    if (record.stages.tela !== 'result' || !auditId) {
      record.errors.push(`sem resultado: ${record.stages.tela}`);
      return record;
    }
    // A tela de resultado aparece antes de os cartões serem desenhados: mede-se o desenho também.
    const cardsStartedAt = Date.now();
    await waitForValue(panel, `document.querySelectorAll('[data-result-card]').length`,
      value => typeof value === 'number' && value > 0, { timeoutMs: 60_000, intervalMs: 100 }).catch(() => null);
    record.stages.painelComCartoes = Date.now() - cardsStartedAt;

    // A tela de resultado aparece antes de o worker terminar de gravar. Em vez de um sono fixo (que numa
    // auditoria grande fica curto e numa pequena fica longo), mede-se quando o registro do IndexedDB já
    // está inteiro: é o mesmo instante em que o relatório passa a poder ser aberto, e o tempo de espera
    // vira número próprio — a gravação terminal de uma página real leva segundos.
    // Espera a gravação terminal EM MEDIDA e ainda um piso curto de acomodação do painel: o relatório
    // depende do mesmo worker, e pedir a abertura no mesmo instante em que a fase fecha deixava o pedido
    // pendente em "Abrindo o relatório completo…" nas medições desta bancada.
    record.stages.resultadoAteRegistroGravado = await waitForTerminalWrite(launch.worker, auditId);
    await sleep(2_500);
    const workerLog = await readWorkerPhaseLog(launch.worker, auditId);
    if (workerLog) { record.phases = workerLog.phases; record.cdp = workerLog.cdp; }
    else record.errors.push('sem registro de fases do worker');
    const panelLog = await readWorkerPhaseLog(panel, auditId);
    if (panelLog && Object.keys(panelLog.phases).length > 0) record.phasesPanel = panelLog.phases;
    record.model = await evaluate(panel, MODEL_SIZE(auditId), { awaitPromise: true }).catch(() => null);

    if (journey) {
      const openedAt = Date.now();
      // O botão fica indisponível enquanto o pedido anterior está em voo e o painel recusa um segundo
      // clique: a jornada tenta de novo em vez de registrar uma negação de arranjo como resultado.
      let report = null;
      let clickedAt = openedAt;
      let attempts = 0;
      for (let attempt = 0; attempt < 3 && report === null; attempt += 1) {
        if (attempt > 0) await sleep(2_000);
        attempts = attempt + 1;
        try {
          clickedAt = Date.now();
          await click(panel, 'button[data-intent="OPEN_REPORT"]');
          // `waitForReport` recusa argumento a mais (contrato do arranque de teste, com a sua própria
          // espera interna): passar `timeoutMs` aqui fazia a medição da jornada morrer em
          // REPORT_CONTEXT_DENIED antes de medir qualquer coisa.
          report = await launch.waitForReport({ auditId });
        } catch (error) {
          // O painel diz em texto por que não abriu (recusa, tempo esgotado, nova tentativa): sem isso a
          // negação do arranjo de teste não distingue "o produto recusou" de "o arranjo não achou a aba".
          const feedback = await evaluate(panel,
            `document.querySelector('[data-report-launch-status]')?.textContent ?? null`).catch(() => null);
          if (feedback) error.message = `${error?.code ?? error?.message} — painel: ${feedback}`;
          if (attempt === 2) throw error;
        }
      }
      record.stages.tentativasDeRelatorio = attempts;
      await waitForValue(report, `Boolean(document.querySelector('button[data-report-export]'))`, Boolean, { timeoutMs: 120_000, intervalMs: 100 });
      record.stages.relatorioCompleto = Date.now() - clickedAt;
      await waitForValue(report, `document.querySelectorAll('details.lay-card').length`,
        value => typeof value === 'number' && value > 0, { timeoutMs: 120_000, intervalMs: 100 }).catch(() => null);
      record.stages.verificacaoGuiada = Date.now() - clickedAt;
      record.stages.cartoesGuiados = await evaluate(report, `document.querySelectorAll('details.lay-card').length`).catch(() => null);
      if (doExport) {
        const exportAt = Date.now();
        await click(report, 'button[data-report-export]');
        try {
          await launch.waitForFourDownloads({ auditId, timeoutMs: 240_000, intervalMs: 250 });
          record.stages.exportacaoQuatroFormatos = Date.now() - exportAt;
        } catch (error) {
          record.stages.exportacaoQuatroFormatos = null;
          record.errors.push(`exportação: ${error?.code ?? error?.message ?? 'falhou'}`);
        }
      }
    }
    return record;
  } catch (error) {
    record.errors.push(`${error?.code ?? ''} ${error?.message ?? error}`.trim());
    return record;
  } finally {
    if (launch) await launch.close().catch(() => {});
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
  }
}

function median(values) {
  const numbers = values.filter(value => Number.isFinite(value)).sort((left, right) => left - right);
  if (numbers.length === 0) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 === 1 ? numbers[middle] : Math.round((numbers[middle - 1] + numbers[middle]) / 2);
}

function aggregate(runs) {
  const phases = {};
  const observed = [...new Set(runs.flatMap(run => Object.keys(run.phases ?? {})))];
  for (const name of orderedPhaseNames(observed)) {
    const values = runs.map(run => run.phases?.[name]?.ms);
    if (values.some(value => Number.isFinite(value))) phases[name] = median(values);
  }
  const stages = {};
  for (const name of ['auditoriaAteResultado', 'painelComCartoes', 'resultadoAteRegistroGravado', 'relatorioCompleto', 'verificacaoGuiada', 'exportacaoQuatroFormatos']) {
    stages[name] = median(runs.map(run => run.stages?.[name]));
  }
  const models = runs.map(run => run.model).filter(Boolean);
  const model = models.length ? {
    totalMB: Number((median(models.map(row => row.totalBytes)) / 1e6).toFixed(2)),
    imagemMB: Number((median(models.map(row => row.imageBytes)) / 1e6).toFixed(2)),
    artefatos: median(models.map(row => row.artifacts)),
    nos: median(models.map(row => row.nodes)),
    ocorrencias: median(models.map(row => row.occurrences)),
  } : null;
  const panelPhases = {};
  const observedPanel = [...new Set(runs.flatMap(run => Object.keys(run.phasesPanel ?? {})))];
  for (const name of orderedPhaseNames(observedPanel)) {
    const values = runs.map(run => run.phasesPanel?.[name]?.ms);
    if (values.some(value => Number.isFinite(value))) panelPhases[name] = median(values);
  }
  const cdpTotals = new Map();
  for (const run of runs) {
    for (const [method, entry] of Object.entries(run.cdp ?? {})) {
      const rows = cdpTotals.get(method) ?? [];
      rows.push(entry);
      cdpTotals.set(method, rows);
    }
  }
  const cdp = Object.fromEntries([...cdpTotals.entries()].map(([method, rows]) => [method, {
    ms: median(rows.map(row => row.ms)), count: median(rows.map(row => row.count)),
  }]).sort((left, right) => right[1].ms - left[1].ms));
  return { phases, phasesPanel: panelPhases, stages, model, cdp, errors: runs.flatMap(run => run.errors) };
}

function printTable(aggregateByTarget, label) {
  const lines = [];
  lines.push(`\n# Medição ${label ?? ''}`.trim());
  for (const [slug, data] of Object.entries(aggregateByTarget)) {
    lines.push(`\n## ${slug}`);
    lines.push('| fase | ms |');
    lines.push('| --- | ---: |');
    for (const [name, ms] of Object.entries(data.phases)) lines.push(`| ${name} | ${ms} |`);
    if (data.phasesPanel && Object.keys(data.phasesPanel).length > 0) {
      lines.push('\n| fase (no painel) | ms |');
      lines.push('| --- | ---: |');
      for (const [name, ms] of Object.entries(data.phasesPanel)) lines.push(`| ${name} | ${ms} |`);
    }
    lines.push('');
    lines.push('| etapa (relógio de parede) | ms |');
    lines.push('| --- | ---: |');
    for (const [name, ms] of Object.entries(data.stages)) lines.push(`| ${name} | ${ms ?? '—'} |`);
    if (data.model) {
      lines.push('');
      lines.push(`modelo: ${data.model.totalMB} MB (imagem ${data.model.imagemMB} MB), ` +
        `${data.model.artefatos} evidências, ${data.model.nos} nós, ${data.model.ocorrencias} ocorrências`);
    }
    lines.push('');
    lines.push('| CDP | ms | chamadas |');
    lines.push('| --- | ---: | ---: |');
    for (const [method, entry] of Object.entries(data.cdp).slice(0, 12)) {
      lines.push(`| ${method} | ${entry.ms} | ${entry.count} |`);
    }
    if (data.errors.length) lines.push(`\nerros: ${data.errors.join(' · ')}`);
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { process.stdout.write(USAGE); return 0; }
  const outRoot = resolve(process.cwd(), options.out ?? join('qa-out', `perf-${options.label ?? ''}${timestampSlug()}`));
  await mkdir(outRoot, { recursive: true });
  const chromeBinary = resolveRealChromeTestBinary();
  if (!chromeBinary) throw new Error('AUDITA_E2E_CHROME_NAO_DEFINIDO');

  const cleanups = [];
  const host = { after: handler => cleanups.push(handler) };
  const fixture = await startFixtureServer(host, await fixtureRoutes());
  const targets = [];
  const used = new Set();
  const push = url => {
    let slug = slugify(url);
    let suffix = 2;
    while (used.has(slug)) { slug = `${slugify(url)}-${suffix}`; suffix += 1; }
    used.add(slug);
    targets.push({ url, slug });
  };
  if (options.fixture) push(`${fixture.origin}${FIXTURE_PATH}`);
  for (const url of options.urls) push(url);

  const out = { label: options.label, at: new Date().toISOString(), runs: options.runs, targets: {} };
  try {
    for (const target of targets) {
      const runs = [];
      for (let runIndex = 1; runIndex <= options.runs; runIndex += 1) {
        process.stdout.write(`→ ${target.slug} · execução ${runIndex}/${options.runs}\n`);
        // Uma página real pode bloquear, demorar ou derrubar o Chrome no meio: a campanha registra a
        // falha daquela execução e segue para a próxima, em vez de perder as medições já feitas.
        let result;
        try {
          result = await measureOnce({
            target, chromeBinary, journey: options.journey, doExport: options.export, runIndex,
          });
        } catch (error) {
          result = { url: target.url, run: runIndex, stages: {}, phases: null, phasesPanel: null, cdp: null, model: null,
            errors: [`falha de execução: ${error?.code ?? error?.message ?? 'desconhecida'}`] };
        }
        runs.push(result);
        process.stdout.write(`   tela=${result.stages.tela} resultado=${result.stages.auditoriaAteResultado} ms` +
          `${result.errors.length ? ` erros=${result.errors.join(' · ')}` : ''}\n`);
      }
      out.targets[target.slug] = { url: target.url, runs, aggregate: aggregate(runs) };
      await writeFile(join(outRoot, `${target.slug}.json`), `${JSON.stringify(out.targets[target.slug], null, 2)}\n`);
    }
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
  }
  const aggregateByTarget = Object.fromEntries(
    Object.entries(out.targets).map(([slug, value]) => [slug, value.aggregate]),
  );
  const table = printTable(aggregateByTarget, options.label);
  await writeFile(join(outRoot, 'summary.json'), `${JSON.stringify(out, null, 2)}\n`);
  await writeFile(join(outRoot, 'tabela.md'), `${table}\n`);
  process.stdout.write(`${table}\n\nSaída: ${outRoot}\n`);
  return 0;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
