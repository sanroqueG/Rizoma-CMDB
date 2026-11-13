'use strict';
/* Gera dist/ pronto a alojar: index.html como documento HTML completo + assets/. Correr: node build.js */
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const cut = src.indexOf('<header class="site-header">');
const html = `<!doctype html>
<html lang="pt-PT">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${src.slice(0, cut).replace(/<meta name="claude:viewport-fit-sides"[^>]*>\n/, '')}</head>
<body>
${src.slice(cut)}</body>
</html>
`;
const dist = path.join(__dirname, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'index.html'), html);
fs.cpSync(path.join(__dirname, 'assets'), path.join(dist, 'assets'), { recursive: true });
console.log('dist/ pronto:', fs.readdirSync(dist).join(', '));
