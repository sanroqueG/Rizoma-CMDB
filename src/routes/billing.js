'use strict';
/*
 * Subscrições com o Stripe (Checkout + portal do cliente + webhooks).
 * Liga-se com CMDB_STRIPE_SECRET_KEY, CMDB_STRIPE_WEBHOOK_SECRET e CMDB_STRIPE_PRICES ({"essencial":"price_…",…}).
 * As faturas fiscais (certificadas pela AT) não são emitidas aqui: ver docs/faturacao.md.
 *
 * Organizações com billing_status NULL não estão sujeitas a faturação (criadas antes, ou geridas à mão pela plataforma).
 * Período experimental expirado ou subscrição cancelada: a organização fica só de leitura (pode consultar e exportar).
 */
const crypto = require('node:crypto');
const { fail } = require('../http');
const S = require('../schema');
const { PLANS, TRIAL_LIMITS, GOOD_STANDING } = require('../plans');

const STRIPE_API = 'https://api.stripe.com/v1';

/** Corpo application/x-www-form-urlencoded com a notação do Stripe para objetos (metadata[org_id]=1, line_items[0][price]=…). */
function stripeForm(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') stripeForm(v, key, out); else out.append(key, String(v));
  }
  return out;
}

/** Verifica a assinatura Stripe-Signature (t=…,v1=…) com tolerância de 5 minutos. */
function verifyStripeSignature(raw, header, secret, now = Date.now()) {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header || '').split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length) return false;
  if (Math.abs(now / 1000 - t) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

module.exports = function registerBilling(core) {
  const { add, one, run, tx, audit, assertAdmin, opts, fetchFn, log } = core;
  const env = process.env;
  const cfg = opts.stripe !== undefined ? opts.stripe : (env.CMDB_STRIPE_SECRET_KEY ? {
    secretKey: env.CMDB_STRIPE_SECRET_KEY,
    webhookSecret: env.CMDB_STRIPE_WEBHOOK_SECRET,
    prices: JSON.parse(env.CMDB_STRIPE_PRICES || '{}'),
    trialDays: Number(env.CMDB_TRIAL_DAYS || 14),
  } : null);
  const enabled = !!(cfg && cfg.secretKey);
  const trialDays = cfg?.trialDays ?? 14;
  const planOfPrice = (priceId) => Object.keys(cfg?.prices || {}).find((p) => cfg.prices[p] === priceId) || null;

  async function stripe(method, path, params) {
    const r = await fetchFn(`${STRIPE_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2024-06-20' },
      body: params ? stripeForm(params).toString() : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      log.error('Stripe recusou o pedido', { path, status: r.status, err: new Error(data?.error?.message || String(r.status)) });
      fail(502, 'Não foi possível contactar o serviço de pagamentos. Tente novamente.');
    }
    return data;
  }

  // ------------------------------------------------------------ regras de acesso
  core.billingEnabled = enabled;
  /** Novas organizações (registo) começam no período experimental quando a faturação está ligada. */
  core.startTrial = (orgId) => {
    if (!enabled) return;
    const ends = new Date(Date.now() + trialDays * 864e5).toISOString();
    run(`UPDATE organizations SET billing_status = 'trialing', trial_ends_at = ?, plan = 'experimental',
      max_clients = ?, max_cis = ?, max_users = ? WHERE id = ?`, ends, TRIAL_LIMITS.max_clients, TRIAL_LIMITS.max_cis, TRIAL_LIMITS.max_users, orgId);
  };
  /** Motivo para a organização estar só de leitura (ou null). Recebe uma linha de organizations. */
  core.billingBlock = (o) => {
    if (!o || !o.billing_status) return null;
    if (o.billing_status === 'trialing' && !o.stripe_subscription_id) {
      return o.trial_ends_at && o.trial_ends_at < new Date().toISOString() ? 'O período experimental terminou.' : null;
    }
    return GOOD_STANDING.has(o.billing_status) ? null : 'A subscrição não está ativa.';
  };

  if (enabled) core.cancelSubscriptionAtPeriodEnd = (subId) => stripe('POST', `/subscriptions/${subId}`, { cancel_at_period_end: true });

  // ------------------------------------------------------------ estado e planos (administrador)
  add('GET', '/api/billing', ({ user }) => {
    assertAdmin(user);
    const o = one('SELECT * FROM organizations WHERE id = ?', user.org_id);
    return {
      enabled, managed: !o.billing_status, status: o.billing_status, plan: o.plan, trial_ends_at: o.trial_ends_at,
      current_period_end: o.current_period_end, cancel_at: o.cancel_at, has_customer: !!o.stripe_customer_id,
      blocked: core.billingBlock(o),
      plans: Object.entries(PLANS).map(([id, p]) => ({ id, label: p.label, limits: p.limits, available: !!cfg?.prices?.[id] })),
    };
  }, { billingExempt: true });

  add('POST', '/api/billing/checkout', async ({ user, body, req }) => {
    assertAdmin(user);
    if (!enabled) fail(404, 'Os pagamentos não estão ativos neste servidor');
    const price = cfg.prices?.[body.plan];
    if (!price) fail(400, 'Plano indisponível');
    const o = one('SELECT * FROM organizations WHERE id = ?', user.org_id);
    if (o.stripe_subscription_id && GOOD_STANDING.has(o.billing_status)) fail(409, 'Já tem uma subscrição ativa. Use "Gerir subscrição" para mudar de plano.');
    const base = core.baseUrl(req);
    const session = await stripe('POST', '/checkout/sessions', {
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      client_reference_id: String(o.id),
      customer: o.stripe_customer_id || undefined,
      customer_email: o.stripe_customer_id ? undefined : user.email || undefined,
      metadata: { org_id: o.id, plan: body.plan },
      subscription_data: { metadata: { org_id: o.id, plan: body.plan } },
      tax_id_collection: { enabled: true }, // NIF da empresa na fatura
      billing_address_collection: 'required',
      allow_promotion_codes: true,
      success_url: `${base}/#/subscricao?estado=sucesso`,
      cancel_url: `${base}/#/subscricao`,
    });
    audit('organization', o.id, null, o.name, user.username, 'checkout', { plano: body.plan }, o.id);
    return { url: session.url };
  }, { billingExempt: true, body: S.obj({ plan: S.str({ enum: Object.keys(PLANS), required: true, label: 'Plano' }) }) });

  add('POST', '/api/billing/portal', async ({ user, req }) => {
    assertAdmin(user);
    if (!enabled) fail(404, 'Os pagamentos não estão ativos neste servidor');
    const o = one('SELECT * FROM organizations WHERE id = ?', user.org_id);
    if (!o.stripe_customer_id) fail(400, 'Ainda não tem uma subscrição');
    const session = await stripe('POST', '/billing_portal/sessions', { customer: o.stripe_customer_id, return_url: `${core.baseUrl(req)}/#/subscricao` });
    return { url: session.url };
  }, { billingExempt: true });

  // ------------------------------------------------------------ webhooks do Stripe
  /** Aplica o estado de uma subscrição do Stripe à organização. */
  function applySubscription(sub, orgIdHint) {
    const orgId = Number(sub.metadata?.org_id || orgIdHint) || one('SELECT id FROM organizations WHERE stripe_customer_id = ?', sub.customer)?.id;
    const o = orgId && one('SELECT * FROM organizations WHERE id = ?', orgId);
    if (!o) return null;
    const plan = planOfPrice(sub.items?.data?.[0]?.price?.id) || sub.metadata?.plan || o.plan;
    const limits = PLANS[plan]?.limits;
    const iso = (s) => (s ? new Date(s * 1000).toISOString() : null);
    run(`UPDATE organizations SET billing_status = ?, stripe_customer_id = ?, stripe_subscription_id = ?, plan = ?,
      current_period_end = ?, cancel_at = ? ${limits ? ', max_clients = ?, max_cis = ?, max_users = ?' : ''} WHERE id = ?`,
    sub.status, sub.customer, sub.id, PLANS[plan] ? plan : o.plan, iso(sub.current_period_end), iso(sub.cancel_at),
    ...(limits ? [limits.max_clients, limits.max_cis, limits.max_users] : []), o.id);
    audit('organization', o.id, null, o.name, 'stripe', 'subscricao', { estado: sub.status, plano: plan }, o.id);
    return o.id;
  }

  add('POST', '/api/stripe/webhook', async ({ req, rawBody, body }) => {
    if (!enabled || !cfg.webhookSecret) fail(404, 'Rota inexistente');
    if (!verifyStripeSignature(rawBody, req.headers['stripe-signature'], cfg.webhookSecret)) fail(400, 'Assinatura inválida');
    // Idempotência: o Stripe pode reenviar o mesmo evento
    if (one('SELECT 1 FROM stripe_events WHERE id = ?', body.id)) return { received: true, duplicate: true };
    const obj = body.data?.object || {};
    if (body.type === 'checkout.session.completed' && obj.mode === 'subscription') {
      const orgId = Number(obj.client_reference_id || obj.metadata?.org_id);
      if (orgId) run('UPDATE organizations SET stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?', obj.customer, obj.subscription, orgId);
      if (obj.subscription) applySubscription(await stripe('GET', `/subscriptions/${obj.subscription}`), orgId);
    } else if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(body.type)) {
      applySubscription(obj);
    } else if (body.type === 'invoice.payment_failed' && obj.subscription) {
      run("UPDATE organizations SET billing_status = 'past_due' WHERE stripe_subscription_id = ?", obj.subscription);
    }
    run('INSERT INTO stripe_events (id, type) VALUES (?, ?)', body.id, body.type);
    return { received: true };
  }, { public: true, billingExempt: true, validate: false });

  return { tx };
};

module.exports.verifyStripeSignature = verifyStripeSignature;
module.exports.stripeForm = stripeForm;
