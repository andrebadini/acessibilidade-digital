import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readWorkspaceFile = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('declares a minimal MV3 extension shell without remote executable code', async () => {
  const manifest = JSON.parse(await readWorkspaceFile('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, '116', 'sidePanel.open e runtime.getContexts exigem Chrome 116+');
  assert.equal(manifest.version, '1.0.1');
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
  assert.equal(manifest.action.default_popup, 'src/popup/index.html');
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

test('popup is an accessible local launcher with no URL, retention or pixel controls', async () => {
  const [html, css] = await Promise.all([
    readWorkspaceFile('src/popup/index.html'),
    readWorkspaceFile('src/popup/popup.css'),
  ]);
  assert.equal((html.match(/<h1\b/giu) ?? []).length, 1);
  assert.match(html, /id="page-domain"/u);
  assert.match(html, /id="page-title"/u);
  assert.match(html, /<button[^>]+id="audit-page"[^>]+disabled[^>]*>\s*Avaliar esta página\s*<\/button>/iu);
  assert.match(html, /<button[^>]+id="other-source"[^>]+disabled[^>]*>\s*Outra URL ou lote\s*<\/button>/iu);
  assert.equal((html.match(/data-persona-mode=/gu) ?? []).length, 3);
  assert.equal((html.match(/data-persona-mode=[^>]+disabled/gu) ?? []).length, 3);
  assert.match(html, /Processamento local; nenhum dado é enviado\./u);
  assert.match(html, /Capturas visuais serão habilitadas somente após a etapa de privacidade\./u);
  assert.match(html, /role="status"[^>]+aria-live="polite"|aria-live="polite"[^>]+role="status"/iu);
  assert.doesNotMatch(html, /<input\b|<textarea\b|type="checkbox"|reten|full-evidence|element-only|no-pixels/iu);
  assert.doesNotMatch(html, /<script(?![^>]+src=)|<style\b|\sstyle=/iu);
  assert.doesNotMatch(html, /<(?:script|link|img)[^>]+(?:src|href)="https?:\/\//iu);
  assert.doesNotMatch(html, /gov(?:erno)?|bras[aã]o|secretaria|certifica|nota de acessibilidade/iu);
  assert.match(css, /font-family:\s*system-ui/iu);
  assert.match(css, /min-(?:block-size|height):\s*44px/iu);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/iu);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/iu);
  assert.doesNotMatch(css, /@import|https?:|url\s*\(/iu);
});

test('panel is an accessible local document with no inline code', async () => {
  const html = await readWorkspaceFile('src/panel/index.html');
  assert.equal((html.match(/<h1\b/gi) ?? []).length, 1);
  assert.match(html, /<label[^>]*for="audit-url"[^>]*>\s*Endereço do site\s*<\/label>/i);
  assert.match(html, /<input[^>]*id="audit-url"[^>]*type="url"/i);
  assert.match(html, /<button[^>]*type="submit"[^>]*>\s*Auditar\s*<\/button>/i);
  assert.match(html, /aria-live="polite"/i);
  assert.match(html, /hidden[^>]*id="latest-report"|id="latest-report"[^>]*hidden/i);
  const privacyNotice = html.match(/<p[^>]+id="audit-privacy-notice"[^>]*>([\s\S]*?)<\/p>/i);
  assert.ok(privacyNotice, 'o aviso de privacidade deve ser um texto visível antes do formulário');
  assert.ok(html.indexOf(privacyNotice[0]) < html.indexOf('<form'), 'o aviso deve anteceder o envio da auditoria');
  assert.match(privacyNotice[1], /captura[^.]*página inteira[^.]*elementos/iu);
  assert.match(privacyNotice[1], /pixels[^.]*dados sensíveis visíveis/iu);
  assert.match(privacyNotice[1], /armazenad[^.]*localmente[^.]*relatórios/iu);
  assert.match(privacyNotice[1], /ocult(?:e|ar)|remov(?:a|er)/iu);
  assert.doesNotMatch(html, /<script(?![^>]+src=)/i);
  assert.doesNotMatch(html, /<style\b|\sstyle=/i);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)="https?:\/\//i);
});

test('panel module starts the closed session client and renders a fixed unavailable start state', async () => {
  const source = await readWorkspaceFile('src/panel/panel.js');
  assert.match(source, /createPanelSessionPortClient/);
  assert.match(source, /sessionPortClient\.start\(\)/u);
  assert.match(source, /textContent/);
  assert.doesNotMatch(source, /innerHTML/);
  assert.doesNotMatch(source, /START_AUDIT|START_BATCH|CANCEL_AUDIT|AUDIT_CONTEXT_PREFILL/u);
  assert.doesNotMatch(source, /sessionCapabilityId/u);
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
