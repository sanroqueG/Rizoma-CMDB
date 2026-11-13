'use strict';
/* Pesquisa sem índice FTS5 (SQLite sem o módulo, ex.: Node 22 em Linux) e criação do índice quando passa a existir. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { search } = require('../src/store');
const { ensureFts, ftsAvailable } = require('../src/migrations');

let S;
let a;
let client;
before(async () => {
  S = await startServer();
  a = S.agent();
  await a.login('admin', 'Admin-pass-123');
  client = (await a.post('/api/clients', { name: 'Pesquisa Lda', code: 'PSQ' })).data.id;
  const type = (await a.get('/api/meta')).data.types[0].id;
  await a.post('/api/cis', { client_id: client, type_id: type, name: 'Servidor de Faturação', hostname: 'SRV-FAT-01', notes: 'Sala técnica, piso 2' });
  await a.post('/api/cis', { client_id: client, type_id: type, name: 'Impressora 50%_off' });
});
after(() => S.close());

const names = async (q) => (await a.get(`/api/cis?q=${encodeURIComponent(q)}`)).data.items.map((c) => c.name).sort();

test('sem FTS5: LIKE sem diferença de maiúsculas nem acentos, com os mesmos resultados', async () => {
  const fts = search.fts;
  search.fts = false;
  try {
    assert.equal(search.fold, true, 'função rz_fold registada');
    assert.deepEqual(await names('faturacao'), ['Servidor de Faturação']);
    assert.deepEqual(await names('FATURAÇÃO'), ['Servidor de Faturação']);
    assert.deepEqual(await names('srv-fat'), ['Servidor de Faturação']);
    assert.deepEqual(await names('tecnica piso'), ['Servidor de Faturação'], 'vários termos');
    assert.deepEqual(await names('50%'), ['Impressora 50%_off'], '% é literal');
    assert.deepEqual(await names('_off'), ['Impressora 50%_off'], '_ é literal');
    assert.deepEqual(await names('inexistente'), []);
    assert.equal((await a.get('/api/search?q=faturacao')).data.cis.length, 1, 'pesquisa global também');
  } finally {
    search.fts = fts;
  }
});

test('o índice FTS5 é criado no arranque quando o SQLite o suporta (idempotente)', () => {
  if (!ftsAvailable(S.db)) return; // este Node não tem FTS5: nada a verificar
  S.db.exec('DROP TRIGGER cis_fts_ai; DROP TRIGGER cis_fts_ad; DROP TRIGGER cis_fts_au; DROP TABLE cis_fts;');
  assert.equal(ensureFts(S.db), true);
  assert.equal(ensureFts(S.db), true, 'segunda vez não faz nada');
  const n = S.db.prepare("SELECT COUNT(*) AS n FROM cis_fts WHERE cis_fts MATCH '\"faturacao\"'").get().n;
  assert.equal(n, 1, 'reconstruído com os ativos existentes');
});
