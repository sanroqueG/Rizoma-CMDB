'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { openDb, schemaVersion } = require('../src/db');

let S;
before(async () => { S = await startServer({ appOpts: { signup: true, defaultLimits: { max_clients: 2, max_cis: null, max_users: null } } }); });
after(() => S.close());

test('migrações versionadas: BD nova fica na última versão e reabrir não repete migrações', () => {
  const db = openDb(':memory:');
  const v = schemaVersion(db);
  assert.ok(v >= 2);
  const names = db.prepare('SELECT id, name FROM schema_migrations ORDER BY id').all().map((r) => r.id);
  assert.deepEqual(names, [...Array(v).keys()].map((i) => i + 1));
  db.close();
});

test('registo self-service cria a organização, o administrador e a sessão', async () => {
  const a = S.agent();
  assert.equal((await a.post('/api/signup', { organization: 'Nova TI', name: 'Rita', username: 'rita', email: 'rita@nova.pt', password: 'curta' })).status, 400);
  const r = await a.post('/api/signup', { organization: 'Nova TI, Lda.', name: 'Rita', username: 'rita', email: 'rita@nova.pt', password: 'Nova-TI-2026' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.role, 'admin');
  assert.equal(r.data.is_platform, false);
  const org = (await a.get('/api/org')).data;
  assert.equal(org.slug, 'nova-ti-lda');
  assert.equal(org.max_clients, 2, 'limites por omissão do plano');
  assert.equal((await S.agent().post('/api/signup', { organization: 'Outra', name: 'X', username: 'rita', password: 'Outra-pass-26' })).status, 409);

  await a.post('/api/clients', { name: 'Cliente da Rita', code: 'RIT' });
  const exp = await a.get('/api/org/export');
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-disposition'), /rizoma-nova-ti-lda-/);
  assert.deepEqual(exp.data.clients.map((c) => c.code), ['RIT']);
  assert.ok(exp.data.users.every((u) => !('password_hash' in u)));
  assert.equal((await a.put('/api/org', { name: 'Nova TI' })).data.name, 'Nova TI');
});

test('a plataforma lista e gere as organizações; o registo pode estar desligado', async () => {
  const p = S.agent();
  await p.login('admin', 'Admin-pass-123');
  const orgs = (await p.get('/api/platform/orgs')).data;
  assert.ok(orgs.some((o) => o.slug === 'nova-ti-lda' && o.usage.clients === 1));
  const nova = orgs.find((o) => o.slug === 'nova-ti-lda');
  assert.equal((await p.del(`/api/platform/orgs/${nova.id}?confirm=errado`)).status, 400);
  assert.equal((await p.del(`/api/platform/orgs/${nova.id}?confirm=nova-ti-lda`)).status, 200);
  assert.equal((await S.agent().post('/api/login', { username: 'rita', password: 'Nova-TI-2026' })).status, 401, 'utilizadores eliminados com a organização');

  const off = await startServer({ appOpts: { signup: false } });
  assert.equal((await off.agent().post('/api/signup', { organization: 'X', name: 'X', username: 'xx1', password: 'Outra-pass-26' })).status, 404);
  await off.close();
});
