'use strict';
const crypto = require('node:crypto');

const KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

/** Token aleatório (sessões e tokens de API). Só o hash é guardado na BD. */
function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Encriptação simétrica (AES-256-GCM) para segredos guardados na BD
 * (segredos de conectores cloud e segredos TOTP).
 */
function createSecretBox(keyMaterial) {
  const key = crypto.createHash('sha256').update(String(keyMaterial)).digest();
  return {
    seal(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
    },
    open(sealed) {
      const [v, iv, tag, ct] = String(sealed || '').split(':');
      if (v !== 'v1') throw new Error('Segredo em formato desconhecido');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
    },
  };
}

/** Chave mestra: CMDB_SECRET_KEY, ou ficheiro secret.key junto da BD (criado no 1.º arranque). */
function loadSecretKey(dbFile) {
  if (process.env.CMDB_SECRET_KEY) return process.env.CMDB_SECRET_KEY;
  if (!dbFile || dbFile === ':memory:') return crypto.randomBytes(32).toString('hex');
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(path.dirname(path.resolve(dbFile)), 'secret.key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

module.exports = { hashPassword, verifyPassword, newToken, sha256, createSecretBox, loadSecretKey };
