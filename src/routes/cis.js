'use strict';
/* Metadados, dashboard, ativos (CIs), relações, análise de impacto e mapas. */
// Os nomes importados abaixo são partilhados por todos os módulos de rotas; nem todos são usados aqui.
/* eslint-disable no-unused-vars */
const {
  STATUSES, CRITICALITIES, ENVIRONMENTS, REL_TYPES, ROLES, CI_TEXT_FIELDS, CSV_COLUMNS, SESSION_TTL_MS, LOGIN_WINDOW_MS, LOGIN_MAX_FAILS, MIME, SECURITY_HEADERS, HttpError, fail, toId, str, reqStr, oneOf, isoDate, cleanAttributes, parseCookies, csvCell, readBody,
} = require('../http');
const { hashPassword, verifyPassword, newToken, sha256 } = require('../auth');
const totp = require('../totp');
const { readCiInput } = require('../validators');
const { ciTextFilter } = require('../store');

module.exports = function register(core) {
  const {
    db, opts, log, add, one, all, run, tx, audit, scopeOf, scopeSql, assertRead, assertWrite, assertAdmin, publicUser, meView, mfaSetupRequired, passwordChangeRequired, checkPassword, getClient, getCi, addCookie, setSessionCookie, createSession, redirect, box, oidc, requireMfa, totpIssuer, fetchFn, secureCookie, state, reconciler,
  } = core;

  // =========================================================== metadados
  add('GET', '/api/meta', ({ user }) => ({
    statuses: STATUSES, criticalities: CRITICALITIES, environments: ENVIRONMENTS, relTypes: REL_TYPES, roles: ROLES,
    types: core.typesFor(user.org_id),
    sso: !!oidc || core.orgHasSso(user.org_id),
    contractKinds: ['licenca', 'suporte', 'manutencao', 'subscricao', 'garantia', 'outsourcing', 'outro'],
    contractStatuses: ['ativo', 'terminado', 'cancelado'],
    billing: ['mensal', 'trimestral', 'anual', 'unico'],
  }), { allowNoMfa: true });

  // =========================================================== dashboard
  add('GET', '/api/dashboard', ({ user }) => {
    const s = scopeSql(user, 'c.client_id');
    const sc = scopeSql(user, 'cl.id');
    const sa = scopeSql(user, 'a.client_id');
    const totals = one(`SELECT COUNT(*) AS total,
        COALESCE(SUM(status = 'em_producao'), 0) AS producao,
        COALESCE(SUM(criticality = 'critica' AND status <> 'abatido'), 0) AS criticos
      FROM cis c WHERE ${s.sql}`, ...s.params);
    const clients = one(`SELECT COUNT(*) AS n FROM clients cl WHERE ${sc.sql}`, ...sc.params).n;
    const byStatus = all(`SELECT status, COUNT(*) AS n FROM cis c WHERE ${s.sql} GROUP BY status`, ...s.params);
    const byType = all(`SELECT t.id, t.name, COUNT(*) AS n FROM cis c JOIN ci_types t ON t.id = c.type_id
      WHERE ${s.sql} GROUP BY t.id ORDER BY n DESC`, ...s.params);
    const byClient = all(`SELECT cl.id, cl.name, cl.code, COUNT(c.id) AS n FROM clients cl
      LEFT JOIN cis c ON c.client_id = cl.id WHERE ${sc.sql} GROUP BY cl.id ORDER BY n DESC, cl.name`, ...sc.params);
    const warranties = all(`SELECT c.id, c.name, c.warranty_end, cl.name AS client_name FROM cis c
      JOIN clients cl ON cl.id = c.client_id
      WHERE ${s.sql} AND c.status <> 'abatido' AND c.warranty_end IS NOT NULL
        AND c.warranty_end <= date('now', '+90 days')
      ORDER BY c.warranty_end LIMIT 15`, ...s.params);
    const stale = all(`SELECT c.id, c.name, c.last_seen, cl.name AS client_name FROM cis c
      JOIN clients cl ON cl.id = c.client_id
      WHERE ${s.sql} AND c.source = 'agent' AND c.status <> 'abatido'
        AND c.last_seen < datetime('now', '-30 days')
      ORDER BY c.last_seen LIMIT 15`, ...s.params);
    const recent = all(`SELECT a.id, a.entity_id, a.label, a.actor, a.action, a.created_at FROM audit a
      WHERE a.entity = 'ci' AND ${sa.sql} ORDER BY a.id DESC LIMIT 10`, ...sa.params);
    return { totals: { ...totals, clients }, byStatus, byType, byClient, warranties, stale, recent };
  });

  // =========================================================== ativos (CIs)
  function checkCiRefs(d, clientId) {
    if (d.type_id && !core.typeVisible(d.type_id, one('SELECT org_id FROM clients WHERE id = ?', clientId)?.org_id)) fail(400, 'Tipo inválido');
    if (d.site_id && !one('SELECT 1 FROM sites WHERE id = ? AND client_id = ?', d.site_id, clientId)) {
      fail(400, 'O local não pertence a este cliente');
    }
  }

  function ciFilters(user, query) {
    const s = scopeSql(user, 'c.client_id');
    const where = [s.sql];
    const params = [...s.params];
    const eq = (col, v) => { where.push(`${col} = ?`); params.push(v); };
    if (query.client) eq('c.client_id', toId(query.client, 'Cliente'));
    if (query.type) eq('c.type_id', toId(query.type, 'Tipo'));
    if (query.site) eq('c.site_id', toId(query.site, 'Local'));
    if (query.status) eq('c.status', oneOf(query.status, STATUSES, 'Estado'));
    if (query.criticality) eq('c.criticality', oneOf(query.criticality, CRITICALITIES, 'Criticidade'));
    if (query.source) eq('c.source', String(query.source));
    if (query.q) {
      // Índice FTS5 (ver store.ciTextFilter): qualquer parte do nome, hostname, nº de série, IP, modelo, notas…
      const t = ciTextFilter(query.q, 'c.id');
      where.push(t.sql);
      params.push(...t.params);
    }
    return { where: where.join(' AND '), params };
  }
  const CI_SELECT = `SELECT c.*, t.name AS type_name, t.category AS type_category, cl.name AS client_name,
      cl.code AS client_code, s.name AS site_name
    FROM cis c JOIN ci_types t ON t.id = c.type_id JOIN clients cl ON cl.id = c.client_id
    LEFT JOIN sites s ON s.id = c.site_id`;

  add('GET', '/api/cis', ({ user, query }) => {
    const f = ciFilters(user, query);
    const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 1000);
    const offset = Math.max(Number(query.offset) || 0, 0);
    const total = one(`SELECT COUNT(*) AS n FROM cis c WHERE ${f.where}`, ...f.params).n;
    const items = all(`${CI_SELECT} WHERE ${f.where} ORDER BY cl.name, c.name LIMIT ? OFFSET ?`, ...f.params, limit, offset);
    return { total, limit, offset, items };
  });

  add('GET', '/api/cis.csv', ({ user, query, res, ctx }) => {
    const f = ciFilters(user, query);
    const rows = all(`${CI_SELECT} WHERE ${f.where} ORDER BY cl.name, c.name`, ...f.params);
    const lines = [CSV_COLUMNS.join(';'), ...rows.map((r) => CSV_COLUMNS.map((k) => csvCell(r[k])).join(';'))];
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="ativos-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
    res.end('﻿' + lines.join('\r\n'));
    ctx.raw = true;
  });

  add('POST', '/api/cis', ({ user, body }) => {
    const clientId = toId(body.client_id, 'Cliente');
    assertWrite(user, clientId);
    core.assertLimit(user.org_id, 'cis');
    const d = readCiInput(body);
    if (!d.name) fail(400, 'Nome é obrigatório');
    if (!d.type_id) fail(400, 'Tipo é obrigatório');
    checkCiRefs(d, clientId);
    d.client_id = clientId;
    const cols = Object.keys(d);
    const r = run(`INSERT INTO cis (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...Object.values(d));
    const id = Number(r.lastInsertRowid);
    audit('ci', id, clientId, d.name, user.username, 'create');
    return one(`${CI_SELECT} WHERE c.id = ?`, id);
  });

  add('GET', '/api/cis/:id', ({ user, params }) => {
    const ci = getCi(user, params.id);
    const full = one(`${CI_SELECT} WHERE c.id = ?`, ci.id);
    full.attributes = JSON.parse(full.attributes || '{}');
    full.outgoing = all(`SELECT r.id, r.type, c.id AS ci_id, c.name, c.status, t.name AS type_name
      FROM relationships r JOIN cis c ON c.id = r.target_id JOIN ci_types t ON t.id = c.type_id
      WHERE r.source_id = ? ORDER BY r.type, c.name`, ci.id);
    full.incoming = all(`SELECT r.id, r.type, c.id AS ci_id, c.name, c.status, t.name AS type_name
      FROM relationships r JOIN cis c ON c.id = r.source_id JOIN ci_types t ON t.id = c.type_id
      WHERE r.target_id = ? ORDER BY r.type, c.name`, ci.id);
    return full;
  });

  add('PUT', '/api/cis/:id', ({ user, params, body }) => {
    const old = getCi(user, params.id);
    assertWrite(user, old.client_id);
    if ('client_id' in body && Number(body.client_id) !== old.client_id) {
      fail(400, 'Não é possível mudar o cliente de um ativo');
    }
    const d = readCiInput(body);
    checkCiRefs(d, old.client_id);
    const changes = {};
    for (const [k, v] of Object.entries(d)) if ((old[k] ?? null) !== v) changes[k] = [old[k] ?? null, v];
    if (!Object.keys(changes).length) return one(`${CI_SELECT} WHERE c.id = ?`, old.id);
    const cols = Object.keys(changes);
    run(`UPDATE cis SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      ...cols.map((k) => d[k]), old.id);
    audit('ci', old.id, old.client_id, d.name || old.name, user.username, 'update', changes);
    return one(`${CI_SELECT} WHERE c.id = ?`, old.id);
  });

  add('DELETE', '/api/cis/:id', ({ user, params }) => {
    const ci = getCi(user, params.id);
    assertWrite(user, ci.client_id);
    run('DELETE FROM cis WHERE id = ?', ci.id);
    audit('ci', ci.id, ci.client_id, ci.name, user.username, 'delete');
    return { ok: true };
  });

  add('GET', '/api/cis/:id/history', ({ user, params }) => {
    const ci = getCi(user, params.id);
    return all(`SELECT id, actor, action, changes, created_at FROM audit
      WHERE (entity = 'ci' AND entity_id = ?) OR (entity = 'relationship' AND label LIKE ?)
      ORDER BY id DESC LIMIT 200`, ci.id, `%#${ci.id}#%`)
      .map((a) => ({ ...a, changes: a.changes ? JSON.parse(a.changes) : null }));
  });

  // Análise de impacto: quem é afetado se este ativo falhar (a montante),
  // e de que ativos este depende (a jusante). Profundidade limitada a 10.
  // fromCol/toCol são constantes internas ('source_id'/'target_id'), nunca dados do utilizador
  const walk = (ciId, fromCol, toCol, maxDepth) => all(`WITH RECURSIVE g(id, depth) AS (
      SELECT ${fromCol}, 1 FROM relationships WHERE ${toCol} = ?
      UNION
      SELECT r.${fromCol}, g.depth + 1 FROM relationships r JOIN g ON r.${toCol} = g.id WHERE g.depth < ?
    )
    SELECT c.id, c.name, c.status, c.criticality, t.name AS type_name, MIN(g.depth) AS depth
    FROM g JOIN cis c ON c.id = g.id JOIN ci_types t ON t.id = c.type_id
    WHERE c.id <> ? GROUP BY c.id ORDER BY depth, c.name`, ciId, maxDepth, ciId);

  add('GET', '/api/cis/:id/impact', ({ user, params }) => {
    const ci = getCi(user, params.id);
    return { impacted: walk(ci.id, 'source_id', 'target_id', 10), dependencies: walk(ci.id, 'target_id', 'source_id', 10) };
  });

  function edgesAmong(ids) {
    if (!ids.length) return [];
    const ph = ids.map(() => '?').join(',');
    return all(`SELECT id, source_id AS source, target_id AS target, type FROM relationships
      WHERE source_id IN (${ph}) AND target_id IN (${ph})`, ...ids, ...ids);
  }

  // Mapa centrado num ativo: nível < 0 = dependentes (afetados), > 0 = dependências
  add('GET', '/api/cis/:id/graph', ({ user, params, query }) => {
    const ci = getCi(user, params.id);
    const depth = Math.min(Math.max(Number(query.depth) || 2, 1), 6);
    const center = one('SELECT c.id, c.name, c.status, c.criticality, t.name AS type_name FROM cis c JOIN ci_types t ON t.id = c.type_id WHERE c.id = ?', ci.id);
    const nodes = new Map([[ci.id, { ...center, level: 0 }]]);
    for (const n of walk(ci.id, 'target_id', 'source_id', depth)) if (!nodes.has(n.id)) nodes.set(n.id, { ...n, level: n.depth });
    for (const n of walk(ci.id, 'source_id', 'target_id', depth)) if (!nodes.has(n.id)) nodes.set(n.id, { ...n, level: -n.depth });
    const list = [...nodes.values()].map(({ depth: _d, ...n }) => n);
    return { nodes: list, edges: edgesAmong(list.map((n) => n.id)) };
  });

  // Mapa de todas as relações de um cliente
  add('GET', '/api/clients/:id/graph', ({ user, params }) => {
    const c = getClient(user, params.id);
    const nodes = all(`SELECT c.id, c.name, c.status, c.criticality, t.name AS type_name FROM cis c
      JOIN ci_types t ON t.id = c.type_id
      WHERE c.client_id = ? AND EXISTS (SELECT 1 FROM relationships r WHERE r.source_id = c.id OR r.target_id = c.id)
      ORDER BY c.name LIMIT 801`, c.id);
    // O mapa de um cliente mostra até 800 ativos; acima disso, avisa (a ficha de cada ativo tem o seu próprio mapa)
    const truncated = nodes.length > 800;
    if (truncated) nodes.pop();
    return { nodes, edges: edgesAmong(nodes.map((n) => n.id)), truncated };
  });

  // ---- relações
  add('POST', '/api/relationships', ({ user, body }) => {
    const src = getCi(user, body.source_id);
    const dst = getCi(user, body.target_id);
    assertWrite(user, src.client_id);
    if (src.client_id !== dst.client_id) fail(400, 'Só é possível relacionar ativos do mesmo cliente');
    if (src.id === dst.id) fail(400, 'Um ativo não se pode relacionar consigo próprio');
    const type = oneOf(body.type, REL_TYPES, 'Tipo de relação');
    const r = run('INSERT INTO relationships (source_id, target_id, type) VALUES (?,?,?)', src.id, dst.id, type);
    audit('relationship', Number(r.lastInsertRowid), src.client_id, `#${src.id}# ${src.name} → #${dst.id}# ${dst.name}`,
      user.username, 'create', { type });
    return { id: Number(r.lastInsertRowid) };
  });
  add('DELETE', '/api/relationships/:id', ({ user, params }) => {
    const r = one('SELECT * FROM relationships WHERE id = ?', toId(params.id));
    if (!r) fail(404, 'Relação não encontrada');
    const src = getCi(user, r.source_id);
    const dst = one('SELECT id, name FROM cis WHERE id = ?', r.target_id);
    assertWrite(user, src.client_id);
    run('DELETE FROM relationships WHERE id = ?', r.id);
    audit('relationship', r.id, src.client_id, `#${src.id}# ${src.name} → #${dst.id}# ${dst.name}`,
      user.username, 'delete', { type: r.type });
    return { ok: true };
  });
  return { readCiInput, walk };
};
