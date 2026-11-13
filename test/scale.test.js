'use strict';
/* Escala: índice FTS5, paginação (contratos, auditoria), retenção da auditoria e limite do mapa. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let S;
let a;
let client;
let type;
before(async () => {
  S = await startServer({ appOpts: { auditRetentionDays: 30 } });
  a = S.agent();
  await a.login('admin', 'Admin-pass-123');
  client = (await a.post('/api/clients', { name: 'Escala Lda', code: 'ESC' })).data.id;
  type = (await a.get('/api/meta')).data.types[0].id;
});
after(() => S.close());

test('o índice FTS5 acompanha criações, alterações e eliminações', async () => {
  const id = (await a.post('/api/cis', { client_id: client, type_id: type, name: 'Servidor de Faturação', hostname: 'srv-fat-01', notes: 'sala técnica piso 2' })).data.id;
  const names = async (q) => (await a.get(`/api/cis?q=${encodeURIComponent(q)}`)).data.items.map((c) => c.name);
  assert.deepEqual(await names('faturacao'), ['Servidor de Faturação'], 'sem acentos');
  assert.deepEqual(await names('FAT-0'), ['Servidor de Faturação'], 'parte do hostname');
  assert.deepEqual(await names('tecnica piso'), ['Servidor de Faturação'], 'vários termos nas notas');
  assert.deepEqual(await names('01'), ['Servidor de Faturação'], 'termos curtos usam LIKE');
  await a.put(`/api/cis/${id}`, { name: 'Servidor de Contabilidade' });
  assert.deepEqual(await names('faturacao'), []);
  assert.deepEqual(await names('contabil'), ['Servidor de Contabilidade']);
  await a.del(`/api/cis/${id}`);
  assert.deepEqual(await names('contabil'), []);
  assert.equal((await a.get('/api/search?q=contabil')).data.cis.length, 0);
});

test('contratos paginados, com total e custo anual do conjunto completo', async () => {
  for (let i = 0; i < 7; i++) await a.post('/api/contracts', { client_id: client, name: `Contrato ${i}`, cost: 10, billing: 'mensal', end_date: `2027-01-0${i + 1}` });
  const p1 = (await a.get('/api/contracts?limit=3&offset=0')).data;
  const p3 = (await a.get('/api/contracts?limit=3&offset=6')).data;
  assert.equal(p1.total, 7);
  assert.equal(p1.items.length, 3);
  assert.equal(p3.items.length, 1);
  assert.equal(p1.annual_cost, 7 * 120, 'custo de todos, não só da página');
  assert.deepEqual(p1.items.map((k) => k.name), ['Contrato 0', 'Contrato 1', 'Contrato 2']);
});

test('auditoria paginada por cursor e retenção configurável', async () => {
  const first = (await a.get('/api/audit?limit=5')).data;
  assert.equal(first.length, 5);
  const next = (await a.get(`/api/audit?limit=5&before=${first[4].id}`)).data;
  assert.ok(next.length > 0 && next.every((e) => e.id < first[4].id));
  S.db.prepare("INSERT INTO audit (entity, actor, action, org_id, created_at) VALUES ('ci', 'antigo', 'update', 1, datetime('now', '-40 days'))").run();
  assert.equal(S.app.purgeAudit(new Date(2030, 0, 1)), 1, 'remove o evento com mais de 30 dias');
  assert.equal(S.app.purgeAudit(new Date(2030, 0, 1)), null, 'só uma vez por dia');
  assert.ok(!(await a.get('/api/audit?limit=1000')).data.some((e) => e.actor === 'antigo'));
});

test('o mapa de um cliente avisa quando tem de cortar ativos', async () => {
  const ins = S.db.prepare('INSERT INTO cis (client_id, type_id, name) VALUES (?, ?, ?)');
  const rel = S.db.prepare("INSERT INTO relationships (source_id, target_id, type) VALUES (?, ?, 'depende_de')");
  S.db.exec('BEGIN');
  const hub = Number(ins.run(client, type, 'HUB').lastInsertRowid);
  for (let i = 0; i < 805; i++) rel.run(Number(ins.run(client, type, `N-${String(i).padStart(4, '0')}`).lastInsertRowid), hub);
  S.db.exec('COMMIT');
  const g = (await a.get(`/api/clients/${client}/graph`)).data;
  assert.equal(g.truncated, true);
  assert.equal(g.nodes.length, 800);
});
