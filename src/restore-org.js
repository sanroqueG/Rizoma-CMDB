'use strict';
/*
 * Repõe os dados de UMA organização a partir de uma cópia de segurança, sem tocar nas outras.
 *
 * - A cópia é aberta numa cópia temporária e migrada para o esquema atual (cópias antigas também servem).
 * - Numa só transação: apaga os dados atuais da organização e insere os da cópia, com os ids originais.
 * - Mantém a linha da organização (subscrição, estado, limites) e a auditoria; regista a reposição na auditoria.
 * - Se um id da cópia já estiver ocupado por outra organização, desiste sem alterar nada.
 * - Utilizadores voltam ao estado da cópia (as sessões abertas terminam).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDb } = require('./db');

const IN_CLIENTS = 'client_id IN (SELECT id FROM clients WHERE org_id = ?)';
const IN_USERS = 'user_id IN (SELECT id FROM users WHERE org_id = ?)';
/** Tabelas da organização, pela ordem de inserção (pais antes dos filhos), com a condição que as liga à organização. */
const TABLES = [
  ['org_sso', 'org_id = ?'],
  ['org_sso_domains', 'org_id = ?'],
  ['ci_types', 'org_id = ?'],
  ['clients', 'org_id = ?'],
  ['users', 'org_id = ?'],
  ['sites', IN_CLIENTS],
  ['cis', IN_CLIENTS],
  ['relationships', 'source_id IN (SELECT c.id FROM cis c JOIN clients cl ON cl.id = c.client_id WHERE cl.org_id = ?)'],
  ['contracts', IN_CLIENTS],
  ['contract_cis', 'contract_id IN (SELECT k.id FROM contracts k JOIN clients cl ON cl.id = k.client_id WHERE cl.org_id = ?)'],
  ['tickets', IN_CLIENTS],
  ['ticket_cis', 'ticket_id IN (SELECT t.id FROM tickets t JOIN clients cl ON cl.id = t.client_id WHERE cl.org_id = ?)'],
  ['user_clients', IN_USERS],
  ['api_tokens', IN_CLIENTS],
  ['cloud_connectors', IN_CLIENTS],
  ['rmm_connections', 'org_id = ?'],
  ['rmm_client_map', 'connection_id IN (SELECT id FROM rmm_connections WHERE org_id = ?)'],
];
// Apagadas mas não repostas (estado transitório dos utilizadores da organização)
const TRANSIENT = [['sessions', IN_USERS], ['user_tokens', IN_USERS], ['mfa_challenges', IN_USERS]];

const columnsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const hasId = (db, table) => columnsOf(db, table).includes('id');

/**
 * @param {object} o
 * @param {any} o.db BD atual (aberta com openDb)
 * @param {string} o.backupFile ficheiro da cópia de segurança
 * @param {string|number} o.org slug ou id da organização
 * @param {boolean} [o.apply] false (omissão) = só simula
 * @param {string} [o.actor] quem repõe (auditoria)
 */
function restoreOrg({ db, backupFile, org, apply = false, actor = 'plataforma' }) {
  if (!fs.existsSync(backupFile)) throw new Error(`Cópia não encontrada: ${backupFile}`);
  const target = /** @type {any} */ (db.prepare('SELECT * FROM organizations WHERE id = ? OR slug = ?').get(Number(org) || -1, String(org)));
  if (!target) throw new Error(`Organização não encontrada na BD atual: ${org}`);

  // Cópia temporária migrada para o esquema atual (o ficheiro original nunca é alterado)
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rizoma-restore-')), 'copia.db');
  const src0 = new DatabaseSync(backupFile, /** @type {any} */ ({ readOnly: true }));
  src0.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  src0.close();
  const src = openDb(tmp);
  try {
    const source = /** @type {any} */ (src.prepare('SELECT * FROM organizations WHERE id = ?').get(target.id));
    if (!source) throw new Error(`A organização ${target.slug} (id ${target.id}) não existe nesta cópia`);
    /** @type {Record<string, any[]>} */
    const rows = Object.fromEntries(TABLES.map(([t, where]) => [t, src.prepare(`SELECT * FROM ${t} WHERE ${where}`).all(source.id)]));
    const current = Object.fromEntries(TABLES.map(([t, where]) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`).get(target.id).n]));
    const summary = TABLES.map(([t]) => ({ table: t, atual: current[t], copia: rows[t].length }));
    if (!apply) return { applied: false, org: target.slug, summary };

    db.exec('BEGIN IMMEDIATE');
    try {
      // 1) apagar os dados atuais (filhos antes dos pais)
      for (const [t, where] of [...TRANSIENT, ...[...TABLES].reverse()]) db.prepare(`DELETE FROM ${t} WHERE ${where}`).run(target.id);
      // 2) ids da cópia ocupados por outra organização?
      for (const [t] of TABLES) {
        if (!hasId(db, t) || !rows[t].length) continue;
        const check = db.prepare(`SELECT 1 FROM ${t} WHERE id = ?`);
        const clash = rows[t].find((r) => check.get(r.id));
        if (clash) throw new Error(`Conflito: ${t} id ${clash.id} já pertence a outra organização. Nada foi alterado.`);
      }
      // 3) inserir os dados da cópia
      for (const [t] of TABLES) {
        const cols = columnsOf(db, t);
        for (const r of rows[t]) {
          const use = cols.filter((c) => c in r);
          db.prepare(`INSERT INTO ${t} (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`).run(...use.map((c) => r[c]));
        }
      }
      const fk = db.prepare('PRAGMA foreign_key_check').all();
      if (fk.length) throw new Error(`Referências inválidas depois da reposição (${fk[0].table}). Nada foi alterado.`);
      db.prepare(`INSERT INTO audit (entity, entity_id, label, actor, action, changes, org_id) VALUES ('organization', ?, ?, ?, 'reposicao', ?, ?)`)
        .run(target.id, target.name, actor, JSON.stringify({ copia: path.basename(backupFile), tabelas: summary }), target.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { applied: true, org: target.slug, summary };
  } finally {
    src.close();
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

module.exports = { restoreOrg, TABLES };
