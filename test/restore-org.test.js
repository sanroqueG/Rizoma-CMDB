'use strict';
/* Reposição de uma organização a partir de uma cópia: só essa organização muda; simulação não altera nada. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, ensureAdmin } = require('../src/db');
const { startServer } = require('./helpers');
const { restoreOrg } = require('../src/restore-org');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rizoma-restore-test-'));
const dbFile = path.join(dir, 'cmdb.db');
const backupFile = path.join(dir, 'copia.db');
let S;
let A;
let B;
let slugB;
before(async () => {
  const db = openDb(dbFile);
  ensureAdmin(db, 'Admin-pass-123');
  S = await startServer({ db, appOpts: { signup: true } });
  A = S.agent();
  await A.login('admin', 'Admin-pass-123');
  B = S.agent();
  const r = await B.post('/api/signup', { organization: 'Distraída Lda', name: 'Dina', username: 'dina', email: 'dina@d.pt', password: 'Distraida-2026' });
  slugB = S.db.prepare('SELECT slug FROM organizations WHERE id = ?').get(r.data.org_id).slug;
});
after(async () => { await S.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const names = (sql, ...p) => S.db.prepare(sql).all(...p).map((r) => r.name).sort();

test('apagar dados por engano e repor só essa organização', async () => {
  const type = (await B.get('/api/meta')).data.types[0].id;
  const own = (await B.post('/api/types', { name: 'Câmara', category: 'Vídeo', fields: ['res'] })).data.id;
  const cB = (await B.post('/api/clients', { name: 'Cliente Importante', code: 'CI' })).data.id;
  const s1 = (await B.post('/api/cis', { client_id: cB, type_id: type, name: 'SRV-ERP' })).data.id;
  const s2 = (await B.post('/api/cis', { client_id: cB, type_id: own, name: 'CAM-1' })).data.id;
  assert.equal((await B.post('/api/relationships', { source_id: s1, target_id: s2, type: 'depende_de' })).status, 200);
  await B.post('/api/contracts', { client_id: cB, name: 'Suporte ERP', cost: 100, billing: 'mensal', ci_ids: [s1] });
  const cA = (await A.post('/api/clients', { name: 'Cliente da A', code: 'CA' })).data.id;
  await A.post('/api/cis', { client_id: cA, type_id: type, name: 'A-ANTES' });

  // Cópia de segurança
  S.db.exec(`VACUUM INTO '${backupFile.replace(/'/g, "''")}'`);

  // Depois da cópia: B apaga o cliente (com tudo) e cria outra coisa; A continua a trabalhar
  assert.equal((await B.del(`/api/clients/${cB}?confirm=CI`)).status, 200);
  await B.post('/api/clients', { name: 'Criado depois', code: 'CD' });
  await A.post('/api/cis', { client_id: cA, type_id: type, name: 'A-DEPOIS' });
  assert.deepEqual(names("SELECT name FROM cis WHERE name LIKE 'SRV%' OR name LIKE 'CAM%'"), []);

  // Simulação: mostra o que muda, não altera nada
  const sim = restoreOrg({ db: S.db, backupFile, org: slugB });
  assert.equal(sim.applied, false);
  const cis = sim.summary.find((x) => x.table === 'cis');
  assert.deepEqual([cis.atual, cis.copia], [0, 2]);
  assert.deepEqual(names('SELECT name FROM clients WHERE org_id = (SELECT id FROM organizations WHERE slug = ?)', slugB), ['Criado depois']);

  // Reposição
  const r = restoreOrg({ db: S.db, backupFile, org: slugB, apply: true, actor: 'operador' });
  assert.equal(r.applied, true);
  const orgB = S.db.prepare('SELECT id FROM organizations WHERE slug = ?').get(slugB).id;
  assert.deepEqual(names('SELECT name FROM clients WHERE org_id = ?', orgB), ['Cliente Importante']);
  assert.deepEqual(names(`SELECT c.name FROM cis c JOIN clients cl ON cl.id = c.client_id WHERE cl.org_id = ?`, orgB), ['CAM-1', 'SRV-ERP']);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM relationships WHERE source_id = ?').get(s1).n, 1);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM contract_cis WHERE ci_id = ?').get(s1).n, 1);
  assert.ok(S.db.prepare("SELECT 1 FROM ci_types WHERE name = 'Câmara' AND org_id = ?").get(orgB));
  // A organização A não foi tocada (mantém o trabalho feito depois da cópia)
  assert.deepEqual(names("SELECT name FROM cis WHERE name LIKE 'A-%'"), ['A-ANTES', 'A-DEPOIS']);
  // Pesquisa (FTS) acompanha os dados repostos; auditoria regista a reposição
  assert.deepEqual((await A.get('/api/cis?q=SRV-ERP')).data.items.length, 0, 'A não vê dados de B');
  B = S.agent();
  await B.login('dina', 'Distraida-2026');
  assert.deepEqual((await B.get('/api/cis?q=erp')).data.items.map((c) => c.name), ['SRV-ERP']);
  assert.ok((await B.get('/api/audit?limit=5')).data.some((e) => e.action === 'reposicao' && e.actor === 'operador'));
  assert.equal(S.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('erros: organização inexistente, cópia inexistente', () => {
  assert.throws(() => restoreOrg({ db: S.db, backupFile, org: 'nao-existe' }), /não encontrada na BD atual/);
  assert.throws(() => restoreOrg({ db: S.db, backupFile: path.join(dir, 'x.db'), org: slugB }), /Cópia não encontrada/);
});
