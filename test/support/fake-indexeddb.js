const clone = value => structuredClone(value);

export function createFakeIndexedDb() {
  const databases = new Map();

  function createTransaction(database, mode, onRelease = () => {}, initiallyActive = true) {
    let active = initiallyActive;
    let aborted = false;
    let finished = false;
    let pending = 0;
    const scheduled = [];
    const tx = {
      mode,
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore(name) {
        const records = database.stores.get(name);
        if (!records) throw new Error(`Unknown object store: ${name}`);
        const request = operation => {
          const result = { result: undefined, error: null, onsuccess: null, onerror: null };
          pending += 1;
          schedule(() => {
            if (aborted) return end();
            try {
              result.result = operation(records);
              result.onsuccess?.({ target: result });
            } catch (error) {
              result.error = error;
              tx.error = error;
              result.onerror?.({ target: result });
              tx.abort();
            } finally {
              end();
            }
          });
          return result;
        };
        return {
          get(key) { return request(values => clone(values.get(key))); },
          put(value, key) {
            if (mode !== 'readwrite') throw new Error('Read-only transaction');
            return request(values => { values.set(key, clone(value)); return key; });
          },
          delete(key) {
            if (mode !== 'readwrite') throw new Error('Read-only transaction');
            return request(values => values.delete(key));
          },
        };
      },
      abort() {
        if (finished || aborted) return;
        aborted = true;
        queueMicrotask(() => finish('abort'));
      },
      _activate() {
        active = true;
        for (const task of scheduled.splice(0)) queueMicrotask(task);
        maybeComplete();
      },
    };
    const schedule = task => active ? queueMicrotask(task) : scheduled.push(task);
    const end = () => { pending -= 1; maybeComplete(); };
    const maybeComplete = () => {
      if (!active || aborted || finished || pending !== 0) return;
      queueMicrotask(() => {
        if (!active || aborted || finished || pending !== 0) return;
        finish('complete');
      });
    };
    const finish = kind => {
      if (finished) return;
      finished = true;
      onRelease();
      if (kind === 'complete') tx.oncomplete?.();
      else tx.onabort?.();
    };
    maybeComplete();
    return tx;
  }

  function databaseHandle(record) {
    return {
      objectStoreNames: { contains: name => record.stores.has(name) },
      createObjectStore(name) {
        if (record.stores.has(name)) throw new Error('Object store exists');
        record.stores.set(name, new Map());
        return {};
      },
      transaction(storeName, mode) {
        const names = Array.isArray(storeName) ? storeName : [storeName];
        if (names.length !== 1 || !record.stores.has(names[0])) throw new Error('Unknown store');
        if (mode !== 'readwrite') return createTransaction(record, mode);
        const wasActive = record.writeActive;
        const tx = createTransaction(record, mode, () => {
          const next = record.writeQueue.shift();
          if (next) next._activate();
          else record.writeActive = false;
        }, !wasActive);
        if (wasActive) record.writeQueue.push(tx);
        else record.writeActive = true;
        return tx;
      },
      close() {},
      onversionchange: null,
    };
  }

  const factory = {
    open(name, requestedVersion = 1) {
      const request = {
        result: null, transaction: null, error: null,
        onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null,
      };
      queueMicrotask(() => {
        let record = databases.get(name);
        const oldVersion = record?.version ?? 0;
        if (record && requestedVersion < record.version) {
          request.error = new Error('VersionError');
          request.onerror?.({ target: request });
          return;
        }
        if (!record) {
          record = { version: 0, stores: new Map(), writeActive: false, writeQueue: [] };
          databases.set(name, record);
        }
        const db = databaseHandle(record);
        request.result = db;
        if (requestedVersion > oldVersion) {
          request.transaction = { abort() {}, error: null };
          request.onupgradeneeded?.({ oldVersion, newVersion: requestedVersion });
          record.version = requestedVersion;
        }
        request.onsuccess?.({ target: request });
      });
      return request;
    },
    inspect(databaseName, storeName, key) {
      return clone(databases.get(databaseName)?.stores.get(storeName)?.get(key));
    },
    replace(databaseName, storeName, key, value) {
      databases.get(databaseName).stores.get(storeName).set(key, clone(value));
    },
  };
  return factory;
}
