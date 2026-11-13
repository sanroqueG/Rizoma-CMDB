'use strict';
/* Contratos: licenças de software, suporte, manutenção, subscrições… por cliente, com ligação a ativos. */

const KINDS = ['licenca', 'suporte', 'manutencao', 'subscricao', 'garantia', 'outsourcing', 'outro'];
const STATUSES = ['ativo', 'terminado', 'cancelado'];
const BILLING = ['mensal', 'trimestral', 'anual', 'unico'];
const PER_YEAR = { mensal: 12, trimestral: 4, anual: 1 };

/** Custo anualizado (null para pagamentos únicos ou sem custo/periodicidade). */
const annualCost = (c) => (c.cost !== null && c.cost !== undefined && PER_YEAR[c.billing] ? Math.round(c.cost * PER_YEAR[c.billing] * 100) / 100 : null);

module.exports = function registerContracts(core) {
  const { add, one, all, run, tx, audit, fail, scopeSql, assertRead, assertWrite, getClient, getCi, toId, str, reqStr, oneOf, isoDate } = core;

  function readInput(body, partial) {
    const out = {};
    if (!partial || 'name' in body) out.name = reqStr(body.name, 'Nome', 160);
    if ('kind' in body || !partial) out.kind = oneOf(body.kind || 'licenca', KINDS, 'Tipo de contrato');
    if ('status' in body) out.status = oneOf(body.status, STATUSES, 'Estado');
    for (const f of ['vendor', 'reference', 'owner']) if (f in body) out[f] = str(body[f], 160);
    if ('notes' in body) out.notes = str(body.notes, 5000);
    if ('start_date' in body) out.start_date = isoDate(body.start_date, 'Data de início');
    if ('end_date' in body) out.end_date = isoDate(body.end_date, 'Data de fim');
    if ('auto_renew' in body) out.auto_renew = body.auto_renew ? 1 : 0;
    if ('billing' in body) out.billing = body.billing ? oneOf(body.billing, BILLING, 'Periodicidade') : null;
    const num = (k, label, { int = false, min = 0, max = 1e12 } = {}) => {
      if (!(k in body)) return;
      const v = body[k];
      if (v === null || v === '' || v === undefined) { out[k] = null; return; }
      const n = Number(String(v).replace(',', '.'));
      if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) fail(400, `${label} inválido`);
      out[k] = n;
    };
    num('cost', 'Custo');
    num('quantity', 'Quantidade', { int: true, max: 1e9 });
    num('notice_days', 'Pré-aviso (dias)', { int: true, max: 3650 });
    if (out.start_date && out.end_date && out.end_date < out.start_date) fail(400, 'A data de fim é anterior à data de início');
    return out;
  }

  const SELECT = `SELECT k.*, cl.name AS client_name, cl.code AS client_code,
      (SELECT COUNT(*) FROM contract_cis x WHERE x.contract_id = k.id) AS ci_count
    FROM contracts k JOIN clients cl ON cl.id = k.client_id`;
  const view = (c) => (c ? { ...c, auto_renew: !!c.auto_renew, annual_cost: annualCost(c) } : c);

  function getContract(user, id) {
    const c = one('SELECT * FROM contracts WHERE id = ?', toId(id));
    if (!c) fail(404, 'Contrato não encontrado');
    assertRead(user, c.client_id);
    return c;
  }

  function filters(user, query) {
    const s = scopeSql(user, 'k.client_id');
    const where = [s.sql];
    const params = [...s.params];
    if (query.client) { where.push('k.client_id = ?'); params.push(toId(query.client, 'Cliente')); }
    if (query.status) { where.push('k.status = ?'); params.push(oneOf(query.status, STATUSES, 'Estado')); }
    if (query.kind) { where.push('k.kind = ?'); params.push(oneOf(query.kind, KINDS, 'Tipo de contrato')); }
    if (query.expiring) {
      const days = Math.min(Math.max(Number(query.expiring) || 0, 0), 3650);
      where.push("k.status = 'ativo' AND k.end_date IS NOT NULL AND k.end_date <= date('now', '+' || (COALESCE(k.notice_days, 0) + ?) || ' days')");
      params.push(days);
    }
    if (query.q) {
      const like = `%${String(query.q).trim().replace(/[\\%_]/g, (m) => '\\' + m)}%`;
      where.push("(k.name LIKE ? ESCAPE '\\' OR k.vendor LIKE ? ESCAPE '\\' OR k.reference LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
    return { where: where.join(' AND '), params };
  }

  add('GET', '/api/contracts', ({ user, query }) => {
    const f = filters(user, query);
    const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 1000);
    const offset = Math.max(Number(query.offset) || 0, 0);
    // Total e custo anual sobre o conjunto completo (não só a página)
    const agg = one(`SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN k.status = 'ativo' AND k.cost IS NOT NULL THEN k.cost *
          (CASE k.billing WHEN 'mensal' THEN 12 WHEN 'trimestral' THEN 4 WHEN 'anual' THEN 1 ELSE 0 END) END), 0) AS annual
      FROM contracts k JOIN clients cl ON cl.id = k.client_id WHERE ${f.where}`, ...f.params);
    const items = all(`${SELECT} WHERE ${f.where} ORDER BY (k.end_date IS NULL), k.end_date, cl.name, k.name, k.id LIMIT ? OFFSET ?`,
      ...f.params, limit, offset).map(view);
    return { total: agg.total, limit, offset, annual_cost: Math.round(agg.annual * 100) / 100, items };
  });

  add('POST', '/api/contracts', ({ user, body }) => {
    const clientId = toId(body.client_id, 'Cliente');
    if (!one('SELECT 1 FROM clients WHERE id = ?', clientId)) fail(404, 'Não encontrado');
    assertWrite(user, clientId);
    const d = readInput(body, false);
    d.client_id = clientId;
    const cols = Object.keys(d);
    const id = tx(() => {
      const r = run(`INSERT INTO contracts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...Object.values(d));
      const cid = Number(r.lastInsertRowid);
      if (Array.isArray(body.ci_ids)) setCis(cid, clientId, body.ci_ids);
      return cid;
    });
    audit('contract', id, clientId, d.name, user.username, 'create');
    return view(one(`${SELECT} WHERE k.id = ?`, id));
  });

  add('GET', '/api/contracts/:id', ({ user, params }) => {
    const c = getContract(user, params.id);
    const full = view(one(`${SELECT} WHERE k.id = ?`, c.id));
    full.cis = all(`SELECT c.id, c.name, c.status, c.serial_number, t.name AS type_name FROM contract_cis x
      JOIN cis c ON c.id = x.ci_id JOIN ci_types t ON t.id = c.type_id WHERE x.contract_id = ? ORDER BY c.name`, c.id);
    full.history = all(`SELECT id, actor, action, changes, created_at FROM audit WHERE entity = 'contract' AND entity_id = ?
      ORDER BY id DESC LIMIT 100`, c.id).map((a) => ({ ...a, changes: a.changes ? JSON.parse(a.changes) : null }));
    return full;
  });

  add('PUT', '/api/contracts/:id', ({ user, params, body }) => {
    const old = getContract(user, params.id);
    assertWrite(user, old.client_id);
    if ('client_id' in body && Number(body.client_id) !== old.client_id) fail(400, 'Não é possível mudar o cliente de um contrato');
    const d = readInput(body, true);
    const merged = { ...old, ...d };
    if (merged.start_date && merged.end_date && merged.end_date < merged.start_date) fail(400, 'A data de fim é anterior à data de início');
    const changes = {};
    for (const [k, v] of Object.entries(d)) if ((old[k] ?? null) !== v) changes[k] = [old[k] ?? null, v];
    tx(() => {
      if (Object.keys(changes).length) {
        const cols = Object.keys(changes);
        run(`UPDATE contracts SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...cols.map((k) => d[k]), old.id);
      }
      if (Array.isArray(body.ci_ids)) {
        const before = all('SELECT ci_id FROM contract_cis WHERE contract_id = ? ORDER BY ci_id', old.id).map((r) => r.ci_id);
        const after = setCis(old.id, old.client_id, body.ci_ids);
        if (before.join() !== after.join()) changes.ativos = [before.length, after.length];
      }
    });
    if (Object.keys(changes).length) audit('contract', old.id, old.client_id, d.name || old.name, user.username, 'update', changes);
    return view(one(`${SELECT} WHERE k.id = ?`, old.id));
  });

  add('DELETE', '/api/contracts/:id', ({ user, params }) => {
    const c = getContract(user, params.id);
    assertWrite(user, c.client_id);
    run('DELETE FROM contracts WHERE id = ?', c.id);
    audit('contract', c.id, c.client_id, c.name, user.username, 'delete');
    return { ok: true };
  });

  /** Substitui os ativos ligados ao contrato; todos têm de ser do mesmo cliente. Devolve os ids (ordenados). */
  function setCis(contractId, clientId, ids) {
    const unique = [...new Set(ids.map((x) => toId(x, 'Ativo')))].sort((a, b) => a - b);
    if (unique.length > 5000) fail(400, 'Demasiados ativos');
    for (const id of unique) {
      const ci = one('SELECT client_id FROM cis WHERE id = ?', id);
      if (!ci || ci.client_id !== clientId) fail(400, 'Só é possível ligar ativos do mesmo cliente');
    }
    run('DELETE FROM contract_cis WHERE contract_id = ?', contractId);
    for (const id of unique) run('INSERT INTO contract_cis (contract_id, ci_id) VALUES (?, ?)', contractId, id);
    return unique;
  }

  add('GET', '/api/cis/:id/contracts', ({ user, params }) => {
    const ci = getCi(user, params.id);
    return all(`${SELECT} JOIN contract_cis x ON x.contract_id = k.id WHERE x.ci_id = ? ORDER BY k.end_date`, ci.id).map(view);
  });

  add('GET', '/api/clients/:id/contracts', ({ user, params }) => {
    const c = getClient(user, params.id);
    return all(`${SELECT} WHERE k.client_id = ? ORDER BY k.status, (k.end_date IS NULL), k.end_date`, c.id).map(view);
  });

  return { KINDS, STATUSES, BILLING, annualCost };
};
