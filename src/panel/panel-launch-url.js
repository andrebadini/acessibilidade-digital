const EXTENSION_ID = /^[a-p]{32}$/u;
const PANEL_LAUNCH_TOKEN = /^[A-Za-z0-9_-]{43}$/u;

export function isAuthorizedPanelLaunchUrl(href, runtimeId) {
  if (typeof href !== 'string' || href.length === 0 || href.length > 2048 ||
    typeof runtimeId !== 'string' || !EXTENSION_ID.test(runtimeId)) return false;
  try {
    const url = new URL(href);
    return url.protocol === 'chrome-extension:' &&
      url.hostname === runtimeId &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/src/panel/index.html' &&
      url.hash === '' &&
      url.searchParams.size === 1 &&
      url.searchParams.getAll('launch').length === 1 &&
      PANEL_LAUNCH_TOKEN.test(url.searchParams.get('launch') ?? '');
  } catch {
    return false;
  }
}
