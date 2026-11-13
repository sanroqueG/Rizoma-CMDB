'use strict';
/* Inventário de software e vulnerabilidades: catálogo, versões, NVD (simulada), KEV, isolamento e avisos. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { productFor, compareVersions, inRange } = require('../src/cve/catalog');
const { parseCve } = require('../src/cve');

const cpe = (product, v = '*') => `cpe:2.3:a:${product}:${v}:*:*:*:*:*:*:*`;
const nvdCve = (id, score, sev, matches) => ({ cve: {
  id, published: '2024-05-01T10:00:00.000', descriptions: [{ lang: 'en', value: `Falha ${id}` }],
  metrics: { cvssMetricV31: [{ cvssData: { baseScore: score, baseSeverity: sev } }] },
  configurations: [{ nodes: [{ operator: 'OR', negate: false, cpeMatch: matches }] }],
} });
const NVD_DATA = {
  '7-zip:7-zip': [
    nvdCve('CVE-2024-11477', 7.8, 'HIGH', [{ vulnerable: true, criteria: cpe('7-zip:7-zip'), versionEndExcluding: '24.07' }]),
    nvdCve('CVE-2025-0411', 7.0, 'HIGH', [{ vulnerable: true, criteria: cpe('7-zip:7-zip'), versionEndExcluding: '24.09' }]),
    nvdCve('CVE-2016-0001', 5.0, 'MEDIUM', [{ vulnerable: true, criteria: cpe('7-zip:7-zip') }]), // sem versões: ignorado
  ],
  'google:chrome': [
    nvdCve('CVE-2024-7971', 8.8, 'HIGH', [{ vulnerable: true, criteria: cpe('google:chrome'), versionEndExcluding: '128.0.6613.84' }]),
    nvdCve('CVE-2023-0001', 9.8, 'CRITICAL', [{ vulnerable: true, criteria: cpe('google:chrome', '100.0.4896.60') }]),
  ],
};
const calls = [];
let pageSize = 1000;
async function mockFetch(url, opts = {}) {
  const u = new URL(url);
  const json = (d) => new Response(JSON.stringify(d), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.host === 'www.cisa.gov') { calls.push('kev'); return json({ vulnerabilities: [{ cveID: 'CVE-2024-7971', dateAdded: '2024-08-26', dueDate: '2024-09-16', vulnerabilityName: 'Chrome V8 Type Confusion' }] }); }
  if (u.host === 'services.nvd.nist.gov') {
    const product = u.searchParams.get('virtualMatchString').replace('cpe:2.3:a:', '');
    calls.push({ product, start: Number(u.searchParams.get('startIndex')), key: opts.headers.apiKey });
    const all = NVD_DATA[product] || [];
    const start = Number(u.searchParams.get('startIndex'));
    const page = all.slice(start, start + pageSize);
    return json({ resultsPerPage: page.length, startIndex: start, totalResults: all.length, vulnerabilities: page });
  }
  if (u.host.endsWith('slack.com')) return new Response('ok');
  throw new Error(`sem rota: ${url}`);
}

let S;
let A;
let token;
let acme;
let beta;
let tech;
before(async () => {
  S = await startServer({ appOpts: { fetch: mockFetch, secretKey: 'k', nvdDelayMs: 0, nvdApiKey: 'chave-nvd', webhookLookup: async () => [{ address: '93.184.216.34' }] } });
  A = S.agent();
  await A.login('admin', 'Admin-pass-123');
  acme = (await A.post('/api/clients', { name: 'Acme', code: 'ACME' })).data.id;
  beta = (await A.post('/api/clients', { name: 'Beta', code: 'BETA' })).data.id;
  token = (await A.post(`/api/clients/${acme}/tokens`, { name: 'agente', scopes: ['ingest'] })).data.token;
  await A.post('/api/users', { username: 'tec-beta', name: 'Téc', role: 'tech', password: 'Tecnico-beta-26', client_ids: [beta] });
  tech = S.agent();
  await tech.login('tec-beta', 'Tecnico-beta-26');
});
after(() => S.close());

const ingest = (body) => fetch(`${S.base}/api/v1/ingest`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, data: await r.json() }));

test('catálogo e comparação de versões', () => {
  assert.equal(productFor('7-Zip 23.01 (x64)'), '7-zip:7-zip');
  assert.equal(productFor('Google Chrome'), 'google:chrome');
  assert.equal(productFor('Mozilla Firefox (x64 pt-PT)'), 'mozilla:firefox');
  assert.equal(productFor('Mozilla Firefox ESR (x64 en-US)'), 'mozilla:firefox_esr');
  assert.equal(productFor('Notepad++ (64-bit x64)'), 'notepad-plus-plus:notepad\\+\\+');
  assert.equal(productFor('Microsoft Visual C++ 2015-2022 Redistributable'), null);
  assert.ok(compareVersions('1.10', '1.9') > 0);
  assert.ok(compareVersions('23.01', '24.07') < 0);
  assert.equal(compareVersions('128.0.6613.84', '128.0.6613.84.0'), 0);
  assert.equal(inRange('23.01', { v: '*', ee: '24.07' }), true);
  assert.equal(inRange('24.07', { v: '*', ee: '24.07' }), false);
  assert.equal(inRange('24.07', { v: '*', ei: '24.07' }), true);
  assert.equal(inRange('5.0', { v: '*', si: '6.0', ee: '7.0' }), false);
  assert.equal(inRange('1.0', { v: '*' }), false, 'sem versões não se atribui');
  assert.equal(inRange('', { v: '*', ee: '9' }), false, 'sem versão instalada não se atribui');
  // Versões reais do registo do Windows
  assert.equal(inRange('ad 9.6.11', { v: '*', ee: '9.7.0' }), true, 'AnyDesk regista "ad 9.6.11"');
  assert.equal(inRange('ad 9.6.11', { v: '*', ee: '9.6.0' }), false);
  assert.equal(inRange('26.05.00.0', { v: '26.05' }), true, '7-Zip regista "26.05.00.0"');
  assert.equal(inRange('2.43.0.windows.1', { v: '*', ee: '2.43.1' }), true, 'Git for Windows');
  const p = parseCve(NVD_DATA['google:chrome'][1], 'google:chrome');
  assert.deepEqual(p.ranges, [{ v: '100.0.4896.60', si: undefined, se: undefined, ei: undefined, ee: undefined }]);
  assert.equal(p.severity, 'CRITICAL');
});

test('o agente envia o software; a atualização encontra as vulnerabilidades por versão', async () => {
  const r = await ingest({ assets: [
    { hostname: 'PC-ANTIGO', software: [{ name: '7-Zip 23.01 (x64)', version: '23.01', publisher: 'Igor Pavlov' }, { name: 'Google Chrome', version: '127.0.6533.120' }, { name: 'Calculadora', version: '1' }] },
    { hostname: 'PC-NOVO', software: [{ name: '7-Zip 24.09 (x64)', version: '24.09' }, { name: 'Google Chrome', version: '131.0.6778.86' }] },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.results.map((x) => x.software), [3, 2]);

  pageSize = 1; // força a paginação da NVD
  const scan = await S.app.runCveScan();
  assert.deepEqual(scan.errors, []);
  assert.equal(scan.products, 2);
  const nvdCalls = calls.filter((c) => c !== 'kev');
  assert.deepEqual(nvdCalls.filter((c) => c.product === '7-zip:7-zip').map((c) => c.start), [0, 1, 2], 'todas as páginas');
  assert.ok(nvdCalls.every((c) => c.key === 'chave-nvd'), 'chave da NVD enviada');

  const old = (await A.get(`/api/cis?q=PC-ANTIGO`)).data.items[0].id;
  const fresh = (await A.get(`/api/cis?q=PC-NOVO`)).data.items[0].id;
  const v = (await A.get(`/api/cis/${old}/software`)).data;
  assert.equal(v.software.length, 3);
  assert.deepEqual(v.vulns.map((x) => x.cve_id), ['CVE-2024-7971', 'CVE-2024-11477', 'CVE-2025-0411'], 'KEV primeiro, depois a gravidade');
  assert.equal(v.vulns[0].kev_added, '2024-08-26');
  assert.equal((await A.get(`/api/cis/${fresh}/software`)).data.vulns.length, 0, 'versões corrigidas: nada');

  const list = (await A.get('/api/vulnerabilities')).data;
  assert.equal(list.totals.cis, 1);
  assert.equal(list.totals.inventoried, 2);
  assert.deepEqual(list.items.map((x) => [x.cve_id, x.cis]), [['CVE-2024-7971', 1], ['CVE-2024-11477', 1], ['CVE-2025-0411', 1]]);
  assert.equal((await A.get('/api/vulnerabilities?kev=1')).data.items.length, 1);
  assert.equal((await A.get('/api/vulnerabilities?severity=CRITICAL')).data.items.length, 0);
});

test('atualizar o software retira as vulnerabilidades corrigidas sem nova consulta à NVD', async () => {
  calls.length = 0;
  await ingest({ hostname: 'PC-ANTIGO', software: [{ name: '7-Zip 24.09 (x64)', version: '24.09' }, { name: 'Google Chrome', version: '131.0.6778.86' }] });
  const old = (await A.get('/api/cis?q=PC-ANTIGO')).data.items[0].id;
  assert.equal((await A.get(`/api/cis/${old}/software`)).data.vulns.length, 0);
  await S.app.runCveScan();
  assert.equal(calls.filter((c) => c !== 'kev').length, 0, 'cache de 24 h por produto');
});

test('isolamento: quem não vê o cliente não vê o software nem as vulnerabilidades', async () => {
  await ingest({ hostname: 'PC-VULN', software: [{ name: '7-Zip 19.00 (x64)', version: '19.00' }] });
  const id = (await A.get('/api/cis?q=PC-VULN')).data.items[0].id;
  assert.ok((await A.get(`/api/cis/${id}/software`)).data.vulns.length >= 2);
  assert.equal((await tech.get(`/api/cis/${id}/software`)).status, 404);
  assert.equal((await tech.get('/api/vulnerabilities')).data.items.length, 0);
  assert.equal((await tech.post('/api/vulnerabilities/scan')).status, 403);
});

test('novas vulnerabilidades geram um aviso por cliente', async () => {
  await A.post('/api/webhooks', { kind: 'slack', name: 'Segurança', url: 'https://hooks.slack.com/services/T/B/x', events: ['vulnerability.detected'] });
  await ingest({ hostname: 'PC-AVISO', software: [{ name: 'Google Chrome', version: '100.0.4896.60' }] });
  const r = await S.app.runCveScan();
  assert.equal(r.notified, 1);
  const p = JSON.parse(S.db.prepare("SELECT payload FROM webhook_deliveries WHERE event = 'vulnerability.detected'").get().payload);
  assert.equal(p.client.name, 'Acme');
  assert.ok(p.data.new_cves >= 2);
  assert.equal(p.data.kev, 1);
  assert.equal((await S.app.runCveScan()).notified, 0, 'só avisa uma vez');
});
