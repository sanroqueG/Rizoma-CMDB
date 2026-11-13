'use strict';
/*
 * SSO por organização (OpenID Connect): cada organização liga o seu Microsoft Entra ID, Google Workspace, Okta...
 * O login começa pelo email: o domínio indica a organização e, com ela, o fornecedor de identidade.
 * O callback só procura utilizadores dessa organização: o fornecedor de uma organização nunca dá acesso a outra.
 */
const { fail, toId } = require('../http');
const { hashPassword, newToken } = require('../auth');
const S = require('../schema');

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// Domínios de email pessoais não podem ser reclamados por uma organização
const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'outlook.pt', 'hotmail.com', 'hotmail.pt', 'live.com', 'live.com.pt',
  'msn.com', 'yahoo.com', 'yahoo.com.br', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'sapo.pt', 'gmx.com', 'gmx.net', 'mail.com']);

module.exports = function registerSso(core) {
  const { add, one, all, run, tx, audit, assertAdmin, assertLimit, addCookie, redirect, createSession, box, fetchFn, secureCookie, oidcPending, createOidc } = core;
  const cache = new Map(); // org_id → { key, client }

  const redirectUri = (req) => `${core.baseUrl(req)}/api/auth/oidc/callback`;
  /** Cliente OIDC da organização (recriado quando a configuração muda). */
  function clientFor(orgId, req) {
    const cfg = one('SELECT * FROM org_sso WHERE org_id = ? AND enabled = 1', orgId);
    if (!cfg) return null;
    const key = `${cfg.updated_at}|${redirectUri(req)}`;
    const hit = cache.get(orgId);
    if (hit && hit.key === key) return hit.client;
    const client = createOidc({
      issuer: cfg.issuer, clientId: cfg.client_id, clientSecret: cfg.client_secret ? box.open(cfg.client_secret) : undefined,
      redirectUri: redirectUri(req), label: cfg.label, fetchFn, pending: oidcPending(orgId),
    });
    cache.set(orgId, { key, client });
    return client;
  }
  core.orgSsoClient = clientFor;
  core.orgHasSso = (orgId) => !!orgId && !!one('SELECT 1 FROM org_sso WHERE org_id = ? AND enabled = 1', orgId);

  /** A organização exige SSO e este utilizador não é administrador (os administradores ficam com a password, como acesso de emergência). */
  core.ssoEnforced = (u) => u.role !== 'admin' && !!one('SELECT 1 FROM org_sso WHERE org_id = ? AND enabled = 1 AND enforce = 1', u.org_id);

  /** Utilizador da organização para as identidades devolvidas; cria-o se a organização o permitir. */
  core.orgSsoUser = (orgId, identities, claims) => {
    const ph = identities.map(() => '?').join(',');
    const u = one(`SELECT * FROM users WHERE org_id = ? AND active = 1 AND (lower(email) IN (${ph}) OR lower(username) IN (${ph}))
      ORDER BY id LIMIT 1`, orgId, ...identities, ...identities);
    if (u) {
      // Quem entra por SSO confirmou o email no fornecedor; um convite pendente fica aceite
      if (u.invite_pending || !u.email_verified_at) run("UPDATE users SET invite_pending = 0, email_verified_at = COALESCE(email_verified_at, datetime('now')) WHERE id = ?", u.id);
      return one('SELECT * FROM users WHERE id = ?', u.id);
    }
    const cfg = one('SELECT auto_provision FROM org_sso WHERE org_id = ?', orgId);
    const email = identities.find((x) => x.includes('@'));
    if (!cfg || !cfg.auto_provision || !email) return null;
    const domain = email.split('@')[1];
    if (!one('SELECT 1 FROM org_sso_domains WHERE domain = ? AND org_id = ?', domain, orgId)) return null; // só emails dos domínios da organização
    if (one('SELECT 1 FROM users WHERE lower(username) = ?', email)) return null;
    assertLimit(orgId, 'users');
    const name = String(claims?.name || email.split('@')[0]).slice(0, 120);
    const id = Number(run(`INSERT INTO users (username, name, email, password_hash, role, org_id, email_verified_at)
      VALUES (?,?,?,?, 'tech', ?, datetime('now'))`, email, name, email, hashPassword(newToken()), orgId).lastInsertRowid);
    audit('user', id, null, email, email, 'create', { origem: 'SSO', perfil: 'tech' }, orgId);
    return one('SELECT * FROM users WHERE id = ?', id);
  };

  // ------------------------------------------------------------ login: email → fornecedor da organização
  add('GET', '/api/auth/sso/start', async ({ query, req, res, ctx }) => {
    const email = String(query.email || '').trim().toLowerCase();
    const domain = email.includes('@') ? email.split('@').pop() : email;
    try {
      const d = one(`SELECT d.org_id FROM org_sso_domains d JOIN org_sso s ON s.org_id = d.org_id AND s.enabled = 1
        JOIN organizations o ON o.id = d.org_id AND o.status = 'active' WHERE d.domain = ?`, domain);
      if (!d) throw new Error(`O domínio ${domain || '(vazio)'} não tem login único configurado. Entre com utilizador e password.`);
      const client = clientFor(d.org_id, req);
      const { url, state } = await client.start();
      addCookie(res, `oidc_state=${state}; HttpOnly; SameSite=Lax; Path=/api/auth/oidc; Max-Age=600${secureCookie ? '; Secure' : ''}`);
      // login_hint: o fornecedor já sugere a conta escrita no Rizoma
      redirect(res, ctx, email.includes('@') ? `${url}&login_hint=${encodeURIComponent(email)}` : url);
    } catch (e) {
      redirect(res, ctx, `/#/?sso_erro=${encodeURIComponent(e.message)}`);
    }
  }, { public: true });

  // ------------------------------------------------------------ configuração (administrador da organização)
  const view = (orgId) => {
    const c = one('SELECT * FROM org_sso WHERE org_id = ?', orgId);
    const domains = all('SELECT domain FROM org_sso_domains WHERE org_id = ? ORDER BY domain', orgId).map((r) => r.domain);
    return {
      configured: !!c, enabled: !!c?.enabled, label: c?.label || '', issuer: c?.issuer || '', client_id: c?.client_id || '',
      has_secret: !!c?.client_secret, auto_provision: !!c?.auto_provision, enforce: !!c?.enforce, domains,
      redirect_uri: null,
    };
  };

  add('GET', '/api/org/sso', ({ user, req }) => {
    assertAdmin(user);
    return { ...view(user.org_id), redirect_uri: redirectUri(req) };
  });

  add('PUT', '/api/org/sso', ({ user, body, req }) => {
    assertAdmin(user);
    let issuer;
    try { issuer = new URL(body.issuer); } catch { fail(400, 'O emissor (issuer) tem de ser um URL'); }
    if (issuer.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(issuer.hostname)) fail(400, 'O emissor tem de usar https');
    const domains = [...new Set((body.domains || []).map((x) => String(x).trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
    if (!domains.length) fail(400, 'Indique pelo menos um domínio de email (ex.: empresa.pt)');
    for (const d of domains) {
      if (!DOMAIN_RE.test(d)) fail(400, `Domínio inválido: ${d}`);
      if (PUBLIC_DOMAINS.has(d)) fail(400, `O domínio ${d} é de email pessoal e não pode ser usado`);
      const owner = one('SELECT org_id FROM org_sso_domains WHERE domain = ?', d);
      if (owner && owner.org_id !== user.org_id) fail(409, `O domínio ${d} já está associado a outra organização. Contacte o suporte.`);
    }
    const prev = one('SELECT * FROM org_sso WHERE org_id = ?', user.org_id);
    const secret = body.client_secret ? box.seal(body.client_secret) : prev?.client_secret || null;
    tx(() => {
      run(`INSERT INTO org_sso (org_id, enabled, label, issuer, client_id, client_secret, auto_provision, enforce, updated_at)
        VALUES (?,?,?,?,?,?,?,?, strftime('%Y-%m-%d %H:%M:%f','now'))
        ON CONFLICT(org_id) DO UPDATE SET enabled = excluded.enabled, label = excluded.label, issuer = excluded.issuer, client_id = excluded.client_id,
          client_secret = excluded.client_secret, auto_provision = excluded.auto_provision, enforce = excluded.enforce, updated_at = excluded.updated_at`,
      user.org_id, body.enabled === false ? 0 : 1, body.label || null, issuer.toString().replace(/\/+$/, ''), body.client_id, secret,
      body.auto_provision ? 1 : 0, body.enforce ? 1 : 0);
      run('DELETE FROM org_sso_domains WHERE org_id = ?', user.org_id);
      for (const d of domains) run('INSERT INTO org_sso_domains (domain, org_id) VALUES (?,?)', d, user.org_id);
    });
    cache.delete(user.org_id);
    audit('organization', user.org_id, null, 'SSO', user.username, prev ? 'update' : 'create',
      { emissor: issuer.host, dominios: domains, criar_utilizadores: !!body.auto_provision, obrigatorio: !!body.enforce }, user.org_id);
    return { ...view(user.org_id), redirect_uri: redirectUri(req) };
  }, {
    body: S.obj({
      enabled: S.bool(),
      label: S.str({ max: 60 }),
      issuer: S.str({ max: 300, required: true, label: 'Emissor' }),
      client_id: S.str({ max: 300, required: true, label: 'Client ID' }),
      client_secret: S.str({ max: 1000, truncate: false }),
      domains: S.arr(S.str({ max: 253 }), { maxItems: 20 }),
      auto_provision: S.bool(),
      enforce: S.bool(),
    }),
  });

  add('DELETE', '/api/org/sso', ({ user }) => {
    assertAdmin(user);
    tx(() => {
      run('DELETE FROM org_sso_domains WHERE org_id = ?', user.org_id);
      run('DELETE FROM org_sso WHERE org_id = ?', user.org_id);
    });
    cache.delete(user.org_id);
    audit('organization', user.org_id, null, 'SSO', user.username, 'delete', null, user.org_id);
    return { ok: true };
  });

  /** Testa a ligação ao fornecedor (descoberta OIDC), sem iniciar sessão. */
  add('POST', '/api/org/sso/test', async ({ user, req }) => {
    assertAdmin(user);
    const client = clientFor(user.org_id, req);
    if (!client) fail(400, 'Guarde e ative a configuração primeiro');
    try {
      const d = await client.discover();
      return { ok: true, issuer: d.issuer, authorization_endpoint: d.authorization_endpoint };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  return { toId };
};
