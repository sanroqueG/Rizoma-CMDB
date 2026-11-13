'use strict';
/*
 * Integração com ferramentas de tickets (GLPI, Freshservice, Jira Service Management, Zendesk…).
 * - Na interface: ligar manualmente um ticket a um ativo.
 * - Webhook (token do cliente): a ferramenta cria/atualiza o ticket e indica os ativos afetados
 *   por hostname, nº de série, etiqueta, nome ou ID. A resposta inclui a análise de impacto,
 *   para a ferramenta poder ajustar a prioridade.
 * - Consulta (token do cliente): procurar ativos e o respetivo impacto a partir da ferramenta.
 */
const { sha256 } = require('../auth');

const CLOSED_RE = /^(closed|resolved|solved|done|cancel+ed|fechad|resolvid|encerrad|conclu[ií]d|cancelad)/i;
const CRIT_RANK = { baixa: 1, media: 2, alta: 3, critica: 4 };

module.exports = function registerTickets(core) {
  const { add, one, all, run, tx, audit, fail, scopeSql, assertWrite, getCi, toId, str, reqStr, walk } = core;

  function readTicket(body) {
    const t = {
      system: reqStr(body.system, 'Sistema', 40),
      external_id: reqStr(body.external_id, 'ID do ticket', 80),
      title: str(body.title, 300),
      status: str(body.status, 60),
      priority: str(body.priority, 40),
      url: str(body.url, 500),
    };
    if (t.url && !/^https?:\/\//i.test(t.url)) fail(400, 'O URL do ticket tem de começar por http:// ou https://');
    t.closed = 'closed' in body ? (body.closed ? 1 : 0) : (t.status && CLOSED_RE.test(t.status) ? 1 : 0);
    return t;
  }

  /** Cria ou atualiza o ticket (chave: cliente + sistema + ID externo). Devolve { id, created }. */
  function upsert(clientId, t) {
    const old = one('SELECT * FROM tickets WHERE client_id = ? AND system = ? AND external_id = ?', clientId, t.system, t.external_id);
    if (old) {
      run(`UPDATE tickets SET title = COALESCE(?, title), status = COALESCE(?, status), priority = COALESCE(?, priority),
        url = COALESCE(?, url), closed = ?, updated_at = datetime('now') WHERE id = ?`,
      t.title, t.status, t.priority, t.url, t.closed, old.id);
      return { id: old.id, created: false };
    }
    const r = run(`INSERT INTO tickets (client_id, system, external_id, title, status, priority, url, closed)
      VALUES (?,?,?,?,?,?,?,?)`, clientId, t.system, t.external_id, t.title, t.status, t.priority, t.url, t.closed);
    return { id: Number(r.lastInsertRowid), created: true };
  }
  const link = (ticketId, ciId) => run('INSERT OR IGNORE INTO ticket_cis (ticket_id, ci_id) VALUES (?, ?)', ticketId, ciId);
  const ticketView = (t) => (t ? { ...t, closed: !!t.closed } : t);

  /** Resumo de impacto de um ativo: quantos dependem dele e a criticidade mais alta entre eles. */
  function impactOf(ci) {
    const impacted = walk(ci.id, 'source_id', 'target_id', 10);
    const maxCrit = [ci, ...impacted].reduce((m, x) => (CRIT_RANK[x.criticality] > CRIT_RANK[m] ? x.criticality : m), 'baixa');
    return {
      impacted_count: impacted.length,
      max_criticality: maxCrit,
      impacted: impacted.slice(0, 50).map((x) => ({ id: x.id, name: x.name, type: x.type_name, criticality: x.criticality, depth: x.depth })),
    };
  }

  // ------------------------------------------------------------ interface (sessão)
  add('GET', '/api/cis/:id/tickets', ({ user, params }) => {
    const ci = getCi(user, params.id);
    return all(`SELECT t.* FROM tickets t JOIN ticket_cis x ON x.ticket_id = t.id WHERE x.ci_id = ?
      ORDER BY t.closed, t.updated_at DESC`, ci.id).map(ticketView);
  });

  add('POST', '/api/cis/:id/tickets', ({ user, params, body }) => {
    const ci = getCi(user, params.id);
    assertWrite(user, ci.client_id);
    const t = readTicket(body);
    const r = tx(() => { const x = upsert(ci.client_id, t); link(x.id, ci.id); return x; });
    audit('ticket', r.id, ci.client_id, `${t.system} ${t.external_id}`, user.username, r.created ? 'create' : 'update', { ativo: ci.name });
    return ticketView(one('SELECT * FROM tickets WHERE id = ?', r.id));
  });

  add('DELETE', '/api/cis/:id/tickets/:ticketId', ({ user, params }) => {
    const ci = getCi(user, params.id);
    assertWrite(user, ci.client_id);
    const t = one('SELECT * FROM tickets WHERE id = ? AND client_id = ?', toId(params.ticketId), ci.client_id);
    if (!t) fail(404, 'Ticket não encontrado');
    tx(() => {
      run('DELETE FROM ticket_cis WHERE ticket_id = ? AND ci_id = ?', t.id, ci.id);
      // Um ticket sem ativos ligados deixa de ter interesse no Rizoma
      if (!one('SELECT 1 FROM ticket_cis WHERE ticket_id = ?', t.id)) run('DELETE FROM tickets WHERE id = ?', t.id);
    });
    audit('ticket', t.id, ci.client_id, `${t.system} ${t.external_id}`, user.username, 'delete', { ativo: ci.name });
    return { ok: true };
  });

  add('GET', '/api/tickets', ({ user, query }) => {
    const s = scopeSql(user, 't.client_id');
    const where = [s.sql];
    const params = [...s.params];
    if (query.client) { where.push('t.client_id = ?'); params.push(toId(query.client, 'Cliente')); }
    if (query.open === '1') where.push('t.closed = 0');
    return all(`SELECT t.*, cl.name AS client_name,
        (SELECT group_concat(c.name, ', ') FROM ticket_cis x JOIN cis c ON c.id = x.ci_id WHERE x.ticket_id = t.id) AS ci_names
      FROM tickets t JOIN clients cl ON cl.id = t.client_id WHERE ${where.join(' AND ')}
      ORDER BY t.closed, t.updated_at DESC LIMIT 500`, ...params).map(ticketView);
  });

  // ------------------------------------------------------------ integração (token do cliente)
  const tokenClient = (req) => core.requireToken(req, 'tickets');

  /** Procura um ativo do cliente por id, hostname, nº de série, etiqueta ou nome (por esta ordem). */
  function findCi(clientId, ref) {
    if (ref === null || ref === undefined) return null;
    if (typeof ref !== 'object') ref = { q: ref };
    if (ref.id) return one('SELECT * FROM cis WHERE id = ? AND client_id = ?', Number(ref.id), clientId) || null;
    const tries = [
      ['hostname', ref.hostname], ['serial_number', ref.serial_number], ['asset_tag', ref.asset_tag], ['name', ref.name],
      ...(ref.q ? ['hostname', 'serial_number', 'asset_tag', 'name', 'ip_address'].map((f) => [f, ref.q]) : []),
    ];
    for (const [col, v] of tries) {
      if (!v) continue;
      // col vem da lista fixa acima, nunca do pedido
      const ci = one(`SELECT * FROM cis WHERE client_id = ? AND ${col} = ? COLLATE NOCASE AND status <> 'abatido' ORDER BY id LIMIT 1`, clientId, String(v).trim());
      if (ci) return ci;
    }
    return null;
  }

  add('POST', '/api/integrations/tickets', ({ req, body }) => {
    const tok = tokenClient(req);
    const t = readTicket(body);
    const refs = Array.isArray(body.cis) ? body.cis.slice(0, 50) : [];
    const matched = [];
    const unmatched = [];
    const r = tx(() => {
      const x = upsert(tok.client_id, t);
      for (const ref of refs) {
        const ci = findCi(tok.client_id, ref);
        if (ci) { link(x.id, ci.id); matched.push(ci); } else unmatched.push(ref);
      }
      return x;
    });
    audit('ticket', r.id, tok.client_id, `${t.system} ${t.external_id}`, `integracao:${tok.name}`, r.created ? 'create' : 'update',
      { estado: t.status, ativos: matched.map((c) => c.name).join(', ') || undefined });
    const ticket = ticketView(one('SELECT * FROM tickets WHERE id = ?', r.id));
    return {
      ticket, created: r.created,
      cis: matched.map((ci) => ({ id: ci.id, name: ci.name, criticality: ci.criticality, ...impactOf(ci) })),
      unmatched,
    };
  }, {
    public: true, token: true, api: true, body: require('../api-schemas').ticket, scope: 'tickets', tag: 'Tickets',
    summary: 'Criar ou atualizar um ticket e ligá-lo a ativos',
    description: 'Chave: system + external_id. A resposta inclui a análise de impacto de cada ativo ligado (impacted_count, max_criticality).',
  });

  add('GET', '/api/integrations/cis', ({ req, query }) => {
    const tok = tokenClient(req);
    const q = String(query.q || '').trim();
    if (q.length < 2) fail(400, 'Indique pelo menos 2 caracteres em "q"');
    const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    const rows = all(`SELECT c.*, t.name AS type_name FROM cis c JOIN ci_types t ON t.id = c.type_id
      WHERE c.client_id = ? AND (c.name LIKE ? ESCAPE '\\' OR c.hostname LIKE ? ESCAPE '\\' OR c.serial_number LIKE ? ESCAPE '\\'
        OR c.asset_tag LIKE ? ESCAPE '\\' OR c.ip_address LIKE ? ESCAPE '\\')
      ORDER BY c.status = 'abatido', c.name LIMIT 10`, tok.client_id, like, like, like, like, like);
    return rows.map((ci) => ({
      id: ci.id, name: ci.name, type: ci.type_name, status: ci.status, criticality: ci.criticality, hostname: ci.hostname,
      serial_number: ci.serial_number, owner: ci.owner,
      open_tickets: one(`SELECT COUNT(*) AS n FROM tickets k JOIN ticket_cis x ON x.ticket_id = k.id WHERE x.ci_id = ? AND k.closed = 0`, ci.id).n,
      ...impactOf(ci),
    }));
  }, {
    public: true, token: true, api: true, scope: 'tickets', tag: 'Tickets', query: { q: 'Texto a procurar (mín. 2 caracteres): nome, hostname, nº de série, etiqueta ou IP.' },
    summary: 'Procurar ativos e o respetivo impacto',
  });
};
