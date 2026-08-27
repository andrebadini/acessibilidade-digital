const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

export function decideAxeE2eExecution({ gate, chromeBinary }) {
  const enabled = gate?.enabled === true;
  const targetSizeEnabled = gate?.targetSizeEnabled === true;
  if (enabled !== targetSizeEnabled) return { action: 'fail', code: 'AXE_MV3_CSP_GATE_INCONSISTENT' };
  if (!enabled) {
    const code = typeof gate?.code === 'string' && SAFE_CODE.test(gate.code) ? gate.code : 'AXE_MV3_CSP_E2E_DISABLED';
    return { action: 'skip', code };
  }
  if (typeof chromeBinary !== 'string' || chromeBinary.trim() === '') {
    return { action: 'fail', code: 'AXE_MV3_CSP_BROWSER_REQUIRED' };
  }
  return { action: 'run', code: 'AXE_MV3_CSP_E2E_REQUIRED' };
}
