'use strict';
/* Pesquisa global: ativos, clientes, locais, contratos e tickets de todos os clientes a que o utilizador tem acesso. */

const { ciTextFilter } = require('../store');

module.exports = function registerSearch(core) {
  const { add, all, fail, scopeSql } = core;

  add('GET', '/api/search', ({ user, query }) => {
    const q = String(query.q || '').trim();
    if (q.length < 2) fail(400, 'Escreva pelo menos 2 caracteres');
    if (q.length > 100) fail(400, 'Pesquisa demasiado longa');
    const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    const L = (n) => Array(n).fill(like);
    const E = "ESCAPE '\\'";
    const sc = scopeSql(user, 'c.client_id');
    const scl = scopeSql(user, 'cl.id');
    const sk = scopeSql(user, 'k.client_id');
    const ss = scopeSql(user, 's.client_id');
    const st = scopeSql(user, 't.client_id');

    // Ativos: correspondências exatas (hostname, nº de série, IP, etiqueta) primeiro
    const t = ciTextFilter(q, 'c.id');
    const cis = all(`SELECT c.id, c.name, c.hostname, c.serial_number, c.ip_address, c.status, c.owner, c.model,
        t.name AS type_name, cl.code AS client_code, cl.name AS client_name
      FROM cis c JOIN ci_types t ON t.id = c.type_id JOIN clients cl ON cl.id = c.client_id
      WHERE ${sc.sql} AND ${t.sql}
      ORDER BY (lower(c.hostname) = lower(?) OR lower(c.serial_number) = lower(?) OR c.ip_address = ? OR lower(c.asset_tag) = lower(?)) DESC,
        (c.status = 'abatido'), c.name LIMIT 10`, ...sc.params, ...t.params, q, q, q, q);
    const clients = all(`SELECT cl.id, cl.name, cl.code FROM clients cl
      WHERE ${scl.sql} AND (cl.name LIKE ? ${E} OR cl.code LIKE ? ${E} OR cl.contact_name LIKE ? ${E} OR cl.contact_email LIKE ? ${E})
      ORDER BY cl.name LIMIT 5`, ...scl.params, ...L(4));
    const sites = all(`SELECT s.id, s.name, s.address, s.client_id, cl.code AS client_code FROM sites s JOIN clients cl ON cl.id = s.client_id
      WHERE ${ss.sql} AND (s.name LIKE ? ${E} OR s.address LIKE ? ${E}) ORDER BY s.name LIMIT 5`, ...ss.params, ...L(2));
    const contracts = all(`SELECT k.id, k.name, k.vendor, k.end_date, k.status, cl.code AS client_code FROM contracts k JOIN clients cl ON cl.id = k.client_id
      WHERE ${sk.sql} AND (k.name LIKE ? ${E} OR k.vendor LIKE ? ${E} OR k.reference LIKE ? ${E})
      ORDER BY k.status = 'ativo' DESC, k.name LIMIT 5`, ...sk.params, ...L(3));
    const tickets = all(`SELECT t.id, t.system, t.external_id, t.title, t.closed, t.url, cl.code AS client_code,
        (SELECT x.ci_id FROM ticket_cis x WHERE x.ticket_id = t.id LIMIT 1) AS ci_id
      FROM tickets t JOIN clients cl ON cl.id = t.client_id
      WHERE ${st.sql} AND (t.external_id LIKE ? ${E} OR t.title LIKE ? ${E}) ORDER BY t.closed, t.updated_at DESC LIMIT 5`, ...st.params, ...L(2));
    return { q, cis, clients, sites, contracts, tickets: tickets.map((t) => ({ ...t, closed: !!t.closed })) };
  });
};
