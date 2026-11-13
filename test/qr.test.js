'use strict';
/* Valida o gerador de QR do frontend contra valores de referência da norma ISO/IEC 18004. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = { window: {}, TextEncoder };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'qr.js'), 'utf8'), ctx);
const QR = ctx.window.QR;

// Bits de formato para o nível M, máscaras 0–7 (tabela da norma)
const FORMAT_M = ['101010000010010', '101000100100101', '101111001111100', '101101101001011',
  '100010111111001', '100000011001110', '100111110010111', '100101010100000'];

function readFormat(m) {
  const bits = [];
  // cópia junto ao canto superior esquerdo, do bit 14 (MSB) ao bit 0
  for (let x = 0; x <= 5; x++) bits.push(m[8][x]);
  bits.push(m[8][7], m[8][8], m[7][8]);
  for (let y = 5; y >= 0; y--) bits.push(m[y][8]);
  return bits.map((b) => (b ? '1' : '0')).join('');
}

test('Reed-Solomon: exemplo "HELLO WORLD" 1-M', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  const { rsDivisor, rsRemainder } = QR._internals;
  assert.deepEqual(Array.from(rsRemainder(data, rsDivisor(10))), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('bits de formato, padrões de posição e versão', () => {
  for (const text of ['otpauth://totp/CMDB:admin?secret=JBSWY3DPEHPK3PXP&issuer=CMDB', 'x', 'á'.repeat(60)]) {
    const r = QR.encode(text);
    assert.equal(r.size, r.version * 4 + 17);
    assert.equal(readFormat(r.modules), FORMAT_M[r.mask], `formato para máscara ${r.mask}`);
    // padrão de posição (finder) no canto superior esquerdo: linha 0 = 7 escuros + separador claro
    assert.deepEqual(Array.from(r.modules[0].slice(0, 8)), [true, true, true, true, true, true, true, false]);
    // módulo escuro fixo
    assert.equal(r.modules[r.size - 8][8], true);
  }
  // versão ≥ 7 inclui o bloco de informação de versão (v7 = 000111110010010100)
  const big = QR.encode('a'.repeat(120));
  assert.ok(big.version >= 7);
  if (big.version === 7) {
    const bits = [];
    for (let i = 17; i >= 0; i--) bits.push(big.modules[Math.floor(i / 3)][big.size - 11 + (i % 3)] ? '1' : '0');
    assert.equal(bits.join(''), '000111110010010100');
  }
});

test('capacidade: escolhe a menor versão possível', () => {
  assert.equal(QR.encode('a'.repeat(14)).version, 1); // 1-M: 14 bytes
  assert.equal(QR.encode('a'.repeat(15)).version, 2);
  assert.equal(QR.encode('a'.repeat(122)).version, 7); // 7-M: 122 bytes
});
