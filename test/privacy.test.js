'use strict';
/* RGPD: eliminação da organização a pedido (prazo para desistir, só leitura, eliminação total) e aceitação dos termos. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let S;
let B;
let orgId;
before(async () => {
  S = await startServer({ appOpts: { signup: true, termsUrl: 'https://rizoma.pt/termos', privacyUrl: 'https://rizoma.pt/privacidade', termsVersion: '2026-11' } });
});
after(() => S.close());

test('com termos configurados, o registo exige a aceitação e guarda a versão', async () => {
  const cfg = (await S.agent().get('/api/auth/config')).data;
  assert.equal(cfg.terms_url, 'https://rizoma.pt/termos');
  assert.equal(cfg.privacy_url, 'https://rizoma.pt/privacidade');
  const data = { organization: 'Vai Sair Lda', name: 'Vasco', username: 'vasco', email: 'vasco@vaisair.pt', password: 'Vai-sair-2026' };
  B = S.agent();
  const no = await B.post('/api/signup', data);
  assert.equal(no.status, 400);
  assert.match(no.data.error, /aceite os Termos/);
  const ok = await B.post('/api/signup', { ...data, accept_terms: true });
  assert.equal(ok.status, 200);
  orgId = ok.data.org_id;
  const u = S.db.prepare("SELECT terms_accepted_at, terms_version FROM users WHERE username = 'vasco'").get();
  assert.ok(u.terms_accepted_at);
  assert.equal(u.terms_version, '2026-11');
});

test('pedido de eliminação: confirmação, só leitura, exportação possível, desistência', async () => {
  const c = (await B.post('/api/clients', { name: 'Cliente X', code: 'CX' })).data.id;
  await B.post('/api/cis', { client_id: c, type_id: (await B.get('/api/meta')).data.types[0].id, name: 'SRV-1' });

  assert.equal((await B.post('/api/org/deletion', { confirm: 'outra-coisa' })).status, 400);
  const slug = S.db.prepare('SELECT slug FROM organizations WHERE id = ?').get(orgId).slug;
  const r = await B.post('/api/org/deletion', { confirm: slug.toUpperCase() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const days = (new Date(r.data.delete_at) - Date.now()) / 864e5;
  assert.ok(days > 29.9 && days <= 30);

  const w = await B.post('/api/clients', { name: 'Y', code: 'YY' });
  assert.equal(w.status, 409);
  assert.match(w.data.error, /vai ser eliminada/);
  assert.equal((await B.get('/api/org/export')).status, 200, 'pode exportar os dados');
  assert.equal((await B.get('/api/org/deletion')).data.requested, true);

  assert.equal((await B.del('/api/org/deletion')).status, 200);
  assert.equal((await B.post('/api/clients', { name: 'Y', code: 'YY' })).status, 200, 'depois de desistir volta a escrever');
  const log = (await B.get('/api/audit?limit=20')).data.map((e) => e.action);
  assert.ok(log.includes('eliminacao_pedida') && log.includes('eliminacao_cancelada'));

  // A organização da plataforma não se elimina por aqui
  const A = S.agent();
  await A.login('admin', 'Admin-pass-123');
  assert.equal((await A.post('/api/org/deletion', { confirm: 'x' })).status, 400);
});

test('passado o prazo, a organização e todos os dados são apagados; as outras ficam intactas', async () => {
  const slug = S.db.prepare('SELECT slug FROM organizations WHERE id = ?').get(orgId).slug;
  await B.post('/api/org/deletion', { confirm: slug });
  const count = (sql) => S.db.prepare(sql).get(orgId).n;
  assert.ok(count('SELECT COUNT(*) n FROM cis c JOIN clients cl ON cl.id = c.client_id WHERE cl.org_id = ?') > 0);
  const before = S.db.prepare('SELECT COUNT(*) n FROM users WHERE org_id <> ?').get(orgId).n;

  assert.equal(S.app.purgeDeletedOrgs(new Date(Date.now() + 29 * 864e5)), 0, 'ainda no prazo');
  assert.equal(S.app.purgeDeletedOrgs(new Date(Date.now() + 31 * 864e5)), 1);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM organizations WHERE id = ?').get(orgId).n, 0);
  for (const t of ['users', 'clients']) assert.equal(count(`SELECT COUNT(*) n FROM ${t} WHERE org_id = ?`), 0, t);
  assert.equal(S.db.prepare("SELECT COUNT(*) n FROM cis WHERE name = 'SRV-1'").get().n, 0);
  assert.equal(S.db.prepare('SELECT COUNT(*) n FROM users WHERE org_id <> ?').get(orgId).n, before, 'as outras organizações ficam');
  assert.equal((await B.get('/api/me')).status, 401, 'sessões terminadas');
  assert.ok(S.db.prepare("SELECT 1 FROM audit WHERE action = 'eliminada' AND org_id = 1").get(), 'registo na auditoria da plataforma');
});
