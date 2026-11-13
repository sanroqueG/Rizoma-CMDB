'use strict';
const crypto = require('node:crypto');
/* Sistema: health check, estado da instalação, cópias de segurança e notificações por email. */
const fs = require('node:fs');
const os = require('node:os');
const { version } = require('../../package.json');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ptDate = (s) => (s ? s.slice(0, 10).split('-').reverse().join('/') : '—');

module.exports = function registerSystem(core) {
  const { add, one, all, run, fail, audit, assertAdmin, assertPlatform, scopeSql, opts } = core;
  const startedAt = Date.now();
  const backups = opts.backups || null;
  const mailer = opts.mailer || null;
  const publicUrl = String(opts.publicUrl ?? process.env.CMDB_PUBLIC_URL ?? '').replace(/\/+$/, '');
  // Variável vazia ou ausente → valor por omissão; CMDB_DIGEST_WEEKDAY=off desliga o envio automático
  const envNum = (v, def) => (v === undefined || String(v).trim() === '' ? def : Number(v));
  const digestCfg = {
    weekday: opts.digestWeekday ?? (process.env.CMDB_DIGEST_WEEKDAY === 'off' ? null : envNum(process.env.CMDB_DIGEST_WEEKDAY, 1)),
    hour: opts.digestHour ?? envNum(process.env.CMDB_DIGEST_HOUR, 8),
  };
  const getSetting = (k) => one('SELECT value FROM settings WHERE key = ?', k)?.value ?? null;
  const setSetting = (k, v) => run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v);

  // ------------------------------------------------------------ health check (público)
  add('GET', '/api/health', ({ ctx }) => {
    let dbOk = false;
    try { dbOk = one('SELECT 1 AS ok').ok === 1; } catch { /* BD indisponível */ }
    if (!dbOk) ctx.status = 503;
    return { ok: dbOk, db: dbOk ? 'ok' : 'erro', version, uptime_s: Math.round((Date.now() - startedAt) / 1000) };
  }, { public: true });

  // ------------------------------------------------------------ métricas (Prometheus)
  // Com CMDB_METRICS_TOKEN: GET /api/metrics com "Authorization: Bearer <token>". Sem token configurado, não existe.
  add('GET', '/api/metrics', ({ req, res, ctx }) => {
    const token = opts.metricsToken ?? process.env.CMDB_METRICS_TOKEN;
    if (!token) fail(404, 'Rota inexistente');
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(token).digest();
    if (!crypto.timingSafeEqual(a, b)) fail(401, 'Token inválido');
    const n = (sql) => one(sql).n;
    let dbBytes = 0;
    if (opts.dbFile && opts.dbFile !== ':memory:') {
      for (const f of [opts.dbFile, `${opts.dbFile}-wal`]) { try { dbBytes += fs.statSync(f).size; } catch { /* sem ficheiro */ } }
    }
    const text = core.metrics.render([
      { name: 'rizoma_organizations', help: 'Organizações por estado de faturação.', value: n("SELECT COUNT(*) n FROM organizations WHERE status = 'active'"), labels: { status: 'active' } },
      { name: 'rizoma_organizations_suspended', help: 'Organizações suspensas.', value: n("SELECT COUNT(*) n FROM organizations WHERE status <> 'active'") },
      { name: 'rizoma_organizations_read_only', help: 'Organizações em modo só de leitura (subscrição ou eliminação pedida).', value: n(`SELECT COUNT(*) n FROM organizations WHERE deletion_requested_at IS NOT NULL
        OR billing_status IN ('canceled', 'unpaid', 'incomplete_expired')
        OR (billing_status = 'trialing' AND stripe_subscription_id IS NULL AND trial_ends_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`) },
      { name: 'rizoma_users', help: 'Utilizadores ativos.', value: n('SELECT COUNT(*) n FROM users WHERE active = 1') },
      { name: 'rizoma_cis', help: 'Ativos registados.', value: n('SELECT COUNT(*) n FROM cis') },
      { name: 'rizoma_sessions', help: 'Sessões válidas.', value: one('SELECT COUNT(*) n FROM sessions WHERE expires_at > ?', Date.now()).n },
      { name: 'rizoma_db_bytes', help: 'Tamanho da base de dados (com WAL).', value: dbBytes },
    ]);
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
    ctx.raw = true;
  }, { public: true });

  // ------------------------------------------------------------ estado (administração)
  add('GET', '/api/system', ({ user }) => {
    assertAdmin(user);
    let dbSize = null;
    if (opts.dbFile && opts.dbFile !== ':memory:') {
      try { dbSize = fs.statSync(opts.dbFile).size + (fs.existsSync(`${opts.dbFile}-wal`) ? fs.statSync(`${opts.dbFile}-wal`).size : 0); } catch { /* sem ficheiro */ }
    }
    // Números da organização de quem pede; o detalhe da instalação (BD, cópias) só para a plataforma
    const org = user.org_id;
    const n = (sql) => one(sql, org).n;
    const counts = {
      clients: n('SELECT COUNT(*) AS n FROM clients WHERE org_id = ?'),
      cis: n('SELECT COUNT(*) AS n FROM cis c JOIN clients cl ON cl.id = c.client_id WHERE cl.org_id = ?'),
      users: n('SELECT COUNT(*) AS n FROM users WHERE org_id = ?'),
      contracts: n('SELECT COUNT(*) AS n FROM contracts k JOIN clients cl ON cl.id = k.client_id WHERE cl.org_id = ?'),
      audit: n('SELECT COUNT(*) AS n FROM audit WHERE org_id = ?'),
    };
    if (!user.is_platform) {
      return { version, platform_admin: false, counts, backups: { enabled: !!backups, managed: true },
        email: mailer ? { enabled: true, from: mailer.from, digest_weekday: digestCfg.weekday, digest_hour: digestCfg.hour, last_digest: getSetting('last_digest_at') } : { enabled: false } };
    }
    return {
      version, platform_admin: true, node: process.version, platform: `${os.type()} ${os.release()}`, uptime_s: Math.round((Date.now() - startedAt) / 1000),
      db: { file: opts.dbFile || null, size: dbSize, schema_version: one('SELECT MAX(id) AS v FROM schema_migrations').v },
      counts,
      backups: backups ? { enabled: true, dir: backups.dir, keep: backups.keep, every_hours: opts.backupHours ?? null, items: backups.list() } : { enabled: false },
      email: mailer
        ? { enabled: true, host: mailer.host, from: mailer.from, digest_weekday: digestCfg.weekday, digest_hour: digestCfg.hour, last_digest: getSetting('last_digest_at') }
        : { enabled: false },
    };
  });

  add('POST', '/api/system/backups', async ({ user }) => {
    assertPlatform(user);
    if (!backups) fail(400, 'As cópias de segurança não estão configuradas');
    const r = await core.runJob('backup', { dir: backups.dir, keep: backups.keep, keyFile: backups.keyFile });
    audit('system', null, null, r.file, user.username, 'backup', null, user.org_id);
    return r;
  });

  // ------------------------------------------------------------ resumo semanal
  /** Conteúdo do resumo para um utilizador, filtrado pelos clientes a que tem acesso. */
  function digestFor(u) {
    const s = scopeSql(u, 'c.client_id');
    const warranties = all(`SELECT c.id, c.name, c.warranty_end, cl.name AS client_name FROM cis c JOIN clients cl ON cl.id = c.client_id
      WHERE ${s.sql} AND c.status <> 'abatido' AND c.warranty_end IS NOT NULL AND c.warranty_end <= date('now', '+30 days')
      ORDER BY c.warranty_end LIMIT 50`, ...s.params);
    const stale = all(`SELECT c.id, c.name, c.last_seen, cl.name AS client_name FROM cis c JOIN clients cl ON cl.id = c.client_id
      WHERE ${s.sql} AND c.source = 'agent' AND c.status <> 'abatido' AND c.last_seen < datetime('now', '-30 days')
      ORDER BY c.last_seen LIMIT 50`, ...s.params);
    const contracts = all(`SELECT c.id, c.name, c.vendor, c.end_date, c.auto_renew, cl.name AS client_name FROM contracts c
      JOIN clients cl ON cl.id = c.client_id
      WHERE ${s.sql} AND c.status = 'ativo' AND c.end_date IS NOT NULL
        AND c.end_date <= date('now', '+' || (COALESCE(c.notice_days, 0) + 30) || ' days')
      ORDER BY c.end_date LIMIT 50`, ...s.params);
    const sc = scopeSql(u, 'k.client_id');
    const connectors = u.role === 'admin' ? all(`SELECT k.client_id, k.last_status, k.last_sync, cl.name AS client_name FROM cloud_connectors k
      JOIN clients cl ON cl.id = k.client_id WHERE ${sc.sql} AND k.enabled = 1 AND k.last_status IN ('erro', 'parcial')`, ...sc.params) : [];
    return { warranties, stale, contracts, connectors, total: warranties.length + stale.length + contracts.length + connectors.length };
  }

  function renderDigest(u, d) {
    const today = new Date().toISOString().slice(0, 10);
    const link = (p, label) => (publicUrl ? `<a href="${esc(publicUrl)}/#${esc(p)}">${esc(label)}</a>` : esc(label));
    const sections = [];
    const text = [`Olá ${u.name},`, '', `Resumo semanal do Rizoma: ${d.total} assunto(s) a precisar de atenção.`, ''];
    function section(title, rows, cols, toText) {
      if (!rows.length) return;
      sections.push(`<h3 style="margin:20px 0 6px;font-size:15px">${esc(title)} (${rows.length})</h3>
        <table cellpadding="6" style="border-collapse:collapse;font-size:13px;width:100%">${rows.map((r) => `<tr style="border-top:1px solid #ddd">${cols(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`);
      text.push(`${title} (${rows.length}):`, ...rows.map((r) => `  - ${toText(r)}`), '');
    }
    section('Garantias expiradas ou a expirar em 30 dias', d.warranties,
      (w) => [link(`/ativos/${w.id}`, w.name), esc(w.client_name), `${w.warranty_end < today ? '<b style="color:#b42318">expirou</b>' : 'expira'} ${ptDate(w.warranty_end)}`],
      (w) => `${w.name} (${w.client_name}): ${w.warranty_end < today ? 'expirou' : 'expira'} ${ptDate(w.warranty_end)}`);
    section('Contratos a renovar', d.contracts,
      (c) => [link(`/contratos/${c.id}`, c.name), esc(c.client_name), `${esc(c.vendor || '')}`, `${c.end_date < today ? '<b style="color:#b42318">terminou</b>' : 'termina'} ${ptDate(c.end_date)}${c.auto_renew ? ' (renovação automática)' : ''}`],
      (c) => `${c.name} (${c.client_name}${c.vendor ? `, ${c.vendor}` : ''}): ${c.end_date < today ? 'terminou' : 'termina'} ${ptDate(c.end_date)}${c.auto_renew ? ' (renovação automática)' : ''}`);
    section('Agentes sem contacto há mais de 30 dias', d.stale,
      (a) => [link(`/ativos/${a.id}`, a.name), esc(a.client_name), `último contacto ${ptDate(a.last_seen)}`],
      (a) => `${a.name} (${a.client_name}): último contacto ${ptDate(a.last_seen)}`);
    section('Conectores Microsoft 365 / Azure com erros', d.connectors,
      (k) => [link(`/clientes/${k.client_id}`, k.client_name), k.last_status === 'erro' ? 'erro' : 'parcial', `última sincronização ${ptDate(k.last_sync)}`],
      (k) => `${k.client_name}: ${k.last_status} (última sincronização ${ptDate(k.last_sync)})`);
    if (publicUrl) text.push(`Abrir o Rizoma: ${publicUrl}`, '');
    text.push('Para deixar de receber este resumo, desligue-o em "A minha conta".');
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#182433;max-width:720px">
      <div style="border-top:3px solid #0f6b73;padding-top:12px;margin-bottom:16px;font-weight:700;font-size:18px;color:#0f6b73">rizoma</div>
      <p>Olá ${esc(u.name)},</p><p>Resumo semanal do Rizoma: <b>${d.total}</b> assunto(s) a precisar de atenção.</p>
      ${sections.join('')}
      <p style="margin-top:24px;color:#667085;font-size:12px">${publicUrl ? `${link('/', 'Abrir o Rizoma')} · ` : ''}Para deixar de receber este resumo, desligue-o em "A minha conta".</p></div>`;
    return { subject: `Rizoma: ${d.total} assunto(s) a precisar de atenção`, text: text.join('\n'), html };
  }

  /** Envia o resumo a todos os utilizadores ativos com email (admin e técnicos). Resumos vazios não são enviados. */
  async function sendDigests(actor, orgId = null) {
    if (!mailer) fail(400, 'O envio de email não está configurado (CMDB_SMTP_HOST)');
    const users = all(`SELECT * FROM users WHERE active = 1 AND notify_digest = 1 AND email IS NOT NULL AND email <> ''
      AND role IN ('admin', 'tech') ${orgId ? 'AND org_id = ?' : ''} ORDER BY id`, ...(orgId ? [orgId] : []));
    const report = { sent: 0, empty: 0, failed: [] };
    for (const u of users) {
      const d = digestFor(u);
      if (!d.total) { report.empty++; continue; }
      try {
        await mailer.send({ to: u.email, ...renderDigest(u, d) });
        report.sent++;
      } catch (e) {
        report.failed.push({ user: u.username, error: e.message });
      }
    }
    setSetting('last_digest_at', new Date().toISOString());
    audit('system', null, null, 'Resumo semanal', actor, 'digest', { enviados: report.sent, vazios: report.empty, falhados: report.failed.length }, orgId);
    return report;
  }

  /** Retenção da auditoria: apaga eventos com mais de N dias (0 = guardar tudo). Uma vez por dia. */
  const retentionDays = opts.auditRetentionDays ?? envNum(process.env.CMDB_AUDIT_RETENTION_DAYS, 730);
  function purgeAudit(now = new Date()) {
    if (!retentionDays) return null;
    const last = getSetting('last_audit_purge');
    if (last && new Date(last).toDateString() === now.toDateString()) return null;
    const r = run("DELETE FROM audit WHERE created_at < datetime('now', ?)", `-${Number(retentionDays)} days`);
    setSetting('last_audit_purge', now.toISOString());
    return Number(r.changes);
  }

  /** Chamado periodicamente: envia o resumo no dia/hora configurados, uma vez por dia. */
  async function runScheduledDigest(now = new Date()) {
    if (!mailer || digestCfg.weekday === null || Number.isNaN(digestCfg.weekday)) return null;
    if (now.getDay() !== digestCfg.weekday || now.getHours() < digestCfg.hour) return null;
    const last = getSetting('last_digest_at');
    if (last && new Date(last).toDateString() === now.toDateString()) return null;
    return sendDigests('agendamento');
  }

  add('GET', '/api/me/digest', ({ user }) => {
    const d = digestFor(user);
    return { ...d, preview: renderDigest(user, d).text };
  });

  add('PUT', '/api/me/notifications', ({ user, body }) => {
    run('UPDATE users SET notify_digest = ? WHERE id = ?', body.digest ? 1 : 0, user.id);
    return { digest: !!body.digest };
  });

  add('POST', '/api/system/email/test', async ({ user }) => {
    assertAdmin(user);
    if (!mailer) fail(400, 'O envio de email não está configurado (CMDB_SMTP_HOST)');
    if (!user.email) fail(400, 'Defina o seu email no perfil de utilizador para receber o teste');
    try {
      await mailer.send({ to: user.email, subject: 'Rizoma: email de teste', text: `Olá ${user.name},\n\nO envio de email do Rizoma está a funcionar.`,
        html: `<p>Olá ${esc(user.name)},</p><p>O envio de email do Rizoma está a funcionar.</p>` });
    } catch (e) {
      fail(502, `Falha no envio: ${e.message}`);
    }
    return { ok: true, to: user.email };
  });

  add('POST', '/api/system/digest', async ({ user }) => {
    assertAdmin(user);
    // Um administrador de organização envia só à sua organização; a plataforma envia a todas
    return sendDigests(user.username, user.is_platform ? null : user.org_id);
  });

  return { runScheduledDigest, sendDigests, digestFor, purgeAudit, retentionDays };
};
