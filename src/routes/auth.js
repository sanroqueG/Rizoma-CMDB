'use strict';
/* Autenticação: login com password e 2FA, SSO (OIDC), sessão e conta do próprio utilizador. */
// Os nomes importados abaixo são partilhados por todos os módulos de rotas; nem todos são usados aqui.
/* eslint-disable no-unused-vars */
const {
  STATUSES, CRITICALITIES, ENVIRONMENTS, REL_TYPES, ROLES, CI_TEXT_FIELDS, CSV_COLUMNS, SESSION_TTL_MS, LOGIN_WINDOW_MS, LOGIN_MAX_FAILS, MIME, SECURITY_HEADERS, HttpError, fail, toId, str, reqStr, oneOf, isoDate, cleanAttributes, parseCookies, csvCell, readBody,
} = require('../http');
const { hashPassword, verifyPassword, newToken, sha256 } = require('../auth');
const totp = require('../totp');

module.exports = function register(core) {
  const {
    db, opts, log, add, one, all, run, tx, audit, scopeOf, scopeSql, assertRead, assertWrite, assertAdmin, publicUser, meView, mfaSetupRequired, passwordChangeRequired, checkPassword, getClient, getCi, addCookie, setSessionCookie, createSession, redirect, box, oidc, requireMfa, totpIssuer, fetchFn, secureCookie, state, reconciler,
  } = core;

  // =========================================================== autenticação
  /** Uma organização suspensa não entra (a mensagem só aparece depois de a password estar certa). */
  function assertOrgActive(u) {
    const org = one('SELECT status FROM organizations WHERE id = ?', u.org_id);
    if (!org || org.status !== 'active') fail(403, 'O acesso desta organização está suspenso. Contacte o suporte.');
  }
  add('POST', '/api/login', ({ body, req, res }) => {
    const username = String(body.username || '').trim();
    const key = `login:${req.socket.remoteAddress}|${username.toLowerCase()}`;
    if (state.throttle.blocked(key, LOGIN_MAX_FAILS, LOGIN_WINDOW_MS)) fail(429, 'Demasiadas tentativas. Tente novamente mais tarde.');
    // Convites por aceitar não entram com password (a password é definida pelo próprio ao aceitar)
    const u = one('SELECT * FROM users WHERE username = ? AND active = 1 AND invite_pending = 0', username);
    if (!u || !verifyPassword(String(body.password || ''), u.password_hash)) {
      state.throttle.hit(key, LOGIN_WINDOW_MS);
      fail(401, 'Credenciais inválidas');
    }
    state.throttle.reset(key);
    assertOrgActive(u);
    if (core.ssoEnforced(u)) fail(403, 'A sua organização exige o login único (SSO). Use "Entrar com SSO da organização".');
    run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    if (u.totp_enabled) {
      // 2.º fator: devolve um token temporário; a sessão só é criada após o código TOTP
      const t = newToken();
      state.mfa.create(sha256(t), u.id, 5 * 60e3);
      return { mfa_required: true, mfa_token: t };
    }
    createSession(res, u, 'password');
    audit('user', u.id, null, u.username, u.username, 'login');
    return meView(u, 'password');
  }, { public: true });

  add('POST', '/api/login/mfa', ({ body, res }) => {
    const key = sha256(String(body.mfa_token || ''));
    const p = state.mfa.get(key);
    if (!p) fail(401, 'O pedido expirou. Inicie sessão novamente.');
    const u = one('SELECT * FROM users WHERE id = ? AND active = 1', p.user_id);
    if (!u || !u.totp_enabled) { state.mfa.remove(key); fail(401, 'Sessão inválida'); }
    let factor = null;
    const ctr = totp.verifyTotp(box.open(u.totp_secret), body.code, u.totp_last);
    if (ctr !== null) {
      run('UPDATE users SET totp_last = ? WHERE id = ?', ctr, u.id);
      factor = 'TOTP';
    } else {
      const norm = totp.normalizeRecoveryCode(body.code);
      const codes = JSON.parse(u.recovery_codes || '[]');
      const i = norm.length === 10 ? codes.indexOf(sha256(norm)) : -1;
      if (i >= 0) {
        codes.splice(i, 1);
        run('UPDATE users SET recovery_codes = ? WHERE id = ?', JSON.stringify(codes), u.id);
        factor = 'código de recuperação';
      }
    }
    if (!factor) {
      const attempts = state.mfa.fail(key);
      if (attempts >= 5) state.mfa.remove(key);
      fail(401, attempts >= 5 ? 'Demasiadas tentativas. Inicie sessão novamente.' : 'Código inválido');
    }
    state.mfa.remove(key);
    assertOrgActive(u);
    createSession(res, u, 'password');
    audit('user', u.id, null, u.username, u.username, 'login', { segundo_fator: factor });
    const fresh = one('SELECT * FROM users WHERE id = ?', u.id);
    return { ...meView(fresh, 'password'), recovery_codes_left: JSON.parse(fresh.recovery_codes || '[]').length };
  }, { public: true });

  add('POST', '/api/logout', ({ sid, res }) => {
    run('DELETE FROM sessions WHERE token_hash = ?', sha256(sid));
    setSessionCookie(res, '', 0);
    return { ok: true };
  }, { allowNoMfa: true });

  add('GET', '/api/me', ({ user }) => meView(user, user.session_method), { allowNoMfa: true });

  // ---- configuração de autenticação (pública, para o ecrã de login)
  add('GET', '/api/auth/config', () => ({
    oidc: oidc ? { label: oidc.label } : null, require_2fa: requireMfa, signup: !!core.signupEnabled,
    org_sso: !!one('SELECT 1 FROM org_sso WHERE enabled = 1 LIMIT 1'),
    terms_url: core.legal.termsUrl, privacy_url: core.legal.privacyUrl,
  }), { public: true });

  // ---- SSO (OpenID Connect)
  add('GET', '/api/auth/oidc/start', async ({ res, ctx }) => {
    if (!oidc) fail(404, 'SSO não configurado');
    const { url, state } = await oidc.start();
    addCookie(res, `oidc_state=${state}; HttpOnly; SameSite=Lax; Path=/api/auth/oidc; Max-Age=600${secureCookie ? '; Secure' : ''}`);
    redirect(res, ctx, url);
  }, { public: true });

  // Callback comum ao SSO global e ao SSO de cada organização (o login pendente indica qual)
  add('GET', '/api/auth/oidc/callback', async ({ req, res, query, ctx }) => {
    addCookie(res, `oidc_state=; HttpOnly; SameSite=Lax; Path=/api/auth/oidc; Max-Age=0${secureCookie ? '; Secure' : ''}`);
    try {
      if (query.error) throw new Error(query.error_description || query.error);
      if (!query.state || query.state !== parseCookies(req).oidc_state) throw new Error('Pedido de login inválido. Tente novamente.');
      const pend = one('SELECT org_id FROM oidc_pending WHERE state = ?', String(query.state));
      const orgId = pend ? pend.org_id : null;
      const client = orgId ? core.orgSsoClient(orgId, req) : oidc;
      if (!client) throw new Error('O login único não está configurado.');
      const { identities, claims } = await client.finish(query.code, query.state);
      if (!identities.length) throw new Error('O fornecedor de identidade não devolveu o email do utilizador');
      const ph = identities.map(() => '?').join(',');
      // SSO de uma organização: só utilizadores dessa organização (ou criados nela, se permitido)
      const u = orgId ? core.orgSsoUser(orgId, identities, claims)
        : one(`SELECT * FROM users WHERE active = 1 AND (lower(email) IN (${ph}) OR lower(username) IN (${ph}))
        ORDER BY id LIMIT 1`, ...identities, ...identities);
      if (!u) {
        audit('user', null, null, identities[0], identities[0], 'login_negado', { motivo: 'conta SSO sem utilizador no Rizoma' });
        throw new Error(`A conta ${identities[0]} não tem acesso ao Rizoma. Peça a um administrador que a registe.`);
      }
      assertOrgActive(u);
      run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
      createSession(res, u, 'oidc');
      audit('user', u.id, null, u.username, u.username, 'login', { metodo: 'SSO' });
      redirect(res, ctx, '/#/');
    } catch (e) {
      redirect(res, ctx, `/#/?sso_erro=${encodeURIComponent(e.message)}`);
    }
  }, { public: true });

  // ---- 2FA (TOTP) do próprio utilizador
  add('POST', '/api/me/2fa/setup', ({ user }) => {
    if (user.totp_enabled) fail(400, 'A autenticação de dois fatores já está ativa');
    const secret = totp.generateSecret();
    run('UPDATE users SET totp_pending = ? WHERE id = ?', box.seal(secret), user.id);
    return { secret, uri: totp.otpauthUri(secret, user.username, totpIssuer) };
  }, { allowNoMfa: true });

  add('POST', '/api/me/2fa/enable', ({ user, body, sid }) => {
    if (user.totp_enabled) fail(400, 'A autenticação de dois fatores já está ativa');
    if (!user.totp_pending) fail(400, 'Inicie a configuração primeiro');
    const ctr = totp.verifyTotp(box.open(user.totp_pending), body.code, null);
    if (ctr === null) fail(400, 'Código inválido. Confirme que a hora do telemóvel está certa e tente novamente.');
    const codes = totp.generateRecoveryCodes();
    run(`UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled = 1, totp_last = ?, recovery_codes = ?
      WHERE id = ?`, ctr, JSON.stringify(codes.map((c) => sha256(totp.normalizeRecoveryCode(c)))), user.id);
    run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', user.id, sha256(sid));
    audit('user', user.id, null, user.username, user.username, '2fa_on');
    return { recovery_codes: codes };
  }, { allowNoMfa: true });

  add('POST', '/api/me/2fa/disable', ({ user, body }) => {
    if (requireMfa) fail(400, 'A autenticação de dois fatores é obrigatória nesta instalação');
    if (!user.totp_enabled) fail(400, 'A autenticação de dois fatores não está ativa');
    if (!verifyPassword(String(body.password || ''), user.password_hash)) fail(400, 'Password incorreta');
    run(`UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled = 0, totp_last = NULL, recovery_codes = NULL
      WHERE id = ?`, user.id);
    audit('user', user.id, null, user.username, user.username, '2fa_off');
    return { ok: true };
  });

  add('POST', '/api/me/2fa/recovery-codes', ({ user, body }) => {
    if (!user.totp_enabled) fail(400, 'A autenticação de dois fatores não está ativa');
    const ctr = totp.verifyTotp(box.open(user.totp_secret), body.code, user.totp_last);
    if (ctr === null) fail(400, 'Código inválido');
    const codes = totp.generateRecoveryCodes();
    run('UPDATE users SET totp_last = ?, recovery_codes = ? WHERE id = ?', ctr,
      JSON.stringify(codes.map((c) => sha256(totp.normalizeRecoveryCode(c)))), user.id);
    audit('user', user.id, null, user.username, user.username, 'update', { codigos_recuperacao: '(novos)' });
    return { recovery_codes: codes };
  });

  add('POST', '/api/me/password', ({ user, body, sid }) => {
    if (!verifyPassword(String(body.current || ''), user.password_hash)) fail(400, 'Password atual incorreta');
    const pw = String(body.password || '');
    checkPassword(pw, user.username);
    if (verifyPassword(pw, user.password_hash)) fail(400, 'A nova password tem de ser diferente da atual');
    run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', hashPassword(pw), user.id);
    run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', user.id, sha256(sid));
    audit('user', user.id, null, user.username, user.username, 'password');
    return { ok: true };
  }, { allowNoMfa: true });
};
