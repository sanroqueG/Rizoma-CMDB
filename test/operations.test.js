'use strict';
/* Operação do serviço: métricas Prometheus e acesso de suporte autorizado pela organização. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let S;
let P; // plataforma (admin da organização 1)
let B; // administradora de outra organização
let orgB;
before(async () => {
  S = await startServer({ appOpts: { signup: true, metricsToken: 'metricas-secretas' } });
  S.db.prepare('UPDATE users SET is_platform = 1 WHERE username = ?').run('admin');
  P = S.agent();
  await P.login('admin', 'Admin-pass-123');
  B = S.agent();
  orgB = (await B.post('/api/signup', { organization: 'Precisa Ajuda', name: 'Pia', username: 'pia', email: 'pia@ajuda.pt', password: 'Precisa-ajuda-26' })).data.org_id;
});
after(() => S.close());

test('métricas: só com token; rotas por padrão, contagens e duração', async () => {
  await B.get('/api/clients');
  await B.get('/api/cis/999999');
  assert.equal((await S.agent().get('/api/metrics')).status, 401);
  assert.equal((await S.agent().get('/api/metrics', { Authorization: 'Bearer errado' })).status, 401);
  const r = await S.agent().get('/api/metrics', { Authorization: 'Bearer metricas-secretas' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/plain/);
  assert.match(r.data, /rizoma_http_requests_total\{method="GET",route="\/api\/clients",status="200"\} \d+/);
  assert.match(r.data, /route="\/api\/cis\/:id",status="404"/, 'padrão da rota, não o id');
  assert.match(r.data, /rizoma_http_request_duration_seconds_bucket\{method="GET",route="\/api\/clients",le="\+Inf"\} \d+/);
  assert.match(r.data, /^rizoma_users \d+$/m);
  assert.match(r.data, /^rizoma_uptime_seconds \d+$/m);
  // Sem token configurado, a rota não existe
  const semToken = await startServer();
  assert.equal((await semToken.agent().get('/api/metrics')).status, 404);
  await semToken.close();
});

test('suporte: só com autorização da organização, auditado e com limites', async () => {
  const fresh = () => S.agent();
  let sup = fresh();
  await sup.login('admin', 'Admin-pass-123');
  const no = await sup.post(`/api/platform/orgs/${orgB}/support-session`);
  assert.equal(no.status, 403);
  assert.match(no.data.error, /não autorizou/);
  assert.equal((await B.post(`/api/platform/orgs/${orgB}/support-session`)).status, 403, 'só a plataforma');

  assert.equal((await B.put('/api/org/support-access', { hours: 200 })).status, 400, 'no máximo 7 dias');
  const g = await B.put('/api/org/support-access', { hours: 24 });
  assert.equal(g.data.granted, true);

  const r = await sup.post(`/api/platform/orgs/${orgB}/support-session`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.expires_in_s <= 3600);
  const me = (await sup.get('/api/me')).data;
  assert.equal(me.org_id, orgB);
  assert.deepEqual(me.support_session, { by: 'admin', as: 'pia' });

  // Trabalha na organização; a auditoria mostra quem foi
  assert.equal((await sup.post('/api/clients', { name: 'Criado pelo suporte', code: 'SUP' })).status, 200);
  const log = (await B.get('/api/audit?limit=10')).data;
  assert.ok(log.some((e) => e.action === 'create' && e.actor === 'suporte:admin'));
  assert.ok(log.some((e) => e.action === 'suporte_sessao' && e.actor === 'suporte:admin'));

  // Vedado: conta do administrador, subscrição, eliminação, autorização
  assert.equal((await sup.post('/api/me/password', { current: 'x', password: 'Outra-pass-2026' })).status, 403);
  assert.equal((await sup.post('/api/org/deletion', { confirm: 'x' })).status, 403);
  assert.equal((await sup.put('/api/org/support-access', { hours: 168 })).status, 403);

  // Revogar termina a sessão de suporte de imediato
  await B.put('/api/org/support-access', { hours: 0 });
  assert.equal((await sup.get('/api/me')).status, 401);
  sup = fresh();
  await sup.login('admin', 'Admin-pass-123');
  assert.equal((await sup.post(`/api/platform/orgs/${orgB}/support-session`)).status, 403);
});
