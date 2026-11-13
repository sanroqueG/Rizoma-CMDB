'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { passwordProblem } = require('../src/passwords');

let S;
before(async () => { S = await startServer({ adminPassword: '' }); }); // vazia → admin123 por omissão
after(() => S.close());

test('política de passwords', () => {
  assert.match(passwordProblem('curta1', 'ana'), /10 caracteres/);
  assert.match(passwordProblem('Password123', 'ana'), /comum/);
  assert.match(passwordProblem('P@ssw0rd!!', 'ana'), /comum/);
  assert.match(passwordProblem('aaaaaaaaaaaa', 'ana'), /repetido/);
  assert.match(passwordProblem('joana.silva-2026', 'joana.silva'), /nome de utilizador/);
  assert.match(passwordProblem('soletrasminusculas', 'ana'), /dois tipos/);
  assert.equal(passwordProblem('Cavalo-azul-42', 'ana'), null);
  assert.equal(passwordProblem('frase longa com 3 palavras', 'ana'), null);
});

test('o admin com a password por omissão tem de a mudar antes de usar a API', async () => {
  const a = S.agent();
  const me = await a.login('admin', 'admin123');
  assert.equal(me.password_change_required, true);
  assert.equal((await a.get('/api/me')).data.password_change_required, true);

  const blocked = await a.get('/api/clients');
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /Altere a sua password/);
  assert.equal((await a.get('/api/meta')).status, 200, 'metadados continuam acessíveis');

  // Regras aplicadas na mudança
  assert.equal((await a.post('/api/me/password', { current: 'admin123', password: 'curta' })).status, 400);
  assert.equal((await a.post('/api/me/password', { current: 'admin123', password: 'admin1234' })).status, 400);
  assert.equal((await a.post('/api/me/password', { current: 'errada', password: 'Nova-pass-2026' })).status, 400);
  assert.equal((await a.post('/api/me/password', { current: 'admin123', password: 'Nova-pass-2026' })).status, 200);

  assert.equal((await a.get('/api/me')).data.password_change_required, false);
  assert.equal((await a.get('/api/clients')).status, 200);
  assert.equal((await a.post('/api/me/password', { current: 'Nova-pass-2026', password: 'Nova-pass-2026' })).status, 400,
    'a nova password tem de ser diferente');
});

test('o administrador pode obrigar um utilizador a mudar a password; política aplicada na criação', async () => {
  const a = S.agent();
  await a.login('admin', 'Nova-pass-2026');
  assert.equal((await a.post('/api/users', { username: 'rui', name: 'Rui', role: 'tech', password: 'password123' })).status, 400);
  assert.equal((await a.post('/api/users', { username: 'rui.costa', name: 'Rui', role: 'tech', password: 'rui.costa-2026' })).status, 400);
  const u = await a.post('/api/users', { username: 'rui', name: 'Rui', role: 'tech', password: 'Inicial-2026', must_change_password: true });
  assert.equal(u.status, 200);
  assert.equal(u.data.must_change_password, true);

  const r = S.agent();
  assert.equal((await r.login('rui', 'Inicial-2026')).password_change_required, true);
  assert.equal((await r.get('/api/dashboard')).status, 403);
  assert.equal((await r.post('/api/me/password', { current: 'Inicial-2026', password: 'Pessoal-rui-99' })).status, 200);
  assert.equal((await r.get('/api/dashboard')).status, 200);

  // Repor a password de outro utilizador e voltar a obrigar a mudança
  assert.equal((await a.put(`/api/users/${u.data.id}`, { password: 'Reposta-2026!', must_change_password: true })).status, 200);
  const r2 = S.agent();
  assert.equal((await r2.login('rui', 'Reposta-2026!')).password_change_required, true);
});
