'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { startServer } = require('./helpers');

let S;
const X = {};
before(async () => {
  S = await startServer();
  const a = S.agent();
  await a.login('admin', 'Admin-pass-123');
  X.admin = a;
  X.c1 = (await a.post('/api/clients', { name: 'Integra Lda', code: 'INT', contact_name: 'Rui' })).data.id;
  X.c2 = (await a.post('/api/clients', { name: 'Outro SA', code: 'OUT' })).data.id;
  const types = Object.fromEntries((await a.get('/api/meta')).data.types.map((t) => [t.name, t.id]));
  const ci = async (client, body) => (await a.post('/api/cis', { client_id: client, ...body })).data.id;
  X.srv = await ci(X.c1, { type_id: types.Servidor, name: 'SRV-ERP', hostname: 'srv-erp', serial_number: 'SN-ERP-1', criticality: 'alta', warranty_end: '2020-01-01' });
  X.app = await ci(X.c1, { type_id: types['Aplicação'], name: 'ERP Primavera', criticality: 'critica' });
  X.svc = await ci(X.c1, { type_id: types['Serviço de negócio'], name: 'Faturação' });
  X.pc = await ci(X.c1, { type_id: types['Portátil'], name: 'PC-RUI', model: 'ThinkPad X1 Carbon', notes: 'portátil do diretor' });
  X.foreign = await ci(X.c2, { type_id: types.Servidor, name: 'SRV-ERP-OUTRO', hostname: 'srv-erp' });
  await a.post('/api/relationships', { source_id: X.app, target_id: X.srv, type: 'corre_em' });
  await a.post('/api/relationships', { source_id: X.svc, target_id: X.app, type: 'depende_de' });
  await a.post('/api/contracts', { client_id: X.c1, name: 'Suporte Primavera', vendor: 'Primavera BSS', cost: 100, billing: 'mensal', end_date: '2026-12-31' });
  X.token = (await a.post(`/api/clients/${X.c1}/tokens`, { name: 'GLPI' })).data.token;
  await a.post('/api/users', { username: 'tec.out', name: 'Téc Outro', role: 'tech', password: 'Tecnico-out-2026', client_ids: [X.c2] });
});
after(() => S.close());

/** Lê as entradas de um ZIP (para validar o .xlsx). */
function unzip(buf) {
  const out = {};
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const off = buf.readUInt32LE(p + 42);
    const size = buf.readUInt32LE(p + 20);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const data = zlib.inflateRawSync(buf.subarray(start, start + size));
    assert.equal(zlib.crc32(data), buf.readUInt32LE(p + 16), `CRC de ${name}`);
    out[name] = data.toString('utf8');
    p += 46 + nameLen + extra;
  }
  return out;
}

test('relatório do cliente (JSON) e exportação Excel', async () => {
  const r = (await X.admin.get(`/api/clients/${X.c1}/report`)).data;
  assert.equal(r.client.code, 'INT');
  assert.equal(r.totals.cis, 4);
  assert.equal(r.totals.annual_cost, 1200);
  assert.equal(r.warranties[0].name, 'SRV-ERP');
  assert.equal(r.relationship_count, 2);

  const x = await X.admin.get(`/api/clients/${X.c1}/report.xlsx`);
  assert.equal(x.status, 200);
  assert.match(x.headers.get('content-disposition'), /relatorio-INT-\d{4}-\d{2}-\d{2}\.xlsx/);
  const files = unzip(x.data);
  assert.ok(files['[Content_Types].xml'] && files['xl/workbook.xml']);
  assert.match(files['xl/workbook.xml'], /name="Resumo".*name="Ativos".*name="Contratos"/s);
  assert.match(files['xl/worksheets/sheet2.xml'], /SRV-ERP/);
  assert.doesNotMatch(files['xl/worksheets/sheet2.xml'], /SRV-ERP-OUTRO/, 'só dados do cliente');
  assert.match(files['xl/worksheets/sheet3.xml'], /Suporte Primavera/);
  assert.match(files['xl/worksheets/sheet5.xml'], /ERP Primavera.*corre em.*SRV-ERP/s);

  const t = S.agent();
  await t.login('tec.out', 'Tecnico-out-2026');
  assert.equal((await t.get(`/api/clients/${X.c1}/report.xlsx`)).status, 404);
});

test('webhook de tickets: cria, liga ativos por hostname/nº de série e devolve o impacto', async () => {
  const auth = { Authorization: `Bearer ${X.token}` };
  assert.equal((await S.agent().post('/api/integrations/tickets', { system: 'GLPI', external_id: '1' })).status, 401);

  const r = await S.agent().post('/api/integrations/tickets', {
    system: 'GLPI', external_id: '4711', title: 'ERP não arranca', status: 'Novo', priority: 'Alta',
    url: 'https://glpi.integra.pt/front/ticket.form.php?id=4711',
    cis: [{ hostname: 'SRV-ERP' }, { serial_number: 'nao-existe' }, 'PC-RUI'],
  }, auth);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.created, true);
  assert.deepEqual(r.data.cis.map((c) => c.name), ['SRV-ERP', 'PC-RUI']);
  const srv = r.data.cis[0];
  assert.equal(srv.id, X.srv, 'não liga o ativo com o mesmo hostname de outro cliente');
  assert.equal(srv.impacted_count, 2);
  assert.equal(srv.max_criticality, 'critica');
  assert.deepEqual(r.data.unmatched, [{ serial_number: 'nao-existe' }]);
  assert.equal((await S.agent().post('/api/integrations/tickets', { system: 'GLPI', external_id: '1', url: 'javascript:alert(1)' }, auth)).status, 400);

  // Atualização: fecha o ticket
  const u = await S.agent().post('/api/integrations/tickets', { system: 'GLPI', external_id: '4711', status: 'Resolvido' }, auth);
  assert.equal(u.data.created, false);
  assert.equal(u.data.ticket.closed, true);
  assert.equal(u.data.ticket.title, 'ERP não arranca', 'mantém os campos não enviados');

  const onCi = (await X.admin.get(`/api/cis/${X.srv}/tickets`)).data;
  assert.equal(onCi.length, 1);
  assert.equal(onCi[0].external_id, '4711');
  assert.equal((await X.admin.get(`/api/tickets?client=${X.c1}&open=1`)).data.length, 0);
});

test('consulta de ativos pela ferramenta de tickets', async () => {
  const auth = { Authorization: `Bearer ${X.token}` };
  const r = await S.agent().get('/api/integrations/cis?q=srv-erp', auth);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.map((c) => c.name), ['SRV-ERP']);
  assert.equal(r.data[0].impacted_count, 2);
  assert.equal((await S.agent().get('/api/integrations/cis?q=x', auth)).status, 400);
});

test('tickets ligados manualmente na interface', async () => {
  const a = X.admin;
  const t = await a.post(`/api/cis/${X.app}/tickets`, { system: 'Jira', external_id: 'SUP-12', title: 'Lentidão', url: 'https://x.atlassian.net/browse/SUP-12' });
  assert.equal(t.status, 200);
  assert.equal(t.data.closed, false);
  assert.equal((await a.get(`/api/tickets?open=1`)).data.length, 1);
  const tech = S.agent();
  await tech.login('tec.out', 'Tecnico-out-2026');
  assert.equal((await tech.post(`/api/cis/${X.app}/tickets`, { system: 'Jira', external_id: 'X' })).status, 404);
  assert.equal((await tech.get('/api/tickets')).data.length, 0);
  assert.equal((await a.del(`/api/cis/${X.app}/tickets/${t.data.id}`)).status, 200);
  assert.equal((await a.get('/api/tickets')).data.some((x) => x.external_id === 'SUP-12'), false, 'ticket sem ativos é removido');
});

test('pesquisa global com âmbito por cliente', async () => {
  const a = X.admin;
  const r = (await a.get('/api/search?q=srv-erp')).data;
  assert.equal(r.cis[0].name, 'SRV-ERP', 'correspondência exata do hostname primeiro');
  assert.equal(r.cis.length, 2);
  assert.deepEqual((await a.get('/api/search?q=carbon')).data.cis.map((c) => c.name), ['PC-RUI'], 'pesquisa no modelo');
  assert.deepEqual((await a.get('/api/search?q=diretor')).data.cis.map((c) => c.name), ['PC-RUI'], 'pesquisa nas notas');
  assert.equal((await a.get('/api/search?q=primavera')).data.contracts[0].name, 'Suporte Primavera');
  assert.equal((await a.get('/api/search?q=4711')).data.tickets[0].external_id, '4711');
  assert.equal((await a.get('/api/search?q=x')).status, 400);

  const t = S.agent();
  await t.login('tec.out', 'Tecnico-out-2026');
  const tr = (await t.get('/api/search?q=srv-erp')).data;
  assert.deepEqual(tr.cis.map((c) => c.name), ['SRV-ERP-OUTRO']);
  assert.equal((await t.get('/api/search?q=primavera')).data.contracts.length, 0);
});
