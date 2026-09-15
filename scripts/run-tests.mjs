import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_CHROME_E2E = new Set([
  'test/e2e/axe-mv3-csp.test.mjs',
  'test/e2e/batch-audit-mv3.test.mjs',
  'test/e2e/batch-pixel-consent-mv3.test.mjs',
  'test/e2e/capture-visible-element.test.mjs',
  'test/e2e/contrast-ancestor-opacity.test.mjs',
  'test/e2e/current-page-export-mv3.test.mjs',
  'test/e2e/download-uniquify-mv3.test.mjs',
  'test/e2e/field-label-review.test.mjs',
  'test/e2e/input-purpose-observation.test.mjs',
  'test/e2e/focus-observation-contract.test.mjs',
  'test/e2e/form-association-observation.test.mjs',
  'test/e2e/graphic-visibility-observation.test.mjs',
  'test/e2e/link-role-observation.test.mjs',
  'test/e2e/mhtml-state-characterization.test.mjs',
  'test/e2e/native-disabled-collector.test.mjs',
  'test/e2e/passive-target-size.test.mjs',
  'test/e2e/personas-mv3-csp.test.mjs',
  'test/e2e/public-axe-map-mv3.test.mjs',
  'test/e2e/report-executive-print.test.mjs',
  'test/e2e/report-print-layout.test.mjs',
  'test/e2e/required-field-observation.test.mjs',
  'test/e2e/retention-indexeddb-mv3.test.mjs',
  'test/e2e/sidepanel-flow-mv3.test.mjs',
  'test/e2e/text-alignment-observation.test.mjs',
  'test/e2e/text-contrast-visibility.test.mjs',
  'test/e2e/text-width-observation.test.mjs',
  'test/e2e/url-audit-mv3.test.mjs',
  'test/e2e/url-pixel-consent-mv3.test.mjs',
]);
const PROCESS_SAFE_E2E = new Set([
  'test/e2e/axe-mv3-csp-decision.test.mjs',
  'test/e2e/support/real-chrome.test.mjs',
]);

function fixed(code) {
  return Object.assign(new Error(code), { code });
}

function normalizedTestPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw fixed('TEST_PLAN_INVALID');
  return value.split(sep).join('/');
}

export function createTestPlan(files) {
  if (!Array.isArray(files)) throw fixed('TEST_PLAN_INVALID');
  const normalized = files.map(normalizedTestPath).sort();
  if (new Set(normalized).size !== normalized.length) throw fixed('TEST_PLAN_INVALID');
  const unclassified = normalized.filter(file => file.startsWith('test/e2e/') &&
    /\.test\.m?js$/u.test(file) && !REAL_CHROME_E2E.has(file) && !PROCESS_SAFE_E2E.has(file));
  if (unclassified.length) throw fixed('TEST_PLAN_UNCLASSIFIED_E2E');
  return Object.freeze({
    parallel: Object.freeze(normalized.filter(file => !REAL_CHROME_E2E.has(file))),
    serial: Object.freeze(normalized.filter(file => REAL_CHROME_E2E.has(file))),
  });
}

async function discoverTests(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await discoverTests(path, files);
    else if (entry.isFile() && /\.test\.m?js$/u.test(entry.name)) files.push(relative(workspaceRoot, path));
  }
  return files;
}

export function createNodeTestArgs(files, { serial = false } = {}) {
  if (!Array.isArray(files) || files.some(file => typeof file !== 'string' || !file)) throw fixed('TEST_PLAN_INVALID');
  return Object.freeze(['--test', ...(serial ? ['--test-concurrency=1'] : []), ...files]);
}

function runTests(files, { serial = false } = {}) {
  if (!files.length) return Promise.resolve(0);
  const args = createNodeTestArgs(files, { serial });
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, { cwd: workspaceRoot, env: process.env, shell: false, stdio: 'inherit' });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => resolvePromise(Number.isInteger(code) ? code : signal ? 1 : 0));
  });
}

async function main() {
  const plan = createTestPlan(await discoverTests(resolve(workspaceRoot, 'test')));
  const parallelStatus = await runTests(plan.parallel);
  if (parallelStatus !== 0) return parallelStatus;
  return runTests(plan.serial, { serial: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) {
    process.stderr.write(`${error?.code || 'TEST_RUNNER_FAILED'}\n`);
    process.exitCode = 1;
  }
}
