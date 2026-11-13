'use strict';
/*
 * Backups da base de dados.
 * - Cópia consistente com "VACUUM INTO" (funciona com o servidor a correr, em modo WAL).
 * - Cada cópia é verificada com "PRAGMA integrity_check".
 * - A chave de encriptação (secret.key) é copiada junto: sem ela, os segredos dos conectores e do 2FA
 *   guardados na cópia não podem ser lidos.
 * - Retenção: mantém apenas as N cópias mais recentes.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const NAME_RE = /^cmdb-(\d{8}-\d{6})(?:-(\d+))?\.db$/;
/** Chave de ordenação: data/hora e, para cópias no mesmo segundo, o nº de sufixo. */
const sortKey = (f) => { const m = NAME_RE.exec(f); return `${m[1]}-${String(m[2] || 1).padStart(4, '0')}`; };

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * @param {object} o
 * @param {DatabaseSync} o.db       BD em uso
 * @param {string} o.dir            pasta das cópias
 * @param {number} [o.keep=14]      nº de cópias a manter
 * @param {string} [o.keyFile]      ficheiro secret.key a copiar junto de cada cópia (se existir)
 */
function createBackups({ db, dir, keep = 14, keyFile = null }) {
  const keepN = Math.max(1, Number(keep) || 14);

  function list() {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => NAME_RE.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { file: f, size: st.size, created_at: st.mtime.toISOString(), has_key: fs.existsSync(path.join(dir, f.replace(/\.db$/, '.key'))) };
      })
      .sort((a, b) => sortKey(b.file).localeCompare(sortKey(a.file)));
  }

  function prune() {
    const removed = [];
    for (const b of list().slice(keepN)) {
      fs.rmSync(path.join(dir, b.file), { force: true });
      fs.rmSync(path.join(dir, b.file.replace(/\.db$/, '.key')), { force: true });
      removed.push(b.file);
    }
    return removed;
  }

  function run() {
    fs.mkdirSync(dir, { recursive: true });
    let base = `cmdb-${stamp()}`;
    for (let i = 2; fs.existsSync(path.join(dir, `${base}.db`)); i++) base = `cmdb-${stamp()}-${i}`;
    const file = path.join(dir, `${base}.db`);
    const started = Date.now();
    // O caminho vai como parâmetro (não concatenado no SQL)
    db.prepare('VACUUM INTO ?').run(file);

    const check = new DatabaseSync(file, /** @type {any} */ ({ readOnly: true }));
    let integrity;
    try { integrity = /** @type {any} */ (check.prepare('PRAGMA integrity_check').get()).integrity_check; } finally { check.close(); }
    if (integrity !== 'ok') {
      fs.rmSync(file, { force: true });
      throw new Error(`A cópia de segurança falhou a verificação de integridade: ${integrity}`);
    }
    if (keyFile && fs.existsSync(keyFile)) {
      fs.copyFileSync(keyFile, path.join(dir, `${base}.key`));
      try { fs.chmodSync(path.join(dir, `${base}.key`), 0o600); } catch { /* Windows */ }
    }
    const removed = prune();
    return { file: `${base}.db`, size: fs.statSync(file).size, ms: Date.now() - started, removed };
  }

  /** Horas desde a cópia mais recente (Infinity se não houver nenhuma). */
  function hoursSinceLast() {
    const last = list()[0];
    return last ? (Date.now() - Date.parse(last.created_at)) / 3600e3 : Infinity;
  }

  return { run, list, prune, hoursSinceLast, dir, keep: keepN, keyFile };
}

module.exports = { createBackups };
