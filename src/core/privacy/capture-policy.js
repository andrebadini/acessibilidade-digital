const POLICY_KEYS = Object.freeze(['mode', 'includeQuery']);
const MODES = Object.freeze({
  'full-evidence': Object.freeze([true, true, true]),
  'element-only': Object.freeze([false, true, false]),
  'no-pixels': Object.freeze([false, false, false]),
});

function captureExact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || keys.some(key => !ownKeys.includes(key))) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

export function createCapturePolicyV1(input) {
  const captured = captureExact(input, POLICY_KEYS);
  if (!captured) throw new TypeError('CAPTURE_POLICY_INVALID');
  const { mode, includeQuery } = captured;
  const flags = MODES[mode];
  if (!flags || typeof includeQuery !== 'boolean') throw new TypeError('CAPTURE_POLICY_INVALID');
  return Object.freeze({
    version: 'CapturePolicyV1', mode, includeQuery,
    captureFullPage: flags[0], captureElements: flags[1], composeAnnouncementMap: flags[2],
  });
}

export function isCapturePolicyV1(value) {
  try {
    const captured = captureExact(value, ['version', 'mode', 'includeQuery', 'captureFullPage', 'captureElements', 'composeAnnouncementMap']);
    if (!captured) return false;
    const expected = createCapturePolicyV1({ mode: captured.mode, includeQuery: captured.includeQuery });
    return Object.keys(expected).every(key => captured[key] === expected[key]);
  } catch {
    return false;
  }
}
