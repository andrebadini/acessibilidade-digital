// Keep the public HTML synchronized with the complete local policy; no external dependencies.
import { readFile, writeFile } from 'node:fs/promises';

const source = await readFile(new URL('../docs/POLITICA-DE-PRIVACIDADE.md', import.meta.url), 'utf8');
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const inline = value => escape(value)
  .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/gu, '<a href="$2">$1</a>')
  .replace(/`([^`]+)`/gu, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>');
const version = source.match(/^Versão ([^,]+), atualizada em ([^.]+)\.$/mu);
if (!version) throw new Error('A política precisa declarar versão e data.');
const sections = source.split(/^## /mu).slice(1).map(section => {
  const [heading, ...body] = section.trim().split('\n');
  const content = body.join('\n').trim().split(/\n\s*\n/u).map(block => {
    if (block.startsWith('- ')) {
      return `<ul>${block.split('\n').map(line => {
        if (!line.startsWith('- ')) throw new Error('Lista não suportada na política.');
        return `<li>${inline(line.slice(2))}</li>`;
      }).join('')}</ul>`;
    }
    return `<p>${inline(block.replaceAll('\n', ' '))}</p>`;
  }).join('');
  return `  <section><h2>${inline(heading)}</h2>${content}</section>`;
});
if (sections.length !== 10) throw new Error('A política precisa manter as dez seções.');
const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Política de Privacidade — Audita Acessibilidade</title>
  <style>
    :root{font-family:Arial,Helvetica,sans-serif;line-height:1.6;color:#162330;background:#f4f7fa}
    *{box-sizing:border-box}body{margin:0}header{background:#003b71;color:#fff;padding:1.25rem}header div,main,footer{max-width:56rem;margin:auto}h1{margin:0;font-size:clamp(1.8rem,5vw,2.6rem)}main{background:#fff;padding:1.5rem;margin-top:1rem;border:1px solid #c7d0d8;border-radius:.5rem}h2{color:#003b71;border-bottom:2px solid #005a9c;padding-bottom:.25rem;margin-top:2rem}a{color:#004f8f}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:#eef1f4;padding:.1rem .3rem;border-radius:.2rem}footer{padding:1rem 1.5rem 2rem;color:#34495e}@media(max-width:58rem){main{margin:0;border-radius:0;border-left:0;border-right:0}}
  </style>
</head>
<body>
<header><div><h1>Política de Privacidade</h1><p>Audita Acessibilidade · versão da política ${inline(version[1])} · ${inline(version[2])}</p></div></header>
<main>
${sections.join('\n')}
</main>
<footer><p>Audita Acessibilidade — ferramenta independente de auditoria de acessibilidade.</p></footer>
</body>
</html>
`;
await writeFile(new URL('privacy.html', import.meta.url), html);
console.log(`Política ${version[1]}: HTML atualizado a partir do Markdown (${sections.length} seções).`);
