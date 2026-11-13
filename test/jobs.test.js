'use strict';
/* Tarefas em worker threads (BD em ficheiro): Excel, importação, cópia de segurança, erros e não-bloqueio. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers');
const { openDb } = require('../src/db');
const { createBackups } = require('../src/backup');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rizoma-jobs-'));
const dbFile = path.join(dir, 'rizoma.db');
let S;
let a;
let client;

before(async () => {
  const db = openDb(dbFile);
  S = await startServer({ db, appOpts: { dbFile, backups: createBackups({ db, dir: path.join(dir, 'backups'), keep: 2 }) } });
  assert.equal(S.app.jobsMode, 'worker');
  a = S.agent();
  await a.login('admin', 'Admin-pass-123');
  client = (await a.post('/api/clients', { name: 'Worker Lda', code: 'WRK' })).data.id;
});
after(async () => { await S.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

test('importação numa worker thread, com erros de validação devolvidos com o código certo', async () => {
  assert.equal((await a.post('/api/import', { client_id: client, rows: [] })).status, 400);
  const rows = Array.from({ length: 50 }, (_, i) => ({ Nome: `PC-${i}`, Tipo: 'Portátil', 'Nº de série': `SN-${i}`, Local: 'Sede' }));
  const sim = await a.post('/api/import', { client_id: client, rows, dry_run: true });
  assert.equal(sim.status, 200, JSON.stringify(sim.data));
  assert.equal(sim.data.summary.created, 50);
  assert.equal((await a.get(`/api/cis?client=${client}`)).data.total, 0, 'a simulação não grava');
  const real = await a.post('/api/import', { client_id: client, rows, dry_run: false });
  assert.equal(real.data.summary.created, 50);
  assert.equal((await a.get(`/api/cis?client=${client}`)).data.total, 50, 'a thread principal vê o que a worker gravou');
  assert.ok((await a.get('/api/audit?entity=ci')).data.some((e) => e.actor === 'admin' && e.org_id), 'auditoria com organização');
});

test('relatório Excel gerado numa worker thread', async () => {
  const x = await a.get(`/api/clients/${client}/report.xlsx`);
  assert.equal(x.status, 200);
  assert.equal(x.data.subarray(0, 2).toString(), 'PK', 'ficheiro ZIP/XLSX válido');
  assert.ok(x.data.length > 2000);
});

test('cópia de segurança numa worker thread', async () => {
  const r = await a.post('/api/system/backups');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.file, /^cmdb-.*\.db$/);
  assert.ok(fs.existsSync(path.join(dir, 'backups', r.data.file)));
});

test('uma importação grande não bloqueia os outros pedidos', async () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ Nome: `GRANDE-${i}`, Tipo: 'Posto de trabalho', 'Nº de série': `BIG-${i}`, Notas: 'x'.repeat(200) }));
  const t0 = Date.now();
  const big = a.post('/api/import', { client_id: client, rows, dry_run: true });
  await new Promise((r) => setTimeout(r, 30));
  const pings = [];
  for (let i = 0; i < 5; i++) {
    const s = Date.now();
    assert.equal((await S.agent().get('/api/health')).status, 200);
    pings.push(Date.now() - s);
  }
  const res = await big;
  const total = Date.now() - t0;
  assert.equal(res.status, 200);
  assert.equal(res.data.summary.created, 5000);
  // Os pedidos durante a importação respondem bem antes de ela terminar
  assert.ok(Math.max(...pings) < total, `health ${Math.max(...pings)} ms vs importação ${total} ms`);
});
