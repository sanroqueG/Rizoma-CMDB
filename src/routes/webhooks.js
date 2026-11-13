'use strict';
/* Configuração dos avisos (Slack, Teams) e webhooks da organização. Ver src/webhooks.js. */
const { fail, toId } = require('../http');
const S = require('../schema');
const { createWebhooks, EVENTS, validateUrl } = require('../webhooks');

const DEFAULT_CHAT_EVENTS = ['ci.status_changed', 'ci.deleted', 'contract.expiring', 'sync.failed', 'vulnerability.detected'];

module.exports = function registerWebhooks(core) {
  const { add, one, all, run, tx, audit, assertAdmin, box, fetchFn, log, opts, store } = core;
  const hooks = createWebhooks({ one, all, run, tx, box, fetchFn, log, opts });
  store.onAudit(hooks.fromAudit);
  core.webhooks = hooks;

  const view = (w) => {
    const url = (() => { try { return box.open(w.url_enc); } catch { return ''; } })();
    let masked = url;
    try { const u = new URL(url); masked = `${u.origin}/…${u.pathname.slice(-6)}`; } catch { /* URL ilegível */ }
    const pending = one("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id = ? AND status = 'pending'", w.id).n;
    return {
      id: w.id, kind: w.kind, name: w.name, url: masked, has_secret: !!w.secret_enc, events: JSON.parse(w.events), client_id: w.client_id,
      enabled: !!w.enabled, last_status: w.last_status, last_error: w.last_error, last_sent_at: w.last_sent_at, failures: w.failures, pending,
    };
  };
  const own = (user, id) => {
    const w = one('SELECT * FROM webhooks WHERE id = ? AND org_id = ?', toId(id), user.org_id);
    if (!w) fail(404, 'Destino não encontrado');
    return w;
  };
  const body = (partial) => S.obj({
    kind: S.str({ enum: ['slack', 'teams', 'generic'], required: !partial, label: 'Tipo' }),
    name: S.str({ max: 80, required: !partial, label: 'Nome' }),
    url: S.str({ max: 1000, truncate: false, required: !partial, label: 'URL' }),
    events: S.arr(S.str({ enum: Object.keys(EVENTS) }), { maxItems: 50 }),
    client_id: S.int({ minimum: 1 }),
    enabled: S.bool(),
  });

  add('GET', '/api/webhooks/events', () => Object.entries(EVENTS).map(([id, label]) => ({ id, label, chat_default: DEFAULT_CHAT_EVENTS.includes(id) })));

  add('GET', '/api/webhooks', ({ user }) => {
    assertAdmin(user);
    return all('SELECT * FROM webhooks WHERE org_id = ? ORDER BY name', user.org_id).map(view);
  });

  add('POST', '/api/webhooks', ({ user, body: b }) => {
    assertAdmin(user);
    const err = validateUrl(b.kind, b.url);
    if (err) fail(400, err);
    if (b.client_id && !one('SELECT 1 FROM clients WHERE id = ? AND org_id = ?', b.client_id, user.org_id)) fail(400, 'Cliente inválido');
    if (one('SELECT COUNT(*) AS n FROM webhooks WHERE org_id = ?', user.org_id).n >= 20) fail(400, 'Máximo de 20 destinos por organização');
    const events = b.events && b.events.length ? b.events : b.kind === 'generic' ? Object.keys(EVENTS) : DEFAULT_CHAT_EVENTS;
    // Webhooks genéricos recebem um segredo de assinatura (mostrado uma só vez)
    const secret = b.kind === 'generic' ? `whsec_${require('node:crypto').randomBytes(24).toString('base64url')}` : null;
    const id = Number(run(`INSERT INTO webhooks (org_id, kind, name, url_enc, secret_enc, events, client_id, enabled) VALUES (?,?,?,?,?,?,?,?)`,
      user.org_id, b.kind, b.name, box.seal(b.url), secret ? box.seal(secret) : null, JSON.stringify(events), b.client_id || null, b.enabled === false ? 0 : 1).lastInsertRowid);
    audit('webhook', id, null, b.name, user.username, 'create', { tipo: b.kind, eventos: events }, user.org_id);
    return { ...view(one('SELECT * FROM webhooks WHERE id = ?', id)), secret };
  }, { body: body(false) });

  add('PUT', '/api/webhooks/:id', ({ user, params, body: b }) => {
    assertAdmin(user);
    const w = own(user, params.id);
    const d = {};
    if (b.name) d.name = b.name;
    if (b.url) {
      const err = validateUrl(w.kind, b.url);
      if (err) fail(400, err);
      d.url_enc = box.seal(b.url);
    }
    if (b.events) d.events = JSON.stringify(b.events);
    if ('client_id' in b) {
      if (b.client_id && !one('SELECT 1 FROM clients WHERE id = ? AND org_id = ?', b.client_id, user.org_id)) fail(400, 'Cliente inválido');
      d.client_id = b.client_id || null;
    }
    if ('enabled' in b) { d.enabled = b.enabled ? 1 : 0; if (b.enabled) d.failures = 0; }
    if (Object.keys(d).length) run(`UPDATE webhooks SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(d), w.id);
    audit('webhook', w.id, null, d.name || w.name, user.username, 'update', { eventos: b.events, ativo: b.enabled, url: b.url ? '(alterado)' : undefined }, user.org_id);
    return view(one('SELECT * FROM webhooks WHERE id = ?', w.id));
  }, { body: body(true) });

  add('DELETE', '/api/webhooks/:id', ({ user, params }) => {
    assertAdmin(user);
    const w = own(user, params.id);
    run('DELETE FROM webhooks WHERE id = ?', w.id);
    audit('webhook', w.id, null, w.name, user.username, 'delete', null, user.org_id);
    return { ok: true };
  });

  /** Envia já uma mensagem de teste e devolve o resultado (não passa pela fila). */
  add('POST', '/api/webhooks/:id/test', async ({ user, params }) => {
    assertAdmin(user);
    const w = own(user, params.id);
    const org = one('SELECT id, name FROM organizations WHERE id = ?', user.org_id);
    const res = await hooks.send(w, [{ id: `teste-${Date.now()}`, event: 'test', occurred_at: new Date().toISOString(), organization: org, actor: user.username }]);
    run('UPDATE webhooks SET last_status = ?, last_error = ? WHERE id = ?', res.ok ? 'ok' : 'erro', res.ok ? null : res.error, w.id);
    return res;
  });

  add('GET', '/api/webhooks/:id/deliveries', ({ user, params }) => {
    assertAdmin(user);
    const w = own(user, params.id);
    return all('SELECT id, event, status, attempts, last_error, created_at, sent_at FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT 50', w.id);
  });

  /** Diário: contratos que terminam daqui a 30 ou 7 dias (uma só vez por dia, guardado em settings). */
  core.emitContractExpiry = (now = new Date()) => {
    const today = now.toISOString().slice(0, 10);
    const done = one("SELECT value FROM settings WHERE key = 'webhooks:contract_expiry'");
    if (done && done.value === today) return null;
    run("INSERT INTO settings (key, value) VALUES ('webhooks:contract_expiry', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", today);
    let n = 0;
    for (const days of [30, 7]) {
      const day = new Date(now.getTime() + days * 864e5).toISOString().slice(0, 10);
      const rows = all(`SELECT k.id, k.name, k.end_date, cl.id AS client_id, cl.name AS client_name, o.id AS org_id, o.name AS org_name
        FROM contracts k JOIN clients cl ON cl.id = k.client_id JOIN organizations o ON o.id = cl.org_id
        WHERE k.end_date = ? AND k.status = 'ativo'`, day);
      for (const k of rows) {
        n += hooks.enqueue(k.org_id, 'contract.expiring', {
          organization: { id: k.org_id, name: k.org_name }, client: { id: k.client_id, name: k.client_name },
          entity: { type: 'contract', id: k.id, label: k.name }, actor: null, data: { end_date: k.end_date, days }, url: hooks.urlFor('contract', k.id),
        });
      }
    }
    return n;
  };
};
