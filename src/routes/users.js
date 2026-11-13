'use strict';
/* Utilizadores e auditoria. */
// Os nomes importados abaixo são partilhados por todos os módulos de rotas; nem todos são usados aqui.
/* eslint-disable no-unused-vars */
const {
  STATUSES, CRITICALITIES, ENVIRONMENTS, REL_TYPES, ROLES, CI_TEXT_FIELDS, CSV_COLUMNS, SESSION_TTL_MS, LOGIN_WINDOW_MS, LOGIN_MAX_FAILS, MIME, SECURITY_HEADERS, HttpError, fail, toId, str, reqStr, oneOf, isoDate, cleanAttributes, parseCookies, csvCell, readBody,
} = require('../http');
const { hashPassword, verifyPassword, newToken, sha256 } = require('../auth');
const totp = require('../totp');

module.exports = function register(core) {
  const {
    orgSql, assertSameOrg, assertLimit,
    db, opts, log, add, one, all, run, tx, audit, scopeOf, scopeSql, assertRead, assertWrite, assertAdmin, publicUser, meView, mfaSetupRequired, passwordChangeRequired, checkPassword, getClient, getCi, addCookie, setSessionCookie, createSession, redirect, box, oidc, requireMfa, totpIssuer, fetchFn, secureCookie, state, reconciler,
  } = core;

  // =========================================================== utilizadores
  function readUserInput(body, partial, currentUsername) {
    const out = {};
    if (!partial || 'username' in body) {
      out.username = reqStr(body.username, 'Utilizador', 60);
      if (!/^[A-Za-z0-9._@-]{3,60}$/.test(out.username)) fail(400, 'Utilizador: 3 a 60 caracteres (letras, números, . _ @ -)');
    }
    if (!partial || 'name' in body) out.name = reqStr(body.name, 'Nome', 120);
    if (!partial || 'role' in body) out.role = oneOf(body.role, ROLES, 'Perfil');
    if ('client_id' in body) out.client_id = body.client_id ? toId(body.client_id, 'Cliente') : null;
    if ('active' in body) out.active = body.active ? 1 : 0;
    if ('email' in body) {
      out.email = str(body.email, 160);
      if (out.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.email)) fail(400, 'Email inválido');
    }
    if ('must_change_password' in body) out.must_change_password = body.must_change_password ? 1 : 0;
    if (body.password) {
      checkPassword(String(body.password), out.username || currentUsername);
      out.password_hash = hashPassword(String(body.password));
    } else if (!partial) {
      // Com SSO ativo é possível criar contas só-SSO (password aleatória, desconhecida)
      if (oidc) out.password_hash = hashPassword(newToken());
      else fail(400, 'Password é obrigatória');
    }
    return out;
  }
  /** Os clientes atribuídos têm de pertencer à organização de quem atribui. */
  function assertOrgClient(user, clientId) {
    if (clientId && !one('SELECT 1 FROM clients WHERE id = ? AND org_id = ?', clientId, user.org_id)) fail(400, 'Cliente inválido');
  }
  function setUserClients(user, userId, ids) {
    const unique = [...new Set(ids.map((x) => toId(x, 'Cliente')))];
    for (const cid of unique) assertOrgClient(user, cid);
    run('DELETE FROM user_clients WHERE user_id = ?', userId);
    for (const cid of unique) run('INSERT INTO user_clients (user_id, client_id) VALUES (?,?)', userId, cid);
  }
  const userView = (u) => ({
    ...publicUser(u),
    created_at: u.created_at,
    client_ids: all('SELECT client_id FROM user_clients WHERE user_id = ?', u.id).map((r) => r.client_id),
  });

  add('GET', '/api/users', ({ user }) => {
    assertAdmin(user);
    const o = orgSql(user, 'org_id');
    return all(`SELECT * FROM users WHERE ${o.sql} ORDER BY username`, ...o.params).map(userView);
  });

  add('POST', '/api/users', ({ user, body }) => {
    assertAdmin(user);
    const d = readUserInput(body, false);
    if (d.role === 'client' && !d.client_id) fail(400, 'Um utilizador do tipo cliente tem de estar associado a um cliente');
    if (d.role !== 'client') d.client_id = null;
    assertOrgClient(user, d.client_id);
    assertLimit(user.org_id, 'users');
    d.org_id = user.org_id;
    const id = tx(() => {
      const cols = Object.keys(d);
      const r = run(`INSERT INTO users (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...Object.values(d));
      const uid = Number(r.lastInsertRowid);
      if (d.role === 'tech') setUserClients(user, uid, Array.isArray(body.client_ids) ? body.client_ids : []);
      return uid;
    });
    audit('user', id, null, d.username, user.username, 'create', { role: d.role });
    return userView(one('SELECT * FROM users WHERE id = ?', id));
  });

  add('PUT', '/api/users/:id', ({ user, params, body }) => {
    assertAdmin(user);
    const u = assertSameOrg(user, toId(params.id));
    const d = readUserInput(body, true, u.username);
    if (u.id === user.id && ((d.role && d.role !== 'admin') || d.active === 0)) {
      fail(400, 'Não pode remover o seu próprio acesso de administrador');
    }
    const role = d.role || u.role;
    const clientId = 'client_id' in d ? d.client_id : u.client_id;
    if (role === 'client' && !clientId) fail(400, 'Um utilizador do tipo cliente tem de estar associado a um cliente');
    if (role !== 'client') d.client_id = null;
    assertOrgClient(user, d.client_id);
    tx(() => {
      if (Object.keys(d).length) {
        run(`UPDATE users SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(d), u.id);
      }
      if (role === 'tech' && Array.isArray(body.client_ids)) setUserClients(user, u.id, body.client_ids);
      if (role !== 'tech') run('DELETE FROM user_clients WHERE user_id = ?', u.id);
      if (d.password_hash || d.active === 0 || (d.role && d.role !== u.role)) run('DELETE FROM sessions WHERE user_id = ?', u.id);
    });
    const { password_hash, ...logged } = d;
    audit('user', u.id, null, u.username, user.username, 'update', { ...logged, password: password_hash ? '(alterada)' : undefined });
    return userView(one('SELECT * FROM users WHERE id = ?', u.id));
  });

  add('POST', '/api/users/:id/2fa/reset', ({ user, params }) => {
    assertAdmin(user);
    const u = assertSameOrg(user, toId(params.id));
    run(`UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled = 0, totp_last = NULL, recovery_codes = NULL
      WHERE id = ?`, u.id);
    run('DELETE FROM sessions WHERE user_id = ?', u.id);
    audit('user', u.id, null, u.username, user.username, '2fa_reset');
    return { ok: true };
  });

  add('DELETE', '/api/users/:id', ({ user, params }) => {
    assertAdmin(user);
    const u = assertSameOrg(user, toId(params.id));
    if (u.id === user.id) fail(400, 'Não pode eliminar o seu próprio utilizador');
    run('DELETE FROM users WHERE id = ?', u.id);
    audit('user', u.id, null, u.username, user.username, 'delete', null, u.org_id);
    return { ok: true };
  });

  // =========================================================== auditoria
  add('GET', '/api/audit', ({ user, query }) => {
    assertAdmin(user);
    const o = orgSql(user, 'a.org_id');
    const where = [o.sql];
    const params = [...o.params];
    if (query.entity) { where.push('a.entity = ?'); params.push(String(query.entity)); }
    if (query.client) { where.push('a.client_id = ?'); params.push(toId(query.client, 'Cliente')); }
    // Paginação por cursor: ?before=<id> devolve os eventos anteriores a esse
    if (query.before) { where.push('a.id < ?'); params.push(toId(query.before, 'Cursor')); }
    const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 1000);
    return all(`SELECT a.*, cl.name AS client_name FROM audit a LEFT JOIN clients cl ON cl.id = a.client_id
      WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ?`, ...params, limit)
      .map((a) => ({ ...a, changes: a.changes ? JSON.parse(a.changes) : null }));
  });
};
