'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { hashPassword } = require('./auth');
const { DEFAULT_ADMIN_PASSWORD } = require('./passwords');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  code          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  contact_name  TEXT,
  contact_email TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sites (
  id        INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  address   TEXT,
  UNIQUE (client_id, name)
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','tech','client')),
  client_id     INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Clientes a que cada técnico tem acesso
CREATE TABLE IF NOT EXISTS user_clients (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, client_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ci_types (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  category TEXT NOT NULL,
  fields   TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS cis (
  id            INTEGER PRIMARY KEY,
  client_id     INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  site_id       INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  type_id       INTEGER NOT NULL REFERENCES ci_types(id),
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'em_producao',
  environment   TEXT,
  criticality   TEXT NOT NULL DEFAULT 'media',
  hostname      TEXT,
  ip_address    TEXT,
  serial_number TEXT,
  asset_tag     TEXT,
  manufacturer  TEXT,
  model         TEXT,
  os            TEXT,
  owner         TEXT,
  purchase_date TEXT,
  warranty_end  TEXT,
  attributes    TEXT NOT NULL DEFAULT '{}',
  notes         TEXT,
  source        TEXT NOT NULL DEFAULT 'manual',
  external_id   TEXT,
  last_seen     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS cis_client ON cis(client_id);
CREATE INDEX IF NOT EXISTS cis_type   ON cis(type_id);
CREATE INDEX IF NOT EXISTS cis_serial ON cis(client_id, serial_number);
CREATE INDEX IF NOT EXISTS cis_host   ON cis(client_id, hostname);
CREATE UNIQUE INDEX IF NOT EXISTS cis_external ON cis(client_id, external_id) WHERE external_id IS NOT NULL;

-- Relação dirigida: "source <type> target"  (ex.: App corre_em Servidor).
-- Semântica comum: a origem depende do destino.
CREATE TABLE IF NOT EXISTS relationships (
  id         INTEGER PRIMARY KEY,
  source_id  INTEGER NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
  target_id  INTEGER NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_id, target_id, type),
  CHECK (source_id <> target_id)
);
CREATE INDEX IF NOT EXISTS rel_target ON relationships(target_id);

-- Tokens para o agente de inventário (um ou mais por cliente)
CREATE TABLE IF NOT EXISTS api_tokens (
  id         INTEGER PRIMARY KEY,
  client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used  TEXT
);

-- Registo de auditoria (sem FKs: o histórico sobrevive a eliminações)
CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY,
  entity     TEXT NOT NULL,
  entity_id  INTEGER,
  client_id  INTEGER,
  label      TEXT,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  changes    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS audit_entity ON audit(entity, entity_id);
CREATE INDEX IF NOT EXISTS audit_client ON audit(client_id);
`;

/** @type {Array<[string, string, string[]]>} */
const DEFAULT_TYPES = [
  ['Servidor', 'Hardware', ['cpu', 'ram_gb', 'disco_gb']],
  ['Posto de trabalho', 'Hardware', ['cpu', 'ram_gb', 'disco_gb']],
  ['Portátil', 'Hardware', ['cpu', 'ram_gb', 'disco_gb']],
  ['Telemóvel', 'Hardware', ['imei', 'numero']],
  ['Impressora', 'Periférico', []],
  ['Equipamento de rede', 'Rede', ['firmware', 'portas']],
  ['Firewall', 'Rede', ['firmware']],
  ['Máquina virtual', 'Virtual', ['vcpu', 'ram_gb', 'hypervisor']],
  ['Aplicação', 'Software', ['versao', 'url']],
  ['Base de dados', 'Software', ['motor', 'versao']],
  ['Serviço de negócio', 'Serviço', ['sla']],
  ['Licença', 'Contrato', ['fornecedor', 'quantidade']],
  ['Recurso cloud', 'Cloud', ['fornecedor', 'regiao', 'subscricao']],
];

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  runMigrations(db);
  const insertType = db.prepare('INSERT OR IGNORE INTO ci_types (name, category, fields) VALUES (?, ?, ?)');
  for (const [name, category, fields] of DEFAULT_TYPES) insertType.run(name, category, JSON.stringify(fields));
  return db;
}

function addColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Migração 1 — esquema base (até à versão 0.2). Idempotente: aplica-se tanto a BDs novas como a BDs
 * criadas por versões anteriores, que ainda não tinham a tabela schema_migrations.
 */
function baseline(db) {
  db.exec(SCHEMA);
  // SSO + 2FA
  addColumn(db, 'users', 'email', 'TEXT');
  addColumn(db, 'users', 'totp_secret', 'TEXT');
  addColumn(db, 'users', 'totp_pending', 'TEXT');
  addColumn(db, 'users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'users', 'totp_last', 'INTEGER');
  addColumn(db, 'users', 'recovery_codes', 'TEXT');
  addColumn(db, 'sessions', 'method', "TEXT NOT NULL DEFAULT 'password'");
  addColumn(db, 'users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'users', 'notify_digest', 'INTEGER NOT NULL DEFAULT 1');
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
  // Contratos: licenças de software, suporte, manutenção, subscrições… (por cliente, ligáveis a ativos)
  db.exec(`CREATE TABLE IF NOT EXISTS contracts (
    id           INTEGER PRIMARY KEY,
    client_id    INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'licenca',
    vendor       TEXT,
    reference    TEXT,
    status       TEXT NOT NULL DEFAULT 'ativo',
    start_date   TEXT,
    end_date     TEXT,
    auto_renew   INTEGER NOT NULL DEFAULT 0,
    notice_days  INTEGER,
    cost         REAL,
    billing      TEXT,
    quantity     INTEGER,
    owner        TEXT,
    notes        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS contracts_client ON contracts(client_id);
  CREATE INDEX IF NOT EXISTS contracts_end ON contracts(end_date);
  CREATE TABLE IF NOT EXISTS contract_cis (
    contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    ci_id       INTEGER NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
    PRIMARY KEY (contract_id, ci_id)
  );
  CREATE INDEX IF NOT EXISTS contract_cis_ci ON contract_cis(ci_id);`);
  // Tickets/incidentes de ferramentas externas (GLPI, Freshservice, Jira…) ligados a ativos
  db.exec(`CREATE TABLE IF NOT EXISTS tickets (
    id          INTEGER PRIMARY KEY,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    system      TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title       TEXT,
    status      TEXT,
    priority    TEXT,
    url         TEXT,
    closed      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (client_id, system, external_id)
  );
  CREATE TABLE IF NOT EXISTS ticket_cis (
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    ci_id     INTEGER NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
    PRIMARY KEY (ticket_id, ci_id)
  );
  CREATE INDEX IF NOT EXISTS ticket_cis_ci ON ticket_cis(ci_id);`);
  // Conectores cloud (um por cliente)
  db.exec(`CREATE TABLE IF NOT EXISTS cloud_connectors (
    id           INTEGER PRIMARY KEY,
    client_id    INTEGER NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
    provider     TEXT NOT NULL DEFAULT 'microsoft',
    tenant_id    TEXT NOT NULL,
    app_id       TEXT NOT NULL,
    secret_enc   TEXT NOT NULL,
    options      TEXT NOT NULL DEFAULT '{}',
    enabled      INTEGER NOT NULL DEFAULT 1,
    last_sync    TEXT,
    last_status  TEXT,
    last_report  TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}


const { MIGRATIONS } = require('./migrations');

/**
 * Aplica, por ordem, as migrações ainda não registadas em schema_migrations. Cada uma corre numa transação;
 * as que reconstroem tabelas (rebuild: true) correm com as chaves estrangeiras desligadas e são verificadas
 * com PRAGMA foreign_key_check antes do COMMIT.
 */
function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const done = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  const all = [{ id: 1, name: 'esquema base', up: baseline }, ...MIGRATIONS];
  for (const m of all) {
    if (done.has(m.id)) continue;
    if (m.rebuild) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      m.up(db, { addColumn });
      if (m.rebuild) {
        const bad = db.prepare('PRAGMA foreign_key_check').all();
        if (bad.length) throw new Error(`Migração ${m.id}: ${bad.length} referência(s) inválida(s) em ${bad[0].table}`);
      }
      db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(m.id, m.name);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Falha na migração ${m.id} (${m.name}): ${e.message}`);
    } finally {
      if (m.rebuild) db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

/** Versão do esquema (última migração aplicada). */
function schemaVersion(db) {
  return db.prepare('SELECT MAX(id) AS v FROM schema_migrations').get().v;
}

/**
 * Cria o utilizador admin se ainda não existir nenhum utilizador. Devolve a password usada (ou null).
 * Com a password por omissão, o admin é obrigado a mudá-la no primeiro login.
 */
function ensureAdmin(db, password) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return null;
  const pw = password || DEFAULT_ADMIN_PASSWORD;
  let org = db.prepare('SELECT id FROM organizations ORDER BY id LIMIT 1').get();
  if (!org) {
    const r = db.prepare("INSERT INTO organizations (name, slug) VALUES ('Organização principal', 'principal')").run();
    org = { id: Number(r.lastInsertRowid) };
  }
  // O primeiro administrador gere a sua organização e também a plataforma (organizações, cópias de segurança)
  db.prepare(`INSERT INTO users (username, name, password_hash, role, must_change_password, org_id, is_platform)
    VALUES ('admin', 'Administrador', ?, 'admin', ?, ?, 1)`).run(hashPassword(pw), pw === DEFAULT_ADMIN_PASSWORD ? 1 : 0, org.id);
  return pw;
}

module.exports = { openDb, ensureAdmin, schemaVersion };
