'use strict';
/* Recuperação de password, convites e verificação de email (com um mailer que guarda as mensagens). */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const sent = [];
const mailer = { host: 'teste', from: 'rizoma@teste.pt', send: async (m) => { sent.push(m); } };
const tokenOf = (m) => /token=([A-Za-z0-9_-]+)/.exec(m.text)[1];
const lastTo = (to) => [...sent].reverse().find((m) => m.to === to);
let S;
let admin;

before(async () => {
  S = await startServer({ appOpts: { mailer, signup: true, publicUrl: 'https://app.rizoma.pt' } });
  admin = S.agent();
  await admin.login('admin', 'Admin-pass-123');
  await admin.put('/api/users/1', { email: 'admin@empresa.pt' });
});
after(() => S.close());

test('recuperação de password: resposta igual exista ou não a conta, ligação de uso único', async () => {
  const anon = S.agent();
  const unknown = await anon.post('/api/password/forgot', { login: 'ninguem@nada.pt' });
  const known = await anon.post('/api/password/forgot', { login: 'ADMIN@empresa.pt' });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.data, known.data, 'não revela se a conta existe');
  const mail = lastTo('admin@empresa.pt');
  assert.match(mail.subject, /redefinir a password/);
  assert.match(mail.text, /https:\/\/app\.rizoma\.pt\/#\/redefinir\?token=/);
  const token = tokenOf(mail);

  assert.equal((await anon.post('/api/password/reset', { token, password: 'curta' })).status, 400);
  const ok = await anon.post('/api/password/reset', { token, password: 'Recuperada-2026' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await admin.get('/api/me')).status, 401, 'as sessões abertas terminam');
  assert.equal((await anon.post('/api/password/reset', { token, password: 'Outra-vez-2026' })).status, 400, 'uso único');
  assert.equal((await S.agent().post('/api/login', { username: 'admin', password: 'Admin-pass-123' })).status, 401);
  admin = S.agent();
  await admin.login('admin', 'Recuperada-2026');

  // Expiração
  await anon.post('/api/password/forgot', { login: 'admin' });
  const t2 = tokenOf(lastTo('admin@empresa.pt'));
  S.db.prepare("UPDATE user_tokens SET expires_at = 0 WHERE purpose = 'reset' AND used_at IS NULL").run();
  assert.equal((await anon.post('/api/password/reset', { token: t2, password: 'Expirada-2026x' })).status, 400);
});

test('convite por email: o próprio define a password e entra', async () => {
  const c = (await admin.post('/api/clients', { name: 'Convites Lda', code: 'CNV' })).data.id;
  const inv = await admin.post('/api/users/invite', { email: 'Rui@Equipa.pt', name: 'Rui', role: 'tech', client_ids: [c] });
  assert.equal(inv.status, 200, JSON.stringify(inv.data));
  assert.equal(inv.data.email_sent, true);
  assert.equal(inv.data.invite_url, undefined, 'com email, a ligação não é devolvida');
  const mail = lastTo('rui@equipa.pt');
  assert.match(mail.subject, /convite para Organização principal/);
  const token = tokenOf(mail);

  assert.equal((await S.agent().post('/api/login', { username: 'rui@equipa.pt', password: 'x' })).status, 401, 'convite pendente não entra');
  const list = (await admin.get('/api/users')).data.find((u) => u.username === 'rui@equipa.pt');
  assert.equal(list.invite_pending, true);
  assert.deepEqual(list.client_ids, [c]);
  assert.equal((await admin.post('/api/users/invite', { email: 'rui@equipa.pt', name: 'Rui', role: 'tech' })).status, 409);

  const info = await S.agent().get(`/api/invites/check?token=${token}`);
  assert.deepEqual(info.data, { name: 'Rui', username: 'rui@equipa.pt', email: 'rui@equipa.pt', org_name: 'Organização principal' });
  const rui = S.agent();
  assert.equal((await rui.post('/api/invites/accept', { token, password: 'rui@equipa.pt' })).status, 400);
  const acc = await rui.post('/api/invites/accept', { token, password: 'Rui-equipa-2026' });
  assert.equal(acc.status, 200);
  assert.equal(acc.data.email_verified, true);
  assert.equal((await rui.get('/api/clients')).data.length, 1, 'sessão iniciada, com os clientes atribuídos');
  assert.equal((await S.agent().post('/api/invites/accept', { token, password: 'Outra-pass-2026' })).status, 400, 'uso único');
});

test('reenvio de convite e convite sem email configurado', async () => {
  const inv = await admin.post('/api/users/invite', { email: 'ana@equipa.pt', name: 'Ana', role: 'admin' });
  const first = tokenOf(lastTo('ana@equipa.pt'));
  const re = await admin.post(`/api/users/${inv.data.id}/invite/resend`);
  assert.equal(re.status, 200);
  const second = tokenOf(lastTo('ana@equipa.pt'));
  assert.notEqual(first, second);
  assert.equal((await S.agent().get(`/api/invites/check?token=${first}`)).status, 400, 'o convite anterior deixa de valer');

  const semEmail = await startServer();
  const a = semEmail.agent();
  await a.login('admin', 'Admin-pass-123');
  const r = await a.post('/api/users/invite', { email: 'x@y.pt', name: 'X', role: 'admin' });
  assert.equal(r.data.email_sent, false);
  assert.match(r.data.invite_url, /\/#\/convite\?token=/);
  await semEmail.close();
});

test('registo envia a verificação de email; a ligação confirma o endereço', async () => {
  const a = S.agent();
  const r = await a.post('/api/signup', { organization: 'Verifica Lda', name: 'Vera', username: 'vera', email: 'vera@verifica.pt', password: 'Verifica-2026' });
  assert.equal(r.status, 200);
  assert.equal(r.data.email_verified, false);
  assert.equal(r.data.email_verification_available, true);
  const mail = lastTo('vera@verifica.pt');
  assert.match(mail.subject, /confirme o seu email/);
  assert.equal((await a.post('/api/me/email/resend')).status, 200);
  const token = tokenOf(lastTo('vera@verifica.pt'));
  assert.equal((await S.agent().post('/api/email/verify', { token })).status, 200);
  assert.equal((await a.get('/api/me')).data.email_verified, true);
  assert.equal((await a.post('/api/me/email/resend')).data.already, true);
});
