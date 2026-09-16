import { createHash } from 'node:crypto';
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertReportCssHashConsistent } from './report-css-hash.mjs';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const cli = process.argv.slice(2);
const usesTemporaryReleaseDirectory = cli.length !== 0;
const releaseDirectory = usesTemporaryReleaseDirectory
  ? await resolveTemporaryReleaseDirectory(cli)
  : join(root, 'release');
const output = resolveReleaseOutput(releaseDirectory, manifest.version);
if (!usesTemporaryReleaseDirectory) await mkdir(releaseDirectory, { recursive: true });
await validateCanonicalReleaseDirectory(releaseDirectory);
const staging = await mkdtemp(join(tmpdir(), 'audita-mt-release-'));
const releaseTimestamp = new Date('2026-08-27T00:00:00.000Z');

try {
  await cp(join(root, 'manifest.json'), join(staging, 'manifest.json'));
  await cp(join(root, 'src'), join(staging, 'src'), { recursive: true });
  // O CSS que vai no pacote precisa bater com o hash declarado: com hash obsoleto o navegador bloqueia
  // o <style> pela CSP e o relatório entregue sai sem estilo, em silêncio (Minor 6 / V9).
  const stagedCss = await import(pathToFileURL(join(staging, 'src/core/report/report.css.js')).href);
  assertReportCssHashConsistent(stagedCss.REPORT_CSS, stagedCss.REPORT_CSS_CSP_HASH);
  await cp(join(root, 'vendor'), join(staging, 'vendor'), { recursive: true });
  await mkdir(join(staging, 'assets', 'icons'), { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    await cp(join(root, 'assets', 'icons', `icon-${size}.png`), join(staging, 'assets', 'icons', `icon-${size}.png`));
  }
  const discovered = await runtimeFiles(staging);
  const files = ['manifest.json', ...discovered.filter(path => path !== 'manifest.json')];
  for (const path of files) await utimes(join(staging, path), releaseTimestamp, releaseTimestamp);
  await validateCanonicalReleaseDirectory(releaseDirectory);
  await rm(output, { force: true });
  await validateCanonicalReleaseDirectory(releaseDirectory);
  const zip = spawnSync('zip', ['-X', '-q', output, ...files], {
    cwd: staging, encoding: 'utf8', env: { ...process.env, TZ: 'UTC' },
  });
  if (zip.status !== 0) throw new Error(zip.stderr || zip.stdout || 'Falha ao gerar o ZIP.');
  const bytes = await readFile(output);
  const digest = createHash('sha256').update(bytes).digest('hex');
  console.log(`${basename(output)}\nSHA-256 ${digest}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}

async function runtimeFiles(directory, prefix = '') {
  const files = [];
  for (const entry of (await readdir(join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const relative = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await runtimeFiles(directory, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort((a, b) => a.localeCompare(b, 'en'));
}

async function resolveTemporaryReleaseDirectory(args) {
  if (args.length !== 2 || args[0] !== '--temporary-release-directory' || args[1].length === 0) {
    throw new Error('Argumentos inválidos para o diretório temporário de release.');
  }
  return validateTemporaryReleaseDirectory(args[1]);
}

async function validateTemporaryReleaseDirectory(candidate) {
  if (!isAbsolute(candidate) || resolve(candidate) !== candidate
      || !/^audita-release-test-[A-Za-z0-9]{6}$/u.test(basename(candidate))) {
    throw new Error('Diretório temporário de release inválido.');
  }
  const [temporaryRoot, candidateParent, entry] = await Promise.all([
    realpath(tmpdir()),
    realpath(dirname(candidate)),
    lstat(candidate),
  ]);
  if (candidateParent !== temporaryRoot || !entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('Diretório temporário de release inseguro.');
  }
  const canonicalCandidate = await realpath(candidate);
  if (dirname(canonicalCandidate) !== temporaryRoot || basename(canonicalCandidate) !== basename(candidate)) {
    throw new Error('Diretório temporário de release inseguro.');
  }
  return canonicalCandidate;
}

async function validateCanonicalReleaseDirectory(candidate) {
  if (!isAbsolute(candidate) || resolve(candidate) !== candidate) {
    throw new Error('Diretório de release não canônico.');
  }
  const entry = await lstat(candidate);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('Diretório de release inseguro.');
  }
  const canonicalCandidate = await realpath(candidate);
  if (canonicalCandidate !== candidate) throw new Error('Diretório de release inseguro.');
  return canonicalCandidate;
}

function resolveReleaseOutput(releaseDirectory, version) {
  const safeVersion = validateChromeVersion(version);
  const canonicalReleaseDirectory = resolve(releaseDirectory);
  if (!isAbsolute(releaseDirectory) || canonicalReleaseDirectory !== releaseDirectory) {
    throw new Error('Diretório de release não canônico.');
  }
  const expectedBasename = `audita-acessibilidade-${safeVersion}.zip`;
  const output = resolve(canonicalReleaseDirectory, expectedBasename);
  if (dirname(resolve(output)) !== canonicalReleaseDirectory || basename(output) !== expectedBasename) {
    throw new Error('Caminho de saída do release escapou do diretório autorizado.');
  }
  return output;
}

function validateChromeVersion(version) {
  if (typeof version !== 'string') throw new Error('Versão do manifesto inválida.');
  const components = version.split('.');
  if (components.length < 1 || components.length > 4) throw new Error('Versão do manifesto inválida.');
  const values = components.map(component => {
    const hasOnlyAsciiDigits = component.length > 0
      && [...component].every(character => character >= '0' && character <= '9');
    if (!hasOnlyAsciiDigits || component.length > 5 || (component.length > 1 && component.startsWith('0'))) {
      throw new Error('Versão do manifesto inválida.');
    }
    const value = Number(component);
    if (!Number.isSafeInteger(value) || value > 65_535) throw new Error('Versão do manifesto inválida.');
    return value;
  });
  if (values.every(value => value === 0)) throw new Error('Versão do manifesto inválida.');
  return version;
}
