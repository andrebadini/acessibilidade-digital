const target = process.argv[1]?.replaceAll('\\', '/');

// Node v25 resolves an explicit directory to this package, while recursive
// discovery executes index.js itself and separately discovers *.test.js files.
if (target === 'test/accessibility' || target?.endsWith('/test/accessibility')) {
  await import('./accessible-name.test.js');
  await import('./announcement.test.js');
}
