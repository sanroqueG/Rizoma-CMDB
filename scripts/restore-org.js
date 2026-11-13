#!/usr/bin/env node
'use strict';
/*
 * Repor uma organização a partir de uma cópia de segurança (as outras não são tocadas).
 *
 *   node scripts/restore-org.js --backup data/backups/cmdb-2026-11-12.db --org acme           # simula
 *   node scripts/restore-org.js --backup data/backups/cmdb-2026-11-12.db --org acme --apply   # repõe
 *
 * --db  BD atual (por omissão CMDB_DB ou data/cmdb.db). Pode correr com o servidor ligado.
 * Antes de repor, faça uma cópia de segurança da BD atual.
 */
const path = require('node:path');
const { openDb } = require('../src/db');
const { restoreOrg } = require('../src/restore-org');

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const backup = arg('backup');
const org = arg('org');
if (!backup || !org) {
  console.error('Uso: node scripts/restore-org.js --backup <ficheiro.db> --org <slug|id> [--apply] [--db <bd atual>]');
  process.exit(2);
}
const dbFile = arg('db') || process.env.CMDB_DB || path.join(__dirname, '..', 'data', 'cmdb.db');
const db = openDb(dbFile);
try {
  const r = restoreOrg({ db, backupFile: backup, org, apply: args.includes('--apply'), actor: process.env.USERNAME || process.env.USER || 'plataforma' });
  console.log(`${r.applied ? 'Reposta' : 'Simulação para'} a organização ${r.org} a partir de ${path.basename(backup)}:\n`);
  console.log('Tabela              Atual   Cópia');
  for (const s of r.summary) console.log(`${s.table.padEnd(18)} ${String(s.atual).padStart(6)}  ${String(s.copia).padStart(6)}`);
  if (!r.applied) console.log('\nNada foi alterado. Acrescente --apply para repor.');
} catch (e) {
  console.error(`Erro: ${e.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
