'use strict';
/*
 * Contas: recuperação de password, convites por email e verificação de email.
 * Os tokens são de uso único, expiram e só o hash fica na BD (tabela user_tokens).
 * O pedido de recuperação responde sempre igual, exista ou não a conta (não revela contas).
 */
const { newToken, sha256, hashPassword } = require('../auth');
const S = require('../schema');
const { resetEmail, inviteEmail, verifyEmail } = require('../emails');

const TTL = { reset: 60 * 60e3, invite: 7 * 24 * 3600e3, verify: 48 * 3600e3 };

module.exports = function registerAccounts(core) {
  const { add, one, all, run, tx, audit, fail, assertAdmin, assertSameOrg, assertLimit, checkPassword, createSession, meView, opts, state, log } = core;
  const mailer = () => opts.mailer || null;

  /** URL pública da aplicação (CMDB_PUBLIC_URL) ou, na falta, a do próprio pedido. */
  function baseUrl(req) {
    const configured = String(opts.publicUrl ?? process.env.CMDB_PUBLIC_URL ?? '').replace(/\/+$/, '');
    if (configured) return configured;
    return `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
  }
  /** Cria um token (invalidando os anteriores com o mesmo fim) e devolve o valor em claro. */
  function issue(userId, purpose) {
    run('UPDATE user_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL', Date.now(), userId, purpose);
    const token = newToken();
    run('INSERT INTO user_tokens (token_hash, user_id, purpose, expires_at) VALUES (?,?,?,?)', sha256(token), userId, purpose, Date.now() + TTL[purpose]);
    return token;
  }
  /** Token válido (não usado, não expirado) com o fim indicado; devolve { row, user } ou falha. */
  function redeem(token, purpose) {
    const row = one('SELECT * FROM user_tokens WHERE token_hash = ? AND purpose = ?', sha256(String(token || '')), purpose);
    if (!row || row.used_at || row.expires_at < Date.now()) {
      fail(400, purpose === 'invite' ? 'O convite já não é válido. Peça um novo ao administrador.' : 'A ligação já não é válida. Peça uma nova.');
    }
    const user = one(`SELECT u.*, o.name AS org_name, o.status AS org_status FROM users u JOIN organizations o ON o.id = u.org_id
      WHERE u.id = ?`, row.user_id);
    if (!user || !user.active || user.org_status !== 'active') fail(400, 'A conta não está ativa.');
    return { row, user };
  }
  const use = (row) => run('UPDATE user_tokens SET used_at = ? WHERE token_hash = ?', Date.now(), row.token_hash);
  async function send(to, message) {
    const m = mailer();
    if (!m || !to) return false;
    try {
      await m.send({ to, ...message });
      return true;
    } catch (e) {
      log.error('Falha a enviar email', { para: to, err: e });
      return false;
    }
  }
  core.sendVerification = async (user, req) => {
    const token = issue(user.id, 'verify');
    return send(user.email, verifyEmail({ name: user.name, url: `${baseUrl(req)}/#/verificar-email?token=${token}`, hours: TTL.verify / 3600e3 }));
  };
  core.accountsMailerReady = () => !!mailer();
  core.baseUrl = baseUrl;

  // ------------------------------------------------------------ recuperação de password
  add('POST', '/api/password/forgot', async ({ body, req }) => {
    const login = String(body.login || '').trim().toLowerCase();
    const ipKey = `forgot:${req.socket.remoteAddress}`;
    if (state.throttle.blocked(ipKey, 10, 3600e3)) fail(429, 'Demasiados pedidos. Tente novamente mais tarde.');
    state.throttle.hit(ipKey, 3600e3);
    const ok = { ok: true, message: 'Se existir uma conta com esse utilizador ou email, enviámos uma ligação para redefinir a password.' };
    if (!login) return ok;
    const users = all(`SELECT u.* FROM users u JOIN organizations o ON o.id = u.org_id
      WHERE u.active = 1 AND o.status = 'active' AND u.invite_pending = 0 AND (lower(u.username) = ? OR lower(u.email) = ?) LIMIT 5`, login, login);
    for (const u of users) {
      if (!u.email || core.ssoEnforced(u)) continue; // com SSO obrigatório a password não serve para entrar
      const key = `forgot-user:${u.id}`;
      if (state.throttle.blocked(key, 3, 3600e3)) continue; // no máximo 3 emails por hora por conta
      state.throttle.hit(key, 3600e3);
      const token = issue(u.id, 'reset');
      await send(u.email, resetEmail({ name: u.name, url: `${baseUrl(req)}/#/redefinir?token=${token}`, minutes: TTL.reset / 60e3 }));
      audit('user', u.id, null, u.username, u.username, 'password_reset_pedido');
    }
    return ok;
  }, { public: true, body: S.obj({ login: S.str({ max: 160 }) }) });

  add('POST', '/api/password/reset', ({ body }) => {
    const { row, user } = redeem(body.token, 'reset');
    checkPassword(String(body.password || ''), user.username);
    tx(() => {
      use(row);
      run(`UPDATE users SET password_hash = ?, must_change_password = 0, email_verified_at = COALESCE(email_verified_at, datetime('now'))
        WHERE id = ?`, hashPassword(String(body.password)), user.id);
      run('DELETE FROM sessions WHERE user_id = ?', user.id); // termina sessões abertas noutros sítios
    });
    audit('user', user.id, null, user.username, user.username, 'password_reset');
    return { ok: true, username: user.username };
  }, { public: true, body: S.obj({ token: S.str({ max: 200, truncate: false, required: true, label: 'Token' }), password: S.str({ max: 200, truncate: false }) }) });

  // ------------------------------------------------------------ convites
  /** Informação pública de um convite (para a página de aceitação). */
  add('GET', '/api/invites/check', ({ query }) => {
    const { user } = redeem(query.token, 'invite');
    return { name: user.name, username: user.username, email: user.email, org_name: user.org_name };
  }, { public: true });

  add('POST', '/api/users/invite', async ({ user, body, req }) => {
    assertAdmin(user);
    const email = body.email.toLowerCase();
    if (one('SELECT 1 FROM users WHERE lower(username) = ? OR (org_id = ? AND lower(email) = ?)', email, user.org_id, email)) {
      fail(409, 'Já existe um utilizador com esse email');
    }
    if (body.role === 'client') {
      if (!body.client_id || !one('SELECT 1 FROM clients WHERE id = ? AND org_id = ?', body.client_id, user.org_id)) fail(400, 'Escolha o cliente deste utilizador');
    }
    const clientIds = body.role === 'tech' ? [...new Set(body.client_ids || [])] : [];
    for (const cid of clientIds) if (!one('SELECT 1 FROM clients WHERE id = ? AND org_id = ?', cid, user.org_id)) fail(400, 'Cliente inválido');
    assertLimit(user.org_id, 'users');
    const id = tx(() => {
      const r = run(`INSERT INTO users (username, name, email, password_hash, role, client_id, org_id, invite_pending)
        VALUES (?,?,?,?,?,?,?,1)`, email, body.name, email, hashPassword(newToken()), body.role, body.role === 'client' ? body.client_id : null, user.org_id);
      const uid = Number(r.lastInsertRowid);
      for (const cid of clientIds) run('INSERT INTO user_clients (user_id, client_id) VALUES (?,?)', uid, cid);
      return uid;
    });
    const token = issue(id, 'invite');
    const url = `${baseUrl(req)}/#/convite?token=${token}`;
    const org = one('SELECT name FROM organizations WHERE id = ?', user.org_id);
    const sent = await send(email, inviteEmail({ name: body.name, orgName: org.name, inviter: user.name, url, days: TTL.invite / 864e5 }));
    audit('user', id, null, email, user.username, 'convite', { role: body.role, email_enviado: sent });
    // Sem email configurado, o administrador recebe a ligação para a entregar por outro meio
    return { id, email_sent: sent, invite_url: sent ? undefined : url };
  }, {
    body: S.obj({
      email: S.email({ required: true, label: 'Email' }),
      name: S.str({ max: 120, required: true, label: 'Nome' }),
      role: S.str({ enum: ['admin', 'tech', 'client'], required: true, label: 'Perfil' }),
      client_id: S.int({ minimum: 1, label: 'Cliente' }),
      client_ids: S.arr(S.int({ minimum: 1, label: 'Cliente' }), { maxItems: 5000 }),
    }),
  });

  add('POST', '/api/users/:id/invite/resend', async ({ user, params, req }) => {
    assertAdmin(user);
    const u = assertSameOrg(user, Number(params.id));
    if (!u.invite_pending) fail(400, 'Este utilizador já aceitou o convite');
    const token = issue(u.id, 'invite');
    const url = `${baseUrl(req)}/#/convite?token=${token}`;
    const org = one('SELECT name FROM organizations WHERE id = ?', user.org_id);
    const sent = await send(u.email, inviteEmail({ name: u.name, orgName: org.name, inviter: user.name, url, days: TTL.invite / 864e5 }));
    audit('user', u.id, null, u.username, user.username, 'convite', { reenvio: true, email_enviado: sent });
    return { email_sent: sent, invite_url: sent ? undefined : url };
  });

  add('POST', '/api/invites/accept', ({ body, res }) => {
    const { row, user } = redeem(body.token, 'invite');
    checkPassword(String(body.password || ''), user.username);
    tx(() => {
      use(row);
      run(`UPDATE users SET password_hash = ?, invite_pending = 0, must_change_password = 0, email_verified_at = datetime('now')
        WHERE id = ?`, hashPassword(String(body.password)), user.id);
    });
    audit('user', user.id, null, user.username, user.username, 'convite_aceite');
    const fresh = one('SELECT * FROM users WHERE id = ?', user.id);
    createSession(res, fresh, 'password');
    return meView(fresh, 'password');
  }, { public: true, body: S.obj({ token: S.str({ max: 200, truncate: false, required: true, label: 'Token' }), password: S.str({ max: 200, truncate: false }) }) });

  // ------------------------------------------------------------ verificação de email
  add('POST', '/api/email/verify', ({ body }) => {
    const { row, user } = redeem(body.token, 'verify');
    use(row);
    run("UPDATE users SET email_verified_at = datetime('now') WHERE id = ?", user.id);
    audit('user', user.id, null, user.username, user.username, 'email_verificado');
    return { ok: true };
  }, { public: true, body: S.obj({ token: S.str({ max: 200, truncate: false, required: true, label: 'Token' }) }) });

  add('POST', '/api/me/email/resend', async ({ user, req }) => {
    if (user.email_verified_at) return { ok: true, already: true };
    if (!user.email) fail(400, 'A sua conta não tem email');
    if (state.throttle.blocked(`verify:${user.id}`, 3, 3600e3)) fail(429, 'Já enviámos vários emails. Verifique a caixa de correio (e o spam).');
    state.throttle.hit(`verify:${user.id}`, 3600e3);
    const sent = await core.sendVerification(user, req);
    if (!sent) fail(503, 'O envio de email não está disponível. Contacte o suporte.');
    return { ok: true };
  }, { allowNoMfa: true });
};
