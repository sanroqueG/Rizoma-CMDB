'use strict';
/* SSO por organização: o domínio do email escolhe o fornecedor; o fornecedor de uma organização não dá acesso a outra. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer } = require('./helpers');

// ---- dois fornecedores de identidade falsos (um por organização)
function makeIdp(issuer) {
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { issuer, keys, email: null, name: null, nonce: null, aud: null };
}
const IDP_A = makeIdp('https://login.empresa-a.test');
const IDP_B = makeIdp('https://login.empresa-b.test');
const idps = [IDP_A, IDP_B];
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function sign(claims, keys) {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${h}.${p}.${crypto.sign('sha256', Buffer.from(`${h}.${p}`), keys.privateKey).toString('base64url')}`;
}
async function mockFetch(url, opts = {}) {
  const idp = idps.find((i) => String(url).startsWith(i.issuer));
  if (!idp) return json({ error: 'sem rota' }, 404);
  const path = String(url).slice(idp.issuer.length);
  if (path === '/.well-known/openid-configuration') {
    return json({ issuer: idp.issuer, authorization_endpoint: `${idp.issuer}/authorize`, token_endpoint: `${idp.issuer}/token`, jwks_uri: `${idp.issuer}/jwks` });
  }
  if (path === '/jwks') return json({ keys: [{ ...idp.keys.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }] });
  if (path === '/token') {
    const body = new URLSearchParams(opts.body);
    const now = Math.floor(Date.now() / 1000);
    return json({ id_token: sign({ iss: idp.issuer, aud: body.get('client_id'), exp: now + 300, iat: now, nonce: idp.nonce, email: idp.email, name: idp.name }, idp.keys) });
  }
  return json({ error: 'sem rota' }, 404);
}

let S;
before(async () => { S = await startServer({ appOpts: { fetch: mockFetch, signup: true, secretKey: 'k', publicUrl: 'http://rizoma.test' } }); });
after(() => S.close());

/** Cliente com vários cookies e sem seguir redirecionamentos. */
function agent() {
  const jar = new Map();
  const call = async (method, p, body) => {
    const res = await fetch(S.base + p, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (kv.slice(i + 1) === '' || /Max-Age=0/.test(c)) jar.delete(kv.slice(0, i)); else jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, data: ct.includes('json') ? await res.json() : await res.text() };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

/** Faz o login SSO completo com o email indicado; devolve { a, location }. */
async function ssoLogin(email, idEmail = email) {
  const a = agent();
  const start = await a.get(`/api/auth/sso/start?email=${encodeURIComponent(email)}`);
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.get('location'), S.base);
  if (loc.pathname !== '/authorize') return { a, location: decodeURIComponent(start.headers.get('location')) };
  const idp = idps.find((i) => loc.origin === i.issuer);
  assert.equal(loc.searchParams.get('login_hint'), email);
  assert.equal(loc.searchParams.get('redirect_uri'), 'http://rizoma.test/api/auth/oidc/callback');
  idp.nonce = loc.searchParams.get('nonce');
  idp.email = idEmail;
  const cb = await a.get(`/api/auth/oidc/callback?code=xyz&state=${loc.searchParams.get('state')}`);
  return { a, location: decodeURIComponent(cb.headers.get('location')) };
}

let adminA;
let adminB;
test('preparação: duas organizações, cada uma com o seu fornecedor', async () => {
  adminA = agent();
  assert.equal((await adminA.post('/api/login', { username: 'admin', password: 'Admin-pass-123' })).status, 200);
  adminB = agent();
  assert.equal((await adminB.post('/api/signup', { organization: 'Empresa B', name: 'Bia', username: 'bia', email: 'bia@empresa-b.pt', password: 'Empresa-B-2026' })).status, 200);

  const cfgA = await adminA.put('/api/org/sso', { label: 'Entra ID', issuer: IDP_A.issuer, client_id: 'app-a', client_secret: 'segredo-a', domains: ['Empresa-A.pt', '@a-filial.pt'] });
  assert.equal(cfgA.status, 200, JSON.stringify(cfgA.data));
  assert.deepEqual(cfgA.data.domains, ['a-filial.pt', 'empresa-a.pt']);
  assert.equal(cfgA.data.has_secret, true);
  assert.equal(cfgA.data.client_secret, undefined, 'o segredo nunca é devolvido');
  assert.equal(cfgA.data.redirect_uri, 'http://rizoma.test/api/auth/oidc/callback');
  const stored = S.db.prepare('SELECT client_secret FROM org_sso WHERE org_id = 1').get().client_secret;
  assert.ok(stored && !stored.includes('segredo-a'), 'segredo encriptado na BD');

  // Domínio de outra organização e domínios de email pessoal são recusados
  assert.equal((await adminB.put('/api/org/sso', { issuer: IDP_B.issuer, client_id: 'app-b', domains: ['empresa-a.pt'] })).status, 409);
  assert.equal((await adminB.put('/api/org/sso', { issuer: IDP_B.issuer, client_id: 'app-b', domains: ['gmail.com'] })).status, 400);
  assert.equal((await adminB.put('/api/org/sso', { issuer: 'http://inseguro.test', client_id: 'app-b', domains: ['empresa-b.pt'] })).status, 400);
  assert.equal((await adminB.put('/api/org/sso', { issuer: IDP_B.issuer, client_id: 'app-b', client_secret: 's', domains: ['empresa-b.pt'] })).status, 200);
  assert.equal((await adminB.post('/api/org/sso/test')).data.ok, true);
  assert.equal((await agent().get('/api/auth/config')).data.org_sso, true);
});

test('login pelo domínio do email, só com utilizadores da própria organização', async () => {
  await adminA.post('/api/users', { username: 'rui', name: 'Rui', email: 'rui@empresa-a.pt', role: 'tech' });
  let r = await ssoLogin('rui@empresa-a.pt');
  assert.equal(r.location, '/#/');
  assert.equal((await r.a.get('/api/me')).data.username, 'rui');

  // O fornecedor da B afirma ser a Bia... mas pelo domínio da A: a Bia não pertence à A, não entra
  r = await ssoLogin('alguem@empresa-a.pt', 'bia@empresa-b.pt');
  assert.match(r.location, /sso_erro=A conta bia@empresa-b\.pt não tem acesso/);
  assert.equal((await r.a.get('/api/me')).status, 401);

  r = await ssoLogin('bia@empresa-b.pt');
  assert.equal((await r.a.get('/api/me')).data.username, 'bia');

  r = await ssoLogin('x@desconhecido.pt');
  assert.match(r.location, /sso_erro=O domínio desconhecido\.pt não tem login único/);
});

test('criação automática de utilizadores (só nos domínios da organização) e SSO obrigatório', async () => {
  let r = await ssoLogin('nova@empresa-a.pt');
  assert.match(r.location, /não tem acesso/, 'sem criação automática, a conta tem de existir');

  await adminA.put('/api/org/sso', { label: 'Entra ID', issuer: IDP_A.issuer, client_id: 'app-a', domains: ['empresa-a.pt', 'a-filial.pt'], auto_provision: true, enforce: true });
  assert.equal((await adminA.get('/api/org/sso')).data.has_secret, true, 'sem client_secret, mantém o anterior');
  IDP_A.name = 'Nova Pessoa';
  r = await ssoLogin('nova@empresa-a.pt');
  assert.equal(r.location, '/#/');
  const me = (await r.a.get('/api/me')).data;
  assert.equal(me.username, 'nova@empresa-a.pt');
  assert.equal(me.role, 'tech');
  assert.equal(me.name, 'Nova Pessoa');
  assert.equal((await r.a.get('/api/clients')).data.length, 0, 'criado sem acesso a clientes');

  // Identidade fora dos domínios da organização não é criada
  r = await ssoLogin('outro@empresa-a.pt', 'estranho@fora.pt');
  assert.match(r.location, /não tem acesso/);

  // SSO obrigatório: técnicos não entram com password; administradores sim (acesso de emergência)
  await adminA.put('/api/users/' + S.db.prepare("SELECT id FROM users WHERE username='rui'").get().id, { password: 'Rui-password-2026' });
  const pw = await agent().post('/api/login', { username: 'rui', password: 'Rui-password-2026' });
  assert.equal(pw.status, 403);
  assert.match(pw.data.error, /exige o login único/);
  assert.equal((await agent().post('/api/login', { username: 'admin', password: 'Admin-pass-123' })).status, 200);
});

test('desligar o SSO e eliminar a organização limpam a configuração', async () => {
  assert.equal((await adminB.del('/api/org/sso')).status, 200);
  assert.match((await ssoLogin('bia@empresa-b.pt')).location, /não tem login único/);
  assert.equal(S.db.prepare("SELECT count(*) n FROM org_sso_domains WHERE domain = 'empresa-b.pt'").get().n, 0);
  assert.equal((await agent().get('/api/org/sso')).status, 401);
});
