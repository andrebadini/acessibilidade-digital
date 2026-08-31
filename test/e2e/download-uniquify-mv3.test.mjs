import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_CHROME_PRODUCT,
  launchUnpackedExtension,
  resolveRealChromeTestBinary,
  startFixtureServer,
} from './support/real-chrome.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const chromeBinary = resolveRealChromeTestBinary();

test('records the exact Chrome-uniquified filename by download id in real MV3', { timeout: 120_000 }, async t => {
  assert.ok(chromeBinary, 'AUDITA_E2E_CHROME ou CHROME_BIN é obrigatório para o E2E real.');
  await access(chromeBinary, fsConstants.X_OK);
  const server = await startFixtureServer(t, new Map([['/', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: '<!doctype html><title>Audita download</title>',
  }]]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(root),
    startUrl: `${server.origin}/`,
    chromeBinary,
    expectedMajor: 152,
    downloadMode: 'profile',
    viewport: { width: 1024, height: 720 },
  });
  assert.equal(extension.chromeProduct, CANONICAL_CHROME_PRODUCT);

  const baseName = 'audita-conflict-proof-20260830T120000000Z';
  const requestedFilename = `${baseName}.html`;
  const actualFilename = `${baseName} (1).html`;
  const originalBytes = 'PREEXISTING_FILE_MUST_REMAIN';
  const downloadedBytes = '<!doctype html><title>Downloaded evidence</title>';
  await writeFile(join(extension.downloadDirectory, requestedFilename), originalBytes, { flag: 'wx' });

  const proof = await extension.evaluate(extension.harnessPage, `(async()=>{
    const {createDownloadsAdapter,downloadArtifacts}=await import(chrome.runtime.getURL('/src/browser/download-artifacts.js'));
    const journal=[];
    const result=await downloadArtifacts({baseName:${JSON.stringify(baseName)},html:${JSON.stringify(downloadedBytes)}},
      createDownloadsAdapter(chrome),{timeoutMs:30000,recordDeliveryState:async entry=>journal.push(entry)});
    const artifact=result.formats[0];
    const items=await chrome.downloads.search({id:artifact.downloadId});
    return {
      artifact,
      journal,
      historyFilename:String(items[0]?.filename||'').split(/[\\\\/]/u).at(-1),
    };
  })()`, { awaitPromise: true });

  assert.equal(proof.artifact.status, 'complete', JSON.stringify(proof));
  assert.equal(proof.artifact.filename, actualFilename);
  assert.equal(proof.historyFilename, actualFilename);
  assert.deepEqual(proof.journal.map(entry => ({
    state: entry.state,
    filename: entry.filename,
    requestedFilename: entry.requestedFilename ?? null,
    downloadId: entry.downloadId ?? null,
  })), [
    { state: 'starting', filename: requestedFilename, requestedFilename: null, downloadId: null },
    { state: 'in-flight', filename: requestedFilename, requestedFilename: null, downloadId: proof.artifact.downloadId },
    { state: 'identified', filename: actualFilename, requestedFilename, downloadId: proof.artifact.downloadId },
    { state: 'terminal', filename: actualFilename, requestedFilename: null, downloadId: proof.artifact.downloadId },
  ]);
  assert.equal(await readFile(join(extension.downloadDirectory, requestedFilename), 'utf8'), originalBytes);
  assert.equal(await readFile(join(extension.downloadDirectory, actualFilename), 'utf8'), downloadedBytes);
});
