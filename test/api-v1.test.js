'use strict';
/* API pública v1: caminhos versionados, obsolescência dos antigos, permissões dos tokens, OpenAPI e validação. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let S;
let a;
let client;
const tok = {};
before(async () => {
  S = await startServer();
  a = S.agent();
  await a.login('admin', 'Admin-pass-123');
  client = (await a.post('/api/clients', { name: 'API Lda', code: 'API' })).data.id;
  tok.both = (await a.post(`/api/clients/${client}/tokens`, { name: 'Tudo' })).data;
  tok.ingest = (await a.post(`/api/clients/${client}/tokens`, { name: 'Agentes', scopes: ['ingest'] })).data;
  tok.tickets = (await a.post(`/api/clients/${client}/tokens`, { name: 'GLPI', scopes: ['tickets'] })).data;
});
after(() => S.close());
const bearer = (t) => ({ Authorization: `Bearer ${t.token}` });

test('caminhos /api/v1 para as integrações; os antigos indicam o sucessor', async () => {
  const v1 = await S.agent().post('/api/v1/ingest', { hostname: 'PC-V1', serial_number: 'SN-V1' }, bearer(tok.both));
  assert.equal(v1.status, 200, JSON.stringify(v1.data));
  assert.equal(v1.headers.get('deprecation'), null);
  const old = await S.agent().post('/api/ingest', { hostname: 'PC-OLD' }, bearer(tok.both));
  assert.equal(old.status, 200);
  assert.equal(old.headers.get('deprecation'), 'true');
  assert.match(old.headers.get('link'), /<\/api\/v1\/ingest>; rel="successor-version"/);
  // as rotas internas da aplicação não existem em /api/v1
  assert.equal((await a.get('/api/v1/clients')).status, 404);
});

test('cada token só faz o que as suas permissões permitem', async () => {
  assert.deepEqual(tok.both.scopes, ['ingest', 'tickets']);
  const t1 = await S.agent().post('/api/v1/integrations/tickets', { system: 'GLPI', external_id: '1' }, bearer(tok.ingest));
  assert.equal(t1.status, 403);
  assert.match(t1.data.error, /permissão "tickets"/);
  assert.equal((await S.agent().post('/api/v1/ingest', { hostname: 'X' }, bearer(tok.tickets))).status, 403);
  assert.equal((await S.agent().get('/api/v1/integrations/cis?q=pc-v1', bearer(tok.tickets))).status, 200);
  assert.equal((await S.agent().post('/api/v1/integrations/tickets', { system: 'GLPI', external_id: '1' }, bearer(tok.tickets))).status, 200);
  assert.equal((await a.post(`/api/clients/${client}/tokens`, { name: 'X', scopes: ['admin'] })).status, 400);
});

test('validação declarativa: erros consistentes e campos desconhecidos descartados', async () => {
  const bad = await S.agent().post('/api/v1/integrations/tickets', { system: 'GLPI' }, bearer(tok.tickets));
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'ID do ticket é obrigatório');
  assert.equal((await S.agent().post('/api/v1/ingest', { assets: 'não é lista' }, bearer(tok.ingest))).status, 400);
  assert.equal((await S.agent().post('/api/v1/ingest', { assets: Array(501).fill({ hostname: 'x' }) }, bearer(tok.ingest))).status, 400);
  const type = (await a.get('/api/meta')).data.types[0].id;
  assert.equal((await a.post('/api/cis', { client_id: client, type_id: type, name: 'X', status: 'inventado' })).data.error, 'Estado inválido');
  assert.equal((await a.post('/api/cis', { client_id: client, type_id: type, name: 'X', warranty_end: '31/12/2027' })).data.error, 'Fim de garantia deve ter o formato AAAA-MM-DD');
  const ok = await a.post('/api/cis', { client_id: client, type_id: type, name: 'Com lixo', inventado: 'x', id: 999 });
  assert.equal(ok.status, 200);
  assert.notEqual(ok.data.id, 999, 'campos não declarados (incluindo id) são ignorados');
  assert.equal((await a.post('/api/contracts', { client_id: client, name: 'C', cost: 'muito' })).data.error, 'Custo inválido');
});

test('OpenAPI gerado a partir das rotas', async () => {
  const r = await S.agent().get('/api/v1/openapi.json');
  assert.equal(r.status, 200);
  const spec = r.data;
  assert.equal(spec.openapi, '3.1.0');
  assert.deepEqual(Object.keys(spec.paths).sort(), ['/api/v1/ingest', '/api/v1/integrations/cis', '/api/v1/integrations/tickets']);
  const ticket = spec.paths['/api/v1/integrations/tickets'].post;
  assert.equal(ticket['x-rizoma-scope'], 'tickets');
  assert.deepEqual(ticket.requestBody.content['application/json'].schema.required, ['system', 'external_id']);
  assert.equal(spec.paths['/api/v1/integrations/cis'].get.parameters[0].name, 'q');
  assert.equal(spec.components.securitySchemes.token.scheme, 'bearer');
});
