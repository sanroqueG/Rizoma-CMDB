'use strict';
/* Integração NinjaOne: credenciais, associação organização→cliente, sincronização sem duplicados e abate. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { typeFromNodeClass, deviceToAsset } = require('../src/rmm/ninjaone');

const ninja = {
  orgs: [{ id: 11, name: 'ACME, Lda.' }, { id: 12, name: 'Beta Serviços' }, { id: 13, name: 'Sem Par' }],
  devices: [],
  tokenCalls: 0,
  pages: [],
};
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
async function mockFetch(url, opts = {}) {
  const u = new URL(url);
  assert.equal(u.host, 'eu.ninjarmm.com');
  if (u.pathname === '/ws/oauth/token') {
    const f = new URLSearchParams(opts.body);
    ninja.tokenCalls++;
    if (f.get('client_secret') !== 'segredo-certo') return json({ error: 'invalid_client' }, 401);
    assert.equal(f.get('scope'), 'monitoring');
    return json({ access_token: 'tok', expires_in: 3600 });
  }
  assert.equal(opts.headers.Authorization, 'Bearer tok');
  const size = Number(u.searchParams.get('pageSize'));
  const after = Number(u.searchParams.get('after') || 0);
  const list = u.pathname === '/v2/organizations' ? ninja.orgs : u.pathname === '/v2/devices-detailed' ? ninja.devices : null;
  if (!list) return json({ error: 'sem rota' }, 404);
  if (u.pathname === '/v2/devices-detailed') ninja.pages.push(after);
  return json(list.filter((x) => x.id > after).slice(0, size));
}
const dev = (id, org, extra = {}) => ({
  id, organizationId: org, systemName: `PC-${id}`, nodeClass: 'WINDOWS_WORKSTATION', offline: false, lastContact: 1763000000,
  system: { manufacturer: 'Dell Inc.', model: 'OptiPlex 7090', serialNumber: `SN${id}` }, os: { name: 'Windows 11 Pro' },
  memory: { capacity: 16 * 1024 ** 3 }, ipAddresses: ['169.254.1.1', `10.0.0.${id % 250}`], ...extra,
});

let S;
let A;
let acme;
let beta;
before(async () => {
  S = await startServer({ appOpts: { fetch: mockFetch, secretKey: 'k' } });
  A = S.agent();
  await A.login('admin', 'Admin-pass-123');
  acme = (await A.post('/api/clients', { name: 'Acme', code: 'ACME' })).data.id;
  beta = (await A.post('/api/clients', { name: 'Beta Serviços', code: 'BETA' })).data.id;
});
after(() => S.close());

test('mapeamento de tipos e campos de um dispositivo', () => {
  assert.equal(typeFromNodeClass('WINDOWS_SERVER'), 'Servidor');
  assert.equal(typeFromNodeClass('LINUX_SERVER'), 'Servidor');
  assert.equal(typeFromNodeClass('VMWARE_VM_GUEST'), 'Máquina virtual');
  assert.equal(typeFromNodeClass('NMS_SWITCH'), 'Equipamento de rede');
  assert.equal(typeFromNodeClass('NMS_FIREWALL'), 'Firewall');
  assert.equal(typeFromNodeClass('NMS_PRINTER'), 'Impressora');
  assert.equal(typeFromNodeClass('MAC', { system: { chassisType: 'Laptop' } }), 'Portátil');
  assert.equal(typeFromNodeClass('WINDOWS_WORKSTATION'), 'Posto de trabalho');
  const a = deviceToAsset(dev(5, 11));
  assert.equal(a.external_id, 'ninjaone:5');
  assert.equal(a.ip_address, '10.0.0.5', 'ignora endereços 169.254');
  assert.equal(a.attributes.ram_gb, 16);
  assert.equal(a.lastSeen, new Date(1763000000 * 1000).toISOString());
  assert.equal(deviceToAsset({ id: 9, organizationId: 1 }).name, undefined, 'campos em falta não falham');
});

test('credenciais erradas são reportadas; certas trazem as organizações com sugestão pelo nome', async () => {
  const bad = await A.put('/api/rmm', { region: 'eu', client_id: 'app-1', secret: 'errado' });
  assert.equal(bad.status, 200);
  assert.match(bad.data.test_error, /recusou as credenciais \(401/);
  assert.equal((await A.put('/api/rmm', { region: 'marte', client_id: 'x', secret: 'y' })).status, 400);

  const ok = await A.put('/api/rmm', { region: 'eu', client_id: 'app-1', secret: 'segredo-certo' });
  assert.equal(ok.data.test_error, null);
  const byName = Object.fromEntries(ok.data.mapping.map((m) => [m.remote_org_name, m.client_id]));
  assert.deepEqual(byName, { 'ACME, Lda.': acme, 'Beta Serviços': beta, 'Sem Par': null }, '"ACME, Lda." = "Acme"');
  const stored = S.db.prepare('SELECT secret_enc FROM rmm_connections').get().secret_enc;
  assert.ok(!stored.includes('segredo-certo'), 'segredo encriptado');
  assert.equal(JSON.stringify((await A.get('/api/rmm')).data).includes('segredo'), false);
});

test('sincronização: cria, não duplica o que já existe, pagina, ignora não associados e abate os que desaparecem', async () => {
  // Um PC já registado pelo agente (mesmo número de série) não pode duplicar
  const type = (await A.get('/api/meta')).data.types.find((t) => t.name === 'Posto de trabalho').id;
  const pre = (await A.post('/api/cis', { client_id: acme, type_id: type, name: 'PC do agente', serial_number: 'SN1' })).data.id;
  ninja.devices = [];
  for (let i = 1; i <= 1003; i++) ninja.devices.push(dev(i, i <= 1000 ? 11 : 12));
  ninja.devices.push(dev(2000, 13), dev(2001, 12, { nodeClass: 'WINDOWS_SERVER', systemName: 'SRV-BETA' }));

  const r = await A.post('/api/rmm/sync');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'ok', JSON.stringify(r.data.report.erros));
  assert.deepEqual(ninja.pages, [0, 1000], 'segunda página pelo cursor after');
  assert.deepEqual(r.data.report.clientes.Acme, { created: 999, updated: 1, unchanged: 0, retired: 0, erros: 0 });
  assert.equal(r.data.report.clientes['Beta Serviços'].created, 4);
  assert.equal(r.data.report.sem_cliente, 1, 'organização sem cliente associado');
  const merged = S.db.prepare('SELECT external_id, name, hostname FROM cis WHERE id = ?').get(pre);
  assert.equal(merged.external_id, 'ninjaone:1', 'ligado ao existente pelo número de série');
  const srv = (await A.get(`/api/cis?client_id=${beta}&q=SRV-BETA`)).data.items[0];
  assert.equal(srv.type_name, 'Servidor');

  // Associar a terceira organização e retirar um dispositivo
  await A.put('/api/rmm/mapping', { items: [{ remote_org_id: '13', client_id: beta }] });
  ninja.devices = ninja.devices.filter((d) => d.id !== 1002);
  const r2 = (await A.post('/api/rmm/sync')).data;
  assert.equal(r2.report.sem_cliente, 0);
  assert.equal(r2.report.clientes['Beta Serviços'].retired, 1);
  assert.equal(S.db.prepare("SELECT status FROM cis WHERE external_id = 'ninjaone:1002'").get().status, 'abatido');
  assert.equal(r2.report.clientes.Acme.unchanged, 1000, 'sem alterações, nada é reescrito');
  assert.equal((await A.get('/api/rmm')).data.mapping.find((m) => m.remote_org_id === '11').devices, 1000);
});

test('isolamento: outra organização não vê nem associa à ligação', async () => {
  const other = await startServer({ appOpts: { fetch: mockFetch, secretKey: 'k', signup: true } });
  try {
    const B = other.agent();
    assert.equal((await B.post('/api/signup', { organization: 'Outra', name: 'Olga', username: 'olga', email: 'olga@outra.pt', password: 'Outra-org-2026x' })).status, 200);
    assert.equal((await B.get('/api/rmm')).data.configured, false);
    assert.equal((await B.post('/api/rmm/sync')).status, 404);
  } finally {
    await other.close();
  }
  // Na mesma instância: associar a um cliente de outra organização é recusado
  S.db.prepare("INSERT INTO organizations (name, slug) VALUES ('Z', 'z')").run();
  const foreign = Number(S.db.prepare("INSERT INTO clients (name, code, org_id) VALUES ('Alheio', 'ALH', (SELECT id FROM organizations WHERE slug = 'z'))").run().lastInsertRowid);
  assert.equal((await A.put('/api/rmm/mapping', { items: [{ remote_org_id: '13', client_id: foreign }] })).status, 400);
});
