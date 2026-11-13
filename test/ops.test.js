'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const { startServer } = require('./helpers');
const { openDb } = require('../src/db');
const { createBackups } = require('../src/backup');
const { createMailer } = require('../src/mailer');
const { createLogger } = require('../src/log');

// ------------------------------------------------------------------ servidor SMTP falso
function fakeSmtp() {
  const mails = [];
  const srv = net.createServer((sock) => {
    let buf = '';
    let inData = false;
    let cur = null;
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          cur.data = buf.slice(0, end).replace(/^\.\./gm, '.');
          buf = buf.slice(end + 5);
          inData = false;
          mails.push(cur);
          sock.write('250 OK queued\r\n');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (/^EHLO/i.test(line)) sock.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        else if (/^AUTH PLAIN/i.test(line)) {
          const [, u, p] = Buffer.from(line.split(' ')[2], 'base64').toString().split('\0');
          sock.write(u === 'cmdb' && p === 'segredo' ? '235 OK\r\n' : '535 Falha de autenticação\r\n');
        } else if (/^MAIL FROM:/i.test(line)) { cur = { from: line.slice(10), to: [] }; sock.write('250 OK\r\n'); }
        else if (/^RCPT TO:/i.test(line)) { cur.to.push(line.slice(8).replace(/[<>]/g, '')); sock.write('250 OK\r\n'); }
        else if (/^DATA/i.test(line)) { inData = true; sock.write('354 Go\r\n'); }
        else if (/^QUIT/i.test(line)) { sock.end('221 Bye\r\n'); return; }
        else sock.write('502 ?\r\n');
      }
    });
  });
  return { srv, mails };
}
/** Extrai a parte de texto (base64) de uma mensagem MIME. */
function textPart(raw) {
  const m = /Content-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/.exec(raw);
  return m ? Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8') : '';
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdb-ops-'));
const smtp = fakeSmtp();
let S;
let mailer;

before(async () => {
  await new Promise((r) => smtp.srv.listen(0, '127.0.0.1', r));
  mailer = createMailer({ host: '127.0.0.1', port: smtp.srv.address().port, secure: false, user: 'cmdb', pass: 'segredo', from: 'CMDB <cmdb@empresa.pt>' });
  const db = openDb(':memory:');
  S = await startServer({
    db,
    appOpts: {
      backups: createBackups({ db, dir: path.join(tmp, 'backups'), keep: 3 }), backupHours: 24, mailer,
      publicUrl: 'https://cmdb.empresa.pt', digestWeekday: 1, digestHour: 8,
    },
  });
});
after(async () => {
  await S.close();
  smtp.srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('health check com estado da BD e versão', async () => {
  const r = await S.agent().get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.db, 'ok');
  assert.match(r.data.version, /^\d+\.\d+\.\d+/);
});

test('cópias de segurança: criar, verificar e reter', async () => {
  const a = S.agent();
  await a.login('admin', 'Admin-pass-123');
  await a.post('/api/clients', { name: 'Backup Lda', code: 'BKP' });
  for (let i = 0; i < 4; i++) assert.equal((await a.post('/api/system/backups')).status, 200);
  const sys = (await a.get('/api/system')).data;
  assert.equal(sys.backups.enabled, true);
  assert.equal(sys.backups.items.length, 3, 'retenção: mantém 3');
  const copy = new DatabaseSync(path.join(sys.backups.dir, sys.backups.items[0].file), { readOnly: true });
  assert.equal(copy.prepare("SELECT name FROM clients WHERE code = 'BKP'").get().name, 'Backup Lda');
  copy.close();

  const tech = S.agent();
  await a.post('/api/users', { username: 'semacesso', name: 'X', role: 'tech', password: 'Tecnico-2026' });
  await tech.login('semacesso', 'Tecnico-2026');
  assert.equal((await tech.post('/api/system/backups')).status, 403);
  assert.equal((await tech.get('/api/system')).status, 403);
});

test('a chave de encriptação é copiada com a BD', () => {
  const db = openDb(':memory:');
  const keyFile = path.join(tmp, 'secret.key');
  fs.writeFileSync(keyFile, 'abc123');
  const b = createBackups({ db, dir: path.join(tmp, 'bk-key'), keyFile });
  const r = b.run();
  assert.equal(fs.readFileSync(path.join(tmp, 'bk-key', r.file.replace('.db', '.key')), 'utf8'), 'abc123');
  assert.equal(b.list()[0].has_key, true);
  db.close();
});

test('envio de email por SMTP (autenticação, UTF-8, dot-stuffing)', async () => {
  smtp.mails.length = 0;
  await mailer.send({ to: 'ana@empresa.pt', subject: 'Olá — teste', text: 'linha 1\n.linha com ponto\nçãõ', html: '<p>x</p>' });
  assert.equal(smtp.mails.length, 1);
  assert.deepEqual(smtp.mails[0].to, ['ana@empresa.pt']);
  assert.match(smtp.mails[0].data, /Subject: =\?UTF-8\?B\?/);
  assert.equal(textPart(smtp.mails[0].data), 'linha 1\n.linha com ponto\nçãõ');

  const bad = createMailer({ host: '127.0.0.1', port: smtp.srv.address().port, user: 'cmdb', pass: 'errada', from: 'cmdb@empresa.pt' });
  await assert.rejects(bad.send({ to: 'ana@empresa.pt', subject: 'x', text: 'x' }), /535/);
  await assert.rejects(mailer.send({ to: 'ana@empresa.pt\r\nBcc: x@y.z', subject: 'x', text: 'x' }), /inválido/);
});

test('resumo semanal: conteúdo por âmbito de cliente, opção de desligar e agendamento', async () => {
  const a = S.agent();
  await a.login('admin', 'Admin-pass-123');
  await a.put('/api/users/1', { email: 'admin@empresa.pt' });
  const c1 = (await a.post('/api/clients', { name: 'Digest Um', code: 'DG1' })).data.id;
  const c2 = (await a.post('/api/clients', { name: 'Digest Dois', code: 'DG2' })).data.id;
  const type = (await a.get('/api/meta')).data.types.find((t) => t.name === 'Servidor').id;
  await a.post('/api/cis', { client_id: c1, type_id: type, name: 'SRV-GARANTIA', warranty_end: '2020-01-01' });
  await a.post('/api/cis', { client_id: c2, type_id: type, name: 'SRV-OUTRO', warranty_end: '2020-01-01' });
  const soon = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
  await a.post('/api/contracts', { client_id: c1, name: 'Suporte Fortinet', kind: 'suporte', vendor: 'Fortinet', end_date: soon });
  await a.post('/api/users', { username: 'tec.dg', name: 'Técnico DG', role: 'tech', email: 'tec@empresa.pt', password: 'Tecnico-dg-2026', client_ids: [c1] });

  smtp.mails.length = 0;
  const r = await a.post('/api/system/digest');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.sent, 2);
  const forTech = smtp.mails.find((m) => m.to.includes('tec@empresa.pt'));
  const body = textPart(forTech.data);
  assert.match(body, /SRV-GARANTIA/);
  assert.match(body, /Suporte Fortinet/);
  assert.doesNotMatch(body, /SRV-OUTRO/, 'o técnico só vê os seus clientes');
  assert.match(body, /https:\/\/cmdb\.empresa\.pt/);
  assert.match(textPart(smtp.mails.find((m) => m.to.includes('admin@empresa.pt')).data), /SRV-OUTRO/);

  // Desligar o resumo
  const t = S.agent();
  await t.login('tec.dg', 'Tecnico-dg-2026');
  assert.match((await t.get('/api/me/digest')).data.preview, /SRV-GARANTIA/);
  await t.put('/api/me/notifications', { digest: false });
  smtp.mails.length = 0;
  assert.equal((await a.post('/api/system/digest')).data.sent, 1);

  // Agendamento: segunda-feira às 9h, só uma vez por dia
  S.db.prepare("DELETE FROM settings WHERE key = 'last_digest_at'").run();
  const monday = new Date(2026, 10, 16, 9, 0);
  assert.equal(await S.app.runScheduledDigest(new Date(2026, 10, 17, 9, 0)), null, 'terça: não envia');
  assert.equal(await S.app.runScheduledDigest(new Date(2026, 10, 16, 7, 0)), null, 'antes das 8h: não envia');
  S.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_digest_at', ?)").run(new Date(2026, 10, 9, 9).toISOString());
  assert.equal((await S.app.runScheduledDigest(monday)).sent, 1);
  S.db.prepare("UPDATE settings SET value = ? WHERE key = 'last_digest_at'").run(monday.toISOString());
  assert.equal(await S.app.runScheduledDigest(new Date(2026, 10, 16, 15, 0)), null, 'já enviado hoje');
});

test('logs em JSON', () => {
  const lines = [];
  const sink = { write: (s) => lines.push(s) };
  const log = createLogger({ CMDB_LOG_FORMAT: 'json' }, sink, sink);
  log.info('olá', { a: 1 });
  log.debug('escondido');
  log.error('falhou', { err: new Error('x') });
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.msg, 'olá');
  assert.equal(first.a, 1);
  assert.equal(JSON.parse(lines[1]).err.message, 'x');
});
