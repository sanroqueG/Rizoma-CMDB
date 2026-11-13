'use strict';
/* Clientes, locais e tokens de inventário. */
// Os nomes importados abaixo são partilhados por todos os módulos de rotas; nem todos são usados aqui.
/* eslint-disable no-unused-vars */
const {
  STATUSES, CRITICALITIES, ENVIRONMENTS, REL_TYPES, ROLES, CI_TEXT_FIELDS, CSV_COLUMNS, SESSION_TTL_MS, LOGIN_WINDOW_MS, LOGIN_MAX_FAILS, MIME, SECURITY_HEADERS, HttpError, fail, toId, str, reqStr, oneOf, isoDate, cleanAttributes, parseCookies, csvCell, readBody,
} = require('../http');
const { hashPassword, verifyPassword, newToken, sha256 } = require('../auth');
const totp = require('../totp');

const S = require('../schema');

module.exports = function register(core) {
  const {
    assertLimit,
    db, opts, log, add, one, all, run, tx, audit, scopeOf, scopeSql, assertRead, assertWrite, assertAdmin, publicUser, meView, mfaSetupRequired, passwordChangeRequired, checkPassword, getClient, getCi, addCookie, setSessionCookie, createSession, redirect, box, oidc, requireMfa, totpIssuer, fetchFn, secureCookie, state, reconciler,
  } = core;

  // =========================================================== clientes
  function readClientInput(body, partial) {
    const out = {};
    if (!partial || 'name' in body) out.name = reqStr(body.name, 'Nome', 120);
    if (!partial || 'code' in body) {
      out.code = reqStr(body.code, 'Código', 12).toUpperCase();
      if (!/^[A-Z0-9_-]{2,12}$/.test(out.code)) fail(400, 'Código: 2 a 12 caracteres (letras, números, - ou _)');
    }
    for (const f of ['contact_name', 'contact_email']) if (f in body) out[f] = str(body[f], 120);
    if ('notes' in body) out.notes = str(body.notes, 5000);
    return out;
  }

  add('GET', '/api/clients', ({ user }) => {
    const s = scopeSql(user, 'c.id');
    return all(`SELECT c.*,
        (SELECT COUNT(*) FROM cis WHERE client_id = c.id) AS ci_count,
        (SELECT COUNT(*) FROM sites WHERE client_id = c.id) AS site_count
      FROM clients c WHERE ${s.sql} ORDER BY c.name`, ...s.params);
  });

  add('POST', '/api/clients', ({ user, body }) => {
    assertAdmin(user);
    const d = readClientInput(body, false);
    assertLimit(user.org_id, 'clients');
    d.org_id = user.org_id;
    const cols = Object.keys(d);
    const r = run(`INSERT INTO clients (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...Object.values(d));
    const id = Number(r.lastInsertRowid);
    audit('client', id, id, d.name, user.username, 'create', d);
    return one('SELECT * FROM clients WHERE id = ?', id);
  });

  add('GET', '/api/clients/:id', ({ user, params }) => {
    const c = getClient(user, params.id);
    const sites = all(`SELECT s.*, (SELECT COUNT(*) FROM cis WHERE site_id = s.id) AS ci_count
      FROM sites s WHERE client_id = ? ORDER BY name`, c.id);
    const byType = all(`SELECT t.id, t.name, COUNT(*) AS n FROM cis c JOIN ci_types t ON t.id = c.type_id
      WHERE c.client_id = ? GROUP BY t.id ORDER BY n DESC`, c.id);
    const tokens = user.role === 'admin'
      ? all('SELECT id, name, scopes, created_at, last_used FROM api_tokens WHERE client_id = ? ORDER BY id', c.id)
      : undefined;
    return { ...c, sites, byType, tokens };
  });

  add('PUT', '/api/clients/:id', ({ user, params, body }) => {
    assertAdmin(user);
    const c = getClient(user, params.id);
    const d = readClientInput(body, true);
    if (!Object.keys(d).length) return c;
    run(`UPDATE clients SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(d), c.id);
    audit('client', c.id, c.id, d.name || c.name, user.username, 'update', d);
    return one('SELECT * FROM clients WHERE id = ?', c.id);
  });

  add('DELETE', '/api/clients/:id', ({ user, params, query }) => {
    assertAdmin(user);
    const c = getClient(user, params.id);
    if (String(query.confirm || '').toUpperCase() !== c.code.toUpperCase()) {
      fail(400, 'Confirme a eliminação indicando o código do cliente');
    }
    const n = one('SELECT COUNT(*) AS n FROM cis WHERE client_id = ?', c.id).n;
    run('DELETE FROM clients WHERE id = ?', c.id);
    audit('client', c.id, null, c.name, user.username, 'delete', { ativos_eliminados: n }, c.org_id);
    return { ok: true };
  });

  // ---- sites
  add('POST', '/api/clients/:id/sites', ({ user, params, body }) => {
    const c = getClient(user, params.id);
    assertWrite(user, c.id);
    const name = reqStr(body.name, 'Nome', 120);
    const r = run('INSERT INTO sites (client_id, name, address) VALUES (?,?,?)', c.id, name, str(body.address, 255));
    audit('site', Number(r.lastInsertRowid), c.id, name, user.username, 'create');
    return one('SELECT * FROM sites WHERE id = ?', r.lastInsertRowid);
  });

  function getSite(user, id) {
    const s = one('SELECT * FROM sites WHERE id = ?', toId(id));
    if (!s) fail(404, 'Local não encontrado');
    assertWrite(user, s.client_id);
    return s;
  }
  add('PUT', '/api/sites/:id', ({ user, params, body }) => {
    const s = getSite(user, params.id);
    const name = 'name' in body ? reqStr(body.name, 'Nome', 120) : s.name;
    const address = 'address' in body ? str(body.address, 255) : s.address;
    run('UPDATE sites SET name = ?, address = ? WHERE id = ?', name, address, s.id);
    audit('site', s.id, s.client_id, name, user.username, 'update', { name, address });
    return one('SELECT * FROM sites WHERE id = ?', s.id);
  });
  add('DELETE', '/api/sites/:id', ({ user, params }) => {
    const s = getSite(user, params.id);
    run('DELETE FROM sites WHERE id = ?', s.id);
    audit('site', s.id, s.client_id, s.name, user.username, 'delete');
    return { ok: true };
  });

  // ---- tokens de inventário
  add('POST', '/api/clients/:id/tokens', ({ user, params, body }) => {
    assertAdmin(user);
    const c = getClient(user, params.id);
    const name = body.name;
    // Permissões: "ingest" (agentes de inventário) e/ou "tickets" (ferramentas de helpdesk); por omissão, as duas
    const scopes = [...new Set(body.scopes && body.scopes.length ? body.scopes : ['ingest', 'tickets'])];
    const token = `cmdb_${newToken()}`;
    const r = run('INSERT INTO api_tokens (client_id, name, token_hash, scopes) VALUES (?,?,?,?)', c.id, name, sha256(token), scopes.join(','));
    audit('token', Number(r.lastInsertRowid), c.id, name, user.username, 'create', { permissoes: scopes.join(', ') });
    return { id: Number(r.lastInsertRowid), name, scopes, token }; // o token só é mostrado uma vez
  }, { body: S.obj({ name: S.str({ max: 80, required: true, label: 'Nome' }), scopes: S.arr(S.str({ enum: ['ingest', 'tickets'], label: 'Permissão' }), { maxItems: 2 }) }) });
  add('DELETE', '/api/tokens/:id', ({ user, params }) => {
    assertAdmin(user);
    const t = one('SELECT * FROM api_tokens WHERE id = ?', toId(params.id));
    if (!t) fail(404, 'Token não encontrado');
    assertRead(user, t.client_id);
    run('DELETE FROM api_tokens WHERE id = ?', t.id);
    audit('token', t.id, t.client_id, t.name, user.username, 'delete');
    return { ok: true };
  });
};
