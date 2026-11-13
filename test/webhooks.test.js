'use strict';
/* Avisos e webhooks: eventos da auditoria, fila na mesma transação, Slack/Teams agrupados, assinatura, tentativas, SSRF. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer } = require('./helpers');
const { validateUrl, isPrivateIp, eventsFromAudit } = require('../src/webhooks');

const received = [];
let failGeneric = 0;
async function mockFetch(url, opts = {}) {
  received.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
  if (url.startsWith('https://recetor.example') && failGeneric > 0) { failGeneric--; return new Response('indisponível', { status: 503 }); }
  return new Response('ok', { status: 200 });
}
const take = (prefix) => { const r = received.filter((x) => x.url.startsWith(prefix)); received.length = 0; return r; };

let S;
let A;
let client;
let type;
let hooks;
before(async () => {
  S = await startServer({ appOpts: { fetch: mockFetch, secretKey: 'k', publicUrl: 'https://app.rizoma.test', webhookLookup: async () => [{ address: '93.184.216.34' }] } });
  A = S.agent();
  await A.login('admin', 'Admin-pass-123');
  client = (await A.post('/api/clients', { name: 'Acme', code: 'ACME' })).data.id;
  type = (await A.get('/api/meta')).data.types[0].id;
});
after(() => S.close());

test('validação dos URLs e endereços internos', () => {
  assert.equal(validateUrl('slack', 'https://hooks.slack.com/services/T/B/x'), null);
  assert.match(validateUrl('slack', 'https://evil.example/hooks'), /Incoming Webhook/);
  assert.match(validateUrl('generic', 'http://recetor.example/x'), /https/);
  assert.match(validateUrl('generic', 'https://10.0.0.5/x'), /internos/);
  assert.match(validateUrl('generic', 'https://user:pw@recetor.example/x'), /credenciais/);
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', '::ffff:10.0.0.1', 'fd00::1']) assert.equal(isPrivateIp(ip), true, ip);
  assert.equal(isPrivateIp('93.184.216.34'), false);
  assert.deepEqual(eventsFromAudit({ entity: 'ci', action: 'update', changes: { status: ['a', 'b'] } }), ['ci.updated', 'ci.status_changed']);
  assert.deepEqual(eventsFromAudit({ entity: 'connector', action: 'sync', changes: { estado: 'erro' } }), ['sync.failed']);
  assert.deepEqual(eventsFromAudit({ entity: 'user', action: 'login' }), []);
});

test('configuração: eventos por omissão, segredo mostrado uma vez, URL nunca devolvido por inteiro', async () => {
  const s = await A.post('/api/webhooks', { kind: 'slack', name: 'Canal #ti', url: 'https://hooks.slack.com/services/T0/B0/segredoSlack' });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.deepEqual(s.data.events, ['ci.status_changed', 'ci.deleted', 'contract.expiring', 'sync.failed', 'vulnerability.detected']);
  assert.ok(!s.data.url.includes('segredoSlack'));
  const t = await A.post('/api/webhooks', { kind: 'teams', name: 'Teams', url: 'https://prod.westeurope.logic.azure.com/workflows/abc', events: ['ci.created', 'ci.status_changed'] });
  const g = await A.post('/api/webhooks', { kind: 'generic', name: 'ERP', url: 'https://recetor.example/rizoma', client_id: client });
  assert.match(g.data.secret, /^whsec_/);
  assert.equal((await A.get('/api/webhooks')).data.find((w) => w.id === g.data.id).secret, undefined);
  assert.equal((await A.post('/api/webhooks', { kind: 'slack', name: 'x', url: 'https://outro.example' })).status, 400);
  hooks = { slack: s.data.id, teams: t.data.id, generic: g.data.id, secret: g.data.secret };
  assert.equal((await A.post(`/api/webhooks/${hooks.slack}/test`)).data.ok, true);
  assert.match(take('https://hooks.slack.com')[0].body.text, /teste/);
});

test('fila: envio, agrupamento e assinatura verificável', async () => {
  received.length = 0;
  S.db.prepare('DELETE FROM webhook_deliveries').run();
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await A.post('/api/cis', { client_id: client, type_id: type, name: `PC-${i}` })).data.id);
  await A.put(`/api/cis/${ids[0]}`, { status: 'abatido' });
  const n = await S.app.processWebhooks();

  const slack = received.filter((r) => r.url.startsWith('https://hooks.slack.com'));
  const teams = received.filter((r) => r.url.includes('logic.azure.com'));
  const generic = received.filter((r) => r.url.startsWith('https://recetor.example'));
  assert.equal(slack.length, 1, 'Slack: só o estado mudou');
  assert.match(slack[0].body.text, /Acme: Ativo "PC-0" .*estado: em_producao → abatido.*por admin/);
  assert.match(slack[0].body.text, /<https:\/\/app\.rizoma\.test\/#\/ativos\/\d+\|Abrir no Rizoma>/);
  assert.equal(teams.length, 1, 'Teams: 4 eventos numa só mensagem');
  assert.equal(teams[0].body.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  assert.match(teams[0].body.attachments[0].content.body[0].text, /4 alterações/);
  assert.equal(generic.length, 5, 'genérico: um pedido por evento (3 criados, 1 alterado, 1 estado)');
  assert.equal(n, 7);

  const g = generic[0];
  assert.equal(g.headers['X-Rizoma-Event'], 'ci.created');
  const [t, v1] = g.headers['X-Rizoma-Signature'].split(',').map((x) => x.split('=')[1]);
  const raw = JSON.stringify(g.body);
  assert.equal(v1, crypto.createHmac('sha256', hooks.secret).update(`${t}.${raw}`).digest('hex'), 'assinatura HMAC verificável');
  assert.deepEqual(Object.keys(g.body).sort(), ['actor', 'changes', 'client', 'entity', 'event', 'id', 'occurred_at', 'organization', 'url']);
  assert.equal(g.body.client.name, 'Acme');
  assert.equal(S.db.prepare("SELECT COUNT(*) n FROM webhook_deliveries WHERE status = 'pending'").get().n, 0);
});

test('alteração desfeita não gera aviso; filtro por cliente', async () => {
  received.length = 0;
  S.db.prepare('DELETE FROM webhook_deliveries').run();
  // Importação em simulação (corre e desfaz): nada entra na fila
  await A.post('/api/import', { client_id: client, rows: [{ Nome: 'SIMULADO' }], dry_run: true });
  const other = (await A.post('/api/clients', { name: 'Outro', code: 'OUT' })).data.id;
  await A.post('/api/cis', { client_id: other, type_id: type, name: 'NOUTRO' });
  const pend = S.db.prepare('SELECT w.kind, d.payload FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id').all();
  assert.ok(!pend.some((d) => d.payload.includes('SIMULADO')), 'transação desfeita: sem eventos');
  assert.ok(!pend.some((d) => d.kind === 'generic'), 'o genérico só subscreve o cliente Acme');
  assert.ok(pend.some((d) => d.kind === 'teams' && d.payload.includes('NOUTRO')));
});

test('falhas: novas tentativas com espera, e o destino recupera', async () => {
  received.length = 0;
  S.db.prepare('DELETE FROM webhook_deliveries').run();
  failGeneric = 2;
  await A.post('/api/cis', { client_id: client, type_id: type, name: 'TENTATIVAS' });
  await S.app.processWebhooks();
  let d = S.db.prepare("SELECT d.* FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE w.kind = 'generic'").get();
  assert.equal(d.status, 'pending');
  assert.equal(d.attempts, 1);
  assert.match(d.last_error, /503/);
  assert.ok(d.next_attempt_at > Date.now() + 50e3, 'próxima tentativa daqui a 1 minuto');
  assert.equal((await A.get('/api/webhooks')).data.find((w) => w.kind === 'generic').last_status, 'erro');
  await S.app.processWebhooks(Date.now() + 2 * 60e3);
  await S.app.processWebhooks(Date.now() + 10 * 60e3);
  d = S.db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(d.id);
  assert.equal(d.status, 'ok');
  assert.equal(d.attempts, 3);
  const w = (await A.get('/api/webhooks')).data.find((x) => x.kind === 'generic');
  assert.deepEqual([w.last_status, w.failures], ['ok', 0]);
  assert.equal((await A.get(`/api/webhooks/${w.id}/deliveries`)).data[0].status, 'ok');
});

test('contratos a expirar: aviso 30 e 7 dias antes, uma vez por dia', async () => {
  S.db.prepare('DELETE FROM webhook_deliveries').run();
  const now = new Date('2026-12-01T09:00:00Z');
  await A.post('/api/contracts', { client_id: client, name: 'Suporte anual', end_date: '2026-12-31' });
  await A.post('/api/contracts', { client_id: client, name: 'Antivírus', end_date: '2026-12-08' });
  S.db.prepare('DELETE FROM webhook_deliveries').run();
  assert.equal(S.app.emitContractExpiry(now) >= 2, true);
  assert.equal(S.app.emitContractExpiry(now), null, 'só uma vez por dia');
  const p = S.db.prepare("SELECT payload FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE w.kind = 'slack'").all().map((r) => JSON.parse(r.payload));
  assert.deepEqual(p.map((x) => [x.entity.label, x.data.days]).sort(), [['Antivírus', 7], ['Suporte anual', 30]]);
});

test('o URL de destino resolve para um endereço interno: não envia', async () => {
  const S2 = await startServer({ appOpts: { fetch: mockFetch, secretKey: 'k', webhookLookup: async () => [{ address: '10.0.0.7' }] } });
  try {
    const a = S2.agent();
    await a.login('admin', 'Admin-pass-123');
    const g = (await a.post('/api/webhooks', { kind: 'generic', name: 'Interno', url: 'https://parece-publico.example/x' })).data;
    received.length = 0;
    const r = await a.post(`/api/webhooks/${g.id}/test`);
    assert.equal(r.data.ok, false);
    assert.match(r.data.error, /endereço interno/);
    assert.equal(received.length, 0);
  } finally { await S2.close(); }
});
