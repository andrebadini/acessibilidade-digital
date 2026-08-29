const POLICY_KEYS = Object.freeze(['mode', 'includeQuery']);
const MODES = Object.freeze({
  'full-evidence': Object.freeze([true, true, true]),
  'element-only': Object.freeze([false, true, false]),
  'no-pixels': Object.freeze([false, false, false]),
});

function ownData(value, key) {
  try {
    const descriptor = value && typeof value === 'object'
      ? Object.getOwnPropertyDescriptor(value, key)
      : null;
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function createCapturePolicyV1(input) {
  let keys;
  try { keys = Reflect.ownKeys(input); } catch { keys = []; }
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    keys.length !== POLICY_KEYS.length || POLICY_KEYS.some(key => !keys.includes(key))) {
    throw new TypeError('CAPTURE_POLICY_INVALID');
  }
  const mode = ownData(input, 'mode');
  const includeQuery = ownData(input, 'includeQuery');
  const flags = MODES[mode];
  if (!flags || typeof includeQuery !== 'boolean') throw new TypeError('CAPTURE_POLICY_INVALID');
  return Object.freeze({
    version: 'CapturePolicyV1', mode, includeQuery,
    captureFullPage: flags[0], captureElements: flags[1], composeAnnouncementMap: flags[2],
  });
}

export function isCapturePolicyV1(value) {
  try {
    const expected = createCapturePolicyV1({ mode: ownData(value, 'mode'), includeQuery: ownData(value, 'includeQuery') });
    const keys = Reflect.ownKeys(value);
    return keys.length === 6 && Object.keys(expected).every(key => ownData(value, key) === expected[key]);
  } catch {
    return false;
  }
}
