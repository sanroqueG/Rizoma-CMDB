'use strict';
/*
 * Avisos e webhooks: eventos do Rizoma enviados para o Slack, o Microsoft Teams ou um URL qualquer.
 *
 * Os eventos nascem da auditoria (todas as alterações passam por ela) e entram numa fila na BD,
 * na mesma transação da alteração. Um processo envia a fila com novas tentativas (1 min, 5 min, 30 min, 2 h, 6 h).
 * No Slack e no Teams, várias alterações pendentes do mesmo destino seguem numa só mensagem (sem inundar o canal).
 * Webhooks genéricos recebem um JSON por evento, assinado com HMAC-SHA256 (cabeçalho X-Rizoma-Signature).
 */
const crypto = require('node:crypto');
const dns = require('node:dns');
const net = require('node:net');

const EVENTS = {
  'ci.created': 'Ativo criado',
  'ci.updated': 'Ativo alterado',
  'ci.status_changed': 'Estado de um ativo mudou',
  'ci.deleted': 'Ativo eliminado',
  'contract.created': 'Contrato criado',
  'contract.updated': 'Contrato alterado',
  'contract.deleted': 'Contrato eliminado',
  'contract.expiring': 'Contrato a expirar (30 e 7 dias antes)',
  'ticket.created': 'Ticket criado',
  'ticket.updated': 'Ticket alterado',
  'client.created': 'Cliente criado',
  'client.deleted': 'Cliente eliminado',
  'sync.failed': 'Sincronização falhou (Microsoft 365, NinjaOne)',
  'vulnerability.detected': 'Novas vulnerabilidades encontradas',
};
const ENTITY_LABEL = { ci: 'Ativo', contract: 'Contrato', ticket: 'Ticket', client: 'Cliente', connector: 'Integração' };
const RETRY_MINUTES = [1, 5, 30, 120, 360];
const DISABLE_AFTER = 50; // falhas seguidas até o destino ser desligado
const CHAT_BATCH = 10;

/** Eventos a partir de uma linha da auditoria. */
function eventsFromAudit(a) {
  const base = { ci: 'ci', contract: 'contract', ticket: 'ticket', client: 'client' }[a.entity];
  const out = [];
  if (base && ['create', 'update', 'delete'].includes(a.action)) {
    const verb = { create: 'created', update: 'updated', delete: 'deleted' }[a.action];
    if (EVENTS[`${base}.${verb}`]) out.push(`${base}.${verb}`);
    if (base === 'ci' && a.action === 'update' && a.changes && a.changes.status) out.push('ci.status_changed');
  }
  if (a.entity === 'connector' && a.action === 'sync' && a.changes && a.changes.estado === 'erro') out.push('sync.failed');
  return out;
}

/** Verifica se um endereço é privado/interno (proteção contra SSRF nos webhooks genéricos). */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return isPrivateIp(x.slice(7));
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80');
}

/** Valida o URL de destino. kind: slack | teams | generic. */
function validateUrl(kind, raw) {
  let u;
  try { u = new URL(raw); } catch { return 'URL inválido'; }
  if (u.protocol !== 'https:') return 'O URL tem de usar https';
  if (u.username || u.password) return 'O URL não pode ter credenciais';
  if (kind === 'slack' && u.hostname !== 'hooks.slack.com') return 'Use o URL de um "Incoming Webhook" do Slack (https://hooks.slack.com/…)';
  if (net.isIP(u.hostname) && isPrivateIp(u.hostname)) return 'Endereços internos não são permitidos';
  return null;
}

/** Assinatura do corpo: t=<segundos>,v1=<hex HMAC-SHA256(secret, `${t}.${corpo}`)> (verificação no recetor). */
function sign(secret, body, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/** Texto curto e legível de um evento (Slack/Teams). */
function describe(p) {
  const who = p.actor ? ` por ${p.actor}` : '';
  const where = p.client ? `${p.client.name}: ` : '';
  const what = p.entity ? `${ENTITY_LABEL[p.entity.type] || p.entity.type} "${p.entity.label || p.entity.id}"` : '';
  const ch = p.changes && p.changes.status && Array.isArray(p.changes.status) ? ` (estado: ${p.changes.status[0]} → ${p.changes.status[1]})` : '';
  switch (p.event) {
    case 'contract.expiring': return `${where}o contrato "${p.entity.label}" termina em ${p.data.end_date} (${p.data.days} dias)`;
    case 'sync.failed': return `${where}a sincronização "${p.entity.label}" falhou`;
    case 'vulnerability.detected': return `${where}${p.data.new_cves} vulnerabilidade(s) nova(s) em ${p.data.cis} ativo(s)${p.data.kev ? `, ${p.data.kev} já exploradas ativamente (CISA KEV)` : ''}`;
    case 'test': return 'Mensagem de teste do Rizoma: a ligação funciona.';
    default: return `${where}${what} ${EVENTS[p.event] ? EVENTS[p.event].toLowerCase().replace(/^(ativo|contrato|ticket|cliente) /, '') : p.event}${ch}${who}`;
  }
}

/** Corpo HTTP para um destino, a partir de um ou mais eventos. */
function formatBody(kind, events, appUrl) {
  if (kind === 'generic') return JSON.stringify(events[0]);
  const lines = events.slice(0, CHAT_BATCH).map((p) => `• ${describe(p)}`);
  if (events.length > CHAT_BATCH) lines.push(`… e mais ${events.length - CHAT_BATCH} alterações`);
  const title = events.length === 1 ? 'Rizoma' : `Rizoma: ${events.length} alterações`;
  const link = events.length === 1 ? events[0].url : appUrl;
  if (kind === 'slack') {
    return JSON.stringify({ text: `*${title}*\n${lines.join('\n')}${link ? `\n<${link}|Abrir no Rizoma>` : ''}` });
  }
  // Teams (Workflows "post to a channel when a webhook request is received"): Adaptive Card
  return JSON.stringify({
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
        body: [{ type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium' }, ...lines.map((l) => ({ type: 'TextBlock', text: l, wrap: true }))],
        actions: link ? [{ type: 'Action.OpenUrl', title: 'Abrir no Rizoma', url: link }] : [],
      },
    }],
  });
}

/** @param {{ one: any, all: any, run: any, tx: any, box: any, fetchFn: any, log: any, opts?: any }} deps */
function createWebhooks({ one, all, run, tx, box, fetchFn, log, opts = {} }) {
  const lookup = opts.webhookLookup || ((host) => dns.promises.lookup(host, { all: true }));
  const appUrl = () => String(opts.publicUrl ?? process.env.CMDB_PUBLIC_URL ?? '').replace(/\/+$/, '');
  const urlFor = (entity, id) => {
    const base = appUrl();
    if (!base || !id) return null;
    return { ci: `${base}/#/ativos/${id}`, contract: `${base}/#/contratos/${id}`, client: `${base}/#/clientes/${id}` }[entity] || `${base}/#/`;
  };

  /** Coloca um evento na fila de todos os destinos da organização que o subscrevem. */
  function enqueue(orgId, event, payload) {
    if (!orgId) return 0;
    const hooks = all('SELECT id, events, client_id FROM webhooks WHERE org_id = ? AND enabled = 1', orgId);
    let n = 0;
    for (const w of hooks) {
      if (!JSON.parse(w.events).includes(event)) continue;
      if (w.client_id && payload.client?.id !== w.client_id) continue;
      const body = { id: crypto.randomUUID(), event, occurred_at: new Date().toISOString(), ...payload };
      run('INSERT INTO webhook_deliveries (webhook_id, event, payload, next_attempt_at) VALUES (?,?,?,?)', w.id, event, JSON.stringify(body), Date.now());
      n++;
    }
    return n;
  }

  /** Ouvinte da auditoria. */
  function fromAudit(a) {
    const events = eventsFromAudit(a);
    if (!events.length) return;
    const org = a.orgId && one('SELECT id, name FROM organizations WHERE id = ?', a.orgId);
    if (!org) return;
    const client = a.clientId ? one('SELECT id, name FROM clients WHERE id = ?', a.clientId) : null;
    for (const event of events) {
      enqueue(org.id, event, {
        organization: { id: org.id, name: org.name },
        client: client ? { id: client.id, name: client.name } : (a.entity === 'client' && a.entityId ? { id: a.entityId, name: a.label } : null),
        entity: { type: a.entity, id: a.entityId ?? null, label: a.label ?? null },
        actor: a.actor, changes: a.changes ?? null, url: a.action === 'delete' ? null : urlFor(a.entity, a.entityId),
      });
    }
  }

  async function assertPublicHost(url) {
    if (opts.webhookAllowPrivate) return;
    const host = new URL(url).hostname;
    const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host);
    if (addrs.some((x) => isPrivateIp(x.address))) throw new Error('O destino resolve para um endereço interno');
  }

  /** Envia para um destino. Devolve { ok, status, error }. */
  async function send(w, events) {
    try {
      const url = box.open(w.url_enc);
      await assertPublicHost(url);
      const body = formatBody(w.kind, events, appUrl());
      const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Rizoma-Webhooks/1' };
      if (w.kind === 'generic') {
        headers['X-Rizoma-Event'] = events[0].event;
        headers['X-Rizoma-Delivery'] = events[0].id;
        if (w.secret_enc) headers['X-Rizoma-Signature'] = sign(box.open(w.secret_enc), body);
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10e3);
      try {
        const r = await fetchFn(url, { method: 'POST', headers, body, redirect: 'manual', signal: ctrl.signal });
        if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status };
        const text = await r.text().catch(() => '');
        return { ok: false, status: r.status, error: `HTTP ${r.status}${text ? `: ${text.slice(0, 200)}` : ''}` };
      } finally { clearTimeout(timer); }
    } catch (e) {
      return { ok: false, status: null, error: e.name === 'AbortError' ? 'Sem resposta em 10 s' : e.message };
    }
  }

  function record(w, ids, res) {
    const ph = ids.map(() => '?').join(',');
    tx(() => {
      if (res.ok) {
        run(`UPDATE webhook_deliveries SET status = 'ok', attempts = attempts + 1, last_error = NULL, sent_at = ? WHERE id IN (${ph})`, Date.now(), ...ids);
        run("UPDATE webhooks SET failures = 0, last_status = 'ok', last_error = NULL, last_sent_at = datetime('now') WHERE id = ?", w.id);
        return;
      }
      for (const d of all(`SELECT id, attempts FROM webhook_deliveries WHERE id IN (${ph})`, ...ids)) {
        const wait = RETRY_MINUTES[d.attempts];
        if (wait === undefined) run("UPDATE webhook_deliveries SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?", res.error, d.id);
        else run('UPDATE webhook_deliveries SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?', res.error, Date.now() + wait * 60e3, d.id);
      }
      run("UPDATE webhooks SET failures = failures + 1, last_status = 'erro', last_error = ? WHERE id = ?", res.error, w.id);
      const fresh = one('SELECT failures FROM webhooks WHERE id = ?', w.id);
      if (fresh.failures >= DISABLE_AFTER) {
        run('UPDATE webhooks SET enabled = 0 WHERE id = ?', w.id);
        log.error('Webhook desligado após falhas seguidas', { webhook: w.id, err: new Error(res.error) });
      }
    });
  }

  /** Envia o que está pendente. Devolve o número de pedidos HTTP feitos. */
  async function processQueue(now = Date.now()) {
    const due = all(`SELECT d.*, w.kind FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
      WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND w.enabled = 1 ORDER BY d.id LIMIT 500`, now);
    const byHook = new Map();
    for (const d of due) {
      if (!byHook.has(d.webhook_id)) byHook.set(d.webhook_id, []);
      byHook.get(d.webhook_id).push(d);
    }
    let requests = 0;
    for (const [hookId, list] of byHook) {
      const w = one('SELECT * FROM webhooks WHERE id = ?', hookId);
      // Chat: uma mensagem com tudo o que está pendente; genérico: um pedido por evento (pára no 1.º erro)
      const groups = w.kind === 'generic' ? list.map((d) => [d]) : [list];
      for (const g of groups) {
        const res = await send(w, g.map((d) => JSON.parse(d.payload)));
        requests++;
        record(w, g.map((d) => d.id), res);
        if (!res.ok) break;
      }
    }
    // Histórico: entregas concluídas com mais de 30 dias
    run("DELETE FROM webhook_deliveries WHERE status <> 'pending' AND created_at < datetime('now', '-30 days')");
    return requests;
  }

  return { enqueue, fromAudit, processQueue, send, urlFor };
}

module.exports = { createWebhooks, EVENTS, eventsFromAudit, validateUrl, isPrivateIp, sign, formatBody, describe };
