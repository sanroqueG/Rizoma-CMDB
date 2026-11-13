'use strict';
/*
 * Capturas de ecrã da interface (para revisão visual e materiais comerciais), com Edge/Chrome headless via DevTools Protocol.
 * Uso: node scripts/screenshots.js [url-base] [utilizador] [password] [pasta-saída]
 * Omissão: http://127.0.0.1:3000 admin admin123 ./screenshots
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const [base = 'http://127.0.0.1:3000', user = 'admin', pass = 'admin123', outDir = 'screenshots'] = process.argv.slice(2);
const PAGES = [
  ['login', null], ['dashboard', '#/'], ['ativos', '#/ativos'], ['ativo', '#/ativos/5'], ['clientes', '#/clientes'],
  ['cliente', '#/clientes/1'], ['contratos', '#/contratos'], ['contrato', '#/contratos/1'], ['mapa', '#/clientes/1/mapa'],
  ['relatorio', '#/clientes/1/relatorio'], ['sistema', '#/sistema'], ['utilizadores', '#/utilizadores'],
];
const BROWSERS = [process.env.CMDB_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];

(async () => {
  const browser = BROWSERS.find((p) => p && fs.existsSync(p));
  if (!browser) throw new Error('Sem browser Chromium/Edge (defina CMDB_BROWSER)');
  const theme = process.env.THEME || 'light';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rizoma-shots-'));
  const proc = spawn(browser, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--disable-extensions', '--hide-scrollbars', '--window-size=1440,900', `--force-dark-mode=${theme === 'dark'}`, 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 300 && !(fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').includes('\n')); i++) await new Promise((r) => setTimeout(r, 100));
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = async () => { for (let i = 0; i < 100; i++) { if (await evaluate("!document.querySelector('.spinner-border')")) break; await sleep(100); } await sleep(400); };

  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  fs.mkdirSync(outDir, { recursive: true });
  await send('Page.navigate', { url: `${base}/` });
  for (let i = 0; i < 100 && !(await evaluate("!!document.querySelector('input[name=username]')")); i++) await sleep(100);
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, `${theme}-${name}.png`), Buffer.from(data, 'base64'));
    console.log('ok', name);
  };
  for (const [name, hash] of PAGES) {
    if (!hash) {
      await sleep(300);
      await shot(name);
      await evaluate(`(() => { const f = document.querySelector('form'); f.username.value = ${JSON.stringify(user)}; f.password.value = ${JSON.stringify(pass)}; f.requestSubmit(); })()`);
      for (let i = 0; i < 100 && !(await evaluate("!!document.querySelector('.navbar-vertical')")); i++) await sleep(100);
      continue;
    }
    await evaluate(`location.hash = ${JSON.stringify(hash)}`);
    await settle();
    await shot(name);
  }
  ws.close();
  proc.kill();
})().catch((e) => { console.error(e); process.exit(1); });
