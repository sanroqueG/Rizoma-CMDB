'use strict';
/*
 * Testes ponta a ponta da interface, num browser real (Chrome/Edge/Chromium headless) controlado pelo
 * Chrome DevTools Protocol — sem dependências npm. Se não houver browser, os testes são ignorados.
 * Browser específico: CMDB_BROWSER=/caminho/para/chrome
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startServer } = require('./helpers');

function findBrowser() {
  const candidates = [
    process.env.CMDB_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/microsoft-edge',
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}
const BROWSER = typeof WebSocket === 'function' ? findBrowser() : null;
const SKIP = BROWSER ? false : 'sem browser Chromium/Edge disponível (defina CMDB_BROWSER)';
const TIMEOUT = 45000;

let S;
let proc;
let profile;
let page;
const errors = [];

/** Cliente CDP mínimo sobre WebSocket. */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('Falha na ligação CDP')); });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else if (msg.method) for (const l of listeners) l(msg);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return { send, on: (fn) => listeners.push(fn), close: () => ws.close() };
}

async function evaluate(expr) {
  const r = await page.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`Erro no browser: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}
async function waitFor(expr, label, timeout = TIMEOUT) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await evaluate(expr); if (last) return last; } catch (e) { last = e.message; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Tempo esgotado à espera de: ${label} (último valor: ${JSON.stringify(last)})`);
}
/** Preenche campos de um formulário (por name) e submete-o. */
async function fillAndSubmit(formSelector, values) {
  await evaluate(`(() => {
    const f = document.querySelector(${JSON.stringify(formSelector)});
    if (!f) throw new Error('formulário não encontrado: ${formSelector}');
    for (const [k, v] of Object.entries(${JSON.stringify(values)})) {
      const el = f.querySelector('[name="' + k + '"]');
      if (!el) throw new Error('campo não encontrado: ' + k);
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    f.requestSubmit();
    return true;
  })()`);
}
/** Navega para uma rota da SPA e espera que a página acabe de carregar sem erro. */
async function go(hash, expectH1) {
  await evaluate(`location.hash = ${JSON.stringify(hash)}`);
  const h1 = await waitFor(`(() => {
    const m = document.querySelector('main.main');
    if (!m || m.textContent.includes('A carregar…')) return null;
    const t = m.querySelector('h1');
    return t ? t.textContent : null;
  })()`, `página ${hash}`);
  assert.notEqual(h1, 'Erro', `${hash}: ${await evaluate("document.querySelector('main .error')?.textContent || ''")}`);
  if (expectH1) assert.match(h1, expectH1, `${hash}: título`);
  return h1;
}

before(async () => {
  if (SKIP) return;
  S = await startServer({ adminPassword: '' }); // admin / admin123, com mudança obrigatória
  // Dados de base pela API (com um admin auxiliar para não mexer no "admin")
  const db = S.db;
  const { hashPassword } = require('../src/auth');
  db.prepare("INSERT INTO users (username, name, password_hash, role, org_id) VALUES ('setup', 'Setup', ?, 'admin', 1)").run(hashPassword('Setup-pass-2026'));
  const a = S.agent();
  await a.login('setup', 'Setup-pass-2026');
  const c = (await a.post('/api/clients', { name: 'Browser Lda', code: 'BRW' })).data.id;
  const types = Object.fromEntries((await a.get('/api/meta')).data.types.map((t) => [t.name, t.id]));
  const srv = (await a.post('/api/cis', { client_id: c, type_id: types.Servidor, name: 'SRV-E2E', hostname: 'srv-e2e', warranty_end: '2020-01-01' })).data.id;
  const appCi = (await a.post('/api/cis', { client_id: c, type_id: types['Aplicação'], name: 'APP-E2E', criticality: 'critica' })).data.id;
  await a.post('/api/relationships', { source_id: appCi, target_id: srv, type: 'corre_em' });
  await a.post('/api/contracts', { client_id: c, name: 'Contrato E2E', vendor: 'Fornecedor X', end_date: new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10), cost: 50, billing: 'mensal', ci_ids: [srv] });
  await a.post(`/api/cis/${srv}/tickets`, { system: 'GLPI', external_id: '900', title: 'Disco cheio' });

  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdb-e2e-'));
  // Em Linux (CI): os runners Ubuntu 24 não permitem o sandbox do Chrome; /dev/shm é pequeno nos contentores
  const linuxArgs = process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
  proc = spawn(BROWSER, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-gpu', '--window-size=1400,1000', ...linuxArgs, 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  const until = Date.now() + 30000;
  while (!fs.existsSync(portFile) || !fs.readFileSync(portFile, 'utf8').includes('\n')) {
    if (Date.now() > until) throw new Error('O browser não arrancou');
    await new Promise((r) => setTimeout(r, 100));
  }
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  page = await connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  page.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((x) => x.value ?? x.description).join(' '));
  });
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: `${S.base}/` });
  await waitFor("document.querySelector('form input[name=username]') !== null", 'ecrã de login');
});

after(async () => {
  if (SKIP) return;
  try { page?.close(); } catch { /* ignore */ }
  proc?.kill();
  await new Promise((r) => setTimeout(r, 500));
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* o browser pode ainda ter ficheiros abertos */ }
  await S.close();
});

test('login com a password por omissão obriga a mudá-la', { skip: SKIP, timeout: 120000 }, async () => {
  await fillAndSubmit('form', { username: 'admin', password: 'admin123' });
  await waitFor("location.hash === '#/conta' && document.querySelector('main h2')?.textContent === 'Definir nova password'", 'página de mudança obrigatória');
  // Tentar sair da página volta a "A minha conta"
  await evaluate("location.hash = '#/ativos'");
  await waitFor("location.hash === '#/conta'", 'redirecionamento para a conta');
  await waitFor("document.querySelector('main form [name=current]')", 'formulário');
  await fillAndSubmit('main form', { current: 'admin123', password: 'fraca', confirm: 'fraca' });
  // A validação do browser (minlength) impede o envio; com uma password comum, o servidor recusa
  await fillAndSubmit('main form', { current: 'admin123', password: 'password123', confirm: 'password123' });
  await waitFor("[...document.querySelectorAll('main .error')].some((e) => !e.hidden && /comum/.test(e.textContent))", 'erro de password comum');
  await fillAndSubmit('main form', { current: 'admin123', password: 'Navegador-Seguro-2026', confirm: 'Navegador-Seguro-2026' });
  await waitFor("location.hash === '#/'", 'dashboard após mudar a password');
  await go('#/', /Dashboard/);
});

test('todas as páginas abrem sem erros', { skip: SKIP, timeout: 300000 }, async () => {
  const pages = [
    ['#/', /Dashboard/], ['#/ativos', /Ativos/], ['#/clientes', /Clientes/], ['#/clientes/1', /Browser Lda/],
    ['#/clientes/1/mapa', /Mapa/], ['#/clientes/1/relatorio', /Relatório/], ['#/contratos', /Contratos/],
    ['#/contratos?expiring=90', /Contratos/], ['#/contratos?status=todos', /Contratos/], ['#/contratos/1', /Contrato E2E/],
    ['#/contratos/1/editar', /Editar/], ['#/contratos/novo', /Novo contrato/], ['#/ativos/1', /SRV-E2E/], ['#/ativos/1/editar', /Editar/],
    ['#/ativos/novo', /Novo ativo/], ['#/importar', /Importar/], ['#/utilizadores', /Utilizadores/], ['#/auditoria', /Auditoria/],
    ['#/sistema', /Sistema/], ['#/organizacao', /Organização/], ['#/plataforma', /Plataforma/], ['#/conta', /A minha conta/],
    ['#/tipos', /Tipos de ativo/], ['#/subscricao', /Subscrição/], ['#/integracoes', /Integrações/],
  ];
  for (const [hash, h1] of pages) await go(hash, h1);
  assert.deepEqual(errors, [], 'sem exceções JavaScript');
});

test('o dashboard mostra garantias e renovações de contratos', { skip: SKIP, timeout: 120000 }, async () => {
  await go('#/', /Dashboard/);
  const text = await evaluate("document.querySelector('.focal').textContent");
  assert.match(text, /SRV-E2E/);
  assert.match(text, /Contrato E2E/);
});

test('o ativo mostra contratos e tickets; ligar um ticket pela interface', { skip: SKIP, timeout: 120000 }, async () => {
  await go('#/ativos/1', /SRV-E2E/);
  const text = await evaluate("document.querySelector('main').textContent");
  assert.match(text, /Contrato E2E/);
  assert.match(text, /GLPI 900/);
  await evaluate("[...document.querySelectorAll('main button')].find((b) => b.textContent.trim() === 'Ligar ticket').click()");
  await waitFor("document.querySelector('dialog form [name=system]')", 'diálogo de ticket');
  await fillAndSubmit('dialog form', { system: 'Jira', external_id: 'OPS-7', title: 'Atualizar firmware' });
  await waitFor("document.querySelector('main').textContent.includes('Jira OPS-7')", 'ticket ligado');
});

test('criar um contrato pelo formulário', { skip: SKIP, timeout: 120000 }, async () => {
  await go('#/contratos/novo?client=1', /Novo contrato/);
  await waitFor("document.querySelector('.ci-picker input[type=checkbox]')", 'lista de ativos');
  await evaluate("document.querySelector('.ci-picker input[type=checkbox]').click()");
  await fillAndSubmit('main form', { name: 'Suporte via browser', kind: 'suporte', vendor: 'ACME Serviços', cost: '99,90', billing: 'anual', end_date: '2027-06-30', auto_renew: true });
  await waitFor("location.hash.startsWith('#/contratos/') && document.querySelector('main h1')?.textContent === 'Suporte via browser'", 'detalhe do novo contrato');
  const text = await evaluate("document.querySelector('main').textContent");
  assert.match(text, /99,90/);
  assert.match(text, /Ativos abrangidos · 1/);
});

test('pesquisa global (Ctrl K) encontra ativos, contratos e tickets', { skip: SKIP, timeout: 120000 }, async () => {
  await go('#/', /Dashboard/);
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))");
  await waitFor("document.querySelector('dialog.palette input')", 'palete');
  const search = async (q, expected) => {
    await evaluate(`(() => { const i = document.querySelector('dialog.palette input'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); })()`);
    return waitFor(`(() => { const t = document.querySelector('dialog.palette ul').textContent; return t.includes(${JSON.stringify(expected)}) ? t : null; })()`, `resultados de ${q}`);
  };
  assert.match(await search('srv-e2e', 'SRV-E2E'), /Ativo.*SRV-E2E/);
  assert.match(await search('Fornecedor X', 'Contrato E2E'), /Contrato.*Contrato E2E/);
  assert.match(await search('Disco cheio', 'GLPI 900'), /Ticket.*GLPI 900/);
  await evaluate("document.querySelector('dialog.palette').close()");
  assert.deepEqual(errors, [], 'sem exceções JavaScript');
});
