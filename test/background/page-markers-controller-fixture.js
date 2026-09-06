import assert from 'node:assert/strict';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { createHighlightModelAuthority } from '../../src/background/highlight-model-authority.js';
import { AUDIT_EXECUTION_INTERNAL } from '../../src/background/chrome-adapter.js';
import { createPageMarkerOriginCache } from '../../src/background/page-marker-origin-cache.js';
import { createTargetOperationQueue } from '../../src/background/target-operation-queue.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { runAuditaPageMarkersCommand } from '../../src/browser/page-markers-overlay.js';
import { createPageMarkersFixture } from '../highlight/page-markers-fixture.js';
import { createPageMarkersController } from '../../src/background/page-markers-controller.js';

export const INSTALLATION_ID = 'I'.repeat(22);
export const SESSION_ID = 'S'.repeat(22);
export const DIGEST = `hmac-sha256:${'D'.repeat(43)}`;

class EventHook {
  constructor() { this.listeners = new Set(); }
  addListener(listener) { this.listeners.add(listener); }
  removeListener(listener) { this.listeners.delete(listener); }
  emit(...args) { for (const listener of [...this.listeners]) listener(...args); }
}

export function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}

export async function createControllerFixture(options = {}) {
  let time = options.time ?? 10_000;
  const draft = structuredClone(SAMPLE_AUDIT);
  if (typeof options.changeDraft === 'function') options.changeDraft(draft);
  const model = await enrichAuditForReport(draft, {
    now: () => '2026-08-29T12:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '1.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/152.0.0.0',
  });
  const snapshot = { model, modelRevision: 7, modelHash: model.integrity.canonicalModelHash };
  const auditStore = {
    async getAuditSnapshot() {
      if (options.modelGate) await options.modelGate.promise;
      if (options.modelSnapshot) return options.modelSnapshot;
      return { model: structuredClone(model), revision: 7, capability: null };
    },
  };
  const modelAuthority = createHighlightModelAuthority({ auditStore });
  const originCache = createPageMarkerOriginCache({ now: () => time });
  originCache.register({
    auditId: model.auditId, tabId: 17, windowId: 9, documentId: 'document-a',
    urlSessionDigest: DIGEST, createdAt: time, expiresAt: time + 60_000,
  });
  if (options.noOrigin) originCache.clearAudit(model.auditId);
  const detailIds = model.occurrences.map(row => row.occurrenceId).sort((a, b) => a.localeCompare(b));
  const bundle = {
    version: 1, auditId: model.auditId, modelRevision: 7, modelHash: snapshot.modelHash,
    summary: { alreadyValidated: true },
    details: detailIds.map(occurrenceId => ({ occurrenceId })),
  };
  const page = createPageMarkersFixture();
  page.first.setAttribute('id', 'continuar');
  const proof = () => ({ tabId: 17, windowId: 9, documentId: 'document-a', urlSessionDigest: DIGEST });
  const proofQueue = [...(options.proofs ?? [])];
  const calls = { authorize: [], probe: [], source: [], scripts: [], publish: [] };
  const timers = new Map();
  let nextTimer = 1;
  let controller;
  let latestPort = null;

  function nativePort(installationId = INSTALLATION_ID, senderOverrides = {}) {
    const port = {
      name: 'audita-page-markers-v1',
      sender: {
        id: 'extension-id', documentId: 'document-a', frameId: 0,
        tab: { id: 17, windowId: 9 }, ...senderOverrides,
      },
      onMessage: new EventHook(), onDisconnect: new EventHook(), disconnected: 0,
      disconnect() { this.disconnected += 1; this.onDisconnect.emit(); },
    };
    port.hello = () => port.onMessage.emit({ type: 'AUDITA_PAGE_MARKERS_HELLO', installationId });
    port.ping = () => port.onMessage.emit({ type: 'AUDITA_PAGE_MARKERS_PING', installationId });
    latestPort = port;
    return port;
  }

  const chromeApi = {
    runtime: { id: 'extension-id' },
    scripting: {
      async executeScript(request) {
        calls.scripts.push(request);
        assert.deepEqual(request.target, { tabId: 17, documentIds: ['document-a'] });
        assert.equal(request.world, 'ISOLATED');
        if (options.scriptPause?.when(request, calls.scripts.length)) {
          options.scriptPause.entered.resolve();
          await options.scriptPause.release.promise;
        }
        if (options.scriptFailure?.(request, calls.scripts.length)) throw new Error('script unavailable');
        const name = request.func.name;
        if (name === 'runAuditaPageMarkersCommand') {
          const result = runAuditaPageMarkersCommand(request.args[0], page.environment);
          return [{ frameId: 0, documentId: 'document-a', result }];
        }
        if (name === 'bindAuditaPageMarkersPort') {
          const port = nativePort(request.args[0]);
          assert.equal(controller.attachPort(port), true);
          if (options.autoHello !== false) queueMicrotask(() => port.hello());
          return [{ frameId: 0, documentId: 'document-a', result: { ok: true } }];
        }
        const isolated = (0, eval)(`(${request.func.toString()})`);
        return [{ frameId: 0, documentId: 'document-a', result: isolated(request.args[0], page.environment) }];
      },
    },
  };
  const session = {
    version: 1, sessionCapabilityId: SESSION_ID, auditId: model.auditId, windowId: 9,
    mode: 'attached', targetBinding: { kind: 'attached' }, state: 'result', issuedAt: time - 1,
    expiresAt: time + 60_000,
  };
  const authority = {
    async authorizeSession(request) {
      calls.authorize.push(structuredClone(request));
      if (options.authorizationGate) await options.authorizationGate.promise;
      if (options.authorized === false) return { ok: false, code: 'SESSION_DENIED' };
      return { ok: true, session: structuredClone(options.session ?? session), context: { windowId: 9 } };
    },
  };
  const chromeAdapter = {
    async probeDocumentIdentity(tabId) {
      calls.probe.push(tabId);
      if (options.probePause?.call === calls.probe.length) {
        options.probePause.entered.resolve();
        await options.probePause.release.promise;
      }
      const next = proofQueue.length ? proofQueue.shift() : proof();
      if (next instanceof Error) throw next;
      return structuredClone(next);
    },
  };
  const adapterInternal = {
    async snapshotAttachedCopySource(givenProof) {
      calls.source.push(structuredClone(givenProof));
      if (options.sourceFailure) throw new Error('source unavailable');
      return structuredClone(options.source ?? {
        version: 'AttachedCopySourceV1', ...proof(), rawUrl: `${model.pages[0].finalUrl}?secret=redacted`,
      });
    },
  };
  Object.defineProperty(chromeAdapter, AUDIT_EXECUTION_INTERNAL, {
    value: Object.freeze(adapterInternal), enumerable: false, configurable: false, writable: false,
  });
  controller = createPageMarkersController({
    originCache, modelAuthority,
    loadPanelResultBundle: async ({ auditId }) => {
      assert.equal(auditId, model.auditId);
      return structuredClone(options.bundle ?? bundle);
    },
    authority, chromeApi, chromeAdapter, targetQueue: createTargetOperationQueue(),
    now: () => time, createInstallationId: () => INSTALLATION_ID,
    publish: async message => { calls.publish.push(structuredClone(message)); },
    setTimer(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
  });

  const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/src/panel/index.html', documentId: 'panel-document' };
  function envelope(type, extra = {}) {
    return { type, auditId: model.auditId, sessionCapabilityId: SESSION_ID,
      windowId: 9, modelRevision: 7, ...extra };
  }
  async function dispatch(type, extra = {}, privateOptions = {}) {
    return controller.dispatch({ envelope: envelope(type, extra), sender,
      panelWindowId: privateOptions.panelWindowId ?? 9,
      isCurrent: privateOptions.isCurrent ?? (() => true) });
  }
  return {
    controller, model, snapshot, bundle, originCache, page, calls, sender, envelope, dispatch,
    nativePort, latestPort: () => latestPort, setTime(value) { time = value; },
    queueProof(value) { proofQueue.push(value); },
    fireTimer(delay) {
      const entry = [...timers].find(([, value]) => value.delay === delay);
      assert.ok(entry, `timer ${delay} expected`);
      timers.delete(entry[0]); entry[1].callback();
    },
    timerDelays: () => [...timers.values()].map(value => value.delay),
  };
}
