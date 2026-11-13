'use strict';
/* Duas instâncias da aplicação sobre o mesmo ficheiro de BD (como atrás de um balanceador). */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers');
const { openDb } = require('../src/db');
const totp = require('../src/totp');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rizoma-multi-'));
const dbFile = path.join(dir, 'rizoma.db');
const secretKey = 'chave-partilhada-entre-instancias';
let I1;
let I2;

before(async () => {
  I1 = await startServer({ db: openDb(dbFile), appOpts: { dbFile, secretKey } });
  I2 = await startServer({ db: openDb(dbFile), adminPassword: null, appOpts: { dbFile, secretKey } });
});
after(async () => { await I1.close(); await I2.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

test('as tentativas de login falhadas contam nas duas instâncias', async () => {
  for (let i = 0; i < 10; i++) {
    const inst = i % 2 ? I2 : I1;
    assert.equal((await inst.agent().post('/api/login', { username: 'admin', password: 'errada' })).status, 401);
  }
  assert.equal((await I1.agent().post('/api/login', { username: 'admin', password: 'Admin-pass-123' })).status, 429);
  assert.equal((await I2.agent().post('/api/login', { username: 'admin', password: 'Admin-pass-123' })).status, 429);
  I1.db.prepare('DELETE FROM throttle').run();
});

test('o 2.º fator pedido numa instância é concluído na outra', async () => {
  const a = I1.agent();
  await a.login('admin', 'Admin-pass-123');
  const { secret } = (await a.post('/api/me/2fa/setup')).data;
  const key = totp.base32Decode(secret);
  const ctr = totp.counterAt();
  assert.equal((await a.post('/api/me/2fa/enable', { code: totp.hotp(key, ctr) })).status, 200);
  const step1 = (await I1.agent().post('/api/login', { username: 'admin', password: 'Admin-pass-123' })).data;
  assert.equal(step1.mfa_required, true);
  const b = I2.agent();
  // o código seguinte (o anterior já foi usado; a proteção anti-replay também é partilhada)
  assert.equal((await b.post('/api/login/mfa', { mfa_token: step1.mfa_token, code: totp.hotp(key, ctr) })).status, 401);
  const step2 = await b.post('/api/login/mfa', { mfa_token: step1.mfa_token, code: totp.hotp(key, ctr + 1) });
  assert.equal(step2.status, 200, JSON.stringify(step2.data));
  assert.equal((await b.get('/api/me')).status, 200);
});

test('um lock só pode estar numa instância de cada vez e expira', async () => {
  const s1 = I1.app.state;
  const s2 = I2.app.state;
  assert.equal(s1.locks.acquire('scheduler:teste', 60e3), true);
  assert.equal(s2.locks.acquire('scheduler:teste', 60e3), false);
  const r = await s2.locks.withLock('scheduler:teste', 60e3, () => 'correu');
  assert.deepEqual(r, { skipped: true });
  s1.locks.release('scheduler:teste');
  assert.equal(await s2.locks.withLock('scheduler:teste', 60e3, () => 'correu'), 'correu');
  assert.equal(s1.locks.acquire('scheduler:curto', 1), true);
  await new Promise((r2) => setTimeout(r2, 5));
  assert.equal(s2.locks.acquire('scheduler:curto', 60e3), true, 'lock expirado pode ser tomado');
});
