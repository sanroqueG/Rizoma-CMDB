'use strict';
/* Tipos de ativo por organização: tipos base comuns e read-only, tipos próprios invisíveis para as outras organizações. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let S;
let A;
let B;
let clientA;
let clientB;
before(async () => {
  S = await startServer({ appOpts: { signup: true } });
  A = S.agent();
  await A.login('admin', 'Admin-pass-123');
  B = S.agent();
  assert.equal((await B.post('/api/signup', { organization: 'Outra', name: 'Olga', username: 'olga', email: 'olga@outra.pt', password: 'Outra-org-2026' })).status, 200);
  clientA = (await A.post('/api/clients', { name: 'Cliente A', code: 'CA' })).data.id;
  clientB = (await B.post('/api/clients', { name: 'Cliente B', code: 'CB' })).data.id;
});
after(() => S.close());

test('a organização cria tipos próprios; as outras não os veem nem usam', async () => {
  const r = await A.post('/api/types', { name: 'Câmara IP', category: 'Segurança', fields: ['Resolução', 'ip-gestao', 'ip_gestao'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.fields, ['resolucao', 'ip_gestao'], 'normaliza acentos, hífenes e repetidos');
  const cam = r.data.id;

  const metaA = (await A.get('/api/meta')).data.types;
  const metaB = (await B.get('/api/meta')).data.types;
  assert.ok(metaA.some((t) => t.id === cam && !t.builtin));
  assert.ok(!metaB.some((t) => t.id === cam), 'invisível para a outra organização');
  assert.ok(metaB.some((t) => t.name === 'Servidor' && t.builtin), 'tipos base para todos');

  assert.equal((await A.post('/api/cis', { client_id: clientA, type_id: cam, name: 'CAM-01' })).status, 200);
  assert.equal((await B.post('/api/cis', { client_id: clientB, type_id: cam, name: 'CAM-X' })).status, 400, 'não usa tipos de outra organização');

  // A outra organização pode ter um tipo com o mesmo nome
  assert.equal((await B.post('/api/types', { name: 'Câmara IP', category: 'Vídeo' })).status, 200);
  assert.equal((await B.put(`/api/types/${cam}`, { name: 'Roubado', category: 'x' })).status, 404);
  assert.equal((await B.del(`/api/types/${cam}`)).status, 404);
});

test('regras: nomes únicos, campos válidos, base read-only, eliminação só sem ativos', async () => {
  const types = (await A.get('/api/types')).data;
  const servidor = types.find((t) => t.name === 'Servidor');
  const cam = types.find((t) => t.name === 'Câmara IP');
  assert.equal(cam.cis, 1, 'conta os ativos');

  assert.equal((await A.post('/api/types', { name: 'servidor', category: 'x' })).status, 409, 'colide com um tipo base');
  assert.equal((await A.post('/api/types', { name: 'CÂMARA IP', category: 'x' })).status, 409);
  assert.equal((await A.post('/api/types', { name: 'UPS', category: 'Energia', fields: ['carga %'] })).status, 400);
  assert.equal((await A.put(`/api/types/${servidor.id}`, { name: 'Servidor', category: 'Outra' })).status, 403);
  assert.equal((await A.del(`/api/types/${servidor.id}`)).status, 403);
  assert.equal((await S.agent().get('/api/types')).status, 401);

  assert.equal((await A.del(`/api/types/${cam.id}`)).status, 409, 'tem ativos');
  const tech = await A.post('/api/users', { username: 'tec', name: 'Téc', role: 'tech', password: 'Tecnico-2026x' });
  assert.equal(tech.status, 200);
  const t = S.agent();
  await t.login('tec', 'Tecnico-2026x');
  assert.equal((await t.post('/api/types', { name: 'Y', category: 'y' })).status, 403, 'só administradores');

  const ups = (await A.post('/api/types', { name: 'UPS', category: 'Energia', fields: ['autonomia_min'] })).data.id;
  assert.equal((await A.put(`/api/types/${ups}`, { name: 'UPS / no-break', category: 'Energia', fields: ['autonomia_min', 'baterias'] })).status, 200);
  assert.equal((await A.del(`/api/types/${ups}`)).status, 200);
  const log = (await A.get('/api/audit?limit=20')).data.filter((e) => e.entity === 'ci_type').map((e) => e.action);
  assert.deepEqual(log.slice(0, 3), ['delete', 'update', 'create']);
});

test('a importação reconhece os tipos próprios da organização', async () => {
  const r = await A.post('/api/import', { client_id: clientA, rows: [{ Nome: 'CAM-02', Tipo: 'câmara ip' }], dry_run: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.summary.errors, 0, JSON.stringify(r.data.results));
});
