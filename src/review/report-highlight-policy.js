const OCCURRENCE_ID = /^[A-Za-z0-9._:-]{1,200}$/u;

function boundedInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 && value <= 5_000 ? value : fallback;
}

export function createReportHighlightPolicy({
  requestAvailability,
  maximumKnown = 40,
  maximumQueued = 8,
} = {}) {
  if (typeof requestAvailability !== 'function') throw new TypeError('requestAvailability is required');
  const knownLimit = boundedInteger(maximumKnown, 40);
  const queueLimit = boundedInteger(maximumQueued, 8);
  const known = new Map();
  const pending = new Map();
  const queue = [];
  let pumping = false;

  function remember(occurrenceId) {
    known.delete(occurrenceId);
    known.set(occurrenceId, true);
    while (known.size > knownLimit) known.delete(known.keys().next().value);
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0) {
        const entry = queue.shift();
        let result = false;
        try {
          result = await requestAvailability(entry.occurrenceId, entry.options) === true;
        } catch { /* fail closed */ }
        pending.delete(entry.occurrenceId);
        entry.resolve(result);
      }
    } finally {
      pumping = false;
    }
  }

  function enqueue(occurrenceId, options, shouldRemember) {
    if (typeof occurrenceId !== 'string' || !OCCURRENCE_ID.test(occurrenceId)) return Promise.resolve(false);
    const existing = pending.get(occurrenceId);
    if (existing) return existing;
    if (pending.size >= queueLimit) return Promise.resolve(false);
    if (shouldRemember) remember(occurrenceId);
    let resolve;
    const result = new Promise(done => { resolve = done; });
    pending.set(occurrenceId, result);
    queue.push({ occurrenceId, options, resolve });
    void pump();
    return result;
  }

  async function recheckKnown() {
    let success = true;
    for (const occurrenceId of [...known.keys()]) {
      success = await enqueue(occurrenceId, { announce: false }, false) && success;
    }
    return success;
  }

  return Object.freeze({
    requestExplicit(occurrenceId) {
      return enqueue(occurrenceId, { announce: true }, true);
    },
    recheckKnown,
    invalidateKnown() { known.clear(); },
  });
}
