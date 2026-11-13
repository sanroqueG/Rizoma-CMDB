'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let S;
const X = {};
before(async () => {
  S = await startServer();
  const a = S.agent();
  await a.login('admin', 'Admin-pass-123');
  X.admin = a;
  X.c1 = (await a.post('/api/clients', { name: 'Contratos Um', code: 'CT1' })).data.id;
  X.c2 = (await a.post('/api/clients', { name: 'Contratos Dois', code: 'CT2' })).data.id;
  const type = (await a.get('/api/meta')).data.types.find((t) => t.name === 'Firewall').id;
  X.fw1 = (await a.post('/api/cis', { client_id: X.c1, type_id: type, name: 'FW-01' })).data.id;
  X.fw2 = (await a.post('/api/cis', { client_id: X.c2, type_id: type, name: 'FW-OUTRO' })).data.id;
  await a.post('/api/users', { username: 'tec.ct', name: 'Téc', role: 'tech', password: 'Tecnico-ct-2026', client_ids: [X.c1] });
  await a.post('/api/users', { username: 'cli.ct', name: 'Cli', role: 'client', password: 'Cliente-ct-2026', client_id: X.c1 });
});
after(() => S.close());

const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

test('criar, consultar, alterar e eliminar um contrato', async () => {
  const a = X.admin;
  const bad = await a.post('/api/contracts', { client_id: X.c1, name: 'X', start_date: '2026-05-01', end_date: '2026-01-01' });
  assert.equal(bad.status, 400);
  assert.equal((await a.post('/api/contracts', { client_id: X.c1, name: 'X', kind: 'inventado' })).status, 400);

  const r = await a.post('/api/contracts', {
    client_id: X.c1, name: 'FortiCare 24x7', kind: 'suporte', vendor: 'Fortinet', reference: 'FC-123',
    start_date: day(-300), end_date: day(65), notice_days: 30, cost: '125,50', billing: 'mensal', ci_ids: [X.fw1],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.cost, 125.5);
  assert.equal(r.data.annual_cost, 1506);
  assert.equal(r.data.ci_count, 1);
  X.k1 = r.data.id;

  const full = (await a.get(`/api/contracts/${X.k1}`)).data;
  assert.deepEqual(full.cis.map((c) => c.name), ['FW-01']);
  assert.equal((await a.get(`/api/cis/${X.fw1}/contracts`)).data[0].name, 'FortiCare 24x7');

  // Não liga ativos de outro cliente
  assert.equal((await a.put(`/api/contracts/${X.k1}`, { ci_ids: [X.fw1, X.fw2] })).status, 400);
  assert.equal((await a.put(`/api/contracts/${X.k1}`, { client_id: X.c2 })).status, 400);

  const up = await a.put(`/api/contracts/${X.k1}`, { billing: 'anual', cost: 1400, auto_renew: true });
  assert.equal(up.data.annual_cost, 1400);
  assert.equal(up.data.auto_renew, true);
  const hist = (await a.get(`/api/contracts/${X.k1}`)).data.history;
  assert.equal(hist[0].action, 'update');
  assert.deepEqual(hist[0].changes.billing, ['mensal', 'anual']);
});

test('renovações: filtro de contratos a terminar (com pré-aviso) e total anual', async () => {
  const a = X.admin;
  await a.post('/api/contracts', { client_id: X.c1, name: 'Microsoft 365 E3', kind: 'subscricao', end_date: day(300), cost: 30, billing: 'mensal' });
  await a.post('/api/contracts', { client_id: X.c2, name: 'Antivírus', kind: 'licenca', end_date: day(20), cost: 900, billing: 'anual' });
  await a.post('/api/contracts', { client_id: X.c2, name: 'Antigo', kind: 'licenca', status: 'terminado', end_date: day(-20), cost: 50, billing: 'mensal' });

  const soon = (await a.get('/api/contracts?expiring=60')).data.items.map((c) => c.name).sort();
  // FortiCare termina em 65 dias mas tem 30 dias de pré-aviso → entra; o terminado não entra
  assert.deepEqual(soon, ['Antivírus', 'FortiCare 24x7']);
  const c1 = (await a.get(`/api/contracts?client=${X.c1}`)).data;
  assert.equal(c1.annual_cost, 1400 + 360);
  assert.equal((await a.get('/api/contracts?q=forti')).data.total, 1);
});

test('isolamento por cliente e permissões', async () => {
  const t = S.agent();
  await t.login('tec.ct', 'Tecnico-ct-2026');
  const mine = (await t.get('/api/contracts')).data.items;
  assert.ok(mine.every((c) => c.client_id === X.c1));
  const other = (await X.admin.get(`/api/contracts?client=${X.c2}`)).data.items[0];
  assert.equal((await t.get(`/api/contracts/${other.id}`)).status, 404);
  assert.equal((await t.post('/api/contracts', { client_id: X.c2, name: 'Y' })).status, 404);
  assert.equal((await t.post('/api/contracts', { client_id: X.c1, name: 'Do técnico' })).status, 200);

  const c = S.agent();
  await c.login('cli.ct', 'Cliente-ct-2026');
  assert.equal((await c.get(`/api/contracts/${X.k1}`)).status, 200);
  assert.equal((await c.put(`/api/contracts/${X.k1}`, { name: 'Z' })).status, 403);
  assert.equal((await c.del(`/api/contracts/${X.k1}`)).status, 403);
});

test('eliminar um ativo remove a ligação; eliminar o contrato fica na auditoria', async () => {
  const a = X.admin;
  await a.del(`/api/cis/${X.fw1}`);
  assert.equal((await a.get(`/api/contracts/${X.k1}`)).data.ci_count, 0);
  assert.equal((await a.del(`/api/contracts/${X.k1}`)).status, 200);
  assert.equal((await a.get(`/api/contracts/${X.k1}`)).status, 404);
  assert.ok((await a.get('/api/audit?entity=contract')).data.some((e) => e.action === 'delete' && e.entity_id === X.k1));
});
