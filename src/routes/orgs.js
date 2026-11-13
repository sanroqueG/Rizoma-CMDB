'use strict';
/*
 * Organizações (SaaS): registo self-service, dados da própria organização (incluindo exportação completa)
 * e administração da plataforma (criar, suspender e alterar limites de organizações).
 */
const { hashPassword } = require('../auth');

const PLAN_FIELDS = ['max_clients', 'max_cis', 'max_users'];

/** "Acme Serviços, Lda." → "acme-servicos-lda" */
function slugify(name) {
  return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org';
}

module.exports = function registerOrgs(core) {
  const { add, one, all, run, tx, audit, fail, str, reqStr, toId, assertAdmin, assertPlatform, checkPassword, createSession, meView, opts, SECURITY_HEADERS } = core;
  const env = process.env;
  core.signupEnabled = opts.signup ?? env.CMDB_SIGNUP === '1';
  const intOrNull = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : Number(v));
  const defaultLimits = opts.defaultLimits || {
    max_clients: intOrNull(env.CMDB_PLAN_MAX_CLIENTS), max_cis: intOrNull(env.CMDB_PLAN_MAX_CIS), max_users: intOrNull(env.CMDB_PLAN_MAX_USERS),
  };

  function uniqueSlug(name) {
    const base = slugify(name);
    let slug = base;
    for (let i = 2; one('SELECT 1 FROM organizations WHERE slug = ?', slug); i++) slug = `${base}-${i}`;
    return slug;
  }
  function readLimits(body) {
    const out = {};
    for (const f of PLAN_FIELDS) {
      if (!(f in body)) continue;
      const v = body[f];
      if (v === null || v === '') { out[f] = null; continue; }
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 1e7) fail(400, `Limite inválido: ${f}`);
      out[f] = n;
    }
    return out;
  }
  function usage(orgId) {
    return one(`SELECT
      (SELECT COUNT(*) FROM clients WHERE org_id = ?) AS clients,
      (SELECT COUNT(*) FROM cis c JOIN clients cl ON cl.id = c.client_id WHERE cl.org_id = ?) AS cis,
      (SELECT COUNT(*) FROM users WHERE org_id = ?) AS users`, orgId, orgId, orgId);
  }
  const orgView = (o) => ({
    support_until: o.support_access_until && o.support_access_until > new Date().toISOString() ? o.support_access_until : null, ...o, usage: usage(o.id) });

  /** Cria a organização e o seu primeiro administrador. */
  /** @param {{ orgName: any, plan?: string, limits: any, admin: any }} o */
  function createOrg({ orgName, plan, limits, admin }) {
    const name = reqStr(orgName, 'Nome da organização', 120);
    const username = reqStr(admin.username, 'Utilizador', 60);
    if (!/^[A-Za-z0-9._@-]{3,60}$/.test(username)) fail(400, 'Utilizador: 3 a 60 caracteres (letras, números, . _ @ -)');
    const email = str(admin.email, 160);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'Email inválido');
    checkPassword(String(admin.password || ''), username);
    if (one('SELECT 1 FROM users WHERE username = ?', username)) fail(409, 'Esse nome de utilizador já está a ser usado');
    return tx(() => {
      const r = run('INSERT INTO organizations (name, slug, plan, max_clients, max_cis, max_users) VALUES (?,?,?,?,?,?)',
        name, uniqueSlug(name), plan || 'standard', limits.max_clients ?? null, limits.max_cis ?? null, limits.max_users ?? null);
      const orgId = Number(r.lastInsertRowid);
      const u = run(`INSERT INTO users (username, name, email, password_hash, role, org_id, must_change_password)
        VALUES (?,?,?,?, 'admin', ?, ?)`, username, reqStr(admin.name, 'Nome', 120), email, hashPassword(String(admin.password)), orgId,
      admin.mustChange ? 1 : 0);
      return { orgId, userId: Number(u.lastInsertRowid) };
    });
  }

  // ------------------------------------------------------------ registo self-service
  add('POST', '/api/signup', async ({ body, req, res }) => {
    if (!core.signupEnabled) fail(404, 'O registo de novas organizações não está ativo');
    const key = `signup:${req.socket.remoteAddress}`;
    if (core.state.throttle.blocked(key, 5, 3600e3)) fail(429, 'Demasiados registos a partir deste endereço. Tente mais tarde.');
    core.state.throttle.hit(key, 3600e3);
    if (core.legal.termsUrl && body.accept_terms !== true) fail(400, 'Para criar a conta, aceite os Termos de Serviço e a Política de Privacidade');
    const { orgId, userId } = createOrg({
      orgName: body.organization, limits: defaultLimits,
      admin: { username: body.username, name: body.name, email: body.email, password: body.password },
    });
    core.startTrial(orgId); // período experimental (só quando os pagamentos estão ligados)
    if (core.legal.termsUrl) run("UPDATE users SET terms_accepted_at = datetime('now'), terms_version = ? WHERE id = ?", core.legal.version || 'sem versão', userId);
    let u = one('SELECT * FROM users WHERE id = ?', userId);
    // Verificação do email: com email configurado envia a ligação; sem email não há forma de verificar
    if (u.email && core.accountsMailerReady()) await core.sendVerification(u, req);
    else run("UPDATE users SET email_verified_at = datetime('now') WHERE id = ?", u.id);
    u = one('SELECT * FROM users WHERE id = ?', userId);
    createSession(res, u, 'password');
    audit('organization', orgId, null, body.organization, u.username, 'create', { origem: 'registo' }, orgId);
    return meView(u, 'password');
  }, { public: true });

  // ------------------------------------------------------------ a minha organização
  add('GET', '/api/org', ({ user }) => {
    const o = one('SELECT * FROM organizations WHERE id = ?', user.org_id);
    return orgView(o);
  });

  add('PUT', '/api/org', ({ user, body }) => {
    assertAdmin(user);
    const name = reqStr(body.name, 'Nome da organização', 120);
    run('UPDATE organizations SET name = ? WHERE id = ?', name, user.org_id);
    audit('organization', user.org_id, null, name, user.username, 'update', { name }, user.org_id);
    return orgView(one('SELECT * FROM organizations WHERE id = ?', user.org_id));
  });

  /** Exportação completa dos dados da organização (portabilidade, RGPD art.º 20.º). Sem segredos nem hashes. */
  add('GET', '/api/org/export', ({ user, res, ctx }) => {
    assertAdmin(user);
    const org = user.org_id;
    const inClients = 'client_id IN (SELECT id FROM clients WHERE org_id = ?)';
    const data = {
      exported_at: new Date().toISOString(),
      organization: one('SELECT id, name, slug, plan, created_at FROM organizations WHERE id = ?', org),
      clients: all('SELECT * FROM clients WHERE org_id = ?', org),
      sites: all(`SELECT * FROM sites WHERE ${inClients}`, org),
      cis: all(`SELECT * FROM cis WHERE ${inClients}`, org).map((c) => ({ ...c, attributes: JSON.parse(c.attributes || '{}') })),
      relationships: all('SELECT r.* FROM relationships r JOIN cis c ON c.id = r.source_id JOIN clients cl ON cl.id = c.client_id WHERE cl.org_id = ?', org),
      contracts: all(`SELECT * FROM contracts WHERE ${inClients}`, org),
      contract_cis: all('SELECT x.* FROM contract_cis x JOIN contracts k ON k.id = x.contract_id JOIN clients cl ON cl.id = k.client_id WHERE cl.org_id = ?', org),
      tickets: all(`SELECT * FROM tickets WHERE ${inClients}`, org),
      ticket_cis: all('SELECT x.* FROM ticket_cis x JOIN tickets t ON t.id = x.ticket_id JOIN clients cl ON cl.id = t.client_id WHERE cl.org_id = ?', org),
      users: all(`SELECT id, username, name, email, role, client_id, active, created_at FROM users WHERE org_id = ?`, org),
      user_clients: all('SELECT uc.* FROM user_clients uc JOIN users u ON u.id = uc.user_id WHERE u.org_id = ?', org),
      audit: all('SELECT * FROM audit WHERE org_id = ? ORDER BY id DESC LIMIT 50000', org),
    };
    audit('organization', org, null, 'Exportação de dados', user.username, 'export', null, org);
    res.writeHead(200, {
      ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="rizoma-${data.organization.slug}-${data.exported_at.slice(0, 10)}.json"`,
    });
    res.end(JSON.stringify(data, null, 2));
    ctx.raw = true;
  });

  // ------------------------------------------------------------ plataforma
  add('GET', '/api/platform/orgs', ({ user }) => {
    assertPlatform(user);
    return all('SELECT * FROM organizations ORDER BY name').map(orgView);
  });

  add('POST', '/api/platform/orgs', ({ user, body }) => {
    assertPlatform(user);
    const { orgId } = createOrg({
      orgName: body.name, plan: str(body.plan, 40), limits: { ...defaultLimits, ...readLimits(body) },
      admin: { username: body.admin_username, name: body.admin_name, email: body.admin_email, password: body.admin_password, mustChange: true },
    });
    audit('organization', orgId, null, body.name, user.username, 'create', { origem: 'plataforma' }, user.org_id);
    return orgView(one('SELECT * FROM organizations WHERE id = ?', orgId));
  });

  add('PUT', '/api/platform/orgs/:id', ({ user, params, body }) => {
    assertPlatform(user);
    const o = one('SELECT * FROM organizations WHERE id = ?', toId(params.id));
    if (!o) fail(404, 'Organização não encontrada');
    const d = readLimits(body);
    if ('name' in body) d.name = reqStr(body.name, 'Nome', 120);
    if ('plan' in body) d.plan = reqStr(body.plan, 'Plano', 40);
    if ('status' in body) {
      if (!['active', 'suspended'].includes(body.status)) fail(400, 'Estado inválido');
      if (o.id === user.org_id && body.status !== 'active') fail(400, 'Não pode suspender a sua própria organização');
      d.status = body.status;
    }
    if (Object.keys(d).length) {
      run(`UPDATE organizations SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(d), o.id);
      if (d.status === 'suspended') run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE org_id = ?)', o.id);
    }
    audit('organization', o.id, null, d.name || o.name, user.username, 'update', d, user.org_id);
    return orgView(one('SELECT * FROM organizations WHERE id = ?', o.id));
  });

  add('DELETE', '/api/platform/orgs/:id', ({ user, params, query }) => {
    assertPlatform(user);
    const o = one('SELECT * FROM organizations WHERE id = ?', toId(params.id));
    if (!o) fail(404, 'Organização não encontrada');
    if (o.id === user.org_id) fail(400, 'Não pode eliminar a sua própria organização');
    if (String(query.confirm || '') !== o.slug) fail(400, 'Confirme a eliminação indicando o identificador da organização');
    const u = usage(o.id);
    run('DELETE FROM organizations WHERE id = ?', o.id);
    audit('organization', o.id, null, o.name, user.username, 'delete', u, user.org_id);
    return { ok: true };
  });

  return { slugify };
};
