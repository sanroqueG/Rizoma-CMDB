'use strict';
/*
 * Acesso de suporte: a equipa da plataforma entra numa organização para ajudar, só com autorização dela.
 * - O administrador da organização autoriza por um período (até 7 dias) e pode revogar a qualquer momento.
 * - A sessão de suporte dura no máximo 1 hora, age como o administrador da organização e fica na auditoria
 *   com o nome de quem deu suporte ("suporte:<utilizador>").
 * - Não pode mudar a conta do administrador, a subscrição, o pedido de eliminação nem a própria autorização.
 */
const { fail, toId, SESSION_TTL_MS } = require('../http');
const { newToken, sha256 } = require('../auth');
const S = require('../schema');

const SUPPORT_SESSION_MS = 60 * 60e3;
const MAX_GRANT_HOURS = 7 * 24;
// Rotas que uma sessão de suporte não pode alterar
const BLOCKED = [/^\/api\/me(\/|$)/, /^\/api\/billing(\/|$)/, /^\/api\/org\/deletion$/, /^\/api\/org\/support-access$/, /^\/api\/logout-all$/];

module.exports = function registerSupport(core) {
  const { add, one, run, audit, assertAdmin, assertPlatform, setSessionCookie } = core;

  core.supportBlocked = (method, path) => method !== 'GET' && BLOCKED.some((re) => re.test(path));

  add('GET', '/api/org/support-access', ({ user }) => {
    assertAdmin(user);
    const o = one('SELECT support_access_until FROM organizations WHERE id = ?', user.org_id);
    const active = !!o.support_access_until && o.support_access_until > new Date().toISOString();
    return { granted: active, until: active ? o.support_access_until : null };
  });

  add('PUT', '/api/org/support-access', ({ user, body }) => {
    assertAdmin(user);
    const hours = body.hours;
    const until = hours > 0 ? new Date(Date.now() + hours * 3600e3).toISOString() : null;
    run('UPDATE organizations SET support_access_until = ? WHERE id = ?', until, user.org_id);
    if (!until) {
      // Revogar termina as sessões de suporte em curso
      run("DELETE FROM sessions WHERE method = 'support' AND user_id IN (SELECT id FROM users WHERE org_id = ?)", user.org_id);
    }
    audit('organization', user.org_id, null, 'Acesso de suporte', user.username, until ? 'suporte_autorizado' : 'suporte_revogado', until ? { ate: until } : null, user.org_id);
    return { granted: !!until, until };
  }, { body: S.obj({ hours: S.int({ minimum: 0, maximum: MAX_GRANT_HOURS, required: true, label: 'Horas' }) }) });

  /** Plataforma: abre uma sessão de suporte (o cookie de sessão passa a ser o da organização). */
  add('POST', '/api/platform/orgs/:id/support-session', ({ user, params, res }) => {
    assertPlatform(user);
    const o = one('SELECT * FROM organizations WHERE id = ?', toId(params.id));
    if (!o) fail(404, 'Organização não encontrada');
    if (o.id === user.org_id) fail(400, 'Já está nesta organização');
    if (!o.support_access_until || o.support_access_until <= new Date().toISOString()) {
      fail(403, 'A organização não autorizou o acesso de suporte. Peça a um administrador que o autorize em "Organização".');
    }
    if (o.status !== 'active') fail(400, 'A organização está suspensa');
    const admin = one("SELECT * FROM users WHERE org_id = ? AND role = 'admin' AND active = 1 AND invite_pending = 0 ORDER BY id LIMIT 1", o.id);
    if (!admin) fail(400, 'A organização não tem nenhum administrador ativo');
    const ttl = Math.min(SUPPORT_SESSION_MS, new Date(o.support_access_until).getTime() - Date.now(), SESSION_TTL_MS);
    const token = newToken();
    run("INSERT INTO sessions (token_hash, user_id, expires_at, method, impersonator) VALUES (?,?,?, 'support', ?)", sha256(token), admin.id, Date.now() + ttl, user.username);
    setSessionCookie(res, token, Math.floor(ttl / 1000));
    audit('organization', o.id, null, o.name, `suporte:${user.username}`, 'suporte_sessao', { como: admin.username, minutos: Math.round(ttl / 60e3) }, o.id);
    audit('organization', o.id, null, o.name, user.username, 'suporte_sessao', { como: admin.username }, user.org_id);
    return { ok: true, expires_in_s: Math.floor(ttl / 1000) };
  });
};
