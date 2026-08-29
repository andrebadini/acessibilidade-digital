import { resolveAxeGateState } from '../src/browser/axe-adapter.js';

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

export function decideAxeE2eExecution({ gate, chromeBinary }) {
  let state;
  try {
    state = resolveAxeGateState(gate);
  } catch (error) {
    return { action: 'fail', code: error?.code === 'AXE_MV3_CSP_GATE_INCONSISTENT' ? error.code : 'AXE_MV3_CSP_GATE_INVALID' };
  }
  if (typeof chromeBinary !== 'string' || chromeBinary.trim() === '') {
    if (state !== 'disabled') return { action: 'fail', code: 'AXE_MV3_CSP_BROWSER_REQUIRED' };
    const code = typeof gate?.code === 'string' && SAFE_CODE.test(gate.code) ? gate.code : 'AXE_MV3_CSP_E2E_DISABLED';
    return { action: 'skip', code };
  }
  return { action: 'run', code: 'AXE_MV3_CSP_E2E_REQUIRED' };
}
