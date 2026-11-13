'use strict';
/* Envio das cópias para fora do servidor: o comando recebe o caminho e o resultado é reportado. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { uploadBackup } = require('../src/offsite');

const node = JSON.stringify(process.execPath);

test('o comando recebe o caminho da cópia em BACKUP_FILE', async () => {
  const r = await uploadBackup(`${node} -e "process.stdout.write('enviado ' + process.env.BACKUP_FILE)"`, { file: '/dados/copia.db' });
  assert.equal(r.ok, true);
  assert.equal(r.output, 'enviado /dados/copia.db');
});

test('falha e tempo limite são reportados', async () => {
  const bad = await uploadBackup(`${node} -e "console.error('sem rede'); process.exit(3)"`, { file: 'x' });
  assert.deepEqual([bad.ok, bad.code, bad.output], [false, 3, 'sem rede']);
  const slow = await uploadBackup(`${node} -e "setTimeout(() => {}, 10000)"`, { file: 'x' }, { timeoutMs: 300 });
  assert.equal(slow.ok, false);
  assert.match(slow.output, /tempo limite/);
});
