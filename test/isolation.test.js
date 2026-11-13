'use strict';
/*
 * Isolamento entre organizações (SaaS). Percorre TODAS as rotas registadas na aplicação — incluindo as que
 * forem acrescentadas no futuro — com o administrador da organização B, apontando para recursos da
 * organização A. Nenhuma pode devolver dados de A nem alterá-los.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const MARK = 'ALVO-ORG-A';
let S;
const A = {};
const B = {};

before(async () => {
  S = await startServer(); // organização 1 (A), admin da plataforma
  const a = S.agent();
  await a.login('admin', 'Admin-pass-123');
  A.agent = a;
  A.client = (await a.post('/api/clients', { name: `${MARK} Cliente`, code: 'ALVO' })).data.id;
  A.site = (await a.post(`/api/clients/${A.client}/sites`, { name: `${MARK} Sede` })).data.id;
  const type = (await a.get('/api/meta')).data.types[0].id;
  A.ci = (await a.post('/api/cis', { client_id: A.client, type_id: type, name: `${MARK} SRV-1`, hostname: 'alvo-srv-1', serial_number: 'ALVO-SN-1' })).data.id;
  A.ci2 = (await a.post('/api/cis', { client_id: A.client, type_id: type, name: `${MARK} SRV-2` })).data.id;
  A.rel = (await a.post('/api/relationships', { source_id: A.ci2, target_id: A.ci, type: 'depende_de' })).data.id;
  A.contract = (await a.post('/api/contracts', { client_id: A.client, name: `${MARK} Contrato`, ci_ids: [A.ci] })).data.id;
  A.ticket = (await a.post(`/api/cis/${A.ci}/tickets`, { system: 'GLPI', external_id: '1', title: `${MARK} Ticket` })).data.id;
  const tok = (await a.post(`/api/clients/${A.client}/tokens`, { name: `${MARK} Token` })).data;
  A.token = tok.id;
  A.tokenValue = tok.token;
  A.user = (await a.post('/api/users', { username: 'alvo.tec', name: `${MARK} Técnico`, role: 'tech', password: 'Tecnico-alvo-26', client_ids: [A.client] })).data.id;

  // Organização B, criada pela plataforma
  const org = await a.post('/api/platform/orgs', { name: 'Outra Lda', admin_username: 'admin.b', admin_name: 'Admin B', admin_password: 'Inicial-B-2026' });
  assert.equal(org.status, 200, JSON.stringify(org.data));
  B.org = org.data.id;
  const b = S.agent();
  await b.login('admin.b', 'Inicial-B-2026');
  assert.equal((await b.post('/api/me/password', { current: 'Inicial-B-2026', password: 'Pessoal-B-2026' })).status, 200);
  B.agent = b;
  B.client = (await b.post('/api/clients', { name: 'Cliente B', code: 'BEE' })).data.id;
  B.tokenValue = (await b.post(`/api/clients/${B.client}/tokens`, { name: 'Token B' })).data.token;
  A.org = (await a.get('/api/me')).data.org_id;
});
after(() => S.close());

/** Substitui os parâmetros da rota por ids de recursos da organização A. */
function pathFor(pattern) {
  const base = pattern.split('/')[2];
  const byBase = { clients: A.client, cis: A.ci, contracts: A.contract, relationships: A.rel, sites: A.site, tokens: A.token, users: A.user, platform: A.org };
  return pattern
    .replace(':ticketId', A.ticket)
    .replace(':id', byBase[base] ?? A.ci);
}
const bodyForA = () => ({
  client_id: A.client, source_id: A.ci, target_id: A.ci2, type: 'depende_de', ci_ids: [A.ci], client_ids: [A.client],
  name: 'Tentativa', code: 'TENT', system: 'GLPI', external_id: '2', rows: [{ Nome: 'x' }], dry_run: true,
});
const SKIP = new Set(['POST /api/logout', 'POST /api/signup', 'POST /api/login', 'POST /api/login/mfa']);

test('nenhuma rota dá à organização B acesso aos dados da organização A', async () => {
  const leaks = [];
  for (const r of S.app.routes) {
    const key = `${r.method} ${r.pattern}`;
    if (SKIP.has(key) || r.flags.token) continue;
    const hasParams = r.pattern.includes(':');
    const path = pathFor(r.pattern);
    const res = r.method === 'GET' ? await B.agent.get(path)
      : r.method === 'DELETE' ? await B.agent.del(path)
        : r.method === 'PUT' ? await B.agent.put(path, bodyForA())
          : await B.agent.post(path, bodyForA());
    const text = typeof res.data === 'string' ? res.data : Buffer.isBuffer(res.data) ? res.data.toString('latin1') : JSON.stringify(res.data);
    if (text.includes(MARK)) leaks.push(`${key} → ${res.status}: devolveu dados de A`);
    if (hasParams && res.status < 400) leaks.push(`${key} → ${res.status}: aceitou um recurso de A`);
  }
  assert.deepEqual(leaks, []);
});

test('os dados de A ficaram intactos', async () => {
  const a = A.agent;
  assert.equal((await a.get(`/api/clients/${A.client}`)).data.name, `${MARK} Cliente`);
  assert.equal((await a.get(`/api/cis/${A.ci}`)).data.outgoing.length + (await a.get(`/api/cis/${A.ci}`)).data.incoming.length, 1);
  assert.equal((await a.get(`/api/contracts/${A.contract}`)).status, 200);
  assert.equal((await a.get(`/api/cis/${A.ci}/tickets`)).data.length, 1);
  assert.equal((await a.get(`/api/clients/${A.client}`)).data.tokens.length, 1);
  assert.ok((await a.get('/api/users')).data.some((u) => u.id === A.user));
  assert.equal((await a.get(`/api/cis?client=${A.client}`)).data.total, 2);
});

test('listas, pesquisa e auditoria de B não mostram nada de A', async () => {
  const b = B.agent;
  for (const p of ['/api/clients', '/api/cis', '/api/contracts', '/api/tickets', '/api/users', '/api/audit', '/api/dashboard', '/api/search?q=alvo', '/api/system']) {
    const r = await b.get(p);
    assert.equal(r.status, 200, p);
    assert.ok(!JSON.stringify(r.data).includes(MARK), `${p} mostra dados de A`);
  }
  assert.equal((await b.get('/api/system')).data.counts.clients, (await b.get('/api/clients')).data.length, 'contagens só da própria organização');
  // A organização B não gere a plataforma
  assert.equal((await b.get('/api/platform/orgs')).status, 403);
  assert.equal((await b.post('/api/system/backups')).status, 403);
});

test('os tokens de integração ficam presos à organização (e ao cliente) a que pertencem', async () => {
  const auth = { Authorization: `Bearer ${B.tokenValue}` };
  const look = await S.agent().get('/api/integrations/cis?q=alvo-srv', auth);
  assert.equal(look.status, 200);
  assert.deepEqual(look.data, []);
  const t = await S.agent().post('/api/integrations/tickets', { system: 'GLPI', external_id: '99', cis: [{ hostname: 'alvo-srv-1' }, { id: A.ci }] }, auth);
  assert.equal(t.status, 200);
  assert.deepEqual(t.data.cis, [], 'não liga ativos de A');
  const ing = await S.agent().post('/api/ingest', { hostname: 'alvo-srv-1', serial_number: 'ALVO-SN-1', name: 'novo' }, auth);
  assert.equal(ing.status, 200);
  assert.equal((await A.agent.get(`/api/cis/${A.ci}`)).data.name, `${MARK} SRV-1`, 'não altera o ativo de A com o mesmo nº de série');
});

test('organização suspensa perde o acesso de imediato; a plataforma reativa', async () => {
  assert.equal((await A.agent.put(`/api/platform/orgs/${B.org}`, { status: 'suspended' })).status, 200);
  assert.equal((await B.agent.get('/api/clients')).status, 401);
  const relogin = await S.agent().post('/api/login', { username: 'admin.b', password: 'Pessoal-B-2026' });
  assert.equal(relogin.status, 403);
  assert.match(relogin.data.error, /suspenso/);
  assert.equal((await A.agent.put(`/api/platform/orgs/${A.org}`, { status: 'suspended' })).status, 400, 'não suspende a própria');
  assert.equal((await A.agent.put(`/api/platform/orgs/${B.org}`, { status: 'active', max_clients: 1 })).status, 200);
  const b = S.agent();
  await b.login('admin.b', 'Pessoal-B-2026');
  const over = await b.post('/api/clients', { name: 'Segundo', code: 'SEG' });
  assert.equal(over.status, 402, 'limite do plano');
  assert.match(over.data.error, /no máximo 1 clientes/);
});

test('o mesmo código de cliente pode existir em organizações diferentes', async () => {
  const b = S.agent();
  await b.login('admin.b', 'Pessoal-B-2026');
  await A.agent.put(`/api/platform/orgs/${B.org}`, { max_clients: null });
  assert.equal((await b.post('/api/clients', { name: `${MARK} Cliente`, code: 'ALVO' })).status, 200);
  assert.equal((await A.agent.post('/api/clients', { name: `${MARK} Cliente`, code: 'ALVO' })).status, 409, 'mas não na mesma');
});
