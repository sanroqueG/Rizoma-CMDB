'use strict';
/*
 * Migrações do esquema, numeradas e aplicadas por ordem (ver runMigrations em db.js).
 * Regras:
 *  - nunca alterar uma migração já publicada: criar uma nova;
 *  - "rebuild: true" quando a migração reconstrói tabelas (corre com as chaves estrangeiras desligadas);
 *  - a migração 1 (esquema base) está em db.js.
 */

const MIGRATIONS = [
  {
    id: 2,
    name: 'organizações (SaaS)',
    rebuild: true,
    up(db, { addColumn }) {
      db.exec(`CREATE TABLE organizations (
        id          INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        slug        TEXT NOT NULL UNIQUE COLLATE NOCASE,
        status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
        plan        TEXT NOT NULL DEFAULT 'standard',
        max_clients INTEGER,
        max_cis     INTEGER,
        max_users   INTEGER,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      // Instalação anterior (um só prestador): tudo passa para a "Organização principal"
      const legacy = db.prepare('SELECT (SELECT COUNT(*) FROM clients) + (SELECT COUNT(*) FROM users) AS n').get().n > 0;
      if (legacy) db.prepare("INSERT INTO organizations (id, name, slug) VALUES (1, 'Organização principal', 'principal')").run();

      // clients: nome e código passam a ser únicos por organização (reconstrução da tabela)
      db.exec(`CREATE TABLE clients_new (
        id            INTEGER PRIMARY KEY,
        org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name          TEXT NOT NULL COLLATE NOCASE,
        code          TEXT NOT NULL COLLATE NOCASE,
        contact_name  TEXT,
        contact_email TEXT,
        notes         TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (org_id, name),
        UNIQUE (org_id, code)
      )`);
      db.exec(`INSERT INTO clients_new (id, org_id, name, code, contact_name, contact_email, notes, created_at)
        SELECT id, 1, name, code, contact_name, contact_email, notes, created_at FROM clients`);
      db.exec('DROP TABLE clients');
      db.exec('ALTER TABLE clients_new RENAME TO clients');
      db.exec('CREATE INDEX clients_org ON clients(org_id)');

      addColumn(db, 'users', 'org_id', 'INTEGER REFERENCES organizations(id) ON DELETE CASCADE');
      addColumn(db, 'users', 'is_platform', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'audit', 'org_id', 'INTEGER');
      if (legacy) {
        db.exec('UPDATE users SET org_id = 1');
        db.exec("UPDATE users SET is_platform = 1 WHERE id = (SELECT MIN(id) FROM users WHERE role = 'admin')");
        db.exec('UPDATE audit SET org_id = 1');
      }
      db.exec('CREATE INDEX users_org ON users(org_id)');
      db.exec('CREATE INDEX audit_org ON audit(org_id, id)');
    },
  },
  {
    id: 3,
    name: 'pesquisa de texto (FTS5)',
    up(db) {
      // Índice trigram: encontra qualquer parte do texto (como LIKE '%x%'), sem diferença de maiúsculas e acentos
      const cols = 'name, hostname, serial_number, ip_address, asset_tag, owner, model, os, notes, external_id';
      db.exec(`CREATE VIRTUAL TABLE cis_fts USING fts5(${cols}, content='cis', content_rowid='id',
        tokenize='trigram remove_diacritics 1')`);
      const vals = (p) => cols.split(', ').map((c) => `${p}.${c}`).join(', ');
      db.exec(`CREATE TRIGGER cis_fts_ai AFTER INSERT ON cis BEGIN
          INSERT INTO cis_fts(rowid, ${cols}) VALUES (new.id, ${vals('new')});
        END;
        CREATE TRIGGER cis_fts_ad AFTER DELETE ON cis BEGIN
          INSERT INTO cis_fts(cis_fts, rowid, ${cols}) VALUES ('delete', old.id, ${vals('old')});
        END;
        CREATE TRIGGER cis_fts_au AFTER UPDATE ON cis BEGIN
          INSERT INTO cis_fts(cis_fts, rowid, ${cols}) VALUES ('delete', old.id, ${vals('old')});
          INSERT INTO cis_fts(rowid, ${cols}) VALUES (new.id, ${vals('new')});
        END;`);
      db.exec("INSERT INTO cis_fts(cis_fts) VALUES ('rebuild')");
      // Índices para listagens paginadas por cursor
      db.exec('CREATE INDEX IF NOT EXISTS contracts_client_end ON contracts(client_id, end_date, id)');
      db.exec('CREATE INDEX IF NOT EXISTS cis_client_name ON cis(client_id, name, id)');
    },
  },
  {
    id: 4,
    name: 'estado partilhado entre instâncias',
    up(db) {
      db.exec(`CREATE TABLE throttle (
        key          TEXT PRIMARY KEY,
        count        INTEGER NOT NULL,
        window_start INTEGER NOT NULL
      );
      CREATE TABLE mfa_challenges (
        token_hash TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        attempts   INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE job_locks (
        name       TEXT PRIMARY KEY,
        owner      TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );`);
    },
  },
  {
    id: 5,
    name: 'permissões dos tokens de integração',
    up(db, { addColumn }) {
      // Permissões separadas: "ingest" (agentes de inventário) e "tickets" (helpdesk). Os tokens antigos ficam com as duas.
      addColumn(db, 'api_tokens', 'scopes', "TEXT NOT NULL DEFAULT 'ingest,tickets'");
    },
  },
];

module.exports = { MIGRATIONS };
