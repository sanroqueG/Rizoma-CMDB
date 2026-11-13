'use strict';
/*
 * Estado partilhado entre instâncias, guardado na BD (e não na memória de cada processo), para poder correr
 * várias instâncias atrás de um balanceador:
 *  - throttle: contadores por janela de tempo (tentativas de login, registos por IP);
 *  - mfa: desafios de 2.º fator pendentes;
 *  - locks: exclusão mútua com expiração (sincronizações, tarefas agendadas — cada uma corre numa só instância).
 */
const os = require('node:os');
const crypto = require('node:crypto');

const INSTANCE = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
let seq = 0;

function createState({ one, run }) {
  const now = () => Date.now();
  const instance = `${INSTANCE}:${++seq}`; // uma identidade por aplicação (permite várias no mesmo processo)

  const throttle = {
    /** true se a chave já atingiu `max` ocorrências na janela atual. */
    blocked(key, max, windowMs) {
      const r = one('SELECT count, window_start FROM throttle WHERE key = ?', key);
      return !!r && now() - r.window_start < windowMs && r.count >= max;
    },
    /** Regista uma ocorrência (abre uma janela nova se a anterior expirou). */
    hit(key, windowMs) {
      const t = now();
      run(`INSERT INTO throttle (key, count, window_start) VALUES (?, 1, ?)
        ON CONFLICT(key) DO UPDATE SET
          count = CASE WHEN ? - throttle.window_start >= ? THEN 1 ELSE throttle.count + 1 END,
          window_start = CASE WHEN ? - throttle.window_start >= ? THEN ? ELSE throttle.window_start END`,
      key, t, t, windowMs, t, windowMs, t);
    },
    reset(key) { run('DELETE FROM throttle WHERE key = ?', key); },
    /** Limpeza periódica de janelas antigas. */
    prune(olderThanMs = 24 * 3600e3) { run('DELETE FROM throttle WHERE window_start < ?', now() - olderThanMs); },
  };

  const mfa = {
    create(tokenHash, userId, ttlMs) {
      run('DELETE FROM mfa_challenges WHERE expires_at < ?', now());
      run('INSERT INTO mfa_challenges (token_hash, user_id, expires_at, attempts) VALUES (?, ?, ?, 0)', tokenHash, userId, now() + ttlMs);
    },
    get(tokenHash) {
      const r = one('SELECT * FROM mfa_challenges WHERE token_hash = ?', tokenHash);
      if (r && r.expires_at < now()) { mfa.remove(tokenHash); return null; }
      return r || null;
    },
    /** Regista uma tentativa falhada; devolve o número de tentativas. */
    fail(tokenHash) {
      run('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = ?', tokenHash);
      return one('SELECT attempts FROM mfa_challenges WHERE token_hash = ?', tokenHash)?.attempts ?? 0;
    },
    remove(tokenHash) { run('DELETE FROM mfa_challenges WHERE token_hash = ?', tokenHash); },
  };

  const locks = {
    /** Tenta obter o lock `name` por `ttlMs`. Devolve true se ficou com ele (ou já o tinha). */
    acquire(name, ttlMs) {
      const t = now();
      run(`INSERT INTO job_locks (name, owner, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
        WHERE job_locks.expires_at < ? OR job_locks.owner = excluded.owner`, name, instance, t + ttlMs, t);
      return one('SELECT owner FROM job_locks WHERE name = ?', name)?.owner === instance;
    },
    release(name) { run('DELETE FROM job_locks WHERE name = ? AND owner = ?', name, instance); },
    /** Corre fn() com o lock; se outra instância o tiver, não corre e devolve { skipped: true }. */
    async withLock(name, ttlMs, fn) {
      if (!locks.acquire(name, ttlMs)) return { skipped: true };
      try { return await fn(); } finally { locks.release(name); }
    },
  };

  return { throttle, mfa, locks, instance };
}

module.exports = { createState, INSTANCE };
