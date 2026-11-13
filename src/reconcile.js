'use strict';
/* Reconciliação de ativos descobertos automaticamente (agentes, Intune, Azure, M365).
   Procura um ativo existente do mesmo cliente por external_id → nº de série → hostname
   e atualiza-o; caso contrário cria um novo. */

const DISCOVERED_FIELDS = ['hostname', 'ip_address', 'serial_number', 'manufacturer', 'model', 'os'];
const BAD_SERIAL = /^(0+|none|unknown|n\/?a|default string|to be filled.*|system serial number|not specified|.*o\.e\.m.*)$/i;

function s(v, max = 255) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t.slice(0, max);
}
function sqlTime(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace('T', ' ');
}
function cleanAttrs(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj).slice(0, 100)) {
    const key = String(k).trim().slice(0, 64);
    if (!key || v === null || v === undefined || v === '') continue;
    out[key] = typeof v === 'number' || typeof v === 'boolean' ? v : String(v).slice(0, 1000);
  }
  return out;
}

function createReconciler({ one, all, run, audit }) {
  const typeCache = new Map();
  function typeId(name) {
    if (!name) return null;
    const key = String(name).toLowerCase();
    if (!typeCache.has(key)) {
      const r = one('SELECT id FROM ci_types WHERE name = ?', String(name));
      typeCache.set(key, r ? r.id : null);
    }
    return typeCache.get(key);
  }

  /**
   * @param {number} clientId  cliente dono
   * @param {Record<string, any>} a  ativo: external_id, name, type, site, hostname, ip_address, serial_number, manufacturer, model, os, attributes
   * @param {string} actor  texto para auditoria (ex.: "agente:GPO", "intune")
   * @param {string} source  'agent' | 'intune' | 'azure' | 'm365'
   * @param {{ status?: string, lastSeen?: any, owns?: boolean, defaultType?: string }} [opts]  owns: atualizar nome/tipo/estado de registos da mesma origem
   */
  function upsert(clientId, a, actor, source, opts = {}) {
    const d = {};
    for (const f of DISCOVERED_FIELDS) d[f] = s(a[f]);
    if (d.serial_number && BAD_SERIAL.test(d.serial_number)) d.serial_number = null;
    const externalId = s(a.external_id, 300);
    if (!d.hostname && !d.serial_number && !externalId) throw new Error('indique hostname, serial_number ou external_id');
    const tId = typeId(a.type);
    const attrs = cleanAttrs(a.attributes);
    const lastSeen = sqlTime(opts.lastSeen) || new Date().toISOString().slice(0, 19).replace('T', ' ');

    let existing = null;
    if (externalId) existing = one('SELECT * FROM cis WHERE client_id = ? AND external_id = ?', clientId, externalId);
    if (!existing && d.serial_number) existing = one('SELECT * FROM cis WHERE client_id = ? AND serial_number = ? ORDER BY id LIMIT 1', clientId, d.serial_number);
    if (!existing && d.hostname) existing = one('SELECT * FROM cis WHERE client_id = ? AND hostname = ? COLLATE NOCASE ORDER BY id LIMIT 1', clientId, d.hostname);

    if (existing) {
      const upd = {};
      for (const [k, v] of Object.entries(d)) if (v !== null && v !== existing[k]) upd[k] = v;
      const merged = JSON.stringify({ ...JSON.parse(existing.attributes || '{}'), ...attrs });
      if (merged !== existing.attributes) upd.attributes = merged;
      if (externalId && !existing.external_id) upd.external_id = externalId;
      if (opts.owns && existing.source === source) {
        const name = s(a.name);
        if (name && name !== existing.name) upd.name = name;
        if (tId && tId !== existing.type_id) upd.type_id = tId;
        if (opts.status && opts.status !== existing.status) upd.status = opts.status;
      }
      const cols = Object.keys(upd);
      run(`UPDATE cis SET ${[...cols.map((k) => `${k} = ?`), 'last_seen = ?',
        "updated_at = CASE WHEN ? THEN datetime('now') ELSE updated_at END"].join(', ')} WHERE id = ?`,
      ...cols.map((k) => upd[k]), lastSeen, cols.length ? 1 : 0, existing.id);
      if (cols.length) {
        const changes = Object.fromEntries(cols.filter((k) => k !== 'attributes').map((k) => [k, [existing[k], upd[k]]]));
        if (upd.attributes) changes.attributes = ['…', '(atualizados)'];
        audit('ci', existing.id, clientId, upd.name || existing.name, actor, 'update', changes);
      }
      return { id: existing.id, action: cols.length ? 'updated' : 'unchanged' };
    }

    const site = a.site ? one('SELECT id FROM sites WHERE client_id = ? AND name = ? COLLATE NOCASE', clientId, String(a.site)) : null;
    const name = s(a.name) || d.hostname || d.serial_number || externalId;
    const r = run(`INSERT INTO cis (client_id, site_id, type_id, name, hostname, ip_address, serial_number, manufacturer,
        model, os, attributes, source, external_id, last_seen, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    clientId, site ? site.id : null, tId || typeId(opts.defaultType || 'Posto de trabalho'), name, d.hostname, d.ip_address,
    d.serial_number, d.manufacturer, d.model, d.os, JSON.stringify(attrs), source, externalId, lastSeen, opts.status || 'em_producao');
    const id = Number(r.lastInsertRowid);
    audit('ci', id, clientId, name, actor, 'create');
    return { id, action: 'created' };
  }

  /** Marca como "abatido" os ativos com o prefixo indicado que deixaram de aparecer na origem. */
  function retireMissing(clientId, prefix, seenIds, actor) {
    const seen = new Set(seenIds);
    const rows = all(`SELECT id, name, status, external_id FROM cis
      WHERE client_id = ? AND external_id LIKE ? AND status <> 'abatido'`, clientId, `${prefix}%`);
    let n = 0;
    for (const r of rows) {
      if (seen.has(r.external_id)) continue;
      run("UPDATE cis SET status = 'abatido', updated_at = datetime('now') WHERE id = ?", r.id);
      audit('ci', r.id, clientId, r.name, actor, 'update', { status: [r.status, 'abatido'], motivo: 'deixou de existir na origem' });
      n++;
    }
    return n;
  }

  function relate(sourceId, targetId, type) {
    run('INSERT OR IGNORE INTO relationships (source_id, target_id, type) VALUES (?,?,?)', sourceId, targetId, type);
  }

  return { upsert, retireMissing, relate };
}

module.exports = { createReconciler };
