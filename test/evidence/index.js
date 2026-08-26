const target = process.argv[1]?.replaceAll('\\', '/');

if (target === 'test/evidence' || target?.endsWith('/test/evidence')) {
  await import('./selector.test.js');
  await import('./snippet.test.js');
  await import('./capture-evidence.test.js');
}
