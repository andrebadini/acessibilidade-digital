export function createFakeLockManager() {
  const tails = new Map();
  const calls = [];

  function request(name, options, callback) {
    calls.push(Object.freeze({ name, options: structuredClone(options) }));
    const predecessor = tails.get(name) ?? Promise.resolve();
    const execute = () => callback(Object.freeze({ name, mode: options?.mode }));
    const result = predecessor.then(execute, execute);
    const tail = result.then(() => undefined, () => undefined);
    tails.set(name, tail);
    void tail.finally(() => {
      if (tails.get(name) === tail) tails.delete(name);
    });
    return result;
  }

  return Object.freeze({ request, calls });
}
