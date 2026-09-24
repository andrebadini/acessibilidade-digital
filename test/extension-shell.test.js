import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const readWorkspaceFile = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('declares a minimal MV3 extension shell without remote executable code', async () => {
  const manifest = JSON.parse(await readWorkspaceFile('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, '116', 'sidePanel.open e runtime.getContexts exigem Chrome 116+');
  assert.equal(manifest.version, '1.1.52');
  assert.equal(manifest.version_name, '1.1.52');
  assert.equal(manifest.description, 'Auditoria independente de acessibilidade de páginas web.');
  assert.deepEqual(manifest.icons, {
    16: 'assets/icons/icon-16.png',
    32: 'assets/icons/icon-32.png',
    48: 'assets/icons/icon-48.png',
    128: 'assets/icons/icon-128.png',
  });
  assert.deepEqual(manifest.permissions, [
    'alarms', 'contextMenus', 'debugger', 'downloads', 'scripting', 'sidePanel', 'storage', 'tabs',
  ]);
  assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*']);
  assert.deepEqual(manifest.background, {
    service_worker: 'src/background/service-worker.js',
    type: 'module',
  });
  assert.deepEqual(manifest.action.default_icon, manifest.icons);
  assert.equal(manifest.action.default_title, 'Abrir Audita Acessibilidade');
  assert.equal(Object.hasOwn(manifest.action, 'default_popup'), false);
  assert.deepEqual(manifest.side_panel, { default_path: 'src/panel/index.html' });
  assert.deepEqual(manifest.commands, {
    _execute_action: {
      suggested_key: { default: 'Alt+Shift+A', mac: 'MacCtrl+Shift+A' },
      description: 'Abrir Audita Acessibilidade',
    },
  });
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.content_security_policy.extension_pages,
    "script-src 'self'; object-src 'none'; img-src 'self' data: blob:; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'");
});

test('shipped extension has no popup surface or popup-only protocol', async () => {
  const forbidden = /src\/popup\/index\.html|PREPARE_POPUP_CAPABILITIES|POPUP_START_AUDIT|POPUP_START_PERSONA|POPUP_SURFACE|openActionPopup/u;
  const visit = async path => {
    const entries = await readdir(new URL(`../${path}`, import.meta.url), { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) files.push(...await visit(child));
      else files.push(child);
    }
    return files;
  };
  const shippedFiles = ['manifest.json', ...await visit('src')];
  for (const path of shippedFiles) {
    const source = await readWorkspaceFile(path);
    assert.doesNotMatch(source, forbidden, path);
  }
});

test('panel is an accessible local four-state mount with no popup or legacy URL surface', async () => {
  const html = await readWorkspaceFile('src/panel/index.html');
  assert.equal((html.match(/<h1\b/gi) ?? []).length, 1);
  assert.match(html, /<main[^>]+id="panel-root"[^>]+tabindex="-1"/iu);
  assert.doesNotMatch(html, /<form\b|<input\b|<textarea\b|audit-url|audit-urls|prefill/iu);
  assert.doesNotMatch(html, /speechSynthesis|audita-persona-v1/iu);
  assert.doesNotMatch(html, /<script(?![^>]+src=)/i);
  assert.doesNotMatch(html, /<style\b|\sstyle=/i);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)="https?:\/\//i);
});

test('panel module renders the local lifecycle without a bearer or legacy side-panel runtime', async () => {
  const [source, view] = await Promise.all([
    readWorkspaceFile('src/panel/panel.js'),
    readWorkspaceFile('src/panel/panel-view.js'),
  ]);
  assert.match(source, /createPanelSessionPortClient/);
  assert.match(source, /sessionPortClient\.start\(\)/u);
  assert.match(source, /PREPARE_PANEL_CAPABILITY/u);
  assert.match(source, /PANEL_START_ATTACHED_AUDIT/u);
  assert.match(source, /PANEL_REHYDRATE_VIEW/u);
  assert.match(source, /requestIntent/u);
  assert.doesNotMatch(source, /runtime\.sendMessage/u);
  assert.match(view, /initial|running|result|unavailable/u);
  assert.match(view, /Lote de páginas/u);
  assert.doesNotMatch(view, /Não disponível nesta beta/u);
  assert.doesNotMatch(`${source}\n${view}`, /innerHTML/);
  assert.doesNotMatch(source, /START_AUDIT|AUDIT_CONTEXT_PREFILL|GET_LAST_AUDIT/u);
  assert.doesNotMatch(source, /speechSynthesis|audita-persona-v1|window\.open|default_popup/u);
  assert.doesNotMatch(`${source}\n${view}`, /sessionCapabilityId/u);
});

test('packages persona runtimes as local classic files without broadening the MV3 shell', async () => {
  const [manifestSource, buildSource, runtime, reader, content, css] = await Promise.all([
    readWorkspaceFile('manifest.json'),
    readWorkspaceFile('scripts/build-release.mjs'),
    readWorkspaceFile('src/core/accessibility/accessible-preview-runtime.classic.js'),
    readWorkspaceFile('src/personas/screen-reader-module.js'),
    readWorkspaceFile('src/personas/content.js'),
    readWorkspaceFile('src/personas/personas.css'),
  ]);
  const manifest = JSON.parse(manifestSource);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.deepEqual(manifest.permissions, ['alarms', 'contextMenus', 'debugger', 'downloads', 'scripting', 'sidePanel', 'storage', 'tabs']);
  assert.equal(manifest.content_security_policy.extension_pages.includes("'unsafe-eval'"), false);
  assert.match(buildSource, /cp\(join\(root, 'src'\), join\(staging, 'src'\), \{ recursive: true \}\)/u);
  for (const [path, source] of [
    ['accessible-preview-runtime.classic.js', runtime],
    ['screen-reader-module.js', reader],
    ['content.js', content],
  ]) {
    assert.ok(source.length > 100, `${path} precisa estar presente`);
    assert.doesNotMatch(source, /^\s*(?:import|export)\s/mu, `${path} precisa permanecer clássico`);
    assert.doesNotMatch(source, /\beval\s*\(|\bnew\s+Function\b/u);
  }
  assert.match(css, /audita-persona-achromatopsia/u);
  assert.doesNotMatch(css, /@import|https?:|url\s*\(/iu);
});
