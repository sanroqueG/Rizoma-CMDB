'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { openDb, ensureAdmin } = require('../src/db');
const { createApp } = require('../src/app');
const totp = require('../src/totp');
const { parseDate } = require('../src/importer');

// ------------------------------------------------------------------ mocks externos
const idpKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const rogueKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const IDP = 'https://idp.test';
const idp = { nonce: null, email: 'ana@cliente.pt', rogue: false, aud: 'cmdb-app' };

function signJwt(claims, keys = idpKeys) {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const s = crypto.sign('sha256', Buffer.from(`${h}.${p}`), keys.privateKey).toString('base64url');
  return `${h}.${p}.${s}`;
}

const cloud = {
  failToken: false,
  devices: [
    { id: 'd1', deviceName: 'ACME-PC-001', serialNumber: 'SN-1', operatingSystem: 'Windows', osVersion: '10.0.22631', chassisType: 'laptop', manufacturer: 'Lenovo', model: 'ThinkPad T14', lastSyncDateTime: '2026-11-10T10:00:00Z', userPrincipalName: 'rita@acme.pt', complianceState: 'compliant' },
    { id: 'd2', deviceName: 'iPhone de Ana', serialNumber: 'F2XPHONE', operatingSystem: 'iOS', osVersion: '18.1', manufacturer: 'Apple', model: 'iPhone 15', lastSyncDateTime: '2026-11-11T08:00:00Z' },
  ],
  calls: [],
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

async function mockFetch(url, opts = {}) {
  const u = new URL(url);
  cloud.calls.push(`${opts.method || 'GET'} ${u.host}${u.pathname}`);
  // --- OIDC
  if (url === `${IDP}/.well-known/openid-configuration`) {
    return json({ issuer: IDP, authorization_endpoint: `${IDP}/authorize`, token_endpoint: `${IDP}/token`, jwks_uri: `${IDP}/jwks` });
  }
  if (url === `${IDP}/jwks`) return json({ keys: [{ ...idpKeys.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] });
  if (url === `${IDP}/token`) {
    const body = new URLSearchParams(opts.body);
    assert.ok(body.get('code_verifier'), 'PKCE verifier enviado');
    const now = Math.floor(Date.now() / 1000);
    return json({ id_token: signJwt({ iss: IDP, aud: idp.aud, exp: now + 300, iat: now, nonce: idp.nonce, email: idp.email }, idp.rogue ? rogueKeys : idpKeys) });
  }
  // --- Microsoft
  if (u.host === 'login.microsoftonline.com') {
    if (cloud.failToken) return json({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret' }, 401);
    return json({ access_token: `tok:${new URLSearchParams(opts.body).get('scope')}` });
  }
  if (u.host === 'graph.microsoft.com') {
    assert.equal(opts.headers.Authorization, 'Bearer tok:https://graph.microsoft.com/.default');
    if (u.pathname === '/v1.0/subscribedSkus') {
      return json({ value: [{ skuId: 'sku-1', skuPartNumber: 'SPB', capabilityStatus: 'Enabled', prepaidUnits: { enabled: 25 }, consumedUnits: 20 }] });
    }
    if (u.pathname === '/v1.0/deviceManagement/managedDevices') {
      if (u.searchParams.get('page') === '2') return json({ value: cloud.devices.slice(1) });
      return json({ value: cloud.devices.slice(0, 1), '@odata.nextLink': 'https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?page=2' });
    }
  }
  if (u.host === 'management.azure.com') {
    if (u.pathname === '/subscriptions') return json({ value: [{ id: '/subscriptions/sub-1', subscriptionId: 'sub-1', displayName: 'Produção', state: 'Enabled' }] });
    if (u.pathname === '/subscriptions/sub-1/resources') {
      const rg = '/subscriptions/sub-1/resourceGroups/rg-erp/providers';
      return json({ value: [
        { id: `${rg}/Microsoft.Compute/virtualMachines/vm-erp`, name: 'vm-erp', type: 'Microsoft.Compute/virtualMachines', location: 'westeurope', tags: { app: 'erp' } },
        { id: `${rg}/Microsoft.Compute/disks/vm-erp-os`, name: 'vm-erp-os', type: 'Microsoft.Compute/disks', location: 'westeurope' },
        { id: `${rg}/Microsoft.Sql/servers/sql1/databases/erpdb`, name: 'sql1/erpdb', type: 'Microsoft.Sql/servers/databases', location: 'westeurope' },
      ] });
    }
  }
  return json({ error: { message: `mock sem rota: ${url}` } }, 404);
}

// ------------------------------------------------------------------ servidor de teste
let db; let server; let base;
before(async () => {
  db = openDb(':memory:');
  ensureAdmin(db, 'admin-pass-123');
  server = http.createServer(createApp(db, {
    fetch: mockFetch,
    secretKey: 'chave-de-teste',
    oidc: { issuer: IDP, clientId: 'cmdb-app', clientSecret: 'segredo', redirectUri: 'http://cmdb.test/api/auth/oidc/callback', label: 'Microsoft' },
  }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); });

function agent(b = () => base) {
  const jar = new Map();
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(b() + p, {
      method, redirect: 'manual',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i);
      const v = kv.slice(i + 1);
      if (v === '' || /Max-Age=0/.test(c)) jar.delete(k); else jar.set(k, v);
    }
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, data: ct.includes('json') ? await res.json() : await res.text() };
  };
  return {
    jar, get: (p) => call('GET', p), post: (p, b2, h) => call('POST', p, b2, h), put: (p, b2) => call('PUT', p, b2), del: (p) => call('DELETE', p),
    async login(u, pw) { const r = await call('POST', '/api/login', { username: u, password: pw }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; },
  };
}

const S = {};
const typeId = async (a, name) => (await a.get('/api/meta')).data.types.find((t) => t.name === name).id;

test('preparação: cliente, técnico e ativos', async () => {
  const a = agent();
  await a.login('admin', 'admin-pass-123');
  S.admin = a;
  S.client = (await a.post('/api/clients', { name: 'ACME', code: 'ACME' })).data.id;
  S.other = (await a.post('/api/clients', { name: 'Outro', code: 'OUT' })).data.id;
  const t = await a.post('/api/users', { username: 'tec', name: 'Técnico', role: 'tech', password: 'tec-pass-123', client_ids: [S.client] });
  assert.equal(t.status, 200);
});

// ================================================================== 2FA
describe('2FA (TOTP)', () => {
  test('vetor RFC 4226 e base32', () => {
    const key = Buffer.from('12345678901234567890');
    assert.equal(totp.hotp(key, 0), '755224');
    assert.equal(totp.hotp(key, 1), '287082');
    assert.deepEqual(totp.base32Decode(totp.base32Encode(key)), key);
  });

  test('ativar, login em 2 passos, anti-replay e códigos de recuperação', async () => {
    const a = agent();
    await a.login('tec', 'tec-pass-123');
    const setup = (await a.post('/api/me/2fa/setup')).data;
    assert.match(setup.uri, /^otpauth:\/\/totp\/Rizoma:tec\?secret=[A-Z2-7]+&issuer=Rizoma/);
    const key = totp.base32Decode(setup.secret);
    const ctr = totp.counterAt();
    assert.equal((await a.post('/api/me/2fa/enable', { code: '000000' })).status, 400);
    const en = await a.post('/api/me/2fa/enable', { code: totp.hotp(key, ctr) });
    assert.equal(en.status, 200, JSON.stringify(en.data));
    assert.equal(en.data.recovery_codes.length, 10);

    const b = agent();
    const step1 = (await b.post('/api/login', { username: 'tec', password: 'tec-pass-123' })).data;
    assert.equal(step1.mfa_required, true);
    assert.equal((await b.get('/api/me')).status, 401, 'sem sessão antes do 2.º fator');
    // o mesmo código não pode ser reutilizado
    assert.equal((await b.post('/api/login/mfa', { mfa_token: step1.mfa_token, code: totp.hotp(key, ctr) })).status, 401);
    const ok = await b.post('/api/login/mfa', { mfa_token: step1.mfa_token, code: totp.hotp(key, ctr + 1) });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal((await b.get('/api/me')).data.totp_enabled, true);

    const c = agent();
    const s2 = (await c.post('/api/login', { username: 'tec', password: 'tec-pass-123' })).data;
    const rec = en.data.recovery_codes[0].toUpperCase();
    const r2 = await c.post('/api/login/mfa', { mfa_token: s2.mfa_token, code: rec });
    assert.equal(r2.status, 200);
    assert.equal(r2.data.recovery_codes_left, 9);
    const d = agent();
    const s3 = (await d.post('/api/login', { username: 'tec', password: 'tec-pass-123' })).data;
    assert.equal((await d.post('/api/login/mfa', { mfa_token: s3.mfa_token, code: rec })).status, 401, 'código de recuperação é de uso único');

    // admin repõe o 2FA
    assert.equal((await S.admin.post(`/api/users/${(await b.get('/api/me')).data.id}/2fa/reset`)).status, 200);
    const e = agent();
    const s4 = await e.post('/api/login', { username: 'tec', password: 'tec-pass-123' });
    assert.ok(!s4.data.mfa_required);
  });

  test('2FA obrigatório bloqueia a API até ser configurado', async () => {
    const db2 = openDb(':memory:');
    ensureAdmin(db2, 'admin-pass-123');
    const srv = http.createServer(createApp(db2, { requireMfa: true, secretKey: 'k', oidc: null }));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const a = agent(() => `http://127.0.0.1:${srv.address().port}`);
    const me = await a.login('admin', 'admin-pass-123');
    assert.equal(me.mfa_setup_required, true);
    assert.equal((await a.get('/api/cis')).status, 403);
    assert.equal((await a.get('/api/meta')).status, 200);
    const setup = (await a.post('/api/me/2fa/setup')).data;
    await a.post('/api/me/2fa/enable', { code: totp.hotp(totp.base32Decode(setup.secret), totp.counterAt()) });
    assert.equal((await a.get('/api/cis')).status, 200);
    assert.equal((await a.post('/api/me/2fa/disable', { password: 'admin-pass-123' })).status, 400);
    srv.close();
    db2.close();
  });
});

// ================================================================== SSO
describe('SSO (OIDC)', () => {
  async function ssoLogin(a) {
    const start = await a.get('/api/auth/oidc/start');
    assert.equal(start.status, 302);
    const loc = new URL(start.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, `${IDP}/authorize`);
    assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
    idp.nonce = loc.searchParams.get('nonce');
    return a.get(`/api/auth/oidc/callback?code=abc&state=${loc.searchParams.get('state')}`);
  }

  test('configuração pública', async () => {
    assert.deepEqual((await agent().get('/api/auth/config')).data, { oidc: { label: 'Microsoft' }, require_2fa: false, signup: false });
  });

  test('login SSO de utilizador registado (por email)', async () => {
    await S.admin.post('/api/users', { username: 'ana', name: 'Ana', email: 'Ana@Cliente.pt', role: 'client', client_id: S.client });
    const a = agent();
    const cb = await ssoLogin(a);
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get('location'), '/#/');
    const me = await a.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.username, 'ana');
  });

  test('recusa conta desconhecida, assinatura falsa, audiência errada e state inválido', async () => {
    idp.email = 'intruso@x.pt';
    let cb = await ssoLogin(agent());
    assert.match(decodeURIComponent(cb.headers.get('location')), /sso_erro=A conta intruso@x\.pt não tem acesso/);
    idp.email = 'ana@cliente.pt';

    idp.rogue = true;
    cb = await ssoLogin(agent());
    assert.match(decodeURIComponent(cb.headers.get('location')), /Assinatura do id_token inválida/);
    idp.rogue = false;

    idp.aud = 'outra-app';
    cb = await ssoLogin(agent());
    assert.match(decodeURIComponent(cb.headers.get('location')), /aud/);
    idp.aud = 'cmdb-app';

    const a = agent();
    await a.get('/api/auth/oidc/start');
    cb = await a.get('/api/auth/oidc/callback?code=abc&state=forjado');
    assert.match(decodeURIComponent(cb.headers.get('location')), /sso_erro=Pedido de login inválido/);
    assert.equal((await a.get('/api/me')).status, 401);
  });
});

// ================================================================== importação
describe('Importação', () => {
  const rows = [
    { Nome: 'PC-01', Tipo: 'portatil', Estado: 'Em produção', 'Nº de série': 'SN-1', Local: 'Filial Porto', 'Fim de garantia': '31/12/2027', 'Data de compra': '45000', Cor: 'preto' },
    { Nome: 'X', Tipo: 'Inexistente' },
    { Nome: 'Y', 'Fim de garantia': '31/02/2027' },
    { Nome: '', Tipo: '' },
    { Nome: 'SRV-02', Tipo: 'Servidor', Criticidade: 'Alta', Ambiente: 'prod', 'Endereço IP': '10.0.0.2' },
  ];

  test('datas', () => {
    assert.equal(parseDate('2027-01-05'), '2027-01-05');
    assert.equal(parseDate('5/1/2027'), '2027-01-05');
    assert.equal(parseDate(45000), '2023-03-15');
    assert.throws(() => parseDate('31/02/2027'));
  });

  test('simulação não grava nada', async () => {
    const before = (await S.admin.get(`/api/cis?client=${S.client}`)).data.total;
    const r = await S.admin.post('/api/import', { client_id: S.client, rows, dry_run: true });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.summary, { created: 2, updated: 0, unchanged: 0, errors: 2, sites_created: 1 });
    assert.equal(r.data.columns.Cor, 'attributes');
    assert.equal(r.data.columns['Nº de série'], 'serial_number');
    assert.match(r.data.results.find((x) => x.row === 3).error, /tipo desconhecido/);
    assert.equal((await S.admin.get(`/api/cis?client=${S.client}`)).data.total, before);
    assert.equal((await S.admin.get(`/api/clients/${S.client}`)).data.sites.length, 0);
  });

  test('importação real, depois atualização pelo nº de série', async () => {
    const r = await S.admin.post('/api/import', { client_id: S.client, rows, dry_run: false });
    assert.equal(r.data.summary.created, 2);
    const id = r.data.results.find((x) => x.row === 2).id;
    const ci = (await S.admin.get(`/api/cis/${id}`)).data;
    assert.equal(ci.type_name, 'Portátil');
    assert.equal(ci.site_name, 'Filial Porto');
    assert.equal(ci.warranty_end, '2027-12-31');
    assert.equal(ci.purchase_date, '2023-03-15');
    assert.equal(ci.source, 'import');
    assert.deepEqual(ci.attributes, { Cor: 'preto' });
    const srv = (await S.admin.get(`/api/cis/${r.data.results.find((x) => x.row === 6).id}`)).data;
    assert.equal(srv.environment, 'producao');
    assert.equal(srv.criticality, 'alta');

    const r2 = await S.admin.post('/api/import', { client_id: S.client, rows: [{ 'Serial Number': 'SN-1', Name: 'PC-01', Hostname: 'acme-pc-01' }], dry_run: false });
    assert.deepEqual(r2.data.summary, { created: 0, updated: 1, unchanged: 0, errors: 0, sites_created: 0 });
    assert.equal(r2.data.results[0].id, id);
    S.pcId = id;
  });

  test('permissões e validação', async () => {
    const t = agent();
    // o 2FA do técnico foi reposto no teste anterior
    await t.login('tec', 'tec-pass-123');
    assert.equal((await t.post('/api/import', { client_id: S.other, rows: [{ Nome: 'a' }] })).status, 404);
    assert.equal((await S.admin.post('/api/import', { client_id: S.client, rows: [{ Cor: 'x' }] })).status, 400);
    assert.equal((await S.admin.post('/api/import', { client_id: S.client, rows: [] })).status, 400);
  });
});

// ================================================================== mapa
describe('Mapa de relações', () => {
  test('níveis e arestas', async () => {
    const a = S.admin;
    const tApp = await typeId(a, 'Aplicação');
    const mk = async (name) => (await a.post('/api/cis', { client_id: S.client, type_id: tApp, name })).data.id;
    const A = await mk('App A'); const B = await mk('Svc B'); const C = await mk('Infra C'); const D = await mk('App D');
    for (const [s, t] of [[A, B], [B, C], [D, B]]) await a.post('/api/relationships', { source_id: s, target_id: t, type: 'depende_de' });
    const g = (await a.get(`/api/cis/${B}/graph?depth=2`)).data;
    const lvl = Object.fromEntries(g.nodes.map((n) => [n.name, n.level]));
    assert.deepEqual(lvl, { 'Svc B': 0, 'Infra C': 1, 'App A': -1, 'App D': -1 });
    assert.equal(g.edges.length, 3);
    const cg = (await a.get(`/api/clients/${S.client}/graph`)).data;
    assert.equal(cg.nodes.length, 4);
    assert.equal((await agent().get(`/api/clients/${S.client}/graph`)).status, 401);
  });
});

// ================================================================== Microsoft 365 / Azure
describe('Conector Microsoft 365 / Azure', () => {
  const cfg = { tenant_id: 'acme.onmicrosoft.com', app_id: '11111111-2222-3333-4444-555555555555', secret: 'super-secreto', options: { licenses: true, intune: true, azure: true } };

  test('configuração (segredo nunca é devolvido) e permissões', async () => {
    assert.equal((await S.admin.put(`/api/clients/${S.client}/connector`, { ...cfg, app_id: 'x' })).status, 400);
    assert.equal((await S.admin.put(`/api/clients/${S.client}/connector`, { ...cfg, secret: '' })).status, 400);
    const r = await S.admin.put(`/api/clients/${S.client}/connector`, cfg);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(!JSON.stringify(r.data).includes('super-secreto'));
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM cloud_connectors').all()).includes('super-secreto'), 'segredo encriptado na BD');
    const t = agent();
    await t.login('tec', 'tec-pass-123');
    assert.equal((await t.get(`/api/clients/${S.client}/connector`)).status, 403);
  });

  test('sincronização: licenças, Intune (com paginação e reconciliação) e Azure', async () => {
    const r = await S.admin.post(`/api/clients/${S.client}/connector/sync`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.status, 'ok', JSON.stringify(r.data.report));
    assert.deepEqual(r.data.report.licencas, { created: 1, updated: 0, unchanged: 0, retired: 0 });
    // SN-1 já existia (importado) → atualizado, não duplicado
    assert.deepEqual(r.data.report.dispositivos, { created: 1, updated: 1, unchanged: 0, retired: 0 });
    assert.deepEqual(r.data.report.azure, { created: 3, updated: 0, unchanged: 0, retired: 0 });

    const list = (await S.admin.get(`/api/cis?client=${S.client}&limit=1000`)).data.items;
    const by = (n) => list.find((x) => x.name === n);
    assert.equal(by('Microsoft 365 Business Premium').type_name, 'Licença');
    assert.equal(by('iPhone de Ana').type_name, 'Telemóvel');
    assert.equal(by('vm-erp').type_name, 'Máquina virtual');
    assert.equal(by('sql1/erpdb').type_name, 'Base de dados');
    assert.ok(!by('vm-erp-os'), 'discos ignorados');
    const pc = (await S.admin.get(`/api/cis/${S.pcId}`)).data;
    assert.equal(pc.attributes.utilizador, 'rita@acme.pt');
    assert.equal(pc.last_seen, '2026-11-10 10:00:00');
    const vm = (await S.admin.get(`/api/cis/${by('vm-erp').id}`)).data;
    assert.equal(vm.outgoing[0].name, 'Subscrição Azure: Produção');
    assert.equal(vm.outgoing[0].type, 'alojado_em');
    assert.ok(cloud.calls.some((c) => c.includes('managedDevices')), 'Graph chamado');
  });

  test('ativos que desaparecem da origem são abatidos; erros de autenticação reportados', async () => {
    cloud.devices = cloud.devices.slice(0, 1);
    const r = await S.admin.post(`/api/clients/${S.client}/connector/sync`);
    assert.equal(r.data.report.dispositivos.retired, 1);
    const phone = (await S.admin.get(`/api/cis?client=${S.client}&q=iPhone`)).data.items[0];
    assert.equal(phone.status, 'abatido');

    cloud.failToken = true;
    const bad = await S.admin.post(`/api/clients/${S.client}/connector/sync`);
    assert.equal(bad.data.status, 'erro');
    assert.match(bad.data.report.erros.join(' '), /AADSTS7000215/);
    cloud.failToken = false;
    const view = (await S.admin.get(`/api/clients/${S.client}/connector`)).data;
    assert.equal(view.last_status, 'erro');
  });
});

// ================================================================== diversos
test('scripts do agente disponíveis para download e health check', async () => {
  const ps = await fetch(`${base}/agent/inventario.ps1`);
  assert.equal(ps.status, 200);
  const sh = await fetch(`${base}/agent/inventario.sh`);
  assert.equal(sh.status, 200);
  assert.match(await sh.text(), /^#!\/bin\/sh/);
  assert.equal((await fetch(`${base}/agent/..%2fsrc%2fapp.js`)).status, 404);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});
