'use strict';
/*
 * Camada de acesso a dados. Todo o SQL da aplicação passa por estas funções (one/all/run/tx), nunca por
 * db.prepare diretamente: é aqui que se troca de motor (SQLite → PostgreSQL) — ver docs/postgresql.md.
 *
 * O SQL usa o dialeto SQLite; as diferenças relevantes para outros motores estão concentradas em `sql`
 * (datas, agregações, "insert or ignore"), que as rotas novas devem usar em vez de escrever SQL específico.
 */

/** Fragmentos de SQL dependentes do motor. */
const SQLITE_DIALECT = {
  name: 'sqlite',
  now: "datetime('now')",
  today: "date('now')",
  /** Data relativa a hoje: dateOffset('+30 days') */
  dateOffset: (modifier) => `date('now', '${String(modifier).replace(/[^0-9a-z +-]/gi, '')}')`,
  datetimeOffset: (modifier) => `datetime('now', '${String(modifier).replace(/[^0-9a-z +-]/gi, '')}')`,
  groupConcat: (expr, sep = ', ') => `group_concat(${expr}, '${sep.replace(/'/g, "''")}')`,
  insertIgnore: 'INSERT OR IGNORE',
  likeEscape: "ESCAPE '\\'",
};

function createStore(db, { dialect = SQLITE_DIALECT } = {}) {
  search.fts = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'cis_fts'").get();
  try { search.fold = db.prepare("SELECT rz_fold('Á') AS v").get().v === 'a'; } catch { search.fold = false; }
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  let depth = 0;
  /** Transação; chamadas encadeadas usam SAVEPOINT (a mais exterior faz COMMIT). */
  function tx(fn) {
    const sp = `sp${depth}`;
    db.exec(depth ? `SAVEPOINT ${sp}` : 'BEGIN');
    depth++;
    try {
      const r = fn();
      depth--;
      db.exec(depth ? `RELEASE ${sp}` : 'COMMIT');
      return r;
    } catch (e) {
      depth--;
      db.exec(depth ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK');
      throw e;
    }
  }
  /** Regista um evento de auditoria. A organização vem do cliente, do utilizador do registo, ou é indicada. */
  function audit(entity, entityId, clientId, label, actor, action, changes, orgId) {
    let org = orgId ?? null;
    if (org === null && clientId) org = one('SELECT org_id FROM clients WHERE id = ?', clientId)?.org_id ?? null;
    if (org === null && entity === 'user' && entityId) org = one('SELECT org_id FROM users WHERE id = ?', entityId)?.org_id ?? null;
    const r = run('INSERT INTO audit (entity, entity_id, client_id, label, actor, action, changes, org_id) VALUES (?,?,?,?,?,?,?,?)',
      entity, entityId ?? null, clientId ?? null, label ?? null, actor, action,
      changes ? JSON.stringify(changes) : null, org);
    // Ouvintes (ex.: webhooks) correm na mesma transação: se a alteração for desfeita, o evento também é
    for (const fn of listeners) fn({ id: Number(r.lastInsertRowid), entity, entityId, clientId, label, actor, action, changes, orgId: org });
  }
  /** @type {Array<(e: any) => void>} */
  const listeners = [];
  const onAudit = (fn) => { listeners.push(fn); };
  return { db, one, all, run, tx, audit, onAudit, sql: dialect };
}

/**
 * Pesquisa de texto nos ativos. Devolve { sql, params } com uma condição sobre `column` (o id do ativo):
 * com 3+ caracteres por termo usa o índice FTS5 (trigram); termos mais curtos caem para LIKE.
 */
// Capacidades do SQLite (definidas por createStore): índice FTS5 e função rz_fold (ver db.js)
const search = { fts: true, fold: false };
const fold = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function ciTextFilter(q, column = 'c.id') {
  const terms = String(q || '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return { sql: '1=1', params: [] };
  if (search.fts && terms.every((t) => t.length >= 3)) {
    const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
    return { sql: `${column} IN (SELECT rowid FROM cis_fts WHERE cis_fts MATCH ?)`, params: [match] };
  }
  const cols = ['name', 'hostname', 'serial_number', 'ip_address', 'asset_tag', 'owner', 'model', 'os', 'notes', 'external_id'];
  const alias = column.includes('.') ? column.split('.')[0] + '.' : '';
  // Sem FTS5 (ou termos curtos): LIKE; com rz_fold, também sem diferença de acentos
  const col = (c) => (search.fold ? `rz_fold(${alias}${c})` : `${alias}${c}`);
  const parts = terms.map(() => `(${cols.map((c) => `${col(c)} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
  const params = terms.flatMap((t) => Array(cols.length).fill(`%${(search.fold ? fold(t) : t).replace(/[\\%_]/g, (m) => '\\' + m)}%`));
  return { sql: parts.join(' AND '), params };
}

module.exports = { createStore, SQLITE_DIALECT, ciTextFilter, search };
