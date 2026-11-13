#!/usr/bin/env node
'use strict';
const http = require('node:http');
const path = require('node:path');
const { openDb, ensureAdmin } = require('./src/db');
const { createApp } = require('./src/app');
const { loadSecretKey, verifyPassword } = require('./src/auth');
const { DEFAULT_ADMIN_PASSWORD } = require('./src/passwords');
const { createBackups } = require('./src/backup');
const { createMailer, smtpConfigFromEnv } = require('./src/mailer');
const { createLogger, withRequestLog } = require('./src/log');

const env = process.env;
/** Número de uma variável de ambiente; vazia ou ausente → valor por omissão. */
const envNum = (name, def) => (env[name] === undefined || String(env[name]).trim() === '' ? def : Number(env[name]));
const log = createLogger(env);
const PORT = Number(env.PORT) || 3000;
const HOST = env.HOST || '127.0.0.1';
const DB_FILE = env.CMDB_DB || path.join(__dirname, 'data', 'cmdb.db');
const DATA_DIR = path.dirname(path.resolve(DB_FILE));

const db = openDb(DB_FILE);
const generated = ensureAdmin(db, env.CMDB_ADMIN_PASSWORD);
if (generated) {
  log.info(generated === DEFAULT_ADMIN_PASSWORD
    ? `Primeiro arranque: criado o utilizador "admin" com a password ${DEFAULT_ADMIN_PASSWORD} (é obrigatório mudá-la no primeiro login)`
    : 'Primeiro arranque: criado o utilizador "admin" com a password definida em CMDB_ADMIN_PASSWORD');
}
warnDefaultPassword();

/** Aviso bem visível se o admin ainda usa a password por omissão, sobretudo se o servidor está acessível pela rede. */
function warnDefaultPassword() {
  const admin = /** @type {{ password_hash: string } | undefined} */ (db.prepare("SELECT password_hash FROM users WHERE username = 'admin' AND active = 1").get());
  if (!admin || !verifyPassword(DEFAULT_ADMIN_PASSWORD, admin.password_hash)) return;
  const msg = `O utilizador "admin" ainda tem a password por omissão (${DEFAULT_ADMIN_PASSWORD}).`;
  if (['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
    log.warn(`${msg} Mude-a antes de expor o servidor na rede.`);
  } else {
    log.warn(`!!! ATENÇÃO: ${msg} O servidor está à escuta em ${HOST} e é acessível por outras máquinas. Mude-a já.`);
  }
}

// ---- cópias de segurança (CMDB_BACKUP_HOURS=0 desativa)
const BACKUP_HOURS = envNum('CMDB_BACKUP_HOURS', 24);
const backups = BACKUP_HOURS > 0 ? createBackups({
  db,
  dir: env.CMDB_BACKUP_DIR || path.join(DATA_DIR, 'backups'),
  keep: envNum('CMDB_BACKUP_KEEP', 14),
  keyFile: env.CMDB_SECRET_KEY ? null : path.join(DATA_DIR, 'secret.key'),
}) : null;

// ---- email (resumo semanal)
const smtp = smtpConfigFromEnv(env);
const mailer = createMailer(smtp);

const app = createApp(db, {
  secretKey: loadSecretKey(DB_FILE), dbFile: DB_FILE, backups, backupHours: backups ? BACKUP_HOURS : null, mailer, log,
});
const server = http.createServer(withRequestLog(app, log));
server.listen(PORT, HOST, () => {
  log.info(`Rizoma a correr em http://${HOST}:${PORT}`, { db: DB_FILE });
  if (env.CMDB_OIDC_ISSUER) log.info('SSO ativo', { issuer: env.CMDB_OIDC_ISSUER });
  log.info(backups ? `Cópias de segurança a cada ${BACKUP_HOURS} h` : 'Cópias de segurança desativadas',
    backups ? { dir: backups.dir, manter: backups.keep } : {});
  log.info(mailer ? 'Email configurado' : 'Email não configurado (sem resumo semanal)', mailer ? { smtp: `${smtp.host}:${smtp.port}` } : {});
});

// ---- tarefas periódicas (verificação de hora a hora)
const SYNC_HOURS = envNum('CMDB_SYNC_HOURS', 24) || 24;
async function runDueSyncs() {
  for (const id of app.dueConnectors(SYNC_HOURS)) {
    try {
      const r = await app.syncConnector(id, 'agendamento');
      log.info('Sincronização de conector', { conector: id, estado: r.status });
    } catch (e) {
      log.error('Sincronização de conector falhou', { conector: id, err: e });
    }
  }
}
async function runDueBackup() {
  if (!backups || backups.hoursSinceLast() < BACKUP_HOURS) return;
  try {
    const r = await app.runJob('backup', { dir: backups.dir, keep: backups.keep, keyFile: backups.keyFile });
    log.info('Cópia de segurança criada', { ficheiro: r.file, bytes: r.size, ms: r.ms, removidas: r.removed.length });
  } catch (e) {
    log.error('Cópia de segurança falhou', { err: e });
  }
}
async function runDueDigest() {
  try {
    const r = await app.runScheduledDigest();
    if (r) log.info('Resumo semanal enviado', { enviados: r.sent, vazios: r.empty, falhados: r.failed.length });
    for (const f of (r && r.failed) || []) log.warn('Resumo semanal não entregue', f);
  } catch (e) {
    log.error('Resumo semanal falhou', { err: e });
  }
}
function runAuditRetention() {
  try {
    const n = app.purgeAudit();
    if (n) log.info('Auditoria: eventos antigos removidos', { eventos: n });
  } catch (e) {
    log.error('Retenção da auditoria falhou', { err: e });
  }
}
/* Com várias instâncias, cada tarefa agendada corre numa só: o lock vive na BD (ver src/state.js).
   As sincronizações têm o seu próprio lock por conector. */
async function hourly() {
  const { locks } = app.state;
  await locks.withLock('scheduler:audit', 10 * 60e3, async () => runAuditRetention());
  await locks.withLock('scheduler:backup', 60 * 60e3, runDueBackup);
  await runDueSyncs();
  await locks.withLock('scheduler:digest', 30 * 60e3, runDueDigest);
  app.state.throttle.prune();
}
setInterval(hourly, 3600e3).unref();
setTimeout(hourly, 30e3).unref();

function shutdown() {
  log.info('A terminar…');
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
