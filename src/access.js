'use strict';
/*
 * Controlo de acesso (multi-organização + multi-cliente). Todas as rotas passam por aqui:
 *  - organização: cada utilizador pertence a uma organização (o prestador de serviços); nunca vê dados de outra;
 *  - cliente: dentro da organização, o administrador vê todos os clientes, o técnico os atribuídos,
 *    o utilizador "cliente" apenas o seu (só leitura);
 *  - plataforma: utilizadores com is_platform gerem as organizações e as cópias de segurança.
 * Um recurso fora do âmbito devolve 404 (não revela que existe).
 * test/isolation.test.js percorre todas as rotas para garantir que nenhuma escapa a estas regras.
 */

function createAccess({ one, all, fail }) {
  /** Ids dos clientes visíveis; null = todos os clientes da organização do utilizador (administrador). */
  function scopeOf(user) {
    if (!user.org_id) return [];
    if (user.role === 'admin') return null;
    if (user.role === 'client') {
      return user.client_id && one('SELECT 1 FROM clients WHERE id = ? AND org_id = ?', user.client_id, user.org_id) ? [user.client_id] : [];
    }
    return all(`SELECT uc.client_id FROM user_clients uc JOIN clients c ON c.id = uc.client_id
      WHERE uc.user_id = ? AND c.org_id = ?`, user.id, user.org_id).map((r) => r.client_id);
  }

  /** Condição SQL sobre uma coluna de client_id. Nunca devolve "tudo": no máximo, os clientes da organização. */
  function scopeSql(user, column) {
    if (!user.org_id) return { sql: '1=0', params: [] };
    if (user.role === 'admin') return { sql: `${column} IN (SELECT id FROM clients WHERE org_id = ?)`, params: [user.org_id] };
    const s = scopeOf(user);
    if (!s.length) return { sql: '1=0', params: [] };
    return { sql: `${column} IN (${s.map(() => '?').join(',')})`, params: s };
  }

  /** Condição SQL sobre uma coluna de org_id (utilizadores, auditoria). */
  function orgSql(user, column) {
    return user.org_id ? { sql: `${column} = ?`, params: [user.org_id] } : { sql: '1=0', params: [] };
  }

  function canRead(user, clientId) {
    if (!clientId || !user.org_id) return false;
    const c = one('SELECT org_id FROM clients WHERE id = ?', clientId);
    if (!c || c.org_id !== user.org_id) return false;
    const s = scopeOf(user);
    return s === null || s.includes(clientId);
  }
  function assertRead(user, clientId) {
    if (!canRead(user, clientId)) fail(404, 'Não encontrado');
  }
  function assertWrite(user, clientId) {
    assertRead(user, clientId);
    if (user.role === 'client') fail(403, 'Sem permissão de escrita');
  }
  function assertAdmin(user) {
    if (user.role !== 'admin') fail(403, 'Apenas administradores');
  }
  function assertPlatform(user) {
    if (!user.is_platform) fail(403, 'Apenas administradores da plataforma');
  }
  /** Garante que um utilizador (por id) pertence à organização de quem pede. */
  function assertSameOrg(user, otherUserId) {
    const u = one('SELECT * FROM users WHERE id = ?', otherUserId);
    if (!u || u.org_id !== user.org_id) fail(404, 'Utilizador não encontrado');
    return u;
  }
  /** Limites do plano da organização (null = sem limite). */
  function assertLimit(orgId, kind) {
    const org = one('SELECT * FROM organizations WHERE id = ?', orgId);
    if (!org) fail(404, 'Organização não encontrada');
    const limits = {
      clients: [org.max_clients, () => one('SELECT COUNT(*) AS n FROM clients WHERE org_id = ?', orgId).n, 'clientes'],
      cis: [org.max_cis, () => one('SELECT COUNT(*) AS n FROM cis c JOIN clients cl ON cl.id = c.client_id WHERE cl.org_id = ?', orgId).n, 'ativos'],
      users: [org.max_users, () => one('SELECT COUNT(*) AS n FROM users WHERE org_id = ?', orgId).n, 'utilizadores'],
    }[kind];
    if (limits && limits[0] !== null && limits[0] !== undefined && limits[1]() >= limits[0]) {
      fail(402, `O plano da organização permite no máximo ${limits[0]} ${limits[2]}. Contacte o suporte para alterar o plano.`);
    }
  }

  return { scopeOf, scopeSql, orgSql, canRead, assertRead, assertWrite, assertAdmin, assertPlatform, assertSameOrg, assertLimit };
}

module.exports = { createAccess };
