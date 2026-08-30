const START_METHODS = Object.freeze(['start', 'rehydrate']);
const COORDINATOR_METHODS = Object.freeze([
  'setMode', 'stop', 'invalidateTab', 'invalidateWindow', 'recover', 'expireDue',
]);

export function createPersonaController(value = {}) {
  const dependencies = readDependencies(value);
  const personaStart = dependencies?.personaStart;
  const personaCoordinator = dependencies?.personaCoordinator;
  if (!personaStart || START_METHODS.some(name => !hasOwnCallable(personaStart, name)) ||
    !personaCoordinator || COORDINATOR_METHODS.some(name => !hasOwnCallable(personaCoordinator, name))) {
    throw new TypeError('PERSONA_CONTROLLER_INVALID');
  }

  return Object.freeze({
    start: value => personaStart.start(value),
    rehydrate: value => personaStart.rehydrate(value),
    setMode: value => personaCoordinator.setMode(value),
    stop: value => personaCoordinator.stop(value),
    invalidateTab: (tabId, reason) => personaCoordinator.invalidateTab(tabId, reason),
    invalidateWindow: (windowId, reason) => personaCoordinator.invalidateWindow(windowId, reason),
    recover: () => personaCoordinator.recover(),
    expireDue: () => personaCoordinator.expireDue(),
  });
}

function readDependencies(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes('personaStart') || !keys.includes('personaCoordinator')) return null;
    const start = Object.getOwnPropertyDescriptor(value, 'personaStart');
    const coordinator = Object.getOwnPropertyDescriptor(value, 'personaCoordinator');
    if (!start?.enumerable || !Object.hasOwn(start, 'value') ||
      !coordinator?.enumerable || !Object.hasOwn(coordinator, 'value')) return null;
    return { personaStart: start.value, personaCoordinator: coordinator.value };
  } catch {
    return null;
  }
}

function hasOwnCallable(value, name) {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return Boolean(descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function');
  } catch {
    return false;
  }
}
