import assert from 'node:assert/strict';
import { chmod, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  launchUnpackedExtension,
  resolveRealChromeTestBinary,
  startFixtureServer,
} from './support/real-chrome.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const chromeBinary = resolveRealChromeTestBinary();

// Reproduz o caso real em que o Chrome recebe os bytes, mas a pasta de downloads recusa a
// gravação: a entrada fica `interrupted/USER_CANCELED` com `filename:""` e `exists:true`.
// Antes, essa forma não era reconhecida como "nada foi escrito", a limpeza ficava pendente
// para sempre e a exportação abortava no primeiro formato — a aba ficava aberta sem arquivo.
// Aqui o adaptador real do Chrome prova que a limpeza é confirmada e que os formatos seguintes
// continuam sendo tentados.
test('a download refused by the destination folder is cleaned and does not abort the next format', {
  timeout: 180_000,
  skip: process.platform === 'win32' ? 'permissões de pasta POSIX' : false,
}, async t => {
  assert.ok(chromeBinary, 'AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório para o E2E real.');
  const server = await startFixtureServer(t, new Map([['/', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: '<!doctype html><html lang="pt-BR"><title>Pasta de downloads recusada</title></html>',
  }]]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(root),
    startUrl: `${server.origin}/`,
    chromeBinary,
    expectedMajor: 152,
    downloadMode: 'profile',
    viewport: { width: 1280, height: 900 },
  });
  await chmod(extension.downloadDirectory, 0o500);
  t.after(async () => { await chmod(extension.downloadDirectory, 0o700).catch(() => {}); });

  const proof = await extension.evaluate(extension.harnessPage, `(async()=>{
    const {createDownloadsAdapter,downloadArtifacts}=await import(chrome.runtime.getURL('/src/browser/download-artifacts.js'));
    const journal=[];
    let result=null; let failure=null;
    try {
      result=await downloadArtifacts({
        baseName:'audita-folder-refused-20260830T120000000Z',
        html:'<!doctype html><html lang="pt-BR"><title>Recusado</title></html>',
        csv:'\\uFEFF"id"\\r\\n"1"\\r\\n',
      }, createDownloadsAdapter(chrome), {
        timeoutMs: 4000,
        recordDeliveryState: async entry => { journal.push(entry); return true; },
      });
    } catch (error) {
      failure={ name:String(error?.name??''), code:String(error?.code??''), message:String(error?.message??'') };
    }
    return {
      failure,
      formats: result ? result.formats.map(entry => ({
        format: entry.format, status: entry.status, failureCode: entry.failureCode ?? null,
      })) : [],
      journal,
      history: (await chrome.downloads.search({})).map(entry => ({
        state: entry.state, error: entry.error ?? null, filename: entry.filename, exists: entry.exists,
      })),
    };
  })()`, { awaitPromise: true });
  assert.equal(proof.failure, null, `a exportação não pode terminar em limpeza pendente: ${JSON.stringify(proof)}`);

  assert.deepEqual(proof.formats, [
    { format: 'html', status: 'timeout', failureCode: 'DOWNLOAD_WAIT_TIMEOUT' },
    { format: 'csv', status: 'timeout', failureCode: 'DOWNLOAD_WAIT_TIMEOUT' },
  ], 'a falha precisa ser contida por formato e o CSV seguinte precisa ser tentado');
  for (const format of ['html', 'csv']) {
    const entries = proof.journal.filter(entry => entry.format === format);
    assert.equal(entries.at(-1)?.state, 'cleaned',
      `${format}: a limpeza física precisa ser confirmada, sem deixar journal pendente`);
    assert.equal(entries.some(entry => entry.state === 'cleanup-failed'), false,
      `${format}: nenhuma entrada pode ficar em cleanup-failed`);
  }
  assert.deepEqual(proof.history, [],
    'as entradas sem destino não podem deixar histórico residual no Chrome');
});
