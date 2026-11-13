'use strict';
/* Subscrições: período experimental, Checkout, webhooks assinados do Stripe e modo só de leitura. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer } = require('./helpers');
const { verifyStripeSignature } = require('../src/routes/billing');

const WHSEC = 'whsec_teste';
const calls = [];
const subs = {};
async function mockFetch(url, opts = {}) {
  const u = new URL(url);
  assert.equal(u.host, 'api.stripe.com');
  assert.equal(opts.headers.Authorization, 'Bearer sk_test_123');
  const form = new URLSearchParams(opts.body || '');
  calls.push({ method: opts.method, path: u.pathname, form });
  const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (u.pathname === '/v1/checkout/sessions') return json({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });
  if (u.pathname === '/v1/billing_portal/sessions') return json({ url: 'https://billing.stripe.test/p_1' });
  const m = /^\/v1\/subscriptions\/(.+)$/.exec(u.pathname);
  if (m && subs[m[1]]) return json(subs[m[1]]);
  return json({ error: { message: 'sem rota' } }, 404);
}

let S;
let B; // administradora da organização registada
let orgId;
before(async () => {
  S = await startServer({
    appOpts: {
      fetch: mockFetch, signup: true, publicUrl: 'https://app.rizoma.test',
      stripe: { secretKey: 'sk_test_123', webhookSecret: WHSEC, prices: { essencial: 'price_ess', profissional: 'price_pro' }, trialDays: 14 },
    },
  });
  B = S.agent();
  const r = await B.post('/api/signup', { organization: 'Cliente Pagante', name: 'Paula', username: 'paula', email: 'paula@pagante.pt', password: 'Pagante-2026x' });
  assert.equal(r.status, 200);
  orgId = r.data.org_id;
});
after(() => S.close());

/** Envia um evento ao webhook com assinatura válida (ou a indicada). */
function webhook(event, { secret = WHSEC, t = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify(event);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return fetch(`${S.base}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body: raw })
    .then(async (res) => ({ status: res.status, data: await res.json() }));
}
const org = () => S.db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);

test('o registo começa um período experimental de 14 dias com os limites do plano Profissional', async () => {
  const o = org();
  assert.equal(o.billing_status, 'trialing');
  assert.equal(o.plan, 'experimental');
  assert.equal(o.max_users, 15);
  const days = (new Date(o.trial_ends_at) - Date.now()) / 864e5;
  assert.ok(days > 13.9 && days <= 14);
  const me = (await B.get('/api/me')).data;
  assert.equal(me.billing.status, 'trialing');
  assert.equal(me.billing.blocked, null);
  const bill = (await B.get('/api/billing')).data;
  assert.deepEqual(bill.plans.map((p) => [p.id, p.available]), [['essencial', true], ['profissional', true], ['empresa', false]]);
});

test('Checkout: sessão de subscrição com a organização identificada', async () => {
  const r = await B.post('/api/billing/checkout', { plan: 'essencial' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.url, 'https://checkout.stripe.test/cs_1');
  const f = calls.at(-1).form;
  assert.equal(f.get('mode'), 'subscription');
  assert.equal(f.get('line_items[0][price]'), 'price_ess');
  assert.equal(f.get('client_reference_id'), String(orgId));
  assert.equal(f.get('subscription_data[metadata][org_id]'), String(orgId));
  assert.equal(f.get('customer_email'), 'paula@pagante.pt');
  assert.equal(f.get('success_url'), 'https://app.rizoma.test/#/subscricao?estado=sucesso');
  assert.equal((await B.post('/api/billing/checkout', { plan: 'empresa' })).status, 400, 'plano sem preço configurado');
  assert.equal((await B.post('/api/billing/portal')).status, 400, 'ainda sem cliente Stripe');
});

test('período experimental terminado: só leitura, mas pode consultar, exportar e subscrever', async () => {
  S.db.prepare("UPDATE organizations SET trial_ends_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(orgId);
  const w = await B.post('/api/clients', { name: 'Novo', code: 'NV' });
  assert.equal(w.status, 402);
  assert.match(w.data.error, /período experimental terminou.*só de leitura/);
  assert.equal((await B.get('/api/clients')).status, 200);
  assert.equal((await B.get('/api/org/export')).status, 200);
  assert.equal((await B.post('/api/billing/checkout', { plan: 'profissional' })).status, 200);
  assert.ok((await B.get('/api/me')).data.billing.blocked);
  // A organização original (sem faturação) nunca é afetada
  const A = S.agent();
  await A.login('admin', 'Admin-pass-123');
  assert.equal((await A.post('/api/clients', { name: 'Sempre', code: 'SP' })).status, 200);
});

test('webhook: assinatura obrigatória; checkout concluído ativa o plano e os limites; idempotente', async () => {
  subs.sub_1 = { id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { org_id: String(orgId) },
    items: { data: [{ price: { id: 'price_ess' } }] }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, cancel_at: null };
  const ev = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: String(orgId), customer: 'cus_1', subscription: 'sub_1' } } };

  assert.equal((await webhook(ev, { secret: 'outro' })).status, 400);
  assert.equal((await webhook(ev, { t: Math.floor(Date.now() / 1000) - 3600 })).status, 400, 'assinatura antiga (replay)');
  assert.equal(org().billing_status, 'trialing');

  assert.equal((await webhook(ev)).status, 200);
  let o = org();
  assert.equal(o.billing_status, 'active');
  assert.equal(o.plan, 'essencial');
  assert.equal(o.max_users, 3);
  assert.equal(o.stripe_customer_id, 'cus_1');
  assert.equal((await B.post('/api/clients', { name: 'Já pode', code: 'JP' })).status, 200, 'volta a poder escrever');
  assert.equal((await webhook(ev)).data.duplicate, true);
  assert.equal((await B.post('/api/billing/checkout', { plan: 'profissional' })).status, 409, 'já tem subscrição: usa o portal');
  assert.equal((await B.post('/api/billing/portal')).data.url, 'https://billing.stripe.test/p_1');

  // Mudança de plano no portal
  await webhook({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: { ...subs.sub_1, items: { data: [{ price: { id: 'price_pro' } }] } } } });
  o = org();
  assert.equal(o.plan, 'profissional');
  assert.equal(o.max_users, 15);

  // Pagamento falhado: continua a trabalhar (o Stripe tenta de novo); cancelada: só leitura
  await webhook({ id: 'evt_3', type: 'invoice.payment_failed', data: { object: { subscription: 'sub_1' } } });
  assert.equal(org().billing_status, 'past_due');
  assert.equal((await B.post('/api/clients', { name: 'Ainda pode', code: 'AP' })).status, 200);
  await webhook({ id: 'evt_4', type: 'customer.subscription.deleted', data: { object: { ...subs.sub_1, status: 'canceled' } } });
  assert.equal(org().billing_status, 'canceled');
  const w = await B.post('/api/clients', { name: 'Não', code: 'NO' });
  assert.equal(w.status, 402);
  assert.match(w.data.error, /subscrição não está ativa/);
  const log = (await B.get('/api/audit?limit=50')).data.filter((e) => e.action === 'subscricao');
  assert.ok(log.length >= 3, 'alterações da subscrição na auditoria');
});

test('verificação da assinatura do Stripe', () => {
  const raw = '{"id":"evt"}';
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 's').update(`${t}.${raw}`).digest('hex');
  assert.equal(verifyStripeSignature(raw, `t=${t},v1=${sig}`, 's'), true);
  assert.equal(verifyStripeSignature(raw, `t=${t},v1=xx,v1=${sig}`, 's'), true, 'várias assinaturas (rotação do segredo)');
  assert.equal(verifyStripeSignature(`${raw} `, `t=${t},v1=${sig}`, 's'), false, 'corpo alterado');
  assert.equal(verifyStripeSignature(raw, '', 's'), false);
});
