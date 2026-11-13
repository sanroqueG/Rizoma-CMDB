'use strict';
/* Aplicação HTTP: configuração, controlo de acesso por cliente, sessões, router e registo dos módulos de rotas (src/routes). */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { newToken, sha256, createSecretBox } = require('./auth');
const { createReconciler } = require('./reconcile');
const { createOidc } = require('./oidc');
const { passwordProblem } = require('./passwords');
const { createAccess } = require('./access');
const { createStore } = require('./store');
const { createJobs } = require('./jobs');
const { createState } = require('./state');
const { validate } = require('./schema');
const { BODY_SCHEMAS } = require('./schemas');
const { createMetrics } = require('./metrics');
const {
  STATUSES, CRITICALITIES, ENVIRONMENTS, REL_TYPES, SESSION_TTL_MS, MIME, SECURITY_HEADERS, HttpError, fail, toId, parseCookies, readBody,
} = require('./http');

function createApp(db, opts = {}) {
  const publicDir = path.resolve(opts.publicDir || path.join(__dirname, '..', 'public'));
  const agentDir = path.resolve(opts.agentDir || path.join(__dirname, '..', 'agent'));
  const secureCookie = opts.secureCookie ?? process.env.CMDB_SECURE_COOKIE === '1';
  const fetchFn = opts.fetch || globalThis.fetch;
  const box = createSecretBox(opts.secretKey || process.env.CMDB_SECRET_KEY || crypto.randomBytes(32).toString('hex'));
  const requireMfa = opts.requireMfa ?? process.env.CMDB_REQUIRE_2FA === '1';
  const totpIssuer = opts.totpIssuer || process.env.CMDB_TOTP_ISSUER || 'Rizoma';
  const log = opts.log || { error: (msg, f) => console.error(msg, (f && f.err) || '') };

  const env = process.env;
  const oidcCfg = opts.oidc !== undefined ? opts.oidc : (env.CMDB_OIDC_ISSUER ? {
    issuer: env.CMDB_OIDC_ISSUER,
    clientId: env.CMDB_OIDC_CLIENT_ID,
    clientSecret: env.CMDB_OIDC_CLIENT_SECRET,
    redirectUri: env.CMDB_OIDC_REDIRECT_URI || `${String(env.CMDB_PUBLIC_URL || '').replace(/\/+$/, '')}/api/auth/oidc/callback`,
    label: env.CMDB_OIDC_LABEL,
  } : null);
  // Acesso a dados: ver src/store.js (todo o SQL passa por aqui)
  const store = createStore(db);
  const { one, all, run, tx, audit } = store;
  /** Estado dos logins SSO em curso, na BD (funciona com várias instâncias). orgId null = SSO global. */
  const oidcPending = (orgId) => ({
    put(stateId, v) {
      run('DELETE FROM oidc_pending WHERE expires_at < ?', Date.now());
      run('INSERT INTO oidc_pending (state, org_id, nonce, verifier, expires_at) VALUES (?,?,?,?,?)', stateId, orgId, v.nonce, v.verifier, v.exp);
    },
    take(stateId) {
      const r = one('SELECT * FROM oidc_pending WHERE state = ?', stateId);
      run('DELETE FROM oidc_pending WHERE state = ?', stateId);
      return r && { nonce: r.nonce, verifier: r.verifier, exp: r.expires_at };
    },
  });
  const oidc = oidcCfg ? createOidc({ ...oidcCfg, fetchFn, pending: oidcPending(null) }) : null;
  // Tarefas pesadas (Excel, importação, cópias) numa worker thread quando a BD é um ficheiro: ver src/jobs.js
  const jobs = createJobs({ store, dbFile: opts.dbFile, inline: opts.inlineJobs });
  // Estado partilhado entre instâncias (tentativas de login, 2FA pendente, locks): ver src/state.js
  const state = createState(store);
  const reconciler = createReconciler({ one, all, run, audit });

  // ---- controlo de acesso (organização + cliente): ver src/access.js
  const access = createAccess({ one, all, fail });
  const { scopeOf, scopeSql, orgSql, assertRead, assertWrite, assertAdmin, assertPlatform, assertSameOrg, assertLimit } = access;
  const publicUser = (u) => ({
    id: u.id, username: u.username, name: u.name, email: u.email || null, role: u.role, client_id: u.client_id,
    org_id: u.org_id, is_platform: !!u.is_platform, active: !!u.active,
    email_verified: !!u.email_verified_at, invite_pending: !!u.invite_pending, totp_enabled: !!u.totp_enabled, must_change_password: !!u.must_change_password, notify_digest: !!u.notify_digest,
  });
  const mfaSetupRequired = (u, method) => requireMfa && method !== 'oidc' && !u.totp_enabled;
  // Quem entra por SSO não usa a password local, por isso não é obrigado a mudá-la
  const passwordChangeRequired = (u, method) => !!u.must_change_password && method !== 'oidc';
  /** Resumo da subscrição para a interface (null quando a organização não está sujeita a faturação). */
  function billingSummary(u) {
    const o = one('SELECT billing_status, trial_ends_at, stripe_subscription_id, plan FROM organizations WHERE id = ?', u.org_id);
    if (!o || !o.billing_status) return null;
    return { status: o.billing_status, plan: o.plan, trial_ends_at: o.trial_ends_at, blocked: core.billingBlock(o) };
  }
  /** Data em que a organização vai ser eliminada (pedido RGPD pendente), ou null. */
  function orgDeleteAt(u) {
    const o = one('SELECT deletion_requested_at FROM organizations WHERE id = ?', u.org_id);
    return o && o.deletion_requested_at ? core.deletionDate(o.deletion_requested_at) : null;
  }
  const meView = (u, method) => ({
    ...publicUser(u), client_ids: scopeOf(u),
    mfa_setup_required: mfaSetupRequired(u, method), password_change_required: passwordChangeRequired(u, method),
    email_verification_available: !!opts.mailer,
    billing: billingSummary(u),
    org_delete_at: orgDeleteAt(u),
    support_session: u.impersonator ? { by: u.impersonator, as: u.support_for } : null,
  });
  function checkPassword(pw, username) {
    const problem = passwordProblem(pw, username);
    if (problem) fail(400, problem);
  }

  function getClient(user, id) {
    const c = one('SELECT * FROM clients WHERE id = ?', toId(id));
    if (!c) fail(404, 'Cliente não encontrado');
    assertRead(user, c.id);
    return c;
  }
  function getCi(user, id) {
    const ci = one('SELECT * FROM cis WHERE id = ?', toId(id));
    if (!ci) fail(404, 'Ativo não encontrado');
    assertRead(user, ci.client_id);
    return ci;
  }

  // ---- router mínimo
  const routes = [];
  function add(method, pattern, handler, flags = {}) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    // Esquema do corpo: o declarado na rota ou o de src/schemas.js
    const body = flags.body || BODY_SCHEMAS[`${method} ${pattern}`];
    routes.push({ method, pattern, re, keys, handler, flags: body ? { ...flags, body } : flags });
  }
  /**
   * Token de integração (Authorization: Bearer …) com a permissão pedida ("ingest" ou "tickets").
   * Devolve a linha do token; regista o último uso.
   */
  function requireToken(req, scope) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    const tok = m && one('SELECT t.*, cl.org_id FROM api_tokens t JOIN clients cl ON cl.id = t.client_id WHERE t.token_hash = ?', sha256(m[1]));
    if (!tok) fail(401, 'Token inválido');
    if (!one("SELECT 1 FROM organizations WHERE id = ? AND status = 'active'", tok.org_id)) fail(403, 'O acesso desta organização está suspenso');
    if (!String(tok.scopes || '').split(',').includes(scope)) fail(403, `Este token não tem a permissão "${scope}"`);
    run("UPDATE api_tokens SET last_used = datetime('now') WHERE id = ?", tok.id);
    return tok;
  }
  function match(method, pathname) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (m) return { ...r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }

  function addCookie(res, cookie) {
    const prev = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', prev ? [].concat(prev, cookie) : cookie);
  }
  function setSessionCookie(res, value, maxAgeSec) {
    addCookie(res, `sid=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${secureCookie ? '; Secure' : ''}`);
  }
  function createSession(res, u, method) {
    const token = newToken();
    run('INSERT INTO sessions (token_hash, user_id, expires_at, method) VALUES (?,?,?,?)', sha256(token), u.id, Date.now() + SESSION_TTL_MS, method);
    setSessionCookie(res, token, SESSION_TTL_MS / 1000);
  }
  function redirect(res, ctx, location) {
    res.writeHead(302, { ...SECURITY_HEADERS, Location: location, 'Cache-Control': 'no-store' });
    res.end();
    ctx.raw = true;
  }

  // =========================================================== módulos de rotas
  const metrics = opts.metrics || createMetrics();
  const core = {
    oidcPending, createOidc, metrics,
    /** Substituída por src/routes/billing.js: motivo para a organização estar só de leitura (ou null). */
    billingBlock: /** @type {(o: any) => string | null} */ (() => null),
    /** Substituída por src/routes/privacy.js: data em que uma organização com eliminação pedida é apagada. */
    deletionDate: /** @type {(requestedAt: string) => string} */ ((x) => x),
    /** Substituída por src/routes/support.js. */
    supportBlocked: /** @type {(method: string, path: string) => boolean} */ (() => false),
    /** Substituídas por src/routes/rmm.js. */
    syncRmm: /** @type {(id: number, actor: string) => Promise<any>} */ (async () => null),
    dueRmm: /** @type {(hours: number) => number[]} */ (() => []),
    /** Substituída por src/routes/privacy.js. */
    purgeDeletedOrgs: /** @type {(now?: Date) => number} */ (() => 0),
    ...require('./http'), // utilitários de validação, constantes e SECURITY_HEADERS
    db, store, sqlDialect: store.sql, runJob: jobs.runJob, requireToken, opts, log, add, routes, one, all, run, tx, audit, scopeOf, scopeSql, orgSql, assertRead, assertWrite, assertAdmin, assertPlatform, assertSameOrg, assertLimit, publicUser, meView, mfaSetupRequired, passwordChangeRequired, checkPassword, getClient, getCi, addCookie, setSessionCookie, createSession, redirect, box, oidc, requireMfa, totpIssuer, fetchFn, secureCookie, state, reconciler,
  };
  require('./routes/auth')(core);
  Object.assign(core, require('./routes/cis')(core)); // readCiInput, walk
  require('./routes/clients')(core);
  require('./routes/users')(core);
  require('./routes/inventory')(core);
  const connectors = require('./routes/connectors')(core);
  const system = require('./routes/system')(core);
  require('./routes/contracts')(core);
  require('./routes/reports')(core);
  require('./routes/tickets')(core);
  require('./routes/search')(core);
  require('./routes/orgs')(core);
  require('./routes/accounts')(core);
  require('./routes/sso')(core);
  require('./routes/types')(core);
  require('./routes/billing')(core);
  require('./routes/privacy')(core);
  require('./routes/support')(core);
  require('./routes/rmm')(core);
  require('./routes/api-docs')(core);

  // =========================================================== ficheiros estáticos
  function serveStatic(pathname, res) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { rel = '/'; }
    if (rel === '/' || rel === '') rel = '/index.html';
    // Scripts do agente ficam disponíveis para download em /agent/...
    const root = rel.startsWith('/agent/') ? agentDir : publicDir;
    if (root === agentDir) rel = rel.slice('/agent'.length);
    const file = path.resolve(root, '.' + path.posix.normalize(rel));
    if (!file.startsWith(root + path.sep)) return sendJson(res, 404, { error: 'Não encontrado' });
    fs.readFile(file, (err, data) => {
      if (err) return sendJson(res, 404, { error: 'Não encontrado' });
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  }

  function sendJson(res, status, data) {
    if (res.headersSent) return;
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  // =========================================================== handler principal
  handle.runJob = jobs.runJob;
  handle.metrics = metrics;
  handle.state = state;
  handle.jobsMode = jobs.mode;
  handle.routes = routes.map(({ method, pattern, flags }) => ({ method, pattern, flags }));
  handle.runScheduledDigest = system.runScheduledDigest;
  handle.purgeAudit = system.purgeAudit;
  handle.purgeDeletedOrgs = core.purgeDeletedOrgs;
  handle.syncRmm = (id, actor) => core.syncRmm(id, actor);
  handle.dueRmm = (hours) => core.dueRmm(hours);
  handle.sendDigests = system.sendDigests;
  handle.syncConnector = connectors.syncConnector;
  handle.dueConnectors = connectors.dueConnectors;
  return handle;

  async function handle(req, res) {
    // Métricas: rota pelo padrão (/api/cis/:id), não pelo URL, para não criar uma série por ativo
    const t0 = process.hrtime.bigint();
    let route = 'nao_encontrada';
    res.on('finish', () => metrics.observe(req.method, route, res.statusCode, Number(process.hrtime.bigint() - t0) / 1e9));
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/')) {
        route = 'estatico';
        if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'Método não permitido');
        return serveStatic(url.pathname, res);
      }
      // API pública versionada: /api/v1/… expõe só as rotas marcadas com { api: true } (integrações)
      const versioned = url.pathname.startsWith('/api/v1/');
      const r = match(req.method, versioned ? `/api/${url.pathname.slice(8)}` : url.pathname);
      if (!r || (versioned && !r.flags.api)) fail(404, 'Rota inexistente');
      route = versioned ? `/api/v1${r.pattern.slice(4)}` : r.pattern;
      if (r.flags.api && !versioned && !r.flags.internal) {
        // Caminho antigo das integrações: continua a funcionar, mas indica o sucessor
        res.setHeader('Deprecation', 'true');
        res.setHeader('Link', `</api/v1/${url.pathname.slice(5)}>; rel="successor-version"`);
      }

      const mutating = !['GET', 'HEAD'].includes(req.method);
      // Proteção CSRF (além do cookie SameSite=Strict): a origem tem de coincidir com o host.
      if (mutating && !r.flags.token && req.headers.origin) {
        let originHost = null;
        try { originHost = new URL(req.headers.origin).host; } catch { /* origem inválida */ }
        if (originHost !== req.headers.host) fail(403, 'Origem não permitida');
      }

      let body = {};
      let rawBody = '';
      if (mutating) {
        const raw = await readBody(req, r.flags.maxBody || 1024 * 1024);
        rawBody = raw; // assinaturas de webhooks (Stripe) são calculadas sobre o corpo original
        if (raw.trim()) {
          if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) fail(415, 'Use Content-Type: application/json');
          try { body = JSON.parse(raw); } catch { fail(400, 'JSON inválido'); }
          if (!body || typeof body !== 'object') fail(400, 'JSON inválido');
        }
      }

      if (r.flags.body && r.flags.validate !== false && mutating) body = validate(r.flags.body, body);
      const ctx = { req, res, params: r.params, query: Object.fromEntries(url.searchParams), body, rawBody };
      ctx.ctx = ctx;
      if (!r.flags.public) {
        const sid = parseCookies(req).sid;
        // Sessão válida, utilizador ativo e organização ativa (uma organização suspensa perde o acesso de imediato)
        const user = sid && one(`SELECT u.*, s.method AS session_method, s.impersonator, o.name AS org_name,
          o.billing_status AS org_billing_status, o.trial_ends_at AS org_trial_ends_at, o.stripe_subscription_id AS org_subscription,
          o.deletion_requested_at AS org_deletion_requested_at FROM sessions s
          JOIN users u ON u.id = s.user_id JOIN organizations o ON o.id = u.org_id
          WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1 AND o.status = 'active'`, sha256(sid), Date.now());
        if (!user) fail(401, 'Sessão inválida ou expirada');
        if (user.impersonator) {
          // Sessão de suporte: fica na auditoria com o nome de quem deu suporte; certas rotas estão vedadas
          if (core.supportBlocked(req.method, url.pathname)) fail(403, 'Não disponível numa sessão de suporte');
          user.support_for = user.username;
          user.username = `suporte:${user.impersonator}`;
        }
        if (!r.flags.allowNoMfa && passwordChangeRequired(user, user.session_method)) {
          fail(403, 'Altere a sua password para continuar (menu "A minha conta")');
        }
        if (!r.flags.allowNoMfa && mfaSetupRequired(user, user.session_method)) {
          fail(403, 'Configure a autenticação de dois fatores para continuar (menu "A minha conta")');
        }
        // Período experimental terminado ou subscrição inativa: só leitura (consultar, exportar, tratar da subscrição)
        if (mutating && !r.flags.billingExempt && !r.flags.allowNoMfa && user.org_deletion_requested_at) {
          fail(409, `A organização vai ser eliminada em ${core.deletionDate(user.org_deletion_requested_at).slice(0, 10)}. Até lá fica só de leitura; um administrador pode desistir em "Organização".`);
        }
        if (mutating && !r.flags.billingExempt && !r.flags.allowNoMfa) {
          const blocked = core.billingBlock({ billing_status: user.org_billing_status, trial_ends_at: user.org_trial_ends_at, stripe_subscription_id: user.org_subscription });
          if (blocked) fail(402, `${blocked} A organização está em modo só de leitura: ${user.role === 'admin' ? 'escolha um plano em "Subscrição"' : 'peça a um administrador que escolha um plano'}.`);
        }
        ctx.user = user;
        ctx.sid = sid;
      }
      const result = await r.handler(ctx);
      if (!ctx.raw) sendJson(res, ctx.status || 200, result);
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      if (/UNIQUE constraint failed/.test(e && e.message)) return sendJson(res, 409, { error: 'Já existe um registo com esses dados' });
      if (/FOREIGN KEY constraint failed/.test(e && e.message)) return sendJson(res, 409, { error: 'Registo em uso por outros dados' });
      log.error('Erro interno', { method: req.method, url: req.url, err: e });
      sendJson(res, 500, { error: 'Erro interno' });
    }
  };
}

module.exports = { createApp, STATUSES, CRITICALITIES, ENVIRONMENTS, REL_TYPES };
