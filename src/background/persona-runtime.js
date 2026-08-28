import { createPersonaController } from './persona-controller.js';

const controllersByChromeRealm = new WeakMap();

export function getPersonaController(chromeApi, options = {}) {
  if (!chromeApi || (typeof chromeApi !== 'object' && typeof chromeApi !== 'function')) return null;
  const available = chromeApi.runtime?.getURL && chromeApi.runtime?.onConnect?.addListener &&
    chromeApi.tabs?.create && chromeApi.tabs?.get && chromeApi.scripting?.executeScript &&
    chromeApi.storage?.session && chromeApi.storage?.local;
  if (!available) return null;
  const existing = controllersByChromeRealm.get(chromeApi);
  if (existing) return existing;
  const controller = createPersonaController(chromeApi, { logger: options.logger });
  controllersByChromeRealm.set(chromeApi, controller);
  return controller;
}
