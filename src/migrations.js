'use strict';
/*
 * Migrações do esquema, numeradas e aplicadas por ordem (ver runMigrations em db.js).
 * Regras:
 *  - nunca alterar uma migração já publicada: criar uma nova;
 *  - "rebuild: true" quando a migração reconstrói tabelas (corre com as chaves estrangeiras desligadas);
 *  - a migração 1 (esquema base) está em db.js.
 */

/** O SQLite deste Node tem o módulo FTS5? (o do Node 22 em Linux, por exemplo, não tem) */
function ftsAvailable(db) {
  try {
    db.exec("CREATE VIRTUAL TABLE temp.rz_fts_probe USING fts5(x, tokenize='trigram remove_diacritics 1'); DROP TABLE temp.rz_fts_probe;");
    return true;
  } catch {
    return false;
  }
}

/**
 * Índice trigram dos ativos: encontra qualquer parte do texto (como LIKE '%x%'), sem diferença de maiúsculas e acentos.
 * Idempotente: corre em cada arranque e cria o índice quando o FTS5 passa a estar disponível (ex.: Node atualizado).
 * Devolve true se o índice existe no fim.
 */
function ensureFts(db) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'cis_fts'").get()) return true;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cis'").get()) return false;
  if (!ftsAvailable(db)) return false;
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
  return true;
}

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
      // O índice FTS5 só é criado se o SQLite do Node o suportar (ver ensureFts); sem ele, a pesquisa usa LIKE
      ensureFts(db);
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
  {
    id: 6,
    name: 'recuperação de password, convites e verificação de email',
    up(db, { addColumn }) {
      // Tokens de uso único enviados por email: guarda-se só o hash
      db.exec(`CREATE TABLE user_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose    TEXT NOT NULL CHECK (purpose IN ('reset', 'invite', 'verify')),
        expires_at INTEGER NOT NULL,
        used_at    INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX user_tokens_user ON user_tokens(user_id, purpose);`);
      addColumn(db, 'users', 'email_verified_at', 'TEXT');
      addColumn(db, 'users', 'invite_pending', 'INTEGER NOT NULL DEFAULT 0');
      // Contas que já existiam são consideradas verificadas
      db.exec("UPDATE users SET email_verified_at = datetime('now') WHERE email IS NOT NULL");
    },
  },
  {
    id: 7,
    name: 'SSO por organização',
    up(db) {
      db.exec(`CREATE TABLE org_sso (
        org_id         INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        enabled        INTEGER NOT NULL DEFAULT 1,
        label          TEXT,
        issuer         TEXT NOT NULL,
        client_id      TEXT NOT NULL,
        client_secret  TEXT,
        auto_provision INTEGER NOT NULL DEFAULT 0,
        enforce        INTEGER NOT NULL DEFAULT 0,
        updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      -- Cada domínio de email pertence a uma só organização: é por ele que o login encontra o fornecedor
      CREATE TABLE org_sso_domains (
        domain TEXT PRIMARY KEY,
        org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE
      );
      CREATE INDEX org_sso_domains_org ON org_sso_domains(org_id);
      -- Logins SSO em curso (partilhado entre instâncias); org_id NULL = SSO global da plataforma
      CREATE TABLE oidc_pending (
        state      TEXT PRIMARY KEY,
        org_id     INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
        nonce      TEXT NOT NULL,
        verifier   TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );`);
    },
  },
  {
    id: 8,
    name: 'tipos de ativo por organização',
    rebuild: true,
    up(db) {
      // org_id NULL = tipo base, comum a todas as organizações; nomes únicos dentro de cada organização
      db.exec(`CREATE TABLE ci_types_new (
        id       INTEGER PRIMARY KEY,
        org_id   INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
        name     TEXT NOT NULL COLLATE NOCASE,
        category TEXT NOT NULL,
        fields   TEXT NOT NULL DEFAULT '[]'
      );
      INSERT INTO ci_types_new (id, org_id, name, category, fields) SELECT id, NULL, name, category, fields FROM ci_types;
      DROP TABLE ci_types;
      ALTER TABLE ci_types_new RENAME TO ci_types;
      CREATE UNIQUE INDEX ci_types_org_name ON ci_types(COALESCE(org_id, 0), name);`);
    },
  },
  {
    id: 9,
    name: 'subscrições (Stripe)',
    up(db, { addColumn }) {
      // billing_status NULL = organização não sujeita a faturação (anterior, ou gerida à mão pela plataforma)
      addColumn(db, 'organizations', 'billing_status', 'TEXT');
      addColumn(db, 'organizations', 'trial_ends_at', 'TEXT');
      addColumn(db, 'organizations', 'stripe_customer_id', 'TEXT');
      addColumn(db, 'organizations', 'stripe_subscription_id', 'TEXT');
      addColumn(db, 'organizations', 'current_period_end', 'TEXT');
      addColumn(db, 'organizations', 'cancel_at', 'TEXT');
      db.exec(`CREATE INDEX organizations_stripe_customer ON organizations(stripe_customer_id);
      CREATE TABLE stripe_events (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        received_at TEXT NOT NULL DEFAULT (datetime('now'))
      );`);
    },
  },
  {
    id: 10,
    name: 'RGPD: eliminação a pedido e aceitação dos termos',
    up(db, { addColumn }) {
      addColumn(db, 'organizations', 'deletion_requested_at', 'TEXT');
      addColumn(db, 'organizations', 'deletion_requested_by', 'TEXT');
      addColumn(db, 'users', 'terms_accepted_at', 'TEXT');
      addColumn(db, 'users', 'terms_version', 'TEXT');
    },
  },
  {
    id: 11,
    name: 'acesso de suporte autorizado pela organização',
    up(db, { addColumn }) {
      addColumn(db, 'organizations', 'support_access_until', 'TEXT');
      // Sessão de suporte: utilizador da plataforma que está a agir como administrador da organização
      addColumn(db, 'sessions', 'impersonator', 'TEXT');
    },
  },
  {
    id: 12,
    name: 'integração RMM (NinjaOne)',
    up(db) {
      db.exec(`CREATE TABLE rmm_connections (
        id            INTEGER PRIMARY KEY,
        org_id        INTEGER NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
        provider      TEXT NOT NULL DEFAULT 'ninjaone',
        region        TEXT NOT NULL,
        api_client_id TEXT NOT NULL,
        secret_enc    TEXT NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 1,
        last_sync     TEXT,
        last_status   TEXT,
        last_report   TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      -- Organização do RMM → cliente do Rizoma (client_id NULL = ainda por associar; os dispositivos são ignorados)
      CREATE TABLE rmm_client_map (
        connection_id   INTEGER NOT NULL REFERENCES rmm_connections(id) ON DELETE CASCADE,
        remote_org_id   TEXT NOT NULL,
        remote_org_name TEXT,
        client_id       INTEGER REFERENCES clients(id) ON DELETE SET NULL,
        devices         INTEGER,
        PRIMARY KEY (connection_id, remote_org_id)
      );`);
    },
  },
  {
    id: 13,
    name: 'avisos e webhooks',
    up(db) {
      db.exec(`CREATE TABLE webhooks (
        id           INTEGER PRIMARY KEY,
        org_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        kind         TEXT NOT NULL CHECK (kind IN ('slack', 'teams', 'generic')),
        name         TEXT NOT NULL,
        url_enc      TEXT NOT NULL,
        secret_enc   TEXT,
        events       TEXT NOT NULL DEFAULT '[]',
        client_id    INTEGER REFERENCES clients(id) ON DELETE CASCADE,
        enabled      INTEGER NOT NULL DEFAULT 1,
        failures     INTEGER NOT NULL DEFAULT 0,
        last_status  TEXT,
        last_error   TEXT,
        last_sent_at TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX webhooks_org ON webhooks(org_id);
      -- Fila de envio (outbox): escrita na mesma transação da alteração
      CREATE TABLE webhook_deliveries (
        id              INTEGER PRIMARY KEY,
        webhook_id      INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
        event           TEXT NOT NULL,
        payload         TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'failed')),
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error      TEXT,
        sent_at         INTEGER,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);`);
    },
  },
  {
    id: 14,
    name: 'inventário de software e vulnerabilidades (CVE)',
    up(db) {
      db.exec(`CREATE TABLE ci_software (
        ci_id     INTEGER NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
        name      TEXT NOT NULL,
        version   TEXT NOT NULL DEFAULT '',
        publisher TEXT,
        product   TEXT,
        seen_at   TEXT,
        PRIMARY KEY (ci_id, name, version)
      );
      CREATE INDEX ci_software_product ON ci_software(product);
      -- Dados públicos (comuns a todas as organizações): CVE por produto CPE e lista KEV da CISA
      CREATE TABLE cve_products (product TEXT PRIMARY KEY, fetched_at INTEGER, cve_count INTEGER, error TEXT);
      CREATE TABLE cves (
        product   TEXT NOT NULL,
        id        TEXT NOT NULL,
        score     REAL,
        severity  TEXT,
        summary   TEXT,
        published TEXT,
        ranges    TEXT NOT NULL,
        PRIMARY KEY (product, id)
      );
      CREATE TABLE kev (cve_id TEXT PRIMARY KEY, date_added TEXT, due_date TEXT, name TEXT);
      -- Correspondências ativo × CVE (first_seen: para avisar só as novidades)
      CREATE TABLE ci_vulns (
        ci_id      INTEGER NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
        cve_id     TEXT NOT NULL,
        software   TEXT NOT NULL,
        version    TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        PRIMARY KEY (ci_id, cve_id)
      );
      CREATE INDEX ci_vulns_cve ON ci_vulns(cve_id);
      CREATE INDEX ci_vulns_first_seen ON ci_vulns(first_seen);`);
    },
  },
];

module.exports = { MIGRATIONS, ensureFts, ftsAvailable };
