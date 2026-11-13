'use strict';
/* TOTP (RFC 6238) compatível com Microsoft/Google Authenticator, Authy, 1Password, etc. */
const crypto = require('node:crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

function base32Encode(buf) {
  let bits = 0;
  let val = 0;
  let out = '';
  for (const b of buf) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const s = String(str).replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let val = 0;
  const out = [];
  for (const ch of s) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Segredo base32 inválido');
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = (((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6;
  return String(code).padStart(6, '0');
}

const counterAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP);

/** Devolve o contador aceite (para impedir reutilização) ou null. Tolerância de ±1 passo (30 s). */
function verifyTotp(secretB32, code, lastCounter, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secretB32);
  const base = counterAt(now);
  for (const d of [0, -1, 1]) {
    const ctr = base + d;
    if (lastCounter !== null && lastCounter !== undefined && ctr <= lastCounter) continue;
    if (crypto.timingSafeEqual(Buffer.from(hotp(key, ctr)), Buffer.from(c))) return ctr;
  }
  return null;
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

function otpauthUri(secret, account, issuer) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;
}

/** Códigos de recuperação no formato xxxxx-xxxxx (hex). */
function generateRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const h = crypto.randomBytes(5).toString('hex');
    return `${h.slice(0, 5)}-${h.slice(5)}`;
  });
}
const normalizeRecoveryCode = (c) => String(c || '').toLowerCase().replace(/[^0-9a-f]/g, '');

module.exports = { base32Encode, base32Decode, hotp, verifyTotp, generateSecret, otpauthUri, generateRecoveryCodes, normalizeRecoveryCode, counterAt };
