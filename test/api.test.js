'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDb, ensureAdmin } = require('../src/db');
const { createApp } = require('../src/app');

let server;
let base;
let db;

before(async () => {
  db = openDb(':memory:');
  ensureAdmin(db, 'admin-pass-123');
  server = http.createServer(createApp(db));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); });

/** Cliente HTTP com cookie de sessão. */
function agent() {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  };
  return {
    get: (p) => call('GET', p), post: (p, b, h) => call('POST', p, b, h), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p),
    login: async (u, pw) => { const r = await call('POST', '/api/login', { username: u, password: pw }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r; },
  };
}

const ctx = {};

test('login e sessão', async () => {
  const a = agent();
  assert.equal((await a.get('/api/me')).status, 401);
  assert.equal((await a.post('/api/login', { username: 'admin', password: 'errada' })).status, 401);
  await a.login('admin', 'admin-pass-123');
  const me = await a.get('/api/me');
  assert.equal(me.data.role, 'admin');
  ctx.admin = a;
});

test('admin cria clientes, locais e utilizadores', async () => {
  const a = ctx.admin;
  const c1 = await a.post('/api/clients', { name: 'Cliente Um', code: 'um' });
  const c2 = await a.post('/api/clients', { name: 'Cliente Dois', code: 'DOIS' });
  assert.equal(c1.status, 200);
  assert.equal(c1.data.code, 'UM');
  assert.equal((await a.post('/api/clients', { name: 'Outro', code: 'UM' })).status, 409);
  ctx.c1 = c1.data.id; ctx.c2 = c2.data.id;
  const s = await a.post(`/api/clients/${ctx.c1}/sites`, { name: 'Sede' });
  ctx.site1 = s.data.id;

  const t = await a.post('/api/users', { username: 'tec', name: 'Técnico', role: 'tech', password: 'tec-pass-123', client_ids: [ctx.c1] });
  assert.equal(t.status, 200);
  assert.deepEqual(t.data.client_ids, [ctx.c1]);
  const cu = await a.post('/api/users', { username: 'cli', name: 'Cliente', role: 'client', password: 'cli-pass-123', client_id: ctx.c1 });
  assert.equal(cu.status, 200);
  assert.equal((await a.post('/api/users', { username: 'x', name: 'x', role: 'client', password: 'abcdefgh1' })).status, 400);
});

test('CRUD de ativos com validação e histórico', async () => {
  const a = ctx.admin;
  const meta = (await a.get('/api/meta')).data;
  const tServer = meta.types.find((t) => t.name === 'Servidor').id;
  const tApp = meta.types.find((t) => t.name === 'Aplicação').id;
  ctx.tServer = tServer;

  assert.equal((await a.post('/api/cis', { client_id: ctx.c1, type_id: tServer })).status, 400); // sem nome
  assert.equal((await a.post('/api/cis', { client_id: ctx.c1, type_id: tServer, name: 'X', status: 'inventado' })).status, 400);
  assert.equal((await a.post('/api/cis', { client_id: ctx.c1, type_id: tServer, name: 'X', warranty_end: '31/12/2026' })).status, 400);

  const srv = await a.post('/api/cis', { client_id: ctx.c1, type_id: tServer, name: 'SRV01', site_id: ctx.site1, attributes: { ram_gb: 64 } });
  assert.equal(srv.status, 200, JSON.stringify(srv.data));
  const app = await a.post('/api/cis', { client_id: ctx.c1, type_id: tApp, name: 'ERP' });
  const svc = await a.post('/api/cis', { client_id: ctx.c1, type_id: tApp, name: 'Portal' });
  const other = await a.post('/api/cis', { client_id: ctx.c2, type_id: tServer, name: 'SRV-C2' });
  ctx.srv = srv.data.id; ctx.app = app.data.id; ctx.svc = svc.data.id; ctx.other = other.data.id;

  // local de outro cliente é rejeitado
  assert.equal((await a.post('/api/cis', { client_id: ctx.c2, type_id: tServer, name: 'Y', site_id: ctx.site1 })).status, 400);

  const upd = await a.put(`/api/cis/${ctx.srv}`, { status: 'em_manutencao', ip_address: '10.0.0.1' });
  assert.equal(upd.data.status, 'em_manutencao');
  assert.equal((await a.put(`/api/cis/${ctx.srv}`, { client_id: ctx.c2 })).status, 400);
  const hist = (await a.get(`/api/cis/${ctx.srv}/history`)).data;
  assert.equal(hist[0].action, 'update');
  assert.deepEqual(hist[0].changes.status, ['em_producao', 'em_manutencao']);

  const list = (await a.get(`/api/cis?client=${ctx.c1}&q=srv`)).data;
  assert.equal(list.total, 1);
});

test('relações e análise de impacto', async () => {
  const a = ctx.admin;
  assert.equal((await a.post('/api/relationships', { source_id: ctx.app, target_id: ctx.srv, type: 'corre_em' })).status, 200);
  assert.equal((await a.post('/api/relationships', { source_id: ctx.svc, target_id: ctx.app, type: 'usa' })).status, 200);
  assert.equal((await a.post('/api/relationships', { source_id: ctx.app, target_id: ctx.srv, type: 'corre_em' })).status, 409);
  assert.equal((await a.post('/api/relationships', { source_id: ctx.app, target_id: ctx.other, type: 'usa' })).status, 400);
  // ciclo não deve rebentar a recursão
  await a.post('/api/relationships', { source_id: ctx.srv, target_id: ctx.svc, type: 'ligado_a' });

  const imp = (await a.get(`/api/cis/${ctx.srv}/impact`)).data;
  const names = imp.impacted.map((x) => `${x.name}:${x.depth}`);
  assert.deepEqual(names, ['ERP:1', 'Portal:2']);
  const dep = (await a.get(`/api/cis/${ctx.svc}/impact`)).data.dependencies.map((x) => x.name);
  assert.deepEqual(dep, ['ERP', 'SRV01']);
});

test('isolamento entre clientes (técnico e cliente)', async () => {
  const t = agent();
  await t.login('tec', 'tec-pass-123');
  const list = (await t.get('/api/cis')).data;
  assert.ok(list.items.every((x) => x.client_id === ctx.c1));
  assert.equal((await t.get(`/api/cis/${ctx.other}`)).status, 404);
  assert.equal((await t.get(`/api/clients/${ctx.c2}`)).status, 404);
  assert.equal((await t.post('/api/cis', { client_id: ctx.c2, type_id: ctx.tServer, name: 'Z' })).status, 404);
  assert.equal((await t.post('/api/clients', { name: 'Novo', code: 'NOVO' })).status, 403);
  assert.equal((await t.get('/api/users')).status, 403);
  const csv = await t.get('/api/cis.csv');
  assert.ok(!csv.data.includes('SRV-C2'));
  assert.equal((await t.post('/api/cis', { client_id: ctx.c1, type_id: ctx.tServer, name: 'Pelo técnico' })).status, 200);

  const c = agent();
  await c.login('cli', 'cli-pass-123');
  assert.equal((await c.get(`/api/cis/${ctx.srv}`)).status, 200);
  assert.equal((await c.put(`/api/cis/${ctx.srv}`, { name: 'hack' })).status, 403);
  assert.equal((await c.del(`/api/cis/${ctx.srv}`)).status, 403);
  assert.equal((await c.get(`/api/cis/${ctx.other}`)).status, 404);
  const dash = (await c.get('/api/dashboard')).data;
  assert.equal(dash.totals.clients, 1);
});

test('inventário por agente com reconciliação', async () => {
  const a = ctx.admin;
  const tok = (await a.post(`/api/clients/${ctx.c1}/tokens`, { name: 'teste' })).data.token;
  assert.match(tok, /^cmdb_/);
  const anon = agent();
  assert.equal((await anon.post('/api/ingest', { hostname: 'PC1' }, { Authorization: 'Bearer errado' })).status, 401);

  const auth = { Authorization: `Bearer ${tok}` };
  const r1 = await anon.post('/api/ingest', { hostname: 'PC1', serial_number: 'SN1', type: 'Portátil', attributes: { ram_gb: 16 } }, auth);
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  assert.equal(r1.data.results[0].action, 'created');
  const id = r1.data.results[0].id;

  // mesmo nº de série, hostname mudou → atualiza o mesmo ativo
  const r2 = await anon.post('/api/ingest', { assets: [{ hostname: 'PC1-RENOMEADO', serial_number: 'SN1', attributes: { cpu: 'i7' } }] }, auth);
  assert.deepEqual(r2.data.results[0], { id, action: 'updated' });
  const r3 = await anon.post('/api/ingest', { hostname: 'PC1-RENOMEADO', serial_number: 'SN1' }, auth);
  assert.equal(r3.data.results[0].action, 'unchanged');

  const ci = (await a.get(`/api/cis/${id}`)).data;
  assert.equal(ci.client_id, ctx.c1);
  assert.equal(ci.source, 'agent');
  assert.equal(ci.type_name, 'Portátil');
  assert.deepEqual(ci.attributes, { ram_gb: 16, cpu: 'i7' });
  assert.ok(ci.last_seen);
});

test('proteções: CSRF, content-type, path traversal, cabeçalhos', async () => {
  const a = ctx.admin;
  const cross = await a.post('/api/clients', { name: 'Mau', code: 'MAU' }, { Origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
  const plain = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"username":"admin"}' });
  assert.equal(plain.status, 415);
  const trav = await fetch(base + '/..%2fsrc%2fapp.js');
  assert.equal(trav.status, 404);
  const idx = await fetch(base + '/');
  assert.equal(idx.status, 200);
  assert.match(idx.headers.get('content-security-policy'), /default-src 'self'/);
});

test('eliminar cliente exige confirmação e apaga ativos', async () => {
  const a = ctx.admin;
  assert.equal((await a.del(`/api/clients/${ctx.c2}`)).status, 400);
  assert.equal((await a.del(`/api/clients/${ctx.c2}?confirm=dois`)).status, 200);
  assert.equal((await a.get(`/api/cis/${ctx.other}`)).status, 404);
  const audit = (await a.get('/api/audit?entity=client')).data;
  assert.equal(audit[0].action, 'delete');
});
